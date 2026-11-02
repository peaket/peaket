// 대기열 저장 포트의 Redis 어댑터(docs/features/queue-admission.md §13 키 표). 판정마다 Lua 하나로 원자적으로 한다.
// Redis 클라이언트는 아직 고르지 않았다(OPEN[11]). 명령 보내기 포트(RedisCommander) 하나만 받는다.
// 판정 Lua마다 호출 쪽 마감을 건다(docs/architecture.md §5 시간 초과 표 Redis 행: 클라이언트의 명령 시간 초과는
// 소켓에 쓰기 전까지만 들어 응답 없이 사라진 노드를 끊지 못한다). 마감을 넘긴 명령은 결과를 모르므로 다시 보내지 않는다.
import { createHash } from 'node:crypto';
import { type RedisCommander, requestLog } from '@peaket/platform';
import type { QueueStore } from '../../domain/queue-store.js';
import {
  ADMIT_PER_SECOND_MAX,
  ADMIT_PER_SECOND_MIN,
  EVENT_ID_PATTERN,
  type AdmitResult,
  type EnterResult,
  type PersonPlace,
  type QueueConfig,
  type QueueSnapshot,
  type ServingLogEntry,
  type TickResult,
} from '../../domain/queue.js';
import { ADMIT_LUA, CANCEL_LUA, ENTER_LUA, OPEN_LUA, READ_LUA, TICK_LUA } from './scripts.js';

/** 연 회차 목록(입장 루프가 돈다). 회차 해시 태그 밖의 키라 Lua에서 함께 쓰지 않는다 */
const EVENTS_KEY = 'q0:events';
/** 차례 진행 속도를 내는 최근 칸 수 [가정] */
const RATE_WINDOW_TICKS = 10;
/** serving_log 최대 길이(대략 자르기). 1초 한 줄이라 하루치 */
const SERVING_LOG_MAX = 86_400;

export interface RedisQueueStoreOptions {
  /** 요청 경로(진입·조회·취소·입장 확정) Lua의 호출 쪽 마감(밀리초). 핫패스 100ms(시간 초과 표) */
  requestTimeoutMs?: number;
  /** 입장 루프 Lua의 마감. 한 칸에 많게는 admitPerSecond명을 옮기므로 길게 둔다 [가정] */
  tickTimeoutMs?: number;
}

export class RedisDeadlineError extends Error {
  constructor(ms: number) {
    super(`대기열 Redis가 ${ms}ms 안에 답하지 않았다`);
    this.name = 'RedisDeadlineError';
  }
}

interface Script {
  src: string;
  sha: string;
}
const script = (src: string): Script => ({ src, sha: createHash('sha1').update(src).digest('hex') });
const OPEN = script(OPEN_LUA);
const ENTER = script(ENTER_LUA);
const READ = script(READ_LUA);
const CANCEL = script(CANCEL_LUA);
const ADMIT = script(ADMIT_LUA);
const TICK = script(TICK_LUA);

function keys(eventId: string) {
  if (!EVENT_ID_PATTERN.test(eventId)) throw new Error('회차 ID 형식이 아니다');
  const k = (name: string) => `q0:{event:${eventId}}:${name}`;
  return {
    meta: k('meta'),
    seq: k('seq'),
    waiting: k('waiting'),
    called: k('called'),
    admitted: k('admitted'),
    serving: k('serving'),
    rate: k('rate'),
    lastTick: k('last_tick'),
    servingLog: k('serving_log'),
  };
}

/** 정수 응답(수, 또는 숫자만 있는 문자열. 빈 문자열을 0으로 받지 않는다) */
const int = (v: unknown): number => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^-?\d+$/.test(v) ? Number(v) : Number.NaN;
  if (!Number.isSafeInteger(n)) throw new Error('Redis 응답이 정수가 아니다');
  return n;
};
const num = (v: unknown): number => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^-?\d+(?:\.\d+)?$/.test(v) ? Number(v) : Number.NaN;
  if (!Number.isFinite(n)) throw new Error('Redis 응답이 수가 아니다');
  return n;
};
/** 'seq:at' 값 */
const pair = (v: unknown): [number, number] => {
  const m = /^(\d+):(\d+)$/.exec(String(v));
  if (!m) throw new Error('대기열 값 형식이 아니다');
  return [int(m[1]), int(m[2])];
};
const strings = (v: unknown): string[] => {
  if (!Array.isArray(v)) throw new Error('Redis 응답이 배열이 아니다');
  return v.map((x) => (x === null || x === undefined ? '' : String(x)));
};

export class RedisQueueStore implements QueueStore {
  private readonly requestTimeoutMs: number;
  private readonly tickTimeoutMs: number;

  constructor(
    private readonly redis: RedisCommander,
    o: RedisQueueStoreOptions = {},
  ) {
    this.requestTimeoutMs = o.requestTimeoutMs ?? 100;
    this.tickTimeoutMs = o.tickTimeoutMs ?? 1_000;
  }

  /** Lua 하나를 마감 안에 부른다 */
  private run(s: Script, keyList: string[], args: string[], deadlineMs = this.requestTimeoutMs): Promise<unknown> {
    return this.call((expired) => this.evalScript(s, keyList, args, expired), deadlineMs);
  }

  /** Lua 밖의 명령 하나를 마감 안에 부른다 */
  private command(args: string[], deadlineMs = this.requestTimeoutMs): Promise<unknown> {
    return this.call(() => this.redis.sendCommand(args), deadlineMs);
  }

  /** 마감 안에 끝나지 않으면 RedisDeadlineError. 걸린 시간을 정규 로그 줄 dep에 더한다 */
  private async call(fn: (expired: () => boolean) => Promise<unknown>, deadlineMs: number): Promise<unknown> {
    const started = performance.now();
    let timer: NodeJS.Timeout | undefined;
    let isExpired = false;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        isExpired = true;
        reject(new RedisDeadlineError(deadlineMs));
      }, deadlineMs);
    });
    try {
      return await Promise.race([fn(() => isExpired), deadline]);
    } finally {
      clearTimeout(timer);
      requestLog().dependency('redis', performance.now() - started);
    }
  }

  /** EVALSHA, 스크립트가 캐시에 없으면 EVAL. 마감이 지난 뒤에는 EVAL을 새로 보내지 않는다(부른 쪽은 이미 실패를 받았다) */
  private async evalScript(s: Script, keyList: string[], args: string[], expired: () => boolean): Promise<unknown> {
    try {
      return await this.redis.sendCommand(['EVALSHA', s.sha, String(keyList.length), ...keyList, ...args]);
    } catch (err) {
      if (!String((err as Error)?.message ?? '').startsWith('NOSCRIPT')) throw err;
      if (expired()) throw err;
      return await this.redis.sendCommand(['EVAL', s.src, String(keyList.length), ...keyList, ...args]);
    }
  }

  async open(eventId: string, config: QueueConfig): Promise<void> {
    const k = keys(eventId);
    const { admitPerSecond, saleEndsAtMs } = config;
    if (!(Number.isInteger(admitPerSecond) && admitPerSecond >= ADMIT_PER_SECOND_MIN && admitPerSecond <= ADMIT_PER_SECOND_MAX)) {
      throw new Error(`admitPerSecond는 ${ADMIT_PER_SECOND_MIN}~${ADMIT_PER_SECOND_MAX} 정수다`);
    }
    if (saleEndsAtMs !== undefined && !(Number.isSafeInteger(saleEndsAtMs) && saleEndsAtMs >= 0)) {
      throw new Error('saleEndsAtMs는 0 이상 정수(유닉스 밀리초)다');
    }
    // 목록에 먼저 넣는다. 설정 쓰기가 실패해도 설정 없는 회차는 루프가 건너뛰고 진입은 404라 해가 없다(다시 열면 된다).
    // 설정(같은 슬롯)은 Lua 하나로 한 번에 쓴다
    await this.command(['SADD', EVENTS_KEY, eventId]);
    await this.run(OPEN, [k.meta], [String(admitPerSecond), saleEndsAtMs === undefined ? '' : String(saleEndsAtMs)]);
  }

  async openEventIds(): Promise<string[]> {
    return strings(await this.command(['SMEMBERS', EVENTS_KEY], this.tickTimeoutMs)).filter((id) => EVENT_ID_PATTERN.test(id)).sort();
  }

  async enter(eventId: string, pid: string, nowMs: number, graceMs: number): Promise<EnterResult> {
    const k = keys(eventId);
    const r = strings(await this.run(ENTER, [k.meta, k.seq, k.waiting, k.called, k.admitted], [pid, String(nowMs), String(graceMs)]));
    switch (r[0]) {
      case 'entered':
        return { kind: 'entered', seq: int(r[1]) };
      case 'already-in-queue':
      case 'already-admitted':
      case 'sale-ended':
      case 'queue-not-found':
        return { kind: r[0] };
      default:
        throw new Error('진입 Lua 응답을 모른다');
    }
  }

  async read(eventId: string, pid: string): Promise<{ queue: QueueSnapshot; place: PersonPlace } | null> {
    const k = keys(eventId);
    const r = strings(await this.run(READ, [k.meta, k.waiting, k.called, k.admitted, k.serving, k.rate], [pid]));
    if (r[0] === 'queue-not-found') return null;
    const queue: QueueSnapshot = { serving: int(r[1]), servingRate: num(r[2]) };
    if (r[3]) queue.saleEndsAtMs = int(r[3]);
    switch (r[0]) {
      case 'waiting':
        return { queue, place: { kind: 'waiting', seq: int(r[4]), ahead: int(r[5]) } };
      case 'called': {
        const [seq, calledAtMs] = pair(r[4]);
        return { queue, place: { kind: 'called', seq, calledAtMs } };
      }
      case 'admitted': {
        const [seq, admittedAtMs] = pair(r[4]);
        return { queue, place: { kind: 'admitted', seq, admittedAtMs } };
      }
      case 'none':
        return { queue, place: { kind: 'none' } };
      default:
        throw new Error('조회 Lua 응답을 모른다');
    }
  }

  async cancel(eventId: string, pid: string): Promise<void> {
    const k = keys(eventId);
    await this.run(CANCEL, [k.waiting, k.called], [pid]);
  }

  async admit(eventId: string, pid: string, nowMs: number, graceMs: number): Promise<AdmitResult> {
    const k = keys(eventId);
    const r = strings(await this.run(ADMIT, [k.meta, k.waiting, k.called, k.admitted], [pid, String(nowMs), String(graceMs)]));
    switch (r[0]) {
      case 'admitted':
        return { kind: 'admitted', seq: pair(r[1])[0] };
      case 'expired':
        return { kind: 'expired', seq: pair(r[1])[0] };
      case 'not-yet':
        return { kind: 'not-yet', seq: int(r[1]) };
      case 'sale-ended':
      case 'not-in-queue':
      case 'queue-not-found':
        return { kind: r[0] };
      default:
        throw new Error('입장 확정 Lua 응답을 모른다');
    }
  }

  async tick(eventId: string, nowMs: number): Promise<TickResult> {
    const k = keys(eventId);
    const r = await this.run(
      TICK,
      [k.meta, k.waiting, k.called, k.serving, k.rate, k.lastTick, k.servingLog],
      [String(nowMs), String(RATE_WINDOW_TICKS), String(SERVING_LOG_MAX)],
      this.tickTimeoutMs,
    );
    if (!Array.isArray(r) || r.length !== 3) throw new Error('입장 루프 Lua 응답을 모른다');
    return { eventId, ticked: int(r[0]) === 1, called: int(r[1]), serving: int(r[2]) };
  }

  async isAdmitted(eventId: string, pid: string): Promise<boolean> {
    const k = keys(eventId);
    return int(await this.command(['HEXISTS', k.admitted, pid])) === 1;
  }

  async servingLog(eventId: string): Promise<ServingLogEntry[]> {
    const k = keys(eventId);
    const rows = await this.command(['XRANGE', k.servingLog, '-', '+'], this.tickTimeoutMs);
    if (!Array.isArray(rows)) throw new Error('XRANGE 응답이 배열이 아니다');
    return rows.map((row) => {
      const fields = strings((row as unknown[])[1]);
      const get = (name: string) => {
        const i = fields.indexOf(name);
        return i >= 0 && i % 2 === 0 ? fields[i + 1] : undefined;
      };
      return { serving: int(get('serving')), called: int(get('called')), atMs: int(get('atMs')) };
    });
  }
}
