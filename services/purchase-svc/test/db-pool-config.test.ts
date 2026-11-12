import { describe, expect, test } from 'vitest';
import { HOT_CONNECT_TIMEOUT_DEFAULT_MS, HOT_CONNECT_TIMEOUT_ENV, hotConnectTimeoutMsFromEnv } from '../src/db-pool.js';

describe('purchase-svc 핫패스 DB 풀 설정(BAT-034)', () => {
  test('환경 값이 없거나 비면 기본 250ms다', () => {
    expect(HOT_CONNECT_TIMEOUT_DEFAULT_MS).toBe(250);
    expect(hotConnectTimeoutMsFromEnv({})).toBe(250);
    expect(hotConnectTimeoutMsFromEnv({ [HOT_CONNECT_TIMEOUT_ENV]: '' })).toBe(250);
  });

  test('1~5,000의 정수를 받는다', () => {
    expect(hotConnectTimeoutMsFromEnv({ [HOT_CONNECT_TIMEOUT_ENV]: '100' })).toBe(100);
    expect(hotConnectTimeoutMsFromEnv({ [HOT_CONNECT_TIMEOUT_ENV]: '250' })).toBe(250);
    expect(hotConnectTimeoutMsFromEnv({ [HOT_CONNECT_TIMEOUT_ENV]: '5000' })).toBe(5000);
  });

  test('정수가 아니거나 범위 밖이면 시작하지 않는다', () => {
    for (const raw of ['0', '-1', '1.5', 'abc', '5001']) {
      expect(() => hotConnectTimeoutMsFromEnv({ [HOT_CONNECT_TIMEOUT_ENV]: raw })).toThrow(HOT_CONNECT_TIMEOUT_ENV);
    }
  });
});
