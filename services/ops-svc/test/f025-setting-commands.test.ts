// 설정형 명령 5·8·9의 매개변수·사건 꼴·되돌리기·만료와 적용 확인 행·delivery(F-02-5 OPS-300, ADR-0365 결정 9·10·13·14, 계획 6절 B1~B6·B16).
// 정본 값(단언은 여기서 적는다. 코드 상수를 가져오지 않는다):
// - 범위는 늘 PLATFORM, 메시지 키 PLATFORM:BOT_LEVEL:·PLATFORM:LOG_LEVEL:<서비스>·PLATFORM:FEATURE_FLAG:<플래그>(ADR-0365 결정 13, asyncapi control.settings)
// - 명령 8: {service, level}. level은 DEBUG·TRACE, service는 설정을 읽는 일곱(core·identity·ops·payment·purchase·queue·ticket). 실행 값 {level}, expiresAt = 판 + 30분.
//   만료(정비 바퀴 AUTO_EXPIRED)와 되돌리기(REVERTED)는 {level: INFO}이고 expiresAt이 없다
// - 명령 9: {flag}. flag는 reviews뿐. 실행 {enabled: false}, 되돌리기 {enabled: true}
// - 명령 5: 실행 {level, reassessMode}(없으면 SHADOW), 되돌리기는 마지막 ACKED 명령 5의 값, 없으면 {STANDARD, SHADOW}
// - 목록 밖은 422 invalid-command, detail은 어긋난 칸 이름(service·level·flag, 모르는 칸은 그 칸 이름), 명령·감사·설정 사건 0건(계획 8.1)
// - 받는 서비스: LOG_LEVEL:<s> → s, FEATURE_FLAG:reviews → core-svc, PG_ASSIGNMENT → payment-svc, BOT_LEVEL → trust-svc, 표 밖 없음(ADR-0365 결정 10·15)
// - delivery(APPLY_CHECK): unackedTargets는 '<파드>:<판>', 판이 없으면 '<파드>:-'(계획 8.2 [가정])
// - 세 단계(실행·되돌리기·만료)는 같은 eventKey(settingEventKey(명령 ID, 종류, 범위))이고 받는 쪽은 판(occurredAt)으로 가린다(계획 8.1)
// 겹친 가드(접수 검사와 사건 꼴 만들기)를 하나씩 빼도 잡히게 도메인 함수 직접 시험과 바깥 HTTP·유스케이스 시험을 둘 다 둔다(계획 11절 '겹친 가드').
// 시계는 가짜 시계이고, 시험 시각은 30분 상수와 겹치지 않게 1,234ms를 더한 값으로 고른다.
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { controlEventCodec, createService, fakeClock, type FakeClock } from '@peaket/platform';
import { afterEach, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { MemoryAuditChain } from '../src/modules/audit/index.js';
import {
  BOT_LEVEL_DEFAULT,
  COMMAND_STORE,
  CommandInputRejected,
  ComputeDryRun,
  CreateCommand,
  DecideCommand,
  ExecuteCommand,
  FEATURE_FLAGS,
  LOG_LEVEL_RAISED,
  LOG_LEVEL_SERVICES,
  MaintainCommands,
  MemoryCommandStore,
  RevertCommand,
  SETTING_COMMAND_TYPES,
  applyCheckViewOf,
  checkCommandParams,
  featureOffParamsOf,
  logLevelParamsOf,
  settingDraftOf,
  settingEventKey,
  settingLedgerKindOf,
  settingReceiverOf,
  type ApplyCheckRow,
  type CommandExecutionActor,
} from '../src/modules/commands/index.js';
import { FakeIdentity, quiet } from './support.js';

const NOW = Date.parse('2026-11-23T05:00:00.000Z');
const MIN = 60_000;
/** 명령 8 자동 복귀(정본 30분, control-tower §3 명령 8·ADR-0365 결정 13) */
const LOG_LEVEL_TTL = 30 * MIN;
/** 설정을 읽는 일곱 서비스(ADR-0365 결정 13) */
const READERS = ['core-svc', 'identity-svc', 'ops-svc', 'payment-svc', 'purchase-svc', 'queue-svc', 'ticket-svc'];

type Headers = Record<string, string>;
type Res = { readonly statusCode: number; readonly payload: string };

interface Harness {
  readonly svc: Awaited<ReturnType<typeof createService>>;
  readonly clock: FakeClock;
  readonly identity: FakeIdentity;
  readonly audit: MemoryAuditChain;
  readonly store: MemoryCommandStore;
  readonly maintain: MaintainCommands;
  post(url: string, who: Headers, body: unknown): Promise<Res>;
  get(url: string, who: Headers): Promise<Res>;
}

const opened: Harness[] = [];
afterEach(async () => {
  for (const h of opened.splice(0)) await h.svc.close();
});

/** 메모리 조립의 서비스(실행기 없음: 설정형 명령은 실행기 없이 끝나야 한다, 계획 8.2 '응용') */
async function harness(): Promise<Harness> {
  const clock = fakeClock({ now: NOW });
  const identity = new FakeIdentity();
  const audit = new MemoryAuditChain();
  const svc = await createService({
    name: 'ops-svc',
    module: AppModule.register({ memory: true, auditChain: audit }),
    env: { PEAKET_ENV: 'ci' },
    clock,
    logDestination: quiet(),
    adminAuthz: identity,
  });
  const found: unknown = svc.app.get(COMMAND_STORE);
  if (!(found instanceof MemoryCommandStore)) throw new Error('메모리 조립의 명령 저장소가 아니다');
  const h: Harness = {
    svc,
    clock,
    identity,
    audit,
    store: found,
    maintain: svc.app.get(MaintainCommands),
    post: (url, who, body) =>
      svc.http.inject({ method: 'POST', url, headers: { ...(url === '/v1/ops/commands' ? { 'idempotency-key': randomUUID() } : {}), ...who, 'content-type': 'application/json' }, payload: JSON.stringify(body) }),
    get: (url, who) => svc.http.inject({ method: 'GET', url, headers: who }),
  };
  opened.push(h);
  return h;
}

const json = (r: { payload: string }) => (r.payload === '' ? {} : (JSON.parse(r.payload) as Record<string, unknown>));
const slug = (r: { payload: string }) => String(json(r).type ?? '').split('/').pop();
const idOf = (r: { payload: string }) => json(r).commandId as string;
const iso = (ms: number) => new Date(ms).toISOString();
const logLevel = (params: Record<string, unknown>) => ({ type: 'LOG_LEVEL', reason: '로그 올림', params });
const featureOff = (params: Record<string, unknown>) => ({ type: 'FEATURE_OFF', reason: '후기 기능 끄기', params });
/** 받는 쪽 운영 해독기로 읽은 n번째 설정 사건 */
const decoded = (h: { store: MemoryCommandStore }, i: number) => controlEventCodec.setting(Buffer.from(h.store.outboxSettings()[i]!.message.payload));
/** 명령 행·감사 기록·설정 사건 수(거절 뒤 0건을 본다) */
const counts = async (h: Harness) => ({
  commands: (await h.store.list({ limit: 100 })).items.length,
  audits: h.audit.entries.length,
  settings: h.store.outboxSettings().length,
});

describe('F025-SET 매개변수 허용 목록(ADR-0365 결정 13, B2·B5)', () => {
  test('F025-SET ① 명령 8은 일곱 서비스 × DEBUG·TRACE만 받고, 목록 밖 서비스·수준·모르는 칸은 도메인에서 INVALID다', () => {
    expect([...SETTING_COMMAND_TYPES]).toEqual(['BOT_LEVEL', 'LOG_LEVEL', 'FEATURE_OFF']);
    expect([...LOG_LEVEL_SERVICES].sort()).toEqual([...READERS].sort());
    expect([...LOG_LEVEL_RAISED].sort()).toEqual(['DEBUG', 'TRACE']);
    for (const service of READERS) {
      for (const level of ['DEBUG', 'TRACE']) expect(logLevelParamsOf({ service, level }), `${service} ${level}`).toEqual({ service, level });
    }
    const bad: [string, Record<string, unknown>][] = [
      // 설정을 읽지 않는 셋(적용 확인이 '아무것도 안 바뀌었는데 확인됨'이 되지 않게, ADR-0365 결정 13)
      ['admission-ctrl', { service: 'admission-ctrl', level: 'DEBUG' }],
      ['realtime-gw', { service: 'realtime-gw', level: 'DEBUG' }],
      ['trust-svc', { service: 'trust-svc', level: 'DEBUG' }],
      ['없는 이름', { service: 'nope-svc', level: 'DEBUG' }],
      ['대문자', { service: 'QUEUE-SVC', level: 'DEBUG' }],
      ['콜론', { service: 'queue-svc:x', level: 'DEBUG' }],
      ['따옴표', { service: 'queue"svc', level: 'DEBUG' }],
      ['빈 글', { service: '', level: 'DEBUG' }],
      ['서비스 없음', { level: 'DEBUG' }],
      ['INFO(기본값은 명령으로 올리지 않는다)', { service: 'queue-svc', level: 'INFO' }],
      ['소문자 수준', { service: 'queue-svc', level: 'debug' }],
      ['모르는 수준', { service: 'queue-svc', level: 'WARN' }],
      ['수준 없음', { service: 'queue-svc' }],
      ['모르는 칸', { service: 'queue-svc', level: 'DEBUG', ttl: 60 }],
    ];
    for (const [label, p] of bad) {
      expect(() => logLevelParamsOf(p), label).toThrow(CommandInputRejected);
      // 접수 검사(checkCommandParams)도 같은 갈래로 닫는다
      expect(() => checkCommandParams('LOG_LEVEL', p, NOW), label).toThrow(CommandInputRejected);
    }
  });

  test('F025-SET ② 명령 9는 reviews만 받고 wishlist·빈 글·REVIEWS·없음·모르는 칸은 도메인에서 INVALID다', () => {
    expect([...FEATURE_FLAGS]).toEqual(['reviews']);
    expect(featureOffParamsOf({ flag: 'reviews' })).toEqual({ flag: 'reviews' });
    for (const [label, p] of [
      ['wishlist', { flag: 'wishlist' }],
      ['빈 글', { flag: '' }],
      ['대문자', { flag: 'REVIEWS' }],
      ['없음', {}],
      ['모르는 칸', { flag: 'reviews', until: 'tomorrow' }],
    ] as const) {
      expect(() => featureOffParamsOf(p), label).toThrow(CommandInputRejected);
      expect(() => checkCommandParams('FEATURE_OFF', p, NOW), label).toThrow(CommandInputRejected);
    }
  });

  test('F025-SET ③ 바깥 HTTP: 목록 밖 명령 8·9는 422 invalid-command이고 detail은 어긋난 칸 이름이며 명령·감사·설정 사건이 0건이다', async () => {
    const h = await harness();
    const op = h.identity.ops('operator');
    const cases: [string, unknown, string][] = [
      ['설정을 읽지 않는 서비스', logLevel({ service: 'realtime-gw', level: 'DEBUG' }), 'service'],
      ['대문자 서비스', logLevel({ service: 'Queue-svc', level: 'TRACE' }), 'service'],
      ['서비스 없음', logLevel({ level: 'DEBUG' }), 'service'],
      ['INFO', logLevel({ service: 'queue-svc', level: 'INFO' }), 'level'],
      ['수준 없음', logLevel({ service: 'queue-svc' }), 'level'],
      ['모르는 칸(명령 8)', logLevel({ service: 'queue-svc', level: 'DEBUG', minutes: 5 }), 'minutes'],
      ['모르는 플래그', featureOff({ flag: 'wishlist' }), 'flag'],
      ['빈 플래그', featureOff({ flag: '' }), 'flag'],
      ['모르는 칸(명령 9)', featureOff({ flag: 'reviews', note: 'x' }), 'note'],
    ];
    for (const [label, body, field] of cases) {
      const r = await h.post('/v1/ops/commands', op, body);
      expect(r.statusCode, `${label} ${r.payload}`).toBe(422);
      expect(slug(r), label).toBe('invalid-command');
      expect(json(r).detail, label).toBe(field);
      // 미리보기도 같은 검사를 지난다
      const preview = await h.post('/v1/ops/command-dry-runs', op, body);
      expect([preview.statusCode, slug(preview)], label).toEqual([422, 'invalid-command']);
    }
    expect(await counts(h)).toEqual({ commands: 0, audits: 0, settings: 0 });
  });
});

describe('F025-SET 사건 꼴(도메인, ADR-0365 결정 13, B1·B3~B6)', () => {
  test('F025-SET ④ settingDraftOf: 명령 8 실행은 {level}·만료 있음, 만료·되돌리기는 {level: INFO}·만료 없음, 대상은 그 서비스다', () => {
    const c = { type: 'LOG_LEVEL' as const, params: { service: 'identity-svc', level: 'TRACE' } };
    expect(settingDraftOf(c, 'APPLY')).toEqual({ kind: 'LOG_LEVEL', scope: 'PLATFORM', target: 'identity-svc', value: { level: 'TRACE' }, expires: true });
    for (const phase of ['EXPIRE', 'REVERT'] as const) {
      expect(settingDraftOf(c, phase), phase).toEqual({ kind: 'LOG_LEVEL', scope: 'PLATFORM', target: 'identity-svc', value: { level: 'INFO' }, expires: false });
    }
    expect(settingLedgerKindOf(settingDraftOf(c, 'APPLY')!)).toBe('SETTING:LOG_LEVEL:identity-svc');
  });

  test('F025-SET ⑤ settingDraftOf: 명령 9는 FEATURE_FLAG 대상 reviews에 실행 {enabled: false}, 되돌리기 {enabled: true}이고 만료가 없다', () => {
    const c = { type: 'FEATURE_OFF' as const, params: { flag: 'reviews' } };
    expect(settingDraftOf(c, 'APPLY')).toEqual({ kind: 'FEATURE_FLAG', scope: 'PLATFORM', target: 'reviews', value: { enabled: false }, expires: false });
    expect(settingDraftOf(c, 'REVERT')).toEqual({ kind: 'FEATURE_FLAG', scope: 'PLATFORM', target: 'reviews', value: { enabled: true }, expires: false });
    expect(settingLedgerKindOf(settingDraftOf(c, 'APPLY')!)).toBe('SETTING:FEATURE_FLAG:reviews');
  });

  test('F025-SET ⑥ settingDraftOf: 명령 5 실행은 reassessMode가 없으면 SHADOW, 되돌리기는 직전 값 또는 {STANDARD, SHADOW}이고 대상이 없다', () => {
    expect(BOT_LEVEL_DEFAULT).toEqual({ level: 'STANDARD', reassessMode: 'SHADOW' });
    const plain = settingDraftOf({ type: 'BOT_LEVEL', params: { level: 'AGGRESSIVE' } }, 'APPLY')!;
    expect(plain).toMatchObject({ kind: 'BOT_LEVEL', scope: 'PLATFORM', value: { level: 'AGGRESSIVE', reassessMode: 'SHADOW' }, expires: false });
    expect(plain.target ?? '').toBe('');
    expect(settingLedgerKindOf(plain)).toBe('SETTING:BOT_LEVEL:');
    const enforce = settingDraftOf({ type: 'BOT_LEVEL', params: { level: 'RELAXED', reassessMode: 'ENFORCE' } }, 'APPLY')!;
    expect(enforce.value).toEqual({ level: 'RELAXED', reassessMode: 'ENFORCE' });
    // 되돌리기: 직전에 ACKED였던 명령 5의 값을 부르는 쪽이 넘긴다. 없으면 기본
    const revertTo = settingDraftOf({ type: 'BOT_LEVEL', params: { level: 'RELAXED' } }, 'REVERT', { previousBotLevel: { level: 'AGGRESSIVE', reassessMode: 'OFF' } })!;
    expect(revertTo.value).toEqual({ level: 'AGGRESSIVE', reassessMode: 'OFF' });
    expect(settingDraftOf({ type: 'BOT_LEVEL', params: { level: 'RELAXED' } }, 'REVERT')!.value).toEqual({ level: 'STANDARD', reassessMode: 'SHADOW' });
  });

  test('F025-SET ⑦ settingDraftOf는 설정형이 아닌 명령에 undefined이고, 목록 밖 값(접수 검사를 빼도)은 사건 꼴을 만들지 않는다', () => {
    expect(settingDraftOf({ type: 'ADMISSION_TARGET', params: { eventId: randomUUID(), target: 3_000 } }, 'APPLY')).toBeUndefined();
    expect(settingDraftOf({ type: 'KILL_SWITCH', params: { scope: 'PLATFORM' } }, 'APPLY')).toBeUndefined();
    // 겹친 가드: 접수 검사를 지나지 않은 레거시 행이 와도 사건 꼴 쪽에서 막는다
    for (const params of [{ service: 'trust-svc', level: 'DEBUG' }, { service: 'queue-svc', level: 'INFO' }, { level: 'DEBUG' }]) {
      expect(() => settingDraftOf({ type: 'LOG_LEVEL', params }, 'APPLY'), JSON.stringify(params)).toThrow(CommandInputRejected);
    }
    expect(() => settingDraftOf({ type: 'FEATURE_OFF', params: { flag: 'wishlist' } }, 'APPLY')).toThrow(CommandInputRejected);
  });

  test('F025-SET ⑧ settingReceiverOf: 메시지 키마다 받는 서비스 하나, 표 밖은 undefined다(ADR-0365 결정 10)', () => {
    const eventId = randomUUID();
    expect(settingReceiverOf('PLATFORM:LOG_LEVEL:queue-svc')).toBe('queue-svc');
    expect(settingReceiverOf('PLATFORM:LOG_LEVEL:ticket-svc')).toBe('ticket-svc');
    expect(settingReceiverOf('PLATFORM:FEATURE_FLAG:reviews')).toBe('core-svc');
    expect(settingReceiverOf(`${eventId}:PG_ASSIGNMENT:`)).toBe('payment-svc');
    expect(settingReceiverOf('PLATFORM:BOT_LEVEL:')).toBe('trust-svc');
    for (const key of ['PLATFORM:FEATURE_FLAG:wishlist', 'PLATFORM:DEGRADED_MODE:PAYMENT_PG_FALLBACK', 'PLATFORM:LOG_SAMPLING:*', 'PLATFORM:AUTOMATION_STOP:', 'garbage', '']) {
      expect(settingReceiverOf(key), key).toBeUndefined();
    }
  });
});

describe('F025-SET 실행·되돌리기·만료의 사건(바깥 HTTP·정비 바퀴, B1·B3·B4·B5)', () => {
  test('F025-SET ⑨ 명령 8 실행은 실행기 없이 ACKED이고 같은 쓰기에 사건 하나(키·값·expiresAt = 판 + 30분)와 적용 확인 행 하나가 있다', async () => {
    const h = await harness();
    const op = h.identity.ops('operator');
    h.clock.advance(1_234);
    const at = NOW + 1_234;
    const r = await h.post('/v1/ops/commands', op, logLevel({ service: 'payment-svc', level: 'TRACE' }));
    expect(r.statusCode, r.payload).toBe(201);
    const id = idOf(r);
    expect(json(r)).toMatchObject({ type: 'LOG_LEVEL', state: 'ACKED', expiresAt: iso(at + LOG_LEVEL_TTL) });
    expect((await h.store.find(id))?.result).toEqual({ setting: 'LOG_LEVEL', scope: 'PLATFORM' });
    const rows = h.store.outboxSettings();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.message.topic).toBe('control.settings');
    expect(rows[0]!.message.key).toBe('PLATFORM:LOG_LEVEL:payment-svc');
    const e = decoded(h, 0);
    // 원장이 빈 첫 판은 지금 밀리초다(max(0 + 1, 지금))
    expect(e).toMatchObject({ commandId: id, key: 'LOG_LEVEL', scope: 'PLATFORM', value: { level: 'TRACE' }, occurredAt: at, expiresAt: at + LOG_LEVEL_TTL });
    expect(e.eventKey).toBe(settingEventKey(id, 'LOG_LEVEL', 'PLATFORM'));
    expect(e.actor).toBe(h.store.requesterRefOf(id));
    expect(e.actor).not.toBe(op['x-user-id']);
    // 적용 확인 행(같은 쓰기, ADR-0365 결정 14): 받는 서비스 payment-svc, 아직 나가지 않은 Outbox 행을 가리킨다
    const row = await h.store.latestOf(id);
    expect(row).toMatchObject({ commandId: id, stage: 'ACKED', version: at, messageKey: 'PLATFORM:LOG_LEVEL:payment-svc', service: 'payment-svc', status: 'CHECKING', writtenAtMs: at, alertOpen: false, pods: [] });
    expect(await h.store.outboxOf(row!.outboxId)).toEqual({ exists: true });
    expect(h.audit.entries.filter((x) => x.recordId === id).map((x) => x.recordType)).toContain('COMMAND_ACKED');
  });

  test('F025-SET ⑩ 명령 8 만료: 판 + 30분 − 1ms에는 그대로, 정각에 AUTO_EXPIRED와 같은 쓰기의 {level: INFO}(만료 없음) 새 사건·새 판·새 적용 확인 행이다', async () => {
    const h = await harness();
    const op = h.identity.ops('operator');
    h.clock.advance(1_234);
    const at = NOW + 1_234;
    const id = idOf(await h.post('/v1/ops/commands', op, logLevel({ service: 'queue-svc', level: 'DEBUG' })));
    expect(await h.maintain.runOnce(at + LOG_LEVEL_TTL - 1)).toMatchObject({ autoExpired: 0 });
    expect((await h.store.find(id))?.state).toBe('ACKED');
    expect(h.store.outboxSettings()).toHaveLength(1);
    expect(await h.maintain.runOnce(at + LOG_LEVEL_TTL)).toMatchObject({ autoExpired: 1 });
    expect((await h.store.find(id))?.state).toBe('AUTO_EXPIRED');
    expect(h.store.outboxSettings()).toHaveLength(2);
    expect(h.store.outboxSettings()[1]!.message.key).toBe('PLATFORM:LOG_LEVEL:queue-svc');
    const e = decoded(h, 1);
    expect(e).toMatchObject({ commandId: id, key: 'LOG_LEVEL', scope: 'PLATFORM', value: { level: 'INFO' }, expiresAt: null, occurredAt: at + LOG_LEVEL_TTL });
    // 세 단계는 같은 eventKey이고 받는 쪽은 더 큰 판으로 가린다
    expect(e.eventKey).toBe(decoded(h, 0).eventKey);
    expect(e.occurredAt).toBeGreaterThan(decoded(h, 0).occurredAt);
    expect(await h.store.latestOf(id)).toMatchObject({ stage: 'AUTO_EXPIRED', version: at + LOG_LEVEL_TTL, messageKey: 'PLATFORM:LOG_LEVEL:queue-svc', service: 'queue-svc', status: 'CHECKING' });
    expect(h.audit.entries.filter((x) => x.recordId === id).map((x) => x.recordType)).toContain('COMMAND_AUTO_EXPIRED');
  });

  test('F025-SET ⑪ 명령 8 되돌리기는 REVERTED와 같은 쓰기의 {level: INFO} 새 사건이고 그 뒤 만료 바퀴는 사건을 더 내지 않는다', async () => {
    const h = await harness();
    const op = h.identity.ops('operator');
    h.clock.advance(1_234);
    const id = idOf(await h.post('/v1/ops/commands', op, logLevel({ service: 'ticket-svc', level: 'DEBUG' })));
    h.clock.advance(7 * MIN);
    const r = await h.post(`/v1/ops/commands/${id}/reversions`, op, { reason: '로그 되돌리기' });
    expect([r.statusCode, json(r).state], r.payload).toEqual([200, 'REVERTED']);
    expect(h.store.outboxSettings()).toHaveLength(2);
    expect(decoded(h, 1)).toMatchObject({ commandId: id, key: 'LOG_LEVEL', value: { level: 'INFO' }, expiresAt: null, occurredAt: NOW + 1_234 + 7 * MIN });
    expect(await h.store.latestOf(id)).toMatchObject({ stage: 'REVERTED', service: 'ticket-svc' });
    // 되돌린 명령은 만료 대상이 아니다(사건이 늘지 않는다)
    await h.maintain.runOnce(NOW + 1_234 + LOG_LEVEL_TTL);
    expect(h.store.outboxSettings()).toHaveLength(2);
  });

  test('F025-SET ⑫ 명령 9 실행은 {enabled: false}(만료 없음)·받는 서비스 core-svc이고, 되돌리기는 {enabled: true} 새 사건이며 delivery는 APPLY_CHECK다', async () => {
    const h = await harness();
    const op = h.identity.ops('operator');
    h.clock.advance(1_234);
    const created = await h.post('/v1/ops/commands', op, featureOff({ flag: 'reviews' }));
    expect(created.statusCode, created.payload).toBe(201);
    const id = idOf(created);
    expect(json(created).state).toBe('ACKED');
    expect(json(created).expiresAt ?? null).toBeNull();
    expect(h.store.outboxSettings()[0]!.message.key).toBe('PLATFORM:FEATURE_FLAG:reviews');
    expect(decoded(h, 0)).toMatchObject({ commandId: id, key: 'FEATURE_FLAG', scope: 'PLATFORM', value: { enabled: false }, expiresAt: null, occurredAt: NOW + 1_234 });
    expect(await h.store.latestOf(id)).toMatchObject({ stage: 'ACKED', messageKey: 'PLATFORM:FEATURE_FLAG:reviews', service: 'core-svc', status: 'CHECKING' });
    // 상세의 delivery(B16): 적용 확인 바퀴가 없는 조립이라 CHECKING에 남고, 본 파드가 없다
    const detail = json(await h.get(`/v1/ops/commands/${id}`, op));
    expect(detail.delivery).toEqual({ kind: 'APPLY_CHECK', applyStatus: 'CHECKING', targetCount: 0, ackedCount: 0, unackedTargets: [] });
    h.clock.advance(2 * MIN);
    const r = await h.post(`/v1/ops/commands/${id}/reversions`, op, { reason: '후기 다시 켜기' });
    expect([r.statusCode, json(r).state], r.payload).toEqual([200, 'REVERTED']);
    expect(h.store.outboxSettings()).toHaveLength(2);
    expect(decoded(h, 1)).toMatchObject({ commandId: id, key: 'FEATURE_FLAG', value: { enabled: true }, expiresAt: null, occurredAt: NOW + 1_234 + 2 * MIN });
    expect(decoded(h, 1).eventKey).toBe(settingEventKey(id, 'FEATURE_FLAG', 'PLATFORM'));
    expect(await h.store.latestOf(id)).toMatchObject({ stage: 'REVERTED', service: 'core-svc' });
    expect(h.audit.entries.filter((x) => x.recordId === id).map((x) => x.recordType)).toContain('COMMAND_REVERTED');
  });
});

describe('F025-SET 명령 5의 실행·되돌리기(유스케이스, B6)', () => {
  const REQUESTER = '0194f025-0000-7000-8000-000000000001';
  const APPROVER = '0194f025-0000-7000-8000-000000000002';
  const actor = (accountId: string): CommandExecutionActor => ({ accountId, sessionId: `s-${accountId}`, role: 'commander' });
  const fixture = () => {
    const audit = new MemoryAuditChain();
    const store = new MemoryCommandStore(audit);
    const execute = new ExecuteCommand(store);
    return { audit, store, create: new CreateCommand(store, execute), decide: new DecideCommand(store, execute), revert: new RevertCommand(store) };
  };
  /** 명령 5를 commander가 내고 다른 commander가 승인한다(2인, control-tower §3 명령 5) */
  const botLevel = async (f: ReturnType<typeof fixture>, params: Record<string, unknown>, nowMs: number) => {
    const c = await f.create.execute({ type: 'BOT_LEVEL', reason: '봇 급증', params, requestedBy: REQUESTER, requestedRole: 'commander', nowMs, actor: actor(REQUESTER) });
    expect(c.state).toBe('PENDING_APPROVAL');
    return f.decide.approve({ commandId: c.commandId, approverRef: APPROVER, approverRole: 'commander', nowMs: nowMs + 1, actor: actor(APPROVER) });
  };

  test('F025-SET ⑬ 명령 5 실행은 ACKED와 같은 쓰기의 BOT_LEVEL 사건(reassessMode 없으면 SHADOW)이고 받는 서비스는 trust-svc다', async () => {
    const f = fixture();
    const acked = await botLevel(f, { level: 'AGGRESSIVE' }, NOW + 1_234);
    expect(acked.state).toBe('ACKED');
    const rows = f.store.outboxSettings();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.message.key).toBe('PLATFORM:BOT_LEVEL:');
    expect(controlEventCodec.setting(Buffer.from(rows[0]!.message.payload))).toMatchObject({ commandId: acked.commandId, key: 'BOT_LEVEL', scope: 'PLATFORM', value: { level: 'AGGRESSIVE', reassessMode: 'SHADOW' }, expiresAt: null, occurredAt: NOW + 1_235 });
    expect(await f.store.latestOf(acked.commandId)).toMatchObject({ stage: 'ACKED', messageKey: 'PLATFORM:BOT_LEVEL:', service: 'trust-svc' });
  });

  test('F025-SET ⑭ 명령 5 되돌리기는 마지막 ACKED 명령 5의 값이고, 그런 명령이 없으면 {STANDARD, SHADOW}다', async () => {
    const f = fixture();
    // 처음 명령 5만 있으면 되돌리기는 기본값
    const first = await botLevel(f, { level: 'AGGRESSIVE', reassessMode: 'ENFORCE' }, NOW);
    const r1 = await f.revert.execute({ commandId: first.commandId, reason: '기본으로', actor: actor(APPROVER), nowMs: NOW + 10 });
    expect(r1).toMatchObject({ pending: false, command: { state: 'REVERTED' } });
    const v1 = controlEventCodec.setting(Buffer.from(f.store.outboxSettings()[1]!.message.payload));
    expect(v1).toMatchObject({ commandId: first.commandId, key: 'BOT_LEVEL', value: { level: 'STANDARD', reassessMode: 'SHADOW' } });

    // ACKED인 명령 5(A) 뒤에 낸 명령 5(B)를 되돌리면 A의 값이다
    const a = await botLevel(f, { level: 'RELAXED', reassessMode: 'OFF' }, NOW + 1 * MIN);
    const b = await botLevel(f, { level: 'AGGRESSIVE' }, NOW + 2 * MIN);
    expect([a.state, b.state]).toEqual(['ACKED', 'ACKED']);
    const before = f.store.outboxSettings().length;
    const r2 = await f.revert.execute({ commandId: b.commandId, reason: '직전 강도로', actor: actor(REQUESTER), nowMs: NOW + 3 * MIN });
    expect(r2.command.state).toBe('REVERTED');
    expect(f.store.outboxSettings()).toHaveLength(before + 1);
    const v2 = controlEventCodec.setting(Buffer.from(f.store.outboxSettings().at(-1)!.message.payload));
    expect(v2).toMatchObject({ commandId: b.commandId, key: 'BOT_LEVEL', scope: 'PLATFORM', value: { level: 'RELAXED', reassessMode: 'OFF' }, occurredAt: NOW + 3 * MIN });
    expect(await f.store.latestOf(b.commandId)).toMatchObject({ stage: 'REVERTED', service: 'trust-svc' });
  });
});

describe('F025-SET delivery 글 꼴(B16, 계획 8.2 applyCheckViewOf)', () => {
  test('F025-SET ⑮ applyCheckViewOf는 kind APPLY_CHECK·applyStatus·센 파드 수와 못 미친 파드를 <파드>:<판>(판 없으면 <파드>:-)로 보인다', () => {
    const row: ApplyCheckRow = {
      commandId: randomUUID(),
      stage: 'ACKED',
      version: 10,
      messageKey: 'PLATFORM:LOG_LEVEL:queue-svc',
      outboxId: randomUUID(),
      service: 'queue-svc',
      status: 'UNCONFIRMED',
      writtenAtMs: NOW,
      sentAtMs: NOW + 400,
      pods: [{ pod: 'queue-svc-7d9f-a', version: 9 }, { pod: 'queue-svc-7d9f-b' }],
      targetCount: 3,
      ackedCount: 1,
      alertOpen: true,
      nextCheckAtMs: NOW + 400 + 90_000,
      updatedAtMs: NOW + 400 + 30_000,
    };
    expect(applyCheckViewOf(row)).toEqual({ kind: 'APPLY_CHECK', applyStatus: 'UNCONFIRMED', targetCount: 3, ackedCount: 1, unackedTargets: ['queue-svc-7d9f-a:9', 'queue-svc-7d9f-b:-'] });
    expect(applyCheckViewOf({ ...row, status: 'CONFIRMED', pods: [], ackedCount: 3, alertOpen: false })).toEqual({ kind: 'APPLY_CHECK', applyStatus: 'CONFIRMED', targetCount: 3, ackedCount: 3, unackedTargets: [] });
  });
});

describe('F025-SET 정비 바퀴 단독 조립', () => {
  test('F025-SET ⑯ 정비 바퀴가 설정형 명령의 사건을 쓰려면 저장소 쓰기만 있으면 된다(덧붙임 없는 MaintainCommands)', async () => {
    const audit = new MemoryAuditChain();
    const store = new MemoryCommandStore(audit);
    const execute = new ExecuteCommand(store);
    const create = new CreateCommand(store, execute);
    const c = await create.execute({ type: 'LOG_LEVEL', reason: '로그', params: { service: 'core-svc', level: 'DEBUG' }, requestedBy: randomUUID(), requestedRole: 'operator', nowMs: NOW, actor: { accountId: randomUUID(), sessionId: 's', role: 'operator' } });
    expect(c.state).toBe('ACKED');
    const maintain = new MaintainCommands(store, new ComputeDryRun());
    expect(await maintain.runOnce(NOW + LOG_LEVEL_TTL)).toMatchObject({ autoExpired: 1 });
    expect(store.outboxSettings().map((s) => [s.message.key, (JSON.parse(Buffer.from(s.message.payload).toString('utf8')) as { value: unknown }).value])).toEqual([
      ['PLATFORM:LOG_LEVEL:core-svc', { level: 'DEBUG' }],
      ['PLATFORM:LOG_LEVEL:core-svc', { level: 'INFO' }],
    ]);
  });
});
