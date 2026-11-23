// 토스페이먼츠 지급대행 API 대역 서버(F-07-6 LCH-110, settlement §5.2·§5.5·§8, ADR-0369 결정 1·3·7). 시험 안에서만 띄우는 로컬 HTTP 서버다.
// 결제사를 절대 부르지 않는다. 경로·머리·본문 칸은 공개 안내를 읽은 모양 [가정]이고(ADR-0369 '남는 한계', 정리 목록 C-03), 구현의
// adapters/toss-payout-shapes.ts가 이 모양을 읽어야 한다. 이 파일이 그 모양의 시험 쪽 원본이다.
//
// 공개 안내 모양 [가정]:
// - 인증: 모든 요청 `Authorization: Basic base64(<결제 상점 시크릿 키> + ':')`. 시크릿 키로 결제 상점(STANDARD·ESCROW)을 가른다.
// - 쓰기 요청(POST /v2/payouts, POST /v2/payouts/{id}/cancel, POST /v2/sellers): 본문은 그 상점 보안 키로 만든 JWE compact
//   (`alg=dir`, `enc=A256GCM`, 사용자 머리 `iat`·`nonce`), `Content-Type: text/plain`. 응답 본문도(2xx·4xx 모두) 같은 꼴의 JWE다.
//   지급 요청은 `Idempotency-Key`가 있어야 하고, 같은 키는 처음 응답을 그대로 돌려준다(새 지급을 만들지 않는다).
// - 읽기 요청(GET /v2/payouts/{id}, GET /v2/sellers/{id}, GET /v2/balances, GET /v1/settlements): 응답은 평문 JSON이다.
// - v2 응답 봉투: `{ version, traceId, entityType, entityBody }`. 오류는 `{ version, traceId, error: { code, message } }`.
// - 지급 요청 평문: 배열 `[{ refPayoutId, destination(토스 셀러 ID), scheduleType: 'SCHEDULED', payoutDate, amount: { currency: 'KRW', value }, transactionDescription? }]`.
//   응답 entityBody `{ items: [{ id, refPayoutId, destination, scheduleType, payoutDate, amount, status: 'REQUESTED', error: null, requestedAt }] }`.
// - 셀러 등록 평문: `{ refSellerId, businessType, company: { name, representativeName, businessRegistrationNumber, email, phone }, account: { bankCode, accountNumber, holderName } }`.
//   응답 entityBody `{ id, refSellerId, businessType, company, account: { bankCode, accountNumber: 끝 4자리 말고 가림, holderName }, status }`.
//   상태는 법인 PARTIALLY_APPROVED, 개인사업자 APPROVAL_REQUIRED(settlement §3 그림).
// - 잔액: entityBody `{ availableAmount: { currency, value }, pendingAmount: { currency, value } }`.
// - 정산 조회(v1, 수수료): 배열 `[{ paymentKey, orderId, amount, fees: [{ type, fee }], payOutAmount, soldDate, paidOutDate }]`.
// - 응답 없음은 요청을 다 읽은 뒤 연결을 끊는 것으로 흉내 낸다(시간 초과를 기다리지 않으려고). 모든 응답은 `Connection: close`라 연결을 다시 쓰지 않는다.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export type FakeStore = 'STANDARD' | 'ESCROW';
export type FakePayoutStatus = 'REQUESTED' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED' | 'CANCELED';
export type FakeSellerStatus = 'PENDING' | 'APPROVAL_REQUIRED' | 'PARTIALLY_APPROVED' | 'APPROVED' | 'KYC_REQUIRED' | 'REJECTED';

export interface FakeStoreKeys {
  secretKey: string;
  /** 지금 보안 키(32바이트). 요청을 이 키로 풀고 응답을 이 키로 봉인한다 */
  securityKey: Buffer;
}

export interface RecordedRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string | string[] | undefined>;
  store: FakeStore | undefined;
  rawBody: string;
  /** 쓰기 요청이면 푼 JWE 보호 머리 */
  jweHeader?: Record<string, unknown>;
  /** 쓰기 요청이면 푼 평문 JSON */
  body?: unknown;
  /** 풀지 못했으면 그 까닭 */
  decryptError?: string;
  /** 주입한 장애(있으면) */
  fault?: string;
}

export interface FakePayout {
  id: string;
  store: FakeStore;
  refPayoutId: string;
  destination: string;
  payoutDate: string;
  amount: number;
  status: FakePayoutStatus;
  errorCode: string | null;
}

export interface FakeSeller {
  id: string;
  store: FakeStore;
  refSellerId: string;
  businessType: string;
  status: FakeSellerStatus;
}

export type Fault =
  | 'NO_RESPONSE'
  | 'SERVER_ERROR'
  | 'PROCESSING'
  | 'BAD_JWE'
  | 'WRONG_ENC'
  | 'WRONG_ALG'
  | { code: string; status?: number };

interface FaultRule {
  method: string;
  path: RegExp;
  store?: FakeStore;
  /** 복호한 요청을 보고 고른다(예: 둘째 묶음의 refPayoutId) */
  when?: (r: RecordedRequest) => boolean;
  times: number;
  fault: Fault;
}

const VERSION = '2022-11-16';
const b64u = (b: Buffer | string): string => Buffer.from(b).toString('base64url');

/** dir + A256GCM compact JWE(대역 서버가 node:crypto로 직접 만든다. 구현이 쓰는 라이브러리와 따로 만들어 서로 맞는지 본다) */
export function sealJwe(payload: unknown, key: Buffer, header: Record<string, unknown> = {}): string {
  const protectedHeader = { alg: 'dir', enc: 'A256GCM', iat: new Date().toISOString(), nonce: randomBytes(16).toString('base64url'), ...header };
  const h = b64u(JSON.stringify(protectedHeader));
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(h, 'ascii'));
  const ct = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  return `${h}..${b64u(iv)}.${b64u(ct)}.${b64u(cipher.getAuthTag())}`;
}

/** 대역 서버의 JWE 풀기. dir·A256GCM만 받고 암호화 키 조각은 비어 있어야 한다 */
export function openJwe(jwe: string, key: Buffer): { header: Record<string, unknown>; payload: unknown; iv: string } {
  const parts = jwe.trim().split('.');
  if (parts.length !== 5) throw new Error('JWE compact 다섯 조각이 아니다');
  const [h, ek, iv, ct, tag] = parts as [string, string, string, string, string];
  const header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8')) as Record<string, unknown>;
  if (header.alg !== 'dir' || header.enc !== 'A256GCM' || ek !== '') throw new Error(`alg·enc가 dir·A256GCM이 아니다: ${String(header.alg)}/${String(header.enc)}`);
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  d.setAAD(Buffer.from(h, 'ascii'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  const pt = Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
  return { header, payload: JSON.parse(pt) as unknown, iv };
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** 지급 요청의 refPayoutId 목록(복호한 본문) */
export const refsOf = (r: RecordedRequest): string[] => (Array.isArray(r.body) ? (r.body as { refPayoutId?: unknown }[]).map((i) => String(i.refPayoutId)) : []);

export interface TossPayoutFake {
  readonly url: string;
  readonly requests: RecordedRequest[];
  readonly payouts: Map<string, FakePayout>;
  readonly sellers: Map<string, FakeSeller>;
  readonly balances: Record<FakeStore, { available: number; pending: number }>;
  readonly settlementRows: Record<FakeStore, { paymentKey: string; amount: number; fee: number }[]>;
  /** 다음 맞는 요청에 장애를 넣는다(times번, 기본 1) */
  inject(rule: { method: string; path: RegExp; store?: FakeStore; when?: (r: RecordedRequest) => boolean; times?: number }, fault: Fault): void;
  /** 그 방법·경로(정규식)의 요청 */
  calls(method: string, path: RegExp): RecordedRequest[];
  /** 결제사 쪽 지급 상태를 바꾼다(단건 조회가 이 값을 준다) */
  setPayout(pgPayoutId: string, status: FakePayoutStatus, errorCode?: string): void;
  /** refPayoutId로 결제사 쪽 지급 건 */
  payoutByRef(refPayoutId: string): FakePayout | undefined;
  close(): Promise<void>;
}

export async function startTossPayoutFake(keys: Record<FakeStore, FakeStoreKeys>): Promise<TossPayoutFake> {
  const requests: RecordedRequest[] = [];
  const payouts = new Map<string, FakePayout>();
  const sellers = new Map<string, FakeSeller>();
  const idempotent = new Map<string, { status: number; payload: unknown }>();
  const balances: Record<FakeStore, { available: number; pending: number }> = { STANDARD: { available: 900_000_000_000, pending: 0 }, ESCROW: { available: 900_000_000_000, pending: 0 } };
  const settlementRows: Record<FakeStore, { paymentKey: string; amount: number; fee: number }[]> = { STANDARD: [], ESCROW: [] };
  const rules: FaultRule[] = [];
  let seq = 0;
  const nextId = (prefix: string) => `${prefix}${String((seq += 1)).padStart(6, '0')}`;

  const storeOf = (auth: string | undefined): FakeStore | undefined => {
    const m = /^Basic (.+)$/.exec(auth ?? '');
    if (!m) return undefined;
    const decoded = Buffer.from(m[1]!, 'base64').toString('utf8');
    for (const s of ['STANDARD', 'ESCROW'] as const) if (decoded === `${keys[s].secretKey}:`) return s;
    return undefined;
  };

  const takeFault = (method: string, path: string, store: FakeStore | undefined, rec: RecordedRequest): Fault | undefined => {
    const i = rules.findIndex((r) => r.method === method && r.path.test(path) && (r.store === undefined || r.store === store) && (r.when === undefined || r.when(rec)) && r.times > 0);
    if (i < 0) return undefined;
    const r = rules[i]!;
    r.times -= 1;
    if (r.times === 0) rules.splice(i, 1);
    return r.fault;
  };

  const send = (res: ServerResponse, status: number, body: string, contentType: string) => {
    res.writeHead(status, { 'content-type': contentType, connection: 'close' });
    res.end(body);
  };
  const plain = (res: ServerResponse, status: number, payload: unknown) => send(res, status, JSON.stringify(payload), 'application/json');
  const sealed = (res: ServerResponse, status: number, payload: unknown, store: FakeStore, header: Record<string, unknown> = {}) =>
    send(res, status, sealJwe(payload, keys[store].securityKey, header), 'text/plain');
  const envelope = (entityType: string, entityBody: unknown) => ({ version: VERSION, traceId: randomBytes(8).toString('hex'), entityType, entityBody });
  const errorBody = (code: string) => ({ version: VERSION, traceId: randomBytes(8).toString('hex'), error: { code, message: `대역 서버 오류 ${code}` } });

  const payoutView = (p: FakePayout) => ({
    id: p.id,
    refPayoutId: p.refPayoutId,
    destination: p.destination,
    scheduleType: 'SCHEDULED',
    payoutDate: p.payoutDate,
    amount: { currency: 'KRW', value: p.amount },
    transactionDescription: '정산 지급',
    requestedAt: '2026-12-04T10:00:00+09:00',
    status: p.status,
    error: p.errorCode ? { code: p.errorCode, message: `지급 실패 ${p.errorCode}` } : null,
  });
  const sellerView = (s: FakeSeller, company?: unknown, account?: { bankCode?: unknown; accountNumber?: unknown; holderName?: unknown }) => ({
    id: s.id,
    refSellerId: s.refSellerId,
    businessType: s.businessType,
    ...(company ? { company } : {}),
    ...(account
      ? { account: { bankCode: account.bankCode, accountNumber: `${'*'.repeat(Math.max(0, String(account.accountNumber).length - 4))}${String(account.accountNumber).slice(-4)}`, holderName: account.holderName } }
      : {}),
    status: s.status,
  });

  const handle = (req: IncomingMessage, res: ServerResponse, rawBody: string) => {
    const url = new URL(req.url ?? '/', 'http://fake.local');
    const path = url.pathname;
    const method = req.method ?? 'GET';
    const store = storeOf(req.headers.authorization);
    const rec: RecordedRequest = { method, path, query: Object.fromEntries(url.searchParams), headers: { ...req.headers }, store, rawBody };
    requests.push(rec);
    const write = method === 'POST';
    if (write && store) {
      try {
        const opened = openJwe(rawBody, keys[store].securityKey);
        rec.jweHeader = opened.header;
        rec.body = opened.payload;
      } catch (e) {
        rec.decryptError = e instanceof Error ? e.message : String(e);
      }
    }
    if (!store) return plain(res, 401, errorBody('UNAUTHORIZED_KEY'));
    const fault = takeFault(method, path, store, rec);
    if (fault !== undefined) {
      rec.fault = typeof fault === 'string' ? fault : fault.code;
      if (fault === 'NO_RESPONSE') {
        req.socket.destroy();
        return;
      }
      if (fault === 'SERVER_ERROR') return plain(res, 500, errorBody('FAILED_INTERNAL_SYSTEM_PROCESSING'));
      if (fault === 'PROCESSING') return sealed(res, 409, errorBody('IDEMPOTENT_REQUEST_PROCESSING'), store);
      if (fault === 'BAD_JWE' || fault === 'WRONG_ENC' || fault === 'WRONG_ALG') {
        // 정상 응답을 만든 뒤 망가뜨린다(변조한 태그, 다른 enc·alg 머리)
        const ok = write ? normalWrite(method, path, rec, store) : undefined;
        const payload = ok?.payload ?? envelope('balance', {});
        if (fault === 'BAD_JWE') {
          const jwe = sealJwe(payload, keys[store].securityKey);
          const parts = jwe.split('.');
          const tag = Buffer.from(parts[4]!, 'base64url');
          tag[0] = tag[0]! ^ 0xff;
          parts[4] = b64u(tag);
          return send(res, ok?.status ?? 200, parts.join('.'), 'text/plain');
        }
        return sealed(res, ok?.status ?? 200, payload, store, fault === 'WRONG_ENC' ? { enc: 'A128GCM' } : { alg: 'A256KW' });
      }
      return write ? sealed(res, fault.status ?? 400, errorBody(fault.code), store) : plain(res, fault.status ?? 400, errorBody(fault.code));
    }
    if (write) {
      if (!String(req.headers['content-type'] ?? '').startsWith('text/plain')) return plain(res, 415, errorBody('INVALID_CONTENT_TYPE'));
      if (rec.decryptError) return plain(res, 400, errorBody('INVALID_ENCRYPTION'));
      const out = normalWrite(method, path, rec, store);
      return sealed(res, out.status, out.payload, store);
    }
    const payoutMatch = /^\/v2\/payouts\/([^/]+)$/.exec(path);
    if (method === 'GET' && payoutMatch) {
      const p = payouts.get(decodeURIComponent(payoutMatch[1]!));
      if (!p || p.store !== store) return plain(res, 404, errorBody('NOT_FOUND_PAYOUT'));
      return plain(res, 200, envelope('payout', payoutView(p)));
    }
    const sellerMatch = /^\/v2\/sellers\/([^/]+)$/.exec(path);
    if (method === 'GET' && sellerMatch) {
      const s = sellers.get(decodeURIComponent(sellerMatch[1]!));
      if (!s || s.store !== store) return plain(res, 404, errorBody('NOT_FOUND_SELLER'));
      return plain(res, 200, envelope('seller', sellerView(s)));
    }
    if (method === 'GET' && path === '/v2/balances') {
      const b = balances[store];
      return plain(res, 200, envelope('balance', { availableAmount: { currency: 'KRW', value: b.available }, pendingAmount: { currency: 'KRW', value: b.pending } }));
    }
    if (method === 'GET' && path === '/v1/settlements') {
      if (!DATE.test(rec.query.startDate ?? '') || !DATE.test(rec.query.endDate ?? '')) return plain(res, 400, errorBody('INVALID_DATE'));
      return plain(
        res,
        200,
        settlementRows[store].map((r) => ({ paymentKey: r.paymentKey, orderId: r.paymentKey, amount: r.amount, fees: [{ type: 'BASE', fee: r.fee }], payOutAmount: r.amount - r.fee, soldDate: rec.query.startDate, paidOutDate: rec.query.endDate })),
      );
    }
    return plain(res, 404, errorBody('NOT_FOUND'));
  };

  const normalWrite = (method: string, path: string, rec: RecordedRequest, store: FakeStore): { status: number; payload: unknown } => {
    if (path === '/v2/payouts') {
      const key = rec.headers['idempotency-key'];
      if (typeof key !== 'string' || key === '') return { status: 400, payload: errorBody('INVALID_IDEMPOTENCY_KEY') };
      const replay = idempotent.get(`${store}:${key}`);
      if (replay) return replay;
      const items = rec.body;
      const valid =
        Array.isArray(items) &&
        items.length > 0 &&
        items.every(
          (i) =>
            isRecord(i) &&
            typeof i.refPayoutId === 'string' &&
            typeof i.destination === 'string' &&
            i.scheduleType === 'SCHEDULED' &&
            typeof i.payoutDate === 'string' &&
            DATE.test(i.payoutDate) &&
            isRecord(i.amount) &&
            i.amount.currency === 'KRW' &&
            Number.isSafeInteger(i.amount.value) &&
            (i.amount.value as number) > 0 &&
            (i.amount.value as number) < 1_000_000_000,
        );
      if (!valid) return { status: 400, payload: errorBody('INVALID_REQUEST') };
      const created = (items as { refPayoutId: string; destination: string; payoutDate: string; amount: { value: number } }[]).map((i) => {
        const p: FakePayout = { id: nextId('FPAY'), store, refPayoutId: i.refPayoutId, destination: i.destination, payoutDate: i.payoutDate, amount: i.amount.value, status: 'REQUESTED', errorCode: null };
        payouts.set(p.id, p);
        return p;
      });
      const out = { status: 200, payload: envelope('payout', { items: created.map(payoutView) }) };
      idempotent.set(`${store}:${key}`, out);
      return out;
    }
    const cancel = /^\/v2\/payouts\/([^/]+)\/cancel$/.exec(path);
    if (cancel) {
      const p = payouts.get(decodeURIComponent(cancel[1]!));
      if (!p || p.store !== store) return { status: 404, payload: errorBody('NOT_FOUND_PAYOUT') };
      if (p.status !== 'REQUESTED') return { status: 400, payload: errorBody('NOT_CANCELABLE_PAYOUT') };
      p.status = 'CANCELED';
      return { status: 200, payload: envelope('payout', payoutView(p)) };
    }
    if (path === '/v2/sellers') {
      const b = rec.body;
      const company = isRecord(b) && isRecord(b.company) ? b.company : undefined;
      const account = isRecord(b) && isRecord(b.account) ? b.account : undefined;
      const valid =
        isRecord(b) &&
        typeof b.refSellerId === 'string' &&
        (b.businessType === 'INDIVIDUAL_BUSINESS' || b.businessType === 'CORPORATE') &&
        company !== undefined &&
        ['name', 'representativeName', 'businessRegistrationNumber', 'email', 'phone'].every((k) => typeof company[k] === 'string') &&
        account !== undefined &&
        ['bankCode', 'accountNumber', 'holderName'].every((k) => typeof account[k] === 'string');
      if (!valid) return { status: 400, payload: errorBody('INVALID_REQUEST') };
      const s: FakeSeller = { id: nextId('FSEL'), store, refSellerId: b.refSellerId as string, businessType: b.businessType as string, status: b.businessType === 'CORPORATE' ? 'PARTIALLY_APPROVED' : 'APPROVAL_REQUIRED' };
      sellers.set(s.id, s);
      return { status: 200, payload: envelope('seller', sellerView(s, company, account)) };
    }
    void method;
    return { status: 404, payload: errorBody('NOT_FOUND') };
  };

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => handle(req, res, Buffer.concat(chunks).toString('utf8')));
  });
  // real-time: 결제사 HTTP 경계(경로·머리·JWE 본문)를 실제 HTTP로 봐야 해서 단위 시험에서 127.0.0.1 임의 포트를 연다. 시험마다 close()로 닫는다 F-07-6
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    payouts,
    sellers,
    balances,
    settlementRows,
    inject(rule, fault) {
      rules.push({ method: rule.method, path: rule.path, ...(rule.store ? { store: rule.store } : {}), ...(rule.when ? { when: rule.when } : {}), times: rule.times ?? 1, fault });
    },
    calls(method, path) {
      return requests.filter((r) => r.method === method && path.test(r.path));
    },
    setPayout(pgPayoutId, status, errorCode) {
      const p = payouts.get(pgPayoutId);
      if (!p) throw new Error(`대역 서버에 없는 지급 ID ${pgPayoutId}`);
      p.status = status;
      p.errorCode = errorCode ?? null;
    },
    payoutByRef(refPayoutId) {
      return [...payouts.values()].find((p) => p.refPayoutId === refPayoutId);
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((e) => (e ? reject(e) : resolve()));
      }),
  };
}
