// 결제사 선택과 결제창 준비의 값과 규칙(docs/features/payment.md §2.2 '선택기의 첫 구현', ADR-0044·0143, BUILD_ORDER PRF-190, 명세 specs/payment.qnt `selected`).
// 프레임워크·저장소·계약 패키지를 모른다(순수 값과 함수). 요청의 모양(proto 칸 이름·enum 앞머리)은 받는 층이 바꿔 넘긴다.
import { checkEntryOpensAt, isLowerUuid, PAYMENT_AMOUNT_MAX, PaymentInputError } from './confirm-command.js';
import { PAY_METHODS, type PayMethod, type PaymentGatewayPort, type PgName } from './payment-gateway.js';
import type { PaymentGateways } from './ports.js';
import { VIRTUAL_ACCOUNT_MIN_LEAD_MS } from './virtual-account.js';

/** 주문명 길이 상한 100자 [가정](토스 orderName 상한과 같다) */
export const ORDER_NAME_MAX_LENGTH = 100;
/** 토스 구매자 키 형식(영문·숫자와 - _ = . @, 2~50자) */
export const CUSTOMER_KEY = /^[A-Za-z0-9\-_=.@]{2,50}$/;
/** 토스가 비회원 결제에 쓰는 고정 값. 비회원을 한 값으로 묶지 않으므로 받지 않는다(§2.2) */
export const ANONYMOUS_CUSTOMER_KEY = 'ANONYMOUS';
/** 주문명에서 받지 않는 글자: 제어(Cc), 양방향 제어·폭 없는 문자를 포함한 서식(Cf), 줄·문단 구분자(Zl·Zp), 글자처럼 보이는 빈칸인 한글 채움 문자(BUILD_ORDER PRF-190 코드 리뷰) */
const ORDER_NAME_FORBIDDEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}ᅟᅠㅤﾠ]/u;
const PG_NAMES: readonly PgName[] = ['TOSS', 'PORTONE', 'SIMULATOR'];

/** pg_switch 한 행 */
export interface PgSwitchRow {
  /** 'PLATFORM' 또는 회차 ID */
  readonly scope: string;
  readonly active: boolean;
  /** 전환해 떠나는 결제사. 없으면 어느 기준 결제사든 전환한다 */
  readonly fromPg?: PgName;
  /** 옮겨 갈 결제사. 없으면 미리 지정한 대체 결제사다 */
  readonly toPg?: PgName;
  readonly version: number;
  readonly changedAtMs: number;
}

/** 회차 지정 사본(event_pg_config) */
export interface EventPgAssignment {
  readonly primary: PgName;
  readonly fallback?: PgName;
}

/** 저장소에서 읽는 고르기 재료. 없는 행은 칸이 없다 */
export interface PgSelectionState {
  readonly eventSwitch?: PgSwitchRow;
  readonly platformSwitch?: PgSwitchRow;
  readonly assignment?: EventPgAssignment;
}

/** 플랫폼 기본값(설정 PEAKET_PG_DEFAULT·PEAKET_PG_FALLBACK, 배포로만 바꾼다) */
export interface PgPlatformDefaults {
  readonly primary: PgName;
  readonly fallback?: PgName;
}

/** 채널 표의 한 줄 */
export interface PgChannel {
  /** 쓸 수 있는가. 서버 승인을 못 하는 어댑터는 거짓이다(POL-013) */
  readonly active: boolean;
  readonly payMethods: ReadonlySet<PayMethod>;
}

export type PgChannelTable = ReadonlyMap<PgName, PgChannel>;

export type PgUnavailableReason = 'NO_CHANNEL' | 'INACTIVE' | 'METHOD_UNSUPPORTED';

export type PgSelection = { readonly kind: 'SELECTED'; readonly pg: PgName; readonly switched: boolean; readonly channel: PgChannel } | { readonly kind: 'UNAVAILABLE'; readonly pg: PgName; readonly reason: PgUnavailableReason };

export interface PgSelectionInput extends PgSelectionState {
  readonly defaults: PgPlatformDefaults;
  readonly channels: PgChannelTable;
  readonly payMethod: PayMethod;
  /** 있으면 전환·지정을 보지 않고 이 결제사로 간다(멱등 재생, BUILD_ORDER PRF-191) */
  readonly pinnedPg?: PgName;
}

/** 고른 결제사를 쓸 수 없다(gRPC UNAVAILABLE, 글은 부르는 쪽이 가르는 이름 그대로) */
export class PaymentPgUnavailableError extends Error {
  readonly code = 'UNAVAILABLE' as const;
  constructor() {
    super('pg-unavailable');
    this.name = 'PaymentPgUnavailableError';
  }
}

/** 받는 층이 넘기는 값(검사 전). 칸이 없으면 빈 글·NaN·undefined다 */
export interface PrepareCheckoutInput {
  /** OrderKind에서 ORDER_KIND_를 뗀 이름 */
  readonly orderKind: string;
  readonly orderId: string;
  readonly attemptId: string;
  readonly eventId: string;
  readonly amount: number;
  readonly orderName: string;
  /** 비었으면 CARD다 */
  readonly payMethod: string;
  readonly customerKey?: string;
  readonly virtualAccountAllowed?: boolean;
  readonly entryOpensAtMs?: number;
  /** PgProvider에서 PG_PROVIDER_를 뗀 이름. 멱등 재생에서 그 시도의 결제사로 고정한다(BUILD_ORDER PRF-191). 비었으면 평소처럼 고른다 */
  readonly pinnedPg?: string;
}

/** 검사를 마친 결제창 준비 명령 */
export interface PrepareCheckoutCommand {
  readonly orderId: string;
  readonly attemptId: string;
  readonly eventId: string;
  readonly amount: number;
  readonly orderName: string;
  readonly payMethod: PayMethod;
  readonly customerKey?: string;
  readonly virtualAccountAllowed: boolean;
  readonly entryOpensAtMs?: number;
  /** 멱등 재생의 결제사 고정(BUILD_ORDER PRF-191) */
  readonly pinnedPg?: PgName;
}

/**
 * 결제사를 고른다(명세 `selected`). 전환 → 회차 지정 → 플랫폼 기본이고, 고른 결제사를 쓸 수 없으면 다른 결제사로 넘기지 않고 UNAVAILABLE이다.
 */
export function selectPg(input: PgSelectionInput): PgSelection {
  const base = input.assignment?.primary ?? input.defaults.primary;
  // 멱등 재생의 고정(BUILD_ORDER PRF-191): 전환·지정을 보지 않는다. switched는 기준 결제사와 다른지로 정해 처음 응답과 같게 둔다
  const pg = input.pinnedPg ?? switchTargetOf(input, base) ?? base;
  const channel = input.channels.get(pg);
  if (channel === undefined) return { kind: 'UNAVAILABLE', pg, reason: 'NO_CHANNEL' };
  if (!channel.active) return { kind: 'UNAVAILABLE', pg, reason: 'INACTIVE' };
  if (!channel.payMethods.has(input.payMethod)) return { kind: 'UNAVAILABLE', pg, reason: 'METHOD_UNSUPPORTED' };
  return { kind: 'SELECTED', pg, switched: pg !== base, channel };
}

/** 이 행이 기준 결제사의 전환인가(켜져 있고, 떠나는 결제사가 없거나 기준과 같다) */
const switchApplies = (row: PgSwitchRow | undefined, base: PgName): row is PgSwitchRow => row?.active === true && (row.fromPg === undefined || row.fromPg === base);

/** 전환이 옮겨 갈 결제사. 회차 행이 맞지 않으면 플랫폼 행으로 내려간다(BUILD_ORDER PRF-190 코드 리뷰). 맞는 행이 없거나 대체가 없으면 undefined다 */
function switchTargetOf(input: PgSelectionState & { readonly defaults: PgPlatformDefaults }, base: PgName): PgName | undefined {
  const row = [input.eventSwitch, input.platformSwitch].find((r) => switchApplies(r, base));
  if (row === undefined) return undefined;
  return row.toPg ?? (input.assignment ? input.assignment.fallback : input.defaults.fallback);
}

/** 그 회차가 쓸 결제사(전환 → 회차 지정 → 플랫폼 기본). 수단·채널 상태는 보지 않는다(BUILD_ORDER PRF-201) */
export function basePgOf(input: PgSelectionState & { readonly defaults: PgPlatformDefaults }): PgName {
  const base = input.assignment?.primary ?? input.defaults.primary;
  return switchTargetOf(input, base) ?? base;
}

/** 어댑터 등록부에서 채널 표를 만든다 */
export function channelTableOf(gateways: PaymentGateways): PgChannelTable {
  const table = new Map<PgName, PgChannel>();
  for (const pg of PG_NAMES) {
    const gateway = gateways.of(pg);
    if (gateway !== undefined) table.set(pg, channelOf(gateway));
  }
  return table;
}

/** 어댑터 하나의 채널 줄 */
export function channelOf(gateway: PaymentGatewayPort): PgChannel {
  const capabilities = gateway.capabilities();
  return { active: capabilities.serverConfirm, payMethods: new Set(capabilities.payMethods ?? PAY_METHODS) };
}

/**
 * 화면에 내도 되는 결제수단. 가상계좌는 부르는 쪽이 끄거나 계좌번호 암호화 키가 없거나 기한까지 2시간 [가정]이 남지 않으면 뺀다.
 */
export function allowedPayMethods(channel: PgChannel, o: { readonly virtualAccountAllowed: boolean; readonly virtualAccountReady: boolean; readonly depositDueAtMs: number; readonly nowMs: number }): PayMethod[] {
  const virtualAccount = o.virtualAccountAllowed && o.virtualAccountReady && o.depositDueAtMs >= o.nowMs + VIRTUAL_ACCOUNT_MIN_LEAD_MS;
  return PAY_METHODS.filter((method) => channel.payMethods.has(method) && (method !== 'VIRTUAL_ACCOUNT' || virtualAccount));
}

/** 결제창 복귀 주소(웹 paymentReturnUrls와 같은 모양, docs/frontend.md §5.3) */
export function checkoutReturnUrls(origin: string, eventId: string, orderId: string, pg: PgName): { successUrl: string; failUrl: string } {
  const url = `${origin}/booking/${encodeURIComponent(eventId)}/checkout/return?order=${encodeURIComponent(orderId)}&pg=${pg}`;
  return { successUrl: url, failUrl: url };
}

const isPayMethod = (value: string): value is PayMethod => (PAY_METHODS as readonly string[]).includes(value);

function uuidOf(value: string, field: string): string {
  if (!isLowerUuid(value)) throw new PaymentInputError(field);
  return value;
}

/**
 * 결제창 준비 입력 검사.
 * @throws PaymentInputError 입력이 틀림(field = proto 칸 이름)
 */
export function parsePrepareCheckoutInput(input: PrepareCheckoutInput): PrepareCheckoutCommand {
  // 굿즈의 복귀 주소가 정해지는 wbs 7.1.1까지 입장권만 받는다
  if (input.orderKind !== 'TICKET') throw new PaymentInputError('order_kind');
  const orderId = uuidOf(input.orderId, 'order_id');
  const attemptId = uuidOf(input.attemptId, 'attempt_id');
  const eventId = uuidOf(input.eventId, 'event_id');
  if (!(Number.isInteger(input.amount) && input.amount >= 1 && input.amount <= PAYMENT_AMOUNT_MAX)) throw new PaymentInputError('amount');
  const nameLength = [...input.orderName].length;
  if (nameLength < 1 || nameLength > ORDER_NAME_MAX_LENGTH || input.orderName.trim() === '' || ORDER_NAME_FORBIDDEN.test(input.orderName)) throw new PaymentInputError('order_name');
  const payMethod = input.payMethod === '' ? 'CARD' : input.payMethod;
  if (!isPayMethod(payMethod)) throw new PaymentInputError('pay_method');
  const { customerKey, entryOpensAtMs } = input;
  const pinned = input.pinnedPg === undefined || input.pinnedPg === '' || input.pinnedPg === 'UNSPECIFIED' ? undefined : input.pinnedPg;
  if (pinned !== undefined && !(PG_NAMES as readonly string[]).includes(pinned)) throw new PaymentInputError('pinned_pg');
  if (customerKey !== undefined && (!CUSTOMER_KEY.test(customerKey) || customerKey === ANONYMOUS_CUSTOMER_KEY)) throw new PaymentInputError('customer_key');
  checkEntryOpensAt(entryOpensAtMs);
  return {
    orderId,
    attemptId,
    eventId,
    amount: input.amount,
    orderName: input.orderName,
    payMethod,
    ...(customerKey === undefined ? {} : { customerKey }),
    virtualAccountAllowed: input.virtualAccountAllowed ?? true,
    ...(entryOpensAtMs === undefined ? {} : { entryOpensAtMs }),
    ...(pinned === undefined ? {} : { pinnedPg: pinned as PgName }),
  };
}
