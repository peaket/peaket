// SEC-07: 운영에서 배상 송금 fake 모드를 켜면 시작을 막는다.
import { describe, expect, test } from 'vitest';
import { assertCompensationFakeAllowed } from '../src/modules/compensation/adapters/fake-compensation-transfer.js';

describe('SEC-07 배상 송금 fake 모드', () => {
  test('운영(NODE_ENV·PEAKET_ENV=production)에서는 fake가 시작 실패다', () => {
    expect(() => assertCompensationFakeAllowed({ NODE_ENV: 'production', PEAKET_COMPENSATION_TRANSFER_MODE: 'fake' })).toThrow(/운영/);
    expect(() => assertCompensationFakeAllowed({ PEAKET_ENV: 'production', PEAKET_COMPENSATION_TRANSFER_MODE: 'fake' })).toThrow(/운영/);
  });

  test('시험·로컬과 fake가 아닌 모드는 통과한다', () => {
    expect(() => assertCompensationFakeAllowed({ PEAKET_ENV: 'ci', PEAKET_COMPENSATION_TRANSFER_MODE: 'fake' })).not.toThrow();
    expect(() => assertCompensationFakeAllowed({ NODE_ENV: 'production' })).not.toThrow();
  });
});
