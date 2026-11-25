// 탈퇴 참여자 클라이언트: purchase-svc WithdrawalParticipantService.ProcessAccountWithdrawal·QuoteAccountWithdrawal(docs/api/proto/peaket/purchase/v1/account.proto,
// docs/features/identity.md §8 '탈퇴 참여자와 탈퇴 미룸의 첫 구현' '참여자 호출' '미사용 티켓 확인과 취소', ADR-0284, BUILD_ORDER PRF-169·PRF-174, I-T84 ③·I-T26 ①).
// 데드라인은 부르는 쪽이 준다(요청 경로 3초·고리 10초·견적 2초 [가정]). 내부 토큰(PEAKET_INTERNAL_GRPC_TOKEN)을 싣고 부르는 쪽 이름은 identity-svc다.
// 병합 확인과 같은 purchase-svc 차단기 안에서 부른다(main이 같은 의존성 이름의 차단기를 넘긴다). 꼴은 grpc-merge-checkers.ts다.
// 답의 state가 DONE·PENDING이 아니거나 모르는 이유가 있으면, 또 어떤 gRPC 오류·차단기 열림·기한 초과든 WithdrawalParticipantUnavailable이다(DONE으로 접지 않는다).
// 견적 답이 0 이상의 정수가 아니거나 금액이 맞지 않아도(공제액 + 환급액 ≠ 결제 금액) 같은 오류다(낮은 금액을 보이지 않는다).
// 주소가 없으면 local·ci만 '늘 DONE' 대역이고, 그 밖의 환경은 '늘 답하지 않음'이라 탈퇴가 늘 202다(시작 로그 경고).
// PEAKET_ENV가 없거나 빈 글이면 운영으로 본다(플랫폼 설정과 같은 닫힌 쪽 기본값, identity §8 '참여자 호출', BAT-010 리뷰 RV-01).
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { purchaseV1Account, ticketV1Ticket } from '@peaket/contracts/proto';
import { type CircuitBreaker, createGrpcClient, type GrpcLbProfile } from '@peaket/platform';
import {
  WITHDRAWAL_RETRY_DEADLINE_MS,
  type UnusedTicketsQuote,
  type WithdrawalParticipant,
  type WithdrawalParticipantAnswer,
  WithdrawalParticipantUnavailable,
} from '../domain/withdrawal.js';

/** 설명자를 읽는 선택지(받는 층과 같은 값: 필드 이름은 proto 그대로, enum은 이름, int64는 숫자, oneof 이름 칸) */
const PROTO_LOAD_OPTIONS: protoLoader.Options = { keepCase: true, longs: Number, enums: String, defaults: true, oneofs: true };
type Unary = (req: object, md: grpc.Metadata, opts: grpc.CallOptions, cb: (e: grpc.ServiceError | null, v?: Record<string, unknown>) => void) => grpc.ClientUnaryCall;
/** 차단기에서 쓰는 것만(main이 서비스 지표 저장소에 단 차단기를 넣는다) */
type Breaker = Pick<CircuitBreaker, 'run'>;

/** 주소 환경 값(host:port). 병합 확인과 같은 purchase-svc 주소다 */
export const PURCHASE_GRPC_URL_ENV = 'PEAKET_PURCHASE_GRPC_URL';
/** ticket-svc 참여자 주소(F-05-11) */
export const TICKET_GRPC_URL_ENV = 'PEAKET_TICKET_GRPC_URL';
/** purchase-svc에 싣는 호출자 머리(내부 gRPC, account.proto '부르는 쪽: identity-svc만') */
export const WITHDRAWAL_CALLER = 'identity-svc';
/** 참여자 이름(지표 participant·로그) */
export const PURCHASE_PARTICIPANT = 'purchase';
export const TICKET_PARTICIPANT = 'ticket-svc';

const STATES: Readonly<Record<string, 'DONE' | 'PENDING'>> = {
  WITHDRAWAL_PARTICIPANT_STATE_DONE: 'DONE',
  WITHDRAWAL_PARTICIPANT_STATE_PENDING: 'PENDING',
};
const REASONS: Readonly<Record<string, string>> = {
  WITHDRAWAL_PENDING_REASON_PAYMENT_PENDING_ORDER: 'PAYMENT_PENDING_ORDER',
  WITHDRAWAL_PENDING_REASON_DEPOSIT_CANCEL_PENDING: 'DEPOSIT_CANCEL_PENDING',
  WITHDRAWAL_PENDING_REASON_TICKET_REFUND_PENDING: 'TICKET_REFUND_PENDING',
};

/**
 * 응답 → 답. state가 DONE·PENDING이 아니거나(UNSPECIFIED·모르는 값) 이유 가운데 모르는 값(UNSPECIFIED 포함)이 있으면 던진다.
 * DONE인데 이유가 실려 오면 모순된 답이라 던진다(DONE으로 접지 않는다). PENDING인데 이유가 비었으면 PENDING 그대로다(미루는 쪽이라 안전하다)
 */
export function toWithdrawalAnswer(r: Record<string, unknown>): WithdrawalParticipantAnswer {
  const state = STATES[String(r.state ?? '')];
  if (!state) throw new WithdrawalParticipantUnavailable(PURCHASE_PARTICIPANT, new Error(`모르는 state ${String(r.state)}`));
  const reasons: string[] = [];
  for (const raw of Array.isArray(r.reasons) ? (r.reasons as unknown[]) : []) {
    const reason = REASONS[String(raw)];
    if (!reason) throw new WithdrawalParticipantUnavailable(PURCHASE_PARTICIPANT, new Error(`모르는 이유 ${String(raw)}`));
    if (!reasons.includes(reason)) reasons.push(reason);
  }
  if (state === 'DONE') {
    if (reasons.length > 0) throw new WithdrawalParticipantUnavailable(PURCHASE_PARTICIPANT, new Error('DONE인데 이유가 있다'));
    return { state: 'DONE' };
  }
  return { state: 'PENDING', reasons };
}

export interface GrpcWithdrawalParticipantOptions {
  /** host:port */
  address: string;
  /** 설정의 grpcLbProfile(기본 service) */
  profile?: GrpcLbProfile;
  /** purchase-svc 차단기(병합 확인과 같은 것). 없으면 차단기 없이 부른다 */
  breaker?: Breaker;
}

/**
 * 견적 답 → 값(identity §8 '미사용 티켓 확인과 취소' 확인(견적)). 여섯 칸이 모두 0 이상의 정수이고
 * 공제액 + 환급액이 결제 금액과 같아야 한다. 아니면 모르는 답이라 WithdrawalParticipantUnavailable이다(빠뜨린 채 낮은 금액을 보이지 않는다)
 */
export function toUnusedTicketsQuote(r: Record<string, unknown>): UnusedTicketsQuote {
  const n = (key: string): number => {
    const v = r[key];
    return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : Number.NaN;
  };
  const quote: UnusedTicketsQuote = {
    count: n('unused_tickets'),
    ticketAmount: n('ticket_amount'),
    deductionAmount: n('deduction_amount'),
    refundAmount: n('refund_amount'),
    transferableCount: n('transferable_tickets'),
    deferredRefundCount: n('refund_deferred_tickets'),
  };
  const values = [quote.count, quote.ticketAmount, quote.deductionAmount, quote.refundAmount, quote.transferableCount, quote.deferredRefundCount];
  const bad =
    values.some((v) => !Number.isInteger(v)) ||
    quote.transferableCount > quote.count ||
    quote.deferredRefundCount > quote.count ||
    quote.deductionAmount + quote.refundAmount !== quote.ticketAmount ||
    // 0장이면 금액도 0이다(어긋난 답으로 낮은 금액을 보이지 않는다)
    (quote.count === 0 && (quote.ticketAmount !== 0 || quote.deductionAmount !== 0 || quote.refundAmount !== 0));
  if (bad) throw new WithdrawalParticipantUnavailable(PURCHASE_PARTICIPANT, new Error(`모르는 견적 ${JSON.stringify(r)}`));
  return quote;
}

export class GrpcWithdrawalParticipant implements WithdrawalParticipant {
  readonly name = PURCHASE_PARTICIPANT;
  readonly #client: grpc.Client & { ProcessAccountWithdrawal: Unary; QuoteAccountWithdrawal: Unary };

  constructor(private readonly o: GrpcWithdrawalParticipantOptions) {
    const def = protoLoader.fromJSON(purchaseV1Account as Parameters<typeof protoLoader.fromJSON>[0], PROTO_LOAD_OPTIONS);
    const pkg = (grpc.loadPackageDefinition(def) as unknown as { peaket: { purchase: { v1: { WithdrawalParticipantService: grpc.ServiceClientConstructor } } } }).peaket.purchase.v1;
    const at = o.address.lastIndexOf(':');
    const port = Number(o.address.slice(at + 1));
    if (at <= 0 || !Number.isInteger(port) || port <= 0 || port > 65_535) throw new Error(`${PURCHASE_GRPC_URL_ENV}는 host:port여야 한다: ${o.address}`);
    // 상한은 고리의 10초다(요청 경로는 호출마다 3초 데드라인을 건다. 요청 안이면 플랫폼 가로채기가 남은 시간과 짧은 쪽을 쓴다)
    this.#client = createGrpcClient(pkg.WithdrawalParticipantService, {
      host: o.address.slice(0, at),
      port,
      profile: o.profile ?? 'service',
      dependency: 'purchase-svc',
      timeoutCapMs: WITHDRAWAL_RETRY_DEADLINE_MS,
      caller: WITHDRAWAL_CALLER,
    }) as unknown as grpc.Client & { ProcessAccountWithdrawal: Unary; QuoteAccountWithdrawal: Unary };
  }

  /** 한 번 묻는다. gRPC 오류는 차단기 안에서 던져 차단기가 실패로 센다. 차단기 거절·gRPC 오류·모르는 답은 모두 WithdrawalParticipantUnavailable이다 */
  async process(accountId: string, o: { deadlineMs: number }): Promise<WithdrawalParticipantAnswer> {
    const v = await this.#call('ProcessAccountWithdrawal', accountId, o.deadlineMs);
    return toWithdrawalAnswer(v);
  }

  /** 탈퇴 전 미사용 티켓 견적(읽기 전용, 데드라인 2초 [가정]). 모르는 답·실패는 WithdrawalParticipantUnavailable이다 */
  async unusedTickets(accountId: string, o: { deadlineMs: number }): Promise<UnusedTicketsQuote | undefined> {
    const v = await this.#call('QuoteAccountWithdrawal', accountId, o.deadlineMs);
    return toUnusedTicketsQuote(v);
  }

  /** 한 번 부르고 답을 돌려준다(차단기 안). 실패는 모두 WithdrawalParticipantUnavailable이다 */
  async #call(method: 'ProcessAccountWithdrawal' | 'QuoteAccountWithdrawal', accountId: string, deadlineMs: number): Promise<Record<string, unknown>> {
    const ms = Math.max(1, Math.floor(Number.isFinite(deadlineMs) ? deadlineMs : WITHDRAWAL_RETRY_DEADLINE_MS));
    const call = () =>
      new Promise<Record<string, unknown>>((resolve, reject) => {
        this.#client[method]({ account_id: accountId }, new grpc.Metadata(), { deadline: new Date(Date.now() + ms) }, (e, v) => (e ? reject(e) : resolve(v ?? {})));
      });
    try {
      return await (this.o.breaker ? this.o.breaker.run(call) : call());
    } catch (e) {
      throw new WithdrawalParticipantUnavailable(this.name, e);
    }
  }

  close(): void {
    this.#client.close();
  }
}

/** local·ci 대역: 늘 DONE(purchase-svc 주소가 없는 시험·로컬 시제품) */
export const doneWithdrawalParticipant: WithdrawalParticipant = { name: PURCHASE_PARTICIPANT, process: async () => ({ state: 'DONE' }) };

/** 그 밖의 환경에서 주소가 없을 때: 늘 답하지 않는다(탈퇴가 늘 202다) */
export const unavailableWithdrawalParticipant: WithdrawalParticipant = {
  name: PURCHASE_PARTICIPANT,
  process: async () => {
    throw new WithdrawalParticipantUnavailable(PURCHASE_PARTICIPANT, new Error('주소가 설정에 없다'));
  },
};

const TICKET_STATES: Readonly<Record<string, 'DONE' | 'PENDING'>> = {
  WITHDRAWAL_PARTICIPANT_STATE_DONE: 'DONE',
  WITHDRAWAL_PARTICIPANT_STATE_PENDING: 'PENDING',
};
const TICKET_REASONS: Readonly<Record<string, string>> = {
  WITHDRAWAL_PENDING_REASON_TICKET_TRANSFER_PENDING: 'TICKET_TRANSFER_PENDING',
};

/** ticket-svc 답 → 참여자 답. 모르는 state·이유는 DONE으로 접지 않는다 */
export function toTicketWithdrawalAnswer(r: Record<string, unknown>): WithdrawalParticipantAnswer {
  const state = TICKET_STATES[String(r.state ?? '')];
  if (!state) throw new WithdrawalParticipantUnavailable(TICKET_PARTICIPANT, new Error(`모르는 state ${String(r.state)}`));
  const reasons: string[] = [];
  for (const raw of Array.isArray(r.reasons) ? (r.reasons as unknown[]) : []) {
    const reason = TICKET_REASONS[String(raw)];
    if (!reason) throw new WithdrawalParticipantUnavailable(TICKET_PARTICIPANT, new Error(`모르는 이유 ${String(raw)}`));
    if (!reasons.includes(reason)) reasons.push(reason);
  }
  if (state === 'DONE') return reasons.length > 0 ? { state: 'PENDING', reasons } : { state: 'DONE' };
  return { state: 'PENDING', reasons };
}

export class GrpcTicketWithdrawalParticipant implements WithdrawalParticipant {
  readonly name = TICKET_PARTICIPANT;
  readonly #client: grpc.Client & { ProcessAccountWithdrawal: Unary };

  constructor(private readonly o: { address: string; profile?: GrpcLbProfile; breaker?: Breaker }) {
    const def = protoLoader.fromJSON(ticketV1Ticket as Parameters<typeof protoLoader.fromJSON>[0], PROTO_LOAD_OPTIONS);
    const pkg = (grpc.loadPackageDefinition(def) as unknown as { peaket: { ticket: { v1: { WithdrawalParticipantService: grpc.ServiceClientConstructor } } } }).peaket.ticket.v1;
    const at = o.address.lastIndexOf(':');
    const port = Number(o.address.slice(at + 1));
    if (at <= 0 || !Number.isInteger(port) || port <= 0 || port > 65_535) throw new Error(`${TICKET_GRPC_URL_ENV}는 host:port여야 한다: ${o.address}`);
    this.#client = createGrpcClient(pkg.WithdrawalParticipantService, {
      host: o.address.slice(0, at),
      port,
      profile: o.profile ?? 'service',
      dependency: 'ticket-svc',
      timeoutCapMs: WITHDRAWAL_RETRY_DEADLINE_MS,
      caller: WITHDRAWAL_CALLER,
    }) as unknown as grpc.Client & { ProcessAccountWithdrawal: Unary };
  }

  async process(accountId: string, o: { deadlineMs: number }): Promise<WithdrawalParticipantAnswer> {
    const ms = Math.max(1, Math.floor(Number.isFinite(o.deadlineMs) ? o.deadlineMs : WITHDRAWAL_RETRY_DEADLINE_MS));
    const call = () =>
      new Promise<Record<string, unknown>>((resolve, reject) => {
        this.#client.ProcessAccountWithdrawal({ account_id: accountId, deadline_at_ms: Date.now() + ms }, new grpc.Metadata(), { deadline: new Date(Date.now() + ms) }, (e, v) => (e ? reject(e) : resolve(v ?? {})));
      });
    try {
      return toTicketWithdrawalAnswer(await (this.o.breaker ? this.o.breaker.run(call) : call()));
    } catch (e) {
      throw e instanceof WithdrawalParticipantUnavailable ? e : new WithdrawalParticipantUnavailable(this.name, e);
    }
  }

  close(): void {
    this.#client.close();
  }
}

export const unavailableTicketWithdrawalParticipant: WithdrawalParticipant = {
  name: TICKET_PARTICIPANT,
  process: async () => {
    throw new WithdrawalParticipantUnavailable(TICKET_PARTICIPANT, new Error('주소가 설정에 없다'));
  },
};

/**
 * 환경값으로 참여자 목록을 만든다. warnings: 대역을 쓴 참여자(시작 로그에 남긴다).
 * breakerOf: 의존성 이름마다 차단기를 준다(main이 병합 확인과 같은 purchase-svc 차단기를 준다). 대역에는 붙이지 않는다
 */
export function withdrawalParticipantsFromEnv(
  env: Record<string, string | undefined>,
  profile: GrpcLbProfile = 'service',
  breakerOf?: (dependency: 'purchase-svc' | 'ticket-svc') => Breaker,
): { participants: WithdrawalParticipant[]; warnings: string[]; clients: Array<{ close(): void }> } {
  // 값이 없거나 빈 글이면 운영이다: 환경 값과 주소가 함께 빠진 배포가 참여자를 건너뛰고 탈퇴를 끝내지 않게(열린 실패를 막는다, RV-01)
  const local = env.PEAKET_ENV === 'local' || env.PEAKET_ENV === 'ci';
  const participants: WithdrawalParticipant[] = [];
  const clients: Array<{ close(): void }> = [];
  const warnings: string[] = [];
  const purchaseAddr = env[PURCHASE_GRPC_URL_ENV];
  if (purchaseAddr) {
    const breaker = breakerOf?.('purchase-svc');
    const client = new GrpcWithdrawalParticipant({ address: purchaseAddr, profile, ...(breaker ? { breaker } : {}) });
    participants.push(client);
    clients.push(client);
  } else {
    warnings.push(`${PURCHASE_GRPC_URL_ENV}이 없어 purchase의 탈퇴 참여자를 ${local ? '늘 DONE인 대역으로' : '늘 답하지 않는 것으로(탈퇴가 늘 202)'} 둔다`);
    participants.push(local ? doneWithdrawalParticipant : unavailableWithdrawalParticipant);
  }
  // F-05-11 ticket-svc 참여자: local·ci에서 주소가 없으면 그 참여자를 빼고 경고만 남긴다.
  // 그 밖의 환경은 '늘 답하지 않는' 참여자로 두어 받은 티켓이 남은 채 탈퇴가 끝나지 않게 한다(identity §8).
  // purchase 주소조차 없는 옛 조립은 이 기능 전과 같은 한 참여자·한 경고를 유지한다
  const ticketAddr = env[TICKET_GRPC_URL_ENV];
  if (ticketAddr) {
    const breaker = breakerOf?.('ticket-svc');
    const client = new GrpcTicketWithdrawalParticipant({ address: ticketAddr, profile, ...(breaker ? { breaker } : {}) });
    participants.push(client);
    clients.push(client);
  } else if (purchaseAddr) {
    if (local) {
      warnings.push(`${TICKET_GRPC_URL_ENV}이 없어 ticket-svc 탈퇴 참여자를 뺀다(로컬·CI)`);
    } else {
      warnings.push(`${TICKET_GRPC_URL_ENV}이 없어 ticket-svc 탈퇴 참여자를 늘 답하지 않는 것으로 둔다(탈퇴가 늘 202)`);
      participants.push(unavailableTicketWithdrawalParticipant);
    }
  }
  return { participants, warnings, clients };
}
