// ops-svc → trust-svc TrustLabelService.ApplyLabel 클라이언트(FR-049, bot-defense §9 '첫 구현', §13, ADR-0258).
// - 표본 검토는 source=SAMPLE_REVIEW, source_version=1(판 1), review_batch·applied_verdict·verdict_event_key를 싣는다.
// - 내부 gRPC 토큰이 있으면 호출자 ops-svc와 처리자(acted_by) 증명을 함께 보낸다(COV2-01).
// - ApplyLabel이 실패하면 BotReviewLabelFailure로 바꾼다(apply-label.ts의 INVALID_ARGUMENT·ALREADY_EXISTS·UNAVAILABLE).
// - 응답의 changed·block_list만 읽는다. 다른 값을 로그에 싣지 않는다.
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { trustV1Trust } from '@peaket/contracts/proto';
import {
  createGrpcClient,
  INTERNAL_GRPC_ACTOR_HEADER,
  INTERNAL_GRPC_ACTOR_PROOF_HEADER,
  INTERNAL_GRPC_CALLER_HEADER,
  INTERNAL_GRPC_TOKEN_HEADER,
  internalGrpcActorProof,
  type GrpcLbProfile,
} from '@peaket/platform';
import { BotReviewLabelFailure } from '../domain/bot-review.js';
import type { ApplySampleLabelInput, AppliedSampleLabel, TrustLabels } from '../domain/ports.js';

const PROTO_LOAD_OPTIONS: protoLoader.Options = { keepCase: true, longs: Number, enums: String, defaults: true, oneofs: true };
/** ApplyLabel 한 번의 데드라인 5초 [가정](판정 화면은 사람이 기다린다) */
export const BOT_REVIEW_LABEL_DEADLINE_MS = 5_000;

type Unary = (req: object, md: grpc.Metadata, opts: grpc.CallOptions, cb: (e: grpc.ServiceError | null, v?: Record<string, unknown>) => void) => grpc.ClientUnaryCall;
type LabelClient = grpc.Client & { ApplyLabel: Unary };
type TrustPackage = { TrustLabelService: grpc.ServiceClientConstructor };

const CALLER = 'ops-svc';
const SOURCE = 'LABEL_SOURCE_SAMPLE_REVIEW';
const BATCH: Readonly<Record<'PASSED' | 'SHADOW_CHALLENGED', string>> = {
  PASSED: 'REVIEW_BATCH_PASSED',
  SHADOW_CHALLENGED: 'REVIEW_BATCH_SHADOW_CHALLENGED',
};
const VERDICT: Readonly<Record<'ALLOW' | 'CHALLENGE', string>> = { ALLOW: 'VERDICT_ALLOW', CHALLENGE: 'VERDICT_CHALLENGE' };

let loaded: TrustPackage | undefined;
function trustPackage(): TrustPackage {
  if (!loaded) {
    const def = protoLoader.fromJSON(trustV1Trust as Parameters<typeof protoLoader.fromJSON>[0], PROTO_LOAD_OPTIONS);
    loaded = (grpc.loadPackageDefinition(def) as unknown as { peaket: { trust: { v1: TrustPackage } } }).peaket.trust.v1;
  }
  return loaded;
}

export interface GrpcTrustLabelsOptions {
  readonly address: string;
  readonly profile?: GrpcLbProfile;
  /** 내부 gRPC 공유 토큰. local·ci에서는 비어 있을 수 있다 */
  readonly token?: string;
}

export class GrpcTrustLabels implements TrustLabels {
  readonly #client: LabelClient;
  readonly #token: string | undefined;

  constructor(o: GrpcTrustLabelsOptions) {
    const at = o.address.lastIndexOf(':');
    const port = Number(o.address.slice(at + 1));
    if (at <= 0 || !Number.isInteger(port) || port <= 0 || port > 65_535) throw new Error('PEAKET_TRUST_GRPC_URL은 host:port여야 한다');
    this.#client = createGrpcClient(trustPackage().TrustLabelService, {
      host: o.address.slice(0, at),
      port,
      profile: o.profile ?? 'service',
      dependency: 'trust-svc',
      timeoutCapMs: BOT_REVIEW_LABEL_DEADLINE_MS,
      caller: CALLER,
    }) as unknown as LabelClient;
    this.#token = o.token;
  }

  async apply(q: ApplySampleLabelInput): Promise<AppliedSampleLabel> {
    const metadata = new grpc.Metadata();
    if (this.#token) {
      metadata.set(INTERNAL_GRPC_TOKEN_HEADER, this.#token);
      metadata.set(INTERNAL_GRPC_CALLER_HEADER, CALLER);
      metadata.set(INTERNAL_GRPC_ACTOR_HEADER, q.actedBy);
      metadata.set(INTERNAL_GRPC_ACTOR_PROOF_HEADER, internalGrpcActorProof(this.#token, q.actedBy));
    }
    const answer = await this.#call(
      {
        source_ref: q.sampleId,
        source_version: 1,
        source: SOURCE,
        label: q.label === 'BOT' ? 'LABEL_BOT' : 'LABEL_HUMAN',
        event_id: q.eventId,
        pid: q.pid,
        acted_by: q.actedBy,
        review_batch: BATCH[q.reviewBatch],
        applied_verdict: VERDICT[q.appliedVerdict],
        verdict_event_key: q.verdictEventKey,
      },
      metadata,
    );
    const block = typeof answer.block_list === 'string' ? answer.block_list.replace('BLOCK_LIST_CHANGE_', '') : 'NONE';
    const blockList = block === 'ADDED' || block === 'REMOVED' || block === 'DEVICE_NOT_FOUND' ? block : 'NONE';
    return { changed: answer.changed === true, blockList };
  }

  async #call(req: object, metadata: grpc.Metadata): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const deadline = new Date(Date.now() + BOT_REVIEW_LABEL_DEADLINE_MS);
      this.#client.ApplyLabel(req, metadata, { deadline }, (e, v) => {
        if (e) return reject(failureOf(e));
        resolve(v ?? {});
      });
    });
  }

  close(): void {
    this.#client.close();
  }
}

function failureOf(e: grpc.ServiceError): BotReviewLabelFailure {
  if (e.code === grpc.status.INVALID_ARGUMENT) return new BotReviewLabelFailure('invalid-argument');
  if (e.code === grpc.status.ALREADY_EXISTS) return new BotReviewLabelFailure('already-exists');
  if (e.code === grpc.status.NOT_FOUND) return new BotReviewLabelFailure('device-not-found');
  return new BotReviewLabelFailure('unavailable');
}
