// 배상 송금 포트·가짜 어댑터(BAT-425 GAT-130 잔여, FR-056) 단위 시험.
// RV-05(높음): 계좌 끝 4자리는 하이픈을 뺀 숫자다(123-456-789 → 6789, docs/data.md compensation.account_last4).
// RV-06(높음): 같은 compensation_id의 겹친 두 요청은 결제사 포트를 한 번만 부른다(ADR-0317, B16).
import { describe, expect, test } from 'vitest';
import { CompensationTransfers } from '../src/modules/compensation/application/compensation-transfers.js';
import { FakeCompensationTransfer } from '../src/modules/compensation/adapters/fake-compensation-transfer.js';
import type { CompensationTransferPort, CompensationTransferRecord, CompensationTransferRequest, CompensationTransferStore } from '../src/modules/compensation/domain/ports.js';

const COMP = '01900000-0000-7000-8000-000000000001';
const ORDER = '01900000-0000-7000-8000-000000000002';
const ACCOUNT = '01900000-0000-7000-8000-000000000003';
const input = { compensationId: COMP, orderId: ORDER, accountId: ACCOUNT, amount: 11_000, bankCode: '004', accountNumber: '1234567890', holderName: '홍길동', requestedBy: 'ops-1' };

/** 결제사 포트 대역. delayMs 동안 답을 붙잡아 두 요청이 겹치게 한다(RV-06) */
class CountingPort implements CompensationTransferPort {
  readonly requests: CompensationTransferRequest[] = [];
  delayMs = 0;
  async request(input: CompensationTransferRequest): Promise<CompensationTransferRecord> {
    this.requests.push(input);
    if (this.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    return { transferId: `tr_bat425_${this.requests.length}`, compensationId: input.compensationId, orderId: input.orderId, accountId: input.accountId, amount: input.amount, status: 'REQUESTED' };
  }
  async get(): Promise<undefined> {
    return undefined;
  }
}

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

  // RV-05: 계좌 모양은 하이픈과 3자리 끝 묶음을 허용한다. 끝 4글자를 원문 그대로 자르면 '-789'가 되어
  // compensation_transfer_account_last4_check(^[0-9]{1,4}$)에 걸린다. 정규화한 숫자의 끝 4자리여야 한다.
  test('R-T47 ②_계좌_끝_4자리는_하이픈을_뺀_숫자다: 123-456-789는_-789가_아니라_6789다', async () => {
    const app = new CompensationTransfers(new FakeCompensationTransfer({ PEAKET_COMPENSATION_TRANSFER_MODE: 'fake' }));
    const r = await app.request({ ...input, accountNumber: '123-456-789' });
    expect(r.accountLast4).toBe('6789');
    expect(r.accountLast4).toMatch(/^[0-9]{1,4}$/);
    expect(JSON.stringify(r)).not.toContain('123-456-789');
    expect(JSON.stringify(r)).not.toContain('123456789');

    const trailing = await app.request({ ...input, compensationId: '01900000-0000-7000-8000-000000000004', accountNumber: '123-456-' });
    expect(trailing.accountLast4).toBe('3456');
    const short = await app.request({ ...input, compensationId: '01900000-0000-7000-8000-000000000005', accountNumber: '123-4' });
    expect(short.accountLast4).toBe('1234');
  });

  // RV-06: 행이 저장된 뒤에만 멱등이 참이면, 겹친 두 요청이 둘 다 포트를 불러 돈이 두 번 나간다.
  test('R-T47 ②_같은_compensation_id의_겹친_두_요청은_결제사_포트를_한_번만_부른다', async () => {
    const port = new CountingPort();
    port.delayMs = 20;
    const app = new CompensationTransfers(port);
    const [a, b] = await Promise.all([app.request(input), app.request(input)]);
    expect(port.requests).toHaveLength(1);
    expect(a).toEqual(b);
  });

  // RV-23(높음): #inFlight는 프로세스 안 표다. 같은 저장소를 쓰는 두 인스턴스(다른 파드)가 겹치면 둘 다 행을 못 보고
  // 포트를 두 번 부른다. 송금 전에 저장소에서 compensation_id를 선점해야 두 인스턴스에서도 포트가 한 번이다(ADR-0317, B16).
  test('R-T47 ②_RV23_같은_저장소를_쓰는_두_인스턴스가_겹쳐도_결제사_포트는_한_번이다', async () => {
    const port = new CountingPort();
    port.delayMs = 20;
    const first = new CompensationTransfers(port);
    // 첫 인스턴스의 저장소를 그대로 꺼내 둘째 인스턴스에 꽂는다(다른 파드가 같은 DB를 보는 꼴)
    const store = (first as unknown as { store: CompensationTransferStore }).store;
    const second = new CompensationTransfers(port, store);
    const [a, b] = await Promise.all([first.request(input), second.request(input)]);
    expect(port.requests).toHaveLength(1);
    expect(a).toEqual(b);
  });
});
