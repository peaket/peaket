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
  /** 응답의 Date 머리(서버 시계, Retry-After 날짜와 견준다) */
  readonly date: string | null;
  readonly body: Record<string, unknown> | null;

  constructor(status: number, problem: Record<string, unknown> | null, retryAfter: string | null, date: string | null = null) {
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
    this.date = date;
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
    return new ApiError(res.status, body, res.headers.get('retry-after'), res.headers.get('date'));
  }
}

/** 412 precondition-failed(다른 곳에서 먼저 고침). 화면은 다시 보내지 않고 지금 값과의 비교 보기를 띄운다(docs/api/guidelines.md §12) */
export function isPreconditionFailed(e: unknown): e is ApiError {
  return e instanceof ApiError && e.status === 412;
}

/**
 * 구매 경로 401의 다음 동작(docs/frontend.md §4.1 '401', BAS-040·BAS-041):
 * 'refresh'는 팬 쿠키 401(이름 없음)이라 토큰을 한 번 갱신하고 다시 보낸다. 'skip-seq-and-retry'는 일련번호가 서버보다 뒤라
 * 번호를 건너뛰어 같은 멱등 키로 한 번 다시 보낸다(서명기, wbs 2.10.7). 'session-ended'는 구매 세션이 끝난 것이다(키를 지우고 SCR-010)
 */
export function purchaseUnauthorizedAction(e: unknown): 'refresh' | 'session-ended' | undefined {
  if (!(e instanceof ApiError) || e.status !== 401) return undefined;
  // 일련번호 재사용은 send가 이미 새 번호로 한 번 다시 보냈다. 여기까지 올라오면 세션이 끝난 것이다(docs/frontend.md §5.3 '401', ADR-0221 결정 5)
  if (e.type === 'purchase-seq-reused' || e.type === 'purchase-session-ended' || e.type === 'admission-token-invalid' || e.type === 'purchase-signature-invalid') return 'session-ended';
  return 'refresh';
}
