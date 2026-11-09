// 위저드가 부르는 API(POST /v1/partner/productions, GET /v1/partner/artists·places, ADR-0198, ADR-0242, ADR-0245).
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
