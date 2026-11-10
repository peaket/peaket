// image-worker ImageService.ProcessImage 클라이언트(docs/api/proto/peaket/image/v1/image.proto, ADR-0257 결정 1).
// HOT-190의 어댑터는 요청 안에서 바로 부른다(데드라인 30초 [가정]). HOT-200이 '작업을 적고 결과를 기다리는' 어댑터로 바꾼다.
// gRPC 오류와 데드라인 초과는 ImageProcessingUnavailable(→ 503 Retry-After 30, fail-closed)이다. 답의 값은 유스케이스가 다시 검사한다.
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { imageV1Image } from '@peaket/contracts/proto';
import { createGrpcClient, type GrpcLbProfile } from '@peaket/platform';
import { type ImageProcessing, ImageProcessingUnavailable, type ProcessOutcome } from '../domain/media-ports.js';
import type { ImageKind } from '../domain/production-image.js';
import { hostPort } from './seatmap-worker-client.js';

export const IMAGE_DEADLINE_MS = 30_000;
const PROTO_LOAD_OPTIONS: protoLoader.Options = { keepCase: true, longs: Number, enums: String, defaults: true, oneofs: true };
const REASONS: Record<string, 'UNSUPPORTED_TYPE' | 'TOO_LARGE' | 'TOO_SMALL' | 'MALWARE'> = {
  IMAGE_REJECT_REASON_UNSUPPORTED_TYPE: 'UNSUPPORTED_TYPE',
  IMAGE_REJECT_REASON_TOO_LARGE: 'TOO_LARGE',
  IMAGE_REJECT_REASON_TOO_SMALL: 'TOO_SMALL',
  IMAGE_REJECT_REASON_MALWARE: 'MALWARE',
};
/** 파생본 키 목록의 상한(뚫린 작업이 끝없이 긴 목록을 주지 못하게, 정상은 8개) */
const KEYS_MAX = 64;

type Unary = (req: object, md: grpc.Metadata, opts: grpc.CallOptions, cb: (e: grpc.ServiceError | null, v?: Record<string, unknown>) => void) => grpc.ClientUnaryCall;

export class GrpcImageProcessing implements ImageProcessing {
  readonly #client: grpc.Client & { ProcessImage: Unary };

  constructor(address: string, profile: GrpcLbProfile = 'service') {
    const def = protoLoader.fromJSON(imageV1Image as Parameters<typeof protoLoader.fromJSON>[0], PROTO_LOAD_OPTIONS);
    const pkg = (grpc.loadPackageDefinition(def) as unknown as { peaket: { image: { v1: Record<string, unknown> } } }).peaket.image.v1;
    const { host, port } = hostPort(address, 'PEAKET_IMAGE_GRPC_URL');
    this.#client = createGrpcClient(pkg.ImageService as grpc.ServiceClientConstructor, { host, port, profile, dependency: 'image-worker', timeoutCapMs: IMAGE_DEADLINE_MS }) as unknown as grpc.Client & {
      ProcessImage: Unary;
    };
  }

  process(q: { sourceKey: string; kind: ImageKind; timeoutMs: number }): Promise<ProcessOutcome> {
    return new Promise((resolve, reject) => {
      // 공연 포스터·상세 이미지는 같은 종류(IMAGE_KIND_PRODUCTION)이고, 종류별 크기 기준은 core-svc가 다시 본다
      this.#client.ProcessImage({ source_key: q.sourceKey, kind: 'IMAGE_KIND_PRODUCTION' }, new grpc.Metadata(), { deadline: Date.now() + Math.min(IMAGE_DEADLINE_MS, q.timeoutMs) }, (e, v) => {
        if (e) {
          reject(new ImageProcessingUnavailable(grpc.status[e.code] ?? String(e.code)));
          return;
        }
        const r = v ?? {};
        if (r.status === 'IMAGE_STATUS_ACCEPTED') {
          const keys = Array.isArray(r.derivative_keys) ? r.derivative_keys.slice(0, KEYS_MAX).filter((k): k is string => typeof k === 'string') : [];
          resolve({ status: 'ACCEPTED', width: Number(r.width), height: Number(r.height), derivativeKeys: keys });
        } else if (r.status === 'IMAGE_STATUS_REJECTED') resolve({ status: 'REJECTED', reason: REASONS[String(r.reject_reason)] ?? 'UNKNOWN' });
        else if (r.status === 'IMAGE_STATUS_SCAN_PENDING') resolve({ status: 'SCAN_PENDING' });
        else resolve({ status: 'UNKNOWN' });
      });
    });
  }

  close(): void {
    this.#client.close();
  }
}
