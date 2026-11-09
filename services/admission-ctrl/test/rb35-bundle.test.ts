// RB-35 명령 묶음의 정규화와 서명 확인(Q-T27의 CLI 몫, ADR-0239 결정 7, ADR-0053 결정 11).
import { describe, expect, test } from 'vitest';
import { canonicalize, commanderKeysFromEnv, parseSigned, verifySigned } from '../src/modules/rb35/index.js';
import { bundleOf, keysEnv, keysOf, NOW, operator, signAs, signedBy } from './rb35-support.js';

const a = operator('commander-a');
const b = operator('commander-b');
const op = operator('operator-c', 'operator');
const keys = keysOf(a, b, op);

describe('RFC 8785 정규화', () => {
  test('RFC 8785 §3.2.3의 키 순서(UTF-16 코드 단위)대로 줄을 세운다', () => {
    const v = { '\u20ac': 'Euro Sign', '\r': 'Carriage Return', '\ufb33': 'Hebrew Letter Dalet With Dagesh', '1': 'One', '\ud83d\ude00': 'Emoji: Grinning Face', '\u0080': 'Control', '\u00f6': 'Latin Small Letter O With Diaeresis' };
    expect(canonicalize(v)).toBe('{"\\r":"Carriage Return","1":"One","\u0080":"Control","\u00f6":"Latin Small Letter O With Diaeresis","\u20ac":"Euro Sign","\ud83d\ude00":"Emoji: Grinning Face","\ufb33":"Hebrew Letter Dalet With Dagesh"}');
  });

  test('빈칸과 키 순서가 달라도 같은 바이트가 된다', () => {
    expect(canonicalize({ b: 1, a: [{ z: null, y: 'x' }, true] })).toBe('{"a":[{"y":"x","z":null},true],"b":1}');
  });

  test('안전한 정수가 아닌 수와 지원하지 않는 값은 던진다', () => {
    expect(() => canonicalize({ a: 1.5 })).toThrow();
    expect(() => canonicalize({ a: 2 ** 53 })).toThrow();
    expect(() => canonicalize({ a: undefined })).toThrow();
  });
});

describe('verifySigned', () => {
  test('[ASVS v5.0.0-11.6.1] Q-T27 서로 다른 commander 두 명이면 통과한다', () => {
    expect(verifySigned(signedBy(bundleOf(), a, b), keys, NOW + 1_000)).toEqual({ ok: true });
  });

  test('Q-T27 서명 하나는 거절한다', () => {
    expect(verifySigned(signedBy(bundleOf(), a), keys, NOW + 1_000)).toEqual({ ok: false, reason: 'two_commanders' });
  });

  test('Q-T27 같은 commander의 두 서명은 거절한다', () => {
    expect(verifySigned(signedBy(bundleOf(), a, a), keys, NOW + 1_000)).toEqual({ ok: false, reason: 'two_commanders' });
  });

  test('Q-T27 commander가 아닌 서명이 섞이면 거절한다', () => {
    expect(verifySigned(signedBy(bundleOf(), a, op), keys, NOW + 1_000)).toEqual({ ok: false, reason: 'not_commander' });
    expect(verifySigned(signedBy(bundleOf(), a, b, op), keys, NOW + 1_000)).toEqual({ ok: false, reason: 'not_commander' });
  });

  test('Q-T27 모르는 서명자는 거절한다', () => {
    expect(verifySigned(signedBy(bundleOf(), a, operator('stranger')), keys, NOW + 1_000)).toEqual({ ok: false, reason: 'unknown_signer' });
  });

  test('Q-T27 서명이 만료되면 거절한다', () => {
    const s = signedBy(bundleOf(), a, b);
    expect(verifySigned(s, keys, NOW + 300_000).ok).toBe(true);
    expect(verifySigned(s, keys, NOW + 300_001)).toEqual({ ok: false, reason: 'expired' });
  });

  test('Q-T27 유효 기간이 5분보다 길면 서명을 봐도 거절한다', () => {
    expect(verifySigned(signedBy(bundleOf({ expiresAt: NOW + 300_001 }), a, b), keys, NOW)).toEqual({ ok: false, reason: 'window' });
    expect(verifySigned(signedBy(bundleOf({ issuedAt: NOW + 10_000, expiresAt: NOW + 5_000 }), a, b), keys, NOW)).toEqual({ ok: false, reason: 'window' });
  });

  test('Q-T27 미래에 만든 묶음은 시계 차이 30초까지만 받는다', () => {
    const s = signedBy(bundleOf({ issuedAt: NOW + 30_000, expiresAt: NOW + 330_000 }), a, b);
    expect(verifySigned(s, keys, NOW).ok).toBe(true);
    expect(verifySigned(signedBy(bundleOf({ issuedAt: NOW + 30_001, expiresAt: NOW + 330_001 }), a, b), keys, NOW)).toEqual({ ok: false, reason: 'not_yet_valid' });
  });

  test('[ASVS v5.0.0-11.6.1] Q-T27 서명 대상을 바꿔치기하면 거절한다', () => {
    const s = signedBy(bundleOf(), a, b);
    for (const tampered of [
      { ...s.bundle, target: { eventId: 'evt-other', group: 'lobby' as const } },
      { ...s.bundle, command: 'rb35.wait' as const },
      { ...s.bundle, params: { ...s.bundle.params, reason: '다른 사유' } },
      { ...s.bundle, params: { ...s.bundle.params, stop: `${NOW}:beacon` } },
      { ...s.bundle, expiresAt: NOW + 200_000 },
    ]) {
      expect(verifySigned({ ...s, bundle: tampered }, keys, NOW + 1)).toEqual({ ok: false, reason: 'bad_signature' });
    }
  });

  test('Q-T27 다른 사람의 서명을 내 이름으로 붙여도 거절한다', () => {
    const bundle = bundleOf();
    expect(verifySigned({ bundle, signatures: [{ signer: 'commander-a', sig: signAs(b, bundle).sig }, signAs(b, bundle)] }, keys, NOW + 1)).toEqual({ ok: false, reason: 'bad_signature' });
  });

  test('서명 base64가 깨져도 예외 없이 거절한다', () => {
    const bundle = bundleOf();
    expect(verifySigned({ bundle, signatures: [{ signer: 'commander-a', sig: '%%%' }, signAs(b, bundle)] }, keys, NOW + 1)).toEqual({ ok: false, reason: 'bad_signature' });
  });
});

describe('parseSigned', () => {
  test('맞는 모양만 받는다', () => {
    const s = signedBy(bundleOf(), a, b);
    expect(parseSigned(JSON.parse(JSON.stringify(s)))).toEqual(s);
    expect(parseSigned(null)).toBeNull();
    expect(parseSigned({ bundle: { ...s.bundle, v: 2 }, signatures: s.signatures })).toBeNull();
    expect(parseSigned({ bundle: { ...s.bundle, command: 'x' }, signatures: s.signatures })).toBeNull();
    expect(parseSigned({ bundle: { ...s.bundle, commandId: 'not-uuid' }, signatures: s.signatures })).toBeNull();
    expect(parseSigned({ bundle: { ...s.bundle, target: { eventId: 'bad/id', group: 'lobby' } }, signatures: s.signatures })).toBeNull();
    expect(parseSigned({ bundle: s.bundle, signatures: 'x' })).toBeNull();
  });

  test('[ASVS v5.0.0-11.6.1] 모르는 칸은 어디든 거절한다', () => {
    const s = JSON.parse(JSON.stringify(signedBy(bundleOf(), a, b))) as { bundle: Record<string, unknown> & { target: object; params: object }; signatures: object[] };
    expect(parseSigned(s)).not.toBeNull();
    expect(parseSigned({ ...s, extra: 1 })).toBeNull();
    expect(parseSigned({ ...s, bundle: { ...s.bundle, extra: 1 } })).toBeNull();
    expect(parseSigned({ ...s, bundle: { ...s.bundle, target: { ...s.bundle.target, extra: 1 } } })).toBeNull();
    expect(parseSigned({ ...s, bundle: { ...s.bundle, params: { ...s.bundle.params, extra: 1 } } })).toBeNull();
    expect(parseSigned({ ...s, signatures: [{ ...s.signatures[0], extra: 1 }, s.signatures[1]] })).toBeNull();
  });

  test('사유는 1~200자 한 줄이다', () => {
    const s = (reason: string) => parseSigned(JSON.parse(JSON.stringify(signedBy(bundleOf({ params: { reason } }), a, b))));
    expect(s('사유')).not.toBeNull();
    expect(s('가'.repeat(200))).not.toBeNull();
    expect(s('')).toBeNull();
    expect(s('가'.repeat(201))).toBeNull();
    expect(s('줄\n바꿈')).toBeNull();
    expect(s('\u0000nul')).toBeNull();
  });
});

describe('commanderKeysFromEnv', () => {
  test('운영자 목록을 읽는다', () => {
    const m = commanderKeysFromEnv(keysEnv(a, b, op));
    expect([...m.keys()]).toEqual(['commander-a', 'commander-b', 'operator-c']);
    expect(m.get('operator-c')?.role).toBe('operator');
  });

  test.each([
    ['JSON이 아님', 'not json'],
    ['배열이 아님', '{}'],
    ['빈 목록', '[]'],
    ['role 없음', JSON.stringify([{ id: 'a', publicKey: 'AA==' }])],
    ['깨진 공개키', JSON.stringify([{ id: 'a', role: 'commander', publicKey: 'AA==' }])],
  ])('[ASVS v5.0.0-11.6.1] 틀린 설정은 시작하지 않는다: %s', (_n, raw) => {
    expect(() => commanderKeysFromEnv(raw)).toThrow();
  });

  test('[ASVS v5.0.0-11.6.1] 같은 공개키를 둔 두 ID는 시작하지 않는다', () => {
    expect(() => commanderKeysFromEnv(keysEnv(a, { ...a, id: 'commander-a2' }))).toThrow(/같은 공개키/);
  });

  test('[ASVS v5.0.0-11.6.1] 같은 키를 압축 형식으로 넣어도 같은 공개키로 본다', async () => {
    const { ECDH } = await import('node:crypto');
    const der = a.publicKey.export({ format: 'der', type: 'spki' });
    const comp = ECDH.convertKey(der.subarray(26), 'prime256v1', undefined, undefined, 'compressed') as Buffer;
    const compDer = Buffer.concat([Buffer.from('3039301306072a8648ce3d020106082a8648ce3d030107032200', 'hex'), comp]);
    expect(() => commanderKeysFromEnv(JSON.stringify([{ id: 'x', role: 'commander', publicKey: der.toString('base64') }, { id: 'y', role: 'commander', publicKey: compDer.toString('base64') }]))).toThrow(/같은 공개키/);
  });

  test('[ASVS v5.0.0-11.6.1] P-256이 아닌 키는 받지 않는다', async () => {
    const { generateKeyPairSync } = await import('node:crypto');
    const k = generateKeyPairSync('ec', { namedCurve: 'secp384r1' }).publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
    expect(() => commanderKeysFromEnv(JSON.stringify([{ id: 'x', role: 'commander', publicKey: k }]))).toThrow(/P-256/);
  });
});
