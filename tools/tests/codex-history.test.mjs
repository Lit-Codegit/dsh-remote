import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ALL_SOURCES,
  PINNED_SECTION_ID,
  registerCodexHistory,
} from '../codex-history.mjs';

const THREAD_ID = '11111111-1111-7111-a111-111111111111';
const OTHER_THREAD_ID = '22222222-2222-7222-a222-222222222222';
const CUSTOM_SECTION_ID = '33333333-3333-7333-a333-333333333333';
const PINNED = { id: PINNED_SECTION_ID, name: 'Pinned' };
const CUSTOM_SECTION = { id: CUSTOM_SECTION_ID, name: 'Existing work' };
const TITLE = 'DSH taskboard worker';
const METADATA_METHODS = new Set([
  'thread/read', 'threadSection/list', 'thread/name/set',
  'thread/section/move', 'thread/list',
]);

function fixture({
  thread = {},
  sections = [PINNED],
  sectionPages,
  visiblePages,
  intercept,
  persistSection = true,
} = {}) {
  const state = {
    thread: {
      id: THREAD_ID,
      source: 'exec',
      cwd: '/private/tmp/dsh-test/worktrees/worker',
      name: 'Old worker title',
      section: null,
      archived: false,
      ephemeral: false,
      ...structuredClone(thread),
    },
  };
  const calls = [];
  const counts = new Map();
  const rpc = {
    async request(method, params) {
      const call = { method, params: structuredClone(params) };
      calls.push(call);
      counts.set(method, (counts.get(method) ?? 0) + 1);
      assert.ok(METADATA_METHODS.has(method), `unexpected non-metadata API: ${method}`);
      await intercept?.(method, params, { state, calls, count: counts.get(method) });
      switch (method) {
        case 'thread/read':
          return { thread: structuredClone(state.thread) };
        case 'threadSection/list': {
          const page = sectionPages?.get(params.cursor);
          if (sectionPages) assert.ok(page, `unexpected section cursor: ${params.cursor}`);
          return structuredClone(page ?? { data: sections, nextCursor: null });
        }
        case 'thread/name/set':
          state.thread.name = params.name;
          return {};
        case 'thread/section/move': {
          const available = sectionPages
            ? [...sectionPages.values()].flatMap((page) => page.data)
            : sections;
          const section = available.find((item) => item.id === params.sectionId);
          assert.ok(section, 'a section must exist before moving into it');
          if (persistSection) state.thread.section = structuredClone(section);
          return {};
        }
        case 'thread/list': {
          const page = visiblePages?.get(params.cursor);
          if (visiblePages) assert.ok(page, `unexpected thread cursor: ${params.cursor}`);
          return structuredClone(page ?? { data: [state.thread], nextCursor: null });
        }
        default:
          assert.fail(`unhandled method: ${method}`);
      }
    },
  };
  return { rpc, calls, state };
}

function callsFor(calls, method) {
  return calls.filter((call) => call.method === method);
}

function assertGuiQuery(call, sectionId = PINNED_SECTION_ID) {
  assert.equal(call.params.sectionId, sectionId);
  assert.deepEqual(call.params.sourceKinds, ALL_SOURCES);
  assert.ok(call.params.sourceKinds.includes('exec'), 'background workers must remain visible');
  assert.deepEqual(call.params.modelProviders, []);
  assert.equal(call.params.archived, false);
  assert.equal(call.params.useStateDbOnly, true);
  assert.equal(call.params.limit, 100);
}

test('registers the existing exec worker using metadata APIs and the native GUI filters', async () => {
  const { rpc, calls, state } = fixture();
  const result = await registerCodexHistory({ rpc, threadId: THREAD_ID, title: TITLE });

  assert.equal(PINNED_SECTION_ID, '01984de2-8f74-7c91-a3b2-5c5e937cf318');
  assert.equal(result.integrated, true);
  assert.equal(result.threadId, THREAD_ID);
  assert.equal(result.sectionId, PINNED_SECTION_ID);
  assert.equal(result.name, TITLE);
  assert.equal(result.source, 'exec');
  assert.equal(result.cwd, state.thread.cwd);
  assert.equal(new URL(result.deepLink).protocol, 'codex:');
  assert.ok(result.deepLink.includes(THREAD_ID));
  assert.deepEqual(calls.map((call) => call.method), [
    'thread/read', 'threadSection/list', 'thread/name/set',
    'thread/section/move', 'thread/read', 'thread/list',
  ]);
  for (const call of callsFor(calls, 'thread/read')) {
    assert.deepEqual(call.params, { threadId: THREAD_ID, includeTurns: false });
  }
  assert.deepEqual(callsFor(calls, 'thread/name/set')[0].params, { threadId: THREAD_ID, name: TITLE });
  assert.deepEqual(callsFor(calls, 'thread/section/move')[0].params, {
    threadId: THREAD_ID, sectionId: PINNED_SECTION_ID,
  });
  assertGuiQuery(callsFor(calls, 'thread/list')[0]);
});

test('repeated registration preserves one thread without repeating name or section writes', async () => {
  const { rpc, calls, state } = fixture();
  const first = await registerCodexHistory({ rpc, threadId: THREAD_ID, title: TITLE });
  const second = await registerCodexHistory({ rpc, threadId: THREAD_ID, title: TITLE });

  assert.deepEqual(second, first);
  assert.equal(state.thread.id, THREAD_ID);
  assert.equal(state.thread.source, 'exec');
  assert.equal(callsFor(calls, 'thread/name/set').length, 1);
  assert.equal(callsFor(calls, 'thread/section/move').length, 1);
  assert.equal(callsFor(calls, 'thread/list').length, 2, 'each registration confirms visibility');
});

test('preserves an existing custom section instead of moving a user-organized thread to Pinned', async () => {
  const { rpc, calls, state } = fixture({
    thread: { section: CUSTOM_SECTION },
    sections: [CUSTOM_SECTION],
  });
  const result = await registerCodexHistory({ rpc, threadId: THREAD_ID });

  assert.equal(result.sectionId, CUSTOM_SECTION_ID);
  assert.deepEqual(state.thread.section, CUSTOM_SECTION);
  assert.equal(callsFor(calls, 'thread/section/move').length, 0);
  assert.equal(callsFor(calls, 'thread/name/set').length, 0, 'an omitted title preserves the existing name');
  assertGuiQuery(callsFor(calls, 'thread/list')[0], CUSTOM_SECTION_ID);
});

test('compares structured source metadata by value without changing it', async () => {
  const source = { subAgent: { threadSpawn: { parentThreadId: OTHER_THREAD_ID } } };
  const { rpc, state } = fixture({ thread: { source, section: PINNED } });
  const result = await registerCodexHistory({ rpc, threadId: THREAD_ID });

  assert.deepEqual(result.source, source);
  assert.deepEqual(state.thread.source, source);
});

test('explicit history opt-out makes no RPC requests', async () => {
  const { rpc, calls } = fixture();
  const result = await registerCodexHistory({
    rpc, threadId: THREAD_ID, title: TITLE, skipHistory: true,
  });

  assert.deepEqual(result, {
    integrated: false, reason: 'explicit-opt-out', threadId: THREAD_ID,
  });
  assert.deepEqual(calls, []);
});

test('retries the thread-started versus persistence race before making metadata writes', async () => {
  const { rpc, calls } = fixture({
    intercept(method, _params, { count }) {
      if (method === 'thread/read' && count <= 2) throw new Error(`thread not found: ${THREAD_ID}`);
    },
  });
  const delays = [];
  const result = await registerCodexHistory({
    rpc, threadId: THREAD_ID, title: TITLE, attempts: 3, retryDelayMs: 7,
    sleepFn: async (ms) => { delays.push(ms); },
  });

  assert.equal(result.integrated, true);
  assert.deepEqual(delays, [7, 7]);
  assert.deepEqual(calls.slice(0, 3).map((call) => call.method), [
    'thread/read', 'thread/read', 'thread/read',
  ]);
  assert.equal(callsFor(calls, 'thread/name/set').length, 1);
  assert.equal(callsFor(calls, 'thread/section/move').length, 1);
});

test('exhausted not-found retries stop without inventing a worker or changing metadata', async () => {
  const { rpc, calls } = fixture({
    intercept() { throw new Error(`thread not found: ${THREAD_ID}`); },
  });
  const delays = [];
  await assert.rejects(registerCodexHistory({
    rpc, threadId: THREAD_ID, title: TITLE, attempts: 3, retryDelayMs: 9,
    sleepFn: async (ms) => { delays.push(ms); },
  }), /thread not found/);

  assert.deepEqual(delays, [9, 9]);
  assert.equal(calls.length, 3);
  assert.ok(calls.every((call) => call.method === 'thread/read'));
});

test('permanent read failures are not retried and cannot proceed to writes', async () => {
  const { rpc, calls } = fixture({
    intercept() { throw new Error('permission denied'); },
  });
  const delays = [];
  await assert.rejects(registerCodexHistory({
    rpc, threadId: THREAD_ID, title: TITLE,
    sleepFn: async (ms) => { delays.push(ms); },
  }), /permission denied/);

  assert.deepEqual(delays, []);
  assert.deepEqual(calls.map((call) => call.method), ['thread/read']);
});

test('a failed title update does not continue to a section mutation', async () => {
  const { rpc, calls } = fixture({
    intercept(method) {
      if (method === 'thread/name/set') throw new Error('permission denied');
    },
  });
  await assert.rejects(registerCodexHistory({ rpc, threadId: THREAD_ID, title: TITLE }), /permission denied/);

  assert.deepEqual(calls.map((call) => call.method), [
    'thread/read', 'threadSection/list', 'thread/name/set',
  ]);
});

test('a missing built-in Pinned ID is rejected before writes even if another section has that name', async () => {
  const { rpc, calls } = fixture({ sections: [{ id: CUSTOM_SECTION_ID, name: 'Pinned' }] });
  await assert.rejects(registerCodexHistory({ rpc, threadId: THREAD_ID, title: TITLE }), /section|Pinned/i);

  assert.deepEqual(calls.map((call) => call.method), ['thread/read', 'threadSection/list']);
});

test('finds Pinned and the exact worker across independently paginated lists', async () => {
  const { rpc, calls } = fixture({
    sectionPages: new Map([
      [null, { data: [CUSTOM_SECTION], nextCursor: 'section-page-2' }],
      ['section-page-2', { data: [PINNED], nextCursor: null }],
    ]),
    visiblePages: new Map([
      [null, { data: [{ id: OTHER_THREAD_ID }], nextCursor: 'thread-page-2' }],
      ['thread-page-2', { data: [{ id: THREAD_ID }], nextCursor: null }],
    ]),
  });
  const result = await registerCodexHistory({ rpc, threadId: THREAD_ID });

  assert.equal(result.integrated, true);
  assert.deepEqual(callsFor(calls, 'threadSection/list').map((call) => call.params.cursor), [null, 'section-page-2']);
  assert.deepEqual(callsFor(calls, 'thread/list').map((call) => call.params.cursor), [null, 'thread-page-2']);
  for (const call of callsFor(calls, 'thread/list')) assertGuiQuery(call);
});

test('does not report success when the section move was not persisted', async () => {
  const { rpc, calls } = fixture({ persistSection: false });
  await assert.rejects(registerCodexHistory({ rpc, threadId: THREAD_ID }), /persist|section/i);

  assert.equal(callsFor(calls, 'thread/section/move').length, 1);
  assert.equal(callsFor(calls, 'thread/list').length, 0);
});

test('does not report success when the GUI-equivalent query cannot find the worker', async () => {
  const { rpc, calls } = fixture({
    thread: { section: PINNED },
    visiblePages: new Map([[null, { data: [{ id: OTHER_THREAD_ID }], nextCursor: null }]]),
  });
  await assert.rejects(registerCodexHistory({ rpc, threadId: THREAD_ID }), /GUI|visible|returned/i);

  assert.equal(callsFor(calls, 'thread/section/move').length, 0);
  assert.equal(callsFor(calls, 'thread/list').length, 1);
});
