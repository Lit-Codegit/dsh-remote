#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { access, mkdir, realpath, rename, writeFile } from 'node:fs/promises';
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
    const result = await rpc.request(method, { ...params, cursor, limit: 50 });
    const found = (result.data ?? []).find(predicate);
    if (found) return found;
    cursor = result.nextCursor;
    if (!cursor) return undefined;
    if (seen.has(cursor)) throw new Error(`${method} repeated a pagination cursor`);
    seen.add(cursor);
  }
  throw new Error(`${method} exceeded the pagination limit`);
}

function requireNativeThread(thread) {
  if (!['cli', 'vscode'].includes(thread?.source)) {
    const source = typeof thread?.source === 'string' ? thread.source : 'non-interactive';
    throw new Error(`Worker source ${source} is excluded from ordinary native history; an official native import is required. Section placement is not history integration.`);
  }
  if (thread.archived) throw new Error('Archived workers are excluded from ordinary native history');
  if (thread.ephemeral) throw new Error('Ephemeral workers cannot be registered in native history');
}

function normalizedTitle(title, fallback) {
  if (title === undefined) return fallback;
  if (typeof title !== 'string' || !title.trim()) throw new Error('title must be non-empty');
  return title.trim();
}

async function sameWorkspace(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  if (path.resolve(left) === path.resolve(right)) return true;
  try { return (await realpath(left)) === (await realpath(right)); } catch { return false; }
}

/** Create a durable native identity, without starting a model turn or claiming visibility. */
export async function createNativeCodexThread({ rpc, cwd, title, sandbox } = {}) {
  if (!rpc?.request) throw new Error('An app-server RPC client is required');
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd) || cwd.includes('\0')) throw new Error('cwd must be an absolute workspace directory');
  if (sandbox !== undefined && !['read-only', 'workspace-write'].includes(sandbox)) {
    throw new Error('Bootstrap sandbox must be read-only or workspace-write');
  }
  const name = normalizedTitle(title, 'DSH · Codex');
  const created = (await rpc.request('thread/start', {
    cwd, ephemeral: false, threadSource: 'user',
    ...(sandbox === undefined ? {} : { sandbox }),
  })).thread;
  if (!UUID.test(created?.id ?? '')) throw new Error('thread/start did not return a valid native thread identity');
  requireNativeThread(created);
  if (!await sameWorkspace(created.cwd, cwd)) throw new Error('thread/start returned an unexpected workspace directory');
  // Explicit naming materializes the identity before the creating process exits.
  // A fresh thread may still have no preview until its first real worker turn.
  await rpc.request('thread/name/set', { threadId: created.id, name });
  const saved = (await rpc.request('thread/read', { threadId: created.id, includeTurns: false })).thread;
  if (saved?.id !== created.id) throw new Error('Codex did not persist the native thread identity');
  requireNativeThread(saved);
  if (saved.source !== created.source) throw new Error('Native worker source changed unexpectedly');
  if (!await sameWorkspace(saved.cwd, cwd)) throw new Error('Codex persisted an unexpected workspace directory');
  if (saved.name !== name) throw new Error('Codex did not persist the worker title');
  return { threadId: saved.id, source: saved.source, cwd: saved.cwd, name: saved.name };
}

/** Verify an existing worker against ordinary native history; never create a model turn. */
export async function registerCodexHistory({
  rpc, threadId, title, skipHistory = false, attempts = 5, retryDelayMs = 300,
  sleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  if (!UUID.test(threadId ?? '')) throw new Error('A valid worker thread UUID is required');
  if (skipHistory) return { integrated: false, reason: 'explicit-opt-out', threadId };
  if (!rpc?.request) throw new Error('An app-server RPC client is required');
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 20) throw new Error('attempts must be between 1 and 20');
  const name = normalizedTitle(title);

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

  // Native IDE history excludes exec/subagent sources. An all-sources section
  // query can find those records while the user's ordinary history remains empty.
  requireNativeThread(thread);
  if (name && thread.name !== name) await rpc.request('thread/name/set', { threadId, name });

  const saved = (await rpc.request('thread/read', { threadId, includeTurns: false })).thread;
  if (saved?.id !== threadId) throw new Error('thread/read returned a different worker');
  requireNativeThread(saved);
  if (saved.source !== thread.source) throw new Error('Worker source changed unexpectedly');
  if (name && saved.name !== name) throw new Error('Codex did not persist the worker title');

  // Match ordinary IDE history, including its default interactive-source filter.
  // Source alone is insufficient: a missing preview can still hide a row.
  const visible = await findInPages(rpc, 'thread/list', {
    sourceKinds: [], modelProviders: [], archived: false,
    useStateDbOnly: true, sortKey: 'created_at',
  }, (item) => item.id === threadId);
  if (!visible) throw new Error('Worker is not returned by the ordinary native history query');
  const deepLink = `codex://threads/${threadId}`;
  return {
    integrated: true, threadId, sectionId: saved.section?.id ?? null, name: saved.name ?? null,
    source: saved.source, cwd: saved.cwd, deepLink, codexDeepLink: deepLink,
    ideDeepLink: `vscode://openai.chatgpt/local/${threadId}`,
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
