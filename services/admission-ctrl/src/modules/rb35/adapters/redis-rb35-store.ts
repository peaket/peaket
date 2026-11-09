// RB-35 저장소(대기열 Redis, ADR-0239 결정 7·8). 적용은 Lua 한 번이다: 재사용 표시·게시 표시·멈춤 값·커밋·라운드를 함께 보고 쓴다.
// q:{event:E}:shuffle과 q:{event:E}:batch_done은 같은 해시 태그라 같은 슬롯이다.
import { type HotRedis, redisScript } from '@peaket/platform';
import type { BatchSchedule, BatchStore, ShuffleGroup } from '../../batch/index.js';
import type { Rb35Apply, Rb35ApplyResult, Rb35State, Rb35Store } from '../domain/ports.js';

const shuffleKey = (e: string): string => `q:{event:${e}}:shuffle`;
const doneKey = (e: string): string => `q:{event:${e}}:batch_done`;
const pendingField = (g: ShuffleGroup): string => `rb35:pending:${g}`;

const APPLY = redisScript(`
local s, d = KEYS[1], KEYS[2]
local g, cid, kind, expectStop, expectCommit, expectRound, raw = ARGV[1], ARGV[2], ARGV[3], ARGV[4], ARGV[5], ARGV[6], ARGV[7]
local expire = tonumber(ARGV[8])
local function finish(result, write)
  if redis.call('HGET', s, 'rb35:pending:' .. g) == raw then redis.call('HDEL', s, 'rb35:pending:' .. g) end
  if write then redis.call('HSET', s, 'rb35:result:' .. cid, write) end
  if redis.call('PEXPIRETIME', s) < expire then redis.call('PEXPIREAT', s, expire) end
  return result
end
if redis.call('HEXISTS', s, 'rb35:done:' .. cid) == 1 then return finish('replay', nil) end
if redis.call('HEXISTS', d, 'pub:' .. g) == 1 then return finish('published', 'rejected:published') end
if kind ~= 'wait' and redis.call('HEXISTS', s, 'beacon:' .. g) == 1 then return finish('beacon_recorded', 'rejected:beacon_recorded') end
if (redis.call('HGET', s, 'stop:' .. g) or '') ~= expectStop then return finish('stale_state', 'rejected:stale_state') end
if (redis.call('HGET', s, 'commit:' .. g) or '') ~= expectCommit or (redis.call('HGET', s, 'round:' .. g) or '') ~= expectRound then return finish('stale_state', 'rejected:stale_state') end
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
if kind == 'wait' then
  redis.call('HSET', s, 'waitUntil:' .. g, string.format('%.0f', now + tonumber(ARGV[9])))
elseif kind == 'emergency' then
  redis.call('HSET', s, 'emergency:' .. g, '{"at":' .. string.format('%.0f', now) .. ',' .. ARGV[9] .. '}')
else
  if redis.call('HEXISTS', s, 'emergency:' .. g) == 1 then return finish('already_emergency', 'rejected:already_emergency') end
  local newAt = tonumber(ARGV[11])
  if newAt - now < tonumber(ARGV[12]) then return finish('too_late', 'rejected:too_late') end
  if tonumber(redis.call('HGET', s, 'at:' .. g) or '0') + tonumber(ARGV[13]) > newAt then return finish('too_late', 'rejected:too_late') end
  if expectStop == '' and tonumber(ARGV[14]) - now < tonumber(ARGV[15]) then return finish('round_public', 'rejected:round_public') end
  if ARGV[16] ~= '' and redis.call('HEXISTS', s, 'recommit:' .. g) == 1 and tonumber(expectRound) >= tonumber(ARGV[16]) then return finish('already_recommitted', 'rejected:already_recommitted') end
  redis.call('HSET', s, 'round:' .. g, ARGV[10])
  redis.call('HDEL', s, 'waitUntil:' .. g)
  local entry = '{"at":' .. string.format('%.0f', now) .. ',' .. ARGV[9] .. '}'
  local prev = redis.call('HGET', s, 'recommit:' .. g)
  if prev then redis.call('HSET', s, 'recommit:' .. g, string.sub(prev, 1, -2) .. ',' .. entry .. ']')
  else redis.call('HSET', s, 'recommit:' .. g, '[' .. entry .. ']') end
end
redis.call('HDEL', s, 'stop:' .. g)
redis.call('HSET', s, 'rb35:done:' .. cid, string.format('%.0f', now))
return finish('applied', 'applied')
`);

// 처리 중인 다른 명령이 없을 때만 넣는다(같은 명령 ID면 다시 넣는다)
const DEPOSIT = redisScript(`
local cur = redis.call('HGET', KEYS[1], ARGV[1])
if cur and cur ~= ARGV[2] and not string.find(cur, ARGV[3], 1, true) then return 0 end
redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])
return 1
`);

const REJECT = redisScript(`
if redis.call('HGET', KEYS[1], ARGV[1]) == ARGV[2] then redis.call('HDEL', KEYS[1], ARGV[1]) end
if ARGV[3] ~= '' then redis.call('HSET', KEYS[1], 'rb35:result:' .. ARGV[3], 'rejected:' .. ARGV[4]) end
return 1
`);

const str = (v: unknown): string | null => (v === null || v === undefined ? null : Buffer.isBuffer(v) ? v.toString('utf8') : String(v));

export class RedisRb35Store implements Rb35Store {
  constructor(
    private readonly redis: HotRedis,
    private readonly batch: Pick<BatchStore, 'scheduleOf'>,
  ) {}

  scheduleOf(eventId: string): Promise<BatchSchedule | null> {
    return this.batch.scheduleOf(eventId);
  }

  async state(eventId: string, group: ShuffleGroup): Promise<Rb35State> {
    const k = shuffleKey(eventId);
    const [stop, commit, round] = ((await this.redis.command(['HMGET', k, `stop:${group}`, `commit:${group}`, `round:${group}`], { key: k })) as unknown[]).map(str);
    const d = doneKey(eventId);
    const pub = Number(await this.redis.command(['HEXISTS', d, `pub:${group}`], { key: d }));
    return { stop: stop ?? null, commit: commit ?? null, round: round ? Number(round) : null, published: pub === 1 };
  }

  async deposit(eventId: string, group: ShuffleGroup, commandId: string, raw: string): Promise<boolean> {
    return Number(await this.redis.evalScript(DEPOSIT, [shuffleKey(eventId)], [pendingField(group), raw, commandId])) === 1;
  }

  async pending(eventId: string): Promise<{ group: ShuffleGroup; raw: string }[]> {
    const k = shuffleKey(eventId);
    const groups: ShuffleGroup[] = ['lobby', 1];
    const vals = ((await this.redis.command(['HMGET', k, ...groups.map(pendingField)], { key: k })) as unknown[]).map(str);
    return groups.flatMap((group, i) => (vals[i] ? [{ group, raw: vals[i]! }] : []));
  }

  async apply(a: Rb35Apply): Promise<Rb35ApplyResult> {
    const tail = fragmentOf(a);
    const r = await this.redis.evalScript(APPLY, [shuffleKey(a.eventId), doneKey(a.eventId)], [String(a.group), a.commandId, a.kind, a.expect.stop ?? '', a.expect.commit, String(a.expect.round), a.raw, String(a.expireAtMs), ...tail]);
    return str(r) as Rb35ApplyResult;
  }

  async reject(eventId: string, group: ShuffleGroup, commandId: string | null, raw: string, reason: string): Promise<void> {
    await this.redis.evalScript(REJECT, [shuffleKey(eventId)], [pendingField(group), raw, commandId ?? '', reason]);
  }

  async result(eventId: string, commandId: string): Promise<string | null> {
    const k = shuffleKey(eventId);
    return str(await this.redis.command(['HGET', k, `rb35:result:${commandId}`], { key: k }));
  }
}

/** 명령마다 Lua에 넘기는 값(JSON 조각은 여기서 만든다) */
function fragmentOf(a: Rb35Apply): string[] {
  const blank = ['', '', '', '', '', '', ''];
  if (a.kind === 'wait') return [String(a.extendMs!), ...blank];
  if (a.kind === 'emergency') return [`"stop":${JSON.stringify(a.stopReason)},"reason":${JSON.stringify(a.reason)},"signed":${a.signedJson}`, ...blank];
  return [`"prev":${a.expect.round},"round":${a.newRound},"reason":${JSON.stringify(a.reason)},"signed":${a.signedJson}`, String(a.newRound), String(a.newRoundTimeMs), String(a.minLeadMs), String(a.minDelayMs), String(a.currentRoundTimeMs), String(a.publicMarginMs), a.scheduledRound === undefined ? '' : String(a.scheduledRound)];
}
