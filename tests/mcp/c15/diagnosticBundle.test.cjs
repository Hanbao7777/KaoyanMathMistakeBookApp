'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const AdmZip = require('adm-zip');

const root = path.resolve(__dirname, '../../..');
const diagnostics = require(path.join(root, 'dist/main/main/mcp/diagnostics/diagnosticBundle.js'));

function snapshot(extra = {}) {
  return {
    appVersion: '0.1.0', electronVersion: '38.4.0', nodeVersion: '24.15.0', mcpSdkVersion: '1.29.0', mcpProtocolVersion: '2025-11-25',
    launcher: { version: '1.0.0', sha256: 'a'.repeat(64) },
    runtime: { externalControlEnabled: true, runtimeState: 'writable', directHttpsState: 'ready', directHttpsReason: 'ready' },
    audit: { valid: true, segments: 2, events: 30 }, ...extra
  };
}

test('C15 diagnostic preview and ZIP contain only generated allowlisted summaries', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kaoyan-c15-diagnostics-'));
  const secret = 'c15-secret-canary'; const absolute = 'C:\\private\\questions.db';
  try {
    const bundle = new diagnostics.AgentDiagnosticBundle(directory, () => new Date('2026-07-22T12:00:00.000Z'));
    const input = snapshot({ runtime: { externalControlEnabled: true, runtimeState: `${secret}-${absolute}`, directHttpsState: 'ready', directHttpsReason: absolute }, secret, questionText: secret });
    const preview = await bundle.preview(input);
    assert.deepEqual(preview.files.map((entry) => entry.name), ['summary.json', 'manifest.json']);
    assert.equal(preview.files.every((entry) => /^[0-9a-f]{64}$/.test(entry.sha256)), true);
    const result = await bundle.export(input);
    assert.match(result.fileName, /^kaoyan-agent-diagnostics-/); assert.equal(path.isAbsolute(result.fileName), false);
    const bytes = fs.readFileSync(path.join(directory, result.fileName)); const text = bytes.toString('latin1');
    assert.equal(text.includes(secret), false); assert.equal(text.includes(absolute), false);
    const zip = new AdmZip(bytes); const names = zip.getEntries().map((entry) => entry.entryName).sort();
    assert.deepEqual(names, ['manifest.json', 'summary.json']);
    const summary = zip.readAsText('summary.json'); assert.equal(summary.includes(secret), false); assert.equal(summary.includes(absolute), false);
    assert.match(summary, /"runtimeState": "unavailable"/); assert.match(summary, /"directHttpsState": "ready"/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('C15 diagnostics reject protected data-root output before creating a file', async () => {
  const bundle = new diagnostics.AgentDiagnosticBundle('D:\\KaoyanMathMistakeBook\\diagnostics');
  await assert.rejects(bundle.export(snapshot()), /protected data root/);
});
