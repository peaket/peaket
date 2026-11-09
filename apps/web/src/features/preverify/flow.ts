// 공연 상세의 사전 검증 흐름(SCR-002 ⑦, ADR-0211 결정 2·4). 화면 틀(React)과 떼어 시계·타이머·보이기·위젯·호출을 주입받는다.
// - [확인하기](선착순 오픈 전)·[대기열 들어가기](오픈 뒤): 사람 확인 → POST …/pre-verifications → 회차 키에 저장(대기실과 같은 키)
// - 대기열에 이미 서 있으면(대기표·참가 토큰·진행 중 진입) 사람 확인 없이 바로 대기실로 간다
// - 일시 실패(503·429·연결)는 하한 위 지터의 실제 시각에 다시 보낸다. 화면의 남은 초는 표시만 한다
// - 조용한 갱신: 만료 2분 전, 보이는 동안만. 숨겨져 있었으면 다시 보일 때 한다. 일시 실패는 만료 전까지 늘려 가며 다시,
//   사람 조작이 필요하거나(위젯) 거절(4xx)이면 멈춘다. 대기실이 키를 지웠거나(입장) 이미 줄을 섰으면 갱신하지 않는다
import { needsRefresh, readPreverify, usableForEntry, writePreverify, type KV, type Preverify } from './model.ts';

export type Step = 'idle' | 'checking' | 'sending' | 'failed' | 'unavailable' | 'not-open' | 'verify' | 'retry' | 'storage';

export interface FlowState {
  token: Preverify | null;
  step: Step;
  /** 대화상자를 열었는가 */
  open: boolean;
  intent: 'early' | 'enter';
  /** retry: 다시 보낼 시각(now 바탕) */
  retryAt?: number;
}

/** 위젯 결과: 토큰, 사람 확인 실패(null), 위젯을 불러오지 못함('unavailable'), 조용한 갱신에서 조작이 필요함('interactive') */
export type HumanResult = string | null | 'unavailable' | 'interactive';

export interface FlowDeps {
  eventId: string;
  kv: KV | null;
  now(): number;
  random(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(id: unknown): void;
  visible(): boolean;
  onVisible(cb: () => void): () => void;
  humanCheck(silent: boolean, signal: AbortSignal): Promise<HumanResult>;
  /** 201 본문을 돌려준다. 실패면 ApiError 꼴(status·type·retryAfter·date)을 던진다 */
  post(body: Record<string, unknown>, signal: AbortSignal): Promise<unknown>;
  body(): Record<string, unknown>;
  navigate(url: string): void;
  /** 개인 상태를 다시 읽는다(본인확인 전 403) */
  refreshPersonal(): void;
  queueHref: string;
  loginHref: string;
  onChange(s: FlowState): void;
}

/**
 * Retry-After 하한(밀리초). 0 이상의 정수 초나 HTTP 날짜만 읽고, 날짜는 같은 응답의 Date(서버 시계)와 견준다(§5.9, api-client retry.ts의 parseRetryAfter와 같은 규칙).
 * 노드 시험이 api-client 입구를 바로 가져오지 못해 여기 같은 규칙을 둔다
 */
export function retryAfterMs(header: string | null, nowMs: number, serverDate: string | null): number | undefined {
  if (header === null) return undefined;
  const v = header.trim();
  if (/^\d+$/.test(v)) return Number(v) * 1000;
  if (!/[A-Za-z]{3}/.test(v) || !/\d{1,2}:\d{2}:\d{2}/.test(v)) return undefined;
  const at = Date.parse(v);
  if (Number.isNaN(at)) return undefined;
  const server = serverDate ? Date.parse(serverDate) : Number.NaN;
  return Math.max(0, at - (Number.isNaN(server) ? nowMs : server));
}

export type Outcome = { kind: 'verify' } | { kind: 'not-open' } | { kind: 'failed' } | { kind: 'login' } | { kind: 'retry'; delayMs: number };

/** 201 본문(PreverifyResult). 꼴이 틀리면 null. 저장하는 시각 칸은 정수다(대기실 저장소가 정수만 받는다) */
export function preverifyFromResponse(body: unknown, now: number): Preverify | null {
  const r = body as Record<string, unknown> | null;
  if (!r || typeof r.preverifyToken !== 'string' || r.preverifyToken.length === 0 || typeof r.expiresAt !== 'string') return null;
  const expiresAt = Date.parse(r.expiresAt);
  if (Number.isNaN(expiresAt)) return null;
  return { token: r.preverifyToken, issuedAt: Math.round(now), expiresAt };
}

/**
 * 사전 검증 오류 → 화면 동작(ADR-0211 결정 4). 하한(Retry-After: 정수 초나 HTTP 날짜)이 있으면 하한 × (1 + U(0, 0.2)),
 * 없으면 전체 지터 0 ~ min(2초 × 2^(실패 수 − 1), 8초)
 */
export function outcomeOfError(e: unknown, random: () => number, failures = 1, now = Date.now()): Outcome {
  const err = e as { status?: unknown; type?: unknown; retryAfter?: unknown; date?: unknown } | null;
  const status = typeof err?.status === 'number' ? err.status : null;
  const type = typeof err?.type === 'string' ? err.type : '';
  if (status === 401) return { kind: 'login' };
  if (status === 403 && type === 'identity-verification-required') return { kind: 'verify' };
  if (status === 404) return { kind: 'not-open' };
  if (status !== null && status >= 400 && status < 500 && status !== 429) return { kind: 'failed' };
  const floor = retryAfterMs(typeof err?.retryAfter === 'string' ? err.retryAfter : null, now, typeof err?.date === 'string' ? err.date : null);
  if (floor !== undefined) return { kind: 'retry', delayMs: Math.round(floor * (1 + random() * 0.2)) };
  return { kind: 'retry', delayMs: Math.round(random() * Math.min(2000 * 2 ** Math.max(0, failures - 1), 8000)) };
}

/** 저장소에 대기 진행(대기표·참가 토큰·진행 중 진입)이 있는가: 있으면 사람 확인 없이 대기실로 간다 */
export function hasQueueProgress(kv: KV | null, eventId: string): boolean {
  try {
    const r = JSON.parse(kv?.getItem(`peaket.queue.${eventId}`) ?? 'null') as Record<string, unknown> | null;
    return !!r && typeof r === 'object' && (typeof r.ticket === 'object' || typeof r.lobby === 'object' || typeof r.entry === 'object') && (r.ticket ?? r.lobby ?? r.entry) !== null;
  } catch {
    return false;
  }
}

export function createPreverifyFlow(d: FlowDeps) {
  const s: FlowState = { token: readPreverify(d.kv, d.eventId, d.now()), step: 'idle', open: false, intent: 'early' };
  let run: AbortController | null = null;
  let retryTimer: unknown = null;
  let refreshTimer: unknown = null;
  let expireTimer: unknown = null;
  let failures = 0;
  let silentFailures = 0;
  let disposed = false;
  const emit = () => d.onChange({ ...s });
  const set = (patch: Partial<FlowState>) => {
    Object.assign(s, patch);
    if (patch.step !== undefined && patch.step !== 'retry') delete s.retryAt;
    emit();
  };
  const clear = (t: unknown) => {
    if (t !== null) d.clearTimer(t);
  };

  async function attempt(silent: boolean): Promise<void> {
    run?.abort();
    clear(retryTimer);
    retryTimer = null;
    const ac = new AbortController();
    run = ac;
    if (!silent) set({ step: 'checking' });
    const human = await d.humanCheck(silent, ac.signal);
    if (ac.signal.aborted || disposed) return;
    if (human === null || human === 'interactive' || human === 'unavailable') {
      if (silent) {
        // 조작이 필요하면 멈추고(만료 뒤 카드가 다시 '사람 확인'), 위젯을 불러오지 못했으면 늘려 가며 다시 한다
        if (human === 'unavailable') scheduleSilentRetry(outcomeOfError(null, d.random, ++silentFailures, d.now()));
        return;
      }
      return set({ step: human === 'unavailable' ? 'unavailable' : 'failed' });
    }
    if (!silent) set({ step: 'sending' });
    const current = readPreverify(d.kv, d.eventId, d.now());
    try {
      const body = { ...d.body(), humanCheckToken: human, ...(current ? { preverifyToken: current.token } : {}) };
      const res = await d.post(body, ac.signal);
      if (ac.signal.aborted || disposed) return;
      const p = preverifyFromResponse(res, d.now());
      if (!p) throw new Error('사전 검증 응답의 꼴이 틀리다');
      failures = 0;
      silentFailures = 0;
      // 저장하지 못하면 대기실이 토큰을 못 읽어 다시 돌려보낸다: 그때는 안내하고 떠나지 않는다
      if (!writePreverify(d.kv, d.eventId, p, d.now())) {
        if (!silent) set({ step: 'storage' });
        return;
      }
      set({ token: p, step: 'idle', open: silent ? s.open : false });
      schedule();
      if (!silent && s.intent === 'enter') d.navigate(d.queueHref);
    } catch (e) {
      if (ac.signal.aborted || disposed) return;
      if (silent) {
        const o = outcomeOfError(e, d.random, ++silentFailures, d.now());
        if (o.kind === 'retry') scheduleSilentRetry(o);
        return;
      }
      const o = outcomeOfError(e, d.random, ++failures, d.now());
      if (o.kind === 'login') return d.navigate(d.loginHref);
      if (o.kind === 'verify') d.refreshPersonal();
      if (o.kind === 'retry') {
        set({ step: 'retry', retryAt: d.now() + o.delayMs });
        retryTimer = d.setTimer(() => {
          retryTimer = null;
          if (s.open) void attempt(false);
        }, o.delayMs);
        return;
      }
      set({ step: o.kind });
    }
  }

  function scheduleSilentRetry(o: Outcome) {
    if (o.kind !== 'retry' || !s.token || d.now() + o.delayMs >= s.token.expiresAt) return;
    clear(refreshTimer);
    refreshTimer = d.setTimer(() => {
      refreshTimer = null;
      refreshIfDue();
    }, o.delayMs);
  }

  /** 갱신할 때이고, 보이고, 대기실이 키를 지우지 않았고, 아직 줄을 서지 않았으면 조용히 갱신한다 */
  function refreshIfDue() {
    if (disposed || !s.token || s.open) return;
    const stored = readPreverify(d.kv, d.eventId, d.now());
    if (!stored || hasQueueProgress(d.kv, d.eventId)) return;
    if (!needsRefresh(stored, d.now())) return schedule();
    if (!d.visible()) return; // 다시 보일 때(onVisible) 한다
    void attempt(true);
  }

  function schedule() {
    clear(refreshTimer);
    clear(expireTimer);
    refreshTimer = expireTimer = null;
    if (!s.token) return;
    const now = d.now();
    refreshTimer = d.setTimer(() => {
      refreshTimer = null;
      refreshIfDue();
    }, Math.max(0, s.token.expiresAt - 120_000 - now));
    expireTimer = d.setTimer(() => {
      expireTimer = null;
      set({ token: readPreverify(d.kv, d.eventId, d.now()) });
    }, Math.max(0, s.token.expiresAt - now + 50));
  }

  const stopVisible = d.onVisible(() => refreshIfDue());
  schedule();
  emit();

  return {
    state: (): FlowState => ({ ...s }),
    /** 선착순 오픈 전 카드의 [확인하기] */
    check() {
      failures = 0;
      set({ intent: 'early', open: true });
      void attempt(false);
    },
    /** 오픈 뒤 [대기열 들어가기] */
    enter() {
      if (hasQueueProgress(d.kv, d.eventId) || usableForEntry(readPreverify(d.kv, d.eventId, d.now()), d.now())) return d.navigate(d.queueHref);
      failures = 0;
      set({ intent: 'enter', open: true });
      void attempt(false);
    },
    /** 실패 안내의 [다시 시도] */
    retry() {
      void attempt(false);
    },
    close() {
      run?.abort();
      clear(retryTimer);
      retryTimer = null;
      set({ open: false, step: 'idle' });
    },
    dispose() {
      disposed = true;
      run?.abort();
      clear(retryTimer);
      clear(refreshTimer);
      clear(expireTimer);
      stopVisible();
    },
  };
}
