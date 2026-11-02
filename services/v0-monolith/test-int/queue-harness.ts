// 대기열 v0 통합 시험 도우미(docs/features/queue-admission.md §13).
// Valkey 컨테이너 하나를 파일 안에서 같이 쓰고, 시계만 가짜(fakeClock)로 둔다. 모놀리스는 HTTP(inject)로,
// 회차 열기·입장 루프는 모듈 공개 함수(createQueueAdmin)로 부른다. 시험마다 회차 ID를 새로 만들어 서로 섞이지 않게 한다.
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { createService, fakeClock, type FakeClock, type PlatformService, type RedisCommander } from '@peaket/platform';
import { createClient } from 'redis';
import { expect } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { createQueueAdmin, type QueueAdmin, type QueueConfig, type TickResult } from '../src/modules/queue/index.js';
import { startValkey, type ValkeyContainer } from './valkey.js';

/** 차례가 온 뒤 입장을 기다려 주는 시간(POL-008, 15분). 모듈 상수를 믿지 않고 정책 값을 그대로 쓴다 */
export const GRACE_MS = 15 * 60 * 1000;

/** RFC 9457 Problem의 type 앞부분(docs/api/guidelines.md §2) */
export const PROBLEM_BASE = 'https://peaket.example/problems/';

/** 성공 응답과 오류 응답의 Content-Type(ASVS v5.0.0-4.1.1, v0-baseline 추적 표) */
export const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';
/** 오류는 application/problem+json이다. 플랫폼이 charset=utf-8을 붙일 수 있어 그 매개변수만 허용한다 */
export const PROBLEM_CONTENT_TYPE = expect.stringMatching(/^application\/problem\+json(?:;\s*charset=utf-8)?$/i);

export type Headers = Record<string, string>;

export interface Reply {
  status: number;
  contentType: string | undefined;
  raw: string;
  // 응답 본문은 시험이 칸마다 정확히 본다
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
}

/** 게이트웨이가 넘기는 팬 신원 머리(x-user-*). 기본은 pid마다 다른 계정·세션이다 */
export function fanHeaders(pid: string, o: { account?: string; session?: string; scope?: string } = {}): Headers {
  return {
    'x-user-id': o.account ?? `acc-${pid}`,
    'x-session-id': o.session ?? `ses-${pid}`,
    'x-user-aud': 'fan',
    'x-user-scope': o.scope ?? 'ticket:buy',
    'x-user-pid': pid,
  };
}

/** 네 경로(§13 동작 1·2·3·5) */
export type Route = 'enter' | 'status' | 'cancel' | 'admit';

export const ROUTES: Record<Route, { method: 'POST' | 'GET' | 'DELETE'; path: (eventId: string) => string }> = {
  enter: { method: 'POST', path: (e) => `/v1/queues/${e}/entries` },
  status: { method: 'GET', path: (e) => `/v1/queues/${e}/entries/me` },
  cancel: { method: 'DELETE', path: (e) => `/v1/queues/${e}/entries/me` },
  admit: { method: 'POST', path: (e) => `/v1/queues/${e}/admission` },
};

/**
 * 오류 응답이 그 이름의 Problem인지 본다(상태 코드·Content-Type·type·status·title·확장 칸).
 * 이름 붙은 오류는 type·title·status를 싣는다(docs/api/guidelines.md §2). 같은 type의 title이 늘 같은지는
 * 따로 한 시험에서 견준다(FR006_FR007_FR008_같은오류이름은…)
 */
export function expectProblem(r: Reply, status: number, name: string, extensions: Record<string, unknown> = {}): void {
  expect({ status: r.status, contentType: r.contentType }, r.raw).toEqual({ status, contentType: PROBLEM_CONTENT_TYPE });
  expect(r.body).toMatchObject({ type: `${PROBLEM_BASE}${name}`, status, title: expect.any(String), ...extensions });
  expect((r.body.title as string).trim(), `title이 비었다: ${r.raw}`).not.toBe('');
}

/** Redis 응답(배열·Map·객체·Buffer가 섞일 수 있다)을 문자열 목록으로 편다 */
function flattenReply(v: unknown): string[] {
  if (v === null || v === undefined) return [];
  if (Array.isArray(v)) return v.flatMap(flattenReply);
  if (v instanceof Map) return [...v.entries()].flatMap(([k, x]) => [...flattenReply(k), ...flattenReply(x)]);
  if (Buffer.isBuffer(v)) return [v.toString('utf8')];
  if (typeof v === 'object') return Object.entries(v as Record<string, unknown>).flatMap(([k, x]) => [k, ...flattenReply(x)]);
  return [String(v)];
}

let eventCounter = 0;

export class QueueHarness {
  private constructor(
    private readonly valkey: ValkeyContainer,
    /** 닫을 Redis 연결들 */
    private readonly closers: (() => Promise<unknown>)[],
    readonly redis: RedisCommander,
    readonly svc: PlatformService,
    readonly clock: FakeClock,
    readonly admin: QueueAdmin,
  ) {}

  /** Valkey 컨테이너·모놀리스(입장 루프 끔)·공개 함수를 띄운다 */
  static async start(): Promise<QueueHarness> {
    const valkey = await startValkey();
    const client = createClient({ url: valkey.url });
    client.on('error', () => {});
    try {
      await client.connect();
      const redis: RedisCommander = { sendCommand: (args) => client.sendCommand(args) };
      const clock = fakeClock();
      const svc = await createService({
        name: 'v0-monolith',
        module: AppModule.register({ queue: { redis, tickIntervalMs: false } }),
        env: { PEAKET_ENV: 'ci' },
        clock,
        logDestination: new Writable({ write: (_chunk, _enc, cb) => cb() }),
      });
      return new QueueHarness(valkey, [() => client.quit()], redis, svc, clock, createQueueAdmin(redis));
    } catch (err) {
      // 띄우다 실패하면 afterAll이 닫을 것이 없다. 컨테이너가 남지 않게 여기서 지운다
      await client.disconnect().catch(() => {});
      valkey.stop();
      throw err;
    }
  }

  /** Valkey 주소(오류 응답에 실리지 않는지 본다) */
  get valkeyUrl(): string {
    return this.valkey.url;
  }

  /** 다른 복제본처럼 따로 연결한 Redis로 공개 함수를 하나 더 만든다 */
  async secondAdmin(): Promise<QueueAdmin> {
    const client = createClient({ url: this.valkey.url });
    client.on('error', () => {});
    await client.connect();
    this.closers.push(() => client.quit());
    return createQueueAdmin({ sendCommand: (args) => client.sendCommand(args) });
  }

  /** 시험마다 새 회차 ID(영숫자·-·_ 1~64자) */
  newEventId(): string {
    eventCounter += 1;
    return `ev${eventCounter}-${randomUUID().slice(0, 8)}`;
  }

  /** 회차를 연다. 기본은 1초에 1명, 판매 종료 없음 */
  async open(config: Partial<QueueConfig> = {}): Promise<string> {
    const eventId = this.newEventId();
    await this.admin.open(eventId, { admitPerSecond: 1, ...config });
    return eventId;
  }

  async request(route: Route, eventId: string, headers: Headers): Promise<Reply> {
    const { method, path } = ROUTES[route];
    return this.requestRaw(method, path(eventId), headers);
  }

  async requestRaw(method: 'POST' | 'GET' | 'DELETE', url: string, headers: Headers): Promise<Reply> {
    const res = await this.svc.http.inject({ method, url, headers });
    const raw = res.payload;
    const ct = res.headers['content-type'];
    return { status: res.statusCode, contentType: ct === undefined ? undefined : String(ct), raw, body: raw.length > 0 ? JSON.parse(raw) : undefined };
  }

  enter(eventId: string, pid: string, headers: Headers = fanHeaders(pid)): Promise<Reply> {
    return this.request('enter', eventId, headers);
  }

  status(eventId: string, pid: string, headers: Headers = fanHeaders(pid)): Promise<Reply> {
    return this.request('status', eventId, headers);
  }

  cancel(eventId: string, pid: string, headers: Headers = fanHeaders(pid)): Promise<Reply> {
    return this.request('cancel', eventId, headers);
  }

  admit(eventId: string, pid: string, headers: Headers = fanHeaders(pid)): Promise<Reply> {
    return this.request('admit', eventId, headers);
  }

  /** 차례대로 진입시키고 받은 순번을 돌려준다(모두 201이어야 한다) */
  async enterAll(eventId: string, pids: string[]): Promise<number[]> {
    const seqs: number[] = [];
    for (const pid of pids) {
      const r = await this.enter(eventId, pid);
      expect(r.status, `진입 ${pid}: ${r.raw}`).toBe(201);
      seqs.push(r.body.seq as number);
    }
    return seqs;
  }

  /** 시계를 다음 1초 칸의 시작(유닉스 초의 경계)으로 민다. 이미 경계면 그대로 둔다 */
  alignToSecond(): number {
    const rem = this.clock.now() % 1000;
    if (rem !== 0) this.clock.advance(1000 - rem);
    return this.clock.now();
  }

  /** 지금 시각으로 입장 루프 한 칸을 부르고 그 회차의 결과를 돌려준다 */
  async tick(eventId: string, admin: QueueAdmin = this.admin, nowMs: number = this.clock.now()): Promise<TickResult | undefined> {
    const results = await admin.tick(nowMs);
    return results.find((t) => t.eventId === eventId);
  }

  /** 1초씩 시계를 밀며 n칸을 부른다(첫 칸은 지금 시각). 끝나면 시계는 마지막 칸 시각에 있다 */
  async tickSeconds(eventId: string, n: number): Promise<TickResult[]> {
    const out: TickResult[] = [];
    for (let i = 0; i < n; i += 1) {
      if (i > 0) this.clock.advance(1000);
      const t = await this.tick(eventId);
      expect(t, `칸 ${i}`).toBeDefined();
      out.push(t!);
    }
    return out;
  }

  /** 저장소의 키 이름 전부(§13 키 표 확인용) */
  async keys(): Promise<string[]> {
    return ((await this.redis.sendCommand(['KEYS', '*'])) as string[]).map(String);
  }

  /** 그 회차 해시 태그(q0:{event:E}:…)가 붙은 키 이름 */
  async eventKeys(eventId: string): Promise<string[]> {
    return (await this.keys()).filter((k) => k.startsWith(`q0:{event:${eventId}}:`)).sort();
  }

  /** 그 회차 키마다 담긴 값 전부를 문자열 목록으로 읽는다(저장한 사람 값 확인용, ASVS v5.0.0-14.1.1) */
  async dumpEvent(eventId: string): Promise<Record<string, string[]>> {
    const out: Record<string, string[]> = {};
    for (const key of await this.eventKeys(eventId)) {
      const type = String(await this.redis.sendCommand(['TYPE', key]));
      const read: Record<string, string[]> = {
        hash: ['HGETALL', key],
        zset: ['ZRANGE', key, '0', '-1', 'WITHSCORES'],
        set: ['SMEMBERS', key],
        list: ['LRANGE', key, '0', '-1'],
        stream: ['XRANGE', key, '-', '+'],
        string: ['GET', key],
      };
      const cmd = read[type];
      expect(cmd, `${key}의 형 ${type}`).toBeDefined();
      out[key] = flattenReply(await this.redis.sendCommand(cmd!));
    }
    return out;
  }

  /** Hash 하나를 필드 → 값으로 읽는다 */
  async hash(key: string): Promise<Record<string, string>> {
    const flat = flattenReply(await this.redis.sendCommand(['HGETALL', key]));
    const out: Record<string, string> = {};
    for (let i = 0; i + 1 < flat.length; i += 2) out[flat[i]!] = flat[i + 1]!;
    return out;
  }

  async close(): Promise<void> {
    try {
      await this.svc?.close();
      for (const close of this.closers) await close().catch(() => {});
    } finally {
      // 앞에서 무엇이 실패해도 컨테이너는 지운다
      this.valkey?.stop();
    }
  }
}
