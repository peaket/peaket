'use client';
// CMP-065 AppShell 소비자 웹 변형 셋(d5 §3.1, docs/frontend.md §2.7, 캔버스 키트 18절 .wh·.fh·.sh·.wf).
// - default(web-default): lg 1280 미만 머리 = 로고 · 검색 아이콘 · 마이 티켓 · 메뉴(메뉴 시트),
//   lg 머리 = 로고 · 통합 검색창(콤보박스) · 찜 · 마이 티켓 · 계정 메뉴, 아래 줄 '전체 장르'와 주 메뉴(홈 · 공연 · 오픈 예정 · 굿즈 스토어). 바닥글.
// - focus(web-focus): ( 닫기 ) 공연명 · 회차 · (홀드 남은 시간) · 계정 메뉴(로그아웃). 바닥글 없음.
// - staff(web-staff): <현장 스태프> 배지 · 닫기 · [ 로그아웃 ]. 바닥글 없음. 폭 360 미만에서는 로고 글자를 숨겨(낭독은 남김) 머리가 넘치지 않게 한다.
// - minimal: 로고만 있는 머리(본인확인 복귀 화면 /verify/return 등 잠깐 거쳐 가는 화면, 보드 SCR-006 '복귀 화면'). 바닥글 없음.
// 일반 셸의 검색: lg 미만 머리의 검색 아이콘을 누르면 머리 자체가 { 검색창 } [취소]로 바뀐다(d5 §3.1·§5.3). search.barOpen이면 처음부터 그 모양이다(SCR-003).
//   lg 머리 통합 검색창과 검색 모드 머리는 같은 WebSearchBox이고, search로 처음 검색어·자동완성 창 상태(미리보기)를 넣는다.
// 세 변형 모두 로그인한 화면이면 로그아웃에 닿고, 같은 확인 대화상자를 쓴다(ASVS 7.4.4).
// 화면 본문은 그리지 않는다: children에 <main id="main" tabIndex={-1}>을 넣는다. 링크는 renderLink로 앱 라우터의 Link를 넣는다.
// renderLink·onNavigate는 함수라서 서버 컴포넌트가 바로 넘길 수 없다 — 앱의 'use client' 감싸개에서 넘긴다(README).
import { Fragment, useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { cx } from "../../lib/cx";
import { renderLinkOrAnchor, type RenderLink, type RenderLinkProps } from "../../lib/link";
import { focusableIn, useFocusTrap, useOutsidePress } from "./focus-trap";
import { LogoutDialog } from "./LogoutDialog";
import { WebFooter, type WebFooterHrefs } from "./WebFooter";
import { WebSearchBox, type WebSearchPopup, type WebSearchSuggestion } from "./WebSearchBox";
import { WebShellModal } from "./WebShellModal";

export type WebShellVariant = "default" | "focus" | "staff" | "minimal";
export type WebNavKey = "home" | "events" | "upcoming" | "shop";

export interface WebShellUser {
  /** 표시 이름(예: '지민') */
  name: string;
  /** 동그란 글자. 없으면 이름 첫 글자 */
  avatarText?: string;
  /** 휴대폰 본인확인 완료 */
  verified?: boolean;
  /** 현장 스태프 배정이 있으면 메뉴에 '현장 근무'를 보인다(→ SCR-061) */
  hasStaffAssignment?: boolean;
}

export interface WebShellHrefs extends WebFooterHrefs {
  home: string;
  search: string;
  /** 주 메뉴 '공연' */
  events: string;
  /** 주 메뉴 '오픈 예정' */
  upcoming: string;
  shop: string;
  /** '전체 장르'(장르 필터 없는 검색) */
  allGenres: string;
  likes: string;
  myTickets: string;
  orders: string;
  settings: string;
  staff: string;
  login: string;
}

/** 기본 주소(소비자 웹 경로, d5 §2·frontend §2.5). 검색 필터 매개변수 이름은 SCR-003 담당이 정한다 */
export const WEB_SHELL_DEFAULT_HREFS: WebShellHrefs = {
  home: "/",
  search: "/search",
  events: "/search",
  upcoming: "/search?status=upcoming",
  shop: "/shop",
  allGenres: "/search",
  likes: "/my/likes",
  myTickets: "/my/tickets",
  orders: "/my/orders",
  settings: "/my/settings",
  staff: "/staff",
  login: "/login",
  help: "/help",
  dispute: "/policy/dispute",
  terms: "/policy/terms",
  privacy: "/policy/privacy",
  escrowCheck: "/policy/business",
  locales: { ko: "/", en: "/en", ja: "/ja", zh: "/zh" },
};

export interface WebShellGenre {
  label: string;
  href: string;
  /** 키트 아이콘 이름(ic-genre-concert의 'concert') */
  icon: string;
}

export interface WebShellHold {
  /** 화면 글(예: '홀드 6:59') */
  text: string;
  /** 낭독 이름(예: '홀드 남은 시간 6분 59초') */
  ariaLabel: string;
  tone?: "normal" | "warning" | "expired" | "paused";
}

export interface WebShellFocusInfo {
  /** 공연명 */
  title: string;
  /** 회차·공연장(예: '10/25(일) 18:00 · 피켓 아레나') */
  subtitle: string;
  /** 닫기 → 공연 상세(대기는 취소하지 않는다) */
  closeHref: string;
  closeLabel?: string;
  hold?: WebShellHold | null;
  /** 데스크톱(lg) 머리에도 홀드 타이머를 보일지(기본 true). 오른쪽 패널에 같은 타이머가 있는 화면(보드 SCR-010-d 직접 선택·SCR-011-d)은 false */
  holdOnDesktop?: boolean;
}

export interface WebShellStaffInfo {
  closeHref: string;
  closeLabel?: string;
}

export type WebShellOverlay = "menu" | "account" | "genres" | "logout";

/** 머리 검색창의 처음 모양(SCR-003 상태 미리보기·주소의 q) */
export interface WebShellSearch {
  /** 처음 검색어 */
  defaultValue?: string;
  /** 처음 자동완성 창 모양. 'closed'가 아니면 연 채로 그린다(보드 '최근 검색어'·'자동완성'·'자동완성 없음'·'자동완성 불러오는 중') */
  popup?: WebSearchPopup;
  /** popup 'suggest'일 때 보일 후보(보드 값). 없으면 검색어로 찾은 후보 */
  popupSuggestions?: readonly WebSearchSuggestion[];
  /** 처음 고른 줄(0부터) */
  activeIndex?: number;
  /** 최근 검색어 */
  recent?: readonly string[];
  /** 휴대폰·태블릿 머리를 처음부터 검색 모드로 그린다(SCR-003 검색 화면) */
  barOpen?: boolean;
  /** 주소의 q를 입력에 채운다(SCR-003 검색 화면은 정적 셸이라 서버가 주소를 읽지 않는다) */
  queryFromUrl?: boolean;
}

export interface WebShellProps {
  variant?: WebShellVariant;
  /** ?theme=dark */
  dark?: boolean;
  /** 로그인한 팬. null이면 로그인 전 모양 */
  user?: WebShellUser | null;
  /**
   * 로그인 여부를 아직 모른다(화면 스크립트가 확인하는 중, 소비자 웹 ADR-0202 결정 2). 머리의 계정 자리를 같은 크기의 빈자리로 둔다:
   * 로그인한 사람에게 [로그인]이 잠깐 비치지 않게 한다
   */
  userPending?: boolean;
  /** 주 메뉴에서 지금 화면(aria-current) */
  current?: WebNavKey | null;
  hrefs?: Partial<WebShellHrefs>;
  /** '전체 장르' 창의 장르 목록 */
  genres?: readonly WebShellGenre[];
  /** 통합 검색창 후보 */
  searchSuggestions?: readonly WebSearchSuggestion[];
  /** 검색어 → 후보(별칭 등 앱 규칙). 주면 searchSuggestions 대신 쓴다 */
  getSearchSuggestions?: (query: string) => readonly WebSearchSuggestion[];
  /** 검색어 → 후보를 비동기로(자동완성 API). 주면 getSearchSuggestions 대신 쓴다 */
  loadSearchSuggestions?: (query: string, signal: AbortSignal) => Promise<readonly WebSearchSuggestion[] | null>;
  /** 기다리지 않고 바로 답할 수 있으면 그 답(후보·null), 요청해야 하면 undefined */
  peekSearchSuggestions?: (query: string) => readonly WebSearchSuggestion[] | null | undefined;
  /** 최근 검색어가 바뀌었을 때(앱이 저장한다) */
  onRecentSearchesChange?: (recent: string[]) => void;
  /** 머리 검색창의 처음 모양 */
  search?: WebShellSearch;
  /** 검색 모드 머리의 [취소]. 없으면 일반 머리로 돌아간다 */
  onSearchCancel?: () => void;
  focus?: WebShellFocusInfo;
  staff?: WebShellStaffInfo;
  /** 위쪽 배너 자리(오프라인 띠 등, WebShellOfflineBanner) */
  banner?: ReactNode;
  /** 새 버전 안내 토스트(대기실·좌석·결제·티켓 화면에서는 주지 않는다) */
  updateAvailable?: boolean;
  /** 바닥글을 그릴지(기본: default 변형만). false면 일반 셸에서도 끈다 */
  footer?: boolean;
  /** 바닥글 사업자 정보 줄 */
  businessInfo?: ReactNode;
  /** 처음부터 연 겹침 창(상태 미리보기) */
  defaultOpen?: WebShellOverlay | null;
  /** 바닥글 뒤에 붙는 띠(공연 상세의 하단 고정 예매 버튼 등). 위치(sticky 등)는 넣는 쪽이 정한다 */
  bottomBar?: ReactNode;
  /** 로그아웃 확인을 눌렀을 때 */
  onLogout?: (opts: { clearEntryKeys: boolean }) => void;
  /** 메뉴 항목·검색 후보로 이동할 때(앱 라우터의 push). 없으면 브라우저 이동 */
  onNavigate?: (href: string) => void;
  renderLink?: RenderLink;
  className?: string;
  children: ReactNode;
}

export function WebShell({
  variant = "default",
  dark = false,
  user = null,
  userPending = false,
  current = null,
  hrefs: hrefsProp,
  genres = [],
  searchSuggestions,
  getSearchSuggestions,
  loadSearchSuggestions,
  peekSearchSuggestions,
  onRecentSearchesChange,
  search,
  onSearchCancel,
  focus,
  staff,
  banner,
  updateAvailable = false,
  footer,
  businessInfo,
  defaultOpen = null,
  bottomBar,
  onLogout,
  onNavigate,
  renderLink,
  className,
  children,
}: WebShellProps) {
  const hrefs: WebShellHrefs = { ...WEB_SHELL_DEFAULT_HREFS, ...hrefsProp, locales: { ...WEB_SHELL_DEFAULT_HREFS.locales, ...hrefsProp?.locales } };
  const [menuOpen, setMenuOpen] = useState(defaultOpen === "menu");
  const [logoutOpen, setLogoutOpen] = useState(defaultOpen === "logout");
  // 휴대폰·태블릿 검색 모드 머리. 아이콘으로 열었으면 입력에 초점, [취소]로 닫으면 아이콘으로 초점을 돌려준다
  const [barOpen, setBarOpen] = useState(Boolean(search?.barOpen));
  const [barFocus, setBarFocus] = useState(false);
  const searchBtnRef = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef(false);
  useEffect(() => {
    if (!barOpen && returnFocus.current) {
      returnFocus.current = false;
      searchBtnRef.current?.focus();
    }
  }, [barOpen]);
  const link = (p: RenderLinkProps) => renderLinkOrAnchor(renderLink, p);
  const navigate = (href: string) => (onNavigate ? onNavigate(href) : window.location.assign(href));
  const showFooter = footer ?? variant === "default";
  const searchBox = (layout: "desktop" | "bar") => (
    <WebSearchBox
      layout={layout}
      action={hrefs.search}
      suggestions={searchSuggestions}
      getSuggestions={getSearchSuggestions}
      {...(loadSearchSuggestions ? { loadSuggestions: loadSearchSuggestions } : {})}
      {...(peekSearchSuggestions ? { peekSuggestions: peekSearchSuggestions } : {})}
      {...(onRecentSearchesChange ? { onRecentChange: onRecentSearchesChange } : {})}
      queryFromUrl={search?.queryFromUrl ?? false}
      defaultValue={search?.defaultValue}
      popup={search?.popup}
      popupSuggestions={search?.popupSuggestions}
      defaultActiveIndex={search?.activeIndex}
      recent={search?.recent}
      onNavigate={onNavigate}
      autoFocus={layout === "bar" && barFocus}
    />
  );
  const cancelSearch = () => {
    if (onSearchCancel) {
      onSearchCancel();
      return;
    }
    returnFocus.current = true;
    setBarFocus(false);
    setBarOpen(false);
  };
  const askLogout = () => {
    setMenuOpen(false);
    setLogoutOpen(true);
  };

  return (
    <div className={cx("pk page min-h-dvh", dark && "dark", className)}>
      <a
        className="sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-[300] focus:rounded-(--r-md) focus:bg-(--surface-raised) focus:px-3 focus:py-2 focus:shadow-lg"
        href="#main"
      >
        본문 바로가기
      </a>
      {banner}

      {variant === "default" && (
        <>
          {/* 휴대폰·태블릿(lg 미만) 머리. 검색 모드면 머리 자체가 { 검색창 } [취소](보드 SCR-003-m·t) */}
          {barOpen ? (
            <header className="wh relative gap-1.5 pr-1.5 pl-3 md:gap-2 md:pr-4 md:pl-6 lg:hidden">
              {searchBox("bar")}
              <button className="btn btn-ghost btn-sm" type="button" aria-label="검색 취소" style={{ height: 44 }} onClick={cancelSearch}>
                취소
              </button>
            </header>
          ) : (
            <header className="wh lg:hidden md:pl-6 md:pr-4">
              {link({ href: hrefs.home, className: "logo", "aria-label": "PEAKET 홈", children: <Logo /> })}
              <button
                ref={searchBtnRef}
                className="icon-btn"
                type="button"
                aria-label="검색"
                onClick={() => {
                  setBarFocus(true);
                  setBarOpen(true);
                }}
              >
                <i className="ic ic-search" aria-hidden="true" />
              </button>
              {link({ href: hrefs.myTickets, className: "icon-btn", "aria-label": "마이 티켓", children: <i className="ic ic-ticket" aria-hidden="true" /> })}
              <button
                className="icon-btn"
                type="button"
                aria-label="메뉴 열기(찜·전체 장르·주 메뉴·계정)"
                aria-haspopup="dialog"
                aria-expanded={menuOpen}
                onClick={() => setMenuOpen(true)}
              >
                <i className="ic ic-menu" aria-hidden="true" />
              </button>
            </header>
          )}

          {/* 데스크톱(lg) 머리: 두 줄 */}
          <header className="wh wh-lg hidden h-auto p-0 lg:block">
            <div className="wh-inner" style={{ height: 64, gap: 16 }}>
              {link({ href: hrefs.home, className: "logo", "aria-label": "PEAKET 홈", children: <Logo /> })}
              {searchBox("desktop")}
              <div className="wh-actions">
                {link({
                  href: hrefs.likes,
                  className: "btn btn-ghost",
                  children: (
                    <>
                      <i className="ic ic-heart" aria-hidden="true" />찜
                    </>
                  ),
                })}
                {link({
                  href: hrefs.myTickets,
                  className: "btn btn-ghost",
                  children: (
                    <>
                      <i className="ic ic-ticket" aria-hidden="true" />마이 티켓
                    </>
                  ),
                })}
                {user ? (
                  <AccountMenu
                    user={user}
                    items={accountItems(hrefs, user)}
                    onNavigate={navigate}
                    onLogout={() => setLogoutOpen(true)}
                    defaultOpen={defaultOpen === "account"}
                    trigger="acct"
                  />
                ) : userPending ? (
                  <span className="skel ml-1 h-8 w-[76px] rounded-full" data-testid="account-pending" aria-hidden="true" />
                ) : (
                  link({ href: hrefs.login, className: "btn btn-outline btn-sm ml-1", children: "로그인" })
                )}
              </div>
            </div>
            <div className="wh-inner" style={{ height: 48, gap: 4 }}>
              <GenrePopover genres={genres} allHref={hrefs.allGenres} renderLink={renderLink} defaultOpen={defaultOpen === "genres"} />
              <span className="vdivider" aria-hidden="true" style={{ height: 16, alignSelf: "center", margin: "0 10px" }} />
              <nav className="wh-nav" aria-label="주 메뉴">
                {mainNav(hrefs).map((n) => (
                  <Fragment key={n.key}>{link({ href: n.href, "aria-current": current === n.key ? "page" : undefined, children: n.label })}</Fragment>
                ))}
              </nav>
            </div>
          </header>

          <MenuSheet
            open={menuOpen}
            onClose={() => setMenuOpen(false)}
            user={user}
            userPending={userPending}
            hrefs={hrefs}
            current={current}
            onLogout={askLogout}
            renderLink={renderLink}
          />
        </>
      )}

      {variant === "focus" && focus && (
        <>
          <header className="fh lg:hidden">
            {link({
              href: focus.closeHref,
              className: "icon-btn",
              "aria-label": focus.closeLabel ?? "닫고 공연 상세로 가기(대기는 유지됩니다)",
              children: <i className="ic ic-close" aria-hidden="true" />,
            })}
            <div className="fh-title">
              <strong>{focus.title}</strong>
              <span>{focus.subtitle}</span>
            </div>
            {focus.hold ? <HoldTimer hold={focus.hold} /> : null}
            {user ? (
              <AccountMenu user={user} items={[]} onNavigate={navigate} onLogout={() => setLogoutOpen(true)} defaultOpen={false} trigger="icon" />
            ) : null}
          </header>
          <header className="fh hidden h-16 p-0 lg:block">
            <div className="wh-inner" style={{ gap: 12 }}>
              {link({
                href: focus.closeHref,
                className: "icon-btn",
                "aria-label": focus.closeLabel ?? "닫고 공연 상세로 가기(대기는 유지됩니다)",
                children: <i className="ic ic-close" aria-hidden="true" />,
              })}
              <span className="logo logo-sm">
                <Logo />
              </span>
              <span className="vdivider" aria-hidden="true" style={{ alignSelf: "center", height: 24 }} />
              <div className="fh-title">
                <strong>{focus.title}</strong>
                <span>{focus.subtitle}</span>
              </div>
              {focus.hold && focus.holdOnDesktop !== false ? <HoldTimer hold={focus.hold} /> : null}
              {user ? (
                <AccountMenu
                  user={user}
                  items={[]}
                  onNavigate={navigate}
                  onLogout={() => setLogoutOpen(true)}
                  defaultOpen={defaultOpen === "account"}
                  trigger="acct"
                  label="계정 메뉴(로그아웃)"
                />
              ) : null}
            </div>
          </header>
        </>
      )}

      {variant === "staff" && (
        <header className="sh md:pr-4 md:pl-6 lg:h-16 lg:pr-6 lg:pl-8">
          {/* 보드 SCR-050·051·061 머리. 폭 360 미만(320 등)에서는 로고 글자를 숨겨 [로그아웃]이 넘치지 않게 한다(낭독은 남긴다) */}
          <span className="logo logo-sm">
            <i className="logo-mark" aria-hidden="true" />
            <span className="max-[360px]:sr-only">PEAKET</span>
          </span>
          <span className="badge badge-solid">현장 스태프</span>
          <span className="grow" />
          {link({
            href: staff?.closeHref ?? hrefs.home,
            className: "icon-btn",
            "aria-label": staff?.closeLabel ?? "닫기",
            children: <i className="ic ic-close" aria-hidden="true" />,
          })}
          {user ? (
            <button className="btn btn-outline btn-sm" type="button" aria-haspopup="dialog" onClick={() => setLogoutOpen(true)}>
              <i className="ic ic-logout" aria-hidden="true" />
              로그아웃
            </button>
          ) : null}
        </header>
      )}

      {variant === "minimal" && (
        <>
          <header className="wh md:pr-4 md:pl-6 lg:hidden">
            {link({ href: hrefs.home, className: "logo", "aria-label": "PEAKET 홈", children: <Logo /> })}
          </header>
          <header className="wh wh-lg hidden lg:flex">
            <div className="wh-inner">{link({ href: hrefs.home, className: "logo", "aria-label": "PEAKET 홈", children: <Logo /> })}</div>
          </header>
        </>
      )}

      {children}

      {showFooter && <WebFooter hrefs={hrefs} businessInfo={businessInfo} renderLink={renderLink} />}
      {bottomBar}

      {updateAvailable && (
        <div className="toast fixed bottom-4 left-1/2 z-[90] -translate-x-1/2" role="status">
          <i className="ic ic-refresh" aria-hidden="true" />
          새 버전이 있습니다
          <button className="btn btn-sm ml-1" type="button" onClick={() => window.location.reload()}>
            새로고침
          </button>
        </div>
      )}

      <LogoutDialog
        open={logoutOpen}
        onClose={() => setLogoutOpen(false)}
        onConfirm={(opts) => {
          setLogoutOpen(false);
          onLogout?.(opts);
        }}
      />
    </div>
  );
}

/** 위쪽 배너 자리의 오프라인 띠(보드 SCR-001 '오프라인'). id는 비활성 버튼의 aria-describedby가 가리킨다 */
export function WebShellOfflineBanner({ lastSync, id = "off-msg" }: { lastSync: string; id?: string }) {
  return (
    <div className="banner banner-offline banner-strip md:px-6 lg:px-8" role="status" id={id}>
      <i className="ic ic-wifi-off" aria-hidden="true" />
      <div className="banner-body">인터넷 연결이 없습니다 · 마지막 동기화 {lastSync}</div>
    </div>
  );
}

function Logo() {
  return (
    <>
      <i className="logo-mark" aria-hidden="true" />
      PEAKET
    </>
  );
}

function HoldTimer({ hold }: { hold: WebShellHold }) {
  const tone = hold.tone && hold.tone !== "normal" ? `is-${hold.tone}` : undefined;
  return (
    <span className={cx("timer", tone)} role="timer" aria-label={hold.ariaLabel}>
      {/* 새 결제 일시 정지 동안은 멈춤 모양(d2 CMP-014 paused, 보드 SCR-011 '결제 일시 정지') */}
      <i className={cx("ic", hold.tone === "paused" ? "ic-pause" : "ic-clock")} aria-hidden="true" />
      {hold.text}
    </span>
  );
}

function mainNav(h: WebShellHrefs): { key: WebNavKey; label: string; href: string }[] {
  return [
    { key: "home", label: "홈", href: h.home },
    { key: "events", label: "공연", href: h.events },
    { key: "upcoming", label: "오픈 예정", href: h.upcoming },
    { key: "shop", label: "굿즈 스토어", href: h.shop },
  ];
}

interface AccountItem {
  label: string;
  href: string;
  icon: string;
}

function accountItems(h: WebShellHrefs, user: WebShellUser): AccountItem[] {
  const items: AccountItem[] = [
    { label: "마이 티켓", href: h.myTickets, icon: "ic-ticket" },
    { label: "예매·주문 내역", href: h.orders, icon: "ic-receipt" },
    { label: "관심 공연·알림", href: h.likes, icon: "ic-heart" },
    { label: "계정 설정", href: h.settings, icon: "ic-settings" },
  ];
  if (user.hasStaffAssignment) items.push({ label: "현장 근무", href: h.staff, icon: "ic-scan" });
  items.push({ label: "고객센터", href: h.help, icon: "ic-help" });
  return items;
}

/** 계정 메뉴(lg 머리·집중 셸). 버튼은 aria-haspopup="menu", 항목은 role="menuitem"(↑↓·Home·End·Esc) */
function AccountMenu({
  user,
  items,
  onNavigate,
  onLogout,
  defaultOpen,
  trigger,
  label,
}: {
  user: WebShellUser;
  items: AccountItem[];
  onNavigate: (href: string) => void;
  onLogout: () => void;
  defaultOpen: boolean;
  trigger: "acct" | "icon";
  label?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = `${useId()}-menu`;
  const avatar = user.avatarText ?? Array.from(user.name)[0] ?? "";
  useOutsidePress([btnRef, menuRef], open, () => setOpen(false));
  useFocusTrap(menuRef, open, () => setOpen(false));

  function onMenuKey(e: ReactKeyboardEvent<HTMLDivElement>) {
    const list = menuRef.current ? focusableIn(menuRef.current) : [];
    const i = list.indexOf(document.activeElement as HTMLElement);
    const move = (n: number) => {
      e.preventDefault();
      list[(n + list.length) % list.length]?.focus();
    };
    if (e.key === "ArrowDown") move(i + 1);
    else if (e.key === "ArrowUp") move(i - 1);
    else if (e.key === "Home") move(0);
    else if (e.key === "End") move(list.length - 1);
    else if (e.key === "Tab") setOpen(false);
  }

  const name = label ?? `계정 메뉴 ${user.name}`;
  return (
    <div className="relative">
      {trigger === "acct" ? (
        <button
          ref={btnRef}
          className="acct"
          type="button"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={open ? menuId : undefined}
          aria-label={name}
          onClick={() => setOpen((v) => !v)}
        >
          <span className="avatar">{avatar}</span>
          {user.name}
          <i className="ic ic-chevron-down" aria-hidden="true" />
        </button>
      ) : (
        <button
          ref={btnRef}
          className="icon-btn"
          type="button"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={open ? menuId : undefined}
          aria-label={label ?? "계정 메뉴(로그아웃)"}
          onClick={() => setOpen((v) => !v)}
        >
          <i className="ic ic-user" aria-hidden="true" />
        </button>
      )}
      {open && (
        <div ref={menuRef} id={menuId} role="menu" aria-label={name} className="menu absolute right-0 top-[calc(100%+6px)] z-40" onKeyDown={onMenuKey}>
          <div className="row" role="none" style={{ gap: 10, padding: "8px 10px 10px" }}>
            <span className="avatar">{avatar}</span>
            <span className="col" style={{ gap: 2 }}>
              <span className="t-sm fw-b">{user.name}</span>
              <span className="t-xs muted">본인확인 {user.verified ? "완료" : "전"}</span>
            </span>
          </div>
          <div className="menu-sep" role="separator" />
          {items.map((it) => (
            <button
              key={it.href + it.label}
              className="menu-item"
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onNavigate(it.href);
              }}
            >
              <i className={cx("ic ic-16", it.icon)} aria-hidden="true" style={{ color: "var(--text-muted)" }} />
              {it.label}
            </button>
          ))}
          {items.length > 0 && <div className="menu-sep" role="separator" />}
          <button
            className="menu-item"
            type="button"
            role="menuitem"
            aria-haspopup="dialog"
            onClick={() => {
              setOpen(false);
              onLogout();
            }}
          >
            <i className="ic ic-16 ic-logout" aria-hidden="true" style={{ color: "var(--text-muted)" }} />
            로그아웃
          </button>
        </div>
      )}
    </div>
  );
}

/** lg 머리의 '전체 장르' 창. 장르마다 검색 장르 필터로, 맨 아래 '전체 장르 보기'는 장르 필터 없는 검색으로 간다(d5 §5.1) */
function GenrePopover({
  genres,
  allHref,
  renderLink,
  defaultOpen,
}: {
  genres: readonly WebShellGenre[];
  allHref: string;
  renderLink?: RenderLink;
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const btnRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const panelId = `${useId()}-genres`;
  useOutsidePress([btnRef, panelRef], open, () => setOpen(false));
  useFocusTrap(panelRef, open, () => setOpen(false));
  return (
    <div className="relative">
      <button
        ref={btnRef}
        className="btn btn-ghost btn-sm"
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        style={{ paddingLeft: 6 }}
        onClick={() => setOpen((v) => !v)}
      >
        <i className="ic ic-menu" aria-hidden="true" />
        전체 장르
      </button>
      {open && (
        <div
          ref={panelRef}
          id={panelId}
          role="dialog"
          aria-label="전체 장르"
          className="popover absolute left-0 top-[calc(100%+6px)] z-40 w-[520px]"
          onClick={(e) => {
            if ((e.target as HTMLElement).closest("a")) setOpen(false);
          }}
        >
          <ul className="grid grid-cols-5 gap-1">
            {genres.map((g) => (
              <li key={g.href}>
                {renderLinkOrAnchor(renderLink, {
                  href: g.href,
                  className: "col items-center gap-1.5 rounded-(--r-md) py-2 text-center text-(--text)",
                  children: (
                    <>
                      <span className="center" aria-hidden="true" style={{ width: 44, height: 44, borderRadius: "var(--r-lg)", background: "var(--surface-muted)", color: "var(--link)" }}>
                        <i className={`ic ic-24 ic-genre-${g.icon}`} />
                      </span>
                      <span className="t-xs fw-m">{g.label}</span>
                    </>
                  ),
                })}
              </li>
            ))}
          </ul>
          <div className="divider" style={{ margin: "8px 0" }} />
          {renderLinkOrAnchor(renderLink, {
            href: allHref,
            className: "link-more",
            children: (
              <>
                전체 장르 보기
                <i className="ic ic-chevron-right" aria-hidden="true" />
              </>
            ),
          })}
        </div>
      )}
    </div>
  );
}

/** 휴대폰·태블릿 메뉴 시트(d5 §3.1 'sm 360 · 메뉴 시트'): 계정 · 주 메뉴 · 내 메뉴 · 고객센터 · 언어 · 로그아웃 */
function MenuSheet({
  open,
  onClose,
  user,
  userPending,
  hrefs,
  current,
  onLogout,
  renderLink,
}: {
  open: boolean;
  onClose: () => void;
  user: WebShellUser | null;
  userPending: boolean;
  hrefs: WebShellHrefs;
  current: WebNavKey | null;
  onLogout: () => void;
  renderLink?: RenderLink;
}) {
  const row = (href: string, label: string, opts?: { icon?: string; current?: boolean }) =>
    renderLinkOrAnchor(renderLink, {
      href,
      className: "li text-(--text)",
      "aria-current": opts?.current ? "page" : undefined,
      children: (
        <>
          {opts?.icon ? <i className={cx("ic", opts.icon)} aria-hidden="true" style={{ color: "var(--text-muted)" }} /> : null}
          <span className={cx("li-title grow", opts?.current && "fw-b")}>{label}</span>
          <i className="ic ic-chevron-right" aria-hidden="true" style={{ color: "var(--text-muted)" }} />
        </>
      ),
    });
  const avatar = user ? (user.avatarText ?? Array.from(user.name)[0] ?? "") : "";
  return (
    <WebShellModal open={open} onClose={onClose} title="메뉴" kind="sheet" closeLabel="메뉴 닫기" scroll>
      <div
        className="col"
        style={{ gap: 16 }}
        onClick={(e) => {
          if ((e.target as HTMLElement).closest("a")) onClose();
        }}
      >
        {user ? (
          <div className="row" style={{ gap: 10 }}>
            <span className="avatar">{avatar}</span>
            <span className="t-md fw-b">{user.name}</span>
            {user.verified ? (
              <span className="badge badge-success">
                <i className="ic ic-check" aria-hidden="true" />
                본인확인 완료
              </span>
            ) : (
              <span className="badge badge-warning">본인확인 전</span>
            )}
          </div>
        ) : userPending ? (
          <span className="skel h-[52px] rounded-[12px]" aria-hidden="true" />
        ) : (
          renderLinkOrAnchor(renderLink, { href: hrefs.login, className: "btn btn-primary btn-lg btn-block", children: "로그인" })
        )}
        <nav aria-label="주 메뉴">
          <ul className="border-t border-(--border)">
            {mainNav(hrefs).map((n) => (
              <li key={n.key}>{row(n.href, n.label, { current: current === n.key })}</li>
            ))}
            <li>{row(hrefs.allGenres, "전체 장르", { icon: "ic-genre-all" })}</li>
          </ul>
        </nav>
        <nav aria-label="내 메뉴">
          <ul className="border-t border-(--border)">
            <li>{row(hrefs.myTickets, "마이 티켓", { icon: "ic-ticket" })}</li>
            <li>{row(hrefs.orders, "예매·주문 내역", { icon: "ic-receipt" })}</li>
            <li>{row(hrefs.likes, "관심 공연·알림(찜)", { icon: "ic-heart" })}</li>
            {user ? <li>{row(hrefs.settings, "계정 설정", { icon: "ic-settings" })}</li> : null}
            {user?.hasStaffAssignment ? <li>{row(hrefs.staff, "현장 근무", { icon: "ic-scan" })}</li> : null}
            <li>{row(hrefs.help, "고객센터", { icon: "ic-help" })}</li>
          </ul>
        </nav>
        <div className="row wrap t-sm" style={{ gap: "4px 12px" }}>
          <i className="ic ic-globe ic-16" aria-hidden="true" />
          <span className="sr-only">언어</span>
          <a href={hrefs.locales.ko} lang="ko" aria-current="true" className="fw-b text-(--text)">
            한국어
          </a>
          <a href={hrefs.locales.en} lang="en">
            English
          </a>
          <a href={hrefs.locales.ja} lang="ja">
            日本語
          </a>
          <a href={hrefs.locales.zh} lang="zh">
            中文
          </a>
        </div>
        {user ? (
          <button className="btn btn-outline btn-block" type="button" aria-haspopup="dialog" onClick={onLogout}>
            <i className="ic ic-logout" aria-hidden="true" />
            로그아웃
          </button>
        ) : null}
      </div>
    </WebShellModal>
  );
}
