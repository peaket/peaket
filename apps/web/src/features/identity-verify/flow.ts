// 본인확인 창 흐름의 브라우저 쪽 규칙(docs/features/identity.md §5 '흐름의 보안 규칙'·'모의 기관과 기관 창 흐름', BUILD_ORDER BOT-010, I-T45).
// 화면(React)과 떼어 둔 흐름이다. 창·BroadcastChannel·시계·탭 저장소·API를 받아서 쓴다(시험은 대역으로 바꾼다).
// - 부르는 화면: 누른 동작 안에서 이름 붙인 빈 창 → 시작 → 그 창(POPUP) 또는 지금 창(막힘·REDIRECT)에 기관 양식 제출
//   → 메시지(받은 표시를 돌려줌)나 창 닫힘 → 결과 조회 값으로만 화면을 정한다(메시지의 status는 쓰지 않는다)
// - 복귀 화면: 기관 값(POST 본문은 서버가 넘김, 쿼리는 읽자마자 주소에서 지움) → 결과 경로 → VERIFIED면 토큰 갱신
//   → 알림 → 받은 표시가 오면 창 닫기, 아니면 건 ID와 남긴 시각을 탭 저장소에 두고 next로(부르는 화면은 1분 안의 값만 믿는다)
// API 호출은 이 파일의 작은 fetch 감싸개가 한다(공용 api-client는 BUILD_ORDER BAS-210).
import { safeNext } from '../../shared/lib/safe-next.ts';
import { refreshOnce, type RefreshResult } from '../../shared/lib/token-refresh.ts';
import type { VerifyOutcome } from './model.ts';

export const VERIFY_CHANNEL = 'peaket.verify';
export const VERIFY_WINDOW_NAME = 'peaket-verify';
/** 기관 창 크기 480×720 [가정] */
export const VERIFY_WINDOW_FEATURES = 'popup,width=480,height=720';
/** 페이지 이동으로 돌아온 건 ID와 남긴 시각(탭 세션 저장소, docs/frontend.md §3.12) */
export const RETURN_STORAGE_KEY = 'peaket.verify.return';
/** 부르는 화면이 복귀 건을 믿는 시간 1분 [가정]. 복귀 화면은 남기자마자 next로 가므로 부르는 화면이 곧 읽는다(BOT-010이 넘긴 것) */
export const RETURN_TTL_MS = 60_000;
/** 복귀 화면이 받은 표시를 기다리는 시간 1초 [가정] */
export const ACK_WAIT_MS = 1_000;
/** 창이 닫힌 뒤 메시지를 더 기다리는 시간 1초 [가정] */
export const CLOSED_GRACE_MS = 1_000;
/** 창이 닫혔는지 보는 간격 */
export const POLL_CLOSED_MS = 500;
/** 받은 표시를 받고 창을 닫았는데도 남아 있으면(닫을 수 없는 창) next로 가는 시간 */
export const CLOSE_FALLBACK_MS = 500;
/** 창이 닫힌 것으로 보인 뒤에도 늦은 메시지를 듣는 시간: 그 건이 결과를 받는 시간 10분 [가정]과 같다 */
export const LATE_MESSAGE_MS = 10 * 60_000;
/** VERIFIED 뒤 토큰 갱신이 일시 장애면 다시 하는 간격 1초 [가정](한 번만 다시 한다, 새 맥락 재검토) */
export const REFRESH_RETRY_MS = 1_000;
export const RETURN_PATH = '/verify/return';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isVerificationId = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);

export const SERVER_STATUSES = ['PENDING', 'VERIFIED', 'CANCELLED', 'FAILED', 'PROVIDER_DOWN', 'DUPLICATE_ACCOUNT', 'UNDER_14', 'BOOTH_MISMATCH'] as const;
export type ServerStatus = (typeof SERVER_STATUSES)[number];
const isStatus = (v: unknown): v is ServerStatus => typeof v === 'string' && (SERVER_STATUSES as readonly string[]).includes(v);

export type Purpose = 'FIRST' | 'REVERIFY';

/** openapi VerificationStart.window */
export interface AgencyWindow {
  url: string;
  method: 'GET' | 'POST';
  fields: Record<string, string>;
  mode: 'POPUP' | 'REDIRECT';
}

/** openapi VerificationResult(화면이 쓰는 칸) */
export interface ResultBody {
  verificationId: string;
  purpose: string;
  status: ServerStatus;
  next: string;
  restrictedUntil?: string | null;
}

/** under14: 만 14세 미만으로 정리 중인 계정이라 시작을 받지 않는다(403 under-14, BUILD_ORDER BOT-020) */
export type StartAnswer = { kind: 'started'; id: string; window: AgencyWindow } | { kind: 'already' } | { kind: 'under14' } | { kind: 'login' } | { kind: 'down' } | { kind: 'error' };
export type ResultAnswer =
  | { kind: 'result'; body: ResultBody }
  | { kind: 'duplicate' }
  | { kind: 'under14' }
  | { kind: 'mismatch' }
  | { kind: 'down' }
  | { kind: 'notFound' }
  | { kind: 'login' }
  | { kind: 'error' };

export interface VerifyApi {
  start(next: string, purpose: Purpose): Promise<StartAnswer>;
  confirm(verificationId: string, fields: Record<string, string>): Promise<ResultAnswer>;
  result(verificationId: string): Promise<ResultAnswer>;
  /** 팬 토큰 갱신(POST /v1/identity/access-tokens). 성공·거절(401)·일시 장애로 나뉜다 */
  refresh(): Promise<RefreshResult>;
}

/** 결과 → 결과 대화상자(d5 §5.6 상태 표). 처리 중(PENDING)이면 창을 닫음·실패로 본다 */
export function outcomeOfStatus(s: ServerStatus): Exclude<VerifyOutcome, 'popup'> {
  switch (s) {
    case 'VERIFIED':
      return 'success';
    case 'PROVIDER_DOWN':
      return 'down';
    case 'DUPLICATE_ACCOUNT':
      return 'other';
    case 'UNDER_14':
      return 'under14';
    case 'BOOTH_MISMATCH':
      return 'mismatch';
    default:
      return 'closed';
  }
}

/**
 * VERIFIED 뒤 토큰 갱신(다음 요청부터 ticket:buy가 실리게). 일시 장애면 1초 [가정] 뒤 한 번 더 한다.
 * 결과: ok 갱신함, rejected 세션이 끝남(로그인), unavailable 두 번 다 일시 장애(identity §5 '부르는 화면', 새 맥락 재검토)
 */
async function refreshAfterVerified(api: VerifyApi, sleep: (ms: number) => Promise<void>, alive: () => boolean = () => true): Promise<RefreshResult> {
  const first = await api.refresh();
  if (first !== 'unavailable') return first;
  await sleep(REFRESH_RETRY_MS);
  // 기다리는 사이 흐름이 멈췄으면([다시 시도]·화면 떠남·메시지 쪽 조회가 먼저 끝남) 두 번째 갱신을 보내지 않는다(새 맥락 마지막 검토)
  if (!alive()) return 'unavailable';
  return api.refresh();
}

/** 완료(success)를 알았는데 토큰을 아직 갱신하지 않았으면 갱신하고 대화상자를 다시 정한다: 401이면 로그인, 일시 장애면 기관 장애(잠시 후 다시) */
async function successAfterRefresh(api: VerifyApi, sleep: (ms: number) => Promise<void>, alive?: () => boolean): Promise<'success' | 'login' | 'down'> {
  const r = await refreshAfterVerified(api, sleep, alive);
  return r === 'ok' ? 'success' : r === 'rejected' ? 'login' : 'down';
}

/** 결과 조회의 답 → 대화상자. 로그인이 필요하면 'login' */
function outcomeOfAnswer(a: ResultAnswer): Exclude<VerifyOutcome, 'popup'> | 'login' {
  switch (a.kind) {
    case 'result':
      return outcomeOfStatus(a.body.status);
    case 'duplicate':
      return 'other';
    case 'under14':
      return 'under14';
    case 'mismatch':
      return 'mismatch';
    case 'login':
      return 'login';
    case 'notFound':
      return 'closed';
    default:
      return 'down';
  }
}

/** 복귀 화면이 알리는 메시지인지(꼴이 정확하고 기다리는 건일 때만, ASVS v5.0.0-3.5.5) */
export function isResultMessage(m: unknown, expectedId: string): boolean {
  if (typeof m !== 'object' || m === null || Array.isArray(m)) return false;
  const o = m as Record<string, unknown>;
  const keys = Object.keys(o).sort();
  return keys.length === 3 && keys[0] === 'status' && keys[1] === 'type' && keys[2] === 'verificationId' && o.type === 'result' && o.verificationId === expectedId && isStatus(o.status);
}

function isAckMessage(m: unknown, expectedId: string): boolean {
  if (typeof m !== 'object' || m === null || Array.isArray(m)) return false;
  const o = m as Record<string, unknown>;
  return Object.keys(o).length === 2 && o.type === 'ack' && o.verificationId === expectedId;
}

// ── API ──

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** 문제 응답의 type 끝 이름(https://peaket.example/problems/<이름>) */
async function problemType(r: Response): Promise<string> {
  try {
    const p = (await r.json()) as { type?: unknown };
    return typeof p.type === 'string' ? (p.type.split('/').pop() ?? '') : '';
  } catch {
    return '';
  }
}

function isResultBody(v: unknown): v is ResultBody {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return isVerificationId(o.verificationId) && typeof o.purpose === 'string' && isStatus(o.status) && typeof o.next === 'string';
}

function isWindow(v: unknown): v is AgencyWindow {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  if (typeof o.url !== 'string' || (o.method !== 'GET' && o.method !== 'POST') || (o.mode !== 'POPUP' && o.mode !== 'REDIRECT')) return false;
  if (typeof o.fields !== 'object' || o.fields === null) return false;
  let u: URL;
  try {
    u = new URL(o.url);
  } catch {
    return false;
  }
  return (u.protocol === 'https:' || u.protocol === 'http:') && Object.values(o.fields).every((x) => typeof x === 'string');
}

/**
 * 팬 API(gw-fan) 호출. 401이면 토큰을 한 번 갱신하고 다시 보낸다(갱신 자체는 다시 보내지 않는다).
 * 갱신은 lock(창끼리 하나씩) 안에서 한다. 같은 리프레시 토큰으로 두 창이 동시에 갱신하면 늦게 받은 쪽 쿠키가 폐기된 토큰이 되어,
 * 다음 갱신이 재사용 탐지에 걸려 세션이 끝날 수 있다(docs/features/identity.md §3, 새 맥락 리뷰 M1)
 */
export function createVerifyApi(o: { origin: string; fetch: FetchLike; lock?: <T>(fn: () => Promise<T>) => Promise<T> }): VerifyApi {
  const lock = o.lock ?? (<T>(fn: () => Promise<T>) => fn());
  const url = (p: string) => `${o.origin}${p}`;
  const send = (path: string, method: 'GET' | 'POST', body?: unknown) =>
    o.fetch(url(path), {
      method,
      credentials: 'include',
      cache: 'no-store',
      headers: body === undefined ? { accept: 'application/json' } : { accept: 'application/json', 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  const refresh = (): Promise<RefreshResult> => lock(() => refreshOnce(o.fetch, url('/v1/identity/access-tokens')));

  /**
   * 보내고 401이면 갱신 뒤 한 번 더. 갱신이 401로 거절되거나 다시 401이면 login, 갱신이 일시 장애(연결 끊김·5xx)면 down이다.
   * 일시 장애를 로그인으로 보면 복귀 화면이 기관 값을 버리고 로그인 화면으로 간다(docs/frontend.md §4.1 '401', 새 맥락 리뷰)
   */
  async function call(path: string, method: 'GET' | 'POST', body?: unknown): Promise<Response | 'login' | 'down'> {
    const first = await send(path, method, body);
    if (first.status !== 401) return first;
    const refreshed = await refresh();
    if (refreshed === 'rejected') return 'login';
    if (refreshed !== 'ok') return 'down';
    const second = await send(path, method, body);
    return second.status === 401 ? 'login' : second;
  }

  async function answer(path: string, method: 'GET' | 'POST', body?: unknown): Promise<ResultAnswer> {
    let r: Response | 'login' | 'down';
    try {
      r = await call(path, method, body);
    } catch {
      return { kind: 'error' };
    }
    if (r === 'login' || r === 'down') return { kind: r };
    if (r.status === 200) {
      try {
        const b = (await r.json()) as unknown;
        return isResultBody(b) ? { kind: 'result', body: b } : { kind: 'error' };
      } catch {
        return { kind: 'error' };
      }
    }
    const type = await problemType(r);
    if (r.status === 409 && type === 'duplicate-account') return { kind: 'duplicate' };
    if (r.status === 409 && type === 'booth-mismatch') return { kind: 'mismatch' };
    if (r.status === 403 && type === 'under-14') return { kind: 'under14' };
    if (r.status === 404) return { kind: 'notFound' };
    if (r.status === 503) return { kind: 'down' };
    return { kind: 'error' };
  }

  const resultPath = (id: string) => `/v1/identity/verifications/${encodeURIComponent(id)}/result`;

  return {
    async start(next, purpose) {
      let r: Response | 'login' | 'down';
      try {
        r = await call('/v1/identity/verifications', 'POST', { purpose, next });
      } catch {
        return { kind: 'error' };
      }
      if (r === 'login' || r === 'down') return { kind: r };
      if (r.status === 201) {
        try {
          const b = (await r.json()) as { verificationId?: unknown; window?: unknown };
          return isVerificationId(b.verificationId) && isWindow(b.window) ? { kind: 'started', id: b.verificationId, window: b.window } : { kind: 'error' };
        } catch {
          return { kind: 'error' };
        }
      }
      const type = await problemType(r);
      if (r.status === 409 && type === 'already-verified') return { kind: 'already' };
      if (r.status === 403 && type === 'under-14') return { kind: 'under14' };
      if (r.status === 503) return { kind: 'down' };
      return { kind: 'error' };
    },
    confirm: (id, fields) => answer(resultPath(id), 'POST', { providerResult: fields }),
    result: (id) => answer(resultPath(id), 'GET'),
    refresh,
  };
}

// ── 부르는 화면 ──

export interface WindowLike {
  readonly closed: boolean;
  close(): void;
}
export interface ChannelLike {
  onmessage: ((e: { data: unknown }) => void) | null;
  postMessage(data: unknown): void;
  close(): void;
}
export interface StorageLike {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

export interface CallerEnv {
  api: VerifyApi;
  /** window.open(빈 창, 이름, 기능). 막혔으면 null */
  openWindow(name: string, features: string): WindowLike | null;
  channel(): ChannelLike;
  /** 기관 양식을 target(창 이름이나 '_self')에 제출한다 */
  submitForm(target: string, w: AgencyWindow): void;
  /** ms 뒤에 끝난다. signal이 끊기면 타이머를 지우고 바로 끝난다(흐름을 멈추면 기다리던 타이머를 남기지 않는다) */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  /** 지금 화면의 경로와 쿼리(돌아갈 주소) */
  currentPath(): string;
  /** 로그인 화면으로(돌아올 주소는 부르는 화면) */
  goLogin(next: string): void;
}

export interface CallerHandlers {
  purpose: Purpose;
  /** 기관 창이 열려 기다리는 중 */
  onWaiting(): void;
  /** 결과 대화상자(완료면 토스트). 지금 창이 기관으로 넘어가면 부르지 않는다 */
  onDone(outcome: Exclude<VerifyOutcome, 'popup'>): void;
}

/** [휴대폰 본인확인]을 누른 동작 안에서 부른다(창을 먼저 연다). 돌려준 함수로 기다리기를 멈춘다 */
export function startCallerFlow(env: CallerEnv, h: CallerHandlers): { cancel(): void } {
  const win = env.openWindow(VERIFY_WINDOW_NAME, VERIFY_WINDOW_FEATURES);
  let stopped = false;
  let channel: ChannelLike | null = null;
  // 멈추면 기다리던 타이머(닫힘 확인 간격·늦은 메시지 10분)를 함께 지운다(BOT-010이 넘긴 것)
  const timers = new AbortController();
  const wait = (ms: number) => env.sleep(ms, timers.signal);
  const stop = () => {
    stopped = true;
    timers.abort();
    channel?.close();
    channel = null;
  };

  const finish = (o: Exclude<VerifyOutcome, 'popup'> | 'login', next: string) => {
    stop();
    if (o === 'login') env.goLogin(next);
    else h.onDone(o);
  };

  void (async () => {
    const next = safeNext(env.currentPath());
    const s = await env.api.start(next, h.purpose);
    if (stopped) return;
    if (s.kind !== 'started') {
      win?.close();
      // 이미 본인확인(409)이면 토큰을 갱신한 뒤 완료다. 앞서 갱신이 일시 장애로 끝나 [다시 시도]한 경우가 이 길로 갱신을 마친다(새 맥락 재검토)
      if (s.kind === 'already') {
        const o = await successAfterRefresh(env.api, wait, () => !stopped);
        if (!stopped) finish(o, next);
        return;
      }
      finish(s.kind === 'login' ? 'login' : s.kind === 'under14' ? 'under14' : 'down', next);
      return;
    }
    const usePopup = s.window.mode === 'POPUP' && win !== null && !win.closed;
    if (!usePopup) {
      // 팝업 차단 대체·페이지 이동 방식 기관: 지금 창이 기관으로 넘어간다(돌아오면 복귀 화면 → next)
      win?.close();
      stop();
      env.submitForm('_self', s.window);
      return;
    }
    // acked: 맞는 메시지를 받아 받은 표시를 보냈다. told: 그 메시지의 status(화면에는 쓰지 않고, 복귀 화면이 갱신을 마쳤는지만 본다).
    // gen: 결과 조회의 세대(새 조회가 나가면 앞 조회의 답은 버린다)
    let acked = false;
    let told: unknown = null;
    let gen = 0;
    channel = env.channel();
    const settle = async (viaMessage: boolean, g: number) => {
      const a = await env.api.result(s.id);
      if (stopped || g !== gen) return;
      let o: Exclude<VerifyOutcome, 'popup'> | 'login' = outcomeOfAnswer(a);
      // 결과 조회로 완료를 알았으면 토큰을 갱신한다. 건너뛰는 것은 복귀 화면이 VERIFIED를 알린 때뿐이다(복귀 화면은 갱신까지 마쳤을 때만
      // VERIFIED를 알린다). 처리 중 알림·메시지 없음이면 복귀 화면이 갱신하지 않았다(갱신은 창끼리 잠금으로 하나씩 돈다, 새 맥락 재검토)
      if (o === 'success' && !(viaMessage && told === 'VERIFIED')) o = await successAfterRefresh(env.api, wait, () => !stopped && g === gen);
      if (stopped || g !== gen) return;
      // 창이 닫힌 것으로 보여 처리 중(PENDING)을 '창을 닫음·실패'로 보였어도, 그 건의 결과를 받을 수 있는 동안은 메시지를 계속 듣는다.
      // 기관 쪽 COOP 등으로 창 관계가 끊기면 열린 창도 닫힌 것으로 보이기 때문이다(새 맥락 리뷰 M1)
      if (!viaMessage && a.kind === 'result' && a.body.status === 'PENDING') {
        h.onDone('closed');
        void wait(LATE_MESSAGE_MS).then(() => {
          if (!acked) stop();
        });
        return;
      }
      finish(o, next);
    };
    const settleSafely = (viaMessage: boolean) => {
      const g = ++gen;
      return settle(viaMessage, g).catch(() => {
        if (!stopped) finish('down', next);
      });
    };
    // 창 닫힘 쪽 조회가 도는 동안 온 메시지도 받는다. 그때는 세대를 올려 앞 조회의 답을 버린다(새 맥락 리뷰 다시 보기 1)
    channel.onmessage = (e) => {
      if (stopped || acked || !isResultMessage(e.data, s.id)) return;
      acked = true;
      told = (e.data as { status: unknown }).status;
      channel?.postMessage({ type: 'ack', verificationId: s.id });
      void settleSafely(true);
    };
    env.submitForm(VERIFY_WINDOW_NAME, s.window);
    h.onWaiting();
    // 창이 닫혔는데 메시지가 없으면 1초 더 기다린 뒤 결과 조회로 정한다
    while (!stopped && !acked) {
      await wait(POLL_CLOSED_MS);
      if (stopped || acked) return;
      if (win.closed) {
        await wait(CLOSED_GRACE_MS);
        if (stopped || acked) return;
        await settleSafely(false);
        return;
      }
    }
  })().catch(() => {
    if (stopped) return;
    win?.close();
    finish('down', '/');
  });

  return { cancel: stop };
}

/** 복귀 건의 저장 값({id, at, refreshed}). refreshed: 복귀 화면이 토큰 갱신까지 마쳤다. 꼴이 틀리면 null */
function parseReturned(v: string): { id: string; at: number; refreshed: boolean } | null {
  try {
    const o = JSON.parse(v) as { id?: unknown; at?: unknown; refreshed?: unknown };
    return typeof o === 'object' && o !== null && isVerificationId(o.id) && typeof o.at === 'number' && Number.isFinite(o.at)
      ? { id: o.id, at: o.at, refreshed: o.refreshed === true }
      : null;
  } catch {
    return null;
  }
}

/**
 * 부르는 화면이 열릴 때: 페이지 이동으로 돌아온 건이 있으면 늘 지우고, 남긴 지 1분 [가정] 안일 때만 결과 대화상자를 정한다. 없으면 null.
 * next가 본인확인 부품이 없는 화면이면 값을 읽는 화면이 없어 남으므로, 나중에 다른 화면에서 지난 결과가 뜨지 않게 기한을 둔다(BOT-010이 넘긴 것)
 */
export async function resumeReturnedResult(env: {
  api: VerifyApi;
  storage: StorageLike;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}): Promise<Exclude<VerifyOutcome, 'popup'> | 'login' | null> {
  const raw = env.storage.get(RETURN_STORAGE_KEY);
  if (raw === null) return null;
  env.storage.remove(RETURN_STORAGE_KEY);
  const saved = parseReturned(raw);
  const now = env.now();
  if (!saved || saved.at > now || now - saved.at > RETURN_TTL_MS) return null;
  const o = outcomeOfAnswer(await env.api.result(saved.id));
  // 완료인데 복귀 화면이 갱신하지 못했으면 직접 갱신한다(새 맥락 재검토)
  return o === 'success' && !saved.refreshed ? successAfterRefresh(env.api, env.sleep) : o;
}

// ── 복귀 화면 ──

export interface ReturnEnv {
  api: VerifyApi;
  channel(): ChannelLike;
  sleep(ms: number): Promise<void>;
  /** location.search */
  search(): string;
  /** history.replaceState로 주소만 바꾼다 */
  replaceUrl(path: string): void;
  closeWindow(): void;
  /** location.replace */
  navigate(path: string): void;
  /** 복귀 건을 남긴 시각(Date.now) */
  now(): number;
  storage: StorageLike;
}

/** 결과를 보내지 못하고 로그인 화면으로 갈 때의 주소: 돌아올 주소는 첫 화면이다(복귀 화면은 기관 값이 없어 그 건을 마칠 수 없다, BOT-010이 넘긴 것) */
const LOGIN_AFTER_LOST = `/login?next=${encodeURIComponent('/')}`;

/** 부르는 화면(팝업)에 결과 코드를 알리고 받은 표시를 1초 기다린다. 받으면 true(팝업), 아니면 false(페이지 이동) */
async function announce(env: ReturnEnv, id: string, status: ServerStatus): Promise<boolean> {
  const channel = env.channel();
  const acked = new Promise<boolean>((resolve) => {
    channel.onmessage = (e) => {
      if (isAckMessage(e.data, id)) resolve(true);
    };
    void env.sleep(ACK_WAIT_MS).then(() => resolve(false));
  });
  channel.postMessage({ type: 'result', verificationId: id, status });
  const popup = await acked;
  channel.close();
  return popup;
}

/** 팝업이면 창을 닫고, 닫을 수 없는 창이면(기관 쪽 COOP 등으로 열린 창 관계가 끊김) 잠시 뒤 to로 간다 */
function closeOr(env: ReturnEnv, to: string): void {
  env.closeWindow();
  void env.sleep(CLOSE_FALLBACK_MS).then(() => env.navigate(to));
}

/** 서버 처리기가 넘긴 POST 본문(posted)이 없으면 쿼리를 기관 값으로 본다. 끝나면 창을 닫거나 다른 화면으로 간다 */
export async function runReturnFlow(env: ReturnEnv, posted: Record<string, string> | null): Promise<void> {
  let fields = posted;
  if (fields === null) {
    const q = new URLSearchParams(env.search());
    if ([...q.keys()].length > 0) {
      // 쿼리 복귀: 기관 값을 읽자마자 주소에서 지운다(ASVS v5.0.0-14.2.1)
      fields = Object.fromEntries(q);
      env.replaceUrl(RETURN_PATH);
    }
  }
  const id = fields?.verificationId;
  if (!fields || !isVerificationId(id)) {
    env.navigate('/');
    return;
  }
  let a = await env.api.confirm(id, fields);
  // 결과 경로가 409·403·503이거나 일시 장애면 본문이 없어 결과 조회로 상태와 next를 받는다
  if (a.kind !== 'result' && a.kind !== 'login') a = await env.api.result(id);
  if (a.kind === 'login') {
    // 세션이 끝나 결과를 보내지 못했다. 처리 중(PENDING)을 알리면 팝업을 연 화면이 결과 조회로 '창을 닫음·실패'나
    // 로그인(돌아올 주소는 부르는 화면)을 정한다. 페이지 이동이면 로그인 뒤 첫 화면으로 간다(identity §5 '복귀 화면의 스크립트')
    if (await announce(env, id, 'PENDING')) closeOr(env, LOGIN_AFTER_LOST);
    else env.navigate(LOGIN_AFTER_LOST);
    return;
  }
  if (a.kind === 'down' || a.kind === 'error') {
    // 일시 장애(연결 끊김·5xx, 401 뒤 갱신의 일시 장애 포함): 로그인 화면으로 보내지 않는다. 처리 중을 알리면 팝업을 연 화면이
    // 결과 조회로 '기관 장애'(잠시 후 다시)나 '창을 닫음·실패'([다시 시도])를 보인다. 페이지 이동이면 부르는 화면을 몰라 첫 화면으로 간다
    if (await announce(env, id, 'PENDING')) closeOr(env, '/');
    else env.navigate('/');
    return;
  }
  if (a.kind !== 'result') {
    env.navigate('/');
    return;
  }
  const { status, next } = a.body;
  // VERIFIED면 토큰을 갱신한다(일시 장애면 한 번 더). 갱신하지 못했으면 VERIFIED 대신 처리 중으로 알려 부르는 화면이 직접 갱신하게 한다(새 맥락 재검토)
  const refreshed = status === 'VERIFIED' && (await refreshAfterVerified(env.api, (ms) => env.sleep(ms))) === 'ok';
  const popup = await announce(env, id, status === 'VERIFIED' && !refreshed ? 'PENDING' : status);
  const to = safeNext(next);
  if (popup) {
    closeOr(env, to);
    return;
  }
  env.storage.set(RETURN_STORAGE_KEY, JSON.stringify({ id, at: env.now(), refreshed }));
  env.navigate(to);
}
