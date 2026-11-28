// F-06-1 POL-034: 계정 병합 흡수 계정 주소를 프로세스 안에만 잠깐 두는 inbox.
// identity는 주소를 저장하지 않고 gRPC 요청에만 싣는다. 이 inbox는 디스크·DB·로그에 쓰지 않으며,
// 워커가 보낸 뒤(성공·실패·만료) 지운다. 파드가 다시 뜨면 주소는 사라지고 작업은 FAILED다(계획 §3.1).
import type { AbsorbedNoticeInbox } from '../domain/fan-notify-ports.js';

/** 주소가 쌓여도 프로세스 메모리가 무한히 늘지 않게 하는 상한 [가정](병합은 드문 사건이다) */
export const ABSORBED_NOTICE_INBOX_MAX = 10_000;

export class MemoryAbsorbedNoticeInbox implements AbsorbedNoticeInbox {
  readonly #rows = new Map<string, string>();

  put(dedupKey: string, email: string): void {
    if (!this.#rows.has(dedupKey) && this.#rows.size >= ABSORBED_NOTICE_INBOX_MAX) {
      const oldest = this.#rows.keys().next().value;
      if (oldest !== undefined) this.#rows.delete(oldest);
    }
    this.#rows.set(dedupKey, email);
  }

  get(dedupKey: string): string | undefined {
    return this.#rows.get(dedupKey);
  }

  delete(dedupKey: string): void {
    this.#rows.delete(dedupKey);
  }
}
