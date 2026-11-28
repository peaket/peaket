// 제어 gRPC 받는 쪽(peaket.control.v1.ControlReceiver.ApplyControl)의 payment-svc 구현(F-02-2 OPS-310, ADR-0102·0103·0143 결정 1, ADR-0366 결정 1·2·8·9).
// 받는 종류: CONTROL_KIND_PG_SWITCH(명령 6 대체 결제사 전환, 회차·PLATFORM)와 CONTROL_KIND_ENTRY_PAUSE_RELEASE(명령 6 해제, PLATFORM). 다른 종류는 UNIMPLEMENTED다.
// 판 번호는 1 이상 안전 정수만(ASVS 1.4.2·15.3.5), 바라는 상태는 종류마다 정한 꼴만 받는다(모르는 칸·틀린 꼴은 INVALID_ARGUMENT이고 쓰기 0, ASVS 2.1.1).
// 저장소 오류·겨루기는 UNAVAILABLE이다(ops-svc가 같은 판으로 1초마다 다시 보낸다). 제어 전용 포트 PEAKET_PAYMENT_CONTROL_GRPC_PORT(운영 50061)에서 받는다.
// 로그는 명령 ID·판·범위·결제사·결과 한 줄이다(계정 ID는 쓰임새의 released 로그 줄만, ADR-0250 결정 5).
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { controlV1Control } from '@peaket/contracts/proto';
import { type GrpcLbProfile, type PlatformMetrics, type RunbookGateConfig, type RunbookProtoBundle, type StartedGrpcServer, withRunbookControl } from '@peaket/platform';
import { startGrpcServer } from '../grpc-server.js';
import { type ApplyEntryPauseRelease, type ApplyPgSwitch, entryReleaseDesiredOf, PaymentInputError, PgSwitchControlRejected, pgSwitchDesiredOf, pgSwitchScopeOf } from '../modules/payment/server.js';

export const CONTROL_KIND_PG_SWITCH = 'CONTROL_KIND_PG_SWITCH';
export const CONTROL_KIND_ENTRY_PAUSE_RELEASE = 'CONTROL_KIND_ENTRY_PAUSE_RELEASE';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROTO_LOAD_OPTIONS: protoLoader.Options = { keepCase: true, longs: Number, enums: String, defaults: true, oneofs: true };

export interface PaymentControlLog {
  applied(e: { commandId: string; kind: string; version: number; scope: string; pg?: string; appliedVersion: number; result: string }): void;
}

export interface PaymentControlDeps {
  readonly pgSwitch: Pick<ApplyPgSwitch, 'run'>;
  readonly release: Pick<ApplyEntryPauseRelease, 'run'>;
  readonly podName: string;
  /** SIMULATOR 해제를 받는가(local·ci만, ADR-0366 결정 8) */
  readonly allowSimulator: boolean;
  readonly nowMs?: () => number;
  readonly log?: PaymentControlLog;
  readonly onError?: (method: string, err: unknown) => void;
  /** 런북 서명 관문 설정(없으면 묶음이 올 때 bundle-malformed) */
  readonly runbook?: RunbookGateConfig;
}

const fail = (code: number, message: string): never => {
  throw Object.assign(new Error(message), { code });
};

/** 요청 하나를 처리한다. 거절은 grpc 상태 코드를 단 Error로 던진다 */
export async function applyPaymentControl(r: Record<string, unknown>, deps: PaymentControlDeps): Promise<{ appliedVersion: number; podName: string; appliedAtMs: number }> {
  if (r.runbook_bundle) {
    return withRunbookControl({
      config: deps.runbook,
      bundle: r.runbook_bundle as RunbookProtoBundle,
      request: {
        commandId: String(r.command_id ?? ''),
        kind: String(r.kind ?? ''),
        scope: String(r.scope ?? ''),
        version: Number(r.version ?? 0),
        desiredStateJson: String(r.desired_state_json ?? ''),
      },
      service: 'payment-svc',
      podName: deps.podName,
      apply: () => applyPaymentInner(r, deps),
    });
  }
  return applyPaymentInner(r, deps);
}

async function applyPaymentInner(r: Record<string, unknown>, deps: PaymentControlDeps): Promise<{ appliedVersion: number; podName: string; appliedAtMs: number }> {
  const kind = String(r.kind ?? '');
  const commandId = String(r.command_id ?? '');
  const version = Number(r.version ?? 0);
  const scope = String(r.scope ?? '');
  const json = String(r.desired_state_json ?? '');
  if (kind !== CONTROL_KIND_PG_SWITCH && kind !== CONTROL_KIND_ENTRY_PAUSE_RELEASE) fail(grpc.status.UNIMPLEMENTED, '이 제어 종류는 받지 않는다');
  if (!UUID.test(commandId)) fail(grpc.status.INVALID_ARGUMENT, 'command_id는 UUID여야 한다');
  if (!Number.isSafeInteger(version) || version <= 0) fail(grpc.status.INVALID_ARGUMENT, 'version은 1 이상의 안전 정수여야 한다');
  const at = deps.nowMs?.() ?? Date.now();
  try {
    if (kind === CONTROL_KIND_PG_SWITCH) {
      const s = pgSwitchScopeOf(scope);
      const desired = pgSwitchDesiredOf(json);
      const out = await deps.pgSwitch.run({ scope: s, desired, version });
      deps.log?.applied({ commandId, kind, version, scope: s, ...(desired.toPg ? { pg: desired.toPg } : {}), appliedVersion: out.appliedVersion, result: out.written ? 'APPLIED' : 'UNCHANGED' });
      return { appliedVersion: out.appliedVersion, podName: deps.podName, appliedAtMs: at };
    }
    const desired = entryReleaseDesiredOf(scope, json, deps.allowSimulator);
    const out = await deps.release.run({ desired, version });
    deps.log?.applied({ commandId, kind, version, scope, pg: desired.pg, appliedVersion: out.appliedVersion, result: out.replayed ? 'UNCHANGED' : (out.outcome ?? 'APPLIED') });
    return { appliedVersion: out.appliedVersion, podName: deps.podName, appliedAtMs: at };
  } catch (err) {
    if (err instanceof PgSwitchControlRejected) return fail(grpc.status.INVALID_ARGUMENT, err.message);
    if (err instanceof PaymentInputError) return fail(grpc.status.INVALID_ARGUMENT, err.message);
    deps.onError?.('ApplyControl', err);
    return fail(grpc.status.UNAVAILABLE, '지금 처리할 수 없다');
  }
}

function controlPackage(): { ControlReceiver: { service: grpc.ServiceDefinition } } {
  const def = protoLoader.fromJSON(controlV1Control as Parameters<typeof protoLoader.fromJSON>[0], PROTO_LOAD_OPTIONS);
  return (grpc.loadPackageDefinition(def) as unknown as { peaket: { control: { v1: { ControlReceiver: { service: grpc.ServiceDefinition } } } } }).peaket.control.v1;
}

/** 제어 전용 gRPC 포트를 연다(업무 포트와 다른 포트, ADR-0102) */
export function startPaymentControlServer(o: { host: string; port: number; deps: PaymentControlDeps; profile?: GrpcLbProfile; metrics?: PlatformMetrics }): Promise<StartedGrpcServer> {
  const handlers: grpc.UntypedServiceImplementation = {
    ApplyControl: (call: grpc.ServerUnaryCall<Record<string, unknown>, unknown>, cb: grpc.sendUnaryData<unknown>) => {
      applyPaymentControl(call.request, o.deps).then(
        (ack) =>
          cb(null, {
            applied_version: ack.appliedVersion,
            pod_name: ack.podName,
            applied_at: { seconds: Math.floor(ack.appliedAtMs / 1000), nanos: (ack.appliedAtMs % 1000) * 1_000_000 },
          }),
        (err: unknown) => {
          const code = (err as { code?: number }).code ?? grpc.status.INTERNAL;
          cb({ code, message: err instanceof Error ? err.message : 'control-failed' });
        },
      );
    },
  };
  return startGrpcServer({ host: o.host, port: o.port, services: [{ definition: controlPackage().ControlReceiver.service, handlers }], ...(o.profile ? { profile: o.profile } : {}), ...(o.metrics ? { metrics: o.metrics } : {}) });
}
