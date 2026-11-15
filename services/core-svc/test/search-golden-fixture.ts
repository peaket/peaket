// 골든 세트 고정 파일(test/fixtures/search-golden.json)을 읽어 메모리 저장소와 PostgreSQL에 같은 카탈로그로 채운다(BAT-165 웨이브 7 T-10·T-11, SR-T12).
// 단위 시험(메모리 어댑터)과 통합 시험(PostgreSQL 어댑터)이 함께 쓴다. 정답 계산은 하지 않는다(정답은 고정 파일에 손으로 적었다).
import { refineLocally } from '@peaket/search-normalize';
import type { Database } from '@peaket/platform';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { artist, event, place, production, productionArtist, promoter, searchAlias, wish } from '../src/modules/catalog/adapters/db/schema.js';
import type { MemoryCatalogRepository } from '../src/modules/catalog/index.js';

export interface GoldenProduction {
  id: string;
  title: string;
  genre: '콘서트' | '뮤지컬' | '연극' | '클래식' | '페스티벌' | '팬미팅' | '기타';
  placeId: string;
  artistIds: string[];
  aliases: string[];
  state: 'ON_SALE' | 'UPCOMING' | 'ENDED';
  wishes: number;
  events: { id: string; openMin: number; startMin: number; endMin: number }[];
}

export interface GoldenCase {
  id: string;
  kind: string;
  q?: string;
  expect?: string;
  params?: Record<string, string | boolean>;
  didYouMean?: string;
  steps?: { q: string; request: boolean }[];
  expectIn?: string;
}

export interface Golden {
  now: string;
  places: { id: string; name: string }[];
  artists: { id: string; name: string }[];
  productions: GoldenProduction[];
  cases: GoldenCase[];
}

export function loadGolden(): Golden {
  return JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/search-golden.json', import.meta.url)), 'utf8')) as Golden;
}

export const PROMOTER = '40000000-0000-4000-8000-000000000001';
const CREATOR = '40000000-0000-4000-8000-000000000002';
const minutes = (g: Golden, m: number) => new Date(Date.parse(g.now) + m * 60_000);
const aliasId = (p: number, i: number) => `60000000-0000-4000-8000-${String(p * 10 + i).padStart(12, '0')}`;
const wishAccount = (p: number, i: number) => `50000000-0000-4000-8000-${String(p * 1_000 + i).padStart(12, '0')}`;

/** 메모리 저장소에 채운다(판매 상태는 시계로 계산되게 saleStates를 두지 않는다) */
export function fillMemory(repo: MemoryCatalogRepository, g: Golden): void {
  const placeOf = new Map(g.places.map((p) => [p.id, p]));
  const artistOf = new Map(g.artists.map((a) => [a.id, a]));
  repo.placeNames = g.places.map((p) => ({ id: p.id, name: p.name })) as never;
  g.productions.forEach((p, n) => {
    repo.productions.set(p.id, { id: p.id, promoterId: PROMOTER, placeId: p.placeId, title: p.title, genre: p.genre, saleReview: 'APPROVED', saleApprovedAt: minutes(g, -60 * 24 * 60) });
    repo.registrations.set(p.id, { aliases: p.aliases.map((alias, i) => ({ id: aliasId(n, i), alias })) } as never);
    for (const e of p.events) {
      repo.events.set(e.id, { id: e.id, productionId: p.id, venueId: null, openAt: minutes(g, e.openMin), startsAt: minutes(g, e.startMin), status: 'SCHEDULED' });
      const pl = placeOf.get(p.placeId)!;
      repo.details.set(e.id, { event: { endsAt: minutes(g, e.endMin) }, place: { id: pl.id, name: pl.name, address: '서울' }, artists: p.artistIds.map((id) => ({ artistId: id, name: artistOf.get(id)!.name })) } as never);
    }
    for (let i = 0; i < p.wishes; i++) {
      const account = wishAccount(n, i);
      const m = repo.wishes.get(account) ?? new Map<string, Date>();
      m.set(p.id, minutes(g, -60));
      repo.wishes.set(account, m);
    }
  });
}

/** PostgreSQL에 같은 카탈로그를 채운다(슈퍼유저 연결). 공연 ID 목록을 돌려준다. 읽기 모델 동기화는 부르는 쪽이 한다 */
export async function fillDatabase(db: Database, g: Golden): Promise<string[]> {
  await db.db.insert(promoter).values({ id: PROMOTER, legalName: '(주)골든세트' }).onConflictDoNothing();
  await db.db.insert(place).values(g.places.map((p) => ({ id: p.id, name: p.name, address: '서울', region: '서울', createdBy: CREATOR }))).onConflictDoNothing();
  await db.db.insert(artist).values(g.artists.map((a) => ({ id: a.id, name: a.name, createdBy: CREATOR }))).onConflictDoNothing();
  for (const [n, p] of g.productions.entries()) {
    await db.db.insert(production).values({ id: p.id, promoterId: PROMOTER, placeId: p.placeId, title: p.title, genre: p.genre, saleReview: 'APPROVED', saleApprovedAt: minutes(g, -60 * 24 * 60) });
    if (p.artistIds.length > 0) await db.db.insert(productionArtist).values(p.artistIds.map((artistId, i) => ({ productionId: p.id, artistId, sortOrder: i })));
    if (p.aliases.length > 0)
      await db.db.insert(searchAlias).values(p.aliases.map((alias, i) => ({ id: aliasId(n, i), targetKind: 'PRODUCTION', targetId: p.id, alias, source: 'PARTNER', createdBy: CREATOR })));
    await db.db.insert(event).values(p.events.map((e) => ({ id: e.id, productionId: p.id, promoterId: PROMOTER, venueId: null, openAt: minutes(g, e.openMin), startsAt: minutes(g, e.startMin), endsAt: minutes(g, e.endMin) })));
    if (p.wishes > 0) await db.db.insert(wish).values(Array.from({ length: p.wishes }, (_, i) => ({ accountId: wishAccount(n, i), productionId: p.id, createdAt: minutes(g, -60) })));
  }
  return g.productions.map((p) => p.id);
}

/** 검색 결과 요청 주소 */
export function searchUrl(c: GoldenCase, page = 1): string {
  const u = new URLSearchParams({ q: c.q ?? '' });
  for (const [k, v] of Object.entries(c.params ?? {})) u.set(k, String(v));
  if (page !== 1) u.set('page', String(page));
  return `/v1/search?${u.toString()}`;
}

export interface SuggestItem {
  kind: string;
  label: string;
  productionId?: string;
}

/**
 * 순서 경우(§4.5): 한 글자씩 늘려 가며 브라우저 거르기 함수를 거친다. 거르지 못하면 서버에 묻는다.
 * 돌려주는 것: 걸음마다 서버에 물었는가, 마지막 걸음의 후보 공연 ID
 */
export async function runSequence(c: GoldenCase, suggest: (q: string) => Promise<{ query: string; items: SuggestItem[] }>): Promise<{ requests: boolean[]; last: string[] }> {
  let answer: { query: string; items: SuggestItem[] } | undefined;
  let shown: SuggestItem[] = [];
  const requests: boolean[] = [];
  for (const step of c.steps ?? []) {
    const local = refineLocally(answer ? { query: answer.query, items: answer.items } : undefined, step.q, (t: SuggestItem) => t.label);
    if (local === undefined) {
      answer = await suggest(step.q);
      shown = answer.items;
      requests.push(true);
    } else {
      shown = local;
      requests.push(false);
    }
  }
  return { requests, last: shown.flatMap((x) => (x.productionId ? [x.productionId] : [])) };
}
