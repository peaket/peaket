// 시험용 엣지 매진 표시 저장소(포트 EdgeSaleFlags의 대역). 실제 KeyValueStore 어댑터(HOT-012)와 같은 규칙:
// sale: 접두사 키만 받고, 저장된 판이 이 판보다 크면 바꾸지 않는다.
import { EDGE_FLAG_KEY_PREFIX, type EdgeFlagEntry, type EdgePutResult, type EdgeSaleFlag, type EdgeSaleFlags, edgeFlagEntry } from '../domain/edge.js';

export class MemoryEdgeSaleFlags implements EdgeSaleFlags {
  readonly #m = new Map<string, EdgeFlagEntry>();
  /** 실제로 쓴 항목(차례대로) */
  readonly writes: EdgeFlagEntry[] = [];
  /** 이 값이 있으면 쓰기마다 던진다(저장소 장애 흉내) */
  failWith: unknown = null;
  /** 참이면 쓰기가 끝나지 않는다(무응답 흉내) */
  hang = false;
  /** 쓰기를 받을 때 부른다(차례 시험) */
  onPut: ((e: EdgeFlagEntry) => void) | undefined;
  #gate: { enter: () => void; wait: Promise<void> } | undefined;

  /** 다음 쓰기 하나를 release까지 잡아 둔다(저장소가 늦게 답하는 동안 다른 쓰기가 끼는 차례 시험). 판 비교는 놓인 뒤에 한다 */
  gate(): { entered: Promise<void>; release(): void } {
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((r) => (enter = r));
    const wait = new Promise<void>((r) => (release = r));
    this.#gate = { enter, wait };
    return { entered, release };
  }

  async put(e: EdgeFlagEntry): Promise<EdgePutResult> {
    if (!e.key.startsWith(EDGE_FLAG_KEY_PREFIX)) throw new RangeError(`엣지 매진 표시는 ${EDGE_FLAG_KEY_PREFIX} 접두사 키만 쓴다`);
    this.onPut?.(e);
    if (this.hang) return new Promise<EdgePutResult>(() => undefined);
    if (this.failWith) throw this.failWith;
    const g = this.#gate;
    if (g) {
      this.#gate = undefined;
      g.enter();
      await g.wait;
    }
    const cur = this.#m.get(e.key);
    if (cur && cur.version > e.version) return 'NEWER_STORED';
    this.#m.set(e.key, { ...e });
    this.writes.push({ ...e });
    return 'WRITTEN';
  }

  // 시험 도구
  flagOf(eventId: string): EdgeSaleFlag | null {
    const e = this.#m.get(`${EDGE_FLAG_KEY_PREFIX}${eventId}`);
    return e ? (JSON.parse(e.value) as EdgeSaleFlag) : null;
  }

  /** 운영자가 손으로 지운 것처럼 지운다 */
  deleteForTest(eventId: string): void {
    this.#m.delete(`${EDGE_FLAG_KEY_PREFIX}${eventId}`);
  }

  /** 다른 파드가 쓴 것처럼 판 번호 비교 없이 덮는다 */
  overwriteForTest(eventId: string, f: EdgeSaleFlag): void {
    const e = edgeFlagEntry(eventId, f);
    this.#m.set(e.key, e);
  }
}
