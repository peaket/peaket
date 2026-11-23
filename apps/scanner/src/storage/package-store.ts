// 스캐너 회차 목록 저장소(offline-gate §6.4, docs/frontend.md §3.8 '회차 목록 저장', 계획 §3).
// - 브라우저 IndexedDB `peaket-scanner`(판 1): meta·tickets·keys·revoked·entryState·cursor.
// - 스캔 큐는 따로 `peaket-scanner-queue`(strict)다. 여기는 목록·입장 상태만 둔다.
// - Node 시험은 MemoryPackageStore를 쓴다. 브라우저에서 DB를 열지 못하면 메모리로 숨기지 않고 던진다.
// - 관람객 이름·연락처 칸은 두지 않는다(ASVS 14.3.3).
import type { EntryState, PackageState, Placement, StoredTicket } from './package-state.ts';

export const SCANNER_DB_NAME = 'peaket-scanner';
export const SCANNER_DB_VERSION = 1;

const META = 'meta';
const TICKETS = 'tickets';
const KEYS = 'keys';
const REVOKED = 'revoked';
const ENTRY_STATE = 'entryState';
const CURSOR = 'cursor';
const STORES = [META, TICKETS, KEYS, REVOKED, ENTRY_STATE, CURSOR] as const;

export interface DeviceMeta {
  deviceSeq: number;
  clockOffsetMs?: number;
  scannerSessionId?: string;
}

export interface PackageStore {
  load(): Promise<PackageState | undefined>;
  save(state: PackageState): Promise<void>;
  /** 1부터 하나씩. 올린 값을 쓴 뒤에 준다. 동시에 불러도 겹치지 않고 다시 열어도 이어진다 */
  nextDeviceSeq(): Promise<number>;
  meta(): Promise<DeviceMeta>;
  setMeta(patch: Partial<Omit<DeviceMeta, 'deviceSeq'>>): Promise<void>;
  clear(): Promise<void>;
}

/** 저장소 안의 meta 행. 기기 값과 회차 값(입장 정책·배치·벡터)을 한 행에 둔다 */
interface MetaRow extends DeviceMeta {
  event?: {
    eventId: string;
    reentryAllowed: boolean;
    gateZones: string[];
    placement: Placement;
    resyncRequired: boolean;
  };
}

interface CursorRow {
  eventId: string;
  lastSeq: number;
  versionVector: PackageState['versionVector'];
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
  if (typeof indexedDB === 'undefined') return Promise.reject(new Error('이 환경에는 IndexedDB가 없다'));
  return new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(SCANNER_DB_NAME, SCANNER_DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META);
      if (!db.objectStoreNames.contains(TICKETS)) db.createObjectStore(TICKETS, { keyPath: 'ticketId' });
      if (!db.objectStoreNames.contains(KEYS)) db.createObjectStore(KEYS, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(REVOKED)) db.createObjectStore(REVOKED, { keyPath: 'keyId' });
      if (!db.objectStoreNames.contains(ENTRY_STATE)) db.createObjectStore(ENTRY_STATE, { keyPath: 'ticketId' });
      if (!db.objectStoreNames.contains(CURSOR)) db.createObjectStore(CURSOR, { keyPath: 'eventId' });
    };
    req.onblocked = () => reject(new Error('다른 탭이 스캐너 목록 DB를 닫지 않아 열지 못했다'));
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    req.onerror = () => reject(req.error ?? new Error('스캐너 목록 DB를 열지 못했다'));
  });
}

/** 브라우저 IndexedDB 어댑터 */
export class IndexedDbPackageStore implements PackageStore {
  readonly #db: IDBDatabase;
  /** deviceSeq를 올리는 일은 한 번에 하나씩(동시에 불러도 같은 번호를 두 번 주지 않는다) */
  #seqChain: Promise<unknown> = Promise.resolve();

  private constructor(db: IDBDatabase) {
    this.#db = db;
  }

  static async open(): Promise<IndexedDbPackageStore> {
    return new IndexedDbPackageStore(await openDatabase());
  }

  #serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.#seqChain.then(fn, fn);
    this.#seqChain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  async load(): Promise<PackageState | undefined> {
    const tx = this.#db.transaction([META, TICKETS, REVOKED, ENTRY_STATE, CURSOR], 'readonly');
    const cursors = (await requestDone(tx.objectStore(CURSOR).getAll() as IDBRequest<CursorRow[]>)) ?? [];
    if (cursors.length === 0) return undefined;
    const cursor = cursors[0]!;
    const meta = (await requestDone(tx.objectStore(META).get(META) as IDBRequest<MetaRow | undefined>)) ?? { deviceSeq: 0 };
    const ticketRows = (await requestDone(tx.objectStore(TICKETS).getAll() as IDBRequest<StoredTicket[]>)) ?? [];
    const revokedRows = (await requestDone(tx.objectStore(REVOKED).getAll() as IDBRequest<{ keyId: string }[]>)) ?? [];
    const entryRows = (await requestDone(tx.objectStore(ENTRY_STATE).getAll() as IDBRequest<(EntryState & { ticketId: string })[]>)) ?? [];
    await transactionDone(tx);
    const event = meta.event;
    const tickets = new Map<string, StoredTicket>();
    for (const t of ticketRows) {
      tickets.set(t.ticketId, {
        ticketId: t.ticketId,
        gateZone: t.gateZone,
        seatLabel: t.seatLabel,
        status: t.status,
        statusVersion: t.statusVersion,
        keys: (t.keys ?? []).map((k) => ({ keyId: k.keyId, ...(k.publicKey !== undefined ? { publicKey: k.publicKey } : {}) })),
      });
    }
    const entries = new Map<string, EntryState>();
    for (const e of entryRows) entries.set(e.ticketId, { lastDirection: e.lastDirection, lastAtMs: e.lastAtMs, gateZone: e.gateZone, source: e.source });
    return {
      eventId: cursor.eventId,
      reentryAllowed: event?.reentryAllowed ?? false,
      gateZones: event?.gateZones ?? [],
      tickets,
      revoked: new Set(revokedRows.map((r) => r.keyId)),
      entries,
      lastSeq: cursor.lastSeq,
      versionVector: cursor.versionVector,
      placement: event?.placement ?? { gateZone: '', mode: 'IN', version: 0 },
      resyncRequired: event?.resyncRequired ?? false,
    };
  }

  async save(state: PackageState): Promise<void> {
    const tx = this.#db.transaction(STORES, 'readwrite');
    const metaStore = tx.objectStore(META);
    const old = (await requestDone(metaStore.get(META) as IDBRequest<MetaRow | undefined>)) ?? { deviceSeq: 0 };
    const meta: MetaRow = {
      ...old,
      event: {
        eventId: state.eventId,
        reentryAllowed: state.reentryAllowed,
        gateZones: [...state.gateZones],
        placement: state.placement,
        resyncRequired: state.resyncRequired,
      },
    };
    metaStore.put(meta, META);
    const tickets = tx.objectStore(TICKETS);
    const keys = tx.objectStore(KEYS);
    tickets.clear();
    keys.clear();
    for (const t of state.tickets.values()) {
      tickets.put({
        ticketId: t.ticketId,
        gateZone: t.gateZone,
        seatLabel: t.seatLabel,
        status: t.status,
        statusVersion: t.statusVersion,
        keys: t.keys.map((k) => ({ keyId: k.keyId, ...(k.publicKey !== undefined ? { publicKey: k.publicKey } : {}) })),
      });
      for (const k of t.keys) keys.put({ id: `${t.ticketId}:${k.keyId}`, ticketId: t.ticketId, keyId: k.keyId, ...(k.publicKey !== undefined ? { publicKey: k.publicKey } : {}) });
    }
    const revoked = tx.objectStore(REVOKED);
    revoked.clear();
    for (const keyId of state.revoked) revoked.put({ keyId });
    const entries = tx.objectStore(ENTRY_STATE);
    entries.clear();
    for (const [ticketId, e] of state.entries) entries.put({ ticketId, lastDirection: e.lastDirection, lastAtMs: e.lastAtMs, gateZone: e.gateZone, source: e.source });
    const cursor = tx.objectStore(CURSOR);
    cursor.clear();
    cursor.put({ eventId: state.eventId, lastSeq: state.lastSeq, versionVector: state.versionVector } satisfies CursorRow);
    await transactionDone(tx);
  }

  nextDeviceSeq(): Promise<number> {
    return this.#serial(async () => {
      const tx = this.#db.transaction(META, 'readwrite');
      const store = tx.objectStore(META);
      const old = (await requestDone(store.get(META) as IDBRequest<MetaRow | undefined>)) ?? { deviceSeq: 0 };
      const next = old.deviceSeq + 1;
      store.put({ ...old, deviceSeq: next }, META);
      await transactionDone(tx);
      return next;
    });
  }

  async meta(): Promise<DeviceMeta> {
    const tx = this.#db.transaction(META, 'readonly');
    const row = await requestDone(tx.objectStore(META).get(META) as IDBRequest<MetaRow | undefined>);
    await transactionDone(tx);
    return deviceMetaOf(row);
  }

  async setMeta(patch: Partial<Omit<DeviceMeta, 'deviceSeq'>>): Promise<void> {
    const tx = this.#db.transaction(META, 'readwrite');
    const store = tx.objectStore(META);
    const old = (await requestDone(store.get(META) as IDBRequest<MetaRow | undefined>)) ?? { deviceSeq: 0 };
    store.put(mergeMeta(old, patch), META);
    await transactionDone(tx);
  }

  async clear(): Promise<void> {
    const tx = this.#db.transaction(STORES, 'readwrite');
    for (const name of STORES) tx.objectStore(name).clear();
    await transactionDone(tx);
  }
}

function deviceMetaOf(row: MetaRow | undefined): DeviceMeta {
  if (!row) return { deviceSeq: 0 };
  return {
    deviceSeq: row.deviceSeq,
    ...(row.clockOffsetMs !== undefined ? { clockOffsetMs: row.clockOffsetMs } : {}),
    ...(row.scannerSessionId !== undefined ? { scannerSessionId: row.scannerSessionId } : {}),
  };
}

function mergeMeta(old: MetaRow, patch: Partial<Omit<DeviceMeta, 'deviceSeq'>>): MetaRow {
  const next: MetaRow = { ...old };
  if (patch.clockOffsetMs !== undefined) next.clockOffsetMs = patch.clockOffsetMs;
  if (patch.scannerSessionId !== undefined) next.scannerSessionId = patch.scannerSessionId;
  return next;
}

/** 시험·Node 환경의 메모리 저장소. 운영 저장으로 쓰지 않는다 */
export class MemoryPackageStore implements PackageStore {
  #state: PackageState | undefined;
  #meta: MetaRow = { deviceSeq: 0 };
  #chain: Promise<unknown> = Promise.resolve();

  #serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.#chain.then(fn, fn);
    this.#chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  async load(): Promise<PackageState | undefined> {
    return this.#state;
  }

  async save(state: PackageState): Promise<void> {
    this.#state = state;
  }

  nextDeviceSeq(): Promise<number> {
    return this.#serial(async () => {
      this.#meta = { ...this.#meta, deviceSeq: this.#meta.deviceSeq + 1 };
      return this.#meta.deviceSeq;
    });
  }

  async meta(): Promise<DeviceMeta> {
    return deviceMetaOf(this.#meta);
  }

  async setMeta(patch: Partial<Omit<DeviceMeta, 'deviceSeq'>>): Promise<void> {
    this.#meta = mergeMeta(this.#meta, patch);
  }

  async clear(): Promise<void> {
    this.#state = undefined;
    this.#meta = { deviceSeq: 0 };
  }
}

/** 브라우저면 IndexedDB, Node(시험)면 메모리. 브라우저에서 열지 못하면 오류를 낸다 */
export async function openPackageStore(): Promise<PackageStore> {
  if (typeof indexedDB === 'undefined') {
    if (typeof window === 'undefined' && typeof self === 'undefined') return new MemoryPackageStore();
    throw new Error('이 환경에서는 IndexedDB를 쓸 수 없어 회차 목록을 안전하게 저장할 수 없다');
  }
  return IndexedDbPackageStore.open();
}
