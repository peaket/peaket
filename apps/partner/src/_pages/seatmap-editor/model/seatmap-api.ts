// 좌석맵 에디터가 부르는 API(openapi getPartnerProductionSeatmap·putPartnerProductionSeatmap·createPartnerProductionSeatmapImport, ADR-0264 결정 8·9).
// 실행부(@/shared/api)는 부를 때 가져온다(첫 화면 JS를 늘리지 않는다, wizard-api.ts와 같은 꼴). 시험은 같은 함수에 가짜 클라이언트를 넘긴다.
// 저장은 [좌석맵 저장]을 누를 때만 PUT 한 번이다(자동 재시도 없음. 작업 서술 표가 쓰기는 다시 보내지 않는다).
// 가져오기는 multipart이고 파일 칸 이름을 seatmap.{형식}으로 바꿔 보낸다(사용자 파일 이름을 보내지 않는다). safelisted가 아닌 X-Requested-With을 단다.
import { bodyBytes, ifMatchOf, SAVE_MAX_BYTES } from './doc.ts';
import { IMPORT_MIME, importFileName, type ImportFormat } from './import-check.ts';

export interface ApiResponseLike<T> {
  data: T;
  status: number;
  headers: { get(name: string): string | null };
}

/** api-client의 send와 같은 모양(시험은 가짜를 넘긴다) */
export interface SendLike {
  send<T>(op: unknown, o: { params?: Record<string, string>; body?: unknown; ifMatch?: string; headers?: Record<string, string>; signal?: AbortSignal; timeoutMs?: number }): Promise<ApiResponseLike<T>>;
}

export interface ApiDeps {
  client: SendLike;
  ops: { getPartnerProductionSeatmap: unknown; putPartnerProductionSeatmap: unknown; createPartnerProductionSeatmapImport: unknown; createPartnerProductionSeatmap: unknown; getPartnerSeatmapTemplates: unknown; getPartnerSeatmapTemplate: unknown };
  parseRetryAfter?: (h: string | null, nowMs: number, date?: string | null) => number | undefined;
}

/**
 * 화면 시간 한도(ms, ADR-0264 결정 34): 서버 경로 한도 + 5초. 저장은 LAYOUT_ROUTE_DEADLINE_MS(60초) + 5초,
 * 가져오기는 그 경로의 서버 한도(플랫폼 기본 15초) + 5초 [가정]. 화면이 먼저 끊으면 서버가 커밋한 저장을 '확인하지 못함'으로 본다
 */
export const SAVE_TIMEOUT_MS = 65_000;
export const IMPORT_TIMEOUT_MS = 20_000;

let deps: Promise<ApiDeps> | null = null;

/** 브라우저: 파트너 API 클라이언트를 늦게 싣는다. 싣기가 실패하면(덩어리 받기 실패) 다음 호출이 다시 싣는다 */
function liveDeps(): Promise<ApiDeps> {
  deps ??= import('@/shared/api').then(
    (m) => ({ client: m.partnerApi(), ops: m.OPERATIONS, parseRetryAfter: m.parseRetryAfter }),
    (e: unknown) => {
      deps = null;
      throw e;
    },
  );
  return deps;
}

/** 불러오기: 배치본이 없으면(404) 'none'. 그 밖의 실패는 던진다 */
export async function loadSeatmap(productionId: string, signal?: AbortSignal, d?: ApiDeps): Promise<{ kind: 'ok'; layout: unknown; etag: string | null } | { kind: 'none' }> {
  const { client, ops } = d ?? (await liveDeps());
  try {
    const r = await client.send<unknown>(ops.getPartnerProductionSeatmap, { params: { productionId }, ...(signal ? { signal } : {}) });
    return { kind: 'ok', layout: r.data, etag: r.headers.get('etag') };
  } catch (e) {
    if ((e as { status?: unknown })?.status === 404) return { kind: 'none' };
    throw e;
  }
}

/** 템플릿 목록(공개된 10종) */
export async function listSeatmapTemplates(d?: ApiDeps): Promise<unknown> {
  const { client, ops } = d ?? (await liveDeps());
  const r = await client.send<unknown>(ops.getPartnerSeatmapTemplates, {});
  return r.data;
}

/** 템플릿 하나(도형·구역별 fillRule·등급 기본값) */
export async function getSeatmapTemplate(templateId: string, d?: ApiDeps): Promise<unknown> {
  const { client, ops } = d ?? (await liveDeps());
  const r = await client.send<unknown>(ops.getPartnerSeatmapTemplate, { params: { templateId } });
  return r.data;
}

/** 템플릿에서 만들기. 409 replace-required면 화면이 지우고 다시 만들지 묻는다 */
export async function createSeatmapFromTemplate(productionId: string, body: { templateId: string; targetCapacity: number; variant?: Record<string, unknown>; replace?: boolean }, d?: ApiDeps): Promise<{ layout: unknown; etag: string | null }> {
  const { client, ops } = d ?? (await liveDeps());
  const r = await client.send<unknown>(ops.createPartnerProductionSeatmap, { params: { productionId }, body });
  return { layout: r.data, etag: r.headers.get('etag') };
}

export class BodyTooLarge extends Error {
  readonly bytes: number;
  constructor(bytes: number) {
    super('좌석맵 본문이 12MiB를 넘는다');
    this.bytes = bytes;
  }
}

/** 저장: 본문이 12MiB를 넘으면 보내지 않는다. If-Match는 불러온 판("0" 포함) */
export async function saveSeatmap(productionId: string, body: { layoutVersion: number } & Record<string, unknown>, d?: ApiDeps): Promise<{ layout: unknown; etag: string | null }> {
  const size = bodyBytes(body);
  if (size > SAVE_MAX_BYTES) throw new BodyTooLarge(size);
  const { client, ops } = d ?? (await liveDeps());
  const r = await client.send<unknown>(ops.putPartnerProductionSeatmap, { params: { productionId }, body, ifMatch: ifMatchOf(body.layoutVersion), timeoutMs: SAVE_TIMEOUT_MS });
  return { layout: r.data, etag: r.headers.get('etag') };
}

/** 가져오기 */
export async function importSeatmap(productionId: string, format: ImportFormat, file: Blob, d?: ApiDeps): Promise<unknown> {
  const { client, ops } = d ?? (await liveDeps());
  const fd = new FormData();
  fd.append('file', new Blob([file], { type: IMPORT_MIME[format] }), importFileName(format));
  fd.append('format', format);
  const r = await client.send<unknown>(ops.createPartnerProductionSeatmapImport, { params: { productionId }, body: fd, headers: { 'X-Requested-With': 'peaket-partner' }, timeoutMs: IMPORT_TIMEOUT_MS });
  return r.data;
}

/** 실패 → 저장 답 표의 입력(Retry-After는 서버가 준 Date와 견준다) */
export async function failureOf(e: unknown, nowMs: number, d?: ApiDeps): Promise<{ status: number; type: string; extensions?: Record<string, unknown>; retryFloorMs?: number }> {
  const p = typeof e === 'object' && e !== null ? (e as { status?: unknown; type?: unknown; extensions?: unknown; retryAfter?: unknown; date?: unknown }) : {};
  const status = typeof p.status === 'number' ? p.status : 0;
  let retryFloorMs: number | undefined;
  if (typeof p.retryAfter === 'string') {
    const parse = (d ?? (await liveDeps())).parseRetryAfter;
    retryFloorMs = parse?.(p.retryAfter, nowMs, typeof p.date === 'string' ? p.date : null);
  }
  return {
    status,
    type: typeof p.type === 'string' ? p.type : status === 0 ? 'network' : `http-${status}`,
    ...(typeof p.extensions === 'object' && p.extensions !== null ? { extensions: p.extensions as Record<string, unknown> } : {}),
    ...(retryFloorMs !== undefined ? { retryFloorMs } : {}),
  };
}
