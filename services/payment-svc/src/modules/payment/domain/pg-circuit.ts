// 결제사 서킷의 포트와 값(docs/features/payment.md §2 '결제사 서킷의 첫 구현', docs/verification.md §4.1 '결제사 서킷과 미루기', ADR-0009 결정 2, BUILD_ORDER PRF-200).
// 프레임워크·저장소를 모른다. 차단기(packages/platform circuit-breaker)는 adapters/pg-circuit.ts가 잇고, 보호기(PgCallGuard)와 실행기는 이 포트로만 본다.
import type { ConfirmResult, PgName, QueryResult } from './payment-gateway.js';

/** 서킷이 열려 잡은 명령을 미루는 간격 1초 [가정]. 단독 조회의 다음 시각에도 쓴다 */
export const PG_CIRCUIT_DEFER_MS = 1_000;
/** 반 열림의 시험 호출로 행을 잡은 뒤 부르기까지의 틈에 다음 틱이 또 잡지 않게 막는 시간 1초 [가정] */
export const PG_CIRCUIT_TRIAL_HOLD_MS = 1_000;
/** 조회할 UNKNOWN이 없는 반 열림의 시험 호출이 묻는, 결제가 없는 고정 번호(docs/features/payment.md '새 결제 진입 정지'의 확인 호출과 같은 모양, ADR-0105 결정 2) */
export const PG_CIRCUIT_PROBE_PAYMENT_REF = 'peaket-circuit-probe';
/** 없는 결제 조회의 기한 1초 [가정](ADR-0105 결정 2) */
export const PG_CIRCUIT_PROBE_TIMEOUT_MS = 1_000;

export type PgCircuitState = 'closed' | 'half_open' | 'open';

/**
 * 서킷을 거치는 호출의 종류(코드 리뷰, BUILD_ORDER PRF-200). confirm은 닫혔을 때만 부르고 열림 판정에 센다.
 * query는 닫혔을 때 판정에 세지 않고(조회 실패가 승인을 막거나 조회 성공이 승인 실패를 희석하지 않게), 반 열림에서는 시험 호출이 된다(실제 고객 승인을 시험으로 내보내지 않게).
 * 취소는 run을 거치지 않는다: 닫혔을 때만 부르고 판정에 세지 않는다
 */
export type PgCallKind = 'confirm' | 'query';

/** 채널 하나의 서킷 */
export interface PgCircuit {
  state(): PgCircuitState;
  /** 차단기가 지금 호출을 받는가(닫힘, 또는 시험 호출이 아직 나가지 않은 반 열림). 토큰·자리와 호출 종류는 보지 않는다 */
  admits(): boolean;
  /** 서킷을 한 번 닫는다(사람이 푼 해제를 이 파드가 봤을 때, ADR-0105 결정 7 보완). 닫혀 있으면 아무것도 하지 않는다 */
  close(): void;
  /**
   * 결제사 호출 하나를 서킷 안에서 돈다. 판정에 세는 호출에서 isOutage가 참인 답은 일시 장애로 세되 부른 쪽에는 답을 그대로 돌려준다. 던진 오류는 실패로 센다.
   * @throws PgCircuitOpenError 서킷이 끊어 action을 부르지 않았다(열림, 시험 호출이 이미 나간 반 열림, 반 열림의 승인)
   */
  run<T>(action: () => Promise<T>, isOutage: (answer: T) => boolean, kind: PgCallKind): Promise<T>;
}

/** 채널별 서킷 등록부 */
export interface PgCircuits {
  /** 그 채널의 서킷. 없으면 undefined(서킷 없이 부른다) */
  of(pg: PgName): PgCircuit | undefined;
}

/** 서킷이 열려 결제사를 부르지 않았다. 호출한 적이 없으므로 결과를 가정하지 않는다(승인은 미룬다) */
export class PgCircuitOpenError extends Error {
  override readonly name = 'PgCircuitOpenError';
  constructor() {
    super('결제사 서킷이 열려 부르지 않았다');
  }
}

/** 승인 답이 일시 장애(연결 실패·읽기 시간 초과·5xx)인가. 업무 거절·429·처리 중은 일시 장애가 아니다 */
export function isConfirmOutage(answer: ConfirmResult): boolean {
  return answer.outage === true;
}

/** 조회 답이 일시 장애인가. 결제 없음(NOT_FOUND)·429·어긋난 답은 일시 장애가 아니다 */
export function isQueryOutage(answer: QueryResult): boolean {
  return answer.kind === 'UNKNOWN' && answer.outage === true;
}

/** 없는 결제 조회의 답이 실패인가. 결제사가 정상으로 답한 결제 없음(또는 있음)만 성공이고 5xx·시간 초과·연결 실패·429·인증 오류는 실패다(ADR-0105 결정 2) */
export function isProbeFailure(answer: QueryResult): boolean {
  return answer.kind === 'UNKNOWN';
}
