// 정산 시험 공용 대역(BAT-625). 승인·판매 중지 의존성이 없는 시험은 이 빈 대역을 쓴다.
import type { PayoutApprovalVerifier, SaleSuspensionSource } from '../src/modules/settlement/domain/ports.js';

export const noApprovals: PayoutApprovalVerifier = { verify: async () => undefined };
export const noSaleSuspensions: SaleSuspensionSource = { listSuspended: async () => new Set() };
