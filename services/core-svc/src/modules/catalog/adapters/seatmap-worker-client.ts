// seatmap-worker SeatmapImportService.ParseSeatmapImport 클라이언트(docs/api/proto/peaket/seatmap/v1/seatmap.proto, ADR-0257 결정 5·8).
// - 데드라인 10초 [가정]. 이 채널만 보내기 12MiB·받기 8MiB [가정]로 늘린다(@grpc/grpc-js 기본 받기 4MiB).
// - gRPC 오류(UNAVAILABLE·RESOURCE_EXHAUSTED·DEADLINE_EXCEEDED와 그 밖)는 모두 SeatmapWorkerUnavailable이다(→ 503, fail-closed).
// - 답의 배치 JSON을 그대로 믿지 않는다: 좌석 ID를 채운 뒤 계약 SeatMapLayout Zod로 보고, 맞지 않으면 'invalid'다(개수·캔버스·겹침은 도메인이 본다).
//   작업이 준 오류·무시 목록도 길이와 개수를 묶는다(뚫린 작업이 응답을 부풀리지 못하게).
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { SeatMapLayout } from '@peaket/contracts/openapi/model';
import { seatmapV1Seatmap } from '@peaket/contracts/proto';
import { createGrpcClient, type GrpcLbProfile } from '@peaket/platform';
import { type SeatmapParse, type SeatmapParser, SeatmapWorkerUnavailable } from '../domain/media-ports.js';
import { type CheckedLayout, countRaw, fillSeatIds, parseLayoutJson, SEATMAP_MAX_ISSUES, type SeatmapFormat, type SeatmapIssue, type TooMany } from '../domain/seatmap-import.js';

export const SEATMAP_DEADLINE_MS = 10_000;
export const SEATMAP_SEND_MAX_BYTES = 12 * 1024 * 1024;
export const SEATMAP_RECEIVE_MAX_BYTES = 8 * 1024 * 1024;
const PROTO_LOAD_OPTIONS: protoLoader.Options = { keepCase: true, longs: Number, enums: String, defaults: true, oneofs: true };
const FORMAT: Record<SeatmapFormat, string> = { SVG: 'SEATMAP_FORMAT_SVG', JSON: 'SEATMAP_FORMAT_JSON', CSV: 'SEATMAP_FORMAT_CSV' };
const TEXT_MAX = 64;
const IGNORED_MAX = 100;

type Unary = (req: object, md: grpc.Metadata, opts: grpc.CallOptions, cb: (e: grpc.ServiceError | null, v?: Record<string, unknown>) => void) => grpc.ClientUnaryCall;

const short = (v: unknown) => (typeof v === 'string' ? v.slice(0, TEXT_MAX) : '');
function issues(v: unknown): SeatmapIssue[] {
  if (!Array.isArray(v)) return [];
  return v.slice(0, SEATMAP_MAX_ISSUES).map((e: Record<string, unknown>) => ({ line: Number.isSafeInteger(e?.line) ? (e.line as number) : 0, field: short(e?.field), code: short(e?.code) }));
}

/** host:port를 나눈다 */
export function hostPort(address: string, name: string): { host: string; port: number } {
  const at = address.lastIndexOf(':');
  const port = Number(address.slice(at + 1));
  if (at <= 0 || !Number.isInteger(port) || port <= 0) throw new Error(`${name}은 host:port여야 한다: ${address}`);
  return { host: address.slice(0, at), port };
}

export class GrpcSeatmapParser implements SeatmapParser {
  readonly #client: grpc.Client & { ParseSeatmapImport: Unary };

  constructor(address: string, profile: GrpcLbProfile = 'service') {
    const def = protoLoader.fromJSON(seatmapV1Seatmap as Parameters<typeof protoLoader.fromJSON>[0], PROTO_LOAD_OPTIONS);
    const pkg = (grpc.loadPackageDefinition(def) as unknown as { peaket: { seatmap: { v1: Record<string, unknown> } } }).peaket.seatmap.v1;
    const { host, port } = hostPort(address, 'PEAKET_SEATMAP_GRPC_URL');
    this.#client = createGrpcClient(pkg.SeatmapImportService as grpc.ServiceClientConstructor, {
      host,
      port,
      profile,
      dependency: 'seatmap-worker',
      timeoutCapMs: SEATMAP_DEADLINE_MS,
      extra: { 'grpc.max_send_message_length': SEATMAP_SEND_MAX_BYTES, 'grpc.max_receive_message_length': SEATMAP_RECEIVE_MAX_BYTES },
    }) as unknown as grpc.Client & { ParseSeatmapImport: Unary };
  }

  parse(file: Uint8Array, format: SeatmapFormat): Promise<SeatmapParse> {
    return new Promise((resolve, reject) => {
      this.#client.ParseSeatmapImport({ file: Buffer.from(file.buffer, file.byteOffset, file.byteLength), format: FORMAT[format] }, new grpc.Metadata(), { deadline: Date.now() + SEATMAP_DEADLINE_MS }, (e, v) => {
        if (e) {
          reject(new SeatmapWorkerUnavailable(grpc.status[e.code] ?? String(e.code)));
          return;
        }
        const r = v ?? {};
        if (r.status === 'PARSE_STATUS_REJECTED') {
          resolve({ status: 'REJECTED', errors: issues(r.errors) });
          return;
        }
        if (r.status !== 'PARSE_STATUS_PARSED') {
          reject(new SeatmapWorkerUnavailable('UNKNOWN_STATUS'));
          return;
        }
        const ignored = Array.isArray(r.ignored) ? r.ignored.slice(0, IGNORED_MAX).map(short).filter((s) => s !== '') : [];
        resolve({ status: 'PARSED', ...checked(r.layout_json), errors: issues(r.errors), ignored });
      });
    });
  }

  close(): void {
    this.#client.close();
  }
}

/**
 * 배치 JSON → 계약 모양. __proto__·constructor·prototype 키가 있거나 읽지 못하면 'invalid'다.
 * 개수 상한은 스키마보다 먼저 본다(스키마에 맞지 않는 거대한 배치도 422로 거절한다, ADR-0257 결정 8)
 */
function checked(raw: unknown): { layout: CheckedLayout | 'invalid'; tooMany?: TooMany } {
  if (!Buffer.isBuffer(raw)) return { layout: 'invalid' };
  const doc = parseLayoutJson(raw.toString('utf8'));
  if (doc === 'invalid') return { layout: 'invalid' };
  const over = countRaw(doc);
  if (over) return { layout: 'invalid', tooMany: over };
  const r = SeatMapLayout.safeParse(fillSeatIds(doc));
  return { layout: r.success ? (r.data as CheckedLayout) : 'invalid' };
}
