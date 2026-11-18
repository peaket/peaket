// 허브 단위 시험 도구: 가짜 연결·가짜 구독기·바이트를 손으로 만드는 프레임(docs/frontend.md §4.4.1 표, 리틀 엔디언).
// 단언 값은 정본(seat-hold §7 'realtime-gw의 첫 구현', frontend §4.4.1)에서 적고, 구현 상수를 가져오지 않는다.
import { fakeClock, type FakeClock } from '@peaket/platform';
import { decodeFrame, type Frame } from '../../../packages/seatmap/src/wire.js'; // 화면과 같은 해독기(core-svc 시험과 같이 소스를 바로 가져온다)
import { createStreamHub, type ChannelSubscriber, type StreamConnection, type StreamHub } from '../src/modules/stream/index.js';

/** 정본 값(seat-hold §7, frontend §4.4.1). 코드 상수와 따로 적는다 */
export const SPEC = {
  intervalMs: 100,
  maxSections: 16,
  windowMs: 1_000,
  timeSyncGapMs: 1_000,
  heartbeatMs: 15_000,
  maxBuffered: 1024 * 1024,
  maxFrameBytes: 1024,
  maxWaitCap: 65_535,
  close: { restart: 1012, slow: 1013, expired: 4401, forbidden: 4403, tooMany: 4429 },
  /** 닫힘 이유 글(docs/frontend.md §4.4.1 '닫힘 이유 글', ADR-0297 결정 8). 글자 그대로 계약이다 */
  reason: { restart: 'server restart', slow: 'slow consumer', expired: 'token expired', badEvent: 'bad event', badSection: 'bad section', badFrame: 'bad frame', tooMany: 'too many' },
  /** 같은 입장 토큰(jti)의 파드 연결 상한(seat-hold §7 '핸드셰이크' 뒤 문장, ADR-0297 결정 3, [가정]) */
  sameTokenMax: 2,
  /** 내릴 때 구독 해제 응답을 기다리는 상한(ms, ADR-0297 결정 5, [가정]) */
  shutdownUnsubscribeWaitMs: 1_000,
} as const;

/** 시작 시각은 박자(100ms)의 배수가 아니게 고른다 */
export const WALL0 = Date.parse('2026-11-18T05:00:00.000Z') + 37;
export const MONO0 = 12_345;

export class FakeConn implements StreamConnection {
  readonly sent: Uint8Array[] = [];
  closes: Array<{ code: number; reason: string }> = [];
  bufferedAmount = 0;
  send(frame: Uint8Array): void {
    this.sent.push(frame);
  }
  close(code: number, reason: string): void {
    this.closes.push({ code, reason });
  }
  get closed(): { code: number; reason: string } | undefined {
    return this.closes[0];
  }
  frames(): Frame[] {
    return this.sent.map((f) => decodeFrame(f));
  }
  /** from번째 뒤로 받은 프레임 */
  framesFrom(from: number): Frame[] {
    return this.sent.slice(from).map((f) => decodeFrame(f));
  }
}

export interface Deferred {
  resolve(): void;
  reject(e: unknown): void;
}

/**
 * 부른 차례를 적는 가짜 구독기. hold가 참이면 끝나지 않은 약속을 돌려주고 pending에 둔다.
 * ADR-0297 결정 1 뒤로 실제 구독기는 원하는 상태를 적고 곧 돌려주며 거절하지 않지만, 허브가 구독기의 약속 결과(거절·끝나지 않음)로
 * 상태를 정하지 않는지 보려고 이 가짜는 거절하거나 붙잡을 수 있다
 */
export class FakeSubscriber implements ChannelSubscriber {
  readonly calls: Array<['subscribe' | 'unsubscribe', string]> = [];
  readonly listeners = new Map<string, (m: string) => void>();
  readonly pending: Deferred[] = [];
  hold = false;
  subscribe(channel: string, onMessage: (message: string) => void): Promise<void> {
    this.calls.push(['subscribe', channel]);
    this.listeners.set(channel, onMessage);
    return this.#done();
  }
  unsubscribe(channel: string): Promise<void> {
    this.calls.push(['unsubscribe', channel]);
    this.listeners.delete(channel);
    return this.#done();
  }
  /** 채널에 구독한 함수로 글 하나를 보낸다(구독하지 않은 채널이면 false) */
  publish(channel: string, text: string): boolean {
    const l = this.listeners.get(channel);
    if (!l) return false;
    l(text);
    return true;
  }
  #done(): Promise<void> {
    if (!this.hold) return Promise.resolve();
    return new Promise<void>((resolve, reject) => this.pending.push({ resolve, reject }));
  }
}

export interface MetricCall {
  name: string;
  labels: Record<string, string>;
  value: number;
}

export interface Harness {
  hub: StreamHub;
  clock: FakeClock;
  sub: FakeSubscriber;
  metrics: MetricCall[];
  sections: Map<string, number>;
  /** 열고 첫 프레임까지 받은 연결. tokenId를 주지 않으면 연결마다 다른 토큰 jti다 */
  open(o?: { eventId?: string; accountId?: string; expiresAtMs?: number; tokenId?: string }): FakeConn;
}

export function harness(o: { sections?: Record<string, number> } = {}): Harness {
  const clock = fakeClock({ now: WALL0, monotonic: MONO0 });
  const sub = new FakeSubscriber();
  const metrics: MetricCall[] = [];
  const sections = new Map(Object.entries(o.sections ?? { 'ev-1': 20, 'ev-2': 20 }));
  let tokens = 0;
  const hub = createStreamHub({
    clock,
    subscriber: sub,
    sectionCount: (eventId) => sections.get(eventId),
    onMetric: (name, labels, value) => metrics.push({ name, labels, value }),
  });
  return {
    hub,
    clock,
    sub,
    metrics,
    sections,
    open(s = {}) {
      const c = new FakeConn();
      // tokenId는 ADR-0297 결정 3의 새 칸(토큰 jti, 같은 토큰의 파드 연결 상한을 센다)
      hub.open(c, { eventId: s.eventId ?? 'ev-1', accountId: s.accountId ?? 'acct-1', expiresAtMs: s.expiresAtMs ?? WALL0 + 3_600_000, tokenId: s.tokenId ?? `jti-${++tokens}` });
      return c;
    },
  };
}

/** 프레임 바이트를 손으로 만든다(머리 u8 version, u8 type, 그 뒤 본문) */
export function rawFrame(version: number, type: number, body: number[] = []): Uint8Array {
  return Uint8Array.from([version, type, ...body]);
}

const u16 = (n: number): number[] => [n & 0xff, (n >> 8) & 0xff];

/** SubscribeSections{u16 count, count × u16 sectionIndex}. count를 따로 주면 실제 목록과 다른 count를 싣는다 */
export function subscribeBytes(sections: readonly number[], o: { count?: number; version?: number } = {}): Uint8Array {
  return rawFrame(o.version ?? 1, 16, [...u16(o.count ?? sections.length), ...sections.flatMap(u16)]);
}

/** TimeSync{u64 clientTimeMs}(10바이트) */
export function timeSyncBytes(clientTimeMs: bigint): Uint8Array {
  const u8 = new Uint8Array(10);
  const v = new DataView(u8.buffer);
  v.setUint8(0, 1);
  v.setUint8(1, 18);
  v.setBigUint64(2, clientTimeMs, true);
  return u8;
}

/** data.md §3 메시지 글 */
export function deltaText(m: { epoch: number; section: number; version: number; changedAtMs: number; seats: Array<[number, number]> }): string {
  return ['1', m.epoch, m.section, m.version, m.changedAtMs, ...m.seats.map(([o, s]) => `${o}:${s}`)].join(' ');
}

export const channelOf = (eventId: string, section: number): string => `s:{event:${eventId}}:sec:${section}`;

export type DeltaFrame = Extract<Frame, { type: 'delta' }>;

export const deltas = (frames: Frame[]): DeltaFrame[] => frames.filter((f): f is DeltaFrame => f.type === 'delta');

/** 묶음 항목을 견주기 쉬운 모양으로 */
export const entriesOf = (f: DeltaFrame) => f.sections.map((s) => ({ sectionIndex: s.sectionIndex, sectionVersion: s.sectionVersion, offsets: [...s.offsets], states: [...s.states] }));

/** 마이크로태스크(구독 약속의 then)가 다 돌 때까지 기다린다 */
export const settle = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};
