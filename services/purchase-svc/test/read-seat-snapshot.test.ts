// 좌석 스냅샷 읽기 쓰임새 ReadSeatSnapshot(docs/features/seat-hold.md §2 '스냅샷 API의 첫 구현', docs/frontend.md §4.4.2, BUILD_ORDER PRF-137)를 메모리 조립으로 본다.
// 차례: 회차 설정 → 구역 검사 → 구매 세션 열기(입장 토큰의 첫 사용) → 스냅샷 읽기 → 이진 본문. 앱 쪽 시각은 모두 주입한 가짜 시계다.
import { randomUUID } from 'node:crypto';
import { Deadline, type FakeClock, fakeClock } from '@peaket/platform';
import { describe, expect, test } from 'vitest';
import {
  decodeSnapshot,
  MemoryPurchaseSessionStore,
  MemorySeatMap,
  MemorySeatStore,
  OpenPurchaseSession,
  OpenSessionError,
  type OpenSessionErrorCode,
  ReadSeatSnapshot,
  RecordingSessionStartedLog,
  type SeatCallOptions,
  type SeatSnapshots,
  SeatStoreUnavailable,
  SnapshotError,
  type SnapshotCommand,
  type SnapshotReadInput,
} from '../src/modules/inventory/index.js';
import { claimsOf, ISS, newKey, signAdmission } from './admission-fixtures.js';
import { account, ACCOUNT_A, ACCOUNT_B, DAY, holdInput, newEvent, SEAT_COUNT, SEAT_DEFS } from './hold-cases.js';
import { clientKeyOf } from './session-fixtures.js';

const NOW = Date.parse('2026-11-04T03:00:00.000Z');
const K1 = newKey('k1');
const keys = new Map([['k1', K1.pub]]);
const HEADER = 12;
/** 시험 판의 구역: 0(A, 색인 0 ~ 19), 1(B, 20 ~ 29), 2(판매 제외석 X01 하나, 30). 구역 표에는 판매 제외석만 있는 구역도 싣는다 */
const SECTIONS = [0, 1, 2];

interface WorldOptions {
  layoutVersion?: string;
  /** 회차 좌석맵 판을 넣지 않는다 */
  noMap?: boolean;
  /** 판에 좌석이 하나도 없다 */
  emptyMap?: boolean;
  /** 판매 열기를 하지 않는다(세대 키 없음) */
  noOpen?: boolean;
}

async function world(o: WorldOptions = {}) {
  const clock: FakeClock = fakeClock({ now: NOW, monotonic: 50 });
  const store = new MemorySeatStore(clock);
  const seatMap = new MemorySeatMap();
  const sessionStore = new MemoryPurchaseSessionStore(clock);
  const log = new RecordingSessionStartedLog();
  const real = new OpenPurchaseSession({ store: sessionStore, log, keys, issuer: ISS, clock });
  const eventId = newEvent();
  if (!o.noMap) seatMap.put({ eventId, layoutVersion: o.layoutVersion ?? '3', seatCount: SEAT_COUNT, perAccountLimit: 4, saleEndsAtMs: NOW + DAY }, o.emptyMap ? [] : SEAT_DEFS);
  const keepUntilMs = NOW + 2 * DAY;
  const opened = o.noOpen ? undefined : await store.openSale({ eventId, seatCount: SEAT_COUNT, keepUntilMs });

  // 호출 차례와 인자를 적는 겉
  const order: string[] = [];
  const reads: { input: SnapshotReadInput; options: SeatCallOptions | undefined }[] = [];
  const faults: { read?: unknown } = {};
  const snapshots: SeatSnapshots = {
    read: async (i, opt) => {
      order.push('read');
      reads.push({ input: { ...i, sectionIndexes: [...i.sectionIndexes] }, options: opt });
      if (faults.read !== undefined) throw faults.read;
      return store.read(i, opt);
    },
  };
  const map = {
    config: async (e: string) => {
      order.push('config');
      return seatMap.config(e);
    },
    resolve: (e: string, ids: readonly string[]) => seatMap.resolve(e, ids),
    sections: async (e: string) => {
      order.push('sections');
      return seatMap.sections(e);
    },
  };
  const opener = {
    execute: (c: Parameters<OpenPurchaseSession['execute']>[0]) => {
      order.push('open');
      return real.execute(c);
    },
  };
  const uc = new ReadSeatSnapshot({ opener, seatMap: map, snapshots, clock });

  /** 입장 토큰을 가진 팬. 토큰의 회차를 바꾸거나 계정을 바꿔 남의 토큰을 흉내 낸다 */
  const fan = (k: number, c: { tokenEvent?: string; tokenAccount?: string; nowMs?: number } = {}) => {
    const accountId = account(k);
    const loginSessionId = `ls-${eventId}-${k}`;
    const jti = randomUUID();
    const token = signAdmission(K1, claimsOf({ nowMs: c.nowMs ?? NOW, jti, accountId: c.tokenAccount ?? accountId, loginSessionId, eventId: c.tokenEvent ?? eventId }));
    const client = clientKeyOf();
    const cmd = (over: Partial<SnapshotCommand> = {}): SnapshotCommand => ({ eventId, accountId, loginSessionId, token, clientKey: client.text, section: undefined, ...over });
    return { accountId, loginSessionId, jti, token, client, cmd };
  };
  const hold = (seatIds: readonly string[], accountId = ACCOUNT_A) => store.hold(holdInput(eventId, seatIds, { accountId, keepUntilMs }));
  return { clock, store, seatMap, sessionStore, log, eventId, opened, order, reads, faults, uc, fan, hold };
}

const codeOf = async (p: Promise<unknown>): Promise<OpenSessionErrorCode | string | 'ok'> => {
  try {
    await p;
    return 'ok';
  } catch (e) {
    if (e instanceof OpenSessionError || e instanceof SnapshotError) return e.code;
    throw e;
  }
};

describe('차례', () => {
  test('FR009_ST28_ 성공하면 회차 설정 → 구매 세션 열기 → 스냅샷 읽기 순서로 한 번씩 부르고, 읽기는 한 번이다', async () => {
    const w = await world();
    const f = w.fan(1);
    await w.uc.execute(f.cmd());
    expect(w.order.indexOf('config')).toBeGreaterThanOrEqual(0);
    expect(w.order.indexOf('open')).toBeGreaterThan(w.order.indexOf('config'));
    expect(w.order.indexOf('read')).toBeGreaterThan(w.order.indexOf('open'));
    expect(w.order.filter((x) => x === 'open')).toHaveLength(1);
    expect(w.order.filter((x) => x === 'read')).toHaveLength(1);
    // 구매 세션이 열렸고 SESSION_STARTED가 한 번 더해졌다
    expect(await w.sessionStore.read(f.jti)).toMatchObject({ accountId: f.accountId, eventId: w.eventId });
    expect(w.log.entries).toHaveLength(1);
  });

  test('ST26_③_FR009_ 그 회차 좌석맵 판(회차 설정)이 없으면 입장 토큰을 쓰지 않고 SnapshotError NOT_READY다: 구매 세션도 SESSION_STARTED도 읽기도 없다', async () => {
    const w = await world({ noMap: true });
    const f = w.fan(1);
    const err = await w.uc.execute(f.cmd()).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(SnapshotError);
    expect(err).toMatchObject({ code: 'NOT_READY' });
    expect(w.order).not.toContain('open');
    expect(w.order).not.toContain('read');
    expect(await w.sessionStore.read(f.jti)).toBeUndefined();
    expect(w.log.entries).toHaveLength(0);
  });

  test('ASVS2.1.1_ section이 판의 구역 수 밖이면 SnapshotError SECTION_OUT_OF_RANGE이고 구매 세션을 열지 않는다(입장 토큰이 쓰이지 않는다)', async () => {
    const w = await world();
    const f = w.fan(1);
    for (const section of [3, 4, 100, 65535]) {
      const err = await w.uc.execute(f.cmd({ section })).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect({ section, isSnapshotError: err instanceof SnapshotError, code: (err as SnapshotError | undefined)?.code }).toEqual({ section, isSnapshotError: true, code: 'SECTION_OUT_OF_RANGE' });
    }
    expect(w.order).not.toContain('open');
    expect(w.order).not.toContain('read');
    expect(await w.sessionStore.read(f.jti)).toBeUndefined();
    expect(w.log.entries).toHaveLength(0);
    // 구역 수 안의 마지막 구역(색인 2)은 읽힌다
    await w.uc.execute(f.cmd({ section: 2 }));
    expect(await w.sessionStore.read(f.jti)).toBeDefined();
  });

  test('ASVS15.3.7_ASVS2.1.1_ 주소의 회차 ID가 키 조각 모양이 아니면 RangeError이고 아무것도 부르지 않는다', async () => {
    const w = await world();
    const f = w.fan(1);
    for (const bad of ['', 'a}b', '{x}', 'a b', 'x'.repeat(65)]) {
      await expect(w.uc.execute(f.cmd({ eventId: bad })), `eventId '${bad}'`).rejects.toBeInstanceOf(RangeError);
    }
    expect(w.order).toEqual([]);
  });

  test('ST26_③_ 세대 키가 없으면(구매 세션은 열리고 나서) SnapshotError NOT_READY다. 구매 세션은 열려 있어 같은 입장 토큰으로 다시 받으면 세션이 REPLAY다', async () => {
    const w = await world();
    const f = w.fan(1);
    w.store.db.event(w.eventId).epoch = undefined;
    const err = await w.uc.execute(f.cmd()).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(SnapshotError);
    expect(err).toMatchObject({ code: 'NOT_READY' });
    expect(w.order).toContain('open');
    expect(w.order).toContain('read');
    // 구매 세션은 ④에서 열리고 ⑤가 실패해도 남는다
    expect(await w.sessionStore.read(f.jti)).toMatchObject({ eventId: w.eventId });
    expect(w.log.entries).toHaveLength(1);
    // 세대 키가 서면 같은 입장 토큰·같은 키로 받을 수 있고 SESSION_STARTED는 더 늘지 않는다
    await w.store.openSale({ eventId: w.eventId, seatCount: SEAT_COUNT, keepUntilMs: NOW + 2 * DAY });
    const body = decodeSnapshot(await w.uc.execute(f.cmd()));
    expect(body.sections.map((s) => s.sectionIndex)).toEqual(SECTIONS);
    expect(w.log.entries).toHaveLength(1);
  });
});

describe('본문', () => {
  test('FR009_ST35_⑥_ 전체 본문: flags 0, 모든 구역 색인 오름차순과 구역 일련번호, 좌석 수(40)만큼 비트, 잡힌 좌석 비트가 1이고 바이트 안에서 낮은 비트부터 채워진다', async () => {
    const w = await world();
    const f = w.fan(1);
    expect((await w.hold(['A01', 'A02', 'B01'])).kind).toBe('OK');
    const raw = await w.uc.execute(f.cmd());
    expect(Buffer.isBuffer(raw)).toBe(true);
    // 바이트로 직접: version 1, flags 0, layoutVersion 3, seatEpoch, 구역 3개
    expect(raw[0]).toBe(1);
    expect(raw[1]).toBe(0);
    expect(raw.readUInt32BE(2)).toBe(3);
    expect(raw.readUInt32BE(6)).toBe(w.opened!.seatEpoch);
    expect(raw.readUInt16BE(10)).toBe(3);
    // 구역 표: (색인 u16, 일련번호 u32) × 3. 홀드는 구역 A·B에 한 번씩 올렸고 구역 2(판매 제외석)는 0이다
    expect(raw.subarray(HEADER, HEADER + 18).toString('hex')).toBe('000000000001' + '000100000001' + '000200000000');
    // 비트맵: 좌석 색인 0·1 → 바이트 0의 비트 0·1(0x03), 색인 20 → 바이트 2의 비트 4(0x10). 낮은 비트부터다(Redis의 0xc0 / 0x08과 거꾸로)
    expect(raw.subarray(HEADER + 18).toString('hex')).toBe('0300100000');
    // 같은 내용을 decodeSnapshot으로도 본다
    const body = decodeSnapshot(raw);
    expect(body.sectionOnly).toBe(false);
    expect(body.layoutVersion).toBe(3);
    expect(body.sections).toEqual([
      { sectionIndex: 0, sectionVersion: 1 },
      { sectionIndex: 1, sectionVersion: 1 },
      { sectionIndex: 2, sectionVersion: 0 },
    ]);
    expect(Buffer.from(body.bitmap).toString('hex')).toBe('0300100000');
  });

  test('FR009_ 전체 본문의 비트는 저장소의 비트와 좌석 색인마다 같고, 마지막 바이트의 남는 비트는 0이다(좌석 수가 8의 배수가 아닌 회차)', async () => {
    const w = await world();
    const f = w.fan(1);
    await w.hold(['A03', 'A20', 'B10']);
    const bits = w.store.db.event(w.eventId).bits;
    const body = decodeSnapshot(await w.uc.execute(f.cmd()));
    expect(body.bitmap.length).toBe(Math.ceil(SEAT_COUNT / 8));
    for (let k = 0; k < SEAT_COUNT; k++) expect({ k, bit: (body.bitmap[k >> 3]! >> (k & 7)) & 1 }).toEqual({ k, bit: bits.has(k) ? 1 : 0 });
    // 좌석 수 40은 8의 배수라, 좌석 수 13인 판으로 남는 비트를 따로 본다
    const odd = await world();
    const g = odd.fan(2);
    odd.seatMap.put({ eventId: odd.eventId, layoutVersion: '3', seatCount: 13, perAccountLimit: 4, saleEndsAtMs: NOW + DAY }, [
      { seatId: 'Q01', index: 0, sectionId: 'SEC-Q', sectionIndex: 0, seatOffset: 0, tierId: 'R' },
      { seatId: 'Q13', index: 12, sectionId: 'SEC-Q', sectionIndex: 0, seatOffset: 12, tierId: 'R' },
    ]);
    odd.store.db.event(odd.eventId).bits.add(12);
    odd.store.db.event(odd.eventId).bits.add(30); // 판 밖(비트 13 이후)의 값은 본문에 싣지 않는다
    const small = await odd.uc.execute(g.cmd());
    expect(small.subarray(HEADER + 6).toString('hex')).toBe('0010');
  });

  test('FR009_ 읽기는 전체일 때 비트 0부터 좌석 수만큼, 모든 구역 색인 오름차순으로 한 번에 요청한다(snapshots.read 입력)', async () => {
    const w = await world();
    await w.uc.execute(w.fan(1).cmd());
    expect(w.reads).toHaveLength(1);
    expect(w.reads[0]!.input).toEqual({ eventId: w.eventId, firstBit: 0, bitCount: SEAT_COUNT, sectionIndexes: SECTIONS });
  });

  test('FR009_ 구역 하나(section=1) 본문: flags 비트 0, 구역 하나, 그 구역 범위(색인 20 ~ 29)의 비트만 처음 비트부터 담는다', async () => {
    const w = await world();
    const f = w.fan(1);
    // B01(색인 20)과 B10(색인 29)을 잡고, 다른 구역 A01도 잡는다
    await w.hold(['B01', 'B10']);
    await w.hold(['A01'], ACCOUNT_B);
    const raw = await w.uc.execute(f.cmd({ section: 1 }));
    expect(raw[1]).toBe(1);
    expect(raw.readUInt16BE(10)).toBe(1);
    // 구역 표 한 칸: (색인 1, 일련번호 1)
    expect(raw.subarray(HEADER, HEADER + 6).toString('hex')).toBe('000100000001');
    // 비트 10개 = 2바이트. 첫 좌석(색인 20) → 비트 0(0x01), 마지막 좌석(색인 29) → 비트 9 = 바이트 1의 비트 1(0x02)
    expect(raw.subarray(HEADER + 6).toString('hex')).toBe('0102');
    const body = decodeSnapshot(raw);
    expect(body.sectionOnly).toBe(true);
    expect(body.sections).toEqual([{ sectionIndex: 1, sectionVersion: 1 }]);
    expect(body.layoutVersion).toBe(3);
    expect(w.reads[0]!.input).toEqual({ eventId: w.eventId, firstBit: 20, bitCount: 10, sectionIndexes: [1] });
  });

  test('FR009_ 구역 하나 본문은 그 구역 범위가 바이트 경계에 맞지 않아도 처음 비트부터 채운다(구역 0 = 색인 0 ~ 19, 20비트 → 3바이트, 마지막 바이트의 남는 비트 0)', async () => {
    const w = await world();
    const f = w.fan(1);
    await w.hold(['A01', 'A09', 'A20']);
    const raw = await w.uc.execute(f.cmd({ section: 0 }));
    // A01 → 비트 0, A09(색인 8) → 바이트 1 비트 0, A20(색인 19) → 바이트 2 비트 3
    expect(raw.subarray(HEADER + 6).toString('hex')).toBe('010108');
  });

  test('FR009_ 구역 하나 본문의 첫 비트가 바이트 중간에서 시작해도 맞다: 판매 제외석만 있는 구역 2(색인 30 하나)는 비트 1개 = 1바이트', async () => {
    const w = await world();
    const f = w.fan(1);
    w.store.db.event(w.eventId).bits.add(30);
    const raw = await w.uc.execute(f.cmd({ section: 2 }));
    expect(raw.subarray(HEADER + 6).toString('hex')).toBe('01');
    expect(w.reads[0]!.input).toEqual({ eventId: w.eventId, firstBit: 30, bitCount: 1, sectionIndexes: [2] });
  });

  test('FR009_ 구역이 하나도 없는 판이면 NOT_READY가 아니라 구역 표가 빈 본문이다(세대·판 번호는 그대로 싣는다)', async () => {
    const w = await world({ emptyMap: true });
    const f = w.fan(1);
    const body = decodeSnapshot(await w.uc.execute(f.cmd()));
    expect(body.sections).toEqual([]);
    expect(body.sectionOnly).toBe(false);
    expect(body.layoutVersion).toBe(3);
    expect(body.seatEpoch).toBe(w.opened!.seatEpoch);
    expect(body.bitmap.length).toBe(Math.ceil(SEAT_COUNT / 8));
  });

  test('FR009_ 판 번호(layoutVersion)는 판 파일의 글을 u32 정수로 싣는다: 0과 4294967295까지, 본문에 그대로 나온다', async () => {
    for (const v of ['0', '7', '4294967295']) {
      const w = await world({ layoutVersion: v });
      expect(decodeSnapshot(await w.uc.execute(w.fan(1).cmd())).layoutVersion, `layoutVersion ${v}`).toBe(Number(v));
    }
  });

  test('FR009_ 판의 layoutVersion이 u32 정수가 아니면(글자·소수·음수·2^32) 거절 오류(SnapshotError·OpenSessionError가 아닌 Error)다', async () => {
    for (const v of ['abc', '1.5', '-1', '4294967296']) {
      const w = await world({ layoutVersion: v });
      const err = await w.uc.execute(w.fan(1).cmd()).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(err, `layoutVersion '${v}'`).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(SnapshotError);
      expect(err).not.toBeInstanceOf(OpenSessionError);
    }
  });

  test('FR009_ 판의 layoutVersion 글이 10진 정수 글이 아니면(빈 글·공백·지수·16진·부호 +) 수로는 정수여도 거절 오류다(Number("")은 0이라 걸러야 한다)', async () => {
    for (const v of ['', ' ', ' 7', '7 ', '1e3', '0x10', '+7']) {
      const w = await world({ layoutVersion: v });
      const err = await w.uc.execute(w.fan(1).cmd()).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(err, `layoutVersion '${v}'`).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(SnapshotError);
      expect(err).not.toBeInstanceOf(OpenSessionError);
    }
  });
});

describe('구매 세션 열기(입장 토큰의 첫 사용)', () => {
  test('ST28_ASVS8.2.1_ 입장 토큰 거절은 OpenSessionError가 그대로 나가고(code) 스냅샷을 읽지 않는다: 서명 틀림 TOKEN_INVALID, 만료 TOKEN_EXPIRED, 남의 계정 TOKEN_MISMATCH, 다른 회차 EVENT_MISMATCH [ASVS v5.0.0-8.2.1]', async () => {
    const w = await world();
    const bad = w.fan(1);
    const forged = bad.cmd({ token: `${bad.token.slice(0, -4)}AAAA` });
    expect(await codeOf(w.uc.execute(forged))).toBe('TOKEN_INVALID');
    const old = w.fan(2, { nowMs: NOW - 60 * 60_000 });
    expect(await codeOf(w.uc.execute(old.cmd()))).toBe('TOKEN_EXPIRED');
    const stolen = w.fan(3, { tokenAccount: ACCOUNT_B });
    expect(await codeOf(w.uc.execute(stolen.cmd()))).toBe('TOKEN_MISMATCH');
    const other = w.fan(4, { tokenEvent: 'ev-other' });
    expect(await codeOf(w.uc.execute(other.cmd()))).toBe('EVENT_MISMATCH');
    expect(w.order).not.toContain('read');
    for (const f of [bad, old, stolen, other]) expect(await w.sessionStore.read(f.jti)).toBeUndefined();
    expect(w.log.entries).toHaveLength(0);
  });

  test('ST28_ 입장 토큰 거절은 OpenSessionError 인스턴스다(받는 층이 code로 401·403·400을 가른다)', async () => {
    const w = await world();
    const err = await w.uc.execute(w.fan(1, { tokenEvent: 'ev-other' }).cmd()).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(OpenSessionError);
    expect(err).toMatchObject({ code: 'EVENT_MISMATCH' });
  });

  test('FR009_ST28_ 세션이 열린 뒤 재요청은 clientKey 없이도 같은 본문이다(임시 공개키를 보내도 같은 키면 같다). SESSION_STARTED는 늘지 않는다', async () => {
    const w = await world();
    const f = w.fan(1);
    await w.hold(['A01']);
    const first = await w.uc.execute(f.cmd());
    const again = await w.uc.execute(f.cmd({ clientKey: undefined }));
    expect(again.equals(first)).toBe(true);
    const withKey = await w.uc.execute(f.cmd());
    expect(withKey.equals(first)).toBe(true);
    // 구역 하나 요청도 키 없이 된다
    const part = decodeSnapshot(await w.uc.execute(f.cmd({ clientKey: undefined, section: 0 })));
    expect(part.sectionOnly).toBe(true);
    expect(w.log.entries).toHaveLength(1);
    expect(w.order.filter((x) => x === 'read')).toHaveLength(4);
  });

  test('ST28_ASVS8.2.1_ 세션이 열린 뒤 다른 임시 공개키를 보내면 TOKEN_USED이고 스냅샷을 읽지 않는다 [ASVS v5.0.0-8.2.1]', async () => {
    const w = await world();
    const f = w.fan(1);
    await w.uc.execute(f.cmd());
    const reads = w.reads.length;
    expect(await codeOf(w.uc.execute(f.cmd({ clientKey: clientKeyOf().text })))).toBe('TOKEN_USED');
    expect(w.reads.length).toBe(reads);
  });

  test('ST28_ 세션이 없는데 clientKey가 없으면 CLIENT_KEY_INVALID이고 세션을 만들지 않는다. 모양이 틀린 키도 같다', async () => {
    const w = await world();
    const f = w.fan(1);
    expect(await codeOf(w.uc.execute(f.cmd({ clientKey: undefined })))).toBe('CLIENT_KEY_INVALID');
    expect(await codeOf(w.uc.execute(f.cmd({ clientKey: 'not-a-key' })))).toBe('CLIENT_KEY_INVALID');
    expect(await codeOf(w.uc.execute(f.cmd({ clientKey: 12345 })))).toBe('CLIENT_KEY_INVALID');
    expect(await w.sessionStore.read(f.jti)).toBeUndefined();
    expect(w.log.entries).toHaveLength(0);
    expect(w.order).not.toContain('read');
    // 키를 제대로 보내면 열린다
    await w.uc.execute(f.cmd());
    expect(await w.sessionStore.read(f.jti)).toBeDefined();
  });

  test('ST28_ 같은 입장 토큰을 다른 계정이 쓰면 TOKEN_MISMATCH, 세션이 열린 뒤 다른 회차 주소로 보내면 EVENT_MISMATCH다', async () => {
    const w = await world();
    const f = w.fan(1);
    await w.uc.execute(f.cmd());
    expect(await codeOf(w.uc.execute(f.cmd({ accountId: ACCOUNT_B })))).toBe('TOKEN_MISMATCH');
    const second = newEvent();
    w.seatMap.put({ eventId: second, layoutVersion: '3', seatCount: SEAT_COUNT, perAccountLimit: 4, saleEndsAtMs: NOW + DAY }, SEAT_DEFS);
    await w.store.openSale({ eventId: second, seatCount: SEAT_COUNT, keepUntilMs: NOW + 2 * DAY });
    expect(await codeOf(w.uc.execute(f.cmd({ eventId: second })))).toBe('EVENT_MISMATCH');
  });
});

describe('좌석 Redis 장애와 호출 마감', () => {
  test('NFR015_ST26_ 스냅샷 읽기의 좌석 Redis 일시 장애·메모리 부족(SeatStoreUnavailable)은 그대로 던진다(같은 객체, 까닭 reason 유지). 구매 세션은 열려 있다 [ASVS v5.0.0-16.3.4]', async () => {
    for (const reason of ['unavailable', 'oom'] as const) {
      const w = await world();
      const f = w.fan(1);
      const down = new SeatStoreUnavailable(new Error(reason === 'oom' ? "OOM command not allowed when used memory > 'maxmemory'." : 'down'), reason);
      w.faults.read = down;
      const err = await w.uc.execute(f.cmd()).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(err).toBe(down);
      expect(await w.sessionStore.read(f.jti)).toBeDefined();
      // 장애가 풀리면 같은 입장 토큰으로 다시 받는다
      w.faults.read = undefined;
      expect((await w.uc.execute(f.cmd({ clientKey: undefined }))).length).toBeGreaterThan(HEADER);
    }
  });

  test('NFR003_ 요청의 deadline이 있으면 snapshots.read의 둘째 인자는 { deadlineMs: max(1, floor(min(남은 시간, 100))) }다(60 → 60, 5000 → 100, 1 → 1), 없으면 undefined다', async () => {
    const w = await world();
    const f = w.fan(1);
    await w.uc.execute(f.cmd({ deadline: Deadline.after(60, w.clock) }));
    await w.uc.execute(f.cmd({ deadline: Deadline.after(5_000, w.clock) }));
    await w.uc.execute(f.cmd({ deadline: Deadline.after(100, w.clock) }));
    await w.uc.execute(f.cmd({ deadline: Deadline.after(1, w.clock) }));
    await w.uc.execute(f.cmd());
    expect(w.reads.map((r) => r.options)).toEqual([{ deadlineMs: 60 }, { deadlineMs: 100 }, { deadlineMs: 100 }, { deadlineMs: 1 }, undefined]);
  });

  test('NFR003_ 시간이 흐른 뒤의 남은 시간으로 계산한다: 60ms 마감에서 15ms가 지났으면 45ms다', async () => {
    const w = await world();
    const f = w.fan(1);
    const deadline = Deadline.after(60, w.clock);
    w.clock.advance(15);
    await w.uc.execute(f.cmd({ deadline }));
    expect(w.reads[0]!.options).toEqual({ deadlineMs: 45 });
  });
});

describe('읽기는 아무것도 쓰지 않는다', () => {
  test('FR009_ASVS15.3.1_ 스냅샷을 읽어도 좌석 키(비트·홀드·보유 수·Stream·Pub/Sub·세대·구역 일련번호)가 바뀌지 않는다', async () => {
    const w = await world();
    await w.hold(['A01', 'B01']);
    const ev = w.store.db.event(w.eventId);
    const shape = () => JSON.stringify({ bits: [...ev.bits], holds: [...ev.holds], quota: [...ev.quota], secver: [...ev.secver], stream: ev.stream, published: ev.published, epoch: ev.epoch, expireAt: [...ev.expireAt] });
    const before = shape();
    await w.uc.execute(w.fan(1).cmd());
    await w.uc.execute(w.fan(2).cmd({ section: 1 }));
    expect(shape()).toBe(before);
    // 좌석 키가 아니라 구매 세션 키만 둘 생겼다
    expect(w.log.entries).toHaveLength(2);
  });
});
