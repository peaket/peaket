// 월렛 IndexedDB 저장소(offline-gate §2·§4, docs/frontend.md §2.3·§5.4, FR-012).
// - DB 이름은 `peaket-wallet`이다. 기기 키(CryptoKey, 구조화 복제)·티켓 마지막 스냅샷·마지막 동기화 시각을 둔다.
// - 개인키는 WebCrypto CryptoKey 객체 그대로 넣는다. 페이지 스크립트가 원문을 꺼낼 수는 없지만,
//   같은 출처 스크립트는 서명을 부를 수 있다(남는 한계, offline-gate §3).
// - 저장소를 쓸 수 없는 사생활 보호 모드에서는 undefined를 돌려주고 화면은 기기 시계·메모리로 계속 돈다.
import Dexie, { type Table } from 'dexie';

export const WALLET_DB_NAME = 'peaket-wallet';

export type DeviceKeyReason = 'ISSUE' | 'REISSUE' | 'TRANSFER' | 'BOOTH';
/** LOCAL: 이 기기에만 만든 키. REGISTERED: ticket-svc에 공개키를 등록한 키 */
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
}

export interface WalletTicketSnapshot {
  ticketId: string;
  title: string;
  whenText: string;
  venueName: string;
  seat: string;
  gate: string;
  updatedAt: number;
}

interface WalletMeta {
  id: 'wallet';
  lastSyncedAt: number;
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

export async function saveLastSyncedAt(at = Date.now()): Promise<void> {
  await walletDatabase()?.meta.put({ id: 'wallet', lastSyncedAt: at });
}

export async function loadLastSyncedAt(): Promise<number | undefined> {
  return (await walletDatabase()?.meta.get('wallet'))?.lastSyncedAt;
}

/** iOS 7일 삭제·저장 공간 정리에 대비해 영구 저장소를 요청한다(offline-gate §4). 결과를 돌려준다 */
export async function requestPersistentStorage(): Promise<boolean> {
  try {
    if (typeof navigator === 'undefined' || !navigator.storage?.persist) return false;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

export async function storagePersisted(): Promise<boolean> {
  try {
    return (await navigator.storage?.persisted?.()) ?? false;
  } catch {
    return false;
  }
}
