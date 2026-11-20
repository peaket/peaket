// S-T13 버전 갭 자가 치유(docs/features/seat-hold.md §12 S-T13, docs/frontend.md §4.4.1, ADR-0117, ADR-0240, BAT-182).
// 화면 경계에서 델타 프레임 하나가 빠져 구역 일련번호가 건너뛴 상황을 3,000번 만들고, 그 구역 스냅샷 한 장으로 30초 안에 회복하는지 잰다.
// 실제 createSeatConnection·createDeltaSync·SeatMapEngine을 가짜 시계·가짜 소켓·가짜 스냅샷으로 돌린다(계획 §3-2). 망 드롭(tc netem)은 HOT-460 측정 창 몫이다.
import { describe, expect, it } from 'vitest';
import { createSeatConnection, type SeatSocket } from '../src/connection';
import { createDeltaSync } from '../src/delta-sync';
import { SeatMapEngine } from '../src/engine';
import { encodeDelta, encodeSnapshot, fakeCtx, makeLayout } from './fixtures';

const LAYOUT = makeLayout({ sections: 2, rows: 10, perRow: 20, gap: 2_000, jitter: false });
/** 갭 시뮬레이션 횟수(S-T13 정본) */
const ROUNDS = 3_000;
/** 30초 안에 회복해야 한다(S-T13 정본) */
const RECOVERY_LIMIT_MS = 30_000;

/** 가짜 시계. 예약된 타이머를 시각 차례로 돌리고 마이크로태스크를 비운다 */
function fakeTime(start = 1_000) {
  let now = start;
  let id = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const flush = async (n = 6) => {
    for (let i = 0; i < n; i++) await Promise.resolve();
  };
  const advance = async (ms: number) => {
    const end = now + ms;
    await flush();
    for (;;) {
      const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      now = due[1].at;
      due[1].fn();
      await flush();
    }
    now = end;
    await flush();
  };
  return { now: () => now, setTimer: (fn: () => void, ms: number) => (timers.set(++id, { at: now + ms, fn }), id), clearTimer: (h: unknown) => void timers.delete(h as number), advance, flush };
}

class FakeSocket implements SeatSocket {
  protocol = 'peaket.seats.v1';
  binaryType = 'arraybuffer';
  readyState = 0;
  sent: Uint8Array[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  send(d: Uint8Array) {
    this.sent.push(d);
  }
  close() {
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  frame(u8: Uint8Array) {
    this.onmessage?.({ data: u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) });
  }
}

/** 그 구역의 스냅샷 한 장(flags 1, 비트맵은 구역 좌석 수만큼) */
function sectionSnapshot(section: number, version: number): Uint8Array {
  const sec = LAYOUT.sections[section]!;
  const n = sec.seatIndexRange.to - sec.seatIndexRange.from + 1;
  return encodeSnapshot({ flags: 1, layoutVersion: LAYOUT.layoutVersion, seatEpoch: 1, sections: [[section, version]], occupied: Array(n).fill(false) });
}

/**
 * 정확 이항 단측 95% 상한(클로퍼-피어슨). 실패 0/3,000이면 1 − 0.05^(1/3,000)이다.
 * S-T13의 판정 값(0.0999% 이하)을 시험이 직접 세게 하려고 정규 근사를 쓰지 않는다(docs/planning/02-requirements.md §3.1 원칙 6).
 */
const exactUpper95 = (failures: number, n: number): number => {
  if (failures === 0) return 1 - 0.05 ** (1 / n);
  let lo = failures / n;
  let hi = 1;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    // P(X ≤ failures)를 이항 분포로 정확히 더한다(3,000회·실패 몇 건이라 로그로 안정하게)
    let cdf = 0;
    for (let k = 0; k <= failures; k++) {
      let log = 0;
      for (let j = 0; j < k; j++) log += Math.log(n - j) - Math.log(j + 1);
      cdf += Math.exp(log + k * Math.log(mid) + (n - k) * Math.log(1 - mid));
    }
    if (cdf > 0.05) lo = mid;
    else hi = mid;
  }
  return hi;
};

describe('S-T13 버전 갭 자가 치유', () => {
  it('[ASVS v5.0.0-4.4.1] S-T13 3,000번 버전 갭에서 30초 안에 그 구역 스냅샷으로 회복하고 실패 0번이다', { timeout: 180_000 }, async () => {
    const t = fakeTime();
    const socket = new FakeSocket();
    const engine = new SeatMapEngine({ ctx: fakeCtx(), width: 400, height: 300, dpr: 1, theme: 'light' });
    engine.load(
      LAYOUT,
      encodeSnapshot({ layoutVersion: LAYOUT.layoutVersion, seatEpoch: 1, sections: [[0, 1], [1, 1]], occupied: Array(LAYOUT.seatCount).fill(false) }),
    );

    /** 진행 중인 구역 스냅샷 요청(시험이 응답 시각과 성패를 정한다) */
    const pending: Array<{ section: number; resolve: (buf: Uint8Array) => void; reject: (err: unknown) => void }> = [];
    let requests = 0;
    let recoveredAt: number | null = null;
    const fetchSection = (section: number): Promise<Uint8Array> => {
      requests++;
      return new Promise<Uint8Array>((resolve, reject) => void pending.push({ section, resolve, reject }));
    };

    const failures: string[] = [];
    const sync = createDeltaSync({
      engine,
      fetchSection,
      subscribed: () => [0],
      random: () => 0.5,
      now: t.now,
      setTimer: t.setTimer,
      clearTimer: t.clearTimer,
      onApplied: () => void (recoveredAt = t.now()),
      onError: (e) => void failures.push(`onError ${String((e as Error)?.message ?? e)}`),
      onFatal: (kind, e) => void failures.push(`onFatal ${kind} ${String((e as Error)?.message ?? e)}`),
    });
    const conn = createSeatConnection({
      url: 'ws://127.0.0.1:4010/v1/events/evt-1/seats/stream',
      getToken: () => ({ token: 'adm.token.sig', expiresAtMs: 10_000_000 }),
      openSocket: () => socket,
      now: t.now,
      serverNow: t.now,
      setTimer: t.setTimer,
      clearTimer: t.clearTimer,
      random: () => 0.5,
      onState: () => undefined,
      onFrame: (frame) => {
        if (frame.type === 'delta') sync.onDelta(frame);
      },
      onResubscribed: (sections) => sync.resync(sections),
      onError: (e) => void failures.push(`socket ${String((e as Error)?.message ?? e)}`),
    });
    // 연결은 구독 없이 열고, 그 뒤에 구독한다(열 때의 재구독 스냅샷이 시뮬레이션 몫을 먹지 않게)
    conn.start();
    socket.open();
    conn.setSections([0]);
    await t.flush();

    let slowest = 0;
    let snapshotPerGap = 0;
    let injected503 = 0;
    for (let i = 0; i < ROUNDS; i++) {
      const current = engine.versions.version[0]!;
      const next = current + 2;
      const sentAt = t.now();
      recoveredAt = null;
      socket.frame(encodeDelta({ seatEpoch: 1, sections: [{ index: 0, version: next, changes: [[i % 200, 1]] }] }));
      await t.flush();
      if (pending.length !== 1) {
        failures.push(`${i}번째 갭: 스냅샷 요청 ${pending.length}건(한 번에 하나여야 한다)`);
        break;
      }
      // 149번에 한 번 503과 Retry-After를 주입한다(복구 경로 장애). 재시도는 2,000ms×지터 1.1 = 2,200ms 뒤다
      if (i % 149 === 0) {
        const failed = pending.shift()!;
        failed.reject(Object.assign(new Error('좌석 스냅샷 503'), { status: 503, retryAfterMs: 2_000 }));
        await t.flush();
        injected503++;
        await t.advance(2_199);
        if (pending.length > 0) failures.push(`${i}번째 갭: Retry-After 전에 다시 물었다`);
        await t.advance(1);
        if (pending.length !== 1) {
          failures.push(`${i}번째 갭: 503 뒤 재요청 ${pending.length}건`);
          break;
        }
      }
      // 응답 지연 150~450ms를 주입한다
      const latency = 150 + (i % 7) * 50;
      await t.advance(latency);
      const call = pending.shift()!;
      if (call.section !== 0) failures.push(`${i}번째 갭: 구역 ${call.section} 스냅샷을 물었다`);
      call.resolve(sectionSnapshot(0, next - 1));
      await t.flush();
      const took = t.now() - sentAt;
      slowest = Math.max(slowest, took);
      if (recoveredAt === null) {
        failures.push(`${i}번째 갭: 회복하지 못했다(${took}ms)`);
      } else if (took > RECOVERY_LIMIT_MS) {
        failures.push(`${i}번째 갭: 회복이 ${took}ms(한도 ${RECOVERY_LIMIT_MS}ms)`);
      }
      if (engine.versions.version[0] !== next) failures.push(`${i}번째 갭: 판 ${engine.versions.version[0]} ≠ ${next}`);
      snapshotPerGap++;
      if (failures.length > 20) break;
    }

    // 각 갭마다 스냅샷 한 장(503 재시도는 별도)으로 회복했다. 실패 0이면 정확 이항 단측 95% 상한이 0.0999% 이하다
    const upper = exactUpper95(failures.length, ROUNDS);
    console.info(`S-T13 3,000번: 실패 0, 가장 느린 회복 ${slowest}ms, 503 주입 ${injected503}번, 정확 이항 단측 95% 상한 ${(upper * 100).toFixed(4)}%`);
    expect(snapshotPerGap).toBe(ROUNDS);
    expect(injected503).toBe(Math.ceil(ROUNDS / 149));
    expect(requests).toBe(ROUNDS + injected503);
    expect(slowest).toBeLessThanOrEqual(RECOVERY_LIMIT_MS);
    // 0/3,000 → 1 − 0.05^(1/3,000) ≈ 0.0998% (판정 기준 0.0999% 이하)
    expect(upper).toBeLessThanOrEqual(0.000999);
    expect(failures).toEqual([]);
  });
});
