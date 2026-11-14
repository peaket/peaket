// 등록 시도 IP 실패 제한(offline-gate §6.1, O-T42, 추천 적용 2026-10-28 기술 검토 낮음-157).
// - 출발지 IP당 실패 10분 10회 [가정]를 넘으면 그 IP를 10분 막는다(429). 성공한 등록은 세지 않는다.
// - 전체 실패가 10분 100회 [가정]를 넘으면 등록 경로를 닫지 않고 SEV3 경보만 낸다(맞힐 확률은 거의 줄지 않는다).
export const ENROLLMENT_IP_FAIL_LIMIT = 10;
export const ENROLLMENT_IP_WINDOW_MS = 10 * 60_000;
export const ENROLLMENT_GLOBAL_FAIL_LIMIT = 100;
export const ENROLLMENT_IP_FAIL_KEY = (ip: string): string => `scanner:enroll:fail:${ip}`;
export const ENROLLMENT_GLOBAL_FAIL_KEY = 'scanner:enroll:fail:all';

interface Window {
  count: number;
  untilMs: number;
}

/** 시험·로컬용. 운영은 RedisEnrollmentAttemptLimiter다 */
export class MemoryEnrollmentAttemptLimiter {
  readonly #byIp = new Map<string, Window>();
  #global: Window = { count: 0, untilMs: 0 };

  constructor(private readonly now: () => number) {}

  async allowed(ip: string): Promise<boolean> {
    const w = this.#byIp.get(ip);
    return w === undefined || w.untilMs <= this.now() || w.count < ENROLLMENT_IP_FAIL_LIMIT;
  }

  async failed(ip: string): Promise<{ globalAlert: boolean; globalFailures: number }> {
    const now = this.now();
    const w = this.#byIp.get(ip);
    const next = w && w.untilMs > now ? { count: w.count + 1, untilMs: w.untilMs } : { count: 1, untilMs: now + ENROLLMENT_IP_WINDOW_MS };
    this.#byIp.set(ip, next);
    if (this.#global.untilMs <= now) this.#global = { count: 0, untilMs: now + ENROLLMENT_IP_WINDOW_MS };
    this.#global = { ...this.#global, count: this.#global.count + 1 };
    return { globalAlert: this.#global.count === ENROLLMENT_GLOBAL_FAIL_LIMIT + 1, globalFailures: this.#global.count };
  }
}
