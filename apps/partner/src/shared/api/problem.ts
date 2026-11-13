// 파트너 화면이 API 오류(application/problem+json)를 같은 규칙으로 읽는다.
// ApiError를 직접 가져오면 화면 첫 JS가 커지므로 모양만 보고 판별한다(docs/frontend.md §4.1 '오류 모양').

export interface ProblemShape {
  status: number;
  type?: string;
  title?: string;
  detail?: string;
  traceId?: string;
  extensions?: Record<string, unknown>;
}

export function isProblem(e: unknown): e is ProblemShape {
  return typeof e === 'object' && e !== null && typeof (e as { status?: unknown }).status === 'number';
}

export function problemType(e: unknown): string | undefined {
  return isProblem(e) && typeof e.type === 'string' ? e.type : undefined;
}

export function isReauthRequired(e: unknown): boolean {
  return isProblem(e) && e.status === 403 && problemType(e) === 'reauth-required';
}

export function isPartnerAdminRequired(e: unknown): boolean {
  return isProblem(e) && e.status === 403 && (problemType(e) === 'partner-admin-required' || problemType(e) === 'forbidden');
}

export function isNotFound(e: unknown): boolean {
  return isProblem(e) && e.status === 404;
}

export function isRetentionEnded(e: unknown): boolean {
  return isProblem(e) && e.status === 410 && problemType(e) === 'retention-ended';
}

export function isConflict(e: unknown): boolean {
  return isProblem(e) && e.status === 409;
}

export function isPreconditionFailed(e: unknown): boolean {
  return isProblem(e) && e.status === 412;
}

export function isNotImplemented(e: unknown): boolean {
  return isProblem(e) && (e.status === 404 || e.status === 501 || e.status === 503);
}

/** 화면에 보일 한 줄. 서버 title·detail 원문은 그대로 보이지 않고, 알려진 유형만 우리 문구로 바꾼다. */
export function problemMessage(e: unknown, fallback: string): string {
  if (isReauthRequired(e)) return '다시 인증해야 합니다. 비밀번호·인증 앱 코드와 패스키로 확인해 주세요.';
  if (isPartnerAdminRequired(e)) return '파트너 관리자만 할 수 있습니다.';
  if (isRetentionEnded(e)) return '보유 기간이 끝나 볼 수 없습니다.';
  if (isPreconditionFailed(e)) return '다른 사람이 먼저 고쳤습니다. 새로 고친 뒤 다시 시도해 주세요.';
  if (isConflict(e)) return '지금 상태에서는 할 수 없습니다. 새로 고친 뒤 다시 시도해 주세요.';
  if (isNotFound(e)) return '찾을 수 없습니다.';
  if (isProblem(e) && e.status >= 500) return '서버가 응답하지 못했습니다. 잠시 뒤 다시 시도해 주세요.';
  if (e instanceof TypeError) return '서버에 연결하지 못했습니다. 잠시 뒤 다시 시도해 주세요.';
  return fallback;
}
