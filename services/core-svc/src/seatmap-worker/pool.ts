// 해석 하나를 작업 스레드 하나에서 돌린다(ADR-0257 결정 5, docs/verification.md §4.1 좌석맵 가져오기 해석 줄).
// - 파드마다 동시 해석 1, 기다리는 요청 4개 [가정]. 넘으면 Busy(→ gRPC RESOURCE_EXHAUSTED → core-svc 503).
// - 스레드는 요청마다 새로 띄운다(한 해석이 다음 해석의 상태를 바꾸지 못하게). 스레드에는 환경 값과 실행 인자를 넘기지 않는다.
// - 시간 상한(5초 [가정])은 스레드가 다 실린 뒤('ready')부터 그 스레드가 쓴 CPU 시간(사용자 + 커널, worker.cpuUsage)으로 잰다(BAT-174).
//   넘으면 스레드를 끝내고 'cpu-limit'(→ REJECTED CPU_LIMIT → 422). 노드가 바빠 차례를 기다린 시간은 들지 않는다(정본 'CPU 5초').
// - 벽시계 바깥 막이: CPU를 상한만큼 쓰지 않고도 WALL_LIMIT_MS를 넘기면(멈춘 스레드, 아주 바쁜 노드) 스레드를 끝내고 'failed'(→ 503).
//   파일이 무거웠다는 증거가 없으므로 422로 답하지 않는다. 부른 쪽(core-svc 데드라인 10초)은 그 전에 이미 끊는다.
// - 스레드가 다 끝난 뒤(terminate 완료)에 답하고 다음 차례로 넘긴다. 잘린 스레드와 새 스레드가 함께 돌지 않는다(동시 해석 1, 힙 상한 1개분).
// - 힙 상한(384MiB [가정])을 넘어 스레드가 죽으면 'out-of-memory'(→ RESOURCE_EXHAUSTED → 503). 이 프로세스는 살아 다음 요청을 받는다.
import { Worker } from 'node:worker_threads';
import type { SeatmapFormat } from '../modules/catalog/domain/seatmap-import.js';
import type { ThreadReply } from './parse-thread.js';

export const PARSE_TIMEOUT_MS = 5_000;
export const THREAD_HEAP_MB = 384;
export const MAX_WAITING = 4;
/** 스레드가 다 실리기를 기다리는 상한 [가정](이 시간은 해석 시간에 넣지 않는다) */
const STARTUP_MS = 10_000;
/** 해석 하나의 벽시계 바깥 막이 [가정]: core-svc 데드라인(SEATMAP_DEADLINE_MS 10초)과 같게 둔다. 시간 상한의 두 배보다 짧지 않다 */
const WALL_LIMIT_MS = 10_000;
/** 스레드 CPU 시간을 읽는 간격의 상한 [가정](상한의 1/4과 이 값 중 작은 쪽). 상한을 넘긴 뒤 끝내기까지 이만큼 늦을 수 있다 */
const CPU_POLL_MAX_MS = 50;

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
      const limitUs = this.#timeoutMs * 1_000;
      const pollMs = Math.max(1, Math.min(CPU_POLL_MAX_MS, Math.floor(this.#timeoutMs / 4)));
      const wallMs = Math.max(WALL_LIMIT_MS, this.#timeoutMs * 2);
      let done = false;
      let cpuPoll: NodeJS.Timeout | undefined;
      let wallTimer: NodeJS.Timeout | undefined;
      const startTimer = setTimeout(() => finish({ kind: 'failed' }), STARTUP_MS);
      const finish = (o: PoolOutcome) => {
        if (done) return;
        done = true;
        clearTimeout(startTimer);
        if (cpuPoll) clearInterval(cpuPoll);
        if (wallTimer) clearTimeout(wallTimer);
        // 스레드가 실제로 끝난 뒤에 답한다(다음 차례의 새 스레드와 겹치지 않게)
        w.terminate().then(
          () => resolve(o),
          () => resolve(o),
        );
      };
      const startParse = (base: NodeJS.CpuUsage) => {
        if (done) return;
        // 받은 바이트를 새 버퍼에 베껴 넘긴다(gRPC 버퍼를 스레드와 나누지 않는다)
        try {
          const copy = new Uint8Array(file.byteLength);
          copy.set(file);
          w.postMessage({ file: copy.buffer, format }, [copy.buffer]);
        } catch {
          finish({ kind: 'failed' });
          return;
        }
        let reading = false;
        cpuPoll = setInterval(() => {
          if (reading || done) return;
          reading = true;
          w.cpuUsage(base).then(
            (u) => {
              reading = false;
              if (u.user + u.system >= limitUs) finish({ kind: 'cpu-limit' });
            },
            // 스레드가 이미 끝났다: 'exit'·'message'가 마무리한다
            () => (reading = false),
          );
        }, pollMs);
        wallTimer = setTimeout(() => finish({ kind: 'failed' }), wallMs);
      };
      w.on('message', (m: ThreadReply) => {
        if (m.kind === 'ready') {
          clearTimeout(startTimer);
          // 다 실릴 때까지 쓴 CPU는 해석 시간에 넣지 않는다: 'ready' 때의 값을 기준으로 잰다
          w.cpuUsage().then(startParse, () => finish({ kind: 'failed' }));
          return;
        }
        finish(m.kind === 'result' ? { kind: 'result', reply: m } : { kind: 'failed' });
      });
      w.on('error', (e: Error & { code?: string }) => finish(e.code === 'ERR_WORKER_OUT_OF_MEMORY' ? { kind: 'out-of-memory' } : { kind: 'failed' }));
      w.on('exit', () => finish({ kind: 'failed' }));
    });
  }
}
