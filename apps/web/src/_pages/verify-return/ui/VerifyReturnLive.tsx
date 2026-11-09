'use client';
// 복귀 화면 /verify/return의 스크립트(docs/features/identity.md §5 '복귀 화면의 스크립트', BUILD_ORDER BOT-010, I-T45).
// 서버 처리기가 넘긴 기관 값(POST 본문) 또는 주소의 쿼리로 결과 경로를 부르고, 팝업이면 알린 뒤 닫고 아니면 next로 간다.
// 그리는 것은 없다(진행 표시는 감싸는 화면이 그린다). 개발 서버의 퍼블리싱 검토(팬 API 출처 없음)에서는 아무것도 하지 않는다.
import { useEffect, useRef } from 'react';
import { browserReturnEnv, isLiveVerify } from '@/features/identity-verify/browser';
import { runReturnFlow } from '@/features/identity-verify/flow';

export function VerifyReturnLive({ posted }: { posted: Record<string, string> | null }) {
  // 개발 모드의 StrictMode가 효과를 두 번 돌려도 결과 경로·토큰 갱신은 한 번만 한다(갱신이 겹치면 재사용 탐지에 걸린다)
  const ran = useRef(false);
  useEffect(() => {
    if (ran.current || !isLiveVerify()) return;
    ran.current = true;
    void runReturnFlow(browserReturnEnv(), posted).catch(() => location.replace('/'));
  }, [posted]);
  return null;
}
