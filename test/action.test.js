const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const axios = require('axios');

const action = require('../src/action');
const {
  getMatchingFiles,
  downloadApp,
  pollDownload,
  pollStatus,
  statusHttpRequest,
  interpretStatusResponse,
  uploadApp,
  processUploadResult,
  verifyReportFile,
  isTransientError,
  withRetry,
  parseBoundedNumber,
  redact,
  NonRetryableError,
  normalizeReportFormat,
  normalizeReportFormats,
  normalizeScanEvaluationMode,
  parseFindingSeverity,
  parseFindingAccepted,
  summarizeScanReport,
  reportMatchesCriteria
} = action;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'zscan-action-'));
}

/** Fast timings so retry/timeout paths run instantly under test. */
function testConfig(overrides = {}) {
  return {
    consoleUrl: 'https://example.test',
    clientId: 'client-id',
    clientSecret: 'client-secret',
    clientEnv: 'prod',
    clientApp: './app.apk',
    teamName: 'Default',
    reportFormat: ['sarif'],
    failOnScanFindings: false,
    scanEvaluationMode: 'any_finding',
    minimumSeverity: 'low',
    retryAttempts: 3,
    retryDelay: 0,
    retryBackoffFactor: 1,
    statusTimeout: 300,
    statusPollInterval: 1,
    reportTimeout: 300,
    reportPollInterval: 1,
    ...overrides
  };
}

const LOGIN = {accessToken: 'test-token'};

function httpError(status, message = 'request failed') {
  const error = new Error(message);
  error.response = {status, data: {}};
  error.request = {};
  return error;
}

function networkError(code = 'ECONNRESET') {
  const error = new Error(`socket hang up (${code})`);
  error.code = code;
  error.request = {};
  return error;
}

/** Runs `fn` inside a temp cwd with axios stubbed, then restores everything. */
async function withStubbedHttp(stubs, fn) {
  const dir = createTempDir();
  const previousCwd = process.cwd();
  const original = {get: axios.get, post: axios.post, put: axios.put};
  const calls = {get: [], post: [], put: []};

  try {
    process.chdir(dir);
    for (const method of ['get', 'post', 'put']) {
      axios[method] = async (...args) => {
        calls[method].push(args);
        if (!stubs[method]) {
          throw new Error(`Unexpected axios.${method} call to ${args[0]}`);
        }
        return stubs[method](...args);
      };
    }
    return await fn({dir, calls});
  } finally {
    axios.get = original.get;
    axios.post = original.post;
    axios.put = original.put;
    process.chdir(previousCwd);
    fs.rmSync(dir, {recursive: true, force: true});
  }
}

/** Builds a sarif/json/pdf-aware GET stub driven by a per-format script. */
function reportGetStub(script, counters = {}) {
  return async (url, options) => {
    // CDN check must come first: signed CDN URLs can also contain "report".
    if (url.startsWith('https://cdn.example.test')) {
      counters.cdn = (counters.cdn || 0) + 1;
      const step = script.cdn ? script.cdn.shift() : undefined;
      if (step instanceof Error) throw step;
      return step !== undefined ? step : {status: 200, data: Buffer.from('%PDF-test')};
    }
    if (url.includes('/report')) {
      counters.metadata = (counters.metadata || 0) + 1;
      const step = script.metadata ? script.metadata.shift() : undefined;
      if (step instanceof Error) throw step;
      return step !== undefined ? step : {status: 200, data: {cdn_link: 'https://cdn.example.test/r/1?sig=abc'}};
    }
    const format = url.endsWith('/sarif') ? 'sarif' : url.endsWith('/json') ? 'json' : 'other';
    counters[format] = (counters[format] || 0) + 1;
    const step = script[format] ? script[format].shift() : undefined;
    if (step instanceof Error) throw step;
    return step !== undefined ? step : {status: 200, data: Buffer.from('{}')};
  };
}

// ---------------------------------------------------------------------------
// File matching (existing behavior preserved)
// ---------------------------------------------------------------------------

test('getMatchingFiles returns matches and rejects when the pattern is too broad', async () => {
  const dir = createTempDir();
  try {
    for (let i = 0; i < 2; i += 1) {
      fs.writeFileSync(path.join(dir, `sample-${i}.apk`), 'test');
    }
    const matches = await getMatchingFiles(path.join(dir, '*.apk'));
    assert.equal(matches.length, 2);
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
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
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

// ---------------------------------------------------------------------------
// Error classification + retry core
// ---------------------------------------------------------------------------

test('transient classification covers 408, 429, 500, 502, 503, 504 and network errors only', () => {
  assert.equal(isTransientError(httpError(408)), true);
  assert.equal(isTransientError(httpError(429)), true);
  assert.equal(isTransientError(httpError(500)), true);
  assert.equal(isTransientError(httpError(502)), true);
  assert.equal(isTransientError(httpError(503)), true);
  assert.equal(isTransientError(httpError(504)), true);
  assert.equal(isTransientError(networkError('ECONNRESET')), true);
  assert.equal(isTransientError(networkError('ETIMEDOUT')), true);

  assert.equal(isTransientError(httpError(400)), false);
  assert.equal(isTransientError(httpError(401)), false);
  assert.equal(isTransientError(httpError(403)), false);
  assert.equal(isTransientError(httpError(404)), false);
  assert.equal(isTransientError(httpError(422)), false);
  assert.equal(isTransientError(httpError(501)), false);
  assert.equal(isTransientError(new NonRetryableError('nope')), false);
  // 404 is only transient where explicitly opted in (status/report polling).
  assert.equal(isTransientError(httpError(404), [404]), true);
});

test('withRetry stops immediately on auth errors and never retries them', async () => {
  let attempts = 0;
  await assert.rejects(
    () => withRetry(async () => {
      attempts += 1;
      throw httpError(401);
    }, {config: testConfig(), label: 'Auth probe'}),
    err => err instanceof NonRetryableError && /failed authentication/.test(err.message)
  );
  assert.equal(attempts, 1);
});

test('parseBoundedNumber validates ranges and rejects invalid input', () => {
  assert.equal(parseBoundedNumber('', {name: 'x', fallback: 3, min: 1, max: 10}), 3);
  assert.equal(parseBoundedNumber('7', {name: 'x', fallback: 3, min: 1, max: 10}), 7);
  assert.throws(
    () => parseBoundedNumber('abc', {name: 'retry_attempts', fallback: 3, min: 1, max: 10}),
    /Invalid value for retry_attempts/
  );
  assert.throws(
    () => parseBoundedNumber('99', {name: 'retry_attempts', fallback: 3, min: 1, max: 10}),
    /between 1 and 10/
  );
});

test('redact removes bearer tokens but leaves signed CDN URLs intact', () => {
  const text = redact('****** failed at https://cdn.example.test/report?sig=SECRETSIG');
  assert.ok(!text.includes('abc.def.ghi'));
  // Signed CDN URLs are not redacted; they expire quickly and are useful for troubleshooting.
  assert.ok(text.includes('https://cdn.example.test/report?sig=SECRETSIG'));
});

// ---------------------------------------------------------------------------
// Upload retries
// ---------------------------------------------------------------------------

test('upload retries a transient failure and then succeeds', async () => {
  const dir = createTempDir();
  const appFile = path.join(dir, 'app.apk');
  fs.writeFileSync(appFile, 'binary');
  try {
    const responses = [httpError(503), {status: 200, data: {buildId: 'b1', zdevAppId: 'a1', teamId: 't1'}}];
    let attempts = 0;
    await withStubbedHttp({
      post: async () => {
        attempts += 1;
        const next = responses.shift();
        if (next instanceof Error) throw next;
        return next;
      }
    }, async () => {
      const results = await uploadApp(testConfig({clientApp: appFile}), LOGIN);
      assert.equal(results.length, 1);
      assert.equal(results[0].buildId, 'b1');
      assert.equal(results[0].originalFileName, appFile);
    });
    assert.equal(attempts, 2);
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('upload retries multiple transient failures before succeeding', async () => {
  const dir = createTempDir();
  const appFile = path.join(dir, 'app.apk');
  fs.writeFileSync(appFile, 'binary');
  try {
    const responses = [httpError(429), httpError(500), {status: 200, data: {buildId: 'b2'}}];
    let attempts = 0;
    await withStubbedHttp({
      post: async () => {
        attempts += 1;
        const next = responses.shift();
        if (next instanceof Error) throw next;
        return next;
      }
    }, async () => {
      const results = await uploadApp(testConfig({clientApp: appFile, retryAttempts: 3}), LOGIN);
      assert.equal(results[0].buildId, 'b2');
    });
    assert.equal(attempts, 3);
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('upload does not retry a non-transient failure and surfaces it', async () => {
  const dir = createTempDir();
  const appFile = path.join(dir, 'app.apk');
  fs.writeFileSync(appFile, 'binary');
  try {
    let attempts = 0;
    await withStubbedHttp({
      post: async () => {
        attempts += 1;
        throw httpError(422, 'unsupported binary');
      }
    }, async () => {
      await assert.rejects(
        () => uploadApp(testConfig({clientApp: appFile}), LOGIN),
        /All 1 app upload\(s\) failed/
      );
    });
    assert.equal(attempts, 1, 'non-transient upload failures must not be retried');
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('upload retries a network-level request failure and then succeeds', async () => {
  const dir = createTempDir();
  const appFile = path.join(dir, 'app.apk');
  fs.writeFileSync(appFile, 'binary');
  try {
    const responses = [networkError('ECONNRESET'), {status: 200, data: {buildId: 'b3'}}];
    let attempts = 0;
    await withStubbedHttp({
      post: async () => {
        attempts += 1;
        const next = responses.shift();
        if (next instanceof Error) throw next;
        return next;
      }
    }, async () => {
      const results = await uploadApp(testConfig({clientApp: appFile}), LOGIN);
      assert.equal(results[0].buildId, 'b3');
    });
    assert.equal(attempts, 2);
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('multiple input files: a failed upload is recorded and never looks successful', async () => {
  const dir = createTempDir();
  fs.writeFileSync(path.join(dir, 'a.apk'), 'binary');
  fs.writeFileSync(path.join(dir, 'b.apk'), 'binary');
  try {
    await withStubbedHttp({
      post: async (url, formData) => {
        // Fail whichever file is streamed second by alternating on call order.
        if (!withStubbedHttp.seen) withStubbedHttp.seen = 0;
        withStubbedHttp.seen += 1;
        if (withStubbedHttp.seen === 1) {
          throw httpError(422, 'rejected binary');
        }
        return {status: 200, data: {buildId: 'ok-build'}};
      }
    }, async () => {
      withStubbedHttp.seen = 0;
      const results = await uploadApp(testConfig({clientApp: path.join(dir, '*.apk')}), LOGIN);
      assert.equal(results.length, 1, 'only the successful upload is returned');
      assert.equal(results[0].buildId, 'ok-build');
      assert.equal(results.uploadFailures.length, 1);
      assert.match(results.uploadFailures[0].message, /Failed to upload file/);
    });
  } finally {
    delete withStubbedHttp.seen;
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('upload rejects a malformed success body that lacks a buildId', async () => {
  const dir = createTempDir();
  const appFile = path.join(dir, 'app.apk');
  fs.writeFileSync(appFile, 'binary');
  try {
    await withStubbedHttp({
      post: async () => ({status: 200, data: {somethingElse: true}})
    }, async () => {
      await assert.rejects(
        () => uploadApp(testConfig({clientApp: appFile}), LOGIN),
        /did not return a buildId/
      );
    });
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

// ---------------------------------------------------------------------------
// Status polling
// ---------------------------------------------------------------------------

test('status interpretation classifies pending, done, failed and malformed payloads', () => {
  assert.equal(interpretStatusResponse({zdevMetadata: {analysis: 'Processing'}}, 'b').state, 'pending');
  assert.equal(interpretStatusResponse({id: 'a1', zdevMetadata: {analysis: 'Done'}}, 'b').state, 'done');
  assert.equal(interpretStatusResponse({zdevMetadata: {analysis: 'Failed'}}, 'b').state, 'failed');
  assert.equal(interpretStatusResponse({}, 'b').state, 'malformed');
  assert.equal(interpretStatusResponse({zdevMetadata: {}}, 'b').state, 'malformed');
  assert.equal(interpretStatusResponse(null, 'b').state, 'malformed');
  // Done without an assessment id cannot be used downstream.
  assert.equal(interpretStatusResponse({zdevMetadata: {analysis: 'Done'}}, 'b').state, 'malformed');
});

test('status polling treats a transient 404 as not-ready and then completes', async () => {
  const responses = [httpError(404), {status: 200, data: {id: 'assess-1', zdevMetadata: {analysis: 'Done'}}}];
  await withStubbedHttp({
    get: async () => {
      const next = responses.shift();
      if (next instanceof Error) throw next;
      return next;
    }
  }, async () => {
    const status = await pollStatus('build-1', testConfig(), LOGIN);
    assert.equal(status.id, 'assess-1');
  });
});

test('status polling treats a transient 5xx as not-ready and then completes', async () => {
  const responses = [httpError(502), httpError(500), {status: 200, data: {id: 'assess-2', zdevMetadata: {analysis: 'Done'}}}];
  await withStubbedHttp({
    get: async () => {
      const next = responses.shift();
      if (next instanceof Error) throw next;
      return next;
    }
  }, async () => {
    const status = await pollStatus('build-2', testConfig(), LOGIN);
    assert.equal(status.id, 'assess-2');
  });
});

test('status polling fails with an actionable error on repeated malformed responses', async () => {
  await withStubbedHttp({
    get: async () => ({status: 200, data: {unexpected: true}})
  }, async () => {
    await assert.rejects(
      () => pollStatus('build-3', testConfig({retryAttempts: 2}), LOGIN),
      /malformed/i
    );
  });
});

test('status polling fails clearly when analysis reports Failed', async () => {
  await withStubbedHttp({
    get: async () => ({status: 200, data: {zdevMetadata: {analysis: 'Failed'}}})
  }, async () => {
    await assert.rejects(
      () => pollStatus('build-4', testConfig(), LOGIN),
      /reported Failed for buildId build-4/
    );
  });
});

test('status polling fails clearly when the timeout is reached', async () => {
  await withStubbedHttp({
    get: async () => ({status: 200, data: {zdevMetadata: {analysis: 'Processing'}}})
  }, async () => {
    await assert.rejects(
      () => pollStatus('build-5', testConfig({statusTimeout: 3, statusPollInterval: 1}), LOGIN),
      /Timed out after .* waiting for zScan analysis of buildId build-5/
    );
  });
});

test('status request does not retry authentication failures', async () => {
  await withStubbedHttp({
    get: async () => {
      throw httpError(403);
    }
  }, async () => {
    await assert.rejects(
      () => statusHttpRequest('build-6', testConfig(), LOGIN),
      err => err instanceof NonRetryableError
    );
  });
});

// ---------------------------------------------------------------------------
// Report download
// ---------------------------------------------------------------------------

test('downloadApp writes a SARIF report file with a derived filename', async () => {
  await withStubbedHttp({
    get: async (url, options) => {
      assert.match(url, /assessments\/123\/sarif/);
      assert.equal(options.headers.Authorization, 'Bearer test-token');
      return {status: 200, data: Buffer.from('{"runs":[]}')};
    }
  }, async ({dir}) => {
    const result = await downloadApp('123', 'Sample_App.apk', testConfig(), LOGIN);
    assert.equal(result.statusCode, 200);
    assert.equal(result.reportFileName, 'Sample_App_zscan.sarif');
    assert.equal(result.assessmentId, '123');
    assert.equal(fs.readFileSync(path.join(dir, 'Sample_App_zscan.sarif'), 'utf8'), '{"runs":[]}');
  });
});

test('downloadApp writes a JSON report file', async () => {
  await withStubbedHttp({
    get: async url => {
      assert.match(url, /assessments\/123\/json/);
      return {status: 200, data: Buffer.from('{"findings":[]}')};
    }
  }, async ({dir}) => {
    const result = await downloadApp('123', 'Sample_App.apk', testConfig(), LOGIN, 'json');
    assert.equal(result.reportFileName, 'Sample_App_zscan.json');
    assert.equal(fs.readFileSync(path.join(dir, 'Sample_App_zscan.json'), 'utf8'), '{"findings":[]}');
  });
});

test('downloadApp reads cdn_link from PDF metadata and downloads immediately', async () => {
  const seen = [];
  await withStubbedHttp({
    get: async (url, options) => {
      seen.push(url);
      if (url.startsWith('https://cdn.example.test')) {
        assert.equal(url, 'https://cdn.example.test/report/123?sig=x');
        assert.equal(options.responseType, 'arraybuffer');
        return {status: 200, data: Buffer.from('%PDF-test')};
      }
      assert.equal(options.headers.Authorization, 'Bearer test-token');
      return {status: 200, data: {cdn_link: 'https://cdn.example.test/report/123?sig=x'}};
    }
  }, async ({dir}) => {
    const result = await downloadApp('123', 'Sample_App.apk', testConfig({reportFormat: ['pdf']}), LOGIN, 'pdf');
    assert.equal(result.reportFileName, 'Sample_App_zscan.pdf');
    assert.equal(seen.length, 2, 'metadata then immediate CDN download');
    assert.match(seen[0], /assessments\/123\/report/);
    assert.equal(fs.readFileSync(path.join(dir, result.reportFileName), 'utf8'), '%PDF-test');
  });
});

test('downloadApp treats a missing cdn_link as non-retryable', async () => {
  let calls = 0;
  await withStubbedHttp({
    get: async () => {
      calls += 1;
      return {status: 200, data: {}};
    }
  }, async () => {
    await assert.rejects(
      () => downloadApp('123', 'Sample_App.apk', testConfig({reportFormat: ['pdf']}), LOGIN, 'pdf'),
      err => err instanceof NonRetryableError && /PDF report URL was not returned/.test(err.message)
    );
  });
  assert.equal(calls, 1, 'missing cdn_link must not be retried');
});

test('report polling retries transient PDF metadata failures then succeeds', async () => {
  const counters = {};
  const script = {
    metadata: [httpError(404), {status: 200, data: {cdn_link: 'https://cdn.example.test/r/1?sig=a'}}],
    cdn: [{status: 200, data: Buffer.from('%PDF-ok')}]
  };
  await withStubbedHttp({get: reportGetStub(script, counters)}, async ({dir}) => {
    const result = await pollDownload('123', 'Sample_App.apk', 'pdf', testConfig({reportFormat: ['pdf']}), LOGIN);
    assert.equal(result.reportFileName, 'Sample_App_zscan.pdf');
    assert.equal(counters.metadata, 2);
    assert.equal(fs.readFileSync(path.join(dir, result.reportFileName), 'utf8'), '%PDF-ok');
  });
});

test('report polling retries a transient network failure then succeeds', async () => {
  const responses = [networkError('ETIMEDOUT'), {status: 200, data: Buffer.from('{"runs":[]}')}];
  await withStubbedHttp({
    get: async () => {
      const next = responses.shift();
      if (next instanceof Error) throw next;
      return next;
    }
  }, async () => {
    const result = await pollDownload('123', 'Sample_App.apk', 'sarif', testConfig(), LOGIN);
    assert.equal(result.statusCode, 200);
  });
});

test('report polling does not retry a non-transient download failure', async () => {
  let calls = 0;
  await withStubbedHttp({
    get: async () => {
      calls += 1;
      throw httpError(400, 'bad request');
    }
  }, async () => {
    await assert.rejects(
      () => pollDownload('123', 'Sample_App.apk', 'sarif', testConfig(), LOGIN),
      /bad request/
    );
  });
  assert.equal(calls, 1, 'non-transient download errors must not be retried');
});

test('report polling fails clearly when the download times out', async () => {
  await withStubbedHttp({
    get: async () => {
      throw httpError(404);
    }
  }, async () => {
    await assert.rejects(
      () => pollDownload('123', 'Sample_App.apk', 'sarif', testConfig({reportTimeout: 3, reportPollInterval: 1}), LOGIN),
      /Timed out after .* waiting for the SARIF report for assessment 123/
    );
  });
});

test('verifyReportFile rejects missing and empty artifacts', async () => {
  const dir = createTempDir();
  const previousCwd = process.cwd();
  try {
    process.chdir(dir);
    fs.writeFileSync('empty.sarif', '');
    fs.writeFileSync('good.sarif', '{}');
    assert.throws(() => verifyReportFile('missing.sarif', 'sarif'), /was not successfully created/);
    assert.throws(() => verifyReportFile('empty.sarif', 'sarif'), /is empty/);
    assert.equal(verifyReportFile('good.sarif', 'sarif'), true);
  } finally {
    process.chdir(previousCwd);
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

// ---------------------------------------------------------------------------
// Multiformat from a single upload + single assessment
// ---------------------------------------------------------------------------

test('multiformat downloads all requested formats from one assessment', async () => {
  const counters = {};
  await withStubbedHttp({
    get: async (url, options) => {
      if (url.includes('/assessments/status')) {
        return {status: 200, data: {id: 'assess-9', zdevMetadata: {analysis: 'Done'}}};
      }
      return reportGetStub({}, counters)(url, options);
    }
  }, async ({dir, calls}) => {
    const config = testConfig({reportFormat: ['sarif', 'json', 'pdf']});
    const result = {buildId: 'b9', zdevAppId: 'a9', teamId: 't9', originalFileName: 'Sample_App.apk'};
    const downloads = await processUploadResult(result, config, LOGIN);

    assert.equal(downloads.length, 3);
    const names = downloads.map(d => d.reportFileName).sort();
    assert.deepEqual(names, ['Sample_App_zscan.json', 'Sample_App_zscan.pdf', 'Sample_App_zscan.sarif']);

    // Every format must come from the same assessment id.
    downloads.forEach(d => assert.equal(d.assessmentId, 'assess-9'));
    for (const name of names) {
      assert.ok(fs.statSync(path.join(dir, name)).size > 0);
    }
    // No upload or team-assignment calls were made during report retrieval.
    assert.equal(calls.post.length, 0);
    assert.equal(calls.put.length, 0);
  });
});

test('multiformat performs exactly one upload and one assessment', async () => {
  const dir = createTempDir();
  const appFile = path.join(dir, 'app.apk');
  fs.writeFileSync(appFile, 'binary');
  let uploadCount = 0;
  let statusCount = 0;
  try {
    await withStubbedHttp({
      post: async () => {
        uploadCount += 1;
        return {status: 200, data: {buildId: 'b10', zdevAppId: 'a10', teamId: 't10'}};
      },
      get: async (url, options) => {
        if (url.includes('/assessments/status')) {
          statusCount += 1;
          return {status: 200, data: {id: 'assess-10', zdevMetadata: {analysis: 'Done'}}};
        }
        return reportGetStub({})(url, options);
      }
    }, async () => {
      const config = testConfig({clientApp: appFile, reportFormat: ['sarif', 'pdf']});
      const uploads = await uploadApp(config, LOGIN);
      assert.equal(uploads.length, 1);
      const downloads = await processUploadResult(uploads[0], config, LOGIN);
      assert.equal(downloads.length, 2);
      downloads.forEach(d => assert.equal(d.assessmentId, 'assess-10'));
    });

    assert.equal(uploadCount, 1, 'exactly one app upload');
    assert.equal(statusCount, 1, 'exactly one assessment resolved');
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

// ---------------------------------------------------------------------------
// Scan evaluation
// ---------------------------------------------------------------------------

test('finding evaluation uses the same scan JSON without a second upload or scan', async () => {
  const counters = {};
  const findings = JSON.stringify({findings: [{severity: 'Critical', accepted_status: false}]});
  let failedMessage = null;
  const core = require('@actions/core');
  const originalSetFailed = core.setFailed;
  core.setFailed = msg => {
    failedMessage = msg;
  };

  try {
    await withStubbedHttp({
      get: async (url, options) => {
        if (url.includes('/assessments/status')) {
          return {status: 200, data: {id: 'assess-11', zdevMetadata: {analysis: 'Done'}}};
        }
        if (url.endsWith('/json')) {
          counters.json = (counters.json || 0) + 1;
          return {status: 200, data: Buffer.from(findings)};
        }
        return reportGetStub({}, counters)(url, options);
      }
    }, async () => {
      // sarif requested; json is pulled implicitly for gating from the same assessment.
      const config = testConfig({reportFormat: ['sarif'], failOnScanFindings: true, minimumSeverity: 'high'});
      const result = {buildId: 'b11', teamId: 't11', originalFileName: 'Sample_App.apk'};
      const downloads = await processUploadResult(result, config, LOGIN);

      assert.equal(downloads.length, 1, 'only requested formats are returned');
      assert.equal(downloads[0].format, 'sarif');
      assert.equal(counters.json, 1, 'json fetched once from the same assessment');
      assert.match(failedMessage, /Scan findings met the configured criteria/);
    });
  } finally {
    core.setFailed = originalSetFailed;
  }
});

test('Best Practices findings remain excluded from gating', () => {
  const report = {
    findings: [
      {severity: 'Best Practices', accepted_status: false},
      {severity: 'Low', accepted_status: false}
    ]
  };
  assert.equal(reportMatchesCriteria(report, 'any_finding', 'high'), false);
  assert.equal(reportMatchesCriteria(report, 'any_finding', 'critical'), false);
  const summary = summarizeScanReport(report);
  assert.deepEqual(summary['best practices'], {total: 1, unaccepted: 1});
});

// ---------------------------------------------------------------------------
// Report format normalization / backward compatibility
// ---------------------------------------------------------------------------

test('backward compatible single-format inputs are unchanged', () => {
  assert.equal(normalizeReportFormat('PDF'), 'pdf');
  assert.equal(normalizeReportFormat('sarif'), 'sarif');
  assert.equal(normalizeReportFormat('json'), 'json');
  assert.deepEqual(normalizeReportFormats('sarif'), ['sarif']);
  assert.deepEqual(normalizeReportFormats(undefined), ['sarif'], 'default stays sarif');
  assert.deepEqual(normalizeReportFormats(''), ['sarif']);
});

test('multiformat inputs parse comma and whitespace separated values', () => {
  assert.deepEqual(normalizeReportFormats('sarif, pdf'), ['sarif', 'pdf']);
  assert.deepEqual(normalizeReportFormats('sarif pdf json'), ['sarif', 'pdf', 'json']);
  assert.deepEqual(normalizeReportFormats('JSON,PDF'), ['json', 'pdf']);
  assert.deepEqual(normalizeReportFormats('sarif,sarif,pdf'), ['sarif', 'pdf'], 'duplicates collapse');
});

test('report_format: all expands to every supported format', () => {
  assert.deepEqual(normalizeReportFormats('all'), ['sarif', 'json', 'pdf']);
  assert.deepEqual(normalizeReportFormats('ALL'), ['sarif', 'json', 'pdf']);
});

test('invalid report-format input falls back to sarif and drops unknown values', () => {
  assert.deepEqual(normalizeReportFormats('invalid'), ['sarif']);
  assert.deepEqual(normalizeReportFormats('bogus, pdf'), ['pdf']);
  assert.deepEqual(normalizeReportFormats('xml html'), ['sarif']);
});

test('scan evaluation mode normalization is unchanged', () => {
  assert.equal(normalizeScanEvaluationMode('unaccepted_finding_only'), 'unaccepted_finding_only');
  assert.equal(normalizeScanEvaluationMode('invalid'), 'any_finding');
});

// ---------------------------------------------------------------------------
// Findings parsing (existing behavior preserved)
// ---------------------------------------------------------------------------

test('finding severity uses the JSON severity fields', () => {
  assert.equal(parseFindingSeverity({severity: 'Critical', severityOrdinal: 4}), 'critical');
  assert.equal(parseFindingSeverity({severityOrdinal: 3}), 'high');
  assert.equal(parseFindingSeverity({severity: 'not-a-severity'}), 'unknown');
});

test('scan summary counts total and unaccepted findings by severity', () => {
  const summary = summarizeScanReport({
    findings: [
      {severity: 'Critical', accepted_status: false},
      {severity: 'Critical', accepted_status: true},
      {severity: 'Low', accepted_status: false},
      {severity: 'Best Practices', accepted_status: false}
    ]
  });

  assert.deepEqual(summary.critical, {total: 2, unaccepted: 1});
  assert.deepEqual(summary.low, {total: 1, unaccepted: 1});
  assert.deepEqual(summary['best practices'], {total: 1, unaccepted: 1});
  assert.deepEqual(summary.high, {total: 0, unaccepted: 0});
});

test('report criteria match severity and accepted status like Jenkins', () => {
  const report = {
    findings: [
      {severity: 'Low', severityOrdinal: 1, accepted_status: true},
      {severity: 'Critical', severityOrdinal: 4, accepted_status: false},
      {severity: 'Best Practices', severityOrdinal: 5, accepted_status: false}
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
      {severity: 'Low', accepted_status: false},
      {severity: 'Best Practices', accepted_status: false}
    ]
  };

  assert.equal(reportMatchesCriteria(report, 'any_finding', 'high'), false);
  assert.equal(reportMatchesCriteria(report, 'any_finding', 'critical'), false);
});
