// 해석 하나를 작업 스레드 하나에서 돌린다(ADR-0257 결정 5, docs/verification.md §4.1 좌석맵 가져오기 해석 줄).
// - 파드마다 동시 해석 1, 기다리는 요청 4개 [가정]. 넘으면 Busy(→ gRPC RESOURCE_EXHAUSTED → core-svc 503).
// - 스레드는 요청마다 새로 띄운다(한 해석이 다음 해석의 상태를 바꾸지 못하게). 스레드에는 환경 값과 실행 인자를 넘기지 않는다.
// - 시간 상한(5초 [가정])은 스레드가 다 실린 뒤('ready')부터 잰다. 넘으면 스레드를 끝내고 'cpu-limit'(→ REJECTED CPU_LIMIT → 422).
// - 힙 상한(384MiB [가정])을 넘어 스레드가 죽으면 'out-of-memory'(→ RESOURCE_EXHAUSTED → 503). 이 프로세스는 살아 다음 요청을 받는다.
import { Worker } from 'node:worker_threads';
import type { SeatmapFormat } from '../modules/catalog/domain/seatmap-import.js';
import type { ThreadReply } from './parse-thread.js';

export const PARSE_TIMEOUT_MS = 5_000;
export const THREAD_HEAP_MB = 384;
export const MAX_WAITING = 4;
/** 스레드가 다 실리기를 기다리는 상한 [가정](이 시간은 해석 시간에 넣지 않는다) */
const STARTUP_MS = 10_000;

export type PoolOutcome =
  | { kind: 'result'; reply: Extract<ThreadReply, { kind: 'result' }> }
  | { kind: 'cpu-limit' }
  | { kind: 'out-of-memory' }
  | { kind: 'failed' }
  /** 차례가 왔을 때 부른 쪽이 이미 끊었거나(cancelled) 데드라인이 지났다(deadline). 해석하지 않았다 */
  | { kind: 'skipped'; why: 'cancelled' | 'deadline' };

/** 차례가 왔을 때 아직 기다리는 쪽이 있는가 */
export type Liveness = () => 'alive' | 'cancelled' | 'deadline';

/** 줄이 가득 찼다 */
export class Busy extends Error {}

export interface ParsePoolOptions {
  threadUrl: URL;
  timeoutMs?: number;
  heapMb?: number;
  maxWaiting?: number;
}

export class ParsePool {
  readonly #threadUrl: URL;
  readonly #timeoutMs: number;
  readonly #heapMb: number;
  readonly #maxWaiting: number;
  #running = false;
  readonly #waiting: (() => void)[] = [];

  constructor(o: ParsePoolOptions) {
    this.#threadUrl = o.threadUrl;
    this.#timeoutMs = o.timeoutMs ?? PARSE_TIMEOUT_MS;
    this.#heapMb = o.heapMb ?? THREAD_HEAP_MB;
    this.#maxWaiting = o.maxWaiting ?? MAX_WAITING;
  }

  async run(file: Uint8Array, format: SeatmapFormat, alive: Liveness = () => 'alive'): Promise<PoolOutcome> {
    if (this.#running) {
      if (this.#waiting.length >= this.#maxWaiting) throw new Busy('해석 줄이 가득 찼다');
      // 앞 해석이 끝나며 차례를 넘겨준다(#running은 그대로 참이다)
      await new Promise<void>((resolve) => this.#waiting.push(resolve));
    } else this.#running = true;
    try {
      // 기다리는 동안 부른 쪽이 끊었거나 데드라인이 지났으면 해석하지 않고 다음 차례로 넘긴다(ADR-0257 결정 5)
      const state = alive();
      if (state !== 'alive') return { kind: 'skipped', why: state };
      return await this.#runOne(file, format);
    } finally {
      const next = this.#waiting.shift();
      if (next) next();
      else this.#running = false;
    }
  }

  #runOne(file: Uint8Array, format: SeatmapFormat): Promise<PoolOutcome> {
    return new Promise<PoolOutcome>((resolve) => {
      const w = new Worker(this.#threadUrl, {
        env: {},
        execArgv: [],
        resourceLimits: { maxOldGenerationSizeMb: this.#heapMb, maxYoungGenerationSizeMb: Math.max(1, Math.min(32, Math.floor(this.#heapMb / 8))) },
      });
      let done = false;
      let parseTimer: NodeJS.Timeout | undefined;
      const startTimer = setTimeout(() => finish({ kind: 'failed' }), STARTUP_MS);
      const finish = (o: PoolOutcome) => {
        if (done) return;
        done = true;
        clearTimeout(startTimer);
        if (parseTimer) clearTimeout(parseTimer);
        void w.terminate();
        resolve(o);
      };
      w.on('message', (m: ThreadReply) => {
        if (m.kind === 'ready') {
          clearTimeout(startTimer);
          // 받은 바이트를 새 버퍼에 베껴 넘긴다(gRPC 버퍼를 스레드와 나누지 않는다)
          try {
            const copy = new Uint8Array(file.byteLength);
            copy.set(file);
            w.postMessage({ file: copy.buffer, format }, [copy.buffer]);
          } catch {
            finish({ kind: 'failed' });
            return;
          }
          parseTimer = setTimeout(() => finish({ kind: 'cpu-limit' }), this.#timeoutMs);
          return;
        }
        finish(m.kind === 'result' ? { kind: 'result', reply: m } : { kind: 'failed' });
      });
      w.on('error', (e: Error & { code?: string }) => finish(e.code === 'ERR_WORKER_OUT_OF_MEMORY' ? { kind: 'out-of-memory' } : { kind: 'failed' }));
      w.on('exit', () => finish({ kind: 'failed' }));
    });
  }
}
