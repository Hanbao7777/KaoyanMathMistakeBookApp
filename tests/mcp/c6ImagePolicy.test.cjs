const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '../..');
const { applyPrincipalDataPolicy } = require(path.join(root, 'dist/main/main/mcp/tools/dataPolicy.js'));

const requestId = '123e4567-e89b-42d3-a456-426614174010';
const absolutePath = 'C:\\private\\mistake-book\\image.png';
const rawBytes = 'data:image/png;base64,' + 'A'.repeat(128);

function principal(scopes) {
  return Object.freeze({ apiVersion: 1, kind: 'agent-principal', clientId: 'image-client', subjectId: 'image-subject', displayName: 'Image Test',
    scopes, trust: 'full_control', credentialBinding: 'binding', authenticatedAt: '2026-07-18T00:00:00.000Z', renderer: false });
}

function outcome(data) {
  return { schemaVersion: 'kaoyan-mcp-schema-v1@1', ok: true, operation: 'questions.get', requestId, data };
}

test('image policy redacts inline strings, malformed metadata, and paths without image scope', () => {
  const value = {
    question_images: rawBytes,
    solution_images: 'B'.repeat(200_000),
    imageData: rawBytes,
    nested: { image_data: [rawBytes, { data: rawBytes, file_path: absolutePath }] },
    images: [{ id: 1, file_path: absolutePath, mimeType: 'image/png', width: 100, height: 100, sizeBytes: 10 }],
    file_path: absolutePath,
    safe: 'kept'
  };
  const filtered = applyPrincipalDataPolicy(outcome(value), principal(['questions.read']));
  assert.equal(filtered.data.question_images, '[REDACTED]');
  assert.equal(filtered.data.solution_images, '[REDACTED]');
  assert.equal(filtered.data.imageData, '[REDACTED]');
  assert.deepEqual(filtered.data.nested.image_data, '[REDACTED]');
  assert.equal(filtered.data.images, '[REDACTED]');
  assert.equal(filtered.data.file_path, undefined);
  assert.equal(filtered.data.safe, 'kept');
  assert.doesNotMatch(JSON.stringify(filtered), /data:image|private|mistake-book|AAAA|BBBB/);
});

test('image scope permits only bounded validated metadata, never raw bytes or absolute paths', () => {
  const filtered = applyPrincipalDataPolicy(outcome({
    question_images: [
      { id: 1, question_id: 7, image_type: 'original', file_path: absolutePath, mimeType: 'image/png', width: 100, height: 100, sizeBytes: 10 },
      { id: 2, mimeType: 'image/svg+xml', width: 100, height: 100, sizeBytes: 10 },
      { id: 3, mimeType: 'image/png', width: 0, height: 100, sizeBytes: 10 },
      { id: 4, mimeType: 'image/png', width: 100, height: 100, sizeBytes: 9 * 1024 * 1024 },
      rawBytes
    ],
    imageData: rawBytes,
    nested: { images: [{ id: 5, mimeType: 'image/jpeg', width: 10_001, height: 10, sizeBytes: 1 }] },
    filePath: absolutePath
  }), principal(['questions.read', 'files.images.read']));
  assert.deepEqual(filtered.data.question_images[0], { id: 1, question_id: 7, image_type: 'original', mimeType: 'image/png', width: 100, height: 100, sizeBytes: 10 });
  assert.equal(filtered.data.question_images[1], '[REDACTED]');
  assert.equal(filtered.data.question_images[2], '[REDACTED]');
  assert.equal(filtered.data.question_images[3], '[REDACTED]');
  assert.equal(filtered.data.question_images[4], '[REDACTED]');
  assert.equal(filtered.data.imageData, '[REDACTED]');
  assert.equal(filtered.data.nested.images[0], '[REDACTED]');
  assert.equal(filtered.data.filePath, undefined);
  assert.doesNotMatch(JSON.stringify(filtered), /data:image|private|mistake-book|AAAA/);
});
