// 배상 송금 결과 확정(F-07-8 I-06, transfer-refund §6 '송금 결과 확정', R-T47 ③, ADR-0317).
// 일괄 환불 실행기 틱 끝에서 REQUESTED인 compensation마다 payment-svc GetCompensationTransfer를 부른다.
// PAID면 상태·receivable_id를, FAILED면 상태를 조건부 갱신(status = 'REQUESTED')으로 쓰고 FAILED는 CS '배상 대기'(COMPENSATION_PENDING) 한 건을 연다
// (계좌 입력 송금 실패와 같은 사건 키 compensation:{id}라 겹쳐도 ops가 한 건으로 모은다). 여전히 REQUESTED·조회 실패·모르는 송금 ID는 그대로 둔다.
// 두 파드가 겹쳐도 조건부 갱신이 이긴 쪽만 CS 건을 연다. 계좌번호 원문은 이 길에 없다(POL-014).
import type { Clock } from '@peaket/platform';
import type { CompensationCaseNotice, CompensationRefreshStore, CompensationTransferLookup } from '../domain/ports.js';

/** 한 바퀴의 기본 상한 50건 [가정] */
export const COMPENSATION_REFRESH_DEFAULT_LIMIT = 50;

export interface RefreshCompensationTransfersDeps {
  readonly store: CompensationRefreshStore;
  readonly transfer: CompensationTransferLookup;
  /** FAILED의 CS '배상 대기' 건. 없으면 열지 않는다 */
  readonly cases?: CompensationCaseNotice;
  readonly clock: Clock;
  readonly log?: { warn(o: object, msg: string): void };
}

export class RefreshCompensationTransfers {
  constructor(private readonly o: RefreshCompensationTransfersDeps) {}

  async run(limit: number = COMPENSATION_REFRESH_DEFAULT_LIMIT): Promise<{ paid: number; failed: number; pending: number }> {
    const rows = await this.o.store.listRequested(limit);
    let paid = 0;
    let failed = 0;
    let pending = 0;
    for (const row of rows) {
      if (row.transferId === undefined) continue;
      let answer: Awaited<ReturnType<CompensationTransferLookup['get']>>;
      try {
        answer = await this.o.transfer.get(row.transferId);
      } catch (err) {
        // 조회 실패는 그대로 두고 다음 바퀴에 다시 본다(송금 ID만 싣는다)
        this.o.log?.warn({ event: 'compensation_transfer_refresh_failed', transferId: row.transferId, err: err instanceof Error ? err.name : 'unknown' }, '배상 송금 결과를 조회하지 못했다(다음 바퀴에 다시 본다)');
        pending += 1;
        continue;
      }
      if (answer === undefined || answer.status === 'REQUESTED') {
        pending += 1;
        continue;
      }
      const nowMs = this.o.clock.now();
      if (answer.status === 'PAID') {
        if (await this.o.store.settleRequested(row.compensationId, { status: 'PAID', ...(answer.receivableId !== undefined ? { receivableId: answer.receivableId } : {}), nowMs })) paid += 1;
        continue;
      }
      if (!(await this.o.store.settleRequested(row.compensationId, { status: 'FAILED', ...(answer.failureReason !== undefined ? { failureReason: answer.failureReason } : {}), nowMs }))) continue;
      failed += 1;
      try {
        await this.o.cases?.open({ compensationId: row.compensationId, orderId: row.orderId, nowMs });
      } catch (err) {
        this.o.log?.warn({ event: 'compensation-pending-case-failed', compensationId: row.compensationId, err: err instanceof Error ? err.name : 'unknown' }, '배상 대기 CS 건을 열지 못했다');
      }
    }
    return { paid, failed, pending };
  }
}
