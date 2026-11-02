// trust-svc가 생기기 전(BUILD_ORDER BOT-050)의 위험 판정: 늘 받지 못함이다. 사전 검증은 축소 운영(사람 확인 보류)으로 발급한다
// (docs/features/bot-defense.md §11, docs/features/queue-admission.md §3 '첫 구현의 세부').
import type { RiskPort, RiskVerdict } from '../domain/ports.js';

export const unavailableRisk: RiskPort = {
  score: async (): Promise<RiskVerdict> => ({ kind: 'UNAVAILABLE' }),
};
