// core-svc 주소가 없을 때의 닫힌 대역(F-07-11). 차단·철회는 503 compliance-core-unavailable로 끝난다.
import { ComplianceCoreUnavailable, type ComplianceApplyInput, type ComplianceApplyResult, type ComplianceCore, type ComplianceWithdrawInput, type ComplianceWithdrawResult } from '../domain/ports.js';

export class UnavailableComplianceCore implements ComplianceCore {
  async applyNotice(_input: ComplianceApplyInput): Promise<ComplianceApplyResult> {
    throw new ComplianceCoreUnavailable('not-wired');
  }
  async withdrawNotice(_input: ComplianceWithdrawInput): Promise<ComplianceWithdrawResult> {
    throw new ComplianceCoreUnavailable('not-wired');
  }
}
