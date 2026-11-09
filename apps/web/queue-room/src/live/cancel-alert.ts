// SCR-018 [취소표 알림 받기](ADR-0213 결정 5, d5 §5.18). 팬 API의 알림 신청(identity 태그 경로)을 작은 fetch 층으로 부른다.
// - 처음 그릴 때 GET /v1/subscriptions?eventIds=로 이미 신청했는지 본다. 실패·비로그인은 '신청할 수 있음'(버튼을 그대로 둔다)
// - 누르면 POST …/subscriptions {kind: CANCELLATION, nightPush}를 한 번 보낸다(nightPush는 이미 있던 신청의 값, 없으면 false)(자동으로 다시 보내지 않는다, docs/frontend.md §4.1).
//   401은 토큰을 한 번 갱신하고 다시 보낸다(§4.1 '401'). 밤 웹 푸시는 묻지 않는다(웹 푸시 구독 경로는 GAT-250 뒤, 이메일은 늘 간다)
import type { Net, Reply } from './net.ts';

export type CancelAlertStatus = 'available' | 'subscribed' | 'closed';
export type CancelAlertResult = 'subscribed' | 'login' | 'closed' | 'limit' | 'failed';

export interface CancelAlertDeps {
  net: Pick<Net, 'getFan' | 'postJson'>;
  api: string;
  eventId: string;
  refresh(): Promise<'ok' | 'rejected' | 'unavailable'>;
}

interface SubscriptionItem {
  eventId?: unknown;
  nightPush?: unknown;
  cancellationStatus?: unknown;
  endReason?: unknown;
}

export function createCancelAlert(d: CancelAlertDeps) {
  const id = encodeURIComponent(d.eventId);
  // 페이지에 하나인 상태: 화면을 다시 그려도(공연 요약이 늦게 옴 등) 알고 있는 상태와 보내는 중인 신청을 이어받는다
  let known: CancelAlertStatus | null = null;
  let inflight: Promise<CancelAlertResult> | null = null;
  /** 이미 있던 신청의 '밤에도 받기'(SCR-054에서 바꾼 값). 다시 신청해도 그 값을 지킨다(이미 있으면 nightPush만 바꾸므로) */
  let nightPush = false;

  /** 401이면 토큰을 한 번 갱신하고 다시 보낸다(docs/frontend.md §4.1 '401'). 갱신 결과도 함께 돌려준다 */
  async function withRefresh(call: () => Promise<Reply>): Promise<{ r: Reply; refresh?: 'ok' | 'rejected' | 'unavailable' }> {
    const r = await call();
    if (r.status !== 401) return { r };
    const t = await d.refresh();
    return t === 'ok' ? { r: await call(), refresh: t } : { r, refresh: t };
  }

  async function status(): Promise<CancelAlertStatus> {
    let r: Reply;
    try {
      ({ r } = await withRefresh(() => d.net.getFan(`${d.api}/v1/subscriptions?eventIds=${id}`)));
    } catch {
      return known ?? 'available';
    }
    if (r.status !== 200) return known ?? 'available';
    const items = (r.body as { items?: unknown } | undefined)?.items;
    const item = Array.isArray(items) ? (items as SubscriptionItem[]).find((i) => i?.eventId === d.eventId) : undefined;
    if (typeof item?.nightPush === 'boolean') nightPush = item.nightPush;
    let s: CancelAlertStatus = 'available';
    if (item?.cancellationStatus === 'ACTIVE') s = 'subscribed';
    // 판매 종료로 끝난 신청은 다시 신청할 수 없다(SubscriptionState.endReason). 다 보냄·예매함으로 끝난 신청은 다시 신청하면 되살아난다
    else if (item?.cancellationStatus === 'ENDED' && item.endReason === 'SALE_ENDED') s = 'closed';
    // 그사이 누른 신청의 결과가 먼저 정해졌으면 그것을 둔다
    if (!inflight && known !== 'subscribed' && known !== 'closed') known = s;
    return known ?? s;
  }

  async function send(): Promise<CancelAlertResult> {
    try {
      const { r, refresh } = await withRefresh(() => d.net.postJson(`${d.api}/v1/events/${id}/subscriptions`, { kind: 'CANCELLATION', nightPush }));
      if (r.status === 401) return refresh === 'unavailable' ? 'failed' : 'login';
      if (r.status === 200 || r.status === 201) return 'subscribed';
      if (r.status === 410) return 'closed';
      if (r.status === 422) return 'limit';
      return 'failed';
    } catch {
      return 'failed';
    }
  }

  return {
    status,
    /** 누르면 한 번 보낸다. 보내는 중에 다시 부르면 같은 결과를 기다린다(두 번 보내지 않는다) */
    subscribe(): Promise<CancelAlertResult> {
      inflight ??= send().then((res) => {
        inflight = null;
        if (res === 'subscribed' || res === 'closed') known = res;
        return res;
      });
      return inflight;
    },
    /** 알고 있는 상태(아직 모르면 null) */
    known: (): CancelAlertStatus | null => known,
    /** 보내는 중인 신청(없으면 null) */
    pending: (): Promise<CancelAlertResult> | null => inflight,
  };
}

export type CancelAlertApi = ReturnType<typeof createCancelAlert>;
