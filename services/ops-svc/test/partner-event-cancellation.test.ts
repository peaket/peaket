// 파트너 회차 취소·연기 요청과 상태(BAT-420 GAT-110 P, R-T36, transfer-refund §5 '요청 두 길') 단위 시험.
// 소속은 core 판매 설정의 promoterId와 세션 테넌트로만 보고, 다른 파트너·승인 전 회차는 같은 404다.
// 시험 담당이 구현 전에 썼다(ADR-0270).
import { randomUUID } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import type { PartnerEventCancellationInput } from '../src/modules/event-cancellations/index.js';
import { COMMANDER_A, COMMANDER_C, JOB, JUDGEMENT, NOW, OPERATOR_B, OTHER_TENANT, PARTNER_ADMIN, TENANT, approveBy, fixture, idemOf, ownEvent, problem, recordOf, type Fixture } from './event-cancellation-fixtures.js';

const OP = 'CREATE_PARTNER_EVENT_CANCELLATION';
const CANCEL: PartnerEventCancellationInput = { kind: 'CANCEL', reason: '공연장 대관 취소', faultOpinion: 'FORCE_MAJEURE', evidenceRef: '공연장 대관 취소 통지 제2026-118호 2026-11-15' };
const partnerIdem = (key: string = randomUUID(), body = 'body', accountRef = PARTNER_ADMIN.accountId) => idemOf(accountRef, key, body, OP);
const ask = (f: Fixture, eventId: string, input: PartnerEventCancellationInput = CANCEL, idem = partnerIdem()) => f.app.requestByPartner(eventId, input, PARTNER_ADMIN, idem);
const errorOf = async (p: Promise<unknown>): Promise<{ type: string; status: number; title: string }> => {
  try {
    await p;
  } catch (e) {
    const x = e as { type: string; status: number; title: string };
    return { type: x.type, status: x.status, title: x.title };
  }
  throw new Error('거절되지 않았다');
};

describe('파트너 회차 취소·연기 요청 [BAT-420 GAT-110 P]', () => {
  test('R-T36 ① 파트너 관리자의 요청은 REQUESTED이고 요청 경로 PARTNER·테넌트·귀책 의견·증빙·바뀐 일시가 저장되며 감사·판정 대기 건이 하나씩 생긴다(단위)', async () => {
    const f = fixture();
    const cancelEvent = ownEvent(f);
    const view = await ask(f, cancelEvent);
    expect(view).toMatchObject({ eventId: cancelEvent, kind: 'CANCEL', status: 'REQUESTED' });
    expect(f.store.rows.get(view.requestId)).toMatchObject({
      requestedVia: 'PARTNER',
      promoterId: TENANT,
      faultOpinion: 'FORCE_MAJEURE',
      evidenceRef: '공연장 대관 취소 통지 제2026-118호 2026-11-15',
      reason: '공연장 대관 취소',
      requestedBy: PARTNER_ADMIN.accountId,
      newStartsAt: null,
      status: 'REQUESTED',
    });
    expect(f.audit.entries.filter((e) => e.recordId === view.requestId).map((e) => e.recordType)).toEqual(['EVENT_CANCELLATION_REQUESTED']);
    expect(f.caseCalls).toEqual([{ requestId: view.requestId, nowMs: NOW }]);

    const startsAtMs = NOW + 10 * 86_400_000;
    const postponeEvent = ownEvent(f, { startsAtMs });
    const newStartsAt = new Date(startsAtMs + 7 * 86_400_000).toISOString();
    const postponed = await ask(f, postponeEvent, { kind: 'POSTPONE', reason: '출연자 건강 문제', evidenceRef: '출연자 측 공문 2026-11-14', newStartsAt });
    expect(postponed).toMatchObject({ eventId: postponeEvent, kind: 'POSTPONE', status: 'REQUESTED' });
    expect(f.store.rows.get(postponed.requestId)).toMatchObject({ kind: 'POSTPONE', requestedVia: 'PARTNER', promoterId: TENANT, faultOpinion: null, newStartsAt: new Date(newStartsAt) });
    expect(f.caseCalls.map((c) => c.requestId)).toEqual([view.requestId, postponed.requestId]);
    expect(f.ownerCalls).toEqual([cancelEvent, postponeEvent]);
  });

  test('R-T36 ③ [ASVS v5.0.0-8.2.2] 다른 파트너 회차와 판매 승인 전 회차는 같은 404이고 core가 답하지 않으면 503 authz-unavailable이다', async () => {
    const f = fixture();
    const others = ownEvent(f, { promoterId: OTHER_TENANT });
    const unapproved = randomUUID();
    const broken = randomUUID();
    f.behaviour.owners.set(broken, 'throw');
    const a = await errorOf(ask(f, others));
    const b = await errorOf(ask(f, unapproved));
    expect(a).toMatchObject(problem('not-found', 404));
    expect(b).toEqual(a);
    await expect(ask(f, broken)).rejects.toMatchObject(problem('authz-unavailable', 503));
    expect(f.store.rows.size).toBe(0);
    expect(f.caseCalls).toEqual([]);
    expect(f.audit.entries).toEqual([]);
    // 상태 보기도 같은 소속 확인이다
    const c = await errorOf(f.app.partnerStatus(others, TENANT));
    expect(c).toMatchObject(problem('not-found', 404));
    expect(await errorOf(f.app.partnerStatus(unapproved, TENANT))).toEqual(c);
    await expect(f.app.partnerStatus(broken, TENANT)).rejects.toMatchObject(problem('authz-unavailable', 503));
  });

  test('R-T36 ③ 다른 파트너가 이미 낸 요청이 있어도 그 회차는 404이고 요청 ID를 드러내지 않는다', async () => {
    const f = fixture();
    const others = ownEvent(f, { promoterId: OTHER_TENANT });
    const existing = recordOf({ eventId: others, requestedVia: 'PARTNER', promoterId: OTHER_TENANT });
    await f.store.insert(existing);
    await expect(ask(f, others)).rejects.toMatchObject(problem('not-found', 404));
    await expect(ask(f, others)).rejects.not.toMatchObject({ extensions: { requestId: existing.requestId } });
    await expect(f.app.partnerStatus(others, TENANT)).rejects.toMatchObject(problem('not-found', 404));
  });

  test('GAT-110 P4 소속 확인기를 조립하지 않았으면 파트너 요청·상태는 503 authz-unavailable이다', async () => {
    const f = fixture({ without: ['owners'] });
    const eventId = randomUUID();
    await expect(ask(f, eventId)).rejects.toMatchObject(problem('authz-unavailable', 503));
    await expect(f.app.partnerStatus(eventId, TENANT)).rejects.toMatchObject(problem('authz-unavailable', 503));
    expect(f.store.rows.size).toBe(0);
  });

  test('R-T36 ④ 진행 중 요청이 있는 회차의 파트너 요청은 409 event-cancellation-active와 기존 요청 ID다(commander가 낸 요청도 막는다)', async () => {
    const f = fixture();
    const eventId = ownEvent(f);
    const byCommander = recordOf({ eventId, status: 'JUDGED' });
    await f.store.insert(byCommander);
    await expect(ask(f, eventId)).rejects.toMatchObject(problem('event-cancellation-active', 409, { requestId: byCommander.requestId }));
    const second = ownEvent(f);
    const first = await ask(f, second);
    await expect(ask(f, second, { ...CANCEL, reason: '다시 요청' })).rejects.toMatchObject(problem('event-cancellation-active', 409, { requestId: first.requestId }));
    expect([...f.store.rows.values()].filter((r) => r.eventId === second)).toHaveLength(1);
  });

  test('R-T36 ⑤ 공연이 끝난 회차는 409 event-ended다(끝 시각 −1ms 받음·정각 거절, 끝 시각이 없으면 시작 + 86,400,000ms)', async () => {
    const f = fixture();
    const startsAtMs = NOW - 5 * 3_600_000;
    const endsAtMs = NOW + 3_600_000;
    const justBefore = ownEvent(f, { startsAtMs, endsAtMs });
    const atEnd = ownEvent(f, { startsAtMs, endsAtMs });
    f.clock.now = endsAtMs - 1;
    expect(await ask(f, justBefore)).toMatchObject({ status: 'REQUESTED' });
    f.clock.now = endsAtMs;
    await expect(ask(f, atEnd)).rejects.toMatchObject(problem('event-ended', 409));

    // 끝 시각이 없으면 시작 + 24시간
    const noEndA = randomUUID();
    const noEndB = randomUUID();
    f.behaviour.owners.set(noEndA, { promoterId: TENANT, startsAtMs });
    f.behaviour.owners.set(noEndB, { promoterId: TENANT, startsAtMs });
    f.clock.now = startsAtMs + 86_399_999;
    expect(await ask(f, noEndA)).toMatchObject({ status: 'REQUESTED' });
    f.clock.now = startsAtMs + 86_400_000;
    await expect(ask(f, noEndB)).rejects.toMatchObject(problem('event-ended', 409));

    // 끝 시각이 있으면 그 값만 쓴다(24시간 대체값을 섞지 않는다)
    const shortShow = ownEvent(f, { startsAtMs, endsAtMs: startsAtMs + 2 * 3_600_000 });
    f.clock.now = startsAtMs + 3 * 3_600_000;
    await expect(ask(f, shortShow)).rejects.toMatchObject(problem('event-ended', 409));
    const longShow = ownEvent(f, { startsAtMs, endsAtMs: startsAtMs + 30 * 3_600_000 });
    f.clock.now = startsAtMs + 25 * 3_600_000;
    expect(await ask(f, longShow)).toMatchObject({ status: 'REQUESTED' });
  });

  test('R-T36 ⑥ 연기 일시가 없거나 지금 시작보다 이르면 422 postponement-date-invalid이고 시작 + 1ms는 받는다', async () => {
    const f = fixture();
    const startsAtMs = NOW + 10 * 86_400_000;
    const postpone = (newStartsAt?: string): PartnerEventCancellationInput => ({ kind: 'POSTPONE', reason: '연기', ...(newStartsAt !== undefined ? { newStartsAt } : {}) });
    for (const at of [undefined, new Date(startsAtMs).toISOString(), new Date(startsAtMs - 86_400_000).toISOString()]) {
      await expect(ask(f, ownEvent(f, { startsAtMs }), postpone(at))).rejects.toMatchObject(problem('postponement-date-invalid', 422));
    }
    expect(f.store.rows.size).toBe(0);
    expect(await ask(f, ownEvent(f, { startsAtMs }), postpone(new Date(startsAtMs + 1).toISOString()))).toMatchObject({ kind: 'POSTPONE', status: 'REQUESTED' });
  });

  test('R-T36 ⑥ 취소에 바뀐 일시를 보내거나 사유·증빙 길이가 한도 밖이면 400 invalid-body다(1,000자·200자 경계 양쪽)', async () => {
    const f = fixture();
    const startsAtMs = NOW + 10 * 86_400_000;
    const bad: PartnerEventCancellationInput[] = [
      { ...CANCEL, newStartsAt: new Date(startsAtMs + 86_400_000).toISOString() },
      { ...CANCEL, reason: '' },
      { ...CANCEL, reason: '가'.repeat(1_001) },
      { ...CANCEL, evidenceRef: '나'.repeat(201) },
      { ...CANCEL, evidenceRef: '' },
    ];
    for (const input of bad) {
      await expect(ask(f, ownEvent(f, { startsAtMs }), input)).rejects.toMatchObject(problem('invalid-body', 400));
    }
    expect(f.store.rows.size).toBe(0);
    expect(f.ownerCalls).toEqual([]);
    expect(await ask(f, ownEvent(f, { startsAtMs }), { ...CANCEL, reason: '가'.repeat(1_000), evidenceRef: '나'.repeat(200) })).toMatchObject({ status: 'REQUESTED' });
  });

  test('R-T36 ⑦ 같은 멱등 키의 같은 본문은 같은 요청 ID로 한 건, 다른 본문은 422, 같은 테넌트의 다른 관리자가 쓴 같은 키는 진행 중 409다(메모리)', async () => {
    const f = fixture();
    const eventId = ownEvent(f);
    const key = randomUUID();
    const first = await ask(f, eventId, CANCEL, partnerIdem(key, 'body-1'));
    const again = await ask(f, eventId, CANCEL, partnerIdem(key, 'body-1'));
    expect(again.requestId).toBe(first.requestId);
    expect(f.store.rows.size).toBe(1);
    expect(f.caseCalls).toHaveLength(1);
    await expect(ask(f, eventId, { ...CANCEL, evidenceRef: '다른 공문 2026-11-16' }, partnerIdem(key, 'body-2'))).rejects.toMatchObject(problem('idempotency-key-reused', 422));
    const otherAdmin = { ...PARTNER_ADMIN, accountId: '0194b000-0000-7000-8000-0000000000d5', sessionId: 's-d2' };
    await expect(f.app.requestByPartner(eventId, CANCEL, otherAdmin, partnerIdem(key, 'body-1', otherAdmin.accountId))).rejects.toMatchObject(
      problem('event-cancellation-active', 409, { requestId: first.requestId }),
    );
    expect(f.store.rows.size).toBe(1);
  });
});

describe('파트너가 보는 상태 [BAT-420 GAT-110 P]', () => {
  const HIDDEN = ['dryRun', 'perPg', 'judgedBy', 'judgementReason'];

  test('R-T36 ⑧ 상태 응답은 미리보기·판정자·내부 판정 사유를 싣지 않고 판정 사유 칸에 팬 통지 사유를 싣는다', async () => {
    const f = fixture();
    const eventId = ownEvent(f);
    const r = await ask(f, eventId);
    const before = await f.app.partnerStatus(eventId, TENANT);
    expect(before).toMatchObject({
      requestId: r.requestId,
      eventId,
      kind: 'CANCEL',
      status: 'REQUESTED',
      reason: '공연장 대관 취소',
      faultOpinion: 'FORCE_MAJEURE',
      evidenceRef: '공연장 대관 취소 통지 제2026-118호 2026-11-15',
      newStartsAt: null,
      judgementDueAt: null,
      fault: null,
      judgementSummary: null,
      rejectionReason: null,
      refundProgress: null,
    });
    await f.app.judge(r.requestId, { ...JUDGEMENT }, COMMANDER_A);
    const after = await f.app.partnerStatus(eventId, TENANT);
    expect(after).toMatchObject({ status: 'PENDING_APPROVAL', fault: 'ORGANIZER', judgementSummary: '공연이 취소되었습니다', judgementDueAt: null });
    for (const key of HIDDEN) expect(after).not.toHaveProperty(key);
    expect(JSON.stringify(after)).not.toContain('주최 측 귀책');
    expect(JSON.stringify(after)).not.toContain(COMMANDER_A.accountId);
  });

  test('R-T36 ⑧ 판정 전 반려 뒤에는 반려 사유를 싣는다', async () => {
    const f = fixture();
    const eventId = ownEvent(f);
    const r = await ask(f, eventId);
    await f.app.reject(r.requestId, COMMANDER_C, '공연 진행 확인');
    expect(await f.app.partnerStatus(eventId, TENANT)).toMatchObject({ requestId: r.requestId, status: 'REJECTED', rejectionReason: '공연 진행 확인', refundProgress: null });
  });

  test('R-T36 ⑧ 진행 중이면 진행 합계만 싣고 멈춤 종류는 PAUSED일 때만이며 진행률 읽기가 실패하면 그 칸만 null이다', async () => {
    const f = fixture();
    const eventId = ownEvent(f);
    const r = await ask(f, eventId);
    await f.app.judge(r.requestId, { ...JUDGEMENT }, COMMANDER_A);
    await approveBy(f, r.requestId, OPERATOR_B);
    const running = await f.app.partnerStatus(eventId, TENANT);
    expect(running).toMatchObject({ status: 'RUNNING', refundProgress: { total: 30, done: 8, failed: 5 }, pausedBy: null });
    expect(Object.keys(running.refundProgress ?? {}).sort()).toEqual(['done', 'failed', 'total']);
    for (const key of HIDDEN) expect(running).not.toHaveProperty(key);

    await f.app.pause(r.requestId, COMMANDER_A, { reason: '수동 정지' });
    f.behaviour.job = { ...JOB, state: 'PAUSED', perPg: JOB.perPg.map((p) => ({ ...p, state: 'PAUSED', pauseReason: 'MANUAL' })) };
    expect(await f.app.partnerStatus(eventId, TENANT)).toMatchObject({ status: 'PAUSED', pausedBy: 'OPERATOR' });
    f.behaviour.job = { ...JOB, state: 'PAUSED', perPg: JOB.perPg.map((p) => ({ ...p, state: 'PAUSED', pauseReason: 'AUTO_CIRCUIT_OPEN' })) };
    expect(await f.app.partnerStatus(eventId, TENANT)).toMatchObject({ status: 'PAUSED', pausedBy: 'AUTOMATIC', refundProgress: { total: 30, done: 8, failed: 5 } });

    f.behaviour.jobFails = true;
    expect(await f.app.partnerStatus(eventId, TENANT)).toMatchObject({ status: 'PAUSED', refundProgress: null, requestId: r.requestId, fault: 'ORGANIZER' });
  });

  test('R-T36 ⑧ 연기 확정 뒤에는 신청 현황을 싣고 진행 합계는 싣지 않는다', async () => {
    const f = fixture();
    const startsAtMs = NOW + 10 * 86_400_000;
    const eventId = ownEvent(f, { startsAtMs });
    const newStartsAt = new Date(startsAtMs + 7 * 86_400_000).toISOString();
    const r = await ask(f, eventId, { kind: 'POSTPONE', reason: '출연자 건강 문제', newStartsAt });
    await f.app.judge(r.requestId, { fault: 'CONTENT_CHANGE', reason: '일정 변경', fanNoticeReason: '공연이 연기되었습니다' }, COMMANDER_A);
    await approveBy(f, r.requestId, OPERATOR_B);
    f.behaviour.job = { state: 'REFUND_WINDOW', total: 12, done: 2, failed: 0, perPg: [], appliedOrders: 9, refundWindowClosesAt: newStartsAt };
    expect(await f.app.partnerStatus(eventId, TENANT)).toMatchObject({
      status: 'REFUND_WINDOW',
      kind: 'POSTPONE',
      newStartsAt,
      postponement: { refundApplicationCount: 9, refundDeadlineAt: newStartsAt },
      refundProgress: null,
      judgementSummary: '공연이 연기되었습니다',
    });
  });

  test('GAT-110 P2 파트너 연기 요청을 확정하면 바뀐 일시로 신청 창을 열고 판매를 멈추지 않는다', async () => {
    const f = fixture();
    const startsAtMs = NOW + 10 * 86_400_000;
    const eventId = ownEvent(f, { startsAtMs });
    const newStartsAtMs = startsAtMs + 7 * 86_400_000 + 123;
    const r = await ask(f, eventId, { kind: 'POSTPONE', reason: '출연자 건강 문제', newStartsAt: new Date(newStartsAtMs).toISOString() });
    await f.app.judge(r.requestId, { fault: 'CONTENT_CHANGE', reason: '일정 변경', fanNoticeReason: '공연이 연기되었습니다' }, COMMANDER_A);
    const view = await approveBy(f, r.requestId, OPERATOR_B);
    expect(view.status).toBe('REFUND_WINDOW');
    expect(f.stopCalls).toEqual([]);
    expect(f.startCalls).toHaveLength(1);
    expect(f.startCalls[0]).toMatchObject({ eventId, requestId: r.requestId, kind: 'POSTPONE', postponedToMs: newStartsAtMs, fault: 'CONTENT_CHANGE' });
  });

  test('GAT-110 P5 상태는 그 회차의 가장 최근 요청이고 요청이 없으면 404이며 commander가 낸 요청의 사유는 싣지 않는다', async () => {
    const f = fixture();
    const eventId = ownEvent(f);
    await expect(f.app.partnerStatus(eventId, TENANT)).rejects.toMatchObject(problem('not-found', 404));
    const old = recordOf({ eventId, status: 'REJECTED', requestedVia: 'PARTNER', promoterId: TENANT, requestedAt: new Date(NOW - 7_200_000), rejectionReason: '증빙 부족' });
    await f.store.insert(old);
    const latest = recordOf({ eventId, status: 'REQUESTED', reason: '판매 중지 뒤 운영 판단', requestedVia: 'COMMANDER', requestedAt: new Date(NOW - 60_000) });
    await f.store.insert(latest);
    expect(await f.app.partnerStatus(eventId, TENANT)).toMatchObject({ requestId: latest.requestId, status: 'REQUESTED', reason: null, rejectionReason: null });
  });
});
