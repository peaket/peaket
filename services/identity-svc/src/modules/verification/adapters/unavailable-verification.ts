// 본인확인기관이 없을 때(계약 전 운영 쪽 환경, 시험 어댑터를 켜지 않음): 시작부터 503 PROVIDER_DOWN으로 답한다
// (openapi 본인확인 결과 503, docs/features/identity.md §5·§10 '본인확인 대행사 전면 장애'. 이미 본인확인한 계정은 영향 없음).
import type { IdentityHashers, VerificationProvider } from '../domain/ports.js';
import { ProviderUnavailable } from '../domain/verification.js';

const down = (): never => {
  throw new ProviderUnavailable();
};

export const unavailableProvider: VerificationProvider = { window: down, confirm: async () => down() };
export const unavailableHashers: IdentityHashers = { ci: down, pid: down };
