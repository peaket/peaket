// realtime-gw 통합 시험: 실제 Valkey 컨테이너와 start()로 띄운 서비스에 WebSocket 클라이언트로 붙는다(BUILD_ORDER HOT-090, BAT-052).
// 정본: docs/features/seat-hold.md §7 'realtime-gw의 첫 구현'(핸드셰이크·받는 프레임 검사·좌석 Redis 구독·묶음·느린 연결과 내릴 때·지표와 로그),
// §12 S-T31 ①②③④·S-T42 ①②③⑤⑧⑪⑫⑭~⑯⑱·S-T12 ②·S-T14 ①(§7 '자동 전환의 첫 구현', ADR-0298, BAT-053), docs/frontend.md §4.4.1(닫힘 이유 글 포함), docs/data.md §3 `s:{event:E}:sec:{section}` 행, docs/observability.md §7 ts,
// ADR-0297(리뷰 반영 RF-T1·T4·T6·T7·T8·T11·T13). 시험이 쓰는 좌석 채널 메시지는 시험이 직접 SPUBLISH한 것뿐이다(환불 Lua의 changedAtMs에 기대지 않는다, 감독 지시).
// docs/security/asvs/seat-hold.md. 묶음은 화면과 같은 해독기(@peaket/seatmap decodeFrame)로 읽는다.
import { request as httpRequest } from 'node:http';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { createClient } from 'redis';
import { LogPseudonymizer } from '@peaket/platform';
import {
  admissionToken,
  AUTH,
  channelOf,
  type Client,
  connect,
  type DeltaFrame,
  deltaText,
  entriesOf,
  handshake,
  isBatchInterval,
  isDelta,
  isHeartbeat,
  ISS,
  K_OTHER,
  layoutDir,
  metricValue,
  ORIGIN,
  PSEUDONYM_KEY,
  rawRedisReply,
  rawSocketOf,
  type Running,
  SEATS,
  serviceEnv,
  sleep,
  startRelay,
  startService,
  streamPath,
  subscribeBytes,
  timeSyncBytes,
  until,
} from './support.js';
import { startValkey, type ValkeyContainer } from './valkey.js';

let valkey: ValkeyContainer;
let layout: ReturnType<typeof layoutDir>;
let svc: Running;
let redis: ReturnType<typeof createClient>;
const clients: Client[] = [];

const open = async (eventId = 'ev-1', o: Parameters<typeof connect>[1] = {}): Promise<Client> => {
  const c = connect(svc.url(streamPath(eventId)), { token: admissionToken({ eventId }), ...o });
  clients.push(c);
  await c.opened;
  await c.next(isBatchInterval);
  return c;
};
const shardSubs = async (channel: string): Promise<number> => {
  const r = (await redis.sendCommand(['PUBSUB', 'SHARDNUMSUB', channel])) as unknown[];
  return Number(r[1]);
};
const cmdCalls = async (cmd: string): Promise<number> => {
  const info = String(await redis.sendCommand(['INFO', 'commandstats']));
  const m = new RegExp(`cmdstat_${cmd}:calls=(\\d+)`).exec(info);
  return m ? Number(m[1]) : 0;
};
const spublish = (channel: string, text: string) => redis.sendCommand(['SPUBLISH', channel, text]);

beforeAll(async () => {
  valkey = await startValkey();
  layout = layoutDir({ 'ev-1': 20, 'ev-2': 20 });
  svc = await startService(serviceEnv({ redisUrl: valkey.url, seatMapDir: layout.dir }));
  redis = createClient({ url: valkey.url });
  await redis.connect();
}, 120_000);

afterEach(async () => {
  for (const c of clients.splice(0)) c.ws.terminate();
  await sleep(50);
});

afterAll(async () => {
  await svc?.close().catch(() => {});
  await redis?.quit().catch(() => {});
  valkey?.stop();
  layout?.remove();
});

describe('S-T42 핸드셰이크', () => {
  test('S-T42 ① 맞는 토큰·출처·경로는 101이고 고른 하위 프로토콜은 peaket.seats.v1뿐이며(토큰 값이 응답에 없다) 첫 프레임이 BatchInterval 100이다', async () => {
    const token = admissionToken();
    const h = await handshake(svc.ports.app, streamPath('ev-1'), { origin: ORIGIN, protocols: [SEATS, AUTH + token] });
    expect(h.status).toBe(101);
    expect(h.headers['sec-websocket-protocol']).toBe(SEATS);
    expect(JSON.stringify(h.headers)).not.toContain(token.slice(-20));
    expect(JSON.stringify(h.headers)).not.toContain(AUTH);

    const c = connect(svc.url(streamPath('ev-1')), { token });
    clients.push(c);
    await c.opened;
    expect(c.ws.protocol).toBe(SEATS);
    const first = await c.next(isBatchInterval);
    expect(first).toEqual({ type: 'batchInterval', intervalMs: 100 });
    expect(c.frames()[0]).toEqual({ type: 'batchInterval', intervalMs: 100 });
    expect([...c.raw[0]!]).toEqual([1, 3, 100, 0]);
  });

  test('S-T42 ② 경로 틀림·출처 없음·출처 다름·Sec-WebSocket-Key 틀림·Sec-WebSocket-Version 틀림·하위 프로토콜 겹침·POST·Upgrade h2c·빈 하위 프로토콜 값·peaket.seats.v1 없음·토큰 없음·토큰 둘·서명 틀림·만료·typ·aud·iss 틀림·판 파일 없음은 차례대로 404·403·403·400×7·401×7·503이고 업그레이드가 없으며 본문이 비었고 상태별로 센다 [ASVS v5.0.0-4.4.2] [ASVS v5.0.0-4.4.3] [ASVS v5.0.0-4.4.4] [ASVS v5.0.0-16.5.1]', async () => {
    const good = admissionToken();
    const now = Date.now();
    const cases: Array<[string, string, { origin?: string; protocols?: string[]; headers?: Record<string, string>; method?: string; rawProtocols?: string }, number]> = [
      ['경로 틀림', '/v1/events/ev-1/seats', { origin: ORIGIN, protocols: [SEATS, AUTH + good] }, 404],
      ['출처 없음', streamPath('ev-1'), { protocols: [SEATS, AUTH + good] }, 403],
      ['출처 다름', streamPath('ev-1'), { origin: 'https://evil.example', protocols: [SEATS, AUTH + good] }, 403],
      // 16바이트가 아닌 키(15바이트의 base64)
      ['Sec-WebSocket-Key 틀림', streamPath('ev-1'), { origin: ORIGIN, protocols: [SEATS, AUTH + good], headers: { 'Sec-WebSocket-Key': Buffer.alloc(15, 9).toString('base64') } }, 400],
      ['Sec-WebSocket-Version 틀림', streamPath('ev-1'), { origin: ORIGIN, protocols: [SEATS, AUTH + good], headers: { 'Sec-WebSocket-Version': '8' } }, 400],
      ['하위 프로토콜 겹침', streamPath('ev-1'), { origin: ORIGIN, protocols: [SEATS, SEATS, AUTH + good] }, 400],
      // 메서드 GET 아님(업그레이드 머리는 맞음)·Upgrade h2c·빈 하위 프로토콜 값(SEC-R03: ws의 405나 본문 있는 400이 아니라 우리 차례의 400)
      ['POST', streamPath('ev-1'), { origin: ORIGIN, protocols: [SEATS, AUTH + good], method: 'POST' }, 400],
      ['Upgrade h2c', streamPath('ev-1'), { origin: ORIGIN, protocols: [SEATS, AUTH + good], headers: { Upgrade: 'h2c' } }, 400],
      ['빈 하위 프로토콜 값', streamPath('ev-1'), { origin: ORIGIN, rawProtocols: `${SEATS},,${AUTH}${good}` }, 400],
      ['peaket.seats.v1 없음', streamPath('ev-1'), { origin: ORIGIN, protocols: [AUTH + good] }, 400],
      ['토큰 없음', streamPath('ev-1'), { origin: ORIGIN, protocols: [SEATS] }, 401],
      ['토큰 둘', streamPath('ev-1'), { origin: ORIGIN, protocols: [SEATS, AUTH + good, AUTH + admissionToken()] }, 401],
      ['서명 틀림', streamPath('ev-1'), { origin: ORIGIN, protocols: [SEATS, AUTH + admissionToken({ signWith: K_OTHER.priv })] }, 401],
      ['만료', streamPath('ev-1'), { origin: ORIGIN, protocols: [SEATS, AUTH + admissionToken({ nowMs: now - 3_600_000, claims: { exp: Math.floor(now / 1000) - 1 } })] }, 401],
      ['typ 틀림', streamPath('ev-1'), { origin: ORIGIN, protocols: [SEATS, AUTH + admissionToken({ header: { typ: 'at+jwt' } })] }, 401],
      ['aud 틀림', streamPath('ev-1'), { origin: ORIGIN, protocols: [SEATS, AUTH + admissionToken({ claims: { aud: 'fan' } })] }, 401],
      ['iss 틀림', streamPath('ev-1'), { origin: ORIGIN, protocols: [SEATS, AUTH + admissionToken({ claims: { iss: 'https://other.example' } })] }, 401],
      ['판 파일 없음', streamPath('ev-nolayout'), { origin: ORIGIN, protocols: [SEATS, AUTH + admissionToken({ eventId: 'ev-nolayout' })] }, 503],
    ];
    const before = await svc.metrics();
    const got: Array<[string, number, string]> = [];
    for (const [name, path, h] of cases) {
      const r = await handshake(svc.ports.app, path, h);
      got.push([name, r.status, r.body]);
      expect(r.headers['sec-websocket-accept'], name).toBeUndefined();
      expect(r.headers.upgrade, name).toBeUndefined();
    }
    expect(got).toEqual(cases.map(([name, , , status]) => [name, status, '']));
    expect(got.map(([, s]) => s)).toEqual([404, 403, 403, 400, 400, 400, 400, 400, 400, 400, 401, 401, 401, 401, 401, 401, 401, 503]);
    // 거절 수는 상태 코드별로 센다(ws가 스스로 거절하던 머리 셋도 우리 차례에서 센다, ADR-0297 결정 7)
    const after = await svc.metrics();
    const delta = (status: number) => (metricValue(after, `realtime_gw_handshake_rejects_total{status="${status}"}`) ?? 0) - (metricValue(before, `realtime_gw_handshake_rejects_total{status="${status}"}`) ?? 0);
    expect([404, 403, 400, 401, 503].map(delta)).toEqual([1, 2, 7, 7, 1]);
    // 400 일곱은 모두 ws_rejected 줄이 남는다
    await until(() => svc.logLines().filter((l) => l.includes('"ws_rejected"') && l.includes('"status":400')).length >= 7, 'ws_rejected 400 줄 일곱');
  });

  test('S-T42 ② 앞 차례가 걸리면 뒤는 보지 않는다: 회차 ID 모양이 틀린 경로는 출처가 없어도 404, 출처가 없으면 토큰이 없어도 403, 업그레이드 머리나 하위 프로토콜이 틀리면 토큰이 틀려도 400, 토큰이 틀리면 판 파일이 없어도 401 [ASVS v5.0.0-4.4.2] [ASVS v5.0.0-16.5.1]', async () => {
    const tok = AUTH + admissionToken();
    const p = svc.ports.app;
    for (const path of ['/v1/events/ev%3A1/seats/stream', `/v1/events/${'a'.repeat(65)}/seats/stream`, '/v1/events//seats/stream', '/v1/events/ev-1/seats/stream/x', '/v1/events/ev:1/seats/stream']) {
      expect((await handshake(p, path, { protocols: [SEATS, tok] })).status, path).toBe(404);
    }
    expect((await handshake(p, streamPath('ev-1'), { protocols: [SEATS] })).status).toBe(403);
    expect((await handshake(p, streamPath('ev-1'), { origin: `${ORIGIN}/`, protocols: [SEATS, tok] })).status).toBe(403);
    expect((await handshake(p, streamPath('ev-1'), { origin: 'http://www.peaket.example', protocols: [SEATS, tok] })).status).toBe(403);
    expect((await handshake(p, streamPath('ev-1'), { origin: ORIGIN, protocols: [AUTH + 'x.y.z'] })).status).toBe(400);
    // 업그레이드 머리(④)는 출처(③) 뒤이고 토큰(⑤) 앞이다: 출처가 없으면 키가 틀려도 403, 키가 틀리면 토큰이 틀려도 400(본문 없음)
    expect((await handshake(p, streamPath('ev-1'), { protocols: [SEATS, tok], headers: { 'Sec-WebSocket-Key': 'not-a-key!!' } })).status).toBe(403);
    for (const headers of ([{ 'Sec-WebSocket-Key': 'not-a-key!!' }, { 'Sec-WebSocket-Key': Buffer.alloc(17, 1).toString('base64') }, { 'Sec-WebSocket-Version': '14' }] as Array<Record<string, string>>)) {
      const r = await handshake(p, streamPath('ev-1'), { origin: ORIGIN, protocols: [SEATS, AUTH + 'x.y.z'], headers });
      expect([r.status, r.body], JSON.stringify(headers)).toEqual([400, '']);
    }
    expect((await handshake(p, streamPath('ev-nolayout'), { origin: ORIGIN, protocols: [SEATS, AUTH + 'x.y.z'] })).status).toBe(401);
    expect((await handshake(p, streamPath('ev-1'), { origin: ORIGIN, protocols: [SEATS, AUTH] })).status).toBe(401);
  });

  test('S-T42 ③ 주소의 회차(ev-1)와 토큰 event(ev-2)가 다르면 맺은 뒤 바로 4403으로 닫는다 [ASVS v5.0.0-4.4.3]', async () => {
    const c = connect(svc.url(streamPath('ev-1')), { token: admissionToken({ eventId: 'ev-2' }) });
    clients.push(c);
    await c.opened;
    expect((await c.closed).code).toBe(4403);
  });

  test('S-T42 ② 회차 ID __proto__·constructor는 키 조각 모양이라 404가 아니다: 토큰이 없으면 401, 맞는 토큰이고 판 파일이 없으면 503 [ASVS v5.0.0-15.3.6]', async () => {
    for (const id of ['__proto__', 'constructor']) {
      expect((await handshake(svc.ports.app, streamPath(id), { origin: ORIGIN, protocols: [SEATS] })).status, id).toBe(401);
      expect((await handshake(svc.ports.app, streamPath(id), { origin: ORIGIN, protocols: [SEATS, AUTH + admissionToken({ eventId: id })] })).status, id).toBe(503);
    }
    expect(Object.getOwnPropertyNames(Object.prototype)).not.toContain('sections');
  });
});

describe('S-T31 실제 소켓의 받는 프레임 검사', () => {
  test('S-T31 ① 구역 17개 구독은 닫힘 코드 4429다 [ASVS v5.0.0-2.4.1]', async () => {
    const ok = await open();
    ok.send(subscribeBytes(Array.from({ length: 16 }, (_, i) => i)));
    const c = await open();
    c.send(subscribeBytes(Array.from({ length: 17 }, (_, i) => i)));
    expect((await c.closed).code).toBe(4429);
    await sleep(200);
    expect(ok.ws.readyState).toBe(ok.ws.OPEN);
  });

  test('S-T31 ③ 판(20구역)의 색인 20과 같은 색인 둘은 4403이고 색인 19는 받는다. 닫힘 이유 글은 입력이 달라도 같고 받은 값이 없다 [ASVS v5.0.0-1.3.7] [ASVS v5.0.0-16.5.1]', async () => {
    const ok = await open();
    ok.send(subscribeBytes([19]));
    const a = await open();
    a.send(subscribeBytes([20]));
    const b = await open('ev-2');
    b.send(subscribeBytes([3, 3]));
    const [ca, cb] = await Promise.all([a.closed, b.closed]);
    expect([ca.code, cb.code]).toEqual([4403, 4403]);
    expect(ca.reason).toBe(cb.reason);
    for (const v of ['ev-1', 'ev-2', '20', 'acct-1']) expect(ca.reason).not.toContain(v);
    await sleep(200);
    expect(ok.ws.readyState).toBe(ok.ws.OPEN);
  });

  test('S-T31 ④ 글 프레임·type 17·1,025바이트·TimeSync 9바이트는 4403이고, 64KiB를 넘는 프레임은 라이브러리 상한으로 1009다', async () => {
    const frames: Array<[string, Uint8Array | string, number]> = [
      ['글 프레임', 'hello', 4403],
      ['type 17', Uint8Array.from([1, 17, 3, 0, 97, 98, 99]), 4403],
      ['1,025바이트', Uint8Array.from([...subscribeBytes(Array.from({ length: 510 }, (_, i) => i)), 0]), 4403],
      ['TimeSync 9바이트', timeSyncBytes(5).subarray(0, 9), 4403],
      ['64KiB + 1바이트', new Uint8Array(64 * 1024 + 1).fill(1), 1009],
    ];
    for (const [name, bytes, code] of frames) {
      const c = await open();
      c.send(bytes);
      expect((await c.closed).code, name).toBe(code);
    }
  });
});

describe('S-T42 묶음 전파(실제 Valkey SPUBLISH)', () => {
  test('S-T42 ⑤ 구독한 구역의 메시지만 다음 박자에 한 묶음으로 오고 같은 구역 둘은 받은 차례대로 두 항목이며 maxWaitMs = serverTimeMs − 가장 이른 changedAtMs, 메시지 없는 박자에는 프레임이 없다 [ASVS v5.0.0-8.1.2]', async () => {
    const a = await open();
    const b = await open();
    const other = await open('ev-2');
    a.send(subscribeBytes([1, 2]));
    b.send(subscribeBytes([3]));
    other.send(subscribeBytes([1]));
    for (const ch of [channelOf('ev-1', 1), channelOf('ev-1', 2), channelOf('ev-1', 3), channelOf('ev-2', 1)]) await until(async () => (await shardSubs(ch)) === 1, `${ch} 구독`);
    const W = Date.now();
    const m = redis.multi();
    m.addCommand(['SPUBLISH', channelOf('ev-1', 1), deltaText({ epoch: 9, section: 1, version: 5, changedAtMs: W - 40, seats: [[0, 1], [12, 2]] })]);
    m.addCommand(['SPUBLISH', channelOf('ev-1', 3), deltaText({ epoch: 9, section: 3, version: 2, changedAtMs: W - 900, seats: [[1, 1]] })]);
    m.addCommand(['SPUBLISH', channelOf('ev-2', 1), deltaText({ epoch: 9, section: 1, version: 7, changedAtMs: W - 950, seats: [[2, 2]] })]);
    m.addCommand(['SPUBLISH', channelOf('ev-1', 1), deltaText({ epoch: 9, section: 1, version: 6, changedAtMs: W - 90, seats: [[12, 0]] })]);
    await m.exec();
    const got = await a.next(isDelta);
    expect(got.seatEpoch).toBe(9);
    expect(entriesOf(got)).toEqual([
      { sectionIndex: 1, sectionVersion: 5, offsets: [0, 12], states: [1, 2] },
      { sectionIndex: 1, sectionVersion: 6, offsets: [12], states: [0] },
    ]);
    expect(got.maxWaitMs).toBe(got.serverTimeMs - (W - 90));
    expect(got.maxWaitMs).toBeGreaterThanOrEqual(90);
    expect(got.maxWaitMs).toBeLessThan(90 + 1_000);
    expect(a.raw.at(-1)!.byteLength).toBe(18 + (8 + 2 * 3) + (8 + 3));
    expect(entriesOf(await b.next(isDelta))).toEqual([{ sectionIndex: 3, sectionVersion: 2, offsets: [1], states: [1] }]);
    expect(entriesOf(await other.next(isDelta))).toEqual([{ sectionIndex: 1, sectionVersion: 7, offsets: [2], states: [2] }]);
    // 박자 몇 개를 더 지나도 새 프레임이 없다
    const n = a.raw.length;
    await sleep(450);
    expect(a.raw.length).toBe(n);
    expect(a.frames().filter(isDelta)).toHaveLength(1);
  });

  test('S-T12 ② 묶음 셋을 보낸 뒤 realtime_gw_batches_total +3, batch_bytes_total + 세 프레임 바이트의 합, batch_wait_ms 표본 +3·합 + 세 maxWaitMs의 합이고 묶음 없는 박자 뒤에는 늘지 않는다', async () => {
    const a = await open();
    a.send(subscribeBytes([7]));
    await until(async () => (await shardSubs(channelOf('ev-1', 7))) === 1, '구역 7 구독');
    const before = await svc.metrics();
    const frames: Array<{ bytes: number; wait: number }> = [];
    for (const [i, ago] of [25, 60, 140].entries()) {
      const from = a.raw.length;
      await spublish(channelOf('ev-1', 7), deltaText({ epoch: 1, section: 7, version: i + 1, changedAtMs: Date.now() - ago, seats: [[i, 1]] }));
      const f = await a.next(isDelta, 3_000, from);
      frames.push({ bytes: a.raw.slice(from).find((b) => b[1] === 1)!.byteLength, wait: f.maxWaitMs });
    }
    const after = await svc.metrics();
    const d = (series: string) => (metricValue(after, series) ?? 0) - (metricValue(before, series) ?? 0);
    expect(d('realtime_gw_batches_total')).toBe(3);
    expect(d('realtime_gw_batch_bytes_total')).toBe(frames.reduce((s, f) => s + f.bytes, 0));
    expect(d('realtime_gw_batch_wait_ms_count')).toBe(3);
    expect(d('realtime_gw_batch_wait_ms_sum')).toBe(frames.reduce((s, f) => s + f.wait, 0));
    expect(frames.every((f) => f.wait > 0)).toBe(true);
    await sleep(400);
    const later = await svc.metrics();
    for (const s of ['realtime_gw_batches_total', 'realtime_gw_batch_bytes_total', 'realtime_gw_batch_wait_ms_count']) expect(metricValue(later, s), s).toBe(metricValue(after, s));
  });

  test('S-T42 ⑧ 두 연결이 같은 구역을 구독하면 SSUBSCRIBE 한 번, 첫 해제에는 SUNSUBSCRIBE가 없고 남은 연결은 계속 받으며, 마지막 해제에 SUNSUBSCRIBE 한 번이다', async () => {
    const ch = channelOf('ev-1', 9);
    await redis.sendCommand(['CONFIG', 'RESETSTAT']);
    const a = await open();
    const b = await open();
    a.send(subscribeBytes([9]));
    await until(async () => (await shardSubs(ch)) === 1, '구역 9 구독');
    b.send(subscribeBytes([9]));
    await sleep(300);
    expect(await cmdCalls('ssubscribe')).toBe(1);
    a.send(subscribeBytes([]));
    await sleep(300);
    expect(await cmdCalls('sunsubscribe')).toBe(0);
    expect(await shardSubs(ch)).toBe(1);
    await spublish(ch, deltaText({ epoch: 1, section: 9, version: 1, changedAtMs: Date.now(), seats: [[0, 2]] }));
    await b.next(isDelta);
    await sleep(250);
    expect(a.frames().filter(isDelta)).toEqual([]);
    b.send(subscribeBytes([]));
    await until(async () => (await shardSubs(ch)) === 0, '구역 9 해제');
    await sleep(200);
    expect([await cmdCalls('ssubscribe'), await cmdCalls('sunsubscribe')]).toEqual([1, 1]);
  });

  test('S-T42 ⑨ 틀린 메시지 사이의 맞는 메시지가 오고 result="bad"가 틀린 수만큼 늘며 연결은 열려 있다', async () => {
    const a = await open();
    a.send(subscribeBytes([4]));
    const ch = channelOf('ev-1', 4);
    await until(async () => (await shardSubs(ch)) === 1, '구역 4 구독');
    const before = await svc.metrics();
    const W = Date.now();
    const m = redis.multi();
    m.addCommand(['SPUBLISH', ch, deltaText({ epoch: 2, section: 4, version: 1, changedAtMs: W, seats: [[3, 1]] })]);
    for (const t of [`2 2 4 2 ${W} 1:1`, `1 2 4 2 ${W}`, `1 2 5 2 ${W} 1:1`, `1 2 4 2 ${W} 70000:1`]) m.addCommand(['SPUBLISH', ch, t]);
    m.addCommand(['SPUBLISH', ch, deltaText({ epoch: 2, section: 4, version: 2, changedAtMs: W, seats: [[4, 2]] })]);
    await m.exec();
    const got = await a.next(isDelta);
    expect(entriesOf(got).map((e) => e.sectionVersion)).toEqual([1, 2]);
    const after = await svc.metrics();
    const d = (r: string) => (metricValue(after, `realtime_gw_pubsub_messages_total{result="${r}"}`) ?? 0) - (metricValue(before, `realtime_gw_pubsub_messages_total{result="${r}"}`) ?? 0);
    expect([d('bad'), d('ok')]).toEqual([4, 2]);
    expect(a.ws.readyState).toBe(a.ws.OPEN);
  });

  test('S-T42 ⑦ 실제 소켓에서 TimeSync에 곧 Heartbeat로 답하고 echoClientTimeMs가 보낸 값이다', async () => {
    const a = await open();
    a.send(timeSyncBytes(987_654_321_012));
    const hb = await a.next(isHeartbeat);
    expect(hb.echoClientTimeMs).toBe(987_654_321_012);
    expect(Math.abs(hb.serverTimeMs - Date.now())).toBeLessThan(2_000);
  });
});

describe('운영 확인과 로그', () => {
  test('S-T42 ⑰ 앱 포트는 업그레이드가 아닌 요청에 404(GET /·/metrics·좌석 경로), TRACE에 405이고 지표(realtime_gw_subscribe_mismatch 포함)는 관리 포트에만 있다 [ASVS v5.0.0-13.4.3] [ASVS v5.0.0-13.4.4] [ASVS v5.0.0-13.4.5]', async () => {
    const app = `http://127.0.0.1:${svc.ports.app}`;
    for (const p of ['/', '/metrics', streamPath('ev-1'), '/v1/', '/ready']) expect((await fetch(app + p)).status, p).toBe(404);
    // fetch는 TRACE를 보내지 못해 http.request로 보낸다
    const trace = (path: string) =>
      new Promise<number>((resolve, reject) => {
        const req = httpRequest({ host: '127.0.0.1', port: svc.ports.app, path, method: 'TRACE' }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        });
        req.once('error', reject);
        req.end();
      });
    expect(await trace('/')).toBe(405);
    expect(await trace('/metrics')).toBe(405);
    expect(await trace(streamPath('ev-1'))).toBe(405);
    const metrics = await svc.metrics();
    for (const name of ['realtime_gw_connections', 'realtime_gw_handshake_rejects_total', 'realtime_gw_closes_total', 'realtime_gw_batches_total', 'realtime_gw_batch_bytes_total', 'realtime_gw_batch_wait_ms', 'realtime_gw_pubsub_messages_total', 'realtime_gw_redis_up', 'realtime_gw_subscribe_mismatch']) {
      expect(metrics, name).toContain(`# TYPE ${name} `);
    }
    expect(metricValue(metrics, 'realtime_gw_redis_up')).toBe(1);
    // 원하는 상태와 실제가 다른 채널 수(ADR-0297 결정 1): 평상시 0
    expect(metricValue(metrics, 'realtime_gw_subscribe_mismatch')).toBe(0);
  });

  test('꾸민 x-user-id·x-forwarded-for를 붙여도 ws_closed의 계정 가명은 토큰 sub의 것이다 [ASVS v5.0.0-4.1.3]', async () => {
    const c = await open('ev-1', { token: admissionToken({ accountId: 'acct-real' }), headers: { 'x-user-id': 'acct-evil', 'x-forwarded-for': '203.0.113.9' } });
    c.ws.close(1000);
    await c.closed;
    const p = new LogPseudonymizer(PSEUDONYM_KEY);
    await until(() => svc.logLines().some((l) => l.includes(p.ref('acct-real'))), 'ws_closed 줄');
    const line = svc.logLines().map((l) => JSON.parse(l) as Record<string, unknown>).find((l) => l.event === 'ws_closed' && l.accountRef === p.ref('acct-real'));
    expect(line).toMatchObject({ event: 'ws_closed', eventId: 'ev-1', code: 1000 });
    expect(svc.logLines().join('\n')).not.toContain(p.ref('acct-evil'));
    expect(svc.logLines().join('\n')).not.toContain('acct-evil');
    expect(svc.logLines().join('\n')).not.toContain('acct-real');
  });

  test('로그 줄은 모두 JSON이고 ts는 KST 오프셋 +09:00 ISO 8601이며 ws_rejected·ws_closed 칸이 있고 토큰·peaket.auth.이 로그·지표 어디에도 없다 [ASVS v5.0.0-14.1.2] [ASVS v5.0.0-16.2.1] [ASVS v5.0.0-16.2.2] [ASVS v5.0.0-16.2.3] [ASVS v5.0.0-16.2.4]', async () => {
    const token = admissionToken({ claims: { aud: 'fan' } });
    await handshake(svc.ports.app, streamPath('ev-1'), { origin: ORIGIN, protocols: [SEATS, AUTH + token] });
    const good = admissionToken();
    const c = await open('ev-1', { token: good });
    c.ws.close(1000);
    await c.closed;
    await until(() => svc.logLines().some((l) => l.includes('"ws_closed"')), 'ws_closed 줄');
    const lines = svc.logLines();
    expect(lines.length).toBeGreaterThan(0);
    const parsed = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    const kst = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}\+09:00$/;
    for (const l of parsed) {
      expect(String(l.ts)).toMatch(kst);
      // ts는 KST 벽시계: UTC로 되돌린 값이 지금과 가깝다
      expect(Math.abs(Date.parse(String(l.ts)) - Date.now())).toBeLessThan(10 * 60_000);
    }
    const rejected = parsed.filter((l) => l.event === 'ws_rejected');
    expect(rejected.length).toBeGreaterThan(0);
    expect(rejected.every((l) => typeof l.status === 'number' && typeof l.reason === 'string')).toBe(true);
    expect(rejected.some((l) => l.status === 401)).toBe(true);
    const closed = parsed.filter((l) => l.event === 'ws_closed');
    expect(closed.length).toBeGreaterThan(0);
    for (const l of closed) {
      expect(typeof l.eventId).toBe('string');
      expect(typeof l.code).toBe('number');
      expect(typeof l.connectedMs).toBe('number');
      expect(String(l.accountRef)).toMatch(/^[A-Za-z0-9_-]{22}$/);
    }
    const all = lines.join('\n') + (await svc.metrics());
    for (const t of [token, good]) {
      for (const part of t.split('.')) expect(all).not.toContain(part);
    }
    expect(all).not.toContain(AUTH);
    expect(all).not.toContain(ISS);
  });
});

describe('S-T42 ⑭ 구독 명령만 허용한 Redis 사용자', () => {
  /** seat-hold §7 '좌석 Redis 구독'의 접근 문자열(ADR-0297 결정 6). BAS-140이 운영 사용자를 이 문자열로 만든다 */
  const ACL_RULES = ['resetchannels', '&s:{event:*}:sec:*', '-@all', '+ssubscribe', '+sunsubscribe', '+ping', '+hello', '+auth', '+client|setinfo', '+cluster|slots'];
  /** 첫 구현의 넓은 접근 문자열(리뷰 SEC-03~05가 좁힌 것). 아래 세 명령이 이 문자열이면 통과함을 보여 단언이 접근 문자열에 민감한지 대조한다 */
  const OLD_RULES = ['resetchannels', '&s:*', '-@all', '+ssubscribe', '+sunsubscribe', '+ping', '+hello', '+auth', '+client'];
  const PROBES: string[][] = [['CLIENT', 'LIST'], ['CLIENT', 'PAUSE', '1', 'WRITE'], ['SSUBSCRIBE', 's:other']];

  test('S-T42 ⑭ 정본 접근 문자열의 사용자로 CLIENT LIST·CLIENT PAUSE·SSUBSCRIBE s:other는 NOPERM이고(옛 문자열이면 통과한다), 같은 사용자로 띄운 단일 노드 Valkey에서 ⑤가 같고 거절된 명령이 없다 [ASVS v5.0.0-13.2.2] [ASVS v5.0.0-13.3.2]', async () => {
    const pw = 'rtgw-pw-1c8e';
    await redis.sendCommand(['ACL', 'SETUSER', 'rtgw', 'reset', 'on', `>${pw}`, ...ACL_RULES]);
    await redis.sendCommand(['ACL', 'SETUSER', 'rtgw-old', 'reset', 'on', `>${pw}`, ...OLD_RULES]);
    // 대조: 옛 문자열이면 세 명령이 통과한다(NOPERM이 아니다)
    for (const args of PROBES) expect(await rawRedisReply(valkey.port, { user: 'rtgw-old', password: pw }, args), `old ${args.join(' ')}`).not.toMatch(/^-NOPERM/);
    // 정본 문자열이면 세 명령 모두 NOPERM
    for (const args of PROBES) expect(await rawRedisReply(valkey.port, { user: 'rtgw', password: pw }, args), args.join(' ')).toMatch(/^-NOPERM/);
    // 데이터 명령도 쓰지 못한다
    expect(await rawRedisReply(valkey.port, { user: 'rtgw', password: pw }, ['GET', 'x'])).toMatch(/^-NOPERM/);
    // 쓰는 채널 모양은 받는다
    expect(await rawRedisReply(valkey.port, { user: 'rtgw', password: pw }, ['SSUBSCRIBE', channelOf('ev-1', 0)])).toMatch(/^\*3/);
    await redis.sendCommand(['ACL', 'LOG', 'RESET']);

    const aclUrl = `redis://rtgw:${pw}@127.0.0.1:${valkey.port}`;
    const svc2 = await startService(serviceEnv({ redisUrl: aclUrl, seatMapDir: layout.dir }));
    try {
      const c = connect(svc2.url(streamPath('ev-1')), { token: admissionToken() });
      clients.push(c);
      await c.opened;
      await c.next(isBatchInterval);
      c.send(subscribeBytes([11, 12]));
      await until(async () => (await shardSubs(channelOf('ev-1', 11))) === 1 && (await shardSubs(channelOf('ev-1', 12))) === 1, 'ACL 사용자 구독');
      const W = Date.now();
      const m = redis.multi();
      m.addCommand(['SPUBLISH', channelOf('ev-1', 11), deltaText({ epoch: 4, section: 11, version: 1, changedAtMs: W - 20, seats: [[5, 1]] })]);
      m.addCommand(['SPUBLISH', channelOf('ev-1', 13), deltaText({ epoch: 4, section: 13, version: 1, changedAtMs: W - 30, seats: [[5, 1]] })]);
      m.addCommand(['SPUBLISH', channelOf('ev-1', 11), deltaText({ epoch: 4, section: 11, version: 2, changedAtMs: W - 50, seats: [[5, 2]] })]);
      await m.exec();
      const got = await c.next(isDelta);
      expect(entriesOf(got)).toEqual([
        { sectionIndex: 11, sectionVersion: 1, offsets: [5], states: [1] },
        { sectionIndex: 11, sectionVersion: 2, offsets: [5], states: [2] },
      ]);
      expect(got.maxWaitMs).toBe(got.serverTimeMs - (W - 50));
      expect(metricValue(await svc2.metrics(), 'realtime_gw_redis_up')).toBe(1);
      // 구독 연결 살핌(PING 5초)이 한 번 돈 뒤에도 거절된 명령이 없다
      await sleep(6_000);
      const log = (await redis.sendCommand(['ACL', 'LOG'])) as unknown[];
      expect(JSON.stringify(log)).not.toContain('rtgw');
    } finally {
      await svc2.close();
    }
  }, 60_000);
});

describe('S-T42 ⑮ 클라이언트 Ping은 받지 않는다(ADR-0297 결정 2)', () => {
  test('S-T42 ⑮ 구독하지 않고 받기를 멈춘 연결이 Ping(125바이트)을 퍼부으면 4403 bad frame으로 닫힌다(자동 Pong이 쌓이지 않는다) [ASVS v5.0.0-2.4.1]', async () => {
    const before = await svc.metrics();
    const c = await open();
    const sock = rawSocketOf(c.ws);
    sock.pause();
    for (let i = 0; i < 500; i++) c.ws.ping(Buffer.alloc(125, 7));
    await sleep(100);
    sock.resume();
    const got = await Promise.race([c.closed, sleep(2_000).then(() => 'still open' as const)]);
    expect(got).toEqual({ code: 4403, reason: 'bad frame' });
    await until(async () => (metricValue(await svc.metrics(), 'realtime_gw_closes_total{code="4403"}') ?? 0) > (metricValue(before, 'realtime_gw_closes_total{code="4403"}') ?? 0), '4403 닫힘 셈', 3_000);
  });
});

describe('S-T42 ⑯ 연결 수 상한(ADR-0297 결정 3)', () => {
  test('S-T42 ⑯ 같은 입장 토큰으로 셋 붙으면 둘은 열리고 셋째는 맺은 뒤 4429 too many다. 첫째를 닫은 뒤 같은 토큰으로 다시 붙으면 열린다 [ASVS v5.0.0-2.4.1]', async () => {
    const token = admissionToken();
    const a = await open('ev-1', { token });
    const b = await open('ev-1', { token });
    const c = connect(svc.url(streamPath('ev-1')), { token });
    clients.push(c);
    await c.opened;
    expect(await Promise.race([c.closed, sleep(3_000).then(() => 'still open' as const)])).toEqual({ code: 4429, reason: 'too many' });
    await sleep(200);
    expect([a.ws.readyState, b.ws.readyState]).toEqual([a.ws.OPEN, b.ws.OPEN]);
    a.ws.close(1000);
    await a.closed;
    await sleep(200);
    const d = await open('ev-1', { token });
    await sleep(300);
    expect(d.ws.readyState).toBe(d.ws.OPEN);
    // 다른 토큰은 세지 않는다
    const e = await open();
    await sleep(200);
    expect(e.ws.readyState).toBe(e.ws.OPEN);
  });

  test('S-T42 ⑯ 파드 연결 상한(PEAKET_REALTIME_MAX_CONNECTIONS=3, 시험 값)까지 붙은 뒤 넷째 핸드셰이크는 503·빈 본문·업그레이드 없음이고, 하나를 닫으면 다시 받는다 [ASVS v5.0.0-2.4.1] [ASVS v5.0.0-16.5.1]', async () => {
    const svcMax = await startService(serviceEnv({ redisUrl: valkey.url, seatMapDir: layout.dir, extra: { PEAKET_REALTIME_MAX_CONNECTIONS: '3' } }));
    const mine: Client[] = [];
    try {
      for (const accountId of ['acct-1', 'acct-2', 'acct-3']) {
        const c = connect(svcMax.url(streamPath('ev-1')), { token: admissionToken({ accountId }) });
        mine.push(c);
        await c.opened;
        await c.next(isBatchInterval);
      }
      const before = await svcMax.metrics();
      const r = await handshake(svcMax.ports.app, streamPath('ev-1'), { origin: ORIGIN, protocols: [SEATS, AUTH + admissionToken({ accountId: 'acct-4' })] });
      expect([r.status, r.body, r.headers.upgrade, r.headers['sec-websocket-accept']]).toEqual([503, '', undefined, undefined]);
      const after = await svcMax.metrics();
      const d503 = (metricValue(after, 'realtime_gw_handshake_rejects_total{status="503"}') ?? 0) - (metricValue(before, 'realtime_gw_handshake_rejects_total{status="503"}') ?? 0);
      expect(d503).toBe(1);
      expect(mine.every((c) => c.ws.readyState === c.ws.OPEN)).toBe(true);
      mine[0]!.ws.close(1000);
      await mine[0]!.closed;
      await until(async () => metricValue(await svcMax.metrics(), 'realtime_gw_connections') === 2, '연결 수 2');
      const again = await handshake(svcMax.ports.app, streamPath('ev-1'), { origin: ORIGIN, protocols: [SEATS, AUTH + admissionToken({ accountId: 'acct-5' })] });
      expect(again.status).toBe(101);
    } finally {
      for (const c of mine) c.ws.terminate();
      await svcMax.close();
    }
  });
});

describe('S-T42 ⑯ 곧 닫는 연결과 상한(보안 다시 보기 SEC-R01·R02, ADR-0297 결정 3)', () => {
  /** 101 뒤 소켓을 열어 둔 채 아무것도 쓰지 않는다(닫기 인사에 답하지 않음). 받은 닫힘 프레임 코드와 끊김을 본다 */
  interface Silent {
    status: number;
    body: string;
    upgrade: string | string[] | undefined;
    code(): number | undefined;
    closed(): boolean;
  }
  const kept: import('node:net').Socket[] = [];
  const silent = async (port: number, path: string, token: string): Promise<Silent> => {
    const data: Buffer[] = [];
    let ended = false;
    const h = await handshake(port, path, { origin: ORIGIN, protocols: [SEATS, AUTH + token] }, (s, head) => {
      kept.push(s);
      if (head.length > 0) data.push(Buffer.from(head));
      s.on('data', (d: Buffer) => data.push(d));
      s.on('close', () => (ended = true));
      s.on('error', () => {});
    });
    return {
      status: h.status,
      body: h.body,
      upgrade: h.headers.upgrade,
      code: () => {
        const b = Buffer.concat(data);
        const at = b.indexOf(0x88);
        return at >= 0 && b.length >= at + 4 ? b.readUInt16BE(at + 2) : undefined;
      },
      closed: () => ended,
    };
  };
  afterEach(() => {
    for (const s of kept.splice(0)) s.destroy();
  });

  test('S-T42 ⑯ 파드 상한 3(시험 값)에서 회차가 다른 토큰으로 셋, 같은 jti로 넷(셋째·넷째 4429)을 답하지 않는 채 붙여도 곧바로(1초 안) 다른 토큰의 핸드셰이크는 101이다 [ASVS v5.0.0-2.4.1]', async () => {
    const svcMax = await startService(serviceEnv({ redisUrl: valkey.url, seatMapDir: layout.dir, extra: { PEAKET_REALTIME_MAX_CONNECTIONS: '3' } }));
    try {
      const p = svcMax.ports.app;
      // (가) 회차 ev-2 토큰 하나로 ev-1 주소에 셋: 모두 101 뒤 4403 bad event, 답하지 않는다
      const evil = admissionToken({ eventId: 'ev-2' });
      const startedA = Date.now();
      const bad: Silent[] = [];
      for (let i = 0; i < 3; i++) bad.push(await silent(p, streamPath('ev-1'), evil));
      expect(bad.map((b) => b.status)).toEqual([101, 101, 101]);
      await until(() => bad.every((b) => b.code() === 4403), '4403 닫힘 프레임 셋', 1_000, 10);
      const otherA = await silent(p, streamPath('ev-1'), admissionToken({ accountId: 'acct-a' }));
      expect(Date.now() - startedA).toBeLessThan(1_000);
      expect(otherA.status).toBe(101);
      for (const s of kept.splice(0)) s.destroy();
      await until(async () => (metricValue(await svcMax.metrics(), 'realtime_gw_connections') ?? 0) === 0, '연결 0', 5_000);

      // (나) 같은 jti로 넷: 앞의 둘은 열리고 셋째·넷째는 101 뒤 4429 too many, 답하지 않는다
      const same = admissionToken({ accountId: 'acct-b' });
      const startedB = Date.now();
      const four: Silent[] = [];
      for (let i = 0; i < 4; i++) four.push(await silent(p, streamPath('ev-1'), same));
      expect(four.map((b) => b.status)).toEqual([101, 101, 101, 101]);
      await until(() => four[2]!.code() === 4429 && four[3]!.code() === 4429, '4429 닫힘 프레임 둘', 1_000, 10);
      const otherB = await silent(p, streamPath('ev-1'), admissionToken({ accountId: 'acct-c' }));
      expect(Date.now() - startedB).toBeLessThan(1_000);
      expect(otherB.status).toBe(101);
    } finally {
      for (const s of kept.splice(0)) s.destroy();
      await svcMax.close();
    }
  });

  test('S-T42 ⑯ 같은 jti로 회차가 다른 연결을 답하지 않는 채 넷(101 뒤 4403 bad event) 만든 뒤 다섯째 핸드셰이크는 회차가 맞든 다르든 업그레이드 없이 503·빈 본문이고, 그 연결들이 끊긴 뒤(300ms) 같은 토큰의 맞는 회차는 101이다 [ASVS v5.0.0-2.4.1] [ASVS v5.0.0-16.5.1]', async () => {
    const p = svc.ports.app;
    // 같은 jti, 회차 ev-2. ev-1 주소면 회차가 다르고 ev-2 주소면 맞다
    const tok = admissionToken({ eventId: 'ev-2', accountId: 'acct-r02' });
    const four: Silent[] = [];
    for (let i = 0; i < 4; i++) four.push(await silent(p, streamPath('ev-1'), tok));
    expect(four.map((b) => b.status)).toEqual([101, 101, 101, 101]);
    await until(() => four.every((b) => b.code() === 4403), '4403 닫힘 프레임 넷', 1_000, 10);
    const before = await svc.metrics();
    const fifthWrong = await silent(p, streamPath('ev-1'), tok);
    const fifthRight = await silent(p, streamPath('ev-2'), tok);
    for (const [name, r] of [['회차 다름', fifthWrong], ['회차 맞음', fifthRight]] as const) {
      expect([r.status, r.body, r.upgrade], name).toEqual([503, '', undefined]);
    }
    const after = await svc.metrics();
    const d503 = (metricValue(after, 'realtime_gw_handshake_rejects_total{status="503"}') ?? 0) - (metricValue(before, 'realtime_gw_handshake_rejects_total{status="503"}') ?? 0);
    expect(d503).toBe(2);
    await sleep(300);
    expect(four.every((b) => b.closed())).toBe(true);
    const later = await silent(p, streamPath('ev-2'), tok);
    expect(later.status).toBe(101);
  });
});

describe('S-T42 ⑱ 답 없는 구독 연결(ADR-0297 결정 4)', () => {
  test(
    'S-T42 ⑱ gw와 Valkey 사이 망이 닫히지 않고 받은 것을 버리면 PING 5초 + 답 2초 뒤 박자 안(10초까지 기다림)에 realtime_gw_redis_up이 0이 되고, 망을 되살리면 1로 돌아와 SPUBLISH가 묶음으로 온다',
    async () => {
      const relay = await startRelay(valkey.port);
      const svcR = await startService(serviceEnv({ redisUrl: relay.url, seatMapDir: layout.dir }));
      try {
        const up = async () => metricValue(await svcR.metrics(), 'realtime_gw_redis_up');
        const ch = channelOf('ev-1', 17);
        const c = connect(svcR.url(streamPath('ev-1')), { token: admissionToken() });
        clients.push(c);
        await c.opened;
        await c.next(isBatchInterval);
        c.send(subscribeBytes([17]));
        await until(async () => (await shardSubs(ch)) === 1, '구역 17 구독');
        let from = c.raw.length;
        await spublish(ch, deltaText({ epoch: 1, section: 17, version: 1, changedAtMs: Date.now(), seats: [[0, 1]] }));
        await c.next(isDelta, 3_000, from);
        expect(await up()).toBe(1);

        relay.blackhole();
        const cutAt = Date.now();
        await until(async () => (await up()) === 0, 'redis_up 0(답 없음)', 10_000, 100);
        expect(Date.now() - cutAt).toBeLessThanOrEqual(10_000);
        // 그동안 WebSocket 연결은 열려 있다
        expect(c.ws.readyState).toBe(c.ws.OPEN);

        relay.restore();
        await until(async () => (await up()) === 1, 'redis_up 1(되살림)', 20_000, 100);
        // 다시 구독한 뒤의 메시지가 묶음으로 온다
        from = c.raw.length;
        let v = 2;
        await until(
          async () => {
            await spublish(ch, deltaText({ epoch: 1, section: 17, version: v++, changedAtMs: Date.now(), seats: [[1, 2]] }));
            await sleep(250);
            return c.frames().slice(from).some(isDelta);
          },
          '되살린 뒤 묶음',
          20_000,
          0,
        );
        expect(c.ws.readyState).toBe(c.ws.OPEN);
      } finally {
        await svcR.close().catch(() => {});
        await relay.close();
      }
    },
    60_000,
  );
});

describe('S-T42 ⑪ S-T31 ② 실제 소켓의 바깥 경계(RF-T11, COR-08)', () => {
  test(
    'S-T42 ⑪ S-T14 ① 받기를 멈춘 실제 연결 하나가 있는 채 큰 묶음을 퍼부으면 그 연결만 1013으로 닫히고(서버의 보내기 버퍼 1MiB) 다른 연결은 묶음을 이어 받는다. 닫히기 전 realtime_gw_buffer_slow_connections가 1(256KiB 이상인 동안 1초 간격)이고 닫힌 뒤 0이며, 받는 연결은 BatchInterval 1000을 받지 않는다(시험 이의 TO-1)',
    async () => {
      const ch = channelOf('ev-1', 15);
      const slow = await open();
      const fast = await open();
      slow.send(subscribeBytes([15]));
      fast.send(subscribeBytes([15]));
      await until(async () => (await shardSubs(ch)) === 1, '구역 15 구독');
      await sleep(200);
      rawSocketOf(slow.ws).pause();
      const before = await svc.metrics();
      const closes1013 = async () => (metricValue(await svc.metrics(), 'realtime_gw_closes_total{code="1013"}') ?? 0) - (metricValue(before, 'realtime_gw_closes_total{code="1013"}') ?? 0);
      // 메시지 하나 = 좌석 20,000개(묶음 항목 약 60KB). 박자마다 6개(약 360KB)씩, 받는 연결이 따라오게 쉬며 보낸다
      const seats = Array.from({ length: 20_000 }, (_, i) => [i, 1] as [number, number]);
      let version = 0;
      // 버퍼 1초 연결 게이지를 박자마다 본다(1013 전에 1이 되어야 한다, ADR-0298 결정 3)
      let sawSlow = false;
      const watchSlow = async (): Promise<void> => {
        if (metricValue(await svc.metrics(), 'realtime_gw_buffer_slow_connections') === 1) sawSlow = true;
      };
      for (let round = 0; round < 150 && (await closes1013()) === 0; round++) {
        const m = redis.multi();
        for (let k = 0; k < 6; k++) m.addCommand(['SPUBLISH', ch, deltaText({ epoch: 3, section: 15, version: ++version, changedAtMs: Date.now(), seats })]);
        await m.exec();
        await sleep(60);
        await watchSlow();
      }
      await until(async () => (await closes1013()) === 1, '느린 연결 1013', 10_000);
      expect(sawSlow).toBe(true);
      await until(async () => metricValue(await svc.metrics(), 'realtime_gw_buffer_slow_connections') === 0, '버퍼 1초 연결 게이지 0');
      // 다른 연결은 열려 있고 그 뒤의 묶음을 받는다
      expect(fast.ws.readyState).toBe(fast.ws.OPEN);
      const from = fast.raw.length;
      await spublish(ch, deltaText({ epoch: 3, section: 15, version: ++version, changedAtMs: Date.now(), seats: [[7, 2]] }));
      const last = version;
      const isLast = (f: Parameters<typeof isDelta>[0]): f is DeltaFrame => isDelta(f) && f.sections.some((s) => s.sectionVersion === last);
      await fast.next(isLast, 10_000, from);
      expect(await closes1013()).toBe(1);
      // 받는 연결은 처음의 100 말고 BatchInterval을 받지 않았다(받기를 멈춘 연결의 버퍼는 그 연결만 바꾼다)
      expect(fast.frames().filter(isBatchInterval).map((f) => f.intervalMs)).toEqual([100]);
      await until(() => svc.logLines().some((l) => l.includes('"ws_closed"') && l.includes('"code":1013')), 'ws_closed 1013 줄');
    },
    90_000,
  );

  test(
    'S-T14 ① RF-T12 받기를 멈춘 실제 연결은 보내기 버퍼가 256KiB에 닿으면 그 연결만 1초 간격이 되고(realtime_gw_buffer_slow_connections 1, realtime_gw_degraded 0), 다시 받으면 BatchInterval 1000 뒤 묶음 serverTimeMs가 1,000ms 안팎 간격이며, 버퍼가 빈 뒤 차례 30번(30초 근처) 뒤 BatchInterval 100을 받고 게이지가 0이다. 받는 연결은 100 그대로다',
    async () => {
      // 시작 파일이 게이지 둘을 0으로 낸다(ADR-0298 결정 7)
      const m0 = await svc.metrics();
      expect(metricValue(m0, 'realtime_gw_degraded')).toBe(0);
      expect(metricValue(m0, 'realtime_gw_buffer_slow_connections')).toBe(0);
      const ch = channelOf('ev-1', 14);
      const slow = await open();
      const fast = await open();
      slow.send(subscribeBytes([14]));
      fast.send(subscribeBytes([14]));
      await until(async () => (await shardSubs(ch)) === 1, '구역 14 구독');
      await sleep(200);
      rawSocketOf(slow.ws).pause();
      const gaugeOf = async (name: string): Promise<number | undefined> => metricValue(await svc.metrics(), name);
      // 메시지 하나 = 좌석 20,000개(묶음 항목 약 60KB). 박자마다 둘(약 120KB)씩 보내고 박자마다 게이지를 본다.
      // 1초가 된 뒤 쌓이는 양이 1MiB에 닿지 않게(1013이 아니게) 게이지가 1이 되면 곧 멈춘다
      const seats = Array.from({ length: 20_000 }, (_, i) => [i, 1] as [number, number]);
      let version = 0;
      let switched = false;
      for (let round = 0; round < 600 && !switched; round++) {
        const m = redis.multi();
        for (let k = 0; k < 2; k++) m.addCommand(['SPUBLISH', ch, deltaText({ epoch: 4, section: 14, version: ++version, changedAtMs: Date.now(), seats })]);
        await m.exec();
        await sleep(80);
        switched = (await gaugeOf('realtime_gw_buffer_slow_connections')) === 1;
      }
      expect(switched).toBe(true);
      expect(await gaugeOf('realtime_gw_degraded')).toBe(0); // 한 연결의 버퍼는 파드를 바꾸지 않는다

      // 다시 받는다. 작은 메시지를 100ms마다 계속 보낸다(멈출 때까지)
      let publishing = true;
      const smallLoop = (async () => {
        while (publishing) {
          await spublish(ch, deltaText({ epoch: 4, section: 14, version: ++version, changedAtMs: Date.now(), seats: [[version % 100, 2]] }));
          await sleep(100);
        }
      })();
      const resumedAt = Date.now();
      rawSocketOf(slow.ws).resume();
      try {
        const isInterval = (ms: number) => (f: Parameters<typeof isBatchInterval>[0]): f is Extract<typeof f, { type: 'batchInterval' }> => isBatchInterval(f) && f.intervalMs === ms;
        await slow.next(isInterval(1_000), 10_000);
        await sleep(5_500);
        expect(slow.ws.readyState).toBe(slow.ws.OPEN); // 1MiB에 닿지 않았다(1013 아님)
        const frames = slow.frames();
        const i1000 = frames.findIndex(isInterval(1_000));
        // 다시 받은 뒤(+300ms부터) 보낸 묶음끼리의 간격: '1,000ms 이상 지난 첫 박자'라 1,000ms에서 박자 하나(100ms) 안쪽.
        // 실제 타이머라 허용 폭을 아래 50ms·위 50ms [가정]로 둔다(경계는 허브 시험이 가짜 시계로 본다)
        const later = frames.slice(i1000 + 1).filter(isDelta).filter((f) => f.serverTimeMs >= resumedAt + 300);
        const gaps = later.slice(1).map((f, i) => f.serverTimeMs - later[i]!.serverTimeMs);
        expect(gaps.length).toBeGreaterThanOrEqual(3);
        for (const g of gaps) {
          expect(g).toBeGreaterThanOrEqual(1_000 - 50);
          expect(g).toBeLessThanOrEqual(1_000 + 100 + 50);
        }
        expect(await gaugeOf('realtime_gw_buffer_slow_connections')).toBe(1);

        // 버퍼가 빈 뒤(다시 받은 뒤) 차례 30번(30초 근처) 뒤 BatchInterval 100. 받기를 멈춘 동안은 버퍼가 64KiB 아래로 내려가지 않으므로 30초 전에는 오지 않는다.
        // 차례 30번은 다시 받은 뒤 첫 낮은 차례(1초 안)부터 세므로 위 허용 폭은 30,000 + 1,500ms다(RF-T12)
        await slow.next(isInterval(100), 40_000, i1000 + 1);
        const back = Date.now() - resumedAt;
        expect(back).toBeGreaterThanOrEqual(30_000 - 50);
        expect(back).toBeLessThanOrEqual(30_000 + 1_500);
        expect(await gaugeOf('realtime_gw_buffer_slow_connections')).toBe(0);
        // 되돌린 뒤 묶음은 100ms 박자에 온다(보내는 쪽 타이머가 박자 하나둘을 비울 수 있어 300ms 안쪽으로 본다. 1초 간격이면 950ms 이상이다)
        // 맺은 때의 첫 BatchInterval 100(0번)이 아니라 1000 알림 뒤의 100을 찾는다(RF-T12, CI 실패 PR #27)
        const i100 = slow.frames().findIndex((f, i) => i > i1000 && isInterval(100)(f));
        expect(i100).toBeGreaterThan(i1000);
        await sleep(800);
        const after = slow.frames().slice(i100 + 1).filter(isDelta);
        expect(after.length).toBeGreaterThanOrEqual(3);
        for (let i = 1; i < after.length; i++) expect(after[i]!.serverTimeMs - after[i - 1]!.serverTimeMs).toBeLessThanOrEqual(300);
      } finally {
        publishing = false;
        await smallLoop;
      }
      // 받는 연결은 처음의 100 말고 BatchInterval을 받지 않았고 묶음을 이어 받았다
      expect(fast.frames().filter(isBatchInterval).map((f) => f.intervalMs)).toEqual([100]);
      expect(fast.frames().filter(isDelta).length).toBeGreaterThan(30);
      expect(await gaugeOf('realtime_gw_degraded')).toBe(0);
    },
    120_000,
  );

  test('S-T31 ② 실제 소켓으로 1초 안에 SubscribeSections 셋(0·300·600ms)을 보내면 셋째에 4429 too many다(맺은 뒤 첫 구독도 센다) [ASVS v5.0.0-2.4.1]', async () => {
    // 정본 경계(0·500·999ms)는 단위 시험(hub)이 가짜 시계로 본다. 실제 소켓은 타이머 지연이 있어 창 안쪽 값으로 본다
    const c = await open();
    c.send(subscribeBytes([1]));
    await sleep(300);
    c.send(subscribeBytes([2]));
    await sleep(300);
    c.send(subscribeBytes([3]));
    expect(await Promise.race([c.closed, sleep(3_000).then(() => 'still open' as const)])).toEqual({ code: 4429, reason: 'too many' });
  });
});

describe('S-T42 ③ ⑮ ⑯ 닫힘 이유 글(ADR-0297 결정 8, RF-T13)', () => {
  test("S-T42 ③ ⑮ ⑯ 실제 소켓의 닫힘 이유 글은 frontend §4.4.1 '닫힘 이유 글'과 글자 그대로 같다: bad event·bad frame·bad section·too many·token expired [ASVS v5.0.0-1.3.7]", async () => {
    const wait = (c: Client) => Promise.race([c.closed, sleep(5_000).then(() => 'still open' as const)]);
    const badEvent = connect(svc.url(streamPath('ev-1')), { token: admissionToken({ eventId: 'ev-2' }) });
    clients.push(badEvent);
    const badFrame = await open();
    badFrame.send(Uint8Array.from([1, 17, 3, 0, 97, 98, 99]));
    const badSection = await open();
    badSection.send(subscribeBytes([20]));
    const tooMany = await open();
    tooMany.send(subscribeBytes(Array.from({ length: 17 }, (_, i) => i)));
    const nowS = Math.floor(Date.now() / 1000);
    const expired = await open('ev-1', { token: admissionToken({ claims: { iat: nowS, exp: nowS + 2 } }) });
    expect(await Promise.all([badEvent, badFrame, badSection, tooMany, expired].map(wait))).toEqual([
      { code: 4403, reason: 'bad event' },
      { code: 4403, reason: 'bad frame' },
      { code: 4403, reason: 'bad section' },
      { code: 4429, reason: 'too many' },
      { code: 4401, reason: 'token expired' },
    ]);
  });
});

describe('S-T42 ⑫ 내릴 때', () => {
  test('S-T42 ⑫ close()(SIGTERM과 같은 길)에 모든 연결이 1012 server restart로 닫히고 내리는 중의 새 핸드셰이크는 503이다 [ASVS v5.0.0-1.3.7]', async () => {
    const a = await open();
    const b = await open('ev-2');
    a.send(subscribeBytes([1]));
    // 닫기 인사에 답하지 않는 연결 하나를 둬 내리는 동안을 늘린다
    let raw: import('node:net').Socket | undefined;
    const rawFrames: Buffer[] = [];
    const h = await handshake(svc.ports.app, streamPath('ev-1'), { origin: ORIGIN, protocols: [SEATS, AUTH + admissionToken()] }, (s) => {
      raw = s;
      s.on('data', (d: Buffer) => rawFrames.push(d));
    });
    expect(h.status).toBe(101);
    await sleep(100);
    const closing = svc.close();
    await sleep(100);
    const during = await handshake(svc.ports.app, streamPath('ev-1'), { origin: ORIGIN, protocols: [SEATS, AUTH + admissionToken()] });
    expect(during.status).toBe(503);
    expect(during.body).toBe('');
    const [ca, cb] = await Promise.all([a.closed, b.closed]);
    expect([ca, cb]).toEqual([
      { code: 1012, reason: 'server restart' },
      { code: 1012, reason: 'server restart' },
    ]);
    await closing;
    // 답하지 않은 연결도 닫힘 프레임(opcode 8)에 1012를 받았다
    const bytes = Buffer.concat(rawFrames);
    const at = bytes.indexOf(0x88);
    expect(at).toBeGreaterThanOrEqual(0);
    expect(bytes.readUInt16BE(at + 2)).toBe(1012);
    raw?.destroy();
  });
});
