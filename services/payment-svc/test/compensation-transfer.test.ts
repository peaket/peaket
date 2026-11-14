// 배상 송금 포트·가짜 어댑터(BAT-425 GAT-130 잔여, FR-056) 단위 시험.
import { describe, expect, test } from 'vitest';
import { CompensationTransfers } from '../src/modules/compensation/application/compensation-transfers.js';
import { FakeCompensationTransfer } from '../src/modules/compensation/adapters/fake-compensation-transfer.js';

const COMP = '01900000-0000-7000-8000-000000000001';
const ORDER = '01900000-0000-7000-8000-000000000002';
const ACCOUNT = '01900000-0000-7000-8000-000000000003';
const input = { compensationId: COMP, orderId: ORDER, accountId: ACCOUNT, amount: 11_000, bankCode: '004', accountNumber: '1234567890', holderName: '홍길동', requestedBy: 'ops-1' };

describe('배상 송금 [BAT-425]', () => {
  test('fake 모드는 compensation_id로 멱등하게 REQUESTED를 만들고 같은 건을 돌려준다', async () => {
    const app = new CompensationTransfers(new FakeCompensationTransfer({ PEAKET_COMPENSATION_TRANSFER_MODE: 'fake' }));
    const a = await app.request(input);
    expect(a).toMatchObject({ compensationId: COMP, amount: 11_000, status: 'REQUESTED' });
    expect(await app.request(input)).toEqual(a);
    expect(await app.get(a.transferId)).toEqual(a);
  });

  test('설정이 없으면 UNAVAILABLE(503 근거)이고 계좌 원문은 기록에 남지 않는다', async () => {
    const app = new CompensationTransfers(new FakeCompensationTransfer({}));
    const r = await app.request(input);
    expect(r).toMatchObject({ status: 'UNAVAILABLE', failureReason: 'compensation-transfer-not-configured' });
    expect(JSON.stringify(r)).not.toContain('1234567890');
  });

  test('모양이 틀린 입력은 INVALID다', async () => {
    const app = new CompensationTransfers(new FakeCompensationTransfer({ PEAKET_COMPENSATION_TRANSFER_MODE: 'fake' }));
    await expect(app.request({ ...input, amount: 0 })).rejects.toMatchObject({ code: 'INVALID' });
    await expect(app.request({ ...input, orderId: 'x' })).rejects.toMatchObject({ code: 'INVALID' });
  });
});
