const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const https = require('node:https');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');
const safety = require('../../../tools/mcp-spikes/spikeSafety.cjs');
const journal = require('../../../tools/mcp-spikes/stdioProbeLauncher.cjs');

const root = safety.makeSafeTempRoot('tests');

test.after(() => fs.rmSync(root, { recursive: true, force: true }));

test('rejects unsafe roots before a write or spawn', () => {
  assert.throws(() => safety.assertSafeTempRoot('D:\\KaoyanMathMistakeBook'), /below|overlap|kaoyan/);
  assert.throws(() => safety.safeWrite('D:\\KaoyanMathMistakeBook', 'D:\\KaoyanMathMistakeBook\\x', 'no'), /below|overlap|kaoyan/);
  assert.throws(() => safety.safeSpawn('D:\\KaoyanMathMistakeBook', process.execPath, ['--version']), /below|overlap|kaoyan/);
  const target = path.join(root, 'safe.txt');
  safety.safeWrite(root, target, 'safe');
  assert.equal(fs.readFileSync(target, 'utf8'), 'safe');
});

test('rejects a temp-root link escape before a write or spawn', (context) => {
  const outside = safety.makeSafeTempRoot('outside');
  const link = path.join(root, 'junction-outside');
  context.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  try {
    fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP', 'UNKNOWN'].includes(error.code)) {
      context.skip(`link creation unavailable: ${error.code}`);
      return;
    }
    throw error;
  }
  assert.throws(() => safety.safeWrite(root, path.join(link, 'escape.txt'), 'no'), /symlink|resolves|escapes/);
  assert.throws(() => safety.safeSpawn(root, process.execPath, ['--version'], { cwd: link }), /symlink|resolves|escapes/);
  assert.equal(fs.existsSync(path.join(outside, 'escape.txt')), false);
});

function journalRecord(requestId, state = 'prepared', overrides = {}) {
  return {
    version: journal.JOURNAL_VERSION,
    clientId: 'client-1',
    requestId,
    operation: 'question.create',
    payloadHash: journal.payloadHash({ requestId, operation: 'question.create' }),
    state,
    ...overrides
  };
}

test('journal prototype recovery never infers a business outcome', () => {
  const payload = { requestId: 'request-1', operation: 'question.create' };
  const payloadHash = journal.payloadHash(payload);
  assert.deepEqual(journal.recover(journalRecord('request-1', 'prepared', { payloadHash }), undefined), { action: 'forward_once' });
  assert.deepEqual(journal.recover(journalRecord('request-1', 'forwarded', { payloadHash }), undefined), { action: 'needs_lookup' });
  assert.deepEqual(journal.recover(journalRecord('request-1', 'needs_lookup', { payloadHash }), { payloadHash, outcomeHash: 'a'.repeat(64) }), {
    action: 'replay_receipt', outcomeHash: 'a'.repeat(64)
  });
  assert.deepEqual(journal.recover(journalRecord('request-1', 'forwarded', { payloadHash }), { payloadHash: 'b'.repeat(64), outcomeHash: 'c'.repeat(64) }), {
    action: 'conflict'
  });
  assert.deepEqual(journal.recover(journalRecord('request-1', 'terminal', { payloadHash, outcomeHash: 'd'.repeat(64) }), undefined), {
    action: 'return_cached', outcomeHash: 'd'.repeat(64)
  });
  journal.writeRecord(root, journalRecord('request-1', 'prepared', { payloadHash }));
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'journal', 'request-1.json'), 'utf8')).state, 'prepared');
  assert.throws(() => journal.writeRecord(root, journalRecord('request-1', 'prepared', { operation: 'task.create' })), /binding mismatch/);
});

test('journal prototype bounds crash cleanup at each durable phase', () => {
  assert.throws(() => journal.writeRecord(root, journalRecord('before-temp'), { faultAt: 'before_temp_write' }), journal.InjectedCrash);
  assert.deepEqual(journal.recoverJournal(root), { removedTemps: 0, records: [journalRecord('request-1')] });

  assert.throws(() => journal.writeRecord(root, journalRecord('after-flush'), { faultAt: 'after_temp_flush' }), journal.InjectedCrash);
  const afterFlush = journal.recoverJournal(root);
  assert.equal(afterFlush.removedTemps, 1);
  assert.deepEqual(afterFlush.records, [journalRecord('request-1')]);

  assert.throws(() => journal.writeRecord(root, journalRecord('after-replace'), { faultAt: 'after_replace' }), journal.InjectedCrash);
  const afterReplace = journal.recoverJournal(root);
  assert.equal(afterReplace.removedTemps, 0);
  assert.deepEqual(afterReplace.records.map((record) => record.requestId).sort(), ['after-replace', 'request-1']);
});

test('stdio probe keeps stdout newline-delimited JSON-RPC only', () => {
  const child = spawnSync(process.execPath, [path.resolve(__dirname, '../../../tools/mcp-spikes/stdioProbeLauncher.cjs')], {
    cwd: root,
    env: { ...process.env, KAOYAN_C0_ROOT: root },
    input: '{"jsonrpc":"2.0","id":7,"method":"tools/list"}\n',
    encoding: 'utf8'
  });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout.endsWith('\n'), true);
  const lines = child.stdout.trim().split('\n');
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]), { jsonrpc: '2.0', id: 7, result: { ok: true } });
  assert.match(child.stderr, /diagnostic/);
});

function runCngProbe(keyName, forceFailure = false) {
  const forced = forceFailure ? "throw 'FORCED_CNG_FAILURE'" : "'CNG_OK'";
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$name = '${keyName}'`,
    "$p = [System.Security.Cryptography.CngKeyCreationParameters]::new()",
    "$p.Provider = [System.Security.Cryptography.CngProvider]::MicrosoftSoftwareKeyStorageProvider",
    "$key = $null",
    "try {",
    "$key = [System.Security.Cryptography.CngKey]::Create([System.Security.Cryptography.CngAlgorithm]::Rsa, $name, $p)",
    "$data = [System.Text.Encoding]::UTF8.GetBytes('kaoyan-c0')",
    "$rsa = [System.Security.Cryptography.RSACng]::new($key)",
    "$signature = $rsa.SignData($data, [System.Security.Cryptography.HashAlgorithmName]::SHA256, [System.Security.Cryptography.RSASignaturePadding]::Pkcs1)",
    "$public = $key.Export([System.Security.Cryptography.CngKeyBlobFormat]::GenericPublicBlob)",
    "$verify = [System.Security.Cryptography.RSACng]::new([System.Security.Cryptography.CngKey]::Import($public, [System.Security.Cryptography.CngKeyBlobFormat]::GenericPublicBlob)).VerifyData($data, $signature, [System.Security.Cryptography.HashAlgorithmName]::SHA256, [System.Security.Cryptography.RSASignaturePadding]::Pkcs1)",
    "if (!$verify -or $key.IsEphemeral) { throw 'CNG key proof failed' }",
    forced,
    "} finally { if ($null -ne $key) { $key.Delete() } }"
  ].join('; ');
  return safety.safeSpawn(root, 'powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
}

function cngKeyExists(keyName) {
  const script = `[System.Security.Cryptography.CngKey]::Exists('${keyName}', [System.Security.Cryptography.CngProvider]::MicrosoftSoftwareKeyStorageProvider)`;
  return safety.safeSpawn(root, 'powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
}

test('current-user persisted CNG key signs, verifies, and deletes', { skip: process.platform !== 'win32' }, () => {
  const keyName = `kaoyan-c0-${crypto.randomUUID()}`;
  const result = runCngProbe(keyName);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /CNG_OK/);
  const exists = cngKeyExists(keyName);
  assert.equal(exists.status, 0, exists.stderr);
  assert.match(exists.stdout, /False/);
});

test('CNG finally cleanup deletes a key after forced failure', { skip: process.platform !== 'win32' }, () => {
  const keyName = `kaoyan-c0-${crypto.randomUUID()}`;
  const result = runCngProbe(keyName, true);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /FORCED_CNG_FAILURE/);
  const exists = cngKeyExists(keyName);
  assert.equal(exists.status, 0, exists.stderr);
  assert.match(exists.stdout, /False/);
});

test('self-signed current-user certificate proves hostname trust only with explicit CA', { skip: process.platform !== 'win32' }, async () => {
  const pfxPath = path.join(root, 'tls', 'server.pfx');
  const cerPath = path.join(root, 'tls', 'server.cer');
  const pemPath = path.join(root, 'tls', 'server.pem');
  const thumbprintPath = path.join(root, 'tls', 'thumbprint.txt');
  const password = 'kaoyan-c0-password';
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$pfx = '${pfxPath.replace(/\\/g, '\\\\')}'`,
    `$cer = '${cerPath.replace(/\\/g, '\\\\')}'`,
    `$pem = '${pemPath.replace(/\\/g, '\\\\')}'`,
    `$out = '${thumbprintPath.replace(/\\/g, '\\\\')}'`,
    "New-Item -ItemType Directory -Force -Path (Split-Path $pfx) | Out-Null",
    "$key = [System.Security.Cryptography.RSA]::Create(2048)",
    "$request = [System.Security.Cryptography.X509Certificates.CertificateRequest]::new('CN=kaoyan-c0.local', $key, [System.Security.Cryptography.HashAlgorithmName]::SHA256, [System.Security.Cryptography.RSASignaturePadding]::Pkcs1)",
    "$san = [System.Security.Cryptography.X509Certificates.SubjectAlternativeNameBuilder]::new()",
    "$san.AddDnsName('kaoyan-c0.local')",
    "$request.CertificateExtensions.Add($san.Build())",
    "$cert = $request.CreateSelfSigned([DateTimeOffset]::UtcNow.AddMinutes(-1), [DateTimeOffset]::UtcNow.AddDays(1))",
    "[System.IO.File]::WriteAllBytes($pfx, $cert.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Pfx, 'kaoyan-c0-password'))",
    "[System.IO.File]::WriteAllBytes($cer, $cert.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Cert))",
    "certutil.exe -f -encode $cer $pem | Out-Null",
    "Set-Content -NoNewline -Path $out -Value $cert.Thumbprint"
  ].join('; ');
  const made = safety.safeSpawn(root, 'powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
  assert.equal(made.status, 0, made.stderr);
  const server = https.createServer({ pfx: fs.readFileSync(pfxPath), passphrase: password }, (_request, response) => response.end('ok'));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const request = (ca) => new Promise((resolve) => {
    const req = https.get({
      host: 'kaoyan-c0.local',
      port,
      servername: 'kaoyan-c0.local',
      ca,
      lookup: (_host, options, callback) => {
        const entry = { address: '127.0.0.1', family: 4 };
        callback(null, options.all ? [entry] : entry.address, options.all ? undefined : entry.family);
      }
    }, (response) => resolve({ status: response.statusCode }));
    req.on('error', (error) => resolve({ error: error.code }));
  });
  try {
    const untrusted = await request();
    const trusted = await request(fs.readFileSync(pemPath));
    assert.equal(untrusted.error, 'DEPTH_ZERO_SELF_SIGNED_CERT', JSON.stringify(untrusted));
    assert.equal(trusted.status, 200, JSON.stringify(trusted));
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
