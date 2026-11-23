// F-05-4 스캔 기록 즉시 업로드 시험(계획 docs/review/plans/F-05-4.md §4 uploader.ts·§6 B7 묶음·다시 시도·O-T21 ③·O-T10·7.4.4).
// 정본: docs/features/offline-gate.md §6.5 '업로드 첫 구현'(5초·500건, 즉시 올리는 때, 5초 × 3^(시도 수 − 1) 최대 5분, 400·401·403, 로그아웃 10초).
// 시계·타이머는 주입한 가짜다(고정 대기 없음). 큐는 진짜 메모리 큐(MemoryScanQueue). 업로드 포트는 UploadPort를 구현한 시험 대역이고,
// 실패 응답의 오류 객체는 진짜 ScannerApi가 fetch 응답(상태·WWW-Authenticate·Problem)으로 만든 것을 그대로 던진다.
// 로그아웃의 10초 한도만 node:test 가짜 setTimeout으로 진행한다. 새 모듈은 동적 불러오기로 읽는다.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ScannerApi as ScannerApiType } from '../src/api/client.ts';
import { generateDpopKey } from '../src/api/dpop.ts';
import { MemoryScanQueue, type ScanQueue, type ScanQueueRecord } from '../src/storage/scan-queue.ts';
import { deferred, EVENT, SESSION, settle } from './scanner-fixture.ts';

type Body = Record<string, unknown>;
interface UploadPort {
  upload(batch: Body[], o: { withToken: boolean }): Promise<{ acceptedIds: string[]; resyncRequired: boolean }>;
}
interface UploadState {
  pending: number;
  failed: boolean;
  lastUploadAtMs?: number;
  stopped?: 'device-revoked' | 'device-unregistered';
}
interface Uploader {
  queued(): Promise<void>;
  flushNow(): Promise<{ sent: number; accepted: number; deferred: number; tokenCleared: boolean }>;
  stop(): void;
}
type UploaderModule = {
  retryDelayMs(attempts: number): number;
  ScanUploader: new (d: {
    queue: ScanQueue;
    port: UploadPort;
    hasToken(): Promise<boolean>;
    clearToken(): Promise<void>;
    now(): number;
    setTimer(fn: () => void, ms: number): unknown;
    clearTimer(h: unknown): void;
    onState(s: UploadState): void;
    onResync(): void;
    onSignedOut(): void;
  }) => Uploader;
  logoutAfterFlush(d: {
    uploader: Uploader;
    online: boolean;
    queue: ScanQueue;
    clearToken(): Promise<void>;
    now(): number;
    timeoutMs?: number;
    setTimer?(fn: () => void, ms: number): unknown;
    clearTimer?(h: unknown): void;
  }): Promise<{ remaining: number }>;
};
const CLIENT = '../src/api/client.ts';
// client.ts도 동적으로 읽는다: Node 형식 벗기기로 읽지 못하는 문법(매개변수 속성 등)이면 이 단언에서 떨어진다
const clientLoaded = (await import(CLIENT).catch(() => ({}))) as { ScannerApi?: typeof ScannerApiType };
function ScannerApi(): typeof ScannerApiType {
  assert.equal(typeof clientLoaded.ScannerApi, 'function', `${CLIENT}를 Node(node --test)가 읽지 못한다`);
  return clientLoaded.ScannerApi!;
}
const MODULE = '../src/sync/uploader.ts';
const loaded = (await import(MODULE).catch(() => ({}))) as Partial<UploaderModule>;
function up(): UploaderModule {
  for (const name of ['retryDelayMs', 'ScanUploader', 'logoutAfterFlush'] as const) assert.equal(typeof loaded[name], 'function', `${MODULE}의 ${name}가 없다`);
  return loaded as UploaderModule;
}

const T0 = Date.parse('2026-11-23T10:00:00.000Z');
const PROBLEM = 'https://peaket.example/problems/';
const dpopKey = await generateDpopKey();

/** 진짜 ScannerApi가 그 응답으로 던지는 오류(업로드 경로) */
async function apiError(status: number, o: { wwwAuthenticate?: string; type?: string } = {}): Promise<unknown> {
  const headers: Record<string, string> = { 'content-type': 'application/problem+json' };
  if (o.wwwAuthenticate) headers['www-authenticate'] = o.wwwAuthenticate;
  const api = new (ScannerApi())({
    origin: 'https://scanner-api.peaket.example',
    key: dpopKey,
    token: 'staff-token',
    fetch: (async () => new Response(JSON.stringify({ type: `${PROBLEM}${o.type ?? 'about-blank'}`, title: `시험 ${status}`, status }), { status, headers })) as typeof fetch,
  });
  try {
    await api.uploadScans([]);
  } catch (e) {
    return e;
  }
  return assert.fail(`ScannerApi가 ${status}에 던지지 않았다`);
}
const invalidToken = () => apiError(401, { wwwAuthenticate: 'DPoP error="invalid_token", error_description="scanner session ended"' });
const invalidProof = () => apiError(401, { wwwAuthenticate: 'DPoP algs="ES256", error="invalid_dpop_proof"' });

type Reply = { acceptedIds?: string[]; resyncRequired?: boolean } | { throws: unknown } | { hang: Promise<unknown> };
/** UploadPort 대역: 받은 묶음을 적고, 차례대로 정한 답을 준다(답이 다 떨어지면 모두 받는다) */
class ScriptedPort implements UploadPort {
  readonly calls: { ids: string[]; withToken: boolean; batch: Body[] }[] = [];
  readonly replies: Reply[];
  constructor(replies: Reply[] = []) {
    this.replies = replies;
  }
  async upload(batch: Body[], o: { withToken: boolean }) {
    const ids = batch.map((b) => String(b.id));
    this.calls.push({ ids, withToken: o.withToken, batch });
    const r = this.replies.shift();
    if (r && 'throws' in r) throw r.throws;
    if (r && 'hang' in r) {
      await r.hang;
      return { acceptedIds: ids, resyncRequired: false };
    }
    return { acceptedIds: r?.acceptedIds ?? ids, resyncRequired: r?.resyncRequired ?? false };
  }
}

function record(n: number, atMs: number): ScanQueueRecord {
  const id = `0190f3a1-7c2e-7f00-8000-${String(n).padStart(12, '0')}`;
  const body = { id, eventId: EVENT, ticketId: `0190f3a1-7c2e-7a00-8b2a-${String(n).padStart(12, '0')}`, scannerSessionId: SESSION, direction: 'IN', method: 'QR', result: 'PASS', gateZone: '동문', scannedAtDevice: new Date(atMs).toISOString(), knownSeq: 1, deviceSeq: n };
  return { id, eventId: EVENT, ticketId: body.ticketId, keyId: 'ldN7EyqkmYs', scannedAtMs: atMs, payload: JSON.stringify(body), attempts: 0, nextAttemptAtMs: atMs };
}

/** 가짜 시계·타이머·토큰을 잇는 업로더 묶음 */
function harness(port: UploadPort, o: { token?: boolean } = {}) {
  let now = T0;
  let seq = 0;
  let token = o.token ?? true;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const log = { states: [] as UploadState[], resync: 0, signedOut: 0, cleared: 0, order: [] as string[] };
  const queue = new MemoryScanQueue();
  const timerApi = {
    setTimer: (fn: () => void, ms: number): unknown => {
      const h = ++seq;
      timers.set(h, { at: now + ms, fn });
      return h;
    },
    clearTimer: (h: unknown): void => {
      timers.delete(h as number);
    },
  };
  const uploader = new (up().ScanUploader)({
    ...timerApi,
    queue,
    port,
    hasToken: async () => token,
    clearToken: async () => {
      log.cleared++;
      log.order.push('clearToken');
      token = false;
    },
    now: () => now,
    onState: (s) => log.states.push(s),
    onResync: () => log.resync++,
    onSignedOut: () => log.signedOut++,
  });
  let n = 0;
  return {
    queue,
    uploader,
    log,
    timerApi,
    now: () => now,
    /** queued()를 부르지 않고 큐에만 쓴다(flushNow 범위를 보려고) */
    async putOnly(count: number) {
      for (let i = 0; i < count; i++) await queue.put(record(++n, now - 1_000_000 + n));
    },
    /** 기록 하나를 큐에 쓰고 queued()를 부른다 */
    async add(count = 1) {
      for (let i = 0; i < count; i++) {
        await queue.put(record(++n, now - 1_000_000 + n));
        await uploader.queued();
      }
      await settle();
    },
    /** 시계를 ms만큼 앞으로. 그 사이에 걸린 타이머를 차례대로 부른다 */
    async advance(ms: number) {
      const target = now + ms;
      for (;;) {
        const next = [...timers.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        timers.delete(next[0]);
        now = next[1].at;
        next[1].fn();
        await settle();
      }
      now = target;
      await settle();
    },
    lastState: () => log.states.at(-1),
  };
}

const rowsOf = async (q: ScanQueue) => q.due(Number.MAX_SAFE_INTEGER, 1000);

test('GAT-140 retryDelayMs는 5초 × 3^(시도 수 − 1)이고 최대 5분이다(1~6, 10)', () => {
  const { retryDelayMs } = up();
  assert.deepEqual([1, 2, 3, 4, 5, 6, 10].map(retryDelayMs), [5_000, 15_000, 45_000, 135_000, 300_000, 300_000, 300_000]);
});

test('GAT-140 B7 첫 기록 뒤 4,999ms에는 보내지 않고 5,000ms에 그 사이 기록까지 한 묶음으로 보낸다(스태프 토큰과 함께)', async () => {
  const port = new ScriptedPort();
  const h = harness(port);
  await h.add();
  await h.advance(1_000);
  await h.add();
  await h.advance(3_999);
  assert.equal(port.calls.length, 0, '4,999ms');
  await h.advance(1);
  assert.equal(port.calls.length, 1, '5,000ms');
  assert.equal(port.calls[0]!.ids.length, 2);
  assert.equal(port.calls[0]!.withToken, true);
  assert.equal(port.calls[0]!.batch[0]!.eventId, EVENT, '큐 payload(ScanEvent 본문)를 그대로 싣는다');
  assert.equal(await h.queue.count(), 0);
  assert.deepEqual(h.lastState(), { pending: 0, failed: false, lastUploadAtMs: T0 + 5_000 });
});

test('GAT-140 B7 499건은 5초를 기다리고 500건째 queued에 곧바로 500건을 보낸다', async () => {
  const port = new ScriptedPort();
  const h = harness(port);
  await h.add(499);
  assert.equal(port.calls.length, 0, '499건');
  await h.add(1);
  assert.equal(port.calls.length, 1, '500건째 즉시');
  assert.equal(port.calls[0]!.ids.length, 500);
  assert.equal(h.now(), T0, '시계가 가지 않았다');
  assert.equal(await h.queue.count(), 0);
});

test('GAT-140 B7 501건이면 앞선 500건을 먼저 보내고 남은 1건도 5초 안에 보낸다(한 번에 500건까지, 판정 시각 차례)', async () => {
  const port = new ScriptedPort();
  const h = harness(port);
  await h.add(501);
  assert.ok(port.calls.length >= 1);
  const firstIds = port.calls[0]!.ids;
  assert.equal(firstIds.length, 500);
  assert.equal(firstIds.includes(record(501, 0).id), false, '가장 늦은 기록은 첫 묶음에 없다');
  await h.advance(5_000);
  assert.deepEqual(port.calls.map((c) => c.ids.length), [500, 1]);
  assert.equal(await h.queue.count(), 0);
});

test('GAT-140 flushNow(연결 복귀·화면 복귀·[지금 동기화])는 5초 전에도 바로 보내고, 뒤의 타이머는 다시 보내지 않는다', async () => {
  const port = new ScriptedPort();
  const h = harness(port);
  await h.add();
  const r = await h.uploader.flushNow();
  assert.deepEqual(r, { sent: 1, accepted: 1, deferred: 0, tokenCleared: false });
  assert.equal(port.calls.length, 1);
  await h.advance(5_000);
  assert.equal(port.calls.length, 1);
});

test('GAT-140 다시 시도: acceptedIds에 없는 기록만 남고 시도 수 1·다음 시각 +5,000ms, 그때 그것만 다시 보낸다', async () => {
  const port = new ScriptedPort([{ acceptedIds: [record(1, 0).id, record(2, 0).id] }]);
  const h = harness(port);
  await h.add(3);
  const r = await h.uploader.flushNow();
  assert.deepEqual(r, { sent: 3, accepted: 2, deferred: 1, tokenCleared: false });
  const left = await rowsOf(h.queue);
  assert.deepEqual(left.map((x) => [x.id, x.attempts, x.nextAttemptAtMs]), [[record(3, 0).id, 1, T0 + 5_000]]);
  await h.advance(4_999);
  assert.equal(port.calls.length, 1);
  await h.advance(1);
  assert.deepEqual(port.calls.map((c) => c.ids), [[record(1, 0).id, record(2, 0).id, record(3, 0).id], [record(3, 0).id]]);
  assert.equal(await h.queue.count(), 0);
});

test('GAT-140 다시 시도: 연결 끊김·5xx·429는 기록을 남기고 시도 수를 올려 +5,000ms로 미루며 업로드 실패로 보인다', async () => {
  for (const [label, err] of [
    ['연결 끊김', new TypeError('fetch failed')],
    ['503', await apiError(503, { type: 'scanner-auth-unavailable' })],
    ['429', await apiError(429, { type: 'rate-limited' })],
  ] as const) {
    const port = new ScriptedPort([{ throws: err }]);
    const h = harness(port);
    await h.add();
    const r = await h.uploader.flushNow();
    assert.deepEqual(r, { sent: 1, accepted: 0, deferred: 1, tokenCleared: false }, label);
    assert.deepEqual((await rowsOf(h.queue)).map((x) => [x.attempts, x.nextAttemptAtMs]), [[1, T0 + 5_000]], label);
    assert.deepEqual(h.lastState(), { pending: 1, failed: true }, label);
  }
});

test('GAT-140 다시 시도: 두 번째 실패는 +15,000ms로 미룬다', async () => {
  const port = new ScriptedPort([{ throws: new TypeError('fetch failed') }, { throws: new TypeError('fetch failed') }]);
  const h = harness(port);
  await h.add();
  await h.uploader.flushNow();
  await h.advance(5_000);
  assert.equal(port.calls.length, 2);
  assert.deepEqual((await rowsOf(h.queue)).map((x) => [x.attempts, x.nextAttemptAtMs]), [[2, T0 + 5_000 + 15_000]]);
});

test('GAT-140 다시 시도: 400(본문 검사)은 최대 간격 300,000ms로 미루고 업로드 실패로 보인다', async () => {
  const port = new ScriptedPort([{ throws: await apiError(400, { type: 'invalid-scan' }) }]);
  const h = harness(port);
  await h.add();
  await h.uploader.flushNow();
  assert.deepEqual((await rowsOf(h.queue)).map((x) => [x.attempts, x.nextAttemptAtMs]), [[1, T0 + 300_000]]);
  assert.equal(h.lastState()!.failed, true);
  await h.advance(299_999);
  assert.equal(port.calls.length, 1);
});

test('GAT-140 다시 시도: 403 device-revoked·device-unregistered면 업로드를 멈추고 큐를 그대로 두며 그 뒤 보내지 않는다', async () => {
  for (const type of ['device-revoked', 'device-unregistered'] as const) {
    const port = new ScriptedPort([{ throws: await apiError(403, { type }) }]);
    const h = harness(port);
    await h.add(2);
    await h.uploader.flushNow();
    assert.equal(h.lastState()!.stopped, type);
    assert.equal(await h.queue.count(), 2, type);
    await h.add();
    await h.advance(300_000);
    await h.uploader.flushNow();
    assert.equal(port.calls.length, 1, `${type} 뒤 보내지 않는다`);
    assert.equal(await h.queue.count(), 3);
  }
});

test('GAT-140 다시 시도: resyncRequired면 onResync를 한 번 부르고 받은 기록은 지운다', async () => {
  const port = new ScriptedPort([{ resyncRequired: true }]);
  const h = harness(port);
  await h.add(2);
  await h.uploader.flushNow();
  assert.equal(h.log.resync, 1);
  assert.equal(await h.queue.count(), 0);
});

test('O-T21 ③ 401 invalid_token이면 토큰을 한 번 지우고 같은 ID 묶음을 토큰 없이 곧바로 다시 보내며 로그인 화면으로 간다', async () => {
  const port = new ScriptedPort([{ throws: await invalidToken() }]);
  const h = harness(port);
  await h.add(3);
  const r = await h.uploader.flushNow();
  assert.equal(port.calls.length, 2);
  assert.deepEqual(port.calls.map((c) => c.withToken), [true, false]);
  assert.deepEqual(port.calls[1]!.ids, port.calls[0]!.ids);
  assert.equal(h.log.cleared, 1);
  assert.equal(h.log.signedOut, 1);
  assert.deepEqual(r, { sent: 3, accepted: 3, deferred: 0, tokenCleared: true });
  assert.equal(await h.queue.count(), 0);
  // 토큰이 지워졌으니 다음 묶음도 기기 인증만이다
  await h.add();
  await h.uploader.flushNow();
  assert.equal(port.calls[2]!.withToken, false);
});

test('O-T21 ③ 토큰 없이 다시 보낸 것도 401이면 그 묶음을 미루고 세 번째로 보내지 않는다', async () => {
  for (const second of [await invalidToken(), await apiError(401)]) {
    const port = new ScriptedPort([{ throws: await invalidToken() }, { throws: second }]);
    const h = harness(port);
    await h.add();
    const r = await h.uploader.flushNow();
    assert.equal(port.calls.length, 2);
    assert.deepEqual(r, { sent: 1, accepted: 0, deferred: 1, tokenCleared: true });
    assert.deepEqual((await rowsOf(h.queue)).map((x) => [x.attempts, x.nextAttemptAtMs]), [[1, T0 + 5_000]]);
  }
});

test('O-T21 ③ 401 invalid_dpop_proof면 토큰을 그대로 두고 토큰과 함께 곧바로 한 번 다시 보내며, 또 401이면 미룬다', async () => {
  const ok = new ScriptedPort([{ throws: await invalidProof() }]);
  const h = harness(ok);
  await h.add(2);
  const r = await h.uploader.flushNow();
  assert.deepEqual(ok.calls.map((c) => c.withToken), [true, true]);
  assert.deepEqual(ok.calls[1]!.ids, ok.calls[0]!.ids);
  assert.equal(h.log.cleared, 0);
  assert.equal(h.log.signedOut, 0);
  assert.deepEqual(r, { sent: 2, accepted: 2, deferred: 0, tokenCleared: false });

  const twice = new ScriptedPort([{ throws: await invalidProof() }, { throws: await invalidProof() }]);
  const h2 = harness(twice);
  await h2.add();
  await h2.uploader.flushNow();
  assert.equal(twice.calls.length, 2);
  assert.equal(h2.log.cleared, 0);
  assert.deepEqual((await rowsOf(h2.queue)).map((x) => x.attempts), [1]);
});

test('O-T21 ③ WWW-Authenticate가 없는 401은 토큰을 지우지 않고 곧바로 다시 보내지도 않고 미룬다', async () => {
  const port = new ScriptedPort([{ throws: await apiError(401) }]);
  const h = harness(port);
  await h.add();
  await h.uploader.flushNow();
  assert.equal(port.calls.length, 1);
  assert.equal(h.log.cleared, 0);
  assert.deepEqual((await rowsOf(h.queue)).map((x) => [x.attempts, x.nextAttemptAtMs]), [[1, T0 + 5_000]]);
});

test('O-T10 응답을 잃은 묶음(서버는 저장)은 큐에 남아 같은 ID로 다시 올라가고, 서버가 받았다고 답하면 큐가 빈다', async () => {
  const stored = new Set<string>();
  let lose = true;
  const server: UploadPort = {
    async upload(batch) {
      for (const b of batch) stored.add(String(b.id));
      if (lose) {
        lose = false;
        throw new TypeError('socket hang up');
      }
      return { acceptedIds: batch.map((b) => String(b.id)), resyncRequired: false };
    },
  };
  const calls: string[][] = [];
  const port: UploadPort = { upload: (batch, o) => (calls.push(batch.map((b) => String(b.id))), server.upload(batch, o)) };
  const h = harness(port);
  await h.add(2);
  await h.uploader.flushNow();
  assert.equal(await h.queue.count(), 2, '응답을 잃으면 지우지 않는다');
  await h.uploader.flushNow();
  assert.deepEqual(calls[1], calls[0]);
  assert.equal(await h.queue.count(), 0);
  assert.equal(stored.size, 2);
});

test('GAT-140 받지 않은 기록은 남는다: 서버가 acceptedIds를 비워 답하면 아무것도 지우지 않는다', async () => {
  const port = new ScriptedPort([{ acceptedIds: [] }]);
  const h = harness(port);
  await h.add(2);
  await h.uploader.flushNow();
  assert.equal(await h.queue.count(), 2);
});

test('GAT-140 7.4.4 온라인 로그아웃은 큐를 올린 뒤 토큰을 지우고 남은 0을 준다 [ASVS v5.0.0-7.4.4]', async () => {
  const order: string[] = [];
  const port: UploadPort = {
    async upload(batch) {
      order.push('upload');
      return { acceptedIds: batch.map((b) => String(b.id)), resyncRequired: false };
    },
  };
  const h = harness(port);
  await h.add(2);
  let cleared = 0;
  const r = await up().logoutAfterFlush({
    uploader: h.uploader,
    online: true,
    queue: h.queue,
    clearToken: async () => {
      cleared++;
      order.push('clearToken');
    },
    now: h.now,
    ...h.timerApi,
  });
  assert.deepEqual(r, { remaining: 0 });
  assert.equal(cleared, 1);
  assert.deepEqual(order, ['upload', 'clearToken']);
});

test('GAT-140 7.4.4 서버가 9,999ms에 답하면 남은 0이고, 답하지 않으면 10,000ms에 토큰을 지우고 남은 수를 준다(주입한 타이머) [ASVS v5.0.0-7.4.4]', async () => {
  // 9,999ms에 답한다
  const answer = deferred();
  const h = harness(new ScriptedPort([{ hang: answer.promise }]));
  await h.putOnly(2);
  let cleared = 0;
  const p = up().logoutAfterFlush({ uploader: h.uploader, online: true, queue: h.queue, clearToken: async () => void cleared++, now: h.now, ...h.timerApi });
  await settle();
  await h.advance(9_999);
  answer.resolve();
  assert.deepEqual(await p, { remaining: 0 });
  assert.equal(cleared, 1);

  // 답하지 않는다
  const never = new Promise<unknown>(() => {});
  const h2 = harness(new ScriptedPort([{ hang: never }]));
  await h2.putOnly(2);
  let cleared2 = 0;
  let done: { remaining: number } | undefined;
  void up()
    .logoutAfterFlush({ uploader: h2.uploader, online: true, queue: h2.queue, clearToken: async () => void cleared2++, now: h2.now, ...h2.timerApi })
    .then((r) => (done = r));
  await settle();
  await h2.advance(9_999);
  assert.equal(done, undefined, '9,999ms에는 아직 기다린다');
  assert.equal(cleared2, 0);
  await h2.advance(1);
  assert.deepEqual(done, { remaining: 2 }, '10,000ms에 끝난다');
  assert.equal(cleared2, 1);
});

test('GAT-140 7.4.4 로그아웃은 501건을 10초 안에 묶음 둘(500·1)로 모두 올리고 남은 0을 준다 [ASVS v5.0.0-7.4.4]', async () => {
  const port = new ScriptedPort();
  const h = harness(port);
  await h.putOnly(501);
  let cleared = 0;
  const r = await up().logoutAfterFlush({ uploader: h.uploader, online: true, queue: h.queue, clearToken: async () => void cleared++, now: h.now, ...h.timerApi });
  assert.deepEqual(r, { remaining: 0 });
  assert.deepEqual(port.calls.map((c) => c.ids.length), [500, 1]);
  assert.equal(cleared, 1);
});

test('GAT-140 flushNow 한 번은 그때 큐에 있는 501건을 500건씩 차례로(500·1) 모두 보낸다', async () => {
  const port = new ScriptedPort();
  const h = harness(port);
  await h.putOnly(501);
  const r = await h.uploader.flushNow();
  assert.deepEqual(r, { sent: 501, accepted: 501, deferred: 0, tokenCleared: false });
  assert.deepEqual(port.calls.map((c) => c.ids.length), [500, 1]);
  assert.equal(port.calls[1]!.ids[0], record(501, 0).id, '가장 늦은 기록이 둘째 묶음');
  assert.equal(await h.queue.count(), 0);
});

test('GAT-140 flushNow에서 한 묶음이 실패하면 거기서 멈추고 둘째 묶음을 보내지 않는다(남은 기록은 시도 수 그대로)', async () => {
  const port = new ScriptedPort([{ throws: new TypeError('fetch failed') }]);
  const h = harness(port);
  await h.putOnly(501);
  const r = await h.uploader.flushNow();
  assert.equal(port.calls.length, 1);
  assert.deepEqual(r, { sent: 500, accepted: 0, deferred: 500, tokenCleared: false });
  const rows = await rowsOf(h.queue);
  assert.equal(rows.length, 501);
  assert.equal(rows.filter((x) => x.attempts === 1).length, 500);
  assert.equal(rows.find((x) => x.id === record(501, 0).id)!.attempts, 0, '보내지 않은 기록');
});

test('GAT-140 겹친 flushNow 둘·5초 타이머는 진행 중인 보내기를 기다리고 같은 기록을 두 번 보내지 않는다', async () => {
  const hold = deferred();
  const port = new ScriptedPort([{ hang: hold.promise }]);
  const h = harness(port);
  await h.add(3);
  const p1 = h.uploader.flushNow();
  await settle();
  const p2 = h.uploader.flushNow();
  await h.advance(5_000); // 첫 기록의 5초 타이머도 이 사이에 돈다
  assert.equal(port.calls.length, 1, '보내는 중에는 다시 보내지 않는다');
  hold.resolve();
  await Promise.all([p1, p2]);
  await settle();
  const sentIds = port.calls.flatMap((c) => c.ids);
  assert.equal(sentIds.length, new Set(sentIds).size, `같은 ID를 두 번 보냈다: ${sentIds.join(',')}`);
  assert.equal(sentIds.length, 3);
  assert.equal(await h.queue.count(), 0);
});

test('GAT-140 7.4.4 오프라인 로그아웃은 보내지 않고 바로 토큰을 지우며 큐를 그대로 둔다 [ASVS v5.0.0-7.4.4]', async () => {
  const port = new ScriptedPort();
  const h = harness(port);
  await h.add(3);
  let cleared = 0;
  const r = await up().logoutAfterFlush({ uploader: h.uploader, online: false, queue: h.queue, clearToken: async () => void cleared++, now: h.now, ...h.timerApi });
  assert.deepEqual(r, { remaining: 3 });
  assert.equal(cleared, 1);
  assert.equal(port.calls.length, 0);
  assert.equal(await h.queue.count(), 3);
});
