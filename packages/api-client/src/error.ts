// 오류 모양(docs/frontend.md §4.1 '오류 모양', docs/api/guidelines.md §2).
// application/problem+json이면 ApiError{status, type, title, detail, traceId, 확장 필드}로 읽는다. type은 주소의 끝 경로(케밥 표기)다.
// 화면은 type → 문구 키 표(§5.12)로 문구를 고르고, 서버의 title·detail 원문은 보이지 않는다.
import { parseJsonSafe } from '@peaket/validation/safe-json';

const KNOWN = new Set(['type', 'title', 'status', 'detail', 'instance', 'traceId']);

export class ApiError extends Error {
  readonly status: number;
  readonly type: string;
  readonly title?: string;
  readonly detail?: string;
  readonly traceId?: string;
  readonly extensions: Record<string, unknown>;
  /** 서버가 준 다시 시도 시각(있으면) */
  readonly retryAfter: string | null;
  readonly body: Record<string, unknown> | null;

  constructor(status: number, problem: Record<string, unknown> | null, retryAfter: string | null) {
    const type = typeof problem?.type === 'string' ? (problem.type.split('/').filter(Boolean).pop() ?? 'about:blank') : `http-${status}`;
    super(`HTTP ${status} ${type}`);
    this.name = 'ApiError';
    this.status = status;
    this.type = type;
    this.title = typeof problem?.title === 'string' ? problem.title : undefined;
    this.detail = typeof problem?.detail === 'string' ? problem.detail : undefined;
    this.traceId = typeof problem?.traceId === 'string' ? problem.traceId : undefined;
    this.extensions = Object.fromEntries(Object.entries(problem ?? {}).filter(([k]) => !KNOWN.has(k)));
    this.retryAfter = retryAfter;
    this.body = problem;
  }

  /** 응답 하나 → ApiError(본문이 problem+json·JSON이 아니면 확장 없이) */
  static async from(res: Response): Promise<ApiError> {
    const ct = res.headers.get('content-type') ?? '';
    let body: Record<string, unknown> | null = null;
    if (/application\/(problem\+)?json/.test(ct)) {
      try {
        // 공용 안전 파서로 읽는다: __proto__·constructor·prototype 키가 든 본문은 확장 없이 둔다(ASVS 15.3.6)
        const parsed: unknown = parseJsonSafe(await res.text());
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
      } catch {
        body = null;
      }
    }
    return new ApiError(res.status, body, res.headers.get('retry-after'));
  }
}
