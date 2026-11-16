// 공연 상세 읽기(서버, ISR. docs/frontend.md §2.5 '/events/[id]' 행, openapi getEvent, ADR-0200, BUILD_ORDER HOT-311).
// - 'use cache' + cacheLife 300초 + cacheTag('event:{id}', 'production:{productionId}'): 회차 하나의 변경은 회차 태그, 공연 칸·회차 목록·
//   판매자 정보의 변경은 공연 태그로 그 공연의 모든 회차를 지운다(ADR-0200 결정 5, 태그는 소문자).
// - 404(승인 이력이 없는 회차·없는 회차)와 410(한 번 공개된 뒤 판매 중지)은 그 값으로 돌려준다. 그 밖의 실패는 던진다:
//   ISR 다시 만들기라면 Next.js가 마지막 정상 화면을 계속 낸다(POL-029 stale-if-error와 같은 뜻). 첫 그리기라면 오류 화면이다.
// - 서버 API 주소(PEAKET_API_ORIGIN)가 없으면(CI 빌드처럼 원본이 없는 곳) 부르지 않고 '없음'이다.
// - 키 수 막기(docs/frontend.md §5.18, BAT-170 웨이브 끝 리뷰 W7L2-S1): 회차 ID 꼴은 캐시 함수 밖(화면)에서 isEventId로 먼저 본다.
//   캐시 함수 안에서 보면 꼴 밖 글자마다 캐시 항목이 생긴다. 없음·중지 결과에는 태그 web-transient를 달아 공유 캐시에 넣지 않는다
//   (처리기가 파드 메모리에만 60초 둔다).
import { getEvent, getHome } from '@peaket/api-client/endpoints/catalog';
import { cacheLife, cacheTag } from 'next/cache';
import { ensureServerApi } from '@/shared/api';
import { toEventDetail, type EventDetail } from '../model/detail';

/** fetchedAtMs: 이 캐시 항목을 만든 시각. 캐시 화면 안의 시각 판정(JSON-LD 판매 상태)은 이 값을 쓴다(캐시 밖 Date.now()는 Cache Components의 미리 그리기를 깬다) */
export type LoadedEvent = { kind: 'found'; detail: EventDetail; fetchedAtMs: number } | { kind: 'missing' } | { kind: 'suspended' };

const ID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function statusOf(e: unknown): number | undefined {
  const s = typeof e === 'object' && e !== null ? (e as { status?: unknown }).status : undefined;
  return typeof s === 'number' ? s : undefined;
}

/** 공유하지 않을 결과의 태그. apps/web/server/cache-store.mjs의 TRANSIENT_TAG와 같은 값이다(서버 묶음에 redis를 끌어오지 않게 글자로 둔다) */
const TRANSIENT_TAG = 'web-transient';

/** 회차 ID 꼴 확인(UUID, W7L2-S1 ①). 화면이 loadEvent보다 먼저 부르고, 꼴 밖이면 캐시 함수를 부르지 않고 404다 */
export function isEventId(id: string): boolean {
  return typeof id === 'string' && ID_SHAPE.test(id);
}

export async function loadEvent(id: string): Promise<LoadedEvent> {
  'use cache';
  cacheLife({ revalidate: 300 });
  cacheTag(`event:${id.toLowerCase()}`);
  // 꼴 밖은 화면이 먼저 막는다. 여기 닿아도 공유 캐시에는 넣지 않는다
  if (!ID_SHAPE.test(id) || id === PLACEHOLDER_EVENT_ID || !ensureServerApi()) return transient({ kind: 'missing' });
  try {
    const r = await getEvent(id);
    const detail = toEventDetail(r.data);
    if (!detail) return transient({ kind: 'missing' });
    cacheTag(`production:${detail.productionId.toLowerCase()}`);
    return { kind: 'found', detail, fetchedAtMs: Date.now() };
  } catch (e) {
    const s = statusOf(e);
    if (s === 404) return transient({ kind: 'missing' });
    if (s === 410) return transient({ kind: 'suspended' });
    throw e;
  }
}

/** 없음·중지 결과: 태그 web-transient를 달아 돌려준다('use cache' 함수 안에서만 부른다) */
function transient<T extends LoadedEvent>(r: T): T {
  cacheTag(TRANSIENT_TAG);
  return r;
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
