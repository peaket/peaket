'use client';
// SCR-016 후기 모달을 주소 값(?reviews=all · ?review=new · ?report=)으로 띄운다. 공연 상세는 캐시 화면이라(ISR, BUILD_ORDER HOT-311)
// 서버가 주소 값을 읽지 않고 화면 스크립트가 읽는다(useSearchParams는 Suspense 안에서만, 정적 셸에는 아무것도 그리지 않는다).
// 모달 안 목록·쓰기·신고는 아직 퍼블리싱 목업이다. 데이터 잇기는 LCH-150이 한다.
import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { resolveReviewModal } from '../model/view';
import { ReviewModalsClient } from './ReviewModalsClient';

export interface ReviewModalsFromUrlProps {
  /** 회차 id(공연 상세 주소의 id) */
  eventId: string;
  title: string;
  /** 이 공연의 회차(쓰기 모달의 회차 고르기) */
  rounds: readonly { value: string; label: string }[];
  /** 로그인 전(쓰기·신고는 로그인 안내로 바뀐다) */
  guest: boolean;
}

function Inner({ eventId, title, rounds, guest }: ReviewModalsFromUrlProps) {
  const sp = new URLSearchParams(useSearchParams().toString());
  // 퍼블리싱 상태 고르기(?state=)는 개발 빌드에서만 읽는다(운영 화면에서 목업 상태 모달이 열리지 않게)
  if (process.env.NODE_ENV === 'production') sp.delete('state');
  const init = resolveReviewModal(sp, guest);
  if (!init) return null;
  const path = `/events/${encodeURIComponent(eventId)}`;
  const key = [init.kind, init.reviewId, init.photo, init.from].join('|');
  return <ReviewModalsClient key={key} init={init} path={path} guest={guest} title={title} rounds={rounds} currentRound={eventId} loginHref={`/login?next=${encodeURIComponent(path)}`} />;
}

export function ReviewModalsFromUrl(props: ReviewModalsFromUrlProps) {
  return (
    <Suspense fallback={null}>
      <Inner {...props} />
    </Suspense>
  );
}
