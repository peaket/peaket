// CMP-059 TransferOfferCard. 캔버스 보드 SCR-014 '진행 중인 요청' 카드(sender)와 SCR-041 '양도 받기' 카드(recipient) 마크업을 그대로 낸다.
// 서버 컴포넌트에서도 쓴다(행동 버튼은 children으로 받는다). 여백은 휴대폰 보드 값이고, 넓은 화면 여백은 className으로 더한다.
// - sender: 받는 분(닉네임 일부 '하* 님') · 상태 배지 · 좌석·남은 시간·수락 기한 · 아래에 [요청 철회] 같은 행동.
// - recipient: 보낸 분 · 상태 배지 · 공연 줄(포스터·공연명·회차, media) · 좌석·입장 게이트 · 수락 기한 줄.
//   받는 사람에게는 결제 금액과 결제자 연락처를 보이지 않는다(d2 CMP-059) — 그런 값을 받는 칸을 두지 않는다.
// - 남은 기한은 글자로 읽힌다(색만으로 말하지 않는다). 수락 버튼 앞의 '결제자만 취소·환불' 고지는 부르는 쪽이 카드 뒤·버튼 앞에 둔다.
import { Fragment, type CSSProperties, type ReactNode } from 'react';
import { cx } from '../../lib/cx';
import { badgeClass, type BadgeTone } from '../Badge/Badge';

export type TransferOfferVariant = 'sender' | 'recipient';

export interface TransferOfferDetail {
  label: ReactNode;
  value: ReactNode;
  /** 고정폭 숫자(남은 시간 등) */
  num?: boolean;
}

export interface TransferOfferDeadline {
  /** '수락 기한 10/24(토) 15:20' */
  label: ReactNode;
  /** '46시간 10분 남음' 또는 '지남' */
  value: ReactNode;
  /** 기한이 지났으면 앞 글을 흐리게 */
  expired?: boolean;
}

export interface TransferOfferCardProps {
  variant: TransferOfferVariant;
  /** 상대 표시 이름(sender: '하* 님', recipient: '지민') */
  partyName: ReactNode;
  /** 동그라미 안 글자(장식) */
  partyInitial: string;
  /** 상태 배지(수락 대기 · 받은 티켓 · 기한 지남 · 철회됨 …) */
  status: { label: ReactNode; tone?: BadgeTone };
  /** recipient: 포스터·공연명·회차 줄 */
  media?: ReactNode;
  /** 좌석·남은 시간·수락 기한(sender) / 좌석·입장 게이트(recipient) */
  details: readonly TransferOfferDetail[];
  /** recipient: 카드 아래 수락 기한 줄(.card-flat) */
  deadline?: TransferOfferDeadline;
  /** 카드 이름(sender: 'R구역 12열 8번 양도 요청') */
  'aria-label'?: string;
  /** recipient: 공연명 제목 id */
  'aria-labelledby'?: string;
  /** 카드 안 맨 아래(행동 버튼·오류) */
  children?: ReactNode;
  /** 카드 간격·여백을 넓히는 반응형 유틸(예: 'md:gap-[18px] md:px-6 md:py-[22px]') */
  className?: string;
  /** 수락 기한 줄의 반응형 여백(예: 'md:px-3.5 lg:px-4 lg:py-3') */
  deadlineClassName?: string;
  style?: CSSProperties;
}

export function TransferOfferCard({
  variant,
  partyName,
  partyInitial,
  status,
  media,
  details,
  deadline,
  'aria-label': ariaLabel,
  'aria-labelledby': labelledBy,
  children,
  className,
  deadlineClassName,
  style,
}: TransferOfferCardProps) {
  const sender = variant === 'sender';
  return (
    <article
      className={cx('card col', sender ? 'gap-3.5 p-4' : 'gap-4 px-4 py-[18px]', className)}
      style={style}
      aria-label={ariaLabel}
      aria-labelledby={labelledBy}
    >
      <div className="row between" style={{ gap: 8 }}>
        <span className="row" style={{ gap: 10 }}>
          <span className="avatar" aria-hidden="true">
            {partyInitial}
          </span>
          {sender ? (
            <span className="col" style={{ gap: 2 }}>
              <span className="t-md fw-b">{partyName}</span>
              <span className="t-xs muted">받는 분</span>
            </span>
          ) : (
            <span className="col" style={{ gap: 2 }}>
              <span className="t-xs muted">보낸 분</span>
              <span className="t-md fw-b">{partyName}</span>
            </span>
          )}
        </span>
        <span className={badgeClass(status.tone ?? 'neutral')}>{status.label}</span>
      </div>
      {media}
      <dl className="kv">
        {details.map((d, i) => (
          <Fragment key={i}>
            <dt>{d.label}</dt>
            <dd className={d.num ? 'num' : undefined}>{d.value}</dd>
          </Fragment>
        ))}
      </dl>
      {deadline ? (
        <div className={cx('card-flat row between gap-2 px-3 py-2.5', deadlineClassName)}>
          <span className={cx('t-sm', deadline.expired && 'muted')}>{deadline.label}</span>
          <span className={cx('t-sm fw-b', !deadline.expired && 'num')}>{deadline.value}</span>
        </div>
      ) : null}
      {children}
    </article>
  );
}
