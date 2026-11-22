// 대기실 로그아웃(docs/frontend.md §5.14.4, §3.12 '지우는 때'의 로그아웃, ADR-0208 결정 7).
// 2번: 서버 응답을 기다리지 않고 이름으로 지울 수 있는 저장물을 지운다. 3번: 고르면 월렛 저장소·서비스 워커·캐시. 4번: 다른 탭에 logout.
// 서버 로그아웃은 같은 출처 POST /logout을 fetch로 보낸다(폼이 아니라서 대기실 CSP A′의 form-action을 바꾸지 않는다).
// 지우는 목록은 소비자 웹 루틴과 같은 모듈(apps/web/src/features/session-cleanup/keys.ts)을 상대 경로로 가져와 갈라지지 않게 한다(ADR-0363 결정 8).
// 웹 푸시 구독 풀기(2번 맨 앞, 서버 로그아웃보다 먼저)는 부르는 쪽이 pushUnbind로 넘긴다(main.ts).
import {
  isLogoutKey,
  isWalletCache,
  isWalletScope,
  LOGOUT_DATABASES,
  LOGOUT_LOCAL_KEYS,
  LOGOUT_LOCAL_PREFIXES,
  LOGOUT_SESSION_KEYS,
  LOGOUT_SESSION_PREFIXES,
  WALLET_DATABASE,
} from '../../../src/features/session-cleanup/keys.ts';

export interface EnumerableKV {
  getItem(k: string): string | null;
  removeItem(k: string): void;
  key(i: number): string | null;
  readonly length: number;
}

export interface LogoutDeps {
  local: EnumerableKV | null;
  session: EnumerableKV | null;
  idb: { deleteDatabase(name: string): unknown } | null;
  caches: { keys(): Promise<string[]>; delete(name: string): Promise<boolean> } | null;
  serviceWorker: { getRegistrations(): Promise<readonly { scope: string; unregister(): Promise<boolean> }[]> } | null;
  broadcast(channel: string, msg: string): void;
  /** 웹 푸시 해제 DELETE(로그아웃한 탭만). 던지지 않는다 */
  pushUnbind?: () => Promise<unknown>;
}


const quiet = async (f: () => unknown): Promise<void> => {
  try {
    await f();
  } catch {
    /* 지우지 못한 것은 넘기고 나머지를 지운다 */
  }
};

function clearKV(kv: EnumerableKV | null, prefixes: readonly string[], keys: readonly string[]): void {
  if (!kv) return;
  const names: string[] = [];
  for (let i = 0; i < kv.length; i++) {
    const k = kv.key(i);
    if (k !== null && isLogoutKey(k, prefixes, keys)) names.push(k);
  }
  for (const k of names) kv.removeItem(k);
}

export async function clearForLogout(d: LogoutDeps, o: { wallet: boolean }): Promise<void> {
  if (d.pushUnbind) await quiet(() => d.pushUnbind?.());
  await quiet(() => clearKV(d.local, LOGOUT_LOCAL_PREFIXES, LOGOUT_LOCAL_KEYS));
  await quiet(() => clearKV(d.session, LOGOUT_SESSION_PREFIXES, LOGOUT_SESSION_KEYS));
  for (const db of LOGOUT_DATABASES) await quiet(() => d.idb?.deleteDatabase(db));
  if (o.wallet) {
    await quiet(() => d.idb?.deleteDatabase(WALLET_DATABASE));
    await quiet(async () => {
      // 월렛 워커 범위는 끝 `/` 없는 /my/tickets다(ADR-0363 결정 5). 웹 푸시 워커(/push/)는 풀지 않는다
      for (const r of (await d.serviceWorker?.getRegistrations()) ?? []) if (isWalletScope(r.scope)) await r.unregister();
    });
    await quiet(async () => {
      for (const k of (await d.caches?.keys()) ?? []) if (isWalletCache(k)) await d.caches?.delete(k);
    });
  }
  await quiet(() => d.broadcast('peaket.session', 'logout'));
}

type FetchLike = (url: string, init: RequestInit) => Promise<Pick<Response, 'type' | 'status' | 'ok'>>;

/** 같은 출처 POST /logout. 이동(opaqueredirect)이나 2xx면 'ok', 그 밖(503·403·연결 실패)은 'failed' */
export async function serverLogout(fetchImpl: FetchLike, url: string): Promise<'ok' | 'failed'> {
  try {
    const r = await fetchImpl(url, { method: 'POST', credentials: 'same-origin', redirect: 'manual', mode: 'same-origin', cache: 'no-store' });
    return r.type === 'opaqueredirect' || r.ok ? 'ok' : 'failed';
  } catch {
    return 'failed';
  }
}
