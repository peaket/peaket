// 머리 통합 검색창의 자동완성 후보(SCR-003 ⑤, d5 §5.3, planning/04 SCR-003 ⑤). 모든 화면의 셸 검색창이 같은 규칙을 쓰므로 셸 위젯에 둔다
// (SCR-003 페이지에서 옮겼다, FSD: 위젯은 페이지를 가져오지 않는다). 종류별 몫 공연 5 · 아티스트 2 · 공연장 1 [가정], 모두 8개 [가정]까지.
// 실제로는 자동완성 API(CDN 60초)가 준다. 지금은 목업 공연·아티스트·공연장에서 고른다. 일치 표시는 맞은 부분만 굵게,
// 다른 이름으로 맞으면 원래 이름의 대응 부분을, 대응이 없으면 이름 전체를 굵게 한다(ADR-0063·0094).
import { ARTISTS } from '@/entities/artist';
import { PRODUCTIONS, type PosterArt } from '@/entities/production';
import { VENUES } from '@/entities/venue';

export type SuggestionKind = 'production' | 'artist' | 'venue';

export interface Suggestion {
  id: string;
  kind: SuggestionKind;
  label: string;
  href: string;
  /** 공연이면 다음 오픈 일시 '10/14(수) 20:00 오픈' */
  meta?: string;
  poster?: PosterArt;
  /** 굵게 할 [시작, 끝). null이면 이름 전체 */
  bold: [number, number] | null;
}

export const KIND_TEXT: Record<SuggestionKind, string> = { production: '공연', artist: '아티스트', venue: '공연장' };
export const KIND_ICON: Record<SuggestionKind, string> = { production: 'ic-ticket', artist: 'ic-user', venue: 'ic-genre-venue' };

/** 다른 이름(별칭) → 원래 이름의 대응 부분 */
const ALIAS: Record<string, string> = { 루멘: 'LUMEN' };
/** 아티스트의 한글 다른 이름(보드의 아티스트 후보 글) */
const ARTIST_KO: Record<string, string> = { 'art-lumen': '루멘' };

function boldRange(label: string, q: string): [number, number] | null {
  const lower = label.toLowerCase();
  for (const needle of [q, ALIAS[q]].filter((s): s is string => Boolean(s))) {
    const at = lower.indexOf(needle.toLowerCase());
    if (at >= 0) return [at, at + needle.length];
  }
  return null;
}

/** 입력 하나의 후보. 한글 음절은 1자부터, 로마자·숫자는 2자부터 [가정] */
export function suggest(raw: string): Suggestion[] {
  const q = raw.trim();
  if (!q) return [];
  if (/^[a-z0-9]+$/i.test(q) && q.length < 2) return [];
  const needle = q.toLowerCase();
  const alias = ALIAS[q]?.toLowerCase();
  const hit = (s: string) => s.toLowerCase().includes(needle) || (alias !== undefined && s.toLowerCase().includes(alias));
  const productions = PRODUCTIONS.filter((p) => hit(p.title) || (p.artistId && hit(ARTISTS.find((a) => a.id === p.artistId)?.name ?? '')))
    .slice(0, 5)
    .map<Suggestion>((p) => ({
      id: p.id,
      kind: 'production',
      label: p.title,
      href: `/events/${p.performanceIds[0] ?? ''}`,
      meta: `${p.openText} 오픈`,
      poster: p.poster.art,
      bold: boldRange(p.title, q),
    }));
  const artists = ARTISTS.filter((a) => hit(a.name) || (ARTIST_KO[a.id] ?? '').includes(q))
    .slice(0, 2)
    .map<Suggestion>((a) => {
      const label = ARTIST_KO[a.id]?.includes(q) ? ARTIST_KO[a.id]! : a.name;
      return { id: a.id, kind: 'artist', label, href: `/search?artistId=${a.id}&q=${encodeURIComponent(q)}`, bold: boldRange(label, q) };
    });
  const venues = VENUES.filter((v) => hit(v.name))
    .slice(0, 1)
    .map<Suggestion>((v) => ({ id: v.id, kind: 'venue', label: v.name, href: `/search?placeId=${v.id}`, bold: boldRange(v.name, q) }));
  return [...productions, ...artists, ...venues].slice(0, 8);
}

/** 보드 '자동완성'(입력 '루멘')의 후보 셋. 둘째(아티스트)가 고른 줄이다 */
export const BOARD_SUGGESTIONS: readonly Suggestion[] = [
  { id: 'prd-lumen', kind: 'production', label: 'LUMEN 콘서트 2026 서울', href: '/events/evt-lumen-1025', meta: '10/14(수) 20:00 오픈', poster: 'lumen', bold: [0, 5] },
  { id: 'art-lumen', kind: 'artist', label: '루멘', href: '/search?artistId=art-lumen&q=%EB%A3%A8%EB%A9%98', bold: [0, 2] },
  { id: 'prd-fanmeet', kind: 'production', label: '팬미팅', href: '/events/evt-fanmeet-1114', meta: '10/28(수) 20:00 오픈', poster: 'fanmeet', bold: null },
];

/** 보드 '최근 검색어' 예시(이 기기에만 저장. 퍼블리싱에서는 화면 안에만 둔다) */
export const BOARD_RECENT: readonly string[] = ['LUMEN', '뮤지컬', '콘서트'];
