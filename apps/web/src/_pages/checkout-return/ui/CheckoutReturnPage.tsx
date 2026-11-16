// SCR-011 결제창 복귀 경로(캐시 셸, docs/frontend.md §5.3 '복귀 화면'). 결제창에서 돌아오는 첫 요청은 쿠키가 없고, 서버는 요청 값을 읽지 않는다.
// 결제 값은 화면 스크립트(CheckoutReturnLive)만 읽는다. 개발 서버에서 ?state=를 주면 퍼블리싱 그림을 본다(ADR-0229).
import { notFound } from 'next/navigation';
import { getPerformance } from '@/entities/performance';
import type { PageProps } from '@/shared/lib/page-props';
import { CheckoutReturnLive } from './CheckoutReturnLive';

type Props = PageProps<{ eventId: string }>;

/** 회차 ID 정본 꼴(소문자 UUID). 목업 회차(고정 자료, 글자 그대로)가 아니면서 이 꼴도 아니면 404다(정규 주소 하나로 모은다, docs/frontend.md §5.18, BAT-170 W7L2-S10) */
const EVENT_ID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export async function CheckoutReturnPage({ params, searchParams }: Props) {
  // 경로의 회차 ID는 정본 꼴과 글자까지 같을 때만 그린다(대소문자 변형마다 캐시 화면 항목이 생기지 않게, 요청 가로채기와 겹친 가드)
  const { eventId } = await params;
  if (!EVENT_ID_SHAPE.test(eventId) && !getPerformance(eventId)) notFound();
  if (process.env.NODE_ENV === 'development' && (await searchParams).state !== undefined) {
    const { CheckoutReturnPreview } = await import('./CheckoutReturnPreview');
    return <CheckoutReturnPreview params={params} searchParams={searchParams} />;
  }
  return <CheckoutReturnLive />;
}
