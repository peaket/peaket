// 본인확인 재확인 판정(docs/features/payment.md §2 '주문 생성의 첫 구현' 본인확인 재확인, ADR-0055, BUILD_ORDER PRF-161).
// 주문 생성이 identity-svc IdentityService.GetVerificationStatus(데드라인 150ms [가정])의 결과와 토큰 값으로 통과·거부를 정한다.
// 다시 묻기(RESOURCE_EXHAUSTED·INTERNAL·UNKNOWN만 남은 데드라인 안에서 한 번)는 어댑터(adapters/grpc-identity.ts)가 하고, 이 판정은 마지막 결과만 본다.
// 순수 함수라 프레임워크·플랫폼 형을 가져오지 않는다.

/**
 * 재확인 호출이 답을 주지 못한 까닭(어댑터가 gRPC 상태를 이 값으로 바꾼다).
 * - circuit_open: 차단기가 열려 부르지 않았다
 * - deadline: DEADLINE_EXCEEDED(데드라인 안에 답이 없음)
 * - unavailable: UNAVAILABLE
 * - exhausted: RESOURCE_EXHAUSTED(한 번 다시 물은 뒤에도)
 * - internal: INTERNAL·UNKNOWN(한 번 다시 물은 뒤에도)
 * - permission_denied: PERMISSION_DENIED(메시 신원 허용 목록 밖, 설정 오류)
 * - invalid_argument: INVALID_ARGUMENT(보낸 값이 틀림, 설정·코드 오류)
 * - unexpected: 정본 목록 밖의 gRPC 상태(UNIMPLEMENTED·UNAUTHENTICATED·NOT_FOUND·FAILED_PRECONDITION 등)와 gRPC가 아닌 예외(TypeError 등).
 *   대체 판정으로 숨기지 않고 설정·코드 오류로 본다(리뷰 고침 M2 2026-11-05)
 */
export type RecheckFailure = 'circuit_open' | 'deadline' | 'unavailable' | 'exhausted' | 'internal' | 'permission_denied' | 'invalid_argument' | 'unexpected';

/** 대체 판정 없이 503(SEV2 설정 오류)인 까닭 */
export type MisconfiguredReason = 'permission_denied' | 'invalid_argument' | 'unexpected';

/** 토큰 판정으로 넘어가는 까닭(지표 purchase_identity_recheck_fallback_total{reason}의 값). 정본 목록(차단기 열림·4·14·8·13·2)뿐이다 */
export type FallbackReason = Exclude<RecheckFailure, MisconfiguredReason>;

/** 대체 판정 까닭 다섯(지표 이름표 값의 차례) */
export const FALLBACK_REASONS: readonly FallbackReason[] = ['circuit_open', 'deadline', 'unavailable', 'exhausted', 'internal'];

/** 재확인 호출 하나의 결과(IdentityRecheck.check가 돌려준다) */
export type RecheckAnswer =
  /** verified 참. pid·previousPid는 응답 그대로다(previous_pid가 빈 글이면 previousPid는 없다) */
  | { readonly status: 'VERIFIED'; readonly pid: string; readonly previousPid?: string }
  /** verified 거짓(본인확인 전, 끝난 로그인 세션 등). 그대로 거부한다(ADR-0055) */
  | { readonly status: 'DENIED' }
  /** 답이 없다 */
  | { readonly status: 'FAILED'; readonly reason: RecheckFailure };

/** 게이트웨이가 넘긴 액세스 토큰의 값(platform Principal의 pid·scopes) */
export interface RecheckToken {
  /** 토큰의 pid(사람 식별값). 없을 수 있다 */
  readonly pid?: string;
  readonly scopes: readonly string[];
}

/** 대체 판정에서 통과에 필요한 토큰 스코프 */
export const TICKET_BUY_SCOPE = 'ticket:buy';

/**
 * 판정 결과.
 * - PASS: 재확인 통과
 * - PASS_FALLBACK: 답이 없어 토큰 판정으로 통과(지표·보안 로그를 남긴다)
 * - DENY: 403 identity-verification-required. fallbackReason이 있으면 토큰 판정으로 거부한 것이다(그때도 지표·보안 로그를 남긴다)
 * - MISCONFIGURED: PERMISSION_DENIED·INVALID_ARGUMENT·정본 목록 밖(unexpected). 대체 판정 없이 503(SEV2, 설정 오류)
 */
export type RecheckVerdict =
  | { readonly kind: 'PASS' }
  | { readonly kind: 'PASS_FALLBACK'; readonly reason: FallbackReason }
  | { readonly kind: 'DENY'; readonly fallbackReason?: FallbackReason }
  | { readonly kind: 'MISCONFIGURED'; readonly reason: MisconfiguredReason };

const MISCONFIGURED_REASONS: ReadonlySet<RecheckFailure> = new Set<MisconfiguredReason>(['permission_denied', 'invalid_argument', 'unexpected']);

/**
 * 재확인 결과와 토큰 값으로 판정한다(payment §2 '본인확인 재확인'):
 * - VERIFIED이고 token.pid가 있고 answer.pid 또는 answer.previousPid와 같다 → PASS
 * - VERIFIED인데 token.pid가 없거나 둘 다와 다르다 → DENY(fallbackReason 없음)
 * - DENIED → DENY(fallbackReason 없음)
 * - FAILED이고 까닭이 permission_denied·invalid_argument·unexpected → MISCONFIGURED(같은 까닭)
 * - FAILED이고 그 밖의 까닭(FallbackReason) →token.scopes에 'ticket:buy'가 있고 token.pid가 빈 글이 아니면 PASS_FALLBACK(까닭), 아니면 DENY(fallbackReason = 까닭)
 * pid 비교는 글 그대로(대소문자 구분) 같은지 본다. 던지지 않는다
 */
export function judgeRecheck(answer: RecheckAnswer, token: RecheckToken): RecheckVerdict {
  // 빈 글 pid는 없는 것으로 본다(없는 값끼리 같다고 보지 않게)
  const pid = typeof token.pid === 'string' && token.pid.length > 0 ? token.pid : undefined;
  switch (answer.status) {
    case 'VERIFIED':
      return pid !== undefined && (answer.pid === pid || answer.previousPid === pid) ? { kind: 'PASS' } : { kind: 'DENY' };
    case 'DENIED':
      return { kind: 'DENY' };
    case 'FAILED': {
      const reason = answer.reason;
      // 정본 목록 밖(모르는 값 포함)은 대체 판정으로 숨기지 않는다
      if (MISCONFIGURED_REASONS.has(reason) || !(FALLBACK_REASONS as readonly string[]).includes(reason)) {
        return { kind: 'MISCONFIGURED', reason: MISCONFIGURED_REASONS.has(reason) ? (reason as MisconfiguredReason) : 'unexpected' };
      }
      const fallback = reason as FallbackReason;
      const buy = Array.isArray(token.scopes) && token.scopes.includes(TICKET_BUY_SCOPE);
      return buy && pid !== undefined ? { kind: 'PASS_FALLBACK', reason: fallback } : { kind: 'DENY', fallbackReason: fallback };
    }
    default:
      // 모르는 답은 거부한다(안전한 실패)
      return { kind: 'DENY' };
  }
}
