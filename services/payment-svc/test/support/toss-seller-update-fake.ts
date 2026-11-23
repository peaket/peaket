// 토스 지급대행 셀러 수정(POST /v2/sellers/{id}) 대역 서버(F-07-7 시험, 계획 §5.1 (타) 결정 1·(파) (바) (5), 시험 리뷰 TR-07).
// 고정된 F-07-6 지원 파일(test/support/toss-payout-fake.ts)은 고치지 않고, 그 파일이 내보내는 JWE 도구(sealJwe·openJwe)로 같은 꼴을 따른다.
// 공개 안내 모양 [가정, F-07-6 대역 머리 주석과 같음]:
// - 인증 `Authorization: Basic base64(<결제 상점 시크릿 키> + ':')`(시크릿 키로 상점을 가른다, 모르면 401 UNAUTHORIZED_KEY).
// - 암호화 쓰기: 본문은 그 상점 보안 키의 JWE compact(alg=dir, enc=A256GCM, 사용자 머리 iat·nonce), `Content-Type: text/plain`,
//   `TossPayments-api-security-mode: ENCRYPTION`(없으면 400 INVALID_SECURITY_MODE, 평문). 응답 본문도 2xx·4xx 모두 같은 꼴의 JWE다.
// - 수정 평문: 셀러 등록과 같은 칸 `{ refSellerId, businessType, company{ name, representativeName, businessRegistrationNumber, email, phone }, account{ bankCode, accountNumber, holderName } }`.
//   칸이 빠지면 400 INVALID_REQUEST, 없는 셀러(또는 다른 상점의 셀러)는 404 NOT_FOUND_SELLER.
// - 응답 봉투 `{ version, traceId, entityType: 'seller', entityBody: { id, refSellerId, businessType, company, account{ bankCode, accountNumber: 끝 4자리 말고 가림, holderName }, status } }`.
import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { openJwe, sealJwe, type FakeSellerStatus, type FakeStore, type FakeStoreKeys } from './toss-payout-fake.js';

export interface SellerUpdateRequest {
  method: string;
  path: string;
  store: FakeStore | undefined;
  headers: Record<string, string | string[] | undefined>;
  jweHeader?: Record<string, unknown>;
  body?: unknown;
  decryptError?: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export class TossSellerUpdateFake {
  readonly requests: SellerUpdateRequest[] = [];
  /** 셀러 ID → 상점·상태 */
  readonly sellers = new Map<string, { store: FakeStore; status: FakeSellerStatus }>();
  #server: Server | undefined;
  #url = '';

  constructor(private readonly keys: Record<FakeStore, FakeStoreKeys>) {}

  get url(): string {
    if (!this.#url) throw new Error('대역 서버를 먼저 띄운다(start)');
    return this.#url;
  }

  #storeOf(authorization: string | undefined): FakeStore | undefined {
    for (const s of ['STANDARD', 'ESCROW'] as const) if (authorization === `Basic ${Buffer.from(`${this.keys[s].secretKey}:`).toString('base64')}`) return s;
    return undefined;
  }

  async start(): Promise<void> {
    this.#server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        const path = new URL(req.url ?? '/', 'http://fake.local').pathname;
        const store = this.#storeOf(req.headers.authorization);
        const rec: SellerUpdateRequest = { method: req.method ?? '', path, store, headers: { ...req.headers } };
        this.requests.push(rec);
        const envelope = (payload: unknown) => ({ version: '2022-11-16', traceId: randomBytes(8).toString('hex'), ...(isRecord(payload) && 'code' in payload ? { error: payload } : { entityType: 'seller', entityBody: payload }) });
        const plain = (status: number, payload: unknown) => {
          res.writeHead(status, { 'content-type': 'application/json', connection: 'close' });
          res.end(JSON.stringify(payload));
        };
        const sealed = (status: number, payload: unknown) => {
          res.writeHead(status, { 'content-type': 'text/plain', connection: 'close' });
          res.end(sealJwe(envelope(payload), this.keys[store!].securityKey));
        };
        if (!store) return plain(401, envelope({ code: 'UNAUTHORIZED_KEY', message: '대역 서버' }));
        const m = /^\/v2\/sellers\/([^/]+)$/.exec(path);
        if (req.method !== 'POST' || !m) return plain(404, envelope({ code: 'NOT_FOUND', message: '대역 서버' }));
        if (!String(req.headers['content-type'] ?? '').startsWith('text/plain')) return plain(415, envelope({ code: 'INVALID_CONTENT_TYPE', message: '대역 서버' }));
        if (String(req.headers['tosspayments-api-security-mode'] ?? '').toUpperCase() !== 'ENCRYPTION') return plain(400, envelope({ code: 'INVALID_SECURITY_MODE', message: '대역 서버' }));
        try {
          const opened = openJwe(raw, this.keys[store].securityKey);
          rec.jweHeader = opened.header;
          rec.body = opened.payload;
        } catch (e) {
          rec.decryptError = e instanceof Error ? e.message : String(e);
          return plain(400, envelope({ code: 'INVALID_ENCRYPTION', message: '대역 서버' }));
        }
        const id = decodeURIComponent(m[1]!);
        const seller = this.sellers.get(id);
        if (!seller || seller.store !== store) return sealed(404, { code: 'NOT_FOUND_SELLER', message: '대역 서버' });
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
        if (!valid) return sealed(400, { code: 'INVALID_REQUEST', message: '대역 서버' });
        const number = String(account.accountNumber);
        return sealed(200, {
          id,
          refSellerId: b.refSellerId,
          businessType: b.businessType,
          company,
          account: { bankCode: account.bankCode, accountNumber: `${'*'.repeat(Math.max(0, number.length - 4))}${number.slice(-4)}`, holderName: account.holderName },
          status: seller.status,
        });
      });
    });
    // real-time: HttpTossPayoutTransport.updateSeller의 실제 HTTP·JWE 경계를 보려고 127.0.0.1에 포트를 연다 F-07-7
    await new Promise<void>((resolve) => this.#server!.listen(0, '127.0.0.1', resolve));
    this.#url = `http://127.0.0.1:${(this.#server.address() as AddressInfo).port}`;
  }

  async close(): Promise<void> {
    const s = this.#server;
    this.#server = undefined;
    if (!s) return;
    s.closeAllConnections();
    await new Promise<void>((resolve, reject) => s.close((e) => (e ? reject(e) : resolve())));
  }
}
