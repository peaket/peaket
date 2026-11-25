// 제어 gRPC 부르는 쪽(peaket.control.v1.ControlReceiver.ApplyControl)의 ops-svc 클라이언트(BAT-465 R-584, ADR-0102·0103).
// 판매 중지·재개는 이 길이 정본이다(HTTP 내부 경로는 주소가 없을 때의 호환 경로다).
// 데드라인 1초 [가정], 같은 명령 ID·판 번호로 다시 보내면 같은 결과다(받는 쪽이 판 번호로 거른다).
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { controlV1Control } from '@peaket/contracts/proto';
import { createGrpcClient, type GrpcLbProfile } from '@peaket/platform';

const PROTO_LOAD_OPTIONS: protoLoader.Options = { keepCase: true, longs: Number, enums: String, defaults: true, oneofs: true };
/** ApplyControl 데드라인 1초 [가정](control-tower §3) */
export const CONTROL_DEADLINE_MS = 1_000;

export interface ControlRequest {
  readonly commandId: string;
  readonly scope: string;
  readonly kind: string;
  readonly version: number;
  readonly desiredStateJson: string;
}

export interface ControlAck {
  readonly appliedVersion: number;
  readonly podName: string;
}

export interface PreviewRequest {
  readonly scope: string;
  readonly kind: string;
  readonly keys: readonly string[];
}

export interface PreviewResponse {
  readonly counts: readonly { readonly key: string; readonly value: number; readonly source: string; readonly measuredAtMs: number }[];
  readonly unavailable: readonly { readonly key: string; readonly reason: string }[];
  readonly podName: string;
}

export interface ControlSender {
  apply(req: ControlRequest): Promise<ControlAck>;
  preview?(req: PreviewRequest): Promise<PreviewResponse>;
  close(): void;
}

type Unary = (req: object, md: grpc.Metadata, opts: grpc.CallOptions, cb: (e: grpc.ServiceError | null, v?: Record<string, unknown>) => void) => grpc.ClientUnaryCall;
type ControlPackage = { ControlReceiver: grpc.ServiceClientConstructor };

let loaded: ControlPackage | undefined;
function controlPackage(): ControlPackage {
  if (!loaded) {
    const def = protoLoader.fromJSON(controlV1Control as Parameters<typeof protoLoader.fromJSON>[0], PROTO_LOAD_OPTIONS);
    loaded = (grpc.loadPackageDefinition(def) as unknown as { peaket: { control: { v1: ControlPackage } } }).peaket.control.v1;
  }
  return loaded;
}

function hostPortOf(address: string): { host: string; port: number } {
  const at = address.lastIndexOf(':');
  const port = Number(address.slice(at + 1));
  if (at <= 0 || !Number.isInteger(port) || port <= 0 || port > 65_535) throw new Error('제어 gRPC 주소는 host:port여야 한다');
  return { host: address.slice(0, at), port };
}

export interface GrpcControlSenderOptions {
  readonly address: string;
  readonly dependency: string;
  readonly profile?: GrpcLbProfile;
}

export class GrpcControlSender implements ControlSender {
  readonly #client: grpc.Client & { ApplyControl: Unary; PreviewControl: Unary };

  /** @throws Error 주소가 host:port 모양이 아님(시작 실패) */
  constructor(o: GrpcControlSenderOptions) {
    const { host, port } = hostPortOf(o.address);
    this.#client = createGrpcClient(controlPackage().ControlReceiver, {
      host,
      port,
      profile: o.profile ?? 'service',
      dependency: o.dependency,
      timeoutCapMs: CONTROL_DEADLINE_MS,
    }) as unknown as grpc.Client & { ApplyControl: Unary; PreviewControl: Unary };
  }

  apply(req: ControlRequest): Promise<ControlAck> {
    const deadline = new Date(Date.now() + CONTROL_DEADLINE_MS);
    return new Promise<ControlAck>((resolve, reject) => {
      this.#client.ApplyControl(
        {
          command_id: req.commandId,
          scope: req.scope,
          kind: req.kind,
          version: req.version,
          desired_state_json: req.desiredStateJson,
        },
        new grpc.Metadata(),
        { deadline },
        (e, v) => {
          if (e) return reject(e);
          const applied = Number(v?.applied_version ?? 0);
          const podName = typeof v?.pod_name === 'string' ? v.pod_name : '';
          if (!Number.isSafeInteger(applied) || applied < 0) return reject(new Error('제어 ack의 applied_version이 올바르지 않다'));
          resolve({ appliedVersion: applied, podName });
        },
      );
    });
  }

  preview(req: PreviewRequest): Promise<PreviewResponse> {
    const deadline = new Date(Date.now() + CONTROL_DEADLINE_MS);
    return new Promise<PreviewResponse>((resolve, reject) => {
      this.#client.PreviewControl(
        { scope: req.scope, kind: req.kind, keys: [...req.keys] },
        new grpc.Metadata(),
        { deadline },
        (e, v) => {
          if (e) {
            if (e.code === grpc.status.DEADLINE_EXCEEDED) return reject(Object.assign(new Error('preview-deadline'), { name: 'TimeoutError', code: e.code }));
            return reject(Object.assign(new Error(e.details ?? e.message), { code: e.code, details: e.details }));
          }
          const rawCounts = Array.isArray(v?.counts) ? (v!.counts as Record<string, unknown>[]) : [];
          const rawUnavailable = Array.isArray(v?.unavailable) ? (v!.unavailable as Record<string, unknown>[]) : [];
          const tsMs = (t: unknown): number => {
            const x = t as { seconds?: number | string; nanos?: number } | undefined;
            return Number(x?.seconds ?? 0) * 1_000 + Math.floor(Number(x?.nanos ?? 0) / 1_000_000);
          };
          resolve({
            counts: rawCounts.map((c) => ({
              key: String(c.key ?? ''),
              value: Number(c.value ?? Number.NaN),
              source: String(c.source ?? ''),
              measuredAtMs: tsMs(c.measured_at),
            })),
            unavailable: rawUnavailable.map((u) => ({ key: String(u.key ?? ''), reason: String(u.reason ?? '') })),
            podName: typeof v?.pod_name === 'string' ? v.pod_name : '',
          });
        },
      );
    });
  }

  close(): void {
    this.#client.close();
  }
}

/**
 * 주소마다 클라이언트 하나를 두는 제어 gRPC 길(F-02-1, ADR-0365 결정 3·4: ControlTransport). 주소는 대상 찾기 포트가 준 것만 부른다.
 * 처음 부르는 주소에 클라이언트를 만들고 닫을 때 모두 닫는다
 */
export class GrpcControlTransport {
  readonly #senders = new Map<string, ControlSender>();

  constructor(private readonly make: (address: string, service: string) => ControlSender = (address, service) => new GrpcControlSender({ address, dependency: `${service}-control` })) {}

  apply(service: string, address: string, req: ControlRequest): Promise<ControlAck> {
    const key = `${service}|${address}`;
    let sender = this.#senders.get(key);
    if (!sender) {
      sender = this.make(address, service);
      this.#senders.set(key, sender);
    }
    return sender.apply(req);
  }

  /** 읽기 전용 사전 모의(PreviewControl). 부르는 쪽은 주소를 ControlTargets에서만 받는다 */
  preview(service: string, address: string, req: PreviewRequest): Promise<PreviewResponse> {
    const key = `${service}|${address}`;
    let sender = this.#senders.get(key);
    if (!sender) {
      sender = this.make(address, service);
      this.#senders.set(key, sender);
    }
    return sender.preview!(req);
  }

  close(): void {
    for (const s of this.#senders.values()) s.close();
    this.#senders.clear();
  }
}
