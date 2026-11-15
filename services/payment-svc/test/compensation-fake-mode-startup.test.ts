// SEC-07 회귀: 배상 송금 가짜 어댑터가 운영에서 fake 모드로 만들어지면 시작 단계에서 실패한다.
import { describe, expect, test } from 'vitest';
import { FakeCompensationTransfer } from '../src/modules/compensation/adapters/fake-compensation-transfer.js';

describe('SEC-07 배상 송금 fake 모드 시작 차단', () => {
  test('NODE_ENV=production·PEAKET_ENV=production에서 fake면 생성자가 던진다', () => {
    expect(() => new FakeCompensationTransfer({ NODE_ENV: 'production', PEAKET_COMPENSATION_TRANSFER_MODE: 'fake' })).toThrow(/운영/);
    expect(() => new FakeCompensationTransfer({ PEAKET_ENV: 'production', PEAKET_COMPENSATION_TRANSFER_MODE: 'fake' })).toThrow(/운영/);
    expect(() => new FakeCompensationTransfer({ PEAKET_ENV: 'production', PEAKET_COMPENSATION_TRANSFER_MODE: ' fake ' })).toThrow(/운영/);
  });

  test('ci·local과 fake가 아닌 모드는 생성된다', () => {
    expect(() => new FakeCompensationTransfer({ PEAKET_ENV: 'ci', PEAKET_COMPENSATION_TRANSFER_MODE: 'fake' })).not.toThrow();
    expect(() => new FakeCompensationTransfer({ PEAKET_ENV: 'local', PEAKET_COMPENSATION_TRANSFER_MODE: 'fake' })).not.toThrow();
    expect(() => new FakeCompensationTransfer({ NODE_ENV: 'production', PEAKET_COMPENSATION_TRANSFER_MODE: 'real' })).not.toThrow();
  });
});
