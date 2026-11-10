// 위저드가 부르는 API(POST /v1/partner/productions, GET /v1/partner/artists·places, POST …/images, ADR-0198, ADR-0242, ADR-0245, ADR-0257).
// 실행부는 부를 때 가져온다(첫 화면 JS를 늘리지 않는다).
export interface NameHit {
  id: string;
  name: string;
  /** 후보 줄의 작은 글(공연장 주소) */
  detail?: string;
}

export interface PartnerOpenWarning {
  eventIndex: number;
  code: string;
  suggestedOpenAt?: string;
}

export interface ProductionCreated {
  productionId: string;
  eventIds: string[];
  warnings: PartnerOpenWarning[];
}

const LIMIT = 8;

const load = () => import('@/shared/api');

export async function createProduction(body: unknown, idempotencyKey: string): Promise<ProductionCreated> {
  const { partnerApi, OPERATIONS } = await load();
  return partnerApi().request<ProductionCreated>(OPERATIONS.createPartnerProduction, { body, idempotencyKey });
}

/** 공연 이미지 한 장(multipart). safelisted가 아닌 X-Requested-With을 단다(catalog-review 3.5.1) */
export async function uploadProductionImage(productionId: string, item: { kind: 'POSTER' | 'DETAIL'; alt: string; order?: number }, file: File): Promise<unknown> {
  const { partnerApi, OPERATIONS, parseRetryAfter } = await load();
  const body = new FormData();
  body.append('file', file, file.name);
  body.append('kind', item.kind);
  body.append('alt', item.alt);
  if (item.order !== undefined) body.append('order', String(item.order));
  try {
    return await partnerApi().request(OPERATIONS.createPartnerProductionImage, { params: { productionId }, body, headers: { 'X-Requested-With': 'peaket-partner' } });
  } catch (e) {
    // 서버가 준 다시 시도 하한(Retry-After, 같은 응답의 Date와 견준다)을 오류에 붙인다(docs/frontend.md §4.1 '기다림')
    if (typeof e === 'object' && e !== null && 'retryAfter' in e) {
      const err = e as { retryAfter: string | null; date?: string | null };
      const floor = parseRetryAfter(err.retryAfter, Date.now(), err.date ?? null);
      if (floor !== undefined) Object.assign(e, { retryFloorMs: floor });
    }
    throw e;
  }
}

export async function searchArtists(q: string, signal: AbortSignal): Promise<NameHit[]> {
  const { partnerApi, OPERATIONS } = await load();
  const r = await partnerApi().request<{ items: { artistId: string; name: string }[] }>(OPERATIONS.listPartnerArtists, { query: { q, limit: LIMIT }, signal });
  return r.items.map((a) => ({ id: a.artistId, name: a.name }));
}

export async function searchPlaces(q: string, signal: AbortSignal): Promise<NameHit[]> {
  const { partnerApi, OPERATIONS } = await load();
  const r = await partnerApi().request<{ items: { placeId: string; name: string; address?: string }[] }>(OPERATIONS.listPartnerPlaces, { query: { q, limit: LIMIT }, signal });
  return r.items.map((p) => ({ id: p.placeId, name: p.name, ...(p.address ? { detail: p.address } : {}) }));
}
