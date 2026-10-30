// CMP-024 PriceTierLegend. 좌석 등급별 가격 범례(list 시맨틱). 서버 컴포넌트에서도 쓴다.
// - swatch(전체 배치 보기, 보드 SCR-010): <ul class="legend" aria-label="등급과 가격"><li class="legend-item">
//   <span style="width:14px;height:10px;background:var(--heat-3)"></span><span class="fw-b">R석</span><span class="num">₩154,000</span>
//   등급 면 색은 데이터 시각화 색 heat를 빌려 가격이 높은 등급부터 heat-3·heat-2·heat-1을 칠하고, 넷째 등급부터는 칠하지 않는다(ADR-0089).
//   등급 글자를 늘 함께 쓴다(색만으로 등급을 말하지 않는다). heat-1 견본에는 border를 긋는다.
// - plain(좌석 보기): <ul class="row wrap t-sm"><li><span class="fw-b">R석</span> <span class="num muted">₩154,000</span></li>
// - tiers는 가격이 높은 순서로 준다. 금액은 원 단위 정수.
import type { CSSProperties } from 'react';
import { cx } from '../../lib/cx';
import { formatWon } from '../../lib/format';

export interface PriceTier {
  name: string;
  price: number;
}

export interface PriceTierLegendProps {
  tiers: readonly PriceTier[];
  variant?: 'swatch' | 'plain';
  label?: string;
  className?: string;
  style?: CSSProperties;
}

const HEAT = ['var(--heat-3)', 'var(--heat-2)', 'var(--heat-1)'];

export function PriceTierLegend({ tiers, variant = 'swatch', label = '등급과 가격', className, style }: PriceTierLegendProps) {
  if (variant === 'plain') {
    return (
      <ul className={cx('row wrap t-sm', className)} style={{ gap: '4px 14px', ...style }} aria-label={label}>
        {tiers.map((t) => (
          <li key={t.name}>
            <span className="fw-b">{t.name}</span> <span className="num muted">{formatWon(t.price)}</span>
          </li>
        ))}
      </ul>
    );
  }
  return (
    <ul className={cx('legend', className)} style={{ gap: '4px 14px', ...style }} aria-label={label}>
      {tiers.map((t, i) => (
        <li key={t.name} className="legend-item">
          {i < HEAT.length ? (
            <span
              aria-hidden="true"
              style={{
                display: 'inline-block',
                width: 14,
                height: 10,
                borderRadius: 2,
                background: HEAT[i],
                ...(i === 2 ? { boxShadow: 'inset 0 0 0 1px var(--border)' } : null),
              }}
            />
          ) : null}
          <span className="fw-b" style={{ color: 'var(--text)' }}>
            {t.name}
          </span>
          <span className="num">{formatWon(t.price)}</span>
        </li>
      ))}
    </ul>
  );
}
