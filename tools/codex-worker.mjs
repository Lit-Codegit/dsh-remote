#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, chmod, lstat, mkdir, open, readFile, readdir, realpath, rename, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { finished } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

import { CodexRpcClient, createNativeCodexThread, registerCodexHistory } from './codex-history.mjs';

const BUNDLED_CODEX = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EVIDENCE = ['run.json', 'exit.json', 'history.json', 'task.md', 'worker.events.jsonl', 'worker.stderr.log', 'result.md'];
export const HISTORY_FAILURE_EXIT_CODE = 3;

async function executable(file) {
  return path.isAbsolute(file) && (await stat(file)).isFile() && access(file, constants.X_OK).then(() => true);
}

export async function resolveCodexBinary(explicit, env = process.env) {
  if (explicit !== undefined) {
    if (!path.isAbsolute(explicit)) throw new Error('--codex-bin must be an absolute executable path');
    if (!await executable(explicit)) throw new Error('--codex-bin must name an executable file');
    return explicit;
  }
  const candidates = [BUNDLED_CODEX, ...(env.PATH ?? '').split(path.delimiter)
    .filter((directory) => directory && path.isAbsolute(directory))
    .map((directory) => path.join(directory, 'codex'))];
  for (const candidate of candidates) {
    try { if (await executable(candidate)) return candidate; } catch { /* Try the next installed CLI. */ }
  }
  throw new Error('No Codex executable found; pass --codex-bin with an absolute path');
}

function taskTitle(task) {
  const firstLine = task.split(/\r?\n/).find((line) => line.trim()) ?? '任务';
  const heading = firstLine.trim().replace(/^#{1,6}\s+/, '').replace(/\s+#+\s*$/, '').trim() || '任务';
  return Array.from(`DSH · ${heading}`).slice(0, 64).join('');
}

async function saveJson(file, value) {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, file);
}

function signalExitCode(signal) {
  return 128 + (os.constants.signals[signal] ?? 1);
}

/** Launch one exec worker; history registration only uses the official metadata APIs. */
export async function runCodexWorker(options, {
  spawnFn = spawn,
  createRpc = (binary) => new CodexRpcClient(binary, { timeoutMs: 5000 }),
  createNativeThread = createNativeCodexThread,
  registerHistory = registerCodexHistory,
  env = process.env,
  signalSource = process,
  killAfterMs = 3000,
  drainTimeoutMs = 1000,
} = {}) {
  for (const [key, flag] of [['cwd', '--cwd'], ['task', '--task'], ['runDir', '--run-dir']]) {
    if (typeof options[key] !== 'string' || !path.isAbsolute(options[key])) throw new Error(`${flag} must be an absolute path`);
  }
  if (!(await stat(options.cwd)).isDirectory()) throw new Error('--cwd must be an existing directory');
  if (!(await stat(options.task)).isFile()) throw new Error('--task must be an existing file');
  if (options.sandbox !== undefined && !['workspace-write', 'read-only'].includes(options.sandbox)) {
    throw new Error('--sandbox must be workspace-write or read-only');
  }
  const task = await readFile(options.task, 'utf8');
  if (!task.trim()) throw new Error('--task must contain a task');
  const binary = await resolveCodexBinary(options.codexBin, env);
  const runDir = path.resolve(options.runDir);
  await mkdir(runDir, { recursive: true, mode: 0o700 });
  if ((await lstat(runDir)).isSymbolicLink()) throw new Error('--run-dir must not be a symbolic link');
  for (const name of EVIDENCE) {
    try {
      await lstat(path.join(runDir, name));
      throw new Error(`Run directory already contains worker evidence: ${name}`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  if ((await readdir(runDir)).length) throw new Error('Run directory must be empty');
  await chmod(runDir, 0o700);
  const file = (name) => path.join(runDir, name);
  // Claim the run atomically so concurrent invocations cannot share evidence files.
  const claim = await open(file('run.json'), 'wx', 0o600);
  const startedAt = new Date().toISOString();
  const title = taskTitle(task);
  const run = {
    pid: null, wrapperPid: process.pid, startedAt, cwd: options.cwd, binary,
    taskFile: options.task, recordedTaskFile: file('task.md'), runDir, threadId: null, state: 'starting',
    history: { enabled: !options.skipHistory, defaultEnabled: true, explicitOptOut: Boolean(options.skipHistory) },
    ...(options.sandbox ? { sandbox: options.sandbox } : {}),
  };
  await claim.writeFile(`${JSON.stringify(run, null, 2)}\n`);
  await claim.close();
  await writeFile(file('task.md'), task, { flag: 'wx', mode: 0o600 });

  const writes = new Map();
  const save = (name, value) => {
    const previous = writes.get(name) ?? Promise.resolve();
    const snapshot = structuredClone(value);
    const next = previous.catch(() => {}).then(() => saveJson(file(name), snapshot));
    writes.set(name, next);
    return next;
  };
  let history = options.skipHistory
    ? { integrated: false, state: 'skipped', reason: 'explicit-opt-out', explicitOptOut: true, threadId: null }
    : { integrated: false, state: 'pending', threadId: null, attempts: 0 };
  await save('history.json', history);

  let child;
  let activeRpc;
  let interruptedSignal;
  let killTimer;
  let registration = Promise.resolve();
  let registrations = 0;
  let evidenceError;
  let spawnError;
  let bootstrapError;
  let workerThreadSeen = false;
  const observeWrite = (promise) => { promise.catch((error) => { evidenceError ??= error; }); };
  const interrupt = (signal) => {
    interruptedSignal ??= signal;
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      child.kill(signal);
      killTimer ??= setTimeout(() => child.kill('SIGKILL'), killAfterMs);
      killTimer.unref();
    }
    // This RPC process belongs to this invocation, too. Never signal other Codex processes.
    activeRpc?.child?.kill(signal);
  };
  const onInt = () => interrupt('SIGINT');
  const onTerm = () => interrupt('SIGTERM');
  signalSource.on('SIGINT', onInt);
  signalSource.on('SIGTERM', onTerm);

  async function closeRpc(rpc) {
    if (!rpc) return;
    let timer;
    try {
      await Promise.race([
        Promise.resolve().then(() => rpc.close()),
        new Promise((resolve) => {
          timer = setTimeout(() => {
            if (rpc.child?.exitCode === null && rpc.child?.signalCode === null) rpc.child.kill('SIGKILL');
            resolve();
          }, 2500);
          timer.unref();
        }),
      ]);
    } finally {
      clearTimeout(timer);
      rpc.child?.stdin?.destroy();
      rpc.child?.stdout?.destroy();
      rpc.child?.stderr?.destroy();
    }
  }

  async function register() {
    registrations += 1;
    let rpc;
    try {
      rpc = createRpc(binary);
      activeRpc = rpc;
      await rpc.initialize();
      const result = await registerHistory({ rpc, threadId: run.threadId, title });
      if (!result.integrated || result.threadId !== run.threadId) throw new Error('History registration did not confirm this worker');
      history = { ...result, state: 'integrated', attempts: registrations };
    } catch (error) {
      history = {
        integrated: false, state: 'pending', threadId: run.threadId,
        attempts: registrations, error: error.message,
      };
    } finally {
      try { await closeRpc(rpc); } catch (error) {
        history.cleanupError = error.message;
      }
      if (activeRpc === rpc) activeRpc = undefined;
      await save('history.json', history);
    }
  }

  async function bootstrap() {
    let rpc;
    try {
      rpc = createRpc(binary);
      activeRpc = rpc;
      await rpc.initialize();
      const native = await createNativeThread({
        rpc, cwd: options.cwd, title,
        ...(options.sandbox ? { sandbox: options.sandbox } : {}),
      });
      if (!UUID.test(native?.threadId ?? '') || !['cli', 'vscode'].includes(native.source)) {
        throw new Error('Native bootstrap did not return an interactive Codex thread');
      }
      if (typeof native.cwd !== 'string' || !path.isAbsolute(native.cwd)
        || await realpath(native.cwd) !== await realpath(options.cwd)) {
        throw new Error('Native bootstrap returned a different working directory');
      }
      run.threadId = native.threadId;
      run.nativeThread = native;
      history = { integrated: false, state: 'pending', threadId: native.threadId, source: native.source, attempts: 0 };
      await save('run.json', run);
    } catch (error) {
      bootstrapError = error;
      history = { integrated: false, state: 'pending', stage: 'bootstrap', threadId: run.threadId, attempts: 0, error: error.message };
    } finally {
      try { await closeRpc(rpc); } catch (error) { history.cleanupError = error.message; }
      if (activeRpc === rpc) activeRpc = undefined;
      await save('history.json', history);
    }
  }

  let events;
  let stderr;
  let lines;
  let workerCode = null;
  let workerSignal = null;
  try {
    // Open log files before spawning; stdout is never copied to the wrapper console.
    const eventHandle = await open(file('worker.events.jsonl'), 'wx', 0o600);
    let stderrHandle;
    try { stderrHandle = await open(file('worker.stderr.log'), 'wx', 0o600); }
    catch (error) { await eventHandle.close(); throw error; }
    events = eventHandle.createWriteStream();
    stderr = stderrHandle.createWriteStream();
    const eventDone = finished(events).catch((error) => { evidenceError ??= error; });
    const stderrDone = finished(stderr).catch((error) => { evidenceError ??= error; });
    const stopOnLogError = (error) => {
      evidenceError ??= error;
      if (child?.exitCode === null && child?.signalCode === null) interrupt('SIGTERM');
    };
    events.on('error', stopOnLogError);
    stderr.on('error', stopOnLogError);
    if (!options.skipHistory) await bootstrap();
    const args = options.skipHistory
      ? ['exec', '-C', options.cwd, '--json', '-o', file('result.md')]
      : ['exec', '--json', '-o', file('result.md')];
    if (options.sandbox) args.push('--sandbox', options.sandbox);
    if (!options.skipHistory) args.push('resume', run.threadId);
    args.push('-');
    try {
      if (bootstrapError || interruptedSignal) {
        events.end();
        stderr.end();
      } else {
        child = spawnFn(binary, args, { cwd: options.cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
        run.pid = child.pid ?? null;
        run.state = 'running';
        observeWrite(save('run.json', run));
        const exited = new Promise((resolve) => {
          child.once('error', (error) => { spawnError = error; resolve({ code: 1, signal: null }); });
          child.once('exit', (code, signal) => resolve({ code, signal }));
        });
        child.stdout.pipe(events);
        child.stderr.pipe(stderr);
        lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
        lines.on('line', (line) => {
          let event;
          try { event = JSON.parse(line); } catch { return; }
          if (event.type !== 'thread.started') return;
          const id = event.thread_id ?? event.threadId ?? event.thread?.id;
          if (!UUID.test(id ?? '')) return;
          if (!options.skipHistory && id !== run.threadId) {
            evidenceError ??= new Error('Worker reported a different thread than its native bootstrap');
            run.reportedThreadId = id;
            observeWrite(save('run.json', run));
            interrupt('SIGTERM');
            return;
          }
          if (workerThreadSeen) return;
          workerThreadSeen = true;
          run.threadId = id;
          observeWrite(save('run.json', run));
          history.threadId = id;
          observeWrite(save('history.json', history));
          if (!options.skipHistory) {
            registration = writes.get('run.json').then(() => register());
            registration.catch((error) => { evidenceError ??= error; });
          }
        });
        child.stdin.on('error', (error) => {
          if (!['EPIPE', 'ERR_STREAM_DESTROYED'].includes(error.code)) evidenceError ??= error;
        });
        child.stdin.end(task);
        if (interruptedSignal) interrupt(interruptedSignal);
        const outcome = await exited;
        workerSignal = outcome.signal;
        workerCode = outcome.signal ? signalExitCode(outcome.signal)
          : Number.isInteger(outcome.code) && outcome.code >= 0 ? outcome.code : 1;
      }
    } catch (error) {
      spawnError = error;
      workerCode = 1;
      events.end();
      stderr.end();
    } finally {
      clearTimeout(killTimer);
      let drainTimer;
      const drained = await Promise.race([
        Promise.all([eventDone, stderrDone]).then(() => true),
        new Promise((resolve) => { drainTimer = setTimeout(() => resolve(false), drainTimeoutMs); }),
      ]);
      clearTimeout(drainTimer);
      if (!drained) {
        evidenceError ??= new Error('Worker pipes remained open after exit; logs were truncated at the drain deadline');
        child?.stdout?.unpipe(events);
        child?.stderr?.unpipe(stderr);
        child?.stdout?.destroy();
        child?.stderr?.destroy();
        events.destroy();
        stderr.destroy();
      }
      lines?.close();
      await Promise.all([eventHandle.close(), stderrHandle.close()]);
    }
    await registration.catch((error) => { evidenceError ??= error; });
    if (!options.skipHistory && !bootstrapError && workerThreadSeen && !interruptedSignal) {
      await register(); // Revalidate completed history after exec releases its writer/metadata locks.
    }
    if (!options.skipHistory && !bootstrapError && !workerThreadSeen) {
      history = {
        ...history, integrated: false, state: 'pending', stage: 'worker-event',
        error: 'No valid thread.started event was received; history registration is pending',
      };
      await save('history.json', history);
    }
    await Promise.all([...writes.values()]);
    const exitCode = workerCode !== null && workerCode !== 0 ? workerCode
      : interruptedSignal ? signalExitCode(interruptedSignal)
        : bootstrapError ? HISTORY_FAILURE_EXIT_CODE
          : evidenceError ? 1 : !options.skipHistory && (!history.integrated || !workerThreadSeen) ? HISTORY_FAILURE_EXIT_CODE : 0;
    const endedAt = new Date().toISOString();
    run.state = 'completed';
    run.endedAt = endedAt;
    await save('run.json', run);
    const result = {
      exitCode, workerExitCode: workerCode, workerSignal, interruptedSignal: interruptedSignal ?? null,
      pid: run.pid, startedAt, endedAt, runDir, threadId: run.threadId,
      history, ...(bootstrapError ? { error: bootstrapError.message } : spawnError ? { error: spawnError.message } : {}),
      ...(evidenceError ? { evidenceError: evidenceError.message } : {}),
    };
    await save('exit.json', result);
    return result;
  } finally {
    clearTimeout(killTimer);
    signalSource.removeListener('SIGINT', onInt);
    signalSource.removeListener('SIGTERM', onTerm);
  }
}

export function parseWorkerArgs(argv) {
  const options = {};
  const flags = { '--cwd': 'cwd', '--task': 'task', '--run-dir': 'runDir', '--codex-bin': 'codexBin', '--sandbox': 'sandbox' };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--help' || flag === '-h') return { help: true };
    if (flag === '--skip-history') { options.skipHistory = true; continue; }
    if (!flags[flag] || !argv[index + 1] || argv[index + 1].startsWith('--')) throw new Error(`Unknown or incomplete option: ${flag}`);
    if (options[flags[flag]] !== undefined) throw new Error(`Repeated option: ${flag}`);
    options[flags[flag]] = argv[++index];
  }
  return options;
}

async function main() {
  const options = parseWorkerArgs(process.argv.slice(2));
  if (options.help) {
    console.log('node tools/codex-worker.mjs --cwd PATH --task FILE --run-dir DIR [--codex-bin PATH] [--sandbox workspace-write|read-only] [--skip-history]');
    return;
  }
  const result = await runCodexWorker(options);
  console.log(JSON.stringify({
    runDir: result.runDir, threadId: result.threadId, exitCode: result.exitCode,
    workerExitCode: result.workerExitCode, history: result.history.state,
    ...(result.history.deepLink ? { deepLink: result.history.deepLink } : {}),
    ...(result.history.ideDeepLink ? { ideDeepLink: result.history.ideDeepLink } : {}),
  }));
  process.exitCode = result.exitCode;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
