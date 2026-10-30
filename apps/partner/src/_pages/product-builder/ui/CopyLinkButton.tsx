'use client';
// 휴대폰 범위 밖 안내 카드의 [ 링크 복사 ](d5 §3.9). 본문 글이 shared BigScreenNotice와 다른 카드(보드 SCR-023-m 배송·반품 처리)에서 쓴다.
import { useState } from 'react';

export function CopyLinkButton({ label }: { label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <>
      <button
        className="btn btn-outline btn-sm"
        type="button"
        aria-label={label}
        onClick={() => void navigator.clipboard?.writeText(window.location.href).then(() => setCopied(true))}
      >
        <i className={copied ? 'ic ic-check' : 'ic ic-copy'} aria-hidden="true" />
        {copied ? '복사했습니다' : '링크 복사'}
      </button>
      <span className="sr-only" role="status">
        {copied ? '링크를 복사했습니다' : ''}
      </span>
    </>
  );
}
