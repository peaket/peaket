// 구매 세션 상태 h:{holdId} 칸의 글(holdId, 좌석 ID 쉼표 글, …)을 항목으로 바꾼다(BUILD_ORDER HOT-070). 망가진 칸은 건너뛴다(그 홀드는 만료로 풀린다).
import { MAX_SEATS, SEAT_ID_PATTERN } from '../domain/hold.js';
import type { SessionHoldEntry } from '../domain/purchase-session.js';

const text = (v: unknown): string => (Buffer.isBuffer(v) ? v.toString('utf8') : String(v));

export function sessionHoldEntries(raw: readonly unknown[]): SessionHoldEntry[] {
  const out: SessionHoldEntry[] = [];
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const holdId = text(raw[i]);
    const seats = text(raw[i + 1]);
    const ids = seats.split(',');
    if (seats === '' || ids.length > MAX_SEATS || ids.some((s) => !SEAT_ID_PATTERN.test(s))) continue;
    out.push({ holdId, seatIds: ids });
  }
  return out;
}
