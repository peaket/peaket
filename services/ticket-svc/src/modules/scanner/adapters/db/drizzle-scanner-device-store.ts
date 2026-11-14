// ticket DB의 스캐너 기기 원장(Drizzle, BUILD_ORDER GAT-170). 등록 코드는 Redis에만 둔다.
import type { Database } from '@peaket/platform';
import { and, asc, eq, gt } from 'drizzle-orm';
import type { ScannerDeviceListInput, ScannerDeviceListResult, ScannerDeviceStore } from '../../domain/ports.js';
import { type ScannerCredentialType, type ScannerDeviceRecord, type ScannerDeviceStatus, ScannerDeviceInputError, ScannerDeviceKeyConflict } from '../../domain/scanner-device.js';
import { scannerDevice } from './schema.js';

type Row = typeof scannerDevice.$inferSelect;

const statusOf = (v: string): ScannerDeviceStatus => {
  if (v === 'ACTIVE' || v === 'REVOKED' || v === 'RETIRED') return v;
  throw new Error(`알 수 없는 스캐너 기기 상태: ${v}`);
};
const credentialOf = (v: string): ScannerCredentialType => {
  if (v === 'DEVICE_KEY' || v === 'MTLS_CERT') return v;
  throw new Error(`알 수 없는 스캐너 자격 종류: ${v}`);
};
const jktOf = (v: Buffer | null): string | undefined => (v === null ? undefined : Buffer.from(v).toString('base64url'));

const recordOf = (r: Row): ScannerDeviceRecord => ({
  deviceId: r.id,
  name: r.name,
  promoterId: r.promoterId,
  status: statusOf(r.status),
  credentialType: credentialOf(r.credentialType),
  ...(r.credentialThumbprint !== null ? { credentialThumbprint: jktOf(r.credentialThumbprint)! } : {}),
  ...(r.certExpiresAt !== null ? { certExpiresAtMs: r.certExpiresAt.getTime() } : {}),
  enrolledBy: r.enrolledBy,
  enrolledAtMs: r.enrolledAt.getTime(),
  ...(r.lastSeenAt !== null ? { lastSeenAtMs: r.lastSeenAt.getTime() } : {}),
  ...(r.revokedAt !== null ? { revokedAtMs: r.revokedAt.getTime() } : {}),
  ...(r.revokeReason !== null ? { revokeReason: r.revokeReason } : {}),
});

export class DrizzleScannerDeviceStore implements ScannerDeviceStore {
  constructor(private readonly database: Database) {}

  async list(i: ScannerDeviceListInput): Promise<ScannerDeviceListResult> {
    const rows = await this.database.db
      .select()
      .from(scannerDevice)
      .where(i.cursor === undefined ? undefined : gt(scannerDevice.id, i.cursor))
      .orderBy(asc(scannerDevice.id))
      .limit(i.limit + 1);
    const more = rows.length > i.limit;
    const page = more ? rows.slice(0, i.limit) : rows;
    return { devices: page.map(recordOf), ...(more ? { nextCursor: page.at(-1)!.id } : {}) };
  }

  async findById(deviceId: string): Promise<ScannerDeviceRecord | undefined> {
    const [row] = await this.database.db.select().from(scannerDevice).where(eq(scannerDevice.id, deviceId)).limit(1);
    return row ? recordOf(row) : undefined;
  }

  async register(i: { deviceId: string; name: string; promoterId: string; enrolledBy: string; atMs: number }): Promise<ScannerDeviceRecord> {
    const [row] = await this.database.db
      .insert(scannerDevice)
      .values({
        id: i.deviceId,
        promoterId: i.promoterId,
        name: i.name,
        status: 'ACTIVE',
        credentialType: 'DEVICE_KEY',
        enrolledBy: i.enrolledBy,
        enrolledAt: new Date(i.atMs),
      })
      .returning();
    if (!row) throw new Error('스캐너 기기를 넣지 못했다');
    return recordOf(row);
  }

  async revoke(i: { deviceId: string; reason: string; atMs: number }): Promise<ScannerDeviceRecord | undefined> {
    const [row] = await this.database.db
      .update(scannerDevice)
      .set({ status: 'REVOKED', revokedAt: new Date(i.atMs), revokeReason: i.reason })
      .where(and(eq(scannerDevice.id, i.deviceId), eq(scannerDevice.status, 'ACTIVE')))
      .returning();
    return row ? recordOf(row) : undefined;
  }

  async bindCredential(i: { deviceId: string; jkt: string; atMs: number }): Promise<ScannerDeviceRecord | undefined> {
    try {
      const [row] = await this.database.db
        .update(scannerDevice)
        .set({ credentialType: 'DEVICE_KEY', credentialThumbprint: Buffer.from(i.jkt, 'base64url') })
        .where(and(eq(scannerDevice.id, i.deviceId), eq(scannerDevice.status, 'ACTIVE')))
        .returning();
      return row ? recordOf(row) : undefined;
    } catch (e) {
      if ((e as { cause?: { code?: string } }).cause?.code === '23505') throw new ScannerDeviceKeyConflict();
      throw e;
    }
  }

  async byThumbprint(jkt: string): Promise<ScannerDeviceRecord | null> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(jkt)) throw new ScannerDeviceInputError('JKT');
    const [row] = await this.database.db.select().from(scannerDevice).where(eq(scannerDevice.credentialThumbprint, Buffer.from(jkt, 'base64url'))).limit(1);
    return row ? recordOf(row) : null;
  }

  async touch(deviceId: string, atMs: number): Promise<void> {
    await this.database.db.update(scannerDevice).set({ lastSeenAt: new Date(atMs) }).where(eq(scannerDevice.id, deviceId));
  }
}
