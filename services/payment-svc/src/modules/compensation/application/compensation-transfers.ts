// 배상 송금 유스케이스(BAT-425 GAT-130 잔여, ADR-0317). 모양을 보고 포트로 넘기고, 기록·멱등·PAID 미수금을 맡는다.
// 차례: 저장한 행이 있으면 그대로 답한다(compensation_id = 멱등 키) → 없으면 저장소에서 compensation_id 행을 선점한다 →
// 선점한 쪽만 포트에 송금 요청(계좌는 이 호출 안에서만) → compensation_transfer 한 행에 답 저장(계좌 끝 4자리만) →
// PAID면 partner_receivable(COMPENSATION_ADVANCE) 한 행과 receivable_id. UNAVAILABLE은 저장한 뒤 UNAVAILABLE로 답하고 받는 쪽이 503으로 드러낸다.
// 선점은 DB 유일 인덱스라 같은 저장소를 보는 두 파드가 겹쳐도 포트를 부르는 쪽은 하나다(RV-23). 진 쪽은 그 행의 답을 기다린다.
// 계좌 원문은 저장·응답에 싣지 않는다(POL-014).
import { randomUUID } from 'node:crypto';
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
/** 송금 전 선점 행의 transfer_id 접두어. 지급대행이 돌려준 진짜 ID와 겹치지 않게 예약한다 */
const CLAIM_PREFIX = 'claim:';
/** 다른 파드가 선점한 송금의 답을 기다리는 시간 6초 [가정](포트 호출 기한 5초 [가정]보다 조금 길다) */
const CLAIM_WAIT_MS = 6_000;
/** 선점한 송금의 답을 다시 읽는 간격 20ms [가정] */
const CLAIM_POLL_MS = 20;

/** 아직 포트 답을 받지 못한 선점 행인가 */
const isPendingClaim = (r: CompensationTransferRecord): boolean => r.transferId.startsWith(CLAIM_PREFIX);

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

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

  async claim(record: { readonly compensationId: string; readonly orderId: string; readonly accountId: string; readonly amount: number; readonly accountLast4: string; readonly promoterId: string; readonly eventId?: string }): Promise<{ readonly record: CompensationTransferRecord; readonly claimed: boolean }> {
    // 이벤트 루프 안에서 확인과 쓰기 사이에 await가 없어 두 호출이 겹쳐도 한 번만 선점한다(운영은 유일 인덱스)
    const claimedTransferId = this.#byCompensation.get(record.compensationId);
    const existing = claimedTransferId === undefined ? undefined : this.#rows.get(claimedTransferId);
    if (existing !== undefined) return { record: existing, claimed: false };
    const row: CompensationTransferRecord = {
      transferId: `${CLAIM_PREFIX}${randomUUID()}`,
      compensationId: record.compensationId,
      orderId: record.orderId,
      accountId: record.accountId,
      amount: record.amount,
      status: 'REQUESTED',
      accountLast4: record.accountLast4,
    };
    this.#rows.set(row.transferId, row);
    this.#byCompensation.set(record.compensationId, row.transferId);
    return { record: row, claimed: true };
  }

  async settle(compensationId: string, record: CompensationTransferRecord & { readonly accountLast4: string; readonly promoterId: string; readonly eventId?: string }): Promise<CompensationTransferRecord> {
    const existing = await this.findByCompensationId(compensationId);
    if (existing === undefined) throw new Error('배상 송금 기록을 찾지 못했습니다');
    if (!isPendingClaim(existing)) return existing;
    // 선점 행을 답으로 바꾼다. transfer_id 색인도 함께 옮긴다(옛 선점 키는 지운다)
    this.#rows.delete(existing.transferId);
    const saved: CompensationTransferRecord = {
      transferId: record.transferId,
      compensationId,
      orderId: record.orderId,
      accountId: record.accountId,
      amount: record.amount,
      status: record.status,
      ...(record.failureReason === undefined ? {} : { failureReason: record.failureReason }),
      accountLast4: record.accountLast4,
      ...(record.receivableId === undefined ? {} : { receivableId: record.receivableId }),
    };
    this.#rows.set(saved.transferId, saved);
    this.#byCompensation.set(compensationId, saved.transferId);
    return saved;
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
    // 같은 compensation_id의 다시 부름은 저장한 상태·transfer_id를 그대로 준다(계좌가 달라도 새 송금을 만들지 않는다).
    // 아직 답이 없는 선점 행이면 아래 선점·대기로 내려가 그 답을 기다린다
    const existing = await this.store.findByCompensationId(input.compensationId);
    if (existing !== undefined && !isPendingClaim(existing)) return existing;
    // 송금 전에 DB 유일 행을 잡는다(RV-23): 두 파드가 겹쳐도 이긴 쪽만 포트를 부른다. 계좌 끝 4자리는 하이픈을 뺀 숫자다(123-456-789 → 6789, RV-05)
    const accountLast4 = input.accountNumber.replace(/-/g, '').slice(-4);
    const claim = await this.store.claim({
      compensationId: input.compensationId,
      orderId: input.orderId,
      accountId: input.accountId,
      amount: input.amount,
      accountLast4,
      promoterId: promoterId ?? UNKNOWN_PROMOTER,
      ...(input.eventId === undefined ? {} : { eventId: input.eventId }),
    });
    if (!claim.claimed) return this.#awaitSettled(input.compensationId);
    return this.#send(input, promoterId, accountLast4);
  }

  /** 다른 파드가 선점한 송금의 답을 기다린다. 포트를 부르지 않는다 */
  async #awaitSettled(compensationId: string): Promise<CompensationTransferRecord> {
    const deadlineAtMs = Date.now() + CLAIM_WAIT_MS;
    for (;;) {
      const row = await this.store.findByCompensationId(compensationId);
      if (row === undefined) throw new Error('배상 송금 기록을 찾지 못했습니다');
      // 선점이 끝났고, PAID면 미수금 ID까지 붙었는지 본다(이긴 쪽이 그 둘을 차례로 쓴다)
      const waiting = isPendingClaim(row) || (row.status === 'PAID' && row.receivableId === undefined);
      if (!waiting || Date.now() >= deadlineAtMs) return row;
      await sleep(CLAIM_POLL_MS);
    }
  }

  async #send(input: CompensationTransferRequest, promoterId: string | undefined, accountLast4: string): Promise<CompensationTransferRecord> {
    const sent = await this.port.request(input);
    const saved = await this.store.settle(input.compensationId, {
      ...sent,
      compensationId: input.compensationId,
      orderId: input.orderId,
      accountId: input.accountId,
      amount: input.amount,
      promoterId: promoterId ?? UNKNOWN_PROMOTER,
      ...(input.eventId === undefined ? {} : { eventId: input.eventId }),
      accountLast4,
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
