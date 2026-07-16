const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REAL_DATA_ROOT = path.resolve('D:\\KaoyanMathMistakeBook');

function comparable(target) {
  return path.resolve(String(target).replace(/^\\\\\?\\/, '')).toLowerCase();
}

function isDescendant(parent, target, allowEqual = false) {
  const relative = path.relative(comparable(parent), comparable(target));
  return (allowEqual && relative === '') || (relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function assertNoRealDataOverlap(target) {
  assert.equal(isDescendant(REAL_DATA_ROOT, target, true), false, 'path must not overlap the real data root');
  assert.equal(isDescendant(target, REAL_DATA_ROOT, true), false, 'path must not contain the real data root');
}

function realpath(target) {
  return fs.realpathSync.native(path.resolve(target));
}

function assertSafeTempRoot(root) {
  const logicalRoot = path.resolve(root);
  const logicalTemp = path.resolve(os.tmpdir());
  assertNoRealDataOverlap(logicalRoot);
  assert.equal(isDescendant(logicalTemp, logicalRoot), true, `root must be below ${logicalTemp}`);
  assert.equal(path.basename(logicalRoot).toLowerCase().startsWith('kaoyan-'), true, 'root must have a kaoyan-* basename');
  const physicalRoot = realpath(logicalRoot);
  const physicalTemp = realpath(logicalTemp);
  assertNoRealDataOverlap(physicalRoot);
  assert.equal(isDescendant(physicalTemp, physicalRoot), true, 'root resolves outside the OS temp directory');
  return physicalRoot;
}

function assertSafeDescendant(root, target, { allowMissing = false } = {}) {
  const safeRoot = assertSafeTempRoot(root);
  const logicalTarget = path.resolve(target);
  assertNoRealDataOverlap(logicalTarget);
  assert.equal(isDescendant(safeRoot, logicalTarget, true), true, 'target escapes spike root');

  const relativeParts = path.relative(safeRoot, logicalTarget).split(path.sep).filter(Boolean);
  let current = safeRoot;
  for (const part of relativeParts) {
    current = path.join(current, part);
    if (!fs.existsSync(current)) {
      assert.equal(allowMissing, true, 'target does not exist');
      continue;
    }
    const stat = fs.lstatSync(current);
    assert.equal(stat.isSymbolicLink(), false, 'target contains a symlink or junction');
    const physicalCurrent = realpath(current);
    assertNoRealDataOverlap(physicalCurrent);
    assert.equal(isDescendant(safeRoot, physicalCurrent, true), true, 'target resolves outside spike root');
  }
  return logicalTarget;
}

function makeSafeTempRoot(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `kaoyan-c0-${label}-`));
  return assertSafeTempRoot(root);
}

function safeWrite(root, target, value) {
  const safeRoot = assertSafeTempRoot(root);
  const resolved = assertSafeDescendant(safeRoot, target, { allowMissing: true });
  const parent = path.dirname(resolved);
  assertSafeDescendant(safeRoot, parent, { allowMissing: true });
  fs.mkdirSync(parent, { recursive: true });
  assertSafeDescendant(safeRoot, parent);
  fs.writeFileSync(resolved, value);
}

function safeSpawn(root, command, args, options = {}) {
  const safeRoot = assertSafeTempRoot(root);
  const cwd = options.cwd || safeRoot;
  assertSafeDescendant(safeRoot, cwd);
  return spawnSync(command, args, { encoding: 'utf8', ...options, cwd });
}

module.exports = {
  REAL_DATA_ROOT,
  assertSafeDescendant,
  assertSafeTempRoot,
  isDescendant,
  makeSafeTempRoot,
  safeSpawn,
  safeWrite
};
