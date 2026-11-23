// 배상 송금 가짜 어댑터(BAT-425 GAT-130 잔여). 외부 지급대행·계정이 없어 실제 송금은 하지 않는다.
// PEAKET_COMPENSATION_TRANSFER_MODE=fake일 때만 REQUESTED를 돌려주고, 그 밖에는 UNAVAILABLE(503)이다.
// 송금 결과(F-07-8 I-06, transfer-refund §6 '송금 결과 확정')는 접수 때 정해 송금 ID에 담는다(`fake-{uuid}-p`는 PAID, `-f`는 FAILED [가정 모양]).
// 계좌번호 끝 4자리가 0000이면 FAILED다(시험·데모용 규칙, 정리 목록 C-05). 그래서 다시 띄운 어댑터도 같은 ID에 같은 결과를 준다.
// 계좌 원문은 저장하지 않는다(POL-014). 메모리 기록은 시험·로컬에서만 쓴다.
import { randomUUID } from 'node:crypto';
import { isProductionLikeEnv } from '@peaket/platform';
import type { CompensationTransferPort, CompensationTransferRecord, CompensationTransferRequest } from '../domain/ports.js';

/** 운영(NODE_ENV=production 또는 PEAKET_ENV=prod·staging, production은 옛 이름 호환)에서 fake 모드를 켜면 시작을 막는다(감사 SEC-07). */
export function assertCompensationFakeAllowed(env: Record<string, string | undefined>): void {
  if (env.PEAKET_COMPENSATION_TRANSFER_MODE?.trim() !== 'fake') return;
  if (isProductionLikeEnv(env)) throw new Error('PEAKET_COMPENSATION_TRANSFER_MODE=fake는 운영(prod·staging)에서 쓸 수 없다');
}

/** 가짜 송금 ID: fake-{uuid}-p(PAID)·-f(FAILED) */
const FAKE_TRANSFER_ID = /^fake-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-([pf])$/;

export class FakeCompensationTransfer implements CompensationTransferPort {
  readonly #rows = new Map<string, CompensationTransferRecord>();
  readonly #byCompensation = new Map<string, string>();
  readonly #enabled: boolean;

  constructor(env: Record<string, string | undefined> = process.env) {
    assertCompensationFakeAllowed(env);
    this.#enabled = env.PEAKET_COMPENSATION_TRANSFER_MODE?.trim() === 'fake';
  }

  async request(input: CompensationTransferRequest): Promise<CompensationTransferRecord> {
    if (!this.#enabled) return { transferId: '', compensationId: input.compensationId, orderId: input.orderId, accountId: input.accountId, amount: input.amount, status: 'UNAVAILABLE', failureReason: 'compensation-transfer-not-configured' };
    const existing = this.#byCompensation.get(input.compensationId);
    if (existing) return this.#rows.get(existing)!;
    const willFail = input.accountNumber.replace(/-/g, '').endsWith('0000');
    const transferId = `fake-${randomUUID()}-${willFail ? 'f' : 'p'}`;
    const record: CompensationTransferRecord = { transferId, compensationId: input.compensationId, orderId: input.orderId, accountId: input.accountId, amount: input.amount, status: 'REQUESTED' };
    this.#rows.set(transferId, record);
    this.#byCompensation.set(input.compensationId, transferId);
    return record;
  }

  /** 송금 ID에 담긴 결과. 모르는 ID는 undefined */
  async get(transferId: string): Promise<CompensationTransferRecord | undefined> {
    const m = FAKE_TRANSFER_ID.exec(transferId);
    if (!m) return undefined;
    const status = m[1] === 'p' ? 'PAID' : 'FAILED';
    const known = this.#rows.get(transferId);
    return {
      transferId,
      compensationId: known?.compensationId ?? '',
      orderId: known?.orderId ?? '',
      accountId: known?.accountId ?? '',
      amount: known?.amount ?? 0,
      status,
      ...(status === 'FAILED' ? { failureReason: 'fake-transfer-failed' } : {}),
    };
  }
}
