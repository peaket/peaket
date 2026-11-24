// SCR-046 계약 조건 변경 카드의 승인·반려 단추 영역(F-07-2). 데이터를 읽지 않는 표시 부품이라 서버 렌더 시험으로 자격을 확인한다(IR-01).
import type { CardActions } from '../model/contract-approval';

export interface ContractApprovalActionsProps {
  actions: CardActions;
  busy: boolean;
  reason: string;
  onReason: (value: string) => void;
  rejectOpen: boolean;
  rejectReason: string;
  onRejectReason: (value: string) => void;
  onApprove: () => void;
  onToggleReject: () => void;
  onReject: () => void;
  /** 반려 사유가 보낼 수 있는 모양인가(모델의 rejectionBodyOf 결과) */
  rejectReady: boolean;
}

export function ContractApprovalActions({
  actions,
  busy,
  reason,
  onReason,
  rejectOpen,
  rejectReason,
  onRejectReason,
  onApprove,
  onToggleReject,
  onReject,
  rejectReady,
}: ContractApprovalActionsProps) {
  return (
    <>
      <label className="field">
        <span className="label">승인 판단 이유(선택, 1~1,000자)</span>
        <input className="input" value={reason} maxLength={1000} onChange={(e) => onReason(e.target.value)} />
      </label>

      <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
        <button className="btn btn-outline" type="button" onClick={onToggleReject} disabled={busy || !actions.canReject}>
          반려
        </button>
        <button className="btn btn-primary" type="button" onClick={onApprove} disabled={busy || !actions.canApprove} aria-describedby={actions.canApprove ? undefined : 'contract-approval-blocked'}>
          승인
        </button>
      </div>
      {actions.canApprove ? null : <p id="contract-approval-blocked" className="t-xs muted">{actions.reason ?? '이 요청은 지금 계정으로 승인할 수 없습니다.'}</p>}

      {rejectOpen ? (
        <section className="card-flat col" style={{ gap: 10, padding: 14 }} aria-labelledby="h-contract-reject">
          <h3 className="t-sm fw-b" id="h-contract-reject">반려 사유(필수)</h3>
          <textarea className="input" rows={3} value={rejectReason} maxLength={1000} onChange={(e) => onRejectReason(e.target.value)} />
          <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
            <button className="btn btn-outline" type="button" onClick={onToggleReject}>
              취소
            </button>
            <button className="btn btn-danger-outline" type="button" onClick={onReject} disabled={busy || !rejectReady}>
              반려합니다
            </button>
          </div>
        </section>
      ) : null}
    </>
  );
}
