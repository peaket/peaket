// 시험용 만료 임대(BUILD_ORDER PRF-135). 좌석 Redis의 만료 임대 Lua(expire-lua.ts SWEEP_LEASE_LUA: 내 것이면 PEXPIRE, 없으면 SET NX PX, 남의 것이면 0)와
// 같은 결과를 메모리로 한 번에 낸다.
// 임대는 MemorySeatDb의 회차 묶음(MemorySeatEvent.sweep)에 적어, 시험이 같은 db로 만든 MemorySeatStore와 함께 읽고 채운다. 시각은 주입 Clock이다.
import type { Clock } from '@peaket/platform';
import { assertSweepLeaseArgs } from '../domain/expiry.js';
import type { SweepLeases } from '../domain/ports.js';
import type { MemorySeatDb } from './memory-seat-store.js';

/**
 * SweepLeases의 메모리 구현. 계약은 domain/ports.ts SweepLeases.acquire이고 결과는 RedisSweepLeases와 같다.
 * - db.event(eventId).sweep이 없거나 Clock.now() ≥ expiresAtMs이면 { owner, expiresAtMs: now + ttlMs }로 쓰고 true
 * - sweep.owner가 owner이면 expiresAtMs = now + ttlMs로 바꾸고 true
 * - 다른 owner이고 아직 살아 있으면 바꾸지 않고 false
 * 모양이 틀리면(eventId·owner가 KEY_PART가 아님, ttlMs가 1 이상의 안전한 정수가 아님) RangeError이고 아무것도 바꾸지 않는다.
 * 일시 장애·메모리 부족은 내지 않는다. 본문에 await가 없어 한 번에 끝난다(동시 호출이 서로 끼어들지 않는다)
 */
export class MemorySweepLeases implements SweepLeases {
  constructor(
    readonly db: MemorySeatDb,
    private readonly clock: Clock,
  ) {}

  async acquire(eventId: string, owner: string, ttlMs: number): Promise<boolean> {
    assertSweepLeaseArgs(eventId, owner, ttlMs);
    const ev = this.db.event(eventId);
    const now = this.clock.now();
    const cur = ev.sweep;
    if (cur && now < cur.expiresAtMs && cur.owner !== owner) return false;
    ev.sweep = { owner, expiresAtMs: now + ttlMs };
    return true;
  }
}

