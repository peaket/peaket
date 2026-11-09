// 결제사 흉내 엔진. 토스페이먼츠의 승인 규칙을 메모리 상태로 흉내 낸다(docs/features/payment.md §2.1 'PG사별 기술 명세 대조').
// - 결제창 인증 뒤 10분 안에 승인하지 않으면 만료, 승인된 주문 ID는 다시 쓸 수 없다(DUPLICATED_ORDER_ID).
// - 같은 멱등키는 같은 응답(15일 보관), 처리 중이면 409, 같은 결제를 다른 키로 동시에 승인하면 400 ALREADY_PROCESSING_REQUEST.
// - 다른 본문에 같은 멱등키는 422 IDEMPOTENCY_KEY_REUSED(토스 문서에 없어 정함, 추천 적용 2026-11-02).
// - 시험이 넣는 장애(거절·처리 중·결제사 오류·응답 유실·한도 초과·지연)는 작업·주문 ID·횟수로 고른다(ADR-0029 결정 6).
import { randomBytes } from 'node:crypto';
import { DEFAULT_CONFIRM_LATENCY, latencySampler, seededRandom, type LatencySpec } from './latency.js';
import { kstIso, systemClock, type SimClock } from './time.js';

export const CONFIRM_DEADLINE_MS = 10 * 60_000;
export const IDEMPOTENCY_RETENTION_MS = 15 * 24 * 3_600_000;
/** 포트원 모양 경로의 멱등키 보관 3시간(payment §2.1 멱등키 규격, BUILD_ORDER HOT-140) */
export const PORTONE_IDEMPOTENCY_RETENTION_MS = 3 * 3_600_000;
export const ORDER_ID = /^[A-Za-z0-9_-]{6,64}$/;

/** 포트원 모양 경로가 엔진에 넘기는 값(토큰 대조, 멱등 보관 3시간, 취소 가능 금액 대조). 토스 모양 경로는 쓰지 않는다 */
export interface PortoneCallOptions {
  retentionMs: number;
  /** 승인: 이 토큰과 결제의 토큰이 달라야 400 INVALID_PAYMENT_TOKEN이다 */
  token?: string;
  /** 승인: 값이 있으면 결제의 결제 시도 ID와 같아야 한다(다르면 포트원 경로의 409 INFORMATION_MISMATCH) */
  txId?: string;
  /** 취소: 값이 있으면 남은 금액과 같아야 한다 */
  currentCancellableAmount?: number;
}

export const OPS = ['confirm', 'cancel', 'query'] as const;
export type Op = (typeof OPS)[number];

export type FaultKind =
  | { kind: 'decline'; code: string; message?: string }
  | { kind: 'in-progress' }
  | { kind: 'throttle' }
  | { kind: 'pg-error'; applied: boolean }
  | { kind: 'drop'; applied: boolean }
  | { kind: 'delay'; ms: number };
export type Fault = { op: Op; orderId?: string; times?: number } & FaultKind;

export interface SimResponse {
  status: number;
  body?: unknown;
  /** 응답 없이 연결을 끊는다 */
  drop?: boolean;
}

type PaymentStatus = 'READY' | 'IN_PROGRESS' | 'DONE' | 'PARTIAL_CANCELED' | 'CANCELED' | 'ABORTED' | 'EXPIRED';

interface CancelRecord {
  cancelAmount: number;
  cancelReason: string;
  canceledAt: number;
  transactionKey: string;
}

interface Payment {
  paymentKey: string;
  orderId: string;
  orderName: string;
  amount: number;
  status: PaymentStatus;
  requestedAt: number;
  approvedAt?: number;
  balance: number;
  cancels: CancelRecord[];
  serial: number;
  lastTransactionKey?: string;
  /** 포트원 모양 결제의 결제 토큰과 결제 시도 ID(결제창 인증이 준다) */
  portoneToken?: string;
  txId?: string;
  /** 결제창에서 고른 결제 수단(없으면 카드) */
  method?: SimPayMethod;
  /** 결제창에서 고른 시험 카드. null이면 카드 정보가 없다(없으면 합성 카드) */
  testCard?: SimTestCard | null;
}

/** 시험이 고르는 결제 수단(BUILD_ORDER HOT-145) */
export const SIM_PAY_METHODS = ['카드', '계좌이체', '가상계좌'] as const;
export type SimPayMethod = (typeof SIM_PAY_METHODS)[number];

/** 시험이 고르는 카드(BUILD_ORDER HOT-145). 번호는 합성 값이다 */
export interface SimTestCard {
  number: string;
  /** null이면 발급사 칸을 뺀다(포트원 모양) */
  issuerCode?: string | null;
  cardType?: string;
  /** 포트원 모양의 bin. 없으면 번호의 앞 8자리, null이면 뺀다 */
  bin?: string | null;
}

interface IdemEntry {
  fingerprint: string;
  at: number;
  /** 없으면 처리 중 */
  response?: SimResponse;
}

interface ArmedFault {
  fault: Fault;
  remaining: number;
}

export interface WebhookEvent {
  paymentKey: string;
  /** 포트원 모양 결제의 결제 시도 ID(포트원 웹훅 본문의 transactionId) */
  txId?: string;
  headers: Record<string, string>;
  body: { eventType: 'PAYMENT_STATUS_CHANGED'; createdAt: string; data: unknown };
}

export interface EngineOptions {
  clock?: SimClock;
  sleep?: (ms: number) => Promise<void>;
  seed?: number;
  confirmLatency?: LatencySpec;
}

const err = (status: number, code: string, message: string): SimResponse => ({ status, body: { code, message } });
const APPROVED: ReadonlySet<PaymentStatus> = new Set(['DONE', 'PARTIAL_CANCELED', 'CANCELED']);
/** 결제창 인증이 받는 시험 결제 수단 */
export interface SimInstrument {
  method?: SimPayMethod;
  card?: SimTestCard | null;
}
const instrumentOf = (a: SimInstrument): Pick<Payment, 'method' | 'testCard'> => ({ ...(a.method === undefined ? {} : { method: a.method }), ...(a.card === undefined ? {} : { testCard: a.card }) });

/** 다시 보내면 결과가 달라질 수 있어 멱등 기록에 남기지 않는 응답 */
const transient = (r: SimResponse) => r.drop === true || r.status >= 500 || r.status === 409 || r.status === 429 || (r.body as { code?: string } | undefined)?.code === 'ALREADY_PROCESSING_REQUEST';

export class PgSimulatorEngine {
  private readonly clock: SimClock;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly initialLatency: LatencySpec;
  private nextLatency: () => number;
  private payments = new Map<string, Payment>();
  private approvedByOrder = new Map<string, string>();
  private idem = new Map<string, IdemEntry>();
  private faults: ArmedFault[] = [];
  private events: WebhookEvent[] = [];
  private serial = 0;

  constructor(o: EngineOptions = {}) {
    this.clock = o.clock ?? systemClock;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.random = o.seed === undefined ? Math.random : seededRandom(o.seed);
    this.initialLatency = o.confirmLatency ?? DEFAULT_CONFIRM_LATENCY;
    this.nextLatency = latencySampler(this.initialLatency, this.random);
  }

  setLatency(spec: LatencySpec): void {
    this.nextLatency = latencySampler(spec, this.random);
  }

  addFault(f: Fault): void {
    this.faults.push({ fault: f, remaining: f.times ?? Number.POSITIVE_INFINITY });
  }

  clearFaults(): void {
    this.faults = [];
  }

  reset(): void {
    this.payments.clear();
    this.approvedByOrder.clear();
    this.idem.clear();
    this.faults = [];
    this.events = [];
    this.nextLatency = latencySampler(this.initialLatency, this.random);
  }

  /** 구매자가 결제창에서 인증을 마친 것을 흉내 낸다. 성공 주소가 받을 값(paymentKey·orderId·amount)을 준다 */
  authenticate(a: { orderId: string; amount: number; orderName?: string } & SimInstrument): SimResponse {
    if (!ORDER_ID.test(a.orderId) || !Number.isSafeInteger(a.amount) || a.amount <= 0) return err(400, 'INVALID_REQUEST', '주문 ID나 금액이 틀렸습니다');
    if (this.approvedByOrder.has(a.orderId)) return err(400, 'DUPLICATED_ORDER_ID', '이미 승인된 주문 ID입니다');
    const serial = ++this.serial;
    const paymentKey = `tsim_${serial.toString(36)}${randomBytes(9).toString('hex')}`;
    this.payments.set(paymentKey, {
      paymentKey,
      orderId: a.orderId,
      orderName: a.orderName ?? '시뮬레이터 주문',
      amount: a.amount,
      status: 'READY',
      requestedAt: this.clock.now(),
      balance: a.amount,
      cancels: [],
      serial,
      ...instrumentOf(a),
    });
    return { status: 200, body: { paymentKey, orderId: a.orderId, amount: a.amount } };
  }

  /** 포트원 모양 결제창 인증. 결제 ID는 pay-{주문 ID}이고 같은 주문을 다시 인증하면 앞 시도를 대체한다(성공은 한 번). 승인된 주문은 다시 인증할 수 없다 */
  authenticatePortone(a: { orderId: string; amount: number; orderName?: string } & SimInstrument): SimResponse {
    if (!ORDER_ID.test(a.orderId) || !Number.isSafeInteger(a.amount) || a.amount <= 0) return err(400, 'INVALID_REQUEST', '주문 ID나 금액이 틀렸습니다');
    if (this.approvedByOrder.has(a.orderId)) return err(400, 'DUPLICATED_ORDER_ID', '이미 승인된 주문 ID입니다');
    const paymentKey = `pay-${a.orderId}`;
    const portoneToken = `ptok_${randomBytes(16).toString('hex')}`;
    const txId = `tx_${randomBytes(9).toString('hex')}`;
    const serial = ++this.serial;
    this.payments.set(paymentKey, {
      paymentKey,
      orderId: a.orderId,
      orderName: a.orderName ?? '시뮬레이터 주문',
      amount: a.amount,
      status: 'READY',
      requestedAt: this.clock.now(),
      balance: a.amount,
      cancels: [],
      serial,
      portoneToken,
      txId,
      ...instrumentOf(a),
    });
    return { status: 200, body: { paymentId: paymentKey, paymentToken: portoneToken, txId, orderId: a.orderId, amount: a.amount } };
  }

  confirm(c: { paymentKey: string; orderId: string; amount: number }, idemKey?: string, portone?: PortoneCallOptions): Promise<SimResponse> {
    const fp = JSON.stringify(['confirm', c.paymentKey, c.orderId, c.amount, portone?.token ?? null, portone?.txId ?? null]);
    return this.idempotent('confirm', idemKey, fp, c.orderId, portone?.retentionMs ?? IDEMPOTENCY_RETENTION_MS, async (fault) => {
      const p = this.payments.get(c.paymentKey);
      if (!p) return { response: err(404, 'NOT_FOUND_PAYMENT', '결제를 찾을 수 없습니다') };
      this.expireIfDue(p);
      if (p.status === 'EXPIRED' || p.status === 'ABORTED') return { response: err(400, 'NOT_FOUND_PAYMENT_SESSION', '결제 시간이 만료되어 결제 진행 데이터가 없습니다') };
      if (p.status === 'IN_PROGRESS') return { response: err(400, 'ALREADY_PROCESSING_REQUEST', '이미 처리 중인 요청입니다') };
      if (APPROVED.has(p.status)) return { response: err(400, 'ALREADY_PROCESSED_PAYMENT', '이미 처리된 결제입니다') };
      if (portone?.token !== undefined && p.portoneToken !== portone.token) return { response: err(400, 'INVALID_PAYMENT_TOKEN', '결제 토큰이 올바르지 않습니다') };
      if (portone?.txId !== undefined && p.txId !== portone.txId) return { response: err(400, 'INVALID_REQUEST', '결제 시도 ID가 결제창 값과 다릅니다') };
      if (p.orderId !== c.orderId || p.amount !== c.amount) return { response: err(400, 'INVALID_REQUEST', '주문 ID나 금액이 결제창 값과 다릅니다') };
      if (this.approvedByOrder.has(c.orderId)) return { response: err(400, 'DUPLICATED_ORDER_ID', '이미 승인된 주문 ID입니다') };

      p.status = 'IN_PROGRESS';
      await this.sleep(this.nextLatency() + (fault?.kind === 'delay' ? fault.ms : 0));
      if (this.payments.get(c.paymentKey) !== p) return { response: err(500, 'FAILED_INTERNAL_SYSTEM_PROCESSING', '시뮬레이터가 초기화되었습니다') };
      // 기다리는 동안 같은 주문의 다른 결제가 먼저 승인됐을 수 있다(주문 ID 재사용 금지)
      if (this.approvedByOrder.has(c.orderId)) {
        p.status = 'READY';
        return { response: err(400, 'DUPLICATED_ORDER_ID', '이미 승인된 주문 ID입니다') };
      }

      if (fault?.kind === 'decline') {
        this.setStatus(p, 'ABORTED');
        return { response: err(400, fault.code, fault.message ?? '결제사가 승인을 거절했습니다') };
      }
      if ((fault?.kind === 'pg-error' || fault?.kind === 'drop') && !fault.applied) {
        p.status = 'READY';
        return { response: fault.kind === 'drop' ? { status: 0, drop: true } : err(500, 'FAILED_INTERNAL_SYSTEM_PROCESSING', '결제사 내부 오류입니다') };
      }
      this.approve(p);
      const ok: SimResponse = { status: 200, body: this.view(p) };
      if (fault?.kind === 'pg-error') return { response: err(500, 'FAILED_INTERNAL_SYSTEM_PROCESSING', '결제사 내부 오류입니다'), store: ok };
      if (fault?.kind === 'drop') return { response: { status: 0, drop: true }, store: ok };
      return { response: ok };
    });
  }

  cancel(paymentKey: string, c: { cancelReason: string; cancelAmount?: number }, idemKey?: string, portone?: PortoneCallOptions): Promise<SimResponse> {
    const fp = JSON.stringify(['cancel', paymentKey, c.cancelReason, c.cancelAmount ?? null, portone?.currentCancellableAmount ?? null]);
    const orderId = this.payments.get(paymentKey)?.orderId;
    return this.idempotent('cancel', idemKey, fp, orderId, portone?.retentionMs ?? IDEMPOTENCY_RETENTION_MS, async (fault) => {
      const p = this.payments.get(paymentKey);
      if (!p) return { response: err(404, 'NOT_FOUND_PAYMENT', '결제를 찾을 수 없습니다') };
      if (!c.cancelReason || c.cancelReason.length > 200) return { response: err(400, 'INVALID_REQUEST', '취소 사유가 필요합니다') };
      if (p.status === 'CANCELED') return { response: err(400, 'ALREADY_CANCELED_PAYMENT', '이미 취소된 결제입니다') };
      if (p.status !== 'DONE' && p.status !== 'PARTIAL_CANCELED') return { response: err(403, 'NOT_CANCELABLE_PAYMENT', '취소할 수 없는 결제입니다') };
      if (portone?.currentCancellableAmount !== undefined && portone.currentCancellableAmount !== p.balance) return { response: err(409, 'CANCELLABLE_AMOUNT_CONSISTENCY_BROKEN', '취소 가능 금액이 맞지 않습니다') };
      const fits = (a: number) => Number.isSafeInteger(a) && a > 0 && a <= p.balance;
      if (!fits(c.cancelAmount ?? p.balance)) return { response: err(400, 'NOT_CANCELABLE_AMOUNT', '취소할 수 없는 금액입니다') };

      await this.sleep(fault?.kind === 'delay' ? fault.ms : 0);
      if (this.payments.get(paymentKey) !== p) return { response: err(500, 'FAILED_INTERNAL_SYSTEM_PROCESSING', '시뮬레이터가 초기화되었습니다') };
      // 기다리는 동안 다른 취소가 남은 금액을 줄였을 수 있다. 금액을 생략한 전액 취소는 그때 남은 금액 전부다
      if ((p.status as PaymentStatus) === 'CANCELED') return { response: err(400, 'ALREADY_CANCELED_PAYMENT', '이미 취소된 결제입니다') };
      const amount = c.cancelAmount ?? p.balance;
      if (!fits(amount)) return { response: err(400, 'NOT_CANCELABLE_AMOUNT', '취소할 수 없는 금액입니다') };
      if (fault?.kind === 'decline') return { response: err(400, fault.code, fault.message ?? '결제사가 취소를 거절했습니다') };
      if ((fault?.kind === 'pg-error' || fault?.kind === 'drop') && !fault.applied) {
        return { response: fault.kind === 'drop' ? { status: 0, drop: true } : err(500, 'FAILED_INTERNAL_SYSTEM_PROCESSING', '결제사 내부 오류입니다') };
      }
      p.balance -= amount;
      p.lastTransactionKey = this.transactionKey();
      p.cancels.push({ cancelAmount: amount, cancelReason: c.cancelReason, canceledAt: this.clock.now(), transactionKey: p.lastTransactionKey });
      this.setStatus(p, p.balance === 0 ? 'CANCELED' : 'PARTIAL_CANCELED');
      const ok: SimResponse = { status: 200, body: this.view(p) };
      if (fault?.kind === 'pg-error') return { response: err(500, 'FAILED_INTERNAL_SYSTEM_PROCESSING', '결제사 내부 오류입니다'), store: ok };
      if (fault?.kind === 'drop') return { response: { status: 0, drop: true }, store: ok };
      return { response: ok };
    });
  }

  query(paymentKey: string): Promise<SimResponse> {
    return this.read(this.payments.get(paymentKey));
  }

  /** 주문 ID로 조회. 승인된 결제가 있으면 그것을, 없으면 가장 나중에 만든 결제를 준다 */
  queryByOrder(orderId: string): Promise<SimResponse> {
    const approved = this.approvedByOrder.get(orderId);
    let p = approved ? this.payments.get(approved) : undefined;
    if (!p) for (const x of this.payments.values()) if (x.orderId === orderId) p = x;
    return this.read(p, orderId);
  }

  /** 불변식 검사기 기록 형식(docs/verification.md §2.5 `pg_charge`). 승인된 적 있는 결제만 */
  ledger(): Array<Record<string, unknown>> {
    return [...this.payments.values()]
      .filter((p) => p.approvedAt !== undefined)
      .map((p) => ({
        kind: 'pg_charge',
        pg: 'SIMULATOR',
        payment_ref: p.paymentKey,
        order_ref: p.orderId,
        amount: p.amount,
        status: p.status,
        approved_at: kstIso(p.approvedAt!),
        canceled_amount: p.amount - p.balance,
      }));
  }

  webhooks(paymentKey?: string): WebhookEvent[] {
    return this.events.filter((e) => paymentKey === undefined || e.paymentKey === paymentKey);
  }

  private read(p: Payment | undefined, orderId?: string): Promise<SimResponse> {
    return this.idempotent('query', undefined, '', p?.orderId ?? orderId, IDEMPOTENCY_RETENTION_MS, async (fault) => {
      await this.sleep(fault?.kind === 'delay' ? fault.ms : 0);
      if (fault?.kind === 'decline') return { response: err(400, fault.code, fault.message ?? '결제사가 조회를 거절했습니다') };
      if (fault?.kind === 'pg-error') return { response: err(500, 'FAILED_INTERNAL_SYSTEM_PROCESSING', '결제사 내부 오류입니다') };
      if (fault?.kind === 'drop') return { response: { status: 0, drop: true } };
      if (!p || this.payments.get(p.paymentKey) !== p) return { response: err(404, 'NOT_FOUND_PAYMENT', '결제를 찾을 수 없습니다') };
      this.expireIfDue(p);
      return { response: { status: 200, body: this.view(p) } };
    });
  }

  private async idempotent(
    op: Op,
    idemKey: string | undefined,
    fingerprint: string,
    orderId: string | undefined,
    retentionMs: number,
    run: (fault: FaultKind | undefined) => Promise<{ response: SimResponse; store?: SimResponse }>,
  ): Promise<SimResponse> {
    const now = this.clock.now();
    const slot = idemKey === undefined ? undefined : `${op}:${idemKey}`;
    if (slot) {
      // 보관 기간이 지난 기록은 꺼낼 때 지운다(요청마다 전부 훑지 않는다)
      const found = this.idem.get(slot);
      if (found?.response && now - found.at > retentionMs) this.idem.delete(slot);
      const e = this.idem.get(slot);
      if (e && e.fingerprint !== fingerprint) return err(422, 'IDEMPOTENCY_KEY_REUSED', '같은 멱등키로 다른 요청을 보냈습니다');
      if (e && !e.response) return err(409, 'IDEMPOTENT_REQUEST_PROCESSING', '같은 멱등키의 요청을 처리하고 있습니다');
      if (e?.response) return e.response;
    }
    const fault = this.takeFault(op, orderId);
    if (fault?.kind === 'throttle') return err(429, 'TOO_MANY_REQUESTS', '요청이 너무 많습니다');
    if (fault?.kind === 'in-progress') return err(409, 'IDEMPOTENT_REQUEST_PROCESSING', '같은 요청을 처리하고 있습니다');
    if (slot) this.idem.set(slot, { fingerprint, at: now });
    try {
      const r = await run(fault);
      const keep = r.store ?? (transient(r.response) ? undefined : r.response);
      if (slot) {
        if (keep) this.idem.set(slot, { fingerprint, at: this.clock.now(), response: keep });
        else this.idem.delete(slot);
      }
      return r.response;
    } catch (e) {
      if (slot) this.idem.delete(slot);
      throw e;
    }
  }

  private takeFault(op: Op, orderId: string | undefined): FaultKind | undefined {
    const i = this.faults.findIndex((a) => a.fault.op === op && (a.fault.orderId === undefined || a.fault.orderId === orderId) && a.remaining > 0);
    if (i < 0) return undefined;
    const armed = this.faults[i]!;
    armed.remaining -= 1;
    if (armed.remaining <= 0) this.faults.splice(i, 1);
    return armed.fault;
  }

  private expireIfDue(p: Payment): void {
    if (p.status === 'READY' && this.clock.now() - p.requestedAt > CONFIRM_DEADLINE_MS) this.setStatus(p, 'EXPIRED');
  }

  private approve(p: Payment): void {
    p.approvedAt = this.clock.now();
    p.balance = p.amount;
    p.lastTransactionKey = this.transactionKey();
    this.approvedByOrder.set(p.orderId, p.paymentKey);
    this.setStatus(p, 'DONE');
  }

  private setStatus(p: Payment, status: PaymentStatus): void {
    p.status = status;
    const at = kstIso(this.clock.now());
    this.events.push({
      paymentKey: p.paymentKey,
      ...(p.txId === undefined ? {} : { txId: p.txId }),
      headers: {
        'tosspayments-webhook-transmission-id': `wh_${randomBytes(12).toString('hex')}`,
        'tosspayments-webhook-transmission-time': at,
        'tosspayments-webhook-transmission-retried-count': '0',
      },
      body: { eventType: 'PAYMENT_STATUS_CHANGED', createdAt: at, data: this.view(p) },
    });
  }

  private transactionKey(): string {
    return `txsim_${randomBytes(10).toString('hex')}`;
  }

  /** Payment.card 모양. 토스에는 bin 칸이 없어 포트원 모양 결제에만 싣는다 */
  private cardView(p: Payment): Record<string, unknown> {
    const t = p.testCard;
    const number = t?.number ?? `43301234****${String(p.serial % 1000).padStart(3, '0')}*`;
    const bin = t?.bin === undefined ? number.slice(0, 8) : t.bin;
    return {
      issuerCode: t?.issuerCode === undefined ? '61' : t.issuerCode,
      acquirerCode: '31',
      number,
      cardType: t?.cardType ?? '신용',
      ownerType: '개인',
      approveNo: String(p.serial).padStart(8, '0'),
      amount: p.amount,
      ...(p.txId !== undefined && bin !== null ? { bin } : {}),
    };
  }

  /** 토스페이먼츠 Payment 객체 모양(필요한 칸만). 카드 정보는 합성 값이다 */
  private view(p: Payment): Record<string, unknown> {
    const approved = p.approvedAt !== undefined;
    const method = p.method ?? '카드';
    return {
      mId: 'peaketsim',
      version: '2022-11-16',
      paymentKey: p.paymentKey,
      type: 'NORMAL',
      orderId: p.orderId,
      orderName: p.orderName,
      status: p.status,
      requestedAt: kstIso(p.requestedAt),
      approvedAt: approved ? kstIso(p.approvedAt!) : null,
      totalAmount: p.amount,
      balanceAmount: p.balance,
      currency: 'KRW',
      method,
      card: approved && method === '카드' && p.testCard !== null ? this.cardView(p) : null,
      cancels: p.cancels.length
        ? p.cancels.map((c) => ({ cancelAmount: c.cancelAmount, cancelReason: c.cancelReason, canceledAt: kstIso(c.canceledAt), transactionKey: c.transactionKey }))
        : null,
      lastTransactionKey: p.lastTransactionKey ?? null,
      ...(p.txId === undefined ? {} : { txId: p.txId }),
    };
  }
}
