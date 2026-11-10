// SCR-009 추가 검증 경로(요청마다 셸, 묶음 B·사람 확인 변형 CSP, docs/frontend.md §2.5·§5.3). 서버는 값을 읽지 않고 실제 화면(QueueVerifyLive)을 낸다.
// 개발 서버에서 ?state=를 주면 퍼블리싱 그림(QueueVerifyPreview)을 본다(결제 화면과 같은 나눔, ADR-0228). 운영 묶음에는 들지 않는다.
import type { PageProps } from '@/shared/lib/page-props';
import { QueueVerifyLive } from './QueueVerifyLive';

type Props = PageProps<{ eventId: string }>;

function decoded(v: string): string {
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
}

export async function QueueVerifyPage({ params, searchParams }: Props) {
  if (process.env.NODE_ENV === 'development' && (await searchParams).state !== undefined) {
    const { QueueVerifyPreview } = await import('./QueueVerifyPreview');
    return <QueueVerifyPreview params={params} searchParams={searchParams} />;
  }
  const { eventId } = await params;
  return <QueueVerifyLive eventId={decoded(eventId)} />;
}
