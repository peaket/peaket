'use client';
// 라디오 카드 묶음(키트 .check-row.card · .rd). 고른 카드에 is-selected를 단다.
// 4단계 대기열 정렬 방식은 선착순(FIFO)을 고르면 매크로 취약 경고(POL-004)를, 좌석 배정은 자동 배정을 고르면 extra(선호 기준)를 보인다.
import { useState, type ReactNode } from 'react';

export interface Choice {
  value: string;
  title: string;
  desc: string;
  /** 작은 회색 줄(예: 로비 셔플 켬 · 오픈 직후 묶음 켬) */
  flags?: string;
  /** 고르면 보일 고객 문구 미리보기 */
  preview?: string;
}

export interface ChoiceCardsProps {
  name: string;
  legend: string;
  required?: boolean;
  choices: readonly Choice[];
  defaultValue: string;
  /** 기본값 카드에 '기본', 잠긴 화면에서 지금 값에 '지금 방식' 배지 */
  badgeFor?: { value: string; text: string; tone: 'primary' | 'outline' };
  /** 잠김(온세일 중): 바꿀 수 없음 이유 요소 id */
  lockedBy?: string;
  padding?: string;
  /** 이 값이 골라졌을 때 보일 경고 */
  warnFor?: { value: string; text: string };
  /** 고른 값의 고객 문구 미리보기 배너 */
  previewTitle?: string;
  /** 이 값이 골라졌을 때 카드 묶음 아래에 보일 것 */
  extraFor?: { value: string; node: ReactNode };
  /** 묶음과 미리보기 사이 도움말 */
  hint?: ReactNode;
}

export function ChoiceCards({
  name,
  legend,
  required,
  choices,
  defaultValue,
  badgeFor,
  lockedBy,
  padding = '14px 16px',
  warnFor,
  previewTitle,
  extraFor,
  hint,
}: ChoiceCardsProps) {
  const [value, setValue] = useState(defaultValue);
  const current = choices.find((c) => c.value === value);
  return (
    <>
      <fieldset className="col" style={{ gap: 10 }} disabled={!!lockedBy} aria-describedby={lockedBy}>
        <legend className="label" style={{ marginBottom: 10 }}>
          {legend} {required ? <span className="opt">(필수)</span> : null}
        </legend>
        {choices.map((c) => (
          <label key={c.value} className={c.value === value ? 'check-row card is-selected' : 'check-row card'} style={{ padding }}>
            <input className="rd" type="radio" name={name} value={c.value} checked={c.value === value} onChange={() => setValue(c.value)} />
            <span className="col" style={{ gap: 4 }}>
              {badgeFor?.value === c.value ? (
                <span className="row" style={{ gap: 6 }}>
                  <span className="fw-b">{c.title}</span>
                  <span className={badgeFor.tone === 'primary' ? 'badge badge-primary' : 'badge badge-outline'}>{badgeFor.text}</span>
                </span>
              ) : (
                <span className="fw-b">{c.title}</span>
              )}
              <span className="t-sm muted">{c.desc}</span>
              {c.flags ? <span className="t-xs muted">{c.flags}</span> : null}
            </span>
          </label>
        ))}
        {extraFor && value === extraFor.value ? extraFor.node : null}
      </fieldset>
      {hint}
      {warnFor && value === warnFor.value ? (
        <div className="banner banner-warning" role="status">
          <i className="ic ic-alert" aria-hidden="true" />
          <div className="banner-body">{warnFor.text}</div>
        </div>
      ) : null}
      {previewTitle && current?.preview ? (
        <div className="banner banner-info" aria-live="polite">
          <i className="ic ic-eye" aria-hidden="true" />
          <div className="banner-body">
            <span className="banner-title">{previewTitle}</span>
            {current.preview}
          </div>
        </div>
      ) : null}
    </>
  );
}
