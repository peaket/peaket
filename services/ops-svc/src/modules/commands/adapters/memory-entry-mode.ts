// F-02-6(동결 로컬) 엣지 저장소 mode:entry의 시험·local 가짜. 실제 CloudFront KeyValueStore 쓰기는 미실행이다.
import type { EntryModeStore, EntryModeValue } from '../domain/edge-ports.js';

export class MemoryEntryMode implements EntryModeStore {
  /** 마지막으로 쓴 값(시험이 그대로 읽는다) */
  value: EntryModeValue | undefined;

  async write(value: EntryModeValue): Promise<void> {
    this.value = { ...value };
  }

  async read(): Promise<EntryModeValue | undefined> {
    return this.value ? { ...this.value } : undefined;
  }
}
