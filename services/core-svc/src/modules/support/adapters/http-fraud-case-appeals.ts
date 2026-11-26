// F-04-15 support → ops-svc 내부 소명 접수 HTTP. core-svc는 팬 요청을 직접 ops로 보내지 않고 여기서만 부른다.
// 공용 외부 HTTP 클라이언트(createExternalHttpClient)로 시간 상한·리디렉션 거부·정규 로그를 다른 내부 호출과 맞춘다.
import { type ExternalHttpClient, ProblemError } from '@peaket/platform';
import type { FraudCaseAppeals } from '../domain/ports.js';

const TIMEOUT_MS = 3_000;

const unavailable = () => new ProblemError({ type: 'dependency-unavailable', status: 503, title: '조사 사건 연결을 쓸 수 없습니다' });

export class HttpFraudCaseAppeals implements FraudCaseAppeals {
  constructor(
    private readonly client: ExternalHttpClient,
    private readonly token?: string,
  ) {}

  async submit(i: { caseId: string; appealId: string; accountId: string; party: 'PAYER' | 'HOLDER'; submittedAt: string }): Promise<{ result: 'SUBMITTED' | 'OBJECTION_SUBMITTED' | 'EXPIRED' | 'INVALID' }> {
    let res: Response;
    try {
      res = await this.client.request({
        method: 'POST',
        path: '/internal/v1/fraud-cases/{caseId}/appeals',
        params: { caseId: i.caseId },
        headers: { 'content-type': 'application/json', ...(this.token ? { 'x-peaket-internal-token': this.token } : {}) },
        body: JSON.stringify({ appealId: i.appealId, accountId: i.accountId, party: i.party, submittedAt: i.submittedAt }),
        timeoutCapMs: TIMEOUT_MS,
      });
    } catch {
      throw unavailable();
    }
    if (res.status === 404) throw new ProblemError({ type: 'not-found', status: 404, title: '조사 사건을 찾을 수 없습니다' });
    // 409는 소명 기한이 지났거나 대상 계정이 아니다. 팬 화면이 '잠시 뒤'가 아니라 그대로 안내한다(IR-10).
    if (res.status === 409) throw new ProblemError({ type: 'fraud-case-state', status: 409, title: '지금 상태에서는 소명을 낼 수 없습니다' });
    if (res.status === 422) throw new ProblemError({ type: 'invalid-body', status: 422, title: '소명 내용을 확인해 주세요' });
    if (res.status < 200 || res.status > 299) throw unavailable();
    const body = (await res.json().catch(() => ({}))) as { result?: string };
    return { result: body.result === 'OBJECTION_SUBMITTED' || body.result === 'EXPIRED' || body.result === 'INVALID' ? body.result : 'SUBMITTED' };
  }
}
