// CMP-063 AppealForm의 사안 카드(예매 제한·양도 회수). 정본: d2 CMP-063, d5 §5.24, 캔버스 보드 SCR-042.
// 보드 마크업: <section class="card" aria-labelledby> → 제목 줄(h2 .t-lg + 경고 배지 '제한 중') → <dl class="kv">
//   (사유 범주 배지 · 대상 티켓 · 소명 기한 + 남은 시간 시계 배지(기한이 지나면 '기한 지남' 위험 배지) · 소명 제출 시각)
//   → (구분선 + '처리 일정' 머리 글과 한 줄). 기한은 글자로 읽힌다(d2 CMP-063). 서버 컴포넌트에서도 쓴다.
import type { ReactNode } from 'react';
import { cx } from '../../lib/cx';
import { Icon } from '../../icons';

export type AppealVariant = 'restriction' | 'reclaim';

export interface AppealDeadline {
  /** '10/27(화) 18:00' */
  text: ReactNode;
  /** '남은 시간 51시간'(시계 배지) */
  remainingText?: ReactNode;
  /** 기한이 지났다(위험 배지) */
  overdue?: boolean;
  /** 기한이 지났을 때 배지 글(기본 '기한 지남') */
  overdueLabel?: ReactNode;
}

export interface AppealCaseCardProps {
  /** 제목(h2)의 id */
  headingId: string;
  variant?: AppealVariant;
  /** '예매 제한' · '양도 회수 예고' · '양도 회수' */
  title: ReactNode;
  /** 제목 오른쪽 경고 배지 글(예: '제한 중') */
  statusLabel?: ReactNode;
  /** 사유 범주(테두리 배지) */
  reasonCategory: ReactNode;
  /** 대상 티켓(양도 회수) */
  target?: ReactNode;
  /** 소명 기한 줄 */
  deadline?: AppealDeadline;
  /** 소명 제출 시각 줄(결과·닫힘 화면) */
  submittedAtText?: ReactNode;
  /** 구분선 아래 처리 일정 한 줄 */
  schedule?: ReactNode;
  className?: string;
}

export function AppealCaseCard({
  headingId,
  variant = 'restriction',
  title,
  statusLabel,
  reasonCategory,
  target,
  deadline,
  submittedAtText,
  schedule,
  className,
}: AppealCaseCardProps) {
  const heading = (
    <h2 id={headingId} className="t-lg">
      {title}
    </h2>
  );
  return (
    <section className={cx('card col gap-3 p-4 md:p-5', className)} aria-labelledby={headingId} data-variant={variant}>
      {statusLabel ? (
        <div className="row between" style={{ gap: 8 }}>
          {heading}
          <span className="badge badge-warning">{statusLabel}</span>
        </div>
      ) : (
        heading
      )}
      <dl className="kv">
        <dt>사유 범주</dt>
        <dd>
          <span className="badge badge-outline">{reasonCategory}</span>
        </dd>
        {target ? (
          <>
            <dt>대상 티켓</dt>
            <dd>{target}</dd>
          </>
        ) : null}
        {deadline ? (
          <>
            <dt>소명 기한</dt>
            <dd>
              <span className="nowrap">{deadline.text}</span>{' '}
              {deadline.overdue ? (
                <span className="badge badge-danger">
                  <Icon name="alert-circle" />
                  {deadline.overdueLabel ?? '기한 지남'}
                </span>
              ) : deadline.remainingText ? (
                <span className="badge">
                  <Icon name="clock" />
                  {deadline.remainingText}
                </span>
              ) : null}
            </dd>
          </>
        ) : null}
        {submittedAtText ? (
          <>
            <dt>소명 제출</dt>
            <dd>{submittedAtText}</dd>
          </>
        ) : null}
      </dl>
      {schedule ? (
        <>
          <hr className="divider" />
          <div className="col" style={{ gap: 4 }}>
            <span className="eyebrow">처리 일정</span>
            <p className="t-sm">{schedule}</p>
          </div>
        </>
      ) : null}
    </section>
  );
}
