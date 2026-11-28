// 제어 gRPC 받는 쪽(peaket.control.v1.ControlReceiver.ApplyControl)의 admission-ctrl 구현(F-02-1 OPS-300, ADR-0102·0103·0365 결정 5, ADR-0056, Q-T30).
// 받는 종류: ADMISSION_TARGET(명령 1)·ADMISSION_PAUSE(명령 2)·SALE_PAUSE(명령 3, 회차·PLATFORM)·AUTOMATION_STOP(명령 11, PLATFORM)·PG_SWITCH(명령 6 대체 결제사 전환, 회차·PLATFORM, F-02-2). 다른 종류는 UNIMPLEMENTED다.
// 판 번호는 1 이상 안전 정수만(ASVS 1.4.2·15.3.5), 바라는 상태는 종류마다 정한 꼴만 받는다(모르는 칸·틀린 꼴은 INVALID_ARGUMENT이고 쓰기 0, ASVS 2.1.1).
// 리더가 아니면 UNAVAILABLE(not-leader), 세대가 낮아 FENCED면 UNAVAILABLE(fenced)이다. 둘 다 아무것도 쓰지 않는다.
// 운영에서는 리더 전용 Service가 리더 파드만 내놓는다(배포 차트는 구간 5). 제어 전용 포트 PEAKET_ADMISSION_CONTROL_GRPC_PORT에서 받는다.
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { controlV1Control } from '@peaket/contracts/proto';
import { type GrpcLbProfile, type PlatformMetrics, type RunbookGateConfig, type RunbookProtoBundle, startGrpcServer, type StartedGrpcServer, withRunbookControl } from '@peaket/platform';
import { type ApplyLeaderControl, LEADER_CONTROL_KINDS, LeaderControlRejected, type LeaderControlKind } from '../modules/leader/index.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROTO_LOAD_OPTIONS: protoLoader.Options = { keepCase: true, longs: Number, enums: String, defaults: true, oneofs: true };
/** UNAVAILABLE의 까닭 글(ADR-0365 결정 5). ops-svc는 이 글로 다시 보낼지 정하지 않는다(늘 1초 뒤 다시) */
export const NOT_LEADER = 'not-leader';
export const FENCED = 'fenced';

export interface AdmissionControlDeps {
  readonly apply: ApplyLeaderControl;
  readonly podName: string;
  readonly nowMs?: () => number;
  readonly onError?: (method: string, err: unknown) => void;
  /** 런북 서명 관문 설정(없으면 묶음이 올 때 bundle-malformed) */
  readonly runbook?: RunbookGateConfig;
}

/** 요청 하나를 처리한다. 거절은 grpc 상태 코드를 단 Error로 던진다 */
export async function applyAdmissionControl(r: Record<string, unknown>, deps: AdmissionControlDeps): Promise<{ appliedVersion: number; podName: string; appliedAtMs: number }> {
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
      service: 'admission-ctrl',
      podName: deps.podName,
      apply: () => applyAdmissionInner(r, deps),
    });
  }
  return applyAdmissionInner(r, deps);
}

async function applyAdmissionInner(r: Record<string, unknown>, deps: AdmissionControlDeps): Promise<{ appliedVersion: number; podName: string; appliedAtMs: number }> {
  const kind = String(r.kind ?? '');
  const commandId = String(r.command_id ?? '');
  const version = Number(r.version ?? 0);
  const fail = (code: number, message: string): never => {
    throw Object.assign(new Error(message), { code });
  };
  if (!(LEADER_CONTROL_KINDS as readonly string[]).includes(kind)) fail(grpc.status.UNIMPLEMENTED, '이 제어 종류는 받지 않는다');
  if (!UUID.test(commandId)) fail(grpc.status.INVALID_ARGUMENT, 'command_id는 UUID여야 한다');
  if (!Number.isSafeInteger(version) || version <= 0) fail(grpc.status.INVALID_ARGUMENT, 'version은 1 이상의 안전 정수여야 한다');
  let result;
  try {
    result = await deps.apply.run({ kind: kind as LeaderControlKind, scope: String(r.scope ?? ''), desiredStateJson: String(r.desired_state_json ?? ''), commandId, version });
  } catch (err) {
    if (err instanceof LeaderControlRejected) return fail(grpc.status.INVALID_ARGUMENT, `${err.why}가 올바르지 않다`);
    throw err;
  }
  if (result.status === 'NOT_LEADER') return fail(grpc.status.UNAVAILABLE, NOT_LEADER);
  if (result.status === 'FENCED') return fail(grpc.status.UNAVAILABLE, FENCED);
  return { appliedVersion: result.appliedVersion, podName: deps.podName, appliedAtMs: deps.nowMs?.() ?? Date.now() };
}

function controlPackage(): { ControlReceiver: { service: grpc.ServiceDefinition } } {
  const def = protoLoader.fromJSON(controlV1Control as Parameters<typeof protoLoader.fromJSON>[0], PROTO_LOAD_OPTIONS);
  return (grpc.loadPackageDefinition(def) as unknown as { peaket: { control: { v1: { ControlReceiver: { service: grpc.ServiceDefinition } } } } }).peaket.control.v1;
}

/** 제어 전용 gRPC 포트를 연다(업무 포트와 다른 포트, ADR-0102) */
export function startAdmissionControlServer(o: { host: string; port: number; deps: AdmissionControlDeps; profile: GrpcLbProfile; metrics?: PlatformMetrics }): Promise<StartedGrpcServer> {
  const handlers: grpc.UntypedServiceImplementation = {
    ApplyControl: (call: grpc.ServerUnaryCall<Record<string, unknown>, unknown>, cb: grpc.sendUnaryData<unknown>) => {
      applyAdmissionControl(call.request, o.deps).then(
        (ack) =>
          cb(null, {
            applied_version: ack.appliedVersion,
            pod_name: ack.podName,
            applied_at: { seconds: Math.floor(ack.appliedAtMs / 1000), nanos: (ack.appliedAtMs % 1000) * 1_000_000 },
          }),
        (err: unknown) => {
          const code = (err as { code?: number }).code ?? grpc.status.INTERNAL;
          if (code === grpc.status.INTERNAL) o.deps.onError?.('ApplyControl', err);
          cb({ code, message: err instanceof Error ? err.message : 'control-failed' });
        },
      );
    },
  };
  return startGrpcServer({ host: o.host, port: o.port, services: [{ definition: controlPackage().ControlReceiver.service, handlers }], profile: o.profile, ...(o.metrics ? { metrics: o.metrics } : {}) });
}
