import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseWorkerArgs, runCodexWorker } from '../codex-worker.mjs';

const THREAD_ID = '11111111-1111-7111-a111-111111111111';
const WRAPPER = fileURLToPath(new URL('../codex-worker.mjs', import.meta.url));
const FAKE_CLI = `#!/usr/bin/env node
const fs = require('node:fs');
const readline = require('node:readline');
const path = require('node:path');
const dir = process.env.FAKE_STATE;
const append = (name, value) => fs.appendFileSync(path.join(dir, name), JSON.stringify(value) + '\\n');
const stateFile = path.join(dir, 'metadata.json');
if (process.argv[2] === 'exec') {
  append('invocations.jsonl', {kind:'exec', args:process.argv.slice(2), cwd:process.cwd(), codexHome:process.env.CODEX_HOME ?? null});
  let task = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', data => task += data);
  process.stdin.on('end', () => {
    fs.writeFileSync(path.join(dir, 'stdin.txt'), task);
    const resumeIndex = process.argv.indexOf('resume');
    const id = process.env.FAKE_THREAD_ID ?? (resumeIndex < 0 ? '${THREAD_ID}' : process.argv[resumeIndex + 1]);
    process.stdout.write('not-json\\n' + JSON.stringify({type:'item.completed', thread_id:'22222222-2222-7222-a222-222222222222'}) + '\\n');
    const started = JSON.stringify({type:'thread.started',thread_id:id}) + '\\n';
    process.stdout.write(started.slice(0,13));
    setTimeout(() => {
      process.stdout.write(started.slice(13));
      const thread = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile,'utf8'))
        : {id, source:resumeIndex < 0 ? 'exec' : 'vscode', cwd:process.cwd(), name:'old', section:null};
      thread.preview = task.split('\\n')[0];
      fs.writeFileSync(stateFile, JSON.stringify(thread));
      fs.writeFileSync(path.join(dir,'worker-started'),'yes');
      if (process.env.FAKE_INHERIT_PIPES) {
        const background = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio:['ignore',process.stdout,process.stderr]});
        fs.writeFileSync(path.join(dir,'background.pid'),String(background.pid));
        background.unref();
      }
      setTimeout(() => {
        fs.writeFileSync(process.argv[process.argv.indexOf('-o') + 1], 'worker result\\n');
        process.stderr.write('worker diagnostics\\n');
        process.stdout.write(JSON.stringify({type:'turn.completed'}) + '\\n');
        process.exit(Number(process.env.FAKE_EXIT ?? 0));
      }, Number(process.env.FAKE_DELAY ?? 30));
    }, 5);
  });
} else if (process.argv[2] === 'app-server') {
  append('invocations.jsonl', {kind:'metadata', args:process.argv.slice(2)});
  const lines = readline.createInterface({input:process.stdin});
  lines.on('line', line => {
    const message = JSON.parse(line);
    append('rpc.jsonl', {method:message.method,params:message.params});
    if (message.id === undefined) return;
    let result = {};
    let error;
    if (message.method === 'initialize') result = {userAgent:'fake'};
    else if (message.method === 'thread/start') {
      if (process.env.FAKE_BOOTSTRAP_FAIL) error = {code:-32600,message:'bootstrap unavailable'};
      else {
        const thread = {id:'${THREAD_ID}',source:'vscode',cwd:message.params.cwd,name:null,section:null};
        fs.writeFileSync(stateFile,JSON.stringify(thread));
        result = {thread};
      }
    }
    else if (process.env.FAKE_HISTORY_FAIL && fs.existsSync(path.join(dir,'worker-started'))) error = {code:-32600,message:'metadata unavailable'};
    else {
      const thread = JSON.parse(fs.readFileSync(stateFile,'utf8'));
      switch (message.method) {
        case 'thread/read': result={thread}; break;
        case 'thread/name/set': thread.name=message.params.name; break;
        case 'thread/list': result={data:[thread],nextCursor:null}; break;
        default: error={code:-32601,message:'forbidden fake API: '+message.method};
      }
      fs.writeFileSync(stateFile,JSON.stringify(thread));
    }
    process.stdout.write(JSON.stringify({id:message.id,...(error ? {error} : {result})}) + '\\n');
  });
} else process.exit(99);
`;

async function fixture(t, extraEnv = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dsh-codex-worker-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cwd = path.join(directory, 'workspace');
  const state = path.join(directory, 'state');
  await Promise.all([mkdir(cwd), mkdir(state)]);
  const task = path.join(directory, 'task.md');
  const codexBin = path.join(directory, 'fake-codex');
  await writeFile(task, '# 小项目\nPrivate task body never printed.\n');
  await writeFile(codexBin, FAKE_CLI);
  await chmod(codexBin, 0o700);
  const options = { cwd, task, codexBin, runDir: path.join(directory, 'run') };
  const env = { ...process.env, FAKE_STATE: state, ...extraEnv };
  const readJson = async (name) => JSON.parse(await readFile(path.join(options.runDir, name), 'utf8'));
  const calls = async () => (await readFile(path.join(state, 'rpc.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  return { directory, options, env, state, readJson, calls };
}

function launch(args, env) {
  const child = spawn(process.execPath, [WRAPPER, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const done = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  return { child, done };
}

function argv(options) {
  return ['--cwd', options.cwd, '--task', options.task, '--run-dir', options.runDir, '--codex-bin', options.codexBin];
}

function nativeDependencies(f, overrides = {}) {
  return {
    env: f.env,
    createRpc: () => ({ async initialize() {}, async close() {} }),
    createNativeThread: async ({ cwd, title }) => ({ threadId: THREAD_ID, source: 'vscode', cwd, name: title }),
    ...overrides,
  };
}

test('actual wrapper CLI spawns a fake worker and automatically registers its original ID in native history', async (t) => {
  const f = await fixture(t, { CODEX_HOME: '/unchanged/configured/home' });
  const outcome = await launch(argv(f.options), f.env).done;
  assert.equal(outcome.code, 0, outcome.stderr);
  const summary = JSON.parse(outcome.stdout);
  assert.equal(summary.threadId, THREAD_ID);
  assert.equal(summary.deepLink, `codex://threads/${THREAD_ID}`);
  assert.equal(summary.ideDeepLink, `vscode://openai.chatgpt/local/${THREAD_ID}`);
  assert.equal(summary.history, 'integrated');
  assert.ok(!outcome.stdout.includes('Private task body'));
  assert.equal(await readFile(path.join(f.state, 'stdin.txt'), 'utf8'), await readFile(f.options.task, 'utf8'));
  const invocations = (await readFile(path.join(f.state, 'invocations.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  const worker = invocations.find((item) => item.kind === 'exec');
  assert.equal(worker.codexHome, '/unchanged/configured/home');
  assert.deepEqual(worker.args, ['exec', '--json', '-o', path.join(f.options.runDir, 'result.md'), 'resume', THREAD_ID, '-']);
  assert.equal(invocations.filter((item) => item.kind === 'exec').length, 1);
  const run = await f.readJson('run.json');
  assert.equal(run.threadId, THREAD_ID);
  assert.ok(run.pid > 0);
  assert.equal(run.binary, f.options.codexBin);
  assert.equal(run.recordedTaskFile, path.join(f.options.runDir, 'task.md'));
  assert.equal(await readFile(run.recordedTaskFile, 'utf8'), await readFile(f.options.task, 'utf8'));
  assert.equal((await stat(run.recordedTaskFile)).mode & 0o777, 0o600);
  assert.deepEqual(run.history, { enabled: true, defaultEnabled: true, explicitOptOut: false });
  const history = await f.readJson('history.json');
  assert.equal(history.name, 'DSH · 小项目');
  assert.equal(history.source, 'vscode');
  assert.equal(history.integrated, true);
  const calls = await f.calls();
  assert.deepEqual(calls.find((item) => item.method === 'thread/start').params, {
    cwd: f.options.cwd, ephemeral: false, threadSource: 'user',
  });
  assert.ok(calls.some((item) => item.method === 'thread/list' && item.params.sourceKinds.length === 0));
  assert.ok(calls.every((item) => ['initialize', 'initialized', 'thread/start', 'thread/read', 'thread/name/set', 'thread/list'].includes(item.method)));
  assert.equal((await f.readJson('exit.json')).workerExitCode, 0);
  assert.match(await readFile(path.join(f.options.runDir, 'worker.events.jsonl'), 'utf8'), /not-json/);
  assert.equal(await readFile(path.join(f.options.runDir, 'worker.stderr.log'), 'utf8'), 'worker diagnostics\n');
});

test('explicit opt-out starts no metadata client and retains the worker exit code', async (t) => {
  const f = await fixture(t);
  let metadataCalls = 0;
  const result = await runCodexWorker({ ...f.options, skipHistory: true, sandbox: 'read-only' }, {
    env: f.env, createRpc() { metadataCalls += 1; throw new Error('must not start'); },
  });
  assert.equal(result.exitCode, 0);
  assert.equal(metadataCalls, 0);
  assert.equal(result.history.reason, 'explicit-opt-out');
  assert.equal(result.history.threadId, THREAD_ID);
  const invocations = (await readFile(path.join(f.state, 'invocations.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(invocations.length, 1);
  assert.ok(invocations[0].args.includes('read-only'));
  await assert.rejects(readFile(path.join(f.state, 'rpc.jsonl')), { code: 'ENOENT' });
});

test('a worker failure remains the wrapper exit code even if history registration fails', async (t) => {
  const f = await fixture(t, { FAKE_EXIT: '17' });
  const result = await runCodexWorker(f.options, {
    ...nativeDependencies(f),
    async registerHistory() { throw new Error('metadata unavailable'); },
  });
  assert.equal(result.exitCode, 17);
  assert.equal(result.workerExitCode, 17);
  assert.equal(result.history.state, 'pending');
  assert.equal(result.history.attempts, 2);
  assert.equal((await f.readJson('exit.json')).exitCode, 17);
});

test('successful worker with failed default history registration records pending and exits 3', async (t) => {
  const f = await fixture(t);
  let calls = 0;
  const result = await runCodexWorker(f.options, {
    ...nativeDependencies(f),
    async registerHistory() { calls += 1; throw new Error('metadata unavailable'); },
  });
  assert.equal(result.exitCode, 3);
  assert.equal(result.workerExitCode, 0);
  assert.equal(result.history.state, 'pending');
  assert.equal(result.history.attempts, 2);
  assert.match((await f.readJson('history.json')).error, /metadata unavailable/);
  assert.equal(calls, 2);
});

test('registration starts while the worker runs and retries once after an initial persistence race', async (t) => {
  const f = await fixture(t, { FAKE_DELAY: '150' });
  let count = 0;
  let firstPid;
  const result = await runCodexWorker(f.options, {
    ...nativeDependencies(f),
    async registerHistory({ threadId, title }) {
      count += 1;
      if (count === 1) {
        firstPid = (await f.readJson('run.json')).pid;
        assert.doesNotThrow(() => process.kill(firstPid, 0));
        throw new Error('thread not found');
      }
      assert.throws(() => process.kill(firstPid, 0), { code: 'ESRCH' });
      assert.equal(title, 'DSH · 小项目');
      return { integrated: true, threadId, deepLink: `codex://threads/${threadId}` };
    },
  });
  assert.equal(result.exitCode, 0);
  assert.equal(count, 2);
  assert.equal(result.history.attempts, 2);
});

test('an early successful registration is rechecked after exit and becomes pending when the final query loses the ID', async (t) => {
  const f = await fixture(t, { FAKE_DELAY: '150' });
  let calls = 0;
  let pid;
  const result = await runCodexWorker(f.options, nativeDependencies(f, {
    async registerHistory({ threadId }) {
      calls += 1;
      if (calls === 1) {
        pid = (await f.readJson('run.json')).pid;
        assert.doesNotThrow(() => process.kill(pid, 0));
        return { integrated: true, threadId, deepLink: `codex://threads/${threadId}` };
      }
      assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
      assert.equal((await f.readJson('history.json')).integrated, true, 'early visibility remains recorded until the final query');
      throw new Error('The ordinary native history query did not return the worker ID');
    },
  }));
  assert.equal(calls, 2);
  assert.equal(result.workerExitCode, 0);
  assert.equal(result.exitCode, 3);
  assert.equal(result.history.state, 'pending');
  assert.equal(result.history.integrated, false);
  assert.match((await f.readJson('history.json')).error, /native history query/);
  assert.equal((await f.readJson('exit.json')).exitCode, 3);
});

test('existing evidence rejects a run before any worker spawn and preserves its bytes', async (t) => {
  const f = await fixture(t);
  await mkdir(f.options.runDir);
  await writeFile(path.join(f.options.runDir, 'worker.events.jsonl'), 'existing evidence');
  let spawned = false;
  await assert.rejects(runCodexWorker(f.options, {
    spawnFn() { spawned = true; throw new Error('must not spawn'); }, env: f.env,
  }), /already contains worker evidence/);
  assert.equal(spawned, false);
  assert.equal(await readFile(path.join(f.options.runDir, 'worker.events.jsonl'), 'utf8'), 'existing evidence');
});

test('relative paths, invalid sandbox, and non-absolute binaries fail before spawning', async (t) => {
  const f = await fixture(t);
  let spawned = false;
  const dependencies = { spawnFn() { spawned = true; }, env: f.env };
  for (const invalid of [{ cwd: '.' }, { task: 'task.md' }, { runDir: 'run' }, { codexBin: 'codex' }, { sandbox: 'danger-full-access' }]) {
    await assert.rejects(runCodexWorker({ ...f.options, ...invalid }, dependencies));
  }
  assert.equal(spawned, false);
  assert.throws(() => parseWorkerArgs(['--cwd']), /incomplete/);
});

test('a spawn failure writes exit evidence and does not attempt metadata registration', async (t) => {
  const f = await fixture(t);
  await writeFile(f.options.codexBin, '#!/no/such/fake-interpreter\n');
  let metadataCalls = 0;
  const result = await runCodexWorker({ ...f.options, skipHistory: true }, {
    env: f.env, createRpc() { metadataCalls += 1; throw new Error('must not start'); },
  });
  assert.equal(result.exitCode, 1);
  assert.equal(result.workerExitCode, 1);
  assert.equal(metadataCalls, 0);
  assert.match(result.error, /ENOENT/);
  assert.equal((await f.readJson('exit.json')).exitCode, 1);
});

test('a failed native bootstrap never spawns exec and records an incomplete delivery', async (t) => {
  const f = await fixture(t);
  let spawned = false;
  const result = await runCodexWorker(f.options, nativeDependencies(f, {
    async createNativeThread() { throw new Error('bootstrap unavailable'); },
    spawnFn() { spawned = true; throw new Error('must not spawn'); },
  }));
  assert.equal(spawned, false);
  assert.equal(result.workerExitCode, null);
  assert.equal(result.exitCode, 3);
  assert.equal(result.history.stage, 'bootstrap');
  assert.match((await f.readJson('exit.json')).error, /bootstrap unavailable/);
});

test('actual CLI bootstrap failure exits 3 without starting a worker', async (t) => {
  const f = await fixture(t, { FAKE_BOOTSTRAP_FAIL: '1' });
  const outcome = await launch(argv(f.options), f.env).done;
  assert.equal(outcome.code, 3, outcome.stderr);
  const invocations = (await readFile(path.join(f.state, 'invocations.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(invocations.every((item) => item.kind === 'metadata'));
  assert.equal((await f.readJson('exit.json')).workerExitCode, null);
});

test('an explicit sandbox is passed to native creation and to the exec parent flags', async (t) => {
  const f = await fixture(t);
  let bootstrapOptions;
  const result = await runCodexWorker({ ...f.options, sandbox: 'read-only' }, nativeDependencies(f, {
    async createNativeThread(options) {
      bootstrapOptions = options;
      return { threadId: THREAD_ID, source: 'vscode', cwd: options.cwd };
    },
    async registerHistory({ threadId }) { return { integrated: true, threadId }; },
  }));
  assert.equal(result.exitCode, 0);
  assert.deepEqual(Object.keys(bootstrapOptions).sort(), ['cwd', 'rpc', 'sandbox', 'title']);
  assert.equal(bootstrapOptions.sandbox, 'read-only');
  const invocation = JSON.parse((await readFile(path.join(f.state, 'invocations.jsonl'), 'utf8')).trim());
  assert.deepEqual(invocation.args, [
    'exec', '--json', '-o', path.join(f.options.runDir, 'result.md'),
    '--sandbox', 'read-only', 'resume', THREAD_ID, '-',
  ]);
});

test('a worker reporting a different thread is interrupted without registering the wrong ID', async (t) => {
  const otherId = '22222222-2222-7222-a222-222222222222';
  const f = await fixture(t, { FAKE_THREAD_ID: otherId, FAKE_DELAY: '10000' });
  let registrations = 0;
  const result = await runCodexWorker(f.options, nativeDependencies(f, {
    async registerHistory() { registrations += 1; throw new Error('must not register'); },
  }));
  assert.equal(result.threadId, THREAD_ID);
  assert.equal(result.exitCode, 143);
  assert.equal(registrations, 0);
  assert.equal((await f.readJson('run.json')).reportedThreadId, otherId);
  assert.match(result.evidenceError, /different thread/);
});

test('bootstrap rejects a noninteractive source or different cwd before sending the task to exec', async (t) => {
  const f = await fixture(t);
  for (const [index, native] of [
    { threadId: THREAD_ID, source: 'exec', cwd: f.options.cwd },
    { threadId: THREAD_ID, source: 'vscode', cwd: f.directory },
  ].entries()) {
    let spawned = false;
    const result = await runCodexWorker({ ...f.options, runDir: path.join(f.directory, `rejected-${index}`) }, nativeDependencies(f, {
      async createNativeThread() { return native; },
      spawnFn() { spawned = true; throw new Error('must not spawn'); },
    }));
    assert.equal(spawned, false);
    assert.equal(result.exitCode, 3);
    assert.equal(result.workerExitCode, null);
  }
});

test('an existing empty run directory is private before the worker writes its result', async (t) => {
  const f = await fixture(t);
  await mkdir(f.options.runDir, { mode: 0o755 });
  const result = await runCodexWorker({ ...f.options, skipHistory: true }, { env: f.env });
  assert.equal(result.exitCode, 0);
  assert.equal((await stat(f.options.runDir)).mode & 0o777, 0o700);
});

test('inherited background pipes have a bounded drain and still produce exit evidence', async (t) => {
  const f = await fixture(t, { FAKE_INHERIT_PIPES: '1' });
  const started = Date.now();
  const running = runCodexWorker({ ...f.options, skipHistory: true }, { env: f.env, drainTimeoutMs: 50 });
  let timer;
  try {
    const result = await Promise.race([
      running,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Worker remained blocked by descendant pipes')), 2000); }),
    ]);
    assert.equal(result.workerExitCode, 0);
    assert.equal(result.exitCode, 1);
    assert.match(result.evidenceError, /pipes.*truncated/);
    assert.match((await f.readJson('exit.json')).evidenceError, /drain deadline/);
    assert.ok(Date.now() - started < 2000);
  } finally {
    clearTimeout(timer);
    const backgroundPid = Number(await readFile(path.join(f.state, 'background.pid'), 'utf8'));
    try { process.kill(backgroundPid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    await running;
  }
});

test('SIGTERM targets the spawned worker and records its signal exit without touching other processes', async (t) => {
  const f = await fixture(t, { FAKE_DELAY: '10000' });
  const signals = new EventEmitter();
  const running = runCodexWorker({ ...f.options, skipHistory: true }, { env: f.env, signalSource: signals });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { if ((await f.readJson('run.json')).threadId) break; } catch { /* Await startup. */ }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  signals.emit('SIGTERM');
  const result = await running;
  assert.equal(result.exitCode, 143);
  assert.equal(result.workerSignal, 'SIGTERM');
  assert.equal((await f.readJson('exit.json')).interruptedSignal, 'SIGTERM');
  assert.equal(signals.listenerCount('SIGTERM'), 0);
});
