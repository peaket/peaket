// CMP-008 PhoneField. 휴대폰 번호(숫자만) 칸: type="tel"·inputmode="tel"·autocomplete="tel"(d2 CMP-008).
// 모양은 TextField(.input)와 같다. 서버 컴포넌트에서도 쓴다.
import { forwardRef } from 'react';
import { TextField, type TextFieldProps } from '../TextField/TextField';

export type PhoneFieldProps = Omit<TextFieldProps, 'type' | 'inputMode'>;

export const PhoneField = forwardRef<HTMLInputElement, PhoneFieldProps>(function PhoneField(
  { autoComplete = 'tel', placeholder = '010-0000-0000', ...rest },
  ref,
) {
  return <TextField ref={ref} type="tel" inputMode="tel" autoComplete={autoComplete} placeholder={placeholder} {...rest} />;
});
