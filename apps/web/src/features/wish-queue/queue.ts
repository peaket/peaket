// 찜 오프라인 대기열(docs/frontend.md §3.12 `peaket.wishQueue`, §4.2.4 '오프라인에서 누른 찜', §6 FE-T37).
// 찜 저장·해제는 자기 상태라 멱등 키가 없다(openapi putProductionWish). 그래서 같은 공연의 마지막 동작만 남기고,
// 연결이 돌아오면 그 동작을 한 번씩 다시 보낸다. 서버가 204를 준 동작만 지운다.
// 이 파일은 저장소·네트워크를 직접 부르지 않는다(화면이 localStorage·fetch를 넘긴다). node 시험이 바로 읽는다.

export const WISH_QUEUE_KEY = 'peaket.wishQueue';

export type WishAction = 'PUT' | 'DELETE';

export interface WishQueueItem {
  productionId: string;
  action: WishAction;
  /** 누른 시각(ms). 같은 공연의 마지막 동작을 고르는 데만 쓴다 */
  at: number;
}

export interface WishQueueResult {
  sent: number;
  remaining: number;
  needsLogin: boolean;
  /** 204가 아닌 답을 받은 동작의 상태 코드(없으면 undefined) */
  failedStatus?: number;
}

/** 저장된 JSON → 대기열. 모양이 틀린 줄은 버린다(옛 판·깨진 값이 화면을 막지 않게) */
export function parseWishQueue(raw: string | null): WishQueueItem[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((x) => {
    if (!x || typeof x !== 'object') return [];
    const item = x as Partial<WishQueueItem>;
    if (typeof item.productionId !== 'string' || item.productionId === '') return [];
    if (item.action !== 'PUT' && item.action !== 'DELETE') return [];
    if (typeof item.at !== 'number' || !Number.isFinite(item.at)) return [];
    return [{ productionId: item.productionId, action: item.action, at: item.at }];
  });
}

/** 대기열 → 저장할 JSON */
export function serializeWishQueue(items: readonly WishQueueItem[]): string {
  return JSON.stringify(items);
}

/** 브라우저 localStorage에서 읽는다(없거나 막혔으면 빈 목록) */
export function readStoredWishQueue(): WishQueueItem[] {
  try {
    return parseWishQueue(globalThis.localStorage?.getItem(WISH_QUEUE_KEY) ?? null);
  } catch {
    return [];
  }
}

/** 브라우저 localStorage에 쓴다(막혔으면 아무 일도 하지 않는다) */
export function writeStoredWishQueue(items: readonly WishQueueItem[]): void {
  try {
    if (items.length === 0) globalThis.localStorage?.removeItem(WISH_QUEUE_KEY);
    else globalThis.localStorage?.setItem(WISH_QUEUE_KEY, serializeWishQueue(items));
  } catch {
    // 저장소가 막힌 브라우저(사생활 보호 모드 등)에서는 화면만 바뀌고 서버 저장은 다음 기회에 다시 시도한다
  }
}

/**
 * 같은 공연의 마지막 동작만 남긴다. 누른 차례는 유지하고, 같은 공연이 다시 들어오면 그 자리에서 빼고 끝에 붙인다.
 * 그래서 찜 → 해제는 DELETE 하나, 해제 → 찜은 PUT 하나가 남는다(중복 저장 0건).
 */
export function enqueueWish(items: readonly WishQueueItem[], item: WishQueueItem): WishQueueItem[] {
  return [...items.filter((x) => x.productionId !== item.productionId), item];
}

/** 찜 토글 한 번을 대기열에 반영한다(서버에 바로 못 보낸 때). 마지막 동작이 이긴다 */
export function queueWish(items: readonly WishQueueItem[], productionId: string, action: WishAction, at: number): WishQueueItem[] {
  return enqueueWish(items, { productionId, action, at });
}

/**
 * 대기열을 차례로 보낸다. 204만 성공으로 보고 지운다.
 * - 401: 갱신까지 실패한 로그인 아님이다. 큐를 지우지 않고 멈춘다(다시 로그인하면 이어 보낸다).
 * - 4xx(401 제외): 그 동작은 다시 보내도 같으므로 지운다(예: 이미 없는 공연 404). 남은 동작은 계속 보낸다.
 * - 5xx·끊김: 그 동작부터 남겨 두고 멈춘다(다음 online·화면 복귀에 다시).
 */
export async function flushWishQueue(o: {
  read: () => readonly WishQueueItem[];
  write: (items: readonly WishQueueItem[]) => void;
  send: (item: WishQueueItem) => Promise<number>;
}): Promise<WishQueueResult> {
  let items = [...o.read()];
  let sent = 0;
  for (const item of items) {
    let status: number;
    try {
      status = await o.send(item);
    } catch {
      return { sent, remaining: items.length, needsLogin: false };
    }
    if (status === 204) {
      sent += 1;
      items = items.filter((x) => x !== item);
      o.write(items);
      continue;
    }
    if (status === 401) return { sent, remaining: items.length, needsLogin: true };
    if (status >= 500) return { sent, remaining: items.length, needsLogin: false, failedStatus: status };
    // 400·404·422 같은 거절은 다시 보내도 같다. 그 동작만 버린다
    sent += 1;
    items = items.filter((x) => x !== item);
    o.write(items);
  }
  return { sent, remaining: 0, needsLogin: false };
}
