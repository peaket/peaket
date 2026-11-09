// 사전 검증 토큰 발급·갱신과 여정 ID(docs/features/queue-admission.md §2·§3, Q-T60, docs/features/bot-defense.md §11)
import { fakeClock, uuidv7Time } from '@peaket/platform';
import { describe, expect, test } from 'vitest';
import { MemoryEventSchedules } from '../src/modules/entry/adapters/memory-entry-store.js';
import { EntryError } from '../src/modules/entry/application/entry-error.js';
import { IssuePreverification } from '../src/modules/entry/application/issue-preverification.js';
import { PREVERIFY_TTL_MS } from '../src/modules/entry/domain/queue.js';
import { ACCOUNT, DEVICE, newEvent, openSchedule, OTHER_ACCOUNT, PID, recordingRisk, tokens } from './support.js';

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

async function setup(risk = recordingRisk()) {
  const clock = fakeClock({ now: Date.UTC(2026, 10, 3, 1, 0, 0) });
  const schedules = new MemoryEventSchedules();
  const eventId = newEvent();
  await schedules.set(eventId, openSchedule(clock.now(), { lobbyShuffle: false }));
  const issue = new IssuePreverification(schedules, tokens, risk, clock);
  const run = (o: { preverifyToken?: string; deviceId?: string; accountId?: string; eventId?: string } = {}) =>
    issue.run({ accountId: o.accountId ?? ACCOUNT, pid: PID, eventId: o.eventId ?? eventId, body: { deviceId: o.deviceId ?? DEVICE, humanCheckToken: 'turnstile-1', preverifyToken: o.preverifyToken } });
  return { clock, eventId, risk, run };
}

describe('사전 검증', () => {
  test('Q-T60②_처음받으면새UUIDv7여정이고_최초발급시각은지금_만료는15분뒤다', async () => {
    const { clock, eventId, run } = await setup();
    const r = await run();
    const c = tokens.readPreverify(r.preverifyToken)!;
    expect(c).toMatchObject({ e: eventId, a: ACCOUNT, d: DEVICE, i0: clock.now(), iat: clock.now(), exp: clock.now() + PREVERIFY_TTL_MS });
    expect(c.jny).toMatch(UUID_V7);
    expect(uuidv7Time(c.jny)).toBe(clock.now());
    expect(r.expiresAt).toBe(new Date(clock.now() + PREVERIFY_TTL_MS).toISOString());
    expect(r.serverTimeMs).toBe(clock.now());
  });

  test('Q-T60_위험판정에넘긴journey_id는토큰의jny이고_맥락PREVERIFY·회차정렬값을싣는다', async () => {
    const { run, risk, eventId } = await setup();
    const c = tokens.readPreverify((await run()).preverifyToken)!;
    expect(risk.seen).toHaveLength(1);
    expect(risk.seen[0]).toMatchObject({ context: 'PREVERIFY', journeyId: c.jny, eventId, accountId: ACCOUNT, pid: PID, deviceId: DEVICE, lobbyShuffle: false, humanCheckToken: 'turnstile-1' });
  });

  test('[Q-T45] pid키전환기간의위험판정에넘기는pid는_옛pid이고_옛값이없으면새pid다', async () => {
    const risk = recordingRisk();
    const { clock, eventId } = await setup(risk);
    const schedules = new MemoryEventSchedules();
    await schedules.set(eventId, openSchedule(clock.now(), { lobbyShuffle: false }));
    const run = (who: { pid: string; pidPrev?: string }) =>
      new IssuePreverification(schedules, tokens, risk, clock).run({ accountId: ACCOUNT, eventId, body: { deviceId: DEVICE, humanCheckToken: 'turnstile-1' }, ...who });
    await run({ pid: 'pid-new', pidPrev: 'pid-old' });
    await run({ pid: 'pid-new' });
    expect(risk.seen.map((r) => r.pid)).toEqual(['pid-old', 'pid-new']);
  });

  test('Q-T60③_만료전갱신은_최초발급시각과jny를그대로옮긴다', async () => {
    const { clock, run } = await setup();
    const first = tokens.readPreverify((await run()).preverifyToken)!;
    clock.advance(10 * 60_000);
    const renewed = tokens.readPreverify((await run({ preverifyToken: tokens.preverify(first) })).preverifyToken)!;
    expect(renewed.i0).toBe(first.i0);
    expect(renewed.jny).toBe(first.jny);
    expect(renewed.iat).toBe(clock.now());
    expect(renewed.exp).toBe(clock.now() + PREVERIFY_TTL_MS);
  });

  test('Q-T60④_만료뒤다시받으면_새여정이다', async () => {
    const { clock, run } = await setup();
    const first = tokens.readPreverify((await run()).preverifyToken)!;
    clock.advance(PREVERIFY_TTL_MS + 1);
    const again = tokens.readPreverify((await run({ preverifyToken: tokens.preverify(first) })).preverifyToken)!;
    expect(again.jny).not.toBe(first.jny);
    expect(again.i0).toBe(clock.now());
  });

  test('다른계정·회차·기기의토큰으로갱신하면_옮기지않고새여정이다', async () => {
    const { run, clock } = await setup();
    const first = (await run()).preverifyToken;
    const jny = tokens.readPreverify(first)!.jny;
    clock.advance(1);
    for (const o of [{ accountId: OTHER_ACCOUNT }, { deviceId: 'dev-other' }]) {
      expect(tokens.readPreverify((await run({ preverifyToken: first, ...o })).preverifyToken)!.jny).not.toBe(jny);
    }
    const other = newEvent();
    expect(tokens.readPreverify((await run({ preverifyToken: tokens.preverify({ ...tokens.readPreverify(first)!, e: other }) })).preverifyToken)!.jny).not.toBe(jny);
  });

  test('고위험이면_추가검증필요사유를서명해넣는다', async () => {
    const { run } = await setup(recordingRisk({ kind: 'VERIFY', reason: 'DEVICE_HISTORY' }));
    const c = tokens.readPreverify((await run()).preverifyToken)!;
    expect(c.vr).toBe('DEVICE_HISTORY');
    expect(c.hd).toBeUndefined();
  });

  test('위험판정을받지못하면_사람확인보류(hd)를넣고발급한다_축소운영은진입을막지않는다', async () => {
    for (const verdict of [{ kind: 'UNAVAILABLE' as const }, async () => Promise.reject(new Error('down'))]) {
      const { run } = await setup(recordingRisk(verdict as never));
      const c = tokens.readPreverify((await run()).preverifyToken)!;
      expect(c.hd).toBe(true);
      expect(c.vr).toBeUndefined();
    }
  });

  test('회차일정사본이없으면_404NOT_FOUND', async () => {
    const { run } = await setup();
    await expect(run({ eventId: newEvent() })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(run({ eventId: newEvent() })).rejects.toBeInstanceOf(EntryError);
  });
});
