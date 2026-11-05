// 시험용 좌석 저장소. 좌석 Redis의 홀드 Lua(hold-lua.ts의 계약)와 같은 규칙을 메모리로 둔다(같은 사례를 메모리와 실제 Valkey에 똑같이 돈다).
// 서버 시각은 주입한 시계다(Lua는 Redis TIME): µs = Clock.now() × 1000. 키 만료는 흉내 내지 않고 걸린 시각만 적는다(멱등 기록 7분만 읽을 때 지난 것을 없는 것으로 본다).
import type { Clock, PlatformLogger } from '@peaket/platform';
import { assertDueExpiriesInput, assertExpireInput, type DueExpiriesInput, type DueExpiry, type ExpireInput, type ExpireResult, isExpirableFence, isStandardInt } from '../domain/expiry.js';
import {
  HOLD_TTL_MS,
  type HoldInput,
  type HoldResult,
  IDEM_TTL_MS,
  KEY_PART,
  REHOLD_WAIT_MS,
  type ReplayInput,
  type ReplayResult,
  SEAT_STATE_AVAILABLE,
  SEAT_STATE_HELD,
  type SeatRef,
} from '../domain/hold.js';
import type { LogGate } from '../domain/log-gate.js';
import type { SeatCallOptions, SeatEventRetire, SeatExpiries, SeatPins, SeatRebuildTarget, SeatSnapshots, SeatStore, SnapshotReadInput, SnapshotReadResult } from '../domain/ports.js';
import { assertRebuildBegin, assertRebuildFinish, assertRebuildSeats, type RebuildFinishInput, type RebuildSeat, type RebuildStep } from '../domain/rebuild.js';
import {
  assertPinInput,
  assertReleaseFailedInput,
  assertRetireInput,
  FAILED_HOLD_MARK_TTL_MS,
  INITIAL_SEAT_GEN,
  type PinInput,
  type PinResult,
  type ReleaseFailedInput,
  type ReleaseFailedResult,
  RETIRE_AFTER_SALE_END_MS,
  type RetireResult,
} from '../domain/pin.js';
import { assertSnapshotInput } from '../domain/snapshot.js';
import { firstResponseOf, seatKeys } from './redis-seat-store.js';
import { keepEventIds, saleEventsWarnGate } from './sale-events.js';

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
  /** 묶음 표시(묶기 Lua가 '1'로 둔다, BUILD_ORDER PRF-142). 없으면 묶이지 않았다 */
  pin?: '1';
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

/**
 * 세대 키 s:{event:E}:epoch의 칸 epoch(세대)·node(주 노드 표지)·gen(다시 만들기 판 번호, 판매 열기가 1로 둔다. 없으면 1로 본다, BUILD_ORDER PRF-142)·
 * chk(표지의 설정 세대까지 마지막으로 견준 초. 없으면 0으로 본다, ADR-0210)·bumps(장애 조치 뒤 세대를 올린 누적 수. 없으면 0, PRF-168 리뷰 고침 중간 1)
 */
export interface MemoryEpoch {
  epoch: number;
  node: string;
  gen?: number;
  chk?: number;
  bumps?: number;
}

/** 회차 하나의 좌석 키(시험이 직접 채우고 읽는다). 이름은 docs/data.md §3의 키와 같다 */
export class MemorySeatEvent {
  /** 세대 키(MemoryEpoch). 없으면 NOT_READY */
  epoch: MemoryEpoch | undefined;
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
  /** 다시 만들기 시도의 판 번호 s:{event:E}:rebuild(시작이 쓴다, 코드 리뷰 PRF-143). 없으면 undefined */
  rebuildGen: number | undefined;
  /**
   * 실패 표시 s:{event:E}:failed:{holdId}(실패 해제가 남긴다, BUILD_ORDER PRF-165): holdId → 수명이 다하는 시각(epoch ms).
   * 주입 Clock의 지금이 그 시각 이상이면 없는 것으로 본다
   */
  readonly failed = new Map<string, number>();
  /** Stream 항목(XADD 차례). 칸 이름·값은 docs/data.md §3 HELD 칸(모두 글) */
  readonly stream: Record<string, string>[] = [];
  /** 샤드 Pub/Sub(보낸 차례) */
  readonly published: MemoryPublished[] = [];
  /** PEXPIREAT로 건 만료 시각: 키 이름(redis-seat-store.ts seatKeys) → epoch ms */
  readonly expireAt = new Map<string, number>();
  /**
   * 회차별 만료 임대 s:{event:E}:sweep(MemorySweepLeases가 쓴다, BUILD_ORDER PRF-135). owner = 잡은 파드 ID, expiresAtMs = 수명이 다하는 시각(epoch ms).
   * 주입 Clock의 지금이 expiresAtMs 이상이면 없는 것으로 본다. 없으면 undefined
   */
  sweep: { owner: string; expiresAtMs: number } | undefined;
  /** 구매 세션 정리 반복의 회차별 임대 s:{event:E}:sesweep(BUILD_ORDER PRF-138). 모양은 sweep과 같다 */
  sessionSweep: { owner: string; expiresAtMs: number } | undefined;
}

/** MemorySeatStore 생성자 선택(BUILD_ORDER PRF-168) */
export interface MemorySeatStoreOptions {
  /** 주 노드 표지(Lua의 nodeId() 대신: 클러스터 '{CLUSTER MYID}:{cluster_my_epoch}', 단일 노드 'standalone'). 기본 'standalone' */
  nodeId?: string;
}

/** 단일 노드의 주 노드 표지(hold-lua.ts NODE_ID가 'cluster support disabled'일 때 쓰는 값). MemorySeatStore의 기본 표지 */
const STANDALONE_NODE = 'standalone';

/** 주 노드 표지의 모양: 빈 글이 아닌 글 */
function assertNodeId(id: unknown): asserts id is string {
  if (typeof id !== 'string' || id.length === 0) throw new RangeError('주 노드 표지(nodeId)가 비었다');
}

/** 표지의 노드 ID 부분(':' 앞, Lua ensureEpoch가 매번 견주는 CLUSTER MYID 몫). ':'이 없으면 표지 그대로('standalone') */
const nodeIdPart = (node: string): string => {
  const cut = node.indexOf(':');
  return cut < 0 ? node : node.slice(0, cut);
};

/** 좌석 저장소 전체의 메모리 모양 */
export class MemorySeatDb {
  /** 좌석 비트맵이 있는 회차 목록 s:ctl:events */
  readonly ctlEvents = new Set<string>();
  readonly #events = new Map<string, MemorySeatEvent>();

  /** 회차의 키 묶음을 만들지 않고 찾는다(읽기 전용 메서드가 쓴다). 없으면 undefined */
  peek(eventId: string): MemorySeatEvent | undefined {
    return this.#events.get(eventId);
  }

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
 * SeatStore·SeatExpiries의 메모리 구현. 계약은 domain/ports.ts SeatStore·SeatExpiries와 hold-lua.ts·expire-lua.ts이고, 결과는 RedisSeatStore와 같다.
 * Redis와 다른 점: 시각은 주입 Clock(µs = now × 1000이라 같은 ms 안의 두 홀드는 fence + 1로 갈린다), openSale의 epoch = floor(now / 1000)·node = 생성자 nodeId(기본 'standalone', PRF-168),
 * 키 만료는 expireAt에 적기만 한다. 일시 장애·메모리 부족(SeatStoreUnavailable)은 내지 않는다. 호출 마감(SeatCallOptions)은 보지 않는다.
 * 만료(PRF-135): saleEvents = db.ctlEvents(KEY_PART 모양만), dueExpiries·expire는 MemorySeatEvent의 expiry·holds·bits·quota·rel·secver·stream·published·expireAt을
 * ports.ts SeatExpiries의 차례대로 바꾼다(만료 Lua와 같은 결과. 보유 수가 0 이하가 되면 quota에서 지우고 expireAt의 그 키도 지운다)
 * 묶기·실패 해제·회차 목록 빼기(PRF-142): pin-lua.ts의 계약과 RedisSeatStore.retireEvent의 차례를 같은 키 모형에 둔다. openSale은 epoch.gen = 1을 함께 쓴다
 * 세대 확인(PRF-168 리뷰 고침 H1·결함 1, ADR-0210): hold·expire·pin·releaseFailed·bumpEpoch는 hold-lua.ts ENSURE_EPOCH와 같은 규칙(#readEpoch·#ensureEpoch)이다.
 * 세대 키는 맨 앞에서 읽고(망가진 세대 칸은 오류), 세대 확인(올리기)은 Lua와 같은 자리(오류로 끝나는 검사 뒤, 거절 결과를 돌려주기 직전과 쓰기 앞)에서 한 번 한다.
 * 표지는 생성자 nodeId(시험은 setNodeId로 승격을 흉내), chk는 그 메서드가 읽은 주입 시계의 초다
 */
export class MemorySeatStore implements SeatStore, SeatExpiries, SeatSnapshots, SeatPins, SeatEventRetire, SeatRebuildTarget {
  readonly db = new MemorySeatDb();
  readonly #filterWarnGate: LogGate;
  /** 이 저장소가 흉내 내는 주 노드의 표지(Lua의 nodeId() 대신). openSale·finish·bumpEpoch와 쓰는 메서드(hold·expire·pin·releaseFailed)가 세대 키 node에 쓰고 견준다 */
  #nodeId: string;

  /**
   * @param clock 저장소 시각(Lua의 TIME 대신)
   * @param logger 서비스 로거(선택). saleEvents가 거른 값의 수를 남긴다(L8, 파드마다 60초에 한 줄까지, C3)
   * @param options nodeId = 이 저장소가 흉내 내는 주 노드의 표지(Lua의 nodeId() 대신, 기본 'standalone'). openSale·finish·bumpEpoch가 쓴다(BUILD_ORDER PRF-168)
   * @throws RangeError options.nodeId가 빈 글
   */
  constructor(
    private readonly clock: Clock,
    private readonly logger?: PlatformLogger,
    options: MemorySeatStoreOptions = {},
  ) {
    this.#filterWarnGate = saleEventsWarnGate(clock);
    const nodeId = options.nodeId ?? STANDALONE_NODE;
    assertNodeId(nodeId);
    this.#nodeId = nodeId;
  }

  /**
   * 시험용: 주 노드 표지를 바꾼다(장애 조치로 복제본이 승격되어 그 슬롯의 Lua가 다른 노드에서 도는 것을 흉내, BUILD_ORDER PRF-168). 세대 키는 바꾸지 않는다
   * @throws RangeError id가 빈 글
   */
  setNodeId(id: string): void {
    assertNodeId(id);
    this.#nodeId = id;
  }

  /**
   * 세대 키 읽기(hold-lua.ts ENSURE_EPOCH readEpoch의 쌍둥이, 쓰지 않는다): 세대 키가 없으면 undefined(부른 쪽이 NOT_READY).
   * epoch가 u32(0 ~ 4294967295의 안전한 정수)가 아니거나 bumps가 있는데 0 이상의 안전한 정수가 아니면 PEAKET_CORRUPT_KEY {세대 키}를 던진다(리뷰 고침 낮음 a)
   */
  #readEpoch(eventId: string, ev: MemorySeatEvent): MemoryEpoch | undefined {
    const ep = ev.epoch;
    if (!ep) return undefined;
    const u32 = Number.isSafeInteger(ep.epoch) && ep.epoch >= 0 && ep.epoch <= 0xffff_ffff;
    const bumpsOk = ep.bumps === undefined || (Number.isSafeInteger(ep.bumps) && ep.bumps >= 0);
    if (!u32 || !bumpsOk) throw new Error(`PEAKET_CORRUPT_KEY ${seatKeys.epoch(eventId)}`);
    return ep;
  }

  /**
   * 세대 확인과 그 자리 올리기(hold-lua.ts ENSURE_EPOCH ensureEpoch의 쌍둥이, ADR-0210 결정 1·2): 부른 메서드의 첫 쓰기다(오류로 끝나는 검사를 모두 지난 뒤, 리뷰 고침 결함 1).
   * 표지의 노드 ID 부분(':' 앞)은 매번, 전체 표지는 노드 ID가 다르거나 chk가 지금 초 sec와 다를 때(없거나, 시계가 뒤로 가 미래의 chk여도, 리뷰 고침 낮음 d)만
   * 이 저장소의 표지(nodeId)와 견준다. 견줬으면 chk = sec, 다르면 epoch = max(epoch + 1, sec)·node = 이 저장소의 표지·bumps + 1.
   * 지금 세대(올렸으면 새 값), 올렸는지, 올린 누적 수를 돌려준다
   * @param sec 부른 메서드가 읽은 주입 시계의 초(Lua의 TIME 초, 리뷰 고침 낮음 c)
   */
  #ensureEpoch(ep: MemoryEpoch, sec: number): { epoch: number; bumped: boolean; bumps: number } {
    const node = this.#nodeId;
    if (nodeIdPart(ep.node) === nodeIdPart(node) && ep.chk === sec) return { epoch: ep.epoch, bumped: false, bumps: ep.bumps ?? 0 };
    if (ep.node === node) {
      ep.chk = sec;
      return { epoch: ep.epoch, bumped: false, bumps: ep.bumps ?? 0 };
    }
    ep.epoch = Math.max(ep.epoch + 1, sec);
    ep.node = node;
    ep.chk = sec;
    ep.bumps = (ep.bumps ?? 0) + 1;
    return { epoch: ep.epoch, bumped: true, bumps: ep.bumps };
  }

  // 메서드 모두 본문에 await가 없어 한 번에 끝난다(Lua가 샤드에서 하나씩 도는 것과 같다. 동시 호출이 서로 끼어들지 않는다)
  async hold(i: HoldInput, _o?: SeatCallOptions): Promise<HoldResult> {
    const e = i.eventId;
    const ev = this.db.event(e);
    const now = this.clock.now();
    const sec = Math.floor(now / 1000);

    // 1 세대 키(읽기만. 망가진 세대 칸은 오류)
    const ep = this.#readEpoch(e, ev);
    if (!ep) return { kind: 'NOT_READY' };
    // 거절 결과를 돌려주기 직전의 세대 확인(장애 조치 뒤면 그 자리에서 올린다, ADR-0210. 오류로 끝나는 검사는 부르지 않는다)
    const decided = (r: HoldResult): HoldResult => {
      this.#ensureEpoch(ep, sec);
      return r;
    };

    // 2 멱등 기록(지난 것은 Redis의 키 만료처럼 없앤다)
    const idemKey = `${i.accountId}:${i.idempotencyKey}`;
    const replayed = this.#replay(ev, idemKey, i.fingerprint, now);
    if (replayed) return decided(replayed);

    // 3 판매 정지 사본
    if (STOP_FIELDS.some((f) => ev.ctl.get(f) === '1')) return decided({ kind: 'PAUSED' });

    // 4 경합(seats 차례의 첫 충돌)
    const taken = i.seats.find((s) => ev.bits.has(s.index));
    if (taken) return decided({ kind: 'CONFLICT', seatId: taken.seatId });

    // 5 방금 놓은 좌석(점수가 지금보다 큰 것만)
    const rel = ev.rel.get(i.accountId);
    const waits = rel ? i.seats.filter((s) => (rel.get(s.index) ?? -Infinity) > now) : [];
    if (waits.length > 0) return decided({ kind: 'REHOLD_WAIT', seatIds: waits.map((s) => s.seatId), availableAtMs: Math.max(...waits.map((s) => rel!.get(s.index)!)) });

    // 쓰기 전 지킴(Lua와 같다): 지난 keepUntil, 표준 10진 정수가 아닌 보유 수(INCRBY가 받는 값, A1)·10진 정수 글이 아닌 fence(SET만 하는 값이라 앞 0은 받는다).
    // 메모리는 키 형이 정해져 있어 형 검사는 없다
    if (!(i.keepUntilMs > now)) throw new Error(`PEAKET_KEEP_UNTIL_PAST keepUntil ${i.keepUntilMs} now ${now}`);
    const quotaKey = seatKeys.quota(e, i.accountId);
    const quota = ev.quota.get(i.accountId);
    if (quota !== undefined && !isStandardInt(String(quota))) throw new Error(`PEAKET_CORRUPT_KEY ${quotaKey}`);
    if (ev.fence !== undefined && !DIGITS.test(ev.fence)) throw new Error(`PEAKET_CORRUPT_KEY ${seatKeys.fence(e)}`);
    // 바뀔 구역의 secver 칸 값(PRF-130 리뷰 낮음 3, HINCRBY가 받는 표준 10진 정수, A1). 바뀌지 않을 구역은 보지 않는다
    for (const s of i.seats) {
      const v = ev.secver.get(s.sectionIndex);
      if (v !== undefined && !isStandardInt(String(v))) throw new Error(`PEAKET_CORRUPT_KEY ${seatKeys.secver(e)}`);
    }

    // 6 1인 한도
    const n = i.seats.length;
    // 시험이 글로 넣은 값('5' 같은)이 글 이어 붙이기가 되지 않게 수로 바꿔 쓴다(지킴을 지난 값이라 표준 10진 정수다)
    const held = quota === undefined ? 0 : Number(quota);
    if (held + n > i.limit) return decided({ kind: 'QUOTA_EXCEEDED' });

    // 7 쓰기(여기까지 아무것도 쓰지 않았다). 토큰이 안전한 정수를 넘으면 쓰지 않고 던진다(Lua의 PEAKET_FENCE_OVERFLOW, 세대 확인보다 앞)
    const token = Math.max(Number(ev.fence ?? '0') + 1, now * 1000);
    if (!Number.isSafeInteger(token)) throw new Error(`PEAKET_FENCE_OVERFLOW 펜싱 토큰이 안전한 정수를 넘는다(fence ${ev.fence})`);
    // 첫 쓰기: 세대 확인(아래 Stream·델타는 이 세대를 싣는다)
    const cur = this.#ensureEpoch(ep, sec);
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
    ev.quota.set(i.accountId, held + n);
    ev.idem.set(idemKey, { fp: i.fingerprint, resp: `${i.holdId}:${now}:${exp}:${tok}`, expiresAtMs: now + IDEM_TTL_MS });

    // 바뀐 구역마다 일련번호 +1(처음 나온 차례)
    const version = new Map<number, number>();
    const deltas = new Map<number, string[]>();
    for (const s of i.seats) {
      if (!version.has(s.sectionIndex)) {
        const v = Number(ev.secver.get(s.sectionIndex) ?? 0) + 1;
        ev.secver.set(s.sectionIndex, v);
        version.set(s.sectionIndex, v);
        deltas.set(s.sectionIndex, []);
      }
      deltas.get(s.sectionIndex)!.push(`${s.seatOffset}:${SEAT_STATE_HELD}`);
    }
    const seatEpoch = String(cur.epoch);
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
  async replay(i: ReplayInput, _o?: SeatCallOptions): Promise<ReplayResult> {
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

  async read(i: SnapshotReadInput, _o?: SeatCallOptions): Promise<SnapshotReadResult> {
    assertSnapshotInput(i);
    const ev = this.db.peek(i.eventId);
    if (!ev?.epoch) return { kind: 'NOT_READY' };
    const corrupt = (key: string): Error => new Error(`PEAKET_CORRUPT_KEY ${key}`);
    const isU32 = (n: number): boolean => Number.isSafeInteger(n) && n >= 0 && n <= 0xffff_ffff;
    if (!isU32(ev.epoch.epoch)) throw corrupt(seatKeys.epoch(i.eventId));
    const firstByte = Math.floor(i.firstBit / 8);
    const lastByte = Math.floor((i.firstBit + i.bitCount - 1) / 8);
    // Redis의 비트맵은 바이트 안에서 높은 비트부터다(SETBIT 0 = 첫 바이트의 가장 높은 비트). 비트맵 길이를 넘는 바이트는 0이다
    const bytes = Buffer.alloc(lastByte - firstByte + 1);
    for (const idx of ev.bits) {
      const b = idx >> 3;
      if (b >= firstByte && b <= lastByte) bytes[b - firstByte]! |= 0x80 >> (idx & 7);
    }
    const sectionVersions = i.sectionIndexes.map((s) => {
      const v = ev.secver.get(s) ?? 0;
      if (!isU32(v)) throw corrupt(seatKeys.secver(i.eventId));
      return v;
    });
    return { kind: 'OK', seatEpoch: ev.epoch.epoch, bytes, sectionVersions };
  }

  /**
   * 좌석 묶기(BUILD_ORDER PRF-142): 묶기 Lua(pin-lua.ts PIN_LUA)와 같은 차례(세대 키 → 실패 표시(PRF-165) → 남의 좌석 → 낡은 판 번호 → 쓰기 전 지킴 → 한도 → 쓰기), 시각은 주입 Clock.
   * 메모리는 키 형이 정해져 있어 형 검사는 없다. gen은 epoch.gen(없으면 1)이다
   */
  async pin(i: PinInput, _o?: SeatCallOptions): Promise<PinResult> {
    assertPinInput(i);
    const e = i.eventId;
    const ev = this.db.event(e);
    const clockNow = this.clock.now();
    const sec = Math.floor(clockNow / 1000);

    // 1 세대 키(읽기만. 망가진 세대 칸은 오류. gen 칸 값이 앞 0 없는 양의 10진 정수 15자리 이하가 아니면 망가진 키)
    const ep = this.#readEpoch(e, ev);
    if (!ep) return { kind: 'NOT_READY' };
    const gen = ep.gen ?? INITIAL_SEAT_GEN;
    if (!Number.isSafeInteger(gen) || gen < 1 || gen >= 1e15) throw new Error(`PEAKET_CORRUPT_KEY ${seatKeys.epoch(e)}`);
    // 거절 결과를 돌려주기 직전의 세대 확인(장애 조치 뒤면 그 자리에서 올린다, ADR-0210. 오류로 끝나는 검사는 부르지 않는다)
    const decided = (r: PinResult): PinResult => {
      this.#ensureEpoch(ep, sec);
      return r;
    };

    // 1′ 실패 표시(PRF-165): 실패 해제가 먼저 돌았다. 아무것도 쓰지 않는다(세대 확인만)
    const mark = ev.failed.get(i.holdId);
    if (mark !== undefined && mark > clockNow) return decided({ kind: 'FAILED_HOLD' });

    // 2 좌석마다 내 홀드(비트 1, holdId·owner 같음) · 빈 좌석(비트 0) · 남의 좌석(그 밖)
    const mine: MemoryHoldHash[] = [];
    const empty: SeatRef[] = [];
    for (const s of i.seats) {
      if (ev.bits.has(s.index)) {
        const h = ev.holds.get(s.index);
        if (!h || h.holdId !== i.holdId || h.owner !== i.accountId) return decided({ kind: 'TAKEN', seatIndex: s.index });
        mine.push(h);
      } else {
        empty.push(s);
      }
    }
    const k = empty.length;

    // 3 낡은 판 번호(빈 좌석이 있을 때만)
    if (k > 0 && i.orderGen !== gen) return decided({ kind: 'STALE_GEN', gen });

    // 쓰기 전 지킴과 4 한도(빈 좌석이 있을 때만. Lua와 같다)
    const quotaKey = seatKeys.quota(e, i.accountId);
    let now = 0;
    let held = 0;
    let token = 0;
    if (k > 0) {
      now = clockNow;
      if (!(i.keepUntilMs > now)) throw new Error(`PEAKET_KEEP_UNTIL_PAST keepUntil ${i.keepUntilMs} now ${now}`);
      const quota = ev.quota.get(i.accountId);
      if (quota !== undefined && !isStandardInt(String(quota))) throw new Error(`PEAKET_CORRUPT_KEY ${quotaKey}`);
      if (ev.fence !== undefined && !DIGITS.test(ev.fence)) throw new Error(`PEAKET_CORRUPT_KEY ${seatKeys.fence(e)}`);
      for (const s of empty) {
        const v = ev.secver.get(s.sectionIndex);
        if (v !== undefined && !isStandardInt(String(v))) throw new Error(`PEAKET_CORRUPT_KEY ${seatKeys.secver(e)}`);
      }
      held = quota === undefined ? 0 : Number(quota);
      if (held + k > i.limit) return decided({ kind: 'QUOTA_EXCEEDED' });
      token = Math.max(Number(ev.fence ?? '0') + 1, now * 1000);
      if (!Number.isSafeInteger(token)) throw new Error(`PEAKET_FENCE_OVERFLOW 펜싱 토큰이 안전한 정수를 넘는다(fence ${ev.fence})`);
    }

    // 첫 쓰기: 세대 확인(아래 HELD·델타는 이 세대를 싣는다)
    const cur = this.#ensureEpoch(ep, sec);

    // 5 쓰기
    const tok = String(token);
    const exp = now + HOLD_TTL_MS;
    const extend = (key: string) => {
      const cur = ev.expireAt.get(key);
      if (cur === undefined || cur < i.keepUntilMs) ev.expireAt.set(key, i.keepUntilMs);
    };
    if (k > 0) {
      ev.fence = tok;
      for (const s of empty) {
        const hk = seatKeys.hold(e, s.index);
        ev.bits.add(s.index);
        // DEL 뒤 HSET: 있던 칸과 수명을 지우고 새로 쓴 뒤 keepUntil을 건다
        ev.expireAt.delete(hk);
        ev.holds.set(s.index, { holdId: i.holdId, owner: i.accountId, psid: i.purchaseSessionId, fence: tok, heldAt: now, exp, kind: 'FAN', ext: '0', pin: '1' });
        ev.expireAt.set(hk, i.keepUntilMs);
      }
    }
    // 내 홀드는 pin 칸만 더한다(exp·토큰은 그대로)
    for (const h of mine) h.pin = '1';
    // 모든 좌석을 만료 인덱스에서 뺀다(Valkey는 빈 정렬 집합을 지운다. 그 키의 수명도 함께 사라진다)
    for (const s of i.seats) ev.expiry.delete(s.index);
    if (ev.expiry.size === 0) ev.expireAt.delete(seatKeys.expiry(e));
    if (k === 0) return { kind: 'OK', gen, regrabbed: 0 };

    ev.quota.set(i.accountId, held + k);
    // 바뀐 구역마다 일련번호 +1(빈 좌석 차례로 처음 나온 차례)
    const version = new Map<number, number>();
    const deltas = new Map<number, string[]>();
    for (const s of empty) {
      if (!version.has(s.sectionIndex)) {
        const v = Number(ev.secver.get(s.sectionIndex) ?? 0) + 1;
        ev.secver.set(s.sectionIndex, v);
        version.set(s.sectionIndex, v);
        deltas.set(s.sectionIndex, []);
      }
      deltas.get(s.sectionIndex)!.push(`${s.seatOffset}:${SEAT_STATE_HELD}`);
    }
    const seatEpoch = String(cur.epoch);
    for (const s of empty) {
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
    // expiry는 빼기만 하므로 늘리지 않는다(Lua와 같다)
    for (const key of [seatKeys.bitmap(e), quotaKey, seatKeys.stream(e), seatKeys.epoch(e), seatKeys.secver(e), seatKeys.fence(e)]) extend(key);
    return { kind: 'OK', gen, regrabbed: k, fencingToken: token };
  }

  /**
   * 결제 실패 해제(BUILD_ORDER PRF-142): 실패 해제 Lua(pin-lua.ts RELEASE_FAILED_LUA)와 같은 차례(세대 키 → 시각 한 번 → keepUntil 지킴 →
   * 그 주문의 홀드(비트 1, holdId·owner 같음) 고르기 → 보유 수·secver 지킴 → 쓰기). 보유 수가 0 이하가 되면 quota에서 지우고 expireAt의 그 키도 지운다
   */
  async releaseFailed(i: ReleaseFailedInput, _o?: SeatCallOptions): Promise<ReleaseFailedResult> {
    assertReleaseFailedInput(i);
    const e = i.eventId;
    const ev = this.db.event(e);
    const now = this.clock.now();
    const sec = Math.floor(now / 1000);
    // 세대 키(읽기만. 망가진 세대 칸은 오류). 세대 확인은 쓰기 전 지킴을 모두 지난 뒤의 첫 쓰기다(ADR-0210, 리뷰 고침 결함 1)
    const ep = this.#readEpoch(e, ev);
    if (!ep) return { kind: 'NOT_READY' };
    if (!(i.keepUntilMs > now)) throw new Error(`PEAKET_KEEP_UNTIL_PAST keepUntil ${i.keepUntilMs} now ${now}`);

    const freed: { seat: SeatRef; hash: MemoryHoldHash }[] = [];
    for (const s of i.seats) {
      const h = ev.holds.get(s.index);
      if (ev.bits.has(s.index) && h && h.holdId === i.holdId && h.owner === i.accountId) freed.push({ seat: s, hash: h });
    }
    const k = freed.length;
    // 실패 표시(PRF-165): 푼 좌석이 0이어도 남긴다(Lua와 같다. 지킴을 지난 뒤에만)
    const markFailed = () => {
      ev.failed.set(i.holdId, now + FAILED_HOLD_MARK_TTL_MS);
      ev.expireAt.set(seatKeys.failed(e, i.holdId), now + FAILED_HOLD_MARK_TTL_MS);
    };
    if (k === 0) {
      this.#ensureEpoch(ep, sec);
      markFailed();
      return { kind: 'OK', released: 0 };
    }
    const quotaKey = seatKeys.quota(e, i.accountId);
    const quota = ev.quota.get(i.accountId);
    if (quota !== undefined && !isStandardInt(String(quota))) throw new Error(`PEAKET_CORRUPT_KEY ${quotaKey}`);
    for (const { seat } of freed) {
      const v = ev.secver.get(seat.sectionIndex);
      if (v !== undefined && !isStandardInt(String(v))) throw new Error(`PEAKET_CORRUPT_KEY ${seatKeys.secver(e)}`);
    }

    // 첫 쓰기: 세대 확인(아래 RELEASED·델타는 이 세대를 싣는다), 그다음 쓰기
    const cur = this.#ensureEpoch(ep, sec);
    markFailed();
    for (const { seat } of freed) {
      ev.bits.delete(seat.index);
      ev.holds.delete(seat.index);
      ev.expireAt.delete(seatKeys.hold(e, seat.index));
      ev.expiry.delete(seat.index);
    }
    if (ev.expiry.size === 0) ev.expireAt.delete(seatKeys.expiry(e));
    const left = (quota === undefined ? 0 : Number(quota)) - k;
    if (left <= 0) {
      ev.quota.delete(i.accountId);
      ev.expireAt.delete(quotaKey);
    } else {
      ev.quota.set(i.accountId, left);
    }
    const version = new Map<number, number>();
    const deltas = new Map<number, string[]>();
    for (const { seat } of freed) {
      if (!version.has(seat.sectionIndex)) {
        const v = Number(ev.secver.get(seat.sectionIndex) ?? 0) + 1;
        ev.secver.set(seat.sectionIndex, v);
        version.set(seat.sectionIndex, v);
        deltas.set(seat.sectionIndex, []);
      }
      deltas.get(seat.sectionIndex)!.push(`${seat.seatOffset}:${SEAT_STATE_AVAILABLE}`);
    }
    const seatEpoch = String(cur.epoch);
    for (const { seat, hash: h } of freed) {
      ev.stream.push({
        type: 'RELEASED',
        seatIdx: String(seat.index),
        seatId: seat.seatId,
        tierId: seat.tierId,
        sectionId: seat.sectionId,
        holdId: h.holdId,
        holdKind: h.kind ?? '',
        purchaseSessionId: h.psid ?? '',
        accountId: h.owner,
        fencingToken: h.fence ?? '',
        sectionVersion: String(version.get(seat.sectionIndex)),
        seatEpoch,
        occurredAtMs: String(now),
        expiresAtMs: h.exp === undefined ? '' : String(h.exp),
      });
    }
    for (const [sec, list] of deltas) {
      ev.published.push({ channel: seatKeys.section(e, String(sec)), message: `1 ${seatEpoch} ${sec} ${version.get(sec)} ${now} ${list.join(' ')}` });
    }
    for (const key of [seatKeys.stream(e), seatKeys.secver(e)]) {
      const cur = ev.expireAt.get(key);
      if (cur === undefined || cur < i.keepUntilMs) ev.expireAt.set(key, i.keepUntilMs);
    }
    return { kind: 'OK', released: k };
  }

  /**
   * 회차 목록에서 빼기(BUILD_ORDER PRF-142): RedisSeatStore.retireEvent와 같은 차례(주입 Clock → Stream 길이 → 목록에서 빼기).
   * 메모리에는 소비자 그룹이 없어 확인받지 못한 항목은 늘 0이다(Stream 항목이 남았는지만 본다)
   */
  async retireEvent(i: { eventId: string; saleEndMs: number }): Promise<RetireResult> {
    assertRetireInput(i);
    if (this.clock.now() < i.saleEndMs + RETIRE_AFTER_SALE_END_MS) return 'TOO_EARLY';
    const ev = this.db.peek(i.eventId);
    if ((ev?.stream.length ?? 0) > 0) return 'STREAM_PENDING';
    if ((ev?.expiry.size ?? 0) > 0) return 'EXPIRY_PENDING';
    return this.db.ctlEvents.delete(i.eventId) ? 'RETIRED' : 'NOT_LISTED';
  }

  /** 다시 만들기(BUILD_ORDER PRF-143): 세대 키가 있나(회차 키 묶음을 만들지 않는다) */
  async isReady(eventId: string): Promise<boolean> {
    if (!KEY_PART.test(eventId)) throw new RangeError('회차 ID가 키 조각 모양이 아니다');
    return this.db.peek(eventId)?.epoch !== undefined;
  }

  /** 세대 키가 있으면 READY(gen 칸, 없으면 1), rebuild 판 번호 ≠ gen이면 STALE, 둘 다 아니면 undefined(rebuild-lua.ts fenced와 같다) */
  #fenced(ev: MemorySeatEvent, gen: number): RebuildStep | undefined {
    if (ev.epoch) return { result: 'READY', gen: ev.epoch.gen ?? INITIAL_SEAT_GEN };
    if (ev.rebuildGen !== gen) return { result: 'STALE' };
    return undefined;
  }

  /**
   * 다시 만들기 시작(BEGIN_REBUILD_LUA의 쌍둥이): 입력 검사 → 세대 키가 있으면 READY(gen) → 저장된 판 번호 > gen이면 STALE → 시각 한 번·keepUntil 지킴 →
   * 비트맵(비트·seatCount)·만료 인덱스와 그 수명을 지우고 rebuildGen = gen(수명 keepUntil) → OK
   */
  async begin(eventId: string, gen: number, keepUntilMs: number): Promise<RebuildStep> {
    assertRebuildBegin(eventId, gen, keepUntilMs);
    const e = eventId;
    const ev = this.db.event(e);
    if (ev.epoch) return { result: 'READY', gen: ev.epoch.gen ?? INITIAL_SEAT_GEN };
    if (ev.rebuildGen !== undefined && ev.rebuildGen > gen) return { result: 'STALE' };
    const now = this.clock.now();
    if (!(keepUntilMs > now)) throw new Error(`PEAKET_KEEP_UNTIL_PAST keepUntil ${keepUntilMs} now ${now}`);
    ev.bits.clear();
    ev.seatCount = undefined;
    ev.expiry.clear();
    ev.expireAt.delete(seatKeys.bitmap(e));
    ev.expireAt.delete(seatKeys.expiry(e));
    ev.rebuildGen = gen;
    ev.expireAt.set(seatKeys.rebuild(e), keepUntilMs);
    return { result: 'OK' };
  }

  /**
   * 다시 만들기 좌석 쓰기(계약은 adapters/rebuild-lua.ts REBUILD_SEATS_LUA): 입력 검사 → 세대 키가 있으면 READY → rebuild 판 번호 ≠ gen이면 STALE → 시각 한 번·keepUntil 지킴 → 쓰기.
   * 판매(SOLD)는 묶음 Hash(원장 행의 fence·heldAt·exp, 없으면 fence = 저장소 시각 µs(now × 1000)·heldAt = exp = now, kind FAN·ext '0'·pin '1')이고 만료 인덱스에서 빠지며,
   * 되살린 홀드(HELD)는 원장 값 그대로(ext '0', pin 없음)와 만료 인덱스.
   * 홀드 Hash 수명은 keepUntil(DEL 뒤 새로 걸기), 비트맵·만료 인덱스는 더 늦은 쪽(만료 인덱스가 비면 Valkey처럼 키와 수명이 사라진다)
   */
  async writeSeats(eventId: string, seats: readonly RebuildSeat[], keepUntilMs: number, gen: number): Promise<RebuildStep> {
    assertRebuildSeats(eventId, seats, keepUntilMs, gen);
    const e = eventId;
    const ev = this.db.event(e);
    const stop = this.#fenced(ev, gen);
    if (stop) return stop;
    const now = this.clock.now();
    if (!(keepUntilMs > now)) throw new Error(`PEAKET_KEEP_UNTIL_PAST keepUntil ${keepUntilMs} now ${now}`);
    for (const s of seats) {
      const i = s.seat.index;
      ev.bits.add(i);
      ev.holds.set(
        i,
        s.mode === 'SOLD'
          ? s.fencingToken !== undefined
            ? { holdId: s.holdId, owner: s.accountId, psid: s.purchaseSessionId, fence: String(s.fencingToken), heldAt: s.heldAtMs!, exp: s.expiresAtMs!, kind: 'FAN', ext: '0', pin: '1' }
            : { holdId: s.holdId, owner: s.accountId, psid: s.purchaseSessionId, fence: String(now * 1000), heldAt: now, exp: now, kind: 'FAN', ext: '0', pin: '1' }
          : { holdId: s.holdId, owner: s.accountId, psid: s.purchaseSessionId, fence: String(s.fencingToken), heldAt: s.heldAtMs, exp: s.expiresAtMs, kind: s.kind, ext: '0' },
      );
      ev.expireAt.set(seatKeys.hold(e, i), keepUntilMs);
      if (s.mode === 'HELD') ev.expiry.set(i, s.expiresAtMs);
      else ev.expiry.delete(i);
    }
    const extend = (key: string) => {
      const cur = ev.expireAt.get(key);
      if (cur === undefined || cur < keepUntilMs) ev.expireAt.set(key, keepUntilMs);
    };
    extend(seatKeys.bitmap(e));
    if (ev.expiry.size > 0) extend(seatKeys.expiry(e));
    else ev.expireAt.delete(seatKeys.expiry(e));
    return { result: 'OK' };
  }

  /**
   * 다시 만들기 끝(RedisSeatStore.finish의 차례: 회차 목록 → REBUILD_QUOTAS_LUA들 → FINISH_REBUILD_LUA. 메모리는 한 번에 한다): 입력 검사 → 회차 목록에 넣기(결과와 관계없이) →
   * 세대 키가 있으면 READY(gen) → rebuild 판 번호 ≠ gen이면 STALE → 시각 한 번·keepUntil 지킴 → 계정마다 보유 수를 그 값으로(수명 keepUntil) →
   * 펜싱 카운터 = max(fence, maxToken)(바뀌면 수명은 더 늦은 쪽 keepUntil) → 세대 키(epoch = floor(now / 1000), node = 이 저장소의 표지, gen, 수명 keepUntil)
   */
  async finish(eventId: string, input: RebuildFinishInput): Promise<RebuildStep> {
    assertRebuildFinish(eventId, input);
    const e = eventId;
    const ev = this.db.event(e);
    this.db.ctlEvents.add(e);
    const stop = this.#fenced(ev, input.gen);
    if (stop) return stop;
    const now = this.clock.now();
    if (!(input.keepUntilMs > now)) throw new Error(`PEAKET_KEEP_UNTIL_PAST keepUntil ${input.keepUntilMs} now ${now}`);
    if (ev.fence !== undefined && !/^[0-9]+$/.test(ev.fence)) throw new Error(`PEAKET_CORRUPT_KEY ${seatKeys.fence(e)}`);
    for (const [a, n] of input.quotas) {
      ev.quota.set(a, n);
      ev.expireAt.set(seatKeys.quota(e, a), input.keepUntilMs);
    }
    const maxToken = input.maxToken ?? 0;
    if (maxToken > 0 && (ev.fence === undefined || Number(ev.fence) < maxToken)) ev.fence = String(maxToken);
    if (ev.fence !== undefined) {
      const cur = ev.expireAt.get(seatKeys.fence(e));
      if (cur === undefined || cur < input.keepUntilMs) ev.expireAt.set(seatKeys.fence(e), input.keepUntilMs);
    }
    // node는 끝내기 Lua의 nodeId()처럼 이 저장소의 표지다(판매 열기와 같은 뜻, 파드 이름이 아니다. PRF-168). chk = 표지를 견준 초(ADR-0210)
    ev.epoch = { epoch: Math.floor(now / 1000), node: this.#nodeId, gen: input.gen, chk: Math.floor(now / 1000) };
    ev.expireAt.set(seatKeys.epoch(e), input.keepUntilMs);
    return { result: 'OK' };
  }

  /**
   * 장애 조치 뒤 세대 올리기(BUMP_EPOCH_LUA, BUILD_ORDER PRF-168, ADR-0210): 쓰는 Lua와 같은 세대 키 읽기(#readEpoch, 망가진 세대 칸을 먼저 거른다)와 세대 확인(#ensureEpoch)이다.
   * 세대 키가 없으면 NOT_READY, 올렸으면 BUMPED(epoch = max(epoch + 1, 지금 초), node = 이 저장소의 표지, chk = 지금 초, bumps + 1), 아니면 SAME(gen·수명 그대로).
   * 둘 다 bumps(올린 누적 수, 없으면 0)를 싣는다
   */
  async bumpEpoch(eventId: string): Promise<{ result: 'BUMPED' | 'SAME'; epoch: number; bumps: number } | { result: 'NOT_READY' }> {
    if (!KEY_PART.test(eventId)) throw new RangeError('회차 ID가 키 조각 모양이 아니다');
    const ev = this.db.peek(eventId);
    const ep = ev && this.#readEpoch(eventId, ev);
    if (!ep) return { result: 'NOT_READY' };
    const cur = this.#ensureEpoch(ep, Math.floor(this.clock.now() / 1000));
    return { result: cur.bumped ? 'BUMPED' : 'SAME', epoch: cur.epoch, bumps: cur.bumps };
  }

  async openSale(i: { eventId: string; seatCount: number; keepUntilMs: number }): Promise<{ created: boolean; seatEpoch: number }> {
    if (!Number.isSafeInteger(i.seatCount) || i.seatCount < 1) throw new RangeError(`좌석 수는 1 이상의 정수다: ${i.seatCount}`);
    const ev = this.db.event(i.eventId);
    this.db.ctlEvents.add(i.eventId);
    if (ev.epoch) return { created: false, seatEpoch: ev.epoch.epoch };
    // 비트맵은 모자랄 때만 늘린다(있는 비트는 그대로). 세대 키는 마지막에
    ev.seatCount = Math.max(ev.seatCount ?? 0, i.seatCount);
    // chk = 표지를 견준 초(판매 열기 Lua와 같다, ADR-0210)
    const sec = Math.floor(this.clock.now() / 1000);
    ev.epoch = { epoch: sec, node: this.#nodeId, gen: INITIAL_SEAT_GEN, chk: sec };
    for (const key of [seatKeys.bitmap(i.eventId), seatKeys.epoch(i.eventId)]) {
      const cur = ev.expireAt.get(key);
      if (cur === undefined || cur < i.keepUntilMs) ev.expireAt.set(key, i.keepUntilMs);
    }
    return { created: true, seatEpoch: ev.epoch.epoch };
  }

  /** SeatExpiries.saleEvents: db.ctlEvents의 사본(넣은 차례). KEY_PART 모양이 아닌 값은 거르고 거른 수를 로그에 남긴다(L8, 경고는 파드마다 60초에 한 줄까지, C3) */
  async saleEvents(): Promise<string[]> {
    return keepEventIds([...this.db.ctlEvents], this.#filterWarnGate, this.logger);
  }

  /**
   * SeatExpiries.dueExpiries: expiry에서 exp ≤ nowMs인 것을 (exp, 색인 10진 글의 바이트 순) 오름차순으로 limit개, holds에서 holdId·fence·owner.
   * 세 칸 가운데 일부만 있거나 owner가 KEY_PART가 아니거나 fence가 만료 Lua가 받지 못하는 모양(isExpirableFence, A2)이면 그 좌석만 corrupt: true(M2).
   * 메모리는 키 형이 정해져 있어 홀드 키의 형 오류(B1)는 없다
   */
  async dueExpiries(i: DueExpiriesInput): Promise<DueExpiry[]> {
    assertDueExpiriesInput(i);
    const e = i.eventId;
    const ev = this.db.event(e);
    const due = [...ev.expiry]
      .filter(([, score]) => score <= i.nowMs)
      .map(([index, score]) => ({ index, score, member: String(index) }))
      .sort((a, b) => a.score - b.score || (a.member < b.member ? -1 : a.member > b.member ? 1 : 0))
      .slice(0, i.limit);
    for (const d of due) if (!Number.isSafeInteger(d.index) || d.index < 0) throw new Error(`PEAKET_CORRUPT_KEY ${seatKeys.expiry(e)}`);
    return due.map(({ index, score }): DueExpiry => {
      const h = ev.holds.get(index) as Partial<Record<'holdId' | 'fence' | 'owner', unknown>> | undefined;
      const fields = [h?.holdId, h?.fence, h?.owner];
      if (fields.every((v) => v === undefined)) return { index, expiresAtMs: score, hold: null };
      const [holdId, fence, owner] = fields;
      if (typeof holdId !== 'string' || typeof fence !== 'string' || typeof owner !== 'string' || !KEY_PART.test(owner) || !isExpirableFence(fence)) return { index, expiresAtMs: score, hold: null, corrupt: true };
      return { index, expiresAtMs: score, hold: { holdId, fencingToken: fence, owner } };
    });
  }

  /**
   * SeatExpiries.expire: 만료 Lua와 같은 차례(세대 키 → 시각 한 번 → 쓰기 전 지킴(입력 전체: 묶음 전체 오류, 그다음 좌석·계정·구역 몫의 망가짐) →
   * 망가지지 않은 좌석마다 펜싱 확인 → 쓰기 → 결과), 시각은 주입 Clock. 메모리는 키 형이 정해져 있어 형 검사(묶음 전체 오류의 형·좌석 몫의 형)는 없다
   */
  async expire(i: ExpireInput): Promise<ExpireResult> {
    assertExpireInput(i);
    const e = i.eventId;
    const ev = this.db.event(e);

    // 2 시각 한 번, 1 세대 키(읽기만. 망가진 세대 칸은 오류)
    const now = this.clock.now();
    const ep = this.#readEpoch(e, ev);
    if (!ep) return { kind: 'NOT_READY' };

    // 3a 묶음 전체 오류(지난 keepUntil)
    if (!(i.keepUntilMs > now)) throw new Error(`PEAKET_KEEP_UNTIL_PAST keepUntil ${i.keepUntilMs} now ${now}`);
    // 첫 쓰기: 세대 확인(장애 조치 뒤면 그 자리에서 올린다, ADR-0210. 3b·4는 오류로 끝나지 않는다)
    const cur = this.#ensureEpoch(ep, Math.floor(now / 1000));
    // 3b 계정·구역 몫의 망가짐
    const badAccount = new Set<string>();
    for (const s of i.seats) {
      const a = s.expected?.owner;
      if (a === undefined || badAccount.has(a)) continue;
      const q = ev.quota.get(a);
      if (q !== undefined && !isStandardInt(String(q))) badAccount.add(a);
    }
    const badSection = new Set<number>();
    for (const s of i.seats) {
      if (!s.seat) continue;
      const v = ev.secver.get(s.seat.sectionIndex);
      if (v !== undefined && !isStandardInt(String(v))) badSection.add(s.seat.sectionIndex);
    }

    // 3b 좌석 몫과 4 펜싱 확인(아직 쓰지 않는다): r 푼다, o 고아, s 건너뜀, c 망가짐
    const kinds = i.seats.map((s): 'r' | 'o' | 's' | 'c' => {
      const h = ev.holds.get(s.index) as Partial<MemoryHoldHash> | undefined;
      const inIndex = ev.expiry.has(s.index);
      if (!h) return inIndex ? 'o' : 's';
      if ((s.expected && badAccount.has(s.expected.owner)) || (s.seat && badSection.has(s.seat.sectionIndex))) return 'c';
      if (h.holdId === undefined || h.owner === undefined || h.fence === undefined || h.exp === undefined || !DIGITS.test(String(h.exp)) || !isExpirableFence(String(h.fence))) return 'c';
      const x = s.expected;
      if (!inIndex || !x || h.holdId !== x.holdId || h.fence !== x.fencingToken || h.owner !== x.owner) return 's';
      return h.exp <= now ? 'r' : 's';
    });
    const count = (k: 'r' | 'o' | 's' | 'c') => kinds.filter((x) => x === k).length;
    const released = count('r');
    const result: ExpireResult = { kind: 'OK', nowUs: now * 1000, released, skipped: count('s'), orphans: count('o'), corrupt: count('c'), expired: [] };

    // 5 쓰기
    const expiryKey = seatKeys.expiry(e);
    i.seats.forEach((s, k) => {
      if (kinds[k] === 'o') ev.expiry.delete(s.index);
    });
    if (released > 0) {
      const freed = new Map<string, number[]>();
      const hashes = new Map<number, MemoryHoldHash>();
      i.seats.forEach((s, k) => {
        if (kinds[k] !== 'r') return;
        const h = ev.holds.get(s.index)!;
        hashes.set(s.index, h);
        ev.bits.delete(s.index);
        ev.holds.delete(s.index);
        ev.expireAt.delete(seatKeys.hold(e, s.index));
        ev.expiry.delete(s.index);
        freed.set(h.owner, [...(freed.get(h.owner) ?? []), s.index]);
      });
      for (const [a, indexes] of freed) {
        const left = (ev.quota.get(a) ?? 0) - indexes.length;
        if (left <= 0) {
          ev.quota.delete(a);
          ev.expireAt.delete(seatKeys.quota(e, a));
        } else {
          ev.quota.set(a, left);
        }
        const rel = ev.rel.get(a) ?? new Map<number, number>();
        for (const [index, at] of rel) if (at <= now) rel.delete(index);
        for (const index of indexes) rel.set(index, now + REHOLD_WAIT_MS);
        ev.rel.set(a, rel);
        ev.expireAt.set(seatKeys.rel(e, a), now + REHOLD_WAIT_MS);
      }
      // 바뀐 구역마다 일련번호 +1(푼 좌석 차례로 처음 나온 차례). 좌석맵 판에 없는 색인(seat 없음)은 구역이 없다
      const version = new Map<number, number>();
      const deltas = new Map<number, string[]>();
      i.seats.forEach((s, k) => {
        if (kinds[k] !== 'r' || !s.seat) return;
        const sec = s.seat.sectionIndex;
        if (!version.has(sec)) {
          const v = Number(ev.secver.get(sec) ?? 0) + 1;
          ev.secver.set(sec, v);
          version.set(sec, v);
          deltas.set(sec, []);
        }
        deltas.get(sec)!.push(`${s.seat.seatOffset}:${SEAT_STATE_AVAILABLE}`);
      });
      const seatEpoch = String(cur.epoch);
      i.seats.forEach((s, k) => {
        if (kinds[k] !== 'r') return;
        const h = hashes.get(s.index)!;
        ev.stream.push({
          type: 'EXPIRED',
          seatIdx: String(s.index),
          seatId: s.seat?.seatId ?? '',
          tierId: s.seat?.tierId ?? '',
          sectionId: s.seat?.sectionId ?? '',
          holdId: h.holdId,
          holdKind: h.kind ?? '',
          purchaseSessionId: h.psid ?? '',
          accountId: h.owner,
          fencingToken: h.fence,
          sectionVersion: s.seat ? String(version.get(s.seat.sectionIndex)) : '',
          seatEpoch,
          occurredAtMs: String(now),
          expiresAtMs: String(h.exp),
        });
        result.expired.push({ index: s.index, fencingToken: Number(h.fence) });
      });
      for (const [sec, list] of deltas) {
        ev.published.push({ channel: seatKeys.section(e, String(sec)), message: `1 ${seatEpoch} ${sec} ${version.get(sec)} ${now} ${list.join(' ')}` });
      }
      for (const key of [seatKeys.stream(e), seatKeys.secver(e)]) {
        const cur = ev.expireAt.get(key);
        if (cur === undefined || cur < i.keepUntilMs) ev.expireAt.set(key, i.keepUntilMs);
      }
    }
    // Valkey는 빈 정렬 집합을 지운다(그 키의 수명도 함께 사라진다)
    if (ev.expiry.size === 0) ev.expireAt.delete(expiryKey);
    return result;
  }
}

/** ctl에서 '1'이면 정지인 칸(회차 범위 판매 일시정지·전체 범위·판매 중지) */
const STOP_FIELDS = ['paused', 'allPaused', 'suspended'] as const;

/** fence·exp 값의 모양(Lua의 ^%d+$). 보유 수·secver 칸은 표준 10진 정수(isStandardInt), 만료가 보는 fence는 isExpirableFence다 */
const DIGITS = /^\d+$/;
