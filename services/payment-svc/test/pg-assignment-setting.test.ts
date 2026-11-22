// 설정 사건 PG_ASSIGNMENT(명령 12)의 받는 쪽(BAT-360 리뷰 RV-02, ADR-0349 결정 5, 계획 6절 B17, docs/features/payment.md §2.2 '회차 지정(명령 12의 쓰임새)').
// 정본 값: 키 `<회차>:PG_ASSIGNMENT:`, 값 asyncapi PgAssignmentValue {primaryPg, fallbackPg?}, 지정 시각은 사건의 occurredAt이고 payment-svc는 설정 변경마다 AssignEventPg를 부른다.
// 하위 결제사 규칙·입력 오류는 같은 값이면 늘 같은 답이라 다시 하지 않고, 저장소 오류는 다시 하며 그사이 온 새 사건이 옛 값을 대신한다.
// 사건은 ops-svc publishSetting이 내는 JSON 꼴로 만들어 플랫폼 운영 해독기(controlEventCodec.setting)와 플랫폼 설정 저장소(SettingsStore)를 지나 받는다.
// 회차 지정 쓰임새 AssignEventPg와 규칙 함수는 진짜이고, 표 쓰기(EventPgAssignmentStore)와 로그(PgAssignmentSettingLog)만 포트 짝 가짜다.
// 다시 하기 대기는 가짜 시계(setTimeout만)로 진행한다.
import { readFileSync } from 'node:fs';
import { controlEventCodec, fakeClock, SettingsStore } from '@peaket/platform';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { AssignEventPg } from '../src/modules/payment/application/assign-event-pg.js';
import { PgAssignmentSettingHandler } from '../src/modules/payment/application/pg-assignment-setting.js';
import { type PortoneChannelMap, portoneChannelMapOf } from '../src/modules/payment/domain/pg-sub-provider.js';
import type { EventPgAssignmentStore, EventPgAssignmentWrite, PgAssignmentSettingLog } from '../src/modules/payment/domain/ports.js';

const EVENT = '0195f3a0-0000-7000-8000-0000000b3611';
const OTHER_EVENT = '0195f3a0-0000-7000-8000-0000000b3612';
const COMMAND = '0195f3a0-0000-7000-8000-0000000c3601';
/** payment-svc 시계의 지금. 사건 시각은 그보다 조금 앞이다(지정 시각 상한 지금 + 5분 안) */
const T = Date.parse('2026-11-25T02:00:00.000Z');
const RETRY_MS = 40;
const RETRY_MAX_MS = 60;

type Behavior = 'ok' | 'stale' | Error | { wait: Promise<void> };

/** event_pg_config 쓰기 짝 가짜. 시험이 부를 때마다의 답(성공·건너뜀·오류·대기)을 차례로 정한다 */
class FakeAssignmentStore implements EventPgAssignmentStore {
  readonly attempts: EventPgAssignmentWrite[] = [];
  readonly written: EventPgAssignmentWrite[] = [];
  readonly plan: Behavior[] = [];
  async assignEvent(w: EventPgAssignmentWrite): Promise<boolean> {
    this.attempts.push(w);
    const b = this.plan.shift() ?? 'ok';
    if (b instanceof Error) throw b;
    if (typeof b === 'object') await b.wait;
    if (b === 'stale') return false;
    this.written.push(w);
    return true;
  }
}

class RecordingLog implements PgAssignmentSettingLog {
  readonly lines: { kind: 'applied' | 'rejected' | 'storeFailed'; e: Record<string, unknown> }[] = [];
  applied(e: Parameters<PgAssignmentSettingLog['applied']>[0]): void {
    this.lines.push({ kind: 'applied', e: { ...e } });
  }
  rejected(e: Parameters<PgAssignmentSettingLog['rejected']>[0]): void {
    this.lines.push({ kind: 'rejected', e: { ...e } });
  }
  storeFailed(e: Parameters<PgAssignmentSettingLog['storeFailed']>[0]): void {
    this.lines.push({ kind: 'storeFailed', e: { eventId: e.eventId, commandId: e.commandId, attempt: e.attempt, retryInMs: e.retryInMs } });
  }
}

const single = (provider: string): PortoneChannelMap => portoneChannelMapOf({ channelKey: 'ch-set' }, { 'ch-set': provider });
const keyOf = (eventId: string, kind = 'PG_ASSIGNMENT') => `${eventId}:${kind}:`;
/** ops-svc publishSetting이 내는 SettingChanged JSON(asyncapi control.settings) */
const message = (o: { eventId?: string; kind?: string; value: unknown; occurredAt: number | string; commandId?: string }): Buffer =>
  Buffer.from(
    JSON.stringify({
      commandId: o.commandId ?? COMMAND,
      key: o.kind ?? 'PG_ASSIGNMENT',
      scope: o.eventId ?? EVENT,
      value: o.value,
      expiresAt: null,
      actor: 'ops-actor-ref-b360',
      occurredAt: o.occurredAt,
      eventKey: '0195f3a0-0000-8000-8000-0000000e3601',
    }),
    'utf8',
  );

function harness(o: { portone?: PortoneChannelMap } = {}) {
  const clock = fakeClock({ now: T });
  const settings = new SettingsStore(clock);
  const store = new FakeAssignmentStore();
  const log = new RecordingLog();
  const handler = new PgAssignmentSettingHandler({
    assign: new AssignEventPg({ store, ...(o.portone ? { portone: o.portone } : {}), clock }),
    log,
    retryMs: RETRY_MS,
    retryMaxMs: RETRY_MAX_MS,
  });
  handler.subscribe(settings);
  /** Kafka 레코드 하나를 받은 것처럼: 운영 해독기 → 설정 저장소 */
  const deliver = (eventId: string, value: Buffer, kind = 'PG_ASSIGNMENT') => settings.apply(keyOf(eventId, kind), controlEventCodec.setting(value));
  return { settings, store, log, handler, deliver };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});
afterEach(() => {
  vi.useRealTimers();
});
/** 쌓인 마이크로 작업과 ms만큼의 대기를 흘린다 */
const flush = (ms = 0) => vi.advanceTimersByTimeAsync(ms);

describe('B360-PAY PG_ASSIGNMENT 설정 사건 받기(ADR-0349 결정 5, B17)', () => {
  test('B360-PAY ⑨ 사건의 occurredAt을 지정 시각으로 회차 지정을 쓴다(ISO 시각 글·밀리초 수 둘 다)', async () => {
    const h = harness({ portone: single('KCP_V2') });
    const at = T - 1_234;
    h.deliver(EVENT, message({ value: { primaryPg: 'TOSS', fallbackPg: 'PORTONE' }, occurredAt: new Date(at).toISOString() }));
    await flush();
    expect(h.store.written).toEqual([{ eventId: EVENT, primary: 'TOSS', fallback: 'PORTONE', updatedAtMs: at }]);
    h.deliver(OTHER_EVENT, message({ eventId: OTHER_EVENT, value: { primaryPg: 'PORTONE' }, occurredAt: at + 7 }));
    await flush();
    expect(h.store.written.at(-1)).toEqual({ eventId: OTHER_EVENT, primary: 'PORTONE', updatedAtMs: at + 7 });
    expect(h.log.lines).toEqual([
      { kind: 'applied', e: { eventId: EVENT, commandId: COMMAND, written: true } },
      { kind: 'applied', e: { eventId: OTHER_EVENT, commandId: COMMAND, written: true } },
    ]);
  });

  test('B360-PAY ⑩ 쓰는 중에 같은 회차의 새 사건 둘이 오면 가운데를 버리고 마지막 값을 쓴다', async () => {
    const h = harness();
    let release!: () => void;
    h.store.plan.push({ wait: new Promise<void>((r) => (release = r)) });
    h.deliver(EVENT, message({ value: { primaryPg: 'TOSS' }, occurredAt: T - 300 }));
    await flush();
    h.deliver(EVENT, message({ value: { primaryPg: 'PORTONE' }, occurredAt: T - 200 }));
    h.deliver(EVENT, message({ value: { primaryPg: 'TOSS', fallbackPg: 'PORTONE' }, occurredAt: T - 100 }));
    await flush();
    expect(h.store.attempts).toHaveLength(1);
    release();
    await flush();
    expect(h.store.written).toEqual([
      { eventId: EVENT, primary: 'TOSS', updatedAtMs: T - 300 },
      { eventId: EVENT, primary: 'TOSS', fallback: 'PORTONE', updatedAtMs: T - 100 },
    ]);
  });

  test('B360-PAY ⑪ 저장소 오류는 간격을 두 배로 늘려(상한까지) 다시 하고, 간격 − 1ms에는 다시 하지 않는다', async () => {
    const h = harness();
    const down = Object.assign(new Error('connection terminated'), { code: '57P01' });
    h.store.plan.push(down, down, 'ok');
    h.deliver(EVENT, message({ value: { primaryPg: 'PORTONE', fallbackPg: 'TOSS' }, occurredAt: T - 50 }));
    await flush();
    expect(h.store.attempts).toHaveLength(1);
    await flush(RETRY_MS - 1);
    expect(h.store.attempts).toHaveLength(1);
    await flush(1);
    expect(h.store.attempts).toHaveLength(2);
    await flush(RETRY_MAX_MS - 1);
    expect(h.store.attempts).toHaveLength(2);
    await flush(1);
    expect(h.store.written).toEqual([{ eventId: EVENT, primary: 'PORTONE', fallback: 'TOSS', updatedAtMs: T - 50 }]);
    expect(h.log.lines.map((l) => [l.kind, l.e.attempt, l.e.retryInMs])).toEqual([
      ['storeFailed', 1, RETRY_MS],
      ['storeFailed', 2, RETRY_MAX_MS],
      ['applied', undefined, undefined],
    ]);
  });

  test('B360-PAY ⑫ 다시 하기를 기다리는 사이 새 사건이 오면 옛 값을 다시 쓰지 않고 새 값을 쓴다', async () => {
    const h = harness();
    h.store.plan.push(new Error('pool timeout'));
    h.deliver(EVENT, message({ value: { primaryPg: 'TOSS' }, occurredAt: T - 500 }));
    await flush();
    h.deliver(EVENT, message({ value: { primaryPg: 'PORTONE' }, occurredAt: T - 400 }));
    await flush(RETRY_MS);
    await flush(RETRY_MAX_MS * 3);
    expect(h.store.attempts.map((w) => w.updatedAtMs)).toEqual([T - 500, T - 400]);
    expect(h.store.written).toEqual([{ eventId: EVENT, primary: 'PORTONE', updatedAtMs: T - 400 }]);
  });

  test('B360-PAY ⑬ 하위 결제사 규칙에 걸린 값은 표를 바꾸지 않고 까닭을 남기며 다시 하지 않는다', async () => {
    const h = harness({ portone: single('TOSSPAYMENTS') });
    h.deliver(EVENT, message({ value: { primaryPg: 'TOSS', fallbackPg: 'PORTONE' }, occurredAt: T - 10 }));
    await flush(10 * 60_000);
    expect(h.store.attempts).toEqual([]);
    expect(h.log.lines).toEqual([{ kind: 'rejected', e: { eventId: EVENT, commandId: COMMAND, provider: 'TOSSPAYMENTS', reason: 'SAME_PROVIDER' } }]);
  });

  test.each([
    ['primaryPg', { primaryPg: 7 }, EVENT],
    ['primaryPg', { fallbackPg: 'TOSS' }, EVENT],
    ['primaryPg', 'TOSS', EVENT],
    ['fallbackPg', { primaryPg: 'TOSS', fallbackPg: 3 }, EVENT],
    ['primary', { primaryPg: 'KAKAO' }, EVENT],
    ['fallback', { primaryPg: 'PORTONE', fallbackPg: 'PORTONE' }, EVENT],
    ['event_id', { primaryPg: 'TOSS' }, 'NOT-A-UUID'],
  ])('B360-PAY ⑭ 값 꼴이 틀리면(%s) 쓰지 않고 그 칸을 남기며 다시 하지 않는다', async (field, value, eventId) => {
    const h = harness();
    h.deliver(eventId, message({ eventId, value, occurredAt: T - 10 }));
    await flush(10 * 60_000);
    expect(h.store.attempts).toEqual([]);
    expect(h.log.lines).toEqual([{ kind: 'rejected', e: expect.objectContaining({ commandId: COMMAND, field }) }]);
  });

  test('B360-PAY ⑮ 다른 종류의 설정(LOG_SAMPLING)과 지우는 표시는 회차 지정을 건드리지 않는다', async () => {
    const h = harness();
    h.deliver(EVENT, message({ kind: 'LOG_SAMPLING', value: { oneIn: 1 }, occurredAt: T - 10 }), 'LOG_SAMPLING');
    h.deliver(EVENT, message({ value: { primaryPg: 'TOSS' }, occurredAt: T - 5 }));
    await flush();
    h.settings.apply(keyOf(EVENT), null);
    await flush(10 * 60_000);
    expect(h.store.attempts).toEqual([{ eventId: EVENT, primary: 'TOSS', updatedAtMs: T - 5 }]);
    expect(h.log.lines.map((l) => l.kind)).toEqual(['applied']);
  });

  test('B360-PAY ⑯ 멈추면 듣기를 끊고 다시 하기를 그만둔다', async () => {
    const h = harness();
    h.store.plan.push(new Error('db down'));
    h.deliver(EVENT, message({ value: { primaryPg: 'TOSS' }, occurredAt: T - 10 }));
    await flush();
    const stopped = h.handler.stop();
    await flush();
    await stopped;
    h.deliver(EVENT, message({ value: { primaryPg: 'PORTONE' }, occurredAt: T - 5 }));
    await flush(10 * 60_000);
    expect(h.store.attempts).toHaveLength(1);
  });
});

describe('B360-PAY 시작 파일 조립(src/start.ts)', () => {
  test('B360-PAY ⑰ 시작 파일이 설정 저장소 변경에 PG_ASSIGNMENT 처리기(AssignEventPg)를 붙이고 종료에 멈추며, 판정 RPC에 승인 상한 설정을 넘긴다', () => {
    const source = readFileSync(new URL('../src/start.ts', import.meta.url), 'utf8');
    expect(source).toMatch(/new PgAssignmentSettingHandler\(\{\s*assign: new AssignEventPg\(/);
    expect(source).toMatch(/pgAssignmentSettings\.subscribe\(controlSync\.sync\.settings\)/);
    expect(source).toMatch(/pgAssignmentSettings\.stop\(\)/);
    expect(source).toMatch(/const approvalTps = loadPgApprovalTps\(env\)/);
    expect(source).toMatch(/checkEventPgAssignment: new CheckEventPgAssignment\(\{ selection: new DrizzlePgSelection\([^)]*\),[^\n]{0,120}approvalTps \}\)/);
  });
});
