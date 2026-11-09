// SCR-012 결제 결과 경로(요청마다 셸, docs/frontend.md §5.3). 서버는 값을 읽지 않고 실제 화면(ResultLive)을 낸다.
// 개발 서버에서 ?state=를 주면 퍼블리싱 그림을 본다(ADR-0230). 운영 묶음에는 들지 않는다.
import type { PageProps } from '@/shared/lib/page-props';
import { ResultLive } from './ResultLive';

type Props = PageProps<{ eventId: string }>;

function decoded(v: string): string {
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
}

export async function BookingResultPage({ params, searchParams }: Props) {
  if (process.env.NODE_ENV === 'development' && (await searchParams).state !== undefined) {
    const { BookingResultPreview } = await import('./BookingResultPreview');
    return <BookingResultPreview params={params} searchParams={searchParams} />;
  }
  const { eventId } = await params;
  return <ResultLive eventId={decoded(eventId)} />;
}
