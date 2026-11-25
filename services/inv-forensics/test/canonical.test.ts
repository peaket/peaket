// FX-T14 ① 정규 JSON(RFC 8785) 모양. 동결 로컬 F-04-11.
import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { canonicalize, sha256Hex } from '../src/canonical.js';

describe('정규 JSON', () => {
  test('FX-T14 ① 키를 UTF-16 순으로 정렬하고 공백 없이 적는다', () => {
    expect(canonicalize({ b: 1, a: 2, A: 3, '10': 4, '2': 5 })).toBe('{"10":4,"2":5,"A":3,"a":2,"b":1}');
    expect(canonicalize({ z: [true, null, 'x'], a: { d: 1, c: [] } })).toBe('{"a":{"c":[],"d":1},"z":[true,null,"x"]}');
    expect(canonicalize('한"글\\')).toBe('"한\\"글\\\\"');
  });

  test('FX-T14 ① 수는 ECMAScript 표기를 쓰고 NaN·Infinity·undefined는 거절한다', () => {
    expect(canonicalize(1)).toBe('1');
    expect(canonicalize(-0)).toBe('0');
    expect(canonicalize(1.5)).toBe('1.5');
    expect(canonicalize(1e21)).toBe('1e+21');
    expect(() => canonicalize(Number.NaN)).toThrow(/유한/);
    expect(() => canonicalize(Number.POSITIVE_INFINITY)).toThrow(/유한/);
    expect(() => canonicalize(undefined)).toThrow(/undefined/);
    expect(() => canonicalize({ a: undefined })).toThrow(/undefined/);
  });

  test('FX-T14 ① SHA-256은 UTF-8 바이트로 계산한다', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256Hex('한')).toBe(createHash('sha256').update('한', 'utf8').digest('hex'));
  });
});
