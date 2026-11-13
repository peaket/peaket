// 규모 올리기 유스케이스가 전역 잠금을 거치고 규모·판을 쓰는지 단위로 본다(ADR-0078 결정 1).
// 저장소·카탈로그는 대역이다. 실제 잠금·저장은 test-int/ops-event.int.test.ts가 본다.
import { describe, expect, test } from 'vitest';
import { fakeClock } from '@peaket/platform';
import { ChangeEventScale } from '../src/modules/catalog/application/change-event-scale.js';
import type { SaleEventRow, SaleState, SaleStore, SaleTx } from '../src/modules/catalog/domain/sale-ports.js';

const OPEN = new Date('2026-11-20T11:00:00.000Z');
const NOW = new Date('2026-11-01T00:00:00.000Z');

class FakeStore {
  lockCalls = 0;
  scale: 'LARGE' | 'MEDIUM' | 'SMALL' = 'SMALL';
  version = 1;

  async eventOwner(): Promise<{ productionId: string; tenantId: string }> {
    return { productionId: 'prod-1', tenantId: 'prom-1' };
  }

  async withScaleChangeLock<T>(_tenantId: string, fn: () => Promise<T>): Promise<T> {
    this.lockCalls++;
    return fn();
  }

  async withLockedProduction<T>(_productionId: string, _tenantId: string, fn: (tx: SaleTx) => Promise<T>): Promise<T> {
    return fn(this.#tx());
  }

  #tx(): SaleTx {
    const state = {
      production: { id: 'prod-1', promoterId: 'prom-1', saleReview: 'APPROVED', saleApprovedAt: NOW, rules: [], pendingRules: undefined, salePolicyVersion: 1 },
      events: [{ eventId: 'ev-1', status: 'SCHEDULED', version: this.version, openAt: OPEN, startsAt: OPEN, endsAt: OPEN, lobbyMinutes: 10, entryOpensAt: null, lobbyShuffle: true, openBatch: true, seatAssignment: 'PICK', perPersonLimit: 4, scale: this.scale } as SaleEventRow],
      eventChanges: {},
      addedEvents: [],
      grades: [],
      lists: [],
    } as unknown as SaleState;
    return {
      state: async () => state,
      largeOpenTimes: async (_from: Date, _to: Date, _exclude: string) => [],
      setEventScale: async (_eventId: string, scale: 'LARGE' | 'MEDIUM' | 'SMALL', version: number) => {
        this.scale = scale;
        this.version = version;
      },
    } as unknown as SaleTx;
  }
}

describe('규모 올리기 유스케이스', () => {
  test('C-T43 전역 잠금 안에서 규모와 판을 쓴다', async () => {
    const store = new FakeStore();
    const useCase = new ChangeEventScale(store as unknown as SaleStore, fakeClock({ now: NOW.getTime() }));
    await expect(useCase.run({ eventId: 'ev-1', scale: 'MEDIUM', reason: '수요 상단 상승', intervalException: false, role: 'operator' })).resolves.toEqual({ applied: true });
    expect(store.lockCalls).toBe(1);
    expect(store.scale).toBe('MEDIUM');
    expect(store.version).toBe(2);
  });
});
