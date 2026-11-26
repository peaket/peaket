// SCR-046 승인 업무 종류별 카드(F-06-3 GAT-290·GAT-300, d5 §7.7, settlement §9).
// 서버 글은 글자 노드로만 그리고, 결제사·계좌·요청자 개인정보는 그리지 않는다.
import { digestMatches, evidenceOf, kindLabel, payeeDigestOf, quorumLabel, statusOf, type ApprovalView } from '../model/live';

const won = (v: number | null): string => (v === null ? '—' : `${v.toLocaleString('ko-KR')}원`);

export function ApprovalSummary({ view }: { view: ApprovalView }) {
  const quorum = quorumLabel(view.requiredApprovals);
  const evidence = evidenceOf(view);
  const digest = payeeDigestOf(view);
  return (
    <article className="cs-approval-card">
      <header>
        <strong>{kindLabel(view.kind)}</strong>
        <span className="badge">{statusOf(view.status)}</span>
        {quorum ? <span className="badge badge-quorum">{quorum}</span> : null}
      </header>
      <p>대상 {view.targetRef}</p>
      <p>금액 {won(view.amount)}</p>
      <p>사유 {view.reasonText}</p>
      {evidence ? <p>증빙 {evidence}</p> : null}
      {digest ? <p>지급 대상 지문 {digest}</p> : null}
      {digest && !digestMatches(digest, digest) ? <p role="alert">'지급 대상이 바뀌었습니다. 다시 불러와 확인해 주세요</p> : null}
      {view.dueAt ? <p>기한 {view.dueAt}</p> : null}
      {view.closeReason ? <p>닫힘 사유 {view.closeReason}</p> : null}
    </article>
  );
}

export function SystemFaultRefundCard({ view }: { view: ApprovalView }) {
  return (
    <section data-kind="SYSTEM_FAULT_REFUND">
      <h3>시스템 잘못 환불</h3>
      <p>공제 0원 전액 환급 대상입니다. 입장 뒤면 마감 뒤 환급 실행기가 맡습니다.</p>
      <ApprovalSummary view={view} />
    </section>
  );
}

export function DiscretionaryWaiverCard({ view }: { view: ApprovalView }) {
  return (
    <section data-kind="DISCRETIONARY_WAIVER">
      <h3>재량 면제</h3>
      <p>면제분만 추가 환급합니다. 티켓은 취소하지 않습니다.</p>
      <ApprovalSummary view={view} />
    </section>
  );
}

export function TransferReclaimCard({ view }: { view: ApprovalView }) {
  return (
    <section data-kind="TRANSFER_RECLAIM">
      <h3>양도 회수</h3>
      <p>소명 기한이 지난 뒤 입장 시작 전까지만 승인할 수 있습니다.</p>
      <ApprovalSummary view={view} />
    </section>
  );
}

export function MinorContractCancelCard({ view }: { view: ApprovalView }) {
  return (
    <section data-kind="MINOR_CONTRACT_CANCEL">
      <h3>미성년자 계약 취소</h3>
      <p>확인한 증빙 종류만 보입니다. 생년월일·연계정보는 화면에 싣지 않습니다.</p>
      <ApprovalSummary view={view} />
    </section>
  );
}

export function PayoutBatchCard({ view }: { view: ApprovalView }) {
  const digest = payeeDigestOf(view);
  return (
    <section data-kind="PAYOUT_BATCH">
      <h3>지급 묶음</h3>
      <ApprovalSummary view={view} />
      {digest ? <p>지급 대상 지문 {digest}</p> : <p>지문 없음</p>}
    </section>
  );
}

export function SettlementAdjustmentCard({ view }: { view: ApprovalView }) {
  return (
    <section data-kind="SETTLEMENT_ADJUSTMENT">
      <h3>정산서 수기 조정</h3>
      <p>정산서 {view.targetRef}</p>
      <p>금액 {won(view.amount)}</p>
      <p>사유 {view.reasonText}</p>
    </section>
  );
}

export function ApprovalCard({ view }: { view: ApprovalView }) {
  switch (view.kind) {
    case 'SYSTEM_FAULT_REFUND':
      return <SystemFaultRefundCard view={view} />;
    case 'DISCRETIONARY_WAIVER':
      return <DiscretionaryWaiverCard view={view} />;
    case 'TRANSFER_RECLAIM':
      return <TransferReclaimCard view={view} />;
    case 'MINOR_CONTRACT_CANCEL':
      return <MinorContractCancelCard view={view} />;
    case 'PAYOUT_BATCH':
      return <PayoutBatchCard view={view} />;
    case 'SETTLEMENT_ADJUSTMENT':
      return <SettlementAdjustmentCard view={view} />;
    default:
      return <ApprovalSummary view={view} />;
  }
}
