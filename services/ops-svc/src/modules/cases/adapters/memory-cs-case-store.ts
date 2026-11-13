// 시험용 CS 처리함 건 저장소. 같은 kind·targetRef의 열린 건은 하나다.
import type { CsCase, CsCaseKind, CsCaseStore } from '../domain/cs-case.js';

export class MemoryCsCaseStore implements CsCaseStore {
  readonly cases = new Map<string, CsCase>();

  async open(input: { caseId: string; kind: CsCaseKind; targetRef: string; nowMs: number }): Promise<CsCase> {
    for (const c of this.cases.values()) if (c.kind === input.kind && c.targetRef === input.targetRef && c.status !== 'RESOLVED') return c;
    const c: CsCase = { caseId: input.caseId, kind: input.kind, targetRef: input.targetRef, status: 'OPEN', createdAtMs: input.nowMs };
    this.cases.set(c.caseId, c);
    return c;
  }
}
