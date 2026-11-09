// node --test 전용 api-client 대역(실제 패키지는 strip-only로 실행되지 않는 문법을 쓴다). 화면 실행부가 쓰는 면만 같게 둔다.
export class ApiError extends Error {
  constructor(status, problem, retryAfter = null, date = null) {
    const type = typeof problem?.type === 'string' ? (problem.type.split('/').filter(Boolean).pop() ?? 'about:blank') : `http-${status}`;
    super(`HTTP ${status} ${type}`);
    this.status = status;
    this.type = type;
    this.extensions = Object.fromEntries(Object.entries(problem ?? {}).filter(([k]) => !['type', 'title', 'status', 'detail', 'instance', 'traceId'].includes(k)));
    this.retryAfter = retryAfter;
    this.date = date;
  }
}
export class PurchaseKeyError extends Error {
  constructor(reason) {
    super(reason);
    this.reason = reason;
  }
}
const op = (operationId) => ({ operationId });
export const OPERATIONS = new Proxy({}, { get: (_t, k) => op(String(k)) });
