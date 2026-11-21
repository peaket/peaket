// BAT-086 시연 시나리오 정의(docs/review/plans/BAT-086.md §1 G2·§5, 정본 docs/design/d5-screen-blueprint.md §10.6).
// - 화면 순서는 정본 표를 그대로 옮기지 않고, plan --check가 정본 표와 글자 단위로 견준다(화면 번호·순서).
//   정의를 고칠 때는 정본을 먼저 고친다(계획 B5).
// - checks는 시나리오가 끝까지 돌았을 때 재생기가 만들 수 있는 결과 확인 이름이다. 하나라도 만들어지지 않으면
//   그 시나리오는 실패다(조용한 건너뛰기 없음, 계획 B4·B15).
// - 이 파일은 값(가격·인원·좌석 이름)을 정본에서 옮겨 적지 않는다. 시나리오 ID·화면 번호·확인 이름만 둔다.
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const D5_DOC = join(REPO, 'docs', 'design', 'd5-screen-blueprint.md');

/** 정본 d5 §10.6의 시연 순서 */
export const SCENARIO_ORDER = ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'S9'];

/**
 * 시나리오 정의. steps는 사람이 읽는 재생 순서이고, 실제 재생은 runner.mjs의 같은 ID 흐름이 맡는다.
 * kind: screen(화면을 연다) · api(제품 API로 상태를 만들거나 확인한다) · wait(화면 조건을 기다린다)
 */
export const SCENARIOS = [
  {
    id: 'S1',
    title: '지민 씨의 하이브리드 공연 예매(E-1)',
    screens: ['SCR-001', 'SCR-002', 'SCR-007', 'SCR-008', 'SCR-010', 'SCR-011', 'SCR-012', 'SCR-013'],
    accounts: ['jimin'],
    needs: ['E-1', 'demo-clock', 'queue-entry', 'pg-simulator'],
    evidenceOnlyScreens: ['SCR-001'],
    checks: ['seat-hold-2', 'payment-approved', 'ticket-qr'],
    steps: [
      { id: 'home', kind: 'screen', screen: 'SCR-001', path: '/', as: 'jimin' },
      { id: 'event', kind: 'screen', screen: 'SCR-002', path: '/events/{eventId}', as: 'jimin' },
      { id: 'clock', kind: 'api', note: '회차 오픈을 지금+30초로 당긴다(파트너 회차 고치기)' },
      { id: 'queue', kind: 'screen', screen: 'SCR-007', path: '/queue/{eventId}', as: 'jimin' },
      { id: 'open', kind: 'wait', screen: 'SCR-008', note: 'T=0이 되면 대기열 화면으로 바뀐다' },
      { id: 'seats', kind: 'screen', screen: 'SCR-010', path: '/booking/{eventId}/seats', as: 'jimin' },
      { id: 'hold', kind: 'api', note: 'R구역 2석 홀드' },
      { id: 'checkout', kind: 'screen', screen: 'SCR-011', path: '/booking/{eventId}/checkout', as: 'jimin' },
      { id: 'pay', kind: 'api', note: '주문 → 결제 시도 → 시뮬레이터 승인 → 결제 승인' },
      { id: 'result', kind: 'screen', screen: 'SCR-012', path: '/booking/{eventId}/result', as: 'jimin' },
      { id: 'ticket', kind: 'screen', screen: 'SCR-013', path: '/my/tickets/{ticketId}', as: 'jimin' },
    ],
  },
  {
    id: 'S2',
    title: '매진과 취소표 알림(E-3)',
    screens: ['SCR-008', 'SCR-018', 'SCR-054'],
    accounts: ['jimin'],
    needs: ['E-3', 'sold-out-fixture'],
    evidenceOnlyScreens: [],
    // 취소표 알림 신청 API는 아직 없다(제품 빈칸). 매진 화면에서 누르면 실패 분기의 '다시 시도' 문구를 재생한다
    checks: ['sold-out', 'retry-message'],
    steps: [
      { id: 'soldout', kind: 'screen', screen: 'SCR-018', path: '/queue/{eventId}', as: 'jimin', note: '매진 상태(대기열 Redis notice를 데모 전용으로 매진으로 바꾼다)' },
      { id: 'alert', kind: 'screen', note: '취소표 알림 받기를 눌러 실패 분기의 다시 시도 문구를 본다(신청 API 없음)' },
      { id: 'likes', kind: 'screen', screen: 'SCR-054', path: '/my/likes', as: 'jimin' },
    ],
  },
  {
    id: 'S3',
    title: '결제 실패와 결과 불명',
    screens: ['SCR-011', 'SCR-012', 'SCR-055', 'SCR-012', 'SCR-010'],
    accounts: ['jimin'],
    // S3는 실패·결과 불명 주문을 남기므로 S9가 취소하는 E-1 대신 E-4를 쓴다
    needs: ['E-4', 'demo-clock', 'queue-entry', 'pg-simulator', 'simulator-faults'],
    evidenceOnlyScreens: [],
    checks: ['unknown-result', 'seat-released'],
    steps: [
      { id: 'checkout', kind: 'screen', screen: 'SCR-011', path: '/booking/{eventId}/checkout', as: 'jimin' },
      { id: 'decline', kind: 'api', note: '결제창 실패 → 같은 주문으로 다시 결제 → 승인 거절' },
      { id: 'result', kind: 'screen', screen: 'SCR-012', path: '/booking/{eventId}/result', as: 'jimin' },
      { id: 'orders', kind: 'screen', screen: 'SCR-055', path: '/my/orders', as: 'jimin' },
      { id: 'unknown', kind: 'api', note: '응답 유실로 결과 불명' },
      { id: 'rehold', kind: 'api', screen: 'SCR-010', note: '실패한 주문의 좌석을 다시 홀드해 해제를 확인' },
    ],
  },
  {
    id: 'S4',
    title: '선착순·자동 배정(E-2)',
    screens: ['SCR-002', 'SCR-008', 'SCR-010', 'SCR-011'],
    accounts: ['jimin'],
    needs: ['E-2', 'demo-clock', 'queue-entry', 'pg-simulator'],
    evidenceOnlyScreens: [],
    checks: ['auto-assign', 'payment-approved'],
    steps: [
      { id: 'event', kind: 'screen', screen: 'SCR-002', path: '/events/{eventId}', as: 'jimin' },
      { id: 'clock', kind: 'api', note: '회차 오픈을 지금+30초로 당긴다' },
      { id: 'queue', kind: 'screen', screen: 'SCR-008', path: '/queue/{eventId}', as: 'jimin' },
      { id: 'seats', kind: 'screen', screen: 'SCR-010', path: '/booking/{eventId}/seats', as: 'jimin' },
      { id: 'auto', kind: 'api', note: '희망 조건으로 자동 배정 홀드' },
      { id: 'checkout', kind: 'screen', screen: 'SCR-011', path: '/booking/{eventId}/checkout', as: 'jimin' },
      { id: 'pay', kind: 'api', note: '결제 승인' },
    ],
  },
  {
    id: 'S5',
    title: '양도와 취소',
    screens: ['SCR-013', 'SCR-014', 'SCR-041', 'SCR-013', 'SCR-038'],
    accounts: ['jimin', 'haneul'],
    needs: ['E-1', 'ticket', 'fan-reauth'],
    evidenceOnlyScreens: ['SCR-014', 'SCR-041'],
    // 양도 API(POST /v1/tickets/{id}/transfers, /v1/transfers/*)는 아직 없다(제품 빈칸). 이 묶음은 팬 재인증 토큰과
    // ticket-cancel 재인증 경로(견적 → 취소)를 실제 API로 끝낸다.
    checks: ['fan-reauth', 'cancel-with-fee'],
    steps: [
      { id: 'tickets', kind: 'screen', screen: 'SCR-013', path: '/my/tickets', as: 'jimin' },
      { id: 'transfer', kind: 'screen', screen: 'SCR-014', path: '/my/tickets/{ticketId}/transfer', as: 'jimin', note: '양도 화면(제품 API 없음, 증거로만 연다)' },
      { id: 'offer', kind: 'screen', screen: 'SCR-041', path: '/my/transfers/{offerId}', as: 'haneul', note: '양도 제안 화면(제품 API 없음)' },
      { id: 'reauth', kind: 'api', note: '팬 재인증 토큰(issueFanReauthToken, act FAN_SENSITIVE·op TICKET_CANCEL)' },
      { id: 'cancel', kind: 'screen', screen: 'SCR-038', path: '/my/tickets/{ticketId}/cancel', as: 'jimin' },
      { id: 'fee', kind: 'api', note: '취소 견적(공제율·환급액) → X-Reauth-Token으로 취소(202)' },
    ],
  },
  {
    id: 'S6',
    title: '공연 등록과 판매 승인',
    screens: ['SCR-020', 'SCR-062', 'SCR-021', 'SCR-048', 'SCR-062', 'SCR-026'],
    accounts: ['stella-admin', 'minho'],
    needs: ['partner-api', 'ops-api', 'seatmap'],
    evidenceOnlyScreens: [],
    checks: ['production-created', 'sale-approved', 'status-visible'],
    steps: [
      { id: 'partner', kind: 'screen', screen: 'SCR-020', path: '/login', as: 'stella-admin' },
      { id: 'list', kind: 'screen', screen: 'SCR-062', path: '/events', as: 'stella-admin' },
      { id: 'create', kind: 'api', note: '공연·회차 등록(파트너 공개 API)' },
      { id: 'wizard', kind: 'screen', screen: 'SCR-021', path: '/events/new', as: 'stella-admin' },
      { id: 'seatmap', kind: 'api', note: '좌석맵 등록' },
      { id: 'submit', kind: 'api', note: '판매 심사 제출' },
      { id: 'approve', kind: 'screen', screen: 'SCR-048', path: '/sale-reviews/{productionId}', as: 'minho' },
      { id: 'approve-api', kind: 'api', note: '관제 승인' },
      { id: 'status', kind: 'screen', screen: 'SCR-062', path: '/events', as: 'stella-admin' },
      { id: 'public', kind: 'api', screen: 'SCR-026', note: '공개 조회로 판매 상태 확인' },
    ],
  },
  {
    id: 'S7',
    title: 'T=0 관제',
    screens: ['SCR-029', 'SCR-030', 'SCR-031'],
    accounts: ['minho', 'sujin', 'second-commander'],
    needs: ['E-1', 'console', 'passkey', 'two-person-approval'],
    evidenceOnlyScreens: [],
    checks: ['self-approval-403', 'second-approval-ok', 'audit-entry'],
    steps: [
      { id: 'dashboard', kind: 'screen', screen: 'SCR-029', path: '/dashboard?event={eventId}', as: 'sujin' },
      { id: 'command', kind: 'api', note: '명령 1(민호) → 명령 3 실행(수진, 1인·재인증)' },
      { id: 'commands', kind: 'screen', screen: 'SCR-030', path: '/commands', as: 'sujin' },
      { id: 'self', kind: 'api', note: '요청자가 자기 명령을 승인하면 403' },
      { id: 'second', kind: 'api', note: '두 번째 commander가 승인하면 성공' },
      { id: 'audit', kind: 'screen', screen: 'SCR-031', path: '/audit', as: 'sujin' },
      { id: 'audit-api', kind: 'api', note: '감사 기록에 두 계정이 따로 남는지 확인' },
    ],
  },
  {
    id: 'S8',
    title: '공연 당일 입장',
    screens: ['SCR-050', 'SCR-053', 'SCR-037', 'SCR-036', 'SCR-051', 'SCR-033', 'SCR-034', 'SCR-052'],
    accounts: ['haneul', 'doyun'],
    needs: ['E-1', 'staff', 'scanner-device', 'synthetic-ticket'],
    evidenceOnlyScreens: [],
    checks: ['verdict-pass', 'verdict-reject', 'verdict-needs-check', 'verdict-anomaly'],
    steps: [
      { id: 'assignment', kind: 'screen', screen: 'SCR-037', path: '/staff', as: 'haneul' },
      { id: 'scanner-home', kind: 'screen', screen: 'SCR-036', path: '/', as: 'haneul' },
      { id: 'approve', kind: 'screen', screen: 'SCR-051', path: '/staff/approve', as: 'haneul' },
      { id: 'scan', kind: 'screen', screen: 'SCR-033', path: '/', as: 'haneul' },
      { id: 'verdicts', kind: 'api', note: '판정 넷(통과·거부·확인 필요·이상 표시)' },
      { id: 'result', kind: 'screen', screen: 'SCR-034', path: '/', as: 'haneul' },
    ],
  },
  {
    id: 'S9',
    title: '회차 취소와 배상(선택)',
    screens: ['SCR-044', 'SCR-045', 'SCR-047', 'SCR-013', 'SCR-043'],
    accounts: ['jimin', 'sujin', 'second-commander'],
    needs: ['E-1', 'ticket', 'event-cancellation', 'two-person-approval'],
    evidenceOnlyScreens: ['SCR-044', 'SCR-043'],
    checks: ['refunded'],
    steps: [
      { id: 'cancellation', kind: 'screen', screen: 'SCR-044', path: '/events/{productionId}/cancellation', as: 'stella-admin' },
      { id: 'inbox', kind: 'screen', screen: 'SCR-045', path: '/cs/inbox', as: 'sujin' },
      { id: 'judge', kind: 'screen', screen: 'SCR-047', path: '/cancellations/{requestId}', as: 'sujin' },
      { id: 'approve', kind: 'api', note: '2인 승인 뒤 일괄 환불' },
      { id: 'ticket', kind: 'screen', screen: 'SCR-013', path: '/my/tickets', as: 'jimin' },
      { id: 'refund', kind: 'api', note: '같은 주문을 두 번 환불하지 않는지 확인' },
      { id: 'compensation', kind: 'screen', screen: 'SCR-043', path: '/my/compensations/{compensationId}', as: 'jimin' },
    ],
  },
];

/** 시나리오 하나를 ID로 찾는다(없으면 undefined) */
export function scenarioById(id, list = SCENARIOS) {
  return list.find((s) => s.id === id);
}

/**
 * 정본 d5 §10.6 표에서 시나리오별 화면 번호를 읽는다. 표의 셋째 칸(화면 순서)만 본다.
 * `SCR-001`과 `002` 같은 맨 번호를 모두 SCR-NNN으로 맞추고, 나온 차례를 지킨다.
 * @param {string} text d5 문서 전체
 * @returns {Map<string, string[]>} S1 → ['SCR-001', ...]
 */
export function parseD5Scenarios(text) {
  const out = new Map();
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^\|\s*(S[1-9])\s*\|/.exec(line);
    if (!m) continue;
    const cells = line.split('|');
    const order = cells[3] ?? '';
    const found = [];
    const re = /SCR-(\d{3})|(?:^|[^0-9])(\d{3})(?![0-9])/g;
    let x;
    while ((x = re.exec(order)) !== null) {
      // 앞 문자 하나를 먹은 경우 그 글자가 숫자면 건너뛴다(4자리 수의 꼬리 방지)
      if (x.index > 0 && /\d/.test(order[x.index - 1]) && x[1] === undefined) continue;
      found.push(`SCR-${x[1] ?? x[2]}`);
    }
    out.set(m[1], found);
  }
  return out;
}

/** docs/design/d5-screen-blueprint.md의 §10.6 표를 읽는다 */
export function readD5Scenarios(file = D5_DOC) {
  return parseD5Scenarios(readFileSync(file, 'utf8'));
}

/** 시나리오마다 반드시 있어야 하는 결과 확인(계획 §6 V-T7 ①) */
export const REQUIRED_CHECKS = {
  S1: ['seat-hold-2', 'payment-approved', 'ticket-qr'],
  S3: ['unknown-result', 'seat-released'],
  S7: ['self-approval-403', 'second-approval-ok', 'audit-entry'],
  S8: ['verdict-pass', 'verdict-reject', 'verdict-needs-check', 'verdict-anomaly'],
  S9: ['refunded'],
};

/**
 * 시나리오 정의를 정본과 견준다. 시험 담당이 목록을 바꿔 넣어도 되게 목록·정본을 인자로 받는다.
 * @param {typeof SCENARIOS} [list] @param {{ d5?: Map<string, string[]> | string, docPath?: string }} [o]
 * @returns {{ ok: boolean, problems: string[], scenarios: Array<{ id: string, title: string, screens: string[], accounts: string[], needs: string[], checks: string[] }> }}
 */
export function validateScenarios(list = SCENARIOS, o = {}) {
  const problems = [];
  let d5 = o.d5;
  if (typeof d5 === 'string') d5 = parseD5Scenarios(d5);
  if (d5 === undefined) {
    try {
      d5 = readD5Scenarios(o.docPath ?? D5_DOC);
    } catch (e) {
      problems.push(`정본 d5 §10.6을 읽지 못했다: ${e instanceof Error ? e.message : String(e)}`);
      d5 = new Map();
    }
  }
  const ids = list.map((s) => s.id);
  if (ids.join(',') !== SCENARIO_ORDER.join(',')) problems.push(`시나리오 순서가 ${SCENARIO_ORDER.join('·')}가 아니다: ${ids.join('·')}`);
  for (const id of SCENARIO_ORDER) {
    const s = list.find((x) => x.id === id);
    if (!s) {
      problems.push(`시나리오 ${id}가 없다`);
      continue;
    }
    const want = d5.get(id);
    if (!want || want.length === 0) problems.push(`정본 d5 §10.6에서 ${id}의 화면 순서를 읽지 못했다`);
    else if (s.screens.join(' ') !== want.join(' ')) {
      problems.push(`${id}의 화면 순서가 정본과 다르다: 정의 ${s.screens.join('→')} / 정본 ${want.join('→')}`);
    }
    if (!Array.isArray(s.accounts) || s.accounts.length === 0) problems.push(`${id}에 계정이 없다`);
    if (!Array.isArray(s.needs) || s.needs.length === 0) problems.push(`${id}에 필요한 선행(needs)이 없다`);
    if (!Array.isArray(s.checks) || s.checks.length === 0) problems.push(`${id}에 결과 확인(checks)이 없다`);
    // 증거로만 여는 화면(리뷰 RV-05): 화면 목록 안의 이름이어야 하고, 필수 화면 판정에서 뺀다
    if (!Array.isArray(s.evidenceOnlyScreens)) problems.push(`${id}에 evidenceOnlyScreens(배열)가 없다`);
    else for (const screen of s.evidenceOnlyScreens) if (!(s.screens ?? []).includes(screen)) problems.push(`${id}의 evidenceOnlyScreens ${screen}이 화면 목록에 없다`);
    for (const c of REQUIRED_CHECKS[id] ?? []) if (!(s.checks ?? []).includes(c)) problems.push(`${id}에 결과 확인 '${c}'가 없다`);
    if (new Set(s.checks ?? []).size !== (s.checks ?? []).length) problems.push(`${id}의 checks에 같은 이름이 두 번 있다`);
    if (new Set(s.screens ?? []).size === 0 && (s.screens ?? []).length > 0) problems.push(`${id}의 screens가 비었다`);
  }
  return {
    ok: problems.length === 0,
    problems,
    scenarios: list.map((s) => ({ id: s.id, title: s.title, screens: [...s.screens], accounts: [...s.accounts], needs: [...s.needs], checks: [...s.checks], evidenceOnlyScreens: [...(s.evidenceOnlyScreens ?? [])] })),
  };
}

/** `plan --json`이 내는 모양(계획 §5. 테스트가 읽는 칸) */
export function publicPlan(list = SCENARIOS) {
  return { scenarios: validateScenarios(list).scenarios };
}
