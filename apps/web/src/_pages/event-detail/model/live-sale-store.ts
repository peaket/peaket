// SCR-002 공연 상세의 상태 파일 가게(ADR-0272 결정 1 '읽는 때'·'요청'). 받는 방법·시계·타이머는 밖에서 넣는다(시험은 대역을 넣는다).
// - start: 문서마다 한 번만 받는다(부르는 쪽은 예매 버튼 상태가 오픈 뒤 진입(queue)일 때만 부른다). 주기 조회는 하지 않는다
// - onVisible: 시작했고 마지막으로 받기를 '보낸' 지 30초 [가정] 이상이면(경계 포함) 한 번 더 받는다. 답이 없거나 한도로 끝난 받기도 한 번으로 센다
// - 시간 한도 3초 [가정]가 지나도 답이 없으면 unknown이고, 늦은 답이 오면 그때 바꾼다. 늦게 온 앞선 받기의 답은 버린다(세대 번호)
import { toLiveSale, type LiveSale } from './live-sale.ts';

export const LIVE_SALE_TIMEOUT_MS = 3000;
export const LIVE_SALE_RECHECK_MS = 30_000;

export interface LiveSaleDeps {
  fetchFile: () => Promise<{ status: number; body: unknown }>;
  now: () => number;
  setTimer?: (fn: () => void, ms: number) => void;
}

export function createLiveSaleStore(deps: LiveSaleDeps): { get(): LiveSale; listen(l: () => void): () => void; start(): void; onVisible(): void } {
  let current: LiveSale = { status: 'loading' };
  let started = false;
  let generation = 0;
  let sentAt = 0;
  const listeners = new Set<() => void>();
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => void setTimeout(fn, ms));

  const set = (next: LiveSale) => {
    current = next;
    for (const l of listeners) l();
  };

  function load(): void {
    const mine = ++generation;
    let answered = false;
    sentAt = deps.now();
    setTimer(() => {
      if (mine === generation && !answered) set({ status: 'unknown' });
    }, LIVE_SALE_TIMEOUT_MS);
    let call: Promise<{ status: number; body: unknown }>;
    try {
      call = deps.fetchFile();
    } catch (e) {
      call = Promise.reject(e);
    }
    void call
      .then(
        (r) => toLiveSale(r.status, r.body),
        (): LiveSale => ({ status: 'unknown' }),
      )
      .then((v) => {
        answered = true;
        if (mine === generation) set(v);
      });
  }

  return {
    get: (): LiveSale => current,
    listen(l: () => void): () => void {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    start(): void {
      if (started) return;
      started = true;
      load();
    },
    onVisible(): void {
      if (started && deps.now() - sentAt >= LIVE_SALE_RECHECK_MS) load();
    },
  };
}
