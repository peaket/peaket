// SCR-002 공연 상세의 판매 단계·팬별 판매 자격·명단 밖 알림(ADR-0272 결정 3·4, d5 §5.2 '판매 정책 자격 없음'·'선예매 대상', BUILD_ORDER HOT-346).
// 순수 함수만 둔다(node --test가 바로 불러 본다). 상대 경로 .ts만 가져오고 api-client는 타입으로만 가져온다.
// - 판정 시각: 오픈 전 상태는 오픈 시각(로비 참가는 오픈 시각으로 판정, ADR-0265), 오픈 뒤 진입은 지금. 그 시각이 든 조각(startsAt ≤ 시각 < endsAt)을 고른다
// - 자격 모름(받기 전·실패·조각이 공개 요약과 다름)은 덮지 않는다. 집행은 로비 참가·진입의 403이다
import type { EventPublicSummary } from '@peaket/api-client/model';
import { dateTimeText, kstParts, parseTime } from '../../../shared/lib/kst.ts';

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

/** 계약 maxItems */
const MAX_PHASES = 10;
const KINDS: readonly SalePhaseKind[] = ['PRESALE', 'GENERAL'];
/** 판정 시각이 오픈 시각인 상태(오픈 전) */
const BEFORE_OPEN = new Set(['closed', 'pending', 'notYet', 'lobby', 'fifo']);
/** 자격을 받는 동안 ⑦을 뼈대로 두는 상태(들어갈 수 있는 때, ADR-0213 결정 2와 같은 규칙) */
const ENTERABLE = new Set(['notYet', 'lobby', 'queue']);

/** 조각 하나(계약 SalePhase·FanSaleEligibility.phases[]). 틀리면 undefined */
function phaseOf(p: unknown): DetailSalePhase | undefined {
  if (typeof p !== 'object' || p === null) return undefined;
  const o = p as { kind?: unknown; startsAt?: unknown; endsAt?: unknown; limitPerPerson?: unknown };
  if (!KINDS.includes(o.kind as SalePhaseKind)) return undefined;
  const startsAtMs = typeof o.startsAt === 'string' ? parseTime(o.startsAt) : undefined;
  const endsAtMs = typeof o.endsAt === 'string' ? parseTime(o.endsAt) : undefined;
  if (startsAtMs === undefined || endsAtMs === undefined || endsAtMs <= startsAtMs) return undefined;
  const limit = o.limitPerPerson;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 10) return undefined;
  return { kind: o.kind as SalePhaseKind, startsAtMs, endsAtMs, limit };
}

/** 공개 요약 salePhases → 시각 순 조각(틀린 조각은 버림, 10개까지) */
export function toSalePhases(list: EventPublicSummary['salePhases']): DetailSalePhase[] {
  if (!Array.isArray(list)) return [];
  return list
    .flatMap((p) => {
      const x = phaseOf(p);
      return x ? [x] : [];
    })
    .sort((a, b) => a.startsAtMs - b.startsAtMs)
    .slice(0, MAX_PHASES);
}

/** 팬별 판매 자격 본문 → 화면 값. 모양이 틀리면 none(자격 모름) */
export function toFanEligibility(body: unknown): FanEligibility {
  const none = { status: 'none' } as const;
  if (typeof body !== 'object' || body === null) return none;
  const b = body as { phases?: unknown; lists?: unknown };
  if (!Array.isArray(b.phases) || !Array.isArray(b.lists)) return none;
  const phases: FanPhase[] = [];
  // 조각은 공개 요약과 같은 차례로 견주므로 차례를 바꾸지 않고, 하나라도 틀리면 모름이다
  for (const p of b.phases.slice(0, MAX_PHASES) as unknown[]) {
    const x = phaseOf(p);
    const eligible = (p as { eligible?: unknown } | null)?.eligible;
    if (!x || typeof eligible !== 'boolean') return none;
    phases.push({ ...x, eligible });
  }
  const lists = (b.lists.slice(0, MAX_PHASES) as unknown[]).flatMap((l) => {
    if (typeof l !== 'object' || l === null) return [];
    const o = l as { name?: unknown; destroyAt?: unknown };
    const destroyAtMs = typeof o.destroyAt === 'string' ? parseTime(o.destroyAt) : undefined;
    return typeof o.name === 'string' && o.name && destroyAtMs !== undefined ? [{ name: o.name, destroyAtMs }] : [];
  });
  return { status: 'known', phases, lists };
}

/** 팬별 판매 자격을 부를 때인가(ADR-0272 결정 3 '부르는 때'): 회원 팬이고 끝나지 않은 PRESALE 조각이 있을 때 */
export function needsEligibility(phases: DetailSalePhase[], session: { status: string }, nowMs: number): boolean {
  return session.status === 'member' && phases.some((p) => p.kind === 'PRESALE' && p.endsAtMs > nowMs);
}

/** 판정 시각(ADR-0272 결정 3 '판정 시각과 조각'). 판매 종료·취소·모름은 없음 */
export function eligibilityJudgeAt(phase: string | undefined, openAtMs: number, nowMs: number): number | undefined {
  if (phase === 'queue') return nowMs;
  if (phase !== undefined && BEFORE_OPEN.has(phase)) return openAtMs;
  return undefined;
}

/** 그 시각이 든 조각의 차례(startsAt ≤ 시각 < endsAt). 없으면 -1 */
function phaseIndexAt(phases: DetailSalePhase[], atMs: number): number {
  return phases.findIndex((p) => p.startsAtMs <= atMs && atMs < p.endsAtMs);
}

/** 자격 없음 이유 글: 판정 시각 뒤 첫 GENERAL 조각의 시작(한국 시각). 없으면 첫 문장만 */
function deniedReason(phases: DetailSalePhase[], atMs: number): string {
  const general = phases.find((p) => p.kind === 'GENERAL' && p.startsAtMs > atMs);
  const lead = '이 회차의 선예매 대상이 아닙니다';
  return general ? `${lead}. 일반 예매는 ${dateTimeText(general.startsAtMs)}에 시작합니다` : lead;
}

/** 팬 자격의 조각이 공개 요약과 같은 차례·종류·시각인가(계약). 다르면 모름 */
function samePhases(pub: DetailSalePhase[], fan: FanPhase[]): boolean {
  return pub.length === fan.length && pub.every((p, i) => p.kind === fan[i]!.kind && p.startsAtMs === fan[i]!.startsAtMs && p.endsAtMs === fan[i]!.endsAtMs);
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
  const at = eligibilityJudgeAt(i.phase, i.openAtMs, i.nowMs);
  if (at === undefined) return null;
  // 대기실이 명단 밖으로 막아 돌려보냈다: 팬 자격과 상관없이 자격 없음(판정 시각은 지금, 결정 4)
  if (i.denied) return { reason: deniedReason(i.phases, i.nowMs) };
  if (i.session.status !== 'member') return null;
  const idx = phaseIndexAt(i.phases, at);
  if (idx < 0 || i.phases[idx]!.kind !== 'PRESALE') return null;
  const fan = i.fan;
  if (fan.status === 'loading') return i.phase !== undefined && ENTERABLE.has(i.phase) ? 'loading' : null;
  if (fan.status !== 'known' || !samePhases(i.phases, fan.phases)) return null;
  return fan.phases[idx]!.eligible ? null : { reason: deniedReason(i.phases, at) };
}

/** 지금 뒤의 가장 이른 조각 경계(ADR-0272 결정 3 '다시 고르는 때'). 같은 시각은 지난 것 */
export function saleBoundaryAfter(phases: DetailSalePhase[], nowMs: number): number | undefined {
  let next: number | undefined;
  for (const p of phases) {
    for (const t of [p.startsAtMs, p.endsAtMs]) if (t > nowMs && (next === undefined || t < next)) next = t;
  }
  return next;
}

/** 파기 날짜 '(M/D)'(한국 날짜). 명단이 없으면 날짜를 모르므로 빈 글 */
function destroyDateText(lists: { destroyAtMs: number }[]): string {
  if (lists.length === 0) return '';
  const k = kstParts(Math.max(...lists.map((l) => l.destroyAtMs)));
  return `(${k.m}/${k.d})`;
}

/** 선예매 대상 안내의 두 글(ADR-0272 결정 3 '선예매 대상 안내'). 글은 화면이 텍스트 노드로만 넣는다 */
export function presaleNotice(i: { fan: FanEligibilityState; sellerName: string; nowMs: number }): { lead: string; notice: string } | null {
  if (i.fan.status !== 'known') return null;
  let first: FanPhase | undefined;
  for (const p of i.fan.phases) {
    if (p.kind === 'PRESALE' && p.eligible && p.endsAtMs > i.nowMs && (!first || p.startsAtMs < first.startsAtMs)) first = p;
  }
  if (!first) return null;
  const lists = i.fan.lists;
  const names = lists.map((l) => l.name).join(' · ') || '판매 자격';
  const from = i.sellerName ? `판매자(${i.sellerName})가` : '판매자가';
  return {
    lead: `${names} 선예매 대상입니다. ${dateTimeText(first.startsAtMs)}부터 1인 ${first.limit}매까지 예매할 수 있습니다`,
    notice: `${from} 보낸 ${names} 명단에 회원님이 있습니다. 이 명단은 선예매 자격 확인에만 쓰고, 이 공연의 판매 기간이 끝나고 1일 뒤${destroyDateText(lists)} 지웁니다`,
  };
}

/** 주소 조각이 명단 밖 알림인가(정확히 같은 값만, ADR-0272 결정 4) */
export function isDeniedHash(hash: string): boolean {
  return hash === SALE_ELIGIBILITY_DENIED_HASH;
}

/** 명단 밖 알림이 꺼지는 시각: 지금이 든 조각의 끝. 없으면 undefined(문서 동안) */
export function deniedUntilMs(phases: DetailSalePhase[], nowMs: number): number | undefined {
  const idx = phaseIndexAt(phases, nowMs);
  return idx < 0 ? undefined : phases[idx]!.endsAtMs;
}
