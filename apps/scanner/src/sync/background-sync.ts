// 일회성 Background Sync 예비 등록과 서비스 워커 업로드(offline-gate §6.5·O-T11·O-T37 ⑧).
// 서비스 워커에는 스태프 토큰이 없으므로 같은 기기 키로 DPoP 증명만 만든다.
import { ScannerApi } from '../api/client.ts';
import type { DpopKey } from '../api/dpop.ts';
import type { ScanQueue, ScanQueueRecord } from '../storage/scan-queue.ts';

export const BACKGROUND_SYNC_TAG = 'peaket-scanner-scans';

export interface BackgroundSyncState {
  pending: number;
  failed: boolean;
  stopped?: 'device-revoked' | 'device-unregistered';
}

export function shouldRegisterBackgroundSync(i: BackgroundSyncState & { hasRegistration: boolean }): boolean {
  if (!i.hasRegistration) return false;
  if (i.stopped) return false;
  return i.failed && i.pending > 0;
}

/** 같은 실패에 거듭 등록하지 않고, 성공/비실패 상태에서 표시를 푼다 */
export class BackgroundSyncGuard {
  readonly #register: (tag: string) => Promise<void>;
  #registered = false;

  constructor(o: { register(tag: string): Promise<void> }) {
    this.#register = o.register;
  }

  async onFailure(i: BackgroundSyncState): Promise<boolean> {
    if (i.stopped || !i.failed || i.pending <= 0) {
      this.#registered = false;
      return false;
    }
    if (this.#registered) return false;
    try {
      await this.#register(BACKGROUND_SYNC_TAG);
      this.#registered = true;
      return true;
    } catch {
      this.#registered = false;
      return false;
    }
  }

  reset(): void {
    this.#registered = false;
  }
}

type UploadPort = {
  upload(batch: unknown[], o: { withToken: boolean }): Promise<{ acceptedIds: string[]; resyncRequired: boolean }>;
};

function stoppedOf(error: unknown): 'device-revoked' | 'device-unregistered' | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const e = error as { status?: unknown; type?: unknown };
  if (e.status !== 403) return undefined;
  return e.type === 'device-revoked' || e.type === 'device-unregistered' ? e.type : undefined;
}

function bodyOf(record: ScanQueueRecord): unknown {
  try {
    return JSON.parse(record.payload) as unknown;
  } catch {
    return { id: record.id, eventId: record.eventId };
  }
}

/**
 * 큐의 기록을 500건씩 올린다. acceptedIds에 든 기록만 지우고, 받지 않은 기록은 남긴다.
 * 실패하면 거기서 멈추고 남은 기록은 다음 기회(화면 복귀·online·다음 sync)에 다시 올린다.
 */
export async function runBackgroundUpload(i: {
  queue: ScanQueue;
  port: UploadPort;
  maxBatches?: number;
  nowMs?: number;
}): Promise<{ sent: number; accepted: number; remaining: number; resyncRequired: boolean; stopped?: 'device-revoked' | 'device-unregistered' }> {
  const maxBatches = i.maxBatches ?? 10;
  const nowMs = i.nowMs ?? Date.now();
  let sent = 0;
  let accepted = 0;
  let resyncRequired = false;
  let stopped: 'device-revoked' | 'device-unregistered' | undefined;
  for (let batchNo = 0; batchNo < maxBatches; batchNo++) {
    const records = await i.queue.due(nowMs, 500);
    if (records.length === 0) break;
    let result: { acceptedIds: string[]; resyncRequired: boolean };
    try {
      result = await i.port.upload(records.map(bodyOf), { withToken: false });
    } catch (error) {
      stopped = stoppedOf(error);
      break;
    }
    sent += records.length;
    resyncRequired = resyncRequired || result.resyncRequired === true;
    const acceptedSet = new Set(result.acceptedIds);
    const acceptedRecords = records.filter((r) => acceptedSet.has(r.id));
    for (const record of acceptedRecords) await i.queue.ack(record.id);
    accepted += acceptedRecords.length;
    if (acceptedRecords.length !== records.length) break;
  }
  return {
    sent,
    accepted,
    remaining: await i.queue.count(),
    resyncRequired,
    ...(stopped ? { stopped } : {}),
  };
}

/** 서비스 워커 업로더. key가 없으면 loadKey로 화면과 같은 저장소의 기기 키를 읽는다 */
export function createServiceWorkerUploader(i: {
  queue: ScanQueue;
  origin: string;
  key?: unknown;
  loadKey?: () => Promise<unknown>;
  fetch?: typeof fetch;
  now?: () => number;
}): UploadPort {
  let keyPromise: Promise<DpopKey | undefined> | undefined;
  const load = async (): Promise<DpopKey | undefined> => {
    if (i.key) return i.key as DpopKey;
    if (!i.loadKey) return undefined;
    return (await i.loadKey()) as DpopKey | undefined;
  };
  return {
    async upload(batch, _o) {
      keyPromise ??= load();
      const key = await keyPromise;
      if (!key) throw new Error('기기 키가 없어 서비스 워커가 업로드할 수 없다');
      const api = new ScannerApi({
        origin: i.origin,
        key,
        ...(i.fetch ? { fetch: i.fetch } : {}),
        ...(i.now ? { now: i.now } : {}),
      });
      const result = await api.uploadScans(batch as Record<string, unknown>[]);
      return { acceptedIds: result.acceptedIds, resyncRequired: result.resyncRequired };
    },
  };
}
