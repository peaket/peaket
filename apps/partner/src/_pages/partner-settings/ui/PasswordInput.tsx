'use client';
// 비밀번호 칸과 보기 토글(보드 .input-group + .icon-btn-sm ic-eye). 붙여넣기와 비밀번호 관리자를 막지 않는다.
import { useState } from 'react';

export interface PasswordInputProps {
  id: string;
  autoComplete: 'current-password' | 'new-password';
  describedBy?: string;
  invalid?: boolean;
  /** 대화상자가 열릴 때 처음 초점(focus-trap의 data-autofocus) */
  autoFocusInDialog?: boolean;
}

export function PasswordInput({ id, autoComplete, describedBy, invalid, autoFocusInDialog }: PasswordInputProps) {
  const [show, setShow] = useState(false);
  return (
    <div className={invalid ? 'input-group is-error' : 'input-group'}>
      <input
        id={id}
        type={show ? 'text' : 'password'}
        autoComplete={autoComplete}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        data-autofocus={autoFocusInDialog ? '' : undefined}
      />
      <button
        className="icon-btn icon-btn-sm"
        type="button"
        aria-label="비밀번호 보기"
        aria-pressed={show}
        aria-controls={id}
        onClick={() => setShow((v) => !v)}
      >
        <i className={show ? 'ic ic-eye-off' : 'ic ic-eye'} aria-hidden="true" />
      </button>
    </div>
  );
}
