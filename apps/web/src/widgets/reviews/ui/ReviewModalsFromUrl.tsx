'use client';
// SCR-016 후기 모달을 주소 값(?reviews=all · ?review=new · ?report=)으로 띄운다. 공연 상세는 캐시 화면이라(ISR, BUILD_ORDER HOT-311)
// 서버가 주소 값을 읽지 않고 화면 스크립트가 읽는다(useSearchParams는 Suspense 안에서만, 정적 셸에는 아무것도 그리지 않는다).
// 모달 안 목록·요약·쓰기·신고는 core-svc 후기 API에 연결한다. 운영자 조치는 운영자 화면에서 moderator를 참으로 준다.
import dynamic from 'next/dynamic';
import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { resolveReviewModal } from '../model/view';

// 후기 모달 본체(목록·쓰기·신고·운영자 조치, api-client 실행부)는 첫 화면 JS 예산에서 뺀다.
// 주소가 모달을 가리킬 때만 이 덩어리를 받는다(next/dynamic, docs/frontend.md §5.8).
const ReviewModalsClient = dynamic(() => import('./ReviewModalsClient').then((m) => m.ReviewModalsClient), {
  ssr: false,
  loading: () => null,
});

export interface ReviewModalsFromUrlProps {
  /** 회차 id(공연 상세 주소의 id) */
  eventId: string;
  title: string;
  /** 이 공연의 회차(쓰기 모달의 회차 고르기) */
  rounds: readonly { value: string; label: string }[];
  /** 로그인 전(쓰기·신고는 로그인 안내로 바뀐다) */
  guest: boolean;
  /** 관제 운영자 조치를 함께 보일지(운영자 화면에서만 참) */
  moderator?: boolean;
}

function Inner({ eventId, title, rounds, guest, moderator = false }: ReviewModalsFromUrlProps) {
  const sp = new URLSearchParams(useSearchParams().toString());
  // 퍼블리싱 상태 고르기(?state=)는 개발 빌드에서만 읽는다(운영 화면에서 목업 상태 모달이 열리지 않게)
  if (process.env.NODE_ENV === 'production') sp.delete('state');
  const init = resolveReviewModal(sp, guest);
  if (!init) return null;
  const path = `/events/${encodeURIComponent(eventId)}`;
  const key = [init.kind, init.reviewId, init.photo, init.from].join('|');
  // 운영자 조치는 운영자 화면에서 moderator를 참으로 준다. 개발 빌드에서는 ?moderator=1로 눈으로 확인할 수 있다.
  const showModeration = moderator || (process.env.NODE_ENV !== 'production' && sp.get('moderator') === '1');
  return <ReviewModalsClient key={key} init={init} path={path} guest={guest} title={title} rounds={rounds} currentRound={eventId} loginHref={`/login?next=${encodeURIComponent(path)}`} moderator={showModeration} />;
}

export function ReviewModalsFromUrl(props: ReviewModalsFromUrlProps) {
  return (
    <Suspense fallback={null}>
      <Inner {...props} />
    </Suspense>
  );
}
