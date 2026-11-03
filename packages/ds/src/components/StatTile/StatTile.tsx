// CMP-032 StatTile. 캔버스 키트 13절 .stat 마크업을 그대로 낸다. 서버 컴포넌트에서도 쓴다.
//   <div class="stat [is-burning|is-breached|is-stale]"><span class="stat-label">결제 확정 성공률</span><span class="stat-value">99.97%</span>
//   <span class="slo slo-ok">정상 · 기준 99.95%</span><span class="stat-meta">남은 허용 실패 9건</span></div>
// - status: ok · burning(버짓 소진) · breached(위반) · stale(수집 지연). 점·글자·테두리를 함께 바꿔 색만으로 말하지 않는다.
//   statusText를 주면 상태 줄(.slo)을 그린다(글자로 상태와 기준을 적는다).
// - badge: 이름 줄 오른쪽(잠정 등, 보드 SCR-026의 .row.between).
import type { CSSProperties, ReactNode } from 'react';
import { cx } from '../../lib/cx';

export type StatStatus = 'ok' | 'burning' | 'breached' | 'stale';

export interface StatTileProps {
  label: ReactNode;
  value: ReactNode;
  status?: StatStatus;
  statusText?: ReactNode;
  meta?: ReactNode;
  badge?: ReactNode;
  /** 바깥 요소. 목록 안이면 li */
  as?: 'div' | 'li' | 'section';
  className?: string;
  style?: CSSProperties;
}

export function StatTile({ label, value, status, statusText, meta, badge, as: Comp = 'div', className, style }: StatTileProps) {
  const labelEl = <span className="stat-label">{label}</span>;
  return (
    <Comp className={cx('stat', status && status !== 'ok' && `is-${status}`, className)} style={style}>
      {badge ? (
        <div className="row between">
          {labelEl}
          {badge}
        </div>
      ) : (
        labelEl
      )}
      <span className="stat-value">{value}</span>
      {statusText ? <span className={cx('slo', `slo-${status ?? 'ok'}`)}>{statusText}</span> : null}
      {meta ? <span className="stat-meta">{meta}</span> : null}
    </Comp>
  );
}
