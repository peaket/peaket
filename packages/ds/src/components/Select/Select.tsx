// CMP-010 Select. 보드 마크업: .input-group 안에 <select>와 ▾ 아이콘(ic-chevron-down). 서버 컴포넌트에서도 쓴다.
// 네이티브 select라 키보드·낭독기 동작은 브라우저 것을 그대로 쓴다.
import { forwardRef, type ReactNode, type SelectHTMLAttributes } from 'react';
import { cx } from '../../lib/cx';
import { Icon } from '../../icons';
import { Field, fieldControlProps, type FieldBaseProps } from '../Field/Field';

export interface SelectOption {
  value: string;
  label: ReactNode;
  disabled?: boolean;
}

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'size' | 'id'>, FieldBaseProps {
  options?: readonly SelectOption[];
  /** 고르기 전 안내(값 '' 선택지, 고를 수 없음) */
  placeholder?: string;
  size?: 'md' | 'sm';
  showFocus?: boolean;
  fieldClassName?: string;
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  {
    id,
    label,
    hint,
    error,
    optional,
    requiredMark,
    hideLabel,
    options,
    placeholder,
    size = 'md',
    showFocus = false,
    fieldClassName,
    className,
    disabled,
    children,
    'aria-describedby': describedBy,
    ...rest
  },
  ref,
) {
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
        <select ref={ref} disabled={disabled} {...aria} {...rest}>
          {placeholder !== undefined ? (
            <option value="" disabled>
              {placeholder}
            </option>
          ) : null}
          {options?.map((o) => (
            <option key={o.value} value={o.value} disabled={o.disabled}>
              {o.label}
            </option>
          ))}
          {children}
        </select>
        <Icon name="chevron-down" />
      </div>
    </Field>
  );
});
