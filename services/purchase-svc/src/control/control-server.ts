// 제어 gRPC 받는 쪽(peaket.control.v1.ControlReceiver.ApplyControl)의 purchase-svc 구현(BAT-465 R-584, F-02-1 OPS-300, ADR-0102·0103·0123·0365).
// 받는 종류: CONTROL_KIND_SALE_SUSPENSION(판매 승인 업무의 판매 중지·재개, 회차 범위)과 CONTROL_KIND_SALE_PAUSE(명령 3 판매 일시정지, 회차·PLATFORM).
// 다른 종류는 UNIMPLEMENTED다. 판 번호(request.version)는 1 이상 안전 정수만 받고(0 이하·밖은 INVALID_ARGUMENT, ASVS 1.4.2·15.3.5),
// 바라는 상태는 종류마다 정한 꼴만 받는다(모르는 칸·틀린 꼴은 INVALID_ARGUMENT이고 아무것도 쓰지 않는다, ADR-0365 결정 2, ASVS 2.1.1).
// 판이 지금 값보다 클 때만 쓰고, 같거나 작으면 아무것도 바꾸지 않고 지금 적용한 판 번호만 돌려준다(멱등).
// 응답의 applied_version은 이 파드가 적용한 판 번호다. ops-svc는 준비된 파드가 요청한 판 이상을 답했는지 이것으로 센다.
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { controlV1Control } from '@peaket/contracts/proto';
import { grpcServerOptions } from '@peaket/platform';
import type { SetSalePause, SetSaleSuspension } from '../modules/sale-control/index.js';
import type { PreviewCounts } from '../modules/inventory/index.js';

export const CONTROL_KIND_SALE_SUSPENSION = 'CONTROL_KIND_SALE_SUSPENSION';
export const CONTROL_KIND_SALE_PAUSE = 'CONTROL_KIND_SALE_PAUSE';
/** 전체 범위 이름(ApplyControlRequest.scope) */
export const CONTROL_SCOPE_PLATFORM = 'PLATFORM';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** 명령 3의 회차 범위는 소문자 UUID만(ops-svc 원장의 범위 글과 같게, 좌석 Redis 키가 글자 그대로라) */
const LOWER_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
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
  /** 명령 3 받는 쪽. 없으면 SALE_PAUSE도 UNIMPLEMENTED다 */
  readonly setPause?: SetSalePause;
  readonly podName: string;
  readonly nowMs?: () => number;
  /** 사전 모의(PreviewControl). 없으면 UNIMPLEMENTED다(계획 8.3) */
  readonly preview?: Pick<PreviewCounts, 'run'>;
}

const invalid = (message: string): Error => Object.assign(new Error(message), { code: grpc.status.INVALID_ARGUMENT });

/**
 * 바라는 상태 JSON이 칸 하나(name)짜리 참거짓 객체인가(ADR-0365 결정 2). 모르는 칸·배열·다른 꼴은 undefined
 */
export function boolStateOf(json: string, name: string): boolean | undefined {
  let v: unknown;
  try {
    v = JSON.parse(json);
  } catch {
    return undefined;
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return undefined;
  const keys = Object.keys(v);
  if (keys.length !== 1 || keys[0] !== name) return undefined;
  const b = (v as Record<string, unknown>)[name];
  return typeof b === 'boolean' ? b : undefined;
}

/** 판매 중지·재개의 바라는 상태({"suspended": true|false})를 읽는다. 모르는 모양이면 undefined */
export const suspendedOf = (json: string): boolean | undefined => boolStateOf(json, 'suspended');

/** 판 번호 검사: 1 이상 안전 정수(ADR-0365 결정 1) */
export const validControlVersion = (v: number): boolean => Number.isSafeInteger(v) && v > 0;

/** ApplyControl 하나를 처리한다. 거절은 grpc 상태 코드를 단 Error로 던진다 */
export async function applyControl(req: ControlRequest, deps: ControlDeps): Promise<ControlAck> {
  const pause = req.kind === CONTROL_KIND_SALE_PAUSE && deps.setPause !== undefined;
  if (req.kind !== CONTROL_KIND_SALE_SUSPENSION && !pause) throw Object.assign(new Error('이 제어 종류는 받지 않는다'), { code: grpc.status.UNIMPLEMENTED });
  if (!UUID.test(req.commandId)) throw invalid('command_id는 UUID여야 한다');
  if (!validControlVersion(req.version)) throw invalid('version은 1 이상의 안전 정수여야 한다');
  const nowMs = deps.nowMs?.() ?? Date.now();
  if (pause) {
    if (req.scope !== CONTROL_SCOPE_PLATFORM && !LOWER_UUID.test(req.scope)) throw invalid('scope는 PLATFORM이나 소문자 회차 ID여야 한다');
    const paused = boolStateOf(req.desiredStateJson, 'paused');
    if (paused === undefined) throw invalid('desired_state_json이 {"paused": bool}이 아니다');
    const scope = req.scope === CONTROL_SCOPE_PLATFORM ? ({ kind: 'PLATFORM' } as const) : ({ kind: 'EVENT', eventId: req.scope } as const);
    const r = await deps.setPause!.run({ scope, paused, commandId: req.commandId, version: req.version, nowMs });
    return { appliedVersion: r.appliedVersion, podName: deps.podName, appliedAtMs: nowMs };
  }
  if (!UUID.test(req.scope)) throw invalid('scope는 회차 ID여야 한다');
  const suspended = suspendedOf(req.desiredStateJson);
  if (suspended === undefined) throw invalid('desired_state_json이 {"suspended": bool}이 아니다');
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

/** 사전 모의 요청 하나(읽기 전용). 명령 3 종류·소문자 회차·키 1~16개만 받는다 */
export async function previewControl(
  r: Record<string, unknown>,
  deps: ControlDeps,
): Promise<{ counts: readonly { key: string; value: number; source: string; measuredAtMs: number }[]; unavailable: readonly { key: string; reason: string }[]; podName: string }> {
  const fail = (code: number, message: string): never => {
    throw Object.assign(new Error(message), { code });
  };
  void fail;
  void r;
  return { counts: [], unavailable: [], podName: deps.podName };
}

// loadPackageDefinition은 서비스마다 클라이언트 생성자를 준다. 서버에는 그 생성자의 서비스 정의(.service)를 넘긴다(F-02-1에서 고침: 생성자를 넘기면 제어 포트를 열 때 던졌다)
function controlPackage(): { ControlReceiver: { service: grpc.ServiceDefinition } } {
  const def = protoLoader.fromJSON(controlV1Control as Parameters<typeof protoLoader.fromJSON>[0], PROTO_LOAD_OPTIONS);
  return (grpc.loadPackageDefinition(def) as unknown as { peaket: { control: { v1: { ControlReceiver: { service: grpc.ServiceDefinition } } } } }).peaket.control.v1;
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
    PreviewControl: (call: grpc.ServerUnaryCall<Record<string, unknown>, unknown>, cb: grpc.sendUnaryData<unknown>) => {
      previewControl(call.request, o.deps).then(
        (r) =>
          cb(null, {
            counts: r.counts.map((c) => ({ key: c.key, value: c.value, source: c.source, measured_at: { seconds: Math.floor(c.measuredAtMs / 1000), nanos: (c.measuredAtMs % 1000) * 1_000_000 } })),
            unavailable: r.unavailable.map((u) => ({ key: u.key, reason: u.reason })),
            pod_name: r.podName,
          }),
        (err: unknown) => cb({ code: (err as { code?: number }).code ?? grpc.status.INTERNAL, message: err instanceof Error ? err.message : 'preview-failed' }),
      );
    },
  };
  server.addService(controlPackage().ControlReceiver.service, handlers);
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
