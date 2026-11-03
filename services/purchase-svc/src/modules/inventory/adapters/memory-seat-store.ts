// 시험용 좌석 저장소. 좌석 Redis의 홀드 Lua(hold-lua.ts의 계약)와 같은 규칙을 메모리로 둔다(같은 사례를 메모리와 실제 Valkey에 똑같이 돈다).
// 서버 시각은 주입한 시계다(Lua는 Redis TIME): µs = Clock.now() × 1000. 키 만료는 흉내 내지 않고 걸린 시각만 적는다(멱등 기록 7분만 읽을 때 지난 것을 없는 것으로 본다).
import type { Clock } from '@peaket/platform';
import { HOLD_TTL_MS, type HoldInput, type HoldResult, IDEM_TTL_MS, type ReplayInput, type ReplayResult, SEAT_STATE_HELD } from '../domain/hold.js';
import type { SeatStore } from '../domain/ports.js';
import { firstResponseOf, seatKeys } from './redis-seat-store.js';

/** 좌석 홀드 Hash s:{event:E}:hold:{색인}의 칸(hold-lua.ts 쓰기) */
export interface MemoryHoldHash {
  holdId: string;
  /** 소유 계정 */
  owner: string;
  /** 구매 세션 ID */
  psid: string;
  /** 펜싱 토큰(10진 글) */
  fence: string;
  heldAt: number;
  exp: number;
  /** 홀드 종류(data.md: FAN·PRIORITY. 홀드 Lua는 FAN) */
  kind: 'FAN' | 'PRIORITY';
  /** 연장한 횟수(10진 글, 홀드 Lua는 '0') */
  ext: string;
}

/** 멱등 기록 s:{event:E}:idem:{account}:{key} */
export interface MemoryIdemRecord {
  /** 지문(hex 64) */
  fp: string;
  /** 처음 응답 '{holdId}:{heldAt}:{exp}:{토큰}' */
  resp: string;
  /** 이 시각(epoch ms) 이후에는 없는 것으로 본다(= 쓴 시각 + IDEM_TTL_MS) */
  expiresAtMs: number;
}

/** 샤드 Pub/Sub 한 건 */
export interface MemoryPublished {
  channel: string;
  message: string;
}

/** 회차 하나의 좌석 키(시험이 직접 채우고 읽는다). 이름은 docs/data.md §3의 키와 같다 */
export class MemorySeatEvent {
  /** 세대 키 s:{event:E}:epoch의 칸 epoch(세대)·node(주 노드 표지). 없으면 NOT_READY */
  epoch: { epoch: number; node: string } | undefined;
  /** 비트맵 크기(openSale의 seatCount). 없으면 비트맵이 없다 */
  seatCount: number | undefined;
  /** 비트맵에서 1인 색인 */
  readonly bits = new Set<number>();
  /** 색인 → 홀드 Hash */
  readonly holds = new Map<number, MemoryHoldHash>();
  /** 만료 인덱스: 색인 → exp */
  readonly expiry = new Map<number, number>();
  /** 보유 수: 계정 → 수 */
  readonly quota = new Map<string, number>();
  /** 멱등 기록: '{account}:{key}' → 기록 */
  readonly idem = new Map<string, MemoryIdemRecord>();
  /** 판매 정지 사본 ctl의 칸(data.md: paused·suspended·rev·cmd·suspRef·allPaused·allRev·allCmd). paused·allPaused·suspended 가운데 '1'이 있으면 정지 */
  readonly ctl = new Map<string, string>();
  /** 방금 놓은 좌석: 계정 → (색인 → 다시 잡을 수 있는 시각 ms) */
  readonly rel = new Map<string, Map<number, number>>();
  /** 구역별 일련번호: 구역 색인 → 마지막 번호 */
  readonly secver = new Map<number, number>();
  /** 마지막 펜싱 토큰(10진 글). 없으면 0으로 본다 */
  fence: string | undefined;
  /** Stream 항목(XADD 차례). 칸 이름·값은 docs/data.md §3 HELD 칸(모두 글) */
  readonly stream: Record<string, string>[] = [];
  /** 샤드 Pub/Sub(보낸 차례) */
  readonly published: MemoryPublished[] = [];
  /** PEXPIREAT로 건 만료 시각: 키 이름(redis-seat-store.ts seatKeys) → epoch ms */
  readonly expireAt = new Map<string, number>();
}

/** 좌석 저장소 전체의 메모리 모양 */
export class MemorySeatDb {
  /** 좌석 비트맵이 있는 회차 목록 s:ctl:events */
  readonly ctlEvents = new Set<string>();
  readonly #events = new Map<string, MemorySeatEvent>();

  /** 회차의 키 묶음. 없으면 빈 것을 만들어 둔다(세대 키·비트맵 없음) */
  event(eventId: string): MemorySeatEvent {
    let e = this.#events.get(eventId);
    if (!e) {
      e = new MemorySeatEvent();
      this.#events.set(eventId, e);
    }
    return e;
  }
}

/**
 * SeatStore의 메모리 구현. 계약은 domain/ports.ts SeatStore와 hold-lua.ts이고, 결과는 RedisSeatStore와 같다.
 * Redis와 다른 점: 시각은 주입 Clock(µs = now × 1000이라 같은 ms 안의 두 홀드는 fence + 1로 갈린다), openSale의 epoch = floor(now / 1000)·node 'standalone',
 * 키 만료는 expireAt에 적기만 한다. 일시 장애(SeatStoreUnavailable)는 내지 않는다
 */
export class MemorySeatStore implements SeatStore {
  readonly db = new MemorySeatDb();

  constructor(private readonly clock: Clock) {}

  // 두 메서드 모두 본문에 await가 없어 한 번에 끝난다(Lua가 샤드에서 하나씩 도는 것과 같다. 동시 호출이 서로 끼어들지 않는다)
  async hold(i: HoldInput): Promise<HoldResult> {
    const e = i.eventId;
    const ev = this.db.event(e);
    const now = this.clock.now();

    // 1 세대 키
    if (!ev.epoch) return { kind: 'NOT_READY' };

    // 2 멱등 기록(지난 것은 Redis의 키 만료처럼 없앤다)
    const idemKey = `${i.accountId}:${i.idempotencyKey}`;
    const replayed = this.#replay(ev, idemKey, i.fingerprint, now);
    if (replayed) return replayed;

    // 3 판매 정지 사본
    if (STOP_FIELDS.some((f) => ev.ctl.get(f) === '1')) return { kind: 'PAUSED' };

    // 4 경합(seats 차례의 첫 충돌)
    const taken = i.seats.find((s) => ev.bits.has(s.index));
    if (taken) return { kind: 'CONFLICT', seatId: taken.seatId };

    // 5 방금 놓은 좌석(점수가 지금보다 큰 것만)
    const rel = ev.rel.get(i.accountId);
    const waits = rel ? i.seats.filter((s) => (rel.get(s.index) ?? -Infinity) > now) : [];
    if (waits.length > 0) return { kind: 'REHOLD_WAIT', seatIds: waits.map((s) => s.seatId), availableAtMs: Math.max(...waits.map((s) => rel!.get(s.index)!)) };

    // 쓰기 전 지킴(Lua와 같다): 지난 keepUntil, 10진 정수 글이 아닌 보유 수·fence. 메모리는 키 형이 정해져 있어 형 검사는 없다
    if (!(i.keepUntilMs > now)) throw new Error(`PEAKET_KEEP_UNTIL_PAST keepUntil ${i.keepUntilMs} now ${now}`);
    const quotaKey = seatKeys.quota(e, i.accountId);
    const quota = ev.quota.get(i.accountId);
    if (quota !== undefined && !DIGITS.test(String(quota))) throw new Error(`PEAKET_CORRUPT_KEY ${quotaKey}`);
    if (ev.fence !== undefined && !DIGITS.test(ev.fence)) throw new Error(`PEAKET_CORRUPT_KEY ${seatKeys.fence(e)}`);

    // 6 1인 한도
    const n = i.seats.length;
    if ((quota ?? 0) + n > i.limit) return { kind: 'QUOTA_EXCEEDED' };

    // 7 쓰기(여기까지 아무것도 쓰지 않았다). 토큰이 안전한 정수를 넘으면 쓰지 않고 던진다(Lua의 PEAKET_FENCE_OVERFLOW)
    const token = Math.max(Number(ev.fence ?? '0') + 1, now * 1000);
    if (!Number.isSafeInteger(token)) throw new Error(`펜싱 토큰이 안전한 정수를 넘는다(fence ${ev.fence})`);
    const tok = String(token);
    const exp = now + HOLD_TTL_MS;
    const extend = (key: string) => {
      const cur = ev.expireAt.get(key);
      if (cur === undefined || cur < i.keepUntilMs) ev.expireAt.set(key, i.keepUntilMs);
    };

    ev.fence = tok;
    for (const s of i.seats) {
      const hk = seatKeys.hold(e, s.index);
      ev.bits.add(s.index);
      // DEL 뒤 HSET: 있던 칸과 수명을 지운다
      ev.expireAt.delete(hk);
      ev.holds.set(s.index, { holdId: i.holdId, owner: i.accountId, psid: i.purchaseSessionId, fence: tok, heldAt: now, exp, kind: 'FAN', ext: '0' });
      ev.expiry.set(s.index, exp);
      extend(hk);
    }
    ev.quota.set(i.accountId, (quota ?? 0) + n);
    ev.idem.set(idemKey, { fp: i.fingerprint, resp: `${i.holdId}:${now}:${exp}:${tok}`, expiresAtMs: now + IDEM_TTL_MS });

    // 바뀐 구역마다 일련번호 +1(처음 나온 차례)
    const version = new Map<number, number>();
    const deltas = new Map<number, string[]>();
    for (const s of i.seats) {
      if (!version.has(s.sectionIndex)) {
        const v = (ev.secver.get(s.sectionIndex) ?? 0) + 1;
        ev.secver.set(s.sectionIndex, v);
        version.set(s.sectionIndex, v);
        deltas.set(s.sectionIndex, []);
      }
      deltas.get(s.sectionIndex)!.push(`${s.seatOffset}:${SEAT_STATE_HELD}`);
    }
    const seatEpoch = String(ev.epoch.epoch);
    for (const s of i.seats) {
      ev.stream.push({
        type: 'HELD',
        seatIdx: String(s.index),
        seatId: s.seatId,
        tierId: s.tierId,
        sectionId: s.sectionId,
        holdId: i.holdId,
        holdKind: 'FAN',
        purchaseSessionId: i.purchaseSessionId,
        accountId: i.accountId,
        fencingToken: tok,
        sectionVersion: String(version.get(s.sectionIndex)),
        seatEpoch,
        occurredAtMs: String(now),
        expiresAtMs: String(exp),
      });
    }
    for (const [sec, list] of deltas) {
      ev.published.push({ channel: seatKeys.section(e, String(sec)), message: `1 ${seatEpoch} ${sec} ${version.get(sec)} ${now} ${list.join(' ')}` });
    }
    // 세대 키도 같은 규칙으로 늘린다(비트맵보다 먼저 지워져 산 회차가 NOT_READY가 되지 않게)
    for (const key of [seatKeys.bitmap(e), seatKeys.expiry(e), quotaKey, seatKeys.stream(e), seatKeys.epoch(e), seatKeys.secver(e), seatKeys.fence(e)]) extend(key);
    return { kind: 'OK', holdId: i.holdId, fencingToken: token, heldAtMs: now, expiresAtMs: exp };
  }

  /** SeatStore.replay: 멱등 기록 하나만 읽는다(지난 것은 없앤다, Redis 키 만료와 같다) */
  async replay(i: ReplayInput): Promise<ReplayResult> {
    return this.#replay(this.db.event(i.eventId), `${i.accountId}:${i.idempotencyKey}`, i.fingerprint, this.clock.now());
  }

  #replay(ev: MemorySeatEvent, idemKey: string, fingerprint: string, now: number): ReplayResult {
    const rec = ev.idem.get(idemKey);
    if (!rec) return null;
    if (rec.expiresAtMs <= now) {
      ev.idem.delete(idemKey);
      return null;
    }
    if (rec.fp !== fingerprint) return { kind: 'IDEM_REUSED' };
    return { kind: 'IDEM_REPLAY', ...firstResponseOf(rec.resp) };
  }

  async openSale(i: { eventId: string; seatCount: number; keepUntilMs: number }): Promise<{ created: boolean; seatEpoch: number }> {
    if (!Number.isSafeInteger(i.seatCount) || i.seatCount < 1) throw new RangeError(`좌석 수는 1 이상의 정수다: ${i.seatCount}`);
    const ev = this.db.event(i.eventId);
    this.db.ctlEvents.add(i.eventId);
    if (ev.epoch) return { created: false, seatEpoch: ev.epoch.epoch };
    // 비트맵은 모자랄 때만 늘린다(있는 비트는 그대로). 세대 키는 마지막에
    ev.seatCount = Math.max(ev.seatCount ?? 0, i.seatCount);
    ev.epoch = { epoch: Math.floor(this.clock.now() / 1000), node: 'standalone' };
    for (const key of [seatKeys.bitmap(i.eventId), seatKeys.epoch(i.eventId)]) {
      const cur = ev.expireAt.get(key);
      if (cur === undefined || cur < i.keepUntilMs) ev.expireAt.set(key, i.keepUntilMs);
    }
    return { created: true, seatEpoch: ev.epoch.epoch };
  }
}

/** ctl에서 '1'이면 정지인 칸(회차 범위 판매 일시정지·전체 범위·판매 중지) */
const STOP_FIELDS = ['paused', 'allPaused', 'suspended'] as const;

/** 보유 수·fence 값의 모양(Lua의 ^%d+$) */
const DIGITS = /^\d+$/;
