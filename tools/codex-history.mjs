#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { access, mkdir, rename, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';

export const PINNED_SECTION_ID = '01984de2-8f74-7c91-a3b2-5c5e937cf318';
export const ALL_SOURCES = [
  'cli', 'vscode', 'exec', 'appServer', 'subAgent', 'subAgentReview',
  'subAgentCompact', 'subAgentThreadSpawn', 'subAgentOther', 'unknown',
];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function retryable(error) {
  return /(?:thread|rollout|session).*(?:not found|does not exist|no longer exists)|no (?:rollout|thread|session) (?:found|exists)|not found.*(?:thread|rollout|session)/i.test(error.message);
}

async function findInPages(rpc, method, params, predicate) {
  let cursor = null;
  const seen = new Set();
  for (let page = 0; page < 100; page += 1) {
    const result = await rpc.request(method, { ...params, cursor, limit: 100 });
    const found = (result.data ?? []).find(predicate);
    if (found) return found;
    cursor = result.nextCursor;
    if (!cursor) return undefined;
    if (seen.has(cursor)) throw new Error(`${method} repeated a pagination cursor`);
    seen.add(cursor);
  }
  throw new Error(`${method} exceeded the pagination limit`);
}

/** Register an existing worker through official metadata APIs; never start a model turn. */
export async function registerCodexHistory({
  rpc, threadId, title, skipHistory = false, attempts = 5, retryDelayMs = 300,
  sleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  if (!UUID.test(threadId ?? '')) throw new Error('A valid worker thread UUID is required');
  if (skipHistory) return { integrated: false, reason: 'explicit-opt-out', threadId };
  if (!rpc?.request) throw new Error('An app-server RPC client is required');
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 20) throw new Error('attempts must be between 1 and 20');
  if (title !== undefined && (typeof title !== 'string' || !title.trim())) throw new Error('title must be non-empty');

  let thread;
  // thread.started can precede rollout persistence. Only retry that specific race.
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      thread = (await rpc.request('thread/read', { threadId, includeTurns: false })).thread;
      if (thread?.id !== threadId) throw new Error('thread/read returned a different worker');
      break;
    } catch (error) {
      if (!retryable(error) || attempt + 1 === attempts) throw error;
      await sleepFn(retryDelayMs);
    }
  }

  const targetId = thread.section?.id ?? PINNED_SECTION_ID;
  const pinned = await findInPages(rpc, 'threadSection/list', {}, (section) => section.id === targetId);
  if (!pinned) throw new Error(targetId === PINNED_SECTION_ID
    ? 'This Codex app-server does not expose the built-in Pinned section'
    : 'The worker existing section is unavailable; preserving its placement');
  const name = title?.trim();
  if (name && thread.name !== name) await rpc.request('thread/name/set', { threadId, name });
  if (thread.section?.id !== pinned.id) {
    await rpc.request('thread/section/move', { threadId, sectionId: pinned.id });
  }

  const saved = (await rpc.request('thread/read', { threadId, includeTurns: false })).thread;
  if (saved?.id !== threadId || saved.section?.id !== pinned.id) throw new Error('Codex did not persist the worker section');
  if (JSON.stringify(saved.source) !== JSON.stringify(thread.source)) throw new Error('Worker source changed unexpectedly');
  if (name && saved.name !== name) throw new Error('Codex did not persist the worker title');

  // These are the native GUI section-list filters, including background exec workers.
  const visible = await findInPages(rpc, 'thread/list', {
    sectionId: pinned.id, sourceKinds: ALL_SOURCES, modelProviders: [],
    archived: false, useStateDbOnly: true,
  }, (item) => item.id === threadId);
  if (!visible) throw new Error('Worker is not returned by the GUI-equivalent section query');
  return {
    integrated: true, threadId, sectionId: pinned.id, name: saved.name ?? null,
    source: saved.source, cwd: saved.cwd, deepLink: `codex://threads/${threadId}`,
  };
}

export class CodexRpcClient {
  constructor(binary, { timeoutMs = 15000, shutdownMs = 3000 } = {}) {
    this.timeoutMs = timeoutMs;
    this.shutdownMs = shutdownMs;
    this.pending = new Map();
    this.nextId = 1;
    this.closed = false;
    this.child = spawn(binary, ['app-server', '--listen', 'stdio://'], { stdio: ['pipe', 'pipe', 'pipe'] });
    // Consume stderr without putting config values or unrelated diagnostics in reports.
    this.child.stderr.on('data', () => {});
    this.child.stdin.on('error', (error) => this.fail(error));
    this.child.on('error', (error) => this.fail(error));
    this.child.on('exit', () => this.fail(new Error('Codex app-server exited')));
    this.lines = readline.createInterface({ input: this.child.stdout });
    this.lines.on('line', (line) => {
      let response;
      try { response = JSON.parse(line); } catch { return; }
      const request = this.pending.get(response.id);
      if (!request) return;
      clearTimeout(request.timer);
      this.pending.delete(response.id);
      if (response.error) request.reject(new Error(`${request.method}: ${response.error.message ?? 'RPC error'}`));
      else request.resolve(response.result);
    });
  }

  fail(error) {
    this.closed = true;
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(error); }
    this.pending.clear();
  }

  request(method, params) {
    if (this.closed) return Promise.reject(new Error('Codex app-server is closed'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  async initialize() {
    await this.request('initialize', {
      clientInfo: { name: 'dsh_history', version: '0.1.0' },
      capabilities: { experimentalApi: true },
    });
    this.child.stdin.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`);
  }

  async close() {
    this.fail(new Error('Codex app-server is closing'));
    const releasePipes = () => {
      this.lines.close();
      for (const stream of [this.child.stdin, this.child.stdout, this.child.stderr]) stream?.destroy?.();
    };
    if (this.child.pid === undefined || this.child.exitCode !== null || this.child.signalCode !== null) {
      releasePipes();
      return;
    }
    await new Promise((resolve, reject) => {
      const timers = [];
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        timers.forEach(clearTimeout);
        this.child.removeListener('exit', exited);
        this.child.removeListener('close', exited);
        releasePipes();
        if (error) reject(error); else resolve();
      };
      const exited = () => finish();
      const signal = (name) => {
        try { this.child.kill(name); } catch (error) { finish(error); }
      };
      this.child.once('exit', exited);
      this.child.once('close', exited);
      timers.push(setTimeout(() => signal('SIGTERM'), this.shutdownMs / 3));
      timers.push(setTimeout(() => signal('SIGKILL'), this.shutdownMs * 2 / 3));
      timers.push(setTimeout(() => finish(new Error('Codex app-server did not stop within the shutdown limit')), this.shutdownMs));
      this.child.stdin.end();
    });
  }
}

async function resolveBinary(explicit) {
  if (explicit) { await access(explicit, constants.X_OK); return explicit; }
  const candidates = [
    '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex',
    ...((process.env.PATH ?? '').split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, 'codex'))),
  ];
  for (const candidate of candidates) {
    try { await access(candidate, constants.X_OK); return candidate; } catch { /* Try the next installed CLI. */ }
  }
  throw new Error('No Codex binary found; pass --codex-bin with the verified worker executable');
}

async function saveResult(file, result) {
  if (!file) return;
  const target = path.resolve(file);
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, target);
}

async function main(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === '--skip-history') { options.skipHistory = true; continue; }
    if (key === '--help') {
      console.log('node tools/codex-history.mjs --thread-id UUID [--title TEXT] [--codex-bin PATH] [--output FILE] [--skip-history]');
      return;
    }
    const names = { '--thread-id': 'threadId', '--title': 'title', '--codex-bin': 'binary', '--output': 'output' };
    if (!names[key] || argv[index + 1] === undefined) throw new Error(`Unknown or incomplete option: ${key}`);
    options[names[key]] = argv[++index];
  }
  // Validate before starting a process, including explicit opt-out.
  if (!UUID.test(options.threadId ?? '')) throw new Error('--thread-id must be a worker UUID');
  let rpc;
  try {
    if (!options.skipHistory) {
      rpc = new CodexRpcClient(await resolveBinary(options.binary));
      await rpc.initialize();
    }
    const result = await registerCodexHistory({ ...options, rpc });
    await saveResult(options.output, result);
    console.log(JSON.stringify(result));
  } catch (error) {
    await saveResult(options.output, { integrated: false, state: 'pending', threadId: options.threadId, error: error.message });
    throw error;
  } finally {
    await rpc?.close();
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
