const unirest = require('unirest');
const core = require('@actions/core');
const fs = require('fs');

const clientEnv = core.getInput('client_env', { required: false });
const clientId = core.getInput('client_id', { required: false });
const clientSecret = core.getInput('client_secret', { required: false });
const clientApp = core.getInput('app_file', { required: false });

const MAX_POLL_TIME = 30/*minutes*/ * 60/*seconds*/ * 1000/*ms*/;

// const clientApp = '/Users/mattthibeeau/Development/zScanMarketplace/src/test.apk';

let loginResponse = undefined;

function loginHttpRequest() {
    return new Promise(function (resolve, reject) {
        let expired = true;
        if(loginResponse != undefined) {
            let claims = JSON.parse(new Buffer(loginResponse.accessToken.split('.')[1], 'base64'));
            if (Date.now() < claims.exp * 1000) {
                expired = false;
                resolve(loginResponse);
            }
        }

        if (expired) {
            core.debug("Requesting Auth Token");
            const url = `https://${clientEnv}.zimperium.com/api/auth/v1/api_keys/login`
            core.debug(url);
            unirest('POST', url)
                .headers({
                    'Content-Type': 'application/json'
                })
                .send(JSON.stringify({"clientId": clientId, "secret": clientSecret}))
                .end(function (res) {
                    if (res.error) reject(res.error);
                    loginResponse = JSON.parse(res.raw_body);
                    resolve(loginResponse);
                });
        }
    });
}

async function uploadApp() {
    const loginResponse = await loginHttpRequest()
    return new Promise(function (resolve, reject) {
        const url = `https://${clientEnv}.zimperium.com/api/zdev-upload/pub/v1/uploads/build`
        unirest('POST', url )
            .headers({'Content-Type': 'multipart/form-data', 'Authorization': 'Bearer ' + loginResponse.accessToken})
            .attach('buildFile', clientApp)
            .field('notifyUploader', 'false')
            .end(function (res) {
                if (res.error)
                    reject(res.error);
                resolve(JSON.parse(res.raw_body));
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
                if (res.error) //The service is returning 500's even though it is still working
                    resolve({zdevMetadata: {analysis: res.error.status}})
                resolve(JSON.parse(res.raw_body));
            });
    });
}

async function pollStatus(buildId) {
    await sleep(15000);
    let done = false;
    let totalTime = 0;
    while(!done && totalTime < MAX_POLL_TIME) {
        let status = await statusHttpRequest(buildId);
        core.debug(status);
        if(status.zdevMetadata.analysis === 'Done' || status.zdevMetadata.analysis === 'Failed' ) {
            core.debug(`Finished state: ${status.zdevMetadata.analysis}`);
            done = true;
            return status;
        } else {
            core.debug(`Sleeping: ${status.zdevMetadata.analysis}`);
            totalTime += 10000;
            await sleep(10000);
        }
    }
}

async function downloadApp(appId) {
    sleep(5000); //Uggh, if you request the assessment too fast you get a 500.
    const loginResponse = await loginHttpRequest()
    return new Promise(function (resolve, reject) {
        let url = `https://${clientEnv}.zimperium.com/api/zdev-app/pub/v1/assessments/${appId}/sarif`
        unirest('GET', url)
            .headers({'Authorization': 'Bearer ' + loginResponse.accessToken})
            .end(function (res) {
                if (res.error) throw new Error(res.error);
                fs.writeFileSync('Zimperium.sarif', Buffer.from(res.raw_body));
            });
    });
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

core.debug(`env ${clientEnv}`);
core.debug(`id ${clientId}`);
core.debug(`secret: ${clientSecret.substring(0,3)}`);
core.debug(`app: ${clientApp}`);

uploadApp().then(uploadResult => {
    pollStatus(uploadResult.buildId).then(statusResult => {
        downloadApp(statusResult.id).then(downloadResult => {
            core.debug('Finished!');
        });
    });
});

