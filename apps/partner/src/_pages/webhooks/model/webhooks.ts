// SCR-025 웹훅 연동 목업(보드 SCR-025-m·t·d, d5 §6.8). 합성 데이터다. 주소는 예시 도메인(partner.example.com), 거절 예는 문서용 IP 주소다.
// 데이터를 잇는 단계에서 엔드포인트·구독·발송 원장(webhook_delivery) API로 바꾼다.

export const ENDPOINT = {
  url: 'https://partner.example.com/hook',
  savedAt: '10/1(목) 10:30 KST',
  secretIssued: '10/1(목)',
  secretMasked: 'whsec_••••••••••••••••••••••••',
  /** '새 비밀 한 번 보기'에서만 보이는 예시 값(실제 비밀이 아니다) */
  newSecret: 'whsec_EXAMPLEONLY0NotARealSecret00000000000=',
  newSecretIssued: '10/14(수) 20:04 KST',
  oldSecretUntil: '10/15(목) 20:04 KST',
} as const;

export const BAD_URL = {
  http: { value: 'http://partner.example.com/hook', message: 'https 주소만 등록할 수 있습니다' },
  rejected: {
    value: 'https://203.0.113.10:8443/hook',
    message:
      '이 주소는 등록할 수 없습니다. https와 443 포트만 받고, IP 주소·localhost·사용자 정보(user:pass@)가 든 주소나 공인 주소가 아닌 곳은 받지 않습니다',
  },
} as const;

/** 계속 실패해 꺼짐(d5 §6.8 그림 예) */
export const DISABLED_INFO = {
  title: '5일 동안 한 번도 받지 못해 보내기를 멈췄습니다. 주소를 확인한 뒤 다시 켜세요',
  detail: '10/14(수) 09:12 KST에 껐습니다 · 마지막 성공 10/8(목) 21:40 KST · DLQ 53건',
} as const;

export const USE_CASES: readonly { icon: string; title: string; types: string }[] = [
  { icon: 'ic-receipt', title: '매출·회계 시스템에 판매·환급 금액 반영', types: 'order.confirmed · order.cancelled' },
  { icon: 'ic-bell', title: '사내 메신저에 매진·회차 취소·연기 알림', types: 'event.sold_out · event.cancelled · event.postponed' },
  { icon: 'ic-globe', title: '자사 홈페이지·SNS 공지 자동 갱신', types: 'event.sold_out · event.cancelled · event.postponed' },
  { icon: 'ic-won', title: '정산 통지·입금 확인', types: 'statement.notified · payout.completed · payout.failed' },
];

/** 구독할 이벤트 8종(d5 §6.8 ⑤). checked는 그림 예의 구독 */
export const EVENT_TYPES: readonly { type: string; label: string; desc: string; checked: boolean }[] = [
  { type: 'order.confirmed', label: '판매 확정', desc: '결제가 확정되어 티켓을 발권했을 때', checked: true },
  { type: 'order.cancelled', label: '예매 취소·환급', desc: '예매 취소가 확정되어 환급을 시작할 때', checked: true },
  { type: 'event.sold_out', label: '매진', desc: '회차의 모든 좌석이 팔렸을 때', checked: false },
  { type: 'event.cancelled', label: '회차 취소 확정', desc: '회차 취소가 확정되었을 때', checked: false },
  { type: 'event.postponed', label: '회차 연기 확정', desc: '회차 연기가 확정되었을 때', checked: false },
  { type: 'statement.notified', label: '정산서 통지', desc: '정산서를 계산해 알렸을 때(이의 기간 시작)', checked: false },
  { type: 'payout.completed', label: '지급 완료', desc: '정산금이 정산 계좌로 지급되었을 때', checked: false },
  { type: 'payout.failed', label: '지급 실패', desc: '지급이 실패해 계좌 확인이 필요할 때', checked: false },
];

export type DeliveryStatus = 'retrying' | 'success' | 'dlq';

export const DELIVERY_STATUS: Record<DeliveryStatus, { cls: string; label: string }> = {
  retrying: { cls: 'badge badge-warning', label: '재시도 중' },
  success: { cls: 'badge badge-success', label: '성공' },
  dlq: { cls: 'badge badge-danger', label: 'DLQ' },
};

export interface Delivery {
  /** 가린 webhook-id */
  id: string;
  label: string;
  type: string;
  attempts: number;
  /** HTTP 응답 코드. 없으면 responseText */
  code?: string;
  responseText?: string;
  at: string;
  /** 다음 재시도. 없으면 '—', 끝났으면 '— 재시도 끝' */
  next?: string;
  status: DeliveryStatus;
}

const SOLD = { label: '판매 확정', type: 'order.confirmed' };
const CANCEL = { label: '예매 취소·환급', type: 'order.cancelled' };
const TIMEOUT = '응답 없음(시간 초과)';

/** 그림 예: 3번째 시도 뒤 30분 간격이라 다음 재시도 20:33, DLQ는 7번(처음 + 1분·5분·30분·2시간·6시간·12시간, ADR-0109) */
export const deliveries: readonly Delivery[] = [
  { id: 'msg_…7Q2D', ...SOLD, attempts: 3, code: '503', at: '20:03:40 KST', next: '20:33 KST', status: 'retrying' },
  { id: 'msg_…K8DW', ...CANCEL, attempts: 1, code: '200', at: '20:02:05 KST', status: 'success' },
  { id: 'msg_…B6FR', ...SOLD, attempts: 2, code: '200', at: '20:00:31 KST', status: 'success' },
  { id: 'msg_…P1XA', ...SOLD, attempts: 7, responseText: TIMEOUT, at: '18:47:09 KST', status: 'dlq' },
  { id: 'msg_…Z3MK', ...CANCEL, attempts: 7, code: '500', at: '18:46:51 KST', status: 'dlq' },
];

/** 꺼진 주소의 기록(최근 5건, 전체 53 · DLQ 53) */
export const disabledDeliveries: readonly Delivery[] = [
  { id: 'msg_…T5JQ', ...CANCEL, attempts: 7, responseText: TIMEOUT, at: '10/14 09:12 KST', status: 'dlq' },
  { id: 'msg_…W2HN', ...SOLD, attempts: 7, code: '502', at: '10/14 06:41 KST', status: 'dlq' },
  { id: 'msg_…C9LV', ...SOLD, attempts: 7, responseText: TIMEOUT, at: '10/13 22:05 KST', status: 'dlq' },
  { id: 'msg_…F4RB', ...CANCEL, attempts: 7, code: '502', at: '10/13 17:30 KST', status: 'dlq' },
  { id: 'msg_…N7GS', ...SOLD, attempts: 7, responseText: TIMEOUT, at: '10/13 11:58 KST', status: 'dlq' },
];

export type LogFilter = 'all' | DeliveryStatus;

export interface LogCounts {
  all: number;
  retrying: number;
  dlq: number;
  success: number;
}

export const LOG_COUNTS: LogCounts = { all: 5, retrying: 1, dlq: 2, success: 2 };
export const DISABLED_LOG_COUNTS: LogCounts = { all: 53, retrying: 0, dlq: 53, success: 0 };
