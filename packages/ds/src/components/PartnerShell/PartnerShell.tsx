'use client';
// CMP-065 AppShell 파트너 변형(d5 §3.2·§3.9, 캔버스 키트 19·20b절). 머리·왼쪽 내비·메뉴 서랍·알림함·계정 메뉴·유휴 잠금 대화상자·긴급 공지 팝업을 그린다.
// 화면 본문은 그리지 않는다(children). 배치: 데스크톱 lg 1280부터 왼쪽 내비 240px, 그 아래(태블릿 768~1279·휴대폰 768 미만)는
// 키트 20b절 .ps-compact와 같은 값을 Tailwind 반응형 유틸로 준다(한 페이지 반응형, kit.css는 고치지 않는다).
// 휴대폰은 대화상자 대신 아래 시트로 연다(보드 SCR-020-m·062-m).
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { renderLinkOrAnchor, type RenderLink } from "../../lib/link";
import { useFocusTrap } from "./focus-trap";

export type PartnerRole = "partner_admin" | "partner_member";
export type PartnerNavKey = "events" | "products" | "account" | "seller" | "payout" | "webhooks";

export const PARTNER_ROLE_LABEL: Record<PartnerRole, string> = {
  partner_admin: "파트너 관리자",
  partner_member: "파트너 실무자",
};

export interface PartnerShellNotification {
  id: string;
  title: string;
  /** 보낸 곳·시각(KST) */
  meta: string;
  href?: string;
  tone?: "danger" | "warning" | "info" | "success";
  unread?: boolean;
}

export interface PartnerShellUrgentNotice {
  title: string;
  body: string;
  /** 'PEAKET 운영자 · 10/14(수) 19:42 KST' */
  meta: string;
}

export interface PartnerShellProps {
  orgName: string;
  /** 표시 이름(예: '파트너 담당자') */
  userName: string;
  /** 머리의 동그란 글자(예: '스') */
  avatarText: string;
  role: PartnerRole;
  /** 지금 내비 항목. 없으면(팀 계정 등) 아무것도 고르지 않는다 */
  current?: PartnerNavKey | null;
  hrefs: Record<PartnerNavKey, string> & { home: string; logout: string; inbox: string };
  notifications: readonly PartnerShellNotification[];
  /** ?theme=dark */
  dark?: boolean;
  /** xl 1440 고밀도(.ps-xl: 본문 최대 폭을 푼다) */
  wide?: boolean;
  /** 처음부터 메뉴 서랍을 연 채로(상태 '메뉴 열림') */
  defaultMenuOpen?: boolean;
  /** 유휴 잠금 대화상자(상태 '유휴 만료 2분 전 경고'·'유휴 만료') */
  idle?: "warning" | "expired" | null;
  /** 유휴 만료 뒤 돌아갈 화면 이름 */
  idleReturnName?: string;
  /** 긴급 공지 팝업(POL-022) */
  urgentNotice?: PartnerShellUrgentNotice | null;
  renderLink?: RenderLink;
  children: ReactNode;
}

const NAV: readonly { key: PartnerNavKey; label: string; icon: string; group: "main" | "settings" }[] = [
  { key: "events", label: "공연 관리", icon: "ic-ticket", group: "main" },
  { key: "products", label: "상품", icon: "ic-box", group: "main" },
  { key: "account", label: "내 계정", icon: "ic-user", group: "settings" },
  { key: "seller", label: "판매자 정보", icon: "ic-building", group: "settings" },
  { key: "payout", label: "정산 계좌", icon: "ic-bank", group: "settings" },
  { key: "webhooks", label: "웹훅", icon: "ic-link", group: "settings" },
];

// 휴대폰(md 미만)은 아래 시트, 그 위는 가운데 대화상자(키트 14절 .dialog·.sheet와 같은 값)
const SCRIM_RESPONSIVE = "max-md:items-end max-md:p-0";
const SHEET_ON_MOBILE =
  "max-md:max-w-none max-md:rounded-b-none max-md:rounded-t-[var(--r-xl)] max-md:gap-[14px] max-md:px-5 max-md:pb-6";

export function PartnerShell({
  orgName,
  userName,
  avatarText,
  role,
  current,
  hrefs,
  notifications,
  dark = false,
  wide = false,
  defaultMenuOpen = false,
  idle = null,
  idleReturnName,
  urgentNotice = null,
  renderLink,
  children,
}: PartnerShellProps) {
  const [menuOpen, setMenuOpen] = useState(defaultMenuOpen);
  const [popup, setPopup] = useState<"inbox" | "account" | null>(null);
  const [idleState, setIdleState] = useState(idle);
  const [urgentOpen, setUrgentOpen] = useState(urgentNotice !== null);
  const roleLabel = PARTNER_ROLE_LABEL[role];
  const unread = notifications.filter((n) => n.unread).length;
  const ids = useId();

  const navLinks = (onPick?: () => void) => (
    <>
      {NAV.filter((n) => n.group === "main").map((n) => navItem(n, onPick))}
      <span className="ps-navgroup">설정</span>
      {NAV.filter((n) => n.group === "settings").map((n) => navItem(n, onPick))}
    </>
  );
  function navItem(n: (typeof NAV)[number], onPick?: () => void) {
    return (
      <span key={n.key} className="contents" onClick={onPick}>
        {renderLinkOrAnchor(renderLink, {
          href: hrefs[n.key],
          className: "ps-navitem",
          "aria-current": current === n.key ? "page" : undefined,
          children: (
            <>
              <i className={`ic ${n.icon}`} aria-hidden="true" />
              {n.label}
            </>
          ),
        })}
      </span>
    );
  }

  return (
    <div
      className={[
        "pk ps min-h-dvh",
        dark ? "dark" : "",
        wide ? "ps-xl" : "",
        // 키트 20b절 .ps.ps-compact(태블릿·휴대폰)
        "max-lg:grid-cols-[minmax(0,1fr)] max-lg:grid-rows-[auto_1fr]",
        "max-lg:[&_.page-head_h1]:text-[22px] max-lg:[&_.page-head_h1]:leading-[30px]",
        "max-md:[&_.page-head_h1]:text-[20px] max-md:[&_.page-head_h1]:leading-[28px]",
      ].join(" ")}
    >
      <a
        className="sr-only focus:not-sr-only focus:!absolute focus:!left-2 focus:!top-2 focus:!z-[300] focus:!rounded-[var(--r-md)] focus:!bg-[var(--surface-raised)] focus:!p-2"
        href="#main"
      >
        본문 바로가기
      </a>
      <header className="ps-top relative max-lg:min-h-14 max-lg:gap-1 max-lg:pl-1 max-lg:pr-2">
        <button
          className="icon-btn lg:hidden"
          type="button"
          aria-label="메뉴 열기"
          aria-haspopup="dialog"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen(true)}
        >
          <i className="ic ic-menu" aria-hidden="true" />
        </button>
        {renderLinkOrAnchor(renderLink, {
          href: hrefs.home,
          className: "logo logo-sm",
          "aria-label": "PEAKET 파트너 홈",
          children: (
            <>
              <i className="logo-mark" aria-hidden="true" />
              PEAKET
            </>
          ),
        })}
        <span className="badge badge-primary">파트너</span>
        <span className="ps-org max-md:hidden max-lg:ml-0.5 max-lg:pl-2.5 max-lg:text-[13px]">
          <i className="ic ic-building ic-16" aria-hidden="true" />
          {orgName}
        </span>
        <span className="grow" />
        <button
          className="icon-btn"
          type="button"
          aria-label={unread > 0 ? `알림함 ${unread}건` : "알림함"}
          aria-haspopup="dialog"
          aria-expanded={popup === "inbox"}
          aria-controls={`${ids}-inbox`}
          data-popup-toggle=""
          onClick={() => setPopup((p) => (p === "inbox" ? null : "inbox"))}
        >
          <i className="ic ic-bell" aria-hidden="true" />
          {unread > 0 && <span className="count-dot">{unread}</span>}
        </button>
        <button
          className="acct max-md:hidden"
          type="button"
          aria-haspopup="dialog"
          aria-expanded={popup === "account"}
          aria-controls={`${ids}-acct`}
          aria-label="계정 메뉴(내 계정·로그아웃)"
          data-popup-toggle=""
          onClick={() => setPopup((p) => (p === "account" ? null : "account"))}
        >
          <span className="avatar">{avatarText}</span>
          {roleLabel}
          <i className="ic ic-chevron-down" aria-hidden="true" />
        </button>
        <button
          className="icon-btn md:hidden"
          type="button"
          aria-haspopup="dialog"
          aria-expanded={popup === "account"}
          aria-controls={`${ids}-acct`}
          aria-label="계정 메뉴(내 계정·로그아웃)"
          data-popup-toggle=""
          onClick={() => setPopup((p) => (p === "account" ? null : "account"))}
        >
          <span className="avatar" style={{ width: 28, height: 28 }}>
            {avatarText}
          </span>
        </button>

        {popup === "inbox" && (
          <Popover id={`${ids}-inbox`} label="알림함" onClose={() => setPopup(null)} width={360}>
            <div className="row between" style={{ padding: "2px 4px 8px" }}>
              <h2 className="t-md fw-b">알림함</h2>
              <span className="t-xs muted">{unread > 0 ? `읽지 않은 알림 ${unread}건` : "모두 읽었습니다"}</span>
            </div>
            <ul className="col" style={{ gap: 2 }}>
              {notifications.map((n) => (
                <li key={n.id}>
                  {renderLinkOrAnchor(renderLink, {
                    href: n.href ?? hrefs.inbox,
                    className: "menu-item",
                    children: (
                      <span className="col" style={{ gap: 2, padding: "8px 0", alignItems: "flex-start" }}>
                        <span className="row" style={{ gap: 6 }}>
                          {n.unread && <span className="sr-only">읽지 않음</span>}
                          {n.unread && (
                            <span
                              aria-hidden="true"
                              style={{ width: 6, height: 6, borderRadius: 3, background: "var(--danger)", flex: "none" }}
                            />
                          )}
                          <span className={n.unread ? "t-sm fw-b" : "t-sm"}>{n.title}</span>
                        </span>
                        <span className="t-xs muted">{n.meta}</span>
                      </span>
                    ),
                  })}
                </li>
              ))}
            </ul>
          </Popover>
        )}
        {popup === "account" && (
          <Popover id={`${ids}-acct`} label="계정 메뉴" onClose={() => setPopup(null)} width={240} variant="menu">
            <div className="col" style={{ gap: 6, padding: "6px 10px 10px" }}>
              <span className="t-sm fw-b">{userName}</span>
              <span>
                <span className={role === "partner_admin" ? "badge badge-primary" : "badge"}>{roleLabel}</span>
              </span>
              <span className="t-xs muted">{orgName}</span>
            </div>
            <div className="menu-sep" />
            {renderLinkOrAnchor(renderLink, {
              href: hrefs.account,
              className: "menu-item",
              children: (
                <>
                  <i className="ic ic-user ic-16" aria-hidden="true" />내 계정
                </>
              ),
            })}
            {renderLinkOrAnchor(renderLink, {
              href: hrefs.logout,
              className: "menu-item",
              children: (
                <>
                  <i className="ic ic-logout ic-16" aria-hidden="true" />
                  로그아웃
                </>
              ),
            })}
          </Popover>
        )}
      </header>

      <nav className="ps-nav max-lg:hidden" aria-label="파트너 메뉴">
        {navLinks()}
      </nav>

      <main
        className="ps-main max-lg:gap-5 max-lg:px-6 max-lg:pb-12 max-lg:pt-5 max-md:gap-4 max-md:px-4 max-md:pb-10 max-md:pt-4"
        id="main"
        tabIndex={-1}
      >
        <div className="ps-body max-lg:max-w-none max-lg:gap-4">{children}</div>
      </main>

      {menuOpen && (
        <Drawer orgName={orgName} onClose={() => setMenuOpen(false)} logout={hrefs.logout} renderLink={renderLink}>
          {navLinks(() => setMenuOpen(false))}
        </Drawer>
      )}

      {urgentNotice && urgentOpen && (
        <Overlay role="alertdialog" labelId={`${ids}-ug-t`} descId={`${ids}-ug-d`} onClose={() => setUrgentOpen(false)} maxWidth={480}>
          <div className="row wrap" style={{ gap: 8 }}>
            <span className="badge badge-danger">
              <i className="ic ic-megaphone" aria-hidden="true" />
              긴급 공지
            </span>
            <span className="t-xs muted">{urgentNotice.meta}</span>
          </div>
          <h2 className="dialog-title" id={`${ids}-ug-t`}>
            {urgentNotice.title}
          </h2>
          <div className="banner banner-danger" id={`${ids}-ug-d`}>
            <i className="ic ic-alert-circle" aria-hidden="true" />
            <div className="banner-body">{urgentNotice.body}</div>
          </div>
          <p className="t-xs muted">같은 공지를 등록한 이메일로도 보냈습니다. 확인한 뒤에도 알림함에 남습니다.</p>
          <div className="dialog-actions max-md:flex-col-reverse max-md:[&>*]:w-full">
            {renderLinkOrAnchor(renderLink, { href: hrefs.inbox, className: "btn btn-ghost", children: "알림함에서 보기" })}
            <button className="btn btn-primary" type="button" data-autofocus onClick={() => setUrgentOpen(false)}>
              공지를 확인했습니다
            </button>
          </div>
        </Overlay>
      )}

      {idleState === "warning" && (
        <Overlay role="alertdialog" labelId={`${ids}-idle-t`} descId={`${ids}-idle-d`} maxWidth={420}>
          <span className="state-icon is-warning" style={{ width: 52, height: 52 }}>
            <i className="ic ic-clock" aria-hidden="true" />
          </span>
          <h2 className="dialog-title" id={`${ids}-idle-t`}>
            2분 뒤 자동으로 잠깁니다
          </h2>
          <p className="t-sm" id={`${ids}-idle-d`}>
            1시간 동안 동작이 없으면 보안을 위해 세션이 끝납니다. 계속 쓰려면 아래 버튼을 누르세요. 잠긴 뒤에는 비밀번호와 인증 앱 코드로 다시
            로그인하면 이 화면으로 돌아옵니다.
          </p>
          <p className="t-xs muted">계속 사용해도 로그인은 처음 로그인한 때부터 최대 24시간까지만 유지됩니다.</p>
          <div className="dialog-actions">
            <button className="btn btn-primary btn-block" type="button" data-autofocus onClick={() => setIdleState(null)}>
              계속 사용
            </button>
          </div>
        </Overlay>
      )}

      {idleState === "expired" && (
        <Overlay role="dialog" labelId={`${ids}-ie-t`} descId={`${ids}-ie-d`} maxWidth={440}>
          <div className="row" style={{ gap: 12 }}>
            <span className="state-icon is-warning" style={{ width: 44, height: 44 }}>
              <i className="ic ic-lock" aria-hidden="true" />
            </span>
            <h2 className="dialog-title" id={`${ids}-ie-t`}>
              세션이 끝났습니다
            </h2>
          </div>
          <p className="t-sm" id={`${ids}-ie-d`}>
            1시간 동안 동작이 없어 보안을 위해 세션을 끝냈습니다. 비밀번호와 인증 앱 코드로 다시 로그인하면 보던 화면({idleReturnName ?? "이 화면"})으로
            돌아갑니다.
          </p>
          <IdleReloginForm idPrefix={ids} logoutHref={hrefs.logout} renderLink={renderLink} onDone={() => setIdleState(null)} />
        </Overlay>
      )}
    </div>
  );
}

function IdleReloginForm({
  idPrefix,
  logoutHref,
  renderLink,
  onDone,
}: {
  idPrefix: string;
  logoutHref: string;
  renderLink?: RenderLink;
  onDone: () => void;
}) {
  const [show, setShow] = useState(false);
  return (
    <form
      className="col"
      style={{ gap: 16 }}
      aria-label="유휴 만료 뒤 다시 로그인"
      onSubmit={(e) => {
        e.preventDefault();
        onDone();
      }}
    >
      <div className="field">
        <label className="label" htmlFor={`${idPrefix}-ie-pw`}>
          비밀번호
        </label>
        <div className="input-group">
          <input id={`${idPrefix}-ie-pw`} type={show ? "text" : "password"} autoComplete="current-password" data-autofocus />
          <button
            className="icon-btn icon-btn-sm"
            type="button"
            aria-label="비밀번호 보기"
            aria-pressed={show}
            aria-controls={`${idPrefix}-ie-pw`}
            onClick={() => setShow((v) => !v)}
          >
            <i className={show ? "ic ic-eye-off" : "ic ic-eye"} aria-hidden="true" />
          </button>
        </div>
      </div>
      <div className="field">
        <label className="label" htmlFor={`${idPrefix}-ie-otp`}>
          인증 앱의 6자리 코드
        </label>
        <input
          className="otp-input"
          id={`${idPrefix}-ie-otp`}
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          pattern="[0-9]*"
        />
      </div>
      <div className="dialog-actions max-md:flex-col-reverse max-md:[&>*]:w-full">
        {renderLinkOrAnchor(renderLink, { href: logoutHref, className: "btn btn-outline", children: "로그아웃" })}
        <button className="btn btn-primary" type="submit">
          다시 로그인
        </button>
      </div>
    </form>
  );
}

function Overlay({
  role,
  labelId,
  descId,
  onClose,
  maxWidth,
  children,
}: {
  role: "dialog" | "alertdialog";
  labelId: string;
  descId: string;
  onClose?: () => void;
  maxWidth: number;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref, true, onClose);
  return (
    <div className={`scrim ${SCRIM_RESPONSIVE}`} style={{ position: "fixed", zIndex: 200 }}>
      <div
        ref={ref}
        className={`dialog ${SHEET_ON_MOBILE}`}
        role={role}
        aria-modal="true"
        aria-labelledby={labelId}
        aria-describedby={descId}
        style={{ maxWidth }}
      >
        {children}
      </div>
    </div>
  );
}

function Drawer({
  orgName,
  logout,
  onClose,
  renderLink,
  children,
}: {
  orgName: string;
  logout: string;
  onClose: () => void;
  renderLink?: RenderLink;
  children: ReactNode;
}) {
  const ref = useRef<HTMLElement>(null);
  useFocusTrap(ref, true, onClose);
  return (
    <div
      className="scrim left lg:hidden"
      style={{ position: "fixed", zIndex: 200 }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <nav ref={ref} className="drawer" aria-label="파트너 메뉴" role="dialog" aria-modal="true">
        <div className="drawer-head">
          <span className="logo logo-sm">
            <i className="logo-mark" aria-hidden="true" />
            PEAKET
          </span>
          <span className="grow" />
          <button className="icon-btn" type="button" aria-label="메뉴 닫기" onClick={onClose}>
            <i className="ic ic-close" aria-hidden="true" />
          </button>
        </div>
        <p className="row t-sm fw-b" style={{ gap: 8, padding: "2px 12px 10px" }}>
          <i className="ic ic-building ic-16" aria-hidden="true" />
          {orgName}
        </p>
        {children}
        <span style={{ marginTop: "auto" }} className="col">
          {renderLinkOrAnchor(renderLink, {
            href: logout,
            className: "btn btn-outline",
            children: (
              <>
                <i className="ic ic-logout" aria-hidden="true" />
                로그아웃
              </>
            ),
          })}
        </span>
      </nav>
    </div>
  );
}

function Popover({
  id,
  label,
  onClose,
  width,
  variant = "popover",
  children,
}: {
  id: string;
  label: string;
  onClose: () => void;
  width: number;
  /** 모양만 키트 .menu(계정 메뉴). 링크 목록이라 역할은 둘 다 대화상자로 둔다 */
  variant?: "popover" | "menu";
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref, true, onClose);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    function onDown(e: PointerEvent) {
      const t = e.target as Element | null;
      if (!t || ref.current?.contains(t) || t.closest("[data-popup-toggle]")) return;
      onCloseRef.current();
    }
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, []);
  return (
    <div
      ref={ref}
      id={id}
      className={variant}
      role="dialog"
      aria-label={label}
      style={{ position: "absolute", top: "calc(100% + 4px)", right: 8, width, maxWidth: "calc(100vw - 16px)", zIndex: 150 }}
    >
      {children}
    </div>
  );
}
