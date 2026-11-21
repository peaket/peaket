// 설정 사건 일반 내기(ADR-0349 결정 5, ADR-0143 결정 3, docs/api/asyncapi.yaml control.settings·SettingChanged, BAT-360 B27).
// 설정형 명령은 상태 쓰기와 같은 트랜잭션의 Outbox 행(ops DB outbox, 마이그레이션 0024)으로 사건을 내고, 릴레이(src/relay.ts)가 control.settings로 보낸다.
// - 메시지 키: '<범위>:<종류>:<대상>'(대상이 없으면 비움, 예 '<회차>:PG_ASSIGNMENT:'). 같은 키는 같은 파티션·압축 단위다
// - 값: asyncapi SettingChanged 칸 그대로의 JSON(UTF-8 바이트). BAS-030 Avro 전까지 받는 쪽 운영 해독기(packages/platform/src/control-codec.ts)가 이 JSON을 읽는다
// - 판은 occurredAt(ISO 밀리초 UTC)이다. eventKey는 (명령 ID, 종류, 범위)로 정한 UUID라 같은 셋을 다시 내면 같은 값이다(받는 쪽 중복 제거, ADR-0052)
//   eventKey = SHA-256('PEAKET-setting-event-v1' ‖ 0x0a ‖ 명령 ID ‖ 0x0a ‖ 종류 ‖ 0x0a ‖ 범위)의 앞 16바이트에 판 8·변형 10 비트를 넣은 UUID(RFC 9562 §5.8)
// - 종류는 계약 생성물(@peaket/contracts/asyncapi SettingChanged.key)의 열거를 그대로 받는다. 계약에 종류가 더해지면(예 LOG_SAMPLING) 코드를 고치지 않고 낸다.
//   열거 밖 종류·계약 꼴에 맞지 않는 값은 던진다(트랜잭션째 되돌아간다)
// - 설정을 없애는 지우는 표시(Kafka 빈 값)는 지금 플랫폼 릴레이가 보내지 못해 여기서 내지 않는다(처음 쓰는 BAT-365가 릴레이와 함께 정한다)
// - Outbox 행은 트랜잭션의 마지막 문장으로 넣는다(ADR-0116 결정 3). 부르는 쪽이 지킨다
import { createHash } from 'node:crypto';
import { SettingChanged } from '@peaket/contracts/asyncapi';
import { CONTROL_TOPICS, systemClock, writeOutbox, type Clock, type DbTransaction, type OutboxMessage } from '@peaket/platform';
import type { SettingChange } from '../domain/ports.js';

/** eventKey 도메인 글. 규칙을 바꾸면 v2로 올린다 */
export const SETTING_EVENT_KEY_DOMAIN = 'PEAKET-setting-event-v1';

/** 계약 열거의 설정 종류(생성물에서 읽는다) */
export const SETTING_KINDS: readonly string[] = SettingChanged.shape.key.options;

/** 설정 사건이 계약 꼴에 맞지 않음(열거 밖 종류, 값·시각 꼴) */
export class SettingChangeRejected extends Error {
  constructor(readonly why: string) {
    super(`설정 사건이 계약 꼴이 아니다: ${why}`);
    this.name = 'SettingChangeRejected';
  }
}

/** (명령 ID, 종류, 범위)로 정한 eventKey(UUID 판 8) */
export function settingEventKey(commandId: string, kind: string, scope: string): string {
  const h = createHash('sha256').update(`${SETTING_EVENT_KEY_DOMAIN}\n${commandId}\n${kind}\n${scope}`, 'utf8').digest().subarray(0, 16);
  h[6] = (h[6]! & 0x0f) | 0x80;
  h[8] = (h[8]! & 0x3f) | 0x80;
  const x = h.toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

/** 메시지 키 '<범위>:<종류>:<대상>'(대상이 없으면 비움) */
export const settingMessageKey = (s: Pick<SettingChange, 'scope' | 'kind' | 'target'>): string => `${s.scope}:${s.kind}:${s.target ?? ''}`;

/**
 * 설정 사건 하나를 Outbox 메시지로 만든다(쓰지 않는다). 계약 생성물 SettingChanged로 꼴을 본다.
 * @throws SettingChangeRejected 열거 밖 종류, 범위가 비었음, 대상에 ':'가 있음, 값·시각·가명 참조가 계약 꼴이 아님
 */
export function settingOutboxMessage(s: SettingChange): OutboxMessage {
  if (!SETTING_KINDS.includes(s.kind)) throw new SettingChangeRejected(`kind:${s.kind}`);
  if (s.scope.length === 0 || s.scope.includes(':')) throw new SettingChangeRejected('scope');
  if (s.target !== undefined && s.target.includes(':')) throw new SettingChangeRejected('target');
  if (!Number.isSafeInteger(s.occurredAtMs) || (s.expiresAtMs !== undefined && !Number.isSafeInteger(s.expiresAtMs))) throw new SettingChangeRejected('time');
  const value = {
    commandId: s.commandId,
    key: s.kind,
    scope: s.scope,
    value: s.value,
    ...(s.expiresAtMs !== undefined ? { expiresAt: new Date(s.expiresAtMs).toISOString() } : {}),
    actor: s.actorRef,
    occurredAt: new Date(s.occurredAtMs).toISOString(),
    eventKey: settingEventKey(s.commandId, s.kind, s.scope),
  };
  const parsed = SettingChanged.safeParse(value);
  if (!parsed.success) throw new SettingChangeRejected(parsed.error.issues.map((i) => i.path.join('.') || 'value').join(','));
  return { topic: CONTROL_TOPICS.settings, key: settingMessageKey(s), payload: Buffer.from(JSON.stringify(value), 'utf8') };
}

/**
 * 설정 사건을 같은 트랜잭션의 Outbox 행으로 쓴다(ADR-0349 결정 5). 트랜잭션의 마지막 문장으로 부른다.
 * Outbox 행 ID(UUIDv7)는 clock으로 만든다(일 파티션이 그 날짜에 있어야 한다, ensureOutboxPartitions와 같은 시계).
 * @returns Outbox 행 ID
 * @throws SettingChangeRejected 계약 꼴이 아님(아무것도 쓰지 않는다)
 */
export async function publishSetting(tx: DbTransaction, setting: SettingChange, clock: Clock = systemClock): Promise<string> {
  const [id] = await writeOutbox(tx, clock, [settingOutboxMessage(setting)]);
  return id!;
}
