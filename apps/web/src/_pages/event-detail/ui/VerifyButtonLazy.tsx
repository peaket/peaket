'use client';
// 공연 상세의 [휴대폰 본인확인] 버튼을 늦게 가져온다(첫 화면 JS 예산, docs/frontend.md §5.8, HOT-321).
// 본인확인 흐름(기관 창·결과 대화상자)은 본인확인 전인 로그인한 팬에게만 그리므로 첫 묶음에 넣지 않는다.
// 가져오는 동안은 같은 모양의 누를 수 없는 버튼을 둔다(자리가 흔들리지 않게).
import { lazy, Suspense } from 'react';
import type { VerifyIdentityButtonProps } from '@/features/identity-verify';

const VerifyIdentityButton = lazy(() => import('@/features/identity-verify').then((m) => ({ default: m.VerifyIdentityButton })));

export function VerifyButtonLazy(props: VerifyIdentityButtonProps) {
  return (
    <Suspense
      fallback={
        <button className={props.className} style={props.style} type="button" aria-disabled="true" aria-describedby={props.describedBy}>
          {props.children}
        </button>
      }
    >
      <VerifyIdentityButton {...props} />
    </Suspense>
  );
}
