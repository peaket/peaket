// 사전 검증 토큰·대기표의 HMAC 형식(docs/features/queue-admission.md §3 '첫 구현의 세부', ASVS v5.0.0-9.1.x·9.2.x, ADR-0053 결정 13)
import { describe, expect, test } from 'vitest';
import { HmacQueueTokens, QUEUE_TOKEN_KEY_ENV, QUEUE_TOKEN_KEY_PREVIOUS_ENV } from '../src/modules/entry/adapters/hmac-tokens.js';
import type { PreverifyClaims, TicketClaims } from '../src/modules/entry/domain/queue.js';

const KEY_A = Buffer.alloc(32, 7).toString('base64');
const KEY_B = Buffer.alloc(32, 9).toString('base64');
const tokens = HmacQueueTokens.fromEnv({ [QUEUE_TOKEN_KEY_ENV]: `k1:${KEY_A}` });

const pre: PreverifyClaims = { e: 'ev-1', a: '0190f3a1-7c2e-7a00-8000-000000000001', d: 'dev-1', i0: 1_000, iat: 2_000, exp: 902_000, jny: '0190f3a1-7c2e-7a00-8000-0000000000aa' };
const ticket: TicketClaims = { e: 'ev-1', a: pre.a, d: 'dev-1', s: 1234, g: 1, seg: 1, rq: '6f1c2c1e-1d2b-4c43-9a43-2d5c8f0a0b11', jny: pre.jny };

const parts = (t: string) => t.split('.');
const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');

describe('형식', () => {
  test('[ASVS v5.0.0-9.1.1] 사전검증토큰은_v1.kid.본문.MAC이고_MAC이맞을때만_본문을돌려준다', () => {
    const t = tokens.preverify(pre);
    expect(parts(t)).toHaveLength(4);
    expect(parts(t).slice(0, 2)).toEqual(['v1', 'k1']);
    expect(tokens.readPreverify(t)).toEqual(pre);
    const [v, kid, , mac] = parts(t);
    expect(tokens.readPreverify([v, kid, b64({ ...pre, a: 'someone-else' }), mac].join('.'))).toBeNull();
  });

  test('[ASVS v5.0.0-9.1.1] Q-T60_jny만바꾼토큰은_서명불일치로거절한다', () => {
    const [v, kid, , mac] = parts(tokens.preverify(pre));
    expect(tokens.readPreverify([v, kid, b64({ ...pre, jny: '0190f3a1-7c2e-7a00-8000-0000000000bb' }), mac].join('.'))).toBeNull();
    const [tv, tkid, , tmac] = parts(tokens.ticket(ticket));
    expect(tokens.readTicket([tv, tkid, b64({ ...ticket, jny: '0190f3a1-7c2e-7a00-8000-0000000000bb' }), tmac].join('.'))).toBeNull();
  });

  test('[ASVS v5.0.0-9.1.2] 형식버전v1밖과_모양이틀린토큰은_거절한다', () => {
    const [, kid, body, mac] = parts(tokens.preverify(pre));
    for (const bad of [`v2.${kid}.${body}.${mac}`, `none.${kid}.${body}.${mac}`, `v1.${kid}.${body}`, '', 'v1..x.y', `v1.${kid}.${body}.${mac}.extra`]) {
      expect(tokens.readPreverify(bad)).toBeNull();
    }
  });

  test('[ASVS v5.0.0-9.1.2] 같은바이트로읽히는MAC변형(덧붙인=·끝글자의쓰지않는비트)은_거절한다_대기표의정체가문자열해시라서다', () => {
    const t = tokens.ticket(ticket);
    const [v, kid, body, mac] = parts(t);
    const ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const last = mac.at(-1)!;
    const flipped = mac.slice(0, -1) + ALPHA[ALPHA.indexOf(last) ^ 1];
    expect(Buffer.from(flipped, 'base64url').equals(Buffer.from(mac, 'base64url'))).toBe(true);
    for (const m of [`${mac}=`, flipped, mac.replace(/-/g, '+').replace(/_/g, '/'), `${mac.slice(0, 10)}
${mac.slice(10)}`]) {
      if (m === mac) continue;
      expect(tokens.readTicket([v, kid, body, m].join('.'))).toBeNull();
    }
    expect(tokens.readTicket(t)).toEqual(ticket);
  });

  test('[ASVS v5.0.0-9.1.3] kid가키목록에없으면_거절하고_이전키는검증만한다', () => {
    const old = HmacQueueTokens.fromEnv({ [QUEUE_TOKEN_KEY_ENV]: `k0:${KEY_B}` });
    const oldToken = old.preverify(pre);
    expect(tokens.readPreverify(oldToken)).toBeNull();
    const rotated = HmacQueueTokens.fromEnv({ [QUEUE_TOKEN_KEY_ENV]: `k1:${KEY_A}`, [QUEUE_TOKEN_KEY_PREVIOUS_ENV]: `k0:${KEY_B}` });
    expect(rotated.readPreverify(oldToken)).toEqual(pre);
    expect(parts(rotated.preverify(pre))[1]).toBe('k1');
  });

  test('[ASVS v5.0.0-9.2.2] 종류문자열이달라_사전검증토큰과대기표를_서로바꿔쓰지못한다', () => {
    const t = tokens.preverify(pre);
    const q = tokens.ticket(ticket);
    expect(tokens.readTicket(t)).toBeNull();
    expect(tokens.readPreverify(q)).toBeNull();
    expect(tokens.readTicket(q)).toEqual(ticket);
  });

  test('같은클레임의대기표는_같은문자열이다_응답을잃은재시도가같은해시를받는다', () => {
    expect(tokens.ticket(ticket)).toBe(tokens.ticket({ ...ticket }));
    expect(tokens.hash(tokens.ticket(ticket))).toMatch(/^[0-9a-f]{64}$/);
  });

  test('본문의형이틀리면_MAC이맞아도_거절한다', () => {
    const bad = { ...pre, i0: 'x' } as unknown as PreverifyClaims;
    expect(tokens.readPreverify(tokens.preverify(bad))).toBeNull();
  });
});

describe('설정', () => {
  test('키는32바이트이상이고_kid형식이맞아야한다_값은오류문구에싣지않는다', () => {
    expect(() => HmacQueueTokens.fromEnv({})).toThrow(QUEUE_TOKEN_KEY_ENV);
    expect(() => HmacQueueTokens.fromEnv({ [QUEUE_TOKEN_KEY_ENV]: `k1:${Buffer.alloc(16, 1).toString('base64')}` })).toThrow(/32바이트/);
    expect(() => HmacQueueTokens.fromEnv({ [QUEUE_TOKEN_KEY_ENV]: `bad kid:${KEY_A}` })).toThrow(/kid/);
    try {
      HmacQueueTokens.fromEnv({ [QUEUE_TOKEN_KEY_ENV]: `k1:${Buffer.alloc(16, 1).toString('base64')}` });
    } catch (e) {
      expect((e as Error).message).not.toContain(Buffer.alloc(16, 1).toString('base64'));
    }
  });
});
