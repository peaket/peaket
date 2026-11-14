// 판매 중지·재개 사본(BAT-465 R-584, ADR-0123) 단위·HTTP 시험.
// 원본 표(sale_control)의 판 번호가 같은 명령의 재시도에서 늘지 않고, 좌석 Redis 사본(s:{event:E}:ctl)이 같은 값을 받는지 본다.
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { createService, fakeClock } from '@peaket/platform';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { MemoryPurchaseSessions } from '../src/modules/inventory/index.js';
import { MemorySaleControlCopies, MemorySaleControlStore, SetSaleSuspension } from '../src/modules/sale-control/index.js';

const NOW = Date.parse('2026-11-14T09:00:00.000Z');
const quiet = new Writable({ write: (_c, _e, cb) => cb() });
const clock = fakeClock({ now: NOW });

const fixture = () => {
  const store = new MemorySaleControlStore();
  const copies = new MemorySaleControlCopies();
  return { store, copies, service: new SetSaleSuspension(store, copies) };
};

describe('BAT-465 판매 중지·재개 사본', () => {
  test('R584_중지는_판_1과_suspended_1을_쓰고_재개는_판_2와_0을_쓴다', async () => {
    const f = fixture();
    const eventId = randomUUID();
    const stopId = randomUUID();
    const stop = await f.service.run({ eventId, action: 'SUSPEND', commandId: stopId, reason: '판매자 신원 확인', suspensionRef: 'AP-1', nowMs: NOW });
    expect(stop).toEqual({ eventId, suspended: true, revision: 1, changed: true });
    expect(f.copies.written.get(eventId)).toMatchObject({ suspended: '1', rev: '1', cmd: stopId, suspRef: 'AP-1' });
    const resumeId = randomUUID();
    const resume = await f.service.run({ eventId, action: 'RESUME', commandId: resumeId, reason: '신원 확인 끝', nowMs: NOW + 1000 });
    expect(resume).toEqual({ eventId, suspended: false, revision: 2, changed: true });
    expect(f.copies.written.get(eventId)).toMatchObject({ suspended: '0', rev: '2', cmd: resumeId });
    // 재개는 승인 업무 ID를 지우지 않는다(마지막 중지의 흔적)
    expect(f.copies.written.get(eventId)?.suspRef).toBe('AP-1');
  });

  test('R584_같은_명령의_재시도는_판_번호를_올리지_않고_사본은_다시_쓴다', async () => {
    const f = fixture();
    const eventId = randomUUID();
    const commandId = randomUUID();
    const input = { eventId, action: 'SUSPEND' as const, commandId, reason: '사기 의심', nowMs: NOW };
    expect((await f.service.run(input)).revision).toBe(1);
    f.copies.written.clear();
    const again = await f.service.run({ ...input, nowMs: NOW + 5000 });
    expect(again).toMatchObject({ suspended: true, revision: 1, changed: false });
    // 앞선 시도가 Redis에 못 썼어도 재시도가 다시 쓴다
    expect(f.copies.written.get(eventId)).toMatchObject({ suspended: '1', rev: '1', cmd: commandId });
  });

  test('R584_상태_읽기는_행이_없으면_정지가_아니다', async () => {
    const f = fixture();
    const eventId = randomUUID();
    expect(await f.service.state(eventId)).toEqual({ eventId, suspended: false, revision: 0 });
    await f.service.run({ eventId, action: 'SUSPEND', commandId: randomUUID(), reason: '법적 요청', nowMs: NOW });
    expect(await f.service.state(eventId)).toEqual({ eventId, suspended: true, revision: 1 });
  });
});

describe('BAT-465 판매 중지·재개 내부 HTTP', () => {
  let svc: Awaited<ReturnType<typeof createService>>;
  const store = new MemorySaleControlStore();
  const copies = new MemorySaleControlCopies();
  const sessions = new MemoryPurchaseSessions();
  beforeAll(async () => {
    svc = await createService({
      name: 'purchase-svc',
      module: AppModule.register({ memory: true, sessions, saleControl: { store, copies } }),
      purchaseSessions: sessions,
      env: { PEAKET_ENV: 'ci' },
      clock,
      logDestination: quiet,
    });
  });
  afterAll(async () => {
    await svc?.close();
  });

  const post = (eventId: string, body: unknown) =>
    svc.http.inject({ method: 'POST', url: `/internal/v1/event-sales/${eventId}/suspensions`, headers: { 'content-type': 'application/json' }, payload: JSON.stringify(body) });

  test('R584_HTTP_중지와_재개가_사본을_쓰고_상태를_돌려준다', async () => {
    const eventId = randomUUID();
    const commandId = randomUUID();
    const stop = await post(eventId, { action: 'SUSPEND', commandId, reason: '판매자 신원 확인', suspensionRef: 'AP-9' });
    expect(stop.statusCode).toBe(200);
    expect(JSON.parse(stop.payload)).toEqual({ eventId, suspended: true, revision: 1, changed: true });
    const state = await svc.http.inject({ method: 'GET', url: `/internal/v1/event-sales/${eventId}/suspensions` });
    expect(state.statusCode).toBe(200);
    expect(JSON.parse(state.payload)).toEqual({ eventId, suspended: true, revision: 1 });
    const resume = await post(eventId, { action: 'RESUME', commandId: randomUUID(), reason: '확인 끝' });
    expect(JSON.parse(resume.payload)).toMatchObject({ suspended: false, revision: 2 });
  });

  test('R584_본문이_틀리면_400이다', async () => {
    const eventId = randomUUID();
    expect((await post(eventId, { action: 'PAUSE', commandId: randomUUID(), reason: 'x' })).statusCode).toBe(400);
    expect((await post(eventId, { action: 'SUSPEND', commandId: 'not-a-uuid', reason: 'x' })).statusCode).toBe(400);
    expect((await post('not-a-uuid', { action: 'SUSPEND', commandId: randomUUID(), reason: 'x' })).statusCode).toBe(400);
  });
});
