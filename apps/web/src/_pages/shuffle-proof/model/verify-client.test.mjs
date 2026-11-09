// 다시 계산의 Worker 잇기(ADR-0232 결정 9): 취소하면 Worker를 끝내고, 파일 요청은 화면 쪽에서 받아 페이지 CSP의 connect-src 안에 둔다
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorkerFetch } from './verify-flow.ts';
import { runVerification } from './verify-client.ts';

const api = { eventId: 'e', opensAt: '', seedRevealAt: '', lobby: null, batch: null };
const flush = () => new Promise((r) => setTimeout(r, 0));

function fakeWorkers() {
  const made = [];
  class FakeWorker {
    posted = [];
    terminated = false;
    constructor() {
      made.push(this);
    }
    postMessage(m, transfer) {
      this.posted.push({ m, transfer });
    }
    terminate() {
      this.terminated = true;
    }
  }
  const before = globalThis.Worker;
  globalThis.Worker = FakeWorker;
  return { made, restore: () => (globalThis.Worker = before) };
}

const ctx = (signal) => ({ signal, onProgress: () => undefined });

test('이미 취소된 신호면 Worker를 만들지 않고 바로 취소로 끝난다', async () => {
  const w = fakeWorkers();
  try {
    const c = new AbortController();
    c.abort();
    await assert.rejects(runVerification(api, 'h', '', ctx(c.signal)), { name: 'AbortError' });
    assert.equal(w.made.length, 0);
  } finally {
    w.restore();
  }
});

test('취소하면 Worker를 끝낸다', async () => {
  const w = fakeWorkers();
  try {
    const c = new AbortController();
    const p = runVerification(api, 'h', '', ctx(c.signal));
    await flush();
    c.abort();
    await assert.rejects(p, { name: 'AbortError' });
    assert.equal(w.made[0].terminated, true);
  } finally {
    w.restore();
  }
});

test('[ASVS v5.0.0-3.4.3] Worker의 파일 요청은 화면 쪽 fetch로 받아 넘긴다(페이지 CSP의 connect-src 안)', async () => {
  const w = fakeWorkers();
  const beforeFetch = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (url) => (urls.push(url), new Response(url.endsWith('nope.json') ? 'x' : '{"a":1}', { status: url.endsWith('nope.json') ? 404 : 200 }));
  try {
    const c = new AbortController();
    const p = runVerification(api, 'h', 'https://f', ctx(c.signal));
    await flush();
    const worker = w.made[0];
    worker.onmessage({ data: { fetch: { id: 1, url: 'https://f/000.json' } } });
    worker.onmessage({ data: { fetch: { id: 2, url: 'https://f/nope.json' } } });
    await flush();
    await flush();
    assert.deepEqual(urls, ['https://f/000.json', 'https://f/nope.json']);
    const replies = worker.posted.map((x) => x.m.fetched).filter(Boolean);
    const ok = replies.find((r) => r.id === 1);
    assert.equal(ok.status, 200);
    assert.equal(new TextDecoder().decode(ok.buffer), '{"a":1}');
    assert.deepEqual(worker.posted.find((x) => x.m.fetched?.id === 1).transfer, [ok.buffer]);
    assert.equal(replies.find((r) => r.id === 2).status, 404);
    worker.onmessage({ data: { outcome: { error: '없음' } } });
    assert.deepEqual(await p, { error: '없음' });
    assert.equal(worker.terminated, true);
  } finally {
    globalThis.fetch = beforeFetch;
    w.restore();
  }
});

test('Worker 쪽 fetchFile은 요청을 번호로 잇고 받은 글을 JSON으로 푼다', async () => {
  const posted = [];
  const { fetchFile, receive } = createWorkerFetch((m) => posted.push(m));
  const a = fetchFile('https://f/a.json');
  const b = fetchFile('https://f/b.json');
  assert.deepEqual(posted.map((m) => m.fetch.url), ['https://f/a.json', 'https://f/b.json']);
  receive({ id: posted[1].fetch.id, status: 404 });
  receive({ id: posted[0].fetch.id, status: 200, buffer: new TextEncoder().encode('{"x":2}').buffer });
  assert.deepEqual(await a, { status: 200, body: { x: 2 } });
  assert.deepEqual(await b, { status: 404 });
});
