// 문의 상태 배지(보드 SCR-056): 접수됨 primary · 처리 중 warning · 답변 완료 success(체크 아이콘) · 닫힘 기본. 글자로 상태를 말한다.
import type { InquiryStatus } from '../model';

const TONE: Record<InquiryStatus, string> = {
  접수됨: 'badge badge-primary',
  '처리 중': 'badge badge-warning',
  '답변 완료': 'badge badge-success',
  닫힘: 'badge',
};

export function InquiryStatusBadge({ status }: { status: InquiryStatus }) {
  return (
    <span className={TONE[status]}>
      {status === '답변 완료' ? <i className="ic ic-check" aria-hidden="true" /> : null}
      {status}
    </span>
  );
}
