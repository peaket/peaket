// 대기실 머리(공연명·회차 일시·공연장)와 매진 화면의 다른 회차는 공연 공개 요약 GET /v1/events/{eventId}(CDN 300초)에서 읽는다(ADR-0207 결정 11).
// 대기열 경로를 막지 않게 따로 받고, 받기 전·실패하면 빈 머리로 둔다.
import type { Ordering, Round } from '../fixtures';

export interface EventMeta {
  id: string;
  title: string;
  /** 집중 셸 머리 둘째 줄(회차 일시 · 공연장, KST) */
  when: string;
  ordering: Ordering;
  autoAssign: boolean;
  rounds: readonly Round[];
  currentRound: string;
  /** 매진 화면의 등급별 안내(없으면 띄우지 않는다) */
  tierStatus: string | null;
}

const KST_MS = 9 * 3600_000;
const DAYS = ['일', '월', '화', '수', '목', '금', '토'];

/** 2026-12-24T10:00:00Z → '12/24(목) 19:00'(KST) */
export function kstLabel(iso: string): string | null {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const d = new Date(t + KST_MS);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}(${DAYS[d.getUTCDay()]}) ${hh}:${mm}`;
}

export const emptyMeta = (id: string): EventMeta => ({ id, title: '', when: '', ordering: 'HYBRID', autoAssign: false, rounds: [], currentRound: id, tierStatus: null });

/** 공개 요약을 읽는다. 꼴이 틀리면 null(빈 머리) */
export function metaFromSummary(id: string, raw: unknown): EventMeta | null {
  const r = raw as Record<string, unknown> | null;
  if (!r || typeof r.title !== 'string' || typeof r.startsAt !== 'string') return null;
  const at = kstLabel(r.startsAt);
  const place = typeof r.placeName === 'string' ? r.placeName : '';
  const rounds: Round[] = Array.isArray(r.rounds)
    ? r.rounds.flatMap((x) => {
        const o = x as Record<string, unknown>;
        if (typeof o.eventId !== 'string' || typeof o.startsAt !== 'string' || o.status === 'CANCELLED') return [];
        const label = kstLabel(o.startsAt);
        return label ? [{ id: o.eventId, label, status: o.status === 'SOLD_OUT' ? 'SOLD_OUT' : 'ON_SALE' } as Round] : [];
      })
    : [];
  return {
    id,
    title: r.title,
    when: [at, place].filter(Boolean).join(' · '),
    ordering: r.queueOrder === 'FIFO' || r.queueOrder === 'PREQUEUE_SHUFFLE' ? r.queueOrder : 'HYBRID',
    autoAssign: r.seatAssignment === 'AUTO',
    rounds,
    currentRound: id,
    tierStatus: null,
  };
}
