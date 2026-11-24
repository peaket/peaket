// GAT-260 찜의 탈퇴·병합 수명주기와 core-svc 합성 소비자 처리기(시험 먼저, BUILD_ORDER F-05-8).
// 탈퇴는 그 계정 찜만 지우고, 병합은 흡수 계정 찜을 대표 계정으로 옮기며 같은 찜은 하나만 남긴다. 두 번 받아도 같다.
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { MemoryCatalogRepository } from '../src/modules/catalog/index.js';
import { WishLifecycle } from '../src/modules/catalog/application/wish-lifecycle.js';
import { CatalogAccountWithdrawnHandler } from '../src/modules/catalog/inbound/account-withdrawn.handler.js';
import { CatalogAccountMergedHandler } from '../src/modules/catalog/inbound/account-merged.handler.js';
import { CoreAccountEventHandler } from '../src/consumers/index.js';

const NOW = Date.parse('2026-11-05T00:00:00Z');

/** 공개 공연·회차 하나를 메모리 저장소에 넣는다 */
function seed(repo: MemoryCatalogRepository, title = '공연'): string {
  const productionId = randomUUID();
  const eventId = randomUUID();
  repo.productions.set(productionId, {
    id: productionId,
    promoterId: randomUUID(),
    placeId: randomUUID(),
    title,
    genre: '콘서트',
    saleReview: 'APPROVED',
    saleApprovedAt: new Date(NOW - 86_400_000),
  });
  repo.events.set(eventId, {
    id: eventId,
    productionId,
    venueId: null,
    openAt: new Date(NOW - 86_400_000),
    startsAt: new Date(NOW + 7 * 86_400_000),
    status: 'SCHEDULED',
  });
  return productionId;
}

function wish(repo: MemoryCatalogRepository, accountId: string, productionId: string, at: number): void {
  const mine = repo.wishes.get(accountId) ?? new Map<string, Date>();
  mine.set(productionId, new Date(at));
  repo.wishes.set(accountId, mine);
}

describe('찜의 탈퇴·병합', () => {
  test('GAT-260 탈퇴 사건을 두 번 받아도 그 계정 찜만 0건이 된다', async () => {
    const repo = new MemoryCatalogRepository();
    const lifecycle = new WishLifecycle(repo);
    const me = randomUUID();
    const other = randomUUID();
    const a = seed(repo, '내 공연 A');
    const b = seed(repo, '내 공연 B');
    const c = seed(repo, '남의 공연');
    wish(repo, me, a, NOW - 2_000);
    wish(repo, me, b, NOW - 1_000);
    wish(repo, other, c, NOW);

    expect(await lifecycle.purgeWithdrawn(me)).toBe(2);
    expect(await lifecycle.purgeWithdrawn(me)).toBe(0);
    expect(await lifecycle.absorbedWishes(me)).toBe(0);
    expect(await lifecycle.absorbedWishes(other)).toBe(1);
  });

  test('GAT-260 병합 사건을 두 번 받아도 대표 계정 찜이 겹치지 않고 흡수 계정 찜이 0건이다', async () => {
    const repo = new MemoryCatalogRepository();
    const lifecycle = new WishLifecycle(repo);
    const primary = randomUUID();
    const absorbed = randomUUID();
    const onlyAbsorbed = seed(repo, '흡수만 찜');
    const both = seed(repo, '둘 다 찜');
    wish(repo, primary, both, NOW - 3_000);
    wish(repo, absorbed, onlyAbsorbed, NOW - 2_000);
    wish(repo, absorbed, both, NOW - 1_000);

    expect(await lifecycle.absorbedWishes(absorbed)).toBe(2);
    expect(await lifecycle.moveMerged(primary, absorbed)).toBe(2);
    expect(await lifecycle.moveMerged(primary, absorbed)).toBe(0);
    expect(await lifecycle.absorbedWishes(absorbed)).toBe(0);
    // 대표 계정의 같은 찜은 처음 시각을 지킨다
    expect(repo.wishes.get(primary)?.get(both)?.getTime()).toBe(NOW - 3_000);
    expect(repo.wishes.get(primary)?.get(onlyAbsorbed)?.getTime()).toBe(NOW - 2_000);
  });

  test('GAT-260 탈퇴·병합 처리기는 계약 모양만 읽고 계정 ID를 소문자로 맞춘다', () => {
    const calls: string[] = [];
    const withdrawn = new CatalogAccountWithdrawnHandler({ purgeWithdrawn: async (id) => (calls.push(`purge:${id}`), 1) });
    const merged = new CatalogAccountMergedHandler({ moveMerged: async (p, a) => (calls.push(`move:${p}>${a}`), 2) });
    const A = randomUUID();
    const B = randomUUID();
    const eventKey = randomUUID();

    const w = withdrawn.decode({ topic: 'identity.accounts-withdrawn', partition: 0, offset: 0n, key: null, value: Buffer.from(JSON.stringify({ eventKey, accountId: A })), headers: {}, timestamp: NOW });
    expect(w).toEqual({ eventKey, accountId: A.toLowerCase() });
    const m = merged.decode({ topic: 'identity.accounts-merged', partition: 0, offset: 0n, key: null, value: Buffer.from(JSON.stringify({ mergeId: 'm1', primaryAccountId: A, mergedAccountId: B, confirmedAt: '2026-11-05T00:00:00Z' })), headers: {}, timestamp: NOW });
    expect(m).toEqual({ mergeId: 'm1', primaryAccountId: A.toLowerCase(), mergedAccountId: B.toLowerCase() });

    expect(() => withdrawn.decode({ topic: 'identity.accounts-withdrawn', partition: 0, offset: 0n, key: null, value: Buffer.from('{"accountId":"x"}'), headers: {}, timestamp: NOW })).toThrow();
    expect(() => merged.decode({ topic: 'identity.accounts-merged', partition: 0, offset: 0n, key: null, value: null, headers: {}, timestamp: NOW })).toThrow();
  });

  test('GAT-260 합성 처리기는 토픽으로 갈라 후기·찜 처리기를 부르고 업무 키·중복 키를 고른다', async () => {
    const calls: string[] = [];
    const review = { decode: (m: { value: Buffer | null }) => JSON.parse(m.value!.toString('utf8')), handle: async () => void calls.push('review') };
    const wishWithdrawn = { decode: (m: { value: Buffer | null }) => JSON.parse(m.value!.toString('utf8')), handle: async () => void calls.push('wish-withdrawn') };
    const wishMerged = { decode: (m: { value: Buffer | null }) => JSON.parse(m.value!.toString('utf8')), handle: async () => void calls.push('wish-merged') };
    const handler = new CoreAccountEventHandler(review, wishWithdrawn, wishMerged);

    const withdrawn = handler.decode({ topic: 'identity.accounts-withdrawn', partition: 0, offset: 0n, key: null, value: Buffer.from(JSON.stringify({ eventKey: 'e1', accountId: 'acc-1' })), headers: {}, timestamp: NOW });
    expect(handler.keyOf(withdrawn)).toBe('acc-1');
    expect(handler.eventKeyOf(withdrawn)).toBe('e1');
    await handler.handle(withdrawn);
    expect(calls).toEqual(['review', 'wish-withdrawn']);

    const merged = handler.decode({ topic: 'identity.accounts-merged', partition: 0, offset: 0n, key: null, value: Buffer.from(JSON.stringify({ mergeId: 'm1', primaryAccountId: 'acc-1', mergedAccountId: 'acc-2' })), headers: {}, timestamp: NOW });
    expect(handler.keyOf(merged)).toBe('acc-2');
    expect(handler.eventKeyOf(merged)).toBe('m1');
    await handler.handle(merged);
    expect(calls).toEqual(['review', 'wish-withdrawn', 'wish-merged']);
  });
});
