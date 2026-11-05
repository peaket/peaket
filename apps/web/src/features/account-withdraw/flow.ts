// 탈퇴 흐름(SCR-017 탈퇴 단계, docs/features/identity.md §8 '탈퇴 화면 연결', BUILD_ORDER BOT-036, I-T16·I-T68 ⑨).
// 브라우저 기능(fetch·sessionStorage·양식 제출)은 밖에서 넣는다(browser.ts). 그래서 이 파일은 node 시험(flow.test.mjs)으로 본다.
// ① 로그인 수단 목록에서 재인증할 제공자를 고른다 ② 탭 저장소에 표시를 남기고 POST /reauth/{provider}로 페이지를 옮긴다
// ③ 돌아오면 표시가 있을 때만 POST /reauth/token으로 토큰을 한 번 받는다(메모리에만) ④ DELETE /v1/identity/account(X-Reauth-Token)
import { REAUTH_EXPIRED, REAUTH_START_UNAVAILABLE, type ReauthFailure, reauthFailureOf, reauthFailureText as pickupFailureText } from '../../shared/lib/reauth-failure.ts';
import { refreshOnce, type RefreshResult } from '../../shared/lib/token-refresh.ts';

export type { ReauthFailure, RefreshResult };

export const PROVIDERS = ['kakao', 'naver', 'google'] as const;
export type Provider = (typeof PROVIDERS)[number];
/** 탭 저장소의 '탈퇴 재인증 중' 표시. 값은 남긴 시각(밀리초) */
export const PENDING_KEY = 'peaket.withdraw.reauth';
/** 표시를 믿는 시간 [가정]: 재인증 결과 쿠키(1분)와 제공자 화면에서 머무는 시간을 넉넉히 덮는다 */
export const PENDING_TTL_MS = 10 * 60_000;
/** 재인증 뒤 돌아올 곳(같은 출처 경로) */
export const RETURN_TO = '/my/settings';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
export interface StorageLike {
  get(k: string): string | null;
  set(k: string, v: string): void;
  remove(k: string): void;
}

export type ProvidersAnswer = { kind: 'ok'; providers: Provider[] } | { kind: 'login' } | { kind: 'error' };
export type ReauthAnswer = { kind: 'token'; token: string; provider?: Provider } | { kind: 'failed'; reason: ReauthFailure };
export type FraudHold = { state: 'RESTRICTED' | 'CASE_OPEN'; until: string };
export type WithdrawAnswer = { kind: 'done' } | { kind: 'deferred' } | ({ kind: 'fraudHold' } & FraudHold) | { kind: 'reauth' } | { kind: 'login' } | { kind: 'error' };

export interface WithdrawApi {
  providers(): Promise<ProvidersAnswer>;
  /** 액세스 토큰 갱신. 재인증 양식을 보내기 직전에 불러, 만료된 토큰으로 제공자로 떠나 막다른 페이지가 되지 않게 한다(새 맥락 리뷰 중간 1) */
  refresh(): Promise<RefreshResult>;
  pickupReauth(): Promise<ReauthAnswer>;
  withdraw(token: string, acknowledgeFraudHold: boolean): Promise<WithdrawAnswer>;
}

const isProvider = (v: unknown): v is Provider => typeof v === 'string' && (PROVIDERS as readonly string[]).includes(v);

/** 문제 상세 type의 끝(예: https://peaket.example/problems/reauth-required → reauth-required). 아니면 '' */
async function problemType(r: Response): Promise<string> {
  try {
    const b = (await r.json()) as { type?: unknown };
    return typeof b.type === 'string' ? (b.type.split('/').pop() ?? '') : '';
  } catch {
    return '';
  }
}

/**
 * origin: API 출처(gw-fan). 재인증 결과 받기(/reauth/token)는 이 화면과 같은 출처다(앱 서버).
 * lock: 토큰 갱신을 창끼리 하나씩(본인확인 흐름과 같은 잠금)
 */
export function createWithdrawApi(o: { origin: string; fetch: FetchLike; lock?: <T>(fn: () => Promise<T>) => Promise<T> }): WithdrawApi {
  const lock = o.lock ?? (<T>(fn: () => Promise<T>) => fn());
  const url = (p: string) => `${o.origin}${p}`;

  /** 401만 거절(rejected)이다. 연결이 끊기거나 5xx 같은 그 밖은 unavailable(로그인 화면으로 보내지 않는다, BOT-036이 넘긴 것) */
  const refresh = (): Promise<RefreshResult> => lock(() => refreshOnce(o.fetch, url('/v1/identity/access-tokens')));

  /**
   * 보내고 401이면 갱신 뒤 한 번 더. 갱신이 401로 거절되거나 다시 401이면 login, 갱신이 일시 장애면 unavailable이다.
   * 탈퇴 요청 401 뒤 갱신 503을 로그인으로 보면 재인증 토큰을 잃는다(identity §8 '탈퇴 화면 연결', 새 맥락 리뷰)
   */
  async function call(path: string, init: RequestInit): Promise<Response | 'login' | 'unavailable'> {
    const send = () => o.fetch(url(path), { credentials: 'include', cache: 'no-store', ...init });
    const first = await send();
    if (first.status !== 401) return first;
    const refreshed = await refresh();
    if (refreshed === 'rejected') return 'login';
    if (refreshed !== 'ok') return 'unavailable';
    const second = await send();
    return second.status === 401 ? 'login' : second;
  }

  return {
    refresh,
    async providers() {
      let r: Response | 'login' | 'unavailable';
      try {
        r = await call('/v1/identity/providers', { method: 'GET', headers: { accept: 'application/json' } });
      } catch {
        return { kind: 'error' };
      }
      if (r === 'login') return { kind: 'login' };
      if (r === 'unavailable' || r.status !== 200) return { kind: 'error' };
      try {
        const b = (await r.json()) as { providers?: unknown };
        const list = Array.isArray(b.providers) ? b.providers.map((x) => (x as { provider?: unknown }).provider).filter(isProvider) : [];
        return list.length ? { kind: 'ok', providers: list } : { kind: 'error' };
      } catch {
        return { kind: 'error' };
      }
    },

    async pickupReauth() {
      let r: Response;
      try {
        r = await o.fetch('/reauth/token', { method: 'POST', credentials: 'same-origin', cache: 'no-store' });
      } catch {
        return { kind: 'failed', reason: 'failed' };
      }
      if (r.status === 200) {
        try {
          const b = (await r.json()) as { reauthToken?: unknown; provider?: unknown };
          if (typeof b.reauthToken !== 'string' || !b.reauthToken) return { kind: 'failed', reason: 'failed' };
          return isProvider(b.provider) ? { kind: 'token', token: b.reauthToken, provider: b.provider } : { kind: 'token', token: b.reauthToken };
        } catch {
          return { kind: 'failed', reason: 'failed' };
        }
      }
      return { kind: 'failed', reason: reauthFailureOf(await problemType(r)) };
    },

    async withdraw(token, acknowledgeFraudHold) {
      let r: Response | 'login' | 'unavailable';
      try {
        r = await call('/v1/identity/account', {
          method: 'DELETE',
          headers: { accept: 'application/json', 'content-type': 'application/json', 'x-reauth-token': token },
          body: JSON.stringify(acknowledgeFraudHold ? { acknowledgeFraudHold: true } : {}),
        });
      } catch {
        return { kind: 'error' };
      }
      if (r === 'login') return { kind: 'login' };
      // 일시 장애는 오류(화면은 '잠시 뒤 다시' 토스트, 토큰과 확인 창은 둔다)
      if (r === 'unavailable') return { kind: 'error' };
      if (r.status === 204) return { kind: 'done' };
      if (r.status === 202) return { kind: 'deferred' };
      if (r.status === 409) {
        try {
          const b = (await r.json()) as { type?: unknown; fraudHold?: { state?: unknown; until?: unknown } };
          const h = b.fraudHold;
          if (typeof b.type === 'string' && b.type.endsWith('/withdrawal-confirmation-required') && h && (h.state === 'RESTRICTED' || h.state === 'CASE_OPEN') && typeof h.until === 'string') {
            return { kind: 'fraudHold', state: h.state, until: h.until };
          }
        } catch {
          // 아래 오류로
        }
        return { kind: 'error' };
      }
      if (r.status === 403 && (await problemType(r)) === 'reauth-required') return { kind: 'reauth' };
      return { kind: 'error' };
    },
  };
}

/** 재인증으로 떠나기 전에 표시를 남긴다 */
export function markPending(storage: StorageLike, now: number): void {
  storage.set(PENDING_KEY, String(now));
}

/** 돌아왔을 때 표시가 10분 안이면 true. 늘 지운다(한 번만) */
export function takePending(storage: StorageLike, now: number): boolean {
  const v = storage.get(PENDING_KEY);
  storage.remove(PENDING_KEY);
  if (v === null) return false;
  const at = Number(v);
  return Number.isFinite(at) && at <= now && now - at <= PENDING_TTL_MS;
}

/** 떠나기의 결과: left 제공자로 떠남, login 로그인 화면으로, retry 잠시 뒤 다시, cancelled 그사이 창을 닫음, no-provider 제공자를 정하지 못함 */
export type LeaveResult = 'left' | 'login' | 'retry' | 'cancelled' | 'no-provider';

/**
 * [다시 로그인하고 계속]: 제공자를 정하고(모르면 로그인 수단 목록의 첫 제공자) 액세스 토큰을 갱신한 뒤, 표시를 남기고 재인증 양식을 보낸다.
 * 갱신이 401이면 로그인 화면, 그 밖의 실패면 잠시 뒤 다시다. 갱신을 기다리는 사이 창을 닫았으면(cancelled) 떠나지 않는다
 * (docs/features/identity.md §8 '탈퇴 화면 연결', BOT-036이 넘긴 것)
 */
export async function leaveForReauth(o: {
  api: Pick<WithdrawApi, 'refresh'>;
  storage: StorageLike;
  now: () => number;
  provider: Provider | null;
  /** 로그인 수단 목록에서 첫 제공자를 고른다(실패면 null. 로그인 화면·안내는 고르는 쪽이 한다) */
  pickProvider: () => Promise<Provider | null>;
  submit: (provider: Provider) => void;
  cancelled: () => boolean;
}): Promise<LeaveResult> {
  const provider = o.provider ?? (await o.pickProvider());
  if (o.cancelled()) return 'cancelled';
  if (!provider) return 'no-provider';
  const r = await o.api.refresh();
  if (o.cancelled()) return 'cancelled';
  if (r === 'rejected') return 'login';
  if (r !== 'ok') return 'retry';
  markPending(o.storage, o.now());
  o.submit(provider);
  return 'left';
}

/**
 * 탈퇴 확인 창이 열린 동안 제공자를 채울 때: 연결한 로그인 수단(연결한 순). 목록이 실패하면(로그인 필요 포함) null이다.
 * 부르는 쪽은 그때 화면을 떠나거나 안내를 띄우지 않고 비운 채로 둔다(재인증 토큰을 잃지 않게, identity §8 '탈퇴 화면 연결', 새 맥락 리뷰)
 */
export async function linkedProvidersQuietly(api: Pick<WithdrawApi, 'providers'>): Promise<Provider[] | null> {
  try {
    const r = await api.providers();
    return r.kind === 'ok' ? r.providers : null;
  } catch {
    return null;
  }
}

/** 탈퇴 응답 뒤 화면이 할 일. ignore: 창을 닫은 뒤 온 응답이라 버린다 */
export type WithdrawStep = 'done' | 'deferred' | 'hold' | 'reauth' | 'login' | 'error' | 'ignore';

/**
 * 탈퇴 응답 → 화면이 할 일. 요청이 도는 동안 창을 닫았으면(closed) 완료(204·202)만 반영한다(계정이 이미 바뀌었다).
 * 409 보관 안내·403·오류·로그인 필요는 버린다(닫은 창을 다시 열지 않는다, identity §8 '탈퇴 화면 연결', 새 맥락 마지막 검토)
 */
export function afterWithdraw(r: WithdrawAnswer, o: { closed: boolean }): WithdrawStep {
  if (r.kind === 'done' || r.kind === 'deferred') return r.kind;
  if (o.closed) return 'ignore';
  return r.kind === 'fraudHold' ? 'hold' : r.kind === 'reauth' ? 'reauth' : r.kind === 'login' ? 'login' : 'error';
}

/** 재인증 시작 양식(POST /reauth/{provider}, 목적 비움 = FAN_SENSITIVE, identity §7.1 ①) */
export function reauthForm(provider: Provider): { action: string; fields: Record<string, string> } {
  return { action: `/reauth/${provider}`, fields: { returnTo: RETURN_TO, purpose: '' } };
}

/** fraudHold.until(날짜·시각)을 화면 글(KST 날짜)로 */
export function untilText(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const kst = new Date(d.getTime() + 9 * 3_600_000);
  return `${kst.getUTCFullYear()}년 ${kst.getUTCMonth() + 1}월 ${kst.getUTCDate()}일`;
}

/**
 * 재인증 창의 실패 문구. 재인증 결과 받기의 이유(identity §7.1 ②·I-T54 ②)는 shared/lib/reauth-failure와 같다(새 맥락 리뷰 중간 2).
 * expired: 탈퇴 403 reauth-required. 5분이 지난 때 말고 이미 쓴 토큰·다른 세션·계정의 토큰·탈퇴할 수 없는 상태에서도 오므로 넓게 쓴다.
 * unavailable: 떠나기 전 갱신이 401이 아닌 이유로 실패했다(BOT-036이 넘긴 것)
 */
export function reauthFailureText(reason: ReauthFailure | 'expired' | 'unavailable'): string {
  if (reason === 'expired') return `${REAUTH_EXPIRED}. 다시 로그인해 주세요`;
  if (reason === 'unavailable') return REAUTH_START_UNAVAILABLE;
  return pickupFailureText(reason);
}
