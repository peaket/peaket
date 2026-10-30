// 입력 칸 묶음: 라벨·힌트·오류(캔버스 키트 11절 .field·.label·.hint·.error-msg, d2 §3.1). 서버 컴포넌트에서도 쓴다.
// - id는 필수다. 라벨 for, 힌트(<id>-hint)·오류(<id>-error) 글의 id, 오류 요약(FormErrorSummary)의 링크가 모두 이 id를 쓴다.
// - 필수·선택은 글자로 적는다: optional → '(선택)', requiredMark → '(필수)'(색·별표만으로 알리지 않는다).
// - 직접 만든 입력에는 fieldControlProps()로 id·aria 속성을 받는다.
import type { CSSProperties, ReactNode } from 'react';
import { fieldIds, joinIds } from '../../lib/aria';
import { cx } from '../../lib/cx';
import { Icon } from '../../icons';

export interface FieldBaseProps {
  /** 입력 요소의 id. 필수 */
  id: string;
  label: ReactNode;
  /** 늘 보이는 도움말(placeholder 대신) */
  hint?: ReactNode;
  /** 오류 글. 있으면 aria-invalid가 붙는다. 형식: [무엇이 문제인가] + [어떻게 고치는가](d2 §4) */
  error?: ReactNode;
  /** 라벨 뒤 '(선택)' */
  optional?: boolean;
  /** 라벨 뒤 '(필수)' */
  requiredMark?: boolean;
  /** 라벨을 화면에서만 숨긴다(낭독기는 읽는다) */
  hideLabel?: boolean;
}

export interface FieldProps extends FieldBaseProps {
  /** 라벨 줄 오른쪽(글자 수 등) */
  labelAside?: ReactNode;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}

export interface FieldControlAria {
  id: string;
  'aria-describedby'?: string;
  'aria-invalid'?: true;
}

/** 입력 요소에 붙일 id·aria 속성 */
export function fieldControlProps({
  id,
  hint,
  error,
  describedBy,
}: Pick<FieldBaseProps, 'id' | 'hint' | 'error'> & { describedBy?: string }): FieldControlAria {
  const ids = fieldIds(id);
  return {
    id,
    'aria-describedby': joinIds(hint ? ids.hint : undefined, error ? ids.error : undefined, describedBy),
    'aria-invalid': error ? true : undefined,
  };
}

/** 라벨 글자 + (선택)/(필수) */
export function FieldLabelText({ label, optional, requiredMark }: Pick<FieldBaseProps, 'label' | 'optional' | 'requiredMark'>) {
  return (
    <>
      {label}
      {requiredMark ? (
        <>
          {' '}
          <span className="opt">(필수)</span>
        </>
      ) : optional ? (
        <>
          {' '}
          <span className="opt">(선택)</span>
        </>
      ) : null}
    </>
  );
}

/** 오류 글(.error-msg + 경고 아이콘) */
export function FieldError({ id, style, children }: { id?: string; style?: CSSProperties; children: ReactNode }) {
  return (
    <span className="error-msg" id={id} style={style}>
      <Icon name="alert-circle" />
      {children}
    </span>
  );
}

export function Field({
  id,
  label,
  hint,
  error,
  optional,
  requiredMark,
  hideLabel,
  labelAside,
  className,
  style,
  children,
}: FieldProps) {
  const ids = fieldIds(id);
  const labelEl = (
    <label className={cx('label', hideLabel && !labelAside && 'sr-only')} htmlFor={id} id={ids.label}>
      <FieldLabelText label={label} optional={optional} requiredMark={requiredMark} />
    </label>
  );
  return (
    <div className={cx('field', className)} style={style}>
      {labelAside ? (
        <div className={cx('row between', hideLabel && 'sr-only')} style={{ gap: 8 }}>
          {labelEl}
          {labelAside}
        </div>
      ) : (
        labelEl
      )}
      {children}
      {hint ? (
        <span className="hint" id={ids.hint}>
          {hint}
        </span>
      ) : null}
      {error ? <FieldError id={ids.error}>{error}</FieldError> : null}
    </div>
  );
}
