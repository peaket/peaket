// 에디터 Worker를 부르는 쪽(ADR-0264 결정 5, asvs/frontend.md 15.1.3). 요청마다 ID를 매기고, 같은 종류의 새 요청이 오면 앞 요청을 버린다(cancel).
// 10초 [가정] 안에 답이 없으면 그 요청을 '계산을 끝내지 못했습니다'로 끝내고 Worker를 버린 뒤 새로 띄운다(그 Worker에 걸린 다른 요청도 끝낸다).
// Worker를 만드는 함수와 시계는 밖에서 받아 브라우저 없이 시험한다.
import type { FromWorker, JobType } from './worker-protocol.ts';
import { isFromWorker } from './worker-protocol.ts';

/** 답을 기다리는 시간(ms) [가정](ADR-0264 결정 5) */
export const WORKER_TIMEOUT_MS = 10_000;

export const TIMEOUT_TEXT = '계산을 끝내지 못했습니다. 다시 해 주세요';

export interface WorkerLike {
  postMessage(m: unknown, transfer?: Transferable[]): void;
  terminate(): void;
  onmessage: ((e: { data: unknown }) => void) | null;
  onerror: ((e: unknown) => void) | null;
}

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(h: unknown): void;
}

/** Worker가 계산하다 실패를 돌려준 답(ok: false)의 문구 */
export const FAILED_TEXT = '계산하지 못했습니다. 다시 해 주세요';

/** 요청이 끝난 까닭 */
export class JobEnded extends Error {
  readonly reason: 'cancelled' | 'timeout' | 'crashed' | 'failed' | 'closed';
  constructor(reason: JobEnded['reason']) {
    // 화면에 보이는 문구는 한국어다(취소·닫힘은 화면이 조용히 넘긴다)
    super(reason === 'timeout' || reason === 'crashed' ? TIMEOUT_TEXT : reason === 'failed' ? FAILED_TEXT : reason);
    this.name = 'JobEnded';
    this.reason = reason;
  }
}

interface Pending {
  type: JobType;
  resolve(v: unknown): void;
  reject(e: unknown): void;
  timer: unknown;
}

export interface WorkerClient {
  request<T>(type: JobType, payload: Record<string, unknown>, transfer?: Transferable[]): Promise<T>;
  /** 지금까지 Worker를 만든 수(처음 1) */
  started(): number;
  close(): void;
}

export function createWorkerClient(make: () => WorkerLike, timers: Timers = globalThis as unknown as Timers, timeoutMs = WORKER_TIMEOUT_MS): WorkerClient {
  let worker: WorkerLike | null = null;
  let made = 0;
  let nextId = 1;
  let closed = false;
  const pending = new Map<number, Pending>();
  /** 종류마다 지금 요청 */
  const latest = new Map<JobType, number>();

  const finish = (id: number) => {
    const p = pending.get(id);
    if (!p) return undefined;
    timers.clearTimeout(p.timer);
    pending.delete(id);
    if (latest.get(p.type) === id) latest.delete(p.type);
    return p;
  };

  const restart = (reason: 'timeout' | 'crashed') => {
    worker?.terminate();
    worker = null;
    for (const id of [...pending.keys()]) finish(id)?.reject(new JobEnded(reason));
  };

  const ensure = (): WorkerLike => {
    if (worker) return worker;
    const w = make();
    made++;
    w.onmessage = (e) => {
      if (w !== worker) return;
      const m = e.data as FromWorker;
      if (!isFromWorker(m)) return;
      const p = finish(m.id);
      if (!p) return; // 버린 요청의 답
      if (m.ok) p.resolve(m.result);
      else p.reject(new JobEnded('failed'));
    };
    w.onerror = () => {
      if (w === worker) restart('crashed');
    };
    worker = w;
    return w;
  };

  return {
    request<T>(type: JobType, payload: Record<string, unknown>, transfer: Transferable[] = []): Promise<T> {
      if (closed) return Promise.reject(new JobEnded('closed'));
      const w = ensure();
      const prev = latest.get(type);
      if (prev !== undefined) {
        finish(prev)?.reject(new JobEnded('cancelled'));
        w.postMessage({ id: nextId++, type: 'cancel', target: prev });
      }
      const id = nextId++;
      return new Promise<T>((resolve, reject) => {
        const timer = timers.setTimeout(() => {
          if (pending.has(id)) restart('timeout');
        }, timeoutMs);
        pending.set(id, { type, resolve: resolve as (v: unknown) => void, reject, timer });
        latest.set(type, id);
        w.postMessage({ ...payload, id, type }, transfer);
      });
    },
    started: () => made,
    close() {
      closed = true;
      for (const id of [...pending.keys()]) finish(id)?.reject(new JobEnded('closed'));
      worker?.terminate();
      worker = null;
    },
  };
}
