'use client';
// SCR-009 ③ 휴대폰 본인확인 다시 하기(목적 REVERIFY, SCR-006 흐름을 이 화면 위에서 연다). 본인확인 흐름은 첫 화면 JS에 싣지 않고
// 이 파일을 늦게 싣는다(QueueVerifyLive의 lazy, docs/frontend.md §5.8 '그 밖 소비자 화면' 첫 JS 200kB).
// 기관 창이 막혀 페이지 이동(REDIRECT)으로 돌아와도 흐름이 그 결과를 되살려 onDone을 부른다(features/identity-verify resumeReturnedResult).
import type { ReactNode } from 'react';
import { VerifyFlowProvider, VerifyTrigger, VerifyWaitingStatus } from '@/features/identity-verify';

export default function ReverifyStep({ onDone, className, describedBy, children }: { onDone: () => void; className: string; describedBy: string; children: ReactNode }) {
  return (
    <VerifyFlowProvider
      purpose="reverify"
      onSettled={(o) => {
        if (o === 'success') onDone();
      }}
    >
      <VerifyTrigger className={className} describedBy={describedBy}>
        {children}
      </VerifyTrigger>
      <VerifyWaitingStatus />
    </VerifyFlowProvider>
  );
}
