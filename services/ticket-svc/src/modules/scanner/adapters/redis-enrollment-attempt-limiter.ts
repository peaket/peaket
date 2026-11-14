// Redis 등록 시도 IP 실패 제한(offline-gate §6.1, O-T42). 파드가 여럿이어도 같은 IP를 함께 센다.
// 키: scanner:enroll:fail:{ip} (10분), scanner:enroll:fail:all (10분). 값은 INCR 카운터다.
import type { HotRedis } from '@peaket/platform';
import type { EnrollmentAttemptLimiter } from '../domain/ports.js';
import { ENROLLMENT_GLOBAL_FAIL_KEY, ENROLLMENT_GLOBAL_FAIL_LIMIT, ENROLLMENT_IP_FAIL_KEY, ENROLLMENT_IP_FAIL_LIMIT, ENROLLMENT_IP_WINDOW_MS } from './memory-enrollment-attempt-limiter.js';

export class RedisEnrollmentAttemptLimiter implements EnrollmentAttemptLimiter {
  constructor(private readonly redis: Pick<HotRedis, 'command'>) {}

  async allowed(ip: string): Promise<boolean> {
    const raw = await this.redis.command(['GET', ENROLLMENT_IP_FAIL_KEY(ip)]);
    const n = typeof raw === 'string' ? Number(raw) : 0;
    return !Number.isFinite(n) || n < ENROLLMENT_IP_FAIL_LIMIT;
  }

  async failed(ip: string): Promise<{ globalAlert: boolean; globalFailures: number }> {
    const ipCount = Number(await this.redis.command(['INCR', ENROLLMENT_IP_FAIL_KEY(ip)]));
    if (ipCount === 1) await this.redis.command(['PEXPIRE', ENROLLMENT_IP_FAIL_KEY(ip), String(ENROLLMENT_IP_WINDOW_MS)]);
    const globalFailures = Number(await this.redis.command(['INCR', ENROLLMENT_GLOBAL_FAIL_KEY]));
    if (globalFailures === 1) await this.redis.command(['PEXPIRE', ENROLLMENT_GLOBAL_FAIL_KEY, String(ENROLLMENT_IP_WINDOW_MS)]);
    return { globalAlert: globalFailures === ENROLLMENT_GLOBAL_FAIL_LIMIT + 1, globalFailures };
  }
}
