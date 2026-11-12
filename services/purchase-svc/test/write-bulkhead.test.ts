// BAT-037 쓰기 경로 HTTP 백프레셔 설정 시험. 기본값·환경 값 검증·같은 객체를 장식자가 참조하는지 본다.
import { afterEach, describe, expect, test } from 'vitest';
import {
  setWriteBulkheadLimit,
  WRITE_BULKHEAD,
  WRITE_BULKHEAD_DEFAULT_LIMIT,
  WRITE_BULKHEAD_LIMIT_ENV,
  writeBulkheadLimitFromEnv,
} from '../src/write-bulkhead.js';

afterEach(() => {
  setWriteBulkheadLimit(WRITE_BULKHEAD_DEFAULT_LIMIT);
});

describe('BAT-037 쓰기 칸막이 설정', () => {
  test('환경 값이 없거나 비면 기본 64다', () => {
    expect(writeBulkheadLimitFromEnv({})).toBe(64);
    expect(writeBulkheadLimitFromEnv({ [WRITE_BULKHEAD_LIMIT_ENV]: '' })).toBe(64);
    expect(WRITE_BULKHEAD).toMatchObject({ name: 'purchase-write', limit: 64, retryAfterSeconds: 1 });
  });

  test('1~1,024의 10진 정수만 받는다', () => {
    for (const raw of ['1', '64', '1024']) expect(writeBulkheadLimitFromEnv({ [WRITE_BULKHEAD_LIMIT_ENV]: raw })).toBe(Number(raw));
    for (const raw of ['0', '1025', '1.5', '0x10', ' 10', '10 ', 'abc']) {
      expect(() => writeBulkheadLimitFromEnv({ [WRITE_BULKHEAD_LIMIT_ENV]: raw }), raw).toThrow(Error);
    }
  });

  test('시작 때 바꾼 한도가 장식자가 참조하는 같은 객체에 적용된다', () => {
    setWriteBulkheadLimit(128);
    expect(WRITE_BULKHEAD.limit).toBe(128);
    for (const bad of [0, 1.5, 1_025]) expect(() => setWriteBulkheadLimit(bad)).toThrow(Error);
    expect(WRITE_BULKHEAD.limit).toBe(128);
  });

});
