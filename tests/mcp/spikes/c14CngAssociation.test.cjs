const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const crypto = require('node:crypto');
const path = require('node:path');
const test = require('node:test');

const execFileAsync = promisify(execFile);
const root = path.resolve(__dirname, '../../..');
const keyModule = require(path.join(root, 'dist/main/main/mcp/tls/currentUserKeyStore.js'));
const issuerModule = require(path.join(root, 'dist/main/main/mcp/tls/currentUserRootIssuer.js'));
const caModule = require(path.join(root, 'dist/main/main/mcp/tls/currentUserRootCa.js'));
const leafModule = require(path.join(root, 'dist/main/main/mcp/tls/localHttpsCertificate.js'));
const contracts = require(path.join(root, 'dist/main/shared/mcp/v1/oauthContracts.js'));

test('C14 Windows CNG root association signs a leaf and cleans exact disposable artifacts', { skip: process.platform !== 'win32' || process.env.KAOYAN_C14_RUN_WINDOWS_CNG_SPIKE !== '1' }, async () => {
  const suffix = crypto.randomUUID().replace(/-/g, '');
  const keyName = `kaoyan-http-root-${suffix}`;
  const authority = contracts.directHttpsAuthority(39458);
  const keyStore = new keyModule.CurrentUserKeyStore();
  const issuer = new issuerModule.CurrentUserRootIssuer();
  const roots = new caModule.CurrentUserRootCaLifecycle();
  let rootMaterial;
  let rootInstalled = false;
  try {
    const key = await keyStore.create(keyName);
    rootMaterial = await issuer.issue(key, `CN=Kaoyan Local HTTPS Root ${suffix.slice(0, 8)}`);
    await roots.install(rootMaterial, true);
    rootInstalled = true;
    await issuer.verify(key, rootMaterial.thumbprint);
    const leaf = await leafModule.issueLocalHttpsCertificate({ authority, rootThumbprint: rootMaterial.thumbprint, rootKeyName: keyName });
    assert.ok(leaf.pfx.length > 32);
    assert.ok(leaf.passphrase.length >= 32);
  } finally {
    if (rootMaterial && rootInstalled) await roots.remove(rootMaterial.thumbprint).catch(() => undefined);
    if (rootMaterial) await execFileAsync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', "$t=$env:T; @(Get-ChildItem Cert:\\CurrentUser\\My | Where-Object {$_.Thumbprint -eq $t}) | ForEach-Object { Remove-Item -LiteralPath $_.PSPath -Force }"], { windowsHide: true, env: { ...process.env, T: rootMaterial.thumbprint } }).catch(() => undefined);
    await keyStore.remove(keyName).catch(() => undefined);
    if (rootMaterial) {
      const { stdout } = await execFileAsync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', "$t=$env:T; $my=@(Get-ChildItem Cert:\\CurrentUser\\My | Where-Object {$_.Thumbprint -eq $t}).Count; $root=@(Get-ChildItem Cert:\\CurrentUser\\Root | Where-Object {$_.Thumbprint -eq $t}).Count; \"$my,$root\""], { windowsHide: true, env: { ...process.env, T: rootMaterial.thumbprint } });
      assert.equal(String(stdout).trim(), '0,0');
    }
  }
});
