const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const axios = require('axios');

const { getMatchingFiles, downloadApp } = require('../src/action');

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'zscan-action-'));
}

test('getMatchingFiles returns matches and rejects when the pattern is too broad', async () => {
  const dir = createTempDir();
  try {
    for (let i = 0; i < 2; i += 1) {
      fs.writeFileSync(path.join(dir, `sample-${i}.apk`), 'test');
    }

    const matches = await getMatchingFiles(path.join(dir, '*.apk'));
    assert.equal(matches.length, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('getMatchingFiles throws when the pattern matches more than five files', async () => {
  const dir = createTempDir();
  try {
    for (let i = 0; i < 6; i += 1) {
      fs.writeFileSync(path.join(dir, `sample-${i}.apk`), 'test');
    }

    await assert.rejects(
      () => getMatchingFiles(path.join(dir, '*.apk')),
      /exceeds the maximum limit of 5/
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('downloadApp writes a SARIF report file with a derived filename', async () => {
  const dir = createTempDir();
  const previousCwd = process.cwd();
  let originalGet;

  try {
    process.chdir(dir);

    originalGet = axios.get;
    axios.get = async (url, options) => {
      assert.match(url, /assessments\/123\/sarif/);
      assert.equal(options.headers.Authorization, 'Bearer test-token');
      return {
        status: 200,
        data: Buffer.from('{"runs":[]}')
      };
    };

    const result = await downloadApp('123', 'Sample_App.apk', {
      baseUrl: 'https://example.test',
      clientId: 'client-id',
      clientSecret: 'client-secret',
      clientEnv: 'prod',
      consoleUrl: 'https://example.test',
      teamName: 'Default'
    }, {
      accessToken: 'test-token'
    });

    assert.equal(result.statusCode, 200);
    assert.equal(result.reportFileName, 'Sample_App_zscan.sarif');
    assert.equal(fs.readFileSync(path.join(dir, 'Sample_App_zscan.sarif'), 'utf8'), '{"runs":[]}');
  } finally {
    axios.get = originalGet;
    process.chdir(previousCwd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
