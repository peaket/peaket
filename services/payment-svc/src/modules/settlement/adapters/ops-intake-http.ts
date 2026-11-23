// ops-svc 내부 받기 셋(감사 기록·운영 경보·CS 건)의 공용 HTTP 보내기(F-07-7 계획 §5.1 (파) (마)).
// 2xx이고 본문 accepted가 참이면 받음. 202 accepted:false·400·422는 거절(OpsIntakeRefused), 연결 실패·시간 초과·그 밖 상태·읽을 수 없는 본문은 일시 실패(SettlementProblem 503).
import { createExternalHttpClient, type Clock, type ExternalHttpClient } from '@peaket/platform';
import { z } from 'zod';
import { SettlementProblem } from '../domain/settlement.js';
import { OpsIntakeRefused, refusalOfStatus } from './ops-intake-refused.js';

const Answer = z.object({ accepted: z.boolean() }).passthrough();
/** ops 내부 받기의 시간 한도(CS 건 받기와 같은 3초 [가정]) */
const OPS_TIMEOUT_MS = 3_000;

export class OpsIntakeHttp {
  readonly #client: Pick<ExternalHttpClient, 'request'>;
  constructor(
    baseUrl: string,
    private readonly internalToken: string | undefined,
    o: { clock?: Clock; fetch?: typeof fetch } = {},
  ) {
    this.#client = createExternalHttpClient({ provider: 'ops-svc', baseUrl, timeoutCapMs: OPS_TIMEOUT_MS, ...(o.clock ? { clock: o.clock } : {}), ...(o.fetch ? { fetch: o.fetch } : {}) });
  }

  async post(path: string, body: unknown, what: string): Promise<void> {
    const unavailable = (why: string) => new SettlementProblem('dependency-unavailable', 503, `${what}을 ops에 보내지 못했습니다(${why})`);
    let res: Response;
    try {
      res = await this.#client.request({
        method: 'POST',
        path,
        headers: { 'content-type': 'application/json', ...(this.internalToken ? { 'x-peaket-internal-token': this.internalToken } : {}) },
        body: JSON.stringify(body),
        timeoutCapMs: OPS_TIMEOUT_MS,
      });
    } catch {
      throw unavailable('connection');
    }
    const refusal = refusalOfStatus(res.status);
    if (refusal) throw new OpsIntakeRefused(refusal, what);
    if (!res.ok) throw unavailable(`status-${res.status}`);
    let parsed: z.infer<typeof Answer>;
    try {
      const r = Answer.safeParse(await res.json());
      if (!r.success) throw new Error('shape');
      parsed = r.data;
    } catch {
      throw unavailable('shape');
    }
    if (!parsed.accepted) throw new OpsIntakeRefused('NOT_ACCEPTED', what);
  }
}
