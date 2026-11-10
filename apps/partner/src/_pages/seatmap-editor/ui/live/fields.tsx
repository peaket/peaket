'use client';
// 라이브 에디터의 칸 부품: 숫자·글자 칸은 Enter·초점 떠남에서 한 번만 명령을 만든다(치는 글자마다 되돌리기 단계를 만들지 않는다).
import { useEffect, useState } from 'react';

export function NumField({ id, label, value, onCommit, disabled, unit, min, max, error }: { id: string; label: string; value: number | null; onCommit: (v: number) => void; disabled?: boolean; unit?: string; min?: number; max?: number; error?: string }) {
  const [text, setText] = useState(value === null ? '' : String(value));
  useEffect(() => setText(value === null ? '' : String(value)), [value]);
  const commit = () => {
    const v = Number(text.trim());
    if (text.trim() === '' || !Number.isFinite(v)) return setText(value === null ? '' : String(value));
    if (v !== value) onCommit(v);
  };
  return (
    <div className="field" style={{ gap: 4 }}>
      <label className="label" htmlFor={id}>
        {label}
        {unit ? <span className="opt"> ({unit})</span> : null}
      </label>
      <input
        className="input input-sm"
        id={id}
        type="text"
        inputMode="decimal"
        value={text}
        disabled={disabled}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-e` : undefined}
        {...(min !== undefined ? { 'aria-valuemin': min } : {})}
        {...(max !== undefined ? { 'aria-valuemax': max } : {})}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
        }}
      />
      {error ? (
        <span className="error-msg" id={`${id}-e`}>
          <i className="ic ic-alert-circle" aria-hidden="true" />
          {error}
        </span>
      ) : null}
    </div>
  );
}

export function TextField({ id, label, value, onCommit, disabled, maxLength = 30 }: { id: string; label: string; value: string; onCommit: (v: string) => void; disabled?: boolean; maxLength?: number }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const commit = () => {
    if (text !== value) onCommit(text);
  };
  return (
    <div className="field" style={{ gap: 4 }}>
      <label className="label" htmlFor={id}>
        {label}
      </label>
      <input
        className="input input-sm"
        id={id}
        type="text"
        value={text}
        maxLength={maxLength}
        disabled={disabled}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
        }}
      />
    </div>
  );
}

export function Radio<T extends string>({ name, legend, value, options, onChange, disabled }: { name: string; legend: string; value: T; options: readonly { value: T; label: string }[]; onChange: (v: T) => void; disabled?: boolean }) {
  return (
    <fieldset className="col" style={{ gap: 4, border: 0, padding: 0, margin: 0 }}>
      <legend className="label">{legend}</legend>
      <div className="row wrap" style={{ gap: 10 }}>
        {options.map((o) => (
          <label key={o.value} className="check-row t-sm">
            <input type="radio" name={name} value={o.value} checked={value === o.value} disabled={disabled} onChange={() => onChange(o.value)} />
            {o.label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}
