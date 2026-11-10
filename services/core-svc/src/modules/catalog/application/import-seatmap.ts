// 유스케이스: 좌석맵 가져오기(openapi createPartnerProductionSeatmapImport, ADR-0257 결정 8, docs/features/seat-hold.md §10, BUILD_ORDER HOT-210).
// 차례(먼저 걸린 것으로 답한다): 소속 확인(404) → X-Requested-With(400, 받는 층) → 파일 10MB(413, 작업을 부르지 않는다) → multipart 칸(400)
// → 압축 파일(413) → seatmap-worker 해석(데드라인 10초, 답이 없으면 503) → REJECTED면 422 → PARSED면 다시 보기 → 200.
// 원본 파일은 어디에도 저장하지 않는다(seat-hold ASVS 5.3.1). 기록에는 형식·크기·좌석·구역 수·결과 코드만 싣고 파트너 글자는 넣지 않는다(16.1.1·16.4.1).
import { Inject, Injectable, Optional } from '@nestjs/common';
import { PLATFORM_LOGGER, type PlatformLogger, RequestValidationError } from '@peaket/platform';
import { PARTNER_PRODUCTION_MEDIA, type PartnerProductionMedia, SEATMAP_PARSER, type SeatmapParser, SeatmapWorkerUnavailable } from '../domain/media-ports.js';
import { type CheckedLayout, isCompressed, layoutCounts, recheckLayout, SEATMAP_FILE_MAX_BYTES, SEATMAP_MAX_ISSUES, type SeatmapFormat, type SeatmapIssue, tooMany } from '../domain/seatmap-import.js';
import { notFound, seatmapImportRejected, seatmapImportTooLarge, seatmapWorkerUnavailable } from './problems.js';
import { strictFields, type UploadForm } from './upload-form.js';

const FORMATS: readonly SeatmapFormat[] = ['SVG', 'JSON', 'CSV'];

export interface SeatMapImportResult {
  ok: boolean;
  layout?: CheckedLayout;
  errors: SeatmapIssue[];
  warnings: { code: 'SVG_IGNORED'; ignored: string[] }[];
}

export interface Caller {
  tenantId: string;
  accountId: string;
}

@Injectable()
export class ImportSeatmap {
  constructor(
    @Inject(PARTNER_PRODUCTION_MEDIA) private readonly media: PartnerProductionMedia,
    @Inject(SEATMAP_PARSER) private readonly parser: SeatmapParser,
    @Optional() @Inject(PLATFORM_LOGGER) private readonly logger?: Pick<PlatformLogger, 'info' | 'warn'>,
  ) {}

  /** 그 테넌트의 공연이 아니면 없는 공연과 같은 404이고 실패한 인가 시도로 남긴다(seat-hold ASVS 16.3.2) */
  async authorize(productionId: string, who: Caller): Promise<void> {
    if (await this.media.owns(productionId, who.tenantId)) return;
    this.#warn({ kind: 'security', event: 'partner_production_denied', route: 'seatmap_import', productionId, tenantId: who.tenantId, accountId: who.accountId }, '소속이 아닌 공연의 좌석맵 가져오기를 막았다');
    throw notFound();
  }

  async run(q: { productionId: string; who: Caller; form: UploadForm }): Promise<SeatMapImportResult> {
    const base = { productionId: q.productionId, accountId: q.who.accountId };
    if (q.form.files.some((f) => f.size > SEATMAP_FILE_MAX_BYTES)) {
      this.#info({ ...base, result: 'too_large' });
      throw seatmapImportTooLarge();
    }
    const { file, values } = strictFields(q.form, ['format'], []);
    const format = values.get('format') as SeatmapFormat;
    if (!FORMATS.includes(format)) throw new RequestValidationError('format');
    const bytes = await file.bytes();
    const at = { ...base, format, bytes: bytes.length };
    if (isCompressed(bytes.subarray(0, 4))) {
      this.#info({ ...at, result: 'compressed' });
      throw seatmapImportTooLarge();
    }
    let parsed;
    try {
      parsed = await this.parser.parse(bytes, format);
    } catch (e) {
      if (!(e instanceof SeatmapWorkerUnavailable)) throw e;
      this.#info({ ...at, result: 'unavailable', code: e.grpcCode });
      throw seatmapWorkerUnavailable();
    }
    if (parsed.status === 'REJECTED') {
      const code = parsed.errors[0]?.code ?? 'REJECTED';
      if (code === 'DOCTYPE_PRESENT') this.#warn({ kind: 'security', event: 'seatmap_import_doctype', ...at }, 'DTD가 든 좌석맵 파일을 거절했다');
      this.#info({ ...at, result: 'rejected', code });
      throw seatmapImportRejected(code);
    }
    const warnings = parsed.ignored.length > 0 ? [{ code: 'SVG_IGNORED' as const, ignored: parsed.ignored }] : [];
    // 개수 상한은 스키마 검사보다 먼저 본다(ADR-0257 결정 8)
    const over = parsed.tooMany ?? (parsed.layout === 'invalid' ? undefined : tooMany(parsed.layout));
    if (over) {
      this.#warn({ kind: 'security', event: 'seatmap_worker_result_invalid', ...at, code: over }, 'seatmap-worker의 배치가 개수 상한을 넘었다');
      this.#info({ ...at, result: 'rejected', code: over });
      throw seatmapImportRejected(over);
    }
    if (parsed.layout === 'invalid') {
      // 작업이 계약 모양이 아닌 배치를 돌려줬다(작업 결과가 바뀐 것으로 본다)
      this.#warn({ kind: 'security', event: 'seatmap_worker_result_invalid', ...at }, 'seatmap-worker의 배치가 계약 모양이 아니다');
      this.#info({ ...at, result: 'invalid', code: 'LAYOUT_INVALID' });
      return { ok: false, errors: [{ line: 0, field: 'layout', code: 'LAYOUT_INVALID' }], warnings };
    }
    // 작업의 행 오류와 다시 보기 오류를 합쳐 1,000개까지 싣는다
    const errors = [...parsed.errors, ...recheckLayout(parsed.layout)].slice(0, SEATMAP_MAX_ISSUES);
    const counts = layoutCounts(parsed.layout);
    this.#info({ ...at, ...counts, result: errors.length === 0 ? 'ok' : 'invalid', ...(errors[0] ? { code: errors[0].code } : {}), errorCount: errors.length, ignoredCount: parsed.ignored.length });
    return errors.length === 0 ? { ok: true, layout: parsed.layout, errors, warnings } : { ok: false, errors, warnings };
  }

  #info(line: Record<string, unknown>): void {
    try {
      this.logger?.info({ event: 'seatmap_import', ...line }, '좌석맵 가져오기를 처리했다');
    } catch {
      // 기록 실패는 응답을 바꾸지 않는다
    }
  }

  #warn(line: Record<string, unknown>, msg: string): void {
    try {
      this.logger?.warn(line, msg);
    } catch {
      // 기록 실패는 응답을 바꾸지 않는다
    }
  }
}
