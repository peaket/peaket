'use client';
// 휴대폰 범위 밖 안내 카드(d5 §3.9, 키트 20b절 .banner.bigscreen). 휴대폰(md 미만)에서만 보이고, 그 자리의 실제 버튼은 숨긴다:
//   <BigScreenNotice title="새 공연 등록은 태블릿이나 데스크톱에서 합니다" />  +  버튼 쪽에는 className="max-md:hidden"
import { useState } from 'react';

export interface BigScreenNoticeProps {
  /** 굵은 첫 줄. 없으면 "이 작업은 태블릿이나 데스크톱에서 합니다" */
  title?: string;
  /** 둘째 줄. 없으면 "휴대폰에서는 볼 수만 있습니다" */
  body?: string;
  /** 링크 복사 버튼의 이름(같은 화면에 여럿일 때 구분) */
  copyLabel?: string;
  /** 복사할 경로(없으면 지금 주소) */
  path?: string;
  /** 휴대폰이 아닌 크기에서도 보인다(미리보기 상태 등) */
  always?: boolean;
}

export function BigScreenNotice({ title, body, copyLabel, path, always = false }: BigScreenNoticeProps) {
  const [copied, setCopied] = useState(false);
  return (
    <div className={`banner banner-info bigscreen${always ? '' : ' md:hidden'}`} role="note" style={{ alignItems: 'flex-start' }}>
      <i className="ic ic-monitor" aria-hidden="true" />
      <div className="banner-body" style={{ flex: '1 1 calc(100% - 30px)' }}>
        <span className="banner-title">{title ?? '이 작업은 태블릿이나 데스크톱에서 합니다'}</span>
        {body ?? '휴대폰에서는 볼 수만 있습니다'}
      </div>
      <button
        className="btn btn-outline btn-sm"
        type="button"
        style={{ marginLeft: 30 }}
        aria-label={copyLabel}
        onClick={() => {
          const url = path ? new URL(path, window.location.origin).toString() : window.location.href;
          void navigator.clipboard?.writeText(url).then(() => setCopied(true));
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
