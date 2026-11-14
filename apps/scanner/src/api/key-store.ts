// 스캐너 기기 키와 스태프 토큰의 브라우저 저장소(offline-gate §6.1, docs/frontend.md §3.8).
// - 기기 키(CryptoKey, extractable=false)와 공개 JWK를 IndexedDB에 둔다. 개인키는 페이지 스크립트가 꺼낼 수 없다.
// - 스태프 토큰도 IndexedDB에 둔다. 로그인 화면(SCR-036)이 승인 뒤 이 함수로 저장한다.
// - 시험·Node 환경에는 IndexedDB가 없으므로 부르는 쪽이 오류를 잡아 퍼블리싱 모드로 남는다.
import { generateDpopKey, type DpopKey } from './dpop.ts';

const DB_NAME = 'peaket-scanner-auth';
const DB_VERSION = 1;
const KEY_STORE = 'keys';
const SESSION_STORE = 'session';
const DEVICE_KEY = 'device';
const STAFF_TOKEN = 'staff-token';

function requestDone<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB 요청이 실패했다'));
  });
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB 트랜잭션이 실패했다'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB 트랜잭션이 취소됐다'));
  });
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(KEY_STORE)) db.createObjectStore(KEY_STORE);
      if (!db.objectStoreNames.contains(SESSION_STORE)) db.createObjectStore(SESSION_STORE);
    };
    req.onblocked = () => reject(new Error('다른 탭이 스캐너 인증 DB를 닫지 않아 열지 못했다'));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('스캐너 인증 DB를 열지 못했다'));
  });
}

async function withStore<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => Promise<T>): Promise<T> {
  const db = await openDb();
  try {
    const tx = db.transaction(store, mode);
    const value = await fn(tx.objectStore(store));
    await transactionDone(tx);
    return value;
  } finally {
    db.close();
  }
}

export async function loadDeviceKey(): Promise<DpopKey | undefined> {
  return withStore(KEY_STORE, 'readonly', async (s) => (await requestDone(s.get(DEVICE_KEY))) as DpopKey | undefined);
}

export async function saveDeviceKey(key: DpopKey): Promise<void> {
  await withStore(KEY_STORE, 'readwrite', async (s) => {
    s.put(key, DEVICE_KEY);
    return undefined;
  });
}

/** 기기 키가 없으면 만들어 저장한다(로그인·등록 모두 같은 키를 쓴다) */
export async function ensureDeviceKey(): Promise<DpopKey> {
  const existing = await loadDeviceKey();
  if (existing) return existing;
  const created = await generateDpopKey();
  await saveDeviceKey(created);
  return created;
}

/** 스태프 토큰과 만료 시각(ms). 토큰 응답의 expires_in을 저장한다 */
export interface StaffSession {
  token: string;
  expiresAtMs: number;
}

const SESSION_KEY = 'peaket.scanner.staff-token';
/** 만료를 모르는 옛 저장값(문자열)은 만료 없음으로 읽는다 */
const NO_EXPIRY = Number.MAX_SAFE_INTEGER;

function sessionOf(v: unknown): StaffSession | undefined {
  if (typeof v === 'string' && v !== '') return { token: v, expiresAtMs: NO_EXPIRY };
  if (v && typeof v === 'object') {
    const r = v as Record<string, unknown>;
    if (typeof r.token === 'string' && r.token !== '' && typeof r.expiresAtMs === 'number' && Number.isFinite(r.expiresAtMs)) {
      return { token: r.token, expiresAtMs: r.expiresAtMs };
    }
  }
  return undefined;
}

/** 저장값(JSON 객체 또는 옛 문자열 토큰)을 세션으로 읽는다 */
export function parseStoredSession(raw: string | null): StaffSession | undefined {
  if (!raw) return undefined;
  try {
    return sessionOf(JSON.parse(raw));
  } catch {
    return sessionOf(raw);
  }
}

/** 만료 경계. 정확히 만료 시각이면 만료다(재로그인) */
export function sessionExpired(session: StaffSession, nowMs: number): boolean {
  return session.expiresAtMs <= nowMs;
}

/** 저장된 스태프 세션. 만료됐으면 지우고 undefined를 준다(재로그인) */
export async function loadStaffSession(nowMs = Date.now()): Promise<StaffSession | undefined> {
  let stored: StaffSession | undefined;
  try {
    stored = sessionOf(await withStore(SESSION_STORE, 'readonly', async (s) => requestDone(s.get(STAFF_TOKEN))));
  } catch {
    // IndexedDB가 없는 시험 환경은 세션 저장소로 떨어진다
  }
  if (!stored) {
    try {
      stored = parseStoredSession(sessionStorage.getItem(SESSION_KEY));
    } catch {
      stored = undefined;
    }
  }
  if (!stored) return undefined;
  if (sessionExpired(stored, nowMs)) {
    await clearStaffToken();
    return undefined;
  }
  return stored;
}

export async function loadStaffToken(nowMs = Date.now()): Promise<string | undefined> {
  return (await loadStaffSession(nowMs))?.token;
}

export async function saveStaffSession(session: StaffSession): Promise<void> {
  try {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
  } catch {
    // 세션 저장소가 막혀도 IndexedDB에 남긴다
  }
  await withStore(SESSION_STORE, 'readwrite', async (s) => {
    s.put(session, STAFF_TOKEN);
    return undefined;
  });
}

/** 만료를 모르면 만료 없음으로 저장한다(옛 호출자 호환) */
export async function saveStaffToken(token: string, expiresAtMs = NO_EXPIRY): Promise<void> {
  await saveStaffSession({ token, expiresAtMs });
}

export async function clearStaffToken(): Promise<void> {
  try {
    sessionStorage.removeItem(SESSION_KEY);
  } catch {
    // ignore
  }
  await withStore(SESSION_STORE, 'readwrite', async (s) => {
    s.delete(STAFF_TOKEN);
    return undefined;
  });
}
