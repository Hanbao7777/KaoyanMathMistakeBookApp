import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { DirectHttpsAuthority } from '../../../shared/mcp/v1/oauthContracts';

const execFileAsync = promisify(execFile);

export interface LocalHttpsCertificate { readonly pfx: Uint8Array; readonly passphrase: string; readonly thumbprint: string; readonly notAfter: string; readonly dnsNames: readonly ['localhost']; readonly ipAddresses: readonly ['127.0.0.1']; }
export interface LocalHttpsCertificateIssuer { issue(input: { readonly authority: DirectHttpsAuthority; readonly rootThumbprint: string; readonly rootKeyName: string }): Promise<LocalHttpsCertificate>; }

function safeThumbprint(value: string): string { if (!/^[0-9a-f]{40,128}$/i.test(value)) throw new TypeError('Invalid root certificate thumbprint'); return value.toUpperCase(); }
function temp(prefix: string, extension: string): string { return path.join(os.tmpdir(), `${prefix}-${randomUUID()}${extension}`); }

class PowerShellLocalHttpsCertificateIssuer implements LocalHttpsCertificateIssuer {
  async issue(input: { readonly authority: DirectHttpsAuthority; readonly rootThumbprint: string; readonly rootKeyName: string }): Promise<LocalHttpsCertificate> {
    const rootThumbprint = safeThumbprint(input.rootThumbprint); const output = temp('kaoyan-http-leaf', '.pfx'); const passphrase = randomBytes(32).toString('base64url');
    const script = "$ErrorActionPreference='Stop'; $t=$env:KAOYAN_HTTP_ROOT_THUMBPRINT; $n=$env:KAOYAN_HTTP_CNG_KEY; $o=$env:KAOYAN_HTTP_PFX; $p=[Security.Cryptography.CngProvider]::MicrosoftSoftwareKeyStorageProvider; $root=@(Get-ChildItem -Path Cert:\\CurrentUser\\My | Where-Object {$_.Thumbprint -eq $t}); if($root.Count -ne 1 -or -not $root[0].HasPrivateKey){throw 'exact root missing'}; $key=[Security.Cryptography.CngKey]::Open($n,$p); try {$rsa=[Security.Cryptography.X509Certificates.RSACertificateExtensions]::GetRSAPrivateKey($root[0]); if($rsa -isnot [Security.Cryptography.RSACng] -or $rsa.Key.Provider.Provider -ne $p.Provider -or $rsa.Key.UniqueName -ne $key.UniqueName){throw 'root key association mismatch'}; $leaf=New-SelfSignedCertificate -DnsName @('localhost') -TextExtension @('2.5.29.17={text}IPAddress=127.0.0.1') -Signer $root[0] -CertStoreLocation 'Cert:\\CurrentUser\\My' -NotAfter (Get-Date).AddDays(7); try { $password=ConvertTo-SecureString -String $env:KAOYAN_HTTP_PFX_PASSPHRASE -AsPlainText -Force; Export-PfxCertificate -Cert $leaf -FilePath $o -Password $password | Out-Null; @{thumbprint=$leaf.Thumbprint;notAfter=$leaf.NotAfter.ToUniversalTime().ToString('o');pfx=[Convert]::ToBase64String([IO.File]::ReadAllBytes($o))}|ConvertTo-Json -Compress } finally {Remove-Item -Path $leaf.PSPath -Force -ErrorAction SilentlyContinue; $rsa.Dispose()} } finally {$key.Dispose()}";
    const result = await execFileAsync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 30_000, maxBuffer: 128 * 1024, env: { ...process.env, KAOYAN_HTTP_ROOT_THUMBPRINT: rootThumbprint, KAOYAN_HTTP_CNG_KEY: input.rootKeyName, KAOYAN_HTTP_PFX: output, KAOYAN_HTTP_PFX_PASSPHRASE: passphrase } });
    try { let parsed: unknown; try { parsed = JSON.parse(String(result.stdout).trim()); } catch { throw new Error('Local HTTPS certificate issuance failed'); } const value = parsed as Record<string, unknown>; if (typeof value.pfx !== 'string' || typeof value.thumbprint !== 'string' || typeof value.notAfter !== 'string') throw new Error('Local HTTPS certificate metadata is invalid'); const pfx = Buffer.from(value.pfx, 'base64'); if (pfx.length < 32) throw new Error('Local HTTPS certificate is empty'); return Object.freeze({ pfx, passphrase, thumbprint: safeThumbprint(value.thumbprint), notAfter: new Date(value.notAfter).toISOString(), dnsNames: ['localhost'] as const, ipAddresses: ['127.0.0.1'] as const }); }
    finally { fs.rmSync(output, { force: true }); }
  }
}

export async function issueLocalHttpsCertificate(input: { readonly authority: DirectHttpsAuthority; readonly rootThumbprint: string; readonly rootKeyName: string }, issuer: LocalHttpsCertificateIssuer = new PowerShellLocalHttpsCertificateIssuer()): Promise<LocalHttpsCertificate> {
  if (input.authority.resource !== `${input.authority.authority}/mcp` || input.authority.issuer !== input.authority.authority) throw new Error('Local HTTPS authority is invalid');
  return issuer.issue(input);
}
