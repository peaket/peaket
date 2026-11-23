// 포트원 플랫폼(파트너 정산) API 대역 서버(F-07-7 시험, LCH-120, ADR-0370 결정 1·7·8, settlement §3·§5.3).
// 결제사를 한 번도 부르지 않는다(계획 Q-01). 공개 명세 v1.16.0을 읽고 정한 경로·모양 [가정]이고, 계약 때 원문으로 맞춘다(계획 정리 목록 C-01).
// 구현(HttpPortonePlatformTransport)은 이 대역이 받는 요청·주는 응답의 모양을 따른다. 시험이 고정한 뒤에는 구현 담당이 고치지 않는다.
//
// 받는 요청(머리 `Authorization: PortOne {secret}`가 아니면 401):
//   GET    /platform/bank-accounts/{bank}/{accountNumber}/holder  → 200 { holderName, accountVerificationId } · 없는 계좌 404 { type: 'PLATFORM_ACCOUNT_HOLDER_NOT_FOUND' }
//   POST   /platform/partners      본문 { id, name, contact{ name, email, phoneNumber }, account{ bank, currency, number, holder }, defaultContractId, type{ business{ companyName, representativeName, businessRegistrationNumber } } }
//                                  → 200 { partner } · 같은 id 409 { type: 'PLATFORM_PARTNER_ID_ALREADY_EXISTS' } · 칸 빠짐 400
//   GET    /platform/partners/{id} → 200 partner · 없음 404
//   PATCH  /platform/partners/{id} 본문 { account{ bank, currency, number, holder } } → 200 { partner }
//   GET    /platform/partners/{id}/schedule → 200 { account{…} }(예약된 변경) · 없음 404 { type: 'PLATFORM_PARTNER_SCHEDULE_NOT_FOUND' }
//   POST   /platform/transfers/manual 본문 { id, partnerId, settlementAmount, settlementDate } → 200 { transfer } · 같은 id 409 { type: 'PLATFORM_TRANSFER_ALREADY_EXISTS' }
//   GET    /platform/transfers/{id} → 200 transfer · 없음 404
//   DELETE /platform/transfers/{id} → 200 {} (수기 정산건 취소 [가정 경로]) · 없음 404
//   GET    /platform/payouts?bulkPayoutId= → 200 { items: [{ id, bulkPayoutId, transferId, status, completedAt, failureCode }] }
//   GET    /platform/account-transfers?from&until → 200 { items: [{ id, type, withdrawalType, payoutId, amount, bank, accountNumber, holderName, balance, tradedAt }] }
//   GET    /platform/partner-settlements?settlementDate= → 200 { items: [{ partnerId, transferId, settlementAmount }] }
// 장애 주입(fault): 'reset'(응답 전에 연결을 끊음 = 응답 없음), '5xx'(503), 'shape'(칸 이름을 바꾼 응답, 녹화 응답의 칸 바꾸기 J-T22 ③).
// 받은 요청은 경로 틀(template)과 함께 남긴다. 계좌번호가 든 실제 경로·본문은 시험의 단언에만 쓴다.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

export type PortoneFakeTemplate =
  | 'GET /platform/bank-accounts/{bank}/{accountNumber}/holder'
  | 'POST /platform/partners'
  | 'GET /platform/partners/{id}'
  | 'PATCH /platform/partners/{id}'
  | 'GET /platform/partners/{id}/schedule'
  | 'POST /platform/transfers/manual'
  | 'GET /platform/transfers/{id}'
  | 'DELETE /platform/transfers/{id}'
  | 'GET /platform/payouts'
  | 'GET /platform/account-transfers'
  | 'GET /platform/partner-settlements';

export type PortoneFaultMode = 'reset' | '5xx' | 'shape';

export interface PortoneFakeRequest {
  method: string;
  template: PortoneFakeTemplate | 'unmatched';
  path: string;
  query: Record<string, string>;
  authorization: string | undefined;
  body: unknown;
}

export interface FakeAccount {
  bank: string;
  number: string;
  holder: string;
}

export interface FakePartner {
  id: string;
  name: string;
  account: FakeAccount;
  defaultContractId: string;
  scheduled: FakeAccount | null;
}

export interface FakeTransfer {
  id: string;
  partnerId: string;
  settlementAmount: number;
  settlementDate: string;
  status: 'SCHEDULED' | 'CANCELLED';
}

export interface FakePayout {
  id: string;
  bulkPayoutId: string;
  transferId: string;
  status: 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'STOPPED' | 'CANCELLED';
  completedAt: string | null;
  failureCode: string | null;
}

export interface FakeAccountTransfer {
  id: string;
  type: 'WITHDRAWAL' | 'DEPOSIT';
  withdrawalType: string | null;
  payoutId: string | null;
  amount: number;
  bank: string | null;
  accountNumber: string | null;
  holderName: string | null;
  balance: number | null;
  tradedAt: string;
}

export interface FakePartnerSettlement {
  partnerId: string;
  transferId: string;
  settlementAmount: number;
}

const ROUTES: readonly { method: string; re: RegExp; template: PortoneFakeTemplate }[] = [
  { method: 'GET', re: /^\/platform\/bank-accounts\/([^/]+)\/([^/]+)\/holder$/, template: 'GET /platform/bank-accounts/{bank}/{accountNumber}/holder' },
  { method: 'POST', re: /^\/platform\/partners$/, template: 'POST /platform/partners' },
  { method: 'GET', re: /^\/platform\/partners\/([^/]+)\/schedule$/, template: 'GET /platform/partners/{id}/schedule' },
  { method: 'GET', re: /^\/platform\/partners\/([^/]+)$/, template: 'GET /platform/partners/{id}' },
  { method: 'PATCH', re: /^\/platform\/partners\/([^/]+)$/, template: 'PATCH /platform/partners/{id}' },
  { method: 'POST', re: /^\/platform\/transfers\/manual$/, template: 'POST /platform/transfers/manual' },
  { method: 'GET', re: /^\/platform\/transfers\/([^/]+)$/, template: 'GET /platform/transfers/{id}' },
  { method: 'DELETE', re: /^\/platform\/transfers\/([^/]+)$/, template: 'DELETE /platform/transfers/{id}' },
  { method: 'GET', re: /^\/platform\/payouts$/, template: 'GET /platform/payouts' },
  { method: 'GET', re: /^\/platform\/account-transfers$/, template: 'GET /platform/account-transfers' },
  { method: 'GET', re: /^\/platform\/partner-settlements$/, template: 'GET /platform/partner-settlements' },
];

const partnerView = (p: FakePartner) => ({
  id: p.id,
  name: p.name,
  account: { bank: p.account.bank, currency: 'KRW', number: p.account.number, holder: p.account.holder, status: 'VERIFIED' },
  defaultContractId: p.defaultContractId,
  status: 'APPROVED',
});
const transferView = (t: FakeTransfer) => ({ type: 'MANUAL', id: t.id, partnerId: t.partnerId, status: t.status, settlementDate: t.settlementDate, settlementCurrency: 'KRW', settlementAmount: t.settlementAmount });

const isText = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

export class PortonePlatformFake {
  readonly requests: PortoneFakeRequest[] = [];
  /** `${bank}:${accountNumber}` → 예금주 조회가 돌려줄 이름 */
  readonly holders = new Map<string, string>();
  readonly partners = new Map<string, FakePartner>();
  readonly transfers = new Map<string, FakeTransfer>();
  readonly payouts: FakePayout[] = [];
  readonly accountTransfers: FakeAccountTransfer[] = [];
  /** 정산일 → 정산 내역 */
  readonly partnerSettlements = new Map<string, FakePartnerSettlement[]>();
  readonly #faults = new Map<PortoneFakeTemplate, { mode: PortoneFaultMode; remaining: number }>();
  /** 요청을 받을 때마다 부른다(토스 대역과 한 줄로 차례를 볼 때) */
  onRequest: ((r: PortoneFakeRequest) => void) | undefined;
  #server: Server | undefined;
  #url = '';

  constructor(readonly secret: string) {}

  get url(): string {
    if (!this.#url) throw new Error('대역 서버를 먼저 띄운다(start)');
    return this.#url;
  }

  holder(bank: string, accountNumber: string, name: string): void {
    this.holders.set(`${bank}:${accountNumber}`, name);
  }

  /** 다음 `times`번(기본 늘) 그 경로에 장애를 낸다 */
  fault(template: PortoneFakeTemplate, mode: PortoneFaultMode, times = Number.POSITIVE_INFINITY): void {
    this.#faults.set(template, { mode, remaining: times });
  }

  clearFaults(): void {
    this.#faults.clear();
  }

  calls(template: PortoneFakeTemplate): PortoneFakeRequest[] {
    return this.requests.filter((r) => r.template === template);
  }

  reset(): void {
    this.requests.length = 0;
    this.holders.clear();
    this.partners.clear();
    this.transfers.clear();
    this.payouts.length = 0;
    this.accountTransfers.length = 0;
    this.partnerSettlements.clear();
    this.#faults.clear();
    this.onRequest = undefined;
  }

  async start(): Promise<void> {
    this.#server = createServer((req, res) => void this.#handle(req, res));
    // real-time: 포트원 플랫폼 전송 어댑터의 실제 HTTP 경계(경로 틀·Authorization·본문)를 보려고 127.0.0.1에 포트를 연다 F-07-7
    await new Promise<void>((resolve) => this.#server!.listen(0, '127.0.0.1', resolve));
    const address = this.#server.address();
    if (!address || typeof address === 'string') throw new Error('대역 서버 주소를 읽지 못했다');
    this.#url = `http://127.0.0.1:${address.port}`;
  }

  async close(): Promise<void> {
    const s = this.#server;
    this.#server = undefined;
    if (!s) return;
    s.closeAllConnections();
    await new Promise<void>((resolve, reject) => s.close((e) => (e ? reject(e) : resolve())));
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    let body: unknown = null;
    if (raw !== '') {
      try {
        body = JSON.parse(raw);
      } catch {
        body = raw;
      }
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const route = ROUTES.find((r) => r.method === req.method && r.re.test(url.pathname));
    const match = route ? route.re.exec(url.pathname) : null;
    const record: PortoneFakeRequest = {
      method: req.method ?? '',
      template: route?.template ?? 'unmatched',
      path: url.pathname,
      query: Object.fromEntries(url.searchParams.entries()),
      authorization: req.headers.authorization,
      body,
    };
    this.requests.push(record);
    this.onRequest?.(record);
    const send = (status: number, value: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(value));
    };
    if (!route || !match) return send(404, { type: 'NOT_FOUND' });
    if (req.headers.authorization !== `PortOne ${this.secret}`) return send(401, { type: 'UNAUTHORIZED' });
    const fault = this.#faults.get(route.template);
    let shape = false;
    if (fault && fault.remaining > 0) {
      fault.remaining -= 1;
      if (fault.mode === 'reset') {
        req.socket.destroy();
        return;
      }
      if (fault.mode === '5xx') return send(503, { type: 'INTERNAL_SERVER_ERROR', message: '대역 서버 장애 주입' });
      shape = true;
    }
    const p1 = decodeURIComponent(match[1] ?? '');
    const p2 = decodeURIComponent(match[2] ?? '');
    switch (route.template) {
      case 'GET /platform/bank-accounts/{bank}/{accountNumber}/holder': {
        const name = this.holders.get(`${p1}:${p2}`);
        if (name === undefined) return send(404, { type: 'PLATFORM_ACCOUNT_HOLDER_NOT_FOUND' });
        return send(200, shape ? { name, verificationId: 'av-1' } : { holderName: name, accountVerificationId: `av-${this.requests.length}` });
      }
      case 'POST /platform/partners': {
        const b = body as { id?: unknown; name?: unknown; account?: { bank?: unknown; number?: unknown; holder?: unknown }; defaultContractId?: unknown } | null;
        const contact = (body as { contact?: { name?: unknown; email?: unknown; phoneNumber?: unknown } } | null)?.contact;
        const business = (body as { type?: { business?: { companyName?: unknown; representativeName?: unknown; businessRegistrationNumber?: unknown } } } | null)?.type?.business;
        const acc = (body as { account?: { currency?: unknown } } | null)?.account;
        if (
          !b ||
          !isText(b.id) ||
          !isText(b.name) ||
          !isText(b.defaultContractId) ||
          !isText(b.account?.bank) ||
          !isText(b.account?.number) ||
          !isText(b.account?.holder) ||
          acc?.currency !== 'KRW' ||
          !isText(contact?.name) ||
          !isText(contact?.email) ||
          !isText(contact?.phoneNumber) ||
          !isText(business?.companyName) ||
          !isText(business?.representativeName) ||
          typeof business?.businessRegistrationNumber !== 'string' ||
          !/^\d{10}$/.test(business.businessRegistrationNumber)
        )
          return send(400, { type: 'INVALID_REQUEST' });
        if (this.partners.has(b.id)) return send(409, { type: 'PLATFORM_PARTNER_ID_ALREADY_EXISTS' });
        const partner: FakePartner = { id: b.id, name: b.name, account: { bank: b.account.bank, number: b.account.number, holder: b.account.holder }, defaultContractId: b.defaultContractId, scheduled: null };
        this.partners.set(partner.id, partner);
        return send(200, shape ? { partnerInfo: partnerView(partner) } : { partner: partnerView(partner) });
      }
      case 'GET /platform/partners/{id}': {
        const partner = this.partners.get(p1);
        if (!partner) return send(404, { type: 'PLATFORM_PARTNER_NOT_FOUND' });
        const view = partnerView(partner);
        return send(200, shape ? { ...view, account: undefined, settlementAccount: view.account } : view);
      }
      case 'PATCH /platform/partners/{id}': {
        const partner = this.partners.get(p1);
        if (!partner) return send(404, { type: 'PLATFORM_PARTNER_NOT_FOUND' });
        const a = (body as { account?: { bank?: unknown; number?: unknown; holder?: unknown } } | null)?.account;
        if (!a || !isText(a.bank) || !isText(a.number) || !isText(a.holder)) return send(400, { type: 'INVALID_REQUEST' });
        partner.account = { bank: a.bank, number: a.number, holder: a.holder };
        return send(200, { partner: partnerView(partner) });
      }
      case 'GET /platform/partners/{id}/schedule': {
        const partner = this.partners.get(p1);
        if (!partner?.scheduled) return send(404, { type: 'PLATFORM_PARTNER_SCHEDULE_NOT_FOUND' });
        return send(200, { account: { bank: partner.scheduled.bank, currency: 'KRW', number: partner.scheduled.number, holder: partner.scheduled.holder } });
      }
      case 'POST /platform/transfers/manual': {
        const b = body as { id?: unknown; partnerId?: unknown; settlementAmount?: unknown; settlementDate?: unknown } | null;
        if (!b || !isText(b.id) || !isText(b.partnerId) || typeof b.settlementAmount !== 'number' || !isText(b.settlementDate)) return send(400, { type: 'INVALID_REQUEST' });
        if (this.transfers.has(b.id)) return send(409, { type: 'PLATFORM_TRANSFER_ALREADY_EXISTS' });
        const t: FakeTransfer = { id: b.id, partnerId: b.partnerId, settlementAmount: b.settlementAmount, settlementDate: b.settlementDate, status: 'SCHEDULED' };
        this.transfers.set(t.id, t);
        return send(200, { transfer: transferView(t) });
      }
      case 'GET /platform/transfers/{id}': {
        const t = this.transfers.get(p1);
        if (!t) return send(404, { type: 'PLATFORM_TRANSFER_NOT_FOUND' });
        return send(200, transferView(t));
      }
      case 'DELETE /platform/transfers/{id}': {
        const t = this.transfers.get(p1);
        if (!t) return send(404, { type: 'PLATFORM_TRANSFER_NOT_FOUND' });
        t.status = 'CANCELLED';
        return send(200, {});
      }
      case 'GET /platform/payouts': {
        const bulk = url.searchParams.get('bulkPayoutId');
        const items = this.payouts.filter((p) => p.bulkPayoutId === bulk);
        return send(200, shape ? { list: items } : { items });
      }
      case 'GET /platform/account-transfers': {
        const from = Date.parse(url.searchParams.get('from') ?? '');
        const until = Date.parse(url.searchParams.get('until') ?? '');
        const items = this.accountTransfers.filter((t) => {
          const at = Date.parse(t.tradedAt);
          return (Number.isNaN(from) || at >= from) && (Number.isNaN(until) || at <= until);
        });
        // 녹화 응답의 칸 이름을 바꾼 모양(J-T22 ③): amount → transferAmount, tradedAt → tradeDate
        return send(200, { items: shape ? items.map(({ amount, tradedAt, ...rest }) => ({ ...rest, transferAmount: amount, tradeDate: tradedAt })) : items });
      }
      case 'GET /platform/partner-settlements': {
        const items = this.partnerSettlements.get(url.searchParams.get('settlementDate') ?? '') ?? [];
        return send(200, shape ? { rows: items } : { items });
      }
    }
  }
}
