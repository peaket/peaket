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

export interface ControlSender {
  apply(req: ControlRequest): Promise<ControlAck>;
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
  readonly #client: grpc.Client & { ApplyControl: Unary };

  /** @throws Error 주소가 host:port 모양이 아님(시작 실패) */
  constructor(o: GrpcControlSenderOptions) {
    const { host, port } = hostPortOf(o.address);
    this.#client = createGrpcClient(controlPackage().ControlReceiver, {
      host,
      port,
      profile: o.profile ?? 'service',
      dependency: o.dependency,
      timeoutCapMs: CONTROL_DEADLINE_MS,
    }) as unknown as grpc.Client & { ApplyControl: Unary };
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

  close(): void {
    this.#client.close();
  }
}
