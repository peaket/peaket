// ops-svc → queue-svc·trust-svc·identity-svc gRPC 클라이언트 넷(F-06-7 GAT-280, bot-defense §12 'CS 처리 첫 구현'의 '호출 모양').
// - queue.proto VerificationAppealService: GetVerificationAppeal(내용·대기 참여 상태), ResolveVerificationAppeal(이의 ID, 건 ID, 판, 결과)
// - trust.proto TrustLabelService.ApplyLabel(source_ref 건 ID, source_version 판, LABEL_SOURCE_APPEAL_ACCEPTED, LABEL_HUMAN, 회차, pid, acted_by),
//   TrustEvidenceService.GetVerdictEvidence(회차, pid)
// - identity.proto AccountHoldService.SetAccountHold(계정, VERIFICATION_APPEAL, 건 ID, OPEN·CLOSED, 판)
// 내부 gRPC 토큰이 있으면 호출자 ops-svc를 싣고, ApplyLabel에는 처리자(acted_by) 증명도 싣는다(bot-defense §9 '내부 gRPC 토큰').
// 호출마다 데드라인을 건다(결정·배경 작업 2초, 상세 1초 [가정]). 실패는 gRPC 상태 이름을 code로 실은 CsDispatchCallError다.
// 받은 값(pid·계정 ID·이의 글)은 로그에 싣지 않는다.
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { identityV1Identity, queueV1Queue, trustV1Trust } from '@peaket/contracts/proto';
import { createGrpcClient, INTERNAL_GRPC_ACTOR_HEADER, INTERNAL_GRPC_ACTOR_PROOF_HEADER, internalGrpcActorProof, type GrpcLbProfile } from '@peaket/platform';
import {
  CsDispatchCallError,
  DISPATCH_CALL_DEADLINE_MS,
  type AccountHolds,
  type AppealContent,
  type AppealEntryState,
  type AppealLabels,
  type AppealOutcome,
  type BlockListChange,
  type CallOptions,
  type VerdictEvidence,
  type VerdictEvidenceAnswer,
  type VerificationAppeals,
} from '../domain/verification-appeal.js';

const PROTO_LOAD_OPTIONS: protoLoader.Options = { keepCase: true, longs: Number, enums: String, defaults: true, oneofs: true };
const CALLER = 'ops-svc';

type Def = Parameters<typeof protoLoader.fromJSON>[0];
type Ctor = grpc.ServiceClientConstructor;
type Reply = Record<string, unknown>;
type Unary = (req: object, md: grpc.Metadata, opts: grpc.CallOptions, cb: (e: grpc.ServiceError | null, v?: Reply) => void) => grpc.ClientUnaryCall;

let packages: { queue: Record<string, Ctor>; trust: Record<string, Ctor>; identity: Record<string, Ctor> } | undefined;
function pkgs() {
  if (!packages) {
    const load = (json: unknown) => grpc.loadPackageDefinition(protoLoader.fromJSON(json as Def, PROTO_LOAD_OPTIONS)) as unknown as { peaket: Record<string, { v1: Record<string, Ctor> }> };
    packages = {
      queue: load(queueV1Queue).peaket.queue!.v1,
      trust: load(trustV1Trust).peaket.trust!.v1,
      identity: load(identityV1Identity).peaket.identity!.v1,
    };
  }
  return packages;
}

export interface GrpcAppealClientOptions {
  /** host:port */
  readonly address: string;
  /** 주소를 준 환경 변수 이름(오류 글에 쓴다) */
  readonly envName: string;
  readonly profile?: GrpcLbProfile;
  /** 내부 gRPC 공유 토큰. local·ci에서는 비어 있을 수 있다 */
  readonly token?: string;
}

/** gRPC 상태 번호 → 이름(UNAVAILABLE 등) */
function codeName(e: unknown): string {
  const code = (e as { code?: unknown } | undefined)?.code;
  if (typeof code === 'number' && typeof grpc.status[code] === 'string') return grpc.status[code] as string;
  return 'INTERNAL';
}

const strip = (v: unknown, prefix: string): string => (typeof v === 'string' && v.startsWith(prefix) ? v.slice(prefix.length) : '');
const tsMs = (v: unknown): number | null => {
  if (typeof v !== 'object' || v === null) return null;
  const t = v as { seconds?: unknown; nanos?: unknown };
  const s = Number(t.seconds ?? 0);
  const n = Number(t.nanos ?? 0);
  return Number.isFinite(s) && Number.isFinite(n) ? s * 1000 + Math.floor(n / 1_000_000) : null;
};
const count = (v: unknown): number => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : 0);

/** 한 서비스의 클라이언트(정본 설명자, createGrpcClient, 호출마다 데드라인) */
class AppealClient {
  readonly #client: grpc.Client & Record<string, Unary>;

  constructor(Service: Ctor, dependency: string, o: GrpcAppealClientOptions) {
    const at = o.address.lastIndexOf(':');
    const port = Number(o.address.slice(at + 1));
    if (at <= 0 || !Number.isInteger(port) || port <= 0 || port > 65_535) throw new Error(`${o.envName}은 host:port여야 한다`);
    this.#client = createGrpcClient(Service, {
      host: o.address.slice(0, at),
      port,
      profile: o.profile ?? 'service',
      dependency,
      timeoutCapMs: DISPATCH_CALL_DEADLINE_MS,
      caller: CALLER,
      ...(o.token ? { internalToken: o.token } : {}),
    }) as unknown as grpc.Client & Record<string, Unary>;
  }

  /** 한 번 부르고 답을 map으로 옮긴다 */
  call<T>(method: string, req: object, opts: CallOptions | undefined, map: (v: Reply) => T, metadata = new grpc.Metadata()): Promise<T> {
    const p = new Promise<Reply>((resolve, reject) => {
      const deadline = new Date(Date.now() + (opts?.deadlineMs ?? DISPATCH_CALL_DEADLINE_MS));
      try {
        this.#client[method]!.call(this.#client, req, metadata, { deadline }, (e, v) => {
          if (e) return reject(new CsDispatchCallError(codeName(e)));
          resolve(v ?? {});
        });
      } catch (err) {
        reject(new CsDispatchCallError(codeName(err)));
      }
    });
    const out = p.then(map);
    // 부르는 쪽이 여러 호출을 먼저 띄우고 차례로 기다려도 기다리기 전의 실패가 '처리되지 않은 거절'로 새지 않게 한다(거절은 그대로 기다리는 쪽에 간다)
    out.catch(() => undefined);
    return out;
  }

  close(): void {
    this.#client.close();
  }
}

const ENTRY: Readonly<Record<string, AppealEntryState>> = {
  APPEAL_ENTRY_STATE_VERIFYING: 'VERIFYING',
  APPEAL_ENTRY_STATE_PASSED: 'PASSED',
  APPEAL_ENTRY_STATE_ENDED: 'ENDED',
};
const RESOLVE: Readonly<Record<string, 'APPLIED' | 'UNCHANGED' | 'NOT_ISOLATED'>> = {
  RESOLVE_APPEAL_RESULT_APPLIED: 'APPLIED',
  RESOLVE_APPEAL_RESULT_UNCHANGED: 'UNCHANGED',
  RESOLVE_APPEAL_RESULT_NOT_ISOLATED: 'NOT_ISOLATED',
};
const OUTCOME: Readonly<Record<AppealOutcome, string>> = { ACCEPTED: 'APPEAL_OUTCOME_ACCEPTED', REJECTED: 'APPEAL_OUTCOME_REJECTED' };

/** queue-svc VerificationAppealService */
export class GrpcVerificationAppeals implements VerificationAppeals {
  readonly #c: AppealClient;

  constructor(o: GrpcAppealClientOptions) {
    this.#c = new AppealClient(pkgs().queue.VerificationAppealService!, 'queue-svc', o);
  }

  get(appealId: string, o?: CallOptions): Promise<AppealContent> {
    return this.#c.call('GetVerificationAppeal', { appeal_id: appealId }, o, (v) => ({
      appealId: typeof v.appeal_id === 'string' && v.appeal_id !== '' ? v.appeal_id : appealId,
      eventId: String(v.event_id ?? ''),
      accountId: String(v.account_id ?? ''),
      pid: String(v.pid ?? ''),
      text: typeof v.text === 'string' ? v.text : '',
      reasonCategory: strip(v.reason_category, 'REASON_CATEGORY_'),
      receivedAtMs: tsMs(v.received_at) ?? 0,
      entryState: ENTRY[String(v.entry_state)] ?? null,
    }));
  }

  resolve(i: { appealId: string; caseId: string; caseVersion: number; outcome: AppealOutcome }, o?: CallOptions): Promise<'APPLIED' | 'UNCHANGED' | 'NOT_ISOLATED'> {
    return this.#c.call('ResolveVerificationAppeal', { appeal_id: i.appealId, case_id: i.caseId, case_version: i.caseVersion, outcome: OUTCOME[i.outcome] }, o, (v) => RESOLVE[String(v.result)] ?? 'UNCHANGED');
  }

  close(): void {
    this.#c.close();
  }
}

const BLOCK: Readonly<Record<string, BlockListChange>> = {
  BLOCK_LIST_CHANGE_NONE: 'NONE',
  BLOCK_LIST_CHANGE_ADDED: 'ADDED',
  BLOCK_LIST_CHANGE_REMOVED: 'REMOVED',
  BLOCK_LIST_CHANGE_DEVICE_NOT_FOUND: 'DEVICE_NOT_FOUND',
};

/** trust-svc TrustLabelService.ApplyLabel(이의 인정) */
export class GrpcAppealLabels implements AppealLabels {
  readonly #c: AppealClient;
  readonly #token: string | undefined;

  constructor(o: GrpcAppealClientOptions) {
    this.#c = new AppealClient(pkgs().trust.TrustLabelService!, 'trust-svc', o);
    this.#token = o.token;
  }

  apply(i: { caseId: string; version: number; eventId: string; pid: string; actedBy: string }, o?: CallOptions): Promise<{ changed: boolean; blockList: BlockListChange }> {
    const metadata = new grpc.Metadata();
    if (this.#token) {
      metadata.set(INTERNAL_GRPC_ACTOR_HEADER, i.actedBy);
      metadata.set(INTERNAL_GRPC_ACTOR_PROOF_HEADER, internalGrpcActorProof(this.#token, i.actedBy));
    }
    // queue_entry_id·device_ref·review_batch·applied_verdict·verdict_event_key는 비운다(표본 검토 칸)
    return this.#c.call(
      'ApplyLabel',
      { source_ref: i.caseId, source_version: i.version, source: 'LABEL_SOURCE_APPEAL_ACCEPTED', label: 'LABEL_HUMAN', event_id: i.eventId, pid: i.pid, acted_by: i.actedBy },
      o,
      (v) => ({ changed: v.changed === true, blockList: BLOCK[String(v.block_list)] ?? 'NONE' }),
      metadata,
    );
  }

  close(): void {
    this.#c.close();
  }
}

const HARD: Readonly<Record<string, 'NONE' | 'BLOCK_LIST' | 'HONEYPOT'>> = { HARD_SIGNAL_NONE: 'NONE', HARD_SIGNAL_BLOCK_LIST: 'BLOCK_LIST', HARD_SIGNAL_HONEYPOT: 'HONEYPOT' };
const SOURCE: Readonly<Record<string, 'REALTIME' | 'REASSESS'>> = { EVIDENCE_SOURCE_REALTIME: 'REALTIME', EVIDENCE_SOURCE_REASSESS: 'REASSESS' };

/** trust-svc TrustEvidenceService.GetVerdictEvidence. 프로필 판은 읽지 않는다(화면에 보이지 않는 값) */
export class GrpcVerdictEvidence implements VerdictEvidence {
  readonly #c: AppealClient;

  constructor(o: GrpcAppealClientOptions) {
    this.#c = new AppealClient(pkgs().trust.TrustEvidenceService!, 'trust-svc', o);
  }

  get(i: { eventId: string; pid: string }, o?: CallOptions): Promise<VerdictEvidenceAnswer> {
    return this.#c.call('GetVerdictEvidence', { event_id: i.eventId, pid: i.pid }, o, (v): VerdictEvidenceAnswer =>
      v.found !== true
        ? { found: false }
        : {
            found: true,
            reason: strip(v.reason, 'REASON_CATEGORY_'),
            hardSignal: HARD[String(v.hard_signal)] ?? null,
            source: SOURCE[String(v.source)] ?? null,
            decidedAtMs: tsMs(v.decided_at),
            sent: count(v.device_challenges_sent),
            passed: count(v.device_challenges_passed),
            failed: count(v.device_challenges_failed),
          },
    );
  }

  close(): void {
    this.#c.close();
  }
}

/** identity-svc AccountHoldService.SetAccountHold(VERIFICATION_APPEAL) */
export class GrpcAccountHolds implements AccountHolds {
  readonly #c: AppealClient;

  constructor(o: GrpcAppealClientOptions) {
    this.#c = new AppealClient(pkgs().identity.AccountHoldService!, 'identity-svc', o);
  }

  set(i: { accountId: string; caseId: string; state: 'OPEN' | 'CLOSED'; version: number }, o?: CallOptions): Promise<{ changed: boolean }> {
    return this.#c.call(
      'SetAccountHold',
      { account_id: i.accountId, kind: 'ACCOUNT_HOLD_KIND_VERIFICATION_APPEAL', source_ref: i.caseId, state: i.state === 'OPEN' ? 'ACCOUNT_HOLD_STATE_OPEN' : 'ACCOUNT_HOLD_STATE_CLOSED', source_version: i.version },
      o,
      (v) => ({ changed: v.changed === true }),
    );
  }

  close(): void {
    this.#c.close();
  }
}
