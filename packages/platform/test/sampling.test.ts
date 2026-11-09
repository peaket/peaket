// 정상 표본 문턱과 브라우저 계열(ADR-0125 결정 3, ADR-0069 결정 11, openspec 변경 add-service-logging 결정 2·3).
import { randomBytes } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { browserFamily, clientFamily, sampleKeep } from '../src/index.js';

const TWO56 = 2n ** 56n;
/** 앞 18자리는 아무 값, 끝 14자리(56비트)가 r인 trace ID */
const traceWithR = (r: bigint) => `${'ab'.repeat(9)}${r.toString(16).padStart(14, '0')}`;

describe('정상 표본 문턱', () => {
  test('ADR0125_문턱은_R이_1빼기1나누기N곱하기2의56승_이상이면_남긴다', () => {
    // (1 − 1/10) × 2^56 = 64851834634135142.4 → 그 이상인 가장 작은 정수
    const t = 64851834634135143n;
    expect(TWO56 - TWO56 / 10n).toBe(t);
    expect(sampleKeep(traceWithR(t), 10)).toBe(true);
    expect(sampleKeep(traceWithR(t - 1n), 10)).toBe(false);
    expect(sampleKeep(traceWithR(TWO56 - 1n), 10)).toBe(true);
    expect(sampleKeep(traceWithR(0n), 10)).toBe(false);
  });

  test('ADR0125_앞18자리는_결과에_영향이없다', () => {
    const tail = (64851834634135143n).toString(16).padStart(14, '0');
    expect(sampleKeep(`${'0'.repeat(18)}${tail}`, 10)).toBe(true);
    expect(sampleKeep(`${'f'.repeat(18)}${tail}`, 10)).toBe(true);
  });

  test('ADR0125_N이1이면_모두남긴다', () => {
    expect(sampleKeep(traceWithR(0n), 1)).toBe(true);
  });

  test('ADR0125_무작위_trace_만건의_남김비율은_1나누기N_근처다', () => {
    let kept = 0;
    for (let i = 0; i < 10_000; i++) if (sampleKeep(randomBytes(16).toString('hex'), 10)) kept++;
    // 기대 1,000, 표준편차 30. 5σ 밖이면 실패
    expect(kept).toBeGreaterThan(850);
    expect(kept).toBeLessThan(1150);
  });

  test.each([0, -1, 1.5, Number.NaN])('ADR0125_N이_양의정수가아니면(%s)_던진다', (n) => {
    expect(() => sampleKeep(traceWithR(1n), n)).toThrow(RangeError);
  });

  test.each(['', 'xyz', 'ab'.repeat(15)])('ADR0125_trace_ID가_32자리16진수가아니면(%s)_던진다', (id) => {
    expect(() => sampleKeep(id, 10)).toThrow(TypeError);
  });
});

describe('브라우저 계열(client)', () => {
  test.each([
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36', 'chrome/130'],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.2849.68', 'edge/130'],
    ['Mozilla/5.0 (Linux; Android 14; SM-S921N) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0.0.0 Mobile Safari/537.36', 'samsung/26'],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Whale/3.28.266.14 Safari/537.36', 'whale/3'],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 OPR/114.0.0.0', 'opera/114'],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0', 'firefox/132'],
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/132.0 Mobile/15E148 Safari/605.1.15', 'firefox/132'],
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0.6723.90 Mobile/15E148 Safari/604.1', 'chrome/130'],
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1', 'safari/18'],
    ['curl/8.10.1', 'other'],
    ['node', 'other'],
  ])('ADR0069_client는_계열과주판만(%#)', (ua, want) => {
    expect(clientFamily(ua)).toBe(want);
  });

  test('ADR0209_browserFamily는_client와같은판별로계열만준다(로그인한기기이름, BOT-044)', () => {
    expect(browserFamily('Mozilla/5.0 (Linux; Android 14; SM-S921N) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0.0.0 Mobile Safari/537.36')).toBe('samsung');
    expect(browserFamily('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.2849.68')).toBe('edge');
    expect(browserFamily('curl/8.10.1')).toBeUndefined();
    expect(browserFamily(null)).toBeUndefined();
  });

  test('ADR0069_User_Agent가없으면_칸을뺀다', () => {
    expect(clientFamily(undefined)).toBeUndefined();
    expect(clientFamily('')).toBeUndefined();
  });

  test('ADR0069_아주긴_User_Agent도_빨리끝난다', () => {
    const ua = `${'Mozilla/5.0 '.repeat(20_000)}Chrome/1`;
    const t = performance.now();
    expect(clientFamily(ua)).toBe('other');
    expect(performance.now() - t).toBeLessThan(200);
  });
});
