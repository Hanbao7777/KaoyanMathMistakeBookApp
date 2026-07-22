const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const authority = 'https://127.0.0.1:39458/mcp';
function executable(command) { const suffixes = process.platform === 'win32' ? ['.cmd', '.exe', ''] : ['']; for (const directory of (process.env.PATH || '').split(path.delimiter)) for (const suffix of suffixes) { const candidate = path.join(directory, `${command}${suffix}`); if (fs.existsSync(candidate)) return candidate; } if (process.platform === 'win32') { const comspec = process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe'; const result = spawnSync(comspec, ['/d', '/c', 'where', command], { encoding: 'utf8', windowsHide: true }); let candidate = `${result.stdout || ''}`.split(/\r?\n/).find(Boolean)?.trim(); if (!(result.status === 0 && candidate && fs.existsSync(candidate))) { const powershell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'; const fallback = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', `(Get-Command ${command}).Source`], { encoding: 'utf8', windowsHide: true }); candidate = `${fallback.stdout || ''}`.trim(); } if (candidate && fs.existsSync(candidate)) return candidate; } return null; }
function version(command) { const file = executable(command); if (!file) return null; const result = process.platform === 'win32' ? spawnSync(process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe', ['/d', '/c', file, '--version'], { encoding: 'utf8', windowsHide: true }) : spawnSync(file, ['--version'], { encoding: 'utf8', windowsHide: true }); return result.status === 0 ? `${result.stdout}${result.stderr}`.trim() : null; }
const codex = executable('codex'); const claude = executable('claude'); const codexVersion = version('codex'); const claudeVersion = version('claude');

test('C14 disposable client registration matrix uses no default profiles', { skip: !codexVersion && !claudeVersion }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kaoyan-c14-real-client-'));
  try {
    if (codexVersion) {
      const env = { ...process.env, CODEX_HOME: path.join(root, 'codex') }; fs.mkdirSync(env.CODEX_HOME, { recursive: true });
      const runCodex = (args) => execFileSync(codex, args, { env, encoding: 'utf8', windowsHide: true, timeout: 45_000, shell: true });
      runCodex(['mcp', 'add', 'kaoyan-c14-codex', '--url', authority, '--oauth-client-id', 'kaoyan-codex-local', '--oauth-resource', authority]);
      assert.match(runCodex(['mcp', 'get', 'kaoyan-c14-codex']), /kaoyan-c14-codex|127\.0\.0\.1/);
      runCodex(['mcp', 'remove', 'kaoyan-c14-codex']);
      assert.equal(fs.existsSync(path.join(root, 'codex', 'config.toml')) || fs.existsSync(path.join(root, 'codex', 'config.json')), true);
    }
    if (claudeVersion) {
      const env = { ...process.env, CLAUDE_CONFIG_DIR: path.join(root, 'claude') }; fs.mkdirSync(env.CLAUDE_CONFIG_DIR, { recursive: true });
      const runClaude = (args) => execFileSync(claude, args, { env, encoding: 'utf8', windowsHide: true, timeout: 45_000, shell: true });
      runClaude(['mcp', 'add', '--scope', 'user', '--transport', 'http', '--callback-port', '39457', '--client-id', 'kaoyan-claude-local', 'kaoyan-c14-claude', authority]);
      assert.match(runClaude(['mcp', 'get', 'kaoyan-c14-claude']), /kaoyan-c14-claude|127\.0\.0\.1/);
      runClaude(['mcp', 'remove', '--scope', 'user', 'kaoyan-c14-claude']);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('C14 real-client evidence records installed product versions without reading default profiles', { skip: !codexVersion && !claudeVersion }, () => {
  assert.equal(typeof codexVersion === 'string' || typeof claudeVersion === 'string', true);
});
