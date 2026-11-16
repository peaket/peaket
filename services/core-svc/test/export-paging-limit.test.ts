// A2-17 회귀: 내보내기는 한 번에 500,001행을 요청하지 않고 1,000행 페이지를 커서로 이어 읽는다.
// W7-audit A2-17: 원천이 거른 뒤 짧은 페이지·0건 페이지를 줘도 nextCursor가 null일 때만 멈추고(docs/api/guidelines.md §3 '끝은 nextCursor가 null일 때뿐'),
// 같은 커서를 되풀이하면 503 dependency-unavailable로 끝내며 이력·접속기록을 남기지 않는다(docs/features/settlement.md §9, J-T26 ④).
import { fakeClock, ProblemError } from '@peaket/platform';
import { randomUUID } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { AttendeeExports } from '../src/modules/export/application/attendee-exports.js';
import { MemoryActorNames, MemoryAttendeeExportStore, MemoryPartnerEventLookup } from '../src/modules/export/index.js';
import type { AttendeeSource, AttendeeSourcePage, BookersReauth } from '../src/modules/export/domain/ports.js';
import type { AttendeeRecord } from '../src/modules/shop/index.js';

const TENANT = randomUUID();
const EVENT = randomUUID();
const ACCOUNT = randomUUID();
const clock = fakeClock({ now: Date.parse('2026-11-15T00:00:00Z') });
const reauth: BookersReauth = { verify: async () => ({ accountId: ACCOUNT, factors: ['passkey'] }) };

const makeRows = (n: number): AttendeeRecord[] => makeRowsFrom(0, n);

const makeRowsFrom = (start: number, n: number): AttendeeRecord[] =>
  Array.from({ length: n }, (_, i) => ({
    orderId: `order-${String(start + i).padStart(7, '0')}`,
    eventId: EVENT,
    buyerName: `구매자${start + i}`,
    buyerPhone: '010-1234-5678',
    seatLabel: `A-${start + i}`,
    quantity: 1,
  }));

/** purchase 원천을 본뜬 대역: 커서 뒤에서 limit개를 주고, 뒤에 행이 더 있을 때만 nextCursor(마지막 주문 ID)를 준다 */
function pagingSource(all: AttendeeRecord[]): AttendeeSource & { limits: number[]; cursors: (string | undefined)[] } {
  const limits: number[] = [];
  const cursors: (string | undefined)[] = [];
  return {
    limits,
    cursors,
    async list(_p, _e, limit, cursor) {
      limits.push(limit);
      cursors.push(cursor);
      const start = cursor ? Number(Buffer.from(cursor, 'base64url').toString().replace('order-', '')) + 1 : 0;
      const items = all.slice(start, start + limit);
      const more = start + limit < all.length;
      return { items, nextCursor: more && items.length > 0 ? Buffer.from(items[items.length - 1]!.orderId).toString('base64url') : null };
    },
    async count() {
      return { bookings: all.length, tickets: all.length };
    },
  };
}

/**
 * 정해 둔 페이지를 차례로 주는 원천. 커서는 주문 ID와 다른 값('c1' 등)이라 core가 커서를 직접 만들면 드러난다.
 * 정해 둔 것보다 더 부르면 던진다(끝을 못 보고 계속 부르는 결함이 시험을 오래 붙잡지 않게)
 */
function scriptedSource(pages: AttendeeSourcePage[]): AttendeeSource & { calls: { limit: number; cursor: string | undefined }[] } {
  const calls: { limit: number; cursor: string | undefined }[] = [];
  return {
    calls,
    async list(_p, _e, limit, cursor) {
      calls.push({ limit, cursor });
      const page = pages[calls.length - 1];
      if (!page) throw new Error(`원천을 정해 둔 ${pages.length}번보다 많이 불렀다`);
      return page;
    },
    async count() {
      return { bookings: 0, tickets: 0 };
    },
  };
}

const app = (s: AttendeeSource, store = new MemoryAttendeeExportStore()): AttendeeExports => {
  const events = new MemoryPartnerEventLookup();
  events.add(TENANT, EVENT, 'LUMEN', new Date('2026-12-01T00:00:00Z'));
  return new AttendeeExports({ store, attendees: s, events, reauth, actors: new MemoryActorNames(), clock });
};

const actor = { accountId: ACCOUNT, sessionId: 's-1', role: 'partner_admin', clientIp: '198.51.100.20' };
const csvText = (body: Uint8Array): string => new TextDecoder().decode(body);

describe('A2-17 내보내기 페이지 상한', () => {
  test('2,500행도 1,000행 이하 페이지로만 읽고 건수를 잃지 않는다', async () => {
    const s = pagingSource(makeRows(2_500));
    const out = await app(s).create(TENANT, EVENT, actor, 'token', { reason: '페이지 상한', format: 'CSV' });
    expect(s.limits).toEqual([1_000, 1_000, 1_000]);
    expect(s.limits.every((n) => n <= 1_000)).toBe(true);
    expect(s.cursors).toEqual([undefined, Buffer.from('order-0000999').toString('base64url'), Buffer.from('order-0001999').toString('base64url')]);
    expect(out.record.count).toBe(2_500);
  });

  test('A2-17 J-T26 ④ 정확히 1,000건이고 nextCursor가 null이면 더 부르지 않는다', async () => {
    const s = pagingSource(makeRows(1_000));
    const out = await app(s).create(TENANT, EVENT, actor, 'token', { reason: '경계', format: 'CSV' });
    expect(s.limits).toEqual([1_000]);
    expect(out.record.count).toBe(1_000);
    expect(csvText(out.file.body).match(/order-/g)).toHaveLength(1_000);

    // 경계 반대쪽: 1,000건에 다음 커서가 있으면 그 커서로 한 번 더 부르고, 0건과 null에서 멈춘다
    const more = scriptedSource([
      { items: makeRowsFrom(0, 1_000), nextCursor: 'c1' },
      { items: [], nextCursor: null },
    ]);
    const out2 = await app(more).create(TENANT, EVENT, actor, 'token', { reason: '경계 반대쪽', format: 'CSV' });
    expect(more.calls).toEqual([
      { limit: 1_000, cursor: undefined },
      { limit: 1_000, cursor: 'c1' },
    ]);
    expect(out2.record.count).toBe(1_000);
  });

  test('A2-17 J-T26 ④ 999건 짧은 페이지 뒤에도 nextCursor로 이어 읽어 2,000건을 모두 내보낸다', async () => {
    // 웨이브 6 독립 시험 작성자(R-625)가 쓴 재현 시험을 페이지 모양으로 고쳐 씀: 둘째 페이지를 limit을 넘는 1,001건 대신 1,000건 + 1건으로 나눈다
    const s = scriptedSource([
      { items: makeRowsFrom(0, 999), nextCursor: 'c1' },
      { items: makeRowsFrom(999, 1_000), nextCursor: 'c2' },
      { items: makeRowsFrom(1_999, 1), nextCursor: null },
    ]);
    const out = await app(s).create(TENANT, EVENT, actor, 'token', { reason: '짧은 페이지', format: 'CSV' });
    expect(out.record.count).toBe(2_000);
    expect(s.calls.map((c) => c.cursor)).toEqual([undefined, 'c1', 'c2']);
    expect(s.calls.map((c) => c.limit)).toEqual([1_000, 1_000, 1_000]);
    const text = csvText(out.file.body);
    expect(text).toContain('order-0000998');
    expect(text).toContain('order-0000999');
    expect(text).toContain('order-0001999');
    expect(text.match(/order-/g)).toHaveLength(2_000);
  });

  test('A2-17 J-T26 ④ 0건 페이지와 다음 커서가 와도 멈추지 않는다', async () => {
    const s = scriptedSource([
      { items: [], nextCursor: 'c1' },
      { items: makeRowsFrom(0, 500), nextCursor: null },
    ]);
    const out = await app(s).create(TENANT, EVENT, actor, 'token', { reason: '빈 페이지', format: 'CSV' });
    expect(out.record.count).toBe(500);
    expect(s.calls).toEqual([
      { limit: 1_000, cursor: undefined },
      { limit: 1_000, cursor: 'c1' },
    ]);
  });

  test('A2-17 J-T26 ④ 원천이 같은 커서를 되풀이하면 503이고 이력·접속기록이 없다', async () => {
    const rows = makeRowsFrom(0, 1_000);
    const s = scriptedSource([
      { items: rows, nextCursor: 'c1' },
      { items: rows, nextCursor: 'c1' },
    ]);
    const store = new MemoryAttendeeExportStore();
    const err = await app(s, store)
      .create(TENANT, EVENT, actor, 'token', { reason: '같은 커서', format: 'CSV' })
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(err).toBeInstanceOf(ProblemError);
    expect(err).toMatchObject({ status: 503, slug: 'dependency-unavailable' });
    expect(s.calls.map((c) => c.cursor)).toEqual([undefined, 'c1']);
    expect(store.rows).toHaveLength(0);
    expect(store.audits).toHaveLength(0);
  });
});

describe('A2-17 명단 보기 커서', () => {
  test('A2-17 J-T26 ④ 명단 보기 응답의 nextCursor는 원천 값 그대로다', async () => {
    const short = scriptedSource([{ items: makeRowsFrom(0, 49), nextCursor: 'opaque-c' }]);
    const page = await app(short).listAttendees(TENANT, EVENT, { limit: 50 }, actor);
    expect(page.items).toHaveLength(49);
    expect(page.nextCursor).toBe('opaque-c');
    expect(short.calls).toEqual([{ limit: 50, cursor: undefined }]);

    // 경계 반대쪽: 정확히 limit건이어도 원천이 null을 주면 끝이다(항목 수로 커서를 다시 만들지 않는다)
    const full = scriptedSource([{ items: makeRowsFrom(0, 50), nextCursor: null }]);
    const last = await app(full).listAttendees(TENANT, EVENT, { limit: 50, cursor: 'opaque-c' }, actor);
    expect(last.items).toHaveLength(50);
    expect(last.nextCursor).toBeNull();
    expect(full.calls).toEqual([{ limit: 50, cursor: 'opaque-c' }]);
  });
});
