// 포트원 플랫폼(파트너 정산) 모양 흉내(F-07-7 LCH-120 I-08 (b), ADR-0370 결정 1·7·8, settlement §3·§5.3). 시험·로컬 데모 전용이다.
// 경로·본문·응답 모양은 payment-svc 시험 대역(test/support/portone-platform-fake.ts)과 같다(공개 명세 v1.16.0을 읽고 정한 [가정], 계약 때 원문으로 맞춘다).
//   GET    /platform/bank-accounts/{bank}/{accountNumber}/holder  → 200 { holderName, accountVerificationId } · 없음 404
//   POST   /platform/partners · GET·PATCH /platform/partners/{id} · GET /platform/partners/{id}/schedule
//   POST   /platform/transfers/manual · GET·DELETE /platform/transfers/{id}
//   GET    /platform/payouts?bulkPayoutId= · /platform/account-transfers?from&until · /platform/partner-settlements?settlementDate=
// 상태는 메모리뿐이고, 계좌번호는 어디에도 기록(로그)하지 않는다(ASVS v5.0.0-16.2.5). 제어 API(/sim/portone/*)가 예금주·지급 내역·이체 원장·
// 예약된 변경·정산 내역과 장애(응답 없음·5xx·칸 이름 바꿈)를 넣는다.

export type PlatformTemplate =
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

export const PLATFORM_TEMPLATES: readonly PlatformTemplate[] = [
  'GET /platform/bank-accounts/{bank}/{accountNumber}/holder',
  'POST /platform/partners',
  'GET /platform/partners/{id}',
  'PATCH /platform/partners/{id}',
  'GET /platform/partners/{id}/schedule',
  'POST /platform/transfers/manual',
  'GET /platform/transfers/{id}',
  'DELETE /platform/transfers/{id}',
  'GET /platform/payouts',
  'GET /platform/account-transfers',
  'GET /platform/partner-settlements',
];

/** 장애 모양: timeout(응답 전에 연결을 끊음), 5xx(503), shape(칸 이름을 바꾼 응답) */
export type PlatformFaultMode = 'timeout' | '5xx' | 'shape';

interface Account {
  bank: string;
  number: string;
  holder: string;
}

interface Partner {
  id: string;
  name: string;
  account: Account;
  defaultContractId: string;
  scheduled: Account | null;
}

interface Transfer {
  id: string;
  partnerId: string;
  settlementAmount: number;
  settlementDate: string;
  status: 'SCHEDULED' | 'CANCELLED';
}

export interface PlatformPayout {
  id: string;
  bulkPayoutId: string;
  transferId: string;
  status: 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'STOPPED' | 'CANCELLED';
  completedAt: string | null;
  failureCode: string | null;
}

export interface PlatformAccountTransfer {
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

export interface PlatformPartnerSettlement {
  partnerId: string;
  transferId: string;
  settlementAmount: number;
}

/** 처리 결과. drop이면 응답을 쓰지 않고 연결을 끊는다 */
export type PlatformResponse = { readonly status: number; readonly body: unknown } | { readonly drop: true };

const ROUTES: readonly { method: string; re: RegExp; template: PlatformTemplate }[] = [
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

const isText = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const accountOf = (v: unknown): Account | undefined => {
  const a = v as { bank?: unknown; number?: unknown; holder?: unknown } | null | undefined;
  return a && isText(a.bank) && isText(a.number) && isText(a.holder) ? { bank: a.bank, number: a.number, holder: a.holder } : undefined;
};
const partnerView = (p: Partner) => ({
  id: p.id,
  name: p.name,
  account: { bank: p.account.bank, currency: 'KRW', number: p.account.number, holder: p.account.holder, status: 'VERIFIED' },
  defaultContractId: p.defaultContractId,
  status: 'APPROVED',
});
const transferView = (t: Transfer) => ({ type: 'MANUAL', id: t.id, partnerId: t.partnerId, status: t.status, settlementDate: t.settlementDate, settlementCurrency: 'KRW', settlementAmount: t.settlementAmount });

export class PortonePlatformSim {
  /** `${bank}:${accountNumber}` → 예금주 이름 */
  readonly #holders = new Map<string, string>();
  readonly #partners = new Map<string, Partner>();
  readonly #transfers = new Map<string, Transfer>();
  readonly #payouts: PlatformPayout[] = [];
  readonly #accountTransfers: PlatformAccountTransfer[] = [];
  readonly #settlements = new Map<string, PlatformPartnerSettlement[]>();
  readonly #faults = new Map<PlatformTemplate, { mode: PlatformFaultMode; remaining: number }>();
  #seq = 0;

  /** 이 경로가 플랫폼 경로인가(인증 머리 PortOne을 본다) */
  static owns(url: string): boolean {
    return url === '/platform' || url.startsWith('/platform/');
  }

  // ---- 제어 ----
  holder(bank: string, accountNumber: string, name: string): void {
    this.#holders.set(`${bank}:${accountNumber}`, name);
  }

  /** 파트너의 예약된 계좌 변경(/schedule). 없는 파트너면 false */
  schedule(partnerId: string, account: Account | null): boolean {
    const p = this.#partners.get(partnerId);
    if (!p) return false;
    p.scheduled = account;
    return true;
  }

  addPayouts(items: readonly PlatformPayout[]): void {
    for (const it of items) {
      const at = this.#payouts.findIndex((p) => p.id === it.id);
      if (at >= 0) this.#payouts[at] = { ...it };
      else this.#payouts.push({ ...it });
    }
  }

  addAccountTransfers(items: readonly PlatformAccountTransfer[]): void {
    for (const it of items) if (!this.#accountTransfers.some((t) => t.id === it.id)) this.#accountTransfers.push({ ...it });
  }

  setPartnerSettlements(settlementDate: string, items: readonly PlatformPartnerSettlement[]): void {
    this.#settlements.set(settlementDate, items.map((i) => ({ ...i })));
  }

  fault(template: PlatformTemplate, mode: PlatformFaultMode, times = Number.POSITIVE_INFINITY): void {
    this.#faults.set(template, { mode, remaining: times });
  }

  reset(): void {
    this.#holders.clear();
    this.#partners.clear();
    this.#transfers.clear();
    this.#payouts.length = 0;
    this.#accountTransfers.length = 0;
    this.#settlements.clear();
    this.#faults.clear();
    this.#seq = 0;
  }

  // ---- 플랫폼 경로 ----
  handle(method: string, pathname: string, query: Readonly<Record<string, string | undefined>>, body: unknown): PlatformResponse {
    const route = ROUTES.find((r) => r.method === method && r.re.test(pathname));
    if (!route) return { status: 404, body: { type: 'NOT_FOUND', message: '없는 경로입니다' } };
    const match = route.re.exec(pathname)!;
    const fault = this.#faults.get(route.template);
    let shape = false;
    if (fault && fault.remaining > 0) {
      fault.remaining -= 1;
      if (fault.mode === 'timeout') return { drop: true };
      if (fault.mode === '5xx') return { status: 503, body: { type: 'INTERNAL_SERVER_ERROR', message: '시뮬레이터 장애 주입' } };
      shape = true;
    }
    let p1: string;
    let p2: string;
    try {
      p1 = decodeURIComponent(match[1] ?? '');
      p2 = decodeURIComponent(match[2] ?? '');
    } catch {
      return { status: 400, body: { type: 'INVALID_REQUEST', message: '요청이 틀렸습니다' } };
    }
    const ok = (value: unknown) => ({ status: 200, body: value });
    const bad = { status: 400, body: { type: 'INVALID_REQUEST', message: '요청이 틀렸습니다' } };
    switch (route.template) {
      case 'GET /platform/bank-accounts/{bank}/{accountNumber}/holder': {
        const name = this.#holders.get(`${p1}:${p2}`);
        if (name === undefined) return { status: 404, body: { type: 'PLATFORM_ACCOUNT_HOLDER_NOT_FOUND', message: '예금주를 찾을 수 없습니다' } };
        this.#seq += 1;
        return ok(shape ? { name, verificationId: `av-${this.#seq}` } : { holderName: name, accountVerificationId: `av-${this.#seq}` });
      }
      case 'POST /platform/partners': {
        const b = body as { id?: unknown; name?: unknown; account?: { currency?: unknown }; defaultContractId?: unknown; contact?: { name?: unknown; email?: unknown; phoneNumber?: unknown }; type?: { business?: { companyName?: unknown; representativeName?: unknown; businessRegistrationNumber?: unknown } } } | null;
        const account = accountOf(b?.account);
        const business = b?.type?.business;
        if (
          !b ||
          !isText(b.id) ||
          !isText(b.name) ||
          !isText(b.defaultContractId) ||
          !account ||
          b.account?.currency !== 'KRW' ||
          !isText(b.contact?.name) ||
          !isText(b.contact?.email) ||
          !isText(b.contact?.phoneNumber) ||
          !isText(business?.companyName) ||
          !isText(business?.representativeName) ||
          typeof business?.businessRegistrationNumber !== 'string' ||
          !/^\d{10}$/.test(business.businessRegistrationNumber)
        )
          return bad;
        if (this.#partners.has(b.id)) return { status: 409, body: { type: 'PLATFORM_PARTNER_ID_ALREADY_EXISTS', message: '이미 있는 파트너입니다' } };
        const partner: Partner = { id: b.id, name: b.name, account, defaultContractId: b.defaultContractId, scheduled: null };
        this.#partners.set(partner.id, partner);
        return ok(shape ? { partnerInfo: partnerView(partner) } : { partner: partnerView(partner) });
      }
      case 'GET /platform/partners/{id}': {
        const partner = this.#partners.get(p1);
        if (!partner) return { status: 404, body: { type: 'PLATFORM_PARTNER_NOT_FOUND', message: '파트너를 찾을 수 없습니다' } };
        const view = partnerView(partner);
        if (!shape) return ok(view);
        const { account, ...rest } = view;
        return ok({ ...rest, settlementAccount: account });
      }
      case 'PATCH /platform/partners/{id}': {
        const partner = this.#partners.get(p1);
        if (!partner) return { status: 404, body: { type: 'PLATFORM_PARTNER_NOT_FOUND', message: '파트너를 찾을 수 없습니다' } };
        const account = accountOf((body as { account?: unknown } | null)?.account);
        if (!account) return bad;
        partner.account = account;
        return ok({ partner: partnerView(partner) });
      }
      case 'GET /platform/partners/{id}/schedule': {
        const partner = this.#partners.get(p1);
        if (!partner?.scheduled) return { status: 404, body: { type: 'PLATFORM_PARTNER_SCHEDULE_NOT_FOUND', message: '예약된 변경이 없습니다' } };
        return ok({ account: { bank: partner.scheduled.bank, currency: 'KRW', number: partner.scheduled.number, holder: partner.scheduled.holder } });
      }
      case 'POST /platform/transfers/manual': {
        const b = body as { id?: unknown; partnerId?: unknown; settlementAmount?: unknown; settlementDate?: unknown } | null;
        if (!b || !isText(b.id) || !isText(b.partnerId) || typeof b.settlementAmount !== 'number' || !Number.isSafeInteger(b.settlementAmount) || !isText(b.settlementDate)) return bad;
        if (this.#transfers.has(b.id)) return { status: 409, body: { type: 'PLATFORM_TRANSFER_ALREADY_EXISTS', message: '이미 있는 정산건입니다' } };
        const t: Transfer = { id: b.id, partnerId: b.partnerId, settlementAmount: b.settlementAmount, settlementDate: b.settlementDate, status: 'SCHEDULED' };
        this.#transfers.set(t.id, t);
        return ok({ transfer: transferView(t) });
      }
      case 'GET /platform/transfers/{id}': {
        const t = this.#transfers.get(p1);
        return t ? ok(transferView(t)) : { status: 404, body: { type: 'PLATFORM_TRANSFER_NOT_FOUND', message: '정산건을 찾을 수 없습니다' } };
      }
      case 'DELETE /platform/transfers/{id}': {
        const t = this.#transfers.get(p1);
        if (!t) return { status: 404, body: { type: 'PLATFORM_TRANSFER_NOT_FOUND', message: '정산건을 찾을 수 없습니다' } };
        t.status = 'CANCELLED';
        return ok({});
      }
      case 'GET /platform/payouts': {
        const items = this.#payouts.filter((p) => p.bulkPayoutId === query.bulkPayoutId);
        return ok(shape ? { list: items } : { items });
      }
      case 'GET /platform/account-transfers': {
        const from = Date.parse(query.from ?? '');
        const until = Date.parse(query.until ?? '');
        const items = this.#accountTransfers.filter((t) => {
          const at = Date.parse(t.tradedAt);
          return (Number.isNaN(from) || at >= from) && (Number.isNaN(until) || at <= until);
        });
        // 칸 이름을 바꾼 모양(J-T22 ③): amount → transferAmount, tradedAt → tradeDate
        return ok({ items: shape ? items.map(({ amount, tradedAt, ...rest }) => ({ ...rest, transferAmount: amount, tradeDate: tradedAt })) : items });
      }
      case 'GET /platform/partner-settlements': {
        const items = this.#settlements.get(query.settlementDate ?? '') ?? [];
        return ok(shape ? { rows: items } : { items });
      }
    }
  }
}
