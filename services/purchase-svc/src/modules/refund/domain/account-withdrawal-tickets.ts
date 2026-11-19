// 탈퇴 참여자의 결제한 미사용 티켓의 값·상수(docs/features/payment.md §4.1 '미사용 티켓 견적'·'미사용 티켓 취소',
// docs/features/identity.md §8 '미사용 티켓 확인과 취소', docs/planning/03 §1.5 ①, ADR-0284 결정 7, I-T26, BAT-013).
// 표마다 만드는 취소 ID는 표 ID에서 나온 고정 UUID(버전 8)라 다시 불러도 같은 결제사 멱등키(cancel-{취소 ID})다.
import { createHash } from 'node:crypto';

/** 한 호출에서 부르는 취소 상한·여유·데드라인 상한은 포트 계약 옆(booking/domain/ports.ts)에 있다 */
/** 양도 마감은 공연 시작 2시간 전과 입장 시작 가운데 이른 때다(POL-017) */
export const TRANSFER_CLOSE_BEFORE_START_MS = 2 * 60 * 60_000;

/** 탈퇴 참여자가 읽는 그 계정의 미사용 티켓 한 장(order_item.ticket_id) */
export interface WithdrawalTicket {
  readonly ticketId: string;
  readonly orderId: string;
  readonly eventId: string;
  /** 표 권면 금액(주문 항목 unit_price, 원) */
  readonly ticketPrice: number;
  /** 주문을 만든 시각(예매 완료 시점, 24시간 특례의 시작) */
  readonly bookedAtMs: number;
}

/**
 * 탈퇴 참여자가 읽는 표와 취소 행(운영은 adapters/db/drizzle-account-withdrawal-tickets.ts).
 * 호출마다 한 문장이고 그 계정의 주문만 읽는다. DB에 닿지 못하거나 문장 시간 한도를 넘으면 WithdrawalOrdersUnavailable을 던진다(그 밖의 SQL 오류는 그대로)
 */
export interface WithdrawalTicketStore {
  /** 그 계정이 결제했고 아직 가진 표(취소 기록이 없고 주문이 CONFIRMED·PARTIALLY_REFUNDED). 공연 시작 전인지는 부르는 쪽이 판매 설정으로 가른다 */
  unusedTicketsOf(accountId: string, o: { statementTimeoutMs: number }): Promise<WithdrawalTicket[]>;
  /** 그 계정 주문의 order_cancellation 가운데 사유 ACCOUNT_WITHDRAWAL이고 상태가 REQUESTED·REFUND_PENDING인 표 수 */
  pendingRefunds(accountId: string, o: { statementTimeoutMs: number }): Promise<number>;
  /** 취소 ID로 취소 행의 상태. 없으면 undefined(행을 쓴 뒤 실패한 표를 두 번 세지 않게) */
  cancellationStatus(cancellationId: string): Promise<string | undefined>;
}

/**
 * 표 하나의 고정 취소 ID: sha256(`WithdrawalCancel:{표 ID}`) 앞 16바이트를 UUID 버전 8 모양으로 바꾼다(ADR-0284 결정 7).
 * 같은 표는 늘 같은 값이라 다시 불러도 같은 결제사 멱등키다(이중 환급 방지)
 */
export function withdrawalTicketCancellationId(ticketId: string): string {
  const hash = createHash('sha256').update(`WithdrawalCancel:${ticketId}`).digest();
  const b = Buffer.from(hash.subarray(0, 16));
  // 버전 8(사용자 정의)과 RFC 4122 변형 비트
  b[6] = (b[6]! & 0x0f) | 0x80;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const hex = b.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
