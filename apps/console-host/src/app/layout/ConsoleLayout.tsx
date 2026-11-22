// 관제 셸 경로(CMP-065 console). 위 상태 바·역할별 내비·탭 막대는 호스트 상태(useHost)에서 그리고, 화면은 <Outlet />에 늦게 싣는다.
// 화면 덩어리를 받지 못해도 셸은 그대로 두고 그 자리만 오류 카드로 바꾼다(router.tsx의 ScreenError, d5 §3.3).
import { useEffect, useRef, useState } from 'react';
import { Outlet, useLocation, useNavigate, useNavigation, useSearchParams } from 'react-router';
import { ConsoleShell } from '@peaket/ds/ConsoleShell';
import { MY_APPROVALS_HREF } from '@/entities/command';
import { isDesignationChoice, isRole } from '@/entities/operator';
import { navFor, navKeyFor, tabKeyFor, tabsFor } from '@/shared/config/nav';
import { useLayout } from '@/shared/lib/layout';
import { useBodyTheme, useResolvedTheme, useUiPrefs } from '@/shared/lib/theme';
import { useHost, useHostStore } from '@/features/preview-host';
import { useShellUi } from '@/shared/model/shell';
import { renderRouterLink } from '@/shared/ui/RouterLink';
import { opsApiAvailable } from '@/shared/api';
import { startLive } from '@/shared/api/live';
import { preloadScreen, scheduleDashboardPreload } from '@/shared/lib/preload';
import { ShortcutsDialog } from './ShortcutsDialog';

export function ConsoleLayout() {
  const layout = useLayout();
  const [params] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const navigation = useNavigation();
  const theme = useResolvedTheme(layout, params.get('theme'));
  useBodyTheme(theme);

  // ?role=로 역할을 바꿔 본다(이동해도 남는다)
  const setRole = useHostStore((s) => s.setRole);
  const roleParam = params.get('role');
  useEffect(() => {
    if (isRole(roleParam)) setRole(roleParam);
  }, [roleParam, setRole]);
  // ?designation=으로 지정을 바꿔 본다(이동해도 남는다, add-fraud-investigation-screens design.md 결정 3)
  const setDesignation = useHostStore((s) => s.setDesignation);
  const designationParam = params.get('designation');
  useEffect(() => {
    if (isDesignationChoice(designationParam)) setDesignation(designationParam);
  }, [designationParam, setDesignation]);

  // 탭마다 늘 여는 흐름 하나와 위젯 흐름 하나(ADR-0100 결정 1, ADR-0360). ?state= 미리보기와 관제 API 주소가 없는 빌드에서는 열지 않는다.
  // 한 번 열면 화면을 옮겨도 닫지 않는다(탭을 숨겨도 닫지 않는다, frontend §4.4.4). 토큰 갱신이 401이면 로그인 화면으로 간다
  const previewState = __PREVIEW__ && params.get('state') !== null;
  useEffect(() => {
    if (previewState || !opsApiAvailable()) return;
    startLive({ origin: __OPS_API_ORIGIN__, onUnauthorized: () => navigate('/login') });
  }, [previewState, navigate]);

  // 대시보드를 처음 그린 뒤 2초 [가정]에 명령 화면 덩어리(낮은 우선순위), 그다음 원격을 같은 무결성 적재기로 미리 싣는다(ADR-0091 결정 1).
  // 경로 lazy가 다 풀려야 navigation이 idle이라 그때 대시보드가 그려져 있다
  const onDashboard = location.pathname === '/dashboard' && navigation.state === 'idle';
  useEffect(() => {
    if (!onDashboard) return undefined;
    return scheduleDashboardPreload({ live: !previewState && opsApiAvailable() });
  }, [onDashboard, previewState]);
  // 메뉴 항목에 포인터가 올라가거나 초점이 가면 그 화면 lazy를 미리 부른다(같은 출처 화면 주소만)
  useEffect(() => {
    const onIntent = (e: Event) => {
      const a = (e.target as Element | null)?.closest?.('nav a[href]');
      const href = a?.getAttribute('href');
      if (href && href.startsWith('/')) preloadScreen(href);
    };
    document.addEventListener('pointerover', onIntent);
    document.addEventListener('focusin', onIntent);
    return () => {
      document.removeEventListener('pointerover', onIntent);
      document.removeEventListener('focusin', onIntent);
    };
  }, []);

  const host = useHost();
  const mainStyle = useShellUi((s) => s.mainStyle);
  const singleKey = useUiPrefs((s) => s.singleKey);
  const [shortcuts, setShortcuts] = useState(false);

  // 한 글자 단축키 '?'(켰을 때만, 입력 칸에 초점이 없을 때만, WCAG 2.1.4)
  useEffect(() => {
    if (!singleKey) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.closest('input, select, textarea, [contenteditable="true"]') || t.isContentEditable)) return;
      if (e.key === '?' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        setShortcuts(true);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [singleKey]);

  // 경로가 바뀌면 새 화면의 h1로 초점을 옮기고 맨 위로 올린다(docs/frontend.md §2.7)
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (location.hash) return;
    window.scrollTo(0, 0);
    const h1 = document.querySelector<HTMLElement>('main h1');
    if (h1) {
      if (!h1.hasAttribute('tabindex')) h1.setAttribute('tabindex', '-1');
      h1.focus({ preventScroll: true });
    }
  }, [location.pathname, location.hash]);

  const role = host.session.role;

  return (
    <>
      <ConsoleShell
        // '메뉴 열림' 상태로 옮기면 서랍을 연 채로 다시 그린다(퍼블리싱 상태)
        key={params.get('state') === '메뉴 열림' ? `${layout}-menu` : layout}
        layout={layout}
        env={host.env}
        event={host.scope.event}
        stage={host.scope.stage}
        control={host.control ?? undefined}
        autoActions={
          host.autoActions.count > 0
            ? { ...host.autoActions, href: location.pathname === '/dashboard' ? '#w-auto' : '/dashboard?tab=live#w-auto' }
            : undefined
        }
        alerts={{ ...host.alerts, href: '/dashboard#w-alert' }}
        // 보드처럼 0건이어도 늘 보인다(SCR-066·045 '내 승인 대기 0'). viewer는 승인할 수 없어 숨긴다(보드 SCR-029 viewer)
        myApprovals={
          role === 'viewer'
            ? undefined
            : // CS 역할은 명령 화면이 없어 승인 업무(SCR-046)로 보낸다
              { count: host.commands.myApprovals, href: role === 'cs_agent' || role === 'cs_lead' ? '/cs/approvals' : MY_APPROVALS_HREF }
        }
        operators={host.presence.operators}
        clock={host.clock}
        user={{ name: host.session.name, initial: host.session.initial, role }}
        nav={navFor(role, host.session.designations)}
        currentKey={navKeyFor(location.pathname)}
        tabs={tabsFor(role, role === 'viewer' ? 0 : host.commands.myApprovals)}
        currentTabKey={tabKeyFor(location.pathname, location.hash)}
        accountMenu={[
          { key: 'me', label: '내 계정', icon: 'user', href: '/me' },
          { key: 'shortcuts', label: '단축키 안내', icon: 'help', onSelect: () => setShortcuts(true) },
          { key: 'logout', label: '로그아웃', icon: 'logout', href: '/login' },
        ]}
        defaultDrawerOpen={params.get('state') === '메뉴 열림'}
        renderLink={renderRouterLink}
        onNavigate={(href) => navigate(href)}
        mainStyle={mainStyle}
        mainTop={
          navigation.state === 'loading' ? (
            <p className="t-xs muted" role="status" aria-live="polite">
              화면을 불러오는 중입니다…
            </p>
          ) : null
        }
      >
        <Outlet />
      </ConsoleShell>
      {shortcuts ? <ShortcutsDialog singleKey={singleKey} onClose={() => setShortcuts(false)} /> : null}
    </>
  );
}
