// 결제사 웹훅 받기의 규칙(docs/features/payment.md §5 '웹훅 받기의 첫 구현', docs/data.md §5, BUILD_ORDER HOT-150, ADR-0029 결정 5, 명세 specs/payment.qnt `query`).
// 웹훅은 결제 결과가 아니라 단독 조회를 부르는 신호다. 여기의 판단은 원장의 값만 보고 본문의 상태·금액을 보지 않는다.
import type { PaymentLedgerStatus } from './confirm-command.js';
import type { PgName } from './payment-gateway.js';

/** 받는 경로(POST /v1/webhooks/{toss|portone}) */
export type WebhookRoute = 'toss' | 'portone';

/** 본문 상한 64KB [가정](docs/verification.md §4.1). 라우트의 @BodyLimit이 해석 전에 막는다 */
export const WEBHOOK_MAX_BODY_BYTES = 64 * 1024;
/** 앱 포트가 요청 하나를 다 받는 시한 5초 [가정]. 이 포트의 HTTP 경로는 웹훅뿐이다(업무 호출은 gRPC) */
export const WEBHOOK_REQUEST_TIMEOUT_MS = 5_000;
/** 수신 기록 보관 7일 [가정](토스 재전송 최대 약 3.8일보다 길다) */
export const WEBHOOK_RECEIPT_RETENTION_MS = 7 * 24 * 3_600_000;
/** 수신 기록을 한 번에 지우는 수 1만 건 [가정] */
export const WEBHOOK_RECEIPT_DELETE_BATCH = 10_000;
/** 문장 시간 한도 2초 [가정](찾기 하나·수신 기록·조회 신호의 문장 셋 + 풀 대기 1초 [가정] = 최악 7초로 토스 응답 기한 10초 안) */
export const WEBHOOK_STATEMENT_TIMEOUT_MS = 2_000;
/** 결제 하나에 조회 신호를 쓰는 최소 간격 5초 [가정]. 직전 신호나 실행기의 잡기로부터 잰다(전송 ID만 바꾼 반복이 결제사 조회를 늘리지 못하게) */
export const WEBHOOK_QUERY_SIGNAL_MIN_INTERVAL_MS = 5_000;
/** 거절 로그의 문: 파드에서 경로·사유마다 1분에 한 줄 [가정]. 건수는 지표가 센다 */
export const WEBHOOK_REJECT_LOG_INTERVAL_MS = 60_000;

/** payment_webhook_received_total의 outcome(docs/observability.md) */
export const PAYMENT_WEBHOOK_OUTCOMES = ['query_signal', 'query_signal_skipped', 'state_ignored', 'duplicate', 'ledger_not_found', 'pg_mismatch', 'invalid', 'ignored', 'no_adapter', 'store_failed'] as const;
export type PaymentWebhookOutcome = (typeof PAYMENT_WEBHOOK_OUTCOMES)[number];

/** 웹훅이 찾은 원장 행(판단에 쓰는 칸만) */
export interface WebhookLedgerRow {
  readonly paymentId: string;
  readonly orderId: string;
  readonly pg: PgName;
  readonly status: PaymentLedgerStatus;
}

/** 원장을 본 판단 */
export type WebhookDecision =
  /** 원장에 없다(승인 명령보다 먼저 온 웹훅). 서명을 본 경로만 수신 기록을 남긴다 */
  | { readonly kind: 'LEDGER_NOT_FOUND' }
  /** 경로의 결제사와 원장의 결제사가 다르다. 조회하지 않는다(서명을 본 경로면 SEV2, 서명 없는 경로면 SEV3) */
  | { readonly kind: 'PG_MISMATCH'; readonly orderId: string; readonly ledgerPg: PgName }
  /** UNKNOWN이라 다음 조회를 지금으로 당긴다 */
  | { readonly kind: 'QUERY_SIGNAL'; readonly paymentId: string; readonly orderId: string }
  /** 그 밖의 상태. 지표만 남긴다(가상계좌·취소는 HOT-151·152) */
  | { readonly kind: 'STATE_IGNORED'; readonly paymentId: string; readonly orderId: string };

const PORTONE_ONLY: readonly PgName[] = ['PORTONE'];
const TOSS_ONLY: readonly PgName[] = ['TOSS'];
const TOSS_OR_SIMULATOR: readonly PgName[] = ['TOSS', 'SIMULATOR'];

/** 그 경로로 받는 결제사. allowSimulator는 local·ci에서만 참이다(시뮬레이터가 토스 모양이고 원장 pg가 SIMULATOR다) */
export function webhookRoutePgs(route: WebhookRoute, allowSimulator: boolean): readonly PgName[] {
  if (route === 'portone') return PORTONE_ONLY;
  return allowSimulator ? TOSS_OR_SIMULATOR : TOSS_ONLY;
}

/** 서명으로 보낸 쪽을 확인하는 경로인가. 아닌 경로(토스)의 요청은 누구나 만들 수 있다 */
export function webhookRouteSigned(route: WebhookRoute): boolean {
  return route === 'portone';
}

/** 이 경로의 INVALID만 4xx로 거절한다: 서명을 쓰는 경로다(P-T17) */
export function webhookRouteRejects(route: WebhookRoute): boolean {
  return webhookRouteSigned(route);
}

/**
 * 찾은 원장 행으로 할 일을 정한다. 경로 대조가 상태보다 먼저다.
 * @param row 찾은 원장 행. 없으면 undefined
 * @param allowedPgs 그 경로로 받는 결제사(webhookRoutePgs)
 */
export function decideWebhookLedger(row: WebhookLedgerRow | undefined, allowedPgs: readonly PgName[]): WebhookDecision {
  if (row === undefined) return { kind: 'LEDGER_NOT_FOUND' };
  if (!allowedPgs.includes(row.pg)) return { kind: 'PG_MISMATCH', orderId: row.orderId, ledgerPg: row.pg };
  return { kind: row.status === 'UNKNOWN' ? 'QUERY_SIGNAL' : 'STATE_IGNORED', paymentId: row.paymentId, orderId: row.orderId };
}
