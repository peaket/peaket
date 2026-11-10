// 유스케이스 층: 팬 좌석맵 파일을 회차마다 쓰고 지우기(ADR-0260 결정 5·6·8, docs/api/guidelines.md §8·§8.1 S3 팬 좌석맵 파일 행).
// 동시 쓰기 수와 전체 시한을 지킨다(8개·20초 [가정], 시험은 주입으로 바꾼다). 하나라도 쓰지 못하거나 시한을 넘기면 더 쓰지 않고, 이미 쓴 파일과
// 쓰는 중이던 파일(끝나는 대로)을 지운 뒤 PublishFailed를 던진다. 받는 쪽이 503 seatmap-publish-unavailable로 답하고 판을 올리지 않는다.
import { Inject, Injectable, Optional } from '@nestjs/common';
import { FAN_FILE_CACHE_CONTROL, FAN_FILE_CONTENT_TYPE, PUBLISH_CONCURRENCY, PUBLISH_TOTAL_MS } from '../domain/seatmap-layout.js';
import { PUBLIC_FILE_STORE, type PublicFileStore, PUBLISH_LIMITS, type PublishLimits } from '../domain/seatmap-ports.js';

/** 게시 실패. reason은 기록의 오류 갈래(write 쓰기 거절·오류, timeout 전체 시한), failed는 쓰지 못한 회차 수 */
export class PublishFailed extends Error {
  constructor(
    readonly reason: 'write' | 'timeout',
    readonly failed: number,
  ) {
    super(`팬 좌석맵 파일을 쓰지 못했다(${reason}, ${failed}개)`);
  }
}

@Injectable()
export class FanFilePublisher {
  constructor(
    @Inject(PUBLIC_FILE_STORE) private readonly store: PublicFileStore,
    @Optional() @Inject(PUBLISH_LIMITS) private readonly limits?: PublishLimits,
  ) {}

  /**
   * keys마다 같은 바이트를 쓴다. 실패하면 쓴 것을 지우고 PublishFailed. 그 지우기가 실패하면 onLeftover(지우지 못한 수)를 부른다.
   * budgetMs를 주면 전체 시한은 정한 값과 그 값 가운데 짧은 쪽이다(요청의 남은 시간, 리뷰 C3)
   */
  async publish(keys: readonly string[], bytes: Uint8Array, o: { onLeftover?: (count: number) => void; budgetMs?: number } = {}): Promise<void> {
    if (keys.length === 0) return;
    const concurrency = Math.max(1, this.limits?.concurrency ?? PUBLISH_CONCURRENCY);
    const totalMs = Math.min(this.limits?.totalMs ?? PUBLISH_TOTAL_MS, o.budgetMs ?? Number.POSITIVE_INFINITY);
    const onLeftover = o.onLeftover;
    const meta = { contentType: FAN_FILE_CONTENT_TYPE, cacheControl: FAN_FILE_CACHE_CONTROL };
    const started: { key: string; done: Promise<boolean> }[] = [];
    let next = 0;
    let stop = false;
    let written = 0;
    let rejected = false;
    const worker = async () => {
      while (!stop && next < keys.length) {
        const key = keys[next++]!;
        const done = this.store.put(key, bytes, meta).then(
          () => true,
          () => false,
        );
        started.push({ key, done });
        if (await done) written++;
        else {
          rejected = true;
          stop = true;
        }
      }
    };
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<'timeout'>((r) => (timer = setTimeout(() => r('timeout'), totalMs)));
    const all = Promise.all(Array.from({ length: Math.min(concurrency, keys.length) }, worker)).then(() => 'done' as const);
    const outcome = await Promise.race([all, timedOut]);
    clearTimeout(timer);
    if (outcome === 'done' && !rejected) return;
    stop = true;
    const failed = keys.length - written;
    // 쓰는 중이던 것도 끝나는 대로 지운다. 이미 끝난 것의 지우기는 기다리고(응답 전에), 늦은 쓰기는 끝나면 뒤에서 지운다
    const removals = Promise.all(
      started.map(({ key, done }) =>
        done
          .then(() => this.store.delete(key))
          .then(
            () => 0,
            () => 1,
          ),
      ),
    ).then((r) => {
      const left = r.reduce<number>((n, x) => n + x, 0);
      if (left > 0) onLeftover?.(left);
    });
    if (outcome === 'done') await removals;
    else void removals;
    throw new PublishFailed(outcome === 'timeout' ? 'timeout' : 'write', failed);
  }

  /** 지운다(없는 키는 그대로 지나간다). 지우지 못한 키 수를 돌려준다 */
  async remove(keys: readonly string[]): Promise<number> {
    const concurrency = Math.max(1, this.limits?.concurrency ?? PUBLISH_CONCURRENCY);
    let next = 0;
    let left = 0;
    const worker = async () => {
      while (next < keys.length) {
        const key = keys[next++]!;
        try {
          await this.store.delete(key);
        } catch {
          left++;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, keys.length) }, worker));
    return left;
  }
}
