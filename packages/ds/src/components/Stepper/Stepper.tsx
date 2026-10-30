// CMP-013 Stepper. 보드 마크업(키트 12절):
//   <nav class="stepper" aria-label="등록 단계"><span class="step is-done"><span class="step-num"><i class="ic ic-check"></i></span>기본 정보</span>
//   <span class="step-line is-done"></span>…<span class="step is-current" aria-current="step"><span class="step-num">3</span>좌석맵</span>…</nav>
// - current는 0부터 센 지금 단계. 앞 단계는 done(체크), 뒤는 upcoming. 끝난 단계는 화면 낭독기에 '완료'를 덧붙인다.
// - vertical: 세로 배치(키트에 세로 규칙이 없어 선을 인라인 스타일로 세운다).
// 서버 컴포넌트에서도 쓴다.
import { Fragment, type CSSProperties, type ReactNode } from 'react';
import { cx } from '../../lib/cx';
import { Icon } from '../../icons';

export interface StepperProps {
  steps: readonly ReactNode[];
  /** 지금 단계(0부터) */
  current: number;
  /** nav 이름. 기본 '단계' */
  label?: string;
  orientation?: 'horizontal' | 'vertical';
  className?: string;
  style?: CSSProperties;
}

export function Stepper({ steps, current, label = '단계', orientation = 'horizontal', className, style }: StepperProps) {
  const vertical = orientation === 'vertical';
  return (
    <nav
      className={cx('stepper', className)}
      aria-label={label}
      style={vertical ? { flexDirection: 'column', alignItems: 'flex-start', gap: 4, ...style } : style}
    >
      {steps.map((step, i) => {
        const done = i < current;
        const isCurrent = i === current;
        return (
          <Fragment key={i}>
            {i > 0 ? (
              <span
                className={cx('step-line', done || isCurrent ? 'is-done' : undefined)}
                aria-hidden="true"
                style={vertical ? { flex: 'none', width: 2, height: 12, minWidth: 0, marginLeft: 11 } : undefined}
              />
            ) : null}
            <span className={cx('step', done && 'is-done', isCurrent && 'is-current')} aria-current={isCurrent ? 'step' : undefined}>
              <span className="step-num">{done ? <Icon name="check" /> : i + 1}</span>
              {step}
              {done ? <span className="sr-only"> 완료</span> : null}
            </span>
          </Fragment>
        );
      })}
    </nav>
  );
}
