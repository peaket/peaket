// 설정 사건 일반 내기(ADR-0349 결정 5, asyncapi control.settings·SettingChanged, 계획 6절 B27). 장부 항목 밖이라 이름은 B360-SET과 번호다.
// 정본 값: 메시지 키 '<범위>:<종류>:<대상>'(대상이 없으면 비움), 값은 SettingChanged 칸(commandId·key·scope·value·expiresAt?·actor·occurredAt·eventKey),
// 판은 occurredAt, eventKey는 (명령 ID, 종류, 범위)로 정한 UUID(같은 셋이면 같은 값), 종류는 계약 key 열거
// [BOT_LEVEL, LOG_LEVEL, FEATURE_FLAG, DEGRADED_MODE, LOBBY_BANNER, PG_ASSIGNMENT, AUTOMATION_STOP] 밖이면 거절, 롤백이면 행이 없다.
// 받는 쪽은 플랫폼 운영 해독기(controlEventCodec.setting, ADR-0333 결정 4)로 되읽는다. DB Outbox 행(publishSetting + writeOutbox)과 릴레이는 통합 시험 몫이다.
import { randomUUID } from 'node:crypto';
import { controlEventCodec } from '@peaket/platform';
import { describe, expect, test } from 'vitest';
import { MemoryAuditChain } from '../src/modules/audit/index.js';
import { MemoryCommandStore, SettingChangeRejected, settingEventKey, settingOutboxMessage, type SettingChange } from '../src/modules/commands/index.js';

const AT = Date.parse('2026-11-23T05:06:07.089Z');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** 계약 열거(asyncapi SettingChanged.key) */
const CONTRACT_KINDS = ['BOT_LEVEL', 'LOG_LEVEL', 'FEATURE_FLAG', 'DEGRADED_MODE', 'LOBBY_BANNER', 'PG_ASSIGNMENT', 'AUTOMATION_STOP'];

const setting = (o: Partial<SettingChange> = {}): SettingChange => ({
  kind: 'PG_ASSIGNMENT',
  scope: randomUUID(),
  value: { primaryPg: 'TOSS', fallbackPg: 'PORTONE' },
  commandId: randomUUID(),
  actorRef: randomUUID(),
  occurredAtMs: AT,
  ...o,
});

describe('B360-SET 설정 사건 꼴(ADR-0349 결정 5, B27)', () => {
  test('B360-SET ① 키는 <범위>:<종류>:<대상>이고 값은 받는 쪽 해독기가 SettingChanged 칸 그대로 되읽는다(대상 없음·있음, 만료 있음)', () => {
    const eventId = randomUUID();
    const pg = setting({ scope: eventId });
    const m1 = settingOutboxMessage(pg);
    expect(m1.topic).toBe('control.settings');
    expect(m1.key).toBe(`${eventId}:PG_ASSIGNMENT:`);
    expect(controlEventCodec.setting(Buffer.from(m1.payload))).toEqual({
      commandId: pg.commandId,
      key: 'PG_ASSIGNMENT',
      scope: eventId,
      value: { primaryPg: 'TOSS', fallbackPg: 'PORTONE' },
      expiresAt: null,
      actor: pg.actorRef,
      occurredAt: AT,
      eventKey: settingEventKey(pg.commandId, 'PG_ASSIGNMENT', eventId),
    });
    const expires = AT + 30 * 60_000;
    const log = setting({ kind: 'LOG_LEVEL', scope: 'PLATFORM', target: 'purchase-svc', value: { level: 'TRACE' }, expiresAtMs: expires });
    const m2 = settingOutboxMessage(log);
    expect(m2.key).toBe('PLATFORM:LOG_LEVEL:purchase-svc');
    expect(controlEventCodec.setting(Buffer.from(m2.payload))).toMatchObject({ key: 'LOG_LEVEL', scope: 'PLATFORM', value: { level: 'TRACE' }, expiresAt: expires, occurredAt: AT });
    // 원문 JSON의 시각은 ISO 밀리초 UTC다
    expect(JSON.parse(Buffer.from(m2.payload).toString('utf8'))).toMatchObject({ occurredAt: '2026-11-23T05:06:07.089Z', expiresAt: new Date(expires).toISOString() });
    const flag = settingOutboxMessage(setting({ kind: 'FEATURE_FLAG', scope: 'PLATFORM', target: 'reviews', value: { enabled: false } }));
    expect(flag.key).toBe('PLATFORM:FEATURE_FLAG:reviews');
  });

  test('B360-SET ② eventKey는 (명령 ID, 종류, 범위)가 같으면 같고 하나라도 다르면 다르며 UUID 꼴이다', () => {
    const commandId = randomUUID();
    const scope = randomUUID();
    const a = settingEventKey(commandId, 'PG_ASSIGNMENT', scope);
    expect(a).toMatch(UUID);
    expect(settingEventKey(commandId, 'PG_ASSIGNMENT', scope)).toBe(a);
    // 같은 셋을 다시 내면(판만 다름) 값의 eventKey가 같다(받는 쪽 중복 제거)
    const first = JSON.parse(Buffer.from(settingOutboxMessage(setting({ commandId, scope, occurredAtMs: AT })).payload).toString('utf8')) as { eventKey: string };
    const again = JSON.parse(Buffer.from(settingOutboxMessage(setting({ commandId, scope, occurredAtMs: AT + 1 })).payload).toString('utf8')) as { eventKey: string };
    expect(again.eventKey).toBe(first.eventKey);
    const others = [settingEventKey(randomUUID(), 'PG_ASSIGNMENT', scope), settingEventKey(commandId, 'DEGRADED_MODE', scope), settingEventKey(commandId, 'PG_ASSIGNMENT', randomUUID())];
    for (const o of others) expect(o).not.toBe(a);
    expect(new Set(others).size).toBe(3);
  });

  test('B360-SET ③ 계약 열거의 종류는 모두 받고, 열거 밖 종류·범위의 콜론·값 꼴 틀림은 SettingChangeRejected다', () => {
    const values: Record<string, Record<string, unknown>> = {
      BOT_LEVEL: { level: 'AGGRESSIVE', reassessMode: 'SHADOW' },
      LOG_LEVEL: { level: 'DEBUG' },
      FEATURE_FLAG: { enabled: true },
      DEGRADED_MODE: { enabled: true },
      LOBBY_BANNER: { templateId: 'tpl-delay' },
      PG_ASSIGNMENT: { primaryPg: 'PORTONE' },
      AUTOMATION_STOP: { stopped: true },
    };
    for (const kind of CONTRACT_KINDS) {
      expect(() => settingOutboxMessage(setting({ kind, scope: 'PLATFORM', value: values[kind]!, ...(kind === 'LOG_LEVEL' ? { expiresAtMs: AT + 60_000 } : {}) })), kind).not.toThrow();
    }
    expect(() => settingOutboxMessage(setting({ kind: 'NOT_A_SETTING_KIND' }))).toThrow(SettingChangeRejected);
    expect(() => settingOutboxMessage(setting({ scope: 'PLATFORM:x' }))).toThrow(SettingChangeRejected);
    expect(() => settingOutboxMessage(setting({ value: { primaryPg: 'KAKAOPAY' } }))).toThrow(SettingChangeRejected);
    expect(() => settingOutboxMessage(setting({ actorRef: 'not-a-uuid' }))).toThrow(SettingChangeRejected);
  });

  test('B360-SET ④ 명령 쓰기가 되돌아가면 설정 사건 행이 남지 않고, 꼴이 틀린 사건은 같은 쓰기의 상태 변경까지 되돌린다(메모리 저장소)', async () => {
    const store = new MemoryCommandStore(new MemoryAuditChain());
    const eventId = randomUUID();
    const { command } = await store.insert({
      commandId: randomUUID(),
      type: 'PG_ASSIGN',
      reason: '지정',
      params: { eventId, primaryPg: 'TOSS' },
      eventId,
      requestedBy: randomUUID(),
      requestedRole: 'operator',
      nowMs: AT,
      dryRun: {},
      approvalMode: 'ONE',
    });
    // 성공한 쓰기 하나와 종류 둘(다른 종류 둘 이상)
    await store.mutate(command.commandId, async (w) => {
      await w.setting!(setting({ commandId: command.commandId, scope: eventId }));
      await w.setting!(setting({ commandId: command.commandId, kind: 'LOBBY_BANNER', scope: eventId, value: { templateId: 'tpl-1' } }));
    });
    expect(store.outboxSettings().map((s) => s.message.key)).toEqual([`${eventId}:PG_ASSIGNMENT:`, `${eventId}:LOBBY_BANNER:`]);
    // 던져서 되돌아간 쓰기
    await expect(
      store.mutate(command.commandId, async (w) => {
        await w.setting!(setting({ commandId: command.commandId, scope: eventId }));
        throw new Error('되돌림');
      }),
    ).rejects.toThrow('되돌림');
    expect(store.outboxSettings()).toHaveLength(2);
    // 꼴이 틀린 사건: 같은 쓰기의 상태 변경도 남지 않는다
    const before = (await store.find(command.commandId))!.state;
    await expect(
      store.mutate(command.commandId, async (w) => {
        await w.patch({ state: 'DISPATCHED', nowMs: AT });
        await w.setting!(setting({ commandId: command.commandId, kind: 'NOT_A_SETTING_KIND', scope: eventId }));
      }),
    ).rejects.toThrow(SettingChangeRejected);
    expect((await store.find(command.commandId))!.state).toBe(before);
    expect(store.outboxSettings()).toHaveLength(2);
  });
});
