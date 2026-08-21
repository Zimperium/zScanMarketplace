const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const axios = require('axios');

const {
  getMatchingFiles,
  downloadApp,
  normalizeReportFormat,
  normalizeScanEvaluationMode,
  parseFindingSeverity,
  parseFindingAccepted,
  reportMatchesCriteria
} = require('../src/action');

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

test('downloadApp supports PDF reports with a format-specific filename', async () => {
  const dir = createTempDir();
  const previousCwd = process.cwd();
  let originalGet;

  try {
    process.chdir(dir);
    originalGet = axios.get;
    axios.get = async (url, options) => {
      assert.match(url, /assessments\/123\/pdf/);
      assert.equal(options.responseType, 'arraybuffer');
      return {
        status: 200,
        data: Buffer.from('%PDF-test')
      };
    };

    const result = await downloadApp('123', 'Sample_App.apk', {
      consoleUrl: 'https://example.test',
      clientId: 'client-id',
      clientSecret: 'client-secret',
      clientEnv: 'prod',
      teamName: 'Default'
    }, {
      accessToken: 'test-token'
    }, 'pdf');

    assert.equal(result.reportFileName, 'Sample_App_zscan.pdf');
    assert.equal(fs.readFileSync(path.join(dir, result.reportFileName), 'utf8'), '%PDF-test');
  } finally {
    axios.get = originalGet;
    process.chdir(previousCwd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('report format and evaluation inputs normalize to supported values', () => {
  assert.equal(normalizeReportFormat('PDF'), 'pdf');
  assert.equal(normalizeReportFormat('invalid'), 'sarif');
  assert.equal(normalizeScanEvaluationMode('unaccepted_finding_only'), 'unaccepted_finding_only');
  assert.equal(normalizeScanEvaluationMode('invalid'), 'any_finding');
});

test('finding severity uses the JSON severity fields', () => {
  assert.equal(parseFindingSeverity({ severity: 'Critical', severityOrdinal: 4 }), 'critical');
  assert.equal(parseFindingSeverity({ severityOrdinal: 3 }), 'high');
  assert.equal(parseFindingSeverity({ severity: 'not-a-severity' }), 'unknown');
});

test('report criteria match severity and accepted status like Jenkins', () => {
  const report = {
    findings: [
      { severity: 'Low', severityOrdinal: 1, accepted_status: true },
      { severity: 'Critical', severityOrdinal: 4, accepted_status: false },
      { severity: 'Best Practices', severityOrdinal: 5, accepted_status: false }
    ]
  };

  assert.equal(parseFindingAccepted(report.findings[0]), false);
  assert.equal(parseFindingAccepted(report.findings[1]), true);
  assert.equal(reportMatchesCriteria(report, 'any_finding', 'high'), true);
  assert.equal(reportMatchesCriteria(report, 'unaccepted_finding_only', 'high'), true);
  assert.equal(reportMatchesCriteria(report, 'unaccepted_finding_only', 'critical'), true);
  assert.equal(reportMatchesCriteria(report, 'any_finding', 'critical'), true);
  assert.equal(reportMatchesCriteria(report, 'any_finding', 'invalid'), true);
});

test('report criteria ignore findings below the threshold and best practices', () => {
  const report = {
    findings: [
      { severity: 'Low', accepted_status: false },
      { severity: 'Best Practices', accepted_status: false }
    ]
  };

  assert.equal(reportMatchesCriteria(report, 'any_finding', 'high'), false);
  assert.equal(reportMatchesCriteria(report, 'any_finding', 'critical'), false);
});
