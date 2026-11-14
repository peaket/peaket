// 제어 gRPC 받는 쪽(peaket.control.v1.ControlReceiver.ApplyControl)의 purchase-svc 구현(BAT-465 R-584, ADR-0102·0103·0123).
// 이번 몫은 CONTROL_KIND_SALE_SUSPENSION(판매 승인 업무의 판매 중지·재개)만 받는다. 다른 종류는 UNIMPLEMENTED다.
// 판 번호(request.version)가 지금 값보다 클 때만 쓰고, 같거나 작으면 아무것도 바꾸지 않고 지금 적용한 판 번호만 돌려준다(멱등).
// 응답의 applied_version은 이 파드가 적용한 판 번호다. ops-svc는 준비된 파드가 요청한 판 이상을 답했는지 이것으로 센다.
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { controlV1Control } from '@peaket/contracts/proto';
import { grpcServerOptions } from '@peaket/platform';
import type { SetSaleSuspension } from '../modules/sale-control/index.js';

export const CONTROL_KIND_SALE_SUSPENSION = 'CONTROL_KIND_SALE_SUSPENSION';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROTO_LOAD_OPTIONS: protoLoader.Options = { keepCase: true, longs: Number, enums: String, defaults: true, oneofs: true };

export interface ControlAck {
  readonly appliedVersion: number;
  readonly podName: string;
  readonly appliedAtMs: number;
}

/** 제어 요청 하나(proto ApplyControlRequest의 칸) */
export interface ControlRequest {
  readonly commandId: string;
  readonly scope: string;
  readonly kind: string;
  readonly version: number;
  readonly desiredStateJson: string;
}

export interface ControlDeps {
  readonly setSuspension: SetSaleSuspension;
  readonly podName: string;
  readonly nowMs?: () => number;
}

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

/** ApplyControl 하나를 처리한다. 던지지 않고 grpc 오류로 답한다 */
export async function applyControl(req: ControlRequest, deps: ControlDeps): Promise<ControlAck> {
  if (req.kind !== CONTROL_KIND_SALE_SUSPENSION) throw Object.assign(new Error('이 제어 종류는 아직 받지 않는다'), { code: grpc.status.UNIMPLEMENTED });
  if (!UUID.test(req.scope)) throw Object.assign(new Error('scope는 회차 ID여야 한다'), { code: grpc.status.INVALID_ARGUMENT });
  if (!UUID.test(req.commandId)) throw Object.assign(new Error('command_id는 UUID여야 한다'), { code: grpc.status.INVALID_ARGUMENT });
  if (!Number.isSafeInteger(req.version) || req.version < 0) throw Object.assign(new Error('version은 0 이상의 정수여야 한다'), { code: grpc.status.INVALID_ARGUMENT });
  const suspended = suspendedOf(req.desiredStateJson);
  if (suspended === undefined) throw Object.assign(new Error('desired_state_json이 {"suspended": bool}이 아니다'), { code: grpc.status.INVALID_ARGUMENT });
  const nowMs = deps.nowMs?.() ?? Date.now();
  const result = await deps.setSuspension.run({
    eventId: req.scope,
    action: suspended ? 'SUSPEND' : 'RESUME',
    commandId: req.commandId,
    reason: `control:${req.kind}`,
    nowMs,
    version: req.version,
  });
  return { appliedVersion: result.revision, podName: deps.podName, appliedAtMs: nowMs };
}

function controlPackage(): { ControlReceiver: grpc.ServiceDefinition } {
  const def = protoLoader.fromJSON(controlV1Control as Parameters<typeof protoLoader.fromJSON>[0], PROTO_LOAD_OPTIONS);
  return (grpc.loadPackageDefinition(def) as unknown as { peaket: { control: { v1: { ControlReceiver: grpc.ServiceDefinition } } } }).peaket.control.v1;
}

/** 제어 gRPC 서버를 연다. 업무 포트와 다른 제어 전용 포트다(<서비스>-control, ADR-0102) */
export async function startControlServer(o: { host: string; port: number; deps: ControlDeps }): Promise<{ port: number; close(): Promise<void> }> {
  const server = new grpc.Server(grpcServerOptions('service'));
  const handlers: grpc.UntypedServiceImplementation = {
    ApplyControl: (call: grpc.ServerUnaryCall<Record<string, unknown>, unknown>, cb: grpc.sendUnaryData<unknown>) => {
      const r = call.request;
      const req: ControlRequest = {
        commandId: String(r.command_id ?? ''),
        scope: String(r.scope ?? ''),
        kind: String(r.kind ?? ''),
        version: Number(r.version ?? 0),
        desiredStateJson: String(r.desired_state_json ?? ''),
      };
      applyControl(req, o.deps).then(
        (ack) =>
          cb(null, {
            applied_version: ack.appliedVersion,
            pod_name: ack.podName,
            applied_at: { seconds: Math.floor(ack.appliedAtMs / 1000), nanos: (ack.appliedAtMs % 1000) * 1_000_000 },
          }),
        (err: unknown) => cb({ code: (err as { code?: number }).code ?? grpc.status.INTERNAL, message: err instanceof Error ? err.message : 'control-failed' }),
      );
    },
  };
  server.addService(controlPackage().ControlReceiver, handlers);
  const port = await new Promise<number>((res, rej) => server.bindAsync(`${o.host}:${o.port}`, grpc.ServerCredentials.createInsecure(), (e, p) => (e ? rej(e) : res(p))));
  return {
    port,
    close: () =>
      new Promise<void>((res) => {
        const timer = setTimeout(() => {
          server.forceShutdown();
          res();
        }, 10_000);
        timer.unref();
        server.tryShutdown(() => {
          clearTimeout(timer);
          res();
        });
      }),
  };
}
