// '등급과 가격' 패널의 계산(ADR-0264 결정 11, d5 §6.5 '등급과 가격', ADR-0260 결정 2·4). 순수 함수만 둔다.
// 줄마다 이름(1~30자)·가격(1~10,000,000원 [가정])과 [위로]·[아래로](CMP-050). 1~16개. 새 등급의 ID는 t + 숫자로 매기고 겹치지 않는다.
// 좌석이나 구역 기본 등급이 쓰는 등급은 지우지 못한다(먼저 좌석 등급을 바꾼다). 차례가 곧 저장 본문 priceTiers의 차례다.
import { type EditorDoc, seatTier, type Tier } from './types.ts';

export const TIERS_MAX = 16;
export const TIER_NAME_MAX = 30;
export const PRICE_MAX = 10_000_000;

/** 겹치지 않는 새 등급 ID(t1, t2, …) */
export function newTierId(tiers: readonly Pick<Tier, 'tierId'>[]): string {
  const used = new Set(tiers.map((t) => t.tierId));
  for (let n = 1; ; n++) if (!used.has(`t${n}`)) return `t${n}`;
}

/** 등급 더하기. 16개면 undefined(더할 수 없다) */
export function addTier(tiers: readonly Tier[]): Tier[] | undefined {
  if (tiers.length >= TIERS_MAX) return undefined;
  const tierId = newTierId(tiers);
  return [...tiers, { tierId, name: `새 등급 ${tiers.length + 1}`, price: null }];
}

/** [위로]·[아래로]. 끝을 넘으면 undefined */
export function moveTier(tiers: readonly Tier[], i: number, dir: -1 | 1): Tier[] | undefined {
  const j = i + dir;
  if (i < 0 || i >= tiers.length || j < 0 || j >= tiers.length) return undefined;
  const out = [...tiers];
  [out[i], out[j]] = [out[j]!, out[i]!];
  return out;
}

/** 등급마다 쓰는 좌석 수(좌석 tierId, 없으면 구역 tierId) */
export function tierUsage(doc: EditorDoc): Map<string, number> {
  const m = new Map<string, number>();
  for (const id of doc.order) {
    const s = doc.sections[id]!;
    for (const x of s.seats) {
      const t = seatTier(s, x);
      if (t !== undefined) m.set(t, (m.get(t) ?? 0) + 1);
    }
  }
  return m;
}

/** 지울 수 있는가: 좌석이 쓰지 않고(실제 등급) 구역 기본 등급도 아니다 */
export function canRemoveTier(doc: EditorDoc, tierId: string): boolean {
  if ((tierUsage(doc).get(tierId) ?? 0) > 0) return false;
  return !doc.order.some((id) => doc.sections[id]!.tierId === tierId);
}

export function removeTier(doc: EditorDoc, tierId: string): Tier[] | undefined {
  if (!canRemoveTier(doc, tierId)) return undefined;
  return doc.priceTiers.filter((t) => t.tierId !== tierId);
}

export function updateTier(tiers: readonly Tier[], tierId: string, patch: Partial<Pick<Tier, 'name' | 'price'>>): Tier[] {
  return tiers.map((t) => (t.tierId === tierId ? { ...t, ...patch } : t));
}

/** 제어 문자(C0·DEL·C1)가 있는가(서버 priceTierIssues와 같은 거름) */
const hasControl = (v: string) => [...v].some((ch) => {
  const c = ch.codePointAt(0)!;
  return c < 0x20 || (c >= 0x7f && c <= 0x9f);
});

/** 줄마다 입력 오류(이름·가격). 계약 SeatMapPriceTierInput과 같은 범위 */
export function tierErrors(t: Tier): { name?: string; price?: string } {
  const e: { name?: string; price?: string } = {};
  const len = [...t.name].length;
  if (t.name.trim() === '') e.name = '이름을 넣어 주세요';
  else if (len > TIER_NAME_MAX) e.name = `이름은 ${TIER_NAME_MAX}자까지입니다`;
  else if (hasControl(t.name)) e.name = '쓸 수 없는 글자가 있습니다';
  if (t.price === null) e.price = '가격을 넣어 주세요';
  else if (!Number.isInteger(t.price) || t.price < 1 || t.price > PRICE_MAX) e.price = `가격은 1~${PRICE_MAX.toLocaleString('ko-KR')}원입니다`;
  return e;
}

/** 가져온 배치의 등급 ID 가운데 가격 등급에 없는 것을 더한다. 가져온 파일이 가격까지 실었으면 그 값을 지키고, 없으면 이름이 그 ID이고 가격이 빈 등급이다(ADR-0264 결정 9) */
export function withImportedTiers(doc: EditorDoc, current: readonly Tier[]): Tier[] {
  const out = [...current];
  const known = new Set(out.map((t) => t.tierId));
  // 가져온 배치가 실은 가격 등급(다시 가져온 JSON·서버 응답)을 먼저 지킨다. 같은 ID는 지금 화면 값을 그대로 둔다
  for (const t of doc.priceTiers) {
    if (known.has(t.tierId)) continue;
    known.add(t.tierId);
    out.push({ ...t, name: t.name.slice(0, TIER_NAME_MAX) });
  }
  for (const id of doc.order) {
    const s = doc.sections[id]!;
    const ids = [s.tierId, ...s.seats.map((x) => x.tierId)];
    for (const t of ids) {
      if (t === undefined || known.has(t)) continue;
      known.add(t);
      out.push({ tierId: t, name: t.slice(0, TIER_NAME_MAX), price: null });
    }
  }
  return out;
}

/** 등급별 좌석 수와 예상 매출(요약 줄) */
export function tierSummary(doc: EditorDoc): { tierId: string; name: string; seats: number; revenue: number }[] {
  const use = tierUsage(doc);
  return doc.priceTiers.map((t) => ({ tierId: t.tierId, name: t.name, seats: use.get(t.tierId) ?? 0, revenue: (use.get(t.tierId) ?? 0) * (t.price ?? 0) }));
}
