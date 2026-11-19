// 탈퇴 참여자와 탈퇴 미룸(docs/features/identity.md §8 '탈퇴 참여자와 탈퇴 미룸의 첫 구현', ADR-0284, BUILD_ORDER PRF-169, I-T84).
// 탈퇴 요청과 다시 하기 고리가 다른 서비스의 정리를 '탈퇴 참여자'에 묻는다. 첫 참여자는 purchase-svc WithdrawalParticipantService다.
// 순수한 값과 포트만 둔다(프레임워크를 가져오지 않는다).

/** 미룬 탈퇴의 다음 참여자 확인까지 60초 [가정](미룰 때와 고리가 잡을 때, identity §8 '미룸 표시'·'다시 하기 고리') */
export const WITHDRAWAL_NEXT_CHECK_MS = 60_000;
/** 다시 하기 고리 withdrawal-pending-retry의 간격 60초 [가정](API 파드마다) */
export const WITHDRAWAL_RETRY_INTERVAL_MS = 60_000;
/** 고리 한 바퀴에 잡는 미룬 계정 수 20개 [가정] */
export const WITHDRAWAL_RETRY_BATCH = 20;
/**
 * 고리 한 바퀴의 마감: 잡은 시각 + 50초 [가정](다음 확인 미루기 60초 − 고리 데드라인 10초). 이때부터 남은 계정을 부르지 않는다
 * (다음 확인 시각 뒤 다시 잡힌다. 참여자가 느려도 다른 파드가 같은 계정을 다시 잡기 전에 호출이 끝난다, identity §8 '다시 하기 고리', BAT-010 리뷰 RV-03)
 */
export const WITHDRAWAL_RETRY_ROUND_MS = 50_000;
/** 탈퇴 요청 경로의 참여자 호출 데드라인 3초 [가정] */
export const WITHDRAWAL_REQUEST_DEADLINE_MS = 3_000;
/** 다시 하기 고리의 참여자 호출 데드라인 10초 [가정] */
export const WITHDRAWAL_RETRY_DEADLINE_MS = 10_000;
/** 탈퇴 전 미사용 티켓 견적의 데드라인 2초 [가정](identity §8 '미사용 티켓 확인과 취소' 확인(견적)) */
export const WITHDRAWAL_QUOTE_DEADLINE_MS = 2_000;

/** 참여자의 답. PENDING이면 이유(참여자가 정한 이름, purchase는 PAYMENT_PENDING_ORDER·DEPOSIT_CANCEL_PENDING·TICKET_REFUND_PENDING) */
export type WithdrawalParticipantAnswer = { state: 'DONE' } | { state: 'PENDING'; reasons: readonly string[] };

/**
 * 탈퇴 전에 보여 줄 결제한 미사용 티켓의 환급 예상(identity §8 '미사용 티켓 확인과 취소' 확인(견적), purchase `QuoteAccountWithdrawal`).
 * 금액은 원 단위이고 참여자가 계산한 값을 그대로 쓴다(참여자마다 더한다). 공제액·환급액은 POL-032다
 */
export interface UnusedTicketsQuote {
  /** 취소할 미사용 티켓 수 */
  readonly count: number;
  /** 그 표들의 결제 금액 합(원) */
  readonly ticketAmount: number;
  /** POL-032 공제액 합(원) */
  readonly deductionAmount: number;
  /** 환급 예상액 합(원) */
  readonly refundAmount: number;
  /** 지금 양도할 수 있는 표 수(양도 마감 전) */
  readonly transferableCount: number;
  /** 입장이 시작돼 환급이 입장 기록 마감 뒤로 미뤄지는 표 수 */
  readonly deferredRefundCount: number;
}

export const WITHDRAWAL_PARTICIPANTS = Symbol('identity.WithdrawalParticipants');
/**
 * 탈퇴 참여자 하나(ADR-0284 결정 1). 한 번 부르면 그 서비스가 할 수 있는 정리를 하고 남은 것이 있는지 답한다. 다시 불러도 된다.
 * 답이 없거나(오류·기한 초과·차단기 열림) 모르는 값이면 WithdrawalParticipantUnavailable을 던진다(DONE으로 접지 않는다, 결정 3)
 */
export interface WithdrawalParticipant {
  /** 지표·로그의 참여자 이름(예 purchase) */
  readonly name: string;
  process(accountId: string, o: { deadlineMs: number }): Promise<WithdrawalParticipantAnswer>;
  /**
   * 탈퇴 전에 보여 줄 결제한 미사용 티켓의 환급 예상(읽기 전용). 미룸 표시 전에 부른다.
   * 취소할 표가 없으면 undefined(또는 count 0)다. 답이 없거나 실패하면 WithdrawalParticipantUnavailable을 던진다(탈퇴는 503, DONE으로 접지 않는다).
   * 견적을 낼 수 없는 참여자(대역)는 이 메서드를 두지 않는다(옛 대역을 깨지 않는다)
   */
  unusedTickets?(accountId: string, o: { deadlineMs: number }): Promise<UnusedTicketsQuote | undefined>;
}

/** 참여자가 답하지 않았거나 모르는 값을 줬다(탈퇴는 202로 미룬다) */
export class WithdrawalParticipantUnavailable extends Error {
  constructor(
    readonly participant: string,
    cause?: unknown,
  ) {
    super(`탈퇴 참여자 ${participant}가 답하지 않았다`, cause === undefined ? undefined : { cause });
    this.name = 'WithdrawalParticipantUnavailable';
  }
}

/** 참여자 호출의 길(지표 path) */
export type WithdrawalPath = 'request' | 'retry';
/** 참여자 호출 결과(지표 outcome) */
export type WithdrawalOutcome = 'done' | 'pending' | 'failed';

export const WITHDRAWAL_SIGNALS = Symbol('identity.WithdrawalSignals');
/** 탈퇴 미룸 지표(identity §8 '지표', §10.1 '탈퇴 미룸과 탈퇴 참여자' 행) */
export interface WithdrawalSignals {
  /** identity_withdrawal_participant_total{participant,path,outcome} */
  participant(participant: string, path: WithdrawalPath, outcome: WithdrawalOutcome): void;
  /** identity_withdrawal_pending_oldest_seconds: 가장 오래 미룬 WITHDRAWAL 계정의 closure_started_at부터 지금까지의 초(없으면 0) */
  pendingOldest(seconds: number): void;
  /** identity_withdrawal_ticket_quote_total{result}: 탈퇴 전 미사용 티켓 견적의 결과(ok 409로 안내, none 0장, error 견적 실패). 옛 대역을 깨지 않게 선택이다 */
  ticketQuote?(result: 'ok' | 'none' | 'error'): void;
}
