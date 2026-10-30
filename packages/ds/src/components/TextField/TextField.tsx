// CMP-004 TextField. 캔버스 키트 11절 .input(칸 하나) 또는 .input-group(앞 아이콘·뒤 버튼이 있는 칸)을 Field 안에 낸다.
// 서버 컴포넌트에서도 쓴다(입력 처리 함수는 부르는 쪽 클라이언트 부품이 넘긴다).
// - type·inputMode·autoComplete는 칸 뜻에 맞게 준다(d2 CMP-004). 검색창은 SearchField, 휴대폰 번호는 PhoneField.
// - showFocus: 보드의 '포커스' 상태를 그대로 그릴 때(.is-focus). 실제 초점 표시는 키트의 :focus-visible이 한다.
import { forwardRef, type InputHTMLAttributes, type ReactNode } from 'react';
import { cx } from '../../lib/cx';
import { Icon, type IconName } from '../../icons';
import { Field, fieldControlProps, type FieldBaseProps } from '../Field/Field';

export interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size' | 'id'>, FieldBaseProps {
  /** md 48 · sm 40 */
  size?: 'md' | 'sm';
  /** 칸 앞 아이콘(.input-group) */
  icon?: IconName;
  /** 칸 뒤(지우기 버튼·단위 글 등, .input-group) */
  trailing?: ReactNode;
  showFocus?: boolean;
  /** 라벨 줄 오른쪽 */
  labelAside?: ReactNode;
  /** 바깥 .field의 클래스 */
  fieldClassName?: string;
}

export const TextField = forwardRef<HTMLInputElement, TextFieldProps>(function TextField(
  {
    id,
    label,
    hint,
    error,
    optional,
    requiredMark,
    hideLabel,
    labelAside,
    size = 'md',
    icon,
    trailing,
    showFocus = false,
    fieldClassName,
    className,
    disabled,
    type = 'text',
    'aria-describedby': describedBy,
    ...rest
  },
  ref,
) {
  const aria = fieldControlProps({ id, hint, error, describedBy });
  const grouped = Boolean(icon || trailing);
  const input = (
    <input
      ref={ref}
      type={type}
      disabled={disabled}
      className={grouped ? undefined : cx('input', size === 'sm' && 'input-sm', error ? 'is-error' : undefined, showFocus && 'is-focus', className)}
      {...aria}
      {...rest}
    />
  );
  return (
    <Field
      id={id}
      label={label}
      hint={hint}
      error={error}
      optional={optional}
      requiredMark={requiredMark}
      hideLabel={hideLabel}
      labelAside={labelAside}
      className={fieldClassName}
    >
      {grouped ? (
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
          {icon ? <Icon name={icon} /> : null}
          {input}
          {trailing}
        </div>
      ) : (
        input
      )}
    </Field>
  );
});
