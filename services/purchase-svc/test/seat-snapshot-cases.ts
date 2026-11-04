// 좌석 스냅샷 읽기(SeatSnapshots.read) 계약 사례(docs/features/seat-hold.md §2 '스냅샷 읽기 Lua', docs/data.md §3 s:{event:E}:bitmap·epoch·secver,
// src/modules/inventory/adapters/snapshot-lua.ts, BUILD_ORDER PRF-137). 메모리 저장소(test/seat-snapshot.test.ts)와 실제 Valkey 8.1 Lua(test-int/seat-snapshot.int.test.ts)에 똑같이 돈다.
// 읽기 결과의 bytes는 좌석 Redis 비트맵 그대로(바이트 안에서 높은 비트부터)다: 좌석 색인 k는 바이트 floor(k / 8)의 0x80 >> (k % 8)이다.
import type { Clock } from '@peaket/platform';
import { expect, test } from 'vitest';
import { type SeatSnapshots, type SeatStore, type SnapshotReadInput, type SnapshotReadResult } from '../src/modules/inventory/index.js';
import { ACCOUNT_A, ACCOUNT_B, DAY, holdInput, idx, newEvent, SEAT_COUNT } from './hold-cases.js';

/** 스냅샷 읽기 사례용 도구: 저장소 하나와 그 키를 직접 채우고 읽는 것. 키 이름은 docs/data.md §3(seatKeys)이다 */
export interface SnapshotHarness {
  store: SeatStore & SeatSnapshots;
  /** 시험 쪽 지금(메모리는 저장소에 넣은 가짜 시계, Valkey는 시스템 시계) */
  clock: Clock;
  /** 비트맵을 이 바이트들로 통째로 바꾼다(바이트 안에서 높은 비트부터, 길이는 마음대로. 빈 Buffer면 비트맵 키가 없는 것과 달리 길이 0으로 만들 수 없으니 dropBitmap을 쓴다) */
  setBitmapBytes(eventId: string, bytes: Buffer): Promise<void>;
  /** 비트맵 키를 지운다(세대 키는 그대로) */
  dropBitmap(eventId: string): Promise<void>;
  /** 세대 키를 지운다(S-T26 ③) */
  dropEpoch(eventId: string): Promise<void>;
  /** secver 칸 하나를 쓴다(메모리는 값 그대로, Valkey는 String(value)) */
  setSecver(eventId: string, sectionIndex: number, value: number): Promise<void>;
  /** secver를 통째로 지운다 */
  dropSecver(eventId: string): Promise<void>;
  /** 비트 하나(좌석 Redis 비트맵의 GETBIT) */
  bit(eventId: string, index: number): Promise<number>;
  /** secver: 구역 색인(글) → 번호 */
  secver(eventId: string): Promise<Record<string, number>>;
  /** 회차 키 전체의 모습('아무것도 쓰지 않았다'를 앞뒤로 견준다. 키의 값·형·만료 시각까지) */
  dump(eventId: string): Promise<unknown>;
}

/** 비트맵 바이트에서 좌석 색인 k의 비트(Redis 순서) */
export const redisBit = (bytes: Uint8Array, k: number): number => ((bytes[k >> 3] ?? 0) >> (7 - (k & 7))) & 1;

/** 읽기 결과가 OK인지 보고 칸만 꺼낸다 */
export function okOf(r: SnapshotReadResult): Extract<SnapshotReadResult, { kind: 'OK' }> {
  expect(r.kind).toBe('OK');
  if (r.kind !== 'OK') throw new Error(`OK가 아니다: ${JSON.stringify(r)}`);
  return r;
}

export const hexOf = (b: Uint8Array): string => Buffer.from(b).toString('hex');

export function seatSnapshotCases(name: string, make: () => Promise<SnapshotHarness>): void {
  async function world(o: { open?: boolean } = {}) {
    const h = await make();
    const eventId = newEvent();
    const keepUntilMs = h.clock.now() + 2 * DAY;
    const opened = o.open === false ? undefined : await h.store.openSale({ eventId, seatCount: SEAT_COUNT, keepUntilMs });
    const read = (c: Partial<SnapshotReadInput> = {}, e = eventId) => h.store.read({ eventId: e, firstBit: 0, bitCount: SEAT_COUNT, sectionIndexes: [0, 1], ...c });
    const hold = (seatIds: readonly string[], accountId = ACCOUNT_A) => h.store.hold(holdInput(eventId, seatIds, { accountId, keepUntilMs }));
    return { h, eventId, keepUntilMs, opened, read, hold };
  }

  // ---- 준비 표시 ----

  test(`[${name}] ST26_③_FR009_ 세대 키의 epoch 칸이 없으면 NOT_READY다(열기 전 회차도, 세대 키를 지운 회차도). 비트맵이 있어도 읽지 않는다`, async () => {
    const never = await world({ open: false });
    expect(await never.read()).toEqual({ kind: 'NOT_READY' });
    const w = await world();
    await w.hold(['A01']);
    expect(okOf(await w.read()).bytes[0]).toBe(0x80);
    await w.h.dropEpoch(w.eventId);
    expect(await w.read()).toEqual({ kind: 'NOT_READY' });
  });

  // ---- 값 ----

  test(`[${name}] FR009_ 판매를 열기만 한 회차는 OK이고 세대는 openSale의 세대, 비트는 모두 0, 구역 일련번호는 모두 0이며 bytes 길이는 40비트 = 5바이트다`, async () => {
    const w = await world();
    const r = okOf(await w.read());
    expect(r.seatEpoch).toBe(w.opened!.seatEpoch);
    expect(Number.isSafeInteger(r.seatEpoch) && r.seatEpoch >= 0 && r.seatEpoch <= 0xffff_ffff).toBe(true);
    expect(Buffer.isBuffer(r.bytes)).toBe(true);
    expect(hexOf(r.bytes)).toBe('0000000000');
    expect(r.sectionVersions).toEqual([0, 0]);
  });

  test(`[${name}] FR009_ST35_⑥_ 홀드를 잡은 뒤 읽으면 그 좌석 비트가 1(Redis 순서: A01=색인 0은 0x80, A02는 0x40, B01=색인 20은 바이트 2의 0x08)이고 구역 일련번호가 홀드 Lua가 올린 번호다`, async () => {
    const w = await world();
    expect((await w.hold(['A01', 'A02', 'B01'])).kind).toBe('OK');
    const r = okOf(await w.read());
    expect(hexOf(r.bytes)).toBe('c000080000');
    // 구역 A·B에 한 번씩 올랐다(좌석이 여럿이어도 구역마다 한 번)
    expect(r.sectionVersions).toEqual([1, 1]);
    expect(await w.h.secver(w.eventId)).toEqual({ '0': 1, '1': 1 });
    // 다른 계정이 구역 A를 한 번 더
    expect((await w.hold(['A03'], ACCOUNT_B)).kind).toBe('OK');
    const r2 = okOf(await w.read());
    expect(hexOf(r2.bytes)).toBe('e000080000');
    expect(r2.sectionVersions).toEqual([2, 1]);
    // 읽은 비트는 저장소가 가진 비트와 모든 좌석 색인에서 같다
    for (let k = 0; k < SEAT_COUNT; k++) expect({ k, bit: redisBit(r2.bytes, k) }).toEqual({ k, bit: await w.h.bit(w.eventId, k) });
    expect(idx('B01')).toBe(20);
  });

  test(`[${name}] FR009_ 잡힌 뒤 비트가 0으로 돌아가면(해제·만료) 읽기도 0이다`, async () => {
    const w = await world();
    await w.hold(['A01', 'A02']);
    await w.h.setBitmapBytes(w.eventId, Buffer.from([0x40, 0, 0, 0, 0]));
    expect(hexOf(okOf(await w.read()).bytes)).toBe('4000000000');
  });

  test(`[${name}] FR009_ 읽기는 그 회차 키만 본다: 다른 회차의 홀드는 이 회차 비트에 보이지 않는다`, async () => {
    const a = await world();
    const b = await world();
    await a.hold(['A01', 'B01']);
    expect(hexOf(okOf(await b.read()).bytes)).toBe('0000000000');
    expect(okOf(await b.read()).sectionVersions).toEqual([0, 0]);
    expect(hexOf(okOf(await a.read()).bytes)).toBe('8000080000');
  });

  // ---- 모자란 키 ----

  test(`[${name}] FR009_ 비트맵이 openSale의 좌석 수보다 짧으면 모자란 바이트를 0으로 채워 bytes 길이는 읽을 범위 그대로다`, async () => {
    const w = await world();
    await w.h.setBitmapBytes(w.eventId, Buffer.from([0xff, 0xff]));
    expect(hexOf(okOf(await w.read()).bytes)).toBe('ffff000000');
    // 읽을 범위가 통째로 비트맵 밖이어도 길이는 (끝 바이트 − 첫 바이트 + 1)이다
    const outside = okOf(await w.read({ firstBit: 24, bitCount: 16 }));
    expect(hexOf(outside.bytes)).toBe('0000');
  });

  test(`[${name}] FR009_ 비트맵 키가 없어도(세대 키만 있음) NOT_READY가 아니라 OK이고 0으로 채운 bytes와 구역 일련번호를 준다`, async () => {
    const w = await world();
    await w.h.setSecver(w.eventId, 0, 4);
    await w.h.dropBitmap(w.eventId);
    const r = okOf(await w.read());
    expect(r.seatEpoch).toBe(w.opened!.seatEpoch);
    expect(hexOf(r.bytes)).toBe('0000000000');
    expect(r.sectionVersions).toEqual([4, 0]);
  });

  test(`[${name}] FR009_ 구역 일련번호 칸이 없으면 0이고, 있는 칸은 그 값이다(u32 끝값 2^32 − 1까지). secver 키가 통째로 없어도 모두 0이다`, async () => {
    const w = await world();
    await w.h.setSecver(w.eventId, 1, 7);
    expect(okOf(await w.read({ sectionIndexes: [0, 1, 2, 65535] })).sectionVersions).toEqual([0, 7, 0, 0]);
    await w.h.setSecver(w.eventId, 2, 4294967295);
    expect(okOf(await w.read({ sectionIndexes: [2] })).sectionVersions).toEqual([4294967295]);
    await w.h.dropSecver(w.eventId);
    expect(okOf(await w.read({ sectionIndexes: [0, 1, 2] })).sectionVersions).toEqual([0, 0, 0]);
  });

  test(`[${name}] FR009_ 구역 일련번호는 요청한 구역 색인 차례대로 돌려준다(오름차순이 아니어도 요청 차례, 0 ~ 65535 사이 아무 값)`, async () => {
    const w = await world();
    await w.h.setSecver(w.eventId, 0, 9);
    await w.h.setSecver(w.eventId, 1, 3);
    await w.h.setSecver(w.eventId, 300, 11);
    expect(okOf(await w.read({ sectionIndexes: [0, 1] })).sectionVersions).toEqual([9, 3]);
    expect(okOf(await w.read({ sectionIndexes: [1, 0] })).sectionVersions).toEqual([3, 9]);
    expect(okOf(await w.read({ sectionIndexes: [300, 65535, 0, 1] })).sectionVersions).toEqual([11, 0, 9, 3]);
    expect(okOf(await w.read({ sectionIndexes: [0] })).sectionVersions).toEqual([9]);
  });

  // ---- 바이트 범위 ----

  test(`[${name}] FR009_ 바이트 범위는 floor(firstBit / 8) ~ floor((firstBit + bitCount − 1) / 8)다: 바이트에 걸치지 않는/걸치는 firstBit·bitCount 모두 그 바이트들만 돌려준다`, async () => {
    const w = await world();
    await w.h.setBitmapBytes(w.eventId, Buffer.from([0x11, 0x22, 0x33, 0x44, 0x55]));
    const bytesFor = async (firstBit: number, bitCount: number) => hexOf(okOf(await w.read({ firstBit, bitCount })).bytes);
    expect(await bytesFor(0, 1)).toBe('11');
    expect(await bytesFor(0, 40)).toBe('1122334455');
    expect(await bytesFor(8, 8)).toBe('22');
    expect(await bytesFor(9, 1)).toBe('22');
    expect(await bytesFor(7, 2)).toBe('1122');
    expect(await bytesFor(15, 2)).toBe('2233');
    expect(await bytesFor(16, 9)).toBe('3344');
    expect(await bytesFor(39, 1)).toBe('55');
    // 비트맵 끝을 넘으면 0으로 채워 길이는 (끝 바이트 − 첫 바이트 + 1)이다: 비트 33 ~ 132 → 바이트 4 ~ 16 = 13바이트
    expect(await bytesFor(33, 100)).toBe(`55${'00'.repeat(12)}`);
  });

  test(`[${name}] FR009_ 비트맵의 마지막 바이트 안에서 끝나는 범위와 한 바이트 안의 여러 비트도 바이트 단위로 돌려준다(비트 중간은 자르지 않는다)`, async () => {
    const w = await world();
    await w.h.setBitmapBytes(w.eventId, Buffer.from([0xaa, 0xbb, 0xcc, 0xdd, 0xee]));
    expect(hexOf(okOf(await w.read({ firstBit: 17, bitCount: 3 })).bytes)).toBe('cc');
    expect(hexOf(okOf(await w.read({ firstBit: 32, bitCount: 8 })).bytes)).toBe('ee');
  });

  // ---- 인자 오류 ----

  test(`[${name}] ASVS2.1.1_ 인자 오류는 RangeError다: eventId가 KEY_PART가 아님, bitCount 1 미만·소수·NaN, firstBit 음수·소수·NaN·안전한 정수 밖`, async () => {
    const w = await world();
    for (const bad of ['', 'a b', 'a}b', '{x}', 'a:b', 'x'.repeat(65), '한글']) await expect(w.read({}, bad), `eventId '${bad}'`).rejects.toBeInstanceOf(RangeError);
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) await expect(w.read({ bitCount: bad }), `bitCount ${bad}`).rejects.toBeInstanceOf(RangeError);
    for (const bad of [-1, 1.5, Number.NaN, 2 ** 53]) await expect(w.read({ firstBit: bad }), `firstBit ${bad}`).rejects.toBeInstanceOf(RangeError);
  });

  test(`[${name}] ASVS2.1.1_ sectionIndexes가 비었거나 겹치거나 0 ~ 65535의 정수가 아니면 RangeError다(65536·−1·소수·NaN, 겹침은 떨어져 있어도)`, async () => {
    const w = await world();
    const bads: number[][] = [[], [0, 0], [1, 0, 1], [-1], [65536], [1.5], [Number.NaN], [0, 65536], [0, 1, 2, 3, 3]];
    for (const sectionIndexes of bads) await expect(w.read({ sectionIndexes }), `sectionIndexes ${JSON.stringify(sectionIndexes)}`).rejects.toBeInstanceOf(RangeError);
    // 경계 값은 된다
    expect(okOf(await w.read({ sectionIndexes: [0, 65535] })).sectionVersions).toEqual([0, 0]);
  });

  test(`[${name}] FR009_ 인자 오류로 거절한 읽기도, 성공한 읽기도 회차 키에 아무것도 쓰지 않는다(키의 값·형·만료 시각이 그대로)`, async () => {
    const w = await world();
    await w.hold(['A01', 'B02']);
    await w.h.setSecver(w.eventId, 5, 2);
    const before = await w.h.dump(w.eventId);
    expect(before).toBeDefined();
    await w.read();
    await w.read({ firstBit: 9, bitCount: 3, sectionIndexes: [5, 0] });
    await expect(w.read({ bitCount: 0 })).rejects.toBeInstanceOf(RangeError);
    await expect(w.read({ sectionIndexes: [] })).rejects.toBeInstanceOf(RangeError);
    expect(await w.h.dump(w.eventId)).toEqual(before);
    // 세대 키가 없는 NOT_READY 읽기도 아무것도 만들지 않는다
    await w.h.dropEpoch(w.eventId);
    const noEpoch = await w.h.dump(w.eventId);
    expect(await w.read()).toEqual({ kind: 'NOT_READY' });
    expect(await w.h.dump(w.eventId)).toEqual(noEpoch);
  });

  test(`[${name}] FR009_ 같은 입력을 여러 번 읽으면 같은 결과다(읽기는 멱등이다)`, async () => {
    const w = await world();
    await w.hold(['A05', 'B05']);
    const a = okOf(await w.read());
    const b = okOf(await w.read());
    expect({ ...b, bytes: hexOf(b.bytes) }).toEqual({ ...a, bytes: hexOf(a.bytes) });
  });
}
