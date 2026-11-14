// 판매 승인 업무의 판매 중지·재개 값(ADR-0123, docs/features/transfer-refund.md §2.1, docs/data.md sale_control).
// 운영 명령 SALE_STOP/SALE_RESUME이 이 값을 회차마다 쓴다. 명령 3(판매 일시정지)의 paused와는 다른 칸이라,
// 명령 3을 재개해도 판매 중지는 풀리지 않고 판매 재개만 suspended를 내린다(ADR-0123 결정 3).
// 이 모듈은 프레임워크를 모른다. 저장소·사본은 포트로만 만난다.

/** 판매 중지·재개 요청의 두 갈래 */
export const SALE_SUSPENSION_ACTIONS = ['SUSPEND', 'RESUME'] as const;
export type SaleSuspensionAction = (typeof SALE_SUSPENSION_ACTIONS)[number];

/** sale_control의 범위. 이번 몫은 EVENT만 쓴다 */
export type SaleControlScope = 'EVENT' | 'PLATFORM';

/** 원본 표의 한 행(회차 범위) */
export interface SaleControl {
  readonly eventId: string;
  /** 판매 일시정지(명령 3). 이번 몫은 읽기만 한다 */
  readonly paused: boolean;
  /** 판매 중지(판매 승인 업무). 재개로만 내려간다 */
  readonly suspended: boolean;
  /** 그 범위에서 늘어나기만 하는 판 번호(1 이상) */
  readonly revision: number;
  /** 마지막으로 이 행을 바꾼 명령(운영 명령 SALE_STOP·SALE_RESUME) */
  readonly commandId?: string;
  /** 판매 중지를 건 승인 업무 ID(없으면 마지막 값을 그대로 둔다) */
  readonly suspensionRef?: string;
  readonly reason?: string;
  readonly updatedAtMs: number;
}

/** 한 번의 쓰기. 같은 명령이 같은 상태를 다시 쓰면 판 번호를 올리지 않는다(재시도 멱등) */
export interface SaleSuspensionWrite {
  readonly eventId: string;
  readonly suspended: boolean;
  readonly commandId: string;
  readonly suspensionRef?: string;
  readonly reason: string;
  readonly nowMs: number;
  /**
   * 제어 gRPC가 매긴 판 번호(ApplyControlRequest.version). 있으면 그 값보다 큰 판만 쓴다(같거나 작으면 지금 값을 돌려준다).
   * HTTP 경로(운영 명령 집행)는 비워 두고 저장소가 판 번호를 하나 올린다.
   */
  readonly version?: number;
}

/** 내부 HTTP가 받는 한 번의 요청(사람이 고른 갈래와 명령) */
export interface SaleSuspensionInput {
  readonly eventId: string;
  readonly action: SaleSuspensionAction;
  readonly commandId: string;
  readonly reason: string;
  readonly suspensionRef?: string;
  readonly nowMs: number;
  /** 제어 gRPC가 매긴 판 번호(있으면 그 값보다 큰 판만 쓴다) */
  readonly version?: number;
}

export interface SaleSuspensionApplied {
  readonly control: SaleControl;
  /** 이번 호출이 행을 바꿨는가. 거짓이면 같은 명령의 다시 실행이다 */
  readonly changed: boolean;
}

/** 실행 결과(ops-svc 명령 결과에 실을 값) */
export interface SaleSuspensionResult {
  readonly eventId: string;
  readonly suspended: boolean;
  readonly revision: number;
  readonly changed: boolean;
}
