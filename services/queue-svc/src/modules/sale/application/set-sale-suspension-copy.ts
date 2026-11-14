// 판매 중지·재개의 대기열 사본 쓰기(BAT-465 R-584, ADR-0123). purchase-svc 원본을 쓴 뒤 ops-svc가 부른다.
// 같은 명령으로 여러 번 와도 같은 값을 쓰므로 멱등이다.
import type { SaleSuspensionAction, SaleSuspensionCopies } from '../domain/sale-suspension.js';

export interface SetSaleSuspensionCopyInput {
  readonly eventId: string;
  readonly action: SaleSuspensionAction;
  readonly commandId: string;
  readonly revision?: number;
}

export interface SaleSuspensionCopyResult {
  readonly eventId: string;
  readonly suspended: boolean;
  readonly revision: number;
}

export class SetSaleSuspensionCopy {
  constructor(private readonly copies: SaleSuspensionCopies) {}

  async run(input: SetSaleSuspensionCopyInput): Promise<SaleSuspensionCopyResult> {
    const suspended = input.action === 'SUSPEND';
    const revision = input.revision ?? 0;
    await this.copies.write({ eventId: input.eventId, suspended, revision, commandId: input.commandId });
    return { eventId: input.eventId, suspended, revision };
  }
}
