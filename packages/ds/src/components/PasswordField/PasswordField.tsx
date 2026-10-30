'use client';
// CMP-006 PasswordField. 보드 마크업: .input-group 안에 비밀번호 칸과 '비밀번호 보기' 아이콘 버튼(icon-btn-sm, aria-pressed, aria-controls).
// - kind: current(로그인, autocomplete="current-password") · new(초대 수락·바꾸기, autocomplete="new-password")
// - 붙여넣기와 비밀번호 관리자 자동 입력을 막지 않는다. 보기 버튼은 누른 뒤에도 이름이 그대로이고 aria-pressed로 상태를 알린다.
import { forwardRef, useState, type InputHTMLAttributes } from 'react';
import { cx } from '../../lib/cx';
import { Field, fieldControlProps, type FieldBaseProps } from '../Field/Field';
import { IconButton } from '../IconButton/IconButton';

export interface PasswordFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size' | 'id' | 'type'>, FieldBaseProps {
  kind?: 'current' | 'new';
  size?: 'md' | 'sm';
  /** 처음부터 글자를 보일지 */
  defaultVisible?: boolean;
  /** 보기 버튼 이름. 기본 '비밀번호 보기' */
  toggleLabel?: string;
  showFocus?: boolean;
  fieldClassName?: string;
}

export const PasswordField = forwardRef<HTMLInputElement, PasswordFieldProps>(function PasswordField(
  {
    id,
    label,
    hint,
    error,
    optional,
    requiredMark,
    hideLabel,
    kind = 'current',
    size = 'md',
    defaultVisible = false,
    toggleLabel = '비밀번호 보기',
    showFocus = false,
    fieldClassName,
    className,
    disabled,
    autoComplete,
    'aria-describedby': describedBy,
    ...rest
  },
  ref,
) {
  const [visible, setVisible] = useState(defaultVisible);
  const aria = fieldControlProps({ id, hint, error, describedBy });
  return (
    <Field
      id={id}
      label={label}
      hint={hint}
      error={error}
      optional={optional}
      requiredMark={requiredMark}
      hideLabel={hideLabel}
      className={fieldClassName}
    >
      <div
        className={cx(
          'input-group',
          size === 'sm' && 'input-group-sm',
          error ? 'is-error' : undefined,
          showFocus && 'is-focus',
          disabled && 'is-disabled',
          className,
        )}
      >
        <input
          ref={ref}
          type={visible ? 'text' : 'password'}
          autoComplete={autoComplete ?? (kind === 'new' ? 'new-password' : 'current-password')}
          disabled={disabled}
          {...aria}
          {...rest}
        />
        <IconButton
          size="sm"
          label={toggleLabel}
          icon="eye"
          pressedIcon="eye-off"
          pressed={visible}
          aria-controls={id}
          disabled={disabled}
          onClick={() => setVisible((v) => !v)}
        />
      </div>
    </Field>
  );
});
