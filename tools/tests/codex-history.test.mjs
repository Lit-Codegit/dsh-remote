import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as history from '../codex-history.mjs';

const ID = '11111111-1111-7111-a111-111111111111';
const OTHER_ID = '22222222-2222-7222-a222-222222222222';
const CUSTOM = { id: '33333333-3333-7333-a333-333333333333', name: 'Existing work' };
const PINNED = { id: history.PINNED_SECTION_ID, name: 'Pinned' };
const CWD = '/private/tmp/dsh-test/worktrees/worker';
const TITLE = 'DSH taskboard worker';

function fixture({ thread = {}, intercept, pages, persistName = true } = {}) {
  const state = { thread: {
    id: ID, source: 'vscode', cwd: CWD, name: 'Old title', section: null,
    archived: false, ephemeral: false, ...structuredClone(thread),
  } };
  const calls = [];
  const counts = new Map();
  const rpc = { async request(method, params) {
    calls.push({ method, params: structuredClone(params) });
    counts.set(method, (counts.get(method) ?? 0) + 1);
    await intercept?.(method, params, { state, count: counts.get(method) });
    switch (method) {
      case 'thread/start':
      case 'thread/read': return { thread: structuredClone(state.thread) };
      case 'thread/name/set':
        if (persistName) state.thread.name = params.name;
        return {};
      case 'thread/list': {
        if (pages) {
          assert.ok(pages.has(params.cursor), `unexpected cursor: ${params.cursor}`);
          return structuredClone(pages.get(params.cursor));
        }
        // The former all-sources query sees exec; ordinary native history does not.
        const visible = params.sourceKinds?.length
          ? params.sourceKinds.includes(state.thread.source)
          : ['cli', 'vscode'].includes(state.thread.source);
        return { data: visible ? [structuredClone(state.thread)] : [], nextCursor: null };
      }
      // Allow the old path so its regression fails on false integration, not an unknown mock API.
      case 'threadSection/list': return { data: [PINNED, CUSTOM], nextCursor: null };
      case 'thread/section/move': state.thread.section = structuredClone(PINNED); return {};
      default: assert.fail(`unexpected API: ${method}`);
    }
  } };
  return { rpc, calls, state };
}
const callsFor = (calls, method) => calls.filter((call) => call.method === method);
const methods = (calls) => calls.map((call) => call.method);
function assertNativeQuery({ params }) {
  assert.deepEqual(params.sourceKinds, []);
  assert.deepEqual(params.modelProviders, []);
  assert.equal(params.archived, false);
  assert.equal(params.useStateDbOnly, true);
  assert.equal(params.sortKey, 'created_at');
  assert.equal(Object.hasOwn(params, 'sectionId'), false);
}

test('exec is rejected before writes even when an all-sources Pinned query would find it', async () => {
  const { rpc, calls, state } = fixture({ thread: { source: 'exec', section: PINNED } });
  await assert.rejects(history.registerCodexHistory({ rpc, threadId: ID, title: TITLE }), /exec|non.interactive|native.*import/i);
  assert.deepEqual(methods(calls), ['thread/read']);
  assert.equal(state.thread.name, 'Old title');
  assert.deepEqual(state.thread.section, PINNED);
});

test('native registration checks ordinary history and never creates or moves a section', async () => {
  const { rpc, calls, state } = fixture();
  const result = await history.registerCodexHistory({ rpc, threadId: ID, title: TITLE });
  assert.equal(result.integrated, true);
  assert.equal(result.threadId, ID);
  assert.equal(result.source, 'vscode');
  assert.equal(result.cwd, CWD);
  assert.equal(result.name, TITLE);
  assert.equal(result.ideDeepLink, `vscode://openai.chatgpt/local/${ID}`);
  assert.equal(result.deepLink, `codex://threads/${ID}`);
  assert.equal(state.thread.section, null);
  assert.deepEqual(methods(calls), ['thread/read', 'thread/name/set', 'thread/read', 'thread/list']);
  for (const call of callsFor(calls, 'thread/read')) assert.deepEqual(call.params, { threadId: ID, includeTurns: false });
  assertNativeQuery(callsFor(calls, 'thread/list')[0]);
});

test('repeated registration keeps the same CLI thread and existing custom section', async () => {
  const { rpc, calls, state } = fixture({ thread: { source: 'cli', section: CUSTOM } });
  const first = await history.registerCodexHistory({ rpc, threadId: ID, title: TITLE });
  assert.deepEqual(await history.registerCodexHistory({ rpc, threadId: ID, title: TITLE }), first);
  assert.deepEqual(state.thread.section, CUSTOM);
  assert.equal(callsFor(calls, 'thread/name/set').length, 1);
  assert.equal(callsFor(calls, 'thread/section/move').length, 0);
  assert.equal(callsFor(calls, 'threadSection/list').length, 0);
});

test('explicit opt-out performs zero RPCs', async () => {
  const { rpc, calls } = fixture();
  assert.deepEqual(await history.registerCodexHistory({ rpc, threadId: ID, skipHistory: true }),
    { integrated: false, reason: 'explicit-opt-out', threadId: ID });
  assert.deepEqual(calls, []);
});

test('the thread-started persistence race is retried before any metadata write', async () => {
  const { rpc, calls } = fixture({ intercept(method, _params, { count }) {
    if (method === 'thread/read' && count <= 2) throw new Error(`thread not found: ${ID}`);
  } });
  const delays = [];
  assert.equal((await history.registerCodexHistory({ rpc, threadId: ID, title: TITLE,
    attempts: 3, retryDelayMs: 7, sleepFn: async (ms) => { delays.push(ms); } })).integrated, true);
  assert.deepEqual(delays, [7, 7]);
  assert.deepEqual(methods(calls).slice(0, 3), ['thread/read', 'thread/read', 'thread/read']);
  assert.equal(callsFor(calls, 'thread/name/set').length, 1);
});

test('exhausted not-found retries and permanent read failures stop without writes', async () => {
  const missing = fixture({ intercept() { throw new Error(`thread not found: ${ID}`); } });
  const delays = [];
  await assert.rejects(history.registerCodexHistory({ rpc: missing.rpc, threadId: ID,
    attempts: 3, retryDelayMs: 9, sleepFn: async (ms) => { delays.push(ms); } }), /thread not found/);
  assert.deepEqual(delays, [9, 9]);
  assert.deepEqual(methods(missing.calls), ['thread/read', 'thread/read', 'thread/read']);
  const denied = fixture({ intercept() { throw new Error('permission denied'); } });
  await assert.rejects(history.registerCodexHistory({ rpc: denied.rpc, threadId: ID,
    sleepFn: async () => assert.fail('permanent errors must not retry') }), /permission denied/);
  assert.deepEqual(methods(denied.calls), ['thread/read']);
});

test('ordinary-history pagination keeps the actual native filters', async () => {
  const { rpc, calls } = fixture({ pages: new Map([
    [null, { data: [{ id: OTHER_ID }], nextCursor: 'page-2' }],
    ['page-2', { data: [{ id: ID }], nextCursor: null }],
  ]) });
  assert.equal((await history.registerCodexHistory({ rpc, threadId: ID })).integrated, true);
  const pages = callsFor(calls, 'thread/list');
  assert.deepEqual(pages.map((call) => call.params.cursor), [null, 'page-2']);
  for (const call of pages) assertNativeQuery(call);
});

test('vscode source alone is insufficient when ordinary history does not return the ID', async () => {
  const { rpc } = fixture({ pages: new Map([[null, { data: [], nextCursor: null }]]) });
  await assert.rejects(history.registerCodexHistory({ rpc, threadId: ID }), /native|history|returned|visible/i);
});

test('structured non-interactive sources and archived records cannot be renamed', async () => {
  for (const thread of [{ source: { subAgent: { threadSpawn: {} } } }, { archived: true }]) {
    const { rpc, calls } = fixture({ thread });
    await assert.rejects(history.registerCodexHistory({ rpc, threadId: ID, title: TITLE }));
    assert.deepEqual(methods(calls), ['thread/read']);
  }
});

test('failed or unpersisted names cannot report integration', async () => {
  const denied = fixture({ intercept(method) { if (method === 'thread/name/set') throw new Error('permission denied'); } });
  await assert.rejects(history.registerCodexHistory({ rpc: denied.rpc, threadId: ID, title: TITLE }), /permission denied/);
  assert.deepEqual(methods(denied.calls), ['thread/read', 'thread/name/set']);
  const unchanged = fixture({ persistName: false });
  await assert.rejects(history.registerCodexHistory({ rpc: unchanged.rpc, threadId: ID, title: TITLE }), /persist|title|name/i);
  assert.equal(callsFor(unchanged.calls, 'thread/list').length, 0);
});

test('bootstrap persists a native identity without a prompt or early visibility claim', async () => {
  const { rpc, calls } = fixture();
  const result = await history.createNativeCodexThread({ rpc, cwd: CWD, title: TITLE, sandbox: 'workspace-write' });
  assert.deepEqual(result, { threadId: ID, source: 'vscode', cwd: CWD, name: TITLE });
  assert.deepEqual(methods(calls), ['thread/start', 'thread/name/set', 'thread/read']);
  assert.deepEqual(calls[0].params, { cwd: CWD, ephemeral: false, threadSource: 'user', sandbox: 'workspace-write' });
  assert.deepEqual(calls[2].params, { threadId: ID, includeTurns: false });
});

test('bootstrap omits unspecified sandbox and persists a default name', async () => {
  const { rpc, calls } = fixture({ thread: { source: 'cli' } });
  const result = await history.createNativeCodexThread({ rpc, cwd: CWD });
  assert.equal(Object.hasOwn(calls[0].params, 'sandbox'), false);
  assert.ok(result.name?.trim());
  assert.equal(result.source, 'cli');
  assert.equal(callsFor(calls, 'thread/name/set').length, 1);
});

test('bootstrap rejects a non-native source and an unexpected persisted workspace', async () => {
  const exec = fixture({ thread: { source: 'exec' } });
  await assert.rejects(history.createNativeCodexThread({ rpc: exec.rpc, cwd: CWD, title: TITLE }), /exec|native|source/i);
  assert.deepEqual(methods(exec.calls), ['thread/start']);
  const changed = fixture({ intercept(method, _params, { state }) {
    if (method === 'thread/read') state.thread.cwd = '/private/tmp/unexpected-workspace';
  } });
  await assert.rejects(history.createNativeCodexThread({ rpc: changed.rpc, cwd: CWD, title: TITLE }), /cwd|workspace|directory/i);
});

test('bootstrap validates settings before RPC and never adds model or auth overrides', async () => {
  for (const options of [{ cwd: 'relative/path' }, { cwd: CWD, title: ' ' }, { cwd: CWD, sandbox: 'danger-full-access' }]) {
    const { rpc, calls } = fixture();
    await assert.rejects(history.createNativeCodexThread({ rpc, ...options }));
    assert.deepEqual(calls, []);
  }
  const { rpc, calls } = fixture();
  await history.createNativeCodexThread({ rpc, cwd: CWD, title: TITLE });
  assert.deepEqual(methods(calls), ['thread/start', 'thread/name/set', 'thread/read']);
  for (const call of calls) for (const forbidden of ['model', 'config', 'approvalPolicy', 'approvalsReviewer', 'baseInstructions', 'developerInstructions']) {
    assert.equal(Object.hasOwn(call.params, forbidden), false, forbidden);
  }
});
