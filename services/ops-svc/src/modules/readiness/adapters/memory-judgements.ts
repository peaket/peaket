// Go/No-Go 판정 기록의 메모리 구현(단위 시험·메모리 조립). PostgreSQL 구현과 같은 규칙으로 순번을 매기고 감사 체인에 남긴다.
import { type AuditChain } from '../../audit/index.js';
import { GO_NO_GO_JUDGED, judgementAuditPayload, type GoNoGoJudgement, type JudgementStore } from '../domain/readiness.js';

export class MemoryJudgementStore implements JudgementStore {
  readonly judgements: GoNoGoJudgement[] = [];

  constructor(private readonly audit: AuditChain) {}

  async record(input: Omit<GoNoGoJudgement, 'sequence'>): Promise<GoNoGoJudgement> {
    const sequence = this.judgements.filter((j) => j.eventId === input.eventId).length + 1;
    const judgement: GoNoGoJudgement = { ...input, sequence };
    await this.audit.append({ recordType: GO_NO_GO_JUDGED, recordId: input.judgementId, payload: judgementAuditPayload(judgement), nowMs: input.judgedAtMs });
    this.judgements.push(judgement);
    return judgement;
  }

  async last(eventId: string): Promise<GoNoGoJudgement | undefined> {
    return this.judgements.filter((j) => j.eventId === eventId).at(-1);
  }
}
