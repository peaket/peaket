'use client';
// 1인 한도 [− n +](키트 .stepper-num). 값은 output으로 알린다(aria-live).
import { useState, type ReactNode } from 'react';

export function LimitStepper({
  labelId,
  defaultValue,
  value,
  onValueChange,
  min = 1,
  max = 10,
  after,
}: {
  labelId: string;
  defaultValue: number;
  /** 주면 부르는 쪽이 값을 쥔다(실제 위저드, ADR-0245) */
  value?: number;
  onValueChange?: (value: number) => void;
  min?: number;
  max?: number;
  after?: ReactNode;
}) {
  const [inner, setInner] = useState(defaultValue);
  const n = value ?? inner;
  const change = (next: number) => {
    setInner(next);
    onValueChange?.(next);
  };
  return (
    <div className="row" style={{ gap: 10 }}>
      <div className="stepper-num max-lg:h-11" role="group" aria-labelledby={labelId}>
        <button type="button" aria-label="1인 한도 1매 줄이기" disabled={n <= min} onClick={() => change(Math.max(min, n - 1))}>
          <i className="ic ic-minus" aria-hidden="true" />
        </button>
        <output aria-live="polite">{n}</output>
        <button type="button" aria-label="1인 한도 1매 늘리기" disabled={n >= max} onClick={() => change(Math.min(max, n + 1))}>
          <i className="ic ic-plus" aria-hidden="true" />
        </button>
      </div>
      <span className="t-sm">매</span>
      {after}
    </div>
  );
}
