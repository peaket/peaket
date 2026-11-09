// 최초 방문 쿠키(docs/features/queue-admission.md §7·§10, docs/features/bot-defense.md §4.8, ADR-0065 결정 9, ADR-0249 결정 2, Q-T39).
// queue-svc는 서명을 확인한 발급 시각만 위험 판정에 넘긴다. 맞지 않으면 쿠키가 없는 것으로 본다.
import { createHmac } from 'node:crypto';
import { fakeClock } from '@peaket/platform';
import { describe, expect, test } from 'vitest';
import { FIRST_VISIT_COOKIE_KEYS_ENV, HmacFirstVisitCookies } from '../src/modules/entry/adapters/first-visit-cookie.js';
import { firstVisitAtMs } from '../src/modules/entry/application/first-visit.js';
import { IssuePreverification } from '../src/modules/entry/application/issue-preverification.js';
import { MemoryEventSchedules } from '../src/modules/entry/adapters/memory-entry-store.js';
import type { FirstVisitResult } from '../src/modules/entry/domain/ports.js';
import { FIRST_VISIT_FUTURE_MS, FIRST_VISIT_MAX_AGE_MS } from '../src/modules/entry/domain/queue.js';
import { ACCOUNT, DEVICE, newEvent, openSchedule, PID, recordingRisk, tokens } from './support.js';

const KEY = 'F'.repeat(43);
const OLD_KEY = 'E'.repeat(43);
const NOW = Date.UTC(2026, 10, 9, 3, 0, 0);
const DAY = 86_400_000;

function cookie(o: { key?: string; kid?: string; t?: number; rid?: string; kind?: string } = {}): string {
  const head = `v1.${o.kid ?? 'k1'}.${o.t ?? NOW - DAY}.${Buffer.from(o.rid ?? 'REQ==').toString('base64url')}`;
  return `${head}.${createHmac('sha256', o.key ?? KEY).update(`${o.kind ?? 'PEAKET-firstvisit-v1'}.${head}`).digest('base64url')}`;
}
const warnNone = () => {
  throw new Error('경고가 없어야 한다');
};
const cookies = () =>
  new HmacFirstVisitCookies([
    { kid: 'k1', key: KEY },
    { kid: 'k0', key: OLD_KEY },
  ]);

describe('HmacFirstVisitCookies(Q-T39 ③)', () => {
  test('[Q-T39] [ASVS v5.0.0-3.3.4] [ASVS v5.0.0-9.1.1] 맞는서명이면_kid와발급시각을돌려준다', () => {
    expect(cookies().read(cookie())).toEqual({ kid: 'k1', issuedAtMs: NOW - DAY });
  });

  test('[Q-T39] 서명키를교체한뒤에도_옛kid로서명한쿠키를받는다', () => {
    expect(cookies().read(cookie({ kid: 'k0', key: OLD_KEY }))).toEqual({ kid: 'k0', issuedAtMs: NOW - DAY });
  });

  test('[Q-T39] [ASVS v5.0.0-9.1.1] 발급시각을바꾸거나_모르는kid이거나_다른종류의MAC이면_없는것으로본다', () => {
    const v = cookie().split('.');
    expect(cookies().read([v[0], v[1], String(NOW - 300 * DAY), v[3], v[4]].join('.'))).toBeNull();
    expect(cookies().read(cookie({ kid: 'k9', key: 'Z'.repeat(43) }))).toBeNull();
    expect(cookies().read(cookie({ kind: 'PEAKET-arrival-v1' }))).toBeNull();
    expect(cookies().read(cookie({ key: 'B'.repeat(43) }))).toBeNull();
  });

  test.each([['', ''], ['형식 아님', 'garbage'], ['칸 수', 'v1.k1.1.a'], ['판 번호', 'v2.k1.1.a.b'], ['시각이 숫자가 아님', 'v1.k1.abc.a.b'], ['너무 김', 'v1.k1.1.a.' + 'b'.repeat(2000)]])('[Q-T39] 모양이틀리면_없는것으로본다: %s', (_n, v) => {
    expect(cookies().read(v)).toBeNull();
  });

  test('[Q-T39] 같은바이트로읽히는다른글자(끝글자의쓰지않는비트)는_받지않는다', () => {
    const v = cookie();
    const last = v.slice(-1);
    const other = last === 'A' ? 'B' : 'A';
    expect(cookies().read(v.slice(0, -1) + other)).toBeNull();
  });

  test('[ASVS v5.0.0-13.3.1] 환경값에서여러kid를읽고_없으면_어느환경이든시작을막지않고경고한다', () => {
    const env = { [FIRST_VISIT_COOKIE_KEYS_ENV]: `k1:${KEY}, k0:${OLD_KEY}` };
    const c = HmacFirstVisitCookies.fromEnv(env, warnNone)!;
    expect(c.read(cookie())?.kid).toBe('k1');
    expect(c.read(cookie({ kid: 'k0', key: OLD_KEY }))?.kid).toBe('k0');
    for (const PEAKET_ENV of ['ci', 'staging', 'prod']) {
      const seen: string[] = [];
      expect(HmacFirstVisitCookies.fromEnv({ PEAKET_ENV }, (m) => seen.push(m))).toBeNull();
      expect(seen.join(' ')).toContain(FIRST_VISIT_COOKIE_KEYS_ENV);
    }
  });

  test('[ASVS v5.0.0-13.3.1] 틀린키는_기능을끄고_경고문구에값을싣지않는다', () => {
    const cases = ['k1:short', `${'x'.repeat(40)}:${KEY}`, Array.from({ length: 7 }, (_, i) => `k${i}:${KEY}`).join(',')];
    for (const v of cases) {
      const seen: string[] = [];
      expect(HmacFirstVisitCookies.fromEnv({ PEAKET_ENV: 'prod', [FIRST_VISIT_COOKIE_KEYS_ENV]: v }, (m) => seen.push(m))).toBeNull();
      expect(seen).toHaveLength(1);
      expect(seen[0]).not.toContain('short');
      expect(seen[0]).not.toContain(KEY);
    }
  });
});

describe('firstVisitAtMs(Q-T39 ②·③)', () => {
  const run = (value: string | undefined, c: HmacFirstVisitCookies | undefined = cookies()) => {
    const seen: FirstVisitResult[] = [];
    return { at: firstVisitAtMs(c, value, NOW, { cookie: (r) => seen.push(r) }), seen };
  };

  test('[Q-T39] 쿠키가없으면_신호도없다', () => {
    expect(run(undefined)).toEqual({ at: undefined, seen: ['absent'] });
  });

  test('[Q-T39] 맞는쿠키는_발급시각을넘긴다', () => {
    expect(run(cookie())).toEqual({ at: NOW - DAY, seen: ['ok'] });
  });

  test('[Q-T39] 틀린쿠키는_없는것으로세고_다른진입은그대로다', () => {
    expect(run('garbage')).toEqual({ at: undefined, seen: ['invalid'] });
  });

  test('[Q-T39] 지금보다5초넘게앞서거나_1년1일보다오래되면_없는것으로본다', () => {
    expect(run(cookie({ t: NOW + FIRST_VISIT_FUTURE_MS }))).toEqual({ at: NOW + FIRST_VISIT_FUTURE_MS, seen: ['ok'] });
    expect(run(cookie({ t: NOW + FIRST_VISIT_FUTURE_MS + 1 }))).toEqual({ at: undefined, seen: ['stale'] });
    expect(run(cookie({ t: NOW - FIRST_VISIT_MAX_AGE_MS }))).toEqual({ at: NOW - FIRST_VISIT_MAX_AGE_MS, seen: ['ok'] });
    expect(run(cookie({ t: NOW - FIRST_VISIT_MAX_AGE_MS - 1 }))).toEqual({ at: undefined, seen: ['stale'] });
  });

  test('키가없으면_기능을끄고_disabled로센다(지표로드러난다)', () => {
    const seen: FirstVisitResult[] = [];
    expect(firstVisitAtMs(undefined, cookie(), NOW, { cookie: (r) => seen.push(r) })).toBeUndefined();
    expect(seen).toEqual(['disabled']);
  });
});

describe('사전 검증 판정 입력(Q-T39 ②)', () => {
  const issue = (firstVisit?: HmacFirstVisitCookies) => {
    const risk = recordingRisk({ kind: 'OK' });
    const clock = fakeClock({ now: NOW });
    const schedules = new MemoryEventSchedules();
    const seen: FirstVisitResult[] = [];
    const app = new IssuePreverification(schedules, tokens, risk, clock, undefined, firstVisit, { cookie: (r) => seen.push(r) });
    return { risk, schedules, seen, app, clock };
  };

  test('[Q-T39] 맞는쿠키는_쿠키나이신호로넘어가고_토큰은그대로나온다', async () => {
    const w = issue(cookies());
    const eventId = newEvent();
    await w.schedules.set(eventId, openSchedule(NOW));
    const r = await w.app.run({ accountId: ACCOUNT, pid: PID, eventId, body: { deviceId: DEVICE, humanCheckToken: 't' }, firstVisitCookie: cookie() });
    expect(r.preverifyToken.length).toBeGreaterThan(0);
    expect(w.risk.seen[0]!.firstVisitAtMs).toBe(NOW - DAY);
    expect(w.seen).toEqual(['ok']);
  });

  test('[Q-T39] 쿠키가없거나틀려도_판정을막지않고_쿠키나이는비운다', async () => {
    const w = issue(cookies());
    const eventId = newEvent();
    await w.schedules.set(eventId, openSchedule(NOW));
    await w.app.run({ accountId: ACCOUNT, pid: PID, eventId, body: { deviceId: DEVICE } });
    await w.app.run({ accountId: ACCOUNT, pid: PID, eventId, body: { deviceId: DEVICE }, firstVisitCookie: 'garbage' });
    expect(w.risk.seen.map((s) => s.firstVisitAtMs)).toEqual([undefined, undefined]);
    expect(w.seen).toEqual(['absent', 'invalid']);
  });
});
