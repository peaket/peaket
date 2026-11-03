// CMP-063 AppealForm의 사안 카드(예매 제한·양도 회수·부정 예매 소명). 정본: d2 CMP-063, d5 §5.24, 캔버스 보드 SCR-042.
// 보드 마크업: <section class="card" aria-labelledby> → 제목 줄(h2 .t-lg + 경고 배지 '제한 중') → <dl class="kv">
//   (사유 범주 배지 · 대상 티켓 · 소명 기한 + 남은 시간 시계 배지(기한이 지나면 '기한 지남' 위험 배지) · 소명 제출 시각)
//   → (구분선 + '처리 일정' 머리 글과 한 줄). 기한은 글자로 읽힌다(d2 CMP-063). 서버 컴포넌트에서도 쓴다.
// fraud(부정 예매 소명, 보드 없음 → d5 §5.24 '부정 예매 소명' 그림): 알린 사유 범주를 모두 테두리 배지로(ul), 대상 칸 이름은 '공연',
//   kv 아래 구분선 + 잠긴 티켓 묶음(h3 머리 글 '양도가 잠긴 티켓 N장' → 좌석 ul(자물쇠 아이콘) → 잠김 안내 한 줄). 잠김은 글자로도 적는다(d3 SCR-042).
//   점수·가중치·근거 신호·사건의 다른 계정 칸은 두지 않는다(d2 CMP-063 fraud). 문구는 모두 앱이 props로 준다.
// fraud-holder(받은 사람, d5 §5.24 '받은 사람의 변형', 추천 적용 2026-10-31, ADR-0173): 사유 범주 줄이 없고(결제자의 사유라서),
//   티켓 묶음은 '내가 가진 표 N장'(표 아이콘, 잠기지 않음)과 안내 두 줄이다. 사유 범주를 주지 않으면 그 줄을 그리지 않는다.
import type { ReactNode } from 'react';
import { cx } from '../../lib/cx';
import { Icon } from '../../icons';

export type AppealVariant = 'restriction' | 'reclaim' | 'fraud' | 'fraud-holder';

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

/** 부정 예매 소명: 이 요청으로 양도가 잠긴 티켓 묶음(받은 사람은 가진 표, 결과는 취소한 표·잠금을 푼 표) */
export interface AppealLockedTickets {
  /** 머리 글(h3) '양도가 잠긴 티켓 2장' · '내가 가진 표 1장' */
  heading: ReactNode;
  /** 좌석 글(목록 ul) 'A구역 3열 14번' */
  items: readonly ReactNode[];
  /** 줄 머리 아이콘(기본 lock: 잠긴 표. 받은 사람·취소한 표는 ticket) */
  icon?: 'lock' | 'ticket';
  /** 목록 아래 안내(한 줄 또는 여러 줄). 예: 잠금 최대 기한 문장 */
  notice?: ReactNode | readonly ReactNode[];
}

export interface AppealCaseCardProps {
  /** 제목(h2)의 id */
  headingId: string;
  variant?: AppealVariant;
  /** '예매 제한' · '양도 회수 예고' · '양도 회수' · '부정 예매 소명 요청' */
  title: ReactNode;
  /** 제목 오른쪽 경고 배지 글(예: '제한 중' · '답변 기다림') */
  statusLabel?: ReactNode;
  /** 사유 범주 하나(테두리 배지, restriction·reclaim) */
  reasonCategory?: ReactNode;
  /** 사유 범주 여럿(테두리 배지 목록, fraud: 알린 범주 모두). 있으면 reasonCategory 대신 쓴다 */
  reasonCategories?: readonly ReactNode[];
  /** 대상 티켓(양도 회수) · 공연과 회차(fraud) */
  target?: ReactNode;
  /** 대상 칸 이름(기본 '대상 티켓', fraud는 '공연') */
  targetLabel?: ReactNode;
  /** 소명 기한 줄 */
  deadline?: AppealDeadline;
  /** 소명 제출 시각 줄(결과·닫힘 화면) */
  submittedAtText?: ReactNode;
  /** 구분선 아래 처리 일정 한 줄 */
  schedule?: ReactNode;
  /** 구분선 아래 잠긴 티켓 묶음(fraud) */
  lockedTickets?: AppealLockedTickets;
  /** 기한 줄과 티켓 묶음 사이의 정보 띠(fraud-holder: d5 §5.24 받은 사람 그림 ①의 순서, 추천 적용 2026-10-31) */
  banner?: ReactNode;
  className?: string;
}

export function AppealCaseCard({
  headingId,
  variant = 'restriction',
  title,
  statusLabel,
  reasonCategory,
  reasonCategories,
  target,
  targetLabel = '대상 티켓',
  deadline,
  submittedAtText,
  schedule,
  lockedTickets,
  banner,
  className,
}: AppealCaseCardProps) {
  const lockedHeadingId = `${headingId}-locked`;
  // 사유 범주를 주지 않으면(받은 사람) 그 줄을 그리지 않는다
  const hasReason = (reasonCategories && reasonCategories.length > 0) || (reasonCategory !== undefined && reasonCategory !== null && reasonCategory !== '');
  const lockedNotices = lockedTickets?.notice === undefined || lockedTickets.notice === null ? [] : Array.isArray(lockedTickets.notice) ? lockedTickets.notice : [lockedTickets.notice];
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
        {hasReason ? (
          <>
            <dt>사유 범주</dt>
            <dd>
              {reasonCategories && reasonCategories.length > 0 ? (
                <ul className="row wrap" style={{ gap: 6, justifyContent: 'flex-end' }}>
                  {reasonCategories.map((c, i) => (
                    <li key={i}>
                      <span className="badge badge-outline">{c}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <span className="badge badge-outline">{reasonCategory}</span>
              )}
            </dd>
          </>
        ) : null}
        {target ? (
          <>
            <dt>{targetLabel}</dt>
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
      {banner ? (
        <div className="banner banner-info">
          <Icon name="info" />
          <div className="banner-body">{banner}</div>
        </div>
      ) : null}
      {lockedTickets ? (
        <>
          <hr className="divider" />
          <div className="col" style={{ gap: 8 }}>
            <h3 id={lockedHeadingId} className="t-sm fw-b">
              {lockedTickets.heading}
            </h3>
            <ul className="col" style={{ gap: 6 }} aria-labelledby={lockedHeadingId}>
              {lockedTickets.items.map((item, i) => (
                <li key={i} className="row t-sm" style={{ gap: 8 }}>
                  <Icon name={lockedTickets.icon ?? 'lock'} size={16} className="muted" />
                  <span>{item}</span>
                </li>
              ))}
            </ul>
            {lockedNotices.map((n, i) => (
              <p key={i} className="t-sm muted">
                {n}
              </p>
            ))}
          </div>
        </>
      ) : null}
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
