import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { CodexRpcClient } from '../codex-history.mjs';

function fakeClient({ onSignal = () => {} } = {}) {
  const client = Object.create(CodexRpcClient.prototype);
  client.pending = new Map();
  client.closed = false;
  client.shutdownMs = 90;
  client.timeoutMs = 100;
  client.child = new EventEmitter();
  Object.assign(client.child, { pid: 123, exitCode: null, signalCode: null });
  client.child.stdin = { end() {} };
  client.signals = [];
  client.child.kill = (name) => { client.signals.push(name); onSignal(name, client.child); return true; };
  client.lines = { close() {} };
  return client;
}

test('a stuck metadata process cannot keep shutdown pending forever', async () => {
  const client = fakeClient();
  await assert.rejects(client.close(), /shutdown limit/);
  assert.deepEqual(client.signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(client.closed, true);
  await assert.rejects(client.request('thread/read', {}), /closed/);
});

test('shutdown stops after its own metadata process exits on SIGTERM', async () => {
  const client = fakeClient({ onSignal: (_name, child) => child.emit('exit', 0) });
  await client.close();
  assert.deepEqual(client.signals, ['SIGTERM']);
});

test('shutdown handles a failed spawn without awaiting a nonexistent process', async () => {
  const client = fakeClient();
  client.child.pid = undefined;
  await client.close();
  assert.deepEqual(client.signals, []);
});

test('metadata process exit releases inherited pipes so the client host can exit', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dsh-history-pipes-test-'));
  const binary = path.join(directory, 'fake-metadata');
  const pidFile = path.join(directory, 'descendant.pid');
  const helper = new URL('../codex-history.mjs', import.meta.url).href;
  await writeFile(binary, `#!/usr/bin/env node
const { spawn } = require('node:child_process');
const { writeFileSync } = require('node:fs');
const readline = require('node:readline');
const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['ignore', 1, 2] });
writeFileSync(process.env.DSH_TEST_CHILD_PID_FILE, String(descendant.pid));
const lines = readline.createInterface({ input: process.stdin });
lines.on('line', line => {
  const request = JSON.parse(line);
  if (request.id !== undefined) process.stdout.write(JSON.stringify({ id: request.id, result: {} }) + '\\n');
});
process.stdin.on('end', () => process.exit(0));
`);
  await chmod(binary, 0o700);
  const source = `import { CodexRpcClient } from ${JSON.stringify(helper)};
const rpc = new CodexRpcClient(process.argv[1]);
await rpc.initialize();
await rpc.close();
console.log('closed');`;
  const host = spawn(process.execPath, ['--input-type=module', '-e', source, binary], {
    env: { ...process.env, DSH_TEST_CHILD_PID_FILE: pidFile }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    if (host.exitCode === null && host.signalCode === null) host.kill('SIGKILL');
    try {
      const pid = Number(await readFile(pidFile, 'utf8'));
      if (Number.isInteger(pid) && pid > 0) process.kill(pid, 'SIGKILL');
    } catch (error) { if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error; }
    await rm(directory, { recursive: true, force: true });
  });
  let stdout = '';
  let stderr = '';
  host.stdout.on('data', (chunk) => { stdout += chunk; });
  host.stderr.on('data', (chunk) => { stderr += chunk; });
  let timer;
  try {
    const code = await Promise.race([
      new Promise((resolve, reject) => { host.once('close', resolve); host.once('error', reject); }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Inherited metadata pipes kept host alive')), 5000); }),
    ]);
    assert.equal(code, 0, stderr);
    assert.equal(stdout.trim(), 'closed');
  } finally { clearTimeout(timer); }
});
