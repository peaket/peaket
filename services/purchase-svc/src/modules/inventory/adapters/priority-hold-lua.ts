// 우선 구매 보류 Lua의 계약(GAT-135, docs/features/seat-hold.md §5 '우선 구매 보류', docs/data.md §3 좌석 키 표, ADR-0171).
// 키·칸 이름의 정본은 docs/data.md §3이다. 문자열만 두고 아무것도 가져오지 않는다(MemorySeatStore.holdPriority가 같은 계약을 따른다).
//
// KEYS(차례 고정, 모두 s:{event:E}: 아래)
//   1 bitmap        좌석 비트맵
//   2 prio          우선 구매 보류 만료 인덱스(멤버 = 좌석 색인, 점수 = exp ms). 일반 만료 인덱스 expiry와 나눈다
//   3 stream        사건 Stream
//   4 epoch         세대 키 Hash(epoch 칸이 없으면 NOT_READY)
//   5 secver        구역별 일련번호 Hash
//   6 fence         회차의 마지막 펜싱 토큰(10진 글, 없으면 0)
//   7 hold:{색인}   잡을 좌석 하나
//
// ARGV
//   1 소유 계정 ID  2 권리 ID(grantId, holdId로도 쓴다)  3 키 만료 시각 ms(keepUntil)  4 보류 만료 시각 ms(exp)
//   5 좌석 색인  6 구역 색인  7 구역 안 거리  8 좌석 ID  9 등급 ID  10 구역 ID  11 구역 채널 앞머리('s:{event:E}:sec:')
//
// 검사 차례(앞이 걸리면 뒤는 보지 않는다)
//   1 세대 키 readEpoch: epoch 칸이 없음 → {'NOT_READY'}
//   2 keepUntil ≤ now 또는 exp ≤ now → {'EXPIRED'}(아무것도 쓰지 않는다)
//   3 비트가 이미 1 → {'CONFLICT', 좌석 색인}
//   4 쓰기 전 형 검사: prio·stream이 zset·stream, secver·hold가 hash, fence가 10진 글, secver의 그 구역 칸이 표준 10진 정수
//   5 쓰기 → {'OK', 토큰 글, heldAt, exp}
//      비트 1, hold Hash = holdId(grantId)·owner·psid ''·fence·heldAt·exp·kind 'PRIORITY'·priorityGrantId(grantId)·ext '0',
//      prio ZADD exp 색인, secver +1, Stream HELD(holdKind PRIORITY·priorityGrantId·purchaseSessionId '')·구역 델타.
//      구매 세션·1인 한도·멱등 기록·expiry 인덱스는 쓰지 않는다.
// 아무것도 쓰지 않는 거절(NOT_READY·EXPIRED·CONFLICT)도 세대 확인(ENSURE_EPOCH)은 돌린다(장애 조치 뒤 그 자리 올리기, ADR-0210).
import { ENSURE_EPOCH } from './hold-lua.js';

const INT_TEXT = `
local function int(x)
  return string.format('%.0f', x)
end
`;
const EXTEND = `
local function extend(key, ms)
  if redis.call('PEXPIRETIME', key) < ms then redis.call('PEXPIREAT', key, int(ms)) end
end
`;
const MAX_SAFE = '9007199254740991';

/** 우선 구매 보류 Lua 원문(위 계약). 첫 줄이 #!lua다 */
export const PRIORITY_HOLD_LUA = `#!lua
${INT_TEXT}${EXTEND}${ENSURE_EPOCH}
if #KEYS ~= 7 or #ARGV ~= 11 then return redis.error_reply('ERR PEAKET_PRIORITY_HOLD_ARGS KEYS ' .. #KEYS .. ' ARGV ' .. #ARGV) end
local t = redis.call('TIME')
local nowSec = tonumber(t[1])
local us = nowSec * 1000000 + tonumber(t[2])
local now = nowSec * 1000 + math.floor(tonumber(t[2]) / 1000)
local ep = readEpoch(KEYS[4])
if not ep then return {'NOT_READY'} end
local function decided(r)
  ensureEpoch(ep, nowSec)
  return r
end
local keep = tonumber(ARGV[3])
local exp = tonumber(ARGV[4])
if not keep or not exp or keep <= now or exp <= now then return decided({'EXPIRED'}) end
local idx = ARGV[5]
local bit = redis.call('BITFIELD_RO', KEYS[1], 'GET', 'u1', idx)
if bit[1] == 1 then return decided({'CONFLICT', idx}) end
-- 쓰기 전 형 검사(거절·오류면 아무것도 쓰지 않는다)
local function typed(key, want)
  local ty = redis.call('TYPE', key).ok
  return ty == 'none' or ty == want
end
local function canon(v)
  return v == '0' or (#v <= 18 and string.match(v, '^[1-9]%d*$') ~= nil)
end
for _, kt in ipairs({{KEYS[2], 'zset'}, {KEYS[3], 'stream'}, {KEYS[5], 'hash'}, {KEYS[7], 'hash'}}) do
  if not typed(kt[1], kt[2]) then return redis.error_reply('ERR PEAKET_CORRUPT_KEY ' .. kt[1]) end
end
local fenceText = redis.call('GET', KEYS[6])
if fenceText and not string.match(fenceText, '^%d+$') then return redis.error_reply('ERR PEAKET_CORRUPT_KEY ' .. KEYS[6]) end
fenceText = fenceText or '0'
local secNow = redis.call('HGET', KEYS[5], ARGV[6])
if secNow and not canon(secNow) then return redis.error_reply('ERR PEAKET_CORRUPT_KEY ' .. KEYS[5]) end
local tok = math.max(tonumber(fenceText) + 1, us)
if tok > ${MAX_SAFE} then return redis.error_reply('ERR PEAKET_FENCE_OVERFLOW ' .. int(tok)) end
-- 첫 쓰기: 세대 확인
local seatEpoch = ensureEpoch(ep, nowSec)
local tokText = int(tok)
local nowText = int(now)
local expText = int(exp)
local keepText = int(keep)
redis.call('SET', KEYS[6], tokText, 'KEEPTTL')
redis.call('BITFIELD', KEYS[1], 'SET', 'u1', idx, '1')
redis.call('HSET', KEYS[7], 'holdId', ARGV[2], 'owner', ARGV[1], 'psid', '', 'fence', tokText, 'heldAt', nowText, 'exp', expText,
  'kind', 'PRIORITY', 'priorityGrantId', ARGV[2], 'ext', '0')
redis.call('PEXPIREAT', KEYS[7], keepText)
redis.call('ZADD', KEYS[2], expText, idx)
local version = redis.call('HINCRBY', KEYS[5], ARGV[6], 1)
redis.call('XADD', KEYS[3], '*',
  'type', 'HELD', 'seatIdx', idx, 'seatId', ARGV[8], 'tierId', ARGV[9], 'sectionId', ARGV[10],
  'holdId', ARGV[2], 'holdKind', 'PRIORITY', 'priorityGrantId', ARGV[2], 'purchaseSessionId', '', 'accountId', ARGV[1],
  'fencingToken', tokText, 'sectionVersion', int(version), 'seatEpoch', seatEpoch,
  'occurredAtMs', nowText, 'expiresAtMs', expText)
redis.call('SPUBLISH', ARGV[11] .. ARGV[6], '1 ' .. seatEpoch .. ' ' .. ARGV[6] .. ' ' .. int(version) .. ' ' .. nowText .. ' ' .. ARGV[7] .. ':1')
for _, k in ipairs({KEYS[1], KEYS[2], KEYS[3], KEYS[4], KEYS[5], KEYS[6]}) do extend(k, keep) end
return {'OK', tokText, nowText, expText}
`;
