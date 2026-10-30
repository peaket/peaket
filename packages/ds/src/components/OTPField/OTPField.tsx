'use client';
// CMP-007 OTPField. 인증 앱 코드 6자리. 입력 칸 하나(.otp-input, maxlength 6)를 키트가 여섯 칸 모양으로 그린다(d2 CMP-007, 칸을 나누지 않는다).
// 보드 마크업: <input class="otp-input" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]*">
// - 여섯 자리를 한 번에 붙여넣거나 자동으로 채울 수 있다(WCAG 3.3.8). 숫자 아닌 글자는 넣는 즉시 뺀다.
// - 라벨 기본은 '인증 앱 코드 6자리'. 오류면 aria-invalid와 오류 칸 무늬(.is-error).
import { forwardRef, type ChangeEvent, type InputHTMLAttributes, type ReactNode } from 'react';
import { cx } from '../../lib/cx';
import { Field, fieldControlProps, type FieldBaseProps } from '../Field/Field';

export interface OTPFieldProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size' | 'id' | 'type' | 'maxLength'>,
    Omit<FieldBaseProps, 'label'> {
  label?: ReactNode;
  showFocus?: boolean;
  fieldClassName?: string;
}

export const OTPField = forwardRef<HTMLInputElement, OTPFieldProps>(function OTPField(
  {
    id,
    label = '인증 앱 코드 6자리',
    hint,
    error,
    optional,
    requiredMark,
    hideLabel,
    showFocus = false,
    fieldClassName,
    className,
    onChange,
    'aria-describedby': describedBy,
    ...rest
  },
  ref,
) {
  const aria = fieldControlProps({ id, hint, error, describedBy });
  const handleChange = (event: ChangeEvent<HTMLInputElement>) => {
    const digits = event.target.value.replace(/\D/g, '').slice(0, 6);
    if (digits !== event.target.value) event.target.value = digits;
    onChange?.(event);
  };
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
      <input
        ref={ref}
        className={cx('otp-input', showFocus && 'is-focus', className)}
        type="text"
        inputMode="numeric"
        autoComplete="one-time-code"
        maxLength={6}
        pattern="[0-9]*"
        onChange={handleChange}
        {...aria}
        {...rest}
      />
    </Field>
  );
});
