// 제어 gRPC 받는 쪽(peaket.control.v1.ControlReceiver.ApplyControl)의 queue-svc 구현(BAT-465 R-584, F-02-1 OPS-300, ADR-0102·0103·0123·0365).
// 받는 종류: CONTROL_KIND_SALE_SUSPENSION(판매 중지·재개, notice·ctl 사본), CONTROL_KIND_SALE_PAUSE(명령 3)·CONTROL_KIND_LOBBY_BANNER(명령 7, q:{event:E}:notice,
// 전체는 q:{event:PLATFORM}:notice). 다른 종류는 UNIMPLEMENTED다. 판 번호는 1 이상 안전 정수만 받고(ASVS 1.4.2·15.3.5), 바라는 상태는 종류마다 정한 꼴만 받는다
// (모르는 칸·틀린 꼴은 INVALID_ARGUMENT이고 아무것도 쓰지 않는다, ASVS 2.1.1). 판이 지금 칸보다 클 때만 쓰고 쓴 뒤(또는 지금)의 판을 돌려준다.
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { controlV1Control } from '@peaket/contracts/proto';
import { type GrpcServiceBinding, startGrpcServer } from '../grpc-server.js';
import { QUEUE_NOTICE_KINDS, QueueNoticeRejected, type QueueNoticeKind, type SetQueueNotice, type SetSaleSuspensionCopy } from '../modules/sale/index.js';
import type { PreviewWaiting } from '../modules/entry/index.js';

export const CONTROL_KIND_SALE_SUSPENSION = 'CONTROL_KIND_SALE_SUSPENSION';
export const CONTROL_KIND_SALE_PAUSE = 'CONTROL_KIND_SALE_PAUSE';
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
  /** 사전 모의(PreviewControl, F-02-5). 없으면 UNIMPLEMENTED다 */
  readonly preview?: Pick<PreviewWaiting, 'run'>;
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
      const notice = (QUEUE_NOTICE_KINDS as readonly string[]).includes(kind) && deps.setNotice !== undefined;
      if (kind !== CONTROL_KIND_SALE_SUSPENSION && !notice) return fail(grpc.status.UNIMPLEMENTED, '이 제어 종류는 받지 않는다');
      if (!UUID.test(commandId)) return fail(grpc.status.INVALID_ARGUMENT, 'command_id는 UUID여야 한다');
      if (!Number.isSafeInteger(version) || version <= 0) return fail(grpc.status.INVALID_ARGUMENT, 'version은 1 이상의 안전 정수여야 한다');
      const nowMs = deps.nowMs?.() ?? Date.now();
      const ack = (applied: number): void =>
        cb(null, {
          applied_version: applied,
          pod_name: deps.podName,
          applied_at: { seconds: Math.floor(nowMs / 1000), nanos: (nowMs % 1000) * 1_000_000 },
        });
      const failed = (err: unknown): void =>
        err instanceof QueueNoticeRejected ? fail(grpc.status.INVALID_ARGUMENT, `${err.why}가 올바르지 않다`) : fail(grpc.status.INTERNAL, err instanceof Error ? err.message : 'control-failed');
      if (notice) {
        deps.setNotice!.run({ kind: kind as QueueNoticeKind, scope, desiredStateJson: String(r.desired_state_json ?? ''), commandId, version }).then(ack, failed);
        return;
      }
      if (!UUID.test(scope)) return fail(grpc.status.INVALID_ARGUMENT, 'scope는 회차 ID여야 한다');
      const suspended = suspendedOf(String(r.desired_state_json ?? ''));
      if (suspended === undefined) return fail(grpc.status.INVALID_ARGUMENT, 'desired_state_json이 {"suspended": bool}이 아니다');
      deps.setSuspension.run({ eventId: scope, action: suspended ? 'SUSPEND' : 'RESUME', commandId, revision: version }).then((result) => ack(result.revision), failed);
    },
    PreviewControl: (call: grpc.ServerUnaryCall<Record<string, unknown>, unknown>, cb: grpc.sendUnaryData<unknown>) => {
      const fail = (code: number, message: string): void => {
        deps.onError?.('PreviewControl', new Error(message));
        cb({ code, message });
      };
      if (!deps.preview) return fail(grpc.status.UNIMPLEMENTED, '사전 모의를 조립하지 않았다');
      const r = call.request;
      if (String(r.kind ?? '') !== CONTROL_KIND_SALE_PAUSE) return fail(grpc.status.UNIMPLEMENTED, '이 사전 모의 종류는 받지 않는다');
      const scope = String(r.scope ?? '');
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(scope)) return fail(grpc.status.INVALID_ARGUMENT, 'scope는 소문자 회차 ID여야 한다');
      const keys = Array.isArray(r.keys) ? (r.keys as unknown[]).map((x) => String(x)) : [];
      if (keys.length === 0 || keys.length > 16) return fail(grpc.status.INVALID_ARGUMENT, 'keys는 1~16개여야 한다');
      deps.preview!.run({ eventId: scope, keys }).then(
        (p) =>
          cb(null, {
            counts: p.counts.map((c) => ({ key: c.key, value: c.value, source: c.source, measured_at: { seconds: Math.floor(c.measuredAtMs / 1000), nanos: (c.measuredAtMs % 1000) * 1_000_000 } })),
            unavailable: p.unavailable.map((u) => ({ key: u.key, reason: u.reason })),
            pod_name: deps.podName,
          }),
        (err: unknown) => fail(grpc.status.INTERNAL, err instanceof Error ? err.message : 'preview-failed'),
      );
    },
  };
  return { definition: controlPackage().ControlReceiver.service, handlers };
}

/** 제어 전용 gRPC 포트를 연다(<서비스>-control, 업무 포트와 다른 포트, ADR-0102) */
export function startQueueControlServer(o: { host: string; port: number; deps: QueueControlDeps }): Promise<{ port: number; close(): Promise<void> }> {
  return startGrpcServer({ host: o.host, port: o.port, services: [saleSuspensionControlBinding(o.deps)] });
}
