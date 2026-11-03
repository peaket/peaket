'use client';
// 수량 고르기(키트 .stepper-num). ds에 부품이 없어 보드 마크업대로 짰다(ds README '부품' 절 끝).
// - 묶음은 role="group", 가운데 숫자는 role="spinbutton"(↑↓·Home·End), 줄이기·늘리기 버튼은 끝에 닿으면 disabled.
// - 이름은 labelledBy(보이는 라벨 id) 또는 label(낭독 이름) 가운데 하나로 준다. 한도 안내 글은 describedBy로 잇는다.
import type { KeyboardEvent } from 'react';
import { cx } from '@/shared/lib/cx';

export interface QuantityStepperProps {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max: number;
  labelledBy?: string;
  label?: string;
  describedBy?: string;
  /** 상한에서 늘리기를 누르려 할 때(↑ 키 포함) */
  onLimit?: () => void;
}

export function QuantityStepper({ value, onChange, min = 1, max, labelledBy, label, describedBy, onLimit }: QuantityStepperProps) {
  const set = (next: number) => {
    if (next > max) {
      onLimit?.();
      return;
    }
    onChange(Math.max(min, Math.min(max, next)));
  };
  const onKeyDown = (e: KeyboardEvent<HTMLSpanElement>) => {
    const map: Record<string, number> = { ArrowUp: value + 1, ArrowRight: value + 1, ArrowDown: value - 1, ArrowLeft: value - 1, Home: min, End: max };
    const next = map[e.key];
    if (next === undefined) return;
    e.preventDefault();
    set(next);
  };
  const atMin = value <= min;
  const atMax = value >= max;
  return (
    <div className="stepper-num" role="group" aria-labelledby={labelledBy} aria-label={labelledBy ? undefined : label} style={{ alignSelf: 'flex-start' }}>
      <button type="button" aria-label="수량 줄이기" disabled={atMin} onClick={() => set(value - 1)}>
        <i className={cx('ic ic-minus', atMin && 'tx-disabled')} aria-hidden="true" />
      </button>
      <span
        role="spinbutton"
        tabIndex={0}
        aria-labelledby={labelledBy}
        aria-label={labelledBy ? undefined : label}
        aria-valuenow={value}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-describedby={describedBy}
        onKeyDown={onKeyDown}
      >
        {value}
      </span>
      <button type="button" aria-label="수량 늘리기" disabled={atMax} onClick={() => set(value + 1)}>
        <i className={cx('ic ic-plus', atMax && 'tx-disabled')} aria-hidden="true" />
      </button>
    </div>
  );
}
