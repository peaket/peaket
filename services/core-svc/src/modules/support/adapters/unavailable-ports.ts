// F-04-15 support 닫힌 대역. 실제 대상(예매 제한·양도 회수·ops 내부)이 없을 때 쓴다.
import { ProblemError } from '@peaket/platform';
import type { AppealKind } from '../domain/appeal.js';
import type { AppealTargets, FraudCaseAppeals } from '../domain/ports.js';

export class UnavailableFraudCaseAppeals implements FraudCaseAppeals {
  async submit(_i?: unknown): Promise<never> {
    throw new ProblemError({ type: 'dependency-unavailable', status: 503, title: '조사 사건 연결을 쓸 수 없습니다' });
  }
}

export class UnavailableAppealTargets implements AppealTargets {
  async submit(_i: { appealId: string; kind: AppealKind; targetId: string; accountId: string }): Promise<{ result: 'UNAVAILABLE' }> {
    return { result: 'UNAVAILABLE' };
  }
}
