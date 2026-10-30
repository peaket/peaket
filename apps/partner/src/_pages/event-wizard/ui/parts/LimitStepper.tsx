'use client';
// 1인 한도 [− n +](키트 .stepper-num). 값은 output으로 알린다(aria-live).
import { useState, type ReactNode } from 'react';

export function LimitStepper({ labelId, defaultValue, min = 1, max = 10, after }: { labelId: string; defaultValue: number; min?: number; max?: number; after?: ReactNode }) {
  const [n, setN] = useState(defaultValue);
  return (
    <div className="row" style={{ gap: 10 }}>
      <div className="stepper-num max-lg:h-11" role="group" aria-labelledby={labelId}>
        <button type="button" aria-label="1인 한도 1매 줄이기" disabled={n <= min} onClick={() => setN((v) => Math.max(min, v - 1))}>
          <i className="ic ic-minus" aria-hidden="true" />
        </button>
        <output aria-live="polite">{n}</output>
        <button type="button" aria-label="1인 한도 1매 늘리기" disabled={n >= max} onClick={() => setN((v) => Math.min(max, v + 1))}>
          <i className="ic ic-plus" aria-hidden="true" />
        </button>
      </div>
      <span className="t-sm">매</span>
      {after}
    </div>
  );
}
