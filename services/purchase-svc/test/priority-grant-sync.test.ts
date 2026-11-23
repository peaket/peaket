// F-05-3 우선 구매 권리 대조 시험(GAT-135, S-T37 ⑩~⑫). 구현 전에는 새 모듈이 없어 이 시험이 실패한다.
// 대조는 ① 기한 지난 OFFERED를 EXPIRED로 바꾸고 ② 만료 전 OFFERED·USED·WITHDRAWN을 queue 사본으로 다시 보낸다.
// 사본 보내기·DB 실패는 다음 틱에 다시 하고, 지표·로그로 드러낸다.
import { randomUUID } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import type { PriorityGrant } from '../src/modules/priority/domain/priority-grant.js';

const NOW = Date.parse('2026-11-24T02:00:00.000Z');
const HOUR = 3600_000;

function grant(over: Partial<PriorityGrant> = {}): PriorityGrant {
  return {
    grantId: randomUUID(),
    eventId: randomUUID(),
    accountId: randomUUID(),
    fraudCaseId: randomUUID(),
    cancelledTicketId: randomUUID(),
    grantKind: 'SAME_SEAT',
    seatId: randomUUID(),
    tierId: 'R',
    price: 110_000,
    status: 'OFFERED',
    expiresAtMs: NOW + HOUR,
    version: 1,
    createdAtMs: NOW - HOUR,
    updatedAtMs: NOW - HOUR,
    ...over,
  };
}

/** 구현 전에는 모듈이 없다. 시험 파일 자체가 읽히지 않는 실패가 아니라 이 시험만 실패하게 동적으로 읽는다 */
async function syncModule(): Promise<{ PriorityGrantSync: new (deps: unknown) => { runOnce(): Promise<void> } } | undefined> {
  return import('../src/modules/priority/application/sync-priority-grants.js').catch(() => undefined) as Promise<
    { PriorityGrantSync: new (deps: unknown) => { runOnce(): Promise<void> } } | undefined
  >;
}

class FakeStore {
  readonly rows: PriorityGrant[];
  readonly order: string[] = [];
  expireCalls = 0;
  failExpire = false;

  constructor(rows: PriorityGrant[]) {
    this.rows = rows;
  }

  async expireDue(nowMs: number, limit: number): Promise<readonly PriorityGrant[]> {
    this.order.push('expireDue');
    this.expireCalls += 1;
    if (this.failExpire) throw new Error('db down');
    const due = this.rows.filter((g) => g.status === 'OFFERED' && g.activeOrderId === undefined && g.expiresAtMs <= nowMs).slice(0, limit);
    for (const g of due) {
      const at = this.rows.findIndex((x) => x.grantId === g.grantId);
      this.rows[at] = { ...g, status: 'EXPIRED', version: g.version + 1, updatedAtMs: nowMs };
    }
    return due;
  }

  async listSyncable(nowMs: number, limit: number): Promise<readonly PriorityGrant[]> {
    this.order.push('listSyncable');
    return this.rows.filter((g) => g.expiresAtMs > nowMs && (g.status === 'OFFERED' || g.status === 'USED' || g.status === 'WITHDRAWN')).slice(0, limit);
  }
}

class FakeCopies {
  readonly calls: { grantId: string; state: string; version: number; expiresAtMs: number }[] = [];
  failNext = 0;

  async set(i: { grantId: string; state: string; version: number; expiresAtMs: number }): Promise<{ changed: boolean }> {
    if (this.failNext > 0) {
      this.failNext -= 1;
      throw new Error('queue unavailable');
    }
    this.calls.push(i);
    return { changed: true };
  }
}

async function ready() {
  const mod = await syncModule();
  expect(mod?.PriorityGrantSync, 'PriorityGrantSync 모듈이 없다(F-05-3 구현 전)').toBeDefined();
  return mod!.PriorityGrantSync;
}

describe('F-05-3 우선 구매 권리 대조 [GAT-135, S-T37]', () => {
  test('S-T37 ⑩ 대조 틱이 만료 전 OFFERED·USED·WITHDRAWN을 판 번호와 만료로 보내고, 만료된 OFFERED는 EXPIRED로 고친다', async () => {
    const Sync = await ready();
    const stale = grant({ status: 'OFFERED', expiresAtMs: NOW - 1, version: 1 });
    const offered = grant({ status: 'OFFERED', expiresAtMs: NOW + HOUR, version: 1 });
    const used = grant({ status: 'USED', expiresAtMs: NOW + 2 * HOUR, version: 2 });
    const withdrawn = grant({ status: 'WITHDRAWN', expiresAtMs: NOW + 3 * HOUR, version: 3 });
    const expired = grant({ status: 'EXPIRED', expiresAtMs: NOW + 4 * HOUR, version: 4 });
    const store = new FakeStore([stale, offered, used, withdrawn, expired]);
    const copies = new FakeCopies();
    const signals: string[] = [];
    const sync = new Sync({
      grants: store,
      copies,
      clock: { now: () => NOW },
      logger: { warn: () => undefined, error: () => undefined },
      signals: { sync: (r: string) => signals.push(`sync:${r}`), expire: (r: string) => signals.push(`expire:${r}`) },
    });

    await sync.runOnce();

    expect(store.order).toEqual(['expireDue', 'listSyncable']);
    expect(store.rows.find((g) => g.grantId === stale.grantId)).toMatchObject({ status: 'EXPIRED', version: 2 });
    expect(copies.calls.map((c) => [c.grantId, c.state, c.version, c.expiresAtMs])).toEqual([
      [offered.grantId, 'OFFERED', 1, offered.expiresAtMs],
      [used.grantId, 'USED', 2, used.expiresAtMs],
      [withdrawn.grantId, 'WITHDRAWN', 3, withdrawn.expiresAtMs],
    ]);
    expect(signals).toContain('expire:ok');
    expect(signals).toContain('sync:ok');
  });

  test('S-T37 ⑪ 사본 보내기 실패는 던지지 않고 다음 틱에 다시 보낸다', async () => {
    const Sync = await ready();
    const row = grant({ status: 'WITHDRAWN', version: 2 });
    const store = new FakeStore([row]);
    const copies = new FakeCopies();
    copies.failNext = 1;
    const signals: string[] = [];
    const sync = new Sync({
      grants: store,
      copies,
      clock: { now: () => NOW },
      logger: { warn: () => undefined, error: () => undefined },
      signals: { sync: (r: string) => signals.push(`sync:${r}`), expire: (r: string) => signals.push(`expire:${r}`) },
    });

    await expect(sync.runOnce()).resolves.toBeUndefined();
    expect(signals).toContain('sync:failed');
    expect(copies.calls).toHaveLength(0);

    await sync.runOnce();
    expect(copies.calls).toEqual([{ grantId: row.grantId, state: 'WITHDRAWN', version: 2, expiresAtMs: row.expiresAtMs }]);
    expect(signals).toContain('sync:ok');
  });

  test('S-T37 ⑫ 만료 DB 실패를 다음 틱이 고친다', async () => {
    const Sync = await ready();
    const row = grant({ status: 'OFFERED', expiresAtMs: NOW - 1, version: 1 });
    const store = new FakeStore([row]);
    store.failExpire = true;
    const signals: string[] = [];
    const sync = new Sync({
      grants: store,
      copies: new FakeCopies(),
      clock: { now: () => NOW },
      logger: { warn: () => undefined, error: () => undefined },
      signals: { sync: (r: string) => signals.push(`sync:${r}`), expire: (r: string) => signals.push(`expire:${r}`) },
    });

    await sync.runOnce();
    expect(signals).toContain('expire:failed');
    expect(store.rows[0]?.status).toBe('OFFERED');

    store.failExpire = false;
    await sync.runOnce();
    expect(signals).toContain('expire:ok');
    expect(store.rows[0]).toMatchObject({ status: 'EXPIRED', version: 2 });
  });
});
