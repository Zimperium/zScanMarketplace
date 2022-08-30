const unirest = require('unirest');
const core = require('@actions/core');
const fs = require('fs');

const clientEnv = core.getInput('client_env', { required: false });
const clientId = core.getInput('client_id', { required: false });
const clientSecret = core.getInput('client_secret', { required: false });
const clientApp = core.getInput('app_file', { required: false });

const DOWNLOAD_POLL_TIME = 6/*seconds*/ * 1000/*ms*/;
const STATUS_POLL_TIME = 30/*seconds*/ * 1000/*ms*/;
const MAX_POLL_TIME = 45/*minutes*/ * 60/*seconds*/ * 1000/*ms*/;
const MAX_DOWNLOAD_TIME = 20/*minutes*/ * 60/*seconds*/ * 1000/*ms*/;
const ERROR_MESSAGE_403 = "********************\n" +
    "The action failed due to incorrect credentials or trial license expiry. Please try again.\n" +
    "If your 30-day trial period has ended, please email us at info@zimperium.com with your details to obtain a paid license.\n" +
    "********************\n";

    let loginResponse = undefined;

function loginHttpRequest() {
    return new Promise(function (resolve, reject) {
        let expired = true;
        if(loginResponse != undefined) {
            let claims = JSON.parse(new Buffer.from(loginResponse.accessToken.split('.')[1], 'base64'));
            if (Date.now() < claims.exp * 1000) {
                expired = false;
                resolve(loginResponse);
            }
        }

        if (expired) {
            const url = `https://${clientEnv}.zimperium.com/api/auth/v1/api_keys/login`;
            core.info(`Authenticating with ${url}`);
            const clientInfo = JSON.stringify({"clientId": clientId, "secret": clientSecret});
            unirest('POST', url)
                .headers({
                    'Content-Type': 'application/json'
                })
                .send(clientInfo)
                .end(function (res) {
                    if (res.error) {
                        if( res.statusCode == 403 ) {
                            core.info(ERROR_MESSAGE_403);
                        }
                        reject(res.error);
                    } else {
                        loginResponse = JSON.parse(res.raw_body);
                        core.info("Authentication successful");
                        resolve(loginResponse);
                    }
                });
        }
    });
}

async function uploadApp() {
    const loginResponse = await loginHttpRequest();
    return new Promise(function (resolve, reject) {
        core.info("Uploading App to Zimperium zScan server")
        const url = `https://${clientEnv}.zimperium.com/api/zdev-upload/pub/v1/uploads/build`
        unirest('POST', url )
            .headers({'Content-Type': 'multipart/form-data', 'Authorization': 'Bearer ' + loginResponse.accessToken})
            .attach('buildFile', clientApp)
            .field('notifyUploader', 'false')
            .end(function (res) {
                if (res.error) {
                    reject(res.error);
                } else {
                    core.info("App upload successful")
                    resolve(JSON.parse(res.raw_body));
                }
            });
    });
}

async function statusHttpRequest(buildId) {
    const loginResponse = await loginHttpRequest()
    return new Promise(function (resolve, reject) {
        const url = `https://${clientEnv}.zimperium.com/api/zdev-app/pub/v1/assessments/status?buildId=${buildId}`
        unirest('GET', url)
            .headers({'Authorization': 'Bearer ' + loginResponse.accessToken})
            .end(function (res) {
                if (res.error) { //The service is returning 500's even though it is still working
                    resolve({zdevMetadata: {analysis: res.error.status}})
                } else {
                    resolve(JSON.parse(res.raw_body));
                }
            });
    });
}

async function pollStatus(buildId) {
    await sleep(STATUS_POLL_TIME);
    let done = false;
    let totalTime = 0;
    while(!done && totalTime < MAX_POLL_TIME) {
        let status = await statusHttpRequest(buildId);
        if(status.zdevMetadata.analysis === 'Done' || status.zdevMetadata.analysis === 'Failed' ) {
            core.info(`App zScan Finished - final state: ${status.zdevMetadata.analysis}`);
            done = true;
            return status;
        } else {
            core.info(`${new Date().toISOString()} - App zScan status is ${status.zdevMetadata.analysis}`);
            totalTime += STATUS_POLL_TIME;
            await sleep(STATUS_POLL_TIME);
        }
    }
    if( totalTime >= MAX_POLL_TIME ) {
        core.error( 'Max waiting time has been exceeded.' );
    }
}

async function downloadApp(appId) {
    const loginResponse = await loginHttpRequest()
    return new Promise(function (resolve, reject) {
        let url = `https://${clientEnv}.zimperium.com/api/zdev-app/pub/v1/assessments/${appId}/sarif`
        unirest('GET', url)
            .headers({'Authorization': 'Bearer ' + loginResponse.accessToken})
            .end(function (res) {
                if (res.error && res.statusCode != 404) {
                    throw new Error(res.error);
                } else if (res.error) {
                    resolve(res.statusCode);
                } else {
                    fs.writeFileSync('Zimperium.sarif', Buffer.from(res.raw_body));
                    resolve(res.statusCode); //should be 200?
                }
            });
    });
}

async function pollDownload(appId) {
    await sleep(DOWNLOAD_POLL_TIME);
    let done = false;
    let totalTime = 0;
    while(!done && totalTime < MAX_DOWNLOAD_TIME) {
        let status = await downloadApp(appId);
        if(status == 200) {
            core.info('Sarif file download complete.');
            done = true;
            return status;
        } else {
            core.info('Sarif file download is not ready, waiting to try again.');
            totalTime += DOWNLOAD_POLL_TIME;
            await sleep(DOWNLOAD_POLL_TIME);
        }
    }
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

core.debug(`env ${clientEnv}`);
core.debug(`id ${clientId}`);
core.debug(`app: ${clientApp}`);

uploadApp().then(uploadResult => {
    pollStatus(uploadResult.buildId).then(statusResult => {
        pollDownload(statusResult.id).then(downloadResult => {
            core.info('Zimperium zScan Marketplace Action Finished');
            fs.stat('Zimperium.sarif', (err, stats) => {
                if (err) {
                    core.error(`ERROR: App Sarif file was not successfully created.`);
                } else {
                    core.info('App Sarif file successfully generated.');
                }
            });
        });
    });
});
