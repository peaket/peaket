// 휴대폰 본인확인 건의 규칙(docs/features/identity.md §5 '본인확인 시험 어댑터와 첫 구현', FR-002, POL-001, ADR-0006·0063).

export const PURPOSES = ['FIRST', 'REVERIFY', 'MINOR_CONTRACT'] as const;
export type Purpose = (typeof PURPOSES)[number];

/** PROVIDER_DOWN은 결과 경로에서 기관 장애를 만난 건이다(그 건은 마치고, [다시 시도]는 새 건으로 한다. identity §5 '모의 기관과 기관 창 흐름') */
export const ATTEMPT_STATUSES = ['PENDING', 'VERIFIED', 'CANCELLED', 'FAILED', 'DUPLICATE_ACCOUNT', 'PROVIDER_DOWN'] as const;
export type AttemptStatus = (typeof ATTEMPT_STATUSES)[number];

/** 시작 뒤 결과를 받는 시간 10분 [가정], 확정한 결과를 조회하는 시간 1일 [가정](docs/data.md verification_attempt) */
export const ATTEMPT_TTL_MS = 10 * 60_000;
export const RESULT_TTL_MS = 24 * 3_600_000;

/** 구매 권한(identity §3 액세스 토큰 scope) */
export const TICKET_BUY_SCOPE = 'ticket:buy';

export interface Attempt {
  id: string;
  accountId: string;
  purpose: Purpose;
  next: string;
  status: AttemptStatus;
  expiresAt: number;
  createdAt: number;
  completedAt: number | null;
}

/** 결과를 받을 수 있는가(시작한 계정이고, 처리 중이면 10분 안, 확정했으면 같은 결과를 1일 안에만 다시 준다) */
export const acceptsResult = (a: Attempt, accountId: string, now: number): boolean =>
  a.accountId === accountId && (a.completedAt === null ? now <= a.expiresAt : now <= a.completedAt + RESULT_TTL_MS);

/** 조회할 수 있는가(시작한 계정이고, 처리 중이면 10분 안, 확정했으면 1일 안) */
export const visible = (a: Attempt, accountId: string, now: number): boolean =>
  a.accountId === accountId && (a.completedAt === null ? now <= a.expiresAt : now <= a.completedAt + RESULT_TTL_MS);

/** 같은 연계정보 HMAC이 이미 다른 계정에 묶였다(저장소의 UNIQUE가 늦은 쪽을 막았을 때) */
export class CiAlreadyLinked extends Error {
  constructor() {
    super('같은 연계정보 HMAC이 이미 다른 계정에 있다');
    this.name = 'CiAlreadyLinked';
  }
}

/** 본인확인기관을 쓸 수 없다(계약 전 운영 쪽 환경, 기관 장애). 유스케이스가 503 PROVIDER_DOWN으로 바꾼다 */
export class ProviderUnavailable extends Error {
  constructor() {
    super('본인확인기관을 쓸 수 없다');
    this.name = 'ProviderUnavailable';
  }
}

/** 같은 계정의 건 둘이 동시에 처음 본인확인을 저장하려 했다(늦은 쪽은 판정을 한 번 다시 한다) */
export class VerificationRaced extends Error {
  constructor() {
    super('같은 계정의 본인확인이 동시에 저장됐다');
    this.name = 'VerificationRaced';
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isAttemptId = (v: string): boolean => UUID.test(v);
