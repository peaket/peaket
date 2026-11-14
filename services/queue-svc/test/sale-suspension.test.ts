// 판매 중지·재개의 대기열 사본(BAT-465 R-584, ADR-0123) 단위·HTTP 시험.
// notice와 ctl에 같은 칸(suspended·suspRev·suspCmd)을 쓰고, 다른 칸(판매 상태·공지)을 건드리지 않는지 본다.
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { createService, fakeClock } from '@peaket/platform';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { MemoryEventSchedules } from '../src/modules/entry/adapters/memory-entry-store.js';
import { MemorySaleSuspensionCopies, SetSaleSuspensionCopy } from '../src/modules/sale/index.js';
import { recordingRisk, tokens } from './support.js';

const NOW = Date.parse('2026-11-14T09:00:00.000Z');
const quiet = new Writable({ write: (_c, _e, cb) => cb() });

describe('BAT-465 판매 중지·재개 대기열 사본', () => {
  test('R584_중지와_재개가_notice와_ctl에_같은_칸을_쓴다', async () => {
    const copies = new MemorySaleSuspensionCopies();
    const service = new SetSaleSuspensionCopy(copies);
    const eventId = randomUUID();
    const stopId = randomUUID();
    expect(await service.run({ eventId, action: 'SUSPEND', commandId: stopId, revision: 3 })).toEqual({ eventId, suspended: true, revision: 3 });
    expect(copies.written.get(eventId)?.notice).toEqual({ suspended: '1', suspRev: '3', suspCmd: stopId });
    expect(copies.written.get(eventId)?.ctl).toEqual({ suspended: '1', suspRev: '3', suspCmd: stopId });
    const resumeId = randomUUID();
    expect(await service.run({ eventId, action: 'RESUME', commandId: resumeId, revision: 4 })).toEqual({ eventId, suspended: false, revision: 4 });
    expect(copies.written.get(eventId)?.notice).toMatchObject({ suspended: '0', suspRev: '4', suspCmd: resumeId });
  });
});

describe('BAT-465 판매 중지·재개 대기열 내부 HTTP', () => {
  let svc: Awaited<ReturnType<typeof createService>>;
  const copies = new MemorySaleSuspensionCopies();
  beforeAll(async () => {
    svc = await createService({
      name: 'queue-svc-sale-suspension',
      module: AppModule.register({ memory: true, schedules: new MemoryEventSchedules(), tokens, risk: recordingRisk(), saleSuspension: copies }),
      env: { PEAKET_ENV: 'ci' },
      clock: fakeClock({ now: NOW }),
      logDestination: quiet,
    });
  });
  afterAll(async () => {
    await svc?.close();
  });

  const post = (eventId: string, body: unknown) =>
    svc.http.inject({ method: 'POST', url: `/internal/v1/event-sales/${eventId}/suspensions`, headers: { 'content-type': 'application/json' }, payload: JSON.stringify(body) });

  test('R584_HTTP_중지가_사본을_쓰고_답한다', async () => {
    const eventId = randomUUID();
    const commandId = randomUUID();
    const r = await post(eventId, { action: 'SUSPEND', commandId, reason: '판매자 신원 확인', revision: 1 });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.payload)).toEqual({ eventId, suspended: true, revision: 1 });
    expect(copies.written.get(eventId)?.notice.suspended).toBe('1');
    expect(copies.written.get(eventId)?.ctl.suspended).toBe('1');
  });

  test('R584_본문이_틀리면_400이다', async () => {
    const eventId = randomUUID();
    expect((await post(eventId, { action: 'PAUSE', commandId: randomUUID() })).statusCode).toBe(400);
    expect((await post(eventId, { action: 'SUSPEND', commandId: 'not-a-uuid' })).statusCode).toBe(400);
    expect((await post('not-a-uuid', { action: 'SUSPEND', commandId: randomUUID() })).statusCode).toBe(400);
  });
});
