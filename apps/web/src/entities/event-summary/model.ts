// 회차 공개 요약 읽기(openapi GET /v1/events/{eventId} EventPublicSummary의 title·startsAt·sellerName, 인증 없음·CDN 캐시).
// 현장 스태프 화면(초대 수락 SCR-050·스캐너 승인 SCR-051·내 현장 배정 SCR-061)이 배정의 eventId로 판매자 상호·공연명·회차 시작을 읽는다
// (d5 §5.26·§5.27 '파트너 이름'·§5.35, open-items 78번, ADR-0362 결정 1). 404·410·연결 실패·모양이 틀린 본문은 모두 '못 읽음'이다.
// 시간 한도는 docs/frontend.md §4.1 'api-client 밖의 호출'의 읽기 값(shared/lib/timed-fetch.ts). 읽은 요약은 이 읽기 도구의 메모리에만 둔다(화면이 닫히면 사라진다).
// 같은 회차를 동시에 여러 번 물으면 한 요청을 나눠 기다린다. 경로 별칭 없이 상대 경로로 가져온다(node 시험이 바로 읽는다).
import { fetchOnce } from '../../shared/lib/timed-fetch.ts';

export interface EventSummary {
  eventId: string;
  /** 공연명 */
  title: string;
  /** 회차 시작(ISO) */
  startsAt: string;
  /** 판매자 상호(초대한 파트너·기기의 배정 파트너) */
  sellerName: string;
}

export type EventSummaryAnswer = { kind: 'ok'; summary: EventSummary } | { kind: 'unreadable' };

export interface EventSummaryReader {
  read(eventId: string): Promise<EventSummaryAnswer>;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const UNREADABLE: EventSummaryAnswer = { kind: 'unreadable' };

const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

/** 200 본문 → 요약. 세 칸 가운데 하나라도 없거나 시각이 틀리면 null */
export function eventSummaryOf(eventId: string, body: unknown): EventSummary | null {
  const b = body as { title?: unknown; startsAt?: unknown; sellerName?: unknown } | null;
  if (!b || typeof b !== 'object' || !nonEmpty(b.title) || !nonEmpty(b.sellerName) || typeof b.startsAt !== 'string' || Number.isNaN(Date.parse(b.startsAt))) return null;
  return { eventId, title: b.title, startsAt: b.startsAt, sellerName: b.sellerName };
}

/** origin: API 출처(gw-fan). 성공한 요약만 기억한다(못 읽음은 [다시 불러오기]가 다시 묻게 기억하지 않는다) */
export function createEventSummaryReader(o: { origin: string; fetch: FetchLike }): EventSummaryReader {
  const memo = new Map<string, EventSummary>();
  const inflight = new Map<string, Promise<EventSummaryAnswer>>();

  async function ask(eventId: string): Promise<EventSummaryAnswer> {
    try {
      return await fetchOnce(
        o.fetch,
        `${o.origin}/v1/events/${encodeURIComponent(eventId)}`,
        // 공개 자원이라 쿠키를 싣지 않는다(쿠키를 캐시 키에 넣지 않는 CDN 응답, openapi getEvent)
        { method: 'GET', credentials: 'omit', headers: { accept: 'application/json' } },
        async (r): Promise<EventSummaryAnswer> => {
          if (r.status !== 200) return UNREADABLE;
          const s = eventSummaryOf(eventId, await r.json());
          if (!s) return UNREADABLE;
          memo.set(eventId, s);
          return { kind: 'ok', summary: s };
        },
      );
    } catch {
      // 연결 실패·시간 초과·본문이 JSON이 아님
      return UNREADABLE;
    }
  }

  return {
    async read(eventId) {
      if (typeof eventId !== 'string' || eventId === '') return UNREADABLE;
      const hit = memo.get(eventId);
      if (hit) return { kind: 'ok', summary: hit };
      const pending = inflight.get(eventId);
      if (pending) return pending;
      const p = ask(eventId).finally(() => inflight.delete(eventId));
      inflight.set(eventId, p);
      return p;
    },
  };
}

/** 여러 회차를 한꺼번에 읽는다(같은 회차는 한 번). 회차 ID → 답 */
export async function readEventSummaries(reader: EventSummaryReader, eventIds: readonly string[]): Promise<Map<string, EventSummaryAnswer>> {
  const ids = [...new Set(eventIds)];
  const answers = await Promise.all(ids.map((id) => reader.read(id)));
  return new Map(ids.map((id, i) => [id, answers[i]!]));
}
