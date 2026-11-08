// 리더 루프의 값(docs/features/queue-admission.md §5, ADR-0058·0104·0181·0182). [가정]은 정본의 처음 값이다.
import type { EventPlan } from './ports.js';

/** 루프 주기 200ms(정본 §5) */
export const TICK_MS = 200;
/** 동시 입장 목표의 처음 값 5,000명 */
export const DEFAULT_TARGET = 5_000;
/** 동시 입장 목표 안전 한계(POL-021 명령 1, queue-admission §5). 코드 상수다: 배포로만 바뀐다 */
export const MAX_TARGET = 8_000;
export const MIN_TARGET_BASE = 1_000;
/** serving 전진 속도 상한(초당) [가정, Phase 2 2.3.2에서 확정] */
export const RATE_CAP_PER_SEC = 1_000;
/** 플랫폼 전체 합산 동시 입장 상한 5,000명 [가정]. 부하 시험 뒤 docs/architecture.md §9.5의 값으로 올린다(ADR-0226 결정 10) */
export const AGGREGATE_TARGET_CAP = 5_000;
/** 입력 없음 판정·회복(ADR-0069 결정 1, [가정, Phase 2 2.3.2에서 확정]) */
export const INPUT_STALE_MS = 30_000;
export const INPUT_RECOVER_MS = 10_000;
/** 표본 시각이 미래여도 받아 주는 폭 5초 [가정](시계 어긋남) */
export const INPUT_FUTURE_MS = 5_000;
/** 증액 창과 크기(높음-12, 초기 목표의 2%) */
export const INCREASE_WINDOW_MS = 30_000;
export const INCREASE_STEP = 100;
/** 감축 확인 시간: 최소 35초, 최대 2분(ADR-0069 결정 2, 높음-12) */
export const HOLD_MIN_MS = 35_000;
export const HOLD_MAX_MS = 120_000;
/** 혼잡 판정 [가정, ADR-0226 결정 5] */
export const P99_LIMIT_S = 0.1;
export const ERROR_RATIO_LIMIT = 0.01;
/** 결제사 상한의 두 갈래(ADR-0129 중간-027) [가정] */
export const PG_PAY_RATIO = 1;
export const AVG_STAY_S = 180;
export const PG_SAFETY_FACTOR = 0.5;
/** 운영자 지정 뒤 자동 조절 멈춤 15분(POL-021 C-2) */
export const OPERATOR_FREEZE_MS = 15 * 60_000;
/** 좌석 저장소 감축과 예산 감축의 겹침 판단 60초 [가정, ADR-0226 결정 12] */
export const BUDGET_SEAT_OVERLAP_MS = 60_000;
/** 입력 읽기 주기 1초 [가정](ADR-0226 결정 4) */
export const INPUT_POLL_MS = 1_000;
/** 명령 11을 다시 읽는 주기 1초 [가정] */
export const AUTO_STOP_CACHE_MS = 1_000;
/** 오픈 간격 규칙(POL-030 모든 공연 5분) 뒤쪽 그물의 간격과 다시 보는 주기(ADR-0226 결정 11) */
export const OPEN_GAP_MS = 5 * 60_000;
export const OPEN_GAP_CHECK_MS = 10_000;
/** 초당 1,000번호 × 0.2초(안전 한계, ADR-0104) */
export const MAX_ADVANCE_PER_TICK = 200;
/** 오는 중 창 W의 처음 값 5초 [가정, Phase 2 2.3.1에서 확정] */
export const ARRIVAL_WINDOW_MS = 5_000;
/** 입장 비율 하한 0.2 [가정] */
export const RATIO_FLOOR = 0.2;
/** 입장 비율의 창: 불린 지 10~60초 [가정, Phase 2 2.3.1에서 확정]인 전진(ADR-0104 결정 3). 표본이 없으면 100% */
export const RATIO_WINDOW_MIN_MS = 10_000;
export const RATIO_WINDOW_MAX_MS = 60_000;
/** 판매 상태를 처음 모를 때(ADR-0122) */
export const INITIAL_SALE_STATE = 'ON_SALE';
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
/** 리더가 회차마다 RB-05가 필요한지 보는 간격 [가정]. 세대 키가 지금 노드 표지와 같으면 Lua가 바로 끝난다(진입 ②가 설정 세대를 1초에 한 번 견주는 것과 같다, ADR-0184) */
export const RB05_CHECK_MS = 1_000;
/** RB-05 복제 확인의 WAIT 한도 [가정](queue-svc RB05_CONFIRM_WAIT_MS와 같다, ADR-0186) */
export const RB05_CONFIRM_WAIT_MS = 500;

const DAY_MS = 24 * 3600_000;
export const saleEndOf = (p: EventPlan): number => p.startsAtMs - DAY_MS;
/** 회차 키 수명 = 판매 종료 + 1일 */
export const keepUntilOf = (p: EventPlan): number => saleEndOf(p) + DAY_MS;
export const closeAtOf = (p: EventPlan): number => p.opensAtMs + (p.batchWindowMs ?? BATCH_WINDOW_DEFAULT_MS);
