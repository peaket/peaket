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
    authzDenied(o) {
      // 보안 사건(ASVS 16.3.2): 파트너·계정·정산서·동작만 싣는다. 정산서 금액·계좌는 싣지 않는다(J-T10)
      try {
        logger.warn(
          { event: 'settlement_authz_denied', partnerId: o.partnerId, accountId: o.accountId, statementId: o.statementId, ...(o.eventId ? { eventId: o.eventId } : {}), action: o.action, at: o.at.toISOString() },
          '다른 파트너의 정산서에 닿으려 했다',
        );
      } catch {
        // 기록 실패는 404 응답을 바꾸지 않는다
      }
    },
    caseNoticeFailed(o) {
      try {
        logger.warn({ event: 'settlement_dispute_case_deferred', disputeId: o.disputeId, statementId: o.statementId, ...(o.reason ? { reason: o.reason } : {}), at: o.at.toISOString() }, 'CS 처리함 정산 이의 건을 열지 못했거나 연 표시를 쓰지 못해 다음 점검에서 다시 보낸다');
      } catch {
        // 기록 실패는 이의 접수를 바꾸지 않는다
      }
    },
    payoutCaseNoticeFailed(o) {
      try {
        logger.warn({ event: 'settlement_payout_case_deferred', eventKey: o.eventKey, kind: o.kind, at: o.at.toISOString() }, '지급 쪽 CS 처리함 건을 열지 못해 다음 점검에서 다시 보낸다');
      } catch {
        // 기록 실패는 건 요청 행을 바꾸지 않는다
      }
    },
    // 정산 웹훅 보안 이벤트(ASVS 16.3.3, F-07-6 ADR-0369 결정 5): 전송 ID·시각만 싣는다. 보안 키·서명·본문은 싣지 않는다
    webhookSignatureInvalid(o) {
      try {
        logger.warn({ event: 'settlement_webhook_signature_invalid', transmissionId: o.transmissionId, at: o.at.toISOString() }, '서명이 맞지 않는 정산 웹훅을 거절했다');
      } catch {
        // 기록 실패는 400 응답을 바꾸지 않는다
      }
    },
    webhookLate(o) {
      try {
        logger.warn({ event: 'settlement_webhook_late', transmissionId: o.transmissionId, sentAt: o.sentAt, at: o.at.toISOString() }, '늦은 정산 웹훅이다. 본문을 쓰지 않고 단건 조회로만 확정한다');
      } catch {
        // 기록 실패는 처리를 바꾸지 않는다
      }
    },
    webhookUnconfigured(o) {
      try {
        logger.warn({ event: 'settlement_webhook_unconfigured', at: o.at.toISOString() }, '토스 지급대행 설정이 없어 정산 웹훅을 받지 않았다');
      } catch {
        // 기록 실패는 400 응답을 바꾸지 않는다
      }
    },
    tossJweInvalid(o) {
      // 보안 사건(ASVS 16.3.4): 상점만 싣는다. 보안 키·JWE 원문은 싣지 않는다
      try {
        logger.warn({ event: 'settlement_toss_jwe_invalid', pgStore: o.pgStore, at: o.at.toISOString() }, '토스페이먼츠 응답 JWE를 쓰지 않았다(다른 alg·enc 또는 복호 실패)');
      } catch {
        // 기록 실패는 응답 없음 처리를 바꾸지 않는다
      }
    },
    payoutJobFailed(o) {
      try {
        logger.warn({ event: 'settlement_payout_job_failed', job: o.job, ...(o.batchId ? { batchId: o.batchId } : {}), ...(o.pgStore ? { pgStore: o.pgStore } : {}), reason: o.reason, at: o.at.toISOString() }, '토스 지급의 자동 일을 하지 못해 다음 점검에서 다시 본다');
      } catch {
        // 기록 실패는 일꾼을 멈추지 않는다
      }
    },
    // F-07-7(계획 §5.1 (사)·(파) (마)): 보안·운영 사건. 계좌번호·예금주명·토큰·본문은 싣지 않는다
    payoutAccountReauthRejected(o) {
      // 보안 사건(ASVS 16.3.3): 파트너·사유 종류만
      try {
        logger.warn({ event: 'payout_account_reauth_rejected', promoterId: o.promoterId, reason: o.reason, at: o.at.toISOString() }, '정산 계좌 변경의 재인증을 받지 않았다');
      } catch {
        // 기록 실패는 403 응답을 바꾸지 않는다
      }
    },
    portoneReconciliationFailed(o) {
      try {
        logger.warn({ event: 'portone_reconciliation_failed', name: o.name, kind: o.kind, at: o.at.toISOString() }, '포트원 사후 대사를 끝내지 못해 성공 시각을 옮기지 않았다');
      } catch {
        // 기록 실패는 일꾼을 멈추지 않는다
      }
    },
    opsIntakeRefused(o) {
      try {
        logger.warn({ event: 'ops_intake_refused', target: o.target, eventKey: o.eventKey, kind: o.kind, refusal: o.refusal, count: o.count, at: o.at.toISOString() }, 'ops가 같은 요청을 거듭 거절해 더 보내지 않는다(사람이 본다)');
      } catch {
        // 기록 실패는 행의 영구 실패 표시를 바꾸지 않는다
      }
    },
  };
}
