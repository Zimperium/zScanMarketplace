const axios = require('axios');
const core = require('@actions/core');
const fs = require('fs');
const glob = require('glob');
const path = require('path');
const FormData = require('form-data');

const clientEnv = core.getInput('client_env', { required: false });
const consoleUrl = core.getInput('console_url', { required: false });
const clientId = core.getInput('client_id', { required: true });
const clientSecret = core.getInput('client_secret', { required: true });
const clientApp = core.getInput('app_file', { required: true });
const teamName = core.getInput('team_name', { required: false }) || 'Default';

const DOWNLOAD_POLL_TIME = 6/*seconds*/ * 1000/*ms*/;
const STATUS_POLL_TIME = 30/*seconds*/ * 1000/*ms*/;
const MAX_POLL_TIME = 45/*minutes*/ * 60/*seconds*/ * 1000/*ms*/;
const MAX_DOWNLOAD_TIME = 20/*minutes*/ * 60/*seconds*/ * 1000/*ms*/;
const MAX_FILES = 5; // Maximum number of files to process
const ERROR_MESSAGE_AUTH = "********************\n" +
    "Authentication Error: The action failed due to incorrect credentials. Please update and try again.\n" +
    "********************\n";

let loginResponse = undefined;
const baseUrl = (!consoleUrl) ? `https://${clientEnv}.zimperium.com` : consoleUrl;
if (baseUrl.endsWith('/')) {
    baseUrl = baseUrl.slice(0, -1);
}
core.debug(`Base URL: ${baseUrl}`);

function loginHttpRequest() {
    core.debug('Entering loginHttpRequest');
    return new Promise(async function (resolve, reject) {
        let expired = true;
        if(loginResponse != undefined) {
            let claims = JSON.parse(Buffer.from(loginResponse.accessToken.split('.')[1], 'base64'));
            if (Date.now() < claims.exp * 1000) {
                expired = false;
                resolve(loginResponse);
            }
        }

        if (expired) {
            core.debug('Access token expired or not present, performing login request');
            const url = `${baseUrl}/api/auth/v1/api_keys/login`;
            core.debug(`Authenticating with ${url}`);
            const clientInfo = {"clientId": clientId, "secret": clientSecret};
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

async function uploadApp() {
    const loginResponse = await loginHttpRequest();
    core.debug('Entering uploadApp');
    try {
        const matchingFiles = await getMatchingFiles(clientApp);
        
        if (matchingFiles.length === 0) {
            throw new Error(`No files found matching pattern: ${clientApp}`);
        }
        
        const results = [];
        for (const file of matchingFiles) {
            core.info(`Uploading file: ${file}`);
            const formData = new FormData();
            formData.append('buildFile', fs.createReadStream(file));
            formData.append('notifyUploader', 'false');

            try {
                const response = await axios.post(`${baseUrl}/api/zdev-upload/public/v1/uploads/build`, formData, {
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

async function statusHttpRequest(buildId) {
    core.debug('Entering statusHttpRequest for buildId: ' + buildId);
    const loginResponse = await loginHttpRequest();
    try {
        const response = await axios.get(`${baseUrl}/api/zdev-app/public/v1/assessments/status?buildId=${buildId}`, {
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

async function downloadApp(assessmentId, originalFileName) {
    core.debug('Entering downloadApp for file: ' + originalFileName);
    const loginResponse = await loginHttpRequest();
    try {
        const response = await axios.get(`${baseUrl}/api/zdev-app/public/v1/assessments/${assessmentId}/sarif`, {
            headers: {
                'Authorization': 'Bearer ' + loginResponse.accessToken
            },
            responseType: 'arraybuffer'
        });
        
        // Generate unique report filename based on original file
        const baseName = path.basename(originalFileName, path.extname(originalFileName));
        const reportFileName = `${baseName}_zscan.sarif`;
        fs.writeFileSync(reportFileName, Buffer.from(response.data));
        return {statusCode: response.status, reportFileName};
    } catch (error) {
        if (error.response && error.response.status === 404) {
            return {statusCode: 404};
        }
        throw error;
    }
}

async function pollDownload(assessmentId, originalFileName) {
    await sleep(DOWNLOAD_POLL_TIME);
    core.debug('Entering pollDownload for file: ' + originalFileName);
    let done = false;
    let totalTime = 0;
    while(!done && totalTime < MAX_DOWNLOAD_TIME) {
        let result = await downloadApp(assessmentId, originalFileName);
        core.debug(`Download attempt returned status code: ${result.statusCode}`);
        if(result.statusCode == 200) {
            core.info(`Sarif file ${result.reportFileName} download complete.`);
            done = true;
            return result;
        } else {
            core.info('Sarif file download is not ready, waiting to try again.');
            totalTime += DOWNLOAD_POLL_TIME;
            await sleep(DOWNLOAD_POLL_TIME);
        }
    }
}

async function getTeams() {
    const loginResponse = await loginHttpRequest();
    try {
        const response = await axios.get(`${baseUrl}/api/auth/public/v1/teams`, {
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

async function assignAppToTeam(appId, teamId) {
    const loginResponse = await loginHttpRequest();
    try {
        const response = await axios.put(`${baseUrl}/api/zdev-app/public/v1/apps/${appId}/upload`, 
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

core.debug(`env ${clientEnv}`);
core.debug(`console url ${consoleUrl}`);
core.debug(`id ${clientId}`);
core.debug(`secret ` + clientSecret.slice(0, 10) + `...`);
core.debug(`app: ${clientApp}`);

uploadApp().then(uploadResults => {
    const promises = uploadResults.map(result => 
        (async () => {
            try {
                // Check if app needs to be assigned to a team
                if (result.teamId === null || result.teamId === undefined) {
                    core.info(`App ${result.zdevAppId} not assigned to a team, attempting to assign to team: ${teamName}`);
                    // Wait for a short time to ensure the app is available for team assignment
                    await sleep(STATUS_POLL_TIME);
                    try {
                        const teams = await getTeams();
                        let targetTeamId = null;
                        
                        // Find the team ID matching the requested team name
                        for (const team of teams) {
                            if (team.name === teamName) {
                                targetTeamId = team.id;
                                core.info(`Found team "${teamName}" with ID: ${targetTeamId}`);
                                break;
                            }
                        }
                        
                        // If team not found, use Default team
                        if (targetTeamId === null) {
                            core.info(`Team "${teamName}" not found, attempting to use Default team`);
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
                            await assignAppToTeam(result.zdevAppId, targetTeamId);
                            core.info(`App ${result.zdevAppId} successfully assigned to team ${teamName}`);
                        }
                    } catch (teamAssignmentError) {
                        core.warning(`Team assignment failed: ${teamAssignmentError.message}. Continuing with scan...`);
                    }
                } else {
                    core.info(`App ${result.zdevAppId} already belongs to team (ID: ${result.teamId})`);
                }
                
                const statusResult = await pollStatus(result.buildId);
                if (statusResult.zdevMetadata.analysis !== 'Failed') {
                    return pollDownload(statusResult.id, result.originalFileName);
                }
            } catch (error) {
                throw error;
            }
            core.debug(`No valid status result for buildId ${result.buildId}, skipping download.`);
        })()
    );
    
    Promise.all(promises).then((downloadResults) => {
        core.info('Zimperium zScan Marketplace Action Finished');
        
        // Check all generated report files
        core.debug('Verifying generated report files');
        const reportFiles = downloadResults.filter(r => r && r.reportFileName).map(r => r.reportFileName);
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
    });
}).catch(error => {
    core.setFailed(error.message);
});
