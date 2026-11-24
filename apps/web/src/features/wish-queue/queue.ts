// 찜 오프라인 대기열(docs/frontend.md §3.12 `peaket.wishQueue`, §4.2.4 '오프라인에서 누른 찜', §6 FE-T37).
// 찜 저장·해제는 자기 상태라 멱등 키가 없다(openapi putProductionWish). 그래서 같은 공연의 마지막 동작만 남기고,
// 연결이 돌아오면 그 동작을 한 번씩 다시 보낸다. 서버가 204를 준 동작만 지운다(IR-07).
// 이 파일은 저장소·네트워크를 직접 부르지 않는다(화면이 localStorage·fetch를 넘긴다). node 시험이 바로 읽는다.

export const WISH_QUEUE_KEY = 'peaket.wishQueue';

/** 자동 재전송 상한(계획 §3, 2026-11-24 IR-07). 이 횟수에 닿은 줄은 지우지 않고 자동 전송에서만 건너뛴다 */
export const WISH_QUEUE_MAX_ATTEMPTS = 3;

export type WishAction = 'PUT' | 'DELETE';

export interface WishQueueItem {
  productionId: string;
  action: WishAction;
  /** 누른 시각(ms). 같은 공연의 마지막 동작을 고르는 데만 쓴다 */
  at: number;
  /** 자동 재전송을 시도한 횟수(0~3). 3에 닿으면 자동 전송에서 건너뛰고 '저장 대기'로 남긴다 */
  attempts: number;
}

export interface WishQueueResult {
  sent: number;
  remaining: number;
  needsLogin: boolean;
  /** 204가 아닌 답을 받은 동작의 상태 코드(없으면 undefined) */
  failedStatus?: number;
}

/** 마지막 동작이 이긴 뒤의 시도 횟수(옛 저장값에 없으면 0) */
const attemptsOf = (item: WishQueueItem): number => (item.attempts >= WISH_QUEUE_MAX_ATTEMPTS ? WISH_QUEUE_MAX_ATTEMPTS : item.attempts);

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
    const attempts = typeof item.attempts === 'number' && Number.isInteger(item.attempts) && item.attempts > 0 ? Math.min(item.attempts, WISH_QUEUE_MAX_ATTEMPTS) : 0;
    return [{ productionId: item.productionId, action: item.action, at: item.at, attempts }];
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

/** 찜 토글 한 번을 대기열에 반영한다(서버에 바로 못 보낸 때). 마지막 동작이 이기고 시도 횟수는 0으로 돌아간다 */
export function queueWish(items: readonly WishQueueItem[], productionId: string, action: WishAction, at: number): WishQueueItem[] {
  return enqueueWish(items, { productionId, action, at, attempts: 0 });
}

/**
 * 대기열을 차례로 보낸다. **204만 성공으로 보고 지운다.**
 * - 401: 갱신까지 실패한 로그인 아님이다. 큐를 지우지 않고 멈춘다(다시 로그인하면 이어 보낸다). 시도 횟수는 올리지 않는다.
 * - 4xx(401 제외)·5xx·끊김: 204가 아니므로 지우지 않는다. 시도 횟수를 1 올리고 멈춘다(다음 online·화면 복귀에 다시).
 * - 시도 횟수가 3에 닿은 줄은 보내지 않고 남겨 둔다('저장 대기'). 다시 누르면 `queueWish`가 0으로 돌린다.
 */
export async function flushWishQueue(o: {
  read: () => readonly WishQueueItem[];
  write: (items: readonly WishQueueItem[]) => void;
  send: (item: WishQueueItem) => Promise<number>;
}): Promise<WishQueueResult> {
  let items = [...o.read()];
  let sent = 0;
  const failAndStop = (item: WishQueueItem, status?: number): WishQueueResult => {
    items = items.map((x) => (x.productionId === item.productionId ? { ...x, attempts: Math.min(WISH_QUEUE_MAX_ATTEMPTS, attemptsOf(x) + 1) } : x));
    o.write(items);
    return { sent, remaining: items.length, needsLogin: false, ...(status !== undefined ? { failedStatus: status } : {}) };
  };
  for (const item of items) {
    if (attemptsOf(item) >= WISH_QUEUE_MAX_ATTEMPTS) continue;
    let status: number;
    try {
      status = await o.send(item);
    } catch {
      return failAndStop(item);
    }
    if (status === 204) {
      sent += 1;
      items = items.filter((x) => x.productionId !== item.productionId);
      o.write(items);
      continue;
    }
    if (status === 401) return { sent, remaining: items.length, needsLogin: true };
    // 204가 아닌 모든 답(4xx 포함)은 지우지 않는다. 재시도 횟수를 올리고 이번 차례를 멈춘다
    return failAndStop(item, status);
  }
  return { sent, remaining: items.length, needsLogin: false };
}
