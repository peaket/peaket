// 결제 결과 기계(docs/frontend.md §3.6, ADR-0079 결정 8, ADR-0230). 조회 결과를 이벤트로 받아 화면 상태를 정한다. 기계는 값만 다루고 요청은 실행부(result-runtime)가 한다.
import { assign, setup } from 'xstate';

export type PayStatus = 'ACCEPTED' | 'RESERVED' | 'AWAITING_DEPOSIT' | 'APPROVED' | 'CONFIRMED' | 'FAILED' | 'UNKNOWN' | 'COMPENSATED';

export interface VirtualAccount {
  bank?: string;
  accountNumber?: string;
  dueAt?: string;
}

export interface ResultContext {
  reason?: string;
  account?: VirtualAccount;
  /** 결과 불명이 1시간 [가정]을 넘었다 */
  unknownLong: boolean;
}

export type ResultEvent =
  | { type: 'STATUS'; status: PayStatus; issueDelayed?: boolean; reason?: string; virtualAccount?: VirtualAccount }
  | { type: 'LONG' }
  | { type: 'UNKNOWN_HOUR' }
  | { type: 'NOT_ACCEPTED' }
  | { type: 'ORDER_EXPIRED' }
  | { type: 'GONE' };

type Status = Extract<ResultEvent, { type: 'STATUS' }>;
const is = (e: ResultEvent, status: PayStatus): boolean => e.type === 'STATUS' && e.status === status;

const onStatus = [
  { guard: 'confirmed', target: 'confirmed' },
  { guard: 'deposit', target: 'awaitingDeposit', actions: 'keepAccount' },
  { guard: 'failed', target: 'failed', actions: 'keepReason' },
  { guard: 'unknown', target: 'unknown' },
  { guard: 'compensated', target: 'compensated' },
  { guard: 'issuing', target: 'issuing' },
] as const;

/** 끝난 뒤에는 다시 묻지 않는 상태 */
export const FINISHED: ReadonlySet<string> = new Set(['confirmed', 'awaitingDeposit', 'failed', 'compensated', 'notAccepted', 'orderExpired', 'gone']);

const stop = { NOT_ACCEPTED: 'notAccepted', ORDER_EXPIRED: 'orderExpired', GONE: 'gone' } as const;

export const resultMachine = setup({
  types: { context: {} as ResultContext, events: {} as ResultEvent },
  guards: {
    confirmed: ({ event }) => is(event, 'CONFIRMED'),
    deposit: ({ event }) => is(event, 'AWAITING_DEPOSIT'),
    failed: ({ event }) => is(event, 'FAILED'),
    unknown: ({ event }) => is(event, 'UNKNOWN'),
    compensated: ({ event }) => is(event, 'COMPENSATED'),
    issuing: ({ event }) => is(event, 'APPROVED') && (event as Status).issueDelayed === true,
  },
  actions: {
    keepAccount: assign({ account: ({ event }) => (event as Status).virtualAccount }),
    keepReason: assign({ reason: ({ event }) => (event as Status).reason }),
    markHour: assign({ unknownLong: true }),
  },
}).createMachine({
  id: 'paymentResult',
  initial: 'checking',
  context: { unknownLong: false },
  states: {
    checking: { on: { STATUS: [...onStatus], LONG: 'checkingLong', ...stop } },
    checkingLong: { on: { STATUS: [...onStatus], ...stop } },
    issuing: { on: { STATUS: [...onStatus], ...stop } },
    unknown: { on: { STATUS: [...onStatus], UNKNOWN_HOUR: { actions: 'markHour' }, ...stop } },
    confirmed: {},
    awaitingDeposit: {},
    failed: {},
    compensated: {},
    notAccepted: {},
    orderExpired: {},
    gone: {},
  },
});

/** 접수부터 잰 시간과 화면 상태로 다음 조회까지의 시간(§3.6). 묻지 않으면 null */
export function nextPollMs(state: string, elapsedMs: number, visible: boolean, random: () => number = Math.random): number | null {
  if (FINISHED.has(state)) return null;
  const quick = state !== 'unknown' && elapsedMs < 120_000;
  if (quick) return 500 + random() * 1000;
  if (!visible || elapsedMs >= 600_000) return null;
  return 30_000;
}

export type StatusOutcome = { kind: 'refresh' } | { kind: 'retry' } | { kind: 'event'; event: ResultEvent };

/** 조회 실패 → 다음 할 일(openapi getOrderPaymentStatus 응답표). 결과 확인에는 구매 세션 서명이 없다 */
export function statusOutcome(e: { status?: number; type?: string }): StatusOutcome {
  if (e.status === 401) return { kind: 'refresh' };
  if (e.status === 404) return { kind: 'event', event: { type: 'GONE' } };
  if (e.status === 409 && e.type === 'payment-not-accepted') return { kind: 'event', event: { type: 'NOT_ACCEPTED' } };
  if (e.status === 409 && e.type === 'order-expired') return { kind: 'event', event: { type: 'ORDER_EXPIRED' } };
  return { kind: 'retry' };
}
