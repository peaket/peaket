// 구매 세션의 홀드 기록 계약 사례(PurchaseSessionStore.recordHold, BUILD_ORDER PRF-137, docs/features/seat-hold.md §3 '구매 세션의 홀드 기록과 첫 홀드 표시',
// docs/data.md §3 s:session:{jti}의 h:{holdId} 칸·fh 칸, src/modules/inventory/adapters/purchase-session-lua.ts RECORD_HOLD_LUA).
// 메모리 저장소(test/purchase-session.test.ts)와 실제 Valkey 8.1 Lua(test-int/purchase-session.int.test.ts, 노드 하나짜리 클러스터 모드 포함)에 똑같이 돈다.
// 이 사례들은 시각을 기다리지 않는다(홀드 기록은 시각을 보지 않는다).
import { expect, test } from 'vitest';
import { newJti, openInput, type SessionHarness } from './purchase-session-cases.js';

/** 홀드 기록을 직접 들여다보는 도구를 더한 저장소 도구 */
export interface HoldRecordHarness extends SessionHarness {
  /**
   * 세션 상태에 기록된 홀드(holdId → 좌석 ID들, 기록한 차례 그대로). 세션이 없거나 기록이 하나도 없으면 undefined.
   * 메모리는 MemoryPurchaseSessionStore.holdsOf, Valkey는 HGETALL s:session:{jti}의 h:{holdId} 칸(좌석 ID를 쉼표로 이은 글)이다
   */
  holds(jti: string): Promise<ReadonlyMap<string, readonly string[]> | undefined>;
  /** 세션 상태 키가 있는지(Valkey는 EXISTS. 메모리는 read가 있는지). 기록이 키를 만들거나 되살리지 않는지 본다 */
  exists(jti: string): Promise<boolean>;
  /** 첫 홀드 표시 fh 칸의 글(Valkey만. 메모리는 없다) */
  fh?(jti: string): Promise<string | undefined>;
  /** 세션 상태 키가 사라지는 시각(epoch ms, Valkey만 PEXPIRETIME. 메모리는 없다) */
  expireAt?(jti: string): Promise<number | undefined>;
}

const BAD_PARTS = ['', 'a}b', '{x}', 'a:b', 'a b', 'x'.repeat(65), 'é'];
const BAD_SEAT_IDS = ['', 'a b', 'x'.repeat(65), 'a,b', 'a}b', 'é', 'a/b', 'a\n'];

async function opened(h: HoldRecordHarness): Promise<string> {
  const jti = newJti();
  expect((await h.store.open(openInput(h, jti))).kind).toBe('CREATED');
  return jti;
}

let n = 0;
/** 시험마다 다른 holdId(KEY_PART 모양) */
const holdIdOf = () => `hold-${process.pid}-${Date.now().toString(36)}-${n++}`;

export function sessionHoldRecordCases(make: () => Promise<HoldRecordHarness> | HoldRecordHarness): void {
  test('ST35_ADR0171_세션이 있으면 첫 호출은 true, 둘째부터는 false이다(첫 홀드 표시 fh는 처음 한 번만). 홀드마다 좌석 ID들이 기록한 차례 그대로 한 칸씩 남는다', async () => {
    const h = await make();
    const jti = await opened(h);
    expect(await h.holds(jti)).toBeUndefined();
    expect(await h.fh?.(jti)).toBeUndefined();
    const h1 = holdIdOf();
    const h2 = holdIdOf();
    const h3 = holdIdOf();
    expect(await h.store.recordHold(jti, h1, ['B02', 'A01'])).toBe(true);
    expect(await h.fh?.(jti)).toBe(h.fh ? '1' : undefined);
    expect(await h.store.recordHold(jti, h2, ['C03'])).toBe(false);
    expect(await h.store.recordHold(jti, h3, ['D01', 'D02', 'D03'])).toBe(false);
    expect(await h.fh?.(jti)).toBe(h.fh ? '1' : undefined);
    const got = await h.holds(jti);
    expect(got).toBeDefined();
    expect(got!.size).toBe(3);
    expect(got!.get(h1)).toEqual(['B02', 'A01']);
    expect(got!.get(h2)).toEqual(['C03']);
    expect(got!.get(h3)).toEqual(['D01', 'D02', 'D03']);
  });

  test('ST35_첫 홀드 표시는 구매 세션마다 따로다: 다른 세션의 첫 기록도 true이고, 서로의 기록이 섞이지 않는다', async () => {
    const h = await make();
    const a = await opened(h);
    const b = await opened(h);
    const ha = holdIdOf();
    const hb = holdIdOf();
    expect(await h.store.recordHold(a, ha, ['A01'])).toBe(true);
    expect(await h.store.recordHold(b, hb, ['B01'])).toBe(true);
    expect(await h.store.recordHold(a, holdIdOf(), ['A02'])).toBe(false);
    expect(await h.store.recordHold(b, holdIdOf(), ['B02'])).toBe(false);
    expect([...(await h.holds(a))!.keys()]).toContain(ha);
    expect([...(await h.holds(a))!.keys()]).not.toContain(hb);
    expect([...(await h.holds(b))!.keys()]).toContain(hb);
    expect((await h.holds(a))!.size).toBe(2);
    expect((await h.holds(b))!.size).toBe(2);
  });

  test('세션이 없으면 null이고 아무것도 만들지 않는다: 읽으면 undefined, 기록도 키도 없고, 같은 jti로 열면 CREATED다(재사용 차단 표지도 만들지 않았다) [ASVS v5.0.0-8.2.2]', async () => {
    const h = await make();
    const jti = newJti();
    expect(await h.store.recordHold(jti, holdIdOf(), ['A01'])).toBeNull();
    expect(await h.store.recordHold(jti, holdIdOf(), ['A02'])).toBeNull();
    expect(await h.store.read(jti)).toBeUndefined();
    expect(await h.holds(jti)).toBeUndefined();
    expect(await h.exists(jti)).toBe(false);
    expect((await h.store.open(openInput(h, jti))).kind).toBe('CREATED');
    // 열린 뒤 첫 기록은 이 세션의 첫 홀드다(앞의 null 호출이 표시를 남기지 않았다)
    expect(await h.store.recordHold(jti, holdIdOf(), ['A03'])).toBe(true);
  });

  test('세션이 끝난 뒤(키가 사라진 뒤)의 기록도 null이고 키를 되살리지 않는다: 같은 입장 토큰은 여전히 ENDED다 [ASVS v5.0.0-8.2.2]', async () => {
    const h = await make();
    const jti = await opened(h);
    expect(await h.store.recordHold(jti, holdIdOf(), ['A01'])).toBe(true);
    await h.end(jti);
    expect(await h.store.recordHold(jti, holdIdOf(), ['A02'])).toBeNull();
    expect(await h.store.read(jti)).toBeUndefined();
    expect(await h.exists(jti)).toBe(false);
    expect(await h.holds(jti)).toBeUndefined();
    expect(await h.fh?.(jti)).toBeUndefined();
    expect(await h.store.open(openInput(h, jti))).toEqual({ kind: 'ENDED' });
    expect(await h.exists(jti)).toBe(false);
  });

  test('모양이 틀린 입력은 RangeError이고 아무것도 쓰지 않는다: jti·holdId는 키 조각 모양, seatIds는 1~10개이고 좌석 ID는 ^[A-Za-z0-9_-]{1,64}$ (쉼표 금지) [ASVS v5.0.0-1.2.4]', async () => {
    const h = await make();
    const jti = await opened(h);
    const ok = holdIdOf();
    for (const bad of BAD_PARTS) {
      await expect(h.store.recordHold(bad, ok, ['A01']), `jti ${JSON.stringify(bad)}`).rejects.toThrow(RangeError);
      await expect(h.store.recordHold(jti, bad, ['A01']), `holdId ${JSON.stringify(bad)}`).rejects.toThrow(RangeError);
    }
    await expect(h.store.recordHold(jti, ok, []), '빈 좌석 목록').rejects.toThrow(RangeError);
    const eleven = Array.from({ length: 11 }, (_, i) => `S${String(i).padStart(2, '0')}`);
    await expect(h.store.recordHold(jti, ok, eleven), '좌석 11개').rejects.toThrow(RangeError);
    for (const bad of BAD_SEAT_IDS) {
      await expect(h.store.recordHold(jti, ok, ['A01', bad]), `좌석 ID ${JSON.stringify(bad)}`).rejects.toThrow(RangeError);
    }
    // 세션이 없는 jti여도 모양이 틀리면 null이 아니라 RangeError다
    await expect(h.store.recordHold(newJti(), ok, ['a,b']), '없는 세션 + 쉼표').rejects.toThrow(RangeError);
    // 실패한 호출은 아무것도 남기지 않는다: 기록도 없고 첫 홀드 표시도 쓰이지 않았다
    expect(await h.holds(jti)).toBeUndefined();
    expect(await h.fh?.(jti)).toBeUndefined();
    expect(await h.store.recordHold(jti, ok, ['A01'])).toBe(true);
    // 경계: 좌석 10개, 64자 좌석 ID·64자 holdId는 받는다
    const ten = Array.from({ length: 10 }, (_, i) => `S${String(i).padStart(2, '0')}`);
    const longHold = 'h'.repeat(64);
    expect(await h.store.recordHold(jti, longHold, [...ten.slice(0, 9), 'x'.repeat(64)])).toBe(false);
    expect((await h.holds(jti))!.get(longHold)).toEqual([...ten.slice(0, 9), 'x'.repeat(64)]);
    expect(await h.store.recordHold(jti, holdIdOf(), ten)).toBe(false);
  });

  test('ST35_같은 holdId를 두 번 기록해도 칸은 하나다(덮어쓴다). 둘째는 false이고 마지막에 쓴 좌석 ID들이 남는다', async () => {
    const h = await make();
    const jti = await opened(h);
    const id = holdIdOf();
    expect(await h.store.recordHold(jti, id, ['A01'])).toBe(true);
    expect(await h.store.recordHold(jti, id, ['A02', 'A03'])).toBe(false);
    const got = await h.holds(jti);
    expect(got!.size).toBe(1);
    expect(got!.get(id)).toEqual(['A02', 'A03']);
  });

  test('기록은 세션 상태를 바꾸지 않는다: 일련번호·유휴 시한·최대 체류 등 read가 주는 값과 열기의 REPLAY 결과, 키 수명이 그대로다 [ASVS v5.0.0-9.1.1]', async () => {
    const h = await make();
    const jti = newJti();
    const i = openInput(h, jti);
    expect((await h.store.open(i)).kind).toBe('CREATED');
    expect(await h.store.advance(jti, 4)).toBe(true);
    // 시작 사건 표시를 해 두면 REPLAY의 needsStarted가 시간에 따라 바뀌지 않는다
    expect(await h.store.markStarted(jti)).toBe(true);
    const before = await h.store.read(jti);
    const replayBefore = await h.store.open(i);
    const lifeBefore = await h.expireAt?.(jti);
    await h.pass(30);
    expect(await h.store.recordHold(jti, holdIdOf(), ['A01', 'A02'])).toBe(true);
    expect(await h.store.recordHold(jti, holdIdOf(), ['A03'])).toBe(false);
    expect(await h.store.read(jti)).toEqual(before);
    expect((await h.store.read(jti))?.lastSeq).toBe(4);
    expect(await h.store.open(i)).toEqual(replayBefore);
    expect(await h.expireAt?.(jti)).toBe(lifeBefore);
    // 기록 뒤에도 일련번호는 이어서 올라간다
    expect(await h.store.advance(jti, 5)).toBe(true);
    expect((await h.store.read(jti))?.lastSeq).toBe(5);
    expect((await h.holds(jti))!.size).toBe(2);
  });

  test('ST35_같은 세션에 동시에 20번 기록해도 true는 정확히 한 번이고 홀드 칸은 20개 모두 남는다', async () => {
    const h = await make();
    const jti = await opened(h);
    const ids = Array.from({ length: 20 }, () => holdIdOf());
    const rs = await Promise.all(ids.map((id, k) => h.store.recordHold(jti, id, [`S${String(k).padStart(2, '0')}`])));
    expect(rs.filter((r) => r === true)).toHaveLength(1);
    expect(rs.filter((r) => r === false)).toHaveLength(19);
    expect(rs.filter((r) => r === null)).toHaveLength(0);
    const got = await h.holds(jti);
    expect(got!.size).toBe(20);
    ids.forEach((id, k) => expect(got!.get(id)).toEqual([`S${String(k).padStart(2, '0')}`]));
  });
}
