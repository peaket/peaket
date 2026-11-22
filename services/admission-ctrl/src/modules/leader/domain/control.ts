// admission-ctrl 리더가 제어 gRPC로 받는 운영 명령의 바라는 상태와 칸(F-02-1 OPS-300, ADR-0365 결정 2·5·6, ADR-0226 결정 7, docs/data.md §3).
// 명령 1 ADMISSION_TARGET·2 ADMISSION_PAUSE는 회차 범위 q:{event:E}:ctl, 명령 3 SALE_PAUSE는 회차 q:{event:E}:ctl 또는 전체 q:{admission}:ctl,
// 명령 11 AUTOMATION_STOP은 전체 q:{admission}:ctl에 쓴다. 종류마다 판·명령 칸이 따로다(한 저장소의 다른 종류를 서로 막지 않게).
// 모르는 칸·틀린 꼴은 LeaderControlRejected(받는 층이 INVALID_ARGUMENT, 쓰기 0). 이 파일은 프레임워크를 모른다.

/** 받는 제어 종류(proto ControlKind 이름) */
export const LEADER_CONTROL_KINDS = ['CONTROL_KIND_ADMISSION_TARGET', 'CONTROL_KIND_ADMISSION_PAUSE', 'CONTROL_KIND_SALE_PAUSE', 'CONTROL_KIND_AUTOMATION_STOP'] as const;
export type LeaderControlKind = (typeof LEADER_CONTROL_KINDS)[number];

/** 전체 범위 이름 */
export const LEADER_CONTROL_PLATFORM = 'PLATFORM';

/** 바라는 상태가 꼴에 맞지 않음(why는 로그·오류 글에 싣는 짧은 까닭) */
export class LeaderControlRejected extends Error {
  constructor(readonly why: string) {
    super(why);
    this.name = 'LeaderControlRejected';
  }
}

/** 리더 상태 한 번의 쓰기(세대 확인 Lua 하나) */
export interface LeaderControlWrite {
  /** 회차 ID(EVENT) 또는 없음(PLATFORM) */
  readonly eventId?: string;
  readonly kind: LeaderControlKind;
  /** 그 종류의 판·명령 칸 */
  readonly revField: string;
  readonly cmdField: string;
  /** 판이 지금 칸보다 클 때 쓸 칸과 지울 칸 */
  readonly set: Readonly<Record<string, string>>;
  readonly del: readonly string[];
}

const LOWER_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const reject = (why: string): never => {
  throw new LeaderControlRejected(why);
};
const positiveInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;

function objectOf(json: string): Record<string, unknown> {
  let v: unknown;
  try {
    v = JSON.parse(json);
  } catch {
    return reject('desired_state_json');
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) reject('desired_state_json');
  return v as Record<string, unknown>;
}

/** 칸 이름이 정확히 이 묶음인가(빠진 칸·모르는 칸 모두 거절) */
function exactKeys(v: Record<string, unknown>, keys: readonly string[]): void {
  const got = Object.keys(v).sort();
  const want = [...keys].sort();
  if (got.length !== want.length || got.some((k, i) => k !== want[i])) reject('desired_state_json');
}

/**
 * 받은 제어를 리더 상태 쓰기로 바꾼다(ADR-0365 결정 2·6).
 * - 1 ADMISSION_TARGET(회차): {"target": 정수, "untilMs": 밀리초} → target·targetUntil. 되돌리기 {"target": null, "resumeAtMs": 밀리초} → target·targetUntil 지움, aimdResumeAt
 * - 2 ADMISSION_PAUSE(회차): {"paused": 참거짓, "expiresAtMs": 밀리초 | null} → admitPaused·admitPausedUntil(null이면 지움)
 * - 3 SALE_PAUSE(회차): {"paused": 참거짓} → paused(판 pausedRev). 전체면 q:{admission}:ctl의 allPaused(판 allPausedRev)
 * - 11 AUTOMATION_STOP(전체만): {"stopped": 참거짓} → autoStopped
 * @throws LeaderControlRejected 범위·바라는 상태가 꼴에 맞지 않음
 */
export function leaderControlOf(kind: LeaderControlKind, scope: string, desiredStateJson: string): LeaderControlWrite {
  const platform = scope === LEADER_CONTROL_PLATFORM;
  if (!platform && !LOWER_UUID.test(scope)) reject('scope');
  const v = objectOf(desiredStateJson);
  const eventScope = platform ? {} : { eventId: scope };
  switch (kind) {
    case 'CONTROL_KIND_ADMISSION_TARGET': {
      if (platform) reject('scope');
      if (v.target === null) {
        exactKeys(v, ['target', 'resumeAtMs']);
        if (!positiveInt(v.resumeAtMs)) reject('resumeAtMs');
        return { ...eventScope, kind, revField: 'targetRev', cmdField: 'targetCmd', set: { aimdResumeAt: String(v.resumeAtMs) }, del: ['target', 'targetUntil'] };
      }
      exactKeys(v, ['target', 'untilMs']);
      if (!positiveInt(v.target)) reject('target');
      if (!positiveInt(v.untilMs)) reject('untilMs');
      return { ...eventScope, kind, revField: 'targetRev', cmdField: 'targetCmd', set: { target: String(v.target), targetUntil: String(v.untilMs) }, del: [] };
    }
    case 'CONTROL_KIND_ADMISSION_PAUSE': {
      if (platform) reject('scope');
      exactKeys(v, ['paused', 'expiresAtMs']);
      if (typeof v.paused !== 'boolean') reject('paused');
      if (v.expiresAtMs !== null && !positiveInt(v.expiresAtMs)) reject('expiresAtMs');
      const set: Record<string, string> = { admitPaused: v.paused ? '1' : '0' };
      if (v.expiresAtMs !== null) set.admitPausedUntil = String(v.expiresAtMs);
      return { ...eventScope, kind, revField: 'admitRev', cmdField: 'admitCmd', set, del: v.expiresAtMs === null ? ['admitPausedUntil'] : [] };
    }
    case 'CONTROL_KIND_SALE_PAUSE': {
      exactKeys(v, ['paused']);
      if (typeof v.paused !== 'boolean') reject('paused');
      const value = v.paused ? '1' : '0';
      return platform
        ? { kind, revField: 'allPausedRev', cmdField: 'allPausedCmd', set: { allPaused: value }, del: [] }
        : { ...eventScope, kind, revField: 'pausedRev', cmdField: 'pausedCmd', set: { paused: value }, del: [] };
    }
    case 'CONTROL_KIND_AUTOMATION_STOP': {
      if (!platform) reject('scope');
      exactKeys(v, ['stopped']);
      if (typeof v.stopped !== 'boolean') reject('stopped');
      return { kind, revField: 'autoStoppedRev', cmdField: 'autoStoppedCmd', set: { autoStopped: v.stopped ? '1' : '0' }, del: [] };
    }
  }
}
