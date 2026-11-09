// 탈퇴 사건의 '처리할 때' 집합 사례(docs/features/queue-admission.md §4 '판매 상태와 Kafka 구독의 첫 구현', docs/data.md §3 q:{wdr}, ADR-0214 결정 7, I-T27).
// 메모리 저장소(test/withdrawn-keys.test.ts)와 실제 Valkey의 Lua(test-int/withdrawn-keys.int.test.ts)에 같은 사례를 돌린다.
import { randomUUID } from 'node:crypto';
import type { FakeClock } from '@peaket/platform';
import { describe, expect, test } from 'vitest';
import type { WithdrawnDue } from '../src/modules/entry/domain/ports.js';

export interface DueWorld {
  due: WithdrawnDue;
  clock: FakeClock;
  /** 값(v:)이 수명(purgeBy)으로 사라진 것을 흉내 낸다 */
  dropValue(eventKey: string): Promise<void>;
}

const LEASE = 60_000;

export function withdrawnDueCases(label: string, make: () => Promise<DueWorld>) {
  describe(`탈퇴 사건 처리할 때 집합(${label})`, () => {
    const item = (now: number, o: { dueIn?: number; purgeIn?: number } = {}) => ({ eventKey: randomUUID(), pids: ['pid-a', 'pid-b'], purgeBy: now + (o.purgeIn ?? 86_400_000), dueAt: now + (o.dueIn ?? 1_000) });

    test('I-T27_때가되기전에는꺼내지않고_때가되면값과함께꺼내며_같은eventKey는한번만넣는다', async () => {
      const { due, clock } = await make();
      const a = item(clock.now());
      await due.schedule(a);
      await due.schedule({ ...a, dueAt: a.dueAt + 99_000 });
      expect((await due.claim({ leaseMs: LEASE, limit: 10 })).items.filter((x) => x.eventKey === a.eventKey)).toEqual([]);
      clock.advance(1_000);
      const got = (await due.claim({ leaseMs: LEASE, limit: 10 })).items.filter((x) => x.eventKey === a.eventKey);
      expect(got).toEqual([a]);
      await due.done(a.eventKey);
      clock.advance(LEASE + 1);
      expect((await due.claim({ leaseMs: LEASE, limit: 10 })).items.filter((x) => x.eventKey === a.eventKey)).toEqual([]);
    });

    test('I-T27_빌린동안에는다른파드가집지않고_처리를마치지못하면빌림이끝난뒤다시꺼낸다', async () => {
      const { due, clock } = await make();
      const a = item(clock.now(), { dueIn: 0 });
      await due.schedule(a);
      const mine = (r: Awaited<ReturnType<WithdrawnDue['claim']>>) => r.items.filter((x) => x.eventKey === a.eventKey).length;
      expect(mine(await due.claim({ leaseMs: LEASE, limit: 10 }))).toBe(1);
      expect(mine(await due.claim({ leaseMs: LEASE, limit: 10 }))).toBe(0);
      clock.advance(LEASE);
      expect(mine(await due.claim({ leaseMs: LEASE, limit: 10 }))).toBe(1);
      await due.done(a.eventKey);
    });

    test('[ASVS v5.0.0-14.2.4] I-T27_pid가든값이수명(purgeBy)으로사라졌으면_항목을지우고expired로센다', async () => {
      const { due, clock, dropValue } = await make();
      const a = item(clock.now(), { dueIn: 5_000, purgeIn: 10_000 });
      await due.schedule(a);
      clock.advance(10_000);
      await dropValue(a.eventKey);
      const r = await due.claim({ leaseMs: LEASE, limit: 10 });
      expect(r.items.filter((x) => x.eventKey === a.eventKey)).toEqual([]);
      expect(r.expired).toBeGreaterThanOrEqual(1);
      clock.advance(LEASE + 1);
      expect((await due.claim({ leaseMs: LEASE, limit: 10 })).items.filter((x) => x.eventKey === a.eventKey)).toEqual([]);
    });

    test('I-T27_값이아직있으면_purgeBy가지났어도버리지않고지금처리할항목으로꺼낸다(만료당기기로키를바로지운다)', async () => {
      const { due, clock } = await make();
      const a = item(clock.now(), { dueIn: 5_000, purgeIn: 10_000 });
      await due.schedule(a);
      clock.advance(10_000);
      const r = await due.claim({ leaseMs: LEASE, limit: 10 });
      expect(r.items.filter((x) => x.eventKey === a.eventKey)).toEqual([a]);
      await due.done(a.eventKey);
    });

    test('I-T27_빌려간항목은훑는범위에들지않아_계속실패하는항목이꺼낼수보다많아도뒤의항목이굶지않는다', async () => {
      const { due, clock } = await make();
      const now = clock.now();
      const all = Array.from({ length: 6 }, (_, i) => item(now, { dueIn: -10_000 + i }));
      for (const a of all) await due.schedule(a);
      const keys = new Set<string>(all.map((a) => a.eventKey));
      const got: string[] = [];
      for (let i = 0; i < 6; i++) got.push(...(await due.claim({ leaseMs: LEASE, limit: 1 })).items.map((x) => x.eventKey).filter((k) => keys.has(k)));
      expect(new Set(got)).toEqual(keys);
      for (const a of all) await due.done(a.eventKey);
    });

    test('I-T27_처리를마치지못한항목은다시나올때마다빌림이두배로늘어(1시간까지)_뒤의항목자리를덜차지한다', async () => {
      const { due, clock } = await make();
      const a = item(clock.now(), { dueIn: 0 });
      await due.schedule(a);
      const mine = async () => (await due.claim({ leaseMs: LEASE, limit: 10 })).items.some((x) => x.eventKey === a.eventKey);
      expect(await mine()).toBe(true); // 1번째: 빌림 60초
      clock.advance(LEASE);
      expect(await mine()).toBe(true); // 2번째: 빌림 120초
      clock.advance(LEASE);
      expect(await mine()).toBe(false);
      clock.advance(LEASE);
      expect(await mine()).toBe(true);
      await due.done(a.eventKey);
    });

    test('I-T27_가장오래된때를알려준다(경보:때가지난지5분[가정])', async () => {
      const { due, clock } = await make();
      const now = clock.now();
      const a = item(now, { dueIn: 2_000 });
      const b = item(now, { dueIn: -3_000 });
      await due.schedule(a);
      await due.schedule(b);
      expect(await due.oldestDue()).toBeLessThanOrEqual(now - 3_000);
      await due.done(b.eventKey);
      await due.done(a.eventKey);
    });
  });
}
