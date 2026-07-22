import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import AdmZip from 'adm-zip';
import type { AgentDiagnosticExportResult, AgentDiagnosticPreview } from '../../../shared/api';

const PROTECTED_DATA_ROOT = 'D:\\KaoyanMathMistakeBook';
const MAX_BUNDLE_BYTES = 256 * 1024;

export interface AgentDiagnosticSnapshot {
  readonly appVersion: string;
  readonly electronVersion: string;
  readonly nodeVersion: string;
  readonly mcpSdkVersion: string;
  readonly mcpProtocolVersion: '2025-11-25';
  readonly launcher?: { readonly version: string; readonly sha256: string };
  readonly runtime: { readonly externalControlEnabled: boolean; readonly runtimeState: string; readonly directHttpsState: string; readonly directHttpsReason?: string };
  readonly audit: { readonly valid: boolean; readonly segments: number; readonly events: number };
}

interface DiagnosticEntry { readonly name: string; readonly bytes: Buffer; readonly sha256: string; }

function hash(bytes: Buffer): string { return createHash('sha256').update(bytes).digest('hex'); }
function safeVersion(value: string): string { return /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/.test(value) ? value : 'unavailable'; }
function safeState(value: string | undefined): string { return value && /^[a-z][a-z0-9_-]{0,63}$/.test(value) ? value : 'unavailable'; }
function normalized(value: string): string { const result = path.resolve(value); return process.platform === 'win32' ? result.toLowerCase() : result; }
function related(left: string, right: string): boolean { const relative = path.relative(normalized(left), normalized(right)); return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)) || (() => { const reverse = path.relative(normalized(right), normalized(left)); return reverse === '' || (!reverse.startsWith(`..${path.sep}`) && reverse !== '..' && !path.isAbsolute(reverse)); })(); }
function plain(value: unknown): Buffer { return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8'); }

function outputDirectory(root: string): string {
  const resolved = path.resolve(root);
  if (related(resolved, PROTECTED_DATA_ROOT)) throw new Error('Diagnostic output overlaps the protected data root');
  mkdirSync(resolved, { recursive: true, mode: 0o700 });
  let current = path.parse(resolved).root;
  for (const segment of path.relative(current, resolved).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment); const info = lstatSync(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Diagnostic output path is unsafe');
  }
  if (normalized(realpathSync.native(resolved)) !== normalized(resolved)) throw new Error('Diagnostic output path is not canonical');
  return resolved;
}

function entries(snapshot: AgentDiagnosticSnapshot): readonly DiagnosticEntry[] {
  const summary = plain(Object.freeze({
    schemaVersion: 1,
    versions: Object.freeze({ app: safeVersion(snapshot.appVersion), electron: safeVersion(snapshot.electronVersion), node: safeVersion(snapshot.nodeVersion), mcpSdk: safeVersion(snapshot.mcpSdkVersion), mcpProtocol: snapshot.mcpProtocolVersion, launcher: safeVersion(snapshot.launcher?.version ?? 'unavailable') }),
    launcher: snapshot.launcher && /^[0-9a-f]{64}$/.test(snapshot.launcher.sha256) ? Object.freeze({ sha256: snapshot.launcher.sha256 }) : null,
    runtime: Object.freeze({ externalControlEnabled: snapshot.runtime.externalControlEnabled === true, runtimeState: safeState(snapshot.runtime.runtimeState), directHttpsState: safeState(snapshot.runtime.directHttpsState), ...(snapshot.runtime.directHttpsReason ? { directHttpsReason: safeState(snapshot.runtime.directHttpsReason) } : {}) }),
    audit: Object.freeze({ valid: snapshot.audit.valid === true, segments: Number.isSafeInteger(snapshot.audit.segments) && snapshot.audit.segments >= 0 ? snapshot.audit.segments : 0, events: Number.isSafeInteger(snapshot.audit.events) && snapshot.audit.events >= 0 ? snapshot.audit.events : 0 })
  }));
  const summaryEntry = Object.freeze({ name: 'summary.json', bytes: summary, sha256: hash(summary) });
  const manifest = plain(Object.freeze({ schemaVersion: 1, files: Object.freeze([{ name: summaryEntry.name, bytes: summaryEntry.bytes.length, sha256: summaryEntry.sha256 }]) }));
  return Object.freeze([summaryEntry, Object.freeze({ name: 'manifest.json', bytes: manifest, sha256: hash(manifest) })]);
}

export class AgentDiagnosticBundle {
  constructor(private readonly root: string, private readonly now: () => Date = () => new Date()) {}

  async preview(snapshot: AgentDiagnosticSnapshot): Promise<AgentDiagnosticPreview> {
    const files = entries(snapshot).map((entry) => Object.freeze({ name: entry.name, bytes: entry.bytes.length, sha256: entry.sha256 }));
    return Object.freeze({ schemaVersion: 1, generatedAt: this.now().toISOString(), files: Object.freeze(files), totalBytes: files.reduce((total, file) => total + file.bytes, 0) });
  }

  async export(snapshot: AgentDiagnosticSnapshot): Promise<AgentDiagnosticExportResult> {
    const generatedAt = this.now(); const files = entries(snapshot); const zip = new AdmZip();
    for (const entry of files) zip.addFile(entry.name, entry.bytes);
    const bytes = zip.toBuffer(); if (bytes.length < 1 || bytes.length > MAX_BUNDLE_BYTES) throw new Error('Diagnostic bundle exceeds its bound');
    const name = `kaoyan-agent-diagnostics-${generatedAt.toISOString().replace(/[:.]/g, '-')}.zip`;
    const directory = outputDirectory(this.root); const target = path.join(directory, name);
    if (existsSync(target)) throw new Error('Diagnostic bundle already exists');
    await writeFile(target, bytes, { flag: 'wx', mode: 0o600 });
    return Object.freeze({ schemaVersion: 1, generatedAt: generatedAt.toISOString(), fileName: name, bytes: bytes.length, sha256: hash(bytes) });
  }
}
