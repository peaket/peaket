// ops-svc Kafka 소비자: support.cases-requested(asyncapi CaseRequested, F-06-2 GAT-280 ADR-0364 결정 4, R-T48 ④).
// 내부 HTTP POST /internal/v1/cs-cases와 같은 처리기(ReceiveCaseRequested)를 부른다. 값은 계약 모양 그대로의 JSON 바이트다(queue-svc 생산자와 같다).
// 받지 않는 종류(문의·게시물 신고 등)와 계약 모양이 아닌 메시지는 보류하지 않고 넘기며 지표(결과 ignored)로 센다(보류 행 0).
// 저장소 일시 실패는 던져 플랫폼 키 단위 소비자가 다시 한다. 업무 키는 (종류, 대상)이라 같은 대상의 요청이 한 줄로 처리된다.
// 이 파일은 Kafka 클라이언트를 싣지 않는다(start.ts가 싣는다).
import { type Clock, type ConsumedMessage, type KeyedHandler } from '@peaket/platform';
import { CaseRequestedBody, type ReceiveCaseRequested } from '../modules/cases/index.js';

export const CS_CASES_REQUESTED_TOPIC = 'support.cases-requested';

/** 읽은 값: 계약 모양의 요청, 또는 넘길 메시지(받지 않음) */
export type CaseRequestRecord = { kind: 'request'; body: import('zod').output<typeof CaseRequestedBody> } | { kind: 'skip'; key: string; caseKind: string };

const kindOf = (o: Record<string, unknown>): string => (typeof o.kind === 'string' && o.kind.length <= 64 ? o.kind : 'UNKNOWN');

export class CaseRequestsHandler implements KeyedHandler<CaseRequestRecord> {
  constructor(
    private readonly receive: Pick<ReceiveCaseRequested, 'handle' | 'ignored'>,
    private readonly clock: Clock,
  ) {}

  decode(m: ConsumedMessage): CaseRequestRecord {
    const skip = (caseKind: string): CaseRequestRecord => ({ kind: 'skip', key: `skip:${m.topic}:${m.partition}:${m.offset}`, caseKind });
    if (m.value === null) return skip('UNKNOWN');
    let v: unknown;
    try {
      v = JSON.parse(m.value.toString('utf8')) as unknown;
    } catch {
      return skip('UNKNOWN');
    }
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return skip('UNKNOWN');
    const o = v as Record<string, unknown>;
    // 계약의 기본값 칸(followUp·hold)이 빠져도 받는다. 모르는 칸이 있으면 계약 모양이 아니다
    const parsed = CaseRequestedBody.safeParse(o);
    if (!parsed.success) return skip(kindOf(o));
    return { kind: 'request', body: parsed.data };
  }

  keyOf(e: CaseRequestRecord): string {
    return e.kind === 'skip' ? e.key : `${e.body.kind}:${e.body.sourceId}`;
  }

  eventKeyOf(e: CaseRequestRecord): string | undefined {
    return e.kind === 'request' ? e.body.eventKey : undefined;
  }

  async handle(e: CaseRequestRecord): Promise<void> {
    if (e.kind === 'skip') {
      this.receive.ignored(e.caseKind);
      return;
    }
    // 받지 않는 종류도 처리기가 ignored로 세고 끝낸다(보류하지 않는다)
    await this.receive.handle(e.body, this.clock.now());
  }
}
