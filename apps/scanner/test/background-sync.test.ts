// F-05-10 Background Sync 예비 업로드·서비스 워커 업로드 시험(계획 docs/review/plans/F-05-10.md §3·§5).
// 정본: docs/features/offline-gate.md §6.5(일회성 Background Sync는 예비, 500건 묶음, 실패는 큐를 지우지 않는다),
// §9(화면이 다시 켜지면 앱이 남은 큐를 바로 올린다), O-T11, O-T37 ⑧(서비스 워커 업로드도 같은 기기 키 DPoP).
// 가짜 시계·가짜 포트를 쓰고 고정 대기하지 않는다. 큐는 진짜 메모리 큐다.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateDpopKey } from '../src/api/dpop.ts';
import { MemoryScanQueue, type ScanQueueRecord } from '../src/storage/scan-queue.ts';

type UploadPort = { upload(batch: unknown[], o: { withToken: boolean }): Promise<{ acceptedIds: string[]; resyncRequired: boolean }> };
type BackgroundModule = {
  BACKGROUND_SYNC_TAG: string;
  shouldRegisterBackgroundSync(i: { pending: number; failed: boolean; hasRegistration: boolean; stopped?: 'device-revoked' | 'device-unregistered' }): boolean;
  BackgroundSyncGuard: new (o: { register(tag: string): Promise<void> }) => {
    onFailure(i: { pending: number; failed: boolean; stopped?: 'device-revoked' | 'device-unregistered' }): Promise<boolean>;
    reset(): void;
  };
  runBackgroundUpload(i: { queue: MemoryScanQueue; port: UploadPort; maxBatches?: number; nowMs?: number }): Promise<{
    sent: number;
    accepted: number;
    remaining: number;
  }>;
  createServiceWorkerUploader(i: {
    queue: MemoryScanQueue;
    origin: string;
    key?: Awaited<ReturnType<typeof generateDpopKey>>;
    loadKey?: () => Promise<Awaited<ReturnType<typeof generateDpopKey>> | undefined>;
    loadClockOffsetMs?: () => Promise<number | undefined>;
    fetch?: typeof fetch;
    now?: () => number;
  }): UploadPort;
};

const MODULE = '../src/sync/background-sync.ts';
const loaded = (await import(MODULE).catch(() => ({}))) as Partial<BackgroundModule>;
function bg(): BackgroundModule {
  for (const name of ['shouldRegisterBackgroundSync', 'BackgroundSyncGuard', 'runBackgroundUpload', 'createServiceWorkerUploader'] as const) {
    assert.equal(typeof loaded[name], 'function', `${MODULE}의 ${name}가 없다`);
  }
  assert.equal(typeof loaded.BACKGROUND_SYNC_TAG, 'string');
  return loaded as BackgroundModule;
}

const EVENT = '0190f3a1-7c2e-7a00-8000-0000000f5481';
const T0 = Date.parse('2026-11-26T10:00:00.000Z');

function record(n: number): ScanQueueRecord {
  const id = `0190f3a1-7c2e-7f00-8000-${String(n).padStart(12, '0')}`;
  const body = {
    id,
    eventId: EVENT,
    ticketId: `0190f3a1-7c2e-7a00-8b2a-${String(n).padStart(12, '0')}`,
    scannerSessionId: '0190f3a1-7c2e-7a00-8000-0000000f5483',
    direction: 'IN',
    method: 'QR',
    result: 'PASS',
    gateZone: '동문',
    scannedAtDevice: new Date(T0).toISOString(),
    knownSeq: 10,
    deviceSeq: n,
  };
  return { id, eventId: EVENT, ticketId: body.ticketId, keyId: 'ldN7EyqkmYs', scannedAtMs: T0, payload: JSON.stringify(body), attempts: 0, nextAttemptAtMs: 0 };
}

async function fill(queue: MemoryScanQueue, n: number): Promise<void> {
  for (let i = 1; i <= n; i++) await queue.put(record(i));
}

class ScriptedPort implements UploadPort {
  readonly calls: { ids: string[]; withToken: boolean }[] = [];
  readonly replies: ({ throws: unknown } | { acceptedIds?: string[] })[] = [];
  constructor(replies: ({ throws: unknown } | { acceptedIds?: string[] })[] = []) {
    this.replies = replies;
  }
  async upload(batch: unknown[], o: { withToken: boolean }) {
    const ids = batch.map((b) => String((b as { id: string }).id));
    this.calls.push({ ids, withToken: o.withToken });
    const reply = this.replies.shift();
    if (reply && 'throws' in reply) throw reply.throws;
    return { acceptedIds: reply && 'acceptedIds' in reply ? (reply.acceptedIds ?? ids) : ids, resyncRequired: false };
  }
}

test('O-T11 업로드가 실패하면 일회성 Background Sync를 예비로 등록하고, 같은 실패에 거듭 등록하지 않는다', async () => {
  const b = bg();
  assert.equal(b.BACKGROUND_SYNC_TAG, 'peaket-scanner-scans');
  assert.equal(b.shouldRegisterBackgroundSync({ pending: 3, failed: true, hasRegistration: true }), true);
  assert.equal(b.shouldRegisterBackgroundSync({ pending: 0, failed: true, hasRegistration: true }), false);
  assert.equal(b.shouldRegisterBackgroundSync({ pending: 3, failed: false, hasRegistration: true }), false);
  assert.equal(b.shouldRegisterBackgroundSync({ pending: 3, failed: true, hasRegistration: false }), false);
  assert.equal(b.shouldRegisterBackgroundSync({ pending: 3, failed: true, hasRegistration: true, stopped: 'device-revoked' }), false);
  assert.equal(b.shouldRegisterBackgroundSync({ pending: 3, failed: true, hasRegistration: true, stopped: 'device-unregistered' }), false);

  let attempts = 0;
  let calls = 0;
  let fail = false;
  const guard = new b.BackgroundSyncGuard({
    register: async (tag) => {
      assert.equal(tag, b.BACKGROUND_SYNC_TAG);
      attempts += 1;
      if (fail) throw new Error('동기화 등록이 막혔다');
      calls += 1;
    },
  });
  assert.equal(await guard.onFailure({ pending: 2, failed: true }), true);
  assert.equal(await guard.onFailure({ pending: 2, failed: true }), false, '같은 실패에 두 번 등록하지 않는다');
  assert.equal(calls, 1);
  assert.equal(attempts, 1, '성공한 등록은 한 번만 부른다');
  assert.equal(await guard.onFailure({ pending: 0, failed: false }), false, '성공하면 등록 표시를 푼다');
  assert.equal(await guard.onFailure({ pending: 1, failed: true }), true, '다음 실패에는 다시 등록한다');
  assert.equal(calls, 2);
  assert.equal(attempts, 2);
  fail = true;
  guard.reset();
  assert.equal(await guard.onFailure({ pending: 1, failed: true }), false, '등록 실패는 던지지 않고 false다');
  assert.equal(attempts, 3, '실패한 등록은 등록 표시를 남기지 않는다');
  // 같은 실패가 이어져도 다음 onFailure는 다시 시도한다(시도는 늘고 성공은 아니다)
  assert.equal(await guard.onFailure({ pending: 1, failed: true }), false, '같은 실패가 이어지면 false다');
  assert.equal(calls, 2);
  assert.equal(attempts, 4, '실패한 등록은 다음 기회에 다시 시도한다');
  fail = false;
  assert.equal(await guard.onFailure({ pending: 1, failed: true }), true, '다음 기회에 성공하면 true다');
  assert.equal(calls, 3);
  assert.equal(attempts, 5);
});

test('O-T11 Background Sync가 3번 시도하고 포기해도 화면이 다시 켜지면 남은 큐를 바로 올린다', async () => {
  const b = bg();
  const queue = new MemoryScanQueue();
  await fill(queue, 501);
  const failing = new ScriptedPort([{ throws: new Error('연결 끊김') }, { throws: new Error('연결 끊김') }, { throws: new Error('연결 끊김') }]);
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await b.runBackgroundUpload({ queue, port: failing, nowMs: 1 });
    assert.deepEqual(r, { sent: 0, accepted: 0, remaining: 501, resyncRequired: false }, '브라우저가 포기해도 기록을 지우지 않는다');
  }
  assert.equal(await queue.count(), 501);

  // 화면이 다시 켜져 앱이 부르는 경로(성공)는 남은 기록을 500건씩 올린다
  const ok = new ScriptedPort();
  const resumed = await b.runBackgroundUpload({ queue, port: ok, nowMs: 1 });
  assert.deepEqual(resumed, { sent: 501, accepted: 501, remaining: 0, resyncRequired: false });
  assert.deepEqual(ok.calls.map((c) => c.ids.length), [500, 1]);
  assert.equal(await queue.count(), 0);
});

test('O-T11 acceptedIds만 큐에서 지운다: 받지 않은 기록은 남기고 다음 동기화에 다시 올린다', async () => {
  const b = bg();
  const queue = new MemoryScanQueue();
  const rows = [record(1), record(2), record(3)];
  for (const row of rows) await queue.put(row);
  const port = new ScriptedPort([{ acceptedIds: [rows[0].id, rows[2].id] }]);
  const first = await b.runBackgroundUpload({ queue, port, nowMs: 1 });
  assert.deepEqual(first, { sent: 3, accepted: 2, remaining: 1, resyncRequired: false });
  assert.equal(await queue.count(), 1);
  assert.deepEqual((await queue.due(1, 10)).map((r) => r.id), [rows[1].id], '받지 않은 기록만 남는다');

  const again = new ScriptedPort();
  const second = await b.runBackgroundUpload({ queue, port: again, nowMs: 1 });
  assert.deepEqual(second, { sent: 1, accepted: 1, remaining: 0, resyncRequired: false });
  assert.deepEqual(again.calls.map((c) => c.ids), [[rows[1].id]]);
  assert.equal(await queue.count(), 0);
});

test('O-T11 resyncRequired와 403 stopped를 결과로 돌려주고 받지 않은 기록은 남긴다', async () => {
  const b = bg();
  const queue = new MemoryScanQueue();
  await fill(queue, 2);
  // ScriptedPort는 resyncRequired를 돌려주지 않으므로 직접 포트를 만든다
  const resyncPort: UploadPort = {
    upload: async (batch) => ({ acceptedIds: [String((batch[0] as { id: string }).id)], resyncRequired: true }),
  };
  const r1 = await b.runBackgroundUpload({ queue, port: resyncPort, nowMs: 1 });
  assert.equal(r1.resyncRequired, true);
  assert.equal(r1.remaining, 1);
  assert.equal(await queue.count(), 1);

  const stoppedPort: UploadPort = {
    upload: async () => {
      const e = new Error('기기 폐기') as Error & { status: number; type: string };
      e.status = 403;
      e.type = 'device-revoked';
      throw e;
    },
  };
  const r2 = await b.runBackgroundUpload({ queue, port: stoppedPort, nowMs: 1 });
  assert.equal(r2.stopped, 'device-revoked');
  assert.equal(await queue.count(), 1, '폐기 기기도 기록은 남긴다');
});

test('O-T11 폐기된 기기(403)에서는 Background Sync를 등록하지 않고 기록을 남긴다', async () => {
  const b = bg();
  assert.equal(b.shouldRegisterBackgroundSync({ pending: 5, failed: true, hasRegistration: true, stopped: 'device-revoked' }), false);
  const queue = new MemoryScanQueue();
  await fill(queue, 2);
  const port = new ScriptedPort([{ throws: Object.assign(new Error('기기 폐기'), { status: 403, type: 'device-revoked' }) }]);
  const r = await b.runBackgroundUpload({ queue, port, nowMs: 1 });
  assert.deepEqual(r, { sent: 0, accepted: 0, remaining: 2, resyncRequired: false, stopped: 'device-revoked' });
  assert.equal(await queue.count(), 2, '폐기 기기도 기록은 남긴다');
});

test('GAT-140 O-T37 ⑧ 서비스 워커 업로드는 화면과 같은 기기 키로 DPoP 증명을 만들고 토큰 없이 올린다', async () => {
  const b = bg();
  const queue = new MemoryScanQueue();
  await fill(queue, 2);
  const key = await generateDpopKey();
  const origin = 'https://scanner-api.peaket.example';
  const requests: { url: string; headers: Record<string, string>; body: unknown }[] = [];
  const fakeFetch = (async (url: string, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    requests.push({ url: String(url), headers, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const body = init?.body ? (JSON.parse(String(init.body)) as { id: string }[]) : [];
    return new Response(JSON.stringify({ acceptedIds: body.map((x) => x.id), resyncRequired: false, staleIds: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  const uploader = b.createServiceWorkerUploader({ queue, origin, key, fetch: fakeFetch, now: () => T0 + 1_000 });
  const r = await b.runBackgroundUpload({ queue, port: uploader, nowMs: 1 });
  assert.deepEqual(r, { sent: 2, accepted: 2, remaining: 0, resyncRequired: false });
  assert.equal(requests.length, 1);
  const req = requests[0];
  assert.equal(req.url, `${origin}/v1/scanner/scans`);
  assert.equal(req.headers.authorization, undefined, '서비스 워커에는 스태프 토큰이 없다');
  assert.equal(typeof req.headers.dpop, 'string');
  assert.equal((req.body as unknown[]).length, 2);

  const [header, payload] = req.headers.dpop.split('.');
  const headerJson = JSON.parse(Buffer.from(header, 'base64url').toString('utf8')) as { typ: string; jwk: { x: string; y: string } };
  const payloadJson = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
  assert.equal(headerJson.typ, 'dpop+jwt');
  assert.equal(headerJson.jwk.x, key.publicJwk.x, '화면과 같은 기기 키로 증명을 만든다');
  assert.equal(headerJson.jwk.y, key.publicJwk.y);
  assert.equal(payloadJson.htm, 'POST');
  assert.equal(payloadJson.htu, `${origin}/v1/scanner/scans`);
  assert.equal('ath' in payloadJson, false, '토큰이 없으면 ath도 없다');
});

test('GAT-140 O-T37 ⑧ 서비스 워커는 화면과 같은 저장소에서 기기 키를 읽어 업로드한다', async () => {
  const b = bg();
  const queue = new MemoryScanQueue();
  await fill(queue, 1);
  const key = await generateDpopKey();
  const origin = 'https://scanner-api.peaket.example';
  let loaded = 0;
  const headers: Record<string, string>[] = [];
  const fakeFetch = (async (_url: string, init?: RequestInit) => {
    headers.push((init?.headers ?? {}) as Record<string, string>);
    const body = init?.body ? (JSON.parse(String(init.body)) as { id: string }[]) : [];
    return new Response(JSON.stringify({ acceptedIds: body.map((x) => x.id), resyncRequired: false, staleIds: [] }), { status: 200 });
  }) as typeof fetch;
  const uploader = b.createServiceWorkerUploader({
    queue,
    origin,
    loadKey: async () => {
      loaded += 1;
      return key;
    },
    fetch: fakeFetch,
    now: () => T0,
  });
  const r = await b.runBackgroundUpload({ queue, port: uploader, nowMs: 1 });
  assert.deepEqual(r, { sent: 1, accepted: 1, remaining: 0, resyncRequired: false });
  assert.equal(loaded, 1, '키를 넘기지 않으면 저장소에서 한 번 읽는다');
  const [, payload] = headers[0].dpop.split('.');
  const payloadJson = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { htu: string };
  assert.equal(payloadJson.htu, `${origin}/v1/scanner/scans`);
});

test('GAT-140 IR-07 서비스 워커 DPoP iat는 저장한 시계 오차를 더한다', async () => {
  const b = bg();
  const queue = new MemoryScanQueue();
  await fill(queue, 1);
  const key = await generateDpopKey();
  const origin = 'https://scanner-api.peaket.example';
  let proof = '';
  const fakeFetch = (async (_url: string, init?: RequestInit) => {
    proof = String((init?.headers as Record<string, string>).dpop);
    return new Response(JSON.stringify({ acceptedIds: [record(1).id], resyncRequired: false, staleIds: [] }), { status: 200 });
  }) as typeof fetch;
  const uploader = b.createServiceWorkerUploader({
    queue,
    origin,
    key,
    loadClockOffsetMs: async () => 120_000,
    fetch: fakeFetch,
    now: () => T0,
  });
  await b.runBackgroundUpload({ queue, port: uploader, nowMs: 1 });
  const [, payload] = proof.split('.');
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { iat: number };
  assert.equal(claims.iat, Math.floor((T0 + 120_000) / 1000), '기기 시계 대신 보정 시각으로 iat를 만든다');
});
