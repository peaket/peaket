// SCR-010 좌석 선택 경로(요청마다 셸, docs/frontend.md §5.2). 서버는 값을 읽지 않고 실제 화면(SeatsLive)을 낸다.
// 개발 서버에서 ?state=를 주면 아직 잇지 않은 상태의 퍼블리싱 그림을 본다(ADR-0224 결정 2). 운영 묶음에는 들지 않는다.
import type { PageProps } from '@/shared/lib/page-props';
import { SeatsLive } from './SeatsLive';

type Props = PageProps<{ eventId: string }>;

/** 잘못된 % 부호여도 화면을 깨뜨리지 않는다(그런 회차는 입장 저장값이 없어 예매 시간 끝으로 간다) */
function decoded(v: string): string {
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
}

export async function SeatsPage({ params, searchParams }: Props) {
  if (process.env.NODE_ENV === 'development' && (await searchParams).state !== undefined) {
    const { SeatsPreview } = await import('./SeatsPreview');
    return <SeatsPreview params={params} searchParams={searchParams} />;
  }
  const { eventId } = await params;
  return <SeatsLive eventId={decoded(eventId)} />;
}
