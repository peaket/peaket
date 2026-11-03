'use client';
// CMP-012 FormErrorSummary. 보드 마크업:
//   <div class="error-summary" role="alert" aria-labelledby><strong class="row tx-danger" id style="gap:6px">
//   <i class="ic ic-alert-circle ic-16"></i>2개 항목을 확인해 주세요</strong><a href="#칸id">오류 글</a>…</div>
// - 항목을 누르면 그 칸으로 초점을 옮긴다(앵커 이동 + focus). focusFirst면 처음 그릴 때 첫 오류 칸으로 초점을 옮긴다(제출 실패 직후).
// - 칸 id는 Field·TextField 등에 준 id와 같다.
import { useEffect, useId, type MouseEvent, type ReactNode } from 'react';
import { focusElementOrFirstFocusable } from '../../lib/aria';
import { cx } from '../../lib/cx';
import { Icon } from '../../icons';

export interface FormErrorItem {
  /** 오류 칸의 id */
  fieldId: string;
  message: ReactNode;
}

export interface FormErrorSummaryProps {
  errors: readonly FormErrorItem[];
  /** 제목. 기본 'N개 항목을 확인해 주세요' */
  title?: ReactNode;
  /** 처음 그릴 때 첫 오류 칸으로 초점을 옮긴다 */
  focusFirst?: boolean;
  className?: string;
}

export function FormErrorSummary({ errors, title, focusFirst = false, className }: FormErrorSummaryProps) {
  const titleId = `${useId()}-title`;
  const firstId = errors[0]?.fieldId;

  useEffect(() => {
    if (focusFirst && firstId) focusElementOrFirstFocusable(document.getElementById(firstId));
  }, [focusFirst, firstId]);

  if (errors.length === 0) return null;

  const onItemClick = (event: MouseEvent<HTMLAnchorElement>, fieldId: string) => {
    const el = document.getElementById(fieldId);
    if (el && focusElementOrFirstFocusable(el)) event.preventDefault();
  };

  return (
    <div className={cx('error-summary', className)} role="alert" aria-labelledby={titleId}>
      <strong className="row tx-danger" id={titleId} style={{ gap: 6 }}>
        <Icon name="alert-circle" size={16} />
        {title ?? `${errors.length}개 항목을 확인해 주세요`}
      </strong>
      {errors.map((e) => (
        <a key={e.fieldId} href={`#${e.fieldId}`} onClick={(ev) => onItemClick(ev, e.fieldId)}>
          {e.message}
        </a>
      ))}
    </div>
  );
}
