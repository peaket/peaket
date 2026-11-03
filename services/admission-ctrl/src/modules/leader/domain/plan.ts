// 리더 루프의 값(docs/features/queue-admission.md §5, ADR-0058·0104·0181·0182). [가정]은 정본의 처음 값이다.
import type { EventPlan } from './ports.js';

/** 루프 주기 200ms(정본 §5) */
export const TICK_MS = 200;
/** 동시 입장 목표의 처음 값 5,000명(AIMD는 HOT-030) */
export const DEFAULT_TARGET = 5_000;
/** 초당 1,000번호 × 0.2초(안전 한계, ADR-0104) */
export const MAX_ADVANCE_PER_TICK = 200;
/** 오는 중 창 W의 처음 값 5초 [가정, Phase 2 2.3.1에서 확정] */
export const ARRIVAL_WINDOW_MS = 5_000;
/** 입장 비율 하한 0.2 [가정]. 비율 계산은 PRF-100이라 이 단계는 표본이 없을 때의 처음 값 100%다 */
export const RATIO_FLOOR = 0.2;
export const INITIAL_RATIO = 1;
/** 곧 입장 항목의 낡음: 안내하는 다시 시도 최대 5초 + 3초 [가정, ADR-0182 결정 4] */
export const SOON_STALE_MS = 8_000;
/** 전진 기록 보관 60초(정본) */
export const CALLS_KEEP_MS = 60_000;
/** 분산 창 8초 [가정], 게시가 늦었을 때 max(분산 창, 재시도 최대 간격 20초) + 404 캐시 1초 = 21초(ADR-0058) */
export const DISPERSAL_MS = 8_000;
export const LATE_DISPERSAL_MS = 21_000;
/** 묶음 결과 공개 예정 = 구간 끝 + 11초 [가정](queue-svc BATCH_RESULT_DELAY_MS와 같다) */
export const BATCH_RESULT_DELAY_MS = 11_000;
/** 리더가 회차를 보기 시작하는 때: 오픈 1분 전 [가정] */
export const PRE_OPEN_MS = 60_000;
/** 묶음 구간 길이 처음 값 2초 [가정] */
export const BATCH_WINDOW_DEFAULT_MS = 2_000;
/** 한 주기에 훑는 번호 상한(빠진 번호가 많아도 Lua가 오래 막지 않게) [가정] */
export const SCAN_BUDGET = 20_000;
/** RB-05 바탕 값(queue-svc RB05_SKIP_BASE와 같다, ADR-0181 결정 4) */
export const RB05_SKIP_BASE = 120_000;

const DAY_MS = 24 * 3600_000;
export const saleEndOf = (p: EventPlan): number => p.startsAtMs - DAY_MS;
/** 회차 키 수명 = 판매 종료 + 1일 */
export const keepUntilOf = (p: EventPlan): number => saleEndOf(p) + DAY_MS;
export const closeAtOf = (p: EventPlan): number => p.opensAtMs + (p.batchWindowMs ?? BATCH_WINDOW_DEFAULT_MS);
