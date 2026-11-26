// F-10-2 image-worker 동시 처리 1·한 건 시한(계획 docs/review/plans/F-10-2.md §3·§5, ASVS v5.0.0-5.2.1).
// 파드마다 동시 처리 1만 받는다. 두 번째 작업은 첫 작업이 끝난 뒤 시작하고, 시한이 지나면 거절한 뒤 자리를 비운다.
export function createImageQueue(o: { concurrency: number; timeoutMs?: number }): { run<T>(fn: () => Promise<T>): Promise<T> } {
  if (o.concurrency !== 1) throw new Error(`PEAKET_IMAGE_CONCURRENCY는 1만 받는다: ${o.concurrency}`);
  const timeoutMs = o.timeoutMs ?? 30_000;
  let chain: Promise<void> = Promise.resolve();
  return {
    run<T>(fn: () => Promise<T>): Promise<T> {
      const result = chain.then(() => withTimeout(fn(), timeoutMs));
      chain = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
  };
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`image processing timeout after ${ms}ms`)), ms);
    timer.unref?.();
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}
