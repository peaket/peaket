// 회차 취소 요청 중 보류 취소의 환급 미룸, ops-svc 쪽(BAT-420 몫 D, OPEN[45] 결정, R-T38 ②⑥, GAT-110 D1·D2,
// docs/features/transfer-refund.md §5 '회차 취소 요청 중 보류 취소의 환급 미룸', refund.proto SetEventRefundHold).
// CANCEL 요청은 모든 검사 뒤·저장 전에 새 요청 ID로 미룸을 걸고(지금 + 72시간 = 259,200,000ms [가정]), 판정·확정 때 늘리며, 판정 전 반려 때 푼다.
// 걸지 못하면 요청을 저장하지 않고 503 event-refund-unavailable이다. 시험 담당이 구현 전에 썼다(ADR-0270).
import { randomUUID } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import type { PartnerEventCancellationInput } from '../src/modules/event-cancellations/index.js';
import { COMMANDER_A, COMMANDER_C, EVENT, JUDGEMENT, NOW, OPERATOR_B, PARTNER_ADMIN, approveBy, fixture, idemOf, ownEvent, problem, recordOf, requested, tokenFor, type Fixture } from './event-cancellation-fixtures.js';

const HOLD_MS = 259_200_000;
const CANCEL: PartnerEventCancellationInput = { kind: 'CANCEL', reason: '공연장 대관 취소', evidenceRef: '대관 취소 통지 제2026-118호' };
const partnerAsk = (f: Fixture, eventId: string, input: PartnerEventCancellationInput = CANCEL, key: string = randomUUID()) =>
  f.app.requestByPartner(eventId, input, PARTNER_ADMIN, idemOf(PARTNER_ADMIN.accountId, key, JSON.stringify(input), 'CREATE_PARTNER_EVENT_CANCELLATION'));
const commanderAsk = (f: Fixture, eventId = EVENT, key: string = randomUUID()) => f.app.request({ eventId, reason: '공연 취소' }, COMMANDER_A, tokenFor(COMMANDER_A.accountId), idemOf(COMMANDER_A.accountId, key));

describe('요청 전 미룸 걸기 [BAT-420 몫 D]', () => {
  test('R-T38 ⑥ commander 요청은 모든 검사 뒤·저장 전에 새 요청 ID와 지금 + 259,200,000ms로 미룸을 건다', async () => {
    const f = fixture();
    const view = await requested(f);
    expect(f.holdCalls).toEqual([{ eventId: EVENT, requestId: view.requestId, held: true, expiresAtMs: NOW + HOLD_MS }]);
    expect(f.behaviour.rowsWhenHeld).toEqual([0]);
    expect(f.log.indexOf(`hold:on:${view.requestId}`)).toBeGreaterThan(f.log.findIndex((x) => x.startsWith('verify:')));
  });

  test('R-T38 ⑥ 미룸을 걸지 못하면 commander 요청은 503 event-refund-unavailable이고 행·감사·CS 건·멱등 기록이 없다', async () => {
    const f = fixture();
    f.behaviour.suspended.add(EVENT);
    f.behaviour.holdFails = true;
    const key = randomUUID();
    await expect(commanderAsk(f, EVENT, key)).rejects.toMatchObject(problem('event-refund-unavailable', 503));
    expect(f.store.rows.size).toBe(0);
    expect(f.audit.entries).toEqual([]);
    expect(f.caseCalls).toEqual([]);
    expect(f.holdCalls).toHaveLength(1);
    // 같은 키로 다시 보내면 새 요청으로 받는다(실패한 시도는 멱등 기록을 남기지 않았다)
    f.behaviour.holdFails = false;
    expect(await commanderAsk(f, EVENT, key)).toMatchObject({ status: 'REQUESTED' });
    expect(f.store.rows.size).toBe(1);
  });

  test('R-T38 ⑥ 재인증·판매 중지 검사에서 걸러진 commander 요청은 미룸을 걸지 않는다', async () => {
    const f = fixture();
    await expect(commanderAsk(f)).rejects.toMatchObject(problem('sale-not-suspended', 409));
    f.behaviour.suspended.add(EVENT);
    await expect(f.app.request({ eventId: EVENT, reason: '공연 취소' }, COMMANDER_A, undefined, idemOf(COMMANDER_A.accountId))).rejects.toMatchObject(problem('reauth-required', 403));
    expect(f.holdCalls).toEqual([]);
  });

  test('R-T38 ⑥ 파트너 취소 요청은 소속·종료 검사 뒤 미룸을 걸고, 걸지 못하면 503이며, 연기 요청은 미룸 없이 받는다', async () => {
    const f = fixture();
    const ok = ownEvent(f);
    const view = await partnerAsk(f, ok);
    expect(f.holdCalls).toEqual([{ eventId: ok, requestId: view.requestId, held: true, expiresAtMs: NOW + HOLD_MS }]);

    f.behaviour.holdFails = true;
    const failing = ownEvent(f);
    await expect(partnerAsk(f, failing)).rejects.toMatchObject(problem('event-refund-unavailable', 503));
    expect([...f.store.rows.values()].filter((r) => r.eventId === failing)).toEqual([]);
    expect(f.caseCalls).toHaveLength(1);

    const others = ownEvent(f, { promoterId: '0194b000-0000-7000-8000-00000000f0ff' });
    await expect(partnerAsk(f, others)).rejects.toMatchObject(problem('not-found', 404));
    const calls = f.holdCalls.length;
    const startsAtMs = NOW + 10 * 86_400_000;
    const postponed = await partnerAsk(f, ownEvent(f, { startsAtMs }), { kind: 'POSTPONE', reason: '연기', newStartsAt: new Date(startsAtMs + 86_400_000).toISOString() });
    expect(postponed).toMatchObject({ kind: 'POSTPONE', status: 'REQUESTED' });
    expect(f.holdCalls).toHaveLength(calls);
  });

  test('GAT-110 P4 미룸 대역을 조립하지 않았으면 CANCEL 요청은 503 event-refund-unavailable이고 연기 요청은 받는다', async () => {
    const f = fixture({ without: ['holds'] });
    f.behaviour.suspended.add(EVENT);
    await expect(commanderAsk(f)).rejects.toMatchObject(problem('event-refund-unavailable', 503));
    await expect(partnerAsk(f, ownEvent(f))).rejects.toMatchObject(problem('event-refund-unavailable', 503));
    const startsAtMs = NOW + 10 * 86_400_000;
    expect(await partnerAsk(f, ownEvent(f, { startsAtMs }), { kind: 'POSTPONE', reason: '연기', newStartsAt: new Date(startsAtMs + 1).toISOString() })).toMatchObject({ status: 'REQUESTED' });
    expect(f.store.rows.size).toBe(1);
  });
});

describe('미룸 되돌림 [BAT-420 몫 D]', () => {
  // 보충 2(af7bde64): 검사 뒤 진행 중 요청을 먼저 보고, 있으면 걸지 않고 409다. 걸기가 ALREADY_EXISTS면 진행 중 요청을 다시 본다
  test('GAT-110 D1 진행 중 요청이 있는 회차의 새 요청은 미룸을 걸지 않고(0회) 409 event-cancellation-active와 기존 요청 ID를 준다(commander·파트너)', async () => {
    const f = fixture();
    f.behaviour.suspended.add(EVENT);
    const existing = recordOf({ status: 'JUDGED' });
    await f.store.insert(existing);
    await expect(commanderAsk(f)).rejects.toMatchObject(problem('event-cancellation-active', 409, { requestId: existing.requestId }));
    expect(f.holdCalls).toEqual([]);

    const own = ownEvent(f);
    const first = await partnerAsk(f, own);
    const calls = f.holdCalls.length;
    await expect(partnerAsk(f, own, { ...CANCEL, reason: '다시 요청' })).rejects.toMatchObject(problem('event-cancellation-active', 409, { requestId: first.requestId }));
    expect(f.holdCalls).toHaveLength(calls);
  });

  test('GAT-110 D1 걸기가 ALREADY_EXISTS인데 다시 보니 그사이 진행 중 요청이 생겼으면 409(그 요청 ID)이고 행을 더 쓰지 않는다', async () => {
    const f = fixture();
    f.behaviour.suspended.add(EVENT);
    const racer = recordOf({ status: 'REQUESTED' });
    f.behaviour.holdConflict = true;
    f.behaviour.onHold = async (q) => {
      if (q.held && !f.store.rows.has(racer.requestId)) await f.store.insert(racer);
    };
    await expect(commanderAsk(f)).rejects.toMatchObject(problem('event-cancellation-active', 409, { requestId: racer.requestId }));
    expect([...f.store.rows.keys()]).toEqual([racer.requestId]);
    expect(f.holdCalls.filter((c) => c.held)).toHaveLength(1);
    expect(f.warns.filter((w) => JSON.stringify(w).includes('event-refund-hold-conflict'))).toEqual([]);
  });

  test('GAT-110 D1 걸기가 ALREADY_EXISTS이고 다시 봐도 진행 중 요청이 없으면(풀기를 놓친 옛 미룸) 503 event-refund-unavailable과 경고 event-refund-hold-conflict 한 번이고 아무것도 쓰지 않는다', async () => {
    const f = fixture();
    f.behaviour.suspended.add(EVENT);
    f.behaviour.holdConflict = true;
    await expect(commanderAsk(f)).rejects.toMatchObject(problem('event-refund-unavailable', 503));
    expect(f.store.rows.size).toBe(0);
    expect(f.audit.entries).toEqual([]);
    expect(f.caseCalls).toEqual([]);
    const conflicts = f.warns.filter((w) => JSON.stringify(w).includes('event-refund-hold-conflict'));
    expect(conflicts).toHaveLength(1);
    expect(JSON.stringify(conflicts[0])).toContain(EVENT);
    // 대조: 옛 미룸이 풀리면(기한) 같은 요청을 받는다
    f.behaviour.holdConflict = false;
    expect(await commanderAsk(f)).toMatchObject({ status: 'REQUESTED' });
  });

  test('GAT-110 D1 걸기 뒤 저장이 진행 중 유일 색인에 걸리면(동시에 들어온 두 요청) 자기 요청 ID로 한 번 풀고 409이며, 풀기가 실패해도 409다', async () => {
    for (const releaseFails of [false, true]) {
      const f = fixture();
      f.behaviour.suspended.add(EVENT);
      f.behaviour.releaseFails = releaseFails;
      const racer = recordOf({ status: 'REQUESTED' });
      // 진행 중 확인은 지났고, 걸기와 저장 사이에 다른 요청이 먼저 저장됐다
      f.behaviour.onHold = async (q) => {
        if (q.held && !f.store.rows.has(racer.requestId)) await f.store.insert(racer);
      };
      await expect(commanderAsk(f), String(releaseFails)).rejects.toMatchObject(problem('event-cancellation-active', 409, { requestId: racer.requestId }));
      const [on, ...rest] = f.holdCalls;
      expect(on, String(releaseFails)).toMatchObject({ eventId: EVENT, held: true });
      expect(on!.requestId).not.toBe(racer.requestId);
      expect(rest, String(releaseFails)).toEqual([{ eventId: EVENT, requestId: on!.requestId, held: false }]);
      expect([...f.store.rows.keys()]).toEqual([racer.requestId]);
    }
  });

  test('GAT-110 D1 요청 저장이 실패하면 건 미룸을 같은 요청 ID로 풀고 그 오류를 그대로 올린다(풀기가 실패해도 같다)', async () => {
    for (const releaseFails of [false, true]) {
      const f = fixture();
      f.behaviour.suspended.add(EVENT);
      f.behaviour.releaseFails = releaseFails;
      f.store.insert = async () => {
        throw new Error('db down');
      };
      await expect(commanderAsk(f)).rejects.toThrow('db down');
      expect(f.holdCalls.map((c) => [c.held, c.requestId]), String(releaseFails)).toEqual([
        [true, f.holdCalls[0]!.requestId],
        [false, f.holdCalls[0]!.requestId],
      ]);
    }
  });
});

describe('판정·확정 때 늘리기, 판정 전 반려 때 풀기 [BAT-420 몫 D]', () => {
  test('GAT-110 D2 판정은 같은 요청 ID로 미룸 기한을 그 시각 + 259,200,000ms로 늘린다', async () => {
    const f = fixture();
    const r = await requested(f);
    f.clock.now = NOW + 3_600_000;
    await f.app.judge(r.requestId, { ...JUDGEMENT }, COMMANDER_A);
    expect(f.holdCalls[1]).toEqual({ eventId: EVENT, requestId: r.requestId, held: true, expiresAtMs: NOW + 3_600_000 + HOLD_MS });
    expect(f.log.indexOf(`hold:on:${r.requestId}`, f.log.indexOf(`hold:on:${r.requestId}`) + 1)).toBeLessThan(f.log.indexOf(`preview:${r.requestId}`));
  });

  test('GAT-110 D2 판정 때 늘리지 못하면 503 event-refund-unavailable이고 JUDGED 저장·미리보기가 없다', async () => {
    const f = fixture();
    const r = await requested(f);
    f.behaviour.holdFails = true;
    await expect(f.app.judge(r.requestId, { ...JUDGEMENT }, COMMANDER_A)).rejects.toMatchObject(problem('event-refund-unavailable', 503));
    expect(f.store.rows.get(r.requestId)).toMatchObject({ status: 'REQUESTED', fault: null, version: 1 });
    expect(f.previewCalls).toEqual([]);
    expect(f.audit.entries.map((e) => e.recordType)).toEqual(['EVENT_CANCELLATION_REQUESTED']);
  });

  test('GAT-110 D2 확정은 재인증 뒤·판매 멈춤 앞에서 같은 요청 ID로 기한을 늘린다', async () => {
    const f = fixture();
    const requestId = await pendingApproval2(f);
    f.clock.now = NOW + 7_200_000;
    await approveBy(f, requestId);
    const tail = f.log.slice(f.log.lastIndexOf(`verify:APPROVAL:${OPERATOR_B.sessionId}`));
    expect(tail.filter((x) => /^(hold|stop|start):/.test(x))).toEqual([`hold:on:${requestId}`, `stop:${requestId}`, `start:${requestId}`]);
    expect(f.holdCalls.at(-1)).toEqual({ eventId: EVENT, requestId, held: true, expiresAtMs: NOW + 7_200_000 + HOLD_MS });
  });

  test('GAT-110 D2 확정 때 늘리지 못하면 503이고 판매 멈춤·시작이 없으며 PENDING_APPROVAL 그대로다(재인증이 틀리면 늘리지도 않는다)', async () => {
    const f = fixture();
    const requestId = await pendingApproval2(f);
    const before = f.holdCalls.length;
    await expect(f.app.approve(requestId, OPERATOR_B, undefined)).rejects.toMatchObject(problem('reauth-required', 403));
    expect(f.holdCalls).toHaveLength(before);
    f.behaviour.holdFails = true;
    await expect(approveBy(f, requestId)).rejects.toMatchObject(problem('event-refund-unavailable', 503));
    expect(f.stopCalls).toEqual([]);
    expect(f.startCalls).toEqual([]);
    expect(f.store.rows.get(requestId)).toMatchObject({ status: 'PENDING_APPROVAL', approvedBy: null });
  });

  test('R-T38 ② 판정 전 반려(REQUESTED → REJECTED)는 같은 요청 ID로 미룸을 한 번 풀고, 다시 반려해도 두 번 풀지 않는다', async () => {
    const f = fixture();
    const r = await requested(f);
    await f.app.reject(r.requestId, COMMANDER_C, '파트너 확인 결과 공연 진행');
    expect(f.store.rows.get(r.requestId)!.status).toBe('REJECTED');
    expect(f.holdCalls.filter((c) => !c.held)).toEqual([{ eventId: EVENT, requestId: r.requestId, held: false }]);
    await expect(f.app.reject(r.requestId, COMMANDER_C, '또')).rejects.toMatchObject({ status: 409 });
    expect(f.holdCalls.filter((c) => !c.held)).toHaveLength(1);
  });

  test('R-T38 ② 판정 전 반려는 풀기가 실패해도 반려한다(기한에 저절로 풀린다)', async () => {
    const f = fixture();
    const r = await requested(f);
    f.behaviour.releaseFails = true;
    expect((await f.app.reject(r.requestId, COMMANDER_C, '공연 진행')).status).toBe('REJECTED');
    expect(f.holdCalls.map((c) => c.held)).toEqual([true, false]);
  });

  test('R-T38 ② 판정 뒤 반려(JUDGED로 돌아감)는 판정이 끝나지 않았으므로 미룸을 풀지 않는다', async () => {
    const f = fixture();
    const requestId = await pendingApproval2(f);
    expect((await f.app.reject(requestId, OPERATOR_B, '증빙 부족')).status).toBe('JUDGED');
    expect(f.holdCalls.filter((c) => !c.held)).toEqual([]);
  });

  test('GAT-110 D2 연기(POSTPONE) 요청은 판정·확정 때 미룸을 부르지 않는다', async () => {
    const f = fixture();
    const startsAtMs = NOW + 10 * 86_400_000;
    const eventId = ownEvent(f, { startsAtMs });
    const r = await partnerAsk(f, eventId, { kind: 'POSTPONE', reason: '연기', newStartsAt: new Date(startsAtMs + 86_400_000).toISOString() });
    await f.app.judge(r.requestId, { fault: 'CONTENT_CHANGE', reason: '일정 변경', fanNoticeReason: '공연이 연기되었습니다' }, COMMANDER_A);
    await approveBy(f, r.requestId);
    expect(f.holdCalls).toEqual([]);
  });
});

/** 요청 → 판정(미리보기)까지 */
async function pendingApproval2(f: Fixture): Promise<string> {
  const r = await requested(f);
  await f.app.judge(r.requestId, { ...JUDGEMENT }, COMMANDER_A);
  expect(f.store.rows.get(r.requestId)!.status).toBe('PENDING_APPROVAL');
  return r.requestId;
}

