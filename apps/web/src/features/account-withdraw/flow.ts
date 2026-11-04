// 탈퇴 흐름(SCR-017 탈퇴 단계, docs/features/identity.md §8 '탈퇴 화면 연결', BUILD_ORDER BOT-036, I-T16·I-T68 ⑨).
// 브라우저 기능(fetch·sessionStorage·양식 제출)은 밖에서 넣는다(browser.ts). 그래서 이 파일은 node 시험(flow.test.mjs)으로 본다.
// ① 로그인 수단 목록에서 재인증할 제공자를 고른다 ② 탭 저장소에 표시를 남기고 POST /reauth/{provider}로 페이지를 옮긴다
// ③ 돌아오면 표시가 있을 때만 POST /reauth/token으로 토큰을 한 번 받는다(메모리에만) ④ DELETE /v1/identity/account(X-Reauth-Token)

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
export type ReauthFailure = 'stale' | 'account-mismatch' | 'reverify-required' | 'failed' | 'missing';
export type ReauthAnswer = { kind: 'token'; token: string; provider?: Provider } | { kind: 'failed'; reason: ReauthFailure };
export type FraudHold = { state: 'RESTRICTED' | 'CASE_OPEN'; until: string };
export type WithdrawAnswer = { kind: 'done' } | { kind: 'deferred' } | ({ kind: 'fraudHold' } & FraudHold) | { kind: 'reauth' } | { kind: 'login' } | { kind: 'error' };

export interface WithdrawApi {
  providers(): Promise<ProvidersAnswer>;
  /** 액세스 토큰 갱신. 재인증 양식을 보내기 직전에 불러, 만료된 토큰으로 제공자로 떠나 막다른 페이지가 되지 않게 한다(새 맥락 리뷰 중간 1) */
  refresh(): Promise<boolean>;
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

const REAUTH_FAILURES: Readonly<Record<string, ReauthFailure>> = {
  'reauth-stale': 'stale',
  'reauth-account-mismatch': 'account-mismatch',
  'reauth-reverify-required': 'reverify-required',
  'reauth-failed': 'failed',
  'reauth-result-missing': 'missing',
};

/**
 * origin: API 출처(gw-fan). 재인증 결과 받기(/reauth/token)는 이 화면과 같은 출처다(앱 서버).
 * lock: 토큰 갱신을 창끼리 하나씩(본인확인 흐름과 같은 잠금)
 */
export function createWithdrawApi(o: { origin: string; fetch: FetchLike; lock?: <T>(fn: () => Promise<T>) => Promise<T> }): WithdrawApi {
  const lock = o.lock ?? (<T>(fn: () => Promise<T>) => fn());
  const url = (p: string) => `${o.origin}${p}`;

  function refresh(): Promise<boolean> {
    return lock(async () => {
      try {
        const r = await o.fetch(url('/v1/identity/access-tokens'), { method: 'POST', credentials: 'include', cache: 'no-store' });
        return r.status === 204 || r.ok;
      } catch {
        return false;
      }
    });
  }

  /** 보내고 401이면 갱신 뒤 한 번 더. 갱신도 안 되면 null(로그인) */
  async function call(path: string, init: RequestInit): Promise<Response | null> {
    const send = () => o.fetch(url(path), { credentials: 'include', cache: 'no-store', ...init });
    const first = await send();
    if (first.status !== 401) return first;
    if (!(await refresh())) return null;
    const second = await send();
    return second.status === 401 ? null : second;
  }

  return {
    refresh,
    async providers() {
      let r: Response | null;
      try {
        r = await call('/v1/identity/providers', { method: 'GET', headers: { accept: 'application/json' } });
      } catch {
        return { kind: 'error' };
      }
      if (r === null) return { kind: 'login' };
      if (r.status !== 200) return { kind: 'error' };
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
      return { kind: 'failed', reason: REAUTH_FAILURES[await problemType(r)] ?? 'failed' };
    },

    async withdraw(token, acknowledgeFraudHold) {
      let r: Response | null;
      try {
        r = await call('/v1/identity/account', {
          method: 'DELETE',
          headers: { accept: 'application/json', 'content-type': 'application/json', 'x-reauth-token': token },
          body: JSON.stringify(acknowledgeFraudHold ? { acknowledgeFraudHold: true } : {}),
        });
      } catch {
        return { kind: 'error' };
      }
      if (r === null) return { kind: 'login' };
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
 * 재인증 실패 문구(identity §7.1 ②·I-T54 ②, 앱 서버 REAUTH_PROBLEM과 같은 뜻). expired는 탈퇴 403 reauth-required(5분이 지났거나 이미 씀)다.
 * 이유마다 다르게 보여야 다시 묻지 않고 통과하는 제공자에서 사용자가 무엇을 할지 안다(새 맥락 리뷰 중간 2)
 */
export function reauthFailureText(reason: ReauthFailure | 'expired'): string {
  switch (reason) {
    case 'stale':
      return '제공자 계정에서 로그아웃한 뒤 다시 시도해 주세요';
    case 'account-mismatch':
      return '지금 로그인한 계정과 다른 계정으로 다시 로그인했습니다. 지금 로그인한 계정으로 다시 로그인해 주세요';
    case 'reverify-required':
      return '휴대폰 본인확인을 다시 한 뒤 계속할 수 있습니다';
    case 'expired':
      return '다시 로그인한 지 5분이 지났습니다. 다시 로그인해 주세요';
    case 'missing':
    case 'failed':
      return '다시 로그인하지 못했습니다. 다시 시도해 주세요';
  }
}
