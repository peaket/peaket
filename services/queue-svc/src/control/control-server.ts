// 제어 gRPC 받는 쪽(peaket.control.v1.ControlReceiver.ApplyControl)의 queue-svc 구현(BAT-465 R-584, F-02-1 OPS-300, ADR-0102·0103·0123·0365).
// 받는 종류: CONTROL_KIND_SALE_SUSPENSION(판매 중지·재개, notice·ctl 사본), CONTROL_KIND_SALE_PAUSE(명령 3)·CONTROL_KIND_LOBBY_BANNER(명령 7, q:{event:E}:notice,
// 전체는 q:{event:PLATFORM}:notice). 다른 종류는 UNIMPLEMENTED다. 판 번호는 1 이상 안전 정수만 받고(ASVS 1.4.2·15.3.5), 바라는 상태는 종류마다 정한 꼴만 받는다
// (모르는 칸·틀린 꼴은 INVALID_ARGUMENT이고 아무것도 쓰지 않는다, ASVS 2.1.1). 판이 지금 칸보다 클 때만 쓰고 쓴 뒤(또는 지금)의 판을 돌려준다.
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { controlV1Control } from '@peaket/contracts/proto';
import { type RunbookGateConfig, type RunbookProtoBundle, withRunbookControl } from '@peaket/platform';
import { type GrpcServiceBinding, startGrpcServer } from '../grpc-server.js';
import { QUEUE_NOTICE_KINDS, QueueNoticeRejected, type QueueNoticeKind, type SetQueueNotice, type SetSaleSuspensionCopy } from '../modules/sale/index.js';

export const CONTROL_KIND_SALE_SUSPENSION = 'CONTROL_KIND_SALE_SUSPENSION';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROTO_LOAD_OPTIONS: protoLoader.Options = { keepCase: true, longs: Number, enums: String, defaults: true, oneofs: true };

/** 판매 중지·재개의 바라는 상태({"suspended": true|false}, 칸 하나)를 읽는다. 모르는 칸·모양이면 undefined */
export function suspendedOf(json: string): boolean | undefined {
  try {
    const v: unknown = JSON.parse(json);
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return undefined;
    const keys = Object.keys(v);
    if (keys.length !== 1 || keys[0] !== 'suspended') return undefined;
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
  /** 명령 3·7 받는 쪽(없으면 두 종류도 UNIMPLEMENTED) */
  readonly setNotice?: SetQueueNotice;
  readonly podName: string;
  readonly nowMs?: () => number;
  readonly onError?: (method: string, err: unknown) => void;
  /** 런북 서명 관문 설정(없으면 묶음이 올 때 bundle-malformed) */
  readonly runbook?: RunbookGateConfig;
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
      const nowMs = deps.nowMs?.() ?? Date.now();
      const ack = (applied: number): void =>
        cb(null, {
          applied_version: applied,
          pod_name: deps.podName,
          applied_at: { seconds: Math.floor(nowMs / 1000), nanos: (nowMs % 1000) * 1_000_000 },
        });
      const failed = (err: unknown): void => {
        if (err instanceof QueueNoticeRejected) return fail(grpc.status.INVALID_ARGUMENT, `${err.why}가 올바르지 않다`);
        const code = (err as { code?: unknown }).code;
        return fail(typeof code === 'number' ? code : grpc.status.INTERNAL, err instanceof Error ? err.message : 'control-failed');
      };
      const inner = async (): Promise<number> => {
        const notice = (QUEUE_NOTICE_KINDS as readonly string[]).includes(kind) && deps.setNotice !== undefined;
        if (kind !== CONTROL_KIND_SALE_SUSPENSION && !notice) throw Object.assign(new Error('이 제어 종류는 받지 않는다'), { code: grpc.status.UNIMPLEMENTED });
        if (!UUID.test(commandId)) throw Object.assign(new Error('command_id는 UUID여야 한다'), { code: grpc.status.INVALID_ARGUMENT });
        if (!Number.isSafeInteger(version) || version <= 0) throw Object.assign(new Error('version은 1 이상의 안전 정수여야 한다'), { code: grpc.status.INVALID_ARGUMENT });
        if (notice) return deps.setNotice!.run({ kind: kind as QueueNoticeKind, scope, desiredStateJson: String(r.desired_state_json ?? ''), commandId, version });
        if (!UUID.test(scope)) throw Object.assign(new Error('scope는 회차 ID여야 한다'), { code: grpc.status.INVALID_ARGUMENT });
        const suspended = suspendedOf(String(r.desired_state_json ?? ''));
        if (suspended === undefined) throw Object.assign(new Error('desired_state_json이 {"suspended": bool}이 아니다'), { code: grpc.status.INVALID_ARGUMENT });
        const result = await deps.setSuspension.run({ eventId: scope, action: suspended ? 'SUSPEND' : 'RESUME', commandId, revision: version });
        return result.revision;
      };
      if (r.runbook_bundle) {
        withRunbookControl({
          config: deps.runbook,
          bundle: r.runbook_bundle as RunbookProtoBundle,
          request: { commandId, kind, scope, version, desiredStateJson: String(r.desired_state_json ?? '') },
          service: 'queue-svc',
          podName: deps.podName,
          apply: async () => {
            try {
              return await inner();
            } catch (err) {
              if (err instanceof QueueNoticeRejected) throw Object.assign(err, { code: grpc.status.INVALID_ARGUMENT });
              throw err;
            }
          },
        }).then(ack, failed);
        return;
      }
      inner().then(ack, failed);
    },
  };
  return { definition: controlPackage().ControlReceiver.service, handlers };
}

/** 제어 전용 gRPC 포트를 연다(<서비스>-control, 업무 포트와 다른 포트, ADR-0102) */
export function startQueueControlServer(o: { host: string; port: number; deps: QueueControlDeps }): Promise<{ port: number; close(): Promise<void> }> {
  return startGrpcServer({ host: o.host, port: o.port, services: [saleSuspensionControlBinding(o.deps)] });
}
