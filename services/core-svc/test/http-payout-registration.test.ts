// core-svc → payment-svc 지급대행 등록 HTTP 클라이언트(F-07-7 계획 I-05·§5.1(아), ADR-0370 결정 3·4, J-T39 ②⑦).
// 로컬 HTTP 대역 서버가 payment 내부 경로 셋의 답(200·422·502·503·500)을 주고, 클라이언트가 같은 이름의 ProblemError로 다시 던지는지,
// 연결 실패·시간 초과를 503 payout-dependency-unavailable로 바꾸는지, 내부 토큰을 붙이는지, 계좌번호 원문이 오류에 없는지 본다.
// test/payout-registration-double.ts 짝 대역의 행동 근거다.
//
// 인터페이스 빈칸(계획 §5.1(아)에 생성자 모양이 없어 이 시험이 고름): new HttpPayoutRegistration(client: Pick<ExternalHttpClient, 'request'>, internalToken?: string)
// — 같은 모듈의 HttpPurchaseSaleOpen과 같은 모양.
import { createExternalHttpClient, ProblemError } from '@peaket/platform';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { HttpPayoutRegistration, type PayoutRegistrationView } from '../src/modules/catalog/index.js';

const TOKEN = 'internal-token-f077';
const P = 'https://peaket.example/problems/';
const PROMOTER = randomUUID();
const ACCOUNT = '110987654321';

interface Seen {
  method: string;
  path: string;
  token: string | undefined;
  body: unknown;
}

let server: Server;
let baseUrl: string;
const seen: Seen[] = [];
/** 다음 요청의 답. 'hang'이면 응답하지 않는다 */
let answer: { status: number; body?: unknown } | 'hang' = { status: 200, body: {} };
const hanging: ServerResponse[] = [];

const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve) => {
    let text = '';
    req.on('data', (c: Buffer) => (text += c.toString('utf8')));
    req.on('end', () => resolve(text));
  });

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const raw = await readBody(req);
    seen.push({ method: req.method ?? '', path: req.url ?? '', token: req.headers['x-peaket-internal-token'] as string | undefined, body: raw ? JSON.parse(raw) : null });
    if (answer === 'hang') {
      hanging.push(res);
      return;
    }
    res.writeHead(answer.status, { 'content-type': answer.status >= 400 ? 'application/problem+json' : 'application/json' });
    res.end(answer.body === undefined ? '' : JSON.stringify(answer.body));
  });
  // real-time: HTTP 클라이언트의 경계(머리·경로·상태 바꾸기)를 실제 소켓으로 본다. 대역 서버는 127.0.0.1 임시 포트만 연다 F-07-7
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(() => {
  seen.length = 0;
  answer = { status: 200, body: {} };
  for (const res of hanging.splice(0)) res.destroy();
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const client = (url = baseUrl, timeoutCapMs = 2_000) => new HttpPayoutRegistration(createExternalHttpClient({ provider: 'payment-svc', baseUrl: url, timeoutCapMs }), TOKEN);
const registerInput = () => ({
  promoterId: PROMOTER,
  businessType: 'CORPORATE' as const,
  company: { name: '(주)스텔라엔터테인먼트', representativeName: '김스텔라', businessRegistrationNumber: '1234567890', email: 'seller@example.test', phone: '0212345678' },
  account: { bankCode: '88', accountNumber: ACCOUNT, holderName: '(주)스텔라엔터테인먼트' },
});
const problemBody = (type: string, status: number) => ({ type: `${P}${type}`, status, title: '대역 문제' });

async function caught(p: Promise<unknown>): Promise<ProblemError> {
  const e = await p.then(
    () => undefined,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(ProblemError);
  return e as ProblemError;
}

describe('J-T39 ② HttpPayoutRegistration.register', () => {
  test('J-T39 ② 내부 토큰과 함께 POST /internal/v1/settlements/payout-registrations를 한 번 부르고 200의 holderChecked를 돌려준다', async () => {
    answer = { status: 200, body: { bankCode: '88', accountLast4: '4321', holderChecked: true, agencies: { PORTONE: 'REGISTERED', TOSS_STANDARD: 'REGISTERED', TOSS_ESCROW: 'REGISTERED' } } };
    await expect(client().register(registerInput())).resolves.toEqual({ holderChecked: true });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ method: 'POST', path: '/internal/v1/settlements/payout-registrations', token: TOKEN });
    expect(seen[0]!.body).toMatchObject({ promoterId: PROMOTER, account: { bankCode: '88', accountNumber: ACCOUNT } });

    answer = { status: 200, body: { bankCode: '88', accountLast4: '4321', holderChecked: false, agencies: { PORTONE: 'SKIPPED', TOSS_STANDARD: 'SKIPPED', TOSS_ESCROW: 'SKIPPED' } } };
    await expect(client().register(registerInput())).resolves.toEqual({ holderChecked: false });
  });

  test('J-T39 ② payment의 422·502·503 문제는 같은 이름·상태의 ProblemError이고 오류 어디에도 계좌번호가 없다 [ASVS v5.0.0-16.2.5]', async () => {
    const cases = [
      { type: 'payout-account-holder-mismatch', status: 422 },
      { type: 'payout-agency-update-failed', status: 502 },
      { type: 'payout-holder-lookup-unavailable', status: 503 },
      { type: 'payout-gateway-unavailable', status: 503 },
    ];
    for (const c of cases) {
      answer = { status: c.status, body: problemBody(c.type, c.status) };
      const e = await caught(client().register(registerInput()));
      expect(e.status, c.type).toBe(c.status);
      expect(e.slug, c.type).toBe(c.type);
      expect(`${e.message} ${JSON.stringify(e)} ${e.stack ?? ''}`, c.type).not.toContain(ACCOUNT);
    }
  });

  test('J-T39 ② 알 수 없는 5xx·연결 실패·시간 초과는 503 payout-dependency-unavailable이다 [ASVS v5.0.0-16.5.3]', async () => {
    answer = { status: 500, body: problemBody('internal', 500) };
    const e500 = await caught(client().register(registerInput()));
    expect({ status: e500.status, slug: e500.slug }).toEqual({ status: 503, slug: 'payout-dependency-unavailable' });

    // 닫힌 포트(연결 거부)
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const closedUrl = `http://127.0.0.1:${(closed.address() as AddressInfo).port}`;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    const refused = await caught(client(closedUrl).register(registerInput()));
    expect({ status: refused.status, slug: refused.slug }).toEqual({ status: 503, slug: 'payout-dependency-unavailable' });

    // real-time: 응답하지 않는 서버의 시간 초과는 HTTP 클라이언트의 실제 시간 상한(여기서는 150ms)으로만 난다 F-07-7
    answer = 'hang';
    const timeout = await caught(client(baseUrl, 150).register(registerInput()));
    expect({ status: timeout.status, slug: timeout.slug }).toEqual({ status: 503, slug: 'payout-dependency-unavailable' });
    expect(`${refused.message} ${timeout.message}`).not.toContain(ACCOUNT);
  });
});

describe('J-T39 ⑤⑧ HttpPayoutRegistration.read', () => {
  test('J-T39 ⑤ GET …/promoters/{id}/payout-registration의 200을 그대로 읽는다', async () => {
    const view: PayoutRegistrationView = {
      payoutAccount: { bankCode: '88', last4: '4321', holdUntil: '2026-11-25T01:00:00.000Z', holderVerified: true },
      agencySyncPending: false,
      tossEnabled: true,
      portoneEnabled: false,
      tossSellers: [{ pgStore: 'STANDARD', status: 'PARTIALLY_APPROVED' }],
      portonePartnerRegistered: false,
    };
    answer = { status: 200, body: view };
    await expect(client().read(PROMOTER)).resolves.toEqual(view);
    expect(seen).toEqual([{ method: 'GET', path: `/internal/v1/settlements/promoters/${PROMOTER}/payout-registration`, token: TOKEN, body: null }]);
  });

  test('J-T39 ⑤ 읽기 503·연결 실패는 503 payout-dependency-unavailable이다(승인 판정이 fail-closed로 쓴다)', async () => {
    answer = { status: 503, body: problemBody('payout-dependency-unavailable', 503) };
    const e = await caught(client().read(PROMOTER));
    expect({ status: e.status, slug: e.slug }).toEqual({ status: 503, slug: 'payout-dependency-unavailable' });
  });
});

describe('J-T39 ⑦ HttpPayoutRegistration.verifySeller', () => {
  test('J-T39 ⑦ PUT …/seller-verification에 상호·대표자·확인 시각을 보내고 200이면 끝난다', async () => {
    answer = { status: 200, body: { status: 'VERIFIED' } };
    const verifiedAt = new Date('2026-11-05T00:00:00.000Z');
    await expect(client().verifySeller(PROMOTER, { legalName: '(주)스텔라엔터테인먼트', representative: '김스텔라', verifiedAt })).resolves.toBeUndefined();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ method: 'PUT', path: `/internal/v1/settlements/promoters/${PROMOTER}/seller-verification`, token: TOKEN });
    expect(seen[0]!.body).toEqual({ legalName: '(주)스텔라엔터테인먼트', representative: '김스텔라', verifiedAt: '2026-11-05T00:00:00.000Z' });
  });

  test('J-T39 ⑦ payment 503·시간 초과는 503 payout-dependency-unavailable이다 [ASVS v5.0.0-16.5.3]', async () => {
    answer = { status: 503, body: problemBody('payout-dependency-unavailable', 503) };
    const e = await caught(client().verifySeller(PROMOTER, { legalName: 'x', representative: 'y', verifiedAt: new Date(0) }));
    expect({ status: e.status, slug: e.slug }).toEqual({ status: 503, slug: 'payout-dependency-unavailable' });

    // real-time: 시간 초과는 실제 시간 상한(150ms)으로만 난다 F-07-7
    answer = 'hang';
    const t = await caught(client(baseUrl, 150).verifySeller(PROMOTER, { legalName: 'x', representative: 'y', verifiedAt: new Date(0) }));
    expect({ status: t.status, slug: t.slug }).toEqual({ status: 503, slug: 'payout-dependency-unavailable' });
  });
});
