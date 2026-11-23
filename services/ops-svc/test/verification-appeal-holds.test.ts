// 이의 건이 열리고 닫힐 때의 계정 병합 막기(F-06-7 GAT-280, B-T28 ⑤, B-T10 ⑥의 '처리함에 건이 하나'). 시험 담당 lane3-f067-test.
// 실제 ops-svc 조립(메모리)의 내부 HTTP 건 요청 → 배경 작업(CsCaseDispatchJob) → 실제 gRPC 클라이언트 → identity-svc AccountHoldService 대역.
// 실제 identity-svc(PostgreSQL account_hold)의 판 비교로 늦게 닿은 OPEN이 CLOSED를 되돌리지 않는지는 test-int/verification-appeal.int.test.ts가 본다.
// 정본: docs/features/bot-defense.md §12 'CS 처리 첫 구현'의 '건이 열릴 때'(같은 트랜잭션에 verification_case·APPEAL_COPY·ACCOUNT_HOLD_OPEN, 판 = 연 때의 판,
// 라벨·병합 막기는 내용을 옮긴 뒤에만)·'호출 모양'(OPEN은 연 때의 판, CLOSED는 해결한 새 판)·'다시 보내기'(NOT_FOUND는 다시 보내지 않고 반영 실패·경보),
// identity.proto SetAccountHold(같은 source_ref에 다른 계정이면 ALREADY_EXISTS, 없는 계정이면 NOT_FOUND), docs/data.md cs_case_request(eventKey 한 번).
import * as grpc from '@grpc/grpc-js';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { NOTE, appealFixture, appealHarness, untilAttempted, type AppealHarness } from './cs-appeal-support.js';
import { caseRequest } from './cs-support.js';

let h: AppealHarness;
beforeEach(async () => {
  h = await appealHarness();
});
afterEach(async () => {
  await h.close();
});

const holds = () => h.stubs.identity.of('SetAccountHold').map((q) => [q.state, q.source_version, q.source_ref, q.account_id, q.kind]);

describe('B-T28 ⑤ 열 때 OPEN, 해결할 때 더 큰 판의 CLOSED', () => {
  test('B-T28 ⑤ 건 요청 뒤 한 바퀴: GetVerificationAppeal 한 번, 그 뒤 SetAccountHold(계정, VERIFICATION_APPEAL, 건 ID, OPEN, 판 1)이다', async () => {
    const { caseId, fx } = await h.openAppeal();
    await h.runDispatch();
    expect(h.stubs.queue.of('GetVerificationAppeal')).toEqual([{ appeal_id: fx.appealId }]);
    expect(holds()).toEqual([['ACCOUNT_HOLD_STATE_OPEN', 1, caseId, fx.accountId, 'ACCOUNT_HOLD_KIND_VERIFICATION_APPEAL']]);
    await h.advanceAndRun(3_600_000);
    expect(holds()).toHaveLength(1);
  });

  test('B-T28 ⑤ 결정하면 CLOSED가 해결한 새 판(2 > 1)으로 간다(기각도 같다)', async () => {
    const { caseId, fx } = await h.openAppeal();
    await h.runDispatch();
    expect((await h.decide(h.as('cs_agent'), caseId, { outcome: 'REJECTED', resultNote: NOTE }, { ifMatch: '"1"' })).status).toBe(202);
    await untilAttempted(h, caseId, ['ACCOUNT_HOLD_CLOSE']);
    expect(holds()).toEqual([
      ['ACCOUNT_HOLD_STATE_OPEN', 1, caseId, fx.accountId, 'ACCOUNT_HOLD_KIND_VERIFICATION_APPEAL'],
      ['ACCOUNT_HOLD_STATE_CLOSED', 2, caseId, fx.accountId, 'ACCOUNT_HOLD_KIND_VERIFICATION_APPEAL'],
    ]);
  });

  // 시험 리뷰 1 TR-07 반영: 대역이 만든 차례를 단언하지 않는다. 판(OPEN 1·CLOSED 2)과 두 호출의 끝 상태만 본다(늦은 OPEN을 버리는 것은 identity 몫, 통합 시험이 본다).
  // 정본 결정(계획 §11 ③): 결정 직후 보내기는 그 건의 밀린 OPEN도 함께, OPEN → CLOSE 차례로 보낸다.
  test('B-T28 ⑤ OPEN이 못 간 채 결정하면 결정 직후 보내기가 밀린 OPEN(판 1)과 CLOSED(판 2)를 함께 보내고, 실패한 것은 다시 보내 둘 다 반영된다', async () => {
    const { caseId } = await h.openAppeal();
    h.stubs.identity.fail(grpc.status.UNAVAILABLE);
    await h.runDispatch();
    expect(await h.dispatchOf(caseId, 'ACCOUNT_HOLD_OPEN')).toMatchObject({ state: 'PENDING', attempts: 1, lastError: 'UNAVAILABLE' });
    h.stubs.identity.restore();
    // 결정 직후 보내기의 OPEN은 한 번 더 실패하고 CLOSE는 반영된다(답은 next로 정한다)
    h.stubs.identity.next('SetAccountHold', (req) => (req.state === 'ACCOUNT_HOLD_STATE_OPEN' ? { code: grpc.status.UNAVAILABLE } : { value: { changed: true } }));
    expect((await h.decide(h.as('cs_agent'), caseId, { outcome: 'ACCEPTED', resultNote: NOTE }, { ifMatch: '"1"' })).status).toBe(202);
    await untilAttempted(h, caseId, ['ACCOUNT_HOLD_OPEN'], 2);
    for (let i = 0; i < 3; i++) await h.advanceAndRun(600_000);
    const sent = h.stubs.identity.of('SetAccountHold');
    for (const r of sent) expect([r.state, r.source_version]).toEqual(r.state === 'ACCOUNT_HOLD_STATE_OPEN' ? ['ACCOUNT_HOLD_STATE_OPEN', 1] : ['ACCOUNT_HOLD_STATE_CLOSED', 2]);
    expect(sent.some((r) => r.state === 'ACCOUNT_HOLD_STATE_CLOSED')).toBe(true);
    expect(await h.dispatchOf(caseId, 'ACCOUNT_HOLD_OPEN')).toMatchObject({ state: 'APPLIED' });
    expect(await h.dispatchOf(caseId, 'ACCOUNT_HOLD_CLOSE')).toMatchObject({ state: 'APPLIED' });
  });

  test('B-T28 ⑤ identity가 NOT_FOUND(없는 계정)면 바로 반영 실패이고 다시 보내지 않으며 경보가 하나다', async () => {
    const { caseId } = await h.openAppeal();
    h.stubs.identity.fail(grpc.status.NOT_FOUND);
    await h.runDispatch();
    for (let i = 0; i < 3; i++) await h.advanceAndRun(600_000);
    expect(h.stubs.identity.count('SetAccountHold')).toBe(1);
    expect(await h.dispatchOf(caseId, 'ACCOUNT_HOLD_OPEN')).toMatchObject({ state: 'FAILED', attempts: 1, lastError: 'NOT_FOUND' });
    expect((await h.appealOf(caseId)).reflectState).toBe('FAILED');
    expect(h.dispatchAlerts(caseId).map((a) => [a.severity, a.open])).toEqual([['SEV3', true]]);
  });
});

describe('B-T10 ⑥ B-T28 ⑤ 처리함에 건이 하나', () => {
  test('B-T10 ⑥ B-T28 ⑤ 같은 이의의 건 요청이 두 번 와도(같은 eventKey, 다른 eventKey) 건 하나·이의 기록 하나·OPEN 한 번이다', async () => {
    const fx = appealFixture();
    const eventKey = crypto.randomUUID();
    const a = await h.openAppeal(fx, { eventKey });
    const b = await h.openAppeal(fx, { eventKey });
    const c = await h.openAppeal(fx);
    expect(new Set([a.caseId, b.caseId, c.caseId]).size).toBe(1);
    await h.runDispatch();
    await h.advanceAndRun(600_000);
    const list = await h.list(h.as('cs_agent'), 'kind=VERIFICATION_APPEAL&limit=100');
    expect((list.body.items as Array<{ caseId: string; targetRef: string }>).map((i) => [i.caseId, i.targetRef])).toEqual([[a.caseId, fx.appealId]]);
    expect(h.stubs.queue.count('GetVerificationAppeal')).toBe(1);
    expect(holds()).toEqual([['ACCOUNT_HOLD_STATE_OPEN', 1, a.caseId, fx.accountId, 'ACCOUNT_HOLD_KIND_VERIFICATION_APPEAL']]);
    expect(((await h.appealOf(a.caseId)).dispatch as Array<{ call: string }>).map((d) => d.call)).toEqual(['APPEAL_COPY', 'ACCOUNT_HOLD_OPEN']);
  });

  // 시험 리뷰 1 TR-15 반영: 정본 결정(계획 §11 ⑤, bot-defense §12 '같은 이의의 다른 건 요청', data.md cs_case_request.event_key)
  test('B-T10 ⑥ 해결된 이의 건 뒤에 같은 이의 ID로 다른 eventKey 건 요청이 와도 새 건을 열지 않고 그 건을 돌려주며 보낼 호출을 더하지 않는다', async () => {
    const { caseId, fx } = await h.openAppeal();
    await h.runDispatch();
    expect((await h.decide(h.as('cs_agent'), caseId, { outcome: 'REJECTED', resultNote: NOTE }, { ifMatch: '"1"' })).status).toBe(202);
    await untilAttempted(h, caseId, ['QUEUE_RESOLVE', 'ACCOUNT_HOLD_CLOSE']);
    const again = await h.intake(caseRequest('VERIFICATION_APPEAL', { sourceId: fx.appealId, category: fx.reasonCategory }));
    expect([again.status, again.body.caseId]).toEqual([202, caseId]);
    expect(await h.requests('VERIFICATION_APPEAL', 'duplicate')).toBe(1);
    await h.advanceAndRun(600_000);
    expect(((await h.appealOf(caseId)).dispatch as Array<{ call: string }>).map((d) => d.call)).toEqual(['APPEAL_COPY', 'ACCOUNT_HOLD_OPEN', 'QUEUE_RESOLVE', 'ACCOUNT_HOLD_CLOSE']);
    expect(holds()).toHaveLength(2);
  });

  test('B-T10 ⑥ 다른 종류의 건(분쟁)을 열면 보낼 호출이 없고 받는 쪽을 부르지 않는다', async () => {
    await h.intake(caseRequest('DISPUTE'));
    await h.runDispatch();
    expect([h.stubs.queue.calls.length, h.stubs.trust.calls.length, h.stubs.identity.calls.length]).toEqual([0, 0, 0]);
  });
});
