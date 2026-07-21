import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

function runCertutil(args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('certutil.exe', [...args], { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('CurrentUser Root certificate command timed out')); }, 120_000);
    child.stderr.on('data', (chunk: Buffer | string) => { stderr += String(chunk).slice(0, 4_096); });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (code) => { clearTimeout(timer); if (code === 0) resolve(); else reject(new Error(`CurrentUser Root certificate command failed${stderr ? `: ${stderr}` : ''}`)); });
    child.stdin.end('Y\r\n');
  });
}

export interface RootCertificateMaterial { readonly der: Uint8Array; readonly thumbprint: string; readonly notAfter: string; readonly subject: string; }
export interface CurrentUserRootBackend { install(der: Uint8Array): Promise<void>; remove(thumbprint: string): Promise<void>; count(thumbprint: string): Promise<number>; }

function thumbprint(value: string): string { if (!/^[0-9a-f]{40,128}$/i.test(value)) throw new TypeError('Invalid certificate thumbprint'); return value.replace(/\s+/g, '').toUpperCase(); }
function tempFile(): string { return path.join(os.tmpdir(), `kaoyan-http-root-${randomUUID()}.cer`); }

class PowerShellCurrentUserRootBackend implements CurrentUserRootBackend {
  async install(der: Uint8Array): Promise<void> {
    const file = tempFile(); fs.writeFileSync(file, Buffer.from(der), { mode: 0o600 });
    try { await runCertutil(['-f', '-user', '-addstore', 'Root', file]); }
    finally { fs.rmSync(file, { force: true }); }
  }
  async remove(value: string): Promise<void> { await execFileAsync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference='Stop';$t=$env:KAOYAN_HTTP_ROOT_THUMBPRINT.ToUpperInvariant();@(Get-ChildItem -Path 'Cert:\\CurrentUser\\Root' | Where-Object {$_.Thumbprint -eq $t}) | ForEach-Object { Remove-Item -LiteralPath $_.PSPath -Force }"], { windowsHide: true, timeout: 15_000, maxBuffer: 32 * 1024, env: { ...process.env, KAOYAN_HTTP_ROOT_THUMBPRINT: thumbprint(value) } }).catch(() => undefined); }
  async count(value: string): Promise<number> {
    const result = await execFileAsync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', "$t=$env:KAOYAN_HTTP_ROOT_THUMBPRINT.ToUpperInvariant(); @(Get-ChildItem -Path Cert:\\CurrentUser\\Root | Where-Object { $_.Thumbprint -eq $t }).Count"], { windowsHide: true, timeout: 15_000, maxBuffer: 32 * 1024, env: { ...process.env, KAOYAN_HTTP_ROOT_THUMBPRINT: thumbprint(value) } });
    const count = Number(String(result.stdout).trim()); if (!Number.isSafeInteger(count) || count < 0) throw new Error('CurrentUser Root verification failed'); return count;
  }
}

export class CurrentUserRootCaLifecycle {
  constructor(private readonly backend: CurrentUserRootBackend = new PowerShellCurrentUserRootBackend()) {}
  async install(material: RootCertificateMaterial, approved: boolean): Promise<void> {
    if (approved !== true) throw new Error('CurrentUser Root CA consent is required');
    const value = thumbprint(material.thumbprint); if (Date.parse(material.notAfter) <= Date.now()) throw new Error('Root CA certificate is expired');
    await this.backend.install(material.der); if (await this.backend.count(value) !== 1) { await this.backend.remove(value); if (await this.backend.count(value) !== 0) throw new Error('CurrentUser Root CA cleanup verification failed'); throw new Error('CurrentUser Root CA install verification failed'); }
  }
  async remove(thumbprintValue: string): Promise<void> {
    const value = thumbprint(thumbprintValue); await this.backend.remove(value); if (await this.backend.count(value) !== 0) throw new Error('CurrentUser Root CA removal left a stale certificate');
  }
  async count(thumbprintValue: string): Promise<number> { return this.backend.count(thumbprint(thumbprintValue)); }
  async rotate(previous: RootCertificateMaterial | undefined, next: RootCertificateMaterial, approved: boolean): Promise<void> {
    await this.install(next, approved);
    try { if (previous) await this.remove(previous.thumbprint); }
    catch (error) { await this.remove(next.thumbprint).catch(() => undefined); throw error; }
  }
  async assertNoStale(thumbprints: readonly string[]): Promise<void> { for (const value of thumbprints) if (await this.backend.count(thumbprint(value)) !== 0) throw new Error('Stale CurrentUser Root CA remains'); }
}

export function assertCurrentUserRootPath(pathValue: string): void { if (pathValue !== 'Cert:\\CurrentUser\\Root') throw new Error('Only the CurrentUser Root store is permitted'); }
