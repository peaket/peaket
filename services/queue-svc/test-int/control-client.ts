// 제어 gRPC ControlReceiver.ApplyControl의 시험 클라이언트(BUILD_ORDER F-02-1 OPS-300, ADR-0102·0103·0365).
// 생성물이 아니라 계약 원본 docs/api/proto/peaket/control/v1/control.proto를 그대로 읽어, 받는 쪽이 정본 계약으로 답하는지 본다.
// queue-svc·admission-ctrl·purchase-svc·ops-svc 통합 시험이 상대 경로로 함께 쓴다(admission-ctrl은 gRPC 의존이 없어 이 파일 자리의 의존을 쓴다).
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

const PROTO_ROOT = fileURLToPath(new URL('../../../docs/api/proto', import.meta.url));
const PROTO_FILE = 'peaket/control/v1/control.proto';

/** gRPC 상태 코드(@grpc/grpc-js 상수 그대로) */
export const status = grpc.status;

export interface ApplyRequest {
  readonly commandId: string;
  readonly scope: string;
  readonly kind: string;
  /** 판 번호. 안전 정수 밖 값을 그대로 싣고 싶으면 10진 글로 준다(int64) */
  readonly version: number | string;
  readonly desiredStateJson: string;
}

export interface ApplyAck {
  readonly appliedVersion: number;
  readonly podName: string;
  readonly appliedAtMs: number;
}

export interface ControlClient {
  /** 데드라인 기본 1초(control-tower §5 '직접 제어 채널'의 1초 [가정]). 거절은 ServiceError(code·details)로 던진다 */
  apply(r: ApplyRequest, deadlineMs?: number): Promise<ApplyAck>;
  close(): void;
}

type Unary = (req: object, md: grpc.Metadata, opts: grpc.CallOptions, cb: (e: grpc.ServiceError | null, v?: Record<string, unknown>) => void) => void;

let ctor: grpc.ServiceClientConstructor | undefined;
function receiver(): grpc.ServiceClientConstructor {
  if (!ctor) {
    const def = protoLoader.loadSync(PROTO_FILE, { includeDirs: [PROTO_ROOT], keepCase: true, longs: String, enums: String, defaults: true, oneofs: true });
    const pkg = grpc.loadPackageDefinition(def) as { peaket: { control: { v1: { ControlReceiver: grpc.ServiceClientConstructor } } } };
    ctor = pkg.peaket.control.v1.ControlReceiver;
  }
  return ctor;
}

export function controlClient(address: string): ControlClient {
  const Ctor = receiver();
  const client = new Ctor(address, grpc.credentials.createInsecure());
  const call = (client as unknown as Record<string, Unary>).ApplyControl!.bind(client);
  return {
    apply: (r, deadlineMs = 1_000) =>
      new Promise<ApplyAck>((resolve, reject) => {
        call(
          { command_id: r.commandId, scope: r.scope, kind: r.kind, version: r.version, desired_state_json: r.desiredStateJson },
          new grpc.Metadata(),
          { deadline: new Date(Date.now() + deadlineMs) },
          (e, v) => {
            if (e) return reject(e);
            const at = v?.applied_at as { seconds?: string; nanos?: number } | undefined;
            resolve({
              appliedVersion: Number(v?.applied_version ?? 0),
              podName: String(v?.pod_name ?? ''),
              appliedAtMs: at ? Number(at.seconds ?? 0) * 1000 + Math.floor((at.nanos ?? 0) / 1_000_000) : 0,
            });
          },
        );
      }),
    close: () => client.close(),
  };
}

/** 빈 TCP 포트 하나(통합 시험에서 서비스 시작 함수에 넘긴다) */
export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const a = s.address();
      const port = typeof a === 'object' && a ? a.port : 0;
      s.close(() => resolve(port));
    });
  });
}
