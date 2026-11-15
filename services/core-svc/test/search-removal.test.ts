// 검색에서 빠진 공연의 커밋 뒤 일(BAT-165 웨이브 7 T-06, catalog-review 16.1.1).
// 정본: docs/features/search.md §2.3(57줄: 승인 취소·회차 전부 취소로 공연이 빠지면 그 트랜잭션이 끝난 뒤 CDN 검색 경로 `/v1/search*`를 비운다),
// §10(270줄: 정규 로그 줄 `search_removed`(공연 ID, 이유, 판, CDN 무효화 요청 ID), CDN 무효화 실패는 경보), ADR-0271 결정 2·7·8.
// SR-T8 ③(판매 중지·회차 전부 취소 처리가 이것을 부르는지)은 BAT-620·BAT-420 몫이라 이름에 달지 않는다.
// 바깥 경계: withSearchSync(트랜잭션 안에서 동기화를 부르고, 커밋 뒤 무효화·기록). 가짜 DB가 커밋·되돌림 차례를 남긴다.
import type { DbTransaction } from '@peaket/platform';
import { describe, expect, test } from 'vitest';
import { withSearchSync, type SearchReadModelSync } from '../src/modules/catalog/index.js';
import type { CdnInvalidation } from '../src/modules/catalog/domain/media-ports.js';

const AT = new Date('2026-11-16T03:00:00.000Z');
const TX = { fake: 'tx' } as unknown as DbTransaction;

function harness(o: { removed: string[]; version: number; cdnFails?: boolean }) {
  const order: string[] = [];
  const info: Record<string, unknown>[] = [];
  const warn: Record<string, unknown>[] = [];
  const syncCalls: { tx: unknown; ids: readonly string[]; at: Date }[] = [];
  const paths: string[][] = [];
  const database = {
    async transaction<T>(fn: (tx: DbTransaction) => Promise<T>): Promise<T> {
      order.push('begin');
      try {
        const r = await fn(TX);
        order.push('commit');
        return r;
      } catch (err) {
        order.push('rollback');
        throw err;
      }
    },
  };
  const sync: SearchReadModelSync = {
    async sync(tx, ids, at) {
      order.push('sync');
      syncCalls.push({ tx, ids, at });
      return { version: o.version, removed: o.removed };
    },
    syncTimed: () => Promise.reject(new Error('부르지 않는다')),
    recountInterest: () => Promise.reject(new Error('부르지 않는다')),
    purgeRemovals: () => Promise.reject(new Error('부르지 않는다')),
  };
  const cdn: CdnInvalidation = {
    async invalidate() {
      order.push('invalidate-tags');
    },
    async invalidatePaths(p) {
      order.push('invalidate-paths');
      paths.push([...p]);
      if (o.cdnFails) throw new Error('CDN이 답하지 않는다');
    },
  };
  const logger = {
    info: (obj: Record<string, unknown>) => {
      info.push(obj);
    },
    warn: (obj: Record<string, unknown>) => {
      warn.push(obj);
    },
  };
  return { order, info, warn, syncCalls, paths, deps: { database, sync, cdn, logger: logger as never, reason: 'SALE_SUSPENDED', at: AT } };
}

describe('검색에서 빠진 공연', () => {
  test('검색에서 빠진 공연은 커밋 뒤 /v1/search* 경로 무효화를 부르고 search_removed 줄을 남긴다 [ASVS v5.0.0-16.1.1]', async () => {
    const h = harness({ removed: ['p1', 'p2'], version: 10 });
    const out = await withSearchSync(h.deps, async (tx) => {
      h.order.push('work');
      expect(tx).toBe(TX);
      return { result: 'done', productionIds: ['p1', 'p2', 'p3'] };
    });
    expect(out).toBe('done');
    // 같은 트랜잭션에서 동기화하고, 무효화는 커밋 뒤에 한 번
    expect(h.order).toEqual(['begin', 'work', 'sync', 'commit', 'invalidate-paths']);
    expect(h.syncCalls).toEqual([{ tx: TX, ids: ['p1', 'p2', 'p3'], at: AT }]);
    expect(h.paths).toEqual([['/v1/search*']]);
    // 빠진 공연마다 한 줄: 공연 ID·이유·판
    const removed = h.info.filter((l) => l.event === 'search_removed');
    expect(removed.map((l) => [l.productionId, l.reason, l.version])).toEqual([
      ['p1', 'SALE_SUSPENDED', 10],
      ['p2', 'SALE_SUSPENDED', 10],
    ]);
    expect(h.warn).toEqual([]);

    // 빠진 공연이 없으면 무효화도 줄도 없다(빈 결과가 '무효화함'으로 새지 않는다)
    const none = harness({ removed: [], version: 11 });
    await withSearchSync(none.deps, async () => ({ result: 1, productionIds: ['p3'] }));
    expect(none.order).toEqual(['begin', 'sync', 'commit']);
    expect(none.paths).toEqual([]);
    expect(none.info.filter((l) => l.event === 'search_removed')).toEqual([]);

    // 트랜잭션이 되돌려지면 무효화하지 않고 줄도 없으며 오류가 그대로 나간다
    const rolled = harness({ removed: ['p1'], version: 12 });
    await expect(
      withSearchSync(rolled.deps, async () => {
        throw new Error('쓰기 실패');
      }),
    ).rejects.toThrow('쓰기 실패');
    expect(rolled.order).toEqual(['begin', 'rollback']);
    expect(rolled.paths).toEqual([]);
    expect(rolled.info.filter((l) => l.event === 'search_removed')).toEqual([]);

    // 동기화 뒤 같은 트랜잭션에서 실패해도(커밋 전) 무효화하지 않는다
    const late = harness({ removed: ['p1'], version: 13 });
    const lateDb = late.deps.database;
    late.deps.database = {
      transaction: <T>(fn: (tx: DbTransaction) => Promise<T>) =>
        lateDb.transaction(async (tx) => {
          const r = await fn(tx);
          throw Object.assign(new Error('커밋 실패'), { r });
        }),
    } as typeof lateDb;
    await expect(withSearchSync(late.deps, async () => ({ result: 1, productionIds: ['p1'] }))).rejects.toThrow('커밋 실패');
    expect(late.paths).toEqual([]);

    // 무효화가 실패하면 경고 줄을 남기고 처리는 성공이다. 빠진 공연 줄은 그대로 남긴다
    const failing = harness({ removed: ['p9'], version: 14, cdnFails: true });
    await expect(withSearchSync(failing.deps, async () => ({ result: 'ok', productionIds: ['p9'] }))).resolves.toBe('ok');
    expect(failing.paths).toEqual([['/v1/search*']]);
    expect(failing.warn.filter((l) => l.event === 'cdn_invalidation_failed')).toHaveLength(1);
    expect(failing.info.filter((l) => l.event === 'search_removed').map((l) => [l.productionId, l.reason, l.version])).toEqual([['p9', 'SALE_SUSPENDED', 14]]);
  });
});
