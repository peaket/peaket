// 토스페이먼츠 지급대행 HTTP 전송(F-07-6 LCH-110, settlement §5.2·§5.5·§8, ADR-0369 결정 1·7, guidelines §8.1 토스 지급 행).
// - 인증은 그 결제 상점 시크릿 키의 Basic(`base64(시크릿 키 + ':')`)이다. 쓰기(지급 요청·셀러 등록)는 그 상점 보안 키의 dir+A256GCM JWE 본문이고
//   Content-Type text/plain·TossPayments-api-security-mode: ENCRYPTION을 단다. 응답도(2xx·4xx 모두) JWE다. 지급 취소는 본문이 없고 암호화하지 않는다.
// - 읽기(단건 조회·셀러 조회·잔액·정산 조회)는 평문 JSON 응답이다. 경로·칸 이름은 공개 안내 모양 [가정]이다(toss-payout-shapes.ts).
// - 지급 요청은 던지지 않고 결과 넷(ACCEPTED·REJECTED·NO_RESPONSE·PROCESSING)을 돌려준다. 연결 실패·시간 초과·5xx·JWE 실패는 NO_RESPONSE(같은 키로 다시 보낸다),
//   409 IDEMPOTENT_REQUEST_PROCESSING은 PROCESSING이다. 그 밖 호출은 응답을 받지 못하거나 복호가 실패하면 TossTransportError를 던진다.
// - 받은 JWE를 거부하면 보안 로그 settlement_toss_jwe_invalid(상점만, 키·JWE 원문 없음, ASVS 16.3.4)를 남긴다. 계좌번호는 오류 메시지에 싣지 않는다.
import { createExternalHttpClient, type Clock, type ExternalHttpClient } from '@peaket/platform';
import type { SettlementApprovalLog, TossPayoutTransport, TossSellerRegistration, TossSendResult } from '../domain/ports.js';
import type { TossPayoutConfig } from '../domain/payout-adapters.js';
import type { PayoutStatus, PgStore, TossSellerStatus } from '../domain/settlement.js';
import { openTossJwe, sealTossJwe, TossJweError } from './toss-jwe.js';
import { TOSS_TRANSACTION_DESCRIPTION, TossBalanceBody, TossErrorBody, TossPayoutOne, TossPayoutsAccepted, TossSellerBody, TossSettlementRows, type TossPayoutRequestItem } from './toss-payout-shapes.js';

/** 응답을 받지 못했거나 쓸 수 없는 응답이다(결과를 지어내지 않는다). 메시지에 키·계좌번호·본문을 싣지 않는다 */
export class TossTransportError extends Error {
  constructor(readonly reason: string) {
    super(`토스페이먼츠 지급대행 호출 실패(${reason})`);
    this.name = 'TossTransportError';
  }
}

/** 시간 한도(ADR-0369 결정 1 [가정]): 쓰기 10초, 읽기 5초, 정산 조회 60초 */
const WRITE_TIMEOUT_MS = 10_000;
const READ_TIMEOUT_MS = 5_000;
const SETTLEMENT_TIMEOUT_MS = 60_000;
const IDEMPOTENT_PROCESSING = 'IDEMPOTENT_REQUEST_PROCESSING';
const KST_OFFSET_MS = 9 * 60 * 60 * 1_000;
const kstDate = (at: Date): string => new Date(at.getTime() + KST_OFFSET_MS).toISOString().slice(0, 10);

type Store = { secretKey: string; securityKeys: readonly Buffer[] };

export class HttpTossPayoutTransport implements TossPayoutTransport {
  readonly #client: ExternalHttpClient;
  readonly #config: TossPayoutConfig;
  readonly #clock: Clock;
  readonly #log: SettlementApprovalLog | undefined;

  constructor(config: TossPayoutConfig, o: { baseUrl: string; clock: Clock; log?: SettlementApprovalLog; fetch?: typeof fetch }) {
    this.#config = config;
    this.#clock = o.clock;
    this.#log = o.log;
    this.#client = createExternalHttpClient({ provider: 'tosspayments-payout', baseUrl: o.baseUrl, timeoutCapMs: WRITE_TIMEOUT_MS, clock: o.clock, ...(o.fetch ? { fetch: o.fetch } : {}) });
  }

  #store(pgStore: PgStore): Store {
    const s = this.#config.stores[pgStore];
    if (!s || s.securityKeys.length === 0) throw new TossTransportError(`store-unconfigured-${pgStore}`);
    return s;
  }

  #now(): Date {
    return new Date(this.#clock.now());
  }

  #auth(s: Store): string {
    return `Basic ${Buffer.from(`${s.secretKey}:`).toString('base64')}`;
  }

  /** 암호화한 쓰기 응답(2xx·4xx 모두 JWE)을 푼다. 풀지 못하면 보안 로그 뒤 undefined. JWE가 아닌 평문 오류는 그대로 읽는다 */
  async #openWrite(pgStore: PgStore, s: Store, text: string): Promise<unknown> {
    const trimmed = text.trim();
    if (trimmed.split('.').length === 5) {
      try {
        return await openTossJwe(trimmed, s.securityKeys);
      } catch (e) {
        if (e instanceof TossJweError) {
          this.#log?.tossJweInvalid?.({ pgStore, at: this.#now() });
          return undefined;
        }
        throw e;
      }
    }
    try {
      return JSON.parse(trimmed) as unknown;
    } catch {
      return undefined;
    }
  }

  async #send(r: Parameters<ExternalHttpClient['request']>[0]): Promise<{ status: number; text: string } | undefined> {
    try {
      const res = await this.#client.request(r);
      return { status: res.status, text: await res.text() };
    } catch {
      return undefined;
    }
  }

  async requestPayouts(pgStore: PgStore, input: { payoutDate: string; idempotencyKey: string; items: readonly { refPayoutId: string; amount: number; tossSellerId: string }[] }): Promise<TossSendResult> {
    let s: Store;
    try {
      s = this.#store(pgStore);
    } catch {
      return { kind: 'REJECTED', code: 'PAYOUT_STORE_UNCONFIGURED' };
    }
    const body: TossPayoutRequestItem[] = input.items.map((i) => ({
      refPayoutId: i.refPayoutId,
      destination: i.tossSellerId,
      scheduleType: 'SCHEDULED',
      payoutDate: input.payoutDate,
      amount: { currency: 'KRW', value: i.amount },
      transactionDescription: TOSS_TRANSACTION_DESCRIPTION,
    }));
    const jwe = await sealTossJwe(body, s.securityKeys[0]!, this.#now());
    const res = await this.#send({
      method: 'POST',
      path: '/v2/payouts',
      headers: { authorization: this.#auth(s), 'idempotency-key': input.idempotencyKey, 'content-type': 'text/plain', 'tosspayments-api-security-mode': 'ENCRYPTION' },
      body: jwe,
      timeoutCapMs: WRITE_TIMEOUT_MS,
    });
    if (!res || res.status >= 500) return { kind: 'NO_RESPONSE' };
    const payload = await this.#openWrite(pgStore, s, res.text);
    if (payload === undefined) return { kind: 'NO_RESPONSE' };
    if (res.status >= 200 && res.status < 300) {
      const ok = TossPayoutsAccepted.safeParse(payload);
      if (!ok.success) return { kind: 'NO_RESPONSE' };
      return { kind: 'ACCEPTED', payouts: ok.data.entityBody.items.map((p) => ({ refPayoutId: p.refPayoutId, pgPayoutId: p.id, status: p.status })) };
    }
    const err = TossErrorBody.safeParse(payload);
    if (!err.success) return { kind: 'NO_RESPONSE' };
    if (res.status === 409 && err.data.error.code === IDEMPOTENT_PROCESSING) return { kind: 'PROCESSING' };
    return { kind: 'REJECTED', code: err.data.error.code.slice(0, 100) };
  }

  async #read(pgStore: PgStore, path: string, o: { params?: Record<string, string>; query?: Record<string, string>; timeoutCapMs?: number } = {}): Promise<unknown> {
    const s = this.#store(pgStore);
    const res = await this.#send({ method: 'GET', path, ...(o.params ? { params: o.params } : {}), ...(o.query ? { query: o.query } : {}), headers: { authorization: this.#auth(s) }, timeoutCapMs: o.timeoutCapMs ?? READ_TIMEOUT_MS });
    if (!res) throw new TossTransportError('no-response');
    if (res.status < 200 || res.status >= 300) throw new TossTransportError(`status-${res.status}`);
    try {
      return JSON.parse(res.text) as unknown;
    } catch {
      throw new TossTransportError('json');
    }
  }

  async getPayout(pgStore: PgStore, pgPayoutId: string): Promise<{ pgPayoutId: string; status: PayoutStatus; errorCode?: string }> {
    const parsed = TossPayoutOne.safeParse(await this.#read(pgStore, '/v2/payouts/{id}', { params: { id: pgPayoutId } }));
    if (!parsed.success) throw new TossTransportError('shape');
    const p = parsed.data.entityBody;
    return { pgPayoutId: p.id, status: p.status, ...(p.error?.code ? { errorCode: p.error.code } : {}) };
  }

  async cancelPayout(pgStore: PgStore, pgPayoutId: string): Promise<{ pgPayoutId: string; status: PayoutStatus }> {
    const s = this.#store(pgStore);
    // 지급 취소는 본문이 없고 암호화하지 않는다(토스 공개 문서, settlement §8, ADR-0369 결정 14)
    const res = await this.#send({ method: 'POST', path: '/v2/payouts/{id}/cancel', params: { id: pgPayoutId }, headers: { authorization: this.#auth(s) }, timeoutCapMs: WRITE_TIMEOUT_MS });
    if (!res) throw new TossTransportError('no-response');
    if (res.status < 200 || res.status >= 300) throw new TossTransportError(`status-${res.status}`);
    let payload: unknown;
    try {
      payload = JSON.parse(res.text);
    } catch {
      throw new TossTransportError('json');
    }
    const parsed = TossPayoutOne.safeParse(payload);
    if (!parsed.success) throw new TossTransportError('shape');
    return { pgPayoutId: parsed.data.entityBody.id, status: parsed.data.entityBody.status };
  }

  async registerSeller(pgStore: PgStore, body: TossSellerRegistration): Promise<{ tossSellerId: string; status: TossSellerStatus }> {
    return this.#writeSeller(pgStore, body, '/v2/sellers');
  }

  /** 셀러 수정(POST /v2/sellers/{id}, 등록과 같은 JWE 본문·머리, F-07-7 계획 §5.1 (타) 결정 1). 없는 셀러(다른 상점 셀러 포함)는 TossTransportError */
  async updateSeller(pgStore: PgStore, tossSellerId: string, body: TossSellerRegistration): Promise<{ tossSellerId: string; status: TossSellerStatus }> {
    return this.#writeSeller(pgStore, body, '/v2/sellers/{id}', { id: tossSellerId });
  }

  async #writeSeller(pgStore: PgStore, body: TossSellerRegistration, path: string, params?: Record<string, string>): Promise<{ tossSellerId: string; status: TossSellerStatus }> {
    const s = this.#store(pgStore);
    const jwe = await sealTossJwe(body, s.securityKeys[0]!, this.#now());
    const res = await this.#send({
      method: 'POST',
      path,
      ...(params ? { params } : {}),
      headers: { authorization: this.#auth(s), 'content-type': 'text/plain', 'tosspayments-api-security-mode': 'ENCRYPTION' },
      body: jwe,
      timeoutCapMs: WRITE_TIMEOUT_MS,
    });
    if (!res) throw new TossTransportError('no-response');
    if (res.status >= 500) throw new TossTransportError(`status-${res.status}`);
    const payload = await this.#openWrite(pgStore, s, res.text);
    if (payload === undefined) throw new TossTransportError('jwe');
    if (res.status < 200 || res.status >= 300) {
      const err = TossErrorBody.safeParse(payload);
      throw new TossTransportError(err.success ? `rejected-${err.data.error.code.slice(0, 60)}` : `status-${res.status}`);
    }
    const parsed = TossSellerBody.safeParse(payload);
    if (!parsed.success) throw new TossTransportError('shape');
    return { tossSellerId: parsed.data.entityBody.id, status: parsed.data.entityBody.status };
  }

  async getSeller(pgStore: PgStore, tossSellerId: string): Promise<{ tossSellerId: string; status: TossSellerStatus }> {
    const parsed = TossSellerBody.safeParse(await this.#read(pgStore, '/v2/sellers/{id}', { params: { id: tossSellerId } }));
    if (!parsed.success) throw new TossTransportError('shape');
    return { tossSellerId: parsed.data.entityBody.id, status: parsed.data.entityBody.status };
  }

  async balance(pgStore: PgStore): Promise<{ availableAmount: number; pendingAmount: number }> {
    const parsed = TossBalanceBody.safeParse(await this.#read(pgStore, '/v2/balances'));
    if (!parsed.success) throw new TossTransportError('shape');
    return { availableAmount: parsed.data.entityBody.availableAmount.value, pendingAmount: parsed.data.entityBody.pendingAmount.value };
  }

  async listSettlementFees(pgStore: PgStore, from: Date, to: Date): Promise<number> {
    const parsed = TossSettlementRows.safeParse(await this.#read(pgStore, '/v1/settlements', { query: { startDate: kstDate(from), endDate: kstDate(to) }, timeoutCapMs: SETTLEMENT_TIMEOUT_MS }));
    if (!parsed.success) throw new TossTransportError('shape');
    return parsed.data.reduce((sum, row) => sum + row.fees.reduce((s, f) => s + f.fee, 0), 0);
  }
}
