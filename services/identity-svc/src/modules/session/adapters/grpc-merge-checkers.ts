// 세 서비스의 CheckAccountMerge 클라이언트(purchase/v1/account.proto·ticket/v1/ticket.proto·core/v1/core.proto, identity §2.1 '계정 병합의 첫 구현', BUILD_ORDER BOT-042).
// 호출마다 기한 1초 [가정]. 답이 없거나 기한을 넘기면 MergeCheckUnavailable(제안은 만들지 않고 확정은 503).
// 서비스마다 따로 차단기를 둔다(docs/architecture.md §5 '2차 서비스 내부 차단', BOT-042·BOT-111이 넘긴 것). 열렸거나 동시 호출 상한이 차면 부르지 않고 같은 MergeCheckUnavailable이다.
// 주소가 설정에 없으면: 로컬·CI는 막는 것이 없다고 보는 대역(그 서비스가 생기기 전 시험용), 운영·데모는 늘 답하지 않는 것으로 본다.
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { coreV1Core, purchaseV1Account, ticketV1Ticket } from '@peaket/contracts/proto';
import { type CircuitBreaker, type CircuitBreakerOptions, createGrpcClient, type GrpcLbProfile } from '@peaket/platform';
import { type CheckBlock, type CheckResult, MERGE_CHECK_DEADLINE_MS } from '../domain/merge.js';
import { type MergeChecker, MergeCheckUnavailable } from '../domain/ports.js';

/** 설명자를 읽는 선택지(받는 층과 같은 값: 필드 이름은 proto 그대로, enum은 이름, int64는 숫자, oneof 이름 칸) */
const PROTO_LOAD_OPTIONS: protoLoader.Options = { keepCase: true, longs: Number, enums: String, defaults: true, oneofs: true };

type Service = MergeChecker['service'];
/** 차단기에서 쓰는 것만(main이 서비스 지표 저장소에 단 차단기를 넣는다) */
type Breaker = Pick<CircuitBreaker, 'run'>;

/**
 * 세 서비스 차단기의 설정 [가정](docs/architecture.md §5 '2차 서비스 내부 차단', identity §2.1 '계정 병합의 첫 구현'). 창·실패율·열린 시간은 공용 기본값(10초·50%·5초)이다.
 * 병합 확인은 드문 호출이라 판정 문턱을 기본 20건보다 낮은 5건으로 둔다(기본이면 서비스가 내려가도 거의 열리지 않는다).
 * 파드마다 서비스별 동시 호출 상한(벌크헤드)은 50건이다(호출 한 건이 1초 기한이라 초당 50건까지. 로그인 수단 추가·확정은 몰리는 경로가 아니다)
 */
export const MERGE_CHECK_BREAKER: Readonly<Pick<CircuitBreakerOptions, 'minCalls' | 'maxConcurrent'>> = Object.freeze({ minCalls: 5, maxConcurrent: 50 });
type Unary = (req: object, md: grpc.Metadata, opts: grpc.CallOptions, cb: (e: grpc.ServiceError | null, v?: Record<string, unknown>) => void) => grpc.ClientUnaryCall;

const DESCRIPTORS: Record<Service, { json: unknown; pkg: string[] }> = {
  purchase: { json: purchaseV1Account, pkg: ['peaket', 'purchase', 'v1'] },
  ticket: { json: ticketV1Ticket, pkg: ['peaket', 'ticket', 'v1'] },
  core: { json: coreV1Core, pkg: ['peaket', 'core', 'v1'] },
};

const REASONS: Record<Service, readonly string[]> = {
  purchase: ['SEAT_HOLD', 'PURCHASE_SESSION', 'PAYMENT_PENDING_ORDER'],
  ticket: ['ABSORBED_HAS_TICKETS', 'TICKET_IN_ENTRY_WINDOW'],
  core: ['ABSORBED_HAS_REVIEWS', 'LIMITED_MERCH_OVER_LIMIT'],
};

/** 응답을 CheckResult로. 모르는 사유는 버리지 않고 '응답이 틀렸다'로 본다(놓치면 막아야 할 병합을 통과시킨다) */
export function toCheckResult(service: Service, r: Record<string, unknown>): CheckResult {
  const blocks: CheckBlock[] = [];
  for (const b of Array.isArray(r.blocks) ? (r.blocks as Record<string, unknown>[]) : []) {
    const reason = String(b.reason ?? '').replace(/^MERGE_BLOCK_REASON_/, '');
    if (!REASONS[service].includes(reason)) throw new MergeCheckUnavailable(service, new Error(`모르는 사유 ${reason}`));
    blocks.push({ service, reason } as CheckBlock);
  }
  const n = (k: string) => (typeof r[k] === 'number' ? (r[k] as number) : 0);
  const counts: CheckResult['counts'] =
    service === 'purchase' ? { orders: n('absorbed_orders') } : service === 'core' ? { wishes: n('absorbed_wishes'), subscriptions: n('absorbed_subscriptions'), addresses: n('absorbed_addresses') } : {};
  return { blocks, counts };
}

export class GrpcMergeChecker implements MergeChecker {
  readonly #client: grpc.Client & { CheckAccountMerge: Unary };

  /**
   * address: host:port. 클라이언트는 플랫폼 함수로 만든다(부하 분산 프로필·추적·의존 로그·데드라인 상한, 새 맥락 리뷰 중간 5).
   * breaker: 이 서비스의 차단기(없으면 차단기 없이 부른다)
   */
  constructor(
    readonly service: Service,
    address: string,
    profile: GrpcLbProfile = 'service',
    private readonly breaker?: Breaker,
  ) {
    const d = DESCRIPTORS[service];
    const def = protoLoader.fromJSON(d.json as Parameters<typeof protoLoader.fromJSON>[0], PROTO_LOAD_OPTIONS);
    let node = grpc.loadPackageDefinition(def) as unknown as Record<string, unknown>;
    for (const p of d.pkg) node = node[p] as Record<string, unknown>;
    const Ctor = node.AccountMergeCheckService as grpc.ServiceClientConstructor;
    const at = address.lastIndexOf(':');
    const port = Number(address.slice(at + 1));
    if (at <= 0 || !Number.isInteger(port) || port <= 0) throw new Error(`CheckAccountMerge 주소는 host:port여야 한다: ${address}`);
    this.#client = createGrpcClient(Ctor, { host: address.slice(0, at), port, profile, dependency: `${service}-svc`, timeoutCapMs: MERGE_CHECK_DEADLINE_MS }) as unknown as grpc.Client & { CheckAccountMerge: Unary };
  }

  /**
   * 한 번 묻는다. gRPC 오류는 차단기 안에서 던져 차단기가 실패로 센다(플랫폼 isBreakerFailure: 서버 쪽 실패 코드만).
   * 차단기가 부르지 않은 거절(열림 503·동시 호출 상한 429·남은 시간 없음 504)과 gRPC 오류는 모두 MergeCheckUnavailable이다
   */
  async check(i: { primaryAccountId: string; absorbedAccountId: string }): Promise<CheckResult> {
    let v: Record<string, unknown> | undefined;
    try {
      v = await (this.breaker ? this.breaker.run(() => this.#call(i)) : this.#call(i));
    } catch (e) {
      throw new MergeCheckUnavailable(this.service, e);
    }
    return toCheckResult(this.service, v ?? {});
  }

  #call(i: { primaryAccountId: string; absorbedAccountId: string }): Promise<Record<string, unknown> | undefined> {
    return new Promise((res, rej) => {
      this.#client.CheckAccountMerge({ primary_account_id: i.primaryAccountId, absorbed_account_id: i.absorbedAccountId }, new grpc.Metadata(), { deadline: Date.now() + MERGE_CHECK_DEADLINE_MS }, (e, v) => (e ? rej(e) : res(v)));
    });
  }

  close(): void {
    this.#client.close();
  }
}

/** 로컬·CI 대역: 막는 것이 없다고 본다(그 서비스가 생기기 전 시험용) */
export const noBlockChecker = (service: Service): MergeChecker => ({ service, check: async () => ({ blocks: [], counts: {} }) });

/** 운영·데모에서 주소가 없을 때: 늘 답하지 않는다(병합을 만들지도 확정하지도 않는다) */
export const unavailableChecker = (service: Service): MergeChecker => ({
  service,
  check: async () => {
    throw new MergeCheckUnavailable(service, new Error('주소가 설정에 없다'));
  },
});

const ENV: Record<Service, string> = { purchase: 'PEAKET_PURCHASE_GRPC_URL', ticket: 'PEAKET_TICKET_GRPC_URL', core: 'PEAKET_CORE_GRPC_URL' };

/**
 * 환경값으로 세 확인기를 만든다. warnings: 대역을 쓴 서비스(시작 로그에 남긴다).
 * breakerOf: 의존성 이름(purchase-svc·ticket-svc·core-svc)마다 차단기를 준다(main이 MERGE_CHECK_BREAKER로 만든다). 대역에는 붙이지 않는다
 */
export function mergeCheckersFromEnv(env: Record<string, string | undefined>, profile: GrpcLbProfile = 'service', breakerOf?: (dependency: `${Service}-svc`) => Breaker): { checkers: MergeChecker[]; warnings: string[] } {
  const local = (env.PEAKET_ENV ?? 'local') === 'local' || env.PEAKET_ENV === 'ci';
  const warnings: string[] = [];
  const checkers = (['purchase', 'ticket', 'core'] as const).map((s) => {
    const addr = env[ENV[s]];
    if (addr) return new GrpcMergeChecker(s, addr, profile, breakerOf?.(`${s}-svc`));
    warnings.push(`${ENV[s]}이 없어 ${s}의 CheckAccountMerge를 ${local ? '막는 것이 없다고 보는 대역으로' : '늘 답하지 않는 것으로'} 둔다`);
    return local ? noBlockChecker(s) : unavailableChecker(s);
  });
  return { checkers, warnings };
}
