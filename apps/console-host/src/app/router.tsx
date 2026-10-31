// 관제 경로 표(d5 §2 인벤토리, docs/frontend.md §2.5·§5.7). 화면마다 경로 lazy로 따로 싣는다(ADR-0091 결정 1).
// 화면 구현은 src/pages/<화면 폴더>/index.ts의 Page(또는 이름 붙은 내보내기)다. 다음 담당은 이 표를 고치지 않고 그 폴더만 바꾼다.
import { createBrowserRouter, Navigate, type RouteObject } from 'react-router';
import { ConsoleLayout } from './layout/ConsoleLayout';
import { RootError, ScreenError } from './RouteError';

const shellScreens: RouteObject[] = [
  // SCR-028 내 계정
  { path: 'me', lazy: () => import(/* webpackChunkName: "scr-028" */ '@/pages/login').then((m) => ({ Component: m.MePage })) },
  // SCR-029 중앙 관제 대시보드(?event=&tab=)
  { path: 'dashboard', lazy: () => import(/* webpackChunkName: "scr-029" */ '@/pages/dashboard').then((m) => ({ Component: m.Page })) },
  // SCR-030 운영 명령
  { path: 'commands', lazy: () => import(/* webpackChunkName: "scr-030" */ '@/pages/commands').then((m) => ({ Component: m.Page })) },
  // SCR-031 감사 로그·리플레이
  { path: 'audit', lazy: () => import(/* webpackChunkName: "scr-031" */ '@/pages/audit').then((m) => ({ Component: m.Page })) },
  // SCR-032 법정 조치
  { path: 'compliance', lazy: () => import(/* webpackChunkName: "scr-032" */ '@/pages/compliance').then((m) => ({ Component: m.Page })) },
  // SCR-045 CS 처리함
  { path: 'cs/inbox', lazy: () => import(/* webpackChunkName: "scr-045" */ '@/pages/cs-inbox').then((m) => ({ Component: m.Page })) },
  // SCR-046 승인 업무
  { path: 'cs/approvals', lazy: () => import(/* webpackChunkName: "scr-046" */ '@/pages/cs-approvals').then((m) => ({ Component: m.Page })) },
  // SCR-047 회차 취소 판정·일괄 환불
  { path: 'cancellations/:requestId', lazy: () => import(/* webpackChunkName: "scr-047" */ '@/pages/cancellation').then((m) => ({ Component: m.Page })) },
  // SCR-048 판매 승인
  { path: 'sale-reviews/:productionId', lazy: () => import(/* webpackChunkName: "scr-048" */ '@/pages/sale-review').then((m) => ({ Component: m.Page })) },
  // SCR-049 정산 지급
  { path: 'settlements', lazy: () => import(/* webpackChunkName: "scr-049" */ '@/pages/settlements').then((m) => ({ Component: m.Page })) },
  // SCR-053 스캐너 기기 관리
  { path: 'scanner-devices', lazy: () => import(/* webpackChunkName: "scr-053" */ '@/pages/scanner-devices').then((m) => ({ Component: m.Page })) },
  // SCR-070 부정 거래 조사 사건 목록(지정 부정 거래 조사관만, ADR-0171)
  { path: 'investigations', lazy: () => import(/* webpackChunkName: "scr-070" */ '@/pages/investigations').then((m) => ({ Component: m.Page })) },
  // SCR-071 사건 작업대
  { path: 'investigations/:caseId', lazy: () => import(/* webpackChunkName: "scr-071" */ '@/pages/investigation-case').then((m) => ({ Component: m.Page })) },
  // SCR-064 관리 계정·세션 관리
  { path: 'accounts', lazy: () => import(/* webpackChunkName: "scr-064" */ '@/pages/accounts').then((m) => ({ Component: m.Page })) },
  // SCR-065 파트너사·계약 관리
  { path: 'partners', lazy: () => import(/* webpackChunkName: "scr-065" */ '@/pages/partners').then((m) => ({ Component: m.Page })) },
  // SCR-066 팬 조회
  { path: 'customers', lazy: () => import(/* webpackChunkName: "scr-066" */ '@/pages/customers').then((m) => ({ Component: m.Page })) },
  // SCR-067 봇 판정 표본 검토
  { path: 'bot-review', lazy: () => import(/* webpackChunkName: "scr-067" */ '@/pages/bot-review').then((m) => ({ Component: m.Page })) },
  // SCR-068 공지 관리
  { path: 'notices', lazy: () => import(/* webpackChunkName: "scr-068" */ '@/pages/notices').then((m) => ({ Component: m.Page })) },
  // SCR-059 관제 변형: 없는 주소
  { path: '*', lazy: () => import(/* webpackChunkName: "scr-059" */ '@/pages/system').then((m) => ({ Component: m.NotFoundPage })) },
];

const routes: RouteObject[] = [
  { index: true, element: <Navigate to="/dashboard" replace /> },
  // SCR-028 로그인(셸 없음)
  { path: 'login', lazy: () => import(/* webpackChunkName: "scr-028" */ '@/pages/login').then((m) => ({ Component: m.LoginPage })) },
  // 화면 목록(개발 서버에서만, 운영 빌드에서는 없는 주소)
  ...(__PREVIEW__ ? [{ path: 'preview', lazy: () => import(/* webpackChunkName: "preview" */ './preview/PreviewPage').then((m) => ({ Component: m.Page })) }] : []),
  {
    element: <ConsoleLayout />,
    // 화면 덩어리를 받지 못하면 셸은 두고 그 자리만 바꾼다
    children: [{ errorElement: <ScreenError />, children: shellScreens }],
  },
];

export const router = createBrowserRouter([{ path: '/', errorElement: <RootError />, children: routes }]);
