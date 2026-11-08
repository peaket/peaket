// 시험용 S3 사본 저장소와 파드 고르기(실제 S3 어댑터는 BUILD_ORDER HOT-012). 포트 둘을 함께 구현한다.
import type { StateMirrorLease, StateMirrorStore } from '../domain/ports.js';

interface Written {
  body: string;
  contentType: string;
  cacheControl: string;
  expiresAtMs?: number;
}

export class MemoryStateMirrors implements StateMirrorStore, StateMirrorLease {
  readonly written = new Map<string, Written>();
  /** 쓴 키를 차례로 적는다 */
  readonly puts: string[] = [];
  /** 참이면 쓰기가 실패한다(S3 장애 흉내) */
  failing = false;
  readonly #claimed = new Set<string>();

  async put(i: { key: string; body: string; contentType: string; cacheControl: string; expiresAtMs?: number }): Promise<void> {
    if (this.failing) throw new Error('S3 쓰기 실패 흉내');
    this.puts.push(i.key);
    this.written.set(i.key, { body: i.body, contentType: i.contentType, cacheControl: i.cacheControl, ...(i.expiresAtMs !== undefined ? { expiresAtMs: i.expiresAtMs } : {}) });
  }

  async claim(eventId: string, boundaryMs: number): Promise<boolean> {
    const k = `${eventId}|${boundaryMs}`;
    if (this.#claimed.has(k)) return false;
    this.#claimed.add(k);
    return true;
  }
}
