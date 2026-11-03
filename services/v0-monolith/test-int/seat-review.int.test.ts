// 새 맥락 코드 리뷰가 찾은 좌석 v0 결함의 재현 시험(docs/architecture.md §8.6의 3).
// ① 변경분 연결이 열려 있으면 서비스 닫기가 끝나지 않았다 ② 거절한 업그레이드의 서버 쪽 소켓이 남았다
// ③ 처음 온 계정의 한도 초과(422)가 보유 수 행을 남겼다(§14 동작 2 '아무것도 바꾸지 않고') ④ 변경분 받기(LISTEN) 연결이 끊긴 동안의
// 변경분을 잃어도 브라우저가 몰랐다(§14 동작 6 '브라우저는 다시 연결할 때 좌석 목록을 다시 받는다'가 일어나지 않음)
import 'reflect-metadata';
import net from 'node:net';
import { Writable } from 'node:stream';
import { createService, fakeClock } from '@peaket/platform';
import { afterAll, beforeAll, expect, test } from 'vitest';
import WebSocket from 'ws';
import { AppModule } from '../src/app.module.js';
import { fanHeaders } from './queue-harness.js';
import { ALLOWED_ORIGIN, SeatHarness, ids } from './seat-harness.js';

let h: SeatHarness;

beforeAll(async () => {
  h = await SeatHarness.start();
});

afterAll(async () => {
  await h?.close();
});

const quiet = () => new Writable({ write: (_c, _e, cb) => cb() });

async function within<T>(ms: number, p: Promise<T>): Promise<{ done: boolean; ms: number }> {
  const t0 = performance.now();
  let timer: NodeJS.Timeout | undefined;
  const guard = new Promise<'guard'>((r) => (timer = setTimeout(() => r('guard'), ms)));
  const v = await Promise.race([p.then(() => 'done' as const, () => 'done' as const), guard]);
  clearTimeout(timer);
  return { done: v === 'done', ms: performance.now() - t0 };
}

test('FR009_ST12_변경분연결이열려있어도_서비스닫기가곧끝나고연결을닫는다', async () => {
  // 입장 확인은 이 시험의 대상이 아니라 늘 입장한 것으로 둔다. 받기 연결은 운영(main.ts)처럼 먼저 연다
  await h.feedReady();
  const svc = await createService({
    name: 'v0-monolith',
    module: AppModule.register({
      queue: { redis: { sendCommand: async () => null }, tickIntervalMs: false },
      inventory: { database: h.database, admission: { isAdmitted: async () => true }, deltaFeed: h.deltaFeed, allowedOrigins: [ALLOWED_ORIGIN], expiryIntervalMs: false },
    }),
    env: { PEAKET_ENV: 'ci', PORT: '0', PEAKET_MANAGEMENT_PORT: '0' },
    clock: fakeClock(),
    logDestination: quiet(),
  });
  const { port } = await svc.listen('127.0.0.1');
  const ws = new WebSocket(`ws://127.0.0.1:${port}/v0/events/shutdown-1/seat-deltas`, { headers: fanHeaders('ps1'), origin: ALLOWED_ORIGIN });
  await new Promise<void>((ok, no) => {
    ws.once('open', () => ok());
    ws.once('error', no);
  });
  const closed = new Promise<number>((ok) => ws.once('close', (code) => ok(code)));
  const r = await within(5_000, svc.close());
  if (!r.done) ws.terminate();
  expect(r.done, `서비스 닫기가 5초 안에 끝나지 않았다(${Math.round(r.ms)}ms)`).toBe(true);
  expect(r.ms).toBeLessThan(3_000);
  expect(await closed).toBeGreaterThan(0);
});

test('ST12_거절한업그레이드는_클라이언트가닫지않아도서버가소켓을닫는다 [ASVS v5.0.0-4.4.2]', async () => {
  const socket = net.connect(h.port, '127.0.0.1');
  await new Promise<void>((ok) => socket.once('connect', () => ok()));
  let response = '';
  socket.on('data', (d) => (response += String(d)));
  const ended = new Promise<void>((ok) => socket.once('close', () => ok()));
  // 신원 머리가 없는 업그레이드(401). 클라이언트는 쓰기만 하고 닫지 않는다
  socket.write(
    'GET /v0/events/any-1/seat-deltas HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n',
  );
  const r = await within(2_000, ended);
  socket.destroy();
  expect(response.startsWith('HTTP/1.1 401')).toBe(true);
  expect(r.done, '서버가 2초 안에 소켓을 닫지 않았다').toBe(true);
});

test('POL011_처음온계정의한도초과는_보유수행도남기지않는다 [ASVS v5.0.0-2.3.4]', async () => {
  const eventId = await h.openEvent(ids('Q', 5), { perPersonLimit: 2 });
  await h.admit(eventId, ['pq1']);
  const r = await h.hold(eventId, ids('Q', 3), fanHeaders('pq1', { account: 'acc-q1' }));
  expect(r.status).toBe(422);
  expect(await h.quotaRows(eventId)).toEqual([]);
});

// 이 시험은 변경분 받기 연결을 끊으므로 마지막에 둔다(받기 연결은 1초 뒤 다시 붙는다)
test('ST12_변경분받기연결이끊기면_열린변경분연결을닫아브라우저가다시받게한다', async () => {
  await h.feedReady(); // 운영(main.ts)처럼 받기 연결을 먼저 연다
  const eventId = await h.openEvent(ids('G', 2));
  await h.admit(eventId, ['pg1']);
  const { ws } = await h.openDeltas(eventId, fanHeaders('pg1'));
  const closed = new Promise<void>((ok) => ws.once('close', () => ok()));
  await h.inspect.query(
    `select pg_terminate_backend(pid) from pg_stat_activity where pid <> pg_backend_pid() and query ilike 'LISTEN%v0_seat_delta%'`,
  );
  const r = await within(5_000, closed);
  expect(r.done, '받기 연결이 끊겼는데 변경분 연결이 5초 안에 닫히지 않았다').toBe(true);
});

// 2차 리뷰: 받기 연결이 끊겨 다시 듣기 전에는 새 변경분 연결을 받지 않는다(받으면 그동안의 변경분을 잃은 채 낡은 화면이 남는다)
test('ST12_변경분받기연결이다시듣기전에는_새변경분연결을503으로거절하고다시들으면받는다', async () => {
  await h.feedReady();
  // 앞 시험이 끊은 받기 연결이 다시 붙을 때까지 기다린다
  await new Promise((r) => setTimeout(r, 2_500));
  const eventId = await h.openEvent(ids('R', 2));
  await h.admit(eventId, ['pr1']);
  await h.inspect.query(`select pg_terminate_backend(pid) from pg_stat_activity where pid <> pg_backend_pid() and query ilike 'LISTEN%v0_seat_delta%'`);
  await new Promise((r) => setTimeout(r, 150));
  const during = await h.connect(h.deltaPath(eventId), fanHeaders('pr1'), ALLOWED_ORIGIN);
  expect(during).toMatchObject({ kind: 'rejected', status: 503 });
  // 다시 붙은 뒤(1초 간격)에는 받는다
  let after = during;
  for (let i = 0; i < 40 && after.kind !== 'open'; i += 1) {
    await new Promise((r) => setTimeout(r, 250));
    after = await h.connect(h.deltaPath(eventId), fanHeaders('pr1'), ALLOWED_ORIGIN);
  }
  expect(after.kind).toBe('open');
});
