// 결제 시도·결제창 흐름(SCR-011, docs/frontend.md §5.3, BUILD_ORDER HOT-358). 화면(React)과 떼어 가짜 API·결제창으로 시험한다.
import { attemptKeyStorageKey, attemptOf, attemptOutcome, attemptStorageKey, nextAttemptKey, readAttemptKey, type AttemptKeyRecord, type AttemptOutcome, type PayMethod, type PaymentAttempt } from './payment-attempt';
import type { PaymentWindow } from '../windows';

export type AttemptProblem = { status?: number; type?: string; extensions?: Record<string, unknown>; retryAfterSeconds?: number } | { keyLost: 'ended' | 'storage' };

export interface AttemptApi {
  /** 결제 시도 시작(서명·멱등 키). 실패는 그대로 던진다 */
  start(body: { payMethod?: PayMethod }, key: string): Promise<{ data: unknown; date: string | null }>;
  refresh(): Promise<'ok' | 'rejected' | 'unavailable'>;
  loadWindow(a: PaymentAttempt): Promise<PaymentWindow>;
  /** 던진 값 → 응답 모양 */
  problem(e: unknown): AttemptProblem;
  windowFailureOf(e: unknown): 'method-not-allowed' | 'cancelled' | 'failed' | 'not-opened';
}

export interface AttemptHooks {
  ended(): void;
  accepted(): void;
  gone(): void;
  /** 서버가 준 남은 시간(ms, 모르면 undefined). frozen이면 시간이 흐르지 않는다(H3) */
  deadline(remainingMs: number | undefined, frozen: boolean): void;
  sdkLoadFailed?(pg: string): void;
}

export interface AttemptView {
  attempt: PaymentAttempt | null;
  status: 'idle' | 'starting' | 'paused' | 'exceeded' | 'unavailable';
  /** 결제창을 띄울 준비가 됐다(위젯 그리기까지 끝남). 그 전에는 결제 버튼을 켜지 않는다 */
  windowReady: boolean;
  /** 결제창 코드·위젯을 싣지 못했다(다시 시도할 수 있다) */
  windowFailed: boolean;
  /** 이 시도의 결제창을 열었다 */
  windowOpened: boolean;
  /** 위젯 자리를 새로 그릴 때 올린다 */
  mountTry: number;
  busy: boolean;
  method: PayMethod | null;
  notice: { text: string; tone: 'danger' | 'warning' } | null;
}

export interface AttemptFlowDeps {
  orderId: string;
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  api: AttemptApi;
  hooks: AttemptHooks;
  container: { methods: string; agreement: string };
  makeKey(): string;
  /** 화면이 위젯 자리를 그린 뒤로 미룬다(시험은 없다) */
  afterRender?(): Promise<void>;
  now?(): number;
  random?(): number;
  setTimer?(f: () => void, ms: number): unknown;
  clearTimer?(t: unknown): void;
}

/** 결제 일시 정지 뒤 다시 시도하기까지 [가정](Retry-After가 없을 때) */
const ATTEMPT_RETRY_MS = 5_000;
const METHOD_REFUSED = '이 공연에서는 고를 수 없는 결제수단입니다. 다른 수단을 골라 주세요';

export function createAttemptFlow(d: AttemptFlowDeps) {
  let view: AttemptView = { attempt: null, status: 'idle', windowReady: false, windowFailed: false, windowOpened: false, mountTry: 0, busy: false, method: null, notice: null };
  const listeners = new Set<() => void>();
  const set = (patch: Partial<AttemptView>) => {
    view = { ...view, ...patch };
    listeners.forEach((f) => f());
  };
  const setTimer = d.setTimer ?? ((f, ms) => setTimeout(f, ms));
  const clearTimer = d.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  const random = d.random ?? Math.random;
  const keyName = attemptKeyStorageKey(d.orderId);
  let memoryKey: AttemptKeyRecord | null = null;
  const readKey = (): AttemptKeyRecord | null => {
    try {
      return readAttemptKey(d.storage.getItem(keyName)) ?? memoryKey;
    } catch {
      return memoryKey;
    }
  };
  const writeKey = (r: AttemptKeyRecord | null): void => {
    memoryKey = r;
    try {
      if (r) d.storage.setItem(keyName, JSON.stringify(r));
      else d.storage.removeItem(keyName);
    } catch {
      /* 저장소를 못 쓰면 이 화면이 사는 동안만 같은 키를 쓴다 */
    }
  };
  let win: PaymentWindow | null = null;
  let retry: unknown;
  let generation = 0;
  /** 지금 시도의 결제수단. 빈 글이면 서버 기본(허용 목록 첫 값)이다 */
  let attemptMethod = '';

  const effectiveMethod = (a: PaymentAttempt): string => attemptMethod || a.allowedPayMethods?.[0] || '';

  const apply = (out: AttemptOutcome, restart: () => void): void => {
    switch (out.kind) {
      case 'ended':
      case 'refresh':
        return d.hooks.ended();
      case 'hold-gone':
      case 'order-expired':
        set({ status: 'idle', windowOpened: false, notice: { text: '주문 시간이 끝났습니다. 요금은 청구되지 않았습니다', tone: 'warning' } });
        return d.hooks.gone();
      case 'already-accepted':
        return d.hooks.accepted();
      case 'exceeded':
        return set({ status: 'exceeded', windowReady: false });
      case 'sale-paused':
        return set({ status: 'unavailable', notice: { text: '판매가 잠시 멈췄습니다. 고른 좌석은 홀드 시간 동안 유지됩니다', tone: 'danger' } });
      case 'bad-method':
        return set({ status: 'idle', notice: { text: METHOD_REFUSED, tone: 'warning' } });
      case 'pay-paused':
        d.hooks.deadline(out.holdRemainingSeconds === undefined ? undefined : out.holdRemainingSeconds * 1000, true);
        set({ status: 'paused', notice: { text: out.holdRemainingSeconds !== undefined ? `결제가 잠시 멈췄습니다. 홀드 남은 시간은 ${Math.ceil(out.holdRemainingSeconds / 60)}분이고 멈춘 동안 줄지 않습니다` : '결제가 잠시 멈췄습니다', tone: 'warning' } });
        // 서버가 준 시각은 하한이고 위로만 0~20% 퍼뜨린다(docs/frontend.md §4.1 '기다림')
        retry = setTimer(restart, Math.round(Math.max(ATTEMPT_RETRY_MS, (out.retryAfterSeconds ?? 0) * 1000) * (1 + random() * 0.2)));
        return;
      default:
        return set({ status: 'unavailable', notice: { text: '결제를 준비하지 못했습니다. 다시 시도해 주세요', tone: 'danger' } });
    }
  };

  /** 결제창 코드를 받고 위젯을 그린다. 시도는 새로 만들지 않는다 */
  async function prepareWindow(a: PaymentAttempt, mine: number): Promise<boolean> {
    try {
      win ??= await d.api.loadWindow(a);
      if (mine !== generation) return false;
      await d.afterRender?.();
      if (mine !== generation) return false;
      await win.mount(d.container);
    } catch {
      if (mine !== generation) return false;
      d.hooks.sdkLoadFailed?.(a.pg);
      set({ windowReady: false, windowFailed: true, notice: { text: '결제 화면을 불러오지 못했습니다. 다시 시도해 주세요. 요금은 청구되지 않았습니다', tone: 'danger' } });
      return false;
    }
    if (mine !== generation) return false;
    set({ windowReady: true, windowFailed: false });
    return true;
  }

  /** 결제 시도를 시작한다. 시도와 결제창이 준비됐으면 참이다 */
  async function start(payMethod?: PayMethod, o: { quiet?: boolean; keepNotice?: boolean } = {}): Promise<boolean> {
    const mine = ++generation;
    if (retry !== undefined) clearTimer(retry);
    if (!o.quiet) set({ status: 'starting', ...(o.keepNotice ? {} : { notice: null }) });
    const before = readKey();
    const method = payMethod ?? ((before?.method as PayMethod | '' | undefined) || undefined);
    // 결제창을 열기 전이면 같은 수단은 같은 키라 행이 늘지 않는다(H1, P-T25)
    const rec = nextAttemptKey(before, method ?? '', d.makeKey);
    writeKey(rec);
    if (method) set({ method });
    const restart = () => void start(payMethod, { quiet: true });
    let refreshed = false;
    for (;;) {
      try {
        const r = await d.api.start(method ? { payMethod: method } : {}, rec.key);
        if (mine !== generation) return false;
        const a = attemptOf(r.data);
        if (!a) {
          apply({ kind: 'unavailable' }, restart);
          return false;
        }
        attemptMethod = method ?? '';
        win = null;
        set({ attempt: a, status: 'idle', windowReady: false, windowFailed: false, windowOpened: false, mountTry: view.mountTry + 1, ...(o.keepNotice ? {} : { notice: null }) });
        d.hooks.deadline(a.holdExpiresAt ? Date.parse(a.holdExpiresAt) - (Date.parse(r.date ?? '') || Date.now()) : undefined, false);
        try {
          d.storage.setItem(attemptStorageKey(d.orderId), a.attemptId);
        } catch {
          /* 없으면 복귀 화면이 attemptId 없이 보내고, 시도가 하나뿐일 때만 접수된다 */
        }
        return await prepareWindow(a, mine);
      } catch (e) {
        if (mine !== generation) return false;
        const p = d.api.problem(e);
        if ('keyLost' in p) {
          apply(p.keyLost === 'ended' ? { kind: 'ended' } : { kind: 'retry' }, restart);
          return false;
        }
        const out = attemptOutcome(p);
        if (out.kind === 'bad-method') writeKey(before);
        if (out.kind !== 'refresh' || refreshed) {
          apply(out, restart);
          return false;
        }
        refreshed = true;
        const r2 = await d.api.refresh();
        if (r2 !== 'ok') {
          apply(r2 === 'rejected' ? { kind: 'ended' } : { kind: 'retry' }, restart);
          return false;
        }
      }
    }
  }

  const markOpened = (opened: boolean): void => {
    const rec = readKey();
    if (rec) writeKey({ ...rec, opened });
    set({ windowOpened: opened });
  };

  async function pay(): Promise<void> {
    if (view.busy || !view.attempt || !win || !view.windowReady) return;
    set({ busy: true, notice: null });
    try {
      const a = view.attempt;
      const selected = view.method ?? (a.allowedPayMethods?.[0] as PayMethod | undefined) ?? null;
      // 포트원은 수단마다 채널이 달라, 지금 시도의 수단과 다르면 그 수단으로 시도를 다시 시작한다(M2)
      if (a.pg === 'PORTONE' && selected && selected !== effectiveMethod(a) && !(await start(selected))) return;
      const w = win as PaymentWindow | null;
      if (!w) return;
      // 페이지가 넘어가면 돌아오지 않으므로 열기 전에 적는다(열지 못했으면 아래에서 되돌린다)
      markOpened(true);
      await w.pay(a.pg === 'PORTONE' && selected ? { payMethod: selected } : {});
    } catch (e) {
      const reason = d.api.windowFailureOf(e);
      if (reason === 'method-not-allowed' || reason === 'not-opened') {
        markOpened(false);
        set({ notice: reason === 'method-not-allowed' ? { text: METHOD_REFUSED, tone: 'warning' } : { text: '결제창을 열지 못했습니다. 다시 시도해 주세요', tone: 'danger' } });
        return;
      }
      // 취소·실패도 시도 하나를 썼다. 새 시도로 다시 할 수 있게 바로 준비한다(payment §4 7행, d5 '결제창 실패 3회 넘음')
      set({ notice: reason === 'cancelled' ? { text: '결제를 취소했습니다. 요금은 청구되지 않았습니다', tone: 'warning' } : { text: '결제창에서 결제하지 못했습니다. 요금은 청구되지 않았습니다', tone: 'danger' } });
      await start(undefined, { keepNotice: true });
    } finally {
      set({ busy: false });
    }
  }

  return {
    view: () => view,
    subscribe(f: () => void) {
      listeners.add(f);
      return () => void listeners.delete(f);
    },
    start,
    pay,
    selectMethod: (m: PayMethod) => set({ method: m, notice: null }),
    /** 결제창 코드·위젯 다시 싣기(시도를 새로 만들지 않는다, M6) */
    async retryWindow(): Promise<void> {
      if (!view.attempt) return;
      const mine = ++generation;
      win = null;
      set({ windowFailed: false, notice: null, mountTry: view.mountTry + 1 });
      await prepareWindow(view.attempt, mine);
    },
    /** bfcache로 돌아왔다: 멈춘 busy를 풀고, 결제창을 열었으면 새 시도를 준비한다 */
    async pageShown(persisted: boolean): Promise<void> {
      if (!persisted) return;
      set({ busy: false });
      await start(undefined, { keepNotice: true });
    },
    dispose() {
      generation += 1;
      if (retry !== undefined) clearTimer(retry);
    },
  };
}

export type AttemptFlow = ReturnType<typeof createAttemptFlow>;
