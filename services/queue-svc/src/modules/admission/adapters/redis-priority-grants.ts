// 우선 구매 권리 사본의 대기열 Redis 구현(queue.proto PriorityGrantService, docs/data.md `q:prio`, ADR-0171).
// 쓰기는 Lua 하나로 판 번호를 견주고 TTL을 권리 만료에 맞춘다. 읽기는 계정·회차 키 하나만 본다.
import { Inject, Injectable } from '@nestjs/common';
import { type HotRedis, redisScript } from '@peaket/platform';
import { guard, QUEUE_REDIS } from '../../entry/index.js';
import { priorityGrantKeyOf, type PriorityGrantCopy, type PriorityGrantState } from '../domain/priority-grant.js';
import type { PriorityGrantStore } from '../domain/ports.js';
import { SET_PRIORITY_GRANT_LUA } from './priority-grant-lua.js';

const SET = redisScript(SET_PRIORITY_GRANT_LUA);
const str = (v: unknown): string => (Buffer.isBuffer(v) ? v.toString('utf8') : String(v));

@Injectable()
export class RedisPriorityGrantStore implements PriorityGrantStore {
  constructor(@Inject(QUEUE_REDIS) private readonly redis: HotRedis) {}

  async set(i: Parameters<PriorityGrantStore['set']>[0]): Promise<{ changed: boolean }> {
    const r = await guard(this.redis.evalScript(SET, [priorityGrantKeyOf(i.accountId, i.eventId)], [i.grantId, i.state, String(i.expiresAtMs), String(i.version)]));
    return { changed: Number(str(r)) === 1 };
  }

  async get(i: { accountId: string; eventId: string; grantId: string }): Promise<PriorityGrantCopy | undefined> {
    const key = priorityGrantKeyOf(i.accountId, i.eventId);
    const r = (await guard(this.redis.command(['HMGET', key, 'id', 'exp', 'state', 'ver'], { key }))) as unknown[];
    const id = r[0];
    if (id === null || id === undefined) return undefined;
    if (str(id) !== i.grantId) return undefined;
    const exp = Number(str(r[1]));
    const state = str(r[2]);
    const version = Number(str(r[3]));
    // 우리가 쓴 값이 망가졌으면 없는 것으로 본다(입장을 열지 않는다). 쓰기 쪽은 같은 망가짐을 PEAKET_CORRUPT_KEY로 드러낸다.
    if (!Number.isSafeInteger(exp) || exp <= 0 || !Number.isSafeInteger(version) || version < 0) return undefined;
    if (state !== 'OFFERED' && state !== 'WITHDRAWN') return undefined;
    return { grantId: str(id), state: state as PriorityGrantState, expiresAtMs: exp, version };
  }
}
