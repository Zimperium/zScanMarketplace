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

function getActionConfig() {
    if (!actionConfig) {
        actionConfig = {
            clientEnv: core.getInput('client_env', { required: false }),
            consoleUrl: core.getInput('console_url', { required: false }),
            clientId: core.getInput('client_id', { required: true }),
            clientSecret: core.getInput('client_secret', { required: true }),
            clientApp: core.getInput('app_file', { required: true }),
            teamName: core.getInput('team_name', { required: false }) || 'Default',
            reportFormat: normalizeReportFormats(core.getInput('report_format', { required: false })),
            failOnScanFindings: core.getBooleanInput('fail_on_scan_findings', { required: false }),
            scanEvaluationMode: normalizeScanEvaluationMode(core.getInput('scan_evaluation_mode', { required: false })),
            minimumSeverity: normalizeSeverity(core.getInput('minimum_severity', { required: false }) || 'low')
        };
    }

    return actionConfig;
}

function normalizeReportFormats(value) {
    if (Array.isArray(value)) {
        value = value.join(',');
    }
    const rawItems = String(value || 'sarif')
        .toLowerCase()
        .split(/[\s,;|]+/)
        .map(s => s.trim())
        .filter(Boolean);

    if (rawItems.includes('all')) {
        return ['sarif', 'json', 'pdf'];
    }

    const valid = rawItems.filter(f => ['json', 'sarif', 'pdf'].includes(f));
    const unique = Array.from(new Set(valid));
    return unique.length > 0 ? unique : ['sarif'];
}

function normalizeReportFormat(value) {
    const formats = normalizeReportFormats(value);
    return formats.length === 1 ? formats[0] : formats;
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
                core.info("Authentication successful");
                resolve(loginResponse);
            } catch (error) {
                core.error('Error during authentication request: ' + error.toString);
                if (error.response && error.response.status === 403 || error.response && error.response.status === 401) {
                    core.info(ERROR_MESSAGE_AUTH);
                }
                reject(error);
            }
        }
    });
}

async function getMatchingFiles(pattern) {
    try {
        const files = await glob.glob(pattern);
        core.debug(`Files matching pattern "${pattern}": ${files.join(', ')}`);
        if (files.length > MAX_FILES) {
            throw new Error(`Pattern matched ${files.length} files, which exceeds the maximum limit of ${MAX_FILES}. Please narrow down your pattern.`);
        }
        
        return files;
    } catch (err) {
        throw err;
    }
}

async function uploadApp(actionConfig = getActionConfig(), loginResponseOverride = undefined) {
    const config = actionConfig || getActionConfig();
    const loginResponse = loginResponseOverride || await loginHttpRequest(config);
    core.debug('Entering uploadApp');
    try {
        const matchingFiles = await getMatchingFiles(config.clientApp);
        
        if (matchingFiles.length === 0) {
            throw new Error(`No files found matching pattern: ${config.clientApp}`);
        }
        
        const results = [];
        for (const file of matchingFiles) {
            core.info(`Uploading file: ${file}`);
            const formData = new FormData();
            formData.append('buildFile', fs.createReadStream(file));
            formData.append('notifyUploader', 'false');

            try {
                const response = await axios.post(`${getBaseUrl(config)}/api/zdev-upload/public/v1/uploads/build`, formData, {
                    headers: {
                        ...formData.getHeaders(),
                        'Authorization': 'Bearer ' + loginResponse.accessToken
                    }
                });

                const result = response.data;
                result.originalFileName = file;
                
                core.info(`Upload successful for ${file}; buildId: ${result.buildId}`);
                core.info(`buildId: ${result.buildId}`);
                core.info(`zdevAppId: ${result.zdevAppId}`);
                core.info(`teamId: ${result.teamId}`);
                core.info(`buildUploadedAt: ${result.buildUploadedAt}`);
                core.info(`buildNumber: ${result.zdevUploadResponse.appBuildVersion}`);
                core.info(`bundleIdentifier: ${result.zdevUploadResponse.bundleIdentifier}`);
                core.info(`appVersion: ${result.zdevUploadResponse.appVersion}`);
                core.debug(`Upload response data: ${JSON.stringify(result)}`);

                results.push(result);
            } catch (error) {
                core.error(`Failed to upload file ${file}: ${error.message}`);
                continue;
            }
        }
        
        return results;
    } catch (error) {
        core.error(error.message);
        throw error;
    }
}

async function statusHttpRequest(buildId, actionConfig = getActionConfig(), loginResponseOverride = undefined) {
    const config = actionConfig || getActionConfig();
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
        core.debug('Error during status request: ' + error.toString);
        // The service is returning 500's even though it is still working
        return {zdevMetadata: {analysis: error.response?.status}};
    }
}

async function pollStatus(buildId) {
    await sleep(STATUS_POLL_TIME);
    let done = false;
    let totalTime = 0;
    let status = null;
    core.debug('Entering pollStatus for buildId: ' + buildId);
    while(!done && totalTime < MAX_POLL_TIME) {
        status = await statusHttpRequest(buildId);
        if(status.zdevMetadata.analysis === 'Done' || status.zdevMetadata.analysis === 'Failed' ) {
            core.info(`zScan finished for buildId ` + buildId + ` - final status: ${status.zdevMetadata.analysis}`);
            done = true;
            return status;
        } else {
            core.info(`${new Date().toISOString()} - zScan status for buildId ` + buildId + ` is ${status.zdevMetadata.analysis}`);
            totalTime += STATUS_POLL_TIME;
            await sleep(STATUS_POLL_TIME);
        }
    }
    if( totalTime >= MAX_POLL_TIME ) {
        core.info( 'Max waiting time has been exceeded for buildId ' + buildId + '.' );
    }
}

function shouldRetryDownload(status) {
    return [400, 404, 429, 500, 502, 503, 504].includes(status);
}

async function downloadApp(assessmentId, originalFileName, actionConfig = getActionConfig(), loginResponseOverride = undefined, reportFormat = undefined) {
    const config = actionConfig || getActionConfig();
    core.debug('Entering downloadApp for file: ' + originalFileName);
    const loginResponse = loginResponseOverride || await loginHttpRequest(config);
    try {
        const defaultFormat = Array.isArray(config.reportFormat) ? config.reportFormat[0] : config.reportFormat;
        const rawFormat = reportFormat || defaultFormat;
        const normalized = normalizeReportFormat(rawFormat);
        const format = Array.isArray(normalized) ? normalized[0] : normalized;
        let response;
        if (format === 'pdf') {
            const reportResponse = await axios.get(`${getBaseUrl(config)}/api/zdev-app/public/v1/assessments/${assessmentId}/report`, {
                headers: {
                    'Authorization': 'Bearer ' + loginResponse.accessToken
                }
            });
            const reportUrl = reportResponse.data && reportResponse.data.cdn_link;
            if (!reportUrl) {
                throw new Error(`PDF report URL was not returned for assessment ${assessmentId}.`);
            }
            response = await axios.get(reportUrl, { responseType: 'arraybuffer' });
        } else {
            response = await axios.get(`${getBaseUrl(config)}/api/zdev-app/public/v1/assessments/${assessmentId}/${format}`, {
                headers: {
                    'Authorization': 'Bearer ' + loginResponse.accessToken
                },
                responseType: 'arraybuffer'
            });
        }
        
        // Generate unique report filename based on original file
        const baseName = path.basename(originalFileName, path.extname(originalFileName));
        const reportFileName = `${baseName}_zscan.${format}`;
        fs.writeFileSync(reportFileName, Buffer.from(response.data));
        return {statusCode: response.status, reportFileName};
    } catch (error) {
        if (error.response && shouldRetryDownload(error.response.status)) {
            return {statusCode: error.response.status};
        }
        throw error;
    }
}

async function pollDownload(assessmentId, originalFileName, reportFormat = undefined) {
    const config = getActionConfig();
    const defaultFormat = Array.isArray(config.reportFormat) ? config.reportFormat[0] : config.reportFormat;
    const rawFormat = reportFormat || defaultFormat;
    const normalized = normalizeReportFormat(rawFormat);
    const format = Array.isArray(normalized) ? normalized[0] : normalized;
    await sleep(DOWNLOAD_POLL_TIME);
    core.debug('Entering pollDownload for file: ' + originalFileName);
    let done = false;
    let totalTime = 0;
    while(!done && totalTime < MAX_DOWNLOAD_TIME) {
        let result = await downloadApp(assessmentId, originalFileName, getActionConfig(), undefined, format);
        core.debug(`Download attempt returned status code: ${result.statusCode}`);
        if(result.statusCode == 200) {
            core.info(`${format.toUpperCase()} file ${result.reportFileName} download complete.`);
            done = true;
            return result;
        } else {
            core.info(`${format.toUpperCase()} file download is not ready, waiting to try again.`);
            totalTime += DOWNLOAD_POLL_TIME;
            await sleep(DOWNLOAD_POLL_TIME);
        }
    }
}

async function getTeams(actionConfig = getActionConfig(), loginResponseOverride = undefined) {
    const config = actionConfig || getActionConfig();
    const loginResponse = loginResponseOverride || await loginHttpRequest(config);
    try {
        const response = await axios.get(`${getBaseUrl(config)}/api/auth/public/v1/teams`, {
            headers: {
                'Authorization': 'Bearer ' + loginResponse.accessToken
            }
        });
        return response.data.content;
    } catch (error) {
        core.error(`Failed to fetch teams list: ${error.message}`);
        throw error;
    }
}

async function assignAppToTeam(appId, teamId, actionConfig = getActionConfig(), loginResponseOverride = undefined) {
    const config = actionConfig || getActionConfig();
    const loginResponse = loginResponseOverride || await loginHttpRequest(config);
    try {
        const response = await axios.put(`${getBaseUrl(config)}/api/zdev-app/public/v1/apps/${appId}/upload`, 
            { "teamId": teamId },
            {
                headers: {
                    'Authorization': 'Bearer ' + loginResponse.accessToken,
                    'Content-Type': 'application/json'
                }
            }
        );
        core.info(`App assigned to team successfully`);
        return response.data;
    } catch (error) {
        core.error(`Failed to assign app to team: ${error.message}`);
        throw error;
    }
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function runAction() {
    const config = getActionConfig();
    core.debug(`env ${config.clientEnv}`);
    core.debug(`console url ${config.consoleUrl}`);
    core.debug(`id ${config.clientId}`);
    core.debug(`secret ` + config.clientSecret.slice(0, 10) + `...`);
    core.debug(`app: ${config.clientApp}`);

    const uploadResults = await uploadApp(config);
    const promises = uploadResults.map(result => 
        (async () => {
            try {
                // Check if app needs to be assigned to a team
                if (result.teamId === null || result.teamId === undefined) {
                    core.info(`App ${result.zdevAppId} not assigned to a team, attempting to assign to team: ${config.teamName}`);
                    // Wait for a short time to ensure the app is available for team assignment
                    await sleep(STATUS_POLL_TIME);
                    try {
                        const teams = await getTeams(config);
                        let targetTeamId = null;
                        
                        // Find the team ID matching the requested team name
                        for (const team of teams) {
                            if (team.name === config.teamName) {
                                targetTeamId = team.id;
                                core.info(`Found team "${config.teamName}" with ID: ${targetTeamId}`);
                                break;
                            }
                        }
                        
                        // If team not found, use Default team
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
                            await assignAppToTeam(result.zdevAppId, targetTeamId, config);
                            core.info(`App ${result.zdevAppId} successfully assigned to team ${config.teamName}`);
                        }
                    } catch (teamAssignmentError) {
                        core.warning(`Team assignment failed: ${teamAssignmentError.message}. Continuing with scan...`);
                    }
                } else {
                    core.info(`App ${result.zdevAppId} already belongs to team (ID: ${result.teamId})`);
                }
                
                const statusResult = await pollStatus(result.buildId);
                if (statusResult.zdevMetadata.analysis !== 'Failed') {
                    const userFormats = Array.isArray(config.reportFormat) ? config.reportFormat : normalizeReportFormats(config.reportFormat);
                    const formatsToFetch = new Set(userFormats);
                    if (config.failOnScanFindings) {
                        formatsToFetch.add('json');
                    }

                    const downloadedResults = {};
                    for (const format of formatsToFetch) {
                        downloadedResults[format] = await pollDownload(statusResult.id, result.originalFileName, format);
                    }

                    if (config.failOnScanFindings && downloadedResults['json']) {
                        const jsonResult = downloadedResults['json'];
                        const report = JSON.parse(fs.readFileSync(jsonResult.reportFileName, 'utf8'));
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
                            core.setFailed(`Scan findings met the configured criteria (${criteriaDescription}) for ${result.originalFileName}.`);
                        } else {
                            core.info(`Scan findings did not meet the configured criteria (${criteriaDescription}) for ${result.originalFileName}.`);
                        }
                    }

                    const userResults = userFormats.map(fmt => downloadedResults[fmt]).filter(Boolean);
                    return userResults.length === 1 ? userResults[0] : userResults;
                }
            } catch (error) {
                throw error;
            }
            core.debug(`No valid status result for buildId ${result.buildId}, skipping download.`);
        })()
    );

    const downloadResults = await Promise.all(promises);
    core.info('Zimperium zScan Marketplace Action Finished');
    
    // Check all generated report files
    core.debug('Verifying generated report files');
    const reportFiles = downloadResults.flat().filter(r => r && r.reportFileName).map(r => r.reportFileName);
    let allSuccessful = true;
    
    for (const reportFile of reportFiles) {
        core.debug(`Checking existence of report file: ${reportFile}`);
        try {
            fs.statSync(reportFile);
            core.info(`Assessment results file ${reportFile} successfully generated.`);
        } catch (err) {
            core.error(`ERROR: Assessment results file ${reportFile} was not successfully created.`);
            allSuccessful = false;
        }
    }
    
    if (!allSuccessful) {
        core.setFailed('One or more assessment result files were not successfully created.');
    }
}

if (require.main === module) {
    runAction().catch(error => {
        core.setFailed(error.message);
    });
}

module.exports = {
    getMatchingFiles,
    loginHttpRequest,
    uploadApp,
    statusHttpRequest,
    pollStatus,
    downloadApp,
    getTeams,
    assignAppToTeam,
    normalizeReportFormat,
    normalizeReportFormats,
    normalizeScanEvaluationMode,
    normalizeSeverity,
    parseFindingSeverity,
    parseFindingAccepted,
    summarizeScanReport,
    reportMatchesCriteria,
    sleep,
    runAction
};
