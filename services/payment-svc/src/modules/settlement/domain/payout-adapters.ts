// 지급대행 어댑터의 순수 부분(토스 지급 웹훅 서명·상점별 설정·이용료 설정, 포트원 지급대행 설정, 잔액 원장).
// 서명 원문·설정 모양은 settlement §8과 ADR-0369 결정 2·5, 대사 규칙은 settlement §5.3·§5.5다(J-T6·J-T20·J-T25·J-T37 ⑤).
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { PayoutFailureClass, PayoutRecord, PgStore } from './settlement.js';
import { loadPortoneGatewayConfig } from '../../../config.js';

/** 토스 지급 한 건의 상한(10억 원 미만). settlement §5.2·J-T4 */
export const TOSS_PAYOUT_MAX_AMOUNT = 999_999_999;
/** 토스 지급 요청 하나에 담는 지급 건 수(요청당 20건). settlement §5.2 */
export const TOSS_PAYOUT_MAX_ITEMS = 20;

/** 10억 원 이상 정산서 지급액을 10억 원 미만 조각으로 나눈다(J-T4). */
export function splitTossPayoutAmount(amount: number): number[] {
  if (!Number.isSafeInteger(amount) || amount <= 0) return [];
  const out: number[] = [];
  let left = amount;
  while (left > TOSS_PAYOUT_MAX_AMOUNT) {
    out.push(TOSS_PAYOUT_MAX_AMOUNT);
    left -= TOSS_PAYOUT_MAX_AMOUNT;
  }
  out.push(left);
  return out;
}

/** 지급 건을 토스 요청당 20건으로 나눈다. 순서는 그대로 둔다. */
export function groupTossPayoutRequests(payouts: readonly PayoutRecord[]): PayoutRecord[][] {
  const out: PayoutRecord[][] = [];
  for (let i = 0; i < payouts.length; i += TOSS_PAYOUT_MAX_ITEMS) out.push(payouts.slice(i, i + TOSS_PAYOUT_MAX_ITEMS));
  return out;
}

export type TossFailureClass = PayoutFailureClass;

/**
 * 지급 건 FAILED의 세 갈래(settlement §12). 표에 없는 코드는 UNKNOWN으로 사람이 본다.
 * 코드 목록은 결제사 원문을 확인할 때 채운다(settlement §12 '결제사 오류 코드 표', 정리 목록 C-03 [가정]).
 */
export function classifyTossFailure(code: string): TossFailureClass {
  const c = code.trim().toUpperCase();
  if (/ACCOUNT|BANK.*(NOT_FOUND|CLOSED)|INVALID_ACCOUNT|DEPOSIT_ACCOUNT/.test(c)) return 'ACCOUNT';
  if (/MAINTENANCE|TEMPORARY|TIMEOUT|NETWORK|SYSTEM|TRY_AGAIN|PROCESSING/.test(c)) return 'TRANSIENT';
  if (/KYC|LIMIT|EXCEED|QUOTA/.test(c)) return 'LIMIT_KYC';
  return 'UNKNOWN';
}

/** 예약 날짜 오류 코드(지급일을 다음 은행 영업일로 바꿔 새 키로 한 번 다시 보낸다, settlement §12 날짜 오류 행). 목록은 [가정](정리 목록 C-03) */
export const TOSS_PAYOUT_DATE_ERRORS: ReadonlySet<string> = new Set(['INVALID_PAYOUT_DATE', 'INVALID_SCHEDULE_DATE', 'NOT_BUSINESS_DAY', 'PAYOUT_DATE_NOT_ALLOWED']);

export type TossSettlementEvent =
  | { kind: 'PAYOUT'; pgPayoutId: string; status: string; eventId: string | null }
  | { kind: 'SELLER'; tossSellerId: string; status: string; eventId: string | null }
  | { kind: 'IGNORED' };

/**
 * /v1/webhooks/toss의 정산 사건을 골라 읽는다. 본문 모양은 공개 웹훅 참조의 { eventType, createdAt, version, eventId, entityType, entityBody }이고
 * 지급 ID·셀러 ID는 entityBody.id다([가정], 시험 리뷰 TR-03). 본문의 상태는 참고만 하고 저장은 단건 조회 결과로 한다.
 * 모르는 사건·모양은 IGNORED이고, 알려진 사건인데 필수 칸이 없으면 null(400)이다.
 */
export function parseTossSettlementWebhook(rawBody: string): TossSettlementEvent | null {
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return null;
  }
  if (typeof body !== 'object' || body === null) return null;
  const b = body as Record<string, unknown>;
  const eventType = typeof b.eventType === 'string' ? b.eventType : typeof b.type === 'string' ? b.type : '';
  const record = (v: unknown): Record<string, unknown> | undefined => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);
  const entity = record(b.entityBody) ?? record(b.data);
  const eventId = typeof b.eventId === 'string' && b.eventId.trim() !== '' ? b.eventId : null;
  const status = typeof entity?.status === 'string' ? entity.status : undefined;
  if (eventType === 'payout.changed') {
    const pgPayoutId = typeof entity?.id === 'string' ? entity.id : typeof entity?.payoutId === 'string' ? entity.payoutId : undefined;
    return pgPayoutId && status ? { kind: 'PAYOUT', pgPayoutId, status, eventId } : null;
  }
  if (eventType === 'seller.changed') {
    const tossSellerId = typeof entity?.id === 'string' ? entity.id : typeof entity?.sellerId === 'string' ? entity.sellerId : undefined;
    return tossSellerId && status ? { kind: 'SELLER', tossSellerId, status, eventId } : null;
  }
  return { kind: 'IGNORED' };
}

export interface TossPayoutWebhookInput {
  /** v1: 뒤 base64. 키 교체 중이면 쉼표나 공백으로 이어 최대 4개 */
  signature: string | undefined;
  /** 보안 키(hex 글 그대로, 두 상점의 지금·옛 키) */
  secrets: readonly string[];
  /** raw body */
  body: string;
  /** tosspayments-webhook-transmission-time */
  transmissionTime: string;
  now: Date;
  /** 허용 시각 차이 [가정] 5분 */
  toleranceMs?: number;
}

export type TossWebhookVerdict = 'OK' | 'SIGNATURE_MISMATCH' | 'STALE';

/**
 * 토스 지급 웹훅 서명을 상수 시간으로 비교한다(settlement §8 웹훅 행, J-T6). 원문은 `{본문}:{전송 시각}`이고, 서명이 여럿이면 하나만 맞아도 받는다.
 * STALE은 서명이 맞고 전송 시각이 5분 넘게 다를 때만이다(서명이 틀리면 늦어도 SIGNATURE_MISMATCH, ADR-0369 결정 5).
 */
export function verifyTossPayoutSignature(input: TossPayoutWebhookInput): TossWebhookVerdict {
  if (!input.signature) return 'SIGNATURE_MISMATCH';
  const actual = input.signature
    .split(/[\s,]+/)
    .map((part) => part.replace(/^v1:/, '').trim())
    .filter(Boolean);
  const message = `${input.body}:${input.transmissionTime}`;
  const expected = input.secrets.map((secret) => createHmac('sha256', secret).update(message).digest('base64'));
  let matched = false;
  for (const a of actual) {
    for (const e of expected) {
      const ab = Buffer.from(a);
      const eb = Buffer.from(e);
      if (ab.length === eb.length && timingSafeEqual(ab, eb)) matched = true;
    }
  }
  if (!matched) return 'SIGNATURE_MISMATCH';
  const sent = Date.parse(input.transmissionTime);
  if (!Number.isFinite(sent)) return 'STALE';
  if (Math.abs(input.now.getTime() - sent) > (input.toleranceMs ?? 5 * 60_000)) return 'STALE';
  return 'OK';
}

/** 토스 지급대행 설정(ADR-0369 결정 2). 결제 상점마다 시크릿 키와 보안 키(32바이트, 첫째가 지금 키·나머지는 교체 중 옛 키) */
export interface TossPayoutConfig {
  stores: Partial<Record<PgStore, { secretKey: string; securityKeys: readonly Buffer[] }>>;
}

const SECURITY_KEY = /^[0-9a-fA-F]{64}$/;

/**
 * 환경 PEAKET_PG_TOSS_PAYOUT_SECRET_KEY_{STANDARD,ESCROW}·PEAKET_PG_TOSS_PAYOUT_SECURITY_KEYS_{STANDARD,ESCROW}(쉼표로 이은 64자 hex)에서 읽는다.
 * 두 상점 모두 비면 undefined, 한 상점이 반만 있거나 보안 키 모양이 틀리면 던진다. 메시지에 환경 이름은 있고 키 값은 없다.
 */
export function tossPayoutConfigured(env: Record<string, string | undefined>): TossPayoutConfig | undefined {
  const stores: { [K in PgStore]?: { secretKey: string; securityKeys: readonly Buffer[] } } = {};
  for (const store of ['STANDARD', 'ESCROW'] as const) {
    const secretName = `PEAKET_PG_TOSS_PAYOUT_SECRET_KEY_${store}`;
    const keysName = `PEAKET_PG_TOSS_PAYOUT_SECURITY_KEYS_${store}`;
    const secretKey = env[secretName]?.trim() ?? '';
    const rawKeys = env[keysName]?.trim() ?? '';
    if (secretKey === '' && rawKeys === '') continue;
    if (secretKey === '') throw new Error(`토스 지급대행 설정이 반만 있다: ${secretName}이 없다(${keysName}만 있다)`);
    if (rawKeys === '') throw new Error(`토스 지급대행 설정이 반만 있다: ${keysName}이 없다(${secretName}만 있다)`);
    const parts = rawKeys.split(',').map((k) => k.trim());
    if (parts.length === 0 || parts.some((k) => !SECURITY_KEY.test(k))) throw new Error(`${keysName}은 쉼표로 이은 64자 hex 보안 키여야 한다`);
    stores[store] = { secretKey, securityKeys: parts.map((k) => Buffer.from(k, 'hex')) };
  }
  return Object.keys(stores).length === 0 ? undefined : { stores };
}

/** 토스 지급대행 이용료 계약 조건(ADR-0369 결정 2). 기본값은 공개 안내 값(월 30만 원·무료 1,000건·건당 100원 [가정]) */
export interface TossPayoutTerms {
  feeMonthlyKrw: number;
  feeFreeCount: number;
  feePerItemKrw: number;
}

export const DEFAULT_TOSS_PAYOUT_TERMS: TossPayoutTerms = { feeMonthlyKrw: 300_000, feeFreeCount: 1_000, feePerItemKrw: 100 };

export function tossPayoutTerms(env: Record<string, string | undefined>): TossPayoutTerms {
  const read = (name: string, fallback: number): number => {
    const raw = env[name]?.trim();
    if (raw === undefined || raw === '') return fallback;
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) throw new Error(`${name}은 0 이상의 정수여야 한다`);
    return Number(raw);
  };
  return {
    feeMonthlyKrw: read('PEAKET_TOSS_PAYOUT_FEE_MONTHLY_KRW', DEFAULT_TOSS_PAYOUT_TERMS.feeMonthlyKrw),
    feeFreeCount: read('PEAKET_TOSS_PAYOUT_FEE_FREE_COUNT', DEFAULT_TOSS_PAYOUT_TERMS.feeFreeCount),
    feePerItemKrw: read('PEAKET_TOSS_PAYOUT_FEE_PER_ITEM_KRW', DEFAULT_TOSS_PAYOUT_TERMS.feePerItemKrw),
  };
}

// 포트원 출금 대사의 사실 모양·함수는 domain/portone-reconciliation.ts로, 예금주 이름 비교는 domain/holder-name.ts로 옮겼다(F-07-7 계획 I-03·I-13).

/** 지급대행 잔액 원장: 있어야 할 잔액 = 대사 완료 승인 − 취소·환불 − 결제사 수수료 − 완료 지급 − PEAKET 몫 인출(settlement §5.5). */
export function ledgerBalance(input: { approvedAmount: number; refundedAmount: number; pgFees: number; paidOut: number; peaketWithdrawn: number }): number {
  return input.approvedAmount - input.refundedAmount - input.pgFees - input.paidOut - input.peaketWithdrawn;
}

/** 포트원 지급대행(파트너 정산) 설정(F-07-7 계획 §5.1 (가), ADR-0370 결정 3). 주소·시크릿은 결제 포트원 설정과 같다 */
export interface PortonePayoutConfig {
  baseUrl: string;
  secret: string;
  contractId: string;
}

/**
 * PEAKET_PAYOUT_PORTONE_ENABLED가 true이고 PEAKET_PAYOUT_PORTONE_CONTRACT_ID와 결제 포트원 설정(loadPortoneGatewayConfig 규칙)이 함께 있을 때만 켠다.
 * ENABLED가 없거나 true가 아니면 undefined. ENABLED=true인데 계약 ID나 결제 포트원 설정이 없으면 던진다(시작 실패, 메시지에 환경 이름만 있고 값은 없다).
 */
export function portonePayoutConfigured(env: Record<string, string | undefined>): PortonePayoutConfig | undefined {
  if (env.PEAKET_PAYOUT_PORTONE_ENABLED?.trim() !== 'true') return undefined;
  const contractId = env.PEAKET_PAYOUT_PORTONE_CONTRACT_ID?.trim() ?? '';
  if (contractId === '') throw new Error('PEAKET_PAYOUT_PORTONE_ENABLED=true인데 PEAKET_PAYOUT_PORTONE_CONTRACT_ID가 없다');
  const gateway = loadPortoneGatewayConfig(env);
  if (!gateway) throw new Error('PEAKET_PAYOUT_PORTONE_ENABLED=true인데 결제 포트원 설정(PEAKET_PG_PORTONE_SECRET 등)이 없다');
  return { baseUrl: gateway.baseUrl, secret: gateway.secret, contractId };
}
