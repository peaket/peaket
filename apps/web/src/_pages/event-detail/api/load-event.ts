// 공연 상세 읽기(서버, ISR. docs/frontend.md §2.5 '/events/[id]' 행, openapi getEvent, ADR-0200, BUILD_ORDER HOT-311).
// - 'use cache' + cacheLife 300초 + cacheTag('event:{id}', 'production:{productionId}'): 회차 하나의 변경은 회차 태그, 공연 칸·회차 목록·
//   판매자 정보의 변경은 공연 태그로 그 공연의 모든 회차를 지운다(ADR-0200 결정 5, 태그는 소문자).
// - 404(승인 이력이 없는 회차·없는 회차)와 410(한 번 공개된 뒤 판매 중지)은 그 값으로 돌려준다. 그 밖의 실패는 던진다:
//   ISR 다시 만들기라면 Next.js가 마지막 정상 화면을 계속 낸다(POL-029 stale-if-error와 같은 뜻). 첫 그리기라면 오류 화면이다.
// - 서버 API 주소(PEAKET_API_ORIGIN)가 없으면(CI 빌드처럼 원본이 없는 곳) 부르지 않고 '없음'이다.
import { getEvent, getHome } from '@peaket/api-client/endpoints/catalog';
import { cacheLife, cacheTag } from 'next/cache';
import { ensureServerApi } from '@/shared/api';
import { toEventDetail, type EventDetail } from '../model/detail';

export type LoadedEvent = { kind: 'found'; detail: EventDetail } | { kind: 'missing' } | { kind: 'suspended' };

const ID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function statusOf(e: unknown): number | undefined {
  const s = typeof e === 'object' && e !== null ? (e as { status?: unknown }).status : undefined;
  return typeof s === 'number' ? s : undefined;
}

export async function loadEvent(id: string): Promise<LoadedEvent> {
  'use cache';
  cacheLife({ revalidate: 300 });
  cacheTag(`event:${id.toLowerCase()}`);
  if (!ID_SHAPE.test(id) || id === PLACEHOLDER_EVENT_ID || !ensureServerApi()) return { kind: 'missing' };
  try {
    const r = await getEvent(id);
    const detail = toEventDetail(r.data);
    if (!detail) return { kind: 'missing' };
    cacheTag(`production:${detail.productionId.toLowerCase()}`);
    return { kind: 'found', detail };
  } catch (e) {
    const s = statusOf(e);
    if (s === 404) return { kind: 'missing' };
    if (s === 410) return { kind: 'suspended' };
    throw e;
  }
}

/** 어느 회차도 미리 그리지 않을 때의 자리 ID(Cache Components는 generateStaticParams가 하나 이상 내야 한다. 이 ID는 404다) */
export const PLACEHOLDER_EVENT_ID = '00000000-0000-4000-8000-000000000000';

/**
 * 빌드 때 미리 그릴 회차: 홈 피드의 대표 회차(오픈 예정·판매 중, 30개 [가정]까지). 나머지는 처음 들어올 때 그리고 ISR로 둔다.
 * 원본이 없거나 홈 피드가 실패하면 자리 ID 하나다(빌드를 막지 않는다). 홈 피드는 왔는데 미리 그릴 회차의 상세가 5xx면 그 그리기가
 * 던져 빌드가 실패한다(원본이 반쯤 망가진 채 배포하지 않게, 드러나게 둔다).
 */
export async function popularEventIds(): Promise<string[]> {
  if (!ensureServerApi()) return [PLACEHOLDER_EVENT_ID];
  try {
    const { data } = await getHome();
    const ids = [...(data.upcoming ?? []), ...(data.onSale ?? [])].flatMap((c) => (c.eventId && ID_SHAPE.test(c.eventId) ? [c.eventId] : []));
    const unique = [...new Set(ids)].slice(0, 30);
    return unique.length > 0 ? unique : [PLACEHOLDER_EVENT_ID];
  } catch {
    return [PLACEHOLDER_EVENT_ID];
  }
}
