// 월렛 목록 받기와 저장 맞추기(FIX-wallet-tickets, docs/frontend.md §4.2.4 '월렛 목록 세부' 받기·표시 값·저장, openapi listTickets·getEvent, O-T52 ①③④⑤⑦⑧⑩).
// - 팬 API 주소(ORIGINS.api)가 있으면 `GET /v1/tickets?limit=100`을 쿠키와 함께 부르고 `nextCursor`를 그대로 실어 null까지 받는다(ADR-0081).
//   앞에서 받은 커서가 다시 오면 더 부르지 않고 실패(cursor-loop)다. 401이면 창끼리 하나씩(Web Locks `peaket.refresh`) 토큰을 한 번 갱신하고 다시 보낸다(§4.1 '401').
// - api-client를 거치지 않는 손 호출이다(§4.1 'api-client 밖의 호출'): 요청마다 읽기 시간 한도 10초를 본문을 다 읽을 때까지 둔다(shared/lib/timed-fetch).
// - 목록을 다 받은 뒤에만 저장소를 맞추고 마지막 동기화 시각을 쓴다. 받지 못한 동기화(모양이 틀린 응답·`items` 없는 200 포함)는 저장소를 바꾸지 않는다
//   (현장 오프라인에서 QR이 사라지지 않게). 저장소에는 목록의 계약 칸 가운데 화면이 쓰는 값만 두고, 계약 밖 값은 버린다.
// - 표시 값은 회차 공개 요약(entities/event-summary, 쿠키 없음)으로 채운다. 한 번 받기에서 같은 회차는 한 번만 묻고, 실패한 회차도 표는 남는다.
// - QR 재료·쿠키·응답 본문을 console·텔레메트리에 내지 않는다. 경로 별칭 없이 상대 경로로 가져온다(node 시험이 바로 읽는다).
import '../../shared/lib/zod-jitless.ts';
import { ListTicketsResponse } from '@peaket/contracts/openapi/tickets';
import { createEventSummaryReader, readEventSummaries, type EventSummaryAnswer } from '../../entities/event-summary/index.ts';
import { listTicketSnapshots, replaceTicketSnapshots, saveLastSyncedAt, walletDatabase, type WalletTicketSnapshot } from '../../entities/wallet/index.ts';
import { ORIGINS } from '../../shared/config/origins.ts';
import { refreshLock } from '../../shared/lib/refresh-lock.ts';
import { fetchOnce } from '../../shared/lib/timed-fetch.ts';
import { loginHrefAfterRefresh, refreshOnce } from '../../shared/lib/token-refresh.ts';
import { walletCardOf, type WalletCard, type WalletSyncFailure, type WalletSyncResult } from './model.ts';

export type { WalletSyncResult } from './model.ts';
/** 갱신 뒤에도 401일 때 갈 로그인 주소(화면이 이 조각을 늦게 받으므로 첫 화면 묶음에 토큰 갱신 코드를 넣지 않으려고 여기서 낸다) */
export { loginHrefAfterRefresh };

/** 한 쪽에 받을 수(계약 최대, docs/frontend.md §4.2.4 '받기') */
const PAGE_LIMIT = 100;

type ListTicketsBody = ReturnType<typeof ListTicketsResponse.parse>;
/** 화면이 쓸 수 있는 목록 항목(티켓·회차 ID와 상태가 있다) */
type ListedTicket = NonNullable<ListTicketsBody['items']>[number] & { ticketId: string; eventId: string; status: NonNullable<WalletTicketSnapshot['status']> };

/** 한 쪽 요청의 결과 */
type PageAnswer = { kind: 'page'; items: ListedTicket[]; nextCursor: string | null } | { kind: 'unauthorized' } | { kind: 'failed'; reason: WalletSyncFailure };

/** 받기를 멈추는 결과(실패·로그인 필요). 저장소를 바꾸지 않고 그대로 돌려준다 */
class SyncStop extends Error {
  readonly result: WalletSyncResult;
  constructor(result: WalletSyncResult) {
    super(result.kind);
    this.result = result;
  }
}

/** 저장소를 쓸 수 없는 브라우저(사생활 보호 모드)에서 이번 문서가 받은 표. 다음 방문에는 없다 */
let memorySnapshots: WalletTicketSnapshot[] | null = null;

const call = (input: string, init?: RequestInit): Promise<Response> => globalThis.fetch(input, init);

/** 200 본문 → 한 쪽. `items` 칸이 없거나 표에 티켓·회차 ID·상태가 없으면 모양이 틀린 응답이다(빈 목록으로 읽지 않는다, TR-01) */
function pageOf(body: unknown): PageAnswer {
  const parsed = ListTicketsResponse.safeParse(body);
  if (!parsed.success || !Array.isArray(parsed.data.items)) return { kind: 'failed', reason: 'bad-response' };
  const items: ListedTicket[] = [];
  for (const t of parsed.data.items) {
    if (typeof t.ticketId !== 'string' || t.ticketId === '' || typeof t.eventId !== 'string' || t.eventId === '' || t.status === undefined) return { kind: 'failed', reason: 'bad-response' };
    items.push(t as ListedTicket);
  }
  const next = parsed.data.nextCursor;
  if (next === '') return { kind: 'failed', reason: 'bad-response' };
  return { kind: 'page', items, nextCursor: next ?? null };
}

async function requestPage(origin: string, cursor: string | null): Promise<PageAnswer> {
  const url = `${origin}/v1/tickets?limit=${PAGE_LIMIT}${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`;
  try {
    return await fetchOnce(call, url, { method: 'GET', credentials: 'include', cache: 'no-store', redirect: 'error', headers: { accept: 'application/json' } }, async (r): Promise<PageAnswer> => {
      if (r.status === 401) return { kind: 'unauthorized' };
      if (r.status !== 200) return { kind: 'failed', reason: 'server' };
      let body: unknown;
      try {
        body = await r.json();
      } catch {
        return { kind: 'failed', reason: 'bad-response' };
      }
      return pageOf(body);
    });
  } catch {
    // 연결 실패(TypeError)·시간 초과(TimeoutError)·이동 응답(redirect: 'error')
    return { kind: 'failed', reason: 'network' };
  }
}

/** 목록을 끝까지 받는다. 받지 못하면 SyncStop을 던진다(저장소는 건드리지 않는다) */
async function fetchAllTickets(origin: string): Promise<ListedTicket[]> {
  const out: ListedTicket[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  let refreshed = false;
  for (;;) {
    let answer = await requestPage(origin, cursor);
    if (answer.kind === 'unauthorized') {
      if (refreshed) throw new SyncStop({ kind: 'needs-login' });
      refreshed = true;
      const r = await refreshLock(() => refreshOnce(call, `${origin}/v1/identity/access-tokens`));
      if (r === 'rejected') throw new SyncStop({ kind: 'needs-login' });
      // 갱신이 일시 장애(끊김·5xx)면 세션이 끝난 것으로 보지 않는다(§4.1 '401')
      if (r !== 'ok') throw new SyncStop({ kind: 'failed', reason: 'network' });
      answer = await requestPage(origin, cursor);
      if (answer.kind === 'unauthorized') throw new SyncStop({ kind: 'needs-login' });
    }
    if (answer.kind === 'failed') throw new SyncStop(answer);
    out.push(...answer.items);
    if (answer.nextCursor === null) return out;
    if (seen.has(answer.nextCursor)) throw new SyncStop({ kind: 'failed', reason: 'cursor-loop' });
    if (cursor !== null) seen.add(cursor);
    seen.add(answer.nextCursor);
    cursor = answer.nextCursor;
  }
}

/** 목록 항목 + 그 회차 요약 → 저장할 스냅샷(계약 밖 칸은 싣지 않는다) */
function snapshotOf(t: ListedTicket, order: number, answer: EventSummaryAnswer | undefined, nowMs: number): WalletTicketSnapshot {
  const s = answer?.kind === 'ok' ? answer.summary : undefined;
  return {
    ticketId: t.ticketId,
    updatedAt: nowMs,
    order,
    eventId: t.eventId,
    status: t.status,
    transferLocked: t.transferLocked === true,
    ...(typeof t.gateZone === 'string' && t.gateZone !== '' ? { gateZone: t.gateZone } : {}),
    ...(typeof t.eventStartsAt === 'string' ? { eventStartsAt: t.eventStartsAt } : {}),
    // 결제자가 보유한 표만 receivedFromNickname이 null이다(칸이 없거나 닉네임이 있으면 받은 표)
    received: t.receivedFromNickname !== null,
    ...(typeof t.receivedFromNickname === 'string' && t.receivedFromNickname !== '' ? { receivedFromNickname: t.receivedFromNickname } : {}),
    // 진행 중 요청은 ID만 저장한다(기한·상대 값은 저장하지 않는다, ASVS 14.3.3)
    ...(t.receivedFromNickname !== null || t.pendingTransfer === undefined || t.pendingTransfer === null ? {} : { pendingTransfer: { offerId: t.pendingTransfer.offerId } }),
    ...(s
      ? {
          title: s.title,
          startsAt: s.startsAt,
          ...(s.placeName === undefined ? {} : { placeName: s.placeName }),
          ...(s.entryOpensAt === undefined ? {} : { entryOpensAt: s.entryOpensAt }),
          ...(s.endsAt === undefined ? {} : { endsAt: s.endsAt }),
        }
      : {}),
  };
}

/**
 * 월렛 목록을 한 번 받아 저장소를 맞춘다. 부를 때마다 ORIGINS.api를 읽고, 비어 있으면 부르지 않는다(unavailable).
 * 결과가 ok일 때만 저장소·마지막 동기화 시각이 바뀐다
 */
export async function syncWallet(): Promise<WalletSyncResult> {
  const origin = ORIGINS.api;
  if (origin === '') return { kind: 'unavailable' };
  let tickets: ListedTicket[];
  try {
    tickets = await fetchAllTickets(origin);
  } catch (e) {
    if (e instanceof SyncStop) return e.result;
    return { kind: 'failed', reason: 'network' };
  }
  // 쪽 사이에 같은 표가 겹치면 앞의 것만 둔다
  const seenIds = new Set<string>();
  const unique = tickets.filter((t) => !seenIds.has(t.ticketId) && seenIds.add(t.ticketId) !== undefined);
  const reader = createEventSummaryReader({ origin, fetch: call });
  const summaries = await readEventSummaries(
    reader,
    unique.map((t) => t.eventId),
  );
  const now = Date.now();
  const snapshots = unique.map((t, i) => snapshotOf(t, i, summaries.get(t.eventId), now));
  if (walletDatabase()) {
    memorySnapshots = null;
    await replaceTicketSnapshots(snapshots);
    await saveLastSyncedAt(now);
  } else {
    memorySnapshots = snapshots;
  }
  return { kind: 'ok', count: snapshots.length };
}

/** 저장된 표(서버 목록 차례)를 카드로. 화면은 이 값으로 그린다(오프라인 우선) */
export async function loadWalletCards(nowMs: number): Promise<WalletCard[]> {
  const snapshots = walletDatabase() ? await listTicketSnapshots() : (memorySnapshots ?? []);
  return snapshots.map((s) => walletCardOf(s, nowMs));
}
