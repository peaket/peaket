// ops-svc 소비자의 토픽 나눔(F-06-2 GAT-280). 키 단위 소비자는 처리기 하나를 받으므로 토픽마다 처리기를 고른다:
// ops.command-events는 OpsCommandEventsHandler, support.cases-requested는 CaseRequestsHandler다. 이 파일은 Kafka 클라이언트를 싣지 않는다.
import type { ConsumedMessage, KeyedHandler } from '@peaket/platform';
import { CS_CASES_REQUESTED_TOPIC, type CaseRequestRecord, type CaseRequestsHandler } from './case-requests.js';
import type { OpsCommandEventsHandler, OpsCommandRecord } from './command-events.js';

export type OpsRecord = { topic: 'command'; r: OpsCommandRecord } | { topic: 'case'; r: CaseRequestRecord };

export class OpsTopicsHandler implements KeyedHandler<OpsRecord> {
  constructor(
    private readonly commands: OpsCommandEventsHandler,
    private readonly cases?: CaseRequestsHandler,
  ) {}

  decode(m: ConsumedMessage): OpsRecord {
    if (m.topic === CS_CASES_REQUESTED_TOPIC && this.cases) return { topic: 'case', r: this.cases.decode(m) };
    return { topic: 'command', r: this.commands.decode(m) };
  }

  keyOf(e: OpsRecord): string {
    return e.topic === 'case' && this.cases ? `case:${this.cases.keyOf(e.r)}` : this.commands.keyOf(e.r as OpsCommandRecord);
  }

  eventKeyOf(e: OpsRecord): string | undefined {
    return e.topic === 'case' && this.cases ? this.cases.eventKeyOf(e.r) : this.commands.eventKeyOf(e.r as OpsCommandRecord);
  }

  async handle(e: OpsRecord): Promise<void> {
    if (e.topic === 'case' && this.cases) return this.cases.handle(e.r);
    return this.commands.handle(e.r as OpsCommandRecord);
  }
}
