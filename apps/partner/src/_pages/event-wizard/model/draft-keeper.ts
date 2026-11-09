// 위저드 임시저장의 순서 규칙(ADR-0245 결정 1·5). 저장소는 밖에서 받아 브라우저 없이 시험한다.
// 지켜야 할 것: 복원 전에는 쓰지 않는다 · 지운 뒤 옛 값을 되살리지 않는다 · 등록이 끝난 초안을 다시 쓰지 않는다 · 저장소를 못 써도 같은 본문은 같은 멱등 키다.
import { parseDraft, parseRequestKey, requestKeyFor, serializeDraft, type RequestKey, type WizardDraft } from './form.ts';

export interface DraftStore {
  readDraft(): string | null;
  writeDraft(value: string): boolean;
  readKey(): string | null;
  writeKey(value: string): boolean;
  clear(): void;
}

export type FlushResult = 'saved' | 'failed' | 'none';

export class DraftKeeper {
  /** 복원하기 전, 등록을 마친 뒤, 다른 탭이 지운 뒤에는 쓰지 않는다 */
  private active = false;
  private current: WizardDraft;
  private saved: WizardDraft;
  /** 저장소를 못 쓰는 브라우저에서도 다시 보낼 때 같은 키를 쓰게 한다 */
  private memoryKey: RequestKey | null = null;
  private readonly store: DraftStore;

  constructor(store: DraftStore, initial: WizardDraft) {
    this.store = store;
    this.current = initial;
    this.saved = initial;
  }

  value(): WizardDraft {
    return this.current;
  }

  /** 저장한 값을 읽어 지금 값으로 삼는다. 없으면 null */
  restore(): WizardDraft | null {
    const found = parseDraft(this.store.readDraft());
    this.active = true;
    if (found) {
      this.current = found;
      this.saved = found;
    }
    return found;
  }

  change(next: WizardDraft): void {
    this.current = next;
  }

  isDirty(): boolean {
    return this.active && this.current !== this.saved;
  }

  flush(): FlushResult {
    if (!this.isDirty()) return 'none';
    if (!this.store.writeDraft(serializeDraft(this.current))) return 'failed';
    this.saved = this.current;
    return 'saved';
  }

  /** 처음부터 다시: 저장을 지우고 새 값에서 시작한다 */
  reset(fresh: WizardDraft): void {
    this.store.clear();
    this.current = fresh;
    this.saved = fresh;
    this.memoryKey = null;
    this.active = true;
  }

  /** 등록을 마쳤다: 저장을 지우고 더 쓰지 않는다 */
  finish(): void {
    this.store.clear();
    this.memoryKey = null;
    this.active = false;
  }

  /** 다른 탭의 변경. null이면 다른 탭이 등록했거나 지웠다 */
  fromOtherTab(draft: WizardDraft | null): 'adopted' | 'closed' | 'none' {
    if (!this.active) return 'none';
    if (draft === null) {
      this.active = false;
      return 'closed';
    }
    this.current = draft;
    this.saved = draft;
    return 'adopted';
  }

  /** 이 본문에 쓸 멱등 키(같은 본문이면 처음 키, 고쳤으면 새 키) */
  requestKey(body: unknown, make: () => string): string {
    const next = requestKeyFor(parseRequestKey(this.store.readKey()) ?? this.memoryKey, body, make);
    this.memoryKey = next;
    this.store.writeKey(JSON.stringify(next));
    return next.key;
  }
}
