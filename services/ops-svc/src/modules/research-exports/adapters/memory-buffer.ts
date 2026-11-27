// 연구 내보내기 메모리 버퍼. 바이트는 DB·S3에 넣지 않고 30분만 둔다(동결 로컬).
import type { ResearchExportBuffer } from '../domain/ports.js';

export class MemoryResearchExportBuffer implements ResearchExportBuffer {
  readonly entries = new Map<string, { bytes: Uint8Array; expiresAtMs: number }>();
  async put(exportId: string, bytes: Uint8Array, expiresAtMs: number): Promise<void> {
    this.entries.set(exportId, { bytes, expiresAtMs });
  }
  async get(exportId: string, nowMs: number): Promise<Uint8Array | null> {
    const e = this.entries.get(exportId);
    if (!e) return null;
    if (e.expiresAtMs <= nowMs) {
      this.entries.delete(exportId);
      return null;
    }
    return e.bytes;
  }
}
