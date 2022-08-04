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
    '{\n' +
    '  "$schema": "https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json",\n' +
    '  "version": "2.1.0",\n' +
    '  "runs": [\n' +
    '    {\n' +
    '      "versionControlProvenance": [\n' +
    '        {\n' +
    '          "repositoryUri": "https://github.com/Zimperium/zScanExampleApp",\n' +
    '          "revisionId": "28915d7ad5b0a045b5e7647bfdf1b7a7df7328ea",\n' +
    '          "branch": "Testing123"\n' +
    '        }\n' +
    '      ],\n' +
    '      "tool": {\n' +
    '        "driver": {\n' +
    '          "name": "Zimperium zScan Analysis",\n' +
    '          "semanticVersion": "0.0",\n' +
    '          "informationUri": "https://ziap.zimperium.com",\n' +
    '          "rules": [\n' +
    '            {\n' +
    '              "id": "5d8dde2c-d68f-b895-195f-561200000000",\n' +
    '              "name": "Sample Rule 1",\n' +
    '              "shortDescription": {\n' +
    '                "text": "Sample Short Description"\n' +
    '              },\n' +
    '              "fullDescription": {\n' +
    '                "text": "Sample Full Description"\n' +
    '              },\n' +
    '              "properties": {\n' +
    '                "tags": [\n' +
    '                  "Sample Tag 1"\n' +
    '                ],\n' +
    '                "severity": "Low",\n' +
    '                "type": "privacy",\n' +
    '                "category": "Personal Data",\n' +
    '                "subcategory": "Logging"\n' +
    '              }\n' +
    '            }\n' +
    '          ],\n' +
    '          "properties": {\n' +
    '            "appVersion": "2.0"\n' +
    '          }\n' +
    '        }\n' +
    '      },\n' +
    '      "results": [\n' +
    '        {\n' +
    '          "ruleId": "R1",\n' +
    '          "ruleIndex": 0,\n' +
    '          "message": {\n' +
    '            "text": "Sample Result Text"\n' +
    '          },\n' +
    '          "locations": [\n' +
    '            {\n' +
    '              "physicalLocation": {\n' +
    '                "artifactLocation": {\n' +
    '                  "uri": "Location' + Math.floor(Math.random() * 1000) + '"\n' +
    '                },\n' +
    '                "region": {\n' +
    '                  "startLine": ' + Math.floor(Math.random() * 1000) + ',\n' +
    '                  "snippet": {\n' +
    '                    "text": "Text"\n' +
    '                  }\n' +
    '                }\n' +
    '              }\n' +
    '            }\n' +
    '          ]\n' +
    '        }\n' +
    '      ]\n' +
    '    }\n' +
    '  ]\n' +
    '}'

core.setOutput( "sarifJson", sampleJson);

fs.writeFile("Zimperium.sarif", sampleJson, (err) => {});
