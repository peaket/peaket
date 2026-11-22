// 입장 키 알림 보내기 반복 단위 시험(BUILD_ORDER GAT-020, F-05-1, docs/features/offline-gate.md §11 O-T48·§10.1, ADR-0363 결정 4,
// docs/features/notify.md §4.7, docs/data.md device_key_notice).
// - 조립은 시작 파일과 같은 함수(start.ts assembleDeviceKeys)다. 보내는 어댑터는 진짜 HttpDeviceKeyNoticeSink이고, 바꿔 끼우는 것은
//   core-svc 내부 입구 앞의 fetch 경계(가짜 core)·시계·기기 키 저장소(MemoryDeviceKeyStore, DrizzleDeviceKeyStore의 짝 가짜)·재인증 확인(ReauthGate 포트)이다.
//   행이 등록과 같은 트랜잭션에 생기는지·잠금 임대는 test-int/device-key-reissue.int.test.ts가 실제 PostgreSQL에서 본다.
// - 단언 값은 정본 글에서 적는다: 본문 다섯 칸(notify §4.7), 2xx·422면 보냄, 그 밖은 1분·5분·30분 뒤 다시(ADR-0363 결정 4), 보낸 행 7일 뒤 지움(data.md).
import { fakeClock } from '@peaket/platform';
import { exportJWK, generateKeyPair } from 'jose';
import { describe, expect, test } from 'vitest';
import { MemoryDeviceKeyStore } from '../src/modules/ticket/adapters/memory-device-key-store.js';
import type { ReauthGate } from '../src/modules/ticket/application/device-keys.js';
import type { PublicKeyJwk } from '../src/modules/ticket/domain/device-key.js';
import { assembleDeviceKeys } from '../src/start.js';

/** 시험 시각(KST 2026-11-23 21:41:07.000) */
const T0 = Date.parse('2026-11-23T12:41:07.000Z');
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const CORE = 'http://core-svc.f051.test:7311';
const INTERNAL_TOKEN = 'f051-internal-token-7d1c';
const ACCOUNT = '0193f2c0-0000-7000-8000-00000000a051';
const EVENT = '0193f2c0-0000-7000-8000-00000000a052';
const BEFORE = '0193f2c0-0000-7000-8000-00000000a101';
const AFTER_EMPTY = '0193f2c0-0000-7000-8000-00000000a102';
const SAME = '0193f2c0-0000-7000-8000-00000000a103';
const SESSION = '0193f2c0-0000-7000-8000-00000000a104';

async function deviceJwk(): Promise<PublicKeyJwk> {
  return (await exportJWK((await generateKeyPair('ES256', { extractable: true })).publicKey)) as PublicKeyJwk;
}

interface CoreCall {
  url: string;
  method: string | undefined;
  headers: Record<string, string>;
  body: unknown;
}

/** core-svc 내부 입구 앞의 fetch 경계. answers를 차례로 쓰고 다 쓰면 202 */
function fakeCore(answers: (number | 'disconnect')[] = []) {
  const calls: CoreCall[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    calls.push({ url, method: init?.method, headers, body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body });
    const a = answers.shift() ?? 202;
    if (a === 'disconnect') throw new TypeError('fetch failed');
    if (a === 204) return new Response(null, { status: 204 });
    return new Response(a === 202 ? JSON.stringify({ created: 1, duplicate: 0 }) : JSON.stringify({ type: 'about:blank', status: a }), {
      status: a,
      headers: { 'content-type': a === 202 ? 'application/json' : 'application/problem+json' },
    });
  };
  return { calls, fetchImpl };
}

/** 시험마다 새 조립(TA-V01). 재인증 확인은 '통과'만 주는 포트 구현(확인기 자체는 device-key-reauth.test.ts가 본다) */
function harness(answers: (number | 'disconnect')[] = []) {
  const clock = fakeClock({ now: T0 });
  const store = new MemoryDeviceKeyStore();
  const core = fakeCore(answers);
  const reauth: ReauthGate = { verify: async (token) => token === 'ok' };
  const sent: ('sent' | 'retry')[] = [];
  const { deviceKeys, notices } = assembleDeviceKeys({ store, reauth, clock, coreHttpUrl: CORE, internalToken: INTERNAL_TOKEN, fetch: core.fetchImpl, observeNotice: (r) => sent.push(r) });
  if (!notices) throw new Error('core-svc 주소를 줬는데 보내기 반복을 만들지 않았다');
  store.seedTicket({ ticketId: BEFORE, eventId: EVENT, accountId: ACCOUNT, payerAccountId: ACCOUNT, eventStartsAtMs: T0 + 3 * DAY });
  store.seedTicket({ ticketId: AFTER_EMPTY, eventId: EVENT, accountId: ACCOUNT, payerAccountId: ACCOUNT, eventStartsAtMs: T0 - MIN });
  store.seedTicket({ ticketId: SAME, eventId: EVENT, accountId: ACCOUNT, payerAccountId: ACCOUNT, eventStartsAtMs: T0 + 3 * DAY });
  const to = (atMs: number) => clock.advance(atMs - clock.now());
  const reg = (ticketId: string, publicKeyJwk: PublicKeyJwk, reason: 'ISSUE' | 'REISSUE', token?: string) =>
    deviceKeys.register({ ticketId, accountId: ACCOUNT, sessionId: SESSION, publicKeyJwk, reason, ...(token ? { reauthToken: token } : {}) });
  return { clock, store, core, notices, sent, to, reg };
}

/** O-T48 차례: 첫 등록(알림 없음) → ② 재발급 성공 → ⑦ 입장 시작 뒤 첫 등록 성공 → 같은 키 다시 등록 → 실패한 등록 */
async function oT48Sequence(h: ReturnType<typeof harness>) {
  const a = await deviceJwk();
  const same = await deviceJwk();
  await h.reg(BEFORE, a, 'ISSUE');
  await h.reg(SAME, same, 'ISSUE');
  expect(h.store.notices).toHaveLength(0);
  const b = await deviceJwk();
  // ② 재발급(T0 + 1초)
  h.to(T0 + 1_000);
  const reissued = await h.reg(BEFORE, b, 'REISSUE', 'ok');
  // ⑦ 입장 시작 뒤 첫 등록(T0 + 2초)
  h.to(T0 + 2_000);
  const late = await h.reg(AFTER_EMPTY, await deviceJwk(), 'ISSUE', 'ok');
  // 같은 키 다시 등록(바뀌지 않음)과 실패한 등록(재인증 없는 다른 키)
  expect(await h.reg(SAME, same, 'ISSUE')).toEqual({ keyId: expect.any(String) });
  await expect(h.reg(SAME, await deviceJwk(), 'ISSUE')).rejects.toMatchObject({ code: 'REISSUE_REQUIRED' });
  await expect(h.reg(BEFORE, await deviceJwk(), 'REISSUE')).rejects.toMatchObject({ code: 'REISSUE_REQUIRED' });
  return { reissued, late };
}

describe('O-T48 입장 키 알림 보내기 [GAT-020]', () => {
  test('O-T48 성공한 재발급과 입장 시작 뒤 첫 등록만 알림 행을 남긴다(같은 키 다시 등록·실패는 0행)', async () => {
    const h = harness();
    await oT48Sequence(h);
    expect(h.store.notices.map((n) => ({ type: n.type, ticketId: n.ticketId, accountId: n.accountId, registeredAtMs: n.registeredAtMs }))).toEqual([
      { type: 'DEVICE_KEY_REISSUED', ticketId: BEFORE, accountId: ACCOUNT, registeredAtMs: T0 + 1_000 },
      { type: 'DEVICE_KEY_LATE_ISSUE', ticketId: AFTER_EMPTY, accountId: ACCOUNT, registeredAtMs: T0 + 2_000 },
    ]);
  });

  test('O-T48 core 503 두 번 뒤 되살리면 행마다 한 번 보내고 등록 응답은 201 그대로다', async () => {
    const h = harness([503, 503]);
    const { reissued, late } = await oT48Sequence(h);
    // 등록은 이미 끝났다(알림 실패와 상관없이 keyId를 돌려받았다)
    expect(reissued.keyId).toMatch(/^[A-Za-z0-9_-]{11}$/);
    expect(late.keyId).toMatch(/^[A-Za-z0-9_-]{11}$/);
    const first = await h.notices.runOnce();
    expect(first).toMatchObject({ attempted: 2, sent: 0, retried: 2 });
    // 1분 [가정] 뒤 다시: 1ms 전에는 보내지 않는다
    h.to(T0 + 2_000 + MIN - 1);
    expect(await h.notices.runOnce()).toMatchObject({ attempted: 0 });
    h.to(T0 + 2_000 + MIN);
    expect(await h.notices.runOnce()).toMatchObject({ attempted: 2, sent: 2, retried: 0 });
    // 보낸 행은 다시 보내지 않는다
    h.to(T0 + 60 * MIN);
    expect(await h.notices.runOnce()).toMatchObject({ attempted: 0 });
    expect(h.sent).toEqual(['retry', 'retry', 'sent', 'sent']);

    // 보낸 본문: 내부 입구 주소, 내부 토큰, notify §4.7의 다섯 칸만(이메일·공개키·keyId 없음)
    expect(h.core.calls).toHaveLength(4);
    for (const c of h.core.calls) {
      expect(c.url).toBe(`${CORE}/internal/v1/notify/ticket-events`);
      expect(c.method).toBe('POST');
      expect(c.headers['x-peaket-internal-token']).toBe(INTERNAL_TOKEN);
      expect(c.headers['content-type']).toBe('application/json');
    }
    const ids = h.store.notices.map((n) => n.id);
    const bodies = h.core.calls.slice(2).map((c) => c.body);
    expect(bodies).toEqual(
      expect.arrayContaining([
        { noticeId: ids[0], type: 'DEVICE_KEY_REISSUED', accountId: ACCOUNT, ticketId: BEFORE, registeredAtMs: T0 + 1_000 },
        { noticeId: ids[1], type: 'DEVICE_KEY_LATE_ISSUE', accountId: ACCOUNT, ticketId: AFTER_EMPTY, registeredAtMs: T0 + 2_000 },
      ]),
    );
    expect(bodies).toHaveLength(2);
    // 503 동안 보낸 본문과 되살린 뒤 보낸 본문은 같은 noticeId다(core가 중복 키로 하나만 적는다)
    expect(new Set(h.core.calls.map((c) => (c.body as { noticeId: string }).noticeId))).toEqual(new Set(ids));
  });

  test('O-T48 다시 보낼 간격은 1분·5분·30분이다(각 경계 1ms 전에는 보내지 않는다)', async () => {
    const h = harness([503, 503, 503, 503]);
    await h.reg(BEFORE, await deviceJwk(), 'ISSUE');
    await h.reg(BEFORE, await deviceJwk(), 'REISSUE', 'ok');
    expect(h.store.notices).toHaveLength(1);
    let at = T0;
    expect(await h.notices.runOnce()).toMatchObject({ attempted: 1, retried: 1 });
    for (const gap of [1 * MIN, 5 * MIN, 30 * MIN]) {
      h.to(at + gap - 1);
      expect(await h.notices.runOnce(), `간격 ${gap / MIN}분 1ms 전`).toMatchObject({ attempted: 0 });
      h.to(at + gap);
      expect(await h.notices.runOnce(), `간격 ${gap / MIN}분`).toMatchObject({ attempted: 1 });
      at += gap;
    }
    expect(h.core.calls).toHaveLength(4);
    expect(h.sent).toEqual(['retry', 'retry', 'retry', 'retry']);
  });

  test('O-T48 2xx·422는 보낸 것이고 401·연결 실패는 다시 보낸다', async () => {
    for (const [answer, outcome] of [
      [202, 'sent'],
      [204, 'sent'],
      [422, 'sent'],
      [401, 'retry'],
      [500, 'retry'],
      ['disconnect', 'retry'],
    ] as const) {
      const h = harness([answer]);
      await h.reg(BEFORE, await deviceJwk(), 'ISSUE');
      await h.reg(BEFORE, await deviceJwk(), 'REISSUE', 'ok');
      await h.notices.runOnce();
      expect(h.sent, String(answer)).toEqual([outcome]);
      expect((await h.notices.backlog()).count, String(answer)).toBe(outcome === 'sent' ? 0 : 1);
    }
  });

  test('O-T48 밀림 지표는 보내지 않은 행 수와 가장 오래된 행의 나이(초)이고, 보낸 행은 7일 뒤 지운다', async () => {
    const h = harness([503, 503]);
    await oT48Sequence(h);
    h.to(T0 + 91_000);
    expect(await h.notices.backlog()).toEqual({ count: 2, oldestSeconds: 90 });
    await h.notices.runOnce();
    h.to(T0 + 91_000 + MIN);
    await h.notices.runOnce();
    expect(await h.notices.backlog()).toEqual({ count: 0, oldestSeconds: 0 });
    const sentAt = T0 + 91_000 + MIN;
    h.to(sentAt + 7 * DAY - 1);
    expect(await h.notices.runOnce()).toMatchObject({ purged: 0 });
    expect(h.store.notices).toHaveLength(2);
    h.to(sentAt + 7 * DAY + 1);
    expect(await h.notices.runOnce()).toMatchObject({ purged: 2 });
    expect(h.store.notices).toHaveLength(0);
  });

  test('core-svc 주소가 없으면 보내기 반복을 만들지 않는다(행만 쌓인다)', () => {
    const store = new MemoryDeviceKeyStore();
    const out = assembleDeviceKeys({ store, reauth: { verify: async () => true }, clock: fakeClock({ now: T0 }) });
    expect(out.notices).toBeUndefined();
  });
});
