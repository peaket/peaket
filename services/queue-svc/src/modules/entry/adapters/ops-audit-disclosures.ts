// 셔플 커밋 공시를 ops-svc 감사 체인의 SYSTEM 기록으로 보내는 어댑터(ADR-0232 결정 10, ADR-0341 결정 7, BAT-355 계획 '감독에게' 2(a)).
// ops 내부 경로 POST /internal/v1/ops/audit-records(내부 토큰)에 recordType SHUFFLE_COMMIT_DISCLOSED로 보낸다. 같은 공시는 같은 eventKey라 ops가 한 번만 덧붙인다.
// 공시를 막지 않는다: 부르는 쪽(ShuffleCommits)은 기다리지 않고, 실패하면 같은 eventKey로 3번 [가정] 다시 보낸 뒤 지금의 정규 로그 줄(shuffle_commit_disclosed)을 남긴다.
import type { ExternalHttpClient, PlatformLogger } from '@peaket/platform';
import type { ShuffleDisclosure, ShuffleDisclosures } from '../domain/ports.js';

/** 다시 보내는 횟수 3번 [가정]과 그 사이 기다림(0.5·1·2초 [가정]) */
export const OPS_AUDIT_RETRY_DELAYS_MS: readonly number[] = [500, 1_000, 2_000];
/** 한 번 보내기의 상한 2초 [가정] */
const SEND_TIMEOUT_MS = 2_000;

/** 같은 공시는 늘 같은 사건 키(ops audit_record_intake 기본 키) */
export const shuffleDisclosureEventKey = (d: ShuffleDisclosure): string => `shuffle-commit:${d.eventId}:${d.group}:${d.commit}`;

export class OpsAuditShuffleDisclosures implements ShuffleDisclosures {
  constructor(
    private readonly o: {
      readonly ops: Pick<ExternalHttpClient, 'request'>;
      readonly internalToken?: string;
      readonly logger?: PlatformLogger;
      /** 시험이 기다림을 줄인다 */
      readonly retryDelaysMs?: readonly number[];
      readonly sleep?: (ms: number) => Promise<void>;
    },
  ) {}

  committed(d: ShuffleDisclosure): void {
    void this.send(d).catch(() => undefined);
  }

  /** 보낸 뒤 ops가 받았으면 참. 모두 실패하면 지금의 로그 줄을 남기고 거짓 */
  async send(d: ShuffleDisclosure): Promise<boolean> {
    const body = JSON.stringify({
      eventKey: shuffleDisclosureEventKey(d),
      recordType: 'SHUFFLE_COMMIT_DISCLOSED',
      recordId: d.eventId,
      payload: { eventId: d.eventId, group: d.group, commit: d.commit, chain: d.chain, round: d.round, algorithm: d.algorithm },
      occurredAt: new Date(d.atMs).toISOString(),
    });
    const delays = this.o.retryDelaysMs ?? OPS_AUDIT_RETRY_DELAYS_MS;
    const sleep = this.o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref()));
    for (let attempt = 0; attempt <= delays.length; attempt += 1) {
      if (attempt > 0) await sleep(delays[attempt - 1]!);
      try {
        const res = await this.o.ops.request({
          method: 'POST',
          path: '/internal/v1/ops/audit-records',
          headers: { 'content-type': 'application/json', ...(this.o.internalToken ? { 'x-peaket-internal-token': this.o.internalToken } : {}) },
          body,
          timeoutCapMs: SEND_TIMEOUT_MS,
        });
        if (res.ok) return true;
        // 본문이 틀린 것(400)은 다시 보내도 같다
        if (res.status === 400) break;
      } catch {
        // 연결 실패·시간 초과는 다시 보낸다
      }
    }
    this.o.logger?.info({ audit: 'shuffle_commit_disclosed', ...d }, '셔플 커밋 공시(POL-005)');
    return false;
  }
}
