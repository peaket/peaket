// seatmap-worker의 gRPC 서버: SeatmapImportService.ParseSeatmapImport만 연다(docs/api/proto/peaket/seatmap/v1/seatmap.proto, ADR-0257 결정 5).
// 받기 상한 12MiB·보내기 상한 8MiB [가정]를 이 서버에만 건다(@grpc/grpc-js 기본 받기 상한 4MiB). 메시 없는 로컬·CI에서는 평문이다(ADR-0082).
// 해석 결과마다 기록 한 줄을 남긴다(형식·크기·상태·첫 오류 코드·좌석·구역 수. 파일의 글자는 싣지 않는다, seat-hold ASVS 16.1.1·16.4.1).
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { seatmapV1Seatmap } from '@peaket/contracts/proto';
import { grpcServerOptions, type PlatformLogger } from '@peaket/platform';
import type { SeatmapFormat } from '../modules/catalog/domain/seatmap-import.js';
import { Busy, ParsePool, type PoolOutcome } from './pool.js';

export const RECEIVE_MAX_BYTES = 12 * 1024 * 1024;
export const SEND_MAX_BYTES = 8 * 1024 * 1024;
/** 닫을 때 처리 중인 호출을 기다리는 시간 [가정] */
const DRAIN_MS = 10_000;

const PROTO_LOAD_OPTIONS: protoLoader.Options = { keepCase: true, longs: Number, enums: String, defaults: true, oneofs: true };
const FORMATS: Record<string, SeatmapFormat> = { SEATMAP_FORMAT_SVG: 'SVG', SEATMAP_FORMAT_JSON: 'JSON', SEATMAP_FORMAT_CSV: 'CSV' };

export function seatmapServiceDefinition(): grpc.ServiceDefinition {
  const def = protoLoader.fromJSON(seatmapV1Seatmap as Parameters<typeof protoLoader.fromJSON>[0], PROTO_LOAD_OPTIONS);
  const pkg = (grpc.loadPackageDefinition(def) as unknown as { peaket: { seatmap: { v1: { SeatmapImportService: grpc.ServiceClientConstructor } } } }).peaket.seatmap.v1;
  return pkg.SeatmapImportService.service;
}

function reply(o: PoolOutcome): { status: string; layout_json?: Buffer; errors: unknown[]; ignored: string[] } | grpc.status {
  if (o.kind === 'skipped') return o.why === 'cancelled' ? grpc.status.CANCELLED : grpc.status.DEADLINE_EXCEEDED;
  if (o.kind === 'cpu-limit') return { status: 'PARSE_STATUS_REJECTED', errors: [{ line: 0, field: 'file', code: 'CPU_LIMIT' }], ignored: [] };
  if (o.kind === 'out-of-memory') return grpc.status.RESOURCE_EXHAUSTED;
  if (o.kind === 'failed') return grpc.status.INTERNAL;
  const r = o.reply;
  if (r.status === 'PARSED') return { status: 'PARSE_STATUS_PARSED', layout_json: Buffer.from(r.layoutJson, 'utf8'), errors: r.errors, ignored: r.ignored };
  return { status: 'PARSE_STATUS_REJECTED', errors: r.errors, ignored: r.ignored };
}

export interface SeatmapWorkerOptions {
  host: string;
  port: number;
  logger: Pick<PlatformLogger, 'info' | 'warn'>;
  timeoutMs?: number;
  heapMb?: number;
}

/** port 0이면 빈 포트를 잡는다. close는 처리 중인 호출을 기다리고 넘으면 끊는다 */
export async function startSeatmapWorker(o: SeatmapWorkerOptions): Promise<{ port: number; close(): Promise<void> }> {
  const pool = new ParsePool({ threadUrl: new URL('./parse-thread.js', import.meta.url), ...(o.timeoutMs !== undefined ? { timeoutMs: o.timeoutMs } : {}), ...(o.heapMb !== undefined ? { heapMb: o.heapMb } : {}) });
  const server = new grpc.Server(grpcServerOptions('service', { 'grpc.max_receive_message_length': RECEIVE_MAX_BYTES, 'grpc.max_send_message_length': SEND_MAX_BYTES }));
  server.addService(seatmapServiceDefinition(), {
    ParseSeatmapImport: (call: grpc.ServerUnaryCall<{ file: Buffer; format: string }, unknown>, callback: grpc.sendUnaryData<unknown>) => {
      const started = performance.now();
      const format = FORMATS[call.request.format];
      const file = call.request.file ?? Buffer.alloc(0);
      const log = (status: string, extra: Record<string, unknown> = {}) =>
        o.logger.info({ event: 'seatmap_parse', format: format ?? 'UNKNOWN', bytes: file.length, status, durationMs: Math.round(performance.now() - started), ...extra }, '좌석맵 파일을 해석했다');
      if (!format) {
        log('INVALID_ARGUMENT');
        callback({ code: grpc.status.INVALID_ARGUMENT, details: 'format' });
        return;
      }
      const deadline = call.getDeadline();
      const deadlineMs = deadline instanceof Date ? deadline.getTime() : Number(deadline);
      // 데드라인이 지나면 클라이언트도 끊으므로(cancelled도 참) 데드라인을 먼저 본다
      const alive = () => (Number.isFinite(deadlineMs) && Date.now() >= deadlineMs ? 'deadline' : call.cancelled ? 'cancelled' : 'alive') as 'alive' | 'cancelled' | 'deadline';
      pool
        .run(file, format, alive)
        .then((outcome) => {
          if (outcome.kind === 'skipped') {
            log('SKIPPED', { code: outcome.why });
            callback({ code: reply(outcome) as grpc.status, details: outcome.why });
            return;
          }
          const r = reply(outcome);
          if (typeof r === 'number') {
            log(grpc.status[r], { code: outcome.kind });
            callback({ code: r, details: outcome.kind });
            return;
          }
          const counts = outcome.kind === 'result' && outcome.reply.status === 'PARSED' ? { seats: outcome.reply.seats, sections: outcome.reply.sections } : {};
          const first = (r.errors[0] as { code?: string } | undefined)?.code;
          log(r.status, { ...counts, ...(first ? { code: first } : {}), errorCount: r.errors.length, ignoredCount: r.ignored.length });
          callback(null, r);
        })
        .catch((e: unknown) => {
          const code = e instanceof Busy ? grpc.status.RESOURCE_EXHAUSTED : grpc.status.INTERNAL;
          log(grpc.status[code], { code: e instanceof Busy ? 'busy' : 'internal' });
          callback({ code, details: e instanceof Busy ? 'busy' : 'internal' });
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
        }, DRAIN_MS);
        timer.unref();
        server.tryShutdown(() => {
          clearTimeout(timer);
          res();
        });
      }),
  };
}
