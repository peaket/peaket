// 판정·미리보기·확정의 차례와 확정 때 판매 멈춤(BAT-420 GAT-110 W·H, R-T37 ①~④, ADR-0280).
// 판정은 미리보기를 저장해 PENDING_APPROVAL로 두고, 확정은 PENDING_APPROVAL에서만 판매를 멈춘 뒤 일괄 환불을 시작한다.
// 시험 담당이 구현 전에 썼다(ADR-0270). 미리보기 값은 purchase-svc가 셈하므로 여기서는 저장·전달이 정확한지만 본다.
import { describe, expect, test } from 'vitest';
import { COMMANDER_A, COMMANDER_C, DRY_RUN, EVENT, JUDGEMENT, NOW, OPERATOR_B, TENANT, approveBy, fixture, pendingApproval, problem, recordOf, requested } from './event-cancellation-fixtures.js';

describe('판정·미리보기·확정 [BAT-420 GAT-110 W]', () => {
  test('R-T37 ① 판정하면 미리보기를 저장하고 승인 대기가 된다', async () => {
    const f = fixture();
    const r = await requested(f);
    const view = await f.app.judge(r.requestId, { ...JUDGEMENT }, COMMANDER_A);
    expect(f.previewCalls).toEqual([{ eventId: EVENT, requestId: r.requestId, fault: 'ORGANIZER' }]);
    expect(view.status).toBe('PENDING_APPROVAL');
    expect(view.dryRun).toEqual({
      targetOrders: 3,
      refundTotal: 133_332,
      compensationTargets: 3,
      compensationTotal: 13_335,
      perPg: [
        { pg: 'TOSS', orders: 1, estimatedSeconds: 1 },
        { pg: 'PORTONE', orders: 2, estimatedSeconds: 1 },
      ],
    });
    const row = f.store.rows.get(r.requestId)!;
    expect(row).toMatchObject({ status: 'PENDING_APPROVAL', fault: 'ORGANIZER', judgedBy: COMMANDER_A.accountId, fanNoticeReason: '공연이 취소되었습니다', judgementReason: '주최 측 귀책' });
    expect(row.dryRun).toEqual(DRY_RUN);
    const entries = f.audit.entries.filter((e) => e.recordId === r.requestId);
    expect(entries.map((e) => e.recordType)).toEqual(['EVENT_CANCELLATION_REQUESTED', 'EVENT_CANCELLATION_JUDGED', 'EVENT_CANCELLATION_PREVIEWED']);
    expect(entries[2]!.record.payload).toMatchObject({ status: 'PENDING_APPROVAL' });
    // 관제 상세도 미리보기를 싣는다
    expect((await f.app.get(r.requestId)).dryRun).toEqual(DRY_RUN);
  });

  test('R-T37 ② 미리보기가 실패한 판정 뒤에는 확정되지 않고 409 preview-required다', async () => {
    const f = fixture();
    const r = await requested(f);
    f.behaviour.previewFails = true;
    await expect(f.app.judge(r.requestId, { ...JUDGEMENT }, COMMANDER_A)).rejects.toMatchObject(problem('event-refund-unavailable', 503));
    const row = f.store.rows.get(r.requestId)!;
    expect(row.status).toBe('JUDGED');
    expect(row.dryRun ?? null).toBeNull();
    expect(row.fault).toBe('ORGANIZER');
    await expect(approveBy(f, r.requestId)).rejects.toMatchObject(problem('preview-required', 409));
    expect(f.stopCalls).toEqual([]);
    expect(f.startCalls).toEqual([]);
    expect(f.store.rows.get(r.requestId)!.status).toBe('JUDGED');
  });

  test('R-T37 ② 판정 전에는 확정되지 않고 409 judgement-required다', async () => {
    const f = fixture();
    const r = await requested(f);
    await expect(approveBy(f, r.requestId)).rejects.toMatchObject(problem('judgement-required', 409));
    expect(f.stopCalls).toEqual([]);
    expect(f.startCalls).toEqual([]);
    expect(f.store.rows.get(r.requestId)!.status).toBe('REQUESTED');
  });

  test('R-T37 ② 미리보기 읽기기를 조립하지 않았으면 판정은 503 event-refund-unavailable이고 JUDGED에 머문다', async () => {
    const f = fixture({ without: ['reader'] });
    const r = await requested(f);
    await expect(f.app.judge(r.requestId, { ...JUDGEMENT }, COMMANDER_A)).rejects.toMatchObject(problem('event-refund-unavailable', 503));
    expect(f.store.rows.get(r.requestId)).toMatchObject({ status: 'JUDGED' });
    await expect(approveBy(f, r.requestId)).rejects.toMatchObject(problem('preview-required', 409));
  });

  test('R-T37 ③ 승인자 반려는 재판정 대기(JUDGED)로 돌려 미리보기를 지우고 다시 판정해야 확정된다', async () => {
    const f = fixture();
    const requestId = await pendingApproval(f);
    const rejected = await f.app.reject(requestId, OPERATOR_B, '증빙 부족');
    expect(rejected.status).toBe('JUDGED');
    expect(rejected.dryRun).toBeUndefined();
    expect(f.store.rows.get(requestId)!.dryRun ?? null).toBeNull();
    await expect(approveBy(f, requestId)).rejects.toMatchObject(problem('preview-required', 409));
    expect(f.stopCalls).toEqual([]);
    const again = await f.app.judge(requestId, { ...JUDGEMENT }, COMMANDER_A);
    expect(again.status).toBe('PENDING_APPROVAL');
    expect(f.previewCalls).toHaveLength(2);
    expect((await approveBy(f, requestId)).status).toBe('RUNNING');
    const entries = f.audit.entries.filter((e) => e.recordType === 'EVENT_CANCELLATION_REJECTED');
    expect(entries).toHaveLength(1);
    expect(entries[0]!.record.payload).toMatchObject({ status: 'JUDGED', reason: '증빙 부족' });
  });

  test('R-T37 ③ 판정 전 반려는 commander만 하고 REJECTED와 반려 사유를 남기며 operator는 403 rejection-not-allowed다', async () => {
    const f = fixture();
    const r = await requested(f);
    await expect(f.app.reject(r.requestId, OPERATOR_B, '근거 없음')).rejects.toMatchObject(problem('rejection-not-allowed', 403));
    expect(f.store.rows.get(r.requestId)!.status).toBe('REQUESTED');
    const rejected = await f.app.reject(r.requestId, COMMANDER_C, '파트너 확인 결과 공연 진행');
    expect(rejected.status).toBe('REJECTED');
    expect(f.store.rows.get(r.requestId)).toMatchObject({ status: 'REJECTED', rejectionReason: '파트너 확인 결과 공연 진행' });
  });

  test('R-T37 ③ 판정자 본인은 판정 뒤 반려할 수 없다(JUDGED·PENDING_APPROVAL 둘 다)', async () => {
    const f = fixture();
    const requestId = await pendingApproval(f);
    await expect(f.app.reject(requestId, COMMANDER_A, '본인')).rejects.toMatchObject(problem('approver-ineligible', 403));
    const g = fixture();
    const r = await requested(g);
    g.behaviour.previewFails = true;
    await g.app.judge(r.requestId, { ...JUDGEMENT }, COMMANDER_A).catch(() => undefined);
    expect(g.store.rows.get(r.requestId)!.status).toBe('JUDGED');
    await expect(g.app.reject(r.requestId, COMMANDER_A, '본인')).rejects.toMatchObject(problem('approver-ineligible', 403));
  });

  test('GAT-110 W1 상세는 dryRun과 진행 중이면 결제사별 진행률을 싣고 읽기 실패면 상태만 싣는다', async () => {
    const f = fixture();
    const requestId = await pendingApproval(f);
    const pending = await f.app.get(requestId);
    expect(pending.dryRun).toEqual(DRY_RUN);
    expect(pending.progress).toBeUndefined();
    expect(f.jobCalls).toEqual([]);
    await approveBy(f, requestId);
    const running = await f.app.get(requestId);
    expect(f.jobCalls.at(-1)).toBe(requestId);
    expect(running.progress).toMatchObject({ state: 'RUNNING', total: 30, done: 8, failed: 5 });
    expect(running.progress?.perPg).toHaveLength(2);
    expect(running.progress?.perPg?.[0]).toMatchObject({ pg: 'TOSS', state: 'RUNNING', done: 5, failed: 1, unknown: 2 });
    expect(running.progress?.perPg?.[1]).toMatchObject({ pg: 'PORTONE', state: 'PAUSED', pauseReason: 'MANUAL', done: 3, failed: 4, unknown: 6 });
    expect(running.dryRun).toEqual(DRY_RUN);
    f.behaviour.jobFails = true;
    expect((await f.app.get(requestId)).progress).toEqual({ state: 'RUNNING' });
    // 목록은 미리보기·결제사별 진행을 싣지 않는다
    const listed = (await f.app.list({ eventId: EVENT, limit: 10 })).items[0]!;
    expect(listed).not.toHaveProperty('dryRun');
    expect(listed.progress?.perPg).toBeUndefined();
  });

  test('GAT-110 W1 진행률은 RUNNING·PAUSED·REFUND_WINDOW·COMPLETED에서만 읽는다', async () => {
    for (const status of ['RUNNING', 'PAUSED', 'REFUND_WINDOW', 'COMPLETED'] as const) {
      const f = fixture();
      const r = recordOf({ status, fault: 'ORGANIZER', judgedBy: COMMANDER_A.accountId, approvedBy: OPERATOR_B.accountId, refundJobState: status === 'COMPLETED' ? 'COMPLETED' : 'RUNNING' });
      await f.store.insert(r);
      expect((await f.app.get(r.requestId)).progress).toMatchObject({ total: 30, done: 8, failed: 5 });
      expect(f.jobCalls).toEqual([r.requestId]);
    }
    for (const status of ['REQUESTED', 'JUDGED', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED'] as const) {
      const f = fixture();
      const r = recordOf({ status });
      await f.store.insert(r);
      await f.app.get(r.requestId);
      expect(f.jobCalls).toEqual([]);
    }
  });

  test('GAT-110 W2 다시 판정하면 미리보기를 새로 계산하고 판정자가 바뀌어 처음 판정자도 확정할 수 있다', async () => {
    const f = fixture();
    const requestId = await pendingApproval(f);
    f.behaviour.dryRun = { ...DRY_RUN, targetOrders: 4, refundTotal: 166_665 };
    const again = await f.app.judge(requestId, { fault: 'FORCE_MAJEURE', reason: '태풍', fanNoticeReason: '기상 특보로 공연이 취소되었습니다' }, COMMANDER_C);
    expect(f.previewCalls).toEqual([
      { eventId: EVENT, requestId, fault: 'ORGANIZER' },
      { eventId: EVENT, requestId, fault: 'FORCE_MAJEURE' },
    ]);
    expect(again).toMatchObject({ status: 'PENDING_APPROVAL', judgedBy: { adminAccountId: COMMANDER_C.accountId, displayName: null, role: 'commander' }, fault: 'FORCE_MAJEURE' });
    expect(f.store.rows.get(requestId)!.dryRun).toMatchObject({ targetOrders: 4, refundTotal: 166_665 });
    await expect(approveBy(f, requestId, COMMANDER_C)).rejects.toMatchObject(problem('approver-ineligible', 403));
    expect((await approveBy(f, requestId, COMMANDER_A)).status).toBe('RUNNING');
    expect(f.startCalls[0]).toMatchObject({ ruledBy: COMMANDER_C.accountId, confirmedBy: COMMANDER_A.accountId, fault: 'FORCE_MAJEURE' });
  });

  test('GAT-110 W3 확정 뒤 일괄 환불 시작이 실패하면 PENDING_APPROVAL로 돌아가고 미리보기는 남으며 다시 확정하면 같은 요청 ID로 다시 멈춘다', async () => {
    const f = fixture();
    const requestId = await pendingApproval(f);
    f.behaviour.startFails = true;
    await expect(approveBy(f, requestId)).rejects.toThrow('purchase down');
    const back = f.store.rows.get(requestId)!;
    expect(back).toMatchObject({ status: 'PENDING_APPROVAL', approvedBy: null, approvedAt: null });
    expect(back.dryRun).toEqual(DRY_RUN);
    expect(f.stopCalls).toEqual([{ eventId: EVENT, requestId }]);
    f.behaviour.startFails = false;
    expect((await approveBy(f, requestId)).status).toBe('RUNNING');
    expect(f.stopCalls).toEqual([
      { eventId: EVENT, requestId },
      { eventId: EVENT, requestId },
    ]);
    expect(f.startCalls).toHaveLength(2);
  });

  // 검증(e2d565c6) 살아남은 M-RT37-2e: 판정이 늘 미리보기를 함께 저장해 이 상태를 흐름으로 못 만든다. 0013 전 행은 dry_run이 NULL일 수 있어 행을 바로 둔다
  test('R-T37 ② 미리보기 없이 승인 대기인 행(0013 전 행, dry_run 빔)도 확정되지 않고 409 preview-required이며 미룸 늘리기·판매 멈춤·시작·감사가 0이다', async () => {
    const f = fixture();
    const row = recordOf({ status: 'PENDING_APPROVAL', fault: 'ORGANIZER', judgementReason: '주최 측 귀책', fanNoticeReason: '공연이 취소되었습니다', judgedBy: COMMANDER_A.accountId, judgedAt: new Date(NOW - 30_000), dryRun: null });
    f.store.rows.set(row.requestId, row);
    await expect(approveBy(f, row.requestId)).rejects.toMatchObject(problem('preview-required', 409));
    expect(f.holdCalls).toEqual([]);
    expect(f.stopCalls).toEqual([]);
    expect(f.startCalls).toEqual([]);
    expect(f.audit.entries).toEqual([]);
    expect(f.store.rows.get(row.requestId)).toMatchObject({ status: 'PENDING_APPROVAL', approvedBy: null, version: row.version });
  });
});

describe('확정 때 판매 멈춤 [BAT-420 GAT-110 H]', () => {
  test('R-T37 ④ 판매 멈춤이 실패하면 확정하지 않고 다시 확정하면 판매가 멈춘 뒤에 일괄 환불이 시작된다', async () => {
    const f = fixture();
    const requestId = await pendingApproval(f);
    f.behaviour.stopFails = true;
    await expect(approveBy(f, requestId)).rejects.toMatchObject(problem('sale-stop-unavailable', 503));
    const row = f.store.rows.get(requestId)!;
    expect(row.status).toBe('PENDING_APPROVAL');
    expect(row.approvedBy).toBeNull();
    expect(row.dryRun).toEqual(DRY_RUN);
    expect(f.startCalls).toEqual([]);
    expect(f.stopCalls).toEqual([{ eventId: EVENT, requestId }]);
    f.behaviour.stopFails = false;
    const ok = await approveBy(f, requestId);
    expect(ok.status).toBe('RUNNING');
    expect(f.log.filter((x) => x.startsWith('stop:') || x.startsWith('start:'))).toEqual([`stop:${requestId}`, `stop:${requestId}`, `start:${requestId}`]);
    expect(f.startCalls[0]).toMatchObject({ eventId: EVENT, requestId, kind: 'CANCEL', ruledBy: COMMANDER_A.accountId, confirmedBy: OPERATOR_B.accountId });
  });

  test('R-T37 ④ 판매 멈춤 집행기를 조립하지 않았으면 회차 취소 확정은 503 sale-stop-unavailable이고 시작 호출이 없다', async () => {
    const f = fixture({ without: ['stopper'] });
    const requestId = await pendingApproval(f);
    await expect(approveBy(f, requestId)).rejects.toMatchObject(problem('sale-stop-unavailable', 503));
    expect(f.startCalls).toEqual([]);
    expect(f.store.rows.get(requestId)!.status).toBe('PENDING_APPROVAL');
  });

  test('R-T37 ④ 연기 확정은 판매를 멈추지 않는다', async () => {
    const f = fixture();
    const newStartsAt = new Date(NOW + 30 * 86_400_000);
    const r = recordOf({ kind: 'POSTPONE', status: 'PENDING_APPROVAL', fault: 'CONTENT_CHANGE', judgedBy: COMMANDER_A.accountId, judgedAt: new Date(NOW - 1_000), fanNoticeReason: '공연이 연기되었습니다', dryRun: DRY_RUN, newStartsAt, requestedVia: 'PARTNER', promoterId: TENANT });
    await f.store.insert(r);
    const view = await approveBy(f, r.requestId);
    expect(view.status).toBe('REFUND_WINDOW');
    expect(f.stopCalls).toEqual([]);
    expect(f.startCalls).toHaveLength(1);
    expect(f.startCalls[0]).toMatchObject({ kind: 'POSTPONE', postponedToMs: newStartsAt.getTime() });
  });
});
