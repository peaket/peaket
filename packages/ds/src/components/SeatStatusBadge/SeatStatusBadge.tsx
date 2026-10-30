// CMP-023 SeatStatusBadge. 좌석 상태를 색 + 무늬 + 글자로 함께 보인다(캔버스 키트 15절 .seat, d2 §1 다중 감각). 서버 컴포넌트에서도 쓴다.
// - 키트 클래스: available(기본) · held(다른 분 선택, 빗금) · mine(내 선택, 체크) · sold(판매됨, 교차 빗금) · unav(판매 제외, 점)
//   · wc(휠체어석, 아이콘) · recently-released(방금 놓은 좌석: available 색 테두리만, 보드 SCR-010 인라인 스타일)
// - SeatStatusBadge: 좌석 그림 하나 + 글자(+ 보조 글). 보드 디자인 기초의 '좌석 상태' 목록 모양.
// - SeatLegend: 좌석맵 범례 <ul class="legend" aria-label="좌석 상태 범례"><li class="legend-item"><span class="seat held" style="border-radius:50%">…
// 좌석 그림은 장식(aria-hidden)이고 글자가 상태를 말한다.
import type { CSSProperties, ReactNode } from 'react';
import { cx } from '../../lib/cx';

export type SeatStatus = 'available' | 'held-by-others' | 'mine' | 'sold' | 'unavailable' | 'wheelchair' | 'recently-released';

/** 상태 → 키트 클래스 */
export const seatClass: Record<SeatStatus, string> = {
  available: '',
  'held-by-others': 'held',
  mine: 'mine',
  sold: 'sold',
  unavailable: 'unav',
  wheelchair: 'wc',
  'recently-released': '',
};

/** 범례 글자(보드 SCR-010) */
export const seatLabel: Record<SeatStatus, string> = {
  available: '예매 가능',
  'held-by-others': '다른 분 선택',
  mine: '내 선택',
  sold: '판매됨·선택 불가',
  unavailable: '판매 제외',
  wheelchair: '휠체어석',
  'recently-released': '방금 놓은 좌석',
};

const releasedStyle: CSSProperties = { background: 'transparent', boxShadow: 'inset 0 0 0 2px var(--seat-available)' };

export interface SeatSwatchProps {
  status: SeatStatus;
  /** sm 14 · md 18 · lg 24 */
  size?: 'sm' | 'md' | 'lg';
  /** 동그란 모양(범례) */
  round?: boolean;
  className?: string;
  style?: CSSProperties;
}

/** 좌석 그림 하나(장식) */
export function SeatSwatch({ status, size = 'sm', round = false, className, style }: SeatSwatchProps) {
  return (
    <span
      className={cx('seat', size !== 'sm' && size, seatClass[status], className)}
      aria-hidden="true"
      style={{ ...(round ? { borderRadius: '50%' } : null), ...(status === 'recently-released' ? releasedStyle : null), ...style }}
    />
  );
}

export interface SeatStatusBadgeProps {
  status: SeatStatus;
  /** 글자. 기본은 범례 글자 */
  label?: ReactNode;
  /** 아래 보조 글 */
  description?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
  round?: boolean;
  className?: string;
  style?: CSSProperties;
}

export function SeatStatusBadge({ status, label, description, size = 'lg', round = false, className, style }: SeatStatusBadgeProps) {
  return (
    <span className={cx('row', className)} style={{ gap: 12, ...style }}>
      <SeatSwatch status={status} size={size} round={round} />
      {description ? (
        <span className="col">
          <span className="t-sm fw-b">{label ?? seatLabel[status]}</span>
          <span className="t-xs muted">{description}</span>
        </span>
      ) : (
        <span className="t-sm">{label ?? seatLabel[status]}</span>
      )}
    </span>
  );
}

export interface SeatLegendProps {
  /** 보일 상태(순서대로). 기본은 recently-released를 뺀 여섯 */
  statuses?: readonly SeatStatus[];
  label?: string;
  className?: string;
  style?: CSSProperties;
}

const DEFAULT_LEGEND: readonly SeatStatus[] = ['available', 'held-by-others', 'mine', 'sold', 'unavailable', 'wheelchair'];

export function SeatLegend({ statuses = DEFAULT_LEGEND, label = '좌석 상태 범례', className, style }: SeatLegendProps) {
  return (
    <ul className={cx('legend', className)} style={{ gap: '6px 12px', ...style }} aria-label={label}>
      {statuses.map((s) => (
        <li key={s} className="legend-item">
          <SeatSwatch status={s} round />
          {seatLabel[s]}
        </li>
      ))}
    </ul>
  );
}
