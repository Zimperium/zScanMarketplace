const axios = require('axios');
const core = require('@actions/core');
const fs = require('fs');
const glob = require('glob');
const path = require('path');
const FormData = require('form-data');

const DOWNLOAD_POLL_TIME = 6/*seconds*/ * 1000/*ms*/;
const STATUS_POLL_TIME = 30/*seconds*/ * 1000/*ms*/;
const MAX_POLL_TIME = 45/*minutes*/ * 60/*seconds*/ * 1000/*ms*/;
const MAX_DOWNLOAD_TIME = 20/*minutes*/ * 60/*seconds*/ * 1000/*ms*/;
const MAX_FILES = 5; // Maximum number of files to process

const DEFAULT_RETRY_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_SECONDS = 5;
const DEFAULT_RETRY_BACKOFF_FACTOR = 2;
const MAX_RETRY_DELAY = 60/*seconds*/ * 1000/*ms*/;

const SUPPORTED_REPORT_FORMATS = ['sarif', 'json', 'pdf'];
const RETRYABLE_STATUS_CODES = [408, 429];
const RETRYABLE_NETWORK_CODES = [
    'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'ETIMEDOUT', 'EPIPE',
    'EAI_AGAIN', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH', 'ERR_NETWORK',
    'ERR_SOCKET_CONNECTION_TIMEOUT'
];

const ERROR_MESSAGE_AUTH = "********************\n" +
    "Authentication Error: The action failed due to incorrect credentials. Please update and try again.\n" +
    "********************\n";

let loginResponse = undefined;
let actionConfig = null;

const SEVERITY_RANKS = {
    informational: 0,
    low: 1,
    medium: 2,
    high: 3,
    critical: 4,
    'best practices': -2,
    unknown: -1
};

/**
 * Marks a failure that must never be retried (auth failures, validation errors,
 * malformed responses, and other non-transient 4xx conditions).
 */
class NonRetryableError extends Error {
    constructor(message, cause = undefined) {
        super(message);
        this.name = 'NonRetryableError';
        this.retryable = false;
        if (cause !== undefined) {
            this.cause = cause;
        }
    }
}

function resetStateForTesting() {
    actionConfig = null;
    loginResponse = undefined;
}

/**
 * Strips credentials, bearer tokens, and signed CDN query strings out of text
 * before it reaches the workflow log.
 */
function redact(value) {
    if (value === undefined || value === null) {
        return '';
    }
    let text = typeof value === 'string' ? value : String(value);
    const config = actionConfig;
    if (config) {
        for (const secret of [config.clientSecret, config.clientId]) {
            if (secret && String(secret).length > 3) {
                text = text.split(String(secret)).join('***');
            }
        }
    }
    if (loginResponse && loginResponse.accessToken) {
        text = text.split(loginResponse.accessToken).join('***');
    }
    text = text.replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1***');
    // Signed CDN links carry credentials in the query string.
    text = text.replace(/(https?:\/\/[^\s?"']+)\?[^\s"']*/gi, '$1?<redacted>');
    return text;
}

function describeError(error) {
    if (!error) {
        return 'unknown error';
    }
    if (error.response && error.response.status) {
        return redact(`HTTP ${error.response.status}`);
    }
    if (error.code) {
        return redact(`${error.code}: ${error.message}`);
    }
    return redact(error.message || String(error));
}

/**
 * Transient == worth retrying: 408, 429, any 5xx, or a network-level failure
 * where no response was ever received.
 */
function isTransientError(error, extraRetryableStatuses = []) {
    if (!error || error.retryable === false) {
        return false;
    }
    const response = error.response;
    if (response && typeof response.status === 'number') {
        const status = response.status;
        if (extraRetryableStatuses.includes(status)) {
            return true;
        }
        if (RETRYABLE_STATUS_CODES.includes(status)) {
            return true;
        }
        return status >= 500 && status <= 599;
    }
    // No response at all -> network/request level failure.
    if (error.code && RETRYABLE_NETWORK_CODES.includes(error.code)) {
        return true;
    }
    return Boolean(error.request) && !response;
}

function isAuthError(error) {
    const status = error && error.response && error.response.status;
    return status === 401 || status === 403;
}

function computeRetryDelay(attempt, config) {
    const base = config.retryDelay;
    const factor = config.retryBackoffFactor;
    const delay = base * Math.pow(factor, attempt - 1);
    return Math.min(delay, MAX_RETRY_DELAY);
}

/**
 * Runs `operation` with bounded attempts and exponential backoff, retrying only
 * transient failures. Non-transient failures propagate immediately.
 */
async function withRetry(operation, options = {}) {
    const config = options.config || getActionConfig();
    const attempts = Math.max(1, options.attempts || config.retryAttempts);
    const label = options.label || 'request';
    const extraRetryableStatuses = options.retryableStatuses || [];

    let lastError;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
            return await operation(attempt);
        } catch (error) {
            lastError = error;
            if (isAuthError(error)) {
                core.info(ERROR_MESSAGE_AUTH);
                throw new NonRetryableError(
                    `${label} failed authentication (${describeError(error)}).`,
                    error
                );
            }
            if (!isTransientError(error, extraRetryableStatuses)) {
                throw error;
            }
            if (attempt >= attempts) {
                break;
            }
            const delay = computeRetryDelay(attempt, config);
            core.warning(
                `${label} failed with a transient error (${describeError(error)}). ` +
                `Retrying in ${Math.round(delay / 1000)}s (attempt ${attempt + 1} of ${attempts}).`
            );
            await sleep(delay);
        }
    }

    throw new Error(
        `${label} failed after ${attempts} attempt(s). Last error: ${describeError(lastError)}`
    );
}

function parseBoundedNumber(rawValue, {name, fallback, min, max, integer = true}) {
    const text = String(rawValue === undefined || rawValue === null ? '' : rawValue).trim();
    if (text === '') {
        return fallback;
    }
    const parsed = Number(text);
    if (!Number.isFinite(parsed)) {
        throw new NonRetryableError(`Invalid value for ${name}: "${text}". Expected a number between ${min} and ${max}.`);
    }
    if (integer && !Number.isInteger(parsed)) {
        throw new NonRetryableError(`Invalid value for ${name}: "${text}". Expected a whole number between ${min} and ${max}.`);
    }
    if (parsed < min || parsed > max) {
        throw new NonRetryableError(`Invalid value for ${name}: "${text}". Expected a value between ${min} and ${max}.`);
    }
    return parsed;
}

function readInput(name) {
    try {
        return core.getInput(name, {required: false});
    } catch (error) {
        return '';
    }
}

/**
 * `core.getBooleanInput` throws a raw YAML-schema error on empty input, which
 * is unhelpful when the action is consumed without action.yml defaults.
 */
function readBooleanInput(name, fallback = false) {
    const raw = readInput(name);
    if (String(raw).trim() === '') {
        return fallback;
    }
    const normalized = String(raw).trim().toLowerCase();
    if (['true', 'false'].includes(normalized)) {
        return normalized === 'true';
    }
    throw new NonRetryableError(
        `Invalid value for ${name}: "${raw}". Expected true or false.`
    );
}

function getActionConfig() {
    if (!actionConfig) {
        const clientSecret = core.getInput('client_secret', {required: true});
        if (clientSecret) {
            core.setSecret(clientSecret);
        }

        const retryAttempts = parseBoundedNumber(readInput('retry_attempts'), {
            name: 'retry_attempts', fallback: DEFAULT_RETRY_ATTEMPTS, min: 1, max: 10
        });
        const retryDelaySeconds = parseBoundedNumber(readInput('retry_delay_seconds'), {
            name: 'retry_delay_seconds', fallback: DEFAULT_RETRY_DELAY_SECONDS, min: 0, max: 60
        });
        const retryBackoffFactor = parseBoundedNumber(readInput('retry_backoff_factor'), {
            name: 'retry_backoff_factor', fallback: DEFAULT_RETRY_BACKOFF_FACTOR, min: 1, max: 5, integer: false
        });
        const statusTimeoutMinutes = parseBoundedNumber(readInput('status_timeout_minutes'), {
            name: 'status_timeout_minutes', fallback: MAX_POLL_TIME / 60000, min: 1, max: 360
        });
        const statusPollIntervalSeconds = parseBoundedNumber(readInput('status_poll_interval_seconds'), {
            name: 'status_poll_interval_seconds', fallback: STATUS_POLL_TIME / 1000, min: 5, max: 300
        });
        const reportTimeoutMinutes = parseBoundedNumber(readInput('report_timeout_minutes'), {
            name: 'report_timeout_minutes', fallback: MAX_DOWNLOAD_TIME / 60000, min: 1, max: 180
        });
        const reportPollIntervalSeconds = parseBoundedNumber(readInput('report_poll_interval_seconds'), {
            name: 'report_poll_interval_seconds', fallback: DOWNLOAD_POLL_TIME / 1000, min: 1, max: 120
        });

        actionConfig = {
            clientEnv: core.getInput('client_env', { required: false }),
            consoleUrl: core.getInput('console_url', { required: false }),
            clientId: core.getInput('client_id', { required: true }),
            clientSecret,
            clientApp: core.getInput('app_file', { required: true }),
            teamName: core.getInput('team_name', { required: false }) || 'Default',
            reportFormat: normalizeReportFormats(core.getInput('report_format', { required: false })),
            failOnScanFindings: readBooleanInput('fail_on_scan_findings', false),
            scanEvaluationMode: normalizeScanEvaluationMode(core.getInput('scan_evaluation_mode', { required: false })),
            minimumSeverity: normalizeSeverity(core.getInput('minimum_severity', { required: false }) || 'low'),
            retryAttempts,
            retryDelay: retryDelaySeconds * 1000,
            retryBackoffFactor,
            statusTimeout: statusTimeoutMinutes * 60 * 1000,
            statusPollInterval: statusPollIntervalSeconds * 1000,
            reportTimeout: reportTimeoutMinutes * 60 * 1000,
            reportPollInterval: reportPollIntervalSeconds * 1000
        };
    }

    return actionConfig;
}

/**
 * Fills in retry/timeout defaults for callers (and tests) that pass a partial
 * config object directly instead of going through action inputs.
 */
function withConfigDefaults(config) {
    const resolved = config || getActionConfig();
    return {
        retryAttempts: DEFAULT_RETRY_ATTEMPTS,
        retryDelay: DEFAULT_RETRY_DELAY_SECONDS * 1000,
        retryBackoffFactor: DEFAULT_RETRY_BACKOFF_FACTOR,
        statusTimeout: MAX_POLL_TIME,
        statusPollInterval: STATUS_POLL_TIME,
        reportTimeout: MAX_DOWNLOAD_TIME,
        reportPollInterval: DOWNLOAD_POLL_TIME,
        ...resolved
    };
}

function normalizeReportFormats(value) {
    if (Array.isArray(value)) {
        value = value.join(',');
    }
    const rawItems = String(value === undefined || value === null ? '' : value)
        .toLowerCase()
        .split(/[\s,;|]+/)
        .map(s => s.trim())
        .filter(Boolean);

    if (rawItems.length === 0) {
        return ['sarif'];
    }

    if (rawItems.includes('all')) {
        return [...SUPPORTED_REPORT_FORMATS];
    }

    const valid = rawItems.filter(f => SUPPORTED_REPORT_FORMATS.includes(f));
    const invalid = rawItems.filter(f => !SUPPORTED_REPORT_FORMATS.includes(f));
    if (invalid.length > 0) {
        core.warning(
            `Ignoring unsupported report_format value(s): ${invalid.join(', ')}. ` +
            `Supported values are ${SUPPORTED_REPORT_FORMATS.join(', ')}, or all.`
        );
    }

    const unique = Array.from(new Set(valid));
    if (unique.length === 0) {
        core.warning(`No supported report_format values were provided; defaulting to sarif.`);
        return ['sarif'];
    }
    return unique;
}

function normalizeReportFormat(value) {
    const formats = normalizeReportFormats(value);
    return formats.length === 1 ? formats[0] : formats;
}

function resolveSingleFormat(rawFormat, config) {
    if (rawFormat) {
        return normalizeReportFormats(rawFormat)[0];
    }
    const configured = config && config.reportFormat;
    if (configured) {
        return normalizeReportFormats(configured)[0];
    }
    return 'sarif';
}

function normalizeScanEvaluationMode(value) {
    const mode = String(value || 'any_finding').trim().toLowerCase();
    return mode === 'unaccepted_finding_only' ? mode : 'any_finding';
}

function normalizeSeverity(value) {
    const severity = String(value || 'unknown').trim().toLowerCase();
    return Object.prototype.hasOwnProperty.call(SEVERITY_RANKS, severity) ? severity : 'unknown';
}

function parseFindingSeverity(finding) {
    if (!finding || typeof finding !== 'object') {
        return 'unknown';
    }
    if (typeof finding.severity === 'string') {
        return normalizeSeverity(finding.severity);
    }
    if (Number.isInteger(finding.severityOrdinal)) {
        const ordinalNames = ['informational', 'low', 'medium', 'high', 'critical', 'best practices'];
        return ordinalNames[finding.severityOrdinal] || 'unknown';
    }
    return 'unknown';
}

function parseFindingAccepted(finding) {
    return finding && finding.accepted_status === false;
}

function summarizeScanReport(report) {
    const findings = report && Array.isArray(report.findings) ? report.findings : [];
    const summary = {};
    Object.keys(SEVERITY_RANKS).forEach(severity => {
        summary[severity] = {total: 0, unaccepted: 0};
    });

    findings.forEach(finding => {
        const severity = parseFindingSeverity(finding);
        summary[severity].total += 1;
        if (parseFindingAccepted(finding)) {
            summary[severity].unaccepted += 1;
        }
    });

    return summary;
}

function reportMatchesCriteria(report, mode = 'any_finding', minimumSeverity = 'low') {
    const findings = report && Array.isArray(report.findings) ? report.findings : [];
    const normalizedThreshold = normalizeSeverity(minimumSeverity);
    const threshold = normalizedThreshold === 'unknown' ? 'low' : normalizedThreshold;
    const thresholdRank = SEVERITY_RANKS[threshold];
    return findings.some(finding => {
        const severity = parseFindingSeverity(finding);
        if (severity === 'best practices' || severity === 'unknown' || SEVERITY_RANKS[severity] < thresholdRank) {
            return false;
        }
        return mode !== 'unaccepted_finding_only' || parseFindingAccepted(finding);
    });
}

function getBaseUrl(actionConfig = getActionConfig()) {
    let baseUrl = (!actionConfig.consoleUrl) ? `https://${actionConfig.clientEnv}.zimperium.com` : actionConfig.consoleUrl;
    if (baseUrl.endsWith('/')) {
        baseUrl = baseUrl.slice(0, -1);
    }
    return baseUrl;
}

function loginHttpRequest(actionConfig = getActionConfig(), loginResponseOverride = undefined) {
    const config = actionConfig || getActionConfig();
    const baseUrl = getBaseUrl(config);
    core.debug('Entering loginHttpRequest');
    return new Promise(async function (resolve, reject) {
        let expired = true;
        const effectiveLoginResponse = loginResponseOverride !== undefined ? loginResponseOverride : loginResponse;
        if (effectiveLoginResponse != undefined) {
            let claims = JSON.parse(Buffer.from(effectiveLoginResponse.accessToken.split('.')[1], 'base64'));
            if (Date.now() < claims.exp * 1000) {
                expired = false;
                resolve(effectiveLoginResponse);
            }
        }

        if (expired) {
            core.debug('Access token expired or not present, performing login request');
            const url = `${baseUrl}/api/auth/v1/api_keys/login`;
            core.debug(`Authenticating with ${url}`);
            const clientInfo = {"clientId": config.clientId, "secret": config.clientSecret};
            try {
                const response = await axios.post(url, clientInfo, {
                    headers: {
                        'Content-Type': 'application/json'
                    }
                });
                loginResponse = response.data;
                if (loginResponse && loginResponse.accessToken) {
                    core.setSecret(loginResponse.accessToken);
                }
                core.info("Authentication successful");
                resolve(loginResponse);
            } catch (error) {
                core.error('Error during authentication request: ' + describeError(error));
                if (isAuthError(error)) {
                    core.info(ERROR_MESSAGE_AUTH);
                }
                reject(error);
            }
        }
    });
}

async function getMatchingFiles(pattern) {
    const files = await glob.glob(pattern);
    core.debug(`Files matching pattern "${pattern}": ${files.join(', ')}`);
    if (files.length > MAX_FILES) {
        throw new Error(`Pattern matched ${files.length} files, which exceeds the maximum limit of ${MAX_FILES}. Please narrow down your pattern.`);
    }
    return files;
}

/**
 * Validates that an upload response carries the identifiers the rest of the
 * workflow depends on, so a malformed 200 cannot look like a success.
 */
function validateUploadResponse(data, file) {
    if (!data || typeof data !== 'object') {
        throw new NonRetryableError(`Upload of ${file} returned a malformed response body.`);
    }
    if (!data.buildId) {
        throw new NonRetryableError(`Upload of ${file} did not return a buildId.`);
    }
    return data;
}

async function uploadSingleFile(file, config, loginResponse) {
    return withRetry(async () => {
        // A fresh stream is required for every attempt; streams cannot be replayed.
        const formData = new FormData();
        formData.append('buildFile', fs.createReadStream(file));
        formData.append('notifyUploader', 'false');

        const response = await axios.post(
            `${getBaseUrl(config)}/api/zdev-upload/public/v1/uploads/build`,
            formData,
            {
                headers: {
                    ...formData.getHeaders(),
                    'Authorization': 'Bearer ' + loginResponse.accessToken
                }
            }
        );
        return validateUploadResponse(response.data, file);
    }, {config, label: `Upload of ${file}`});
}

async function uploadApp(actionConfig = getActionConfig(), loginResponseOverride = undefined) {
    const config = withConfigDefaults(actionConfig || getActionConfig());
    const loginResponse = loginResponseOverride || await loginHttpRequest(config);
    core.debug('Entering uploadApp');

    const matchingFiles = await getMatchingFiles(config.clientApp);
    if (matchingFiles.length === 0) {
        throw new Error(`No files found matching pattern: ${config.clientApp}`);
    }

    const results = [];
    const failures = [];
    for (const file of matchingFiles) {
        core.info(`Uploading file: ${file}`);
        try {
            const result = await uploadSingleFile(file, config, loginResponse);
            result.originalFileName = file;

            core.info(`Upload successful for ${file}; buildId: ${result.buildId}`);
            core.info(`buildId: ${result.buildId}`);
            core.info(`zdevAppId: ${result.zdevAppId}`);
            core.info(`teamId: ${result.teamId}`);
            core.info(`buildUploadedAt: ${result.buildUploadedAt}`);
            if (result.zdevUploadResponse) {
                core.info(`buildNumber: ${result.zdevUploadResponse.appBuildVersion}`);
                core.info(`bundleIdentifier: ${result.zdevUploadResponse.bundleIdentifier}`);
                core.info(`appVersion: ${result.zdevUploadResponse.appVersion}`);
            }

            results.push(result);
        } catch (error) {
            const message = `Failed to upload file ${file}: ${describeError(error)}`;
            core.error(message);
            failures.push({file, message});
        }
    }

    if (results.length === 0) {
        const detail = failures.map(f => f.message).join('; ');
        throw new Error(`All ${matchingFiles.length} app upload(s) failed. ${detail}`);
    }

    results.uploadFailures = failures;
    return results;
}

/**
 * Returns the raw status payload, or a sentinel describing why this poll
 * attempt should be treated as "not ready yet".
 */
async function statusHttpRequest(buildId, actionConfig = getActionConfig(), loginResponseOverride = undefined) {
    const config = withConfigDefaults(actionConfig || getActionConfig());
    core.debug('Entering statusHttpRequest for buildId: ' + buildId);
    const loginResponse = loginResponseOverride || await loginHttpRequest(config);
    try {
        const response = await axios.get(`${getBaseUrl(config)}/api/zdev-app/public/v1/assessments/status?buildId=${buildId}`, {
            headers: {
                'Authorization': 'Bearer ' + loginResponse.accessToken
            }
        });
        core.debug('Status response received: ' + response.status);
        return response.data;
    } catch (error) {
        if (isAuthError(error)) {
            core.info(ERROR_MESSAGE_AUTH);
            throw new NonRetryableError(
                `Assessment status request for buildId ${buildId} failed authentication (${describeError(error)}).`,
                error
            );
        }
        // 404 means the assessment record has not materialized yet; 5xx are
        // emitted by the service while it is still working.
        if (isTransientError(error, [404])) {
            core.debug(`Transient status error for buildId ${buildId}: ${describeError(error)}`);
            return {__transient: true, __reason: describeError(error)};
        }
        throw new NonRetryableError(
            `Assessment status request for buildId ${buildId} failed: ${describeError(error)}`,
            error
        );
    }
}

/**
 * Distinguishes "still working", "ready", and "this payload is broken" without
 * ever dereferencing fields that may be absent.
 */
function interpretStatusResponse(status, buildId) {
    if (status && status.__transient) {
        return {state: 'pending', analysis: 'transient error', detail: status.__reason};
    }
    if (!status || typeof status !== 'object') {
        return {state: 'malformed', detail: 'status response was empty or not an object'};
    }
    const metadata = status.zdevMetadata;
    if (metadata === undefined || metadata === null) {
        return {state: 'malformed', detail: 'status response did not include zdevMetadata'};
    }
    if (typeof metadata !== 'object') {
        return {state: 'malformed', detail: 'zdevMetadata was not an object'};
    }
    const analysis = metadata.analysis;
    if (analysis === undefined || analysis === null || analysis === '') {
        return {state: 'malformed', detail: 'zdevMetadata.analysis was missing'};
    }
    if (typeof analysis !== 'string') {
        // Older service behavior surfaced numeric HTTP codes here.
        return {state: 'pending', analysis: String(analysis)};
    }
    if (analysis === 'Failed') {
        return {state: 'failed', analysis};
    }
    if (analysis === 'Done') {
        if (!status.id) {
            return {state: 'malformed', detail: `analysis reported Done for buildId ${buildId} but no assessment id was returned`};
        }
        return {state: 'done', analysis, assessmentId: status.id};
    }
    return {state: 'pending', analysis};
}

/**
 * Polls until the assessment completes. Always either returns a status payload
 * containing a usable assessment id, or throws with an actionable message.
 */
async function pollStatus(buildId, actionConfig = undefined, loginResponseOverride = undefined) {
    const config = withConfigDefaults(actionConfig || getActionConfig());
    const pollInterval = config.statusPollInterval;
    const maxTime = config.statusTimeout;

    await sleep(pollInterval);
    let totalTime = 0;
    let consecutiveMalformed = 0;
    core.debug('Entering pollStatus for buildId: ' + buildId);

    while (totalTime < maxTime) {
        const status = await statusHttpRequest(buildId, config, loginResponseOverride);
        const interpreted = interpretStatusResponse(status, buildId);

        if (interpreted.state === 'done') {
            core.info(`zScan finished for buildId ${buildId} - final status: ${interpreted.analysis}`);
            return status;
        }

        if (interpreted.state === 'failed') {
            throw new Error(`zScan analysis reported Failed for buildId ${buildId}. The assessment did not produce reports.`);
        }

        if (interpreted.state === 'malformed') {
            consecutiveMalformed += 1;
            if (consecutiveMalformed >= config.retryAttempts) {
                throw new Error(
                    `Assessment status for buildId ${buildId} was malformed ${consecutiveMalformed} time(s) in a row: ` +
                    `${interpreted.detail}. Unable to determine scan state.`
                );
            }
            core.warning(
                `Assessment status for buildId ${buildId} was malformed (${interpreted.detail}). ` +
                `Retrying (${consecutiveMalformed} of ${config.retryAttempts}).`
            );
        } else {
            consecutiveMalformed = 0;
            core.info(`${new Date().toISOString()} - zScan status for buildId ${buildId} is ${interpreted.analysis}`);
        }

        totalTime += pollInterval;
        if (totalTime >= maxTime) {
            break;
        }
        await sleep(pollInterval);
    }

    throw new Error(
        `Timed out after ${Math.round(maxTime / 60000)} minute(s) waiting for zScan analysis of buildId ${buildId} to complete.`
    );
}

/**
 * Report endpoints legitimately answer 404/425 while the artifact is still
 * being generated, so those join the transient set for downloads only.
 */
function shouldRetryDownload(status) {
    return status === 404 || status === 425 || RETRYABLE_STATUS_CODES.includes(status) ||
        (typeof status === 'number' && status >= 500 && status <= 599);
}

async function fetchPdfReport(assessmentId, config, loginResponse) {
    const metadataResponse = await axios.get(
        `${getBaseUrl(config)}/api/zdev-app/public/v1/assessments/${assessmentId}/report`,
        {
            headers: {
                'Authorization': 'Bearer ' + loginResponse.accessToken
            }
        }
    );

    if (!metadataResponse || !metadataResponse.data || typeof metadataResponse.data !== 'object') {
        throw new NonRetryableError(`PDF report metadata for assessment ${assessmentId} was malformed.`);
    }
    const reportUrl = metadataResponse.data.cdn_link;
    if (!reportUrl) {
        throw new NonRetryableError(`PDF report URL was not returned for assessment ${assessmentId}.`);
    }
    core.debug(`Retrieved PDF CDN link for assessment ${assessmentId}`);
    // Signed CDN links are short-lived, so download immediately.
    return axios.get(reportUrl, { responseType: 'arraybuffer' });
}

async function downloadApp(assessmentId, originalFileName, actionConfig = getActionConfig(), loginResponseOverride = undefined, reportFormat = undefined) {
    const config = withConfigDefaults(actionConfig || getActionConfig());
    core.debug('Entering downloadApp for file: ' + originalFileName);
    const loginResponse = loginResponseOverride || await loginHttpRequest(config);
    const format = resolveSingleFormat(reportFormat, config);

    try {
        let response;
        if (format === 'pdf') {
            response = await fetchPdfReport(assessmentId, config, loginResponse);
        } else {
            response = await axios.get(`${getBaseUrl(config)}/api/zdev-app/public/v1/assessments/${assessmentId}/${format}`, {
                headers: {
                    'Authorization': 'Bearer ' + loginResponse.accessToken
                },
                responseType: 'arraybuffer'
            });
        }

        if (!response || response.data === undefined || response.data === null) {
            throw new NonRetryableError(`${format.toUpperCase()} report for assessment ${assessmentId} returned an empty body.`);
        }

        // Generate unique report filename based on original file
        const baseName = path.basename(originalFileName, path.extname(originalFileName));
        const reportFileName = `${baseName}_zscan.${format}`;
        fs.writeFileSync(reportFileName, Buffer.from(response.data));
        return {statusCode: response.status, reportFileName, format, assessmentId};
    } catch (error) {
        if (error instanceof NonRetryableError || error.retryable === false) {
            throw error;
        }
        if (isAuthError(error)) {
            core.info(ERROR_MESSAGE_AUTH);
            throw new NonRetryableError(
                `${format.toUpperCase()} report download for assessment ${assessmentId} failed authentication (${describeError(error)}).`,
                error
            );
        }
        if (error.response && shouldRetryDownload(error.response.status)) {
            return {statusCode: error.response.status, format, assessmentId};
        }
        if (!error.response && isTransientError(error)) {
            // Network-level failure: report as not-ready so the poller retries.
            core.debug(`Transient network error downloading ${format}: ${describeError(error)}`);
            return {statusCode: 0, format, assessmentId, transient: true};
        }
        throw error;
    }
}

async function pollDownload(assessmentId, originalFileName, reportFormat = undefined, actionConfig = undefined, loginResponseOverride = undefined) {
    const config = withConfigDefaults(actionConfig || getActionConfig());
    const format = resolveSingleFormat(reportFormat, config);
    const pollInterval = config.reportPollInterval;
    const maxTime = config.reportTimeout;

    await sleep(pollInterval);
    core.debug('Entering pollDownload for file: ' + originalFileName);
    let totalTime = 0;
    let lastStatus;

    while (totalTime < maxTime) {
        const result = await downloadApp(assessmentId, originalFileName, config, loginResponseOverride, format);
        core.debug(`Download attempt returned status code: ${result.statusCode}`);
        if (result.statusCode === 200) {
            verifyReportFile(result.reportFileName, format);
            core.info(`${format.toUpperCase()} file ${result.reportFileName} download complete.`);
            return result;
        }
        lastStatus = result.statusCode;
        core.info(`${format.toUpperCase()} file download is not ready, waiting to try again.`);
        totalTime += pollInterval;
        if (totalTime >= maxTime) {
            break;
        }
        await sleep(pollInterval);
    }

    throw new Error(
        `Timed out after ${Math.round(maxTime / 60000)} minute(s) waiting for the ${format.toUpperCase()} report ` +
        `for assessment ${assessmentId}${lastStatus ? ` (last status ${lastStatus})` : ''}.`
    );
}

/**
 * Confirms the artifact actually landed on disk with content.
 */
function verifyReportFile(reportFileName, format) {
    if (!reportFileName) {
        throw new Error(`${String(format).toUpperCase()} report did not produce an output file.`);
    }
    let stats;
    try {
        stats = fs.statSync(reportFileName);
    } catch (error) {
        throw new Error(`Assessment results file ${reportFileName} was not successfully created.`);
    }
    if (!stats.isFile() || stats.size === 0) {
        throw new Error(`Assessment results file ${reportFileName} was created but is empty.`);
    }
    return true;
}

async function getTeams(actionConfig = getActionConfig(), loginResponseOverride = undefined) {
    const config = withConfigDefaults(actionConfig || getActionConfig());
    const loginResponse = loginResponseOverride || await loginHttpRequest(config);
    try {
        const response = await withRetry(async () => axios.get(`${getBaseUrl(config)}/api/auth/public/v1/teams`, {
            headers: {
                'Authorization': 'Bearer ' + loginResponse.accessToken
            }
        }), {config, label: 'Team list request'});
        return response.data.content;
    } catch (error) {
        core.error(`Failed to fetch teams list: ${describeError(error)}`);
        throw error;
    }
}

async function assignAppToTeam(appId, teamId, actionConfig = getActionConfig(), loginResponseOverride = undefined) {
    const config = withConfigDefaults(actionConfig || getActionConfig());
    const loginResponse = loginResponseOverride || await loginHttpRequest(config);
    try {
        const response = await withRetry(async () => axios.put(`${getBaseUrl(config)}/api/zdev-app/public/v1/apps/${appId}/upload`,
            { "teamId": teamId },
            {
                headers: {
                    'Authorization': 'Bearer ' + loginResponse.accessToken,
                    'Content-Type': 'application/json'
                }
            }
        ), {config, label: `Team assignment for app ${appId}`});
        core.info(`App assigned to team successfully`);
        return response.data;
    } catch (error) {
        core.error(`Failed to assign app to team: ${describeError(error)}`);
        throw error;
    }
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function ensureTeamAssignment(result, config, loginResponseOverride = undefined) {
    if (result.teamId !== null && result.teamId !== undefined) {
        core.info(`App ${result.zdevAppId} already belongs to team (ID: ${result.teamId})`);
        return;
    }

    core.info(`App ${result.zdevAppId} not assigned to a team, attempting to assign to team: ${config.teamName}`);
    // Wait for a short time to ensure the app is available for team assignment
    await sleep(config.statusPollInterval);
    try {
        const teams = await getTeams(config, loginResponseOverride);
        let targetTeamId = null;

        for (const team of teams) {
            if (team.name === config.teamName) {
                targetTeamId = team.id;
                core.info(`Found team "${config.teamName}" with ID: ${targetTeamId}`);
                break;
            }
        }

        if (targetTeamId === null) {
            core.info(`Team "${config.teamName}" not found, attempting to use Default team`);
            for (const team of teams) {
                if (team.name === 'Default') {
                    targetTeamId = team.id;
                    core.info(`Found 'Default' team with ID: ${targetTeamId}`);
                    break;
                }
            }
        }

        if (targetTeamId === null) {
            core.error('Could not find team to assign the app to. Continuing with scan...');
        } else {
            await assignAppToTeam(result.zdevAppId, targetTeamId, config, loginResponseOverride);
            core.info(`App ${result.zdevAppId} successfully assigned to team ${config.teamName}`);
        }
    } catch (teamAssignmentError) {
        core.warning(`Team assignment failed: ${describeError(teamAssignmentError)}. Continuing with scan...`);
    }
}

function evaluateFindings(jsonResult, statusResult, originalFileName, config) {
    let report;
    try {
        report = JSON.parse(fs.readFileSync(jsonResult.reportFileName, 'utf8'));
    } catch (error) {
        throw new Error(
            `Unable to parse the JSON report ${jsonResult.reportFileName} required for scan evaluation: ${describeError(error)}`
        );
    }

    const summary = summarizeScanReport(report);
    core.info(`Scan Summary for assessment ${statusResult.id}:`);
    Object.keys(SEVERITY_RANKS).forEach(severity => {
        const counts = summary[severity];
        if (counts.total > 0 || counts.unaccepted > 0) {
            core.info(`  ${severity}: total=${counts.total}, unaccepted=${counts.unaccepted}`);
        }
    });

    const criteriaDescription = `mode=${config.scanEvaluationMode}, minimum severity=${config.minimumSeverity}`;
    if (reportMatchesCriteria(report, config.scanEvaluationMode, config.minimumSeverity)) {
        core.setFailed(`Scan findings met the configured criteria (${criteriaDescription}) for ${originalFileName}.`);
    } else {
        core.info(`Scan findings did not meet the configured criteria (${criteriaDescription}) for ${originalFileName}.`);
    }
}

/**
 * Runs one upload -> one assessment -> N report downloads for a single file.
 */
async function processUploadResult(result, config, loginResponseOverride = undefined) {
    await ensureTeamAssignment(result, config, loginResponseOverride);

    const statusResult = await pollStatus(result.buildId, config, loginResponseOverride);
    const assessmentId = statusResult.id;

    const userFormats = normalizeReportFormats(config.reportFormat);
    const formatsToFetch = [...userFormats];
    if (config.failOnScanFindings && !formatsToFetch.includes('json')) {
        formatsToFetch.push('json');
    }

    core.info(
        `Downloading ${formatsToFetch.length} report format(s) [${formatsToFetch.join(', ')}] ` +
        `from assessment ${assessmentId} for ${result.originalFileName}.`
    );

    const downloadedResults = {};
    for (const format of formatsToFetch) {
        // Every format is pulled from the same assessment id: one upload, one scan.
        downloadedResults[format] = await pollDownload(assessmentId, result.originalFileName, format, config, loginResponseOverride);
    }

    if (config.failOnScanFindings && downloadedResults['json']) {
        evaluateFindings(downloadedResults['json'], statusResult, result.originalFileName, config);
    }

    return userFormats.map(format => downloadedResults[format]).filter(Boolean);
}

async function runAction() {
    const config = getActionConfig();
    core.debug(`env ${config.clientEnv}`);
    core.debug(`console url ${config.consoleUrl}`);
    core.debug(`app: ${config.clientApp}`);
    core.debug(`report formats: ${config.reportFormat.join(', ')}`);

    const uploadResults = await uploadApp(config);
    const uploadFailures = uploadResults.uploadFailures || [];

    const settled = await Promise.allSettled(
        uploadResults.map(result => processUploadResult(result, config))
    );

    core.info('Zimperium zScan Marketplace Action Finished');

    const reportFiles = [];
    const failures = uploadFailures.map(f => f.message);

    settled.forEach((outcome, index) => {
        const originalFileName = uploadResults[index].originalFileName;
        if (outcome.status === 'fulfilled') {
            outcome.value.forEach(r => reportFiles.push(r.reportFileName));
        } else {
            failures.push(`${originalFileName}: ${describeError(outcome.reason)}`);
        }
    });

    core.debug('Verifying generated report files');
    for (const reportFile of reportFiles) {
        try {
            verifyReportFile(reportFile);
            core.info(`Assessment results file ${reportFile} successfully generated.`);
        } catch (error) {
            core.error(`ERROR: ${error.message}`);
            failures.push(error.message);
        }
    }

    if (failures.length > 0) {
        core.setFailed(`zScan action completed with ${failures.length} failure(s): ${failures.join('; ')}`);
    }

    return {reportFiles, failures};
}

if (require.main === module) {
    runAction().catch(error => {
        core.setFailed(describeError(error));
    });
}

module.exports = {
    NonRetryableError,
    getMatchingFiles,
    loginHttpRequest,
    uploadApp,
    statusHttpRequest,
    interpretStatusResponse,
    pollStatus,
    downloadApp,
    pollDownload,
    verifyReportFile,
    getTeams,
    assignAppToTeam,
    isTransientError,
    withRetry,
    parseBoundedNumber,
    redact,
    normalizeReportFormat,
    normalizeReportFormats,
    normalizeScanEvaluationMode,
    normalizeSeverity,
    parseFindingSeverity,
    parseFindingAccepted,
    summarizeScanReport,
    reportMatchesCriteria,
    processUploadResult,
    resetStateForTesting,
    sleep,
    runAction
};
