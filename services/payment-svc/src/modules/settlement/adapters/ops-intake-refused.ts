// ops 받기의 '거절'(F-07-7 계획 §5.1 (파) (마), settlement §8·§11, guidelines §8.1).
// 202 accepted:false·400·422는 같은 본문이 다시 거절되므로 거절로 센다. 연결 실패·시간 초과·401·429·5xx는 일시 실패(SettlementProblem 503 그대로)다.
// 이름·상태는 일시 실패와 같은 dependency-unavailable·503이라 "503으로 던진다"를 보는 고정 시험은 그대로 참이다. 응용 층은 instanceof로 셈한다.
import { SettlementProblem, type OpsRefusal } from '../domain/settlement.js';

export class OpsIntakeRefused extends SettlementProblem {
  constructor(
    readonly refusal: OpsRefusal,
    what: string,
  ) {
    super('dependency-unavailable', 503, `${what}을 ops가 받지 않았습니다(${refusal})`);
    this.name = 'OpsIntakeRefused';
  }
}

/** HTTP 상태가 거절이면 그 까닭, 아니면 undefined(일시 실패나 성공) */
export function refusalOfStatus(status: number): OpsRefusal | undefined {
  if (status === 400) return 'HTTP_400';
  if (status === 422) return 'HTTP_422';
  return undefined;
}
