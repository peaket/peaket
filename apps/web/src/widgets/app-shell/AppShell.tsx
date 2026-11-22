'use client';
// 소비자 웹 셸 감싸개: ds WebShell(CMP-065 web-default·web-focus·web-staff·로고만)에 Next.js Link·라우터, 로그인 상태,
// 장르 목록, 자동완성 출처·최근 검색어(search-source, HOT-313), 토스트를 넣는다. 서버 페이지는 직렬화되는 값(문자열·불리언·객체·ReactNode)만 넘긴다.
// 로그인 상태(ADR-0202 결정 2, HOT-321): guest·user를 넘기지 않으면 화면 스크립트가 팬 계정 요약(GET /v1/identity/me)을 받아 고른다.
// 받기 전에는 머리의 계정 자리가 빈자리다. guest(로그인 화면처럼 늘 로그인 전 모양)와 user(아직 데이터에 잇지 않은 화면의 목업)는 그대로 따른다.
// 로그아웃(ADR-0363 결정 8, docs/frontend.md §5.14.4): 대화상자의 [로그아웃]이 정리 루틴(features/session-cleanup)을 부른다.
// 웹 푸시 해제 DELETE를 먼저 → 저장물 지우기 → ('이 기기의 입장 키도 지우기'를 골랐으면) 월렛 → 다른 탭에 logout → 같은 출처 fetch POST /logout.
// 이동이나 2xx면 홈으로, 503·연결 실패면 대화상자 안에 다시 시도를 안내한다. 다른 탭의 logout을 받으면 저장물을 지우고 로그인 화면으로 간다.
// 로그인한 셸이 그려지면 웹 푸시 구독을 지금 계정에 다시 묶는다(권한을 묻지 않는다, §4.2.4). 둘 다 늦게 싣는다(첫 JS에 넣지 않는다).
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, type ReactNode } from 'react';
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
// 셸 묶음에는 작은 로더만 든다(월렛 등록이 있을 때만 토스트 모듈을 늦게 불러온다, HOT-390)
import { WalletUpdateLoader } from '@/features/wallet-device-key/ui/WalletUpdateLoader';
import { GENRES, searchHref } from '@/shared/config/genres';
import { ToastProvider } from '@/shared/ui/toast';
import { useRecentSearches, useSuggestionSource } from './search-source';

/** 이 문서에서 웹 푸시 다시 묶기를 이미 했는가 */
let rebound = false;

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
  const logout = useCallback(async ({ clearEntryKeys }: { clearEntryKeys: boolean }): Promise<{ error?: string } | void> => {
    try {
      const [{ logoutCleanup }, { browserWebPush }] = await Promise.all([import('@/features/session-cleanup'), import('@/features/web-push')]);
      const r = await logoutCleanup({ wallet: clearEntryKeys, server: true, pushUnbind: () => browserWebPush().unbind() });
      if (r.server === 'ok') {
        window.location.assign('/');
        return;
      }
    } catch {
      // 모듈을 받지 못했거나(연결 끊김) 정리 중 뜻밖 오류: 아래 다시 시도 안내
    }
    return { error: '로그아웃하지 못했습니다. 인터넷 연결을 확인한 뒤 다시 시도해 주세요' };
  }, []);
  // 다른 탭의 로그아웃(§5.14.4 4번): 이 탭의 저장물을 지우고 로그인 화면으로
  useEffect(() => {
    let stop: (() => void) | undefined;
    let cancelled = false;
    void import('@/features/session-cleanup')
      .then((m) => {
        if (!cancelled) stop = m.listenSessionLogout(() => window.location.assign('/login'));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      stop?.();
    };
  }, []);
  // 로그인한 셸: 웹 푸시 구독을 지금 계정에 다시 묶는다(§4.2.4 '웹 푸시 다시 묶기'). 문서마다 한 번
  const signedIn = Boolean(live);
  useEffect(() => {
    if (!signedIn || rebound) return;
    rebound = true;
    void import('@/features/web-push')
      .then((m) => m.browserWebPush().rebind())
      .then((r) => {
        // 실패하면 다음 화면 열림에 한 번 더 한다
        if (r.kind === 'failed') rebound = false;
      })
      .catch(() => {
        rebound = false;
      });
  }, [signedIn]);
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
        onSearchActivate={suggestSource.warm}
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
        onNavigate={(href) => {
          // 자동완성 항목을 골랐으면 선택 사건을 센다(검색 품질, docs/features/search.md §11)
          suggestSource.selected(href);
          router.push(href);
        }}
        onLogout={logout}
        renderLink={(p) => <Link {...p} />}
      >
        {children}
      </WebShell>
      {/* 실제 월렛 워커 갱신 안내. 미리보기(updateAvailable)가 켜져 있으면 셸이 이미 그린다 */}
      {updateAvailable ? null : <WalletUpdateLoader />}
    </ToastProvider>
  );
}
