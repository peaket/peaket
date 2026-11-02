// 주문·결제·발권 v0의 도메인 규칙 값과 공개 함수 입력 검사(docs/features/payment.md §13, docs/features/offline-gate.md §13,
// docs/features/seat-hold.md §14 동작 9). 모듈 공개 파일만 본다. DB 없이 도는 단위 시험이다.
// 공개 함수(좌석 판매·가격 넣기·스태프 배정)의 입력 검사는 'DB에 닿으면 기록하고 실패하는 가짜 Database'로 본다:
// 틀린 입력은 DB에 닿기 전에 RangeError로 거절된 Promise여야 하고, 맞는 입력은 DB에 닿아야 한다(가짜가 실제로 잡는지 보는 대조).
import 'reflect-metadata';
import type { Database } from '@peaket/platform';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { GRADE_PATTERN, MAX_PRICE, MIN_PRICE, ORDER_STATUSES, PAYMENT_KEY_PATTERN, createBookingAdmin, orderNameOf } from '../src/modules/booking/index.js';
import { EVENT_ID_PATTERN, createSeatSales } from '../src/modules/inventory/index.js';
import { PAYMENT_STATUSES } from '../src/modules/payment/index.js';
import { TICKET_CODE_BYTES, TICKET_CODE_PATTERN, createTicketAdmin, newTicketCode } from '../src/modules/ticket/index.js';

/** 동기로 던져도 거절된 Promise로 바꿔 본다 */
const attempt = (f: () => unknown): Promise<unknown> => (async () => f())();

/**
 * DB에 닿으면(어느 메서드든 부르면) 기록하고 던지는 가짜 Database. 속성 읽기는 막지 않는다(어댑터가 만들 때 참조만 잡아 둘 수 있다).
 * await 대상이 되지 않게 then은 없다
 */
function trapDatabase(): { database: Database; calls: string[] } {
  const calls: string[] = [];
  const trap = (path: string): unknown =>
    new Proxy(function trapped() {}, {
      get(_t, prop) {
        if (typeof prop === 'symbol' || prop === 'then') return undefined;
        return trap(`${path}.${prop}`);
      },
      apply() {
        calls.push(path);
        throw new Error(`시험: DB에 닿았다(${path})`);
      },
      construct() {
        calls.push(`new ${path}`);
        throw new Error(`시험: DB에 닿았다(new ${path})`);
      },
    });
  return { database: trap('database') as Database, calls };
}

const HOLD = '6f1c7d2e-3b4a-4c5d-8e9f-0a1b2c3d4e5f';
const ORDER = '0b9a8c7d-6e5f-4a3b-9c2d-1e0f9a8b7c6d';
const NOW = Date.parse('2026-11-02T01:00:00.000Z');
/** 9999-12-31T23:59:59.999Z(좌석 v0의 시각 상한, inventory isEpochMs) */
const MAX_EPOCH_MS = 253_402_300_799_999;

/** 틀린 입력: 가짜 DB에 닿지 않고 RangeError로 거절된다 */
async function expectRejectedBeforeDb(label: string, run: (database: Database) => unknown): Promise<void> {
  const { database, calls } = trapDatabase();
  await expect(attempt(() => run(database)), label).rejects.toBeInstanceOf(RangeError);
  expect(calls, `${label}: DB에 닿기 전에 거절해야 한다`).toEqual([]);
}

/** 맞는 입력: 검사를 지나 DB에 닿는다(결과는 묻지 않는다. 가짜 DB가 던진 것을 어떻게 다루든 상관없다) */
async function expectReachesDb(label: string, run: (database: Database) => unknown): Promise<void> {
  const { database, calls } = trapDatabase();
  await attempt(() => run(database)).catch(() => {});
  expect(calls.length, `${label}: 맞는 입력인데 DB에 닿지 않았다(검사가 너무 좁거나 아직 만들지 않았다)`).toBeGreaterThan(0);
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ───────────────────────── 티켓 코드(offline-gate §13 동작 1, ASVS 11.5.1) ─────────────────────────

describe('티켓 코드 newTicketCode', () => {
  test('FR012_티켓코드는난수16바이트를base64url로쓴22자이고_풀면정확히16바이트로돌아온다 [ASVS v5.0.0-11.5.1]', () => {
    expect(TICKET_CODE_BYTES).toBe(16);
    for (let i = 0; i < 200; i += 1) {
      const code = newTicketCode();
      expect(code, code).toMatch(/^[A-Za-z0-9_-]{22}$/);
      const bytes = Buffer.from(code, 'base64url');
      expect(bytes.length, code).toBe(16);
      // 같은 바이트를 다시 쓰면 같은 글이다(덧붙임 '='이나 다른 표기 없이 정규형)
      expect(bytes.toString('base64url'), code).toBe(code);
      // 검표 본문 형식(영숫자·-·_ 1~64자)에 들어간다
      expect(TICKET_CODE_PATTERN.test(code), code).toBe(true);
    }
  });

  test('FR012_티켓코드를2만개만들어도겹치지않고_128비트의모든자리가0과1을모두가진다 [ASVS v5.0.0-11.5.1]', () => {
    const codes = Array.from({ length: 20_000 }, () => newTicketCode());
    expect(new Set(codes).size).toBe(codes.length);
    // 자리마다 2,000개 가운데 한 번도 바뀌지 않을 확률은 2^-1999라 고정 바이트·짧은 난수를 잡는다
    const seen = Array.from({ length: 128 }, () => new Set<number>());
    for (const code of codes.slice(0, 2_000)) {
      const bytes = Buffer.from(code, 'base64url');
      for (let bit = 0; bit < 128; bit += 1) seen[bit]!.add((bytes[bit >> 3]! >> (7 - (bit & 7))) & 1);
    }
    const stuck = seen.map((s, bit) => (s.size === 2 ? -1 : bit)).filter((b) => b >= 0);
    expect(stuck, '한 값에 묶인 비트 자리').toEqual([]);
  });

  test('FR012_티켓코드는Math.random에기대지않는다_Math.random을한값으로묶어도서로다르다 [ASVS v5.0.0-11.5.1]', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.4242);
    const codes = Array.from({ length: 1_000 }, () => newTicketCode());
    expect(new Set(codes).size).toBe(codes.length);
  });
});

// ───────────────────────── 형식 규칙 값(§13 동작 1·2, offline-gate §13 동작 2) ─────────────────────────

describe('형식 규칙 값', () => {
  test('FR035_검표코드는영숫자와-_로된1~64자만받는다_공백제어문자비ASCII와base64기호는받지않는다 [ASVS v5.0.0-2.2.1]', () => {
    for (const ok of ['a', 'Z', '0', '-', '_', 'x'.repeat(64), 'AZaz09-_', 'AAAAAAAAAAAAAAAAAAAAAA']) expect(TICKET_CODE_PATTERN.test(ok), ok).toBe(true);
    const bad = ['', 'x'.repeat(65), ' ', 'ab cd', ' abc', 'abc ', 'abc\n', '\nabc', 'a\tb', 'a\u0000b', '\u007f', '가나다', 'é', 'ａ', 'a+b', 'a/b', 'abc=', 'a.b', "a'b", 'a"b', 'a;b', '{a}', 'a%20b'];
    for (const b of bad) expect(TICKET_CODE_PATTERN.test(b), JSON.stringify(b)).toBe(false);
  });

  test('FR011_결제참조는출력가능한ASCII1~200자만받는다_빈값201자공백제어문자비ASCII는받지않는다 [ASVS v5.0.0-2.2.1]', () => {
    const printable = Array.from({ length: 0x7e - 0x21 + 1 }, (_, i) => String.fromCharCode(0x21 + i)).join('');
    for (const ok of ['!', '~', 'tsim_1a2b3c', printable, '~'.repeat(200), 'a'.repeat(199)]) expect(PAYMENT_KEY_PATTERN.test(ok), ok).toBe(true);
    const bad = ['', 'a'.repeat(201), ' ', 'a b', ' a', 'a ', 'a\n', '\na', 'a\tb', 'a\u0000', '\u007f', 'a\u0080', '결제', 'ｔｓｉｍ', 'a​b'];
    for (const b of bad) expect(PAYMENT_KEY_PATTERN.test(b), JSON.stringify(b)).toBe(false);
  });

  test('FR011_좌석등급이름은제어문자없는1~30자다 [ASVS v5.0.0-2.2.1]', () => {
    for (const ok of ['R', 'VIP석', 'S 구역', 'x'.repeat(30), '가'.repeat(30)]) expect(GRADE_PATTERN.test(ok), ok).toBe(true);
    for (const bad of ['', 'x'.repeat(31), 'R\n', '\tR', 'R\u0000', 'R​', 'R\u007f']) expect(GRADE_PATTERN.test(bad), JSON.stringify(bad)).toBe(false);
  });

  test('FR011_가격범위는1원~1억원이다', () => {
    expect({ min: MIN_PRICE, max: MAX_PRICE }).toEqual({ min: 1, max: 100_000_000 });
  });

  test('FR011_주문상태와결제상태는정본표의값이다 [ASVS v5.0.0-2.3.1]', () => {
    expect([...ORDER_STATUSES]).toEqual(['CREATED', 'PAYING', 'APPROVED', 'CONFIRMED', 'FAILED']);
    expect([...PAYMENT_STATUSES]).toEqual(['CONFIRMING', 'APPROVED', 'FAILED']);
  });
});

// ───────────────────────── 주문 이름(결제사 상한 100자) ─────────────────────────

describe('주문 이름 orderNameOf', () => {
  test('FR011_주문이름은64자회차ID와10석에도100자이하이고_제어문자가없으며같은입력엔같은값이다', () => {
    for (const eventId of ['e', 'A-b_9', 'z'.repeat(64), '9'.repeat(64)]) {
      expect(EVENT_ID_PATTERN.test(eventId)).toBe(true);
      for (const n of [1, 2, 9, 10]) {
        const name = orderNameOf(eventId, n);
        expect(typeof name).toBe('string');
        // 결제사(시뮬레이터 /sim/authenticate)는 1~100자를 받는다. 코드 단위와 코드 포인트 모두 100 이하
        expect(name.length, name).toBeGreaterThanOrEqual(1);
        expect(name.length, name).toBeLessThanOrEqual(100);
        expect([...name].length, name).toBeLessThanOrEqual(100);
        expect(/[\p{Cc}\p{Cf}]/u.test(name), name).toBe(false);
        expect(orderNameOf(eventId, n)).toBe(name);
      }
    }
  });
});

// ───────────────────────── 공개 함수 입력 검사(DB에 닿기 전에 거절) ─────────────────────────

describe('좌석 판매 공개 함수 createSeatSales의 입력 검사(seat-hold §14 동작 9)', () => {
  const badHolds = ['', 'not-a-uuid', `${HOLD}x`, ` ${HOLD}`, HOLD.slice(0, -1), "'; drop table v0_seat; --", 123 as unknown as string, null as unknown as string];
  const badAccounts = ['', 'a'.repeat(1025), 42 as unknown as string, undefined as unknown as string];
  const badTimes = [Number.NaN, 1.5, -1, Number.POSITIVE_INFINITY, MAX_EPOCH_MS + 1, '1000' as unknown as number];

  test('POL011_홀드ID주문ID가UUID가아니거나계정ID가1~1024자글이아니거나시각이유닉스밀리초정수가아니면_DB에닿기전에RangeError다 [ASVS v5.0.0-2.2.1]', async () => {
    for (const h of badHolds) {
      await expectRejectedBeforeDb(`holdForOrder hold=${JSON.stringify(h)}`, (db) => createSeatSales(db).holdForOrder(h, 'acc-1', NOW));
      await expectRejectedBeforeDb(`sell hold=${JSON.stringify(h)}`, (db) => createSeatSales(db).sell(h, 'acc-1', ORDER, NOW));
      await expectRejectedBeforeDb(`unsell hold=${JSON.stringify(h)}`, (db) => createSeatSales(db).unsell(h, ORDER, NOW));
    }
    for (const o of badHolds) {
      await expectRejectedBeforeDb(`sell order=${JSON.stringify(o)}`, (db) => createSeatSales(db).sell(HOLD, 'acc-1', o, NOW));
      await expectRejectedBeforeDb(`unsell order=${JSON.stringify(o)}`, (db) => createSeatSales(db).unsell(HOLD, o, NOW));
    }
    for (const a of badAccounts) {
      await expectRejectedBeforeDb(`holdForOrder account=${JSON.stringify(a)}`, (db) => createSeatSales(db).holdForOrder(HOLD, a, NOW));
      await expectRejectedBeforeDb(`sell account=${JSON.stringify(a)}`, (db) => createSeatSales(db).sell(HOLD, a, ORDER, NOW));
    }
    for (const t of badTimes) {
      await expectRejectedBeforeDb(`holdForOrder now=${String(t)}`, (db) => createSeatSales(db).holdForOrder(HOLD, 'acc-1', t));
      await expectRejectedBeforeDb(`sell now=${String(t)}`, (db) => createSeatSales(db).sell(HOLD, 'acc-1', ORDER, t));
      await expectRejectedBeforeDb(`unsell now=${String(t)}`, (db) => createSeatSales(db).unsell(HOLD, ORDER, t));
    }
  });

  test('POL011_경계안의입력은검사를지나DB에닿는다_계정ID1자와1024자_시각0과상한', async () => {
    for (const account of ['a', 'a'.repeat(1024), "acc-'quoted'"]) {
      await expectReachesDb(`holdForOrder account ${account.length}자`, (db) => createSeatSales(db).holdForOrder(HOLD, account, NOW));
      await expectReachesDb(`sell account ${account.length}자`, (db) => createSeatSales(db).sell(HOLD, account, ORDER, NOW));
    }
    for (const t of [0, NOW, MAX_EPOCH_MS]) await expectReachesDb(`unsell now=${t}`, (db) => createSeatSales(db).unsell(HOLD, ORDER, t));
  });
});

describe('가격 넣기 createBookingAdmin().setPrices의 입력 검사(payment §13 동작 4)', () => {
  test('FR011_회차ID형식이나등급이름이나가격이틀리거나등급이없으면_DB에닿기전에RangeError다 [ASVS v5.0.0-2.2.1]', async () => {
    const cases: [string, string, Record<string, number>][] = [
      ['회차 ID 공백', 'bad id', { R: 1000 }],
      ['회차 ID 빈 값', '', { R: 1000 }],
      ['회차 ID 65자', 'z'.repeat(65), { R: 1000 }],
      ['회차 ID 따옴표', "e'1", { R: 1000 }],
      ['등급 없음', 'ev-1', {}],
      ['등급 빈 이름', 'ev-1', { '': 1000 }],
      ['등급 31자', 'ev-1', { ['x'.repeat(31)]: 1000 }],
      ['등급 줄바꿈', 'ev-1', { 'R\n': 1000 }],
      ['등급 NUL', 'ev-1', { 'R\u0000': 1000 }],
      ['등급 보이지 않는 서식 문자', 'ev-1', { 'R​': 1000 }],
      ['가격 0원', 'ev-1', { R: 0 }],
      ['가격 음수', 'ev-1', { R: -1 }],
      ['가격 1억 1원', 'ev-1', { R: 100_000_001 }],
      ['가격 소수', 'ev-1', { R: 1000.5 }],
      ['가격 NaN', 'ev-1', { R: Number.NaN }],
      ['가격 무한대', 'ev-1', { R: Number.POSITIVE_INFINITY }],
      ['가격 글', 'ev-1', { R: '1000' as unknown as number }],
      ['맞는 등급과 틀린 등급이 섞임', 'ev-1', { R: 1000, S: 0 }],
    ];
    for (const [label, eventId, prices] of cases) {
      await expectRejectedBeforeDb(`setPrices ${label}`, (db) => createBookingAdmin(db).setPrices(eventId, prices));
    }
  });

  test('FR011_경계안의가격은검사를지나DB에닿는다_1원과1억원_30자등급_64자회차ID', async () => {
    await expectReachesDb('setPrices 경계', (db) => createBookingAdmin(db).setPrices('z'.repeat(64), { R: 1, ['가'.repeat(30)]: 100_000_000, 'VIP석': 99_000 }));
  });
});

describe('스태프 배정 createTicketAdmin().assignStaff의 입력 검사(offline-gate §13 동작 3)', () => {
  test('FR035_회차ID형식이틀리거나계정ID가1~1024자글이아니면_DB에닿기전에RangeError다 [ASVS v5.0.0-2.2.1]', async () => {
    const cases: [string, string, string[]][] = [
      ['회차 ID 공백', 'bad id', ['staff-1']],
      ['회차 ID 빈 값', '', ['staff-1']],
      ['회차 ID 65자', 'z'.repeat(65), ['staff-1']],
      ['계정 ID 빈 값', 'ev-1', ['']],
      ['계정 ID 1025자', 'ev-1', ['a'.repeat(1025)]],
      ['계정 ID 숫자', 'ev-1', [7 as unknown as string]],
      ['맞는 계정과 틀린 계정이 섞임', 'ev-1', ['staff-1', '']],
    ];
    for (const [label, eventId, accounts] of cases) {
      await expectRejectedBeforeDb(`assignStaff ${label}`, (db) => createTicketAdmin(db).assignStaff(eventId, accounts));
    }
  });

  test('FR035_경계안의배정은검사를지나DB에닿는다_계정ID1자와1024자', async () => {
    await expectReachesDb('assignStaff 경계', (db) => createTicketAdmin(db).assignStaff('z'.repeat(64), ['a', 'b'.repeat(1024)]));
  });
});
