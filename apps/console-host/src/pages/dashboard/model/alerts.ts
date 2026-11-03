// 대시보드 경보 패널 목업(보드 SCR-029-d의 w-alert·w-lalert 줄). 상태 플래그(보드 vals)에 따라 줄을 고른다.
import type { AlertPanelProps, ConsoleAlert } from '@peaket/ds/ConsoleShell';
import { ALERT_NO_INPUT, ALERT_SEAT_HOLD_BURN, GRAFANA, SEV3_SUMMARY_TEXT } from '@/entities/alert';
import { CURRENT_RUN } from '@/entities/event-run';

const RUNBOOK = 'https://runbook.ops.peaket.example/';

const SEV1_QUEUE_BURN: ConsoleAlert = {
  id: 'al-queue-10x',
  sev: 1,
  title: '대기열 진입 에러 버짓 10배 소진(2분·20초 창)',
  at: '20:04:02 KST',
  meta: ' · 10초 전 · 대응: 온콜 호출 · 입장 목표는 그대로(입장 목표 앞 여정)',
  metaOnly: true,
  links: [
    { label: '런북', href: RUNBOOK },
    { label: 'Grafana', href: GRAFANA, external: true },
    { label: '실패 사건 보기', href: `${GRAFANA}/explore`, external: true, ariaLabel: '실패 사건 보기, Grafana Explore 새 탭' },
  ],
};

const budgetCut = (at: string): ConsoleAlert => ({
  id: `al-budget-cut-${at}`,
  sev: 2,
  title: '예산 50% 감축 실행(좌석 홀드 · 동시 입장 목표 1,500 → 1,000명)',
  at,
  meta: ' · 대응: 명령 1로 목표를 정합니다',
  links: [
    { label: '런북', href: RUNBOOK },
    { label: 'Grafana', href: GRAFANA, external: true },
  ],
});

const BUDGET_100: ConsoleAlert = {
  id: 'al-budget-100',
  sev: '버짓 100%',
  tone: 'danger',
  title: '좌석 홀드 에러 버짓 모두 소진 · Degraded 후보 제시 · 포스트모템 소집',
  at: '20:04:09 KST · 3초 전',
  meta: ' · 대응: Degraded 후보 검토(명령 6, 2인)',
  links: [
    { label: '명령 6 열기', href: '/commands' },
    { label: '런북', href: RUNBOOK },
  ],
};

const PG_DEGRADED: ConsoleAlert = {
  id: 'al-pg-degraded',
  sev: 2,
  title: '결제 Degraded 진입(토스페이먼츠 신규 결제 정지)',
  at: '20:02:51 KST',
  meta: ' · 1분 21초 전 · 대응: 걸린 자동 조치에서 풀림 확인',
  links: [
    { label: '런북', href: `${RUNBOOK}RB-07` },
    { label: 'Grafana', href: GRAFANA, external: true },
  ],
};

export interface AlertFlags {
  isNoInput?: boolean;
  isSupp?: boolean;
  isB50?: boolean;
  isB100?: boolean;
  isAuto?: boolean;
  isStale?: boolean;
  isGap?: boolean;
}

/** T=0 탭('t0')과 판매 중 탭('live')의 경보 패널. 셸의 SEV 링크(/dashboard#w-alert)가 닿도록 id는 둘 다 w-alert다 */
export function alertPanelFor(tab: 't0' | 'live', f: AlertFlags): Omit<AlertPanelProps, 'renderLink' | 'footer' | 'style'> {
  const event: ConsoleAlert[] = [];
  if (tab === 't0') {
    if (f.isNoInput) event.push(ALERT_NO_INPUT);
    event.push(ALERT_SEAT_HOLD_BURN);
  } else {
    event.push(ALERT_SEAT_HOLD_BURN);
    if (f.isB50) event.push(budgetCut('20:04:05 KST · 7초 전'));
    if (f.isB100) event.push(budgetCut('20:02:58 KST · 1분 14초 전'), BUDGET_100);
    if (f.isAuto) event.push(PG_DEGRADED);
  }
  const tail =
    tab === 'live'
      ? `${f.isStale ? ' · 실시간 표 낡음(대체 표시) 포함' : ''}${f.isGap ? ' · 거래 사건 끊김(판매 사건 60초 넘게 없음) 포함' : ''}`
      : '';
  return {
    id: 'w-alert',
    sev1: tab === 'live' && f.isSupp ? [SEV1_QUEUE_BURN] : [],
    suppressed: tab === 'live' && f.isSupp ? { count: 1, detail: 'SEV2 대기열 진입 에러 버짓 3배 소진(5분·25초 창) · 20:03:50 KST' } : undefined,
    event: { title: `이 회차 판단 · ${CURRENT_RUN.label.split(' · ')[0]}`, alerts: event },
    platform: { sev3Summary: { text: SEV3_SUMMARY_TEXT + tail, count: 4, href: '/audit' } },
    allHref: '/audit',
  };
}
