// 스캐너 기기 키와 스태프 토큰의 브라우저 저장소(offline-gate §6.1, docs/frontend.md §3.8).
// - 기기 키(CryptoKey, extractable=false)와 공개 JWK를 IndexedDB에 둔다. 개인키는 페이지 스크립트가 꺼낼 수 없다.
// - 스태프 토큰도 IndexedDB에 둔다. 로그인 화면(SCR-036)이 승인 뒤 이 함수로 저장한다.
// - 시험·Node 환경에는 IndexedDB가 없으므로 부르는 쪽이 오류를 잡아 퍼블리싱 모드로 남는다.
import type { DpopKey } from './dpop';

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

export async function loadStaffToken(): Promise<string | undefined> {
  try {
    const v = await withStore(SESSION_STORE, 'readonly', async (s) => (await requestDone(s.get(STAFF_TOKEN))) as string | undefined);
    if (v) return v;
  } catch {
    // IndexedDB가 없는 시험 환경은 세션 저장소로 떨어진다
  }
  try {
    return sessionStorage.getItem('peaket.scanner.staff-token') ?? undefined;
  } catch {
    return undefined;
  }
}

export async function saveStaffToken(token: string): Promise<void> {
  try {
    sessionStorage.setItem('peaket.scanner.staff-token', token);
  } catch {
    // 세션 저장소가 막혀도 IndexedDB에 남긴다
  }
  await withStore(SESSION_STORE, 'readwrite', async (s) => {
    s.put(token, STAFF_TOKEN);
    return undefined;
  });
}

export async function clearStaffToken(): Promise<void> {
  try {
    sessionStorage.removeItem('peaket.scanner.staff-token');
  } catch {
    // ignore
  }
  await withStore(SESSION_STORE, 'readwrite', async (s) => {
    s.delete(STAFF_TOKEN);
    return undefined;
  });
}
