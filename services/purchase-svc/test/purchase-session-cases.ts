// 구매 세션 저장소(PurchaseSessionStore) 계약 사례(docs/features/seat-hold.md §2 '구매 세션 열기와 확인의 첫 구현', docs/data.md §3 s:jti·s:session,
// src/modules/inventory/adapters/purchase-session-lua.ts). 메모리 저장소(test/purchase-session.test.ts)와 실제 Valkey 8.1 Lua(test-int/purchase-session.int.test.ts)에 똑같이 돈다.
// Lua 안의 시각은 Redis TIME이라 시험이 바꿀 수 없다. 그래서 시각이 걸린 사례는 짧은 기한(1~2초)을 주고 실제로 기다린다(메모리는 가짜 시계를 민다).
import { expect, test } from 'vitest';
import { type OpenSessionInput, type PurchaseSessionStore, SESSION_IDLE_MS, SESSION_STARTED_GRACE_MS } from '../src/modules/inventory/index.js';

export interface SessionHarness {
  store: PurchaseSessionStore;
  /** 저장소 시계의 지금(메모리는 가짜 시계, Valkey는 시험 프로세스의 시각) */
  now(): number;
  /** 저장소 시계를 ms만큼 지난 것으로 만든다(메모리는 시계를 밀고 Valkey는 실제로 기다린다) */
  pass(ms: number): Promise<void>;
  /** 세션 상태 키만 지운다(세션이 끝난 것을 만든다. 재사용 차단 표지는 남는다) */
  end(jti: string): Promise<void>;
  /** 시험 프로세스 시각과 저장소 시각의 허용 오차(메모리 0, Valkey 몇 초) */
  skewMs: number;
}

export const ACCOUNT = 'acct-1';
export const LOGIN = 'login-1';
export const EVENT = 'ev-1';
export const JOURNEY = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
/** 비압축 점 65바이트의 base64url(저장소는 점이 곡선 위인지 보지 않는다. 그건 열기 유스케이스의 몫) */
export const CLIENT_KEY = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 7)]).toString('base64url');
export const OTHER_CLIENT_KEY = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 9)]).toString('base64url');

let n = 0;
/** 시험마다 다른 jti(실제 Valkey를 시험끼리 나눠 쓴다). KEY_PART 모양이다 */
export const newJti = () => `jti-${process.pid}-${Date.now().toString(36)}-${n++}`;

/** 열기 입력. 기본은 45분 최대 체류·첫 사용 기한 5분·같은 jti로 다시 받을 수 있는 가장 늦은 입장 토큰의 exp는 90분 뒤 */
export function openInput(h: { now(): number }, jti: string, over: Partial<OpenSessionInput> = {}): OpenSessionInput {
  return {
    jti,
    accountId: ACCOUNT,
    loginSessionId: LOGIN,
    eventId: EVENT,
    journeyId: JOURNEY,
    clientKey: CLIENT_KEY,
    expiresAtMs: h.now() + 45 * 60_000,
    firstUseDeadlineMs: h.now() + 5 * 60_000,
    reissueUntilMs: h.now() + 90 * 60_000,
    ...over,
  };
}

const near = (a: number, b: number, skew: number) => Math.abs(a - b) <= skew;

export function purchaseSessionStoreCases(make: () => Promise<SessionHarness> | SessionHarness): void {
  test('ST28_① 표지가 없으면 CREATED이고 세션 상태에 계정·로그인 세션·회차·여정·임시 공개키·일련번호 0·유휴 시한·최대 체류가 적힌다 [ASVS v5.0.0-8.2.1]', async () => {
    const h = await make();
    const jti = newJti();
    const i = openInput(h, jti);
    const r = await h.store.open(i);
    expect(r.kind).toBe('CREATED');
    if (r.kind !== 'CREATED') return;
    expect(near(r.startedAtMs, h.now(), h.skewMs)).toBe(true);
    const s = await h.store.read(jti);
    expect(s).toEqual({
      sessionId: jti,
      accountId: ACCOUNT,
      loginSessionId: LOGIN,
      eventId: EVENT,
      journeyId: JOURNEY,
      clientKey: CLIENT_KEY,
      lastSeq: 0,
      startedAtMs: r.startedAtMs,
      idleUntilMs: r.startedAtMs + SESSION_IDLE_MS,
      maxStayUntilMs: i.expiresAtMs,
    });
    expect(s).not.toHaveProperty('priorityGrantId');
  });

  test('ST35_ADR0171_우선 구매 입장의 권리 ID(prio)는 세션 상태에 적힌다', async () => {
    const h = await make();
    const jti = newJti();
    expect((await h.store.open(openInput(h, jti, { priorityGrantId: 'grant-1' }))).kind).toBe('CREATED');
    expect((await h.store.read(jti))?.priorityGrantId).toBe('grant-1');
    // 같은 입력으로 다시 열면 REPLAY(prio가 있는 쪽도 같은 입력)
    expect((await h.store.open(openInput(h, jti, { priorityGrantId: 'grant-1' }))).kind).toBe('REPLAY');
  });

  test('ST28_② 같은 입력으로 다시 열면 REPLAY이고 처음 연 시각을 그대로 주며 일련번호·세션 상태를 바꾸지 않는다(응답을 잃은 재시도)', async () => {
    const h = await make();
    const jti = newJti();
    const first = await h.store.open(openInput(h, jti));
    if (first.kind !== 'CREATED') throw new Error('CREATED여야 한다');
    expect(await h.store.advance(jti, 3)).toBe(true);
    const before = await h.store.read(jti);
    await h.pass(20);
    const again = await h.store.open(openInput(h, jti));
    expect(again).toEqual({ kind: 'REPLAY', startedAtMs: first.startedAtMs, maxStayUntilMs: before!.maxStayUntilMs, needsStarted: false });
    expect(await h.store.read(jti)).toEqual(before);
    expect((await h.store.read(jti))?.lastSeq).toBe(3);
  });

  test('ST28_③ 계정·로그인 세션·회차·임시 공개키 가운데 하나라도 다르면 MISMATCH이고 세션 상태는 그대로다 [ASVS v5.0.0-8.2.1] [ASVS v5.0.0-8.2.2]', async () => {
    const h = await make();
    const jti = newJti();
    await h.store.open(openInput(h, jti));
    const before = await h.store.read(jti);
    for (const over of [{ accountId: 'acct-2' }, { loginSessionId: 'login-2' }, { eventId: 'ev-2' }, { clientKey: OTHER_CLIENT_KEY }]) {
      expect(await h.store.open(openInput(h, jti, over)), JSON.stringify(over)).toEqual({ kind: 'MISMATCH' });
    }
    expect(await h.store.read(jti)).toEqual(before);
  });

  test('ADR0183_8_첫 사용 기한이 지난 뒤의 첫 열기는 FIRST_USE_EXPIRED이고 아무것도 쓰지 않는다. jti는 쓰이지 않은 채라 기한 안에 다시 오면 열린다', async () => {
    const h = await make();
    const jti = newJti();
    expect(await h.store.open(openInput(h, jti, { firstUseDeadlineMs: h.now() - 10_000 }))).toEqual({ kind: 'FIRST_USE_EXPIRED' });
    expect(await h.store.read(jti)).toBeUndefined();
    expect((await h.store.open(openInput(h, jti))).kind).toBe('CREATED');
  });

  test('최대 체류(exp)가 지난 첫 열기는 TOKEN_EXPIRED이고 아무것도 쓰지 않는다 [ASVS v5.0.0-9.2.1]', async () => {
    const h = await make();
    const jti = newJti();
    expect(await h.store.open(openInput(h, jti, { expiresAtMs: h.now() - 10_000 }))).toEqual({ kind: 'TOKEN_EXPIRED' });
    expect(await h.store.read(jti)).toBeUndefined();
    expect((await h.store.open(openInput(h, jti))).kind).toBe('CREATED');
  });

  test('ADR0183_8_첫 사용 기한은 첫 열기에만 걸린다: 기한이 지난 뒤의 같은 입력은 REPLAY이고, exp가 지나면 TOKEN_EXPIRED이며 일련번호도 올리지 못한다', async () => {
    const h = await make();
    const jti = newJti();
    const i = openInput(h, jti, { firstUseDeadlineMs: h.now() + 1_000, expiresAtMs: h.now() + 2_000 });
    expect((await h.store.open(i)).kind).toBe('CREATED');
    await h.pass(1_100); // 첫 사용 기한 뒤, exp 앞
    expect((await h.store.open(i)).kind).toBe('REPLAY');
    expect(await h.store.advance(jti, 1)).toBe(true);
    await h.pass(1_100); // exp 뒤
    expect(await h.store.open(i)).toEqual({ kind: 'TOKEN_EXPIRED' });
    expect(await h.store.advance(jti, 2)).toBe(false);
    expect((await h.store.read(jti))?.lastSeq).toBe(1);
  });

  test('ADR0183_8_세션 상태만 지워지면(끝난 세션) 같은 입장 토큰으로 다시 열 수 없다: ENDED', async () => {
    const h = await make();
    const jti = newJti();
    await h.store.open(openInput(h, jti));
    await h.end(jti);
    expect(await h.store.read(jti)).toBeUndefined();
    expect(await h.store.open(openInput(h, jti))).toEqual({ kind: 'ENDED' });
    expect(await h.store.read(jti)).toBeUndefined();
    expect(await h.store.advance(jti, 1)).toBe(false);
  });

  test('ST28_④ 같은 jti를 동시에 여러 번 열어도 CREATED는 한 번이다(같은 입력이면 나머지는 REPLAY, 임시 공개키가 다르면 나머지는 MISMATCH)', async () => {
    const h = await make();
    const same = newJti();
    const rs = await Promise.all(Array.from({ length: 20 }, () => h.store.open(openInput(h, same, { expiresAtMs: openInput(h, same).expiresAtMs }))));
    expect(rs.filter((r) => r.kind === 'CREATED')).toHaveLength(1);
    expect(rs.filter((r) => r.kind === 'REPLAY')).toHaveLength(19);
    const startedAt = new Set(rs.map((r) => ('startedAtMs' in r ? r.startedAtMs : -1)));
    expect(startedAt.size).toBe(1);

    const diff = newJti();
    const keys = [CLIENT_KEY, OTHER_CLIENT_KEY];
    const rs2 = await Promise.all(Array.from({ length: 20 }, (_, k) => h.store.open(openInput(h, diff, { clientKey: keys[k % 2]! }))));
    expect(rs2.filter((r) => r.kind === 'CREATED')).toHaveLength(1);
    expect(rs2.filter((r) => r.kind === 'MISMATCH').length).toBeGreaterThanOrEqual(9);
    // 이긴 쪽의 키가 세션에 남는다
    const won = (await h.store.read(diff))!.clientKey;
    expect(keys).toContain(won);
  });

  test('일련번호는 마지막 번호보다 클 때만 올라간다: 같은 번호·작은 번호·0은 false이고 번호는 그대로다 [ASVS v5.0.0-9.1.1]', async () => {
    const h = await make();
    const jti = newJti();
    await h.store.open(openInput(h, jti));
    expect(await h.store.advance(jti, 1)).toBe(true);
    expect(await h.store.advance(jti, 1)).toBe(false);
    expect(await h.store.advance(jti, 2)).toBe(true);
    expect(await h.store.advance(jti, 5)).toBe(true);
    expect(await h.store.advance(jti, 3)).toBe(false);
    expect(await h.store.advance(jti, 5)).toBe(false);
    expect((await h.store.read(jti))?.lastSeq).toBe(5);
    // 2^53 − 1까지 정확히 다룬다
    expect(await h.store.advance(jti, Number.MAX_SAFE_INTEGER - 1)).toBe(true);
    expect(await h.store.advance(jti, Number.MAX_SAFE_INTEGER)).toBe(true);
    expect(await h.store.advance(jti, Number.MAX_SAFE_INTEGER)).toBe(false);
    expect((await h.store.read(jti))?.lastSeq).toBe(Number.MAX_SAFE_INTEGER);
  });

  test('같은 번호를 동시에 보내면 하나만 true이고, 서로 다른 번호를 동시에 보내도 끝 번호는 가장 큰 번호다 [ASVS v5.0.0-9.1.1]', async () => {
    const h = await make();
    const jti = newJti();
    await h.store.open(openInput(h, jti));
    const same = await Promise.all(Array.from({ length: 30 }, () => h.store.advance(jti, 1)));
    expect(same.filter(Boolean)).toHaveLength(1);
    const many = await Promise.all(Array.from({ length: 30 }, (_, k) => h.store.advance(jti, k + 2)));
    expect(many.filter(Boolean).length).toBeGreaterThanOrEqual(1);
    expect((await h.store.read(jti))?.lastSeq).toBe(31);
  });

  test('모양이 틀린 입력은 RangeError이고 아무것도 쓰지 않는다: jti는 키 조각 모양(해시 태그를 깨는 글자 금지), 계정·로그인 세션·회차·prio도 키 조각 모양, 여정 ID는 UUID, 임시 공개키는 87자 base64url, 시각은 안전한 정수, 일련번호는 1 이상의 안전한 정수 [ASVS v5.0.0-1.2.4]', async () => {
    const h = await make();
    const jti = newJti();
    for (const bad of ['', 'a}b', '{x}', 'a:b', 'a b', 'x'.repeat(65), 'é']) {
      await expect(h.store.open(openInput(h, bad)), bad).rejects.toThrow(RangeError);
      await expect(h.store.read(bad), bad).rejects.toThrow(RangeError);
      await expect(h.store.advance(bad, 1), bad).rejects.toThrow(RangeError);
    }
    const overs: Array<Partial<OpenSessionInput>> = [
      { accountId: 'a}b' },
      { loginSessionId: '' },
      { eventId: 'ev 1' },
      { priorityGrantId: 'a:b' },
      { journeyId: 'not-a-uuid' },
      { clientKey: 'AAAA' },
      { clientKey: `${CLIENT_KEY.slice(0, -1)}=` },
      { expiresAtMs: Number.NaN },
      { expiresAtMs: 1.5 },
      { expiresAtMs: Number.MAX_SAFE_INTEGER + 1 },
      { firstUseDeadlineMs: -1 },
      { firstUseDeadlineMs: 0.5 },
      { reissueUntilMs: -1 },
      { reissueUntilMs: 1.5 },
      // 다시 받을 수 있는 가장 늦은 exp가 이 토큰의 exp보다 이르면 표지가 세션보다 먼저 사라진다
      { reissueUntilMs: 5, expiresAtMs: 10 },
    ];
    for (const over of overs) await expect(h.store.open(openInput(h, jti, over)), JSON.stringify(over)).rejects.toThrow(RangeError);
    expect(await h.store.read(jti)).toBeUndefined();
    await h.store.open(openInput(h, jti));
    for (const seq of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1, Number.POSITIVE_INFINITY]) {
      await expect(h.store.advance(jti, seq), String(seq)).rejects.toThrow(RangeError);
    }
    expect((await h.store.read(jti))?.lastSeq).toBe(0);
  });

  test('[ASVS v5.0.0-9.1.1]_없는 세션은 읽으면 undefined이고 일련번호를 올릴 수 없다(세션 상태를 만들어 주지 않는다)', async () => {
    const h = await make();
    const jti = newJti();
    expect(await h.store.read(jti)).toBeUndefined();
    expect(await h.store.advance(jti, 1)).toBe(false);
    expect(await h.store.read(jti)).toBeUndefined();
  });

  test('ADR0183_8_일련번호를 올릴 때마다 유휴 시한이 지금 + 5분으로 다시 쓰인다(지우거나 넘기는 일은 이 단계 밖)', async () => {
    const h = await make();
    const jti = newJti();
    const r = await h.store.open(openInput(h, jti));
    if (r.kind !== 'CREATED') throw new Error('CREATED여야 한다');
    await h.pass(1_100);
    expect(await h.store.advance(jti, 1)).toBe(true);
    const s = (await h.store.read(jti))!;
    expect(s.idleUntilMs).toBeGreaterThan(r.startedAtMs + SESSION_IDLE_MS);
    expect(near(s.idleUntilMs, h.now() + SESSION_IDLE_MS, h.skewMs)).toBe(true);
    // 번호를 올리지 못한 요청은 유휴 시한을 바꾸지 않는다
    await h.pass(50);
    expect(await h.store.advance(jti, 1)).toBe(false);
    expect((await h.store.read(jti))?.idleUntilMs).toBe(s.idleUntilMs);
  });

  test('ADR0183_8_같은 jti로 다시 받은 입장 토큰(더 늦은 exp)으로 열면 REPLAY이고 최대 체류는 처음 값 그대로다: 세션 상태도 늘어나지 않는다(다시 받아 체류를 늘릴 수 없다)', async () => {
    const h = await make();
    const jti = newJti();
    const a = openInput(h, jti);
    expect((await h.store.open(a)).kind).toBe('CREATED');
    const b = openInput(h, jti, { expiresAtMs: a.expiresAtMs + 40 * 60_000, reissueUntilMs: a.reissueUntilMs + 40 * 60_000 });
    const again = await h.store.open(b);
    expect(again).toMatchObject({ kind: 'REPLAY', maxStayUntilMs: a.expiresAtMs });
    expect((await h.store.read(jti))?.maxStayUntilMs).toBe(a.expiresAtMs);
  });

  test('ADR0183_8_처음 최대 체류가 지나면 더 늦은 exp의 다시 받은 입장 토큰으로도 TOKEN_EXPIRED이고 일련번호도 올리지 못한다. 세션을 새로 열지 않는다', async () => {
    const h = await make();
    const jti = newJti();
    const a = openInput(h, jti, { expiresAtMs: h.now() + 1_000 });
    expect((await h.store.open(a)).kind).toBe('CREATED');
    await h.pass(1_100);
    const b = openInput(h, jti, { expiresAtMs: h.now() + 40 * 60_000, reissueUntilMs: h.now() + 85 * 60_000 });
    expect(await h.store.open(b)).toEqual({ kind: 'TOKEN_EXPIRED' });
    expect(await h.store.advance(jti, 1)).toBe(false);
  });

  test('ADR0183_11_markStarted는 세션이 있을 때만 시작 사건 기록 표시를 한다(true). 표시가 없으면 연 지 유예(1초) 뒤의 REPLAY가 needsStarted true를 주고(그 안은 처음 연 요청이 더하는 중이라 false), 표시가 있으면 늘 false다. 없는 세션에는 아무것도 만들지 않는다(false)', async () => {
    const h = await make();
    const jti = newJti();
    expect(await h.store.markStarted(jti)).toBe(false);
    expect(await h.store.read(jti)).toBeUndefined();
    expect((await h.store.open(openInput(h, jti))).kind).toBe('CREATED');
    expect(await h.store.open(openInput(h, jti))).toMatchObject({ kind: 'REPLAY', needsStarted: false });
    await h.pass(SESSION_STARTED_GRACE_MS + 150);
    expect(await h.store.open(openInput(h, jti))).toMatchObject({ kind: 'REPLAY', needsStarted: true });
    expect(await h.store.markStarted(jti)).toBe(true);
    expect(await h.store.markStarted(jti)).toBe(true);
    expect(await h.store.open(openInput(h, jti))).toMatchObject({ kind: 'REPLAY', needsStarted: false });
    // 표시는 세션 상태 읽기 결과를 바꾸지 않는다
    expect((await h.store.read(jti))?.lastSeq).toBe(0);
    await h.end(jti);
    expect(await h.store.markStarted(jti)).toBe(false);
    expect(await h.store.read(jti)).toBeUndefined();
    // 세션이 끝난 뒤의 표시는 아무것도 되살리지 않는다: 같은 입장 토큰은 여전히 ENDED다
    expect(await h.store.open(openInput(h, jti))).toEqual({ kind: 'ENDED' });
  });

  test('markStarted의 jti가 키 조각 모양이 아니면 RangeError이고 아무것도 쓰지 않는다 [ASVS v5.0.0-1.2.4]', async () => {
    const h = await make();
    for (const bad of ['', 'a}b', '{x}', 'a:b', 'x'.repeat(65)]) await expect(h.store.markStarted(bad), bad).rejects.toThrow(RangeError);
  });

  // ── 키 없는 열기(BUILD_ORDER PRF-137): 세션이 열린 뒤의 재요청은 X-Client-Ephemeral-Key 없이 온다(openapi '그 뒤에는 무시한다', docs/features/seat-hold.md §2 '클라이언트 임시 공개키 헤더') ──

  test('ST28_ADR0183_8_키 없는 열기: 재사용 차단 표지가 없고 첫 사용 기한 안이면 KEY_REQUIRED이고 아무것도 쓰지 않는다(읽으면 undefined, 같은 jti로 키를 주고 다시 열면 CREATED)', async () => {
    const h = await make();
    const jti = newJti();
    expect(await h.store.open(openInput(h, jti, { clientKey: undefined }))).toEqual({ kind: 'KEY_REQUIRED' });
    expect(await h.store.read(jti)).toBeUndefined();
    expect(await h.store.advance(jti, 1)).toBe(false);
    expect(await h.store.markStarted(jti)).toBe(false);
    // 여러 번·동시에 불러도 그대로다
    const rs = await Promise.all(Array.from({ length: 20 }, () => h.store.open(openInput(h, jti, { clientKey: undefined }))));
    expect(rs.every((r) => r.kind === 'KEY_REQUIRED')).toBe(true);
    expect(await h.store.read(jti)).toBeUndefined();
    // 표지가 남지 않았다: 키를 주고 열면 REPLAY·ENDED가 아니라 CREATED다
    expect((await h.store.open(openInput(h, jti))).kind).toBe('CREATED');
  });

  test('ADR0183_8_키 없는 열기: 첫 사용 기한이 지났으면 키 없음보다 먼저 FIRST_USE_EXPIRED이고 아무것도 쓰지 않는다', async () => {
    const h = await make();
    const jti = newJti();
    expect(await h.store.open(openInput(h, jti, { clientKey: undefined, firstUseDeadlineMs: h.now() - 10_000 }))).toEqual({ kind: 'FIRST_USE_EXPIRED' });
    expect(await h.store.read(jti)).toBeUndefined();
    expect((await h.store.open(openInput(h, jti))).kind).toBe('CREATED');
  });

  test('키 없는 열기: 최대 체류(exp)가 지났으면 맨 먼저 TOKEN_EXPIRED다(기한·키 없음보다 앞). 열린 세션도 처음 최대 체류가 지나면 TOKEN_EXPIRED다 [ASVS v5.0.0-9.2.1]', async () => {
    const h = await make();
    const jti = newJti();
    expect(await h.store.open(openInput(h, jti, { clientKey: undefined, expiresAtMs: h.now() - 10_000, firstUseDeadlineMs: h.now() - 20_000 }))).toEqual({ kind: 'TOKEN_EXPIRED' });
    expect(await h.store.read(jti)).toBeUndefined();
    expect((await h.store.open(openInput(h, jti))).kind).toBe('CREATED');

    const live = newJti();
    const i = openInput(h, live, { expiresAtMs: h.now() + 1_000 });
    expect((await h.store.open(i)).kind).toBe('CREATED');
    await h.pass(1_100);
    expect(await h.store.open({ ...i, clientKey: undefined })).toEqual({ kind: 'TOKEN_EXPIRED' });
    expect(await h.store.advance(live, 1)).toBe(false);
  });

  test('ST28_ADR0183_8_세션이 열린 뒤에는 키 없이도 REPLAY다: 처음 연 시각·처음 최대 체류·needsStarted를 주고 세션 상태(저장된 임시 공개키 포함)를 바꾸지 않는다', async () => {
    const h = await make();
    const jti = newJti();
    const i = openInput(h, jti);
    const first = await h.store.open(i);
    if (first.kind !== 'CREATED') throw new Error('CREATED여야 한다');
    expect(await h.store.advance(jti, 2)).toBe(true);
    expect(await h.store.markStarted(jti)).toBe(true);
    const before = await h.store.read(jti);
    await h.pass(20);
    const keyless = { ...i, clientKey: undefined };
    expect(await h.store.open(keyless)).toEqual({ kind: 'REPLAY', startedAtMs: first.startedAtMs, maxStayUntilMs: i.expiresAtMs, needsStarted: false });
    expect(await h.store.read(jti)).toEqual(before);
    expect((await h.store.read(jti))?.clientKey).toBe(CLIENT_KEY);
    // 저장된 키는 그대로라서 다른 키는 여전히 MISMATCH, 같은 키는 REPLAY다
    expect(await h.store.open(openInput(h, jti, { clientKey: OTHER_CLIENT_KEY }))).toEqual({ kind: 'MISMATCH' });
    expect((await h.store.open(i)).kind).toBe('REPLAY');
  });

  test('ADR0183_11_키 없는 REPLAY도 needsStarted를 따른다: 시작 사건 기록 표시가 없고 연 지 유예(1초)가 지났으면 true, 그 안이거나 표시가 있으면 false다', async () => {
    const h = await make();
    const jti = newJti();
    const i = openInput(h, jti);
    expect((await h.store.open(i)).kind).toBe('CREATED');
    const keyless = { ...i, clientKey: undefined };
    expect(await h.store.open(keyless)).toMatchObject({ kind: 'REPLAY', needsStarted: false });
    await h.pass(SESSION_STARTED_GRACE_MS + 150);
    expect(await h.store.open(keyless)).toMatchObject({ kind: 'REPLAY', needsStarted: true });
    expect(await h.store.markStarted(jti)).toBe(true);
    expect(await h.store.open(keyless)).toMatchObject({ kind: 'REPLAY', needsStarted: false });
  });

  test('ADR0183_8_키 없는 REPLAY는 첫 사용 기한을 보지 않는다: 기한이 지난 뒤에도 최대 체류 안이면 REPLAY다', async () => {
    const h = await make();
    const jti = newJti();
    const i = openInput(h, jti, { firstUseDeadlineMs: h.now() + 1_000, expiresAtMs: h.now() + 60_000 });
    expect((await h.store.open(i)).kind).toBe('CREATED');
    await h.pass(1_100);
    expect((await h.store.open({ ...i, clientKey: undefined })).kind).toBe('REPLAY');
  });

  test('ST28_키 없는 열기: 계정·로그인 세션·회차 가운데 하나라도 다르면 MISMATCH이고 세션 상태는 그대로다 [ASVS v5.0.0-8.2.1] [ASVS v5.0.0-8.2.2]', async () => {
    const h = await make();
    const jti = newJti();
    await h.store.open(openInput(h, jti));
    const before = await h.store.read(jti);
    for (const over of [{ accountId: 'acct-2' }, { loginSessionId: 'login-2' }, { eventId: 'ev-2' }]) {
      expect(await h.store.open(openInput(h, jti, { ...over, clientKey: undefined })), JSON.stringify(over)).toEqual({ kind: 'MISMATCH' });
    }
    expect(await h.store.read(jti)).toEqual(before);
  });

  test('ADR0183_8_키 없는 열기: 표지만 남고 세션 상태가 없으면(끝난 세션) ENDED다. 세션을 되살리지 않는다', async () => {
    const h = await make();
    const jti = newJti();
    await h.store.open(openInput(h, jti));
    await h.end(jti);
    expect(await h.store.open(openInput(h, jti, { clientKey: undefined }))).toEqual({ kind: 'ENDED' });
    expect(await h.store.read(jti)).toBeUndefined();
    expect(await h.store.advance(jti, 1)).toBe(false);
  });
}
