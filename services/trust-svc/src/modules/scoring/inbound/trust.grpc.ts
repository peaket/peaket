// 받는 층: gRPC TrustService(docs/api/proto/peaket/trust/v1/trust.proto)를 유스케이스에 잇는다.
// 응답에는 판정·사유 범주·degraded만 싣는다(점수 원값·가중치·기준값·확정 신호 종류는 싣지 않는다, POL-006).
// 부르는 쪽 신원 확인은 아직 이 저장소의 배포 설정(deploy·infra)에 없다. 호출자를 queue-svc·identity-svc로 줄이는 메시 허용 정책은 배포 단계의 필수 조건이다(ADR-0248).
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { trustV1Trust } from '@peaket/contracts/proto';
import { TrustError } from '../application/trust-error.js';
import type { BehaviorSummary, ScoreContext, ScoreRequest, ScoreResult, ShuffleMode } from '../domain/types.js';

/**
 * 설명자를 읽는 선택지: 필드 이름은 proto 그대로, enum은 이름, int64는 숫자.
 * defaults false: 보내지 않은 칸을 0으로 채우지 않는다(값 없음과 보낸 0을 구분한다. 행동 요약의 선택 칸이 대표적이다, 낮음-10).
 * proto3에는 칸의 있음·없음 표시가 없어, 부르는 쪽(protobufjs)이 넣은 칸만 보낸다는 동작에 기댄다
 */
const PROTO_LOAD_OPTIONS: protoLoader.Options = { keepCase: true, longs: Number, enums: String, defaults: false, oneofs: true };

export interface TrustPackage {
  TrustService: grpc.ServiceClientConstructor;
}

let pkg: TrustPackage | undefined;
/** peaket.trust.v1 패키지(계약 설명자에서 한 번 만든다) */
export function trustPackage(): TrustPackage {
  if (!pkg) {
    const def = protoLoader.fromJSON(trustV1Trust as Parameters<typeof protoLoader.fromJSON>[0], PROTO_LOAD_OPTIONS);
    const root = grpc.loadPackageDefinition(def) as unknown as { peaket: { trust: { v1: TrustPackage } } };
    pkg = root.peaket.trust.v1;
  }
  return pkg;
}

type Req = Record<string, unknown>;
const CONTEXT: Record<string, ScoreContext> = {
  SCORE_CONTEXT_LOBBY_ENTRY: 'LOBBY_ENTRY',
  SCORE_CONTEXT_PREVERIFY: 'PREVERIFY',
  SCORE_CONTEXT_LOGIN: 'LOGIN',
  SCORE_CONTEXT_VERIFICATION: 'VERIFICATION',
};
const SHUFFLE: Record<string, ShuffleMode> = { LOBBY_SHUFFLE_ON: 'ON', LOBBY_SHUFFLE_OFF: 'OFF', LOBBY_SHUFFLE_UNSPECIFIED: 'NONE' };
/** 부르는 쪽이 데드라인을 걸지 않았을 때(800ms [가정], docs/features/bot-defense.md §4.6) */
const DEFAULT_DEADLINE_MS = 800;

const text = (v: unknown): string => (typeof v === 'string' ? v : '');
const number = (v: unknown): number => (typeof v === 'number' ? v : 0);
const optionalNumber = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);
const object = (v: unknown): Req | undefined => (v && typeof v === 'object' ? (v as Req) : undefined);

function timestampMs(v: unknown): number | undefined {
  const t = object(v);
  if (!t) return undefined;
  return number(t.seconds) * 1000 + Math.floor(number(t.nanos) / 1_000_000);
}

function behaviorOf(v: unknown): BehaviorSummary | undefined {
  const b = object(v);
  if (!b) return undefined;
  return {
    v: number(b.v),
    windowMs: number(b.window_ms),
    pointerMoves: optionalNumber(b.pointer_moves),
    pointerEntropy: optionalNumber(b.pointer_entropy),
    inputIntervalMeanMs: optionalNumber(b.input_interval_mean_ms),
    inputIntervalStdMs: optionalNumber(b.input_interval_std_ms),
    scrollEvents: optionalNumber(b.scroll_events),
    scrollDistancePx: optionalNumber(b.scroll_distance_px),
  };
}

function hintsOf(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, value] of Object.entries(object(v) ?? {}).slice(0, 16)) if (typeof value === 'string') out[k.toLowerCase().slice(0, 64)] = value.slice(0, 256);
  return out;
}

function deadlineOf(call: grpc.ServerUnaryCall<Req, object>): number {
  const d = call.getDeadline();
  const at = d instanceof Date ? d.getTime() : typeof d === 'number' ? d : Number.POSITIVE_INFINITY;
  return Number.isFinite(at) ? at : Date.now() + DEFAULT_DEADLINE_MS;
}

function toRequest(call: grpc.ServerUnaryCall<Req, object>): ScoreRequest {
  const r = call.request;
  const context = CONTEXT[text(r.context)];
  if (!context) throw new TrustError('INVALID_ARGUMENT', '판정 맥락이 없다');
  const client = object(r.client) ?? {};
  return {
    context,
    eventId: text(r.event_id),
    pid: text(r.pid),
    accountId: text(r.account_id),
    humanCheckToken: text(r.human_check_token),
    deviceId: text(r.device_id),
    behavior: behaviorOf(r.behavior),
    client: { ip: text(client.ip), userAgent: text(client.user_agent).slice(0, 512), clientHints: hintsOf(client.client_hints), asn: number(client.asn) },
    firstVisitAtMs: timestampMs(r.first_visit_at),
    sessionCreatedAtMs: timestampMs(r.session_created_at),
    shuffle: SHUFFLE[text(r.lobby_shuffle)] ?? 'NONE',
    journeyId: text(r.journey_id),
    deadlineAtMs: deadlineOf(call),
  };
}

const responseOf = (r: ScoreResult): object => ({
  verdict: r.verdict === 'ALLOW' ? 'VERDICT_ALLOW' : 'VERDICT_CHALLENGE',
  ...(r.reason ? { reason: `REASON_CATEGORY_${r.reason}` } : {}),
  degraded: r.degraded,
});

export function trustServiceHandlers(uc: { run(i: ScoreRequest): Promise<ScoreResult> }, onError: (method: string, err: unknown) => void): grpc.UntypedServiceImplementation {
  const ScoreRisk: grpc.handleUnaryCall<Req, object> = (call, cb) => {
    let input: ScoreRequest;
    try {
      input = toRequest(call);
    } catch (err) {
      if (err instanceof TrustError) cb({ code: grpc.status[err.code], details: err.message });
      else cb({ code: grpc.status.INTERNAL, details: '처리하지 못했다' });
      return;
    }
    uc.run(input).then(
      (v) => cb(null, responseOf(v)),
      (err: unknown) => {
        if (err instanceof TrustError) {
          cb({ code: grpc.status[err.code], details: err.message });
          return;
        }
        onError('ScoreRisk', err);
        cb({ code: grpc.status.INTERNAL, details: '처리하지 못했다' });
      },
    );
  };
  return { ScoreRisk };
}
