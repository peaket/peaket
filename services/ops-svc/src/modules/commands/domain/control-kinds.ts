// 제어 gRPC로 보내는 운영 명령의 종류·범위·받는 쪽·바라는 상태(F-02-1 OPS-300, ADR-0365 결정 2, docs/features/control-tower.md §3·§5).
// 명령 1·2·3·7·11(카탈로그)과 판매 중지·재개(1회 실행)가 대상이다. 명령 6의 두 갈래는 F-02-2가 더한다.
// 주소는 여기서 정하지 않는다(대상 찾기 포트 ControlTargets, 결정 3). 명령 값에서 주소를 읽지 않는다(ASVS 1.3.6).
// 이 파일은 프레임워크를 모른다.
import { SAFETY_LIMITS, type Command, type CommandType } from './command.js';
import { CommandInputRejected } from './command-params.js';

/** 제어를 받는 서비스(대상 찾기 포트가 주소를 준다) */
export const CONTROL_SERVICES = ['purchase-svc', 'queue-svc', 'admission-ctrl'] as const;
export type ControlService = (typeof CONTROL_SERVICES)[number];

/** 전체 범위 이름(ApplyControlRequest.scope) */
export const CONTROL_SCOPE_PLATFORM = 'PLATFORM';

/** proto ControlKind 이름. 판 원장(control_version)의 종류 칸도 이 이름이다 */
export type ControlKindName =
  | 'CONTROL_KIND_ADMISSION_TARGET'
  | 'CONTROL_KIND_ADMISSION_PAUSE'
  | 'CONTROL_KIND_SALE_PAUSE'
  | 'CONTROL_KIND_LOBBY_BANNER'
  | 'CONTROL_KIND_AUTOMATION_STOP'
  | 'CONTROL_KIND_SALE_SUSPENSION';

/** 명령 1의 수동 고정 만료: 지정 시각 + 15분(ADR-0226 결정 7) */
export const ADMISSION_TARGET_HOLD_MS = 15 * 60_000;

/** 받는 쪽 하나에 보낼 것(범위·종류·바라는 상태) */
export interface ControlDelivery {
  readonly service: ControlService;
  readonly scope: string;
  readonly kind: ControlKindName;
  readonly desiredStateJson: string;
}

/** 무엇을 보내나: 명령 적용(APPLY), 되돌림(REVERT), 명령 2 연장(EXTEND), 명령 2 만료(EXPIRE) */
export type ControlPhase = 'APPLY' | 'REVERT' | 'EXTEND' | 'EXPIRE';

const KIND_OF: Partial<Record<CommandType, ControlKindName>> = {
  ADMISSION_TARGET: 'CONTROL_KIND_ADMISSION_TARGET',
  ADMISSION_PAUSE: 'CONTROL_KIND_ADMISSION_PAUSE',
  KILL_SWITCH: 'CONTROL_KIND_SALE_PAUSE',
  LOBBY_BANNER: 'CONTROL_KIND_LOBBY_BANNER',
  AUTOMATION_STOP: 'CONTROL_KIND_AUTOMATION_STOP',
  SALE_STOP: 'CONTROL_KIND_SALE_SUSPENSION',
  SALE_RESUME: 'CONTROL_KIND_SALE_SUSPENSION',
};

/** 명령 유형의 제어 종류(원장 종류). 제어 gRPC로 보내지 않는 유형은 undefined */
export function controlKindOf(type: CommandType): ControlKindName | undefined {
  return KIND_OF[type];
}

/** 배경 작업이 보내고 받는 쪽 ack로 ACKED가 되는 카탈로그 명령(1·2·3·7·11, ADR-0365 결정 4) */
export const DISPATCHED_CONTROL_TYPES: readonly CommandType[] = ['ADMISSION_TARGET', 'ADMISSION_PAUSE', 'KILL_SWITCH', 'LOBBY_BANNER', 'AUTOMATION_STOP'];
export const isDispatchedControl = (type: CommandType): boolean => DISPATCHED_CONTROL_TYPES.includes(type);

const LOWER_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** 명령 7 문구 템플릿 ID(openapi NoticeTemplateCreate.templateId와 같은 꼴) */
const TEMPLATE_ID = /^[a-z][a-z0-9-]{2,39}$/;
const invalid = (why: string): never => {
  throw new CommandInputRejected('INVALID', why);
};
const eventOf = (v: unknown): string => (typeof v === 'string' && LOWER_UUID.test(v.toLowerCase()) ? v.toLowerCase() : invalid('eventId'));

/**
 * 명령이 거는 범위(원장 행). 명령 3은 EVENT면 회차들, PLATFORM이면 PLATFORM 하나다. 명령 7은 회차가 없으면 PLATFORM이다.
 * @throws CommandInputRejected 범위 값이 꼴에 맞지 않음
 */
export function controlScopesOf(c: Pick<Command, 'type' | 'params'>): string[] {
  const p = c.params;
  switch (c.type) {
    case 'ADMISSION_TARGET':
    case 'ADMISSION_PAUSE':
    case 'SALE_STOP':
    case 'SALE_RESUME':
      return [eventOf(p.eventId)];
    case 'KILL_SWITCH': {
      if (p.scope === 'PLATFORM') return [CONTROL_SCOPE_PLATFORM];
      if (p.scope !== 'EVENT' || !Array.isArray(p.eventIds) || p.eventIds.length === 0) return invalid('eventIds');
      return [...new Set((p.eventIds as unknown[]).map(eventOf))].sort();
    }
    case 'LOBBY_BANNER':
      return [p.eventId === undefined || p.eventId === null ? CONTROL_SCOPE_PLATFORM : eventOf(p.eventId)];
    case 'AUTOMATION_STOP':
      return [CONTROL_SCOPE_PLATFORM];
    default:
      return [];
  }
}

export interface ControlDeliveryTimes {
  /** 이 판을 처음 보낸 시각(명령 1 고정 만료·명령 2 만료의 기준) */
  readonly sentAtMs: number;
  /** 명령 2 연장의 새 만료(EXTEND만) */
  readonly expiresAtMs?: number;
}

/**
 * 받는 쪽마다 보낼 것(ADR-0365 결정 2의 바라는 상태 꼴). 같은 판을 다시 보낼 때 같은 값이 나오도록 시각은 times에서만 읽는다.
 * - 1: admission-ctrl 리더. APPLY {"target", "untilMs": 보낸 시각 + 15분}, REVERT {"target": null, "resumeAtMs": 보낸 시각}
 * - 2: admission-ctrl 리더. APPLY {"paused": true, "expiresAtMs": 보낸 시각 + 10분}, EXTEND {"paused": true, "expiresAtMs": 새 만료}, REVERT·EXPIRE {"paused": false, "expiresAtMs": null}
 * - 3: purchase-svc·admission-ctrl·queue-svc 범위마다 {"paused": 참거짓}
 * - 7: queue-svc {"banner": 템플릿 ID 또는 null}(배너 글 풀기는 화면 몫, 정한 세부)
 * - 11: admission-ctrl 리더 PLATFORM {"stopped": 참거짓}
 * @throws CommandInputRejected 명령 값이 꼴에 맞지 않음(배경 작업이 FAILED invalid-command로 남긴다)
 */
export function controlDeliveriesOf(c: Pick<Command, 'type' | 'params'>, phase: ControlPhase, times: ControlDeliveryTimes): ControlDelivery[] {
  const kind = controlKindOf(c.type);
  if (!kind || !isDispatchedControl(c.type)) return invalid('not-control');
  const scopes = controlScopesOf(c);
  const json = (v: Record<string, unknown>): string => JSON.stringify(v);
  const undo = phase === 'REVERT' || phase === 'EXPIRE';
  switch (c.type) {
    case 'ADMISSION_TARGET': {
      if (undo) return [{ service: 'admission-ctrl', scope: scopes[0]!, kind, desiredStateJson: json({ target: null, resumeAtMs: times.sentAtMs }) }];
      const target = c.params.target;
      if (typeof target !== 'number' || !Number.isSafeInteger(target) || target < 1) return invalid('target');
      return [{ service: 'admission-ctrl', scope: scopes[0]!, kind, desiredStateJson: json({ target, untilMs: times.sentAtMs + ADMISSION_TARGET_HOLD_MS }) }];
    }
    case 'ADMISSION_PAUSE': {
      if (undo) return [{ service: 'admission-ctrl', scope: scopes[0]!, kind, desiredStateJson: json({ paused: false, expiresAtMs: null }) }];
      const expiresAtMs = phase === 'EXTEND' ? (times.expiresAtMs ?? invalid('expiresAtMs')) : times.sentAtMs + SAFETY_LIMITS.admissionPauseMs;
      return [{ service: 'admission-ctrl', scope: scopes[0]!, kind, desiredStateJson: json({ paused: true, expiresAtMs }) }];
    }
    case 'KILL_SWITCH': {
      const state = json({ paused: !undo });
      return scopes.flatMap((scope) => (['purchase-svc', 'admission-ctrl', 'queue-svc'] as const).map((service) => ({ service, scope, kind, desiredStateJson: state })));
    }
    case 'LOBBY_BANNER': {
      if (undo) return [{ service: 'queue-svc', scope: scopes[0]!, kind, desiredStateJson: json({ banner: null }) }];
      const templateId = c.params.templateId;
      if (typeof templateId !== 'string' || !TEMPLATE_ID.test(templateId)) return invalid('templateId');
      return [{ service: 'queue-svc', scope: scopes[0]!, kind, desiredStateJson: json({ banner: templateId }) }];
    }
    case 'AUTOMATION_STOP':
      return [{ service: 'admission-ctrl', scope: CONTROL_SCOPE_PLATFORM, kind, desiredStateJson: json({ stopped: !undo }) }];
    default:
      return invalid('not-control');
  }
}
