'use client';
// 휴대폰 범위 밖 안내 카드(d5 §3.9, 키트 .banner.bigscreen). 보드 SCR-021-m은 본문 글이 상태마다 달라 shared/ui/BigScreenNotice 대신 이것을 쓴다.
import { useState } from 'react';

export function CopyLinkBanner({ title, body }: { title: string; body: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="banner banner-info bigscreen" role="note">
      <i className="ic ic-monitor" aria-hidden="true" />
      <div className="banner-body" style={{ flex: '1 1 200px' }}>
        <span className="banner-title">{title}</span>
        {body}
      </div>
      <button
        className="btn btn-outline btn-sm"
        type="button"
        onClick={() => {
          void navigator.clipboard?.writeText(window.location.href).then(() => setCopied(true));
        }}
      >
        <i className={copied ? 'ic ic-check' : 'ic ic-copy'} aria-hidden="true" />
        {copied ? '복사했습니다' : '링크 복사'}
      </button>
      <span className="sr-only" role="status">
        {copied ? '링크를 복사했습니다' : ''}
      </span>
    </div>
  );
}
