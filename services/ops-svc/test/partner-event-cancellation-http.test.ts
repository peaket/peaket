// /v1/partner/events/{eventId}/cancellation HTTP(메모리 조립, BAT-420 GAT-110 P, R-T36). 소속은 세션 테넌트와 core 판매 설정만 본다.
// 시험 담당이 구현 전에 썼다(ADR-0270).
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { createService, fakeClock } from '@peaket/platform';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import type { EventOwnerLookup, EventRefundReader, EventRefundStarter, EventSaleStopper } from '../src/modules/event-cancellations/index.js';
// RV-01: 화면이 보는 응답은 이 파일이 실제 HTTP로 받은 것이다(시험 안에서 모양을 흉내 내지 않는다).
import { detailView } from '../../../apps/console-host/src/pages/cancellation/model/live.js';
import { DRY_RUN, JOB, NOW, OTHER_TENANT, TENANT, fakeReauth, okHolds, tokenFor } from './event-cancellation-fixtures.js';
import { FakeIdentity, quiet } from './support.js';

const identity = new FakeIdentity();
const ownersAnswer = new Map<string, { promoterId: string; startsAtMs: number; endsAtMs?: number; title?: string } | 'throw'>();
const ownerCalls: string[] = [];
const owners: EventOwnerLookup = {
  find: async (eventId) => {
    ownerCalls.push(eventId);
    const v = ownersAnswer.get(eventId);
    if (v === 'throw') throw new Error('core down');
    return v;
  },
};
const refunds: EventRefundStarter = {
  start: async (i) => ({ jobId: i.requestId, state: 'RUNNING' }),
  pause: async (i) => ({ jobId: i.requestId, state: 'PAUSED' }),
  resume: async (i) => ({ jobId: i.requestId, state: 'RUNNING' }),
};
const reader: EventRefundReader = { preview: async () => DRY_RUN, job: async () => JOB };
const stopper: EventSaleStopper = { stop: async () => undefined };
let svc: Awaited<ReturnType<typeof createService>>;

beforeAll(async () => {
  svc = await createService({
    name: 'ops-svc',
    module: AppModule.register({ memory: true, eventCancellations: { refunds, reauth: fakeReauth(), reader, stopper, owners, holds: okHolds() } }),
    env: { PEAKET_ENV: 'ci' },
    clock: fakeClock({ now: NOW }),
    logDestination: quiet(),
    adminAuthz: identity,
  });
});
afterAll(async () => {
  await svc?.close();
});

type Headers = Record<string, string>;
const url = (eventId: string) => `/v1/partner/events/${eventId}/cancellation`;
const post = (eventId: string, headers: Headers, body: unknown, key: string | null = randomUUID()) =>
  svc.http.inject({ method: 'POST', url: url(eventId), headers: { ...headers, ...(key !== null ? { 'idempotency-key': key } : {}), 'content-type': 'application/json' }, payload: JSON.stringify(body) });
const get = (path: string, headers: Headers) => svc.http.inject({ method: 'GET', url: path, headers });
const json = (r: { payload: string }) => JSON.parse(r.payload) as Record<string, unknown>;
const own = (promoterId: string = TENANT): string => {
  const eventId = randomUUID();
  const startsAtMs = NOW + 10 * 86_400_000;
  ownersAnswer.set(eventId, { promoterId, startsAtMs, endsAtMs: startsAtMs + 3 * 3_600_000, title: `LUMEN 콘서트 ${eventId.slice(0, 8)}` });
  return eventId;
};
const CANCEL = { kind: 'CANCEL', reason: '공연장 대관 취소', faultOpinion: 'FORCE_MAJEURE', evidenceRef: '공연장 대관 취소 통지 제2026-118호 2026-11-15' };

describe('/v1/partner/events/{eventId}/cancellation [BAT-420 GAT-110 P]', () => {
  test('R-T36 ① 파트너 관리자의 취소 요청은 202 REQUESTED다(HTTP)', async () => {
    const eventId = own();
    const r = await post(eventId, identity.partner(TENANT), CANCEL);
    expect(r.statusCode).toBe(202);
    expect(json(r)).toMatchObject({ eventId, kind: 'CANCEL', status: 'REQUESTED' });
  });

  test('R-T36 ② 실무자는 요청 403이고 상태 보기는 200이다', async () => {
    const eventId = own();
    const calls = ownerCalls.length;
    const member = identity.partner(TENANT, 'partner_member');
    const denied = await post(eventId, member, CANCEL);
    expect(denied.statusCode).toBe(403);
    // RV-02: 화면이 d5 §6.12 문구와 버튼 끔을 고를 수 있게 역할 실패를 붙은 이름의 Problem으로 답한다(about:blank가 아니다)
    expect(json(denied).type).toMatch(/(^|\/)partner-admin-required$/);
    expect(ownerCalls.length).toBe(calls);
    expect((await post(eventId, identity.partner(TENANT), CANCEL)).statusCode).toBe(202);
    const status = await get(url(eventId), member);
    expect(status.statusCode).toBe(200);
    expect(json(status)).toMatchObject({ eventId, status: 'REQUESTED' });
  });

  test('R-T36 ③ [ASVS v5.0.0-8.2.2] 다른 파트너 회차와 판매 승인 전 회차는 같은 404이고 core가 답하지 않으면 503이다(HTTP)', async () => {
    const admin = identity.partner(TENANT);
    const others = own(OTHER_TENANT);
    const unapproved = randomUUID();
    const a = await post(others, admin, CANCEL);
    const b = await post(unapproved, admin, CANCEL);
    expect(a.statusCode).toBe(404);
    expect(b.statusCode).toBe(404);
    const pick = (x: Record<string, unknown>) => ({ type: x.type, status: x.status, title: x.title });
    expect(json(a).type).toMatch(/not-found$/);
    expect(pick(json(b))).toEqual(pick(json(a)));
    const ga = await get(url(others), admin);
    const gb = await get(url(unapproved), admin);
    expect(ga.statusCode).toBe(404);
    expect(pick(json(gb))).toEqual(pick(json(ga)));
    const broken = randomUUID();
    ownersAnswer.set(broken, 'throw');
    const c = await post(broken, admin, CANCEL);
    expect(c.statusCode).toBe(503);
    expect(json(c).type).toMatch(/authz-unavailable$/);
    expect((await get(url(broken), admin)).statusCode).toBe(503);
  });

  test('R-T36 ⑥ 취소에 바뀐 일시를 보내면 400이고 연기에 일시가 없으면 422 postponement-date-invalid다(HTTP)', async () => {
    const admin = identity.partner(TENANT);
    expect((await post(own(), admin, { ...CANCEL, newStartsAt: new Date(NOW + 20 * 86_400_000).toISOString() })).statusCode).toBe(400);
    const p = await post(own(), admin, { kind: 'POSTPONE', reason: '연기' });
    expect(p.statusCode).toBe(422);
    expect(json(p).type).toMatch(/postponement-date-invalid$/);
  });

  test('R-T36 ⑦ 파트너 요청에 Idempotency-Key가 없으면 400 idempotency-key-invalid이고 같은 키·같은 본문은 같은 요청 ID다(HTTP)', async () => {
    const admin = identity.partner(TENANT);
    const eventId = own();
    const missing = await post(eventId, admin, CANCEL, null);
    expect(missing.statusCode).toBe(400);
    expect(json(missing).type).toMatch(/idempotency-key-invalid$/);
    const key = randomUUID();
    const a = await post(eventId, admin, CANCEL, key);
    const b = await post(eventId, admin, CANCEL, key);
    expect(a.statusCode).toBe(202);
    expect(b.statusCode).toBe(202);
    expect(json(b).requestId).toBe(json(a).requestId);
    const c = await post(eventId, admin, { ...CANCEL, evidenceRef: '다른 공문' }, key);
    expect(c.statusCode).toBe(422);
    expect(json(c).type).toMatch(/idempotency-key-reused$/);
  });

  test('R-T36 ⑧ 상태 응답은 미리보기·결제사별 몫·판정자·내부 판정 사유를 싣지 않고 no-store다(HTTP)', async () => {
    const admin = identity.partner(TENANT);
    const eventId = own();
    const created = await post(eventId, admin, CANCEL);
    const requestId = json(created).requestId as string;
    const commander = identity.ops('commander');
    const judged = await svc.http.inject({
      method: 'POST',
      url: `/v1/ops/event-cancellations/${requestId}/judgement`,
      headers: { ...commander, 'content-type': 'application/json' },
      payload: JSON.stringify({ fault: 'ORGANIZER', reason: '내부 판정 메모', fanNoticeReason: '공연이 취소되었습니다' }),
    });
    expect(json(judged).status).toBe('PENDING_APPROVAL');
    const status = await get(url(eventId), admin);
    expect(status.statusCode).toBe(200);
    expect(status.headers['cache-control']).toBe('no-store');
    const body = json(status);
    expect(body).toMatchObject({ requestId, status: 'PENDING_APPROVAL', fault: 'ORGANIZER', judgementSummary: '공연이 취소되었습니다', judgementDueAt: null });
    for (const key of ['dryRun', 'perPg', 'judgedBy', 'judgementReason']) expect(body).not.toHaveProperty(key);
    expect(status.payload).not.toContain('내부 판정 메모');
    expect(status.payload).not.toContain(commander['x-user-id']);
  });

  test('RV-01 관제 상세 HTTP 응답은 openapi의 judgedBy(OpsActor)·title·partnerReason·faultOpinion·evidenceRef·newStartsAt을 싣고 화면이 그대로 읽는다', async () => {
    const admin = identity.partner(TENANT);
    const eventId = own();
    const starts = new Date(NOW + 25 * 86_400_000).toISOString();
    const created = await post(eventId, admin, { kind: 'POSTPONE', reason: '공연장 화재', evidenceRef: '소방서 통보 2026-77호', faultOpinion: 'FORCE_MAJEURE', newStartsAt: starts });
    expect(created.statusCode).toBe(202);
    const requestId = json(created).requestId as string;
    const commander = identity.ops('commander');
    const judged = await svc.http.inject({
      method: 'POST',
      url: `/v1/ops/event-cancellations/${requestId}/judgement`,
      headers: { ...commander, 'content-type': 'application/json' },
      payload: JSON.stringify({ fault: 'FORCE_MAJEURE', reason: '불가항력', fanNoticeReason: '공연이 연기되었습니다' }),
    });
    expect(judged.statusCode).toBe(200);

    const body = json(await get(`/v1/ops/event-cancellations/${requestId}`, identity.ops('operator')));
    const answer = ownersAnswer.get(eventId);
    const title = typeof answer === 'object' ? answer.title : undefined;
    expect(body).toMatchObject({
      requestId,
      title,
      partnerReason: '공연장 화재',
      faultOpinion: 'FORCE_MAJEURE',
      evidenceRef: '소방서 통보 2026-77호',
      newStartsAt: starts,
    });
    expect(body.judgedBy).toEqual({ adminAccountId: commander['x-user-id'], displayName: null, role: 'commander' });

    // 화면 디코더가 실제 HTTP 응답을 그대로 읽는다(서버 모양과 화면 모양이 갈라지지 않게)
    const d = detailView(body);
    expect(d.title).toBe(title);
    expect(d.partnerReason).toBe('공연장 화재');
    expect(d.faultOpinion).toBe('FORCE_MAJEURE');
    expect(d.evidenceRef).toBe('소방서 통보 2026-77호');
    expect(d.newStartsAt).toBe(starts);
    expect(d.judgedById).toBe(commander['x-user-id']);
  });

  test('RV-08 파트너 상태의 compensation은 확정 뒤 미리보기의 배상 대상 수·합계이고 그 전에는 null이다', async () => {
    const admin = identity.partner(TENANT);
    const eventId = own();
    const requestId = json(await post(eventId, admin, CANCEL)).requestId as string;
    const commander = identity.ops('commander');
    await svc.http.inject({
      method: 'POST',
      url: `/v1/ops/event-cancellations/${requestId}/judgement`,
      headers: { ...commander, 'content-type': 'application/json' },
      payload: JSON.stringify({ fault: 'ORGANIZER', reason: '주최 측 귀책', fanNoticeReason: '공연이 취소되었습니다' }),
    });
    const before = json(await get(url(eventId), admin));
    expect(before).toHaveProperty('compensation', null);
    const operator = identity.ops('operator');
    const approved = await svc.http.inject({
      method: 'POST',
      url: `/v1/ops/event-cancellations/${requestId}/approvals`,
      headers: { ...operator, 'x-reauth-token': tokenFor(operator['x-user-id']!) },
    });
    expect(approved.statusCode).toBe(200);
    const after = json(await get(url(eventId), admin));
    expect(after.compensation).toEqual({ targetCount: DRY_RUN.compensationTargets, totalAmount: DRY_RUN.compensationTotal });
  });

  test('GAT-110 P1 소속 확인은 세션 테넌트만 쓴다(본문 promoterId 400, 쿼리 promoterId 무시, 테넌트 없는 세션 503)', async () => {
    const admin = identity.partner(TENANT);
    expect((await post(own(), admin, { ...CANCEL, promoterId: TENANT })).statusCode).toBe(400);
    const mine = own();
    expect((await post(mine, admin, CANCEL)).statusCode).toBe(202);
    expect((await get(`${url(mine)}?promoterId=${OTHER_TENANT}`, admin)).statusCode).toBe(200);
    const others = own(OTHER_TENANT);
    expect((await get(`${url(others)}?promoterId=${OTHER_TENANT}`, admin)).statusCode).toBe(404);
    const noTenant = identity.partner(undefined);
    const r = await post(own(), noTenant, CANCEL);
    expect(r.statusCode).toBe(503);
    expect(json(r).type).toMatch(/authz-unavailable$/);
  });
});
