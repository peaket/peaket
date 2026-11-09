// 실제 위저드의 칸 부품과 오류 표시(CMP-012, 보드 SCR-021의 .error-msg·.error-summary).
import type { HTMLAttributes, ReactNode } from 'react';
import type { FieldError, WizardDraft } from '../../model/form';

export interface StepProps {
  draft: WizardDraft;
  /** 값을 바꾸고, 그 칸의 오류를 지운다 */
  update: (patch: Partial<WizardDraft>, field: string) => void;
  errorOf: (field: string) => string | undefined;
}

const FIELD_IDS: Record<string, string> = {
  title: 'w-title',
  place: 'w-venue',
  artists: 'w-artist',
  genre: 'w-genre',
  ageRating: 'w-age',
  runningMinutes: 'w-run',
  producer: 'w-prod',
  aliases: 'w-alias',
  notice: 'w-notice',
  rounds: 'r-add',
  queueOrder: 'n-ord',
  perPersonLimit: 'n-limit-l',
};

/** 오류 칸의 요소 id. 칸을 짚을 수 없으면 undefined */
export function fieldId(field: string): string | undefined {
  const round = /^rounds\.(\d+)\.(\w+)$/.exec(field);
  return round ? `r-${round[1]}-${round[2]}` : FIELD_IDS[field];
}

export const roundFieldId = (i: number, name: string) => `r-${i}-${name}`;

const errorIdOf = (id: string) => `${id}-e`;

/** 입력 요소에 줄 접근성 속성 */
export function errorAttrs(id: string, error: string | undefined, hintId?: string) {
  const describedBy = [hintId, error ? errorIdOf(id) : undefined].filter(Boolean).join(' ');
  return { 'aria-invalid': error ? true : undefined, 'aria-describedby': describedBy || undefined } as const;
}

export function FieldMessage({ id, error }: { id: string; error: string | undefined }) {
  if (!error) return null;
  return (
    <span className="error-msg" id={errorIdOf(id)}>
      <i className="ic ic-alert-circle" aria-hidden="true" />
      {error}
    </span>
  );
}

export function FieldLabel({ htmlFor, required, children }: { htmlFor: string; required?: boolean; children: ReactNode }) {
  return (
    <label className="label" htmlFor={htmlFor}>
      {children} <span className="opt">{required ? '(필수)' : '(선택)'}</span>
    </label>
  );
}

export function TextField({
  id,
  label,
  required,
  value,
  error,
  hint,
  placeholder,
  inputMode,
  onChange,
  className = 'field',
}: {
  id: string;
  label: string;
  required?: boolean;
  value: string;
  error: string | undefined;
  hint?: string;
  placeholder?: string;
  inputMode?: HTMLAttributes<HTMLInputElement>['inputMode'];
  onChange: (value: string) => void;
  className?: string;
}) {
  const hintId = hint ? `${id}-h` : undefined;
  return (
    <div className={className}>
      <FieldLabel htmlFor={id} required={required}>
        {label}
      </FieldLabel>
      <input className={error ? 'input is-error' : 'input'} id={id} type="text" inputMode={inputMode} placeholder={placeholder} value={value} onChange={(e) => onChange(e.target.value)} {...errorAttrs(id, error, hintId)} />
      {hint ? (
        <span className="hint" id={hintId}>
          {hint}
        </span>
      ) : null}
      <FieldMessage id={id} error={error} />
    </div>
  );
}

function errorText(e: FieldError): string {
  const round = /^rounds\.(\d+)\./.exec(e.field);
  return round ? `${Number(round[1]) + 1}회차: ${e.message}` : e.message;
}

/** 오류 요약(CMP-012). 칸을 짚을 수 있으면 그 칸으로 가는 링크를 단다 */
export function ErrorSummary({ errors, refCallback }: { errors: readonly FieldError[]; refCallback: (el: HTMLDivElement | null) => void }) {
  if (errors.length === 0) return null;
  const onlyForm = errors.every((e) => e.field === 'form');
  return (
    <div className="error-summary" role="alert" aria-labelledby="l-err-t" tabIndex={-1} ref={refCallback}>
      <strong className="row" id="l-err-t" style={{ gap: 6 }}>
        <i className="ic ic-alert-circle tx-danger" aria-hidden="true" />
        {onlyForm ? '공연 등록을 마치지 못했습니다' : `${errors.length}건을 고쳐야 넘어갈 수 있습니다`}
      </strong>
      {errors.map((e) => {
        const id = fieldId(e.field);
        return id ? (
          <a key={e.field} href={`#${id}`}>
            {errorText(e)}
          </a>
        ) : (
          <span key={e.field}>{errorText(e)}</span>
        );
      })}
    </div>
  );
}
