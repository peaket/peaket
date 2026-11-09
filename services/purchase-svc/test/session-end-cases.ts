// 구매 세션 종료·정리 저장소 계약 사례(PurchaseSessionStore.end·sweep·setPaying, BUILD_ORDER PRF-138, docs/features/seat-hold.md §2 '구매 세션 종료와 정리',
// docs/data.md §3 s:session:{jti}의 pay 칸, src/modules/inventory/adapters/purchase-session-lua.ts의 END_SESSION_LUA·SWEEP_SESSION_LUA·PAY_SESSION_LUA 계약,
// docs/planning/03-policies-glossary.md §2.2 T4~T12). 메모리 저장소(test/purchase-session.test.ts)와 실제 Valkey 8.1 Lua(test-int/purchase-session.int.test.ts,
// 노드 하나짜리 클러스터 모드 포함)에 똑같이 돈다.
// 유휴 시한(SESSION_IDLE_MS 5분)은 시험이 기다릴 수 없다: 메모리는 가짜 시계를 5분 밀고, Valkey는 유휴 시한 칸을 과거로 직접 쓴다(setIdle, 시험 전용).
// 최대 체류는 짧은 기한(1.5초)을 주고 실제로 기다린다(메모리는 가짜 시계를 민다).
import { expect, test } from 'vitest';
import { type OpenSessionInput, SESSION_IDLE_MS } from '../src/modules/inventory/index.js';
import { EVENT, JOURNEY, newJti, openInput, type SessionHarness } from './purchase-session-cases.js';

/** 종료·정리 사례용 저장소 도구 */
export interface EndHarness extends SessionHarness {
  /**
   * 세션 상태의 유휴 시한 칸(idle)을 ms로 직접 쓴다(Valkey만, 시험 전용 HSET s:session:{jti} idle ms. 세션이 있을 때만 부른다).
   * 없으면(메모리) 유휴 시한은 가짜 시계를 SESSION_IDLE_MS 밀어 닿게 한다
   */
  setIdle?(jti: string, ms: number): Promise<void>;
}

const OTHER_JOURNEY = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c';
const BAD_JTI = ['', 'a}b', '{x}', 'a:b', 'a b', 'x'.repeat(65), 'é'];
const near = (a: number, b: number, skew: number) => Math.abs(a - b) <= skew;

/** 열고 CREATED를 확인한다. 회차·여정·최대 체류 같은 열기 입력은 over로 바꾼다 */
async function opened(h: EndHarness, over: Partial<OpenSessionInput> = {}): Promise<{ jti: string; i: OpenSessionInput; startedAtMs: number }> {
  const jti = newJti();
  const i = openInput(h, jti, over);
  const r = await h.store.open(i);
  if (r.kind !== 'CREATED') throw new Error('CREATED여야 한다');
  return { jti, i, startedAtMs: r.startedAtMs };
}

/** 그 세션의 유휴 시한에 닿게 한다(최대 체류는 넘기지 않는다) */
async function reachIdle(h: EndHarness, jti: string): Promise<void> {
  if (h.setIdle) await h.setIdle(jti, h.now() - 1_000);
  else await h.pass(SESSION_IDLE_MS);
}

/**
 * 유휴 시한과 최대 체류를 함께 다루는 사례의 최대 체류까지 남은 시간(ms). Valkey는 1.5초(유휴 시한을 칸으로 직접 쓰므로 짧게 기다린다),
 * 메모리는 유휴 5분 + 10초(가짜 시계를 5분 밀어도 세션 키 수명(최대 체류 + 60초) 안이라 세션이 남아 있다)
 */
const shortMax = (h: EndHarness) => (h.setIdle ? 1_500 : SESSION_IDLE_MS + 10_000);

/** 이 열기 입력의 최대 체류를 지나게 한다(여유 150ms) */
async function passMax(h: EndHarness, i: OpenSessionInput): Promise<void> {
  await h.pass(Math.max(0, i.expiresAtMs - h.now()) + 150);
}

export function sessionEndCases(make: () => Promise<EndHarness> | EndHarness): void {
  // ── end ─────────────────────────────────────────────────────────────────────────────────────────────────────

  test('QT11_ST33_ADR0183_8_end는 세션이 있으면 회차 ID·여정 ID를 주고 세션 상태를 지운다: 읽으면 undefined이고 일련번호·홀드 기록·시작 표시는 거절되며, 재사용 차단 표지는 남아 같은 입장 토큰으로 다시 열면 ENDED다 [ASVS v5.0.0-8.2.1]', async () => {
    const h = await make();
    const { jti, i } = await opened(h, { eventId: 'ev-end-1', journeyId: OTHER_JOURNEY });
    expect(await h.store.advance(jti, 1)).toBe(true);
    expect(await h.store.recordHold(jti, 'hold-1', ['A01'])).toBe(true);
    expect(await h.store.end(jti)).toMatchObject({ eventId: 'ev-end-1', journeyId: OTHER_JOURNEY });
    expect(await h.store.read(jti)).toBeUndefined();
    expect(await h.store.advance(jti, 2)).toBe(false);
    expect(await h.store.recordHold(jti, 'hold-2', ['A02'])).toBeNull();
    expect(await h.store.markStarted(jti)).toBe(false);
    // 같은 입장 토큰·키 없는 재요청·다시 받은 입장 토큰(더 늦은 exp) 모두 새 세션을 열지 못한다
    expect(await h.store.open(i)).toEqual({ kind: 'ENDED' });
    expect(await h.store.open({ ...i, clientKey: undefined })).toEqual({ kind: 'ENDED' });
    const reissued = openInput(h, jti, { eventId: 'ev-end-1', expiresAtMs: i.expiresAtMs + 40 * 60_000, reissueUntilMs: i.reissueUntilMs + 40 * 60_000 });
    expect(await h.store.open(reissued)).toEqual({ kind: 'ENDED' });
    expect(await h.store.read(jti)).toBeUndefined();
  });

  test('QT11_end를 두 번 부르면 둘째는 null이다(한 번만 끝난다). 동시에 여러 번 불러도 끝내는 쪽은 하나다', async () => {
    const h = await make();
    const a = await opened(h);
    expect(await h.store.end(a.jti)).toEqual({ eventId: EVENT, journeyId: JOURNEY });
    expect(await h.store.end(a.jti)).toBeNull();
    expect(await h.store.end(a.jti)).toBeNull();

    const b = await opened(h);
    const rs = await Promise.all(Array.from({ length: 20 }, () => h.store.end(b.jti)));
    expect(rs.filter((r) => r !== null)).toEqual([{ eventId: EVENT, journeyId: JOURNEY }]);
    expect(rs.filter((r) => r === null)).toHaveLength(19);
  });

  test('QT11_세션이 없으면 end는 null이고 아무것도 만들지 않는다: 읽으면 undefined이고, 같은 jti로 열면 ENDED가 아니라 CREATED다(재사용 차단 표지도 만들지 않았다) [ASVS v5.0.0-8.2.2]', async () => {
    const h = await make();
    const jti = newJti();
    expect(await h.store.end(jti)).toBeNull();
    expect(await h.store.read(jti)).toBeUndefined();
    expect(await h.store.advance(jti, 1)).toBe(false);
    expect((await h.store.open(openInput(h, jti))).kind).toBe('CREATED');
  });

  test('QT11_POL009_Paying인 세션도 end로 끝난다(Active·Paying 모두)', async () => {
    const h = await make();
    const { jti } = await opened(h);
    expect(await h.store.setPaying(jti, true)).toBe(true);
    expect(await h.store.end(jti)).toEqual({ eventId: EVENT, journeyId: JOURNEY });
    expect(await h.store.read(jti)).toBeUndefined();
    expect(await h.store.sweep(jti)).toEqual({ kind: 'GONE' });
    expect(await h.store.setPaying(jti, false)).toBe(false);
    expect(await h.store.setPaying(jti, true)).toBe(false);
  });

  test('QT11_end는 그 세션만 끝낸다: 다른 세션의 상태·일련번호 올리기는 그대로다', async () => {
    const h = await make();
    const a = await opened(h);
    const b = await opened(h);
    expect(await h.store.advance(b.jti, 4)).toBe(true);
    const before = await h.store.read(b.jti);
    expect(await h.store.end(a.jti)).not.toBeNull();
    expect(await h.store.read(b.jti)).toEqual(before);
    expect(await h.store.advance(b.jti, 5)).toBe(true);
    expect(await h.store.sweep(b.jti)).toMatchObject({ kind: 'LIVE' });
  });

  test('end·sweep·setPaying의 jti가 키 조각 모양이 아니면 RangeError이고 아무것도 쓰지 않는다 [ASVS v5.0.0-1.2.4]', async () => {
    const h = await make();
    for (const bad of BAD_JTI) {
      await expect(h.store.end(bad), `end ${bad}`).rejects.toThrow(RangeError);
      await expect(h.store.sweep(bad), `sweep ${bad}`).rejects.toThrow(RangeError);
      await expect(h.store.setPaying(bad, true), `setPaying ${bad}`).rejects.toThrow(RangeError);
      await expect(h.store.setPaying(bad, false), `setPaying false ${bad}`).rejects.toThrow(RangeError);
    }
    // 살아 있는 세션은 이 호출들로 달라지지 않는다
    const { jti } = await opened(h);
    const before = await h.store.read(jti);
    await expect(h.store.end('a}b')).rejects.toThrow(RangeError);
    expect(await h.store.read(jti)).toEqual(before);
  });

  // ── sweep ───────────────────────────────────────────────────────────────────────────────────────────────────

  test('QT11_sweep: 세션 상태가 없으면 GONE이고 아무것도 만들지 않는다(같은 jti로 열면 CREATED)', async () => {
    const h = await make();
    const jti = newJti();
    expect(await h.store.sweep(jti)).toEqual({ kind: 'GONE' });
    expect(await h.store.read(jti)).toBeUndefined();
    expect((await h.store.open(openInput(h, jti))).kind).toBe('CREATED');
    // 만들어진 세션에 점검이 지난 흔적(유휴로 끝낼 표시)이 남지 않았다: 갓 열렸으니 LIVE다
    expect(await h.store.sweep(jti)).toMatchObject({ kind: 'LIVE' });
  });

  test('QT11_POL009_sweep: 살아 있고 유휴 시한 앞이면 LIVE이고 다음 점검 = min(최대 체류, 유휴 시한)이다. 아무것도 바꾸지 않는다', async () => {
    const h = await make();
    const a = await opened(h);
    const beforeA = await h.store.read(a.jti);
    expect(await h.store.sweep(a.jti)).toEqual({ kind: 'LIVE', nextCheckMs: a.startedAtMs + SESSION_IDLE_MS });
    expect(await h.store.sweep(a.jti)).toEqual({ kind: 'LIVE', nextCheckMs: a.startedAtMs + SESSION_IDLE_MS });
    expect(await h.store.read(a.jti)).toEqual(beforeA);

    // 최대 체류가 유휴 시한보다 이르면 다음 점검은 최대 체류다
    const b = await opened(h, { expiresAtMs: h.now() + 60_000 });
    const beforeB = await h.store.read(b.jti);
    expect(await h.store.sweep(b.jti)).toEqual({ kind: 'LIVE', nextCheckMs: b.i.expiresAtMs });
    expect(await h.store.read(b.jti)).toEqual(beforeB);
    expect(await h.store.advance(b.jti, 1)).toBe(true);
  });

  test('QT11_ADR0183_11_sweep: 최대 체류에 닿으면 ENDED(MAX_STAY)로 회차·여정·끝낸 시각을 주고 세션 상태를 지운다. 재사용 차단 표지는 남는다 [ASVS v5.0.0-9.2.1]', async () => {
    const h = await make();
    const { jti, i } = await opened(h, { eventId: 'ev-sw-1', journeyId: OTHER_JOURNEY, expiresAtMs: h.now() + 1_500 });
    expect(await h.store.sweep(jti)).toMatchObject({ kind: 'LIVE' });
    await passMax(h, i);
    const r = await h.store.sweep(jti);
    expect(r).toMatchObject({ kind: 'ENDED', reason: 'MAX_STAY', eventId: 'ev-sw-1', journeyId: OTHER_JOURNEY });
    if (r.kind !== 'ENDED') return;
    expect(Object.keys(r).sort()).toEqual(['endedAtMs', 'eventId', 'journeyId', 'kind', 'reason']);
    expect(r.endedAtMs).toBeGreaterThanOrEqual(i.expiresAtMs);
    expect(near(r.endedAtMs, h.now(), h.skewMs)).toBe(true);
    expect(await h.store.read(jti)).toBeUndefined();
    expect(await h.store.advance(jti, 1)).toBe(false);
    expect(await h.store.sweep(jti)).toEqual({ kind: 'GONE' });
    // 다시 받은 입장 토큰(더 늦은 exp)으로도 세션을 새로 열지 못한다
    const reissued = openInput(h, jti, { eventId: 'ev-sw-1', expiresAtMs: h.now() + 40 * 60_000, reissueUntilMs: h.now() + 85 * 60_000 });
    expect(await h.store.open(reissued)).toEqual({ kind: 'ENDED' });
  });

  test('S-T33 ⑥ HOT070_sweep: 끝낼 때 세션에 홀드가 있으면 계정과 홀드 칸을 돌려준다(유휴·최대 체류, 끝낸 뒤 홀드를 풀 재료다)', async () => {
    const h = await make();
    const idle = await opened(h, { eventId: 'ev-sw-h1' });
    expect(await h.store.recordHold(idle.jti, 'h1', ['A01', 'A02'])).toBe(true);
    await reachIdle(h, idle.jti);
    expect(await h.store.sweep(idle.jti)).toMatchObject({ kind: 'ENDED', reason: 'IDLE', accountId: idle.i.accountId, holds: [{ holdId: 'h1', seatIds: ['A01', 'A02'] }] });
    const max = await opened(h, { eventId: 'ev-sw-h2', expiresAtMs: h.now() + shortMax(h) });
    expect(await h.store.recordHold(max.jti, 'h2', ['B01'])).toBe(true);
    await passMax(h, max.i);
    expect(await h.store.sweep(max.jti)).toMatchObject({ kind: 'ENDED', reason: 'MAX_STAY', accountId: max.i.accountId, holds: [{ holdId: 'h2', seatIds: ['B01'] }] });
  });

  test('S-T33 ⑥ HOT070_end: 끝낼 때 세션에 홀드가 있으면 계정과 홀드 칸을 돌려준다', async () => {
    const h = await make();
    const { jti, i } = await opened(h, { eventId: 'ev-end-h1' });
    expect(await h.store.recordHold(jti, 'h1', ['A01'])).toBe(true);
    expect(await h.store.end(jti)).toMatchObject({ accountId: i.accountId, holds: [{ holdId: 'h1', seatIds: ['A01'] }] });
  });

  test('QT11_POL009_sweep: 유휴 시한에 닿으면 ENDED(IDLE)로 회차·여정·끝낸 시각을 주고 세션 상태를 지운다. 최대 체류 앞이라 MAX_STAY가 아니다', async () => {
    const h = await make();
    const { jti, i } = await opened(h, { eventId: 'ev-sw-2', journeyId: OTHER_JOURNEY });
    await reachIdle(h, jti);
    const r = await h.store.sweep(jti);
    expect(r).toMatchObject({ kind: 'ENDED', reason: 'IDLE', eventId: 'ev-sw-2', journeyId: OTHER_JOURNEY });
    if (r.kind !== 'ENDED') return;
    expect(r.endedAtMs).toBeLessThan(i.expiresAtMs);
    expect(near(r.endedAtMs, h.now(), h.skewMs)).toBe(true);
    expect(await h.store.read(jti)).toBeUndefined();
    expect(await h.store.advance(jti, 1)).toBe(false);
    expect(await h.store.sweep(jti)).toEqual({ kind: 'GONE' });
    expect(await h.store.open(i)).toEqual({ kind: 'ENDED' });
  });

  test('QT11_POL009_ADR0183_8_sweep: 일련번호를 올린 세션은 유휴 시한이 뒤로 밀려 아직 LIVE다. 올리지 못한 요청은 밀지 못하고, 다시 유휴 시한에 닿으면 IDLE로 끝난다', async () => {
    const h = await make();
    const { jti } = await opened(h);
    await reachIdle(h, jti);
    // 유휴 시한이 지난 뒤라도 일련번호를 올리면 지금 + 5분으로 다시 쓰인다
    expect(await h.store.advance(jti, 1)).toBe(true);
    const s = (await h.store.read(jti))!;
    expect(near(s.idleUntilMs, h.now() + SESSION_IDLE_MS, h.skewMs)).toBe(true);
    expect(await h.store.sweep(jti)).toEqual({ kind: 'LIVE', nextCheckMs: s.idleUntilMs });
    // 올리지 못한 요청(같은 번호)은 유휴 시한을 밀지 못한다
    expect(await h.store.advance(jti, 1)).toBe(false);
    expect((await h.store.read(jti))?.idleUntilMs).toBe(s.idleUntilMs);
    await reachIdle(h, jti);
    expect(await h.store.sweep(jti)).toMatchObject({ kind: 'ENDED', reason: 'IDLE' });
  });

  test('QT11_POL009_sweep: 최대 체류와 유휴 시한이 모두 지났으면 MAX_STAY가 이긴다', async () => {
    const h = await make();
    const { jti, i } = await opened(h, { eventId: 'ev-sw-3', expiresAtMs: h.now() + shortMax(h) });
    await reachIdle(h, jti);
    await passMax(h, i);
    expect(await h.store.sweep(jti)).toMatchObject({ kind: 'ENDED', reason: 'MAX_STAY', eventId: 'ev-sw-3' });
    expect(await h.store.read(jti)).toBeUndefined();
    expect(await h.store.sweep(jti)).toEqual({ kind: 'GONE' });
  });

  test('QT11_POL009_ADR0183_11_sweep: Paying이면 유휴 시한이 지나도 LIVE이고 다음 점검은 min(최대 체류, 지금 + 5분)이다(유휴로 끝내지 않는다). 세션 상태는 그대로다', async () => {
    const h = await make();
    const { jti, i } = await opened(h);
    expect(await h.store.setPaying(jti, true)).toBe(true);
    await reachIdle(h, jti);
    const before = await h.store.read(jti);
    // Paying이어도 5분 [가정]마다 다시 본다(결제 실패로 Active에 돌아와도 유휴 5분 정리가 최대 체류까지 밀리지 않게): 다음 점검 = min(최대 체류, 지금 + 유휴 5분)
    for (let k = 0; k < 2; k++) {
      const r = await h.store.sweep(jti);
      expect(r.kind).toBe('LIVE');
      if (r.kind !== 'LIVE') return;
      expect(r.nextCheckMs).toBeLessThanOrEqual(Math.min(i.expiresAtMs, h.now() + SESSION_IDLE_MS + h.skewMs));
      expect(r.nextCheckMs).toBeGreaterThanOrEqual(Math.min(i.expiresAtMs, h.now() + SESSION_IDLE_MS - h.skewMs));
    }
    expect(await h.store.read(jti)).toEqual(before);
    // 유휴 시한이 지나 있어도 일련번호는 올라간다(Paying 동안의 결제 요청)
    expect(await h.store.advance(jti, 1)).toBe(true);
  });

  test('QT11_POL009_sweep: Paying이어도 최대 체류에 닿으면 MAX_STAY로 끝난다(안전장치, T10) [ASVS v5.0.0-9.2.1]', async () => {
    const h = await make();
    const { jti, i } = await opened(h, { eventId: 'ev-sw-4', expiresAtMs: h.now() + 1_500 });
    expect(await h.store.setPaying(jti, true)).toBe(true);
    await passMax(h, i);
    expect(await h.store.sweep(jti)).toMatchObject({ kind: 'ENDED', reason: 'MAX_STAY', eventId: 'ev-sw-4' });
    expect(await h.store.read(jti)).toBeUndefined();
    expect(await h.store.sweep(jti)).toEqual({ kind: 'GONE' });
  });

  test('QT11_sweep: end로 끝난 세션을 점검하면 GONE이다. 점검이 끝낸 세션에 end를 부르면 null이다', async () => {
    const h = await make();
    const a = await opened(h);
    expect(await h.store.end(a.jti)).not.toBeNull();
    expect(await h.store.sweep(a.jti)).toEqual({ kind: 'GONE' });

    const b = await opened(h);
    await reachIdle(h, b.jti);
    expect(await h.store.sweep(b.jti)).toMatchObject({ kind: 'ENDED', reason: 'IDLE' });
    expect(await h.store.end(b.jti)).toBeNull();
  });

  test('QT11_sweep: 끝낼 세션을 동시에 점검하고 end를 불러도 끝내는 쪽은 하나다(점검은 ENDED 하나, 나머지는 GONE / end는 null)', async () => {
    const h = await make();
    const { jti, i } = await opened(h, { expiresAtMs: h.now() + 1_500 });
    await passMax(h, i);
    const [sweeps, ends] = await Promise.all([
      Promise.all(Array.from({ length: 15 }, () => h.store.sweep(jti))),
      Promise.all(Array.from({ length: 5 }, () => h.store.end(jti))),
    ]);
    const endedBySweep = sweeps.filter((r) => r.kind === 'ENDED').length;
    const endedByEnd = ends.filter((r) => r !== null).length;
    expect(endedBySweep + endedByEnd).toBe(1);
    // 최대 체류가 지난 뒤라 LIVE는 없다
    expect(sweeps.every((r) => r.kind === 'ENDED' || r.kind === 'GONE')).toBe(true);
    expect(await h.store.read(jti)).toBeUndefined();
  });

  // ── setPaying ───────────────────────────────────────────────────────────────────────────────────────────────

  test('POL009_ADR0183_11_setPaying: 세션이 있으면 true이고 같은 값을 두 번 써도 true다. true는 유휴 시한을 바꾸지 않아 세션 상태 읽기 결과는 그대로다', async () => {
    const h = await make();
    const { jti } = await opened(h);
    expect(await h.store.advance(jti, 3)).toBe(true);
    const before = await h.store.read(jti);
    expect(await h.store.setPaying(jti, true)).toBe(true);
    expect(await h.store.setPaying(jti, true)).toBe(true);
    expect(await h.store.read(jti)).toEqual(before);
    expect(await h.store.setPaying(jti, false)).toBe(true);
    expect(await h.store.setPaying(jti, false)).toBe(true);
    expect((await h.store.read(jti))?.lastSeq).toBe(3);
  });

  test('POL009_setPaying: 세션이 없으면 true·false 모두 false이고 아무것도 만들지 않는다(그 뒤 새로 연 세션이 Paying 표시를 물려받지 않는다) [ASVS v5.0.0-8.2.2]', async () => {
    const h = await make();
    const jti = newJti();
    expect(await h.store.setPaying(jti, true)).toBe(false);
    expect(await h.store.setPaying(jti, false)).toBe(false);
    expect(await h.store.read(jti)).toBeUndefined();
    expect(await h.store.sweep(jti)).toEqual({ kind: 'GONE' });
    expect((await h.store.open(openInput(h, jti))).kind).toBe('CREATED');
    // 새 세션은 Active다: 유휴 시한에 닿으면 IDLE로 끝난다
    await reachIdle(h, jti);
    expect(await h.store.sweep(jti)).toMatchObject({ kind: 'ENDED', reason: 'IDLE' });
  });

  test('POL009_setPaying: 끝난 세션에는 false이다(end로 끝났든 점검이 끝냈든). 끝난 세션을 되살리지 않는다', async () => {
    const h = await make();
    const a = await opened(h);
    expect(await h.store.end(a.jti)).not.toBeNull();
    expect(await h.store.setPaying(a.jti, true)).toBe(false);
    expect(await h.store.setPaying(a.jti, false)).toBe(false);
    expect(await h.store.read(a.jti)).toBeUndefined();

    const b = await opened(h);
    await reachIdle(h, b.jti);
    expect(await h.store.sweep(b.jti)).toMatchObject({ kind: 'ENDED' });
    expect(await h.store.setPaying(b.jti, true)).toBe(false);
    expect(await h.store.read(b.jti)).toBeUndefined();
    expect(await h.store.open(b.i)).toEqual({ kind: 'ENDED' });
  });

  test('POL009_ADR0183_11_setPaying(false): pay 표시를 지우고 유휴 시한을 지금 + 5분으로 다시 쓴다: Paying 동안 지난 유휴 시한은 Active로 돌아오면 새로 5분이고, 그 뒤 다시 유휴에 닿으면 IDLE이다 (T8)', async () => {
    const h = await make();
    const { jti } = await opened(h);
    expect(await h.store.setPaying(jti, true)).toBe(true);
    await reachIdle(h, jti);
    expect(await h.store.sweep(jti)).toMatchObject({ kind: 'LIVE' });

    expect(await h.store.setPaying(jti, false)).toBe(true);
    const s = (await h.store.read(jti))!;
    expect(near(s.idleUntilMs, h.now() + SESSION_IDLE_MS, h.skewMs)).toBe(true);
    expect(await h.store.sweep(jti)).toEqual({ kind: 'LIVE', nextCheckMs: s.idleUntilMs });

    await reachIdle(h, jti);
    expect(await h.store.sweep(jti)).toMatchObject({ kind: 'ENDED', reason: 'IDLE' });
  });

  test('POL009_setPaying(false)는 Active 세션에도 유휴 시한을 지금 + 5분으로 다시 쓴다(칸이 없어도 유휴 시한은 다시 쓴다). 일련번호·최대 체류는 그대로다', async () => {
    const h = await make();
    const { jti, startedAtMs } = await opened(h);
    expect(await h.store.advance(jti, 2)).toBe(true);
    await h.pass(1_100);
    const before = (await h.store.read(jti))!;
    expect(await h.store.setPaying(jti, false)).toBe(true);
    const after = (await h.store.read(jti))!;
    expect(after.idleUntilMs).toBeGreaterThan(startedAtMs + SESSION_IDLE_MS);
    expect(after.idleUntilMs).toBeGreaterThan(before.idleUntilMs);
    expect(near(after.idleUntilMs, h.now() + SESSION_IDLE_MS, h.skewMs)).toBe(true);
    expect({ ...after, idleUntilMs: 0 }).toEqual({ ...before, idleUntilMs: 0 });
  });

  test('POL009_Paying 표시는 세션마다 따로다: 한 세션을 Paying으로 해도 다른 세션은 유휴 시한에 끝난다', async () => {
    const h = await make();
    const paying = await opened(h);
    const active = await opened(h);
    expect(await h.store.setPaying(paying.jti, true)).toBe(true);
    await reachIdle(h, paying.jti);
    await reachIdle(h, active.jti);
    expect(await h.store.sweep(paying.jti)).toMatchObject({ kind: 'LIVE' });
    expect(await h.store.sweep(active.jti)).toMatchObject({ kind: 'ENDED', reason: 'IDLE' });
  });
}
