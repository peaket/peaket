'use client';
// 새 서명 비밀의 [ 비밀 복사 ](발급·재발급 직후 한 번만 보이는 값, d5 §6.8·ADR-0053).
import { useState } from 'react';

export function CopySecretButton({ secret }: { secret: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <>
      <button
        className="btn btn-primary"
        type="button"
        style={{ height: 'auto' }}
        onClick={() => void navigator.clipboard?.writeText(secret).then(() => setCopied(true))}
      >
        <i className={copied ? 'ic ic-check' : 'ic ic-copy'} aria-hidden="true" />
        {copied ? '복사했습니다' : '비밀 복사'}
      </button>
      <span className="sr-only" role="status">
        {copied ? '서명 비밀을 복사했습니다' : ''}
      </span>
    </>
  );
}
