// 판매 승인의 아티스트·공연장 연결 규칙(순수, LCH-080 잔여, ADR-0093 결정 4·ADR-0198 결정 4).
// 파트너가 새 이름으로 요청한 아티스트는 승인 본문 artists로 요청 이름마다 하나씩 이어야 하고,
// 새 공연장 요청은 placeId가 있어야 한다. 빠지면 실제 DB 제약(production_approved_place_check)에 닿기 전에 422로 막는다.
import { sameName } from './ops-catalog.js';
import type { SaleState } from './sale-ports.js';

export interface SaleLinkageInput {
  artists?: { name: string; artistId: string }[];
  placeId?: string | undefined;
}

export interface SaleLinkageSupport {
  /** 승인 본문 artistId 가운데 실제로 있는 것 */
  existingArtists: ReadonlySet<string>;
  /** 고른 공연장을 쓸 수 있는지(없거나 CLOSED면 거짓). placeId가 없으면 참으로 본다 */
  placeUsable: boolean;
}

export interface ResolvedArtist {
  artistId: string;
  sortOrder: number;
}

const problem = (type: string, title: string): Error => Object.assign(new Error(title), { saleReviewProblem: { type, status: 422, title } });

/** 유스케이스가 ProblemError로 바꿀 수 있게 표시한 오류인지 */
export function linkageProblemOf(err: unknown): { type: string; status: number; title: string } | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  return (err as { saleReviewProblem?: { type: string; status: number; title: string } }).saleReviewProblem;
}

/**
 * 승인 본문의 연결 값을 검사하고, 저장할 아티스트 행을 요청 순서로 돌려준다.
 * support가 없으면 존재·사용 가능 검사는 건너뛴다(잠금 밖 1차 검사와 잠금 안 재검사에 같은 함수를 쓴다).
 */
export function checkLinkage(st: SaleState, input: SaleLinkageInput, support?: SaleLinkageSupport): ResolvedArtist[] {
  const requested = [...(st.production.requestedArtists ?? [])].sort((a, b) => a.sortOrder - b.sortOrder || (a.name < b.name ? -1 : 1));
  const given = input.artists ?? [];
  const resolved: ResolvedArtist[] = [];

  if (requested.length === 0 && given.length > 0) {
    throw problem('sale-review-artists-missing', '연결할 새 아티스트 요청이 없습니다');
  }
  if (requested.length > 0) {
    if (given.length !== requested.length) throw problem('sale-review-artists-missing', '새 이름 아티스트마다 연결할 아티스트를 골라 주세요');
    const used = new Set<number>();
    for (const want of requested) {
      const at = given.findIndex((g, i) => !used.has(i) && sameName(g.name, want.name));
      if (at < 0) throw problem('sale-review-artists-missing', '새 이름 아티스트마다 연결할 아티스트를 골라 주세요');
      used.add(at);
      const artistId = given[at]!.artistId;
      if (typeof artistId !== 'string' || artistId === '') throw problem('sale-review-artists-missing', '연결할 아티스트를 골라 주세요');
      if (support && !support.existingArtists.has(artistId)) throw problem('sale-review-artists-missing', '없는 아티스트는 연결할 수 없습니다');
      resolved.push({ artistId, sortOrder: want.sortOrder });
    }
    if (used.size !== given.length) throw problem('sale-review-artists-missing', '요청에 없는 아티스트가 섞였습니다');
  }

  const requestedPlace = st.production.requestedPlace ?? null;
  if (requestedPlace !== null) {
    if (input.placeId === undefined || input.placeId === '') throw problem('sale-review-place-missing', '새 공연장 요청은 연결할 공연장을 골라 주세요');
  }
  if (input.placeId !== undefined && support && !support.placeUsable) {
    throw problem('sale-review-place-missing', '쓸 수 없는 공연장입니다');
  }

  return resolved;
}
