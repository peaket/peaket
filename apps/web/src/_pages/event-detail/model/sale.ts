// SCR-002 공연 상세의 판매 단계·팬별 판매 자격·명단 밖 알림(ADR-0272 결정 3·4, BUILD_ORDER HOT-346).
// 순수 함수만 둔다(node --test가 바로 불러 본다). 시험 담당이 만든 빈 뼈대이고, 동작은 구현 담당이 채운다(ADR-0270 결정 1).
import type { EventPublicSummary } from '@peaket/api-client/model';

export type SalePhaseKind = 'PRESALE' | 'GENERAL';

export interface DetailSalePhase {
  kind: SalePhaseKind;
  startsAtMs: number;
  endsAtMs: number;
  limit: number;
}

export interface FanPhase extends DetailSalePhase {
  eligible: boolean;
}

export type FanEligibility = { status: 'none' } | { status: 'known'; phases: FanPhase[]; lists: { name: string; destroyAtMs: number }[] };

export type FanEligibilityState = { status: 'idle' } | { status: 'loading' } | FanEligibility;

export type EligibilityGate = null | 'loading' | { reason: string };

export const SALE_ELIGIBILITY_DENIED_HASH = '#sale-eligibility-required';

const notYet = (): never => {
  throw new Error('아직 없음');
};

/** 공개 요약 salePhases → 시각 순 조각(틀린 조각은 버림, 10개까지) */
export function toSalePhases(list: EventPublicSummary['salePhases']): DetailSalePhase[] {
  void list;
  return notYet();
}

/** 팬별 판매 자격 본문 → 화면 값. 모양이 틀리면 none */
export function toFanEligibility(body: unknown): FanEligibility {
  void body;
  return notYet();
}

/** 팬별 판매 자격을 부를 때인가(ADR-0272 결정 3 '부르는 때') */
export function needsEligibility(phases: DetailSalePhase[], session: { status: string }, nowMs: number): boolean {
  void phases;
  void session;
  void nowMs;
  return notYet();
}

/** 판정 시각(ADR-0272 결정 3 '판정 시각과 조각') */
export function eligibilityJudgeAt(phase: string | undefined, openAtMs: number, nowMs: number): number | undefined {
  void phase;
  void openAtMs;
  void nowMs;
  return notYet();
}

/** ⑦을 판매 자격으로 덮을 값(ADR-0272 결정 3 '자격 없음'·'실패'·받는 동안, 결정 4 명단 밖 알림) */
export function eligibilityGate(i: {
  phase: string | undefined;
  session: { status: string };
  phases: DetailSalePhase[];
  fan: FanEligibilityState;
  denied: boolean;
  openAtMs: number;
  nowMs: number;
}): EligibilityGate {
  void i;
  return notYet();
}

/** 지금 뒤의 가장 이른 조각 경계(ADR-0272 결정 3 '다시 고르는 때') */
export function saleBoundaryAfter(phases: DetailSalePhase[], nowMs: number): number | undefined {
  void phases;
  void nowMs;
  return notYet();
}

/** 선예매 대상 안내의 두 글(ADR-0272 결정 3 '선예매 대상 안내') */
export function presaleNotice(i: { fan: FanEligibilityState; sellerName: string; nowMs: number }): { lead: string; notice: string } | null {
  void i;
  return notYet();
}

/** 주소 조각이 명단 밖 알림인가(정확히 같은 값만, ADR-0272 결정 4) */
export function isDeniedHash(hash: string): boolean {
  void hash;
  return notYet();
}

/** 명단 밖 알림이 꺼지는 시각: 지금이 든 조각의 끝. 없으면 undefined(문서 동안) */
export function deniedUntilMs(phases: DetailSalePhase[], nowMs: number): number | undefined {
  void phases;
  void nowMs;
  return notYet();
}
