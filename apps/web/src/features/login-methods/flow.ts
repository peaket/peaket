// 계정 설정의 로그인 수단 연결·해제 흐름(SCR-040 ①②③, docs/features/identity.md §2.1 '설정의 로그인 수단 연결·해제의 첫 구현', BUILD_ORDER BOT-041, I-T33·I-T34).
// 브라우저 기능(fetch·sessionStorage·양식 제출)은 밖에서 넣는다(browser.ts). 그래서 이 파일은 node 시험(flow.test.mjs)으로 본다.
// ① 목록(GET /v1/identity/providers) ② 해제·추가 전에 재인증: 탭 저장소에 할 일을 남기고 POST /reauth/{제공자}로 옮긴다
// ③ 돌아오면 할 일이 있을 때만 POST /reauth/token으로 토큰을 받아 해제(DELETE /v1/identity/providers/{p})나 추가(POST /link/{p})를 한다

export const PROVIDERS = ['kakao', 'naver', 'google'] as const;
export type Provider = (typeof PROVIDERS)[number];
/** 탭 저장소의 '재인증 뒤 할 일'. 값은 {action, provider, at} JSON */
export const PENDING_KEY = 'peaket.providers.pending';
/** 할 일을 믿는 시간 [가정]: 재인증 결과 쿠키(1분)와 제공자 화면에서 머무는 시간을 넉넉히 덮는다(탈퇴의 표시와 같다) */
export const PENDING_TTL_MS = 10 * 60_000;
export const RETURN_TO = '/my/settings/providers';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
export interface StorageLike {
  get(k: string): string | null;
  set(k: string, v: string): void;
  remove(k: string): void;
}

export interface LinkedMethod {
  provider: Provider;
  linkedAt: string;
  lastLoginAt: string | null;
}
export type ListAnswer = { kind: 'ok'; methods: LinkedMethod[] } | { kind: 'login' } | { kind: 'error' };
export type UnlinkAnswer = { kind: 'done' } | { kind: 'last' } | { kind: 'missing' } | { kind: 'reauth' } | { kind: 'login' } | { kind: 'error' };
export type ReauthAnswer = { kind: 'token'; token: string } | { kind: 'failed' };
export interface Pending {
  action: 'unlink' | 'add';
  provider: Provider;
  at: number;
}

export const isProvider = (v: unknown): v is Provider => typeof v === 'string' && (PROVIDERS as readonly string[]).includes(v);

async function problemType(r: Response): Promise<string> {
  try {
    const b = (await r.json()) as { type?: unknown };
    return typeof b.type === 'string' ? (b.type.split('/').pop() ?? '') : '';
  } catch {
    return '';
  }
}

/** origin: API 출처(gw-fan). 재인증 결과 받기(/reauth/token)는 이 화면과 같은 출처다(앱 서버) */
export function createLoginMethodsApi(o: { origin: string; fetch: FetchLike; lock?: <T>(fn: () => Promise<T>) => Promise<T> }) {
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
    async list(): Promise<ListAnswer> {
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
        const rows = Array.isArray(b.providers) ? b.providers : [];
        const methods = rows
          .map((x) => x as { provider?: unknown; linkedAt?: unknown; lastLoginAt?: unknown })
          .filter((x) => isProvider(x.provider) && typeof x.linkedAt === 'string')
          .map((x) => ({ provider: x.provider as Provider, linkedAt: x.linkedAt as string, lastLoginAt: typeof x.lastLoginAt === 'string' ? x.lastLoginAt : null }));
        return methods.length ? { kind: 'ok', methods } : { kind: 'error' };
      } catch {
        return { kind: 'error' };
      }
    },
    async unlink(provider: Provider, token: string): Promise<UnlinkAnswer> {
      let r: Response | null;
      try {
        r = await call(`/v1/identity/providers/${provider}`, { method: 'DELETE', headers: { accept: 'application/json', 'x-reauth-token': token } });
      } catch {
        return { kind: 'error' };
      }
      if (r === null) return { kind: 'login' };
      if (r.status === 204) return { kind: 'done' };
      if (r.status === 404) return { kind: 'missing' };
      if (r.status === 409 && (await problemType(r)) === 'last-login-method') return { kind: 'last' };
      if (r.status === 403) return { kind: 'reauth' };
      return { kind: 'error' };
    },
    async pickupReauth(): Promise<ReauthAnswer> {
      try {
        const r = await o.fetch('/reauth/token', { method: 'POST', credentials: 'same-origin', cache: 'no-store' });
        if (r.status !== 200) return { kind: 'failed' };
        const b = (await r.json()) as { reauthToken?: unknown };
        return typeof b.reauthToken === 'string' && b.reauthToken ? { kind: 'token', token: b.reauthToken } : { kind: 'failed' };
      } catch {
        return { kind: 'failed' };
      }
    },
  };
}
export type LoginMethodsApi = ReturnType<typeof createLoginMethodsApi>;

/** 재인증으로 떠나기 전에 할 일을 남긴다 */
export function markPending(storage: StorageLike, p: Pending): void {
  storage.set(PENDING_KEY, JSON.stringify(p));
}

/** 돌아왔을 때 할 일이 10분 안이면 돌려준다. 늘 지운다(한 번만) */
export function takePending(storage: StorageLike, now: number): Pending | null {
  const v = storage.get(PENDING_KEY);
  storage.remove(PENDING_KEY);
  if (v === null) return null;
  try {
    const p = JSON.parse(v) as Partial<Pending>;
    if ((p.action !== 'unlink' && p.action !== 'add') || !isProvider(p.provider) || typeof p.at !== 'number') return null;
    if (p.at > now || now - p.at > PENDING_TTL_MS) return null;
    return { action: p.action, provider: p.provider, at: p.at };
  } catch {
    return null;
  }
}

/** 재인증 시작 양식(목적 비움 = FAN_SENSITIVE, identity §7.1 ①) */
export function reauthForm(provider: Provider): { action: string; fields: Record<string, string> } {
  return { action: `/reauth/${provider}`, fields: { returnTo: RETURN_TO, purpose: '' } };
}

/** 로그인 수단 추가 시작 양식(POST /link/{p}, 재인증 토큰을 싣는다) */
export function linkForm(provider: Provider, token: string): { action: string; fields: Record<string, string> } {
  return { action: `/link/${provider}`, fields: { reauthToken: token, returnTo: RETURN_TO } };
}

/** 추가 결과(?loginMethod=, 앱 서버가 붙인다)의 안내 문구. 모르는 값이면 null */
export function addResultText(v: string | null): { tone: 'success' | 'warning' | 'danger'; text: string } | null {
  switch (v) {
    case 'linked':
      return { tone: 'success', text: '로그인 수단을 연결했습니다' };
    case 'already-linked':
      return { tone: 'success', text: '이미 이 계정에 연결된 로그인 수단입니다' };
    case 'type-taken':
      return { tone: 'warning', text: '같은 종류의 로그인 수단이 이미 연결돼 있습니다. 먼저 해제한 뒤 다시 추가해 주세요' };
    case 'other-account':
      return { tone: 'warning', text: '그 소셜 계정은 이미 다른 PEAKET 계정의 로그인 수단입니다' };
    case 'reauth-required':
      return { tone: 'danger', text: '다시 로그인한 지 5분이 지났습니다. 처음부터 다시 시도해 주세요' };
    case 'failed':
      return { tone: 'danger', text: '지금은 처리할 수 없습니다. 잠시 뒤 다시 시도해 주세요' };
    default:
      return null;
  }
}

/** 해제 결과의 안내 문구 */
export function unlinkResultText(a: UnlinkAnswer): { tone: 'success' | 'warning' | 'danger'; text: string } {
  switch (a.kind) {
    case 'done':
      return { tone: 'success', text: '로그인 수단을 해제했습니다' };
    case 'last':
      return { tone: 'warning', text: '마지막 로그인 수단은 해제할 수 없습니다' };
    case 'missing':
      return { tone: 'warning', text: '이미 해제된 로그인 수단입니다' };
    case 'reauth':
      return { tone: 'danger', text: '다시 로그인한 지 5분이 지났습니다. 처음부터 다시 시도해 주세요' };
    default:
      return { tone: 'danger', text: '지금은 처리할 수 없습니다. 잠시 뒤 다시 시도해 주세요' };
  }
}

/** ISO 시각을 화면 날짜(KST, 2026.09.01)로 */
export function dayText(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const k = new Date(d.getTime() + 9 * 3_600_000);
  return `${k.getUTCFullYear()}.${String(k.getUTCMonth() + 1).padStart(2, '0')}.${String(k.getUTCDate()).padStart(2, '0')}`;
}
