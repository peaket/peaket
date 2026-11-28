// 런북 CLI의 실제 제어 gRPC 전송(IR027-01). 받는 쪽 네 서비스의 ApplyControl에 runbook_bundle을 싣는다.
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { controlV1Control } from '@peaket/contracts/proto';
import { createGrpcClient } from '@peaket/platform';
import type { RunbookControlAck, RunbookControlRequest, RunbookControlTransport } from '../domain/ports.js';

const PROTO_LOAD_OPTIONS: protoLoader.Options = { keepCase: true, longs: Number, enums: String, defaults: true, oneofs: true };
/** ApplyControl 데드라인 1초 [가정](control-tower §3) */
const DEADLINE_MS = 1_000;

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

class Sender {
  readonly #client: grpc.Client & { ApplyControl: Unary };
  constructor(address: string) {
    const { host, port } = hostPortOf(address);
    this.#client = createGrpcClient(controlPackage().ControlReceiver, { host, port, profile: 'service', dependency: 'runbook-control', timeoutCapMs: DEADLINE_MS }) as unknown as grpc.Client & { ApplyControl: Unary };
  }
  apply(req: RunbookControlRequest): Promise<RunbookControlAck> {
    const deadline = new Date(Date.now() + DEADLINE_MS);
    return new Promise((resolve, reject) => {
      this.#client.ApplyControl(
        {
          command_id: req.commandId,
          scope: req.scope,
          kind: req.kind,
          version: req.version,
          desired_state_json: req.desiredStateJson,
          runbook_bundle: {
            canonical_bundle: req.canonicalBundle,
            signatures: req.signatures.map((s) => ({ key_id: s.keyId, signature: s.signature })),
          },
        },
        new grpc.Metadata(),
        { deadline },
        (e, v) => {
          if (e) return reject(e);
          const applied = Number(v?.applied_version ?? 0);
          const podName = typeof v?.pod_name === 'string' ? v.pod_name : '';
          if (!Number.isSafeInteger(applied) || applied < 0) return reject(new Error('제어 ack의 applied_version이 올바르지 않다'));
          const t = v?.applied_at as { seconds?: number; nanos?: number } | undefined;
          const appliedAtMs = typeof t?.seconds === 'number' ? t.seconds * 1000 + Math.floor((t.nanos ?? 0) / 1_000_000) : Date.now();
          resolve({ appliedVersion: applied, podName, appliedAtMs });
        },
      );
    });
  }
  close(): void {
    this.#client.close();
  }
}

/** 주소마다 클라이언트를 하나 두고 닫을 때 모두 닫는다 */
export class GrpcRunbookControlTransport implements RunbookControlTransport {
  readonly #senders = new Map<string, Sender>();
  send(address: string, request: RunbookControlRequest): Promise<RunbookControlAck> {
    let sender = this.#senders.get(address);
    if (!sender) {
      sender = new Sender(address);
      this.#senders.set(address, sender);
    }
    return sender.apply(request);
  }
  close(): void {
    for (const s of this.#senders.values()) s.close();
    this.#senders.clear();
  }
}
