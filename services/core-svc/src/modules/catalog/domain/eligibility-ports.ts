// 도메인 층: 판매 자격 명단의 바깥 포트(ADR-0261 결정 6·9). 어댑터가 구현한다.

/**
 * 회원 코드 → 계정 ID 변환(identity MemberCodeService.ResolveMemberCodes). 어댑터가 1만 개 [가정]씩 데드라인 2초 [가정]로 차례대로 부르고,
 * 답에는 찾은 것만 있다(가입을 마친 ACTIVE 계정). 호출이 하나라도 실패하면 MemberCodeLookupFailed를 던진다(부분 결과를 돌려주지 않는다)
 */
export interface MemberCodeDirectory {
  resolve(codes: readonly string[], opts: { signal?: AbortSignal }): Promise<Map<string, string>>;
}

/** 변환 실패(UNAVAILABLE·DEADLINE_EXCEEDED·UNIMPLEMENTED·INTERNAL과 정한 모양이 아닌 답). 회원 코드는 싣지 않는다 */
export class MemberCodeLookupFailed extends Error {
  constructor(readonly reason: string) {
    super(`회원 코드 변환 실패: ${reason}`);
    this.name = 'MemberCodeLookupFailed';
  }
}

/** 대기열 사본에 넘길 명단(구성원은 계정 ID, 수명은 파기 시각) */
export interface EligibilityCopyPut {
  productionId: string;
  /** 그 명단 키를 쓰는 규칙의 rounds에 든 회차(ALL이면 모든 회차) */
  eventIds: string[];
  listKey: string;
  /** 사본 판(전역 순번 copy_seq, 리뷰 H1). 받는 쪽은 판이 지금보다 클 때만 바꾼다 */
  version: number;
  accountIds: string[];
  /** 수명 = destroy_due_at */
  expiresAt: Date;
}

/**
 * 판매 자격 명단의 대기열 사본 넘기기(q:{event:E}:elig:{listKey}). 누가 대기열 Redis에 쓰는지는 소유자 결정 대기다(ADR-0261 결정 9, BAT-157 계획 OPEN 초안).
 * 그때까지 운영 조립은 늘 실패하는 어댑터다(조용히 넘어간 것으로 보이지 않게 경고 지표를 올린다)
 */
export interface SaleEligibilityCopy {
  /** 쓰는 쪽이 이어져 있는가. false면 정비 일은 구성원을 읽지 않고 넘길 명단 수만 지표로 낸다(리뷰 C1) */
  readonly connected: boolean;
  put(c: EligibilityCopyPut): Promise<void>;
  /** 받는 쪽은 지금 판이 version 이하일 때만 지운다(지운 뒤 다시 올린 더 큰 판은 남는다, 리뷰 S1) */
  drop(c: EligibilityCopyDrop): Promise<void>;
}

export interface EligibilityCopyDrop {
  eventIds: string[];
  listKey: string;
  version: number;
}

/** 감사 줄의 사람 식별값을 로그 가명으로 바꾼다(정규 로그 줄의 accountRef와 같은 키, ADR-0053 결정 1). 플랫폼 LogPseudonymizer가 맞는다 */
export interface LogPseudonym {
  ref(value: string): string;
}

export const MEMBER_CODE_DIRECTORY = Symbol('MEMBER_CODE_DIRECTORY');
export const LOG_PSEUDONYM = Symbol('LOG_PSEUDONYM');
/** 판매 자격 명단 운영 지표 묶음(application/sale-eligibility-metrics.ts) */
export const SALE_ELIGIBILITY_METRICS = Symbol('SALE_ELIGIBILITY_METRICS');
export const SALE_ELIGIBILITY_COPY = Symbol('SALE_ELIGIBILITY_COPY');
