// commander 회차 취소 요청의 가드(BAT-420 GAT-110 Q, R-T23 ⑤⑥, transfer-refund §5 '요청 두 길').
// 판매 중지 확인(ops 명령 기록의 마지막 SUCCEEDED SALE_STOP·SALE_RESUME), 재인증(act APPROVAL·패스키), 멱등 키,
// 진행 중 요청 409와 기존 요청 ID, CS '판정 대기' 건을 본다. 시험 담당이 구현 전에 썼다(ADR-0270).
import { randomUUID } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { MemoryAuditChain } from '../src/modules/audit/index.js';
import { MemoryCommandStore, type CommandType } from '../src/modules/commands/index.js';
import { MemorySaleSuspensionLookup, type EventCancellationStatus } from '../src/modules/event-cancellations/index.js';
import { COMMANDER_A, COMMANDER_C, EVENT, JUDGEMENT, NOW, OPERATOR_B, approveBy, fixture, idemOf, problem, recordOf, requested, tokenFor } from './event-cancellation-fixtures.js';

const REQUESTER = '0194b000-0000-7000-8000-0000000000e1';
const APPROVER = '0194b000-0000-7000-8000-0000000000e2';

/** 메모리 명령 기록에 판매 중지·재개 명령 하나를 원하는 끝 상태로 남긴다 */
async function command(store: MemoryCommandStore, o: { type: Extract<CommandType, 'SALE_STOP' | 'SALE_RESUME'>; eventId: string; end: 'SUCCEEDED' | 'FAILED' | 'PENDING_APPROVAL'; atMs: number; commandId?: string }) {
  const commandId = o.commandId ?? randomUUID();
  await store.create({ commandId, type: o.type, reason: '판매 중지 대응', params: { eventId: o.eventId, reasonCode: 'LEGAL_REQUEST' }, requestedBy: REQUESTER, requestedRole: 'commander', eventId: o.eventId, nowMs: o.atMs - 2 });
  if (o.end === 'PENDING_APPROVAL') return commandId;
  await store.approve(commandId, APPROVER, 'commander', o.atMs - 1);
  await store.markDispatched(commandId, o.atMs);
  if (o.end === 'SUCCEEDED') await store.markSucceeded(commandId, { suspended: o.type === 'SALE_STOP' }, o.atMs);
  else await store.markDispatchFailed(commandId, 'purchase-svc sale suspension 503', o.atMs);
  return commandId;
}

const withCommandLog = () => {
  const commands = new MemoryCommandStore(new MemoryAuditChain());
  const f = fixture({ suspension: new MemorySaleSuspensionLookup(commands) });
  return { commands, f };
};
const ask = (f: ReturnType<typeof fixture>, eventId: string) => f.app.request({ eventId, reason: '공연 취소' }, COMMANDER_A, tokenFor(COMMANDER_A.accountId), idemOf(COMMANDER_A.accountId));

describe('commander 회차 취소 요청 [BAT-420 GAT-110 Q]', () => {
  test('R-T23 ⑤ 판매 중지가 아닌 회차에 commander가 회차 취소를 요청하면 409 sale-not-suspended이고 아무것도 쓰지 않는다', async () => {
    const { commands, f } = withCommandLog();
    const t0 = NOW - 3_600_000;
    const none = randomUUID();
    const failedStop = randomUUID();
    await command(commands, { type: 'SALE_STOP', eventId: failedStop, end: 'FAILED', atMs: t0 });
    const pendingStop = randomUUID();
    await command(commands, { type: 'SALE_STOP', eventId: pendingStop, end: 'PENDING_APPROVAL', atMs: t0 });
    const resumedAfterStop = randomUUID();
    await command(commands, { type: 'SALE_STOP', eventId: resumedAfterStop, end: 'SUCCEEDED', atMs: t0 });
    await command(commands, { type: 'SALE_RESUME', eventId: resumedAfterStop, end: 'SUCCEEDED', atMs: t0 + 60_000 });
    // 다른 회차의 판매 중지는 이 회차의 판매 중지가 아니다
    const otherEventStopped = randomUUID();
    await command(commands, { type: 'SALE_STOP', eventId: randomUUID(), end: 'SUCCEEDED', atMs: t0 });
    for (const eventId of [none, failedStop, pendingStop, resumedAfterStop, otherEventStopped]) {
      await expect(ask(f, eventId)).rejects.toMatchObject(problem('sale-not-suspended', 409));
    }
    expect(f.store.rows.size).toBe(0);
    expect(f.caseCalls).toEqual([]);
    expect(f.audit.entries).toEqual([]);
  });

  test('R-T23 ⑤ 판매 재개 뒤 다시 판매 중지가 끝난 회차는 받고, 중지 뒤 재개가 실패했으면 여전히 판매 중지다(차례를 바꾼 경우)', async () => {
    const { commands, f } = withCommandLog();
    const t0 = NOW - 3_600_000;
    const stoppedAgain = randomUUID();
    await command(commands, { type: 'SALE_RESUME', eventId: stoppedAgain, end: 'SUCCEEDED', atMs: t0 });
    await command(commands, { type: 'SALE_STOP', eventId: stoppedAgain, end: 'SUCCEEDED', atMs: t0 + 60_000 });
    const resumeFailed = randomUUID();
    await command(commands, { type: 'SALE_STOP', eventId: resumeFailed, end: 'SUCCEEDED', atMs: t0 });
    await command(commands, { type: 'SALE_RESUME', eventId: resumeFailed, end: 'FAILED', atMs: t0 + 60_000 });
    expect(await ask(f, stoppedAgain)).toMatchObject({ eventId: stoppedAgain, kind: 'CANCEL', status: 'REQUESTED' });
    expect(await ask(f, resumeFailed)).toMatchObject({ eventId: resumeFailed, status: 'REQUESTED' });
    expect(f.store.rows.size).toBe(2);
  });

  test('R-T23 ⑤ 같은 시각에 끝난 판매 중지·재개는 명령 ID 차례로 마지막을 정한다', async () => {
    const { commands, f } = withCommandLog();
    const at = NOW - 600_000;
    const stopLast = randomUUID();
    await command(commands, { type: 'SALE_RESUME', eventId: stopLast, end: 'SUCCEEDED', atMs: at, commandId: '0194b000-0000-7000-8000-000000010001' });
    await command(commands, { type: 'SALE_STOP', eventId: stopLast, end: 'SUCCEEDED', atMs: at, commandId: '0194b000-0000-7000-8000-000000010002' });
    const resumeLast = randomUUID();
    await command(commands, { type: 'SALE_STOP', eventId: resumeLast, end: 'SUCCEEDED', atMs: at, commandId: '0194b000-0000-7000-8000-000000020001' });
    await command(commands, { type: 'SALE_RESUME', eventId: resumeLast, end: 'SUCCEEDED', atMs: at, commandId: '0194b000-0000-7000-8000-000000020002' });
    expect(await ask(f, stopLast)).toMatchObject({ status: 'REQUESTED' });
    await expect(ask(f, resumeLast)).rejects.toMatchObject(problem('sale-not-suspended', 409));
  });

  test('R-T23 ⑥ 판매 중지된 회차의 commander 요청은 판정·판정자 외 1인 확정을 거쳐 일괄 환불로 이어진다(단위)', async () => {
    const f = fixture();
    const r = await requested(f);
    expect(r).toMatchObject({ eventId: EVENT, kind: 'CANCEL', status: 'REQUESTED' });
    const judged = await f.app.judge(r.requestId, { ...JUDGEMENT }, COMMANDER_A);
    expect(judged.status).toBe('PENDING_APPROVAL');
    expect(f.previewCalls).toEqual([{ eventId: EVENT, requestId: r.requestId, fault: 'ORGANIZER' }]);
    await expect(approveBy(f, r.requestId, COMMANDER_A)).rejects.toMatchObject(problem('approver-ineligible', 403));
    const approved = await approveBy(f, r.requestId, OPERATOR_B);
    expect(approved.status).toBe('RUNNING');
    expect(f.stopCalls).toEqual([{ eventId: EVENT, requestId: r.requestId }]);
    expect(f.startCalls).toHaveLength(1);
    expect(f.startCalls[0]).toMatchObject({ eventId: EVENT, requestId: r.requestId, fault: 'ORGANIZER', ruledBy: COMMANDER_A.accountId, confirmedBy: OPERATOR_B.accountId, kind: 'CANCEL' });
    expect(f.audit.entries.filter((e) => e.recordId === r.requestId).map((e) => e.recordType)).toEqual([
      'EVENT_CANCELLATION_REQUESTED',
      'EVENT_CANCELLATION_JUDGED',
      'EVENT_CANCELLATION_PREVIEWED',
      'EVENT_CANCELLATION_APPROVED',
      'EVENT_CANCELLATION_STARTED',
    ]);
  });

  test('GAT-110 Q1 commander 요청은 재인증 토큰이 없거나 다른 계정·다른 동작·패스키 없음이면 403이고 아무것도 쓰지 않는다', async () => {
    const f = fixture();
    f.behaviour.suspended.add(EVENT);
    const input = { eventId: EVENT, reason: '공연 취소' };
    const bad: Array<string | undefined> = [
      undefined,
      tokenFor(COMMANDER_C.accountId),
      tokenFor(COMMANDER_A.accountId, { act: 'OPS_COMMAND' }),
      tokenFor(COMMANDER_A.accountId, { factors: ['password'] }),
      tokenFor(COMMANDER_A.accountId, { factors: ['password', 'otp'] }),
    ];
    for (const token of bad) {
      await expect(f.app.request(input, COMMANDER_A, token, idemOf(COMMANDER_A.accountId))).rejects.toMatchObject(problem('reauth-required', 403));
    }
    expect(f.suspensionCalls).toEqual([]);
    expect(f.store.rows.size).toBe(0);
    expect(f.caseCalls).toEqual([]);
    // 패스키가 있으면 다른 요소가 함께 있어도 받는다
    expect(await f.app.request(input, COMMANDER_A, tokenFor(COMMANDER_A.accountId, { factors: ['password', 'passkey'] }), idemOf(COMMANDER_A.accountId))).toMatchObject({ status: 'REQUESTED' });
  });

  test('GAT-110 Q1 재인증 검증기가 없으면 commander 요청은 503 reauth-unavailable이고 판매 중지를 묻지 않는다', async () => {
    const f = fixture({ reauth: null });
    f.behaviour.suspended.add(EVENT);
    await expect(f.app.request({ eventId: EVENT, reason: '공연 취소' }, COMMANDER_A, tokenFor(COMMANDER_A.accountId), idemOf(COMMANDER_A.accountId))).rejects.toMatchObject(problem('reauth-unavailable', 503));
    expect(f.suspensionCalls).toEqual([]);
    expect(f.store.rows.size).toBe(0);
  });

  test('GAT-110 Q1 재인증은 요청자의 세션과 act APPROVAL로 묻는다', async () => {
    const f = fixture();
    await requested(f);
    expect(f.log.filter((x) => x.startsWith('verify:'))).toEqual([`verify:APPROVAL:${COMMANDER_A.sessionId}`]);
    expect(f.suspensionCalls).toEqual([EVENT]);
  });

  test('GAT-110 Q2 같은 멱등 키의 같은 요청은 같은 요청 ID를 주고 다른 요청은 422이며 행·CS 건은 하나다(메모리)', async () => {
    const f = fixture();
    f.behaviour.suspended.add(EVENT);
    const key = randomUUID();
    const token = tokenFor(COMMANDER_A.accountId);
    const first = await f.app.request({ eventId: EVENT, reason: '공연 취소' }, COMMANDER_A, token, idemOf(COMMANDER_A.accountId, key, 'body-1'));
    const again = await f.app.request({ eventId: EVENT, reason: '공연 취소' }, COMMANDER_A, token, idemOf(COMMANDER_A.accountId, key, 'body-1'));
    expect(again.requestId).toBe(first.requestId);
    expect(f.store.rows.size).toBe(1);
    expect(f.caseCalls).toEqual([{ requestId: first.requestId, nowMs: NOW }]);
    expect(f.audit.entries.filter((e) => e.recordType === 'EVENT_CANCELLATION_REQUESTED')).toHaveLength(1);
    await expect(f.app.request({ eventId: EVENT, reason: '다른 사유' }, COMMANDER_A, token, idemOf(COMMANDER_A.accountId, key, 'body-2'))).rejects.toMatchObject(problem('idempotency-key-reused', 422));
    expect(f.store.rows.size).toBe(1);
  });

  test('GAT-110 Q3 진행 중 요청이 있으면 409 event-cancellation-active와 기존 요청 ID다(진행 중 상태 일곱)', async () => {
    const active: EventCancellationStatus[] = ['REQUESTED', 'JUDGED', 'PENDING_APPROVAL', 'APPROVED', 'RUNNING', 'PAUSED', 'REFUND_WINDOW'];
    for (const status of active) {
      const f = fixture();
      f.behaviour.suspended.add(EVENT);
      const existing = recordOf({ status });
      await f.store.insert(existing);
      await expect(f.app.request({ eventId: EVENT, reason: '다시' }, COMMANDER_C, tokenFor(COMMANDER_C.accountId), idemOf(COMMANDER_C.accountId))).rejects.toMatchObject(
        problem('event-cancellation-active', 409, { requestId: existing.requestId }),
      );
      expect(f.store.rows.size).toBe(1);
    }
    for (const status of ['COMPLETED', 'REJECTED'] as const) {
      const f = fixture();
      f.behaviour.suspended.add(EVENT);
      await f.store.insert(recordOf({ status }));
      expect(await f.app.request({ eventId: EVENT, reason: '다시' }, COMMANDER_C, tokenFor(COMMANDER_C.accountId), idemOf(COMMANDER_C.accountId))).toMatchObject({ status: 'REQUESTED' });
      expect(f.store.rows.size).toBe(2);
    }
  });

  test('GAT-110 Q3 판매 중지가 아니거나 재인증이 틀리면 진행 중 요청이 있어도 그 요청 ID를 알리지 않는다', async () => {
    const f = fixture();
    const existing = recordOf({ status: 'RUNNING' });
    await f.store.insert(existing);
    const notSuspended = f.app.request({ eventId: EVENT, reason: '다시' }, COMMANDER_C, tokenFor(COMMANDER_C.accountId), idemOf(COMMANDER_C.accountId));
    await expect(notSuspended).rejects.toMatchObject(problem('sale-not-suspended', 409));
    await expect(notSuspended).rejects.not.toMatchObject({ extensions: { requestId: existing.requestId } });
    f.behaviour.suspended.add(EVENT);
    await expect(f.app.request({ eventId: EVENT, reason: '다시' }, COMMANDER_C, undefined, idemOf(COMMANDER_C.accountId))).rejects.toMatchObject(problem('reauth-required', 403));
  });

  test('GAT-110 Q4 commander 요청은 연기를 받지 않는다', async () => {
    const f = fixture();
    f.behaviour.suspended.add(EVENT);
    await expect(f.app.request({ eventId: EVENT, kind: 'POSTPONE', reason: '연기' }, COMMANDER_A, tokenFor(COMMANDER_A.accountId), idemOf(COMMANDER_A.accountId))).rejects.toMatchObject(problem('invalid-body', 400));
    expect(f.store.rows.size).toBe(0);
  });

  test('GAT-110 Q5 commander 요청은 요청 경로 COMMANDER로 저장하고 판정 대기 건을 하나 열며 건을 못 열어도 접수한다', async () => {
    const f = fixture();
    const r = await requested(f);
    expect(f.store.rows.get(r.requestId)).toMatchObject({ requestedVia: 'COMMANDER', promoterId: null, status: 'REQUESTED', reason: '공연 취소', requestedBy: COMMANDER_A.accountId });
    expect(f.caseCalls).toEqual([{ requestId: r.requestId, nowMs: NOW }]);

    const g = fixture();
    g.behaviour.casesFail = true;
    const s = await requested(g);
    expect(s).toMatchObject({ status: 'REQUESTED' });
    expect(g.store.rows.get(s.requestId)).toMatchObject({ status: 'REQUESTED' });
    expect(g.caseCalls).toHaveLength(1);
  });
});
