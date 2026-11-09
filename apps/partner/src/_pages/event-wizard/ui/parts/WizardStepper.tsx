// 위저드 단계 표시(CMP-013 Stepper, 키트 .stepper). 데스크톱 lg는 단계 이름을 모두 보이고, 태블릿은 지금 단계 이름만 보인다(나머지는 sr-only, 보드 SCR-021-t). 휴대폰은 읽기 전용 요약이라 숨긴다.
import { WIZARD_STEPS } from '../../model/fixtures';
import type { WizardStep, WizardView } from '../../model/view';

export function WizardStepper({ view }: { view: Pick<WizardView, 'body' | 'context'> }) {
  const isEdit = view.body.kind !== 'step';
  const current: WizardStep = view.body.kind === 'step' ? view.body.step : view.body.kind === 'e4' ? 4 : 2;
  // 고치는 화면은 다른 단계가 모두 입력 완료다(보드 e4·e2). 반려된 5단계도 앞 단계는 완료다
  const allDone = isEdit;
  return (
    <div className="card max-md:hidden" style={{ padding: '14px 20px' }}>
      <div className="row" style={{ gap: 16 }}>
        <nav className="stepper grow" aria-label={isEdit || view.context === 'event' ? '등록 정보 단계' : '등록 단계'}>
          {WIZARD_STEPS.map((name, i) => {
            const n = (i + 1) as WizardStep;
            const done = n !== current && (allDone || n < current);
            const isCurrent = n === current;
            const lineDone = allDone || n < current;
            return (
              <span key={name} className="contents">
                <span className={isCurrent ? 'step is-current' : done ? 'step is-done' : 'step'} aria-current={isCurrent ? 'step' : undefined}>
                  <span className="step-num">{done ? <i className="ic ic-check" aria-hidden="true" /> : n}</span>
                  {done ? <span className="sr-only">완료: </span> : null}
                  <span className={isCurrent ? undefined : 'max-lg:sr-only'}>{name}</span>
                </span>
                {i < WIZARD_STEPS.length - 1 ? <span className={lineDone ? 'step-line is-done' : 'step-line'} aria-hidden="true" /> : null}
              </span>
            );
          })}
        </nav>
        <span className="t-sm muted num nowrap">{current} / 5단계</span>
      </div>
    </div>
  );
}
