// 검색에서 빠진 공연의 커밋 뒤 일(BAT-165 웨이브 7 T-06, catalog-review 16.1.1).
// 정본: docs/features/search.md §2.3(57줄: 승인 취소·회차 전부 취소로 공연이 빠지면 그 트랜잭션이 끝난 뒤 CDN 검색 경로 `/v1/search*`를 비운다),
// §10(270줄: 정규 로그 줄 `search_removed`(공연 ID, 이유, 판, CDN 무효화 요청 ID), CDN 무효화 실패는 경보), ADR-0271 결정 2·7·8.
// SR-T8 ③(판매 중지·회차 전부 취소 처리가 이것을 부르는지)은 BAT-620·BAT-420 몫이라 이름에 달지 않는다.
// 로그 칸 이름 searchVersion(계획 '### 13' R165-6, ADR-0271 결정 15). 무효화 요청 ID(계획 '### 12. 시험 뒤 정한 것' 2): invalidatePaths가 { requestId }를 돌려주고, search_removed 줄마다 invalidationRequestId로 싣는다(실패면 null).
// 바깥 경계: withSearchSync(트랜잭션 안에서 동기화를 부르고, 커밋 뒤 무효화·기록). 가짜 DB가 커밋·되돌림 차례를 남긴다.
import type { DbTransaction } from '@peaket/platform';
import { describe, expect, test } from 'vitest';
import { MemoryCdnInvalidation, withSearchSync, type SearchReadModelSync } from '../src/modules/catalog/index.js';
import type { CdnInvalidation } from '../src/modules/catalog/domain/media-ports.js';

const AT = new Date('2026-11-16T03:00:00.000Z');
const TX = { fake: 'tx' } as unknown as DbTransaction;

function harness(o: { removed: string[]; version: number; cdnFails?: boolean; requestId?: string }) {
  const order: string[] = [];
  // 무효화와 로그 줄의 차례(무효화를 부른 뒤 search_removed 줄을 남긴다)
  const timeline: string[] = [];
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
    reconcileAll: () => Promise.reject(new Error('부르지 않는다')),
    lastReconciledAt: () => Promise.reject(new Error('부르지 않는다')),
    syncPoster: () => Promise.reject(new Error('부르지 않는다')),
  };
  const cdn: CdnInvalidation = {
    async invalidate() {
      order.push('invalidate-tags');
    },
    async invalidatePaths(p) {
      order.push('invalidate-paths');
      timeline.push('invalidate-paths');
      paths.push([...p]);
      if (o.cdnFails) throw new Error('CDN이 답하지 않는다');
      return { requestId: o.requestId ?? 'inv-7' };
    },
  };
  const logger = {
    info: (obj: Record<string, unknown>) => {
      info.push(obj);
      timeline.push(`info:${String(obj.event)}`);
    },
    warn: (obj: Record<string, unknown>) => {
      warn.push(obj);
      timeline.push(`warn:${String(obj.event)}`);
    },
  };
  return { order, timeline, info, warn, syncCalls, paths, deps: { database, sync, cdn, logger: logger as never, reason: 'SALE_SUSPENDED', at: AT } };
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
    // 판은 searchVersion에 싣는다. version은 로그 바탕 칸(서비스 판)이라 이 줄이 따로 싣지 않는다(ADR-0271 결정 15, R165-6)
    expect(removed.every((l) => !('version' in l))).toBe(true);
    expect(removed.map((l) => [l.productionId, l.reason, l.searchVersion])).toEqual([
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
    expect(failing.info.filter((l) => l.event === 'search_removed').map((l) => [l.productionId, l.reason, l.searchVersion])).toEqual([['p9', 'SALE_SUSPENDED', 14]]);
  });

  test('검색에서 빠진 공연의 search_removed 줄은 경로 무효화가 돌려준 요청 ID를 싣고, 무효화가 실패하면 null이다 [ASVS v5.0.0-16.1.1]', async () => {
    // 한 트랜잭션에서 공연 둘이 빠지면 무효화는 1번이고, 돌려준 ID가 두 줄에 같이 실린다
    const h = harness({ removed: ['p1', 'p2'], version: 21, requestId: 'inv-7' });
    await expect(withSearchSync(h.deps, async () => ({ result: 'ok', productionIds: ['p1', 'p2'] }))).resolves.toBe('ok');
    expect(h.paths).toEqual([['/v1/search*']]);
    const lines = h.info.filter((l) => l.event === 'search_removed');
    expect(lines.map((l) => ({ productionId: l.productionId, reason: l.reason, searchVersion: l.searchVersion, invalidationRequestId: l.invalidationRequestId, hasVersion: 'version' in l }))).toEqual([
      { productionId: 'p1', reason: 'SALE_SUSPENDED', searchVersion: 21, invalidationRequestId: 'inv-7', hasVersion: false },
      { productionId: 'p2', reason: 'SALE_SUSPENDED', searchVersion: 21, invalidationRequestId: 'inv-7', hasVersion: false },
    ]);
    // 줄은 무효화를 부른 뒤에 남긴다
    expect(h.timeline.filter((t) => t === 'invalidate-paths' || t === 'info:search_removed')).toEqual(['invalidate-paths', 'info:search_removed', 'info:search_removed']);
    expect(h.warn).toEqual([]);

    // 돌려준 ID를 그대로 싣는다(시험이 정한 다른 값)
    const other = harness({ removed: ['p3'], version: 22, requestId: 'I2ABCDEF9XYZ' });
    await withSearchSync(other.deps, async () => ({ result: 1, productionIds: ['p3'] }));
    expect(other.info.filter((l) => l.event === 'search_removed').map((l) => l.invalidationRequestId)).toEqual(['I2ABCDEF9XYZ']);

    // 무효화가 던지면 줄마다 null이고 경고 1줄, 처리는 성공이며 줄은 무효화를 부른 뒤 남긴다
    const failing = harness({ removed: ['p4', 'p5'], version: 23, cdnFails: true });
    await expect(withSearchSync(failing.deps, async () => ({ result: 'still-ok', productionIds: ['p4', 'p5'] }))).resolves.toBe('still-ok');
    expect(failing.paths).toEqual([['/v1/search*']]);
    expect(failing.info.filter((l) => l.event === 'search_removed').map((l) => [l.productionId, l.invalidationRequestId])).toEqual([
      ['p4', null],
      ['p5', null],
    ]);
    expect(failing.warn.filter((l) => l.event === 'cdn_invalidation_failed')).toHaveLength(1);
    expect(failing.timeline.indexOf('invalidate-paths')).toBeLessThan(failing.timeline.indexOf('info:search_removed'));

    // 되돌린 트랜잭션은 무효화 0번, 줄 0이다
    const rolled = harness({ removed: ['p6'], version: 24 });
    await expect(
      withSearchSync(rolled.deps, async () => {
        throw new Error('쓰기 실패');
      }),
    ).rejects.toThrow('쓰기 실패');
    expect(rolled.paths).toEqual([]);
    expect(rolled.info.filter((l) => l.event === 'search_removed')).toEqual([]);
  });

  test('메모리 CDN 무효화는 경로 무효화를 부를 때마다 겹치지 않는 요청 ID를 돌려준다', async () => {
    const cdn = new MemoryCdnInvalidation();
    const ids = [];
    for (let i = 0; i < 3; i++) ids.push((await cdn.invalidatePaths(['/v1/search*'])).requestId);
    for (const id of ids) {
      expect(typeof id).toBe('string');
      expect(id.length).toBeGreaterThan(0);
    }
    expect(new Set(ids).size).toBe(3);
    // 다른 객체도 같은 ID를 되풀이하지 않는다
    const second = await new MemoryCdnInvalidation().invalidatePaths(['/v1/search*']);
    expect(ids).not.toContain(second.requestId);
  });
});
