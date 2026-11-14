// 제어 gRPC 받는 쪽(peaket.control.v1.ControlReceiver.ApplyControl)의 queue-svc 구현(BAT-465 R-584, ADR-0102·0103·0123).
// 이번 몫은 CONTROL_KIND_SALE_SUSPENSION(판매 승인 업무의 판매 중지·재개)만 받는다. 다른 종류는 UNIMPLEMENTED다.
// 대기열 사본(q:{event:E}:notice·ctl)만 쓰고, 판 번호는 요청 값을 그대로 돌려준다(사본에 suspRev로 남긴다).
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { controlV1Control } from '@peaket/contracts/proto';
import { type GrpcServiceBinding, startGrpcServer } from '../grpc-server.js';
import type { SetSaleSuspensionCopy } from '../modules/sale/index.js';

export const CONTROL_KIND_SALE_SUSPENSION = 'CONTROL_KIND_SALE_SUSPENSION';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROTO_LOAD_OPTIONS: protoLoader.Options = { keepCase: true, longs: Number, enums: String, defaults: true, oneofs: true };

/** 판매 중지·재개의 바라는 상태({"suspended": true|false})를 읽는다. 모르는 모양이면 undefined */
export function suspendedOf(json: string): boolean | undefined {
  try {
    const v: unknown = JSON.parse(json);
    if (typeof v !== 'object' || v === null) return undefined;
    const suspended = (v as { suspended?: unknown }).suspended;
    return typeof suspended === 'boolean' ? suspended : undefined;
  } catch {
    return undefined;
  }
}

function controlPackage(): { ControlReceiver: { service: grpc.ServiceDefinition } } {
  const def = protoLoader.fromJSON(controlV1Control as Parameters<typeof protoLoader.fromJSON>[0], PROTO_LOAD_OPTIONS);
  return (grpc.loadPackageDefinition(def) as unknown as { peaket: { control: { v1: { ControlReceiver: { service: grpc.ServiceDefinition } } } } }).peaket.control.v1;
}

export interface QueueControlDeps {
  readonly setSuspension: SetSaleSuspensionCopy;
  readonly podName: string;
  readonly nowMs?: () => number;
  readonly onError?: (method: string, err: unknown) => void;
}

/** ControlReceiver의 queue-svc 처리기(ApplyControl 하나) */
export function saleSuspensionControlBinding(deps: QueueControlDeps): GrpcServiceBinding {
  const handlers: grpc.UntypedServiceImplementation = {
    ApplyControl: (call: grpc.ServerUnaryCall<Record<string, unknown>, unknown>, cb: grpc.sendUnaryData<unknown>) => {
      const r = call.request;
      const kind = String(r.kind ?? '');
      const scope = String(r.scope ?? '');
      const commandId = String(r.command_id ?? '');
      const version = Number(r.version ?? 0);
      const fail = (code: number, message: string): void => {
        deps.onError?.('ApplyControl', new Error(message));
        cb({ code, message });
      };
      if (kind !== CONTROL_KIND_SALE_SUSPENSION) return fail(grpc.status.UNIMPLEMENTED, '이 제어 종류는 아직 받지 않는다');
      if (!UUID.test(scope)) return fail(grpc.status.INVALID_ARGUMENT, 'scope는 회차 ID여야 한다');
      if (!UUID.test(commandId)) return fail(grpc.status.INVALID_ARGUMENT, 'command_id는 UUID여야 한다');
      if (!Number.isSafeInteger(version) || version < 0) return fail(grpc.status.INVALID_ARGUMENT, 'version은 0 이상의 정수여야 한다');
      const suspended = suspendedOf(String(r.desired_state_json ?? ''));
      if (suspended === undefined) return fail(grpc.status.INVALID_ARGUMENT, 'desired_state_json이 {"suspended": bool}이 아니다');
      const nowMs = deps.nowMs?.() ?? Date.now();
      deps.setSuspension
        .run({ eventId: scope, action: suspended ? 'SUSPEND' : 'RESUME', commandId, revision: version })
        .then(
          (result) =>
            cb(null, {
              applied_version: result.revision,
              pod_name: deps.podName,
              applied_at: { seconds: Math.floor(nowMs / 1000), nanos: (nowMs % 1000) * 1_000_000 },
            }),
          (err: unknown) => fail(grpc.status.INTERNAL, err instanceof Error ? err.message : 'control-failed'),
        );
    },
  };
  return { definition: controlPackage().ControlReceiver.service, handlers };
}

/** 제어 전용 gRPC 포트를 연다(<서비스>-control, 업무 포트와 다른 포트, ADR-0102) */
export function startQueueControlServer(o: { host: string; port: number; deps: QueueControlDeps }): Promise<{ port: number; close(): Promise<void> }> {
  return startGrpcServer({ host: o.host, port: o.port, services: [saleSuspensionControlBinding(o.deps)] });
}
