// 런북 CLI 프리셋(계획 6.2). 명령 종류·범위·서비스별 바라는 상태를 한 곳에서 만든다.
import type { ControlPreset } from './ports.js';

export class PresetError extends Error {
  constructor(message: string, readonly code = 2) {
    super(message);
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PG = ['TOSS', 'PORTONE', 'SIMULATOR'] as const;
const lowerUuid = (v: string | undefined): string => {
  if (typeof v !== 'string' || !UUID.test(v.toLowerCase())) throw new PresetError('--event는 UUID여야 한다');
  return v.toLowerCase();
};
const intOf = (v: string | undefined, name: string, min: number, max: number): number => {
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new PresetError(`--param ${name}은 ${min}~${max}의 정수다`);
  return n;
};
const pgOf = (v: string | undefined, allowSimulator: boolean): string => {
  if (typeof v !== 'string' || !(PG as readonly string[]).includes(v)) throw new PresetError('--param pg는 TOSS·PORTONE·SIMULATOR 가운데 하나다');
  if (v === 'SIMULATOR' && !allowSimulator) throw new PresetError('SIMULATOR는 local·ci에서만 쓴다');
  return v;
};

export interface PresetInput {
  readonly eventId?: string;
  readonly platform: boolean;
  readonly params: ReadonlyMap<string, string>;
  readonly issuedAt: number;
  readonly allowSimulator: boolean;
}

export interface PresetBundle {
  readonly kind: string;
  readonly scope: string;
  readonly requests: Record<string, Record<string, unknown>>;
}

export function buildPreset(preset: ControlPreset, i: PresetInput): PresetBundle {
  const event = i.eventId === undefined ? undefined : lowerUuid(i.eventId);
  const scope = i.platform ? 'PLATFORM' : event;
  if (!scope) throw new PresetError('--event나 --scope platform 가운데 하나가 필요하다');
  switch (preset) {
    case 'sale-pause':
    case 'sale-resume': {
      const paused = preset === 'sale-pause';
      return {
        kind: 'CONTROL_KIND_SALE_PAUSE',
        scope,
        requests: { 'purchase-svc': { paused }, 'admission-ctrl': { paused }, 'queue-svc': { paused } },
      };
    }
    case 'admission-pause':
    case 'admission-resume': {
      if (i.platform) throw new PresetError('입장 일시정지는 회차 범위만 받는다');
      if (!event) throw new PresetError('--event가 필요하다');
      if (preset === 'admission-pause') {
        const seconds = i.params.has('expiresInSec') ? intOf(i.params.get('expiresInSec'), 'expiresInSec', 60, 600) : 600;
        return { kind: 'CONTROL_KIND_ADMISSION_PAUSE', scope: event, requests: { 'admission-ctrl': { paused: true, expiresAtMs: i.issuedAt + seconds * 1_000 } } };
      }
      return { kind: 'CONTROL_KIND_ADMISSION_PAUSE', scope: event, requests: { 'admission-ctrl': { paused: false, expiresAtMs: null } } };
    }
    case 'automation-stop':
    case 'automation-resume': {
      if (!i.platform) throw new PresetError('자동 제어 정지·재개는 --scope platform만 받는다');
      return { kind: 'CONTROL_KIND_AUTOMATION_STOP', scope: 'PLATFORM', requests: { 'admission-ctrl': { stopped: preset === 'automation-stop' } } };
    }
    case 'pg-switch': {
      const toPg = pgOf(i.params.get('toPg'), i.allowSimulator);
      if (toPg === 'SIMULATOR') throw new PresetError('대체 결제사 전환은 TOSS·PORTONE만 받는다');
      const pgTps = intOf(i.params.get('pgTps'), 'pgTps', 1, 1_000_000);
      return {
        kind: 'CONTROL_KIND_PG_SWITCH',
        scope,
        requests: { 'payment-svc': { switched: true, toPg }, 'admission-ctrl': { switched: true, pgKey: toPg, pgTps } },
      };
    }
    case 'pg-switch-off':
      return {
        kind: 'CONTROL_KIND_PG_SWITCH',
        scope,
        requests: { 'payment-svc': { switched: false, toPg: null }, 'admission-ctrl': { switched: false, pgKey: null, pgTps: null } },
      };
    case 'entry-pause-release': {
      if (!i.platform) throw new PresetError('새 결제 진입 정지 해제는 --scope platform만 받는다');
      const pg = pgOf(i.params.get('pg'), i.allowSimulator);
      const actor = i.params.get('actor');
      if (typeof actor !== 'string' || !UUID.test(actor)) throw new PresetError('--param actor는 관리 계정 UUID다');
      return { kind: 'CONTROL_KIND_ENTRY_PAUSE_RELEASE', scope: 'PLATFORM', requests: { 'payment-svc': { pg, actor } } };
    }
  }
}
