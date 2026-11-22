// 지급 묶음 승인 감사 로그(BAT-625 LCH-100). 돈이 움직이는 승인의 성공·거절을 구조화해 남긴다.
// 계좌번호·내부 토큰·승인 사유 원문은 싣지 않는다. 감사 표(payout_batch_audit)는 저장소가 따로 남긴다.
import type { PlatformLogger } from '@peaket/platform';
import type { SettlementApprovalLog } from '../domain/ports.js';

export function settlementApprovalLog(logger: Pick<PlatformLogger, 'info' | 'warn'>): SettlementApprovalLog {
  return {
    approved(o) {
      try {
        logger.info(
          {
            event: 'payout_batch_approved',
            batchId: o.batchId,
            approvalId: o.approvalId,
            requesterId: o.requesterId,
            approverId: o.approverId,
            amount: o.amount,
            currency: 'KRW',
            pg: o.pg,
            pgStore: o.pgStore,
            payoutDate: o.payoutDate,
            at: o.at.toISOString(),
          },
          '지급 묶음 승인을 ops 승인 기록과 대조해 반영했다',
        );
      } catch {
        // 기록 실패가 이미 끝난 승인을 바꾸지 않는다
      }
    },
    rejected(o) {
      try {
        logger.warn(
          { event: 'payout_batch_approval_rejected', batchId: o.batchId, approvalId: o.approvalId, reason: o.reason, at: o.at.toISOString() },
          '지급 묶음 승인을 거절했다',
        );
      } catch {
        // 기록 실패는 거절 결과를 바꾸지 않는다
      }
    },
  };
}
