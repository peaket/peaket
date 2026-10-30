'use client';
// 비밀번호 칸과 보기 토글(키트 .input-group + .icon-btn-sm). 붙여넣기와 비밀번호 관리자는 막지 않는다(d5 §6.1).
import { useState } from 'react';

export interface PasswordInputProps {
  id: string;
  autoComplete: 'current-password' | 'new-password';
  /** 보기 토글 이름(예: '비밀번호 보기', '지금 비밀번호 보기') */
  toggleLabel: string;
  defaultValue?: string;
  describedBy?: string;
  invalid?: boolean;
  autoFocus?: boolean;
}

export function PasswordInput({ id, autoComplete, toggleLabel, defaultValue, describedBy, invalid, autoFocus }: PasswordInputProps) {
  const [show, setShow] = useState(false);
  return (
    <div className={invalid ? 'input-group is-error' : 'input-group'}>
      <input
        id={id}
        type={show ? 'text' : 'password'}
        autoComplete={autoComplete}
        defaultValue={defaultValue}
        aria-invalid={invalid ? 'true' : undefined}
        aria-describedby={describedBy}
        autoFocus={autoFocus}
      />
      <button
        className="icon-btn icon-btn-sm"
        type="button"
        aria-label={toggleLabel}
        aria-pressed={show}
        aria-controls={id}
        onClick={() => setShow((v) => !v)}
      >
        <i className={show ? 'ic ic-eye-off' : 'ic ic-eye'} aria-hidden="true" />
      </button>
    </div>
  );
}
