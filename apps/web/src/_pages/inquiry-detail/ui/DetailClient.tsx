'use client';
// 문의 상세의 클라이언트 조각: 접수 직후 토스트, 추가 문의 입력.
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { TextArea } from '@peaket/ds/TextArea';
import { useToast } from '@/shared/ui/toast';

/** 접수 직후 상세 위 토스트(d5 §5.30 '접수 완료', role="status"는 토스트 자리가 맡는다) */
export function SubmittedToast({ no }: { no: string }) {
  const toast = useToast();
  const shown = useRef(false);
  useEffect(() => {
    if (shown.current) return;
    shown.current = true;
    toast(`문의를 접수했습니다. 접수 번호 ${no}`);
  }, [toast, no]);
  return null;
}

/**
 * 추가 문의(10~2,000자 [가정]). 퍼블리싱에서는 보내지 않고 화면에서 검사만 한다.
 * 짧을 때 오류 글은 문의하기와 같은 문구, 보낸 뒤 토스트 글은 추천안(d5에 없음).
 */
export function FollowUpForm({ id }: { id: string }) {
  const toast = useToast();
  const [text, setText] = useState('');
  const [error, setError] = useState<string | undefined>();
  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (Array.from(text.trim()).length < 10) {
      setError('내용을 10자 이상 써 주세요');
      document.getElementById(id)?.focus();
      return;
    }
    setError(undefined);
    setText('');
    toast('추가 문의를 보냈습니다');
  };
  return (
    <form className="col" style={{ gap: 12 }} noValidate onSubmit={onSubmit} aria-label="추가 문의">
      <TextArea
        id={id}
        label="추가로 문의할 내용"
        requiredMark
        hint="10~2,000자"
        maxLength={2000}
        value={text}
        onChange={(e) => setText(e.target.value)}
        error={error}
      />
      <div className="col gap-3 md:flex-row md:flex-wrap md:items-center md:justify-between lg:flex-nowrap lg:gap-4">
        <button className="btn btn-outline btn-lg btn-block md:order-2 md:w-auto" type="submit">
          추가 문의 보내기
        </button>
        <p className="t-xs muted md:order-1 md:grow">답변을 받은 뒤 14일 동안 추가 문의가 없으면 문의가 닫힙니다.</p>
      </div>
    </form>
  );
}
