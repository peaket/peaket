// 가상계좌 입금 확인의 값과 규칙(docs/features/payment.md §6 '입금 확인의 첫 구현', docs/data.md §2 payment, BUILD_ORDER HOT-151, ADR-0062).
// 프레임워크·저장소를 모른다(순수 값과 함수). 계좌번호 평문과 입금 secret은 여기서 로그로 나가지 않는다.
import { createHash, timingSafeEqual } from 'node:crypto';

/** 입금 기한 뒤 조회까지의 여유 10분 [가정](payment §6 '기한 만료') */
export const DEPOSIT_QUERY_GRACE_MS = 10 * 60_000;
/** 입금 기한을 모를 때 다음 조회까지 1시간 [가정] */
export const DEPOSIT_NO_DUE_RECHECK_MS = 3_600_000;
/** 다음 조회 시각이 이미 지났을 때의 간격 5초 [가정](UNKNOWN의 첫 조회와 같다) */
export const DEPOSIT_PAST_DUE_DELAY_MS = 5_000;
/** 입금 완료 통보 뒤 짧은 간격으로 다시 묻는 시간 10분 [가정](결제사 조회 반영이 통보보다 늦을 때, BUILD_ORDER HOT-151 코드 리뷰) */
export const DEPOSIT_NOTIFIED_WINDOW_MS = 10 * 60_000;

/** 결제사가 준 새 입금 기한을 그대로 쓰는 최소 여유 2시간 [가정](다시 입금할 시간을 주려고, BUILD_ORDER HOT-152 코드 리뷰) */
export const REVERSAL_DUE_MIN_LEAD_MS = 2 * 3_600_000;

/**
 * 입금 오류로 되돌린 결제의 새 입금 기한(epoch ms): 조회 답의 기한이 지금 + 2시간 [가정] 이상 남았으면 그 값, 아니면 다음 날 23:59(KST) [가정](docs/planning/03 §2.4의 공식, BUILD_ORDER HOT-152).
 * '입장 24시간 전' 상한은 입장 시각을 아는 쪽(PRF-190)이 자른다.
 * @param answerDueMs 조회 답의 입금 기한(epoch ms). 없으면 undefined
 * @param nowMs 지금(epoch ms)
 */
export function reversalDueAtMs(answerDueMs: number | undefined, nowMs: number): number {
  if (answerDueMs !== undefined && answerDueMs >= nowMs + REVERSAL_DUE_MIN_LEAD_MS) return answerDueMs;
  // KST 하루의 시작(epoch ms)을 구해 다음 날 23:59를 더한다
  const startOfKstDay = Math.floor((nowMs + KST_OFFSET_MS) / DAY_MS) * DAY_MS - KST_OFFSET_MS;
  return startOfKstDay + DAY_MS + REVERSAL_DUE_TIME_OF_DAY_MS;
}

const KST_OFFSET_MS = 9 * 3_600_000;
const DAY_MS = 86_400_000;
/** 하루의 23:59까지(ms) [가정](docs/planning/03 §2.4의 입금 기한 공식) */
const REVERSAL_DUE_TIME_OF_DAY_MS = 23 * 3_600_000 + 59 * 60_000;

/** 입금 대기를 쓰는 트랜잭션이 함께 쓰는 값(docs/data.md payment의 가상계좌 칸). 틀리거나 없는 칸은 비운다(코드 리뷰 M5) */
export interface DepositWrite {
  /** 입금 기한(epoch ms). 결제사가 주지 않았으면 없다 */
  readonly dueAtMs?: number;
  readonly bank?: string;
  /** 필드 암호화한 계좌번호(base64). 키가 없거나 암호화에 실패하면 없다(평문을 저장하지 않는다) */
  readonly accountNoSealed?: string;
  /** 입금 통보 secret의 SHA-256. 포트원은 없다 */
  readonly secretHash?: Buffer;
}

/** 필드 암호화 실패의 까닭. 값은 싣지 않는다 */
export type VirtualAccountFieldReason = 'NO_KEY' | 'ERROR';

/** 계좌번호 필드 암호화(결제 건에 묶는다). 구현은 어댑터다 */
export interface VirtualAccountCipher {
  /** 키가 있는가. 없으면 seal·open을 부르지 않는다 */
  readonly ready: boolean;
  /**
   * @throws Error 암호화 실패. 글에 값을 싣지 않는다
   */
  seal(paymentId: string, accountNumber: string): Promise<string>;
  /**
   * @throws Error 복호 실패(다른 결제 행의 암호문 포함). 글에 값을 싣지 않는다
   */
  open(paymentId: string, sealed: string): Promise<string>;
}

/**
 * 입금 대기 행의 다음 조회 시각(epoch ms): 기한이 있으면 max(기한 + 10분, 지금 + 5초), 없으면 지금 + 1시간.
 * @param dueAtMs 입금 기한(epoch ms). 모르면 undefined
 * @param nowMs 지금(epoch ms)
 */
export function depositNextQueryAtMs(dueAtMs: number | undefined, nowMs: number): number {
  if (dueAtMs === undefined) return nowMs + DEPOSIT_NO_DUE_RECHECK_MS;
  return Math.max(dueAtMs + DEPOSIT_QUERY_GRACE_MS, nowMs + DEPOSIT_PAST_DUE_DELAY_MS);
}

/** 입금 기한 + 10분이 지났는가(같은 시각은 지난 것으로 본다). 기한을 모르면 거짓이다 */
export function depositExpired(dueAtMs: number | undefined, nowMs: number): boolean {
  return dueAtMs !== undefined && nowMs >= dueAtMs + DEPOSIT_QUERY_GRACE_MS;
}

/** 입금 완료 통보 뒤 10분 [가정] 안인가(같은 시각은 지난 것으로 본다). 통보가 없으면 거짓이다 */
export function depositNotifiedRecently(notifiedAtMs: number | undefined, nowMs: number): boolean {
  return notifiedAtMs !== undefined && nowMs < notifiedAtMs + DEPOSIT_NOTIFIED_WINDOW_MS;
}

/** 입금 통보 secret의 SHA-256 */
export function depositSecretHashOf(secret: string): Buffer {
  return createHash('sha256').update(secret, 'utf8').digest();
}

/** 두 해시가 같은가(상수 시간 비교). 길이가 다르면 거짓이다 */
export function depositSecretMatches(expected: Uint8Array, actual: Uint8Array): boolean {
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
