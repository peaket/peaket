// 탈퇴 참여자 클라이언트: purchase-svc WithdrawalParticipantService.ProcessAccountWithdrawal(docs/api/proto/peaket/purchase/v1/account.proto,
// docs/features/identity.md §8 '탈퇴 참여자와 탈퇴 미룸의 첫 구현' '참여자 호출', ADR-0284, BUILD_ORDER PRF-169, I-T84 ③).
// 데드라인은 부르는 쪽이 준다(요청 경로 3초·고리 10초 [가정]). 내부 토큰(PEAKET_INTERNAL_GRPC_TOKEN)을 싣고 부르는 쪽 이름은 identity-svc다.
// 병합 확인과 같은 purchase-svc 차단기 안에서 부른다(main이 같은 의존성 이름의 차단기를 넘긴다). 꼴은 grpc-merge-checkers.ts다.
// 답의 state가 DONE·PENDING이 아니거나 모르는 이유가 있으면, 또 어떤 gRPC 오류·차단기 열림·기한 초과든 WithdrawalParticipantUnavailable이다(DONE으로 접지 않는다).
// 주소가 없으면 local·ci만 '늘 DONE' 대역이고, 그 밖의 환경은 '늘 답하지 않음'이라 탈퇴가 늘 202다(시작 로그 경고, 병합 확인과 같은 규칙).
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { purchaseV1Account } from '@peaket/contracts/proto';
import { type CircuitBreaker, createGrpcClient, type GrpcLbProfile } from '@peaket/platform';
import { WITHDRAWAL_RETRY_DEADLINE_MS, type WithdrawalParticipant, type WithdrawalParticipantAnswer, WithdrawalParticipantUnavailable } from '../domain/withdrawal.js';

/** 설명자를 읽는 선택지(받는 층과 같은 값: 필드 이름은 proto 그대로, enum은 이름, int64는 숫자, oneof 이름 칸) */
const PROTO_LOAD_OPTIONS: protoLoader.Options = { keepCase: true, longs: Number, enums: String, defaults: true, oneofs: true };
type Unary = (req: object, md: grpc.Metadata, opts: grpc.CallOptions, cb: (e: grpc.ServiceError | null, v?: Record<string, unknown>) => void) => grpc.ClientUnaryCall;
/** 차단기에서 쓰는 것만(main이 서비스 지표 저장소에 단 차단기를 넣는다) */
type Breaker = Pick<CircuitBreaker, 'run'>;

/** 주소 환경 값(host:port). 병합 확인과 같은 purchase-svc 주소다 */
export const PURCHASE_GRPC_URL_ENV = 'PEAKET_PURCHASE_GRPC_URL';
/** purchase-svc에 싣는 호출자 머리(내부 gRPC, account.proto '부르는 쪽: identity-svc만') */
export const WITHDRAWAL_CALLER = 'identity-svc';
/** 참여자 이름(지표 participant·로그) */
export const PURCHASE_PARTICIPANT = 'purchase';

const STATES: Readonly<Record<string, 'DONE' | 'PENDING'>> = {
  WITHDRAWAL_PARTICIPANT_STATE_DONE: 'DONE',
  WITHDRAWAL_PARTICIPANT_STATE_PENDING: 'PENDING',
};
const REASONS: Readonly<Record<string, string>> = {
  WITHDRAWAL_PENDING_REASON_PAYMENT_PENDING_ORDER: 'PAYMENT_PENDING_ORDER',
  WITHDRAWAL_PENDING_REASON_DEPOSIT_CANCEL_PENDING: 'DEPOSIT_CANCEL_PENDING',
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

export class GrpcWithdrawalParticipant implements WithdrawalParticipant {
  readonly name = PURCHASE_PARTICIPANT;
  readonly #client: grpc.Client & { ProcessAccountWithdrawal: Unary };

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
    }) as unknown as grpc.Client & { ProcessAccountWithdrawal: Unary };
  }

  /** 한 번 묻는다. gRPC 오류는 차단기 안에서 던져 차단기가 실패로 센다. 차단기 거절·gRPC 오류·모르는 답은 모두 WithdrawalParticipantUnavailable이다 */
  async process(accountId: string, o: { deadlineMs: number }): Promise<WithdrawalParticipantAnswer> {
    const ms = Math.max(1, Math.floor(Number.isFinite(o.deadlineMs) ? o.deadlineMs : WITHDRAWAL_RETRY_DEADLINE_MS));
    const call = () =>
      new Promise<Record<string, unknown>>((resolve, reject) => {
        this.#client.ProcessAccountWithdrawal({ account_id: accountId }, new grpc.Metadata(), { deadline: new Date(Date.now() + ms) }, (e, v) => (e ? reject(e) : resolve(v ?? {})));
      });
    let v: Record<string, unknown>;
    try {
      v = await (this.o.breaker ? this.o.breaker.run(call) : call());
    } catch (e) {
      throw new WithdrawalParticipantUnavailable(this.name, e);
    }
    return toWithdrawalAnswer(v);
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

/**
 * 환경값으로 참여자 목록을 만든다. warnings: 대역을 쓴 참여자(시작 로그에 남긴다).
 * breakerOf: 의존성 이름마다 차단기를 준다(main이 병합 확인과 같은 purchase-svc 차단기를 준다). 대역에는 붙이지 않는다
 */
export function withdrawalParticipantsFromEnv(
  env: Record<string, string | undefined>,
  profile: GrpcLbProfile = 'service',
  breakerOf?: (dependency: 'purchase-svc') => Breaker,
): { participants: WithdrawalParticipant[]; warnings: string[]; clients: GrpcWithdrawalParticipant[] } {
  const local = (env.PEAKET_ENV ?? 'local') === 'local' || env.PEAKET_ENV === 'ci';
  const addr = env[PURCHASE_GRPC_URL_ENV];
  if (addr) {
    const breaker = breakerOf?.('purchase-svc');
    const client = new GrpcWithdrawalParticipant({ address: addr, profile, ...(breaker ? { breaker } : {}) });
    return { participants: [client], warnings: [], clients: [client] };
  }
  const warnings = [`${PURCHASE_GRPC_URL_ENV}이 없어 purchase의 탈퇴 참여자를 ${local ? '늘 DONE인 대역으로' : '늘 답하지 않는 것으로(탈퇴가 늘 202)'} 둔다`];
  return { participants: [local ? doneWithdrawalParticipant : unavailableWithdrawalParticipant], warnings, clients: [] };
}
