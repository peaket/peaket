// SCR-011 주문·결제 경로(요청마다 셸, docs/frontend.md §5.3). 서버는 값을 읽지 않고 실제 화면(CheckoutLive)을 낸다.
// 개발 서버에서 ?state=를 주면 아직 잇지 않은 상태의 퍼블리싱 그림을 본다(ADR-0228). 운영 묶음에는 들지 않는다.
import type { PageProps } from '@/shared/lib/page-props';
import { CheckoutLive } from './CheckoutLive';

type Props = PageProps<{ eventId: string }>;

function decoded(v: string): string {
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
}

export async function CheckoutPage({ params, searchParams }: Props) {
  if (process.env.NODE_ENV === 'development' && (await searchParams).state !== undefined) {
    const { CheckoutPreview } = await import('./CheckoutPreview');
    return <CheckoutPreview params={params} searchParams={searchParams} />;
  }
  const { eventId } = await params;
  return <CheckoutLive eventId={decoded(eventId)} />;
}
