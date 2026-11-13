// 스캐너 스캔 큐 저장소(docs/frontend.md §3.8, docs/features/offline-gate.md §6.5, BUILD_ORDER GAT-150).
// 정본은 Dexie DB `peaket-scanner-queue`(판 1)와 `chromeTransactionDurability: 'strict'`다.
// 이 작업 트리에는 Dexie 4가 설치되어 있지 않아 같은 계약을 브라우저 IndexedDB로 직접 구현했다:
// - DB를 `peaket-scanner-queue`로 따로 열고, 쓰기 트랜잭션을 `durability: 'strict'`로 연다.
// - put은 트랜잭션 complete 뒤에 끝난다. 그래서 통과 화면은 이 약속이 끝난 뒤에 띄운다.
// - IndexedDB가 없는 시험 환경은 MemoryScanQueue를 쓴다. 브라우저에서 DB를 열지 못하면
//   조용히 메모리로 떨어지지 않고 오류를 낸다(통과 화면의 내구성 약속을 지키기 위해서다).
// Dexie로 바꾸는 일은 의존성 설치가 가능할 때 어댑터만 바꾸면 된다(포트는 ScanQueue다).

export const SCAN_QUEUE_DB_NAME = 'peaket-scanner-queue';
export const SCAN_QUEUE_DB_VERSION = 1;
export const SCAN_QUEUE_STORE = 'scanQueue';
export const SCAN_QUEUE_INDEX = 'nextAttemptAtMs';
/** 스캔 큐 쓰기 트랜잭션의 내구성. 정본은 strict다(frontend §3.8) */
export const SCAN_QUEUE_TX_OPTIONS: IDBTransactionOptions = { durability: 'strict' };

/** 큐에 먼저 쓰는 스캔 기록. 업로드가 끝나면 지운다 */
export interface ScanQueueRecord {
  /** UUIDv7(스캔마다 하나) */
  readonly id: string;
  readonly eventId: string;
  readonly ticketId: string;
  readonly keyId: string;
  readonly scannedAtMs: number;
  /** gw-scanner `POST /v1/scanner/scans`에 실을 본문(JSON) */
  readonly payload: string;
  readonly attempts: number;
  readonly nextAttemptAtMs: number;
}

/** 스캔 큐 포트. IndexedDB 어댑터와 시험용 메모리 어댑터가 같은 계약을 지킨다 */
export interface ScanQueue {
  /** strict 쓰기 트랜잭션이 끝난 뒤에 끝난다 */
  put(record: ScanQueueRecord): Promise<void>;
  /** nextAttemptAtMs ≤ nowMs인 기록을 차례대로 limit개 */
  due(nowMs: number, limit: number): Promise<ScanQueueRecord[]>;
  /** 업로드가 끝난 기록을 지운다 */
  ack(id: string): Promise<void>;
  /** 실패한 기록의 attempts를 1 올리고 다음 시각을 적는다 */
  fail(id: string, nextAttemptAtMs: number): Promise<void>;
  count(): Promise<number>;
}

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

function openDatabase(): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(SCAN_QUEUE_DB_NAME, SCAN_QUEUE_DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      const store = db.objectStoreNames.contains(SCAN_QUEUE_STORE)
        ? req.transaction!.objectStore(SCAN_QUEUE_STORE)
        : db.createObjectStore(SCAN_QUEUE_STORE, { keyPath: 'id' });
      if (!store.indexNames.contains(SCAN_QUEUE_INDEX)) store.createIndex(SCAN_QUEUE_INDEX, 'nextAttemptAtMs');
    };
    req.onblocked = () => reject(new Error('다른 탭이 스캔 큐 DB를 닫지 않아 열지 못했다'));
    req.onsuccess = () => {
      const db = req.result;
      // 다른 탭이 판을 올릴 때 이 연결이 막지 않게 닫는다.
      db.onversionchange = () => db.close();
      resolve(db);
    };
    req.onerror = () => reject(req.error ?? new Error('스캔 큐 DB를 열지 못했다'));
  });
}

/** 브라우저 IndexedDB 어댑터. DB를 따로 열고 쓰기를 strict로 연다 */
export class IndexedDbScanQueue implements ScanQueue {
  readonly #db: IDBDatabase;

  private constructor(db: IDBDatabase) {
    this.#db = db;
  }

  static async open(): Promise<IndexedDbScanQueue> {
    return new IndexedDbScanQueue(await openDatabase());
  }

  async put(record: ScanQueueRecord): Promise<void> {
    const tx = this.#db.transaction(SCAN_QUEUE_STORE, 'readwrite', SCAN_QUEUE_TX_OPTIONS);
    tx.objectStore(SCAN_QUEUE_STORE).put(record);
    await transactionDone(tx);
  }

  async due(nowMs: number, limit: number): Promise<ScanQueueRecord[]> {
    if (!Number.isInteger(limit) || limit < 1) throw new RangeError(`limit은 1 이상 정수여야 한다: ${limit}`);
    const tx = this.#db.transaction(SCAN_QUEUE_STORE, 'readonly');
    const rows = await requestDone(
      tx.objectStore(SCAN_QUEUE_STORE).index(SCAN_QUEUE_INDEX).getAll(IDBKeyRange.upperBound(nowMs), limit) as IDBRequest<ScanQueueRecord[]>,
    );
    return rows.sort((a, b) => a.nextAttemptAtMs - b.nextAttemptAtMs || a.scannedAtMs - b.scannedAtMs);
  }

  async ack(id: string): Promise<void> {
    const tx = this.#db.transaction(SCAN_QUEUE_STORE, 'readwrite', SCAN_QUEUE_TX_OPTIONS);
    tx.objectStore(SCAN_QUEUE_STORE).delete(id);
    await transactionDone(tx);
  }

  async fail(id: string, nextAttemptAtMs: number): Promise<void> {
    const tx = this.#db.transaction(SCAN_QUEUE_STORE, 'readwrite', SCAN_QUEUE_TX_OPTIONS);
    const store = tx.objectStore(SCAN_QUEUE_STORE);
    const row = await requestDone(store.get(id) as IDBRequest<ScanQueueRecord | undefined>);
    if (row) store.put({ ...row, attempts: row.attempts + 1, nextAttemptAtMs });
    await transactionDone(tx);
  }

  async count(): Promise<number> {
    const tx = this.#db.transaction(SCAN_QUEUE_STORE, 'readonly');
    return requestDone(tx.objectStore(SCAN_QUEUE_STORE).count());
  }

  close(): void {
    this.#db.close();
  }
}

/** 시험·IndexedDB 없는 환경의 큐. 운영 저장으로 쓰지 않는다 */
export class MemoryScanQueue implements ScanQueue {
  readonly #rows = new Map<string, ScanQueueRecord>();

  async put(record: ScanQueueRecord): Promise<void> {
    this.#rows.set(record.id, record);
  }

  async due(nowMs: number, limit: number): Promise<ScanQueueRecord[]> {
    if (!Number.isInteger(limit) || limit < 1) throw new RangeError(`limit은 1 이상 정수여야 한다: ${limit}`);
    return [...this.#rows.values()]
      .filter((r) => r.nextAttemptAtMs <= nowMs)
      .sort((a, b) => a.nextAttemptAtMs - b.nextAttemptAtMs || a.scannedAtMs - b.scannedAtMs)
      .slice(0, limit);
  }

  async ack(id: string): Promise<void> {
    this.#rows.delete(id);
  }

  async fail(id: string, nextAttemptAtMs: number): Promise<void> {
    const row = this.#rows.get(id);
    if (row) this.#rows.set(id, { ...row, attempts: row.attempts + 1, nextAttemptAtMs });
  }

  async count(): Promise<number> {
    return this.#rows.size;
  }
}

/** 브라우저면 IndexedDB, 시험(Node)이면 메모리. 브라우저에서 열지 못하면 오류를 낸다 */
export async function openScanQueue(): Promise<ScanQueue> {
  if (typeof indexedDB === 'undefined') {
    // Node 시험에는 브라우저 저장소가 없다. 화면·Worker가 있는 곳에서는 메모리로 숨기지 않는다.
    if (typeof window === 'undefined' && typeof self === 'undefined') return new MemoryScanQueue();
    throw new Error('이 환경에서는 IndexedDB를 쓸 수 없어 스캔 기록을 안전하게 저장할 수 없다');
  }
  return IndexedDbScanQueue.open();
}
