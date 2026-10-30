'use client';
// 규칙 JSON 대화상자의 [ 복사 ](d5 §6.7, 읽기 전용 JSON을 그대로 복사한다).
import { useState } from 'react';

export function CopyTextButton({ text, className, label = '복사' }: { text: string; className: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <>
      <button className={className} type="button" onClick={() => void navigator.clipboard?.writeText(text).then(() => setCopied(true))}>
        <i className={copied ? 'ic ic-check' : 'ic ic-copy'} aria-hidden="true" />
        {copied ? '복사했습니다' : label}
      </button>
      <span className="sr-only" role="status">
        {copied ? 'JSON을 복사했습니다' : ''}
      </span>
    </>
  );
}
