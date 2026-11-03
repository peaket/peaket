'use client';
// CMP-065 관제 변형(docs/design/d5 §3.3·§3.9, 디자인 캔버스 키트 20·20b절).
// 데스크톱(lg 1280 이상): 위 상태 바 + 왼쪽 내비 + 본문. 태블릿(768~1279): 위 상태 바(메뉴 버튼) + 메뉴 서랍.
// 휴대폰(768 미만): 두 줄 머리 + 요약 줄 + 아래 탭 막대 + 메뉴 서랍.
// 라우터와 상관없이 그린다. 링크는 renderLink로 앱 라우터의 Link를 넣는다. 값은 모두 props로 받는다(호스트 상태가 넘긴다).
import { Fragment, useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { renderLinkOrAnchor, type RenderLink } from '../../lib/link';
import { cx } from '../../lib/cx';

export type ConsoleLayout = 'desktop' | 'tablet' | 'phone';
export type ConsoleRole = 'viewer' | 'operator' | 'commander' | 'cs_agent' | 'cs_lead';

/** 자동 제어 다섯 값(d5 §3.3). 둘 이상이면 긴급 정지 → 입력 없음 → 일시정지 → 자동 증액 멈춤 순서로 앞의 것을 넘긴다 */
export type ControlStatus =
  | { kind: 'ok' }
  | { kind: 'paused'; remaining: string }
  | { kind: 'raise-stopped' }
  | { kind: 'no-input' }
  | { kind: 'emergency-stop' };

export interface ConsoleNavItem {
  key: string;
  label: string;
  href: string;
  icon: string;
  badge?: { text: string; tone?: 'warning' | 'default' };
}
export interface ConsoleNavGroup {
  /** 첫 묶음은 제목이 없다 */
  title?: string;
  items: ConsoleNavItem[];
}

export interface ConsoleTabItem {
  key: string;
  label: string;
  href: string;
  icon: string;
  badge?: string;
}

export interface ConsoleAccountMenuItem {
  key: string;
  label: string;
  icon: string;
  href?: string;
  onSelect?: () => void;
}

export interface ConsoleShellProps {
  layout: ConsoleLayout;
  /** '운영 환경'(데스크톱) · '운영'(휴대폰) */
  env: { label: string; short: string };
  /** 고른 회차. null이면 '활성 회차 없음' */
  event: { label: string; short: string } | null;
  /** 단계 이름(T=0, 판매 중 …). 없으면 그리지 않는다 */
  stage?: string;
  control?: ControlStatus;
  /** 걸린 자동 조치 수. 0이면 그리지 않는다. needsHuman이면 warning, 아니면 primary */
  autoActions?: { count: number; needsHuman: boolean; href: string };
  alerts: { sev1: number; sev2: number; sev3: number; href: string; note?: string };
  /** viewer는 없다 */
  myApprovals?: { count: number; href: string };
  operators: number;
  /** 'HH:MM:SS KST' 꼴(d5 §3.1·NFR-024) */
  clock: string;
  user: { name: string; initial: string; role: ConsoleRole };
  nav: ConsoleNavGroup[];
  /** 지금 화면의 내비 key */
  currentKey?: string;
  tabs: ConsoleTabItem[];
  currentTabKey?: string;
  accountMenu: ConsoleAccountMenuItem[];
  /** 메뉴 서랍을 열린 채로 시작(퍼블리싱 상태 '메뉴 열림') */
  defaultDrawerOpen?: boolean;
  renderLink?: RenderLink;
  /** 계정 메뉴의 링크를 앱 라우터로 옮길 때(없으면 보통 링크) */
  onNavigate?: (href: string) => void;
  /** 본문 위·아래에 덧붙는 배너(새 버전 안내 등) */
  mainTop?: ReactNode;
  /** 보드마다 다른 본문 간격·여백 */
  mainStyle?: React.CSSProperties;
  children: ReactNode;
}

function controlBadge(c: ControlStatus | undefined) {
  if (!c) return null;
  switch (c.kind) {
    case 'ok':
      return <span className="badge badge-success">자동 제어 정상</span>;
    case 'paused':
      return <span className="badge badge-warning">자동 제어 일시정지 {c.remaining}</span>;
    case 'raise-stopped':
      return <span className="badge badge-warning">자동 제어 자동 증액 멈춤</span>;
    case 'no-input':
      return <span className="badge badge-danger">자동 제어 입력 없음</span>;
    case 'emergency-stop':
      return <span className="badge badge-danger">자동 제어 긴급 정지</span>;
  }
}

export function ConsoleShell(props: ConsoleShellProps) {
  const { layout, renderLink } = props;
  const [drawerOpen, setDrawerOpen] = useState(!!props.defaultDrawerOpen);
  const closeDrawer = useCallback(() => setDrawerOpen(false), []);
  const compact = layout !== 'desktop';
  // 위 상태 바의 경보·자동 조치·승인 묶음도 앱 라우터 링크로 그린다(페이지 전체를 다시 불러오지 않는다). 모양은 클래스로 준다
  const link = (href: string, children: ReactNode, extra?: { className?: string; label?: string; current?: boolean }) => {
    return renderLinkOrAnchor(renderLink, {
      href,
      className: extra?.className,
      'aria-label': extra?.label,
      'aria-current': extra?.current ? 'page' : undefined,
      children,
    });
  };

  const alertsLabel = `경보 패널: SEV1 ${props.alerts.sev1}건, SEV2 ${props.alerts.sev2}건, SEV3 ${props.alerts.sev3}건${props.alerts.note ? `. ${props.alerts.note}` : ''}`;
  const alertBadges = link(
    props.alerts.href,
    <>
      <span className="badge badge-danger">SEV1 {props.alerts.sev1}</span>
      <span className="badge badge-warning">SEV2 {props.alerts.sev2}</span>
      <span className="badge">SEV3 {props.alerts.sev3}</span>
    </>,
    { className: 'row gap-1 text-inherit', label: alertsLabel },
  );
  const auto =
    props.autoActions && props.autoActions.count > 0
      ? link(
          props.autoActions.href,
          <>
            자동 조치 {props.autoActions.count}
            {layout !== 'phone' && props.autoActions.needsHuman ? ' · 사람이 풀 것 포함' : ''}
          </>,
          {
            className: cx('badge', props.autoActions.needsHuman ? 'badge-warning' : 'badge-primary'),
            label: `걸린 자동 조치 ${props.autoActions.count}건${props.autoActions.needsHuman ? ', 사람이 풀 것 포함' : ''}`,
          },
        )
      : null;

  const menuButton = (
    <button className="icon-btn" type="button" aria-label="메뉴 열기" aria-haspopup="dialog" aria-expanded={drawerOpen} onClick={() => setDrawerOpen(true)}>
      <i className="ic ic-menu" aria-hidden="true" />
    </button>
  );
  const eventChip = (
    <button className="chip chip-sm" type="button" aria-haspopup="listbox">
      {props.event ? (layout === 'phone' ? props.event.short : props.event.label) : '활성 회차 없음'}
      <i className="ic ic-chevron-down" aria-hidden="true" />
    </button>
  );

  const bar =
    layout === 'phone' ? (
      <header className="cs-bar">
        {menuButton}
        <span className="badge badge-outline">{props.env.short}</span>
        {eventChip}
        {props.stage ? <span className="badge badge-primary">{props.stage}</span> : null}
        <span className="grow" />
        <AccountMenu user={props.user} items={props.accountMenu} onNavigate={props.onNavigate} compact />
      </header>
    ) : (
      <header className="cs-bar">
        {layout === 'tablet' ? menuButton : null}
        <span className="logo logo-sm">
          <i className="logo-mark" aria-hidden="true" />
          PEAKET
        </span>
        <span className="badge badge-inverse">관제</span>
        <span className="sep" aria-hidden="true" />
        <span className="badge badge-outline">{props.env.label}</span>
        {eventChip}
        {props.stage ? <span className="badge badge-primary">단계 {props.stage}</span> : null}
        {controlBadge(props.control)}
        {auto}
        <span className="sep" aria-hidden="true" />
        {alertBadges}
        <span className="grow" />
        {props.myApprovals
          ? link(
              props.myApprovals.href,
              <>
                <i className="ic ic-stamp ic-16" aria-hidden="true" />
                내 승인 대기 {props.myApprovals.count}
              </>,
              { className: 'row gap-1.5 text-inherit' },
            )
          : null}
        <span className="row" style={{ gap: 6 }}>
          <i className="ic ic-users ic-16" aria-hidden="true" />
          접속 운영자 {props.operators}
        </span>
        <span className="mono">{props.clock}</span>
        <span className="badge badge-outline">{props.user.role}</span>
        <AccountMenu user={props.user} items={props.accountMenu} onNavigate={props.onNavigate} />
      </header>
    );

  const navItems = () =>
    props.nav.map((g, gi) => (
      <Fragment key={g.title ?? `g${gi}`}>
        {g.title ? <span className="cs-navgroup">{g.title}</span> : null}
        {g.items.map((it) => (
          <Fragment key={it.key}>
            {link(
              it.href,
              <>
                <i className={`ic ic-${it.icon}`} aria-hidden="true" />
                {it.label}
                {it.badge ? <span className={cx('badge', it.badge.tone === 'warning' && 'badge-warning')}>{it.badge.text}</span> : null}
              </>,
              { className: 'cs-navitem', current: it.key === props.currentKey },
            )}
          </Fragment>
        ))}
      </Fragment>
    ));

  return (
    <div className={cx('cs', compact && 'cs-compact', layout === 'tablet' && 'is-tab')} style={{ minHeight: '100vh' }}>
      <SkipToMain />
      {bar}
      {layout === 'phone' ? (
        <div className="cs-sum">
          {controlBadge(props.control)}
          {auto}
          {alertBadges}
          <span className="mono" style={{ marginLeft: 'auto' }}>
            {props.clock}
          </span>
        </div>
      ) : null}
      {layout === 'desktop' ? (
        <nav className="cs-nav" aria-label="관제 메뉴">
          {navItems()}
        </nav>
      ) : null}
      <main className="cs-main" id="main" tabIndex={-1} style={props.mainStyle}>
        {props.mainTop}
        {props.children}
      </main>
      {layout === 'phone' ? (
        <nav className="cs-tabbar" aria-label="관제 주요 메뉴">
          {props.tabs.map((t) =>
            t.key === 'menu' ? (
              <a
                key={t.key}
                href={t.href}
                aria-haspopup="dialog"
                onClick={(e) => {
                  e.preventDefault();
                  setDrawerOpen(true);
                }}
              >
                <i className={`ic ic-${t.icon}`} aria-hidden="true" />
                {t.label}
              </a>
            ) : (
              <Fragment key={t.key}>
                {link(
                  t.href,
                  <>
                    <i className={`ic ic-${t.icon}`} aria-hidden="true" />
                    {t.label}
                    {t.badge ? <span className="badge badge-warning">{t.badge}</span> : null}
                  </>,
                  { current: t.key === props.currentTabKey },
                )}
              </Fragment>
            ),
          )}
        </nav>
      ) : null}
      {compact && drawerOpen ? (
        <Drawer onClose={closeDrawer} accountMenu={props.accountMenu} renderLink={renderLink}>
          {navItems()}
        </Drawer>
      ) : null}
    </div>
  );
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** 메뉴 서랍(키트 20b절 .scrim.left > .drawer). 초점을 가두고 Esc·바깥 누름으로 닫는다 */
function Drawer({
  onClose,
  children,
  accountMenu,
  renderLink,
}: {
  onClose: () => void;
  children: ReactNode;
  accountMenu: ConsoleAccountMenuItem[];
  renderLink?: RenderLink;
}) {
  const ref = useRef<HTMLElement>(null);
  // 닫기 함수는 ref로 읽는다. 부모가 다시 그려 함수가 바뀌어도 초점 가두기 효과는 열 때 한 번만 돈다(Dialog·useFocusTrap과 같은 방식)
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeRef.current();
      if (e.key === 'Tab' && ref.current) {
        const els = Array.from(ref.current.querySelectorAll<HTMLElement>(FOCUSABLE));
        if (els.length === 0) return;
        const first = els[0]!;
        const last = els[els.length - 1]!;
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      prev?.focus();
    };
  }, []);
  const logout = accountMenu.find((m) => m.key === 'logout');
  return (
    <div
      className="scrim left"
      style={{ position: 'fixed' }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <nav className="drawer" aria-label="관제 메뉴" role="dialog" aria-modal="true" ref={ref}>
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
        <div
          className="col"
          style={{ gap: 1 }}
          onClick={(e) => {
            if ((e.target as HTMLElement).closest('a')) onClose();
          }}
        >
          {children}
        </div>
        {logout ? (
          logout.href ? (
            renderLinkOrAnchor(renderLink, {
              href: logout.href,
              className: 'btn btn-outline',
              children: (
                <>
                  <i className="ic ic-logout" aria-hidden="true" />
                  {logout.label}
                </>
              ),
            })
          ) : (
            <button className="btn btn-outline" type="button" style={{ marginTop: 'auto' }} onClick={logout.onSelect}>
              <i className="ic ic-logout" aria-hidden="true" />
              {logout.label}
            </button>
          )
        ) : null}
      </nav>
    </div>
  );
}

/** 계정 메뉴(내 계정 · 단축키 안내 · 로그아웃). 휴대폰은 이름 대신 역할 배지를 단추 안에 둔다 */
function AccountMenu({
  user,
  items,
  onNavigate,
  compact,
}: {
  user: ConsoleShellProps['user'];
  items: ConsoleAccountMenuItem[];
  onNavigate?: (href: string) => void;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const wrap = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    wrap.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const onDown = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        wrap.current?.querySelector<HTMLElement>('button.acct')?.focus();
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const els = Array.from(wrap.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
        const i = els.indexOf(document.activeElement as HTMLElement);
        const next = e.key === 'ArrowDown' ? (i + 1) % els.length : (i - 1 + els.length) % els.length;
        els[next]?.focus();
        e.preventDefault();
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return (
    <span ref={wrap} style={{ position: 'relative', display: 'inline-flex', marginLeft: compact ? 'auto' : undefined }}>
      <button
        className="acct"
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-label={compact ? `계정 메뉴: ${user.name} ${user.role}(내 계정·로그아웃)` : '계정 메뉴(내 계정·로그아웃)'}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="avatar">{user.initial}</span>
        {compact ? (
          <span className="badge badge-outline">{user.role}</span>
        ) : (
          <>
            {user.name}
            <i className="ic ic-chevron-down" aria-hidden="true" />
          </>
        )}
      </button>
      {open ? (
        <div className="menu" role="menu" id={id} aria-label="계정 메뉴" style={{ position: 'absolute', right: 0, top: 'calc(100% + 6px)', zIndex: 120 }}>
          {items.map((m) =>
            m.href ? (
              <a
                key={m.key}
                className="menu-item"
                role="menuitem"
                tabIndex={-1}
                href={m.href}
                onClick={(e) => {
                  setOpen(false);
                  if (onNavigate) {
                    e.preventDefault();
                    onNavigate(m.href!);
                  }
                }}
              >
                <i className={`ic ic-${m.icon}`} aria-hidden="true" />
                {m.label}
              </a>
            ) : (
              <button
                key={m.key}
                className="menu-item"
                role="menuitem"
                type="button"
                tabIndex={-1}
                onClick={() => {
                  setOpen(false);
                  m.onSelect?.();
                }}
              >
                <i className={`ic ic-${m.icon}`} aria-hidden="true" />
                {m.label}
              </button>
            ),
          )}
        </div>
      ) : null}
    </span>
  );
}

/** 본문 바로가기(보드의 sr-only 링크). 초점을 받으면 보이게 한다(WCAG 2.4.1·2.4.7) */
function SkipToMain() {
  const [shown, setShown] = useState(false);
  return (
    <a
      className={shown ? 'btn btn-primary btn-sm' : 'sr-only'}
      href="#main"
      style={shown ? { position: 'absolute', left: 8, top: 8, zIndex: 200 } : undefined}
      onFocus={() => setShown(true)}
      onBlur={() => setShown(false)}
    >
      본문 바로가기
    </a>
  );
}
