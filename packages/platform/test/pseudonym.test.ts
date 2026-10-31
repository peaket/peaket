// 로그 가명과 IP 앞부분(ADR-0053 결정 1, docs/observability.md §2·§7, openspec 변경 add-service-logging 결정 4).
import { createHmac } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { PlatformConfigError, ipPrefix, loadLogPseudonymizer } from '../src/index.js';

const KEY = Buffer.alloc(32, 7);
const env = (e: Record<string, string>) => e;

describe('로그 가명', () => {
  test('[ASVS v5.0.0-16.2.5] ADR0053_가명은_HMAC_SHA256앞16바이트_base64url이다', () => {
    const { pseudonymizer } = loadLogPseudonymizer(env({ PEAKET_ENV: 'prod', PEAKET_LOG_PSEUDONYM_KEY: KEY.toString('base64') }));
    const want = createHmac('sha256', KEY).update('p-123', 'utf8').digest().subarray(0, 16).toString('base64url');
    expect(pseudonymizer.ref('p-123')).toBe(want);
    expect(pseudonymizer.ref('p-123')).toHaveLength(22);
    expect(pseudonymizer.ref('p-124')).not.toBe(want);
  });

  test('ADR0053_키는_base64url로도받는다', () => {
    const a = loadLogPseudonymizer(env({ PEAKET_ENV: 'prod', PEAKET_LOG_PSEUDONYM_KEY: KEY.toString('base64') })).pseudonymizer;
    const b = loadLogPseudonymizer(env({ PEAKET_ENV: 'prod', PEAKET_LOG_PSEUDONYM_KEY: KEY.toString('base64url') })).pseudonymizer;
    expect(a.ref('x')).toBe(b.ref('x'));
  });

  test.each(['prod', 'staging', 'demo', ''])('ADR0053_운영쪽환경(%s)에서_키가없으면_시작하지않는다', (e) => {
    expect(() => loadLogPseudonymizer(env({ PEAKET_ENV: e }))).toThrow(PlatformConfigError);
  });

  test.each([
    ['31바이트', Buffer.alloc(31, 1).toString('base64')],
    ['33바이트', Buffer.alloc(33, 1).toString('base64')],
    ['base64가 아님', '!!!!'],
  ])('ADR0053_키길이가_32바이트가아니면(%s)_시작하지않는다', (_n, value) => {
    expect(() => loadLogPseudonymizer(env({ PEAKET_ENV: 'local', PEAKET_LOG_PSEUDONYM_KEY: value }))).toThrow(PlatformConfigError);
  });

  test('ADR0053_로컬_CI는_키가없으면_프로세스마다_무작위키와_경고', () => {
    const a = loadLogPseudonymizer(env({ PEAKET_ENV: 'ci' }));
    const b = loadLogPseudonymizer(env({ PEAKET_ENV: 'local' }));
    expect(a.warning).toMatch(/PEAKET_LOG_PSEUDONYM_KEY/);
    expect(a.pseudonymizer.ref('x')).not.toBe(b.pseudonymizer.ref('x'));
    expect(loadLogPseudonymizer(env({ PEAKET_ENV: 'ci', PEAKET_LOG_PSEUDONYM_KEY: KEY.toString('base64') })).warning).toBeUndefined();
  });

  test('ADR0053_키는_객체를통째로_글로바꿔도_드러나지않는다', () => {
    const { pseudonymizer } = loadLogPseudonymizer(env({ PEAKET_ENV: 'prod', PEAKET_LOG_PSEUDONYM_KEY: KEY.toString('base64') }));
    const text = `${JSON.stringify(pseudonymizer)} ${String(pseudonymizer)}`;
    expect(text).not.toContain(KEY.toString('base64'));
    expect(text).not.toContain(KEY.toString('hex'));
  });
});

describe('IP 앞부분', () => {
  test.each([
    ['203.0.113.77', '203.0.113.0/24'],
    ['10.0.0.1', '10.0.0.0/24'],
    ['2001:db8:abcd:12::1', '2001:db8:abcd::/48'],
    ['2001:0DB8:0000:0000:0000:0000:0000:0001', '2001:db8::/48'],
    ['2001:0:5:6::', '2001:0:5::/48'],
    ['::1', '::/48'],
    ['fe80::1%eth0', 'fe80::/48'],
    ['::ffff:198.51.100.9', '198.51.100.0/24'],
  ])('ADR0053_IP는_IPv4_24_IPv6_48_앞부분만(%s)', (ip, want) => {
    expect(ipPrefix(ip)).toBe(want);
  });

  test.each(['', 'abc', '999.1.1.1', '1.2.3', '2001:db8::1::2', '1.2.3.4/24'])('ADR0053_형식이틀린값(%s)은_쓰지않는다', (ip) => {
    expect(ipPrefix(ip)).toBeUndefined();
  });
});
