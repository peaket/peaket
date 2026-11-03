// 파트너 관리자만 하는 버튼(d5 §3.2 역할 규칙). 역할 규칙에 기대므로 shared가 아니라 features 층에 둔다. 실무자에게는 숨기지 않고 aria-disabled + 늘 보이는 이유 글로 둔다(서버는 403).
//   <AdminOnly isMember={pv.isMember} id="po-change" className="btn btn-outline">계좌 바꾸기</AdminOnly>
import type { ReactNode } from 'react';
import { ADMIN_ONLY_REASON } from '@/entities/partner-user';

export interface AdminOnlyProps {
  isMember: boolean;
  /** 이유 글 id를 만들 바탕 */
  id: string;
  className: string;
  children: ReactNode;
  /** 관리자일 때 여는 대화상자(Modal id) */
  opensModal?: string;
  /** 이유 글(기본 '이 작업은 파트너 관리자만 할 수 있습니다') */
  reason?: string;
  /** 이유 글을 버튼 옆이 아니라 다른 곳에 둘 때 false */
  showReason?: boolean;
  describedBy?: string;
}

export function AdminOnly({ isMember, id, className, children, opensModal, reason, showReason = true, describedBy }: AdminOnlyProps) {
  if (!isMember) {
    return (
      <button
        className={className}
        type="button"
        data-modal-open={opensModal}
        aria-haspopup={opensModal ? 'dialog' : undefined}
        aria-describedby={describedBy}
      >
        {children}
      </button>
    );
  }
  const reasonId = `${id}-role`;
  return (
    <span className="col" style={{ gap: 4, alignItems: 'flex-start' }}>
      <button className={className} type="button" aria-disabled="true" aria-describedby={describedBy ? `${describedBy} ${reasonId}` : reasonId}>
        {children}
      </button>
      {showReason && (
        <span className="row t-xs tx-warning" id={reasonId} style={{ gap: 4 }}>
          <i className="ic ic-lock ic-14" aria-hidden="true" />
          {reason ?? ADMIN_ONLY_REASON}
        </span>
      )}
    </span>
  );
}
