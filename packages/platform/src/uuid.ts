// UUIDv7과 ID 범위 경계(docs/data.md §2 '파티션 표 규칙', ADR-0083, RFC 9562 §5.7).
// ID는 주입한 시계로 만든다(시간 의존 로직은 Clock 주입). PostgreSQL은 uuid를 바이트 순서로 비교하므로 앞 48비트가 시간 순서다.
import { randomBytes } from 'node:crypto';
import type { Clock } from './clock.js';

const MAX_MS = 2 ** 48 - 1;

const hex12 = (ms: number): string => {
  if (!Number.isInteger(ms) || ms < 0 || ms > MAX_MS) throw new RangeError(`UUIDv7 시각은 0 이상 2^48 미만의 정수 밀리초다: ${ms}`);
  return ms.toString(16).padStart(12, '0');
};

const format = (h: string): string => `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;

/** UUIDv7: 앞 48비트 시계 밀리초, 판 7, 변형 10, 나머지 무작위 74비트 */
export function uuidv7(clock: Clock): string {
  const r = randomBytes(10);
  r[0] = (r[0]! & 0x0f) | 0x70;
  r[2] = (r[2]! & 0x3f) | 0x80;
  return format(hex12(clock.now()) + r.toString('hex'));
}

/** UUIDv7의 앞 48비트(만든 시각, 밀리초) */
export function uuidv7Time(id: string): number {
  const h = id.replace(/-/g, '');
  if (!/^[0-9a-f]{32}$/i.test(h)) throw new Error(`UUID가 아니다: ${id}`);
  return Number.parseInt(h.slice(0, 12), 16);
}

/** ID 범위의 경계: 밀리초를 앞 48비트에 두고 나머지를 0으로 채운 UUID(data.md §2) */
export function uuidLowerBound(ms: number): string {
  return format(hex12(ms) + '0'.repeat(20));
}
