// 도착 시각 쿠키 코덱과 진입(docs/features/queue-admission.md §4 HOT-020 절, §10 '보안 토큰 및 키', ADR-0053 결정 2, ADR-0223 결정 3·5, Q-T29).
import { createHmac } from 'node:crypto';
import { fakeClock } from '@peaket/platform';
import { describe, expect, test } from 'vitest';
import { ARRIVAL_COOKIE_KEY_ENV, ARRIVAL_COOKIE_KEY_PREVIOUS_ENV, HmacArrivalCookies } from '../src/modules/entry/adapters/arrival-cookie.js';
import * as lua from '../src/modules/entry/adapters/entry-lua.js';
import * as domain from '../src/modules/entry/domain/queue.js';
import { MemoryEntryStore, MemoryEventSchedules } from '../src/modules/entry/adapters/memory-entry-store.js';
import type { ArrivalSignals } from '../src/modules/entry/domain/ports.js';
import { EnterQueue } from '../src/modules/entry/application/enter-queue.js';
import { PENDING_TTL_MS } from '../src/modules/entry/domain/queue.js';
import { ACCOUNT, DEVICE, newEvent, newRequest, openSchedule, preverifyToken, tokens } from './support.js';

const KEY = 'K'.repeat(43);
const SID = 'sess-1';
function cookie(o: { key?: string; kid?: string; e: string; t: number; rid?: string; sid?: string; kind?: string }): string {
  const head = `v1.${o.kid ?? 'k1'}.${o.e}.${o.t}.${Buffer.from(o.rid ?? 'req-1==').toString('base64url')}.${o.sid ?? SID}`;
  return `${head}.${createHmac('sha256', o.key ?? KEY).update(`${o.kind ?? 'PEAKET-arrival-v1'}.${head}`).digest('base64url')}`;
}

test('[Q-T16] Lua의칸상수는_domain값과같다(측정도구가Lua파일을그대로읽어가져오지못한다)', () => {
  expect([lua.ARRIVAL_SLOT_MS, lua.ARRIVAL_CLOSE_AFTER_MS, lua.ARRIVAL_FUTURE_MS, lua.ARRIVAL_WINDOW_SLOTS, lua.ARRIVAL_CARVE_MAX]).toEqual([domain.ARRIVAL_SLOT_MS, domain.ARRIVAL_CLOSE_AFTER_MS, domain.ARRIVAL_FUTURE_MS, domain.ARRIVAL_WINDOW_SLOTS, domain.ARRIVAL_CARVE_MAX]);
  // 한 Lua에서 떼는 양은 RB-05가 건너뛰는 양보다 작아야 잃은 칸의 번호가 건너뛴 구간 안에 든다(ADR-0223 결정 6)
  expect(domain.ARRIVAL_CARVE_MAX).toBeLessThan(domain.RB05_SKIP_BASE);
  expect([lua.ARRIVAL_CARVE_WINDOW_MS, lua.ARRIVAL_CARVE_WINDOW_MAX]).toEqual([domain.ARRIVAL_CARVE_WINDOW_MS, domain.ARRIVAL_CARVE_WINDOW_MAX]);
});

test('[Q-T16] 복제지연안에잃는번호의상한이_RB-05건너뛰기안에든다(ADR-0243)', () => {
  // 복제 지연 0.3초는 시간 창 둘에 걸칠 수 있다: 칸 떼기는 창 상한 × 2까지, 일반 진입은 초당 20만 × 0.3초까지다
  expect(domain.ARRIVAL_CARVE_WINDOW_MAX * 2 + (domain.RB05_RATE_MAX_PER_SEC * domain.REPLICATION_LAG_P999_MS) / 1000).toBeLessThanOrEqual(domain.RB05_SKIP_BASE);
  // 창의 몫이 남아 있으면 한 호출의 첫 칸을 뗄 수 있어야 한다
  expect(domain.ARRIVAL_CARVE_MAX).toBeLessThanOrEqual(domain.ARRIVAL_CARVE_WINDOW_MAX);
  expect(domain.ARRIVAL_CARVE_RATE_MAX_PER_SEC).toBe((domain.ARRIVAL_CARVE_WINDOW_MAX * 1000) / domain.ARRIVAL_CARVE_WINDOW_MS);
  expect(domain.RB05_SKIP_BASE).toBe(Math.ceil(((domain.RB05_RATE_MAX_PER_SEC + domain.ARRIVAL_CARVE_RATE_MAX_PER_SEC) * domain.REPLICATION_LAG_P999_MS * 2) / 1000));
});

describe('다시 보내기 분포와 칸 닫기(Q-T16)', () => {
  test('[Q-T16] Degraded3초뒤1분쉬고다시온300칸은_쉰뒤에도칸번호를받는다', async () => {
    const clock = fakeClock({ now: Date.UTC(2026, 10, 9, 3, 0, 0) });
    const store = new MemoryEntryStore(clock);
    const eventId = newEvent();
    const one = async () => (await store.numberBatch({ eventId, expireAtMs: clock.now() + 86_400_000, arrivalInitial: 10, items: [{ arrivalSlot: domain.arrivalSlotOf(clock.now()) }] }))[0];
    for (let i = 0; i < 30; i++) {
      await one();
      clock.advance(domain.ARRIVAL_SLOT_MS);
    }
    clock.advance(60_000);
    const after: string[] = [];
    for (let i = 0; i < 300; i++) {
      const r = await one();
      after.push(r!.kind === 'NUMBERED' ? (r!.arrival ?? '') : r!.kind);
      clock.advance(domain.ARRIVAL_SLOT_MS);
    }
    expect(after.filter((p) => p !== 'slot')).toEqual([]);
  });

  /** 화면과 같은 기다림: Retry-After(0~15초 정수) × (1 + 0~20%), 왕복 0~0.5초 */
  const retryDelayMs = (rnd: () => number) => Math.floor(rnd() * 16) * 1000 * (1 + rnd() * 0.2) + rnd() * 500;

  test('[Q-T16] 칸을닫는시간은_다시보내기최댓값(15초×1.2)에왕복여유를더한값보다길다', () => {
    expect(domain.ARRIVAL_CLOSE_AFTER_MS).toBeGreaterThanOrEqual(15_000 * 1.2 + 500);
  });

  test('[Q-T16] 쿠키받은요청이0~15초흩어져와도_닫힌뒤온비율은1%이하_넘침5%이하_쓰지않은번호절반이하다', async () => {
    let x = 12345;
    const rnd = () => (x = (x * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    const t0 = Date.UTC(2026, 10, 9, 2, 0, 0);
    const clock = fakeClock({ now: t0 });
    const store = new MemoryEntryStore(clock);
    const eventId = newEvent();
    const PER_SLOT = 20;
    const SLOTS = 300;
    const events: { at: number; slot: number }[] = [];
    for (let s = 0; s < SLOTS; s++) {
      const arrival = t0 + s * domain.ARRIVAL_SLOT_MS;
      for (let i = 0; i < PER_SLOT; i++) events.push({ at: arrival + retryDelayMs(rnd), slot: domain.arrivalSlotOf(arrival) });
    }
    events.sort((a, b) => a.at - b.at);
    const count = { slot: 0, late: 0, overflow: 0 };
    for (const e of events) {
      if (e.at > clock.now()) clock.advance(e.at - clock.now());
      const [r] = await store.numberBatch({ eventId, expireAtMs: t0 + 86_400_000, arrivalInitial: Math.ceil(PER_SLOT * 1.5), items: [{ arrivalSlot: e.slot }] });
      if (r!.kind === 'NUMBERED' && r!.arrival) count[r!.arrival]++;
    }
    const total = SLOTS * PER_SLOT;
    expect(count.late / total, `닫힌 뒤 ${count.late}`).toBeLessThanOrEqual(0.01);
    expect(count.overflow / total, `넘침 ${count.overflow}`).toBeLessThanOrEqual(0.05);
    const issued = store.counterOf(eventId);
    expect((issued - total) / issued, `쓰지 않은 번호 ${issued - total}/${issued}`).toBeLessThanOrEqual(0.5);
  });
});

describe('쿠키 읽기', () => {
  const c = new HmacArrivalCookies([{ kid: 'k1', key: KEY }]);

  test('[ASVS v5.0.0-9.1.1] [Q-T29] MAC이맞을때만_칸을돌려주고_틀리면읽지않는다', () => {
    expect(c.read(cookie({ e: 'E', t: 1000 }))).toEqual({ kid: 'k1', e: 'E', t: 1000, rid: 'req-1==', sid: SID });
    expect(c.read(cookie({ e: 'E', t: 1000, key: 'x'.repeat(43) }))).toBeNull();
    expect(c.read(`${cookie({ e: 'E', t: 1000 })}A`)).toBeNull();
    const parts = cookie({ e: 'E', t: 1000 }).split('.');
    parts[3] = '2000';
    expect(c.read(parts.join('.'))).toBeNull();
  });

  test('[ASVS v5.0.0-11.2.4] [Q-T29] 길이가다른MAC은_같은길이로견주기전에거절한다', () => {
    const v = cookie({ e: 'E', t: 1000 });
    expect(c.read(`${v.slice(0, v.lastIndexOf('.') + 1)}AAAA`)).toBeNull();
  });

  test('[ASVS v5.0.0-9.2.2] [Q-T29] 다른종류문자열로만든MAC은_맞지않는다', () => {
    expect(c.read(cookie({ e: 'E', t: 1000, kind: 'PEAKET-queue-v1' }))).toBeNull();
  });

  test('[Q-T29] 형식·판·모르는kid·모양이틀리면_null이다', () => {
    expect(c.read('')).toBeNull();
    expect(c.read('v2.k1.E.1000.cmVx.s.mac')).toBeNull();
    expect(c.read(cookie({ e: 'E', t: 1000, kid: 'k9' }))).toBeNull();
    expect(c.read(cookie({ e: 'E/../x', t: 1000 }))).toBeNull();
    expect(c.read('v1.k1.E.notnum.cmVx.s.mac')).toBeNull();
    expect(c.read('a'.repeat(5000))).toBeNull();
  });

  test('[Q-T29] 옛kid로서명한쿠키도_목록에있으면읽는다', () => {
    const two = new HmacArrivalCookies([{ kid: 'k2', key: 'B'.repeat(43) }, { kid: 'k1', key: KEY }]);
    expect(two.read(cookie({ e: 'E', t: 1000 }))?.kid).toBe('k1');
  });

  test('[Q-T29] 환경값이없으면_개발환경은null이고_운영환경은시작에실패한다', () => {
    expect(HmacArrivalCookies.fromEnv({})).toBeNull();
    expect(HmacArrivalCookies.fromEnv({ PEAKET_ENV: 'local' })).toBeNull();
    expect(HmacArrivalCookies.fromEnv({ PEAKET_ENV: 'ci' })).toBeNull();
    expect(() => HmacArrivalCookies.fromEnv({ PEAKET_ENV: 'staging' })).toThrow(/PEAKET_ARRIVAL_COOKIE_KEY/);
    expect(() => HmacArrivalCookies.fromEnv({ PEAKET_ENV: 'prod' })).toThrow(/PEAKET_ARRIVAL_COOKIE_KEY/);
  });

  test('[Q-T29] 환경값이틀리면_시작에실패한다(값은오류에싣지않는다)', () => {
    const good = HmacArrivalCookies.fromEnv({ [ARRIVAL_COOKIE_KEY_ENV]: `k2:${'B'.repeat(43)}`, [ARRIVAL_COOKIE_KEY_PREVIOUS_ENV]: `k1:${KEY}` });
    expect(good?.read(cookie({ e: 'E', t: 1000 }))?.kid).toBe('k1');
    expect(() => HmacArrivalCookies.fromEnv({ [ARRIVAL_COOKIE_KEY_ENV]: 'k1:short' })).toThrow(/32바이트/);
    let msg = '';
    try {
      HmacArrivalCookies.fromEnv({ [ARRIVAL_COOKIE_KEY_ENV]: 'k1:short-secret-value' });
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).not.toContain('short-secret-value');
  });
});

describe('진입에서 쿠키 받기', () => {
  const setup = async (o: { arrivals?: boolean } = {}) => {
    const clock = fakeClock({ now: Date.UTC(2026, 10, 9, 1, 0, 0) });
    const store = new MemoryEntryStore(clock);
    const schedules = new MemoryEventSchedules();
    const eventId = newEvent();
    await schedules.set(eventId, { ...openSchedule(clock.now()), openBatch: false, lobbyShuffle: false });
    const signals = { cookie: [] as string[], number: [] as string[] };
    const sink: ArrivalSignals = { cookie: (r) => signals.cookie.push(r), number: (p) => signals.number.push(p) };
    const enter = new EnterQueue(store, schedules, tokens, clock, { pendingTtlMs: PENDING_TTL_MS, batchWindowMs: 0, arrivalSlotInitial: 10 }, undefined, o.arrivals === false ? undefined : new HmacArrivalCookies([{ kid: 'k1', key: KEY }]), sink);
    let n = 0;
    const go = (c: string | undefined, _unused?: string, pid = `pid-cookie-${n++}-${eventId}`.slice(0, 64), entryRequestId = newRequest(), arrivalUnsigned = false) =>
      enter.run({ accountId: ACCOUNT, pid, sessionId: SID, eventId, body: { preverifyToken: preverifyToken(clock, eventId), deviceId: DEVICE, entryRequestId }, ...(c ? { arrivalCookie: c } : {}), ...(arrivalUnsigned ? { arrivalUnsigned } : {}) });
    return { clock, store, eventId, go, signals };
  };

  test('[Q-T29] 정상쿠키는_도착시각칸의번호를받고_같은칸은처리한순서로붙는다', async () => {
    const { clock, eventId, go, signals } = await setup();
    const t = clock.now();
    const a = await go(cookie({ e: eventId, t, rid: 'a' }));
    const b = await go(cookie({ e: eventId, t: t + 50, rid: 'b' }));
    expect(a).toMatchObject({ kind: 'TICKET', seq: 1 });
    expect(b).toMatchObject({ kind: 'TICKET', seq: 2 });
    expect(signals.cookie).toEqual(['ok', 'ok']);
    expect(signals.number).toEqual(['slot', 'slot']);
  });

  test('[ASVS v5.0.0-9.2.1] [Q-T29] 시각이10분지났거나_5초넘게앞선쿠키는_무시하고일반진입이다', async () => {
    const { clock, eventId, go, signals } = await setup();
    const t = clock.now();
    await go(cookie({ e: eventId, t: t - 600_001, rid: 'old' }));
    await go(cookie({ e: eventId, t: t + 5_001, rid: 'future' }));
    expect(signals.cookie).toEqual(['invalid', 'invalid']);
    expect(signals.number).toEqual([]);
  });

  test('[Q-T29] 다른sid·다른회차의쿠키는_무시하고일반진입이다', async () => {
    const { clock, eventId, go, signals } = await setup();
    const t = clock.now();
    await go(cookie({ e: eventId, t, rid: 'x', sid: 'other' }));
    await go(cookie({ e: 'other-event', t, rid: 'y' }));
    await go('v1.junk');
    expect(signals.cookie).toEqual(['invalid', 'invalid', 'invalid']);
  });

  test('[Q-T29] 다른진입요청이_이미쓴요청ID의쿠키를쓰면_무시하고일반진입이다', async () => {
    const { clock, eventId, go, signals } = await setup();
    const c = cookie({ e: eventId, t: clock.now(), rid: 'same' });
    const a = await go(c);
    const b = await go(c);
    expect(a).toMatchObject({ seq: 1 });
    // 뒤 사람은 칸이 아니라 카운터 끝이다: 칸 크기 10을 떼었으므로 11번이다
    expect(b).toMatchObject({ seq: 11 });
    expect(signals.cookie).toEqual(['ok', 'reused']);
  });

  test('[Q-T29] 같은진입요청의다시보내기는_응답을잃기전이면쿠키를다시받아_같은칸으로간다', async () => {
    const { clock, eventId, go } = await setup();
    const c = cookie({ e: eventId, t: clock.now(), rid: 'retry' });
    const requestId = newRequest();
    const pid = `pid-retry-${eventId}`.slice(0, 64);
    const first = await go(c, undefined, pid, requestId);
    const again = await go(c, undefined, pid, requestId);
    expect(again).toMatchObject({ kind: 'TICKET', seq: (first as { seq: number }).seq });
  });

  test('[Q-T29] 쿠키요청ID를잡지못하면_맨뒤번호로넘기지않고_503으로다시오게하고_지표를센다', async () => {
    const { clock, store, eventId, go, signals } = await setup();
    const c = cookie({ e: eventId, t: clock.now(), rid: 'down' });
    const requestId = newRequest();
    const pid = `pid-down-${eventId}`.slice(0, 64);
    const real = store.claimArrival.bind(store);
    store.claimArrival = () => Promise.reject(new domain.QueueStoreUnavailable(new Error('down')));
    await expect(go(c, undefined, pid, requestId)).rejects.toBeInstanceOf(domain.QueueStoreUnavailable);
    expect(signals.cookie).toEqual(['unavailable']);
    expect(signals.number).toEqual([]);
    store.claimArrival = real;
    expect(await go(c, undefined, pid, requestId)).toMatchObject({ kind: 'TICKET', seq: 1 });
    expect(signals.number).toEqual(['slot']);
  });

  test('[Q-T16] 엣지가서명없이보낸진입은_쿠키없음으로센다', async () => {
    const { clock, eventId, go, signals } = await setup();
    await go(undefined, undefined, undefined, undefined, true);
    expect(signals.cookie).toEqual(['absent']);
    await go(cookie({ e: eventId, t: clock.now(), rid: 'z' }), undefined, undefined, undefined, true);
    expect(signals.cookie).toEqual(['absent', 'ok']);
  });

  test('[Q-T29] 코덱이없거나_쿠키를주지않으면_일반진입이다', async () => {
    const a = await setup({ arrivals: false });
    expect(await a.go(cookie({ e: a.eventId, t: a.clock.now() }))).toMatchObject({ kind: 'TICKET', seq: 1 });
    expect(a.signals.cookie).toEqual([]);
    const b = await setup();
    expect(await b.go(undefined)).toMatchObject({ kind: 'TICKET', seq: 1 });
    expect(b.signals.cookie).toEqual([]);
  });
});
