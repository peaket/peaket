// 월렛 IndexedDB 저장소(offline-gate §2·§4, docs/frontend.md §2.3·§4.2.4·§5.4, FR-012).
// - DB 이름은 `peaket-wallet`이다. 기기 키(CryptoKey, 구조화 복제)·티켓 마지막 스냅샷·마지막 동기화 시각을 둔다.
// - 기기 키 흐름(features/wallet-device-key)과 월렛 목록 받기(features/wallet-sync)가 함께 쓰므로 entities 층에 둔다
//   (같은 층의 다른 조각끼리 가져오지 않는다, ADR-0329). features/wallet-device-key/store.ts는 이 파일을 다시 내보낸다.
// - 개인키는 WebCrypto CryptoKey 객체 그대로 넣는다. 페이지 스크립트가 원문을 꺼낼 수는 없지만,
//   같은 출처 스크립트는 서명을 부를 수 있다(남는 한계, offline-gate §3).
// - 저장소를 쓸 수 없는 사생활 보호 모드에서는 undefined를 돌려주고 화면은 기기 시계·메모리로 계속 돈다.
import Dexie, { type Table } from 'dexie';

export const WALLET_DB_NAME = 'peaket-wallet';

export type DeviceKeyReason = 'ISSUE' | 'REISSUE' | 'TRANSFER' | 'BOOTH';
/**
 * LOCAL: 서버가 등록을 확인하기 전의 키('확인 전'), 또는 팬 API 주소가 없는 빌드(로컬 화면 개발)에서 이 기기에만 둔 키.
 * REGISTERED: ticket-svc가 같은 keyId로 등록을 확인한 키(201). QR은 이때만 보인다(주소 없는 빌드 제외, docs/frontend.md §4.2.4, ADR-0336)
 */
export type DeviceKeyRegistration = 'LOCAL' | 'REGISTERED';

export interface StoredDeviceKey {
  /** 티켓 UUIDv7. 티켓당 활성 키 하나(서버 규칙과 맞춘다) */
  ticketId: string;
  /** QR v1 keyId 8바이트의 base64url 11자 */
  keyId: string;
  privateKey: CryptoKey;
  publicKeyJwk: JsonWebKey;
  createdAt: number;
  reason: DeviceKeyReason;
  registration: DeviceKeyRegistration;
  /**
   * 서버가 재인증을 요구해 멈춘 키(ADR-0363 결정 2·3): REISSUE면 403 `reissue-required`('저장소 유실, 입장 시작 전'),
   * ISSUE면 403 `reauth-required`('다시 확인 필요'). 화면을 다시 열어도 재인증 없이 다시 보내지 않는다(O-T49 ⑦). 재인증 뒤 보내면 지운다
   */
  reauthNeeded?: 'REISSUE' | 'ISSUE';
}

/** 티켓 상태(openapi `Ticket.status`, docs/planning/03 §2.5) */
export type WalletTicketStatus = 'ISSUED' | 'ACTIVE' | 'TRANSFER_PENDING' | 'CANCEL_REQUESTED' | 'REFUNDED' | 'FLAGGED' | 'VOIDED';

/**
 * 티켓 한 장의 마지막 스냅샷. 개인정보(이름·연락처)는 두지 않는다(docs/frontend.md §3.7).
 * 월렛 목록(GET /v1/tickets)으로 받은 표는 order·eventId·status가 늘 있다. 퍼블리싱 미리보기(목업 화면)가 남긴 스냅샷은 표시 글만 있다
 */
export interface WalletTicketSnapshot {
  ticketId: string;
  updatedAt: number;
  /** 서버 목록 차례(0부터). 화면은 이 차례로 그린다 */
  order?: number;
  eventId?: string;
  status?: WalletTicketStatus;
  /** 부정 예매 양도 잠금 */
  transferLocked?: boolean;
  /** 게이트 구역(서버가 줄 때만) */
  gateZone?: string;
  /** 발권 때 받은 회차 시작(ISO) */
  eventStartsAt?: string;
  /** 받은 티켓(보유자가 결제자가 아님, 목록 항목에 receivedFromNickname null이 없음) */
  received?: boolean;
  /** 회차 공개 요약(GET /v1/events/{eventId})의 표시 값. 그 회차 요약을 못 읽었으면 없다 */
  title?: string;
  placeName?: string;
  startsAt?: string;
  entryOpensAt?: string;
  endsAt?: string;
  /** 퍼블리싱 미리보기의 표시 글(목업 화면만 쓴다) */
  whenText?: string;
  venueName?: string;
  seat?: string;
  gate?: string;
}

interface WalletMeta {
  id: 'wallet';
  lastSyncedAt: number;
  /** 오프라인 스냅샷 버전 벡터(GAT-160). 서버 스캐너 목록의 벡터와 같은 모양이다 */
  versionVector?: WalletVersionVector;
  /** 마지막 `navigator.storage.persist()` 결과(docs/frontend.md §5.4, ADR-0363 결정 10). 등록할 때와 월렛을 열 때마다 다시 적는다 */
  persistGranted?: boolean;
}

export interface WalletVersionVector {
  eventId: string;
  seq: number;
  ticketSeq: number;
  keySeq: number;
  policySeq: number;
  placementSeq: number;
  flagSeq: number;
  issuedAt: string;
  maxOfflineMs: number;
}

class WalletDatabase extends Dexie {
  deviceKeys!: Table<StoredDeviceKey, string>;
  tickets!: Table<WalletTicketSnapshot, string>;
  meta!: Table<WalletMeta, string>;

  constructor() {
    super(WALLET_DB_NAME);
    this.version(1).stores({
      deviceKeys: 'ticketId, keyId, createdAt',
      tickets: 'ticketId, updatedAt',
      meta: 'id',
    });
  }
}

let database: WalletDatabase | undefined;

/** 브라우저에서만 부른다. IndexedDB가 없으면(SSR·사생활 보호 모드) undefined */
export function walletDatabase(): WalletDatabase | undefined {
  if (typeof indexedDB === 'undefined') return undefined;
  database ??= new WalletDatabase();
  return database;
}

export async function loadDeviceKey(ticketId: string): Promise<StoredDeviceKey | undefined> {
  return walletDatabase()?.deviceKeys.get(ticketId);
}

export async function saveDeviceKey(key: StoredDeviceKey): Promise<void> {
  await walletDatabase()?.deviceKeys.put(key);
}

export async function deleteDeviceKey(ticketId: string): Promise<void> {
  await walletDatabase()?.deviceKeys.delete(ticketId);
}

export async function saveTicketSnapshot(snapshot: WalletTicketSnapshot): Promise<void> {
  await walletDatabase()?.tickets.put(snapshot);
}

export async function loadTicketSnapshot(ticketId: string): Promise<WalletTicketSnapshot | undefined> {
  return walletDatabase()?.tickets.get(ticketId);
}

/** 월렛 목록으로 받은 표의 스냅샷(서버 목록 차례). 미리보기가 남긴 표시 글뿐인 스냅샷은 뺀다 */
export async function listTicketSnapshots(): Promise<WalletTicketSnapshot[]> {
  const rows = (await walletDatabase()?.tickets.toArray()) ?? [];
  return rows.filter((s) => s.status !== undefined && s.eventId !== undefined).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

/**
 * 저장된 표를 이 목록과 같게 맞춘다(docs/frontend.md §4.2.4 '저장'): 새 표는 넣고, 목록에 없는 표의 스냅샷은 지운다.
 * 기기 키(deviceKeys)와 마지막 동기화 시각(meta)은 건드리지 않는다. 한 트랜잭션이라 중간에 끊겨도 반쯤 맞춘 상태가 남지 않는다
 */
export async function replaceTicketSnapshots(snapshots: readonly WalletTicketSnapshot[]): Promise<void> {
  const db = walletDatabase();
  if (!db) return;
  const keep = new Set(snapshots.map((s) => s.ticketId));
  await db.transaction('rw', db.tickets, async () => {
    const existing = await db.tickets.toCollection().primaryKeys();
    await db.tickets.bulkDelete(existing.filter((id) => !keep.has(id)));
    await db.tickets.bulkPut([...snapshots]);
  });
}

export async function saveLastSyncedAt(at = Date.now()): Promise<void> {
  const db = walletDatabase();
  if (!db) return;
  // 다른 칸(버전 벡터·persistGranted)은 남긴다
  const meta = await db.meta.get('wallet');
  await db.meta.put({ ...(meta ?? {}), id: 'wallet', lastSyncedAt: at });
}

/** 마지막 persist() 결과(meta.persistGranted). 적은 적이 없으면 undefined */
export async function loadPersistGranted(): Promise<boolean | undefined> {
  return (await walletDatabase()?.meta.get('wallet'))?.persistGranted;
}

export async function loadLastSyncedAt(): Promise<number | undefined> {
  return (await walletDatabase()?.meta.get('wallet'))?.lastSyncedAt;
}

export async function saveWalletVersionVector(vector: WalletVersionVector): Promise<void> {
  const db = walletDatabase();
  if (!db) return;
  const meta = (await db.meta.get('wallet')) ?? { id: 'wallet' as const, lastSyncedAt: Date.now() };
  await db.meta.put({ ...meta, versionVector: vector });
}

export async function loadWalletVersionVector(): Promise<WalletVersionVector | undefined> {
  return (await walletDatabase()?.meta.get('wallet'))?.versionVector;
}

/** 월렛 스냅샷이 서버가 정한 오프라인 허용 시간을 넘겼는가. 경계값(같음)은 아직 신선하다 */
export function isWalletSnapshotStale(vector: Pick<WalletVersionVector, 'issuedAt' | 'maxOfflineMs'>, syncedAtMs: number, nowMs: number): boolean {
  if (nowMs - syncedAtMs > vector.maxOfflineMs) return true;
  return nowMs - Date.parse(vector.issuedAt) > vector.maxOfflineMs;
}

/**
 * iOS 7일 삭제·저장 공간 정리에 대비해 영구 저장소를 요청한다(offline-gate §4). 등록할 때와 월렛을 열 때마다 부른다(ADR-0363 결정 10).
 * 결과를 `meta.persistGranted`에 적고 돌려준다
 */
export async function requestPersistentStorage(): Promise<boolean> {
  let granted = false;
  try {
    if (typeof navigator !== 'undefined' && navigator.storage?.persist) granted = await navigator.storage.persist();
  } catch {
    granted = false;
  }
  try {
    const db = walletDatabase();
    if (db) {
      const meta = await db.meta.get('wallet');
      await db.meta.put({ ...(meta ?? { lastSyncedAt: 0 }), id: 'wallet', persistGranted: granted });
    }
  } catch {
    // 적지 못해도 결과는 돌려준다
  }
  return granted;
}

export async function storagePersisted(): Promise<boolean> {
  try {
    return (await navigator.storage?.persisted?.()) ?? false;
  } catch {
    return false;
  }
}
