// core-svc → payment-svc 지급대행 등록 내부 HTTP 클라이언트(F-07-7 LCH-120, ADR-0370 결정 3·4, guidelines §8.1).
// 경로 셋: POST /internal/v1/settlements/payout-registrations(판매 승인 요청), GET …/promoters/{id}/payout-registration(판매 승인 조건·상세),
// PUT …/promoters/{id}/seller-verification(승인 성공 때 판매자 확인). 서비스 사이 토큰을 붙이고 시간 상한은 다른 내부 HTTP와 같은 3초 [가정]이다.
// payment의 422·502·503 이름 붙은 오류는 같은 이름·상태의 ProblemError로 다시 던지고, 연결 실패·시간 초과·모르는 오류는 503 payout-dependency-unavailable이다.
// 계좌번호는 요청 본문에만 싣고 오류 메시지·로그에 넣지 않는다(오류는 payment 응답의 이름·상태·제목만 옮긴다).
import { createExternalHttpClient, type ExternalHttpClient, PROBLEM_TYPE_BASE, ProblemError } from '@peaket/platform';
import { PAYOUT_REGISTRATION_OFF, type PayoutRegistrationInput, type PayoutRegistrationPort, type PayoutRegistrationView } from '../domain/payout-registration-port.js';

export const PAYOUT_REGISTRATION_TIMEOUT_MS = 3_000;

/** payment가 그대로 넘기는 이름(openapi createPartnerProductionSaleReview 422·502·503) */
const PASS_THROUGH: Readonly<Record<string, number>> = {
  'payout-account-holder-mismatch': 422,
  'payout-agency-update-failed': 502,
  'payout-holder-lookup-unavailable': 503,
  'payout-gateway-unavailable': 503,
  'payout-dependency-unavailable': 503,
};
/** 확장 칸 가운데 옮기는 것(결제사 이름 목록만, 원문 ID·계좌 없음) */
const AGENCIES: ReadonlySet<string> = new Set(['TOSS_STANDARD', 'TOSS_ESCROW', 'PORTONE']);

const dependencyUnavailable = () => new ProblemError({ type: 'payout-dependency-unavailable', status: 503, title: '지급 서비스에 연결하지 못했습니다' });

async function problemOf(res: Response): Promise<ProblemError> {
  const text = await res.text().catch(() => '');
  let body: { type?: unknown; title?: unknown; failedAgencies?: unknown } = {};
  try {
    body = text ? (JSON.parse(text) as typeof body) : {};
  } catch {
    body = {};
  }
  const slug = typeof body.type === 'string' && body.type.startsWith(PROBLEM_TYPE_BASE) ? body.type.slice(PROBLEM_TYPE_BASE.length) : '';
  if (slug === 'invalid-query' || slug === 'invalid-body') {
    // payment가 판매자 정보·계좌 모양을 받지 않았다(사업자등록번호 10자리 등). 파트너가 고칠 입력이다
    return new ProblemError({ type: 'sale-review-request-invalid', status: 422, title: '판매 승인 요청을 받을 수 없습니다', detail: '판매자 정보나 정산 계좌가 지급대행 등록 모양에 맞지 않습니다' });
  }
  const status = PASS_THROUGH[slug];
  if (status === undefined || status !== res.status) return dependencyUnavailable();
  const failed = Array.isArray(body.failedAgencies) ? body.failedAgencies.filter((a): a is string => typeof a === 'string' && AGENCIES.has(a)) : undefined;
  return new ProblemError({
    type: slug,
    status,
    title: typeof body.title === 'string' && body.title.length > 0 && body.title.length <= 200 ? body.title : '지급대행 등록을 끝내지 못했습니다',
    ...(failed && failed.length > 0 ? { extensions: { failedAgencies: failed } } : {}),
  });
}

export class HttpPayoutRegistration implements PayoutRegistrationPort {
  constructor(
    private readonly client: Pick<ExternalHttpClient, 'request'>,
    private readonly internalToken?: string,
  ) {}

  private headers(json: boolean): Record<string, string> {
    return { ...(json ? { 'content-type': 'application/json' } : {}), ...(this.internalToken ? { 'x-peaket-internal-token': this.internalToken } : {}) };
  }

  private async call(r: Parameters<ExternalHttpClient['request']>[0]): Promise<Response> {
    let res: Response;
    try {
      res = await this.client.request({ ...r, timeoutCapMs: PAYOUT_REGISTRATION_TIMEOUT_MS });
    } catch {
      // 연결 실패·시간 초과(원인 메시지는 싣지 않는다)
      throw dependencyUnavailable();
    }
    if (res.status < 200 || res.status > 299) throw await problemOf(res);
    return res;
  }

  private async json(res: Response): Promise<unknown> {
    try {
      const text = await res.text();
      return text ? (JSON.parse(text) as unknown) : {};
    } catch {
      throw dependencyUnavailable();
    }
  }

  async register(input: PayoutRegistrationInput): Promise<{ holderChecked: boolean }> {
    const res = await this.call({
      method: 'POST',
      path: '/internal/v1/settlements/payout-registrations',
      headers: this.headers(true),
      body: JSON.stringify({
        promoterId: input.promoterId,
        seller: {
          legalName: input.company.name,
          representative: input.company.representativeName,
          businessRegNo: input.company.businessRegistrationNumber,
          businessType: input.businessType,
          email: input.company.email,
          phone: input.company.phone,
        },
        account: { bankCode: input.account.bankCode, accountNumber: input.account.accountNumber, holderName: input.account.holderName },
      }),
    });
    const body = (await this.json(res)) as { holderChecked?: unknown };
    if (typeof body.holderChecked !== 'boolean') throw dependencyUnavailable();
    return { holderChecked: body.holderChecked };
  }

  async read(promoterId: string): Promise<PayoutRegistrationView> {
    const res = await this.call({ method: 'GET', path: '/internal/v1/settlements/promoters/{promoterId}/payout-registration', params: { promoterId }, headers: this.headers(false) });
    const body = (await this.json(res)) as Partial<PayoutRegistrationView>;
    if (typeof body.tossEnabled !== 'boolean' || typeof body.portoneEnabled !== 'boolean' || !Array.isArray(body.tossSellers) || typeof body.portonePartnerRegistered !== 'boolean') throw dependencyUnavailable();
    return {
      payoutAccount: body.payoutAccount ?? null,
      agencySyncPending: body.agencySyncPending === true,
      tossEnabled: body.tossEnabled,
      portoneEnabled: body.portoneEnabled,
      tossSellers: body.tossSellers.map((s) => ({ pgStore: s.pgStore, status: s.status ?? null })),
      portonePartnerRegistered: body.portonePartnerRegistered,
    };
  }

  async verifySeller(promoterId: string, input: { legalName: string; representative: string; verifiedAt: Date }): Promise<void> {
    const res = await this.call({
      method: 'PUT',
      path: '/internal/v1/settlements/promoters/{promoterId}/seller-verification',
      params: { promoterId },
      headers: this.headers(true),
      body: JSON.stringify({ legalName: input.legalName, representative: input.representative, verifiedAt: input.verifiedAt.toISOString() }),
    });
    await res.text().catch(() => '');
  }
}

/**
 * payment 주소가 없을 때(local·ci·test 조립): 읽기는 '둘 다 꺼짐', 등록은 건너뜀(모양만), 판매자 확인 쓰기는 건너뜀과 경고 로그.
 * 운영·스테이징·데모 조립에는 쓰지 않는다(assemblePayoutRegistration이 시작을 막는다)
 */
export class UnavailablePayoutRegistration implements PayoutRegistrationPort {
  constructor(private readonly warn?: (msg: string) => void) {}

  async register(): Promise<{ holderChecked: boolean }> {
    return { holderChecked: false };
  }

  async read(): Promise<PayoutRegistrationView> {
    return structuredClone(PAYOUT_REGISTRATION_OFF);
  }

  async verifySeller(): Promise<void> {
    this.warn?.('payment 주소가 없어 판매자 확인을 payment에 쓰지 않았다');
  }
}

/** payment 주소 없이 뜰 수 있는 환경 */
const UNWIRED_ENVS: ReadonlySet<string> = new Set(['local', 'ci', 'test']);

/**
 * 시작 조립(F-07-7 계획 I-05, 시험 리뷰 TR-20): PEAKET_PAYMENT_HTTP_URL이 있으면 HttpPayoutRegistration,
 * 없으면 PEAKET_ENV가 local·ci·test일 때만 UnavailablePayoutRegistration이고 그 밖의 환경은 던진다(시작 실패).
 */
export function assemblePayoutRegistration(env: Record<string, string | undefined>, deps: { warn?: (msg: string) => void; createClient?: (baseUrl: string) => Pick<ExternalHttpClient, 'request'> } = {}): PayoutRegistrationPort {
  const url = env.PEAKET_PAYMENT_HTTP_URL;
  if (url) {
    const client = deps.createClient ? deps.createClient(url) : createExternalHttpClient({ provider: 'payment-svc', baseUrl: url, timeoutCapMs: PAYOUT_REGISTRATION_TIMEOUT_MS });
    return new HttpPayoutRegistration(client, env.PEAKET_INTERNAL_TOKEN);
  }
  const peaketEnv = env.PEAKET_ENV ?? '';
  if (!UNWIRED_ENVS.has(peaketEnv)) throw new Error('PEAKET_PAYMENT_HTTP_URL이 없어 판매 승인의 지급대행 등록을 이을 수 없다(local·ci·test 밖에서는 시작하지 않는다)');
  deps.warn?.('PEAKET_PAYMENT_HTTP_URL이 없어 판매 승인 요청의 지급대행 등록을 건너뛰고 등록 읽기는 둘 다 꺼짐이다');
  return new UnavailablePayoutRegistration(deps.warn);
}
