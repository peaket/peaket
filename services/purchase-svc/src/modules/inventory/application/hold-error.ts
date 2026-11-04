// 좌석 홀드 업무 오류와 HTTP 문제 상세(RFC 9457) 대응표(openapi POST /v1/events/{eventId}/holds, docs/features/seat-hold.md §3~§5, BUILD_ORDER PRF-130 ①).
// 쓰임새(HoldSeats)는 HoldError를 던지고, 받는 층이 throwHoldProblem으로 바꿔 던진다.
import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { COOKIE_CHALLENGE, ProblemError, RequestValidationError } from '@peaket/platform';
import { SEAT_STORE_RETRY_AFTER_SEC, type SeatStoreUnavailable, type SeatStoreUnavailableReason } from '../domain/hold.js';

/** 응답 머리를 다는 곳(FastifyReply가 이 모양이다. 유스케이스 층은 웹 서버 형을 가져오지 않는다) */
export interface ReplyHeaders {
  header(name: string, value: string): unknown;
}

export type HoldErrorCode =
  /** 구매 세션이 없거나 끝났거나 다른 계정의 것(인증 훅을 지난 뒤 사라진 경우) */
  | 'SESSION_NOT_FOUND'
  /** 구매 세션에 적힌 회차가 주소의 회차와 다르다(S-T28 ③) */
  | 'EVENT_MISMATCH'
  /** 본문에 auto(자동 배정 희망 조건)가 있다. 자동 배정은 wbs 2.5.4에서 연다 */
  | 'AUTO_NOT_SUPPORTED'
  /** 본문에 seatIds도 auto도 없다 */
  | 'SEATS_REQUIRED'
  /** 좌석맵 판에 없는 좌석·다른 회차의 좌석·판매 제외석·같은 좌석 두 번(S-T30, seat-hold.md §3 '좌석 ID 확인') */
  | 'INVALID_SEAT'
  /** 판매 종료(주입 Clock의 지금 ≥ 판매 종료 시각, ADR-0064) */
  | 'SALE_ENDED'
  /** 좌석 저장소가 준비되지 않음: 세대 키 없음(NOT_READY) 또는 그 회차의 좌석맵 판이 없음 */
  | 'NOT_READY'
  /** 좌석 Redis 일시 장애 또는 메모리 부족(SeatStoreUnavailable, 까닭은 details.storeReason) */
  | 'STORE_UNAVAILABLE'
  /** 좌석 Redis를 부르기 전 남은 시간이 SEAT_CALL_MIN_REMAINING_MS(5ms) 미만(guidelines §5, BUILD_ORDER PRF-135) */
  | 'DEADLINE_EXCEEDED'
  /** 같은 멱등 키에 다른 좌석 선택(지문이 다름) */
  | 'IDEM_REUSED'
  /** 판매 일시정지(명령 3) 또는 판매 중지(ADR-0123) */
  | 'PAUSED'
  /** 다른 사람이 잡은 좌석이 섞였다 */
  | 'CONFLICT'
  /** 같은 계정이 방금 놓은 좌석(30초 [가정]) */
  | 'REHOLD_WAIT'
  /** 보유 수 + 좌석 수 > 1인 한도 */
  | 'QUOTA_EXCEEDED';

export interface HoldErrorDetails {
  /** REHOLD_WAIT: 아직 다시 잡을 수 없는 좌석 ID(요청 좌석 차례) */
  recentlyReleasedSeats?: string[];
  /** REHOLD_WAIT: 그 좌석을 모두 다시 잡을 수 있게 되는 시각(epoch ms) */
  reholdAvailableAtMs?: number;
  /**
   * STORE_UNAVAILABLE: 저장소가 준 까닭(SeatStoreUnavailable.reason, BUILD_ORDER PRF-135). 'oom'이어도 응답(503 본문·Retry-After)은 같다.
   * 응답 본문·머리와 정규 로그 줄에는 싣지 않는다(플랫폼 정규 로그 줄에 그 칸이 없다, 추천 적용 2026-11-04). 지표(seat_lua_errors_total code OOM, HoldSeats)와
   * 받는 층의 서비스 로그 한 줄({ seatStoreReason: 'oom' })에만 남는다
   */
  storeReason?: SeatStoreUnavailableReason;
  cause?: unknown;
}

export class HoldError extends Error {
  constructor(
    readonly code: HoldErrorCode,
    message: string,
    readonly details: HoldErrorDetails = {},
  ) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = 'HoldError';
  }
}

/** 대응표 한 줄. type이 'about:blank'이면 이름 없는 HTTP 오류(Nest 예외·요청 검사 오류)로 낸다 */
export interface HoldProblemSpec {
  status: number;
  type: string;
  title: string;
  /** Retry-After 머리(초) */
  retryAfterSeconds?: number;
  /** 업무상 정상 분기로 센다(오류가 아니라 businessRejections, 로그 수준 info) */
  normalBranch?: boolean;
  /** 고정 detail(auto 400의 '좌석 지정만 받는다') */
  detail?: string;
}

/**
 * 결과 → HTTP 문제 상세 대응표(결정 목록 2026-11-04의 상태 코드·problem 이름).
 * 401·403·SEATS_REQUIRED 400은 이름 없는 오류(about:blank)다: 401은 플랫폼 인증 가드와 같이 WWW-Authenticate(COOKIE_CHALLENGE)를 싣고,
 * 403은 게이트웨이의 회차 대조 403과 같은 본문, SEATS_REQUIRED는 요청 검사 실패와 같은 본문(detail 없음, guidelines §2)이다.
 */
export const HOLD_PROBLEMS: Readonly<Record<HoldErrorCode, HoldProblemSpec>> = {
  SESSION_NOT_FOUND: { status: 401, type: 'about:blank', title: 'Unauthorized' },
  EVENT_MISMATCH: { status: 403, type: 'about:blank', title: 'Forbidden' },
  AUTO_NOT_SUPPORTED: {
    status: 400,
    type: 'auto-assign-not-supported',
    title: '좌석 자동 배정은 아직 받지 않습니다',
    detail: '지금은 좌석 지정(seatIds)만 받습니다',
  },
  SEATS_REQUIRED: { status: 400, type: 'about:blank', title: 'Bad Request' },
  INVALID_SEAT: { status: 422, type: 'invalid-seat', title: '고를 수 없는 좌석이 있습니다' },
  SALE_ENDED: { status: 410, type: 'sale-ended', title: '판매 시간이 끝났습니다' },
  NOT_READY: { status: 503, type: 'seat-store-unavailable', title: '좌석 정보를 잠시 쓸 수 없습니다', retryAfterSeconds: SEAT_STORE_RETRY_AFTER_SEC },
  // 메모리 부족(storeReason 'oom')도 이 줄이다. 까닭은 로그·지표에만 둔다(BUILD_ORDER PRF-135)
  STORE_UNAVAILABLE: { status: 503, type: 'seat-store-unavailable', title: '좌석 정보를 잠시 쓸 수 없습니다', retryAfterSeconds: SEAT_STORE_RETRY_AFTER_SEC },
  // 플랫폼 deadlineExceeded()와 같은 본문(guidelines §5. 게이트웨이 시간 초과도 504라 클라이언트가 보는 결과가 같다)
  DEADLINE_EXCEEDED: { status: 504, type: 'deadline-exceeded', title: '남은 처리 시간이 모자라 요청을 끝내지 못했습니다' },
  IDEM_REUSED: { status: 422, type: 'idempotency-key-reused', title: '같은 멱등 키를 다른 요청에 썼습니다' },
  PAUSED: { status: 423, type: 'sale-paused', title: '판매가 잠시 멈췄습니다' },
  // 내 좌석을 새 키로 다시 누른 경우도 있어 '다른 분이 먼저'가 아닌 중립 문구다(추천 적용 2026-11-04)
  CONFLICT: { status: 409, type: 'seat-already-held', title: '이미 잡힌 좌석이 있습니다', normalBranch: true },
  REHOLD_WAIT: { status: 409, type: 'seat-recently-released', title: '방금 놓은 좌석은 잠시 뒤에 다시 고를 수 있습니다', normalBranch: true },
  QUOTA_EXCEEDED: { status: 422, type: 'purchase-limit-exceeded', title: '1인 구매 한도를 넘었습니다' },
};

/**
 * 저장소의 SeatStoreUnavailable을 STORE_UNAVAILABLE HoldError로 바꾼다(BUILD_ORDER PRF-135).
 * 결과: code 'STORE_UNAVAILABLE', details.cause = err, details.storeReason = err.reason('unavailable' 또는 'oom'). 메시지는 까닭과 관계없이
 * '좌석 Redis를 잠시 쓸 수 없다'다. 대응표의 503 seat-store-unavailable + Retry-After 2초로 답하고(까닭 'oom'도 같은 응답), 던지지 않는다
 */
export function storeUnavailableError(err: SeatStoreUnavailable): HoldError {
  return new HoldError('STORE_UNAVAILABLE', '좌석 Redis를 잠시 쓸 수 없다', { cause: err, storeReason: err.reason });
}

/**
 * HoldError를 대응표대로 HTTP 오류로 바꿔 던진다(돌아오지 않는다).
 * - STORE_UNAVAILABLE의 details.storeReason은 응답에 싣지 않는다(본문·머리가 'unavailable'과 같다).
 * - DEADLINE_EXCEEDED는 이름 있는 줄(504 deadline-exceeded, Retry-After 없음)이다.
 * - 이름 있는 줄: ProblemError(type·status·title·detail·retryAfterSeconds·normalBranch, cause = e). REHOLD_WAIT는 확장 칸
 *   recentlyReleasedSeats(details 그대로)와 reholdAvailableAt(details.reholdAvailableAtMs의 ISO 8601 UTC 'Z', 밀리초 셋째 자리까지)를 싣는다.
 *   CONFLICT의 suggestedSeats는 추천 규칙이 [보완]이라 아직 싣지 않는다.
 * - SESSION_NOT_FOUND: reply에 WWW-Authenticate: Cookie realm="peaket"을 달고 Nest UnauthorizedException.
 * - EVENT_MISMATCH: Nest ForbiddenException. SEATS_REQUIRED: 플랫폼 RequestValidationError.
 * 어느 경우든 응답의 Cache-Control은 받는 층이 이미 no-store로 달았다.
 */
export function throwHoldProblem(e: HoldError, reply: ReplyHeaders): never {
  switch (e.code) {
    case 'SESSION_NOT_FOUND':
      reply.header('www-authenticate', COOKIE_CHALLENGE);
      throw new UnauthorizedException();
    case 'EVENT_MISMATCH':
      throw new ForbiddenException();
    case 'SEATS_REQUIRED':
      throw new RequestValidationError('본문에 seatIds가 없다');
    default:
      break;
  }
  const spec = HOLD_PROBLEMS[e.code];
  const extensions: Record<string, unknown> = {};
  if (e.code === 'REHOLD_WAIT') {
    extensions.recentlyReleasedSeats = [...(e.details.recentlyReleasedSeats ?? [])];
    if (e.details.reholdAvailableAtMs !== undefined) extensions.reholdAvailableAt = new Date(e.details.reholdAvailableAtMs).toISOString();
  }
  throw new ProblemError({
    type: spec.type,
    status: spec.status,
    title: spec.title,
    ...(spec.detail !== undefined ? { detail: spec.detail } : {}),
    ...(Object.keys(extensions).length > 0 ? { extensions } : {}),
    ...(spec.retryAfterSeconds !== undefined ? { retryAfterSeconds: spec.retryAfterSeconds } : {}),
    ...(spec.normalBranch ? { normalBranch: true } : {}),
    cause: e,
  });
}
