// 구매 세션 열기 유스케이스 OpenPurchaseSession(docs/features/seat-hold.md §2 '구매 세션 열기와 확인의 첫 구현', ADR-0183 결정 8·11, BUILD_ORDER PRF-136).
// 입장 토큰 확인 → 요청의 계정·로그인 세션·회차와 대조 → 클라이언트 임시 공개키 검사 → 저장소에서 열기 → 새로 열렸을 때만 SESSION_STARTED를 따로 더한다.
import { randomUUID } from 'node:crypto';
import { fakeClock } from '@peaket/platform';
import { describe, expect, test } from 'vitest';
import {
  FIRST_USE_MS,
  MemoryPurchaseSessionStore,
  OpenPurchaseSession,
  OpenSessionError,
  type OpenSessionErrorCode,
  RecordingSessionStartedLog,
  SESSION_KEY_GRACE_MS,
  SESSION_STARTED_GRACE_MS,
  SeatStoreUnavailable,
  SessionStoreFailure,
  type SessionStartedEntry,
} from '../src/modules/inventory/index.js';
import { claimsOf, ISS, JNY, newKey, signAdmission } from './admission-fixtures.js';
import { OTHER_CLIENT_KEY } from './purchase-session-cases.js';
import { clientKeyOf } from './session-fixtures.js';

const NOW = Date.parse('2026-11-04T03:00:00.000Z');
const K1 = newKey('k1');
const keys = new Map([['k1', K1.pub]]);

function setup(o: { logFails?: boolean } = {}) {
  const clock = fakeClock({ now: NOW });
  const store = new MemoryPurchaseSessionStore(clock);
  const log = new RecordingSessionStartedLog();
  if (o.logFails) log.failWith = new Error('stream down');
  const warnings: Array<{ obj: Record<string, unknown>; msg: string }> = [];
  const uc = new OpenPurchaseSession({ store, log, keys, issuer: ISS, clock, logger: { warn: (obj, msg) => warnings.push({ obj: obj as Record<string, unknown>, msg }) } });
  return { clock, store, log, warnings, uc };
}

function command(over: Record<string, unknown> = {}, claimsOver: Record<string, unknown> = {}, jti = randomUUID()) {
  const client = clientKeyOf();
  return {
    jti,
    client,
    cmd: {
      token: signAdmission(K1, claimsOf({ nowMs: NOW, jti }, claimsOver)),
      accountId: 'acct-1',
      loginSessionId: 'login-1',
      eventId: 'ev-1',
      clientKey: client.text,
      ...over,
    },
  };
}

const codeOf = async (p: Promise<unknown>): Promise<OpenSessionErrorCode | 'ok'> => {
  try {
    await p;
    return 'ok';
  } catch (e) {
    if (e instanceof OpenSessionError) return e.code;
    throw e;
  }
};

describe('열기', () => {
  test('ST28_ST35_ADR0183_8_처음 열면 구매 세션 ID(= jti)·여정 ID·시작 시각·최대 체류를 주고 SESSION_STARTED를 한 번 더한다', async () => {
    const { uc, log, store } = setup();
    const { jti, cmd, client } = command();
    const out = await uc.execute(cmd);
    expect(out).toEqual({ sessionId: jti, eventId: 'ev-1', journeyId: JNY, created: true, startedAtMs: NOW, maxStayUntilMs: (Math.floor(NOW / 1000) + 45 * 60) * 1000 });
    expect(log.entries).toEqual<SessionStartedEntry[]>([{ eventId: 'ev-1', purchaseSessionId: jti, admissionJti: jti, journeyId: JNY, startedAtMs: NOW, maxStayUntilMs: out.maxStayUntilMs }]);
    const s = await store.read(jti);
    expect(s).toMatchObject({ accountId: 'acct-1', loginSessionId: 'login-1', eventId: 'ev-1', journeyId: JNY, clientKey: client.text, lastSeq: 0 });
  });

  test('ST28_ADR0183_8_응답을 잃은 재시도(같은 토큰·같은 임시 공개키)는 같은 세션을 주고 SESSION_STARTED를 더하지 않는다. 첫 사용 기한이 지난 뒤여도 열린다', async () => {
    const { uc, log, clock } = setup();
    const { cmd } = command();
    const first = await uc.execute(cmd);
    clock.advance(FIRST_USE_MS + 1_000);
    const again = await uc.execute(cmd);
    expect(again).toEqual({ ...first, created: false });
    expect(log.entries).toHaveLength(1);
  });

  test('ADR0183_8_첫 사용 기한은 iat + 5분이다: 정각까지는 열리고 1ms 지나면 FIRST_USE_EXPIRED이며 아무것도 쓰지 않는다', async () => {
    const edge = setup();
    const a = command();
    edge.clock.advance(FIRST_USE_MS);
    expect((await edge.uc.execute(a.cmd)).created).toBe(true);

    const late = setup();
    const b = command();
    late.clock.advance(FIRST_USE_MS + 1);
    expect(await codeOf(late.uc.execute(b.cmd))).toBe('FIRST_USE_EXPIRED');
    expect(await late.store.read(b.jti)).toBeUndefined();
    expect(late.log.entries).toHaveLength(0);
  });

  test('ASVS9.2.1_exp가 지난 입장 토큰은 TOKEN_EXPIRED다(열린 세션의 재시도도 같다) [ASVS v5.0.0-9.2.1]', async () => {
    const { uc, clock } = setup();
    const { cmd } = command();
    await uc.execute(cmd);
    clock.advance(45 * 60_000);
    expect(await codeOf(uc.execute(cmd))).toBe('TOKEN_EXPIRED');
  });

  test('ADR0183_11_우선 구매 입장의 prio 클레임은 세션 상태와 결과에 실린다', async () => {
    const { uc, store } = setup();
    const { jti, cmd } = command({}, { prio: 'grant-9' });
    const out = await uc.execute(cmd);
    expect(out.priorityGrantId).toBe('grant-9');
    expect((await store.read(jti))?.priorityGrantId).toBe('grant-9');
  });

  test('ST28_④ 같은 입장 토큰을 동시에 열어도 새로 열리는 것은 한 번이고 SESSION_STARTED도 한 번이다', async () => {
    const { uc, log } = setup();
    const { cmd } = command();
    const outs = await Promise.all(Array.from({ length: 10 }, () => uc.execute(cmd)));
    expect(outs.filter((o) => o.created)).toHaveLength(1);
    expect(log.entries).toHaveLength(1);
  });
});

describe('거절', () => {
  test('ASVS9.1.1_ASVS16.3.1_서명·typ·aud·iss·kid·모양이 틀린 입장 토큰은 TOKEN_INVALID이고 아무것도 열지 않는다. 이유는 로그에만 남고 토큰·계정은 싣지 않는다 [ASVS v5.0.0-9.1.1] [ASVS v5.0.0-16.3.1]', async () => {
    const other = newKey('k1');
    const claims = (jti: string, over: Record<string, unknown> = {}) => claimsOf({ nowMs: NOW, jti }, over);
    const cases: Array<[string, string, string | undefined]> = [
      ['signature', 'j1', signAdmission(K1, claims('j1'), { signWith: other.priv })],
      ['typ', 'j2', signAdmission(K1, claims('j2'), { header: { typ: 'at+jwt' } })],
      ['aud', 'j3', signAdmission(K1, claims('j3', { aud: 'fan' }))],
      ['iss', 'j4', signAdmission(K1, claims('j4', { iss: 'https://evil.example' }))],
      ['kid', 'j5', signAdmission(K1, claims('j5'), { header: { kid: 'k9' } })],
      ['alg', 'j6', signAdmission(K1, claims('j6'), { header: { alg: 'none' } })],
      ['format', 'j7', 'not-a-token'],
      ['format', 'j8', undefined],
      ['claims', 'j9', signAdmission(K1, claims('j9', { jny: 'nope' }))],
      ['not_yet', 'j10', signAdmission(K1, claims('j10', { iat: Math.floor(NOW / 1000) + 120, exp: Math.floor(NOW / 1000) + 3600 }))],
    ];
    for (const [reason, jti, token] of cases) {
      const { uc, log, warnings, store } = setup();
      const { cmd } = command({ token });
      expect(await codeOf(uc.execute(cmd as never)), reason).toBe('TOKEN_INVALID');
      expect(log.entries).toHaveLength(0);
      expect(await store.read(jti)).toBeUndefined();
      expect(warnings).toHaveLength(1);
      expect(warnings[0]!.obj).toMatchObject({ reason });
      const text = JSON.stringify(warnings);
      expect(text).not.toContain('acct-1');
      expect(text).not.toContain('login-1');
      expect(text).not.toContain(cmd.clientKey);
      if (typeof token === 'string') expect(text).not.toContain(token);
    }
  });

  test('ASVS16.3.1_토큰 거절 로그는 이유와 회차만 싣고 한 번에 한 줄이다 [ASVS v5.0.0-16.3.1]', async () => {
    const { uc, warnings } = setup();
    const { cmd } = command({ token: 'x.y.z' });
    await codeOf(uc.execute(cmd));
    expect(warnings).toEqual([{ obj: { reason: 'format', code: 'TOKEN_INVALID', eventId: 'ev-1' }, msg: '구매 세션 열기 거절' }]);
  });

  test('ASVS9.2.1_exp가 지난 토큰은 TOKEN_EXPIRED로 가른다 [ASVS v5.0.0-9.2.1]', async () => {
    const { uc, clock, warnings } = setup();
    const { cmd } = command();
    clock.advance(45 * 60_000);
    expect(await codeOf(uc.execute(cmd))).toBe('TOKEN_EXPIRED');
    expect(warnings[0]!.obj).toMatchObject({ reason: 'expired', code: 'TOKEN_EXPIRED' });
  });

  test('ASVS8.2.1_ASVS8.2.2_토큰의 계정·로그인 세션이 요청과 다르면 TOKEN_MISMATCH다(남의 토큰). 아무것도 열지 않는다 [ASVS v5.0.0-8.2.1] [ASVS v5.0.0-8.2.2]', async () => {
    for (const over of [{ accountId: 'acct-2' }, { loginSessionId: 'login-2' }]) {
      const { uc, store, log } = setup();
      const { jti, cmd } = command(over);
      expect(await codeOf(uc.execute(cmd)), JSON.stringify(over)).toBe('TOKEN_MISMATCH');
      expect(await store.read(jti)).toBeUndefined();
      expect(log.entries).toHaveLength(0);
    }
  });

  test('ST28_①③ 주소의 회차가 토큰의 event와 다르면 EVENT_MISMATCH(403)이고 아무것도 열지 않는다. 한가한 회차의 입장 토큰으로 다른 회차를 못 연다 [ASVS v5.0.0-8.2.2]', async () => {
    const { uc, store, log, warnings } = setup();
    const { jti, cmd } = command({ eventId: 'ev-2' });
    expect(await codeOf(uc.execute(cmd))).toBe('EVENT_MISMATCH');
    expect(await store.read(jti)).toBeUndefined();
    expect(log.entries).toHaveLength(0);
    expect(warnings[0]!.obj).toMatchObject({ code: 'EVENT_MISMATCH', eventId: 'ev-2' });
  });

  test('ASVS8.2.1_토큰 검사가 임시 공개키 검사보다 먼저다(인증 실패가 입력 오류보다 먼저 드러난다). 토큰이 맞으면 임시 공개키가 틀린 것은 CLIENT_KEY_INVALID(400)이고 아무것도 열지 않는다 [ASVS v5.0.0-8.2.1]', async () => {
    const both = setup();
    expect(await codeOf(both.uc.execute(command({ token: 'bad', clientKey: 'zzz' }).cmd))).toBe('TOKEN_INVALID');
    for (const clientKey of [undefined, '', 'AAAA', OTHER_CLIENT_KEY.slice(0, -1), Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 1)]).toString('base64url')]) {
      const { uc, store, log } = setup();
      const { jti, cmd } = command({ clientKey });
      expect(await codeOf(uc.execute(cmd as never)), String(clientKey)).toBe('CLIENT_KEY_INVALID');
      expect(await store.read(jti)).toBeUndefined();
      expect(log.entries).toHaveLength(0);
    }
  });

  test('ADR0183_8_이미 쓴 입장 토큰: 다른 임시 공개키로 다시 열거나 끝난 세션에 다시 열면 TOKEN_USED다. 처음 세션은 그대로다', async () => {
    const { uc, store, log } = setup();
    const { jti, cmd } = command();
    await uc.execute(cmd);
    const before = await store.read(jti);
    expect(await codeOf(uc.execute({ ...cmd, clientKey: clientKeyOf().text }))).toBe('TOKEN_USED');
    expect(await store.read(jti)).toEqual(before);
    store.endSession(jti);
    expect(await codeOf(uc.execute(cmd))).toBe('TOKEN_USED');
    expect(log.entries).toHaveLength(1);
  });
});

describe('시작 사건', () => {
  test('ADR0183_11_SESSION_STARTED를 더하지 못해도 열기는 성공이고 로그만 남긴다(빠지면 입장 자리 5분 회수와 최대 체류 정리가 덮는다)', async () => {
    const { uc, warnings, store } = setup({ logFails: true });
    const { jti, cmd } = command();
    const out = await uc.execute(cmd);
    expect(out.created).toBe(true);
    expect(await store.read(jti)).toBeDefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.msg).toBe('SESSION_STARTED 더하기 실패');
    expect(warnings[0]!.obj).toMatchObject({ eventId: 'ev-1' });
    expect(JSON.stringify(warnings)).not.toContain('acct-1');
  });

  test('ST35_서로 다른 입장 토큰은 각자 세션과 사건을 만든다: 사건의 여정 ID는 그 토큰의 jny다', async () => {
    const { uc, log } = setup();
    const a = command({}, { jny: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a01' });
    const b = command({}, { jny: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a02' });
    await uc.execute(a.cmd);
    await uc.execute(b.cmd);
    expect(log.entries.map((e) => [e.admissionJti, e.journeyId])).toEqual([
      [a.jti, '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a01'],
      [b.jti, '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a02'],
    ]);
  });
});

describe('응답을 잃은 재시도와 다시 받은 입장 토큰(PRF-136 리뷰)', () => {
  test('ADR0183_11_ST35_시작 사건 더하기가 실패한 채 응답을 잃으면 같은 입력의 재시도(REPLAY)가 SESSION_STARTED를 다시 더한다. 더한 뒤에는 더하지 않는다', async () => {
    const { uc, log, warnings, clock } = setup({ logFails: true });
    const { cmd, jti } = command();
    const first = await uc.execute(cmd);
    expect(first.created).toBe(true);
    expect(log.entries).toHaveLength(0);
    expect(warnings.filter((w) => w.msg.includes('SESSION_STARTED'))).toHaveLength(1);
    log.failWith = undefined;
    // 연 지 유예(1초) 안의 재시도는 처음 연 요청이 더하는 중으로 본다(더하지 않는다)
    await uc.execute(cmd);
    expect(log.entries).toHaveLength(0);
    clock.advance(SESSION_STARTED_GRACE_MS);
    const again = await uc.execute(cmd);
    expect(again).toEqual({ ...first, created: false });
    expect(log.entries).toEqual<SessionStartedEntry[]>([{ eventId: 'ev-1', purchaseSessionId: jti, admissionJti: jti, journeyId: JNY, startedAtMs: first.startedAtMs, maxStayUntilMs: first.maxStayUntilMs }]);
    await uc.execute(cmd);
    await uc.execute(cmd);
    expect(log.entries).toHaveLength(1);
  });

  test('ADR0183_11_ST35_더하기는 됐는데 기록 표시(markStarted)가 실패하면 열기는 성공이고, 다음 재시도가 같은 사건을 한 번 더 더한다(중복은 eventKey로 거른다). 표시가 되면 멈춘다', async () => {
    const { uc, log, store, warnings, clock } = setup();
    const { cmd } = command();
    const ok = store.markStarted.bind(store);
    store.markStarted = async () => {
      throw new SeatStoreUnavailable(new Error('down'));
    };
    const first = await uc.execute(cmd);
    expect(first.created).toBe(true);
    expect(log.entries).toHaveLength(1);
    expect(warnings.filter((w) => w.msg.includes('표시'))).toHaveLength(1);
    store.markStarted = ok;
    clock.advance(SESSION_STARTED_GRACE_MS);
    await uc.execute(cmd);
    expect(log.entries).toHaveLength(2);
    expect(log.entries[1]).toEqual(log.entries[0]);
    await uc.execute(cmd);
    expect(log.entries).toHaveLength(2);
  });

  test('ADR0183_8_같은 jti로 다시 받은 입장 토큰(더 늦은 exp)은 REPLAY이고 결과의 최대 체류는 처음 세션의 값이다. 시작 사건을 더하지 않는다', async () => {
    const { uc, log, clock } = setup();
    const { jti, cmd, client } = command();
    const first = await uc.execute(cmd);
    clock.advance(44 * 60_000);
    // queue-svc가 자리가 살아 있는 동안 같은 jti로 다시 준 토큰: iat이 44분 뒤라 exp도 44분 늦다
    const reissued = { ...cmd, token: signAdmission(K1, claimsOf({ nowMs: NOW + 44 * 60_000, jti })), clientKey: client.text };
    const again = await uc.execute(reissued);
    expect(again.created).toBe(false);
    expect(again.maxStayUntilMs).toBe(first.maxStayUntilMs);
    expect(log.entries).toHaveLength(1);
    // 처음 최대 체류가 지나면 다시 받은 토큰의 exp가 남아 있어도 열지 못한다(세션 상태 키가 남은 60초 동안은 TOKEN_EXPIRED)
    clock.advance(60_000);
    expect(await codeOf(uc.execute(reissued))).toBe('TOKEN_EXPIRED');
    // 세션 상태 키가 사라진 뒤에는 표지가 남아 있어 같은 jti로 새 세션을 열지 못한다(TOKEN_USED). 열린 세션이 없으니 시작 사건도 더하지 않는다
    clock.advance(SESSION_KEY_GRACE_MS + 1);
    expect(await codeOf(uc.execute(reissued))).toBe('TOKEN_USED');
    expect(log.entries).toHaveLength(1);
  });

  test('ASVS16.2.5_열기 저장소의 쓰기 전 지킴 오류(PEAKET_CORRUPT_KEY s:session:{jti})는 키 이름 없이 코드만 담은 SessionStoreFailure로 던진다. 좌석 Redis 장애는 그대로 던진다 [ASVS v5.0.0-16.2.5]', async () => {
    const { uc, store } = setup();
    const { jti, cmd } = command();
    store.open = async () => {
      throw new Error(`ERR PEAKET_CORRUPT_KEY s:session:{${jti}}`);
    };
    const err = await uc.execute(cmd).then(
      () => undefined,
      (x: unknown) => x,
    );
    expect(err).toBeInstanceOf(SessionStoreFailure);
    expect((err as SessionStoreFailure).code).toBe('CORRUPT_KEY');
    expect((err as Error).message).not.toContain(jti);
    expect((err as Error).cause).toBeUndefined();

    const down = new SeatStoreUnavailable(new Error('down'));
    store.open = async () => {
      throw down;
    };
    await expect(uc.execute(cmd)).rejects.toBe(down);
  });
});

import type { OpenSessionCommand } from '../src/modules/inventory/index.js';

describe('키 없는 재요청(BUILD_ORDER PRF-137: 세션이 열린 뒤에는 X-Client-Ephemeral-Key 없이 와도 열린다)', () => {
  /** 키를 뺀 같은 요청 */
  const keyless = (c: { cmd: unknown }): OpenSessionCommand => ({ ...(c.cmd as OpenSessionCommand), clientKey: undefined });

  test('ST28_ADR0183_8_세션이 없는데 clientKey가 없으면 CLIENT_KEY_INVALID(400)이고 저장소에 쓴 것이 없다: 키를 주고 다시 열면 새로 열린다', async () => {
    const { uc, store, log, warnings } = setup();
    const { jti, cmd } = command();
    expect(await codeOf(uc.execute(keyless({ cmd })))).toBe('CLIENT_KEY_INVALID');
    expect(await store.read(jti)).toBeUndefined();
    expect(log.entries).toHaveLength(0);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.obj).toMatchObject({ code: 'CLIENT_KEY_INVALID', eventId: 'ev-1' });
    const text = JSON.stringify(warnings);
    expect(text).not.toContain('acct-1');
    expect(text).not.toContain('login-1');
    // 표지가 남지 않았다
    const out = await uc.execute(cmd);
    expect(out.created).toBe(true);
    expect(log.entries).toHaveLength(1);
  });

  test('ST28_ADR0183_8_세션이 열린 뒤 clientKey를 안 보내면 REPLAY로 열린다: 같은 세션을 주고(created false) SESSION_STARTED를 더 더하지 않으며 저장된 임시 공개키는 그대로다', async () => {
    const { uc, store, log } = setup();
    const { jti, cmd, client } = command();
    const first = await uc.execute(cmd);
    const before = await store.read(jti);
    const again = await uc.execute(keyless({ cmd }));
    expect(again).toEqual({ ...first, created: false });
    expect(log.entries).toHaveLength(1);
    expect(await store.read(jti)).toEqual(before);
    expect((await store.read(jti))?.clientKey).toBe(client.text);
    // 키를 보내는 재요청도 같은 키면 여전히 REPLAY다
    expect((await uc.execute(cmd)).created).toBe(false);
  });

  test('ADR0183_11_ST35_키 없는 재요청도 시작 사건을 지킨다: 더하기가 실패한 채 응답을 잃으면 유예(1초) 뒤의 키 없는 재요청이 SESSION_STARTED를 다시 더하고, 더한 뒤에는 더하지 않는다', async () => {
    const { uc, log, clock } = setup({ logFails: true });
    const { cmd, jti } = command();
    const first = await uc.execute(cmd);
    expect(log.entries).toHaveLength(0);
    log.failWith = undefined;
    await uc.execute(keyless({ cmd })); // 유예 안: 처음 연 요청이 더하는 중으로 본다
    expect(log.entries).toHaveLength(0);
    clock.advance(SESSION_STARTED_GRACE_MS);
    const again = await uc.execute(keyless({ cmd }));
    expect(again).toEqual({ ...first, created: false });
    expect(log.entries).toEqual<SessionStartedEntry[]>([{ eventId: 'ev-1', purchaseSessionId: jti, admissionJti: jti, journeyId: JNY, startedAtMs: first.startedAtMs, maxStayUntilMs: first.maxStayUntilMs }]);
    await uc.execute(keyless({ cmd }));
    expect(log.entries).toHaveLength(1);
  });

  test('ADR0183_8_세션이 열린 뒤에는 첫 사용 기한이 지나도 키 없는 재요청이 열린다. 기한이 지난 뒤 세션이 없는 키 없는 요청은 FIRST_USE_EXPIRED다', async () => {
    const { uc, clock } = setup();
    const { cmd } = command();
    await uc.execute(cmd);
    clock.advance(FIRST_USE_MS + 1_000);
    expect((await uc.execute(keyless({ cmd }))).created).toBe(false);

    const late = setup();
    const b = command();
    late.clock.advance(FIRST_USE_MS + 1);
    expect(await codeOf(late.uc.execute(keyless(b)))).toBe('FIRST_USE_EXPIRED');
    expect(await late.store.read(b.jti)).toBeUndefined();
  });

  test('ASVS9.2.1_키 없는 재요청도 exp가 지났으면 TOKEN_EXPIRED다 [ASVS v5.0.0-9.2.1]', async () => {
    const { uc, clock } = setup();
    const { cmd } = command();
    await uc.execute(cmd);
    clock.advance(45 * 60_000);
    expect(await codeOf(uc.execute(keyless({ cmd })))).toBe('TOKEN_EXPIRED');
  });

  test('ASVS8.2.1_ASVS8.2.2_키 없는 재요청도 입장 토큰 검사가 먼저다: 남의 토큰은 TOKEN_MISMATCH, 다른 회차는 EVENT_MISMATCH, 서명이 틀리면 TOKEN_INVALID이고 열린 세션은 그대로다 [ASVS v5.0.0-8.2.1] [ASVS v5.0.0-8.2.2]', async () => {
    const { uc, store } = setup();
    const { jti, cmd } = command();
    await uc.execute(cmd);
    const before = await store.read(jti);
    expect(await codeOf(uc.execute({ ...keyless({ cmd }), accountId: 'acct-2' }))).toBe('TOKEN_MISMATCH');
    expect(await codeOf(uc.execute({ ...keyless({ cmd }), loginSessionId: 'login-2' }))).toBe('TOKEN_MISMATCH');
    expect(await codeOf(uc.execute({ ...keyless({ cmd }), eventId: 'ev-2' }))).toBe('EVENT_MISMATCH');
    expect(await codeOf(uc.execute({ ...keyless({ cmd }), token: 'not-a-token' }))).toBe('TOKEN_INVALID');
    expect(await store.read(jti)).toEqual(before);
  });

  test('ADR0183_8_끝난 세션(세션 상태만 사라짐)에 키 없이 다시 열면 TOKEN_USED이고 세션을 되살리지 않는다', async () => {
    const { uc, store, log } = setup();
    const { jti, cmd } = command();
    await uc.execute(cmd);
    store.endSession(jti);
    expect(await codeOf(uc.execute(keyless({ cmd })))).toBe('TOKEN_USED');
    expect(await store.read(jti)).toBeUndefined();
    expect(log.entries).toHaveLength(1);
  });

  test('ST28_ASVS8.2.1_열린 뒤 clientKey를 보냈는데 곡선 위의 점이 아니면(87자 base64url 모양이어도) CLIENT_KEY_INVALID(400)이고 세션은 그대로다 [ASVS v5.0.0-8.2.1]', async () => {
    const { uc, store, log } = setup();
    const { jti, cmd } = command();
    await uc.execute(cmd);
    const before = await store.read(jti);
    for (const clientKey of ['A'.repeat(87), 'AAAA', Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 1)]).toString('base64url')]) {
      expect(await codeOf(uc.execute({ ...cmd, clientKey })), clientKey).toBe('CLIENT_KEY_INVALID');
    }
    expect(await store.read(jti)).toEqual(before);
    expect(log.entries).toHaveLength(1);
  });

  test('ADR0183_8_열린 뒤 다른 유효한 clientKey를 보내면 TOKEN_USED(401)이다(남의 키로 서명하게 두지 않는다). 세션은 그대로다', async () => {
    const { uc, store } = setup();
    const { jti, cmd } = command();
    await uc.execute(cmd);
    const before = await store.read(jti);
    expect(await codeOf(uc.execute({ ...cmd, clientKey: clientKeyOf().text }))).toBe('TOKEN_USED');
    expect(await store.read(jti)).toEqual(before);
  });

  test('ST28_clientKey가 빈 글(\'\')이면 \'보낸 것\'이라 CLIENT_KEY_INVALID다(키 없음이 아니다): 세션이 없든 열려 있든 REPLAY로 열리지 않는다', async () => {
    const none = setup();
    const a = command();
    expect(await codeOf(none.uc.execute({ ...a.cmd, clientKey: '' }))).toBe('CLIENT_KEY_INVALID');
    expect(await none.store.read(a.jti)).toBeUndefined();

    const open = setup();
    const b = command();
    await open.uc.execute(b.cmd);
    const before = await open.store.read(b.jti);
    expect(await codeOf(open.uc.execute({ ...b.cmd, clientKey: '' }))).toBe('CLIENT_KEY_INVALID');
    expect(await open.store.read(b.jti)).toEqual(before);
    expect(open.log.entries).toHaveLength(1);
  });
});
