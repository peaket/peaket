// 회차 취소 요청의 판정 기한 judgementDueAt(F-06-2 GAT-280, R-T50 ⑤). 시험 담당 lane3-f062-test.
// 실제 ops-svc 조립(메모리)에 파트너 회차 취소 요청을 HTTP로 넣고, 상태 응답과 CS '판정 대기' 건의 기한을 본다.
// 정본: docs/features/transfer-refund.md §11 R-T50 ⑤(REQUESTED 응답의 judgementDueAt이 요청 + 1영업일, 판정 뒤 null),
// ADR-0364 결정 2(JUDGEMENT_PENDING은 요청 시각 + 1영업일, judgementDueAt도 같은 달력), openapi PartnerEventCancellation.judgementDueAt.
// 공휴일은 시험이 만든 날(2026-11-25 수)이다.
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { createService, fakeClock } from '@peaket/platform';
import { afterEach, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import type { EventOwnerLookup, EventRefundReader, EventRefundStarter, EventSaleStopper } from '../src/modules/event-cancellations/index.js';
import { DRY_RUN, JOB, TENANT, fakeReauth, okHolds } from './event-cancellation-fixtures.js';
import { testCalendar } from './cs-support.js';
import { FakeIdentity, quiet } from './support.js';

const CANCEL = { kind: 'CANCEL', reason: '공연장 대관 취소', faultOpinion: 'FORCE_MAJEURE', evidenceRef: '공연장 대관 취소 통지 제2026-118호 2026-11-15' };
let svc: Awaited<ReturnType<typeof createService>> | undefined;
afterEach(async () => {
  await svc?.close();
  svc = undefined;
});

async function boot(nowIso: string) {
  const identity = new FakeIdentity();
  const owned = new Map<string, { promoterId: string; startsAtMs: number; endsAtMs: number }>();
  const owners: EventOwnerLookup = { find: async (eventId) => owned.get(eventId) };
  const refunds: EventRefundStarter = {
    start: async (i) => ({ jobId: i.requestId, state: 'RUNNING' }),
    pause: async (i) => ({ jobId: i.requestId, state: 'PAUSED' }),
    resume: async (i) => ({ jobId: i.requestId, state: 'RUNNING' }),
  };
  const reader: EventRefundReader = { preview: async () => DRY_RUN, job: async () => JOB };
  const stopper: EventSaleStopper = { stop: async () => undefined };
  const clock = fakeClock({ now: Date.parse(nowIso) });
  svc = await createService({
    name: 'ops-svc',
    module: AppModule.register({ memory: true, calendar: testCalendar(), eventCancellations: { refunds, reauth: fakeReauth(), reader, stopper, owners, holds: okHolds() } }),
    env: { PEAKET_ENV: 'ci' },
    clock,
    logDestination: quiet(),
    adminAuthz: identity,
  });
  const s = svc;
  const partner = identity.partner(TENANT);
  const eventId = randomUUID();
  const startsAtMs = clock.now() + 10 * 86_400_000;
  owned.set(eventId, { promoterId: TENANT, startsAtMs, endsAtMs: startsAtMs + 3 * 3_600_000 });
  const url = `/v1/partner/events/${eventId}/cancellation`;
  const json = (r: { payload: string }) => JSON.parse(r.payload) as Record<string, unknown>;
  return {
    clock,
    async request() {
      const r = await s.http.inject({ method: 'POST', url, headers: { ...partner, 'idempotency-key': randomUUID(), 'content-type': 'application/json' }, payload: JSON.stringify(CANCEL) });
      expect(r.statusCode, r.payload).toBe(202);
      return json(r);
    },
    status: async () => json(await s.http.inject({ method: 'GET', url, headers: partner })),
    async judge(requestId: string) {
      const r = await s.http.inject({
        method: 'POST',
        url: `/v1/ops/event-cancellations/${requestId}/judgement`,
        headers: { ...identity.ops('commander'), 'content-type': 'application/json' },
        payload: JSON.stringify({ fault: 'ORGANIZER', reason: '주최 측 귀책', fanNoticeReason: '공연이 취소되었습니다' }),
      });
      expect(r.statusCode, r.payload).toBe(200);
    },
    async judgementCase(requestId: string) {
      const r = await s.http.inject({ method: 'GET', url: '/v1/ops/cases?kind=JUDGEMENT_PENDING', headers: identity.ops('cs_lead') });
      return (json(r).items as Array<Record<string, unknown>>).filter((i) => i.targetRef === requestId);
    },
  };
}

describe('R-T50 ⑤ 회차 취소 요청의 판정 기한', () => {
  test('R-T50 ⑤ 금요일 23:30 KST에 접수한 요청의 judgementDueAt은 주말을 건넌 월요일 23:30 KST이고 판정 대기 건의 기한과 같다', async () => {
    const b = await boot('2026-11-20T14:30:00.000Z');
    const req = await b.request();
    expect(req).toMatchObject({ status: 'REQUESTED' });
    expect(await b.status()).toMatchObject({ requestId: req.requestId, status: 'REQUESTED', judgementDueAt: '2026-11-23T14:30:00.000Z' });
    expect((await b.judgementCase(req.requestId as string)).map((c) => [c.status, c.resultDueAt])).toEqual([['OPEN', '2026-11-23T14:30:00.000Z']]);
  });

  test('R-T50 ⑤ 공휴일 앞날(화 10:00 KST)에 접수하면 공휴일(수)을 건너 목 10:00 KST이고, 판정 뒤에는 null이다', async () => {
    const b = await boot('2026-11-24T01:00:00.000Z');
    const req = await b.request();
    // 접수 뒤 시간이 지나도 기한은 요청 시각에서 센 값이다
    b.clock.advance(5 * 3_600_000);
    expect(await b.status()).toMatchObject({ status: 'REQUESTED', judgementDueAt: '2026-11-26T01:00:00.000Z' });
    await b.judge(req.requestId as string);
    expect(await b.status()).toMatchObject({ status: 'PENDING_APPROVAL', judgementDueAt: null });
  });
});
