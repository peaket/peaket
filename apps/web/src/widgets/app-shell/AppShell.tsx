'use client';
// 소비자 웹 셸 감싸개: ds WebShell(CMP-065 web-default·web-focus·web-staff·로고만)에 Next.js Link·라우터, 로그인 상태,
// 장르 목록, 자동완성 출처·최근 검색어(search-source, HOT-313), 토스트를 넣는다. 서버 페이지는 직렬화되는 값(문자열·불리언·객체·ReactNode)만 넘긴다.
// 로그인 상태(ADR-0202 결정 2, HOT-321): guest·user를 넘기지 않으면 화면 스크립트가 팬 계정 요약(GET /v1/identity/me)을 받아 고른다.
// 받기 전에는 머리의 계정 자리가 빈자리다. guest(로그인 화면처럼 늘 로그인 전 모양)와 user(아직 데이터에 잇지 않은 화면의 목업)는 그대로 따른다.
// 로그아웃은 확인 뒤 같은 출처 폼 POST /logout이다(앱 서버가 Origin을 보고 쿠키를 지운 뒤 홈으로, identity §2, ADR-0202 결정 6).
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, type ReactNode } from 'react';
import {
  WebShell,
  WebShellOfflineBanner,
  type WebNavKey,
  type WebSearchPopup,
  type WebShellFocusInfo,
  type WebShellOverlay,
  type WebShellStaffInfo,
} from '@peaket/ds/WebShell';
import { shellUserOf, useFanSession, type MeSummary } from '@/entities/me';
import { GENRES, searchHref } from '@/shared/config/genres';
import { ToastProvider } from '@/shared/ui/toast';
import { useRecentSearches, useSuggestionSource } from './search-source';

const SHELL_GENRES = [
  ...GENRES.map((g) => ({ label: g.label, href: searchHref.genre(g.key), icon: g.icon })),
  { label: '굿즈 스토어', href: '/shop', icon: 'goods' },
  { label: '공연장', href: searchHref.venue(), icon: 'venue' },
];

/** 머리 검색창의 처음 모양 */
export interface AppShellSearch {
  /** 처음 검색어 */
  defaultValue?: string;
  /** 처음 자동완성 창 모양(상태 미리보기). 'closed'가 아니면 연 채로 그린다 */
  popup?: WebSearchPopup;
  /** 휴대폰·태블릿 머리를 처음부터 검색 모드로(검색 화면). [취소]는 앞 화면으로 돌아간다 */
  barOpen?: boolean;
  /** 주소의 q를 입력에 채운다(검색 화면은 정적 셸이라 서버가 주소를 읽지 않는다, HOT-313) */
  queryFromUrl?: boolean;
}

export interface AppShellProps {
  /** default 일반 · focus 예매 흐름 · staff 현장 스태프 · minimal 로고만(잠깐 거쳐 가는 화면) */
  variant?: 'default' | 'focus' | 'staff' | 'minimal';
  /** ?theme=dark */
  dark?: boolean;
  /** 늘 로그인 전 모양(로그인 화면, 상태 미리보기 '비로그인' 등) */
  guest?: boolean;
  /** 셸에 보일 목업 사용자(아직 데이터에 잇지 않은 화면). 없으면 실제 로그인 상태 */
  user?: MeSummary;
  current?: WebNavKey | null;
  /** 위쪽 오프라인 띠(띠의 id는 'off-msg') */
  offline?: { lastSync: string } | null;
  focus?: WebShellFocusInfo;
  staff?: WebShellStaffInfo;
  /** 머리 검색창의 처음 모양 */
  search?: AppShellSearch;
  /** 바닥글을 그릴지(기본: default 변형만). false면 끈다 */
  footer?: boolean;
  defaultOpen?: WebShellOverlay | null;
  bottomBar?: ReactNode;
  updateAvailable?: boolean;
  children: ReactNode;
}

export function AppShell({
  variant = 'default',
  dark = false,
  guest = false,
  user,
  current = null,
  offline = null,
  focus,
  staff,
  search,
  footer,
  defaultOpen = null,
  bottomBar,
  updateAvailable = false,
  children,
}: AppShellProps) {
  const router = useRouter();
  const backOrHome = useCallback(() => (window.history.length > 1 ? router.back() : router.push('/')), [router]);
  const suggestSource = useSuggestionSource();
  const { recent, save } = useRecentSearches();
  const session = useFanSession({ enabled: !guest && !user });
  const live = shellUserOf(session);
  const shellUser = guest
    ? null
    : user
      ? { name: user.name, avatarText: user.avatarText, verified: user.verified, hasStaffAssignment: user.hasStaffAssignment }
      : (live ?? null);
  const logout = useCallback(() => {
    const f = document.createElement('form');
    f.method = 'post';
    f.action = '/logout';
    document.body.appendChild(f);
    f.submit();
  }, []);
  return (
    <ToastProvider>
      <WebShell
        variant={variant}
        dark={dark}
        user={shellUser}
        userPending={!guest && !user && live === undefined}
        current={current}
        genres={SHELL_GENRES}
        loadSearchSuggestions={suggestSource.load}
        peekSearchSuggestions={suggestSource.peek}
        onRecentSearchesChange={save}
        search={{
          defaultValue: search?.defaultValue,
          popup: search?.popup,
          recent,
          barOpen: search?.barOpen,
          queryFromUrl: search?.queryFromUrl,
        }}
        onSearchCancel={search?.barOpen ? backOrHome : undefined}
        focus={focus}
        staff={staff}
        footer={footer}
        banner={offline ? <WebShellOfflineBanner lastSync={offline.lastSync} /> : null}
        defaultOpen={defaultOpen}
        bottomBar={bottomBar}
        updateAvailable={updateAvailable}
        onNavigate={(href) => router.push(href)}
        onLogout={logout}
        renderLink={(p) => <Link {...p} />}
      >
        {children}
      </WebShell>
    </ToastProvider>
  );
}
