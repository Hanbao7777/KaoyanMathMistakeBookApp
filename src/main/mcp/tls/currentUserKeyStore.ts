import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface CurrentUserCngKeyHandle {
  readonly keyName: string;
  readonly provider: 'Microsoft Software Key Storage Provider';
  readonly scope: 'CurrentUser';
  readonly algorithm: 'RSA';
  readonly exportable: false;
  readonly publicKey?: string;
}

export interface CurrentUserKeyStoreBackend {
  create(keyName: string): Promise<CurrentUserCngKeyHandle>;
  open(keyName: string): Promise<CurrentUserCngKeyHandle>;
  verify(keyName: string): Promise<CurrentUserCngKeyHandle>;
  remove(keyName: string): Promise<void>;
}

function safeKeyName(value: string): void {
  if (!/^kaoyan-http-root-[A-Za-z0-9._-]{1,120}$/.test(value)) throw new TypeError('Invalid CurrentUser CNG key name');
}

function parseHandle(value: string, keyName: string): CurrentUserCngKeyHandle {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new Error('CurrentUser CNG verification failed'); }
  if (!parsed || typeof parsed !== 'object' || (parsed as Record<string, unknown>).provider !== 'Microsoft Software Key Storage Provider' || (parsed as Record<string, unknown>).scope !== 'CurrentUser' || (parsed as Record<string, unknown>).algorithm !== 'RSA' || (parsed as Record<string, unknown>).exportable !== false) throw new Error('CurrentUser CNG key is not non-exportable');
  return Object.freeze({ keyName, provider: 'Microsoft Software Key Storage Provider', scope: 'CurrentUser', algorithm: 'RSA', exportable: false, ...((parsed as Record<string, unknown>).publicKey ? { publicKey: String((parsed as Record<string, unknown>).publicKey) } : {}) });
}

async function invoke(script: string, keyName: string): Promise<string> {
  const result = await execFileAsync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 15_000, maxBuffer: 64 * 1024, env: { ...process.env, KAOYAN_HTTP_CNG_KEY: keyName } });
  return String(result.stdout).trim();
}

class PowerShellCurrentUserCngBackend implements CurrentUserKeyStoreBackend {
  async create(keyName: string): Promise<CurrentUserCngKeyHandle> {
    const output = await invoke("$n=$env:KAOYAN_HTTP_CNG_KEY; $p=[Security.Cryptography.CngProvider]::MicrosoftSoftwareKeyStorageProvider; if([Security.Cryptography.CngKey]::Exists($n,$p)){throw 'key exists'}; $k=$null; try{$k=[Security.Cryptography.CngKey]::Create([Security.Cryptography.CngAlgorithm]::Rsa,$n,[Security.Cryptography.CngKeyCreationParameters]@{Provider=$p;KeyCreationOptions=[Security.Cryptography.CngKeyCreationOptions]::None}); $rsa=[Security.Cryptography.RSACng]::new($k); @{provider=$p.Provider;scope='CurrentUser';algorithm='RSA';exportable=($k.ExportPolicy -ne [Security.Cryptography.CngExportPolicies]::None);publicKey=([Convert]::ToBase64String($rsa.ExportSubjectPublicKeyInfo()).TrimEnd('=').Replace('+','-').Replace('/','_'))}|ConvertTo-Json -Compress} finally {if($rsa){$rsa.Dispose()};if($k){$k.Dispose()}}", keyName);
    return parseHandle(output, keyName);
  }
  async open(keyName: string): Promise<CurrentUserCngKeyHandle> { return this.verify(keyName); }
  async verify(keyName: string): Promise<CurrentUserCngKeyHandle> {
    const output = await invoke("$n=$env:KAOYAN_HTTP_CNG_KEY; $p=[Security.Cryptography.CngProvider]::MicrosoftSoftwareKeyStorageProvider; if(-not [Security.Cryptography.CngKey]::Exists($n,$p)){throw 'missing'}; $k=[Security.Cryptography.CngKey]::Open($n,$p); try{$rsa=[Security.Cryptography.RSACng]::new($k); @{provider=$p.Provider;scope='CurrentUser';algorithm='RSA';exportable=($k.ExportPolicy -ne [Security.Cryptography.CngExportPolicies]::None);publicKey=([Convert]::ToBase64String($rsa.ExportSubjectPublicKeyInfo()).TrimEnd('=').Replace('+','-').Replace('/','_'))}|ConvertTo-Json -Compress} finally {if($rsa){$rsa.Dispose()};$k.Dispose()}", keyName);
    return parseHandle(output, keyName);
  }
  async remove(keyName: string): Promise<void> { await invoke("$n=$env:KAOYAN_HTTP_CNG_KEY; $p=[Security.Cryptography.CngProvider]::MicrosoftSoftwareKeyStorageProvider; if([Security.Cryptography.CngKey]::Exists($n,$p)){$k=[Security.Cryptography.CngKey]::Open($n,$p);try{$k.Delete()}finally{$k.Dispose()}}", keyName); }
}

export class CurrentUserKeyStore {
  private readonly backend: CurrentUserKeyStoreBackend;
  constructor(backend: CurrentUserKeyStoreBackend = new PowerShellCurrentUserCngBackend()) { this.backend = backend; }
  async create(keyName: string): Promise<CurrentUserCngKeyHandle> { safeKeyName(keyName); return this.requireVerified(await this.backend.create(keyName), keyName); }
  async open(keyName: string): Promise<CurrentUserCngKeyHandle> { safeKeyName(keyName); return this.requireVerified(await this.backend.open(keyName), keyName); }
  async verify(keyName: string): Promise<CurrentUserCngKeyHandle> { safeKeyName(keyName); return this.requireVerified(await this.backend.verify(keyName), keyName); }
  async remove(keyName: string): Promise<void> { safeKeyName(keyName); await this.backend.remove(keyName); }
  async rotate(previousKeyName: string, nextKeyName: string): Promise<CurrentUserCngKeyHandle> { safeKeyName(previousKeyName); safeKeyName(nextKeyName); const next = await this.create(nextKeyName); try { await this.remove(previousKeyName); return next; } catch (error) { await this.remove(nextKeyName).catch(() => undefined); throw error; } }
  private requireVerified(value: CurrentUserCngKeyHandle, keyName: string): CurrentUserCngKeyHandle { if (!value || value.keyName !== keyName || value.provider !== 'Microsoft Software Key Storage Provider' || value.scope !== 'CurrentUser' || value.algorithm !== 'RSA' || value.exportable !== false) throw new Error('CurrentUser CNG key failed closed verification'); return Object.freeze({ ...value, exportable: false as const }); }
}

export const currentUserCngKeyName = (suffix: string): string => { const value = `kaoyan-http-root-${suffix}`; safeKeyName(value); return value; };
