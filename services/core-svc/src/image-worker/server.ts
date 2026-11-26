// F-10-2 image-worker gRPC 서버(계획 docs/review/plans/F-10-2.md §3·§5, docs/api/proto/peaket/image/v1/image.proto, ADR-0148 결정 8).
// ProcessImage 하나만 연다. source_key는 정한 격리 접두사·UUID만 받고, 검사 태그가 clean일 때만 디코딩한다.
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { imageV1Image } from '@peaket/contracts/proto';
import { grpcServerOptions, type PlatformLogger } from '@peaket/platform';
import { createImageQueue } from './queue.js';
import { derivativeNamesFor, prefixOf, stagingKey, type ImageKindProto } from './derivatives.js';
import { processImage } from './process.js';
import { scanVerdict } from './scan.js';
import { ImageObjectTooLarge, type ImageWorkerStore } from './s3.js';

const ID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const SOURCE = new RegExp(`^quarantine/(production|banner|review)/(${ID})$`);
const PROTO_LOAD_OPTIONS: protoLoader.Options = { keepCase: true, longs: Number, enums: String, defaults: true, oneofs: true };

export function imageServiceDefinition(): grpc.ServiceDefinition {
  const def = protoLoader.fromJSON(imageV1Image as Parameters<typeof protoLoader.fromJSON>[0], PROTO_LOAD_OPTIONS);
  const pkg = (grpc.loadPackageDefinition(def) as unknown as { peaket: { image: { v1: { ImageService: grpc.ServiceClientConstructor } } } }).peaket.image.v1;
  return pkg.ImageService.service;
}

export interface ImageWorkerServerOptions {
  host: string;
  port: number;
  store: ImageWorkerStore;
  logger: Pick<PlatformLogger, 'info' | 'warn'>;
  timeoutMs?: number;
  maxPixels?: number;
}

interface Reply {
  status: string;
  derivative_keys?: string[];
  width?: number;
  height?: number;
  reject_reason?: string;
}

export async function startImageWorker(o: ImageWorkerServerOptions): Promise<{ port: number; close(): Promise<void> }> {
  const queue = createImageQueue({ concurrency: 1, timeoutMs: o.timeoutMs ?? 30_000 });
  const maxPixels = o.maxPixels ?? 40_000_000;
  let active = 0;
  const server = new grpc.Server(grpcServerOptions('service'));
  server.addService(imageServiceDefinition(), {
    ProcessImage: (call: grpc.ServerUnaryCall<{ source_key: string; kind: string }, unknown>, callback: grpc.sendUnaryData<Reply>) => {
      const sourceKey = call.request.source_key ?? '';
      const kind = call.request.kind as ImageKindProto;
      const matched = sourceKey.match(SOURCE);
      // 격리 접두사와 kind가 어긋나면 받지 않는다(예: quarantine/banner + IMAGE_KIND_PRODUCTION, IR-15).
      if (!matched || !['IMAGE_KIND_PRODUCTION', 'IMAGE_KIND_HOME_BANNER', 'IMAGE_KIND_REVIEW_PHOTO'].includes(kind) || matched[1] !== prefixOf(kind)) {
        callback({ code: grpc.status.INVALID_ARGUMENT, details: 'source_key or kind' });
        return;
      }
      const started = performance.now();
      const imageId = matched[2]!;
      const prefix = matched[1] as 'production' | 'banner' | 'review';
      const log = (status: string, extra: Record<string, unknown> = {}) =>
        o.logger.info({ event: 'image_process', imageId, kind, active, status, durationMs: Math.round(performance.now() - started), ...extra }, '이미지 처리 작업을 마쳤다');
      queue
        .run(async () => {
          active++;
          try {
            const tags = await o.store.scanTags(sourceKey);
            const verdict = scanVerdict(tags);
            if (verdict === 'PENDING') return { status: 'IMAGE_STATUS_SCAN_PENDING' } satisfies Reply;
            if (verdict === 'THREATS_FOUND') return { status: 'IMAGE_STATUS_REJECTED', reject_reason: 'IMAGE_REJECT_REASON_MALWARE' } satisfies Reply;
            let bytes: Uint8Array;
            try {
              bytes = await o.store.read(sourceKey);
            } catch (e) {
              // 격리 객체가 10MB를 넘으면 본문을 다 읽지 않고 TOO_LARGE로 거절한다(IR-16).
              if (e instanceof ImageObjectTooLarge) return { status: 'IMAGE_STATUS_REJECTED', reject_reason: 'IMAGE_REJECT_REASON_TOO_LARGE' } satisfies Reply;
              throw e;
            }
            const result = await processImage({ bytes, kind, maxPixels });
            if (result.status === 'REJECTED') {
              const map = { UNSUPPORTED_TYPE: 'IMAGE_REJECT_REASON_UNSUPPORTED_TYPE', TOO_LARGE: 'IMAGE_REJECT_REASON_TOO_LARGE', TOO_SMALL: 'IMAGE_REJECT_REASON_TOO_SMALL', MALWARE: 'IMAGE_REJECT_REASON_MALWARE' } as const;
              return { status: 'IMAGE_STATUS_REJECTED', reject_reason: map[result.reason] } satisfies Reply;
            }
            const names = derivativeNamesFor(kind, result.width, result.height);
            const keys: string[] = [];
            for (const name of names) {
              const data = result.derivatives.get(name);
              if (!data) continue;
              const key = stagingKey(prefix, imageId, name);
              await o.store.putStaging(key, data, name.endsWith('.avif') ? 'image/avif' : 'image/webp');
              keys.push(key);
            }
            return { status: 'IMAGE_STATUS_ACCEPTED', derivative_keys: keys, width: result.width, height: result.height } satisfies Reply;
          } finally {
            active--;
          }
        })
        .then((reply) => {
          log(reply.status);
          callback(null, reply);
        })
        .catch((e: unknown) => {
          const timeout = e instanceof Error && /timeout/i.test(e.message);
          log(timeout ? 'DEADLINE_EXCEEDED' : 'INTERNAL');
          callback({ code: timeout ? grpc.status.DEADLINE_EXCEEDED : grpc.status.INTERNAL, details: timeout ? 'timeout' : 'internal' });
        });
    },
  });
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
