// 퍼블리싱 상태 고르기(add-screen-publishing design.md 결정 7). 데이터를 잇는 단계에서 걷어 낸다.
// ?state=<보드 state 열거값> · ?theme=dark · ?role=member(파트너 실무자로 보기)
import { resolvePreviewState, resolvePreviewTheme } from '@peaket/ds/Preview';
import type { PartnerRole } from '@peaket/ds/PartnerShell';

export type SearchParams = Record<string, string | string[] | undefined>;

/** app/ 페이지가 받는 props(Next.js 16은 params·searchParams가 Promise다) */
export interface RouteProps<P extends Record<string, string> = Record<string, never>> {
  params: Promise<P>;
  searchParams: Promise<SearchParams>;
}

/** 실무자로 보는 상태 이름. 이 상태거나 ?role=member면 셸과 화면이 파트너 실무자로 그린다 */
export const MEMBER_STATES: readonly string[] = ['실무자 권한 없음', '실무자 보기', '명단 실무자 보기', '다운로드 이력 실무자 보기'];

export function readParam(sp: SearchParams | URLSearchParams | undefined, key: string): string | undefined {
  if (!sp) return undefined;
  if (sp instanceof URLSearchParams) return sp.get(key) ?? undefined;
  const v = sp[key];
  return Array.isArray(v) ? v[0] : v;
}

export function resolveRole(sp: SearchParams | URLSearchParams | undefined): PartnerRole {
  const role = readParam(sp, 'role');
  const state = readParam(sp, 'state');
  return role === 'member' || (state !== undefined && MEMBER_STATES.includes(state)) ? 'partner_member' : 'partner_admin';
}

export interface Preview<S extends string> {
  state: S;
  theme: 'light' | 'dark';
  role: PartnerRole;
  isMember: boolean;
  /** StateSwitcher에 넘겨 남길 검색 값 */
  keep: Record<string, string | undefined>;
}

/** 페이지에서 한 줄로: const pv = readPreview(await searchParams, STATES, '목록'); */
export function readPreview<S extends string>(sp: SearchParams, states: readonly S[], fallback: S): Preview<S> {
  const state = resolvePreviewState(sp, states, fallback);
  const theme = resolvePreviewTheme(sp);
  const role = resolveRole(sp);
  return {
    state,
    theme,
    role,
    isMember: role === 'partner_member',
    keep: { theme: theme === 'dark' ? 'dark' : undefined, role: readParam(sp, 'role') === 'member' ? 'member' : undefined },
  };
}
