// 자동 배정 공연의 희망 조건(CMP-057 preference, docs/frontend.md §3.12 `peaket.autoassign.{eventId}`, ADR-0212 결정 1).
// 이 기기에만 저장한다. 서버로는 입장 뒤 좌석 화면이 홀드 요청의 auto로 보낸다(HOT-350). 등급은 공연 공개 요약의 priceTiers다.
import type { KV } from './store.ts';

export interface Tier {
  id: string;
  name: string;
}

export interface Preference {
  firstTierId: string;
  count: number;
  wheelchair: boolean;
  secondTierId?: string;
  allowSplit: boolean;
}

const keyOf = (eventId: string) => `peaket.autoassign.${eventId}`;

/** 처음 값: 첫 등급 1매, 휠체어석 아님, 2순위 없음, 분리 허용 아님 */
export function defaultPreference(tiers: readonly Tier[]): Preference {
  return { firstTierId: tiers[0]?.id ?? '', count: 1, wheelchair: false, allowSplit: false };
}

/** 그 회차의 등급·매수 상한에 맞는지 */
export function validPreference(p: Preference, tiers: readonly Tier[], maxCount: number): boolean {
  const ids = new Set(tiers.map((t) => t.id));
  return (
    ids.has(p.firstTierId) &&
    Number.isInteger(p.count) &&
    p.count >= 1 &&
    p.count <= maxCount &&
    (p.secondTierId === undefined || (ids.has(p.secondTierId) && p.secondTierId !== p.firstTierId))
  );
}

/** 저장된 희망 조건. 없거나 꼴이 틀리거나 이 회차에 맞지 않으면 null */
export function readPreference(kv: KV | null, eventId: string, tiers: readonly Tier[], maxCount: number): Preference | null {
  try {
    const r = JSON.parse(kv?.getItem(keyOf(eventId)) ?? 'null') as Record<string, unknown> | null;
    if (!r || typeof r !== 'object' || r.v !== 1 || typeof r.firstTierId !== 'string' || typeof r.count !== 'number' || typeof r.wheelchair !== 'boolean' || typeof r.allowSplit !== 'boolean') return null;
    if (r.secondTierId !== undefined && typeof r.secondTierId !== 'string') return null;
    const p: Preference = { firstTierId: r.firstTierId, count: r.count, wheelchair: r.wheelchair, allowSplit: r.allowSplit, ...(typeof r.secondTierId === 'string' ? { secondTierId: r.secondTierId } : {}) };
    return validPreference(p, tiers, maxCount) ? p : null;
  } catch {
    return null;
  }
}

export function writePreference(kv: KV | null, eventId: string, p: Preference, now: number): boolean {
  if (!kv) return false;
  try {
    kv.setItem(keyOf(eventId), JSON.stringify({ v: 1, firstTierId: p.firstTierId, count: p.count, wheelchair: p.wheelchair, ...(p.secondTierId ? { secondTierId: p.secondTierId } : {}), allowSplit: p.allowSplit, savedAt: Math.round(now) }));
    return true;
  } catch {
    return false;
  }
}

export function clearPreference(kv: KV | null, eventId: string): void {
  try {
    kv?.removeItem(keyOf(eventId));
  } catch {
    /* 넘긴다 */
  }
}
