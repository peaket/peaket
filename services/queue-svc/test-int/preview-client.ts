// 제어 gRPC ControlReceiver.PreviewControl의 시험 클라이언트(BUILD_ORDER F-02-5 OPS-300, ADR-0365 결정 11·16, 계획 docs/review/plans/F-02-5.md 8.1).
// control-client.ts와 같이 생성물이 아니라 계약 원본 docs/api/proto/peaket/control/v1/control.proto를 그대로 읽어, 받는 쪽이 정본 계약으로 답하는지 본다.
// queue-svc·admission-ctrl·purchase-svc 통합 시험이 상대 경로로 함께 쓴다(admission-ctrl은 gRPC 의존이 없어 이 파일 자리의 의존을 쓴다).
import { fileURLToPath } from 'node:url';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

const PROTO_ROOT = fileURLToPath(new URL('../../../docs/api/proto', import.meta.url));
const PROTO_FILE = 'peaket/control/v1/control.proto';

export interface PreviewRequest {
  readonly scope: string;
  readonly kind: string;
  readonly keys: readonly string[];
}

export interface PreviewAnswer {
  readonly counts: readonly { readonly key: string; readonly value: number; readonly source: string; readonly measuredAtMs: number }[];
  readonly unavailable: readonly { readonly key: string; readonly reason: string }[];
  readonly podName: string;
}

export interface PreviewClient {
  /** 데드라인 기본 1초(ADR-0365 결정 11 '데드라인 1초'). 거절은 ServiceError(code·details)로 던진다 */
  preview(r: PreviewRequest, deadlineMs?: number): Promise<PreviewAnswer>;
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

const msOf = (t: unknown): number => {
  const at = t as { seconds?: string | number; nanos?: number } | undefined;
  return at ? Number(at.seconds ?? 0) * 1000 + Math.floor((at.nanos ?? 0) / 1_000_000) : Number.NaN;
};

export function previewClient(address: string): PreviewClient {
  const Ctor = receiver();
  const client = new Ctor(address, grpc.credentials.createInsecure());
  // type-escape: proto-loader가 만든 동적 클라이언트는 메서드 타입이 없다(control-client.ts와 같은 꼴, 가짜 끼우기가 아니다) F-02-5
  const method = (client as unknown as Record<string, Unary | undefined>).PreviewControl;
  if (typeof method !== 'function') throw new Error('계약 원본 control.proto에 ControlReceiver.PreviewControl이 없다(ADR-0365 결정 16)');
  const call = method.bind(client);
  return {
    preview: (r, deadlineMs = 1_000) =>
      new Promise<PreviewAnswer>((resolve, reject) => {
        call({ scope: r.scope, kind: r.kind, keys: [...r.keys] }, new grpc.Metadata(), { deadline: new Date(Date.now() + deadlineMs) }, (e, v) => {
          if (e) return reject(e);
          const counts = ((v?.counts ?? []) as Record<string, unknown>[]).map((c) => ({ key: String(c.key), value: Number(c.value), source: String(c.source), measuredAtMs: msOf(c.measured_at) }));
          const unavailable = ((v?.unavailable ?? []) as Record<string, unknown>[]).map((u) => ({ key: String(u.key), reason: String(u.reason) }));
          resolve({ counts, unavailable, podName: String(v?.pod_name ?? '') });
        });
      }),
    close: () => client.close(),
  };
}
