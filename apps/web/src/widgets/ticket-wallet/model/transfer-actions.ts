// SCR-013 마이 티켓의 돌려주기·받은 요청 카드 가운데 **네트워크·저장소를 쓰는 함수**만 둔다.
// 화면이 첫 렌더에 쓰는 순수 규칙은 transfer-rules로 뺐다. WalletLive는 이 파일을 늦게 가져온다(docs/frontend.md §5.8).
// 돌려주기 200이면 이 기기의 그 표 입장 키와 월렛 항목을 함께 지운다(계획 §10 '지우는 연산은 건드린 것 전부').
import type { ReceivedOfferItem, WalletActionResult } from './transfer-rules.ts';
import { eventIdHeaders } from '../../../shared/lib/event-id.ts';

export type { ReceivedOfferItem, ReturnableTicket, WalletActionResult } from './transfer-rules.ts';
export { RETURN_CONFIRM_TEXT, canReturn, reauthProviderFor, receivedOfferCardsOf, receivedSnapshotOf, returnFailureOf, returnReauthTarget } from './transfer-rules.ts';

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
export interface Net {
  readonly origin: string;
  readonly fetch: FetchLike;
}

const problemTypeOf = async (r: Response): Promise<string> => {
  try {
    const b = (await r.json()) as { type?: unknown } | null;
    if (b && typeof b.type === 'string') return b.type.split('/').filter(Boolean).pop() ?? 'about:blank';
  } catch {
    // 본문이 JSON이 아니다
  }
  return `http-${r.status}`;
};

export interface ReturnBody {
  readonly ticketId: string;
  readonly status: 'RETURNED';
}

/**
 * 결제자에게 돌려주기. 200이면 이 기기의 그 표 입장 키와 월렛 항목을 지운다.
 * 실패(403·409·422·5xx·끊김)에는 아무것도 지우지 않는다.
 */
export async function returnTicket(i: { readonly ticketId: string; readonly eventId: string; readonly reauthToken: string; readonly idempotencyKey: string } & Net): Promise<WalletActionResult<ReturnBody>> {
  let r: Response;
  try {
    r = await i.fetch(`${i.origin}/v1/tickets/${encodeURIComponent(i.ticketId)}/returns`, {
      method: 'POST',
      credentials: 'include',
      cache: 'no-store',
      redirect: 'error',
      headers: { accept: 'application/json', 'idempotency-key': i.idempotencyKey, 'x-reauth-token': i.reauthToken, ...eventIdHeaders(i.eventId) },
    });
  } catch {
    return { kind: 'network' };
  }
  if (r.status !== 200) return { kind: 'problem', status: r.status, type: await problemTypeOf(r) };
  let body: ReturnBody;
  try {
    body = (await r.json()) as ReturnBody;
  } catch {
    return { kind: 'problem', status: r.status, type: 'bad-response' };
  }
  // 돌려준 뒤에만 필요하다. Dexie(entities/wallet)를 첫 화면 JS에 싣지 않도록 여기서 늦게 가져온다
  const { deleteDeviceKey, deleteTicketSnapshot } = await import('../../../entities/wallet/index.ts');
  await deleteDeviceKey(i.ticketId);
  await deleteTicketSnapshot(i.ticketId);
  return { kind: 'ok', body };
}

export async function loadReceivedOffers(i: Net): Promise<WalletActionResult<{ items: ReceivedOfferItem[]; nextCursor?: string | null }>> {
  let r: Response;
  try {
    r = await i.fetch(`${i.origin}/v1/transfers?status=OFFERED`, {
      method: 'GET',
      credentials: 'include',
      cache: 'no-store',
      redirect: 'error',
      headers: { accept: 'application/json' },
    });
  } catch {
    return { kind: 'network' };
  }
  if (r.status !== 200) return { kind: 'problem', status: r.status, type: await problemTypeOf(r) };
  try {
    return { kind: 'ok', body: (await r.json()) as { items: ReceivedOfferItem[]; nextCursor?: string | null } };
  } catch {
    return { kind: 'problem', status: r.status, type: 'bad-response' };
  }
}
