// 소비자 웹 로그아웃 정리 루틴(docs/frontend.md §5.14.4, ADR-0363 결정 8, FE-T43·FE-T47, ASVS 14.3.1).
// 부르는 자리 셋: 셸 대화상자의 [로그아웃](서버 로그아웃까지), 탈퇴 완료(204·202 직후), 계정 흡수(확정 202의 requesterRole MERGED, 흡수 안내로 떠나기 직전).
// 탈퇴·흡수는 서버가 이미 세션을 끝냈으므로 서버 로그아웃을 보내지 않는다(server: false).
// 차례: 2번 웹 푸시 해제 DELETE를 먼저(실패해도 이어 감) → §3.12 '로그아웃' 값 지우기 → 3번(체크했을 때만: peaket-wallet·월렛 워커 등록·월렛 캐시.
// `/push/` 등록은 풀지 않는다) → 4번 BroadcastChannel('peaket.session')의 logout → 서버 로그아웃(같은 출처 fetch POST /logout, redirect: 'manual').
// 다른 탭은 logout을 받으면 2번(웹 푸시 해제 없이 저장물 지우기)만 하고(3번은 그 탭이 고르지 않았다) 로그인 화면으로 간다(onSessionLogout).
// 바깥 의존(저장소·IDB·캐시·워커·채널·fetch·웹 푸시 해제)은 주입한다(시험·연결 시험이 같은 모양으로 부른다). 브라우저 조립은 browser.ts다.
import {
  isLogoutKey,
  isWalletCache,
  isWalletScope,
  LOGOUT_DATABASES,
  LOGOUT_LOCAL_KEYS,
  LOGOUT_LOCAL_PREFIXES,
  LOGOUT_MESSAGE,
  LOGOUT_SESSION_KEYS,
  LOGOUT_SESSION_PREFIXES,
  SESSION_CHANNEL,
  WALLET_DATABASE,
} from './keys.ts';

export interface EnumerableStorage {
  getItem(k: string): string | null;
  removeItem(k: string): void;
  key(i: number): string | null;
  readonly length: number;
}

export interface CleanupDeps {
  local: EnumerableStorage | null;
  session: EnumerableStorage | null;
  idb: { deleteDatabase(name: string): unknown } | null;
  caches: { keys(): Promise<string[]>; delete(name: string): Promise<boolean> } | null;
  serviceWorker: { getRegistrations(): Promise<readonly { scope: string; unregister(): Promise<boolean> }[]> } | null;
  /** 다른 탭에 알린다(BroadcastChannel). 다른 탭이 받아 부를 때는 넘기지 않는다 */
  broadcast?: (channel: string, message: string) => void;
  /** 웹 푸시 해제(features/web-push createWebPush().unbind). 던지지 않는다 */
  pushUnbind?: () => Promise<unknown>;
  /** 같은 출처 fetch(서버 로그아웃) */
  fetch?: (url: string, init: RequestInit) => Promise<Pick<Response, 'type' | 'status' | 'ok'>>;
  /** 서버 로그아웃 주소(기본 /logout) */
  logoutUrl?: string;
}

export interface CleanupOptions {
  /** 3번: '이 기기의 입장 키도 지우기'를 골랐다 */
  wallet: boolean;
  /** 서버 로그아웃을 보낸다(셸 대화상자). 탈퇴·흡수는 false */
  server: boolean;
}

export interface CleanupResult {
  push: 'done' | 'skipped';
  /** 서버 로그아웃: ok(이동·2xx) · failed(503·연결 실패 → 대화상자 안 다시 시도) · skipped */
  server: 'ok' | 'failed' | 'skipped';
}

const quiet = async (f: () => unknown): Promise<void> => {
  try {
    await f();
  } catch {
    // 지우지 못한 것은 넘기고 나머지를 지운다
  }
};

function clearStorage(s: EnumerableStorage | null, prefixes: readonly string[], keys: readonly string[]): void {
  if (!s) return;
  const names: string[] = [];
  for (let i = 0; i < s.length; i += 1) {
    const k = s.key(i);
    if (k !== null && isLogoutKey(k, prefixes, keys)) names.push(k);
  }
  for (const k of names) s.removeItem(k);
}

/** 2번의 저장물 지우기(웹 푸시 해제 제외). 다른 탭도 이것을 한다 */
export async function clearLogoutStorage(d: Pick<CleanupDeps, 'local' | 'session' | 'idb'>): Promise<void> {
  await quiet(() => clearStorage(d.local, LOGOUT_LOCAL_PREFIXES, LOGOUT_LOCAL_KEYS));
  await quiet(() => clearStorage(d.session, LOGOUT_SESSION_PREFIXES, LOGOUT_SESSION_KEYS));
  for (const db of LOGOUT_DATABASES) await quiet(() => d.idb?.deleteDatabase(db));
}

/** 3번: peaket-wallet·월렛 워커 등록(범위 /my/tickets)·월렛 캐시. 웹 푸시 워커(/push/) 등록은 풀지 않는다 */
export async function clearWalletStorage(d: Pick<CleanupDeps, 'idb' | 'caches' | 'serviceWorker'>): Promise<void> {
  await quiet(() => d.idb?.deleteDatabase(WALLET_DATABASE));
  await quiet(async () => {
    for (const r of (await d.serviceWorker?.getRegistrations()) ?? []) if (isWalletScope(r.scope)) await r.unregister();
  });
  await quiet(async () => {
    for (const k of (await d.caches?.keys()) ?? []) if (isWalletCache(k)) await d.caches?.delete(k);
  });
}

/** 같은 출처 POST /logout. 이동(opaqueredirect)이나 2xx면 ok, 그 밖(503·403·연결 실패)은 failed */
export async function serverLogout(fetchImpl: NonNullable<CleanupDeps['fetch']>, url = '/logout'): Promise<'ok' | 'failed'> {
  try {
    const r = await fetchImpl(url, { method: 'POST', credentials: 'same-origin', redirect: 'manual', mode: 'same-origin', cache: 'no-store' });
    return r.type === 'opaqueredirect' || r.ok ? 'ok' : 'failed';
  } catch {
    return 'failed';
  }
}

/**
 * 로그아웃 정리 루틴(§5.14.4 2~4번과 서버 로그아웃). 저장물은 서버 응답을 기다리지 않고 먼저 지운다.
 * 웹 푸시 DELETE는 서버 로그아웃보다 먼저 보낸다(로그아웃 뒤에는 쿠키가 없어 서버가 계정의 구독인지 확인할 수 없다)
 */
export async function runLogoutCleanup(d: CleanupDeps, o: CleanupOptions): Promise<CleanupResult> {
  let push: CleanupResult['push'] = 'skipped';
  if (d.pushUnbind) {
    await quiet(() => d.pushUnbind?.());
    push = 'done';
  }
  await clearLogoutStorage(d);
  if (o.wallet) await clearWalletStorage(d);
  await quiet(() => d.broadcast?.(SESSION_CHANNEL, LOGOUT_MESSAGE));
  if (!o.server || !d.fetch) return { push, server: 'skipped' };
  return { push, server: await serverLogout(d.fetch, d.logoutUrl ?? '/logout') };
}

/** 다른 탭이 보낸 logout인가 */
export const isLogoutMessage = (data: unknown): boolean => data === LOGOUT_MESSAGE;

/**
 * 다른 탭의 logout을 받았을 때: 2번 저장물만 지우고(월렛 키는 이 탭이 고르지 않았으므로 지우지 않는다, 웹 푸시 해제는 보낸 탭이 했다) 끝나면 then을 부른다
 */
export async function onSessionLogout(d: Pick<CleanupDeps, 'local' | 'session' | 'idb'>, then: () => void): Promise<void> {
  await clearLogoutStorage(d);
  then();
}
