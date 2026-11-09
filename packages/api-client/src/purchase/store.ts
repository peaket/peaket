// 구매 세션 키 저장(docs/frontend.md §3.12 IndexedDB `peaket-purchase` 행, ADR-0221 결정 3). 판 1, 표 `sessions`(키 jti).
// 값: 요청 인증 키(HMAC CryptoKey, 추출 불가 — IndexedDB가 구조 복제로 그대로 두고 꺼내도 추출 불가다), 일련번호, 만료(밀리초), 보낸 클라이언트 공개키.
// 입장 토큰은 두지 않는다(화면이 입장 저장값에서 읽어 넘긴다). Node 시험과 세 엔진 검사가 같은 꼴을 보도록 메모리 판을 함께 둔다.

export const PURCHASE_DB = 'peaket-purchase';
const VERSION = 1;
const TABLE = 'sessions';

export interface PurchaseRecord {
  jti: string;
  key: CryptoKey;
  /** 마지막으로 쓴 일련번호(처음 0, 서명할 때마다 1 올린다) */
  seq: number;
  /** 만료(Unix 밀리초) */
  exp: number;
  /** 첫 사용(스냅샷 머리·자동 배정 홀드 본문)에 보내는 클라이언트 임시 공개키(비압축 점 base64url) */
  clientPublicKey: string;
}

export interface PurchaseStore {
  get(jti: string): Promise<PurchaseRecord | undefined>;
  /** 없을 때만 넣고, 이미 있으면 있는 것을 돌려준다(두 탭이 같이 열어도 키는 하나다) */
  putIfAbsent(rec: PurchaseRecord): Promise<PurchaseRecord>;
  /** 일련번호를 1 올려 두고 올린 값을 돌려준다(한 트랜잭션). 항목이 없으면 undefined(세션이 끝났다) */
  nextSeq(jti: string): Promise<number | undefined>;
  delete(jti: string): Promise<void>;
  /** 만료가 nowMs 이하인 항목을 지운다 */
  sweep(nowMs: number): Promise<void>;
  clear(): Promise<void>;
  all(): Promise<PurchaseRecord[]>;
}

export function memoryStore(): PurchaseStore {
  const m = new Map<string, PurchaseRecord>();
  const copy = (r: PurchaseRecord): PurchaseRecord => ({ ...r });
  return {
    get: async (jti) => (m.has(jti) ? copy(m.get(jti)!) : undefined),
    putIfAbsent: async (rec) => {
      if (!m.has(rec.jti)) m.set(rec.jti, copy(rec));
      return copy(m.get(rec.jti)!);
    },
    nextSeq: async (jti) => {
      const r = m.get(jti);
      if (!r) return undefined;
      r.seq += 1;
      return r.seq;
    },
    delete: async (jti) => void m.delete(jti),
    sweep: async (nowMs) => {
      for (const [k, r] of m) if (r.exp <= nowMs) m.delete(k);
    },
    clear: async () => m.clear(),
    all: async () => [...m.values()].map(copy).sort((a, b) => (a.jti < b.jti ? -1 : 1)),
  };
}

const req = <T>(r: IDBRequest<T>) =>
  new Promise<T>((ok, no) => {
    r.onsuccess = () => ok(r.result);
    r.onerror = () => no(r.error);
  });

const done = (tx: IDBTransaction) =>
  new Promise<void>((ok, no) => {
    tx.oncomplete = () => ok();
    tx.onerror = () => no(tx.error);
    tx.onabort = () => no(tx.error ?? new DOMException('트랜잭션이 끊겼다', 'AbortError'));
  });

/** IndexedDB 판. 열 때마다 DB를 열고 닫는다(다른 탭의 판 올리기·지우기를 막지 않게) */
export function indexedDbStore(idb: IDBFactory = indexedDB): PurchaseStore {
  async function open(): Promise<IDBDatabase> {
    const r = idb.open(PURCHASE_DB, VERSION);
    r.onupgradeneeded = () => {
      if (!r.result.objectStoreNames.contains(TABLE)) r.result.createObjectStore(TABLE, { keyPath: 'jti' });
    };
    const db = await req(r);
    // 다른 탭이 DB를 지우거나(로그아웃) 판을 올리면 닫아 비켜 준다
    db.onversionchange = () => db.close();
    return db;
  }
  async function tx<T>(mode: IDBTransactionMode, work: (s: IDBObjectStore) => Promise<T>): Promise<T> {
    const db = await open();
    try {
      const t = db.transaction(TABLE, mode);
      const finished = done(t);
      // work가 먼저 실패하면 아무도 finished를 기다리지 않는다(처리되지 않은 거절로 오류 수집에 잡음이 들어가지 않게 한다)
      finished.catch(() => undefined);
      const out = await work(t.objectStore(TABLE));
      await finished;
      return out;
    } finally {
      db.close();
    }
  }
  return {
    get: (jti) => tx('readonly', (s) => req(s.get(jti) as IDBRequest<PurchaseRecord | undefined>)),
    putIfAbsent: (rec) =>
      tx('readwrite', async (s) => {
        const have = await req(s.get(rec.jti) as IDBRequest<PurchaseRecord | undefined>);
        if (have) return have;
        await req(s.add(rec));
        return rec;
      }),
    nextSeq: (jti) =>
      tx('readwrite', async (s) => {
        const have = await req(s.get(jti) as IDBRequest<PurchaseRecord | undefined>);
        if (!have) return undefined;
        const seq = have.seq + 1;
        await req(s.put({ ...have, seq }));
        return seq;
      }),
    delete: (jti) => tx('readwrite', async (s) => void (await req(s.delete(jti)))),
    sweep: (nowMs) =>
      tx('readwrite', async (s) => {
        const rows = await req(s.getAll() as IDBRequest<PurchaseRecord[]>);
        for (const r of rows) if (r.exp <= nowMs) await req(s.delete(r.jti));
      }),
    clear: () => tx('readwrite', async (s) => void (await req(s.clear()))),
    all: () => tx('readonly', (s) => req(s.getAll() as IDBRequest<PurchaseRecord[]>)),
  };
}
