// 로그인한 기기 흐름(SCR-017 ②, docs/features/identity.md §8 '로그인한 기기와 다른 세션 끝내기의 첫 구현', d5 §5.17, BUILD_ORDER BOT-044, ADR-0209, I-T74).
// 브라우저 기능(fetch·sessionStorage·양식 제출)은 밖에서 넣는다(browser.ts). 그래서 이 파일은 node 시험(flow.test.mjs)으로 본다.
// ① GET /v1/identity/sessions로 기기마다 한 줄을 받는다 ② [로그아웃]은 토큰을 갱신하고 탭 저장소에 할 일을 남긴 뒤 재인증으로 떠난다
// ③ 돌아오면 할 일이 있을 때만 재인증 토큰을 한 번 받아 DELETE /v1/identity/sessions/{sessionId}(X-Reauth-Token)를 보낸다(재인증 결과 받기는 탈퇴 흐름과 같다)
import type { DeviceSession } from '@peaket/ds/DeviceSessionList';
import { refreshOnce, type RefreshResult } from '../../shared/lib/token-refresh.ts';

export type Provider = 'kakao' | 'naver' | 'google';
/** 탭 저장소의 '원격 로그아웃 재인증 중' 표시. 값은 끝낼 세션·기기 이름·떠난 시각(토큰은 넣지 않는다, docs/frontend.md §3.12) */
export const PENDING_KEY = 'peaket.devices.reauth';
/** 표시를 믿는 시간 [가정]: 탈퇴 재인증 표시와 같다 */
export const PENDING_TTL_MS = 10 * 60_000;

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
export interface StorageLike {
  get(k: string): string | null;
  set(k: string, v: string): void;
  remove(k: string): void;
}

/** openapi FanDeviceSession */
export interface DeviceRow {
  sessionId: string;
  deviceName: string | null;
  lastActiveAt: string;
  current: boolean;
  /** 그 줄에서 대표 세션 말고 살아 있는 세션 수(같은 기기의 다른 로그인) */
  otherSessions: number;
}

export type ListAnswer = { kind: 'ok'; items: DeviceRow[] } | { kind: 'login' } | { kind: 'error' };
/** done 204, gone 404 session-not-found(끝낼 것이 없음 포함), reauth 403 reauth-required */
export type EndAnswer = { kind: 'done' } | { kind: 'gone' } | { kind: 'reauth' } | { kind: 'login' } | { kind: 'error' };

export interface DevicesApi {
  list(): Promise<ListAnswer>;
  /** 액세스 토큰 갱신. 재인증 양식을 보내기 직전에 부른다(탈퇴 흐름과 같은 까닭) */
  refresh(): Promise<RefreshResult>;
  end(sessionId: string, reauthToken: string): Promise<EndAnswer>;
}

const isRow = (v: unknown): v is DeviceRow => {
  const r = v as Partial<DeviceRow> | null;
  return (
    !!r &&
    typeof r.sessionId === 'string' &&
    (r.deviceName === null || typeof r.deviceName === 'string') &&
    typeof r.lastActiveAt === 'string' &&
    typeof r.current === 'boolean' &&
    Number.isInteger(r.otherSessions) &&
    (r.otherSessions as number) >= 0
  );
};

/** 문제 상세 type의 끝(예: …/problems/session-not-found → session-not-found). 아니면 '' */
async function problemType(r: Response): Promise<string> {
  try {
    const b = (await r.json()) as { type?: unknown };
    return typeof b.type === 'string' ? (b.type.split('/').pop() ?? '') : '';
  } catch {
    return '';
  }
}

/** origin: API 출처(gw-fan). lock: 토큰 갱신을 창끼리 하나씩(본인확인·탈퇴 흐름과 같은 잠금) */
export function createDevicesApi(o: { origin: string; fetch: FetchLike; lock?: <T>(fn: () => Promise<T>) => Promise<T> }): DevicesApi {
  const lock = o.lock ?? (<T>(fn: () => Promise<T>) => fn());
  const url = (p: string) => `${o.origin}${p}`;
  /** 401만 거절(rejected)이다. 연결이 끊기거나 5xx는 unavailable(로그인 화면으로 보내지 않는다) */
  const refresh = (): Promise<RefreshResult> => lock(() => refreshOnce(o.fetch, url('/v1/identity/access-tokens')));

  /** 보내고 401이면 갱신 뒤 한 번 더. 갱신이 401로 거절되거나 다시 401이면 login, 갱신이 일시 장애면 unavailable */
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
    async list() {
      let r: Response | 'login' | 'unavailable';
      try {
        r = await call('/v1/identity/sessions', { method: 'GET', headers: { accept: 'application/json' } });
      } catch {
        return { kind: 'error' };
      }
      if (r === 'login') return { kind: 'login' };
      if (r === 'unavailable' || r.status !== 200) return { kind: 'error' };
      try {
        const b = (await r.json()) as { items?: unknown };
        return Array.isArray(b.items) && b.items.every(isRow) ? { kind: 'ok', items: b.items } : { kind: 'error' };
      } catch {
        return { kind: 'error' };
      }
    },
    async end(sessionId, reauthToken) {
      let r: Response | 'login' | 'unavailable';
      try {
        r = await call(`/v1/identity/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE', headers: { accept: 'application/json', 'x-reauth-token': reauthToken } });
      } catch {
        return { kind: 'error' };
      }
      if (r === 'login') return { kind: 'login' };
      if (r === 'unavailable') return { kind: 'error' };
      if (r.status === 204) return { kind: 'done' };
      const type = await problemType(r);
      if (r.status === 404 && type === 'session-not-found') return { kind: 'gone' };
      if (r.status === 403 && type === 'reauth-required') return { kind: 'reauth' };
      return { kind: 'error' };
    },
  };
}

const KST_MS = 9 * 3_600_000;
/** ISO 시각 → 한국 날짜 'YYYY.MM.DD'(로그인 수단 화면과 같은 꼴). 틀리면 null */
function dayText(iso: string): string | null {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const k = new Date(t + KST_MS);
  return `${k.getUTCFullYear()}.${String(k.getUTCMonth() + 1).padStart(2, '0')}.${String(k.getUTCDate()).padStart(2, '0')}`;
}

/** 기기 이름 → 아이콘(휴대폰·태블릿·컴퓨터 monitor). 이름을 모르면 기기 */
function iconOf(name: string | null): DeviceSession['icon'] {
  if (name === null) return 'device';
  if (/\biPad\b/.test(name)) return 'tablet';
  if (/\biPhone\b|\bAndroid\b/.test(name)) return 'phone';
  return 'monitor';
}

/** 목록의 줄 → 화면 부품(CMP-052)의 기기. 지금 이 기기 밖에는 이름 아래 '마지막 활동 날짜'를 단다(d5 §5.17) */
export function toDeviceSessions(rows: readonly DeviceRow[]): DeviceSession[] {
  return rows.map((r) => {
    const s: DeviceSession = { id: r.sessionId, name: r.deviceName ?? '알 수 없는 기기', icon: iconOf(r.deviceName), current: r.current };
    const day = r.current ? null : dayText(r.lastActiveAt);
    return day ? { ...s, detail: `마지막 활동 ${day}` } : s;
  });
}

/** 지금 이 기기 줄의 같은 기기 다른 로그인 수(0이면 [이 기기의 다른 로그인 끝내기]를 보이지 않는다, d5 §5.17) */
export function otherLoginsOf(rows: readonly DeviceRow[]): number {
  return rows.find((r) => r.current)?.otherSessions ?? 0;
}

/** 끄는 범위: 그 기기(다른 기기 줄), 이 기기의 다른 로그인(지금 이 기기 줄) */
export type LogoutScope = 'device' | 'others';

/**
 * 원격 로그아웃 결과의 토스트(d5 §5.17). 재인증 만료와 로그인 필요는 토스트가 아니라 재인증 창·로그인 화면이라 null.
 * 이 기기의 다른 로그인 끝내기는 문구가 다르다(지금 세션은 끝나지 않는다)
 */
export function endResultText(r: EndAnswer, target: { name: string; scope: LogoutScope }): { text: string; icon: string } | null {
  const own = target.scope === 'others';
  switch (r.kind) {
    case 'done':
      return own ? { text: '이 기기의 다른 로그인을 끝냈습니다', icon: 'ic-check' } : { text: `${target.name}에서 로그아웃했습니다`, icon: 'ic-check' };
    case 'gone':
      return own ? { text: '끝낼 다른 로그인이 없습니다', icon: 'ic-info' } : { text: '이미 로그아웃된 기기입니다', icon: 'ic-info' };
    case 'error':
      return { text: '지금은 로그아웃할 수 없습니다. 잠시 뒤 다시 시도해 주세요', icon: 'ic-alert-circle' };
    default:
      return null;
  }
}

export interface PendingLogout {
  sessionId: string;
  /** 토스트에 보일 기기 이름 */
  name: string;
  scope: LogoutScope;
  at: number;
}

export function markPending(storage: StorageLike, p: PendingLogout): void {
  storage.set(PENDING_KEY, JSON.stringify({ sessionId: p.sessionId, name: p.name, scope: p.scope, at: p.at }));
}

/** 돌아왔을 때 할 일이 10분 안이면 돌려준다. 늘 지운다(한 번만). 모양이 틀리면 버린다 */
export function takePending(storage: StorageLike, now: number): PendingLogout | null {
  const v = storage.get(PENDING_KEY);
  storage.remove(PENDING_KEY);
  if (v === null) return null;
  try {
    const p = JSON.parse(v) as Partial<PendingLogout>;
    if (typeof p.sessionId !== 'string' || typeof p.name !== 'string' || typeof p.at !== 'number' || (p.scope !== 'device' && p.scope !== 'others')) return null;
    if (!(p.at <= now && now - p.at <= PENDING_TTL_MS)) return null;
    return { sessionId: p.sessionId, name: p.name, scope: p.scope, at: p.at };
  } catch {
    return null;
  }
}

/** 원격 로그아웃 표시와 탈퇴 재인증 표시(남긴 시각)가 함께 있으면 나중에 남긴 쪽만 잇는다 */
export function chooseReturn(device: PendingLogout | null, withdrawAt: number | null): 'device' | 'withdraw' | null {
  if (device && withdrawAt !== null) return device.at > withdrawAt ? 'device' : 'withdraw';
  if (device) return 'device';
  return withdrawAt !== null ? 'withdraw' : null;
}

/**
 * [로그아웃]의 재인증으로 떠나기: 제공자를 정하고(모르면 로그인 수단 목록의 첫 제공자) 액세스 토큰을 갱신한 뒤, 표시를 남기고 재인증 양식을 보낸다.
 * 갱신이 401이면 login, 그 밖의 실패면 retry다. 그사이 창을 닫았으면(cancelled) 떠나지 않는다(탈퇴 흐름의 leaveForReauth와 같은 규칙)
 */
export async function leaveForDeviceReauth(o: {
  api: Pick<DevicesApi, 'refresh'>;
  storage: StorageLike;
  now: () => number;
  provider: Provider | null;
  pickProvider: () => Promise<Provider | null>;
  target: { sessionId: string; name: string; scope: LogoutScope };
  submit: (provider: Provider) => void;
  cancelled: () => boolean;
}): Promise<'left' | 'login' | 'retry' | 'cancelled' | 'no-provider'> {
  const provider = o.provider ?? (await o.pickProvider());
  if (o.cancelled()) return 'cancelled';
  if (!provider) return 'no-provider';
  const r = await o.api.refresh();
  if (o.cancelled()) return 'cancelled';
  if (r === 'rejected') return 'login';
  if (r !== 'ok') return 'retry';
  markPending(o.storage, { sessionId: o.target.sessionId, name: o.target.name, scope: o.target.scope, at: o.now() });
  o.submit(provider);
  return 'left';
}
