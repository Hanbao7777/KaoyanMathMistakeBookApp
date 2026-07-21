import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import type { CurrentUserCngKeyHandle } from './currentUserKeyStore';
import type { RootCertificateMaterial } from './currentUserRootCa';

const execFileAsync = promisify(execFile);

export interface CurrentUserRootIssuerPort {
  issue(key: CurrentUserCngKeyHandle, subject: string): Promise<RootCertificateMaterial>;
  verify(key: CurrentUserCngKeyHandle, thumbprint: string): Promise<void>;
  remove?(thumbprint: string): Promise<void>;
}

function assertKey(key: CurrentUserCngKeyHandle): void {
  if (key.provider !== 'Microsoft Software Key Storage Provider' || key.scope !== 'CurrentUser' || key.algorithm !== 'RSA' || key.exportable !== false) throw new Error('CurrentUser CNG key failed closed verification');
}
function assertSubject(subject: string): void { if (!/^CN=Kaoyan Local HTTPS Root [A-Za-z0-9._ -]{1,80}$/.test(subject)) throw new TypeError('Invalid root certificate subject'); }
function parseMaterial(output: string): RootCertificateMaterial {
  let value: Record<string, unknown>;
  try { value = JSON.parse(output) as Record<string, unknown>; } catch { throw new Error('CurrentUser root issuance failed'); }
  if (typeof value.der !== 'string' || typeof value.thumbprint !== 'string' || typeof value.notAfter !== 'string' || typeof value.subject !== 'string' || !/^[0-9A-F]{40,128}$/.test(value.thumbprint)) throw new Error('CurrentUser root issuer returned invalid material');
  const der = Buffer.from(value.der, 'base64'); if (der.length < 128 || new Date(value.notAfter).getTime() <= Date.now()) throw new Error('CurrentUser root issuer returned invalid certificate');
  return Object.freeze({ der, thumbprint: value.thumbprint, notAfter: new Date(value.notAfter).toISOString(), subject: value.subject });
}

class PowerShellCurrentUserRootIssuer implements CurrentUserRootIssuerPort {
  async issue(key: CurrentUserCngKeyHandle, subject: string): Promise<RootCertificateMaterial> {
    assertKey(key); assertSubject(subject);
    const nonce = randomBytes(32).toString('base64');
    const script = "$ErrorActionPreference='Stop';$n=$env:KAOYAN_HTTP_CNG_KEY;$s=$env:KAOYAN_HTTP_ROOT_SUBJECT;$p=[Security.Cryptography.CngProvider]::MicrosoftSoftwareKeyStorageProvider;$k=[Security.Cryptography.CngKey]::Open($n,$p);try{$rsa=[Security.Cryptography.RSACng]::new($k);$req=[Security.Cryptography.X509Certificates.CertificateRequest]::new($s,$rsa,[Security.Cryptography.HashAlgorithmName]::SHA256,[Security.Cryptography.RSASignaturePadding]::Pkcs1);$req.CertificateExtensions.Add([Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new($true,$false,0,$true));$req.CertificateExtensions.Add([Security.Cryptography.X509Certificates.X509KeyUsageExtension]::new([Security.Cryptography.X509Certificates.X509KeyUsageFlags]::KeyCertSign -bor [Security.Cryptography.X509Certificates.X509KeyUsageFlags]::CrlSign,$true));$cert=$req.CreateSelfSigned((Get-Date).ToUniversalTime().AddMinutes(-1),(Get-Date).ToUniversalTime().AddDays(30));try{$store=[Security.Cryptography.X509Certificates.X509Store]::new('My','CurrentUser');$store.Open([Security.Cryptography.X509Certificates.OpenFlags]::ReadWrite);try{$store.Add($cert)}finally{$store.Dispose()};@{der=[Convert]::ToBase64String($cert.Export([Security.Cryptography.X509Certificates.X509ContentType]::Cert));thumbprint=$cert.Thumbprint;notAfter=$cert.NotAfter.ToUniversalTime().ToString('o');subject=$cert.Subject}|ConvertTo-Json -Compress}finally{$cert.Dispose()}}finally{if($rsa){$rsa.Dispose()};$k.Dispose()}";
    const result = await execFileAsync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 30_000, maxBuffer: 128 * 1024, env: { ...process.env, KAOYAN_HTTP_CNG_KEY: key.keyName, KAOYAN_HTTP_ROOT_SUBJECT: subject, KAOYAN_HTTP_ROOT_SERIAL: nonce } });
    return parseMaterial(String(result.stdout).trim());
  }
  async verify(key: CurrentUserCngKeyHandle, thumbprint: string): Promise<void> {
    assertKey(key); if (!/^[0-9A-Fa-f]{40,128}$/.test(thumbprint)) throw new TypeError('Invalid root certificate thumbprint');
    const script = "$ErrorActionPreference='Stop';$n=$env:KAOYAN_HTTP_CNG_KEY;$t=$env:KAOYAN_HTTP_ROOT_THUMBPRINT.ToUpperInvariant();$p=[Security.Cryptography.CngProvider]::MicrosoftSoftwareKeyStorageProvider;$cert=@(Get-ChildItem Cert:\\CurrentUser\\My | Where-Object {$_.Thumbprint -eq $t});if($cert.Count -ne 1 -or -not $cert[0].HasPrivateKey){throw 'missing exact My certificate'};$key=[Security.Cryptography.CngKey]::Open($n,$p);try{$rsa=[Security.Cryptography.X509Certificates.RSACertificateExtensions]::GetRSAPrivateKey($cert[0]);$pub=[Security.Cryptography.X509Certificates.RSACertificateExtensions]::GetRSAPublicKey($cert[0]);try{if($rsa -isnot [Security.Cryptography.RSACng] -or $rsa.Key.Provider.Provider -ne $p.Provider -or $rsa.Key.UniqueName -ne $key.UniqueName){throw 'key association mismatch'};if([Convert]::ToBase64String($rsa.ExportSubjectPublicKeyInfo()) -ne [Convert]::ToBase64String($pub.ExportSubjectPublicKeyInfo())){throw 'public key binding mismatch'};$challenge=[Convert]::FromBase64String($env:KAOYAN_HTTP_ROOT_CHALLENGE);$signature=$rsa.SignData($challenge,[Security.Cryptography.HashAlgorithmName]::SHA256,[Security.Cryptography.RSASignaturePadding]::Pkcs1);if(-not $pub.VerifyData($challenge,$signature,[Security.Cryptography.HashAlgorithmName]::SHA256,[Security.Cryptography.RSASignaturePadding]::Pkcs1)){throw 'signature proof failed'};$basic=$cert[0].Extensions | Where-Object {$_.Oid.Value -eq '2.5.29.19'};$usage=$cert[0].Extensions | Where-Object {$_.Oid.Value -eq '2.5.29.15'};if(-not $basic.CertificateAuthority -or -not $usage.KeyUsages.ToString().Contains('KeyCertSign') -or $cert[0].NotAfter.ToUniversalTime() -le (Get-Date).ToUniversalTime()){throw 'CA constraints invalid'}}finally{$pub.Dispose();$rsa.Dispose()}}finally{$key.Dispose()}";
    await execFileAsync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 30_000, maxBuffer: 64 * 1024, env: { ...process.env, KAOYAN_HTTP_CNG_KEY: key.keyName, KAOYAN_HTTP_ROOT_THUMBPRINT: thumbprint.toUpperCase(), KAOYAN_HTTP_ROOT_CHALLENGE: randomBytes(32).toString('base64') } });
  }
  async remove(thumbprint: string): Promise<void> {
    if (!/^[0-9A-Fa-f]{40,128}$/.test(thumbprint)) throw new TypeError('Invalid root certificate thumbprint');
    await execFileAsync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference='Stop';$t=$env:KAOYAN_HTTP_ROOT_THUMBPRINT.ToUpperInvariant();@(Get-ChildItem -Path 'Cert:\\CurrentUser\\My' | Where-Object {$_.Thumbprint -eq $t}) | ForEach-Object { Remove-Item -LiteralPath $_.PSPath -Force }"], { windowsHide: true, timeout: 15_000, maxBuffer: 32 * 1024, env: { ...process.env, KAOYAN_HTTP_ROOT_THUMBPRINT: thumbprint.toUpperCase() } });
  }
}

export class CurrentUserRootIssuer {
  constructor(private readonly port: CurrentUserRootIssuerPort = new PowerShellCurrentUserRootIssuer()) {}
  async issue(key: CurrentUserCngKeyHandle, subject: string): Promise<RootCertificateMaterial> { const material = await this.port.issue(key, subject); try { await this.port.verify(key, material.thumbprint); } catch (error) { await this.port.remove?.(material.thumbprint).catch(() => undefined); throw error; } return material; }
  async verify(key: CurrentUserCngKeyHandle, thumbprint: string): Promise<void> { await this.port.verify(key, thumbprint); }
  async remove(thumbprint: string): Promise<void> { if (!this.port.remove) throw new Error('CurrentUser My certificate removal is unavailable'); await this.port.remove(thumbprint); }
}
