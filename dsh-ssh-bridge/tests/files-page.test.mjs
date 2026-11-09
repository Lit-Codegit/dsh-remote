import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { listDirectory, resolveWithin } from '../lib/files-page.mjs';

function workspace(t) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-files-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, 'workspace');
  const outside = path.join(temporary, 'workspace-other');
  fs.mkdirSync(root);
  fs.mkdirSync(outside);
  fs.mkdirSync(path.join(root, 'folder'));
  fs.writeFileSync(path.join(root, 'report.txt'), 'workspace report');
  fs.writeFileSync(path.join(root, 'folder', 'nested.txt'), 'nested report');
  fs.writeFileSync(path.join(outside, 'private.txt'), 'outside the workspace');
  return { temporary, root, outside };
}

function symlink(t, target, destination, type) {
  try {
    fs.symlinkSync(target, destination, type);
    return true;
  } catch (error) {
    if (error.code !== 'EPERM' && error.code !== 'EACCES') throw error;
    t.skip('Symbolic links are unavailable for this account');
    return false;
  }
}

test('resolves relative and absolute workspace paths but rejects lexical escapes', (t) => {
  const { root, outside } = workspace(t);
  assert.equal(resolveWithin(root, ''), root);
  assert.equal(resolveWithin(root, 'folder/nested.txt'), path.join(root, 'folder', 'nested.txt'));
  assert.equal(resolveWithin(root, path.join(root, 'report.txt')), path.join(root, 'report.txt'));
  assert.equal(resolveWithin(root, '../workspace-other/private.txt'), undefined);
  assert.equal(resolveWithin(root, path.join(outside, 'private.txt')), undefined);
});

test('preserves safe missing paths for the routes to return 404', (t) => {
  const { root } = workspace(t);
  const missing = path.join(root, 'missing', 'report.txt');
  assert.equal(resolveWithin(root, 'missing/report.txt'), missing);
  assert.throws(() => fs.statSync(missing), { code: 'ENOENT' });
});

test('refuses files and directories whose symbolic links leave the workspace', (t) => {
  const { root, outside } = workspace(t);
  if (!symlink(t, path.join(outside, 'private.txt'), path.join(root, 'private.txt'), 'file')) return;
  if (!symlink(t, outside, path.join(root, 'external'), 'dir')) return;
  assert.equal(resolveWithin(root, 'private.txt'), undefined);
  assert.equal(resolveWithin(root, path.join(root, 'private.txt')), undefined);
  assert.equal(resolveWithin(root, 'external'), undefined);
  assert.equal(resolveWithin(root, 'external/private.txt'), undefined);
  assert.equal(resolveWithin(root, 'external/missing.txt'), undefined);
});

test('refuses dangling links and their missing descendants', (t) => {
  const { root, outside } = workspace(t);
  if (!symlink(t, path.join(outside, 'missing'), path.join(root, 'dangling'), 'dir')) return;
  assert.equal(resolveWithin(root, 'dangling'), undefined);
  assert.equal(resolveWithin(root, 'dangling/missing.txt'), undefined);
});

test('allows symbolic links to files and directories inside the workspace', (t) => {
  const { root } = workspace(t);
  if (!symlink(t, path.join(root, 'report.txt'), path.join(root, 'report-link.txt'), 'file')) return;
  if (!symlink(t, path.join(root, 'folder'), path.join(root, 'folder-link'), 'dir')) return;
  const linkedFile = resolveWithin(root, 'report-link.txt');
  assert.equal(fs.readFileSync(linkedFile, 'utf8'), 'workspace report');
  assert.equal(resolveWithin(root, 'folder-link/nested.txt'), path.join(root, 'folder-link', 'nested.txt'));
  assert.equal(listDirectory(root).find((entry) => entry.name === 'folder-link').dir, true);
});

test('accepts a symbolic-link workspace root without weakening its boundary', (t) => {
  const { temporary, root, outside } = workspace(t);
  const alias = path.join(temporary, 'workspace-link');
  if (!symlink(t, root, alias, 'dir')) return;
  if (!symlink(t, outside, path.join(root, 'external'), 'dir')) return;
  assert.equal(resolveWithin(alias, ''), alias);
  assert.equal(resolveWithin(alias, 'report.txt'), path.join(alias, 'report.txt'));
  assert.equal(resolveWithin(alias, path.join(alias, 'report.txt')), path.join(alias, 'report.txt'));
  assert.equal(resolveWithin(alias, 'external/private.txt'), undefined);
  assert.ok(listDirectory(alias).some((entry) => entry.name === 'report.txt'));
});

test('directory listings omit external and dangling links while keeping in-root links', (t) => {
  const { root, outside } = workspace(t);
  const directory = path.join(root, 'folder');
  if (!symlink(t, path.join(outside, 'private.txt'), path.join(directory, 'external-file'), 'file')) return;
  if (!symlink(t, outside, path.join(directory, 'external-dir'), 'dir')) return;
  if (!symlink(t, path.join(outside, 'missing'), path.join(directory, 'dangling'), 'file')) return;
  if (!symlink(t, path.join(root, 'report.txt'), path.join(directory, 'internal-file'), 'file')) return;
  if (!symlink(t, root, path.join(directory, 'internal-dir'), 'dir')) return;
  const entries = listDirectory(directory, root);
  assert.deepEqual(entries.map((entry) => entry.name).sort(), ['internal-dir', 'internal-file', 'nested.txt']);
  assert.equal(entries.find((entry) => entry.name === 'internal-dir').dir, true);
  assert.equal(entries.find((entry) => entry.name === 'internal-file').size, Buffer.byteLength('workspace report'));
});

test('does not list a directory reached outside the supplied workspace', (t) => {
  const { root, outside } = workspace(t);
  if (!symlink(t, outside, path.join(root, 'external'), 'dir')) return;
  assert.throws(() => listDirectory(outside, root), /outside the workspace/);
  assert.throws(() => listDirectory(path.join(root, 'external'), root), /outside the workspace/);
});
