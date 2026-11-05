// 팬의 로그인한 기기와 다른 세션 끝내기(docs/features/identity.md §8 '로그인한 기기와 다른 세션 끝내기의 첫 구현', BUILD_ORDER BOT-044, ADR-0209,
// I-T74·I-T75·I-T76, FR-017, POL-019). 메모리 저장소로 본다. PostgreSQL은 test-int/device-sessions.int.test.ts.
import { CONTROL_TOPICS } from '@peaket/platform';
import { describe, expect, test } from 'vitest';
import { JoseReauthVerifier } from '../src/modules/session/adapters/jose-reauth-verifier.js';
import { MemoryLinkProposals } from '../src/modules/session/adapters/memory-link-proposals.js';
import { MemoryMergeProposals } from '../src/modules/session/adapters/memory-merge-proposals.js';
import { MemorySessionStore } from '../src/modules/session/adapters/memory-session-store.js';
import { AccountError } from '../src/modules/session/application/account-error.js';
import { AddProvider } from '../src/modules/session/application/add-provider.js';
import { ConfirmMerge } from '../src/modules/session/application/confirm-merge.js';
import { EndDeviceSession } from '../src/modules/session/application/end-device-session.js';
import { ListSessions } from '../src/modules/session/application/list-sessions.js';
import { MergePlanner } from '../src/modules/session/application/plan-merge.js';
import { UnlinkProvider } from '../src/modules/session/application/unlink-provider.js';
import { deviceLabelOf } from '../src/modules/session/application/device-label.js';
import { SESSION_ABSOLUTE_MS, SESSION_IDLE_MS } from '../src/modules/session/domain/session.js';
import { ISSUER, kit, newKey } from './support.js';

/** 합성 User-Agent(실제 사람의 값이 아니다. 브라우저들이 내는 꼴만 따랐다) */
export const UA = {
  chromeWindows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  safariIphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1',
  safariIpad: 'Mozilla/5.0 (iPad; CPU OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1',
  safariMac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15',
  chromeIphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0.7390.41 Mobile/15E148 Safari/604.1',
  firefoxIphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/143.0 Mobile/15E148 Safari/605.1.15',
  samsungAndroid: 'Mozilla/5.0 (Linux; Android 15; SM-S928N) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/28.0 Chrome/130.0.0.0 Mobile Safari/537.36',
  chromeAndroid: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36',
  edgeWindows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.3537.57',
  whaleWindows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Whale/4.33.325.17 Safari/537.36',
  operaWindows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 OPR/124.0.0.0',
  firefoxMac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 15.6; rv:143.0) Gecko/20100101 Firefox/143.0',
  firefoxLinux: 'Mozilla/5.0 (X11; Linux x86_64; rv:143.0) Gecko/20100101 Firefox/143.0',
  chromeOs: 'Mozilla/5.0 (X11; CrOS x86_64 16181.61.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  kakaotalkIphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 KAKAOTALK 25.8.0',
  naverAppAndroid: 'Mozilla/5.0 (Linux; Android 15; SM-S928N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36 NAVER(inapp; search; 2000; 12.10.4)',
} as const;

async function setup() {
  const sessions = new MemorySessionStore();
  const k0 = await kit(sessions);
  const links = new MemoryLinkProposals(k0.clock);
  const k = await kit(sessions, { clock: k0.clock, links });
  const reauth = new JoseReauthVerifier(k.keys, ISSUER, k.clock);
  const proposals = new MemoryMergeProposals(k.clock);
  /** 본인확인을 마친 계정(병합의 대표 계정 고르기, merge.test.ts와 같은 대역) */
  const verified = new Set<string>();
  const planner = new MergePlanner(sessions, { pidsOf: async (id) => (verified.has(id) ? ['pid'] : []) }, [], proposals, k.clock, undefined, k.signals);
  const login = (o: { provider?: 'kakao' | 'naver' | 'google'; sub: string; deviceId?: string | null; userAgent?: string; email?: string | null }) =>
    k.create.run({ idempotencyKey: newKey(), provider: o.provider ?? 'kakao', providerUserId: o.sub, email: o.email ?? null, emailVerified: o.email != null, deviceId: o.deviceId === undefined ? 'dev-a' : o.deviceId, userAgent: o.userAgent });
  const token = async (s: { accountId: string; sessionId: string }) =>
    (await k.signer.reauth({ accountId: s.accountId, sessionId: s.sessionId, provider: 'kakao', strength: 'verified', purpose: 'sensitive' }, k.clock.now())).token;
  return {
    sessions,
    k,
    links,
    verified,
    login,
    token,
    clock: k.clock,
    list: new ListSessions(sessions, k.clock),
    end: new EndDeviceSession(sessions, reauth, k.clock, k.signals),
    add: new AddProvider(sessions, reauth, k.clock, planner, k.signals),
    unlink: new UnlinkProvider(sessions, reauth, k.clock, k.signals),
    confirm: new ConfirmMerge(sessions, reauth, planner, proposals, k.clock, k.signals),
  };
}

const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'OK';
  } catch (e) {
    if (e instanceof AccountError) return e.code;
    throw e;
  }
};
const alive = (t: { sessions: MemorySessionStore }, id: string) => t.sessions.peekSession(id)?.terminatedAt === null;
/** 그 계정의 Outbox(적힌 차례대로): 세션 종료 사건은 [topic, sessionId, reason], 그 밖은 [topic] */
const outboxOf = (t: { sessions: MemorySessionStore }, accountId: string) =>
  t.sessions
    .outboxMessages()
    .filter((m) => m.key === accountId)
    .map((m) => {
      const v = JSON.parse(Buffer.from(m.payload).toString('utf8')) as { sessionId?: string; reason?: string };
      return m.topic === CONTROL_TOPICS.sessionsTerminated ? [m.topic, v.sessionId, v.reason] : [m.topic];
    });

describe('화면용 기기 이름(I-T76)', () => {
  test("I-T76_User-Agent에서정해진낱말의'브라우저 · 운영체제'만뽑는다", () => {
    expect(deviceLabelOf(UA.chromeWindows)).toBe('Chrome · Windows');
    expect(deviceLabelOf(UA.safariIphone)).toBe('Safari · iPhone');
    expect(deviceLabelOf(UA.safariIpad)).toBe('Safari · iPad');
    expect(deviceLabelOf(UA.safariMac)).toBe('Safari · macOS');
    expect(deviceLabelOf(UA.chromeIphone)).toBe('Chrome · iPhone');
    expect(deviceLabelOf(UA.firefoxIphone)).toBe('Firefox · iPhone');
    expect(deviceLabelOf(UA.samsungAndroid)).toBe('Samsung Internet · Android');
    expect(deviceLabelOf(UA.chromeAndroid)).toBe('Chrome · Android');
    expect(deviceLabelOf(UA.edgeWindows)).toBe('Edge · Windows');
    expect(deviceLabelOf(UA.whaleWindows)).toBe('Whale · Windows');
    expect(deviceLabelOf(UA.operaWindows)).toBe('Opera · Windows');
    expect(deviceLabelOf(UA.firefoxMac)).toBe('Firefox · macOS');
    expect(deviceLabelOf(UA.firefoxLinux)).toBe('Firefox · Linux');
    expect(deviceLabelOf(UA.chromeOs)).toBe('Chrome · ChromeOS');
    expect(deviceLabelOf(UA.kakaotalkIphone)).toBe('카카오톡 · iPhone');
    expect(deviceLabelOf(UA.naverAppAndroid)).toBe('네이버 앱 · Android');
  });

  test('I-T76_모르면null이고_하나만알면그것만이며_원문글자는하나도옮기지않는다', () => {
    expect(deviceLabelOf('')).toBeNull();
    expect(deviceLabelOf(undefined)).toBeNull();
    expect(deviceLabelOf(null)).toBeNull();
    expect(deviceLabelOf('curl/8.9.1')).toBeNull();
    expect(deviceLabelOf('Mozilla/5.0 (Windows NT 10.0) SomethingNew/1.0')).toBe('Windows');
    expect(deviceLabelOf('<img src=x onerror=alert(1)> Firefox/1.0')).toBe('Firefox');
    // 아주 긴 값도 앞 512자만 본다(앱 서버도 512자에서 자른다)
    expect(deviceLabelOf(`${'x'.repeat(600)} Chrome/141.0 (Windows NT 10.0)`)).toBeNull();
    expect(deviceLabelOf(`Mozilla/5.0 (Windows NT 10.0) Chrome/141.0 ${'x'.repeat(5000)}`)).toBe('Chrome · Windows');
    // 낱말 목록 밖의 글자(판 번호·모델명)는 나오지 않는다
    for (const ua of Object.values(UA)) expect(deviceLabelOf(ua)).toMatch(/^[A-Za-z가-힣 ]+( · [A-Za-z]+)?$/);
  });

  test('I-T76_로그인때기기이름만세션에두고_User-Agent원문은저장하지않는다', async () => {
    const t = await setup();
    const s = await t.login({ sub: 'k-ua', userAgent: UA.samsungAndroid });
    expect(t.sessions.peekSession(s.sessionId)).toMatchObject({ deviceLabel: 'Samsung Internet · Android', lastActiveAt: t.clock.now() });
    expect(JSON.stringify(t.sessions.peekSession(s.sessionId))).not.toContain('SM-S928N');
    expect(JSON.stringify(t.sessions.peekSession(s.sessionId))).not.toContain('28.0');
  });

  test('I-T76_세션이끝나면기기이름을지우고_유휴만료로끝난세션은절대만료뒤정비가지운다', async () => {
    const t = await setup();
    const a = await t.login({ sub: 'k-label', deviceId: 'dev-1', userAgent: UA.chromeWindows });
    await t.k.end.run({ sessionId: a.sessionId, accountId: a.accountId });
    expect(t.sessions.peekSession(a.sessionId)).toMatchObject({ deviceLabel: null });
    const b = await t.login({ sub: 'k-label', deviceId: 'dev-2', userAgent: UA.safariIphone });
    // 유휴 만료(14일)가 지나도 절대 만료 전에는 정비가 그대로 둔다
    t.clock.advance(SESSION_IDLE_MS + 1);
    expect(await t.sessions.clearEndedDeviceLabels(t.clock.now())).toBe(0);
    expect(t.sessions.peekSession(b.sessionId)).toMatchObject({ deviceLabel: 'Safari · iPhone' });
    t.clock.advance(SESSION_ABSOLUTE_MS - SESSION_IDLE_MS);
    expect(await t.sessions.clearEndedDeviceLabels(t.clock.now())).toBe(1);
    expect(t.sessions.peekSession(b.sessionId)).toMatchObject({ deviceLabel: null });
  });
});

describe('로그인한 기기 목록(I-T74)', () => {
  test('I-T74_살아있는세션을기기마다한줄로주고_지금이기기가맨앞이며_나머지는마지막활동이늦은순이다 [ASVS v5.0.0-7.5.2] [ASVS v5.0.0-7.1.2]', async () => {
    const t = await setup();
    const old = await t.login({ sub: 'k-list', deviceId: 'dev-phone', userAgent: UA.safariIphone });
    t.clock.advance(60_000);
    const tablet = await t.login({ sub: 'k-list', deviceId: null, userAgent: UA.safariIpad });
    t.clock.advance(60_000);
    // 같은 기기로 다시 로그인한 세션은 같은 줄이다(마지막 활동은 늦은 쪽)
    const phone2 = await t.login({ sub: 'k-list', deviceId: 'dev-phone', userAgent: UA.safariIphone });
    t.clock.advance(60_000);
    const me = await t.login({ sub: 'k-list', deviceId: 'dev-pc', userAgent: UA.chromeWindows });
    const rows = await t.list.run({ accountId: me.accountId, sessionId: me.sessionId });
    expect(rows).toEqual([
      { sessionId: me.sessionId, deviceName: 'Chrome · Windows', lastActiveAt: new Date(t.clock.now()).toISOString(), current: true, otherSessions: 0 },
      { sessionId: phone2.sessionId, deviceName: 'Safari · iPhone', lastActiveAt: new Date(t.clock.now() - 60_000).toISOString(), current: false, otherSessions: 1 },
      { sessionId: tablet.sessionId, deviceName: 'Safari · iPad', lastActiveAt: new Date(t.clock.now() - 120_000).toISOString(), current: false, otherSessions: 0 },
    ]);
    expect(alive(t, old.sessionId)).toBe(true);
    // 기기 가명·User-Agent 원문은 싣지 않는다
    expect(JSON.stringify(rows)).not.toMatch(/k1\.|Mozilla/);
  });

  test('I-T74_마지막활동은로그인과토큰갱신(회전)때적는다', async () => {
    const t = await setup();
    const a = await t.login({ sub: 'k-active', userAgent: UA.chromeWindows });
    t.clock.advance(5 * 60_000);
    const r = await t.k.refresh.run({ refreshToken: a.refreshToken });
    expect(r.result).toBe('OK');
    expect(t.sessions.peekSession(a.sessionId)).toMatchObject({ lastActiveAt: t.clock.now() });
    expect((await t.list.run({ accountId: a.accountId, sessionId: a.sessionId }))[0]).toMatchObject({ lastActiveAt: new Date(t.clock.now()).toISOString() });
  });

  test('I-T74_⑥_끝난세션으로목록을부르면SESSION_ENDED다 [ASVS v5.0.0-7.4.1]', async () => {
    const t = await setup();
    const a = await t.login({ sub: 'k-ended' });
    await t.k.end.run({ sessionId: a.sessionId, accountId: a.accountId });
    expect(await code(t.list.run({ accountId: a.accountId, sessionId: a.sessionId }))).toBe('SESSION_ENDED');
  });
});

describe('다른 기기 로그아웃(I-T74)', () => {
  test('I-T74_②_다른기기의줄을재인증토큰으로끄면그기기의세션이모두끝나고_세션마다LOGOUT사건을적는다 [ASVS v5.0.0-7.5.2] [ASVS v5.0.0-7.4.1]', async () => {
    const t = await setup();
    const p1 = await t.login({ sub: 'k-off', deviceId: 'dev-phone', userAgent: UA.safariIphone });
    const p2 = await t.login({ sub: 'k-off', deviceId: 'dev-phone', userAgent: UA.safariIphone });
    const me = await t.login({ sub: 'k-off', deviceId: 'dev-pc', userAgent: UA.chromeWindows });
    expect(await t.end.run({ accountId: me.accountId, sessionId: me.sessionId, reauthToken: await t.token(me), targetSessionId: p2.sessionId })).toEqual({ ended: 2 });
    expect([alive(t, p1.sessionId), alive(t, p2.sessionId), alive(t, me.sessionId)]).toEqual([false, false, true]);
    expect(t.sessions.terminations(me.accountId).sort()).toEqual([
      [p1.sessionId, 'LOGOUT'],
      [p2.sessionId, 'LOGOUT'],
    ].sort());
    expect(outboxOf(t, me.accountId).filter((m) => m[0] === CONTROL_TOPICS.sessionsTerminated)).toHaveLength(2);
    expect(t.sessions.refreshHashCount(me.accountId)).toBe(1);
    expect(t.k.signals.seen).toContain('others-ended:remote_logout:2');
    expect((await t.list.run({ accountId: me.accountId, sessionId: me.sessionId })).map((r) => r.sessionId)).toEqual([me.sessionId]);
    // 끈 기기의 리프레시 토큰은 더 쓰지 못한다
    expect((await t.k.refresh.run({ refreshToken: p1.refreshToken })).result).toBe('INVALID');
  });

  test('I-T74_③_재인증토큰이없거나·다른세션의것이거나·한번쓴것이면REAUTH_REQUIRED다', async () => {
    const t = await setup();
    const other = await t.login({ sub: 'k-ra', deviceId: 'dev-2' });
    const third = await t.login({ sub: 'k-ra', deviceId: 'dev-3' });
    const me = await t.login({ sub: 'k-ra', deviceId: 'dev-1' });
    const run = (reauthToken: string, targetSessionId: string) => t.end.run({ accountId: me.accountId, sessionId: me.sessionId, reauthToken, targetSessionId });
    expect(await code(run('', other.sessionId))).toBe('REAUTH_REQUIRED');
    expect(await code(run(await t.token(other), other.sessionId))).toBe('REAUTH_REQUIRED');
    const once = await t.token(me);
    expect(await code(run(once, other.sessionId))).toBe('OK');
    expect(await code(run(once, third.sessionId))).toBe('REAUTH_REQUIRED');
    expect(alive(t, third.sessionId)).toBe(true);
  });

  test('I-T74_④_다른계정의세션·끝난세션·없는ID는같은SESSION_NOT_FOUND이고_아무것도끝내지않으며재인증토큰을쓰지않는다 [ASVS v5.0.0-8.2.2]', async () => {
    const t = await setup();
    const stranger = await t.login({ sub: 'k-stranger', deviceId: 'dev-s' });
    const gone = await t.login({ sub: 'k-404', deviceId: 'dev-g' });
    await t.k.end.run({ sessionId: gone.sessionId, accountId: gone.accountId });
    const other = await t.login({ sub: 'k-404', deviceId: 'dev-o' });
    const me = await t.login({ sub: 'k-404', deviceId: 'dev-m' });
    const tok = await t.token(me);
    for (const target of [stranger.sessionId, gone.sessionId, '0190f3a1-7c2e-7a00-8000-0000000000ff', 'not-a-uuid']) {
      expect(await code(t.end.run({ accountId: me.accountId, sessionId: me.sessionId, reauthToken: tok, targetSessionId: target })), target).toBe('SESSION_NOT_FOUND');
    }
    expect(alive(t, stranger.sessionId)).toBe(true);
    expect(t.sessions.terminations(stranger.accountId)).toEqual([]);
    // 되돌렸으므로 같은 토큰으로 다른 기기를 끌 수 있다
    expect(await t.end.run({ accountId: me.accountId, sessionId: me.sessionId, reauthToken: tok, targetSessionId: other.sessionId })).toEqual({ ended: 1 });
  });

  test('I-T74_⑤_지금기기줄은같은기기의다른로그인수를보이고_끄면지금세션만남기고그기기의다른세션을모두끝낸다(새맥락리뷰중간1) [ASVS v5.0.0-7.5.2]', async () => {
    const t = await setup();
    // 같은 브라우저 저장소의 기기 값으로 두 번 로그인했다(앞 세션이 지금 기기 줄에 숨는 경우)
    const old = await t.login({ sub: 'k-cur', deviceId: 'dev-same' });
    const older = await t.login({ sub: 'k-cur', deviceId: 'dev-same' });
    const other = await t.login({ sub: 'k-cur', deviceId: 'dev-other' });
    const me = await t.login({ sub: 'k-cur', deviceId: 'dev-same' });
    const rows = await t.list.run({ accountId: me.accountId, sessionId: me.sessionId });
    expect(rows.map((r) => [r.sessionId, r.current, r.otherSessions])).toEqual([
      [me.sessionId, true, 2],
      [other.sessionId, false, 0],
    ]);
    expect(await t.end.run({ accountId: me.accountId, sessionId: me.sessionId, reauthToken: await t.token(me), targetSessionId: me.sessionId })).toEqual({ ended: 2 });
    expect([alive(t, old.sessionId), alive(t, older.sessionId), alive(t, me.sessionId), alive(t, other.sessionId)]).toEqual([false, false, true, true]);
    expect(t.sessions.terminations(me.accountId).map(([, why]) => why)).toEqual(['LOGOUT', 'LOGOUT']);
    expect((await t.list.run({ accountId: me.accountId, sessionId: me.sessionId }))[0]).toMatchObject({ sessionId: me.sessionId, current: true, otherSessions: 0 });
    // 끝낼 다른 로그인이 없으면 같은 404이고 재인증 토큰을 쓰지 않는다
    const tok = await t.token(me);
    expect(await code(t.end.run({ accountId: me.accountId, sessionId: me.sessionId, reauthToken: tok, targetSessionId: me.sessionId }))).toBe('SESSION_NOT_FOUND');
    expect(await t.end.run({ accountId: me.accountId, sessionId: me.sessionId, reauthToken: tok, targetSessionId: other.sessionId })).toEqual({ ended: 1 });
  });

  test('I-T74_⑤_같은기기의다른세션ID로끄더라도지금세션은끝내지않는다(새맥락리뷰중간1)', async () => {
    const t = await setup();
    const sibling = await t.login({ sub: 'k-sib', deviceId: 'dev-same' });
    const me = await t.login({ sub: 'k-sib', deviceId: 'dev-same' });
    expect(await t.end.run({ accountId: me.accountId, sessionId: me.sessionId, reauthToken: await t.token(me), targetSessionId: sibling.sessionId })).toEqual({ ended: 1 });
    expect([alive(t, sibling.sessionId), alive(t, me.sessionId)]).toEqual([false, true]);
  });

  test('I-T74_부른세션이끝났으면REAUTH_REQUIRED다(다른기기에서먼저끈세션의토큰)', async () => {
    const t = await setup();
    const a = await t.login({ sub: 'k-race', deviceId: 'dev-a' });
    const b = await t.login({ sub: 'k-race', deviceId: 'dev-b' });
    const tokB = await t.token(b);
    expect(await t.end.run({ accountId: a.accountId, sessionId: a.sessionId, reauthToken: await t.token(a), targetSessionId: b.sessionId })).toEqual({ ended: 1 });
    expect(await code(t.end.run({ accountId: b.accountId, sessionId: b.sessionId, reauthToken: tokB, targetSessionId: a.sessionId }))).toBe('REAUTH_REQUIRED');
    expect(alive(t, a.sessionId)).toBe(true);
  });
});

/** 트랜잭션마다 부른 저장소 메서드 이름을 차례대로 모은다 */
function recordCalls(store: MemorySessionStore): string[][] {
  const calls: string[][] = [];
  const orig = store.transaction.bind(store);
  store.transaction = ((fn: Parameters<MemorySessionStore['transaction']>[0]) =>
    orig((tx) => {
      const c: string[] = [];
      calls.push(c);
      return fn(
        new Proxy(tx, {
          get(target, k, recv) {
            const v = Reflect.get(target, k, recv) as unknown;
            return typeof v === 'function' ? (...a: unknown[]) => (c.push(String(k)), (v as (...x: unknown[]) => unknown).apply(target, a)) : v;
          },
        }),
      );
    })) as MemorySessionStore['transaction'];
  return calls;
}
/** 사건을 적는 마지막 쓰기: 세션 끝내기는 한 번이고, 그 뒤에는 다른 사건 쓰기만 온다(ADR-0116 결정 3) */
const RECORDS = new Set(['recordLoginMethodChanged', 'recordAccountMerged', 'recordWithdrawn']);
function expectOutboxLast(c: string[]) {
  const ends = c.filter((x) => x === 'terminateSessions' || x === 'endSessions');
  expect(ends.length, c.join(' ')).toBeLessThanOrEqual(1);
  const first = c.findIndex((x) => x === 'terminateSessions' || x === 'endSessions' || RECORDS.has(x));
  if (first >= 0) expect(c.slice(first + 1).every((x) => RECORDS.has(x)), c.join(' ')).toBe(true);
}

describe('로그인 수단을 바꾸면 다른 세션을 끝낸다(I-T75)', () => {
  test('I-T75_①_로그인수단을더하면(LINKED)이세션말고그계정의살아있는세션을모두끝내고_LOGIN_METHOD_CHANGED사건을연결사건보다먼저적는다 [ASVS v5.0.0-7.4.3]', async () => {
    const t = await setup();
    const phone = await t.login({ sub: 'k-add', deviceId: 'dev-phone' });
    const tablet = await t.login({ sub: 'k-add', deviceId: 'dev-tablet' });
    const me = await t.login({ sub: 'k-add', deviceId: 'dev-pc' });
    expect(await t.add.run({ accountId: me.accountId, sessionId: me.sessionId, reauthToken: await t.token(me), provider: 'google', providerUserId: 'g-add' })).toBe('LINKED');
    expect([alive(t, phone.sessionId), alive(t, tablet.sessionId), alive(t, me.sessionId)]).toEqual([false, false, true]);
    const box = outboxOf(t, me.accountId);
    expect(box.slice(0, 2).map((m) => m[2])).toEqual(['LOGIN_METHOD_CHANGED', 'LOGIN_METHOD_CHANGED']);
    expect(box.slice(0, 2).map((m) => m[1]).sort()).toEqual([phone.sessionId, tablet.sessionId].sort());
    expect(box.at(-1)).toEqual(['identity.login-methods-changed']);
    expect(t.k.signals.seen).toContain('others-ended:login_method_changed:2');
  });

  test('I-T75_②③_해제하면다른세션을모두끝내고_ALREADY_LINKED·같은종류·마지막수단409는아무것도끝내지않는다 [ASVS v5.0.0-7.4.3]', async () => {
    const t = await setup();
    const phone = await t.login({ sub: 'k-un', deviceId: 'dev-phone' });
    const me = await t.login({ sub: 'k-un', deviceId: 'dev-pc' });
    // 바뀐 것이 없으면 끝내지 않는다
    expect(await t.add.run({ accountId: me.accountId, sessionId: me.sessionId, reauthToken: await t.token(me), provider: 'kakao', providerUserId: 'k-un' })).toBe('ALREADY_LINKED');
    expect(await t.add.run({ accountId: me.accountId, sessionId: me.sessionId, reauthToken: await t.token(me), provider: 'kakao', providerUserId: 'k-un-2' })).toBe('PROVIDER_TYPE_TAKEN');
    expect(await code(t.unlink.run({ accountId: me.accountId, sessionId: me.sessionId, reauthToken: await t.token(me), provider: 'kakao' }))).toBe('LAST_LOGIN_METHOD');
    expect(alive(t, phone.sessionId)).toBe(true);
    // 수단을 하나 더 이으면 다른 세션이 끝난다. 그 뒤 다른 기기로 다시 로그인하고 해제하면 또 끝난다
    expect(await t.add.run({ accountId: me.accountId, sessionId: me.sessionId, reauthToken: await t.token(me), provider: 'naver', providerUserId: 'n-un' })).toBe('LINKED');
    expect(alive(t, phone.sessionId)).toBe(false);
    const phoneAgain = await t.login({ sub: 'k-un', deviceId: 'dev-phone' });
    expect(await code(t.unlink.run({ accountId: me.accountId, sessionId: me.sessionId, reauthToken: await t.token(me), provider: 'naver' }))).toBe('OK');
    expect([alive(t, phoneAgain.sessionId), alive(t, me.sessionId)]).toEqual([false, true]);
    expect(t.sessions.terminations(me.accountId).map(([id, why]) => [id === phone.sessionId || id === phoneAgain.sessionId, why])).toEqual([
      [true, 'LOGIN_METHOD_CHANGED'],
      [true, 'LOGIN_METHOD_CHANGED'],
    ]);
  });

  test('I-T75_④_병합확정은대표계정의다른세션을끝낸다(제안한쪽이흡수계정이면대표계정의세션을모두) [ASVS v5.0.0-7.4.3]', async () => {
    for (const requester of ['primary', 'absorbed'] as const) {
      const t = await setup();
      const aPhone = await t.login({ sub: `k-m-${requester}`, deviceId: 'dev-a-phone' });
      const a = await t.login({ sub: `k-m-${requester}`, deviceId: 'dev-a-pc' });
      const b = await t.login({ provider: 'google', sub: `g-m-${requester}`, deviceId: 'dev-b' });
      // 대표는 a다. primary: 지금 계정 a가 b의 구글을 더한다(둘 다 본인확인 전이면 지금 계정이 대표). absorbed: a만 본인확인을 마쳤고 b가 a의 카카오를 더한다
      if (requester === 'absorbed') t.verified.add(a.accountId);
      const [me, provider, sub] = requester === 'primary' ? [a, 'google' as const, `g-m-${requester}`] : [b, 'kakao' as const, `k-m-${requester}`];
      const r = await t.add.add({ accountId: me.accountId, sessionId: me.sessionId, reauthToken: await t.token(me), provider, providerUserId: sub });
      expect(r.result).toBe('OTHER_ACCOUNT');
      // 다른 계정이라 병합 제안으로 갔을 뿐 바뀐 것이 없어 아직 끝내지 않는다
      expect([alive(t, aPhone.sessionId), alive(t, a.sessionId), alive(t, b.sessionId)]).toEqual([true, true, true]);
      await t.confirm.run({ accountId: me.accountId, sessionId: me.sessionId, proposalId: r.mergeProposalId!, reauthToken: await t.token(me) });
      expect(t.sessions.accountOf(b.accountId)).toMatchObject({ status: 'MERGED', mergedInto: a.accountId });
      expect(t.sessions.terminations(b.accountId)).toEqual([[b.sessionId, 'MERGED']]);
      if (requester === 'primary') {
        // 제안한 대표 세션만 남고 a의 휴대폰 세션은 LOGIN_METHOD_CHANGED다
        expect([alive(t, a.sessionId), alive(t, aPhone.sessionId)]).toEqual([true, false]);
        expect(t.sessions.terminations(a.accountId)).toEqual([[aPhone.sessionId, 'LOGIN_METHOD_CHANGED']]);
      } else {
        // 제안한 세션이 흡수 계정의 것이라 MERGED로 끝났고, 대표 a의 세션은 모두 LOGIN_METHOD_CHANGED다
        expect([alive(t, a.sessionId), alive(t, aPhone.sessionId)]).toEqual([false, false]);
        expect(t.sessions.terminations(a.accountId).map(([, why]) => why)).toEqual(['LOGIN_METHOD_CHANGED', 'LOGIN_METHOD_CHANGED']);
      }
      // 병합 사건이 마지막이다
      expect(t.sessions.outboxMessages().at(-1)?.topic).toBe('identity.accounts-merged');
    }
  });

  test('새맥락리뷰낮음3_병합확정·연결제안의연결·추가·해제는세션끝내기를한번만하고_사건쓰기를트랜잭션의마지막에둔다 [ASVS v5.0.0-7.4.3]', async () => {
    const t = await setup();
    const aPhone = await t.login({ sub: 'k-ord', deviceId: 'dev-a-phone' });
    void aPhone;
    const a = await t.login({ sub: 'k-ord', deviceId: 'dev-a-pc' });
    await t.login({ provider: 'google', sub: 'g-ord', deviceId: 'dev-b' });
    const calls = recordCalls(t.sessions);
    const r = await t.add.add({ accountId: a.accountId, sessionId: a.sessionId, reauthToken: await t.token(a), provider: 'google', providerUserId: 'g-ord' });
    await t.confirm.run({ accountId: a.accountId, sessionId: a.sessionId, proposalId: r.mergeProposalId!, reauthToken: await t.token(a) });
    expect(await t.add.run({ accountId: a.accountId, sessionId: a.sessionId, reauthToken: await t.token(a), provider: 'naver', providerUserId: 'n-ord' })).toBe('LINKED');
    await t.unlink.run({ accountId: a.accountId, sessionId: a.sessionId, reauthToken: await t.token(a), provider: 'naver' });
    expect(calls.some((c) => c.includes('recordAccountMerged'))).toBe(true);
    for (const c of calls) expectOutboxLast(c);
  });

  test('새맥락리뷰낮음3_연결제안으로새수단을이을때기기가한도를넘어도_다른세션은모두LOGIN_METHOD_CHANGED로한번에끝난다 [ASVS v5.0.0-7.4.3]', async () => {
    const t = await setup();
    const others = [];
    for (let n = 1; n <= 5; n++) {
      others.push(await t.login({ sub: 'k-lim', deviceId: `dev-${n}`, email: 'lim@peaket.test' }));
      t.clock.advance(1_000);
    }
    const p = await t.k.create.outcome({ idempotencyKey: newKey(), provider: 'google', providerUserId: 'g-lim', email: 'lim@peaket.test', emailVerified: true, deviceId: 'dev-6' });
    if (p.kind !== 'link-proposed') throw new Error(`연결 제안이 아니다: ${p.kind}`);
    const calls = recordCalls(t.sessions);
    const r = await t.k.create.outcome({ idempotencyKey: newKey(), provider: 'kakao', providerUserId: 'k-lim', email: null, deviceId: 'dev-6', link: { proposalId: p.proposalId, binding: p.binding } });
    if (r.kind !== 'session') throw new Error(`세션이 아니다: ${r.kind}`);
    expect(t.sessions.terminations(r.accountId).map(([, why]) => why)).toEqual(Array(5).fill('LOGIN_METHOD_CHANGED'));
    expect(others.every((s) => !alive(t, s.sessionId))).toBe(true);
    for (const c of calls) expectOutboxLast(c);
    expect(t.k.signals.seen).not.toContain('terminated:DEVICE_LIMIT:1');
  });

  test('I-T75_⑤_가입때연결제안의연결은그로그인으로만든세션만남기고_대상계정의다른세션을끝낸다 [ASVS v5.0.0-7.4.3]', async () => {
    const t = await setup();
    const phone = await t.login({ sub: 'k-link', deviceId: 'dev-phone', email: 'fan@peaket.test' });
    const p = await t.k.create.outcome({ idempotencyKey: newKey(), provider: 'google', providerUserId: 'g-link', email: 'fan@peaket.test', emailVerified: true, deviceId: 'dev-pc' });
    if (p.kind !== 'link-proposed') throw new Error(`연결 제안이 아니다: ${p.kind}`);
    const r = await t.k.create.outcome({ idempotencyKey: newKey(), provider: 'kakao', providerUserId: 'k-link', email: null, deviceId: 'dev-pc', link: { proposalId: p.proposalId, binding: p.binding } });
    if (r.kind !== 'session') throw new Error(`세션이 아니다: ${r.kind}`);
    expect(r.linkedProvider).toBe('google');
    expect([alive(t, phone.sessionId), alive(t, r.sessionId)]).toEqual([false, true]);
    expect(t.sessions.terminations(r.accountId)).toEqual([[phone.sessionId, 'LOGIN_METHOD_CHANGED']]);
    expect(outboxOf(t, r.accountId).at(-1)).toEqual(['identity.login-methods-changed']);
  });
});
