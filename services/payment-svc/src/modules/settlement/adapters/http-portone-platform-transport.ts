// 포트원 플랫폼(파트너 정산) API 전송(F-07-7 계획 I-02·§5.1 (나), ADR-0370 결정 1·7·8, guidelines §8 포트원 플랫폼 행, settlement §3·§5.3).
// - 결제와 같은 포트원 주소·시크릿(Authorization: PortOne {secret})으로 플랫폼 createExternalHttpClient를 부른다. span 이름·url.template·정규 로그 줄은 경로 틀만 남는다
//   (예금주 조회는 /platform/bank-accounts/{bank}/{accountNumber}/holder, J-T17). 응답 본문·예금주명은 로그에 싣지 않는다.
// - 은행은 PEAKET 두 자리 코드를 포트원 Bank 열거값으로 바꿔 보내고(portone-platform-shapes.ts 대응표), 돌려받은 계좌는 끝 4자리로만 줄여 돌려준다.
// - 응답 없음(연결 실패·시간 초과·5xx)은 NO_RESPONSE, 그 밖의 거절 상태는 REJECTED, 응답 모양 틀림은 SHAPE로 PortoneTransportError를 던진다. 오류 글에 계좌번호·본문이 없다.
import { createExternalHttpClient, type Clock, type ExternalHttpClient, type ExternalRequest } from '@peaket/platform';
import type { z } from 'zod';
import type { PayoutAccountInput, PayoutCompany, PortoneAccountTransfer, PortonePayoutItem, PortonePlatformTransport } from '../domain/ports.js';
import type { PortonePayoutConfig } from '../domain/payout-adapters.js';
import {
  AccountTransfersAnswer,
  HolderAnswer,
  PartnerAnswer,
  PartnerSettlementsAnswer,
  PartnerView,
  PayoutsAnswer,
  peaketBankCode,
  portoneBankEnum,
  ScheduleAnswer,
  TransferAnswer,
  TransferView,
} from './portone-platform-shapes.js';

export type PortoneTransportErrorKind = 'NO_RESPONSE' | 'REJECTED' | 'SHAPE';

/** 포트원 플랫폼 호출 실패. 메시지에는 종류·상태·경로 틀만 있고 계좌번호·본문·시크릿이 없다 */
export class PortoneTransportError extends Error {
  constructor(
    readonly kind: PortoneTransportErrorKind,
    readonly template: string,
    readonly status?: number,
  ) {
    super(`포트원 플랫폼 호출 실패(${kind}${status === undefined ? '' : ` ${status}`}, ${template})`);
    this.name = 'PortoneTransportError';
  }
}

/** 시간 한도: 결제 조회의 뒤따르는 조회와 같은 10초 [가정](payment PORTONE_FOLLOW_UP_TIMEOUT_MS) */
const TIMEOUT_MS = 10_000;
const PROVIDER = 'portone-platform';

const last4 = (number: string): string => number.replace(/\D/g, '').slice(-4);

export class HttpPortonePlatformTransport implements PortonePlatformTransport {
  readonly #client: ExternalHttpClient;
  readonly #auth: string;

  constructor(config: PortonePayoutConfig, o: { clock: Clock; fetch?: typeof fetch }) {
    this.#auth = `PortOne ${config.secret}`;
    this.#client = createExternalHttpClient({ provider: PROVIDER, baseUrl: config.baseUrl, timeoutCapMs: TIMEOUT_MS, clock: o.clock, ...(o.fetch ? { fetch: o.fetch } : {}) });
  }

  /** 한 번 부른다. 응답을 받으면 상태·본문(JSON, 없으면 undefined)을 돌려주고, 받지 못하거나 5xx면 NO_RESPONSE로 던진다 */
  async #call(method: ExternalRequest['method'], path: string, o: { params?: Record<string, string>; query?: Record<string, string>; body?: unknown } = {}): Promise<{ status: number; json: unknown }> {
    const template = `${method} ${path}`;
    let res: Response;
    try {
      res = await this.#client.request({
        method,
        path,
        ...(o.params ? { params: o.params } : {}),
        ...(o.query ? { query: o.query } : {}),
        headers: { authorization: this.#auth, ...(o.body !== undefined ? { 'content-type': 'application/json' } : {}) },
        ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {}),
        timeoutCapMs: TIMEOUT_MS,
      });
    } catch {
      throw new PortoneTransportError('NO_RESPONSE', template);
    }
    if (res.status >= 500) throw new PortoneTransportError('NO_RESPONSE', template, res.status);
    let text: string;
    try {
      text = await res.text();
    } catch {
      throw new PortoneTransportError('NO_RESPONSE', template, res.status);
    }
    let json: unknown;
    if (text.trim() !== '') {
      try {
        json = JSON.parse(text) as unknown;
      } catch {
        throw new PortoneTransportError('SHAPE', template, res.status);
      }
    }
    return { status: res.status, json };
  }

  #ok<T extends z.ZodTypeAny>(r: { status: number; json: unknown }, schema: T, template: string): z.infer<T> {
    if (r.status < 200 || r.status >= 300) throw new PortoneTransportError('REJECTED', template, r.status);
    const parsed = schema.safeParse(r.json);
    if (!parsed.success) throw new PortoneTransportError('SHAPE', template, r.status);
    return parsed.data as z.infer<T>;
  }

  #bank(bankCode: string, template: string): string {
    const e = portoneBankEnum(bankCode);
    if (!e) throw new PortoneTransportError('REJECTED', template);
    return e;
  }

  #account(a: { bank: string; number: string; holder: string }, template: string): { bankCode: string; accountLast4: string; holderName: string } {
    const bankCode = peaketBankCode(a.bank);
    if (!bankCode) throw new PortoneTransportError('SHAPE', template);
    return { bankCode, accountLast4: last4(a.number), holderName: a.holder };
  }

  async lookupHolder(input: { bankCode: string; accountNumber: string }): Promise<{ holderName: string } | null> {
    const path = '/platform/bank-accounts/{bank}/{accountNumber}/holder';
    const template = `GET ${path}`;
    const r = await this.#call('GET', path, { params: { bank: this.#bank(input.bankCode, template), accountNumber: input.accountNumber } });
    if (r.status === 404) return null;
    return { holderName: this.#ok(r, HolderAnswer, template).holderName };
  }

  async registerPartner(input: { partnerId: string; contractId: string; company: PayoutCompany; account: PayoutAccountInput }): Promise<{ partnerId: string }> {
    const path = '/platform/partners';
    const template = `POST ${path}`;
    const c = input.company;
    const body = {
      id: input.partnerId,
      name: c.name,
      contact: { name: c.representativeName, email: c.email, phoneNumber: c.phone },
      account: { bank: this.#bank(input.account.bankCode, template), currency: 'KRW', number: input.account.accountNumber, holder: input.account.holderName },
      defaultContractId: input.contractId,
      type: { business: { companyName: c.name, representativeName: c.representativeName, businessRegistrationNumber: c.businessRegistrationNumber } },
    };
    const r = await this.#call('POST', path, { body });
    return { partnerId: this.#ok(r, PartnerAnswer, template).partner.id };
  }

  async updatePartnerAccount(partnerId: string, account: PayoutAccountInput): Promise<void> {
    const path = '/platform/partners/{id}';
    const template = `PATCH ${path}`;
    const r = await this.#call('PATCH', path, { params: { id: partnerId }, body: { account: { bank: this.#bank(account.bankCode, template), currency: 'KRW', number: account.accountNumber, holder: account.holderName } } });
    this.#ok(r, PartnerAnswer, template);
  }

  async getPartner(partnerId: string): Promise<{ partnerId: string; bankCode: string; accountLast4: string; holderName: string; scheduled: { bankCode: string; accountLast4: string; holderName: string } | null }> {
    const path = '/platform/partners/{id}';
    const template = `GET ${path}`;
    const partner = this.#ok(await this.#call('GET', path, { params: { id: partnerId } }), PartnerView, template);
    const current = this.#account(partner.account, template);
    const schedulePath = '/platform/partners/{id}/schedule';
    const scheduleTemplate = `GET ${schedulePath}`;
    const s = await this.#call('GET', schedulePath, { params: { id: partnerId } });
    const scheduled = s.status === 404 ? null : this.#account(this.#ok(s, ScheduleAnswer, scheduleTemplate).account, scheduleTemplate);
    return { partnerId: partner.id, ...current, scheduled };
  }

  async createManualTransfer(input: { transferId: string; partnerId: string; amount: number; settlementDate: string }): Promise<{ transferId: string; created: boolean }> {
    const path = '/platform/transfers/manual';
    const template = `POST ${path}`;
    const r = await this.#call('POST', path, { body: { id: input.transferId, partnerId: input.partnerId, settlementAmount: input.amount, settlementDate: input.settlementDate } });
    if (r.status === 409) {
      // 같은 아이디가 이미 있다: 금액·정산일이 같을 때만 같은 건으로 본다(다르면 멈춘다)
      const existing = await this.getManualTransfer(input.transferId);
      if (existing && existing.amount === input.amount && existing.settlementDate === input.settlementDate) return { transferId: input.transferId, created: false };
      throw new PortoneTransportError('REJECTED', template, 409);
    }
    return { transferId: this.#ok(r, TransferAnswer, template).transfer.id, created: true };
  }

  async getManualTransfer(transferId: string): Promise<{ transferId: string; amount: number; settlementDate: string; status: string } | null> {
    const path = '/platform/transfers/{id}';
    const template = `GET ${path}`;
    const r = await this.#call('GET', path, { params: { id: transferId } });
    if (r.status === 404) return null;
    const t = this.#ok(r, TransferView, template);
    return { transferId: t.id, amount: t.settlementAmount, settlementDate: t.settlementDate, status: t.status };
  }

  async cancelManualTransfer(transferId: string): Promise<void> {
    const path = '/platform/transfers/{id}';
    const template = `DELETE ${path}`;
    const r = await this.#call('DELETE', path, { params: { id: transferId } });
    if (r.status < 200 || r.status >= 300) throw new PortoneTransportError('REJECTED', template, r.status);
  }

  async listPayouts(input: { bulkPayoutId: string }): Promise<readonly PortonePayoutItem[]> {
    const path = '/platform/payouts';
    const template = `GET ${path}`;
    const a = this.#ok(await this.#call('GET', path, { query: { bulkPayoutId: input.bulkPayoutId } }), PayoutsAnswer, template);
    return a.items.map((p) => ({ payoutId: p.id, transferId: p.transferId, status: p.status, completedAt: p.completedAt === null ? null : new Date(p.completedAt), failureCode: p.failureCode }));
  }

  async listAccountTransfers(input: { from: Date; to: Date }): Promise<readonly PortoneAccountTransfer[]> {
    const path = '/platform/account-transfers';
    const template = `GET ${path}`;
    const a = this.#ok(await this.#call('GET', path, { query: { from: input.from.toISOString(), until: input.to.toISOString() } }), AccountTransfersAnswer, template);
    return a.items.map((t) => {
      const transferredAt = new Date(t.tradedAt);
      if (Number.isNaN(transferredAt.getTime())) throw new PortoneTransportError('SHAPE', template);
      return {
        transferId: t.id,
        type: t.type,
        withdrawalType: t.withdrawalType,
        payoutId: t.payoutId,
        amount: t.amount,
        bankCode: t.bank === null ? null : (peaketBankCode(t.bank) ?? null),
        accountLast4: t.accountNumber === null ? null : last4(t.accountNumber),
        holderName: t.holderName,
        balance: t.balance,
        transferredAt,
      };
    });
  }

  async listPartnerSettlements(settlementDate: string): Promise<readonly { partnerId: string; transferId: string; amount: number }[]> {
    const path = '/platform/partner-settlements';
    const template = `GET ${path}`;
    const a = this.#ok(await this.#call('GET', path, { query: { settlementDate } }), PartnerSettlementsAnswer, template);
    return a.items.map((s) => ({ partnerId: s.partnerId, transferId: s.transferId, amount: s.settlementAmount }));
  }
}
