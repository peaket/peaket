// 머리 검색창 자동완성의 브라우저 규칙(docs/features/search.md §4.5, d5 §5.3 '자동완성 불러오는 중', openapi getSearchSuggestions, BUILD_ORDER HOT-313).
// - 요청 최소 길이: 한글 음절이 하나라도 있으면 1자부터, 로마자·숫자·낱자만이면 2자부터 [가정](계약 q 설명).
// - 받은 후보가 8개보다 적으면 더 긴 입력은 요청 없이 그 안에서 거른다. 앞선 입력이 두 글자(한글은 두 음절) 이상이고 입력 종류(초성만·한글·로마자)가
//   같으며 거른 결과가 0건이 아닐 때만 거른다(0건이면 다시 요청한다. 서버는 한/영 변환으로 다시 찾을 수 있다).
// - 계약 후보 → 셸 후보: 공연은 대표 회차 상세, 아티스트·공연장은 그 필터의 검색 결과. 굵게는 서버가 준 위치만(matches, UTF-16), 없으면 이름 전체.
// 이 파일은 순수 함수만 둔다(node --test가 바로 불러 본다).
import type { SuggestResultItemsItem } from '@peaket/api-client/model';
import { dateTimeText, parseTime } from '../../../shared/lib/kst.ts';

export const SUGGEST_LIMIT = 8;
const ZERO_WIDTH = /[​-‍⁠﻿ㅤ]/g;
const SYLLABLE = /[가-힣]/;
const CHOSUNG_ONLY = /^[ㄱ-ㅎ\s]+$/;
const CHOSUNG = ['ㄱ', 'ㄲ', 'ㄴ', 'ㄷ', 'ㄸ', 'ㄹ', 'ㅁ', 'ㅂ', 'ㅃ', 'ㅅ', 'ㅆ', 'ㅇ', 'ㅈ', 'ㅉ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ'];

/** 호환 자모 94자(U+3131~U+318E). NFKC가 이것들을 조합용 자모로 바꾸므로 역표를 만들어 되돌린다(search.md §3.1 '호환 자모 94자의 역표') */
const COMPAT_FROM_NFKC: ReadonlyMap<string, string> = (() => {
  const m = new Map<string, string>();
  for (let c = 0x3131; c <= 0x318e; c += 1) {
    const ch = String.fromCharCode(c);
    const n = ch.normalize('NFKC');
    if (n !== ch && n.length === 1 && !m.has(n)) m.set(n, ch);
  }
  return m;
})();
/** NFKC 뒤 남는 한글 채움 문자(U+115F 초성 채움·U+1160 중성 채움) */
const FILLERS = /[\u115f\u1160]/g;

/** NFKC가 바꾼 조합용 자모를 호환 자모로 되돌린다 */
function toCompatJamo(s: string): string {
  let out = '';
  for (const ch of s) out += COMPAT_FROM_NFKC.get(ch) ?? ch;
  return out;
}

/** 정규화(search.md §3.1의 줄인 꼴): NFKC 뒤 한글 채움 문자 지움·자모를 호환 자모로 되돌림·소문자·제로폭 지움·공백 정리. 조합 중 글자를 낱자로 풀지는 않는다 */
export function normalizeInput(q: string): string {
  return toCompatJamo(q.normalize('NFKC').replace(FILLERS, '')).toLowerCase().replace(ZERO_WIDTH, '').replace(/\s+/g, ' ').trim();
}

/** 자동완성 요청에 싣는 값: 정규화한 입력(같은 검색이 같은 요청 주소, SR-T11). 50자를 넘으면 부르지 않는다(undefined) */
export function suggestRequestQuery(q: string): string | undefined {
  const n = normalizeInput(q);
  return n && n.length <= 50 ? n : undefined;
}

export type InputKind = 'chosung' | 'hangul' | 'roman';

export function inputKind(q: string): InputKind {
  if (CHOSUNG_ONLY.test(q)) return 'chosung';
  return /[ᄀ-ᇿㄱ-ㆎ가-힣]/.test(q) ? 'hangul' : 'roman';
}

/** 요청해도 되는 길이인가(한글 음절이 있으면 1자, 아니면 2자부터 [가정]) */
export function minLengthOk(q: string): boolean {
  const n = normalizeInput(q);
  if (!n) return false;
  return SYLLABLE.test(n) ? true : [...n].length >= 2;
}

/** 이름의 초성(음절이 아닌 글자는 그대로) */
export function chosungOf(label: string): string {
  let out = '';
  for (const ch of label) {
    const c = ch.charCodeAt(0);
    out += c >= 0xac00 && c <= 0xd7a3 ? CHOSUNG[Math.floor((c - 0xac00) / 588)] : ch;
  }
  return out;
}

/** 앞선 입력이 거르기의 출발점이 될 만큼 긴가(두 글자, 한글은 두 음절 이상) */
function longEnough(q: string): boolean {
  const chars = [...q.replace(/\s/g, '')];
  if (inputKind(q) === 'hangul') return chars.filter((c) => SYLLABLE.test(c)).length >= 2;
  return chars.length >= 2;
}

export interface LastAnswer<T> {
  /** 정규화한 입력 */
  query: string;
  items: readonly T[];
  /** 서버가 준 후보 수(그리지 못해 뺀 것 포함). 없으면 items 수 */
  rawCount?: number;
}

/**
 * 받은 후보 안에서 거를 수 있으면 거른 결과, 아니면 undefined(요청한다). label은 후보의 화면 이름.
 * 조건: 앞선 후보가 8개보다 적고, 새 입력이 앞선 입력으로 시작하며 더 길고, 앞선 입력이 두 글자(한글 두 음절) 이상이고, 입력 종류가 같고, 거른 결과가 있다.
 */
/** 이름이 입력에 맞는가(브라우저 비교: 이름 안에 그대로, 띄어쓰기를 없앤 값, 초성 입력이면 이름의 초성) */
function labelMatches(labelText: string, q: string): boolean {
  const l = normalizeInput(labelText);
  if (inputKind(q) === 'chosung') {
    const c = chosungOf(l);
    return c.includes(q) || c.replace(/ /g, '').includes(q.replace(/ /g, ''));
  }
  return l.includes(q) || l.replace(/ /g, '').includes(q.replace(/ /g, ''));
}

/**
 * 받은 후보 안에서 거를 수 있으면 거른 결과, 아니면 undefined(요청한다). label은 후보의 화면 이름. rawCount는 서버가 준 후보 수(뺀 것 포함).
 * 조건: 서버가 준 후보가 8개보다 적고, 새 입력이 앞선 입력으로 시작하며 더 길고, 앞선 입력이 두 글자(한글 두 음절) 이상이고, 입력 종류가 같고,
 * 앞선 답의 모든 후보가 브라우저 비교로도 앞선 입력에 맞으며(다른 이름·낱자로 맞은 후보가 섞였으면 브라우저가 설명하지 못해 다시 요청),
 * 거른 결과가 있다.
 */
export function refineLocally<T>(last: LastAnswer<T> | undefined, q: string, label: (t: T) => string, limit: number = SUGGEST_LIMIT): T[] | undefined {
  const n = normalizeInput(q);
  if (!last || (last.rawCount ?? last.items.length) >= limit || n === last.query || !n.startsWith(last.query)) return undefined;
  if (!longEnough(last.query) || inputKind(last.query) !== inputKind(n)) return undefined;
  if (!last.items.every((t) => labelMatches(label(t), last.query))) return undefined;
  const found = last.items.filter((t) => labelMatches(label(t), n));
  return found.length > 0 ? found : undefined;
}

/** 셸(ds WebSearchBox)이 그리는 후보 한 줄 */
export interface ShellSuggestion {
  id: string;
  kind: 'production' | 'artist' | 'venue';
  label: string;
  href: string;
  meta?: string;
  posterUrl?: string;
  /** 굵게 보일 [시작, 끝) 목록(서버가 준 위치). 빈 목록이면 이름 전체 */
  highlights: readonly (readonly [number, number])[];
}

/** 계약 후보 하나 → 셸 후보. 갈 곳이 없으면(ID 없음) 빼고 그린다 */
export function toShellSuggestion(it: SuggestResultItemsItem): ShellSuggestion | undefined {
  const highlights = (it.matches ?? []).flatMap((m) =>
    typeof m.start === 'number' && typeof m.length === 'number' && m.length > 0 && m.start >= 0 && m.start + m.length <= it.label.length ? [[m.start, m.start + m.length] as const] : [],
  );
  if (it.kind === 'PRODUCTION') {
    if (!it.eventId) return undefined;
    const open = parseTime(it.nextOpenAt);
    return {
      id: `p-${it.productionId ?? it.eventId}`,
      kind: 'production',
      label: it.label,
      href: `/events/${encodeURIComponent(it.eventId)}`,
      ...(open !== undefined ? { meta: `${dateTimeText(open)} 오픈` } : {}),
      ...(it.posterUrl ? { posterUrl: it.posterUrl } : {}),
      highlights,
    };
  }
  if (it.kind === 'ARTIST') {
    if (!it.artistId) return undefined;
    return { id: `a-${it.artistId}`, kind: 'artist', label: it.label, href: `/search?artistId=${encodeURIComponent(it.artistId)}`, highlights };
  }
  if (!it.placeId) return undefined;
  return { id: `v-${it.placeId}`, kind: 'venue', label: it.label, href: `/search?placeId=${encodeURIComponent(it.placeId)}`, highlights };
}

/** 최근 검색어 저장 이름과 상한(docs/frontend.md §3.12 `peaket.recentSearches`, 10개 [가정]) */
export const RECENT_KEY = 'peaket.recentSearches';
export const RECENT_MAX = 10;
/** 최근 검색어 한 개의 글자 수 상한(검색어 50자, 계약 q) */
export const RECENT_TEXT_MAX = 50;

/** 저장소 값 → 최근 검색어(모양이 틀리면 빈 목록) */
export function parseRecent(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length <= RECENT_TEXT_MAX).slice(0, RECENT_MAX) : [];
  } catch {
    return [];
  }
}
