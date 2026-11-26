// F-10-2 image-worker 동시 처리 1·한 건 시한(계획 docs/review/plans/F-10-2.md §3·§5·§7,
// ASVS v5.0.0-5.2.1, docs/devops.md D-T35). 실제 파드에서 동시에 두 이미지를 처리하지 않는지,
// 한 이미지가 시한을 넘으면 자리를 비우는지 결정적으로 본다(가짜 작업으로 시간을 흔든다).
// 시험 먼저: 구현 전에는 src/image-worker/queue.js가 없어 이 파일이 실패한다(ADR-0372).
import { beforeAll, describe, expect, test } from 'vitest';

let createImageQueue: ((o: { concurrency: number; timeoutMs?: number }) => { run<T>(fn: () => Promise<T>): Promise<T> }) | undefined;
let startFailure: string | undefined;
const ready = () => {
  if (startFailure) throw new Error(startFailure);
  if (!createImageQueue) throw new Error('createImageQueue가 없다');
  return createImageQueue;
};

beforeAll(async () => {
  try {
    // @ts-ignore 구현 전에는 이 모듈이 없다(시험 먼저, ADR-0372)
    const mod = (await import('../src/image-worker/queue.js')) as { createImageQueue?: typeof createImageQueue };
    createImageQueue = mod.createImageQueue;
    if (typeof createImageQueue !== 'function') startFailure = 'src/image-worker/queue.js에 createImageQueue가 없다';
  } catch (e) {
    startFailure = e instanceof Error ? e.message : String(e);
  }
});

describe('F-10-2 image-worker 동시 처리', () => {
  test('F-10-2 image-worker 작업 큐는 동시 처리 1에서 둘째 작업을 첫 작업이 끝날 때까지 시작하지 않는다 [ASVS v5.0.0-5.2.1]', async () => {
    const q = ready()({ concurrency: 1 });
    const events: string[] = [];
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    const first = q.run(
      () =>
        new Promise<void>((resolve) => {
          events.push('first-start');
          releaseFirst = () => {
            events.push('first-end');
            resolve();
          };
        }),
    );
    const second = q.run(
      () =>
        new Promise<void>((resolve) => {
          events.push('second-start');
          releaseSecond = () => {
            events.push('second-end');
            resolve();
          };
        }),
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(events).toEqual(['first-start']);
    releaseFirst();
    await new Promise((r) => setTimeout(r, 20));
    expect(events).toEqual(['first-start', 'first-end', 'second-start']);
    releaseSecond();
    await Promise.all([first, second]);
  });

  test('F-10-2 image-worker 작업 큐는 동시 처리 1이 아니면 만들지 않고, 시한이 지난 작업은 거절한 뒤 자리를 비운다 [ASVS v5.0.0-5.2.1]', async () => {
    const make = ready();
    expect(() => make({ concurrency: 0 })).toThrow();
    expect(() => make({ concurrency: 2 })).toThrow();
    const q = make({ concurrency: 1, timeoutMs: 20 });
    await expect(q.run(() => new Promise<void>(() => {}))).rejects.toThrow(/timeout|시한|시간/i);
    // 시한이 지난 작업이 자리를 쥐고 있지 않다
    await expect(q.run(async () => 'next')).resolves.toBe('next');
  });
});
