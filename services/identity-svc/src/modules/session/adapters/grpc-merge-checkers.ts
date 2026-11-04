// 세 서비스의 CheckAccountMerge 클라이언트(purchase/v1/account.proto·ticket/v1/ticket.proto·core/v1/core.proto, identity §2.1 '계정 병합의 첫 구현', BUILD_ORDER BOT-042).
// 호출마다 기한 1초 [가정]. 답이 없거나 기한을 넘기면 MergeCheckUnavailable(제안은 만들지 않고 확정은 503).
// 주소가 설정에 없으면: 로컬·CI는 막는 것이 없다고 보는 대역(그 서비스가 생기기 전 시험용), 운영·데모는 늘 답하지 않는 것으로 본다.
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { coreV1Core, purchaseV1Account, ticketV1Ticket } from '@peaket/contracts/proto';
import { createGrpcClient, type GrpcLbProfile } from '@peaket/platform';
import { type CheckBlock, type CheckResult, MERGE_CHECK_DEADLINE_MS } from '../domain/merge.js';
import { type MergeChecker, MergeCheckUnavailable } from '../domain/ports.js';

/** 설명자를 읽는 선택지(받는 층과 같은 값: 필드 이름은 proto 그대로, enum은 이름, int64는 숫자, oneof 이름 칸) */
const PROTO_LOAD_OPTIONS: protoLoader.Options = { keepCase: true, longs: Number, enums: String, defaults: true, oneofs: true };

type Service = MergeChecker['service'];
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

  /** address: host:port. 클라이언트는 플랫폼 함수로 만든다(부하 분산 프로필·추적·의존 로그·데드라인 상한, 새 맥락 리뷰 중간 5) */
  constructor(
    readonly service: Service,
    address: string,
    profile: GrpcLbProfile = 'service',
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

  check(i: { primaryAccountId: string; absorbedAccountId: string }): Promise<CheckResult> {
    return new Promise((res, rej) => {
      this.#client.CheckAccountMerge({ primary_account_id: i.primaryAccountId, absorbed_account_id: i.absorbedAccountId }, new grpc.Metadata(), { deadline: Date.now() + MERGE_CHECK_DEADLINE_MS }, (e, v) => {
        if (e) return rej(new MergeCheckUnavailable(this.service, e));
        try {
          res(toCheckResult(this.service, v ?? {}));
        } catch (err) {
          rej(err);
        }
      });
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

/** 환경값으로 세 확인기를 만든다. warnings: 대역을 쓴 서비스(시작 로그에 남긴다) */
export function mergeCheckersFromEnv(env: Record<string, string | undefined>, profile: GrpcLbProfile = 'service'): { checkers: MergeChecker[]; warnings: string[] } {
  const local = (env.PEAKET_ENV ?? 'local') === 'local' || env.PEAKET_ENV === 'ci';
  const warnings: string[] = [];
  const checkers = (['purchase', 'ticket', 'core'] as const).map((s) => {
    const addr = env[ENV[s]];
    if (addr) return new GrpcMergeChecker(s, addr, profile);
    warnings.push(`${ENV[s]}이 없어 ${s}의 CheckAccountMerge를 ${local ? '막는 것이 없다고 보는 대역으로' : '늘 답하지 않는 것으로'} 둔다`);
    return local ? noBlockChecker(s) : unavailableChecker(s);
  });
  return { checkers, warnings };
}
