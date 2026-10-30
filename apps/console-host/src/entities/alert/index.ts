// 경보(목업). 경보 패널(@peaket/ds/ConsoleShell의 AlertPanel)에 넘기는 모양 그대로 둔다.
import type { ConsoleAlert } from '@peaket/ds/ConsoleShell';

/** 콘솔 밖 도구는 새 탭 링크로만 잇는다(ADR-0067). 목업 주소 */
export const GRAFANA = 'https://grafana.ops.peaket.example/d/onsale';
export const SENTRY = 'https://sentry.ops.peaket.example/issues';

export const ALERT_SEAT_HOLD_BURN: ConsoleAlert = {
  id: 'al-seat-hold-3x',
  sev: 2,
  title: '좌석 홀드 에러 버짓 3배 소진(5분·25초 창)',
  at: '20:03:41 KST',
  meta: ' · 31초 전 · 대응: 운영자 상황 판단',
  links: [
    { label: '런북', href: '/audit' },
    { label: 'Grafana', href: GRAFANA, external: true },
    { label: '실패 사건 보기', href: `${GRAFANA}/explore`, external: true, ariaLabel: '실패 사건 보기, Grafana Explore 새 탭' },
  ],
};

export const ALERT_NO_INPUT: ConsoleAlert = {
  id: 'al-no-input',
  sev: 2,
  title: '자동 제어 입력 없음(purchase-svc 지표 30초 넘게 없음)',
  at: '20:04:08 KST',
  meta: ' · 4초 전 · 대응: 운영자 판단(명령 1·2)',
  note: '관측 경로와 별개로 입장 제어가 알린 경보입니다',
  links: [
    { label: '런북', href: '/audit' },
    { label: 'Grafana', href: GRAFANA, external: true },
  ],
};

export const SEV3_SUMMARY_TEXT = '4건 · 다음 업무일에 처리(GitHub Issues 자동 등록)';

export const DECISION_ORDER =
  '판단 순서: ① 돈과 좌석(불변식) → ② 여정별 남은 허용 실패와 소진 속도 → ③ 4대 신호 → ④ 몇 분짜리 분류(최근 변경·외부 의존·포화) → ⑤ 되돌릴 수 있는 약한 조치부터(최근 변경이면 되돌리기 RB-23, 명령 1 → 2 → 6 → 3) → ⑥ 알림';
