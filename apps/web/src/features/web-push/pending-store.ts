// IndexedDB `peaket-push`의 `pending`(웹 푸시 '다시 등록 필요' 표시, docs/frontend.md §3.12, docs/features/notify.md §3.4).
// 웹 푸시 워커(`pushsubscriptionchange`)가 브라우저가 바꾼 새 구독을 적고, 로그인한 화면이 등록에 성공하면 지운다. 로그아웃 정리도 지운다.
// 워커 묶음에도 들어가므로 표준 IndexedDB API만 쓴다(Dexie를 쓰지 않는다). 액세스 토큰은 넣지 않는다.

export const PUSH_DB_NAME = 'peaket-push';
const STORE = 'kv';
const PENDING_KEY = 'pending';

/** 다시 등록할 구독(구독 주소·암호화 키·만료). 적은 시각을 함께 둔다 */
export interface PendingPushSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  expirationTime: number | null;
  at: number;
}

/** 화면·워커가 함께 쓰는 '다시 등록 필요' 저장소 모양. 시험은 메모리 구현을 넘긴다 */
export interface PendingPushStore {
  read(): Promise<PendingPushSubscription | undefined>;
  write(p: PendingPushSubscription): Promise<void>;
  clear(): Promise<void>;
}

function openDb(idb: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = idb.open(PUSH_DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('peaket-push를 열지 못했다'));
  });
}

async function run<T>(idb: IDBFactory, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb(idb);
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error ?? new Error('peaket-push 쓰기가 실패했다'));
      tx.onabort = () => reject(tx.error ?? new Error('peaket-push 쓰기가 멈췄다'));
    });
  } finally {
    db.close();
  }
}

const isPending = (v: unknown): v is PendingPushSubscription => {
  if (typeof v !== 'object' || v === null) return false;
  const p = v as Partial<PendingPushSubscription>;
  return typeof p.endpoint === 'string' && typeof p.keys?.p256dh === 'string' && typeof p.keys?.auth === 'string';
};

/** 표준 IndexedDB로 만든 저장소. IndexedDB가 없으면(사생활 보호 모드 등) 아무것도 남기지 않는다 */
export function indexedDbPendingStore(idb: IDBFactory | undefined = typeof indexedDB === 'undefined' ? undefined : indexedDB): PendingPushStore {
  return {
    async read() {
      if (!idb) return undefined;
      try {
        const v = await run<unknown>(idb, 'readonly', (s) => s.get(PENDING_KEY));
        return isPending(v) ? v : undefined;
      } catch {
        return undefined;
      }
    },
    async write(p) {
      if (!idb) return;
      await run(idb, 'readwrite', (s) => s.put(p, PENDING_KEY));
    },
    async clear() {
      if (!idb) return;
      try {
        await run(idb, 'readwrite', (s) => s.delete(PENDING_KEY));
      } catch {
        // 지우지 못하면 다음 등록 때 다시 지운다
      }
    },
  };
}
