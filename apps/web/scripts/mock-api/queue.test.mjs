// 가짜 API 대기열(ADR-0207·0208): 로비 참가·셔플 결과, 진입·묶음 결과·대기 상태 파일·입장 확정·대기 취소가 계약 Zod를 지나고, 상태 바꾸기대로 답하는지
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  CreateQueuePreVerificationBody,
  CreateQueuePreVerificationResponse,
  CreateQueueLobbyParticipantBody,
  CreateQueueLobbyParticipantResponse,
  GetQueueShuffleResultResponse,
  CreateQueueAdmissionBody,
  CreateQueueAdmissionResponse,
  CreateQueueEntryBody,
  CreateQueueEntryResponse,
  GetQueueBatchResultResponse,
  GetQueueSegmentStateResponse,
} from '@peaket/contracts/openapi/queue';
import { startMockApi } from '../mock-api.mjs';

const EVENT = '0b8f1f2e-4a1d-4c1e-9b5a-1f0a2b3c4e04';
const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

async function boot() {
  let clock = Date.parse('2026-11-05T11:00:00Z');
  const server = await startMockApi({ port: 0, now: () => clock });
  const base = `http://127.0.0.1:${server.address().port}`;
  const text = async (method, path, body) => {
    const r = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'text/plain;charset=UTF-8' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, retryAfter: r.headers.get('retry-after'), body: r.headers.get('content-type')?.includes('json') ? await r.json() : undefined };
  };
  const get = async (path) => {
    const r = await fetch(`${base}${path}`);
    return { status: r.status, body: r.headers.get('content-type')?.includes('json') ? await r.json() : undefined };
  };
  const state = (q) => fetch(`${base}/__mock/state?${q}`);
  return { server, base, text, get, state, tick: (ms) => (clock += ms), now: () => clock };
}

const enter = (m, body) => m.text('POST', `/v1/queues/${EVENT}/entries`, body);
const admit = (m, body) => m.text('POST', `/v1/queues/${EVENT}/admission`, body);
const file = (m, segment) => m.get(`/v1/queues/${EVENT}/segment-states/${segment}.json`);

test('진입 201 → 대기 상태 파일의 serving이 속도대로 나아가고, 차례가 오면 입장 확정이 ADMITTED다(계약 Zod 그대로)', async () => {
  const m = await boot();
  try {
    await m.state('queueReset=1&queueAhead=30&queueRate=2');
    const body = CreateQueueEntryBody.parse({ preverifyToken: 'pv-1', deviceId: 'dev-1', entryRequestId: '11111111-1111-4111-8111-111111111111' });
    const e = await enter(m, body);
    assert.equal(e.status, 201);
    assert.deepEqual(CreateQueueEntryResponse.parse(e.body), e.body);
    assert.equal(e.body.segment, Math.floor((e.body.seq - 1) / 1000));
    assert.equal(typeof e.body.serverTimeMs, 'number');
    // 같은 요청 ID로 다시 보내면 같은 대기표
    assert.equal((await enter(m, body)).body.queueTicket, e.body.queueTicket);
    const f0 = await file(m, e.body.segment);
    assert.equal(f0.status, 200);
    assert.deepEqual(GetQueueSegmentStateResponse.parse(f0.body), f0.body);
    assert.equal(e.body.seq - f0.body.serving - 1, 30, '앞 인원 30');
    assert.equal(Buffer.from(f0.body.removedBitmap, 'base64').length, 125);
    assert.equal(f0.body.generatedAtMs % 1000, 0, '매초 경계');
    // 차례 전 입장 확정은 NOT_YET(retryAfterMs)
    const early = await admit(m, CreateQueueAdmissionBody.parse({ queueTicket: e.body.queueTicket, firstEtaSec: 15, firstEtaAtMs: m.now() }));
    assert.deepEqual([early.status, early.body.status], [200, 'NOT_YET']);
    assert.ok(early.body.retryAfterMs >= 1000 && early.body.retryAfterMs <= 60_000);
    m.tick(16_000);
    const f1 = await file(m, e.body.segment);
    assert.ok(f1.body.serving >= e.body.seq, `serving ${f1.body.serving} ≥ ${e.body.seq}`);
    assert.ok(f1.body.generatedAtMs > f0.body.generatedAtMs);
    const ok = await admit(m, { queueTicket: e.body.queueTicket });
    assert.equal(ok.body.status, 'ADMITTED');
    assert.deepEqual(CreateQueueAdmissionResponse.parse(ok.body), ok.body);
    // 입장 토큰은 JWT 세 조각이고 본문에 jti·exp가 있다(좌석 화면의 서명기가 읽는다, ADR-0224)
    const claims = JSON.parse(Buffer.from(ok.body.admissionToken.split('.')[1], 'base64url').toString());
    assert.equal(ok.body.admissionToken.split('.').length, 3);
    assert.match(claims.jti, /^[A-Za-z0-9_-]{1,64}$/);
    assert.equal(typeof claims.exp, 'number');
    assert.match(ok.body.seatmapLayoutPath, /\/seatmap-layouts\/2\.json$/);
    assert.ok(ok.body.admissionToken && ok.body.purchaseSessionExpiresAt && ok.body.serverEcdhPublicKey?.kty === 'EC' && ok.body.seatmapLayoutPath);
    assert.equal((await admit(m, { queueTicket: e.body.queueTicket })).body.status, 'ADMITTED', '응답을 잃고 같은 대기표로 다시 보내면 ADMITTED를 다시 준다(queue-svc와 같다)');
    assert.match((await admit(m, { queueTicket: 'nope' })).body.type, /queue-ticket-invalid$/);
    assert.equal((await enter(m, { preverifyToken: 'x', extra: 1 })).status, 400, '정의 밖 칸');
  } finally {
    m.server.close();
  }
});

test('묶음 진입: 202 본문 → 공개 전 결과 파일 404 → 공개 뒤 {SHA-256(토큰): 순번} → 같은 요청 ID로 다시 진입하면 그 순번의 대기표', async () => {
  const m = await boot();
  try {
    await m.state('queueReset=1&queueEntry=batching');
    const token = 'pv-batch';
    const id = '22222222-2222-4222-8222-222222222222';
    const b = await enter(m, { preverifyToken: token, deviceId: 'dev-2', entryRequestId: id });
    assert.equal(b.status, 202);
    assert.equal(b.body.entryRequestId, id);
    assert.equal(b.body.resultPath, `/v1/queues/${EVENT}/batch-results/${sha(token).slice(0, 3)}.json`);
    assert.ok(Date.parse(b.body.resultAt) > m.now());
    assert.ok(Number.isInteger(b.body.spreadSec) && b.body.spreadSec > 0);
    assert.equal((await m.get(b.body.resultPath)).status, 404, '공개 전');
    assert.equal((await enter(m, { preverifyToken: token, entryRequestId: id })).status, 202, '공개 전 다시 진입은 202');
    m.tick(Date.parse(b.body.resultAt) - m.now() + 1);
    const r = await m.get(b.body.resultPath);
    assert.equal(r.status, 200);
    GetQueueBatchResultResponse.parse(r.body);
    const seq = r.body[sha(token)];
    assert.ok(seq >= 1);
    const t = await enter(m, { preverifyToken: token, entryRequestId: id });
    assert.deepEqual([t.status, t.body.seq], [201, seq]);
  } finally {
    m.server.close();
  }
});

test('상태 바꾸기: 판매 상태·진입 오류·입장 확정 오류가 계약의 problem type과 Retry-After로 나온다', async () => {
  const m = await boot();
  try {
    await m.state('queueReset=1');
    const t = (await enter(m, { preverifyToken: 'pv-3', entryRequestId: '33333333-3333-4333-8333-333333333333' })).body;
    for (const [q, sale, rate0] of [['paused', 'PAUSED', true], ['all-held', 'ALL_HELD', true], ['sold-out', 'SOLD_OUT', true], ['ended', 'ENDED', true], ['on-sale', 'ON_SALE', false]]) {
      await m.state(`queue=${q}`);
      m.tick(1000);
      const f = (await file(m, t.segment)).body;
      assert.equal(f.saleStatus, sale, q);
      assert.equal(f.servingRate === 0, rate0, `${q} 속도`);
    }
    await m.state('queueSoldOutTiers=tier-r,tier-s');
    m.tick(1000);
    assert.deepEqual((await file(m, t.segment)).body.soldOutTiers, ['tier-r', 'tier-s']);
    await m.state('queueSoldOutTiers=');
    await m.state('queueBanner=점검 안내&queueSeats=1');
    m.tick(1000);
    const f = (await file(m, t.segment)).body;
    assert.deepEqual([f.banner, f.remainingSeats, typeof f.avgTicketsPerOrder], ['점검 안내', 1, 'number']);
    const fresh = async (mode, i) => {
      await m.state(`queueEntry=${mode}`);
      return enter(m, { preverifyToken: `pv-${mode}`, entryRequestId: `44444444-4444-4444-8444-44444444444${i}` });
    };
    const busy = await fresh('busy', 1);
    assert.deepEqual([busy.status, busy.retryAfter], [429, '2']);
    const down = await fresh('down', 2);
    assert.deepEqual([down.status, down.retryAfter], [503, '1']);
    assert.match((await fresh('other-device', 3)).body.type, /already-waiting$/);
    assert.match((await fresh('already-admitted', 4)).body.type, /already-admitted$/);
    assert.match((await fresh('not-open', 5)).body.type, /queue-not-open$/);
    assert.match((await fresh('preverify-invalid', 6)).body.type, /preverify-invalid$/);
    assert.match((await fresh('sold-out', 7)).body.type, /sold-out$/);
    assert.match((await fresh('ended', 8)).body.type, /sale-ended$/);
    assert.equal((await fresh('verify', 9)).body.verification, 'REQUIRED');
    await m.state('queueEntry=normal&queueReset=1&queueAhead=0');
    const t2 = (await enter(m, { preverifyToken: 'pv-5', entryRequestId: '55555555-5555-4555-8555-555555555555' })).body;
    m.tick(1000); // 앞 인원 0이면 serving이 한 번호 더 나아가야 차례다
    const tries = { soon: [200, 'SOON'], verifying: [200, 'VERIFYING'], restricted: [403, 'booking-restricted'], unauthorized: [401, undefined], duplicate: [409, 'duplicate-admission'], expired: [410, 'queue-ticket-expired'], removed: [410, 'queue-ticket-removed'], 'sold-out': [410, 'sold-out'], ended: [410, 'sale-ended'], down: [503, 'dependency-unavailable'] };
    for (const [mode, [status, kind]] of Object.entries(tries)) {
      await m.state(`queueAdmit=${mode}`);
      const a = await admit(m, { queueTicket: t2.queueTicket });
      assert.equal(a.status, status, mode);
      if (status === 200) assert.equal(a.body.status, kind, mode);
      else if (kind) assert.match(a.body.type, new RegExp(`${kind}$`), mode);
      if (mode === 'soon') assert.ok(a.body.retryAfterSeconds >= 1 && a.body.retryAfterSeconds <= 5);
    }
    await m.state('queueAdmit=expired-final');
    assert.equal((await admit(m, { queueTicket: t2.queueTicket })).body.rejoinAllowed, false);
    await m.state('queueAdmit=expired');
    assert.equal((await admit(m, { queueTicket: t2.queueTicket })).body.rejoinAllowed, true);
    // 대기 취소
    const del = await fetch(`${m.base}/v1/queues/${EVENT}/entries/me`, { method: 'DELETE' });
    assert.equal(del.status, 204);
    assert.equal((await file(m, 999)).status, 404, '마지막 구간 뒤 100구간보다 먼 파일');
  } finally {
    m.server.close();
  }
});

test('대기실 개발 출처에도 자격 증명 포함 CORS를 연다(text/plain 진입은 사전 요청이 없다)', async () => {
  const m = await boot();
  try {
    const r = await fetch(`${m.base}/v1/queues/${EVENT}/entries`, { method: 'POST', headers: { origin: 'http://localhost:3004', 'content-type': 'text/plain;charset=UTF-8' }, body: JSON.stringify({ preverifyToken: 'pv-cors' }) });
    assert.equal(r.headers.get('access-control-allow-origin'), 'http://localhost:3004');
    assert.equal(r.headers.get('access-control-allow-credentials'), 'true');
  } finally {
    m.server.close();
  }
});

const json = (m, method, path, body) =>
  fetch(`${m.base}${path}`, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }).then(async (r) => ({
    status: r.status,
    body: r.headers.get('content-type')?.includes('json') ? await r.json() : undefined,
  }));
const join = (m, body = { humanCheckToken: 'sim.lobby.1', deviceId: 'dev-l' }) => json(m, 'POST', `/v1/queues/${EVENT}/lobby-participants`, CreateQueueLobbyParticipantBody.parse(body));

test('로비(ADR-0208): queueOpenIn으로 오픈 전 회차 → 참가 201(계약 Zod) → 두 번째는 409 → 오픈 + 3초에 셔플 결과 게시 → 참가 토큰으로 입장 확정', async () => {
  const m = await boot();
  try {
    await m.state('queueReset=1&queueOpenIn=300&queueAhead=10&queueRate=5');
    const d = await m.get(`/v1/events/${EVENT}`);
    const openAt = Date.parse(d.body.openAt);
    assert.equal(openAt, m.now() + 300_000);
    assert.equal(Date.parse(d.body.lobbyOpensAt), openAt - 10 * 60_000);
    const j = await join(m);
    assert.equal(j.status, 201);
    assert.deepEqual(CreateQueueLobbyParticipantResponse.parse(j.body), j.body);
    assert.equal(Date.parse(j.body.shuffleResultAt), openAt + 3000);
    assert.equal(j.body.seedHash.length, 64);
    assert.equal((await join(m)).status, 409, 'pid당 1장');
    const prefix = sha(j.body.lobbyToken).slice(0, 3);
    m.tick(300_000 + 2000);
    assert.equal((await m.get(`/v1/queues/${EVENT}/shuffle-results/${prefix}.json`)).status, 404, '게시 전');
    assert.equal((await join(m)).status, 409, '오픈 뒤에는 로비가 닫힌다');
    m.tick(1000);
    const r = await m.get(`/v1/queues/${EVENT}/shuffle-results/${prefix}.json`);
    assert.equal(r.status, 200);
    GetQueueShuffleResultResponse.parse(r.body);
    const seq = r.body[sha(j.body.lobbyToken)];
    assert.ok(seq >= 1);
    const f = await file(m, Math.floor((seq - 1) / 1000));
    assert.equal(seq - f.body.serving - 1, 10 - 15, '오픈 뒤 3초 동안 5 × 3 = 15번 나아갔다(앞 인원이 음수면 차례)');
    const ok = await admit(m, CreateQueueAdmissionBody.parse({ lobbyToken: j.body.lobbyToken }));
    assert.equal(ok.body.status, 'ADMITTED');
    assert.equal((await admit(m, { lobbyToken: j.body.lobbyToken, queueTicket: 'x' })).status, 400, '둘 중 하나만');
  } finally {
    m.server.close();
  }
});

test('로비 상태 바꾸기: 본인확인 전 403·사람 확인 실패 428·혼잡 429(한 번)·다른 기기 409(로비 취소 뒤 지나감)·고위험 REQUIRED, 취소한 참가 토큰은 410 queue-ticket-removed, missing이면 셔플 파일에 내 토큰이 없다', async () => {
  const m = await boot();
  try {
    await m.state('queueReset=1&queueOpenIn=120');
    for (const [mode, status, type] of [['identity', 403, /identity-verification-required$/], ['human-fail', 428, /human-check-required$/], ['unauthorized', 401, /about:blank/]]) {
      await m.state(`queueLobby=${mode}`);
      const r = await join(m);
      assert.equal(r.status, status, mode);
      assert.match(r.body.type, type);
    }
    await m.state('queueLobby=busy');
    assert.equal((await join(m, { humanCheckToken: 'busy-1' })).status, 429);
    assert.equal((await join(m, { humanCheckToken: 'busy-1' })).status, 201, '같은 토큰으로 다시 보내면 지나간다');
    assert.equal((await json(m, 'DELETE', `/v1/queues/${EVENT}/lobby-participants/me`)).status, 204);
    await m.state('queueLobby=other-device');
    assert.equal((await join(m)).status, 409);
    assert.equal((await json(m, 'DELETE', `/v1/queues/${EVENT}/lobby-participants/me`)).status, 204, '다른 기기의 참가 토큰을 취소한다');
    const fresh = await join(m);
    assert.equal(fresh.status, 201, '로비 참가 취소 뒤에는 다시 참가한다');
    assert.equal((await json(m, 'DELETE', `/v1/queues/${EVENT}/lobby-participants/me`)).status, 204);
    m.tick(120_000 + 5000);
    assert.match((await admit(m, { lobbyToken: fresh.body.lobbyToken })).body.type, /queue-ticket-removed$/);
    await m.state('queueReset=1&queueOpenIn=60&queueLobby=verify&queueShuffle=missing');
    const v = await join(m);
    assert.deepEqual([v.status, v.body.verification], [201, 'REQUIRED']);
    m.tick(60_000 + 3000);
    const r = await m.get(`/v1/queues/${EVENT}/shuffle-results/${sha(v.body.lobbyToken).slice(0, 3)}.json`);
    assert.equal(r.status, 200);
    assert.equal(r.body[sha(v.body.lobbyToken)], undefined);
  } finally {
    m.server.close();
  }
});

test('사전 검증(ADR-0211): 계약 Zod 본문 → 201(15분), 갱신이면 최초 발급 시각을 잇고, 상태 바꾸기대로 403·404·428·503(한 번)·401', async () => {
  const m = await boot();
  try {
    await m.state('queueReset=1&queuePreverify=normal');
    const body = CreateQueuePreVerificationBody.parse({ humanCheckToken: 'sim.preverify.1', deviceId: 'dev-p', behaviorSummary: { v: 1, windowMs: 1200, pointerMoves: 3, pointerEntropy: 1.5, scrollEvents: 0, scrollDistancePx: 0 } });
    const r = await json(m, 'POST', `/v1/queues/${EVENT}/pre-verifications`, body);
    assert.equal(r.status, 201);
    assert.deepEqual(CreateQueuePreVerificationResponse.parse(r.body), r.body);
    assert.equal(Date.parse(r.body.expiresAt), m.now() + 15 * 60_000);
    m.tick(60_000);
    const again = await json(m, 'POST', `/v1/queues/${EVENT}/pre-verifications`, { humanCheckToken: 'sim.preverify.2', preverifyToken: r.body.preverifyToken });
    assert.equal(again.body.preverifyToken.split('.')[1], r.body.preverifyToken.split('.')[1], '갱신은 최초 발급 시각을 잇는다');
    assert.equal((await json(m, 'POST', `/v1/queues/${EVENT}/pre-verifications`, { humanCheckToken: 'x', extra: 1 })).status, 400);
    assert.equal((await json(m, 'POST', `/v1/queues/${EVENT}/pre-verifications`, { humanCheckToken: 'x', behaviorSummary: { v: 2, windowMs: 0 } })).status, 400);
    assert.equal((await json(m, 'POST', `/v1/queues/${EVENT}/pre-verifications`, { deviceId: 'no-human' })).status, 201, '사람 확인 토큰은 계약에서 선택이다');
    for (const [mode, status, type] of [['identity', 403, /identity-verification-required$/], ['not-found', 404, /queue-not-found$/], ['unauthorized', 401, /about:blank/]]) {
      await m.state(`queuePreverify=${mode}`);
      const x = await json(m, 'POST', `/v1/queues/${EVENT}/pre-verifications`, { humanCheckToken: 'h' });
      assert.equal(x.status, status, mode);
      assert.match(x.body.type, type);
    }
    await m.state('queuePreverify=down');
    const down = await fetch(`${m.base}/v1/queues/${EVENT}/pre-verifications`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ humanCheckToken: 'd1' }) });
    assert.deepEqual([down.status, down.headers.get('retry-after')], [503, '3']);
    assert.equal((await json(m, 'POST', `/v1/queues/${EVENT}/pre-verifications`, { humanCheckToken: 'd2' })).status, 201, '회차마다 한 번(새 사람 확인 토큰으로 다시 보내면 지나간다)');
    assert.equal((await json(m, 'POST', `/v1/queues/nope-event/pre-verifications`, { humanCheckToken: 'x' })).status, 404, '모르는 회차');
  } finally {
    m.server.close();
  }
});

test('검사 기록(ADR-0217): 받은 요청을 메서드·경로·출처·시각으로 남기고(CORS 사전 요청 OPTIONS 포함) logReset으로 비운다', async () => {
  const m = await boot();
  try {
    await m.state('logReset=1');
    await fetch(`${m.base}/v1/queues/${EVENT}/entries`, { method: 'OPTIONS', headers: { origin: 'http://localhost:3004', 'access-control-request-method': 'POST' } });
    await enter(m, { preverifyToken: 'pv' });
    const log = await (await fetch(`${m.base}/__mock/requests`)).json();
    const mine = log.items.filter((x) => x.path === `/v1/queues/${EVENT}/entries`);
    assert.deepEqual(mine.map((x) => x.m), ['OPTIONS', 'POST']);
    assert.equal(mine[0].origin, 'http://localhost:3004');
    assert.equal(typeof mine[1].at, 'number');
    assert.ok(!log.items.some((x) => x.path.startsWith('/__mock/')), '검사 경로는 남기지 않는다');
    await m.state('logReset=1');
    assert.deepEqual((await (await fetch(`${m.base}/__mock/requests`)).json()).items, []);
  } finally {
    m.server.close();
  }
});

test('진입 멈춤(queueEntry=hang, ADR-0217): 답하지 않고, 손님이 끊으면 끊은 시각을 기록한다(FE-T15 브라우저 시간 초과 확인)', async () => {
  const m = await boot();
  try {
    await m.state('queueEntry=hang&logReset=1');
    const started = Date.now();
    await assert.rejects(fetch(`${m.base}/v1/queues/${EVENT}/entries`, { method: 'POST', headers: { 'content-type': 'text/plain;charset=UTF-8' }, body: JSON.stringify({ preverifyToken: 'pv' }), signal: AbortSignal.timeout(300) }));
    await new Promise((r) => setTimeout(r, 100));
    const log = (await (await fetch(`${m.base}/__mock/requests`)).json()).items;
    const e = log.find((x) => x.m === 'POST');
    assert.ok(e && typeof e.abortedAt === 'number', JSON.stringify(log));
    assert.ok(e.abortedAt - started >= 250 && e.abortedAt - started < 2000, `${e.abortedAt - started}ms`);
  } finally {
    m.server.close();
  }
});

test('200 대기 상태 파일의 Retry-After(queueStateRetryAfter, ADR-0217): 브라우저가 무시해야 하는 머리를 싣는다(FE-T4)', async () => {
  const m = await boot();
  try {
    const r = await enter(m, { preverifyToken: 'pv' });
    await m.state('queueStateRetryAfter=30');
    const f = await fetch(`${m.base}/v1/queues/${EVENT}/segment-states/${r.body.segment}.json`);
    assert.equal(f.status, 200);
    assert.equal(f.headers.get('retry-after'), '30');
    await m.state('queueStateRetryAfter=');
    assert.equal((await fetch(`${m.base}/v1/queues/${EVENT}/segment-states/${r.body.segment}.json`)).headers.get('retry-after'), null);
  } finally {
    m.server.close();
  }
});
