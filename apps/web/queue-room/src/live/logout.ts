// 대기실 로그아웃(docs/frontend.md §5.14.4, §3.12 '지우는 때'의 로그아웃, ADR-0208 결정 7).
// 2번: 서버 응답을 기다리지 않고 이름으로 지울 수 있는 저장물을 지운다. 3번: 고르면 월렛 저장소·서비스 워커·캐시. 4번: 다른 탭에 logout.
// 서버 로그아웃은 같은 출처 POST /logout을 fetch로 보낸다(폼이 아니라서 대기실 CSP A′의 form-action을 바꾸지 않는다).
// 웹 푸시 구독 풀기는 등록이 아직 없어 GAT-040이 루틴을 웹과 한 곳으로 모을 때 함께 쓴다.

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
}

/** 로그아웃 때 지우는 키(§3.12). 기기 ID·최근 검색어·흡수 표시(peaket.providers.merged)는 남긴다 */
const LOCAL_PREFIXES = ['peaket.queue.', 'peaket.autoassign.'];
const LOCAL_KEYS = ['peaket.clock', 'peaket.wishQueue'];
// 결제 초안(peaket.checkout.*)은 §5.14.4 2번의 '결제 초안'이다
const SESSION_PREFIXES = ['peaket.queue.', 'peaket.admission.', 'peaket.checkout.', 'peaket.hold.'];
const SESSION_KEYS = ['peaket.withdraw.reauth', 'peaket.providers.pending', 'peaket.verify.return'];
const DATABASES = ['peaket-purchase', 'peaket-push'];
const WALLET_DB = 'peaket-wallet';
const WALLET_SCOPE = '/my/tickets/';
const WALLET_CACHE = 'wallet-shell-';

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
    if (k !== null && (keys.includes(k) || prefixes.some((p) => k.startsWith(p)))) names.push(k);
  }
  for (const k of names) kv.removeItem(k);
}

export async function clearForLogout(d: LogoutDeps, o: { wallet: boolean }): Promise<void> {
  await quiet(() => clearKV(d.local, LOCAL_PREFIXES, LOCAL_KEYS));
  await quiet(() => clearKV(d.session, SESSION_PREFIXES, SESSION_KEYS));
  for (const db of DATABASES) await quiet(() => d.idb?.deleteDatabase(db));
  if (o.wallet) {
    await quiet(() => d.idb?.deleteDatabase(WALLET_DB));
    await quiet(async () => {
      for (const r of (await d.serviceWorker?.getRegistrations()) ?? []) {
        if (new URL(r.scope).pathname === WALLET_SCOPE) await r.unregister();
      }
    });
    await quiet(async () => {
      for (const k of (await d.caches?.keys()) ?? []) if (k.startsWith(WALLET_CACHE)) await d.caches?.delete(k);
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
