// 좌석 Lua 오류의 갈래(지표 seat_lua_errors_total{script,code}, docs/observability.md, BUILD_ORDER PRF-135 'PRF-130 리뷰 낮음 4').
// 로그·지표에는 키 종류만 남긴다(계정 ID가 든 키 이름 s:{event:E}:quota:{account} 같은 것을 남기지 않는다, ASVS 16.2.5).
// 도메인 층이라 프레임워크·플랫폼 형을 가져오지 않는다.
import { SeatStoreUnavailable } from './hold.js';

/** 지표 이름표 script의 값(Lua 이름, docs/observability.md). 홀드 Lua, 만료 Lua. 해제·연장 같은 뒤 단계의 Lua가 더한다 */
export type SeatLuaScript = 'hold' | 'expire';

/**
 * 지표 이름표 code의 값(docs/observability.md, 라벨 값이 늘지 않게 이 일곱 개만).
 * - CORRUPT_KEY·KEEP_UNTIL_PAST·FENCE_OVERFLOW: Lua(또는 메모리 구현)의 쓰기 전 지킴 오류 글 PEAKET_{code}
 * - OOM: 좌석 Redis 메모리 부족(SeatStoreUnavailable reason 'oom')
 * - NOT_READY: 세대 키가 없어 결과 NOT_READY(오류가 아니라 결과지만 같은 지표로 센다)
 * - OTHER: 그 밖의 스크립트 오류·모르는 결과 값 같은 버그
 */
export type SeatLuaErrorCode = 'CORRUPT_KEY' | 'KEEP_UNTIL_PAST' | 'FENCE_OVERFLOW' | 'OOM' | 'NOT_READY' | 'OTHER';

/**
 * 좌석 키의 종류(docs/data.md §3 키 이름 s:{event:E}:{종류}… 의 첫 조각). 로그에는 키 이름 대신 이것만 싣는다.
 * 'ctl:events'는 회차 태그 없는 s:ctl:events다
 */
export type SeatKeyKind =
  | 'bitmap'
  | 'hold'
  | 'expiry'
  | 'quota'
  | 'stream'
  | 'idem'
  | 'epoch'
  | 'ctl'
  | 'rel'
  | 'secver'
  | 'fence'
  | 'sweep'
  | 'ctl:events'
  | 'unknown';

/** seatLuaErrorOf의 결과 */
export interface SeatLuaError {
  code: SeatLuaErrorCode;
  /** CORRUPT_KEY일 때 오류 글에 든 키의 종류(키를 찾지 못하면 'unknown'). 그 밖의 code에는 없다 */
  keyKind?: SeatKeyKind;
}

/**
 * 저장소가 던진 오류를 지표·로그용 갈래로 바꾼다(순수 함수, 던지지 않는다). 오류 글 자체는 돌려주지 않는다(계정 ID가 든 키 이름이 있을 수 있다).
 *
 * 차례(앞이 맞으면 뒤는 보지 않는다):
 * 1. SeatStoreUnavailable이고 reason이 'oom' → { code: 'OOM' }
 * 2. SeatStoreUnavailable이고 reason이 'unavailable' → undefined(일시 장애는 Lua 오류로 세지 않는다)
 * 3. Error이고 message 안에 PEAKET_CORRUPT_KEY가 있음 → { code: 'CORRUPT_KEY', keyKind }. keyKind는 그 뒤 첫 키 이름
 *    s:{…}:{종류}[:…]의 {종류}(SeatKeyKind에 있는 것만, 없거나 모양이 다르면 'unknown'). s:ctl:events는 'ctl:events'
 * 4. Error이고 message 안에 PEAKET_KEEP_UNTIL_PAST·PEAKET_FENCE_OVERFLOW가 있음 → 그 code(keyKind 없음)
 * 5. 그 밖의 값(다른 Error·Error가 아닌 값) → { code: 'OTHER' }
 *
 * 예: Error('ERR PEAKET_CORRUPT_KEY s:{event:ev-1}:quota:0190…') → { code: 'CORRUPT_KEY', keyKind: 'quota' },
 * Error('PEAKET_KEEP_UNTIL_PAST keepUntil 1 now 2') → { code: 'KEEP_UNTIL_PAST' }.
 * 메모리 구현도 같은 글(PEAKET_…)로 던져야 같은 갈래가 된다(토큰 넘침은 PEAKET_FENCE_OVERFLOW).
 */
export function seatLuaErrorOf(err: unknown): SeatLuaError | undefined {
  if (err instanceof SeatStoreUnavailable) return err.reason === 'oom' ? { code: 'OOM' } : undefined;
  if (!(err instanceof Error)) return { code: 'OTHER' };
  const m = err.message;
  const corrupt = /PEAKET_CORRUPT_KEY(?:\s+(\S*))?/.exec(m);
  if (corrupt) return { code: 'CORRUPT_KEY', keyKind: keyKindOf(corrupt[1] ?? '') };
  if (m.includes('PEAKET_KEEP_UNTIL_PAST')) return { code: 'KEEP_UNTIL_PAST' };
  if (m.includes('PEAKET_FENCE_OVERFLOW')) return { code: 'FENCE_OVERFLOW' };
  return { code: 'OTHER' };
}

/** 회차 태그 뒤 첫 조각으로 가르는 키 종류 */
const EVENT_KEY_KINDS: ReadonlySet<SeatKeyKind> = new Set(['bitmap', 'hold', 'expiry', 'quota', 'stream', 'idem', 'epoch', 'ctl', 'rel', 'secver', 'fence', 'sweep']);

/** 키 이름 → 종류(s:ctl:events, s:{…}:{종류}[:…]. 그 밖은 unknown) */
function keyKindOf(key: string): SeatKeyKind {
  if (key === 's:ctl:events') return 'ctl:events';
  const m = /^s:\{[^}]+\}:([^:]+)/.exec(key);
  const kind = m?.[1] as SeatKeyKind | undefined;
  return kind && EVENT_KEY_KINDS.has(kind) ? kind : 'unknown';
}
