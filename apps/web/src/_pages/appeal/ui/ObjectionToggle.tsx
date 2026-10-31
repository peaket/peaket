'use client';
// SCR-042 '조치 결과 · 부정 예매'의 [[ 이의 내기 ]]: 누르면 같은 소명 입력 칸 ②를 다시 연다(d5 §5.24, 추천 적용 2026-10-31, ADR-0173).
// 이의 창(objectionDueAt) 안의 제출은 이의로 접수된다(openapi FraudAppealView). 퍼블리싱이라 서버로 보내지 않는다.
// 열면 입력 칸으로 초점을 옮긴다. 입력은 화면 메모리에만 둔다(asvs 14.3.3).
import { useEffect, useState } from 'react';
import { AppealForm } from '@peaket/ds/AppealForm';

export function ObjectionToggle({
  idPrefix,
  title,
  deadlineText,
  hint,
  maxLength,
}: {
  idPrefix: string;
  title: string;
  /** 이의 기한 글 '11/22(일) 18:00' */
  deadlineText: string;
  hint: string;
  maxLength: number;
}) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (open) document.getElementById(`${idPrefix}-text`)?.focus();
  }, [open, idPrefix]);
  if (!open) {
    return (
      <button className="btn btn-primary btn-lg btn-block" type="button" aria-expanded={false} aria-controls={`${idPrefix}-wrap`} onClick={() => setOpen(true)}>
        이의 내기
      </button>
    );
  }
  return (
    <div id={`${idPrefix}-wrap`}>
      <AppealForm
        idPrefix={idPrefix}
        variant="fraud"
        caseCard={false}
        title={title}
        deadlineText={deadlineText}
        scheduleText=""
        formLabel="이의 작성"
        hint={hint}
        maxLength={maxLength}
      />
    </div>
  );
}
