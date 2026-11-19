// 배상 송금 유스케이스(BAT-425 GAT-130 잔여, ADR-0317). 모양을 보고 포트로 넘기고, 기록·멱등·PAID 미수금을 맡는다.
// 차례: 저장한 행이 있으면 그대로 답한다(compensation_id = 멱등 키) → 포트에 송금 요청(계좌는 이 호출 안에서만) →
// compensation_transfer 한 행 저장(계좌 끝 4자리만) → PAID면 partner_receivable(COMPENSATION_ADVANCE) 한 행과 receivable_id.
// UNAVAILABLE은 저장한 뒤 UNAVAILABLE로 답하고 받는 쪽이 503으로 드러낸다. 계좌 원문은 저장·응답에 싣지 않는다(POL-014).
import type { CompensationReceivables, CompensationTransferPort, CompensationTransferRecord, CompensationTransferRequest, CompensationTransferStore } from '../domain/ports.js';

export class CompensationTransferProblem extends Error {
  constructor(
    readonly code: 'INVALID' | 'NOT_FOUND' | 'UNAVAILABLE',
    message: string,
  ) {
    super(message);
    this.name = 'CompensationTransferProblem';
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** 옛 호출자(파트너를 싣지 않는 단위 시험)가 REQUESTED만 볼 때 쓰는 자리 표시자. PAID면 미수금을 만들지 않고 UNAVAILABLE이다 */
const UNKNOWN_PROMOTER = '00000000-0000-0000-0000-000000000000';

/** 저장소를 넘기지 않는 옛 호출자(단위 시험)를 위한 메모리 기록. 운영 조립은 DrizzleCompensationTransfers를 넘긴다 */
class MemoryCompensationTransferStore implements CompensationTransferStore {
  readonly #rows = new Map<string, CompensationTransferRecord>();
  readonly #byCompensation = new Map<string, string>();

  async findByCompensationId(compensationId: string): Promise<CompensationTransferRecord | undefined> {
    const transferId = this.#byCompensation.get(compensationId);
    return transferId === undefined ? undefined : this.#rows.get(transferId);
  }

  async findByTransferId(transferId: string): Promise<CompensationTransferRecord | undefined> {
    return this.#rows.get(transferId);
  }

  async save(record: CompensationTransferRecord & { readonly accountLast4: string; readonly promoterId: string; readonly eventId?: string }): Promise<CompensationTransferRecord> {
    const existing = await this.findByCompensationId(record.compensationId);
    if (existing !== undefined) return existing;
    this.#rows.set(record.transferId, record);
    this.#byCompensation.set(record.compensationId, record.transferId);
    return record;
  }

  async attachReceivable(compensationId: string, receivableId: string): Promise<CompensationTransferRecord> {
    const existing = await this.findByCompensationId(compensationId);
    if (existing === undefined) throw new Error('배상 송금 기록을 찾지 못했습니다');
    if (existing.receivableId !== undefined) return existing;
    const next = { ...existing, receivableId };
    this.#rows.set(next.transferId, next);
    return next;
  }
}

export class CompensationTransfers {
  constructor(
    private readonly port: CompensationTransferPort,
    private readonly store: CompensationTransferStore = new MemoryCompensationTransferStore(),
    private readonly receivables?: CompensationReceivables,
  ) {}

  async request(input: CompensationTransferRequest): Promise<CompensationTransferRecord> {
    if (!UUID.test(input.compensationId) || !UUID.test(input.orderId) || !UUID.test(input.accountId)) throw new CompensationTransferProblem('INVALID', 'ID 모양이 올바르지 않습니다');
    // promoter_id는 proto에서 필수 글자지만, 옛 gRPC 시험 대역은 빈 값으로 부른다. PAID가 아니면 쓰지 않고, PAID인데 없으면 UNAVAILABLE이다
    const promoterId = input.promoterId === undefined || input.promoterId === '' ? undefined : input.promoterId;
    if (promoterId !== undefined && !UUID.test(promoterId)) throw new CompensationTransferProblem('INVALID', 'ID 모양이 올바르지 않습니다');
    if (input.eventId !== undefined && !UUID.test(input.eventId)) throw new CompensationTransferProblem('INVALID', 'ID 모양이 올바르지 않습니다');
    if (!Number.isSafeInteger(input.amount) || input.amount < 1) throw new CompensationTransferProblem('INVALID', '금액이 올바르지 않습니다');
    if (!input.bankCode || !input.accountNumber || !input.holderName) throw new CompensationTransferProblem('INVALID', '계좌 정보가 필요합니다');
    // 같은 compensation_id의 다시 부름은 저장한 상태·transfer_id를 그대로 준다(계좌가 달라도 새 송금을 만들지 않는다)
    const existing = await this.store.findByCompensationId(input.compensationId);
    if (existing !== undefined) return existing;

    const sent = await this.port.request(input);
    const saved = await this.store.save({
      ...sent,
      compensationId: input.compensationId,
      orderId: input.orderId,
      accountId: input.accountId,
      amount: input.amount,
      promoterId: promoterId ?? UNKNOWN_PROMOTER,
      ...(input.eventId === undefined ? {} : { eventId: input.eventId }),
      accountLast4: input.accountNumber.slice(-4),
    });
    if (saved.status !== 'PAID' || saved.receivableId !== undefined) return saved;
    // PAID일 때만 미수금 한 행(REQUESTED·FAILED·UNAVAILABLE은 0행). 같은 PAID를 다시 받아도 source_ref 유일로 1행이다
    if (this.receivables === undefined || promoterId === undefined) throw new CompensationTransferProblem('UNAVAILABLE', '배상 미수금 기록을 조립하지 못했습니다');
    const receivable = await this.receivables.recordCompensationAdvance({
      compensationId: saved.compensationId,
      promoterId,
      ...(input.eventId === undefined ? {} : { eventId: input.eventId }),
      amount: saved.amount,
    });
    return this.store.attachReceivable(saved.compensationId, receivable.receivableId);
  }

  async get(transferId: string): Promise<CompensationTransferRecord> {
    const saved = await this.store.findByTransferId(transferId);
    if (saved !== undefined) return saved;
    const r = await this.port.get(transferId);
    if (!r) throw new CompensationTransferProblem('NOT_FOUND', '송금 건을 찾을 수 없습니다');
    return r;
  }
}
