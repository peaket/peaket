// 자동 제어의 순수 판단(docs/features/queue-admission.md §5 '자동 제어의 첫 구현', POL-010, ADR-0069·0126·0127·0129·0226).
// 시계와 저장소를 건드리지 않는다. 입력은 표본 시각과 함께 받고, 기억(AimdMemory)을 돌려준다. 저장은 리더 Lua가 세대 확인 안에서 한다.
import { AVG_STAY_S, BUDGET_SEAT_OVERLAP_MS, ERROR_RATIO_LIMIT, HOLD_MAX_MS, HOLD_MIN_MS, INCREASE_STEP, INCREASE_WINDOW_MS, INPUT_FUTURE_MS, INPUT_RECOVER_MS, INPUT_STALE_MS, MAX_TARGET, MIN_TARGET_BASE, OPERATOR_FREEZE_MS, P99_LIMIT_S, PG_PAY_RATIO, PG_SAFETY_FACTOR } from './plan.js';

/** 표본이 있는 입력은 값과 표본 시각, 쿼리 실패는 failed, 빈 결과는 missing이다. 빈 결과를 0으로 읽지 않는다(ADR-0069 결정 1) */
export type Reading = { ok: true; value: number; atMs: number } | { ok: false; why: 'failed' | 'missing' };

/** 입장 목표가 부하를 정하는 여정(ADR-0126 결정 1) */
export const LINKED_JOURNEYS = ['hold', 'seat_status', 'payment_accept', 'payment_confirm'] as const;
export const OTHER_JOURNEYS = ['detail', 'queue_entry', 'queue_state'] as const;
export const ALL_JOURNEYS = [...LINKED_JOURNEYS, ...OTHER_JOURNEYS] as const;
export type Journey = (typeof ALL_JOURNEYS)[number];
export type BudgetKind = 'alert' | 'burn50';
const LINKED = new Set<Journey>(LINKED_JOURNEYS);
const PAYMENT_JOURNEYS = new Set<Journey>(['payment_accept', 'payment_confirm']);

/** admission_control_input_stale의 input 라벨 값(docs/observability.md §8) */
export const INPUT_KINDS = ['downstream_latency', 'downstream_errors', 'budget_burn', 'seat_store'] as const;

export interface EventInputs {
  latency: Reading;
  errors: Reading;
  seatStore: Reading;
  /** 열쇠 `${journey}:${kind}` */
  budget: ReadonlyMap<string, Reading>;
  /** 결제사 원인 경보(노출 줄이기 표시용, 없어도 입력 없음이 아니다, ADR-0126) */
  pgCause: boolean;
}

export interface AimdMemory {
  /** 결제사·합산 나누기 전의 AIMD 목표 */
  target: number;
  /** 마지막 증액·감축의 시각(증액 창의 기준) */
  changeAt: number;
  decAt: number | null;
  decTo: number | null;
  /** 마지막으로 판단한 표본 시각 */
  sample: number | null;
  staleSince: number | null;
  freshSince: number | null;
  staleKinds: string[];
  /** 입력 없음이 끝난 시각(복귀 확인 기준) */
  recoveredAt: number | null;
  budgetHoldAt: number | null;
  budgetSeen: string[];
  seatStoreDown: boolean;
  seatStoreCutAt: number | null;
  /** 좌석 홀드 여정 예산 감축 시각(좌석 저장소 감축과 겹침, ADR-0121 결정 3) */
  budgetHoldCutAt: number | null;
  manualEndedAt: number | null;
  /** JSON(사유·여정·전후 목표·노출 줄이기) */
  lastDecrease: string | null;
}

/** ctl의 운영자 칸(ADR-0226 결정 7). 쓰는 코드는 OPS-300 */
export interface OperatorState {
  value: number | null;
  untilMs: number | null;
  resumeAtMs: number | null;
}

export interface AimdContext {
  nowMs: number;
  memory: AimdMemory;
  inputs: EventInputs;
  /** 직전 주기의 예매 단계 인원(새 리더의 첫 주기에는 모른다) */
  slotsUsed: number | undefined;
  /** 입장 일시정지·판매 일시정지·판매 중지(증액 멈춤, 감축 허용) */
  paused: boolean;
  /** 명령 11(자동화 정지) */
  autoStopped: boolean;
  operator: OperatorState;
  upper: number;
  lower: number;
  /** 결제사 상한이 걸린 회차인가(상한으로 줄이면 pg_cap으로 센다) */
  pgLimited: boolean;
}

export interface Decrease {
  reason: 'aimd' | 'budget_alert' | 'budget_50' | 'pg_cap' | 'seat_store' | 'operator';
  journey?: Journey;
  exposure?: boolean;
  from: number;
  to: number;
}

export interface AimdResult {
  memory: AimdMemory;
  target: number;
  decreases: Decrease[];
  suppressed: number;
  ignored: Journey[];
  staleKinds: string[];
}

/** 신선한 표본: 30초 안이고, 미래로 허용치(시계 어긋남)를 넘지 않는다. 미래 표본을 받으면 그 뒤 진짜 표본이 '새 표본'이 되지 못한다 */
const fresh = (r: Reading, now: number) => r.ok && now - r.atMs <= INPUT_STALE_MS && r.atMs - now <= INPUT_FUTURE_MS;
const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

export const setAtOf = (op: OperatorState): number | null => (op.untilMs === null ? null : op.untilMs - OPERATOR_FREEZE_MS);

/** 운영자 고정 중인가: 값이 있고, 만료 전이고, 버짓 감축이 끝내지 않았다(ADR-0062 결정 43) */
export function isManualFixed(op: OperatorState, manualEndedAt: number | null, nowMs: number): boolean {
  if (op.value === null) return false;
  if (op.untilMs !== null && nowMs >= op.untilMs) return false;
  if (manualEndedAt !== null) {
    const setAt = setAtOf(op);
    if (setAt === null || manualEndedAt >= setAt) return false;
  }
  return true;
}

function staleKindsOf(i: EventInputs, now: number): string[] {
  const kinds: string[] = [];
  if (!fresh(i.latency, now)) kinds.push('downstream_latency');
  if (!fresh(i.errors, now)) kinds.push('downstream_errors');
  let budgetOk = true;
  for (const j of LINKED_JOURNEYS) for (const k of ['alert', 'burn50'] as const) {
    const r = i.budget.get(`${j}:${k}`);
    if (!r || !fresh(r, now)) budgetOk = false;
  }
  if (!budgetOk) kinds.push('budget_burn');
  if (!fresh(i.seatStore, now)) kinds.push('seat_store');
  return kinds;
}

/** 지난 기억과 입력으로 이번 판단을 한다. 입력 없음·명령 11이면 증액도 자동 감축도 하지 않는다(ADR-0069 결정 1) */
export function decideAimd(ctx: AimdContext): AimdResult {
  const { nowMs: now, inputs, operator, upper, lower } = ctx;
  const m: AimdMemory = { ...ctx.memory, budgetSeen: [...ctx.memory.budgetSeen], staleKinds: [...ctx.memory.staleKinds] };
  const decreases: Decrease[] = [];
  const ignored: Journey[] = [];
  let suppressed = 0;

  const record = (d: Decrease): void => {
    decreases.push(d);
    m.lastDecrease = JSON.stringify({ at: now, ...d });
  };
  /** 절반으로 줄인다(하한 아래로는 내리지 않는다). 줄었으면 참 */
  const halve = (reason: Decrease['reason'], extra: Pick<Decrease, 'journey' | 'exposure'> = {}): boolean => {
    const from = m.target;
    const to = Math.max(lower, Math.floor(from / 2));
    if (to >= from) return false;
    m.target = to;
    m.changeAt = now;
    record({ reason, ...extra, from, to });
    return true;
  };

  // 입력 없음 판정: 입력마다 매 주기 본다. 돌아오기 시작해서 10초 이어져야 입력 없음이 끝난다
  const staleKinds = staleKindsOf(inputs, now);
  if (staleKinds.length > 0) {
    if (m.staleSince === null) m.staleSince = now;
    m.freshSince = null;
    m.staleKinds = staleKinds;
  } else if (m.staleSince !== null) {
    if (m.freshSince === null) m.freshSince = now;
    if (now - m.freshSince >= INPUT_RECOVER_MS) {
      m.staleSince = null;
      m.freshSince = null;
      m.staleKinds = [];
      m.recoveredAt = now;
    }
  }
  const stale = m.staleSince !== null;

  // 안전 범위: 낮아진 상한(결제사 상한)은 입력 없음이어도 바로 따른다. 저장된 값이 범위를 벗어나도 여기서 깎는다
  if (m.target > upper) {
    const from = m.target;
    m.target = upper;
    m.changeAt = now;
    if (ctx.pgLimited) record({ reason: 'pg_cap', from, to: upper });
  }
  if (m.target < lower) m.target = lower;

  // 운영자 고정: 입력 없음이어도 그대로 받는다(값은 안전 범위로 깎는다)
  let fixed = isManualFixed(operator, m.manualEndedAt, now);
  if (fixed && operator.value !== null) {
    const v = clamp(operator.value, lower, upper);
    if (v !== m.target) {
      if (v < m.target) record({ reason: 'operator', from: m.target, to: v });
      m.target = v;
      m.changeAt = now;
    }
  }

  const automatic = !stale && !ctx.autoStopped;

  // 좌석 저장소 감축: 신호가 켜질 때 한 번(ADR-0121 결정 3). 홀드 여정 예산 감축 직후면 다시 줄이지 않는다
  if (automatic && inputs.seatStore.ok) {
    const down = inputs.seatStore.value >= 1;
    if (down && !m.seatStoreDown) {
      m.seatStoreDown = true;
      const recent = m.budgetHoldCutAt !== null && now - m.budgetHoldCutAt < BUDGET_SEAT_OVERLAP_MS;
      if (!recent && halve('seat_store')) {
        m.seatStoreCutAt = now;
        // 고정 중이면 고정을 끝낸다: 다음 주기에 운영자 값으로 되돌아가면 감축이 한 주기만 산다(ADR-0226 결정 12)
        if (fixed) {
          m.manualEndedAt = now;
          fixed = false;
        }
      }
    } else if (!down && m.seatStoreDown) m.seatStoreDown = false;
  }

  // 에러 버짓 연동 감축: 신호가 처음 켜진 때 한 번. 연동 여정만(ADR-0126). 입력 없음·명령 11 동안에는 적지도 줄이지도 않는다
  if (automatic) {
    for (const j of ALL_JOURNEYS) {
      for (const k of ['alert', 'burn50'] as const) {
        const key = `${j}:${k}`;
        const r = inputs.budget.get(key);
        if (!r?.ok) continue;
        const on = r.value >= 1;
        const known = m.budgetSeen.includes(key);
        if (on && !known) {
          m.budgetSeen.push(key);
          if (!LINKED.has(j)) ignored.push(j);
          else {
            m.budgetHoldAt = now;
            // 좌석 저장소가 안 되는 동안 켜진 좌석 홀드 여정 신호는 같은 원인이라 더 줄이지 않는다(ADR-0121 결정 3)
            const overlap = j === 'hold' && m.seatStoreDown;
            const exposure = inputs.pgCause && PAYMENT_JOURNEYS.has(j) ? { exposure: true } : {};
            const cut = !overlap && halve(k === 'alert' ? 'budget_alert' : 'budget_50', { journey: j, ...exposure });
            if (cut && j === 'hold') m.budgetHoldCutAt = now;
            // 고정 뒤 새로 울린 신호로 줄이면 고정이 끝난다(줄이지 않았으면 끝나지 않는다, ADR-0062 결정 43)
            if (cut && fixed) {
              m.manualEndedAt = now;
              fixed = false;
            }
          }
        } else if (!on && known && k === 'alert') m.budgetSeen = m.budgetSeen.filter((x) => x !== key);
      }
    }
  }

  // 고정 뒤 복귀 확인 전에는 AIMD가 움직이지 않는다(POL-021 C-2)
  const manualSet = operator.value !== null;
  const endedBy = m.manualEndedAt !== null && (setAtOf(operator) === null || m.manualEndedAt >= setAtOf(operator)!) ? m.manualEndedAt : operator.untilMs;
  const waitingConfirm = manualSet && !fixed && !(operator.resumeAtMs !== null && endedBy !== null && operator.resumeAtMs > endedBy);

  if (automatic && !fixed && !waitingConfirm && inputs.latency.ok && inputs.errors.ok) {
    const at = Math.max(inputs.latency.atMs, inputs.errors.atMs);
    if (m.sample === null || at > m.sample) {
      // 처음 판단이면 증액 창을 첫 표본 시각부터 센다(시작 때 '지금'으로 채운 값은 표본보다 뒤일 수 있다)
      if (m.sample === null) m.changeAt = Math.min(m.changeAt, at);
      m.sample = at;
      const over = inputs.latency.value > P99_LIMIT_S || inputs.errors.value > ERROR_RATIO_LIMIT;
      if (over) {
        // 감축 확인 시간: 인원이 새 목표 아래로 내려오고 35초가 지났거나 2분이 지날 때까지 AIMD 추가 감축을 막는다(ADR-0069 결정 2, 높음-12)
        const holdActive = m.decAt !== null && !(now - m.decAt >= HOLD_MAX_MS || (now - m.decAt >= HOLD_MIN_MS && ctx.slotsUsed !== undefined && m.decTo !== null && ctx.slotsUsed < m.decTo));
        if (holdActive) suppressed += 1;
        else if (halve('aimd')) {
          m.decAt = now;
          m.decTo = m.target;
          m.changeAt = at;
        }
      } else if (at - m.changeAt >= INCREASE_WINDOW_MS && m.target < upper) {
        const needConfirm = m.recoveredAt !== null && !(operator.resumeAtMs !== null && operator.resumeAtMs > m.recoveredAt);
        const setAt = setAtOf(operator);
        const budgetHold = m.budgetHoldAt !== null && !(setAt !== null && setAt > m.budgetHoldAt);
        // 좌석 저장소가 안 되는 동안에는 늘리지 않는다('회복 뒤에', ADR-0121 결정 3)
        if (!ctx.paused && !needConfirm && !budgetHold && !m.seatStoreDown) {
          m.target = Math.min(upper, m.target + INCREASE_STEP);
          m.changeAt = at;
        }
      }
    }
  }

  return { memory: m, target: m.target, decreases, suppressed, ignored, staleKinds };
}

export function initialMemory(target: number, nowMs: number): AimdMemory {
  return { target, changeAt: nowMs, decAt: null, decTo: null, sample: null, staleSince: null, freshSince: null, staleKinds: [], recoveredAt: null, budgetHoldAt: null, budgetSeen: [], seatStoreDown: false, seatStoreCutAt: null, budgetHoldCutAt: null, manualEndedAt: null, lastDecrease: null };
}

const n = (v: number | null): string => (v === null ? '' : String(v));
const int = (v: string | null | undefined): number | null => (v !== null && v !== undefined && /^\d{1,16}$/.test(v) ? Number(v) : null);

/** 기억을 ctl 칸(docs/data.md q:{event:E}:ctl)으로 바꾼다. 없는 값은 빈 글자다 */
export function memoryToFields(m: AimdMemory): Record<string, string> {
  return {
    aimdTarget: String(m.target),
    aimdChangeAt: String(m.changeAt),
    aimdDecAt: n(m.decAt),
    aimdDecTo: n(m.decTo),
    aimdSample: n(m.sample),
    inputStale: m.staleSince !== null ? '1' : '0',
    inputStaleAt: n(m.staleSince),
    inputFreshAt: n(m.freshSince),
    inputStaleKinds: m.staleKinds.join(','),
    aimdRecoveredAt: n(m.recoveredAt),
    budgetHoldAt: n(m.budgetHoldAt),
    budgetSeen: JSON.stringify(m.budgetSeen),
    seatStoreDown: m.seatStoreDown ? '1' : '0',
    seatStoreCutAt: n(m.seatStoreCutAt),
    budgetHoldCutAt: n(m.budgetHoldCutAt),
    manualEndedAt: n(m.manualEndedAt),
    lastDecrease: m.lastDecrease ?? '',
  };
}

export const MEMORY_FIELDS = Object.keys(memoryToFields(initialMemory(0, 0)));

/** ctl 칸을 기억으로 읽는다. 틀린 칸은 없는 것으로 본다(바꾸는 쪽이 하나뿐이라도 저장소가 그대로라고 믿지 않는다) */
export function memoryFromFields(f: Record<string, string | null | undefined>, fallbackTarget: number, nowMs: number): AimdMemory {
  let seen: string[] = [];
  try {
    const parsed: unknown = f.budgetSeen ? JSON.parse(f.budgetSeen) : [];
    if (Array.isArray(parsed) && parsed.every((x) => typeof x === 'string')) seen = parsed as string[];
  } catch {
    seen = [];
  }
  const stale = f.inputStale === '1';
  return {
    target: int(f.aimdTarget) ?? fallbackTarget,
    changeAt: int(f.aimdChangeAt) ?? nowMs,
    decAt: int(f.aimdDecAt),
    decTo: int(f.aimdDecTo),
    sample: int(f.aimdSample),
    staleSince: stale ? (int(f.inputStaleAt) ?? nowMs) : null,
    freshSince: stale ? int(f.inputFreshAt) : null,
    staleKinds: f.inputStaleKinds ? f.inputStaleKinds.split(',').filter(Boolean) : [],
    recoveredAt: int(f.aimdRecoveredAt),
    budgetHoldAt: int(f.budgetHoldAt),
    budgetSeen: seen,
    seatStoreDown: f.seatStoreDown === '1',
    seatStoreCutAt: int(f.seatStoreCutAt),
    budgetHoldCutAt: int(f.budgetHoldCutAt),
    manualEndedAt: int(f.manualEndedAt),
    lastDecrease: f.lastDecrease || null,
  };
}

/** 저장된 칸(원문)과 다른 칸만(Lua가 쓴다). 칸이 없는 새 회차는 처음에 모두 쓴다 */
export function changedFields(before: Readonly<Record<string, string | null | undefined>>, after: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(after)) if (before[k] !== v) out[k] = v;
  return out;
}

export interface Pg {
  key: string;
  tps: number;
}

/** 결제사 동시 입장 상한 = 승인 상한 × 평균 체류 ÷ 결제 비율 × 안전 계수(ADR-0129 중간-027) */
export function pgTargetCapOf(tps: number): number {
  return Math.floor((tps * AVG_STAY_S) / PG_PAY_RATIO * PG_SAFETY_FACTOR);
}
/** 결제사 전진 속도 상한 = 승인 상한 ÷ 결제 비율 */
export function pgRateCapOf(tps: number): number {
  return Math.floor(tps / PG_PAY_RATIO);
}
/** 동시 입장 목표의 안전 범위: 상한은 8,000과 결제사 상한 중 낮은 값, 하한은 1,000과 그 상한의 절반 중 낮은 값(POL-021 명령 1) */
export function boundsOf(pgTps: number | undefined): { upper: number; lower: number } {
  const upper = pgTps === undefined ? MAX_TARGET : Math.min(MAX_TARGET, pgTargetCapOf(pgTps));
  return { upper, lower: Math.min(MIN_TARGET_BASE, Math.floor(upper / 2)) };
}

export interface ShareRow {
  id: string;
  want: number;
  demand: number;
}

/**
 * 상한을 나눈다(ADR-0226 결정 10). 목표의 합은 언제나 상한 안이다(POL-010, 정본 §5).
 * 수요 합이 상한 안이면 수요를 먼저 다 주고, 남는 자리를 아직 쓰지 않은 몫(목표 − 수요)에 비례해 더 준다. 넘으면 수요에 비례해 나누고, 기다리는 사람이 있는 회차의 몫은 1 이상이다
 */
export function shareTargets(rows: readonly ShareRow[], cap: number): Map<string, number> {
  const out = new Map<string, number>();
  const need = (r: ShareRow) => Math.min(r.demand, r.want);
  const sum = rows.reduce((a, r) => a + need(r), 0);
  if (sum <= cap) {
    const left = cap - sum;
    const roomSum = rows.reduce((a, r) => a + (r.want - need(r)), 0);
    for (const r of rows) {
      const room = r.want - need(r);
      out.set(r.id, need(r) + (roomSum <= left ? room : Math.floor((left * room) / roomSum)));
    }
    return out;
  }
  for (const r of rows) out.set(r.id, Math.floor((cap * need(r)) / sum));
  const total = () => [...out.values()].reduce((a, v) => a + v, 0);
  for (const r of rows) {
    if (need(r) === 0 || out.get(r.id) !== 0) continue;
    if (total() >= cap) {
      // 가장 큰 몫에서 하나를 옮긴다. 옮길 곳이 없으면(상한이 회차 수보다 작다) 상한이 먼저다
      const [topId, topValue] = [...out.entries()].reduce((a, b) => (b[1] > a[1] ? b : a));
      if (topValue <= 1) continue;
      out.set(topId, topValue - 1);
    }
    out.set(r.id, 1);
  }
  return out;
}

/** 전진 속도 상한(초당)을 수요에 비례해 나눈다. 소수를 그대로 돌려 합이 상한을 넘지 않는다(주기로 바꾸는 쪽이 소수 몫을 쌓는다). 수요 합이 0이면 똑같이 나눈다 */
export function shareRate(rows: readonly ShareRow[], rate: number): Map<string, number> {
  const out = new Map<string, number>();
  const sum = rows.reduce((a, r) => a + r.demand, 0);
  for (const r of rows) out.set(r.id, sum === 0 ? rate / rows.length : (rate * r.demand) / sum);
  return out;
}

/** 지금 쓰는 인원(입장 자리 + 곧 입장 + 오는 중) */
const inUseOf = (last: { slots: number; soon: number; inFlight: number }): number => last.slots + last.soon + last.inFlight;

/**
 * 나누기에 쓰는 수요(ADR-0226 결정 10). 처음 보는 회차는 목표 전체다.
 * 매진·판매 종료는 0이다(부를 사람이 없고, 들어온 사람도 살 좌석이 없다). 일시 매진은 지금 쓰는 인원이다(들어온 사람이 홀드와 결제로 부하를 낸다, ADR-0122)
 */
export function demandOf(want: number, last: { waiting: number; slots: number; soon: number; inFlight: number; saleState?: string } | undefined): number {
  if (!last) return want;
  const state = last.saleState ?? 'ON_SALE';
  if (state === 'SOLD_OUT' || state === 'ENDED') return 0;
  if (state !== 'ON_SALE' || last.waiting === 0) return Math.min(want, inUseOf(last));
  return want;
}

/** 오픈 시각이 간격보다 가까운 쌍의 수 */
export function openGapViolationsOf(opens: readonly number[], gapMs: number): number {
  const sorted = [...opens].sort((a, b) => a - b);
  let count = 0;
  for (let i = 0; i < sorted.length; i += 1) for (let j = i + 1; j < sorted.length && sorted[j]! - sorted[i]! < gapMs; j += 1) count += 1;
  return count;
}

/** 저장된 AIMD 자기 목표. targetNow는 쓰지 않는다: 합산 나누기가 끝난 값이라 자기 목표로 굳으면 나누기가 풀려도 돌아오지 못한다(ADR-0226 결정 3) */
export const storedTarget = (f: Readonly<Record<string, string | null | undefined>>): number | null => int(f.aimdTarget);
