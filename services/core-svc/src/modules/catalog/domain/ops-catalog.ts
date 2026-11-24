// 관제 판매 승인 화면의 아티스트·공연장 찾기/만들기 값과 검사(LCH-080 잔여, ADR-0093 결정 4, d5 §7.9 ②).
// 이름·다른 이름·초성으로 찾고, 정규화한 이름이 같은 대상은 새로 만들지 않는다(같은 대상이 둘로 갈라지지 않게).
// 순수 함수만 둔다(프레임워크·플랫폼 형 없음).
import { nameKeys, normalize } from '@peaket/search-normalize';

export const OPS_ARTISTS_MAX = 20;
export const OPS_PLACES_MAX = 20;
export const OPS_QUERY_MIN = 1;
export const OPS_QUERY_MAX = 50;
export const OPS_LIST_DEFAULT = 20;
export const OPS_LIST_MAX = 100;
export const OPS_NAME_MAX = 100;
export const OPS_REASON_MAX = 500;

export interface OpsArtistView {
  artistId: string;
  name: string;
  aliases: string[];
}

export interface OpsPlaceView {
  placeId: string;
  name: string;
  address: string;
  region: string;
  status: 'ACTIVE' | 'CLOSED';
  aliases: string[];
}

/** 유스케이스 층의 이름 붙은 오류(openapi problem type과 같은 status·title). 확장 칸은 ProblemError가 싣는다 */
export class OpsCatalogProblem extends Error {
  constructor(
    readonly type: string,
    readonly status: number,
    readonly title: string,
    readonly extensions: Record<string, unknown> = {},
    readonly detail?: string,
  ) {
    super(title);
    this.name = 'OpsCatalogProblem';
  }
}

export const invalidQuery = (detail: string) => new OpsCatalogProblem('invalid-query', 400, '찾기 조건이 올바르지 않습니다', {}, detail);
export const invalidBody = (detail: string) => new OpsCatalogProblem('invalid-body', 400, '입력한 값을 확인해 주세요', {}, detail);
export const artistExists = (artistId: string) => new OpsCatalogProblem('artist-exists', 409, '같은 이름의 아티스트가 이미 있습니다', { artistId });
export const placeExists = (placeId: string) => new OpsCatalogProblem('place-exists', 409, '같은 이름·주소의 공연장이 이미 있습니다', { placeId });

const CHOSEONG = /^[ㄱ-ㅎ]+$/;

/** 찾기 비교: 정규화한 이름·다른 이름의 부분 일치, 초성 입력은 초성 앞부분 일치 */
export function matchesName(q: string, name: string, aliases: readonly string[]): boolean {
  const nq = nameKeys(q);
  if (nq.nospace === '') return false;
  const isChoseong = CHOSEONG.test(q.normalize('NFKC').replaceAll(/\s/g, ''));
  for (const label of [name, ...aliases]) {
    const nk = nameKeys(label);
    if (nk.nospace.includes(nq.nospace)) return true;
    if (isChoseong && nq.chosung !== '' && nk.chosung.startsWith(nq.chosung)) return true;
  }
  return false;
}

/** 정규화한 이름이 같은지(중복 만들기 409). 공백·대소문자·전각 차이를 지운다 */
export function sameName(a: string, b: string): boolean {
  return nameKeys(a).nospace === nameKeys(b).nospace;
}

/** 이름·주소가 같은 공연장인지(공백·문장부호 차이를 지운다) */
export function samePlace(a: { name: string; address: string }, b: { name: string; address: string }): boolean {
  const squash = (s: string): string => normalize(s).replaceAll(/[\s.,()[\]-]/g, '');
  return squash(a.name) === squash(b.name) && squash(a.address) === squash(b.address);
}

/** 목록 커서: 정렬 키(정규화 이름, ID)를 base64url로 담는다 */
export function encodeOpsCursor(sortKey: string, id: string): string {
  return Buffer.from(JSON.stringify([sortKey, id])).toString('base64url');
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function decodeOpsCursor(cursor: string): { sortKey: string; id: string } | undefined {
  try {
    const v = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    if (!Array.isArray(v) || v.length !== 2 || typeof v[0] !== 'string' || typeof v[1] !== 'string' || !UUID.test(v[1])) return undefined;
    return { sortKey: v[0], id: v[1] };
  } catch {
    return undefined;
  }
}

/** 정렬 키: 정규화 이름 → ID. 같은 이름이 여럿이어도 한 줄씩 넘어간다 */
export const opsSortKey = (name: string): string => normalize(name);

/** 찾은 목록을 커서 뒤부터 limit만큼 자른다. nextCursor는 더 있을 때만 준다 */
export function pageOf<T extends { id: string; name: string; aliases: string[] }>(
  rows: readonly T[],
  q: string,
  limit: number,
  cursor: { sortKey: string; id: string } | undefined,
): { rows: T[]; nextCursor: string | null } {
  const hit = rows
    .filter((r) => matchesName(q, r.name, r.aliases))
    .map((r) => ({ r, key: opsSortKey(r.name) }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.r.id < b.r.id ? -1 : a.r.id > b.r.id ? 1 : 0));
  const start = cursor === undefined ? 0 : hit.findIndex((x) => x.key > cursor.sortKey || (x.key === cursor.sortKey && x.r.id > cursor.id));
  const from = start < 0 ? hit.length : start;
  const page = hit.slice(from, from + limit).map((x) => x.r);
  const last = page[page.length - 1];
  const more = hit.length > from + page.length;
  return { rows: page, nextCursor: more && last !== undefined ? encodeOpsCursor(opsSortKey(last.name), last.id) : null };
}
