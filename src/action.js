const core = require('@actions/core');
const fs = require('fs');

const clientEnv = core.getInput('client_env', { required: false });
const clientId = core.getInput('client_id', { required: false });
const clientSecret = core.getInput('client_secret', { required: false });
const appFile = core.getInput('app_file', { required: false });

core.debug(`env ${clientEnv}`);
core.debug(`id ${clientId}`);
core.debug(`secret: ${clientSecret.substring(0,3)}`);
core.debug(`app: ${appFile}`);

const sampleJson =
    '{"$schema":"https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json",' +
    '"version":"2.1.0","runs":[{"tool":{"driver":{"name":"Zimperium zScan Analysis","semanticVersion":"0.0",' +
    '"informationUri":"https://ziap.zimperium.com","rules":[{"id":"5d8dde2c-d68f-b895-195f-561200000000",' +
    '"name":"Sample Rule 1","shortDescription":{"text":"Sample Short Description"},' +
    '"fullDescription":{"text":"Sample Full Description"},"properties":{"tags":["Sample Tag 1"],"severity":"Low",' +
    '"type":"privacy","category":"Personal Data","subcategory":"Logging"}}],"properties":{"appVersion":"2.0"}}},' +
    '"results":[{"ruleId":"R1","ruleIndex":0,"message":{"text":"Sample Result Text"},' +
    '"locations":[{"physicalLocation":{"artifactLocation":{"uri":"Location"},"region":{"startLine":133,' +
    '"snippet":{"text":"Text"}}}}]}]}]}'

core.setOutput( "sarifJson", sampleJson);

fs.writeFile("Zimperium.sarif", sampleJson, (err) => {});
