// 제어 사건 운영 해독기(ADR-0333 결정 4, docs/features/identity.md §3 '서비스에 잇기'). BAS-030의 Avro 전까지 JSON이다.
// - 종료 사건은 sessionId(비지 않은 글)만 꼭 요구하고 reason·accountId는 보지 않는다(이유 값이 새로 더해져도 거절이 빠지지 않게)
// - 시각은 ISO 시각 글(asyncapi)과 밀리초 수(Avro timestamp-millis) 둘 다 받는다. 종료 시각을 읽지 못하면 NaN을, 읽히면 그 수를 그대로 돌려준다.
//   믿을 범위(그 레코드의 Kafka 시각 기준)는 startControlSync가 보고, 읽지 못했거나 범위 밖이면 받은 때를 종료 시각으로 쓴다(닫힌 쪽 실패)
// - 설정 사건은 asyncapi SettingChanged의 칸 이름과 모양대로 읽는다. 플랫폼은 계약 생성물(@peaket/contracts)을 실행 때 싣지 않으므로
//   키·값 갈래 목록은 보지 않는다(추천 적용, 2026-11-21, BAT-059 구현, ADR-0333 결정 4). 다만 LOG_SAMPLING 값은 startControlSync가
//   logSamplingValue로 갈래와 범위를 본다(ADR-0334 결정 2)
// 던지면 startControlSync가 그 레코드를 건너뛰고 control_sync_skipped_total{reason="unreadable"}로 센다
import { z } from 'zod';
import type { ControlCodec, SessionTerminated, SettingChanged } from './control.js';

const ISO_TIME = z.iso.datetime({ offset: true });

/** ISO 시각 글이면 그 밀리초, 수면 그대로, 그 밖은 NaN */
function timeMs(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && ISO_TIME.safeParse(v).success) return Date.parse(v);
  return Number.NaN;
}

function jsonObject(value: Buffer, what: string): Record<string, unknown> {
  const o: unknown = JSON.parse(value.toString('utf8'));
  if (typeof o !== 'object' || o === null || Array.isArray(o)) throw new TypeError(`${what} 값이 JSON 객체가 아니다`);
  return o as Record<string, unknown>;
}

const SettingJson = z.object({
  commandId: z.string(),
  key: z.string().min(1),
  scope: z.string().min(1),
  value: z.unknown().refine((v) => v !== undefined, '값(value)이 없다'),
  expiresAt: z.union([ISO_TIME, z.number(), z.null()]).optional(),
  actor: z.string(),
  occurredAt: z.union([ISO_TIME, z.number()]),
  eventKey: z.string(),
});

/** LOG_SAMPLING의 oneIn 범위(asyncapi LogSamplingValue, ADR-0334 결정 1) */
const LogSamplingValue = z.object({ oneIn: z.int().min(1).max(10_000) });

/**
 * LOG_SAMPLING 값 갈래(asyncapi SettingChanged.value의 LogSamplingValue)를 읽는다(ADR-0334 결정 1·2).
 * oneIn 칸이 없는 값(다른 갈래·객체 아님)은 'branch', 1 이상 10,000 이하의 정수가 아니면 'range'다. 던지지 않는다(startControlSync가 경고 줄을 남기고 버린다)
 */
export function logSamplingValue(value: unknown): { oneIn: number } | { invalid: 'branch' | 'range' } {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || !Object.hasOwn(value, 'oneIn')) return { invalid: 'branch' };
  const r = LogSamplingValue.safeParse(value);
  return r.success ? { oneIn: r.data.oneIn } : { invalid: 'range' };
}

export const controlEventCodec: ControlCodec = {
  /** @throws JSON이 아님, sessionId가 비지 않은 글이 아님 */
  sessionTerminated(value: Buffer): SessionTerminated {
    const o = jsonObject(value, 'control.sessions-terminated');
    if (typeof o.sessionId !== 'string' || o.sessionId.length === 0) throw new TypeError('control.sessions-terminated 값에 sessionId가 없다');
    return {
      sessionId: o.sessionId,
      accountId: typeof o.accountId === 'string' ? o.accountId : '',
      reason: typeof o.reason === 'string' ? o.reason : '',
      terminatedAt: timeMs(o.terminatedAt),
    };
  },
  /** @throws JSON이 아님, SettingChanged 모양이 아님, 시각을 밀리초로 읽지 못함 */
  setting(value: Buffer): SettingChanged {
    const s = SettingJson.parse(jsonObject(value, 'control.settings'));
    const occurredAt = timeMs(s.occurredAt);
    const expiresAt = s.expiresAt === undefined || s.expiresAt === null ? null : timeMs(s.expiresAt);
    if (!Number.isFinite(occurredAt) || (expiresAt !== null && !Number.isFinite(expiresAt))) throw new RangeError('control.settings 값의 시각을 밀리초로 읽지 못했다');
    return { commandId: s.commandId, key: s.key, scope: s.scope, value: s.value, expiresAt, actor: s.actor, occurredAt, eventKey: s.eventKey };
  },
};
