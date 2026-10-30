'use client';
// CMP-009 ConsentCheckbox. 약관·개인정보 동의 체크박스. 필수·선택을 라벨 끝 글자 '(필수)'·'(선택)'(.muted)로 분명히 적는다(보드 SCR-005).
// - requirement: required · optional · checklist(관제·운영의 확인 항목: 글자를 붙이지 않는다)
// - 약관 내용 '보기 ›' 링크는 detailHref(+detailLabel: 링크 이름 "이용약관 보기")로 오른쪽 끝에 둔다.
// - 선택 항목을 필수처럼 헷갈리게 만들지 않는다(다크 패턴 금지).
import { forwardRef, type ReactNode } from 'react';
import { Checkbox, type CheckboxProps } from '../Checkbox/Checkbox';

export interface ConsentCheckboxProps extends Omit<CheckboxProps, 'aside'> {
  requirement?: 'required' | 'optional' | 'checklist';
  /** 내용 보기 링크 주소 */
  detailHref?: string;
  /** 보기 링크의 이름(aria-label). 기본 '<라벨> 보기' */
  detailLabel?: string;
  /** 보기 링크 대신 둘 것(대화상자 여는 버튼 등) */
  detail?: ReactNode;
}

export const ConsentCheckbox = forwardRef<HTMLInputElement, ConsentCheckboxProps>(function ConsentCheckbox(
  { requirement = 'required', label, detailHref, detailLabel, detail, ...rest },
  ref,
) {
  const suffix = requirement === 'required' ? '(필수)' : requirement === 'optional' ? '(선택)' : null;
  const aside =
    detail ??
    (detailHref ? (
      <a
        className="link-more"
        href={detailHref}
        aria-label={detailLabel ?? (typeof label === 'string' ? `${label} 보기` : undefined)}
      >
        보기
        <i className="ic ic-chevron-right" aria-hidden="true" />
      </a>
    ) : undefined);
  return (
    <Checkbox
      ref={ref}
      label={
        <>
          {label}
          {suffix ? (
            <>
              {' '}
              <span className="muted">{suffix}</span>
            </>
          ) : null}
        </>
      }
      aside={aside}
      {...rest}
    />
  );
});
