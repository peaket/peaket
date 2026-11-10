// 판매 단계 요약(ADR-0261 결정 3·5): 공개 요약 salePhases, 팬별 자격, 판매 승인의 진입 자격 창 eligGates가 같은 조각을 쓴다.
import { applies, listKeysOf, smallestLimit } from './conditions.js';
import { entryGate } from './entry-gate.js';
import type { SalePolicyRule } from './schema.js';

export interface SalePhase {
  /** PRESALE: 명단이 없는 사람이 들어갈 수 없는 창 */
  kind: 'PRESALE' | 'GENERAL';
  startsAt: Date;
  endsAt: Date;
  /** 표시용 한도(PRESALE은 창을 여는 명단 키를 가진 사람의, GENERAL은 명단이 없는 사람의 나올 수 있는 한도 가운데 가장 작은 값). 강제는 홀드 때의 평가다 */
  limitPerPerson: number;
  /** PRESALE 창을 여는 명단 키(GENERAL은 빈 목록) */
  lists: string[];
}

/** 단계 조각 상한 [가정](openapi salePhases maxItems) */
const MAX_PHASES = 10;

/**
 * 오픈부터 판매 종료까지를 걸리는 규칙의 during 경계로 자르고, 조각마다 명단이 없는 사람의 진입 판정이 거부면 PRESALE, 아니면 GENERAL이다.
 * 이웃한 조각은 종류와 명단 키 집합이 같을 때만 합친다(한도는 작은 값, 리뷰 A2). 앞에서부터 10개 [가정]까지다
 */
export function salePhases(rules: readonly SalePolicyRule[], round: string, o: { openAt: Date; saleEndsAt: Date; perPersonLimit: number }): SalePhase[] {
  const open = o.openAt.getTime();
  const end = o.saleEndsAt.getTime();
  if (!(open < end)) return [];
  const cuts = new Set<number>([open, end]);
  for (const r of rules) {
    if (!r.rule || !r.during || (r.rounds !== 'ALL' && !r.rounds.includes(round))) continue;
    for (const t of [r.during.from, r.during.to]) {
      if (t === undefined) continue;
      const ms = Date.parse(t);
      if (ms > open && ms < end) cuts.add(ms);
    }
  }
  const points = [...cuts].sort((a, b) => a - b);
  const out: SalePhase[] = [];
  for (let i = 0; i + 1 < points.length; i++) {
    const at = points[i]!;
    const piece = phaseAt(rules, round, at, o.perPersonLimit);
    const last = out.at(-1);
    if (last && last.kind === piece.kind && sameSet(last.lists, piece.lists)) {
      last.endsAt = new Date(points[i + 1]!);
      last.limitPerPerson = Math.min(last.limitPerPerson, piece.limitPerPerson);
      continue;
    }
    out.push({ ...piece, startsAt: new Date(at), endsAt: new Date(points[i + 1]!) });
  }
  return out.slice(0, MAX_PHASES);
}

/** 조각 안에서는 걸리는 규칙이 바뀌지 않으므로 조각의 시작 시각으로 본다 */
function phaseAt(rules: readonly SalePolicyRule[], round: string, at: number, roundLimit: number): Omit<SalePhase, 'startsAt' | 'endsAt'> {
  const when = new Date(at);
  if (entryGate(rules, { at: when, round, lists: [] }).allowed) return { kind: 'GENERAL', limitPerPerson: smallestLimit(rules, { round, lists: [] }, at, roundLimit), lists: [] };
  // 창을 여는 명단 키는 넓게 잡는다(리뷰 A3): 그 창에서 진입 판정을 지날 수 있는 사람이 가질 수 있는 키 모두다. 걸리는 규칙이 쓰는 키를 모두 가진 사람이
  // 지나면 그 키 모두, 아니면 그 키 하나만으로 지나는 키들이다. 정확한 판정은 홀드 때의 평가가 한다
  const candidates: string[] = [];
  for (const r of rules) if (applies(r, round, at)) listKeysOf(r.rule!.if, candidates);
  const all = candidates.length > 0 && entryGate(rules, { at: when, round, lists: candidates }).allowed;
  const openers = all ? candidates : candidates.filter((k) => entryGate(rules, { at: when, round, lists: [k] }).allowed);
  // 한도는 그 키를 가진 사람에게 나올 수 있는 한도 가운데 가장 작은 값(키 모두로 지나면 그 사람, 아니면 키마다 본 값 가운데 가장 작은 값)
  const holders = all ? [candidates] : openers.map((k) => [k]);
  const limit = holders.length > 0 ? Math.min(...holders.map((lists) => smallestLimit(rules, { round, lists }, at, roundLimit))) : roundLimit;
  return { kind: 'PRESALE', limitPerPerson: limit, lists: openers };
}

const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((k) => b.includes(k));
