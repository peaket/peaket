'use client';
// 페이지 이동 방식의 본인확인(기관이 새 창 대신 이 탭을 옮김)에서 공연 상세로 돌아왔는데, 이 화면에 본인확인 버튼이 없을 때 그 결과를 받는다
// (HOT-321 새 맥락 리뷰 낮음 5). 계정 요약이 이미 '본인확인 완료'이거나 비로그인이면 버튼(=결과를 읽는 흐름)이 그려지지 않아
// 탭 저장소의 복귀 값이 남았다가 다른 화면에서 엉뚱하게 뜬다. 복귀 값이 있을 때만 흐름을 늦게 가져와 읽는다(완료 토스트·결과 대화상자).
// 본인확인 전인 로그인한 팬이면 버튼들의 흐름이 읽으므로 여기서는 읽지 않는다.
import { lazy, Suspense, useEffect, useState } from 'react';
import { useFanSession } from '@/entities/me';
import { RETURN_STORAGE_KEY } from '@/features/identity-verify/keys';

const VerifyFlowProvider = lazy(() => import('@/features/identity-verify').then((m) => ({ default: m.VerifyFlowProvider })));

export function VerifyReturnResume({ loginHref }: { loginHref: string }) {
  const s = useFanSession();
  const [returned, setReturned] = useState(false);
  useEffect(() => {
    try {
      setReturned(sessionStorage.getItem(RETURN_STORAGE_KEY) !== null);
    } catch {
      // 저장소를 쓸 수 없는 브라우저: 복귀 값도 없다
    }
  }, []);
  const buttonsRead = s.status === 'member' && !s.me.verified;
  if (!returned || s.status === 'loading' || buttonsRead) return null;
  return (
    <Suspense fallback={null}>
      <VerifyFlowProvider loginHref={loginHref}>{null}</VerifyFlowProvider>
    </Suspense>
  );
}
