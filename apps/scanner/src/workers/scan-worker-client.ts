// 화면 스레드와 판정 Worker 사이의 요청/응답 고리(frontend §5.5).
// 응답 id로 요청을 가르고, 응답이 없거나 Worker가 죽으면 통과가 아니라 RETRY로 닫는다.
import { parseScanWorkerResponse, type ScanWorkerResponse } from './qr-protocol.ts';

export interface ScanWorkerPort {
  postMessage(message: unknown, transfer?: readonly unknown[]): void;
  terminate(): void;
  addEventListener(type: 'message' | 'error', fn: (e: unknown) => void): void;
}

type Pending =
  | { kind: 'decode'; resolve(value: string | undefined): void; timer: unknown }
  | { kind: 'judge'; resolve(value: unknown): void; timer: unknown };

export class ScanWorkerClient {
  readonly #worker: ScanWorkerPort;
  readonly #timeoutMs: number;
  readonly #setTimer: (fn: () => void, ms: number) => unknown;
  readonly #clearTimer: (h: unknown) => void;
  readonly #pending = new Map<number, Pending>();
  #nextId = 1;
  #disposed = false;

  constructor(o: {
    worker: ScanWorkerPort;
    timeoutMs?: number;
    setTimer?(fn: () => void, ms: number): unknown;
    clearTimer?(h: unknown): void;
  }) {
    this.#worker = o.worker;
    this.#timeoutMs = o.timeoutMs ?? 1_000;
    this.#setTimer = o.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.#clearTimer = o.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.#worker.addEventListener('message', (e) => this.#onMessage(e));
    this.#worker.addEventListener('error', () => this.#failAll());
  }

  prepare(state: unknown): void {
    if (this.#disposed) return;
    this.#worker.postMessage({ type: 'prepare', state });
  }

  decode(bitmap: unknown): Promise<string | undefined> {
    if (this.#disposed) return Promise.resolve(undefined);
    return new Promise<string | undefined>((resolve) => {
      const id = this.#nextId++;
      const timer = this.#setTimer(() => {
        this.#pending.delete(id);
        resolve(undefined);
      }, this.#timeoutMs);
      this.#pending.set(id, { kind: 'decode', resolve, timer });
      this.#worker.postMessage({ type: 'decode', id, bitmap });
    });
  }

  judge(i: { raw: string; nowMs: number; clockOffsetMs: number }): Promise<unknown> {
    if (this.#disposed) return Promise.resolve({ result: 'RETRY' });
    return new Promise<unknown>((resolve) => {
      const id = this.#nextId++;
      const timer = this.#setTimer(() => {
        this.#pending.delete(id);
        resolve({ result: 'RETRY' });
      }, this.#timeoutMs);
      this.#pending.set(id, { kind: 'judge', resolve, timer });
      this.#worker.postMessage({ type: 'judge', id, raw: i.raw, nowMs: i.nowMs, clockOffsetMs: i.clockOffsetMs });
    });
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#worker.terminate();
    for (const [id, pending] of this.#pending) {
      this.#clearTimer(pending.timer);
      (pending.resolve as (value: unknown) => void)(pending.kind === 'judge' ? { result: 'RETRY' } : undefined);
      this.#pending.delete(id);
    }
  }

  #onMessage(e: unknown): void {
    const data = (e as { data?: unknown }).data;
    const message = parseScanWorkerResponse(data);
    if (!message) return;
    const pending = this.#pending.get(message.id);
    if (!pending) return;
    if (pending.kind === 'decode' && (message.type === 'decoded' || message.type === 'decode-failed')) {
      this.#clearTimer(pending.timer);
      this.#pending.delete(message.id);
      pending.resolve(message.type === 'decoded' ? message.raw : undefined);
      return;
    }
    if (pending.kind === 'judge' && (message.type === 'judged' || message.type === 'worker-error')) {
      this.#clearTimer(pending.timer);
      this.#pending.delete(message.id);
      pending.resolve(message.type === 'judged' ? message.outcome : { result: 'RETRY' });
    }
  }

  #failAll(): void {
    for (const [id, pending] of this.#pending) {
      this.#clearTimer(pending.timer);
      (pending.resolve as (value: unknown) => void)(pending.kind === 'judge' ? { result: 'RETRY' } : undefined);
      this.#pending.delete(id);
    }
  }
}

export type { ScanWorkerResponse };
