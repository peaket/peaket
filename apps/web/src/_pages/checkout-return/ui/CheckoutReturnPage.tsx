// SCR-011 결제창 복귀 경로(캐시 셸, docs/frontend.md §5.3 '복귀 화면'). 결제창에서 돌아오는 첫 요청은 쿠키가 없고, 서버는 요청 값을 읽지 않는다.
// 결제 값은 화면 스크립트(CheckoutReturnLive)만 읽는다. 개발 서버에서 ?state=를 주면 퍼블리싱 그림을 본다(ADR-0229).
import type { PageProps } from '@/shared/lib/page-props';
import { CheckoutReturnLive } from './CheckoutReturnLive';

type Props = PageProps<{ eventId: string }>;

export async function CheckoutReturnPage({ params, searchParams }: Props) {
  if (process.env.NODE_ENV === 'development' && (await searchParams).state !== undefined) {
    const { CheckoutReturnPreview } = await import('./CheckoutReturnPreview');
    return <CheckoutReturnPreview params={params} searchParams={searchParams} />;
  }
  return <CheckoutReturnLive />;
}
