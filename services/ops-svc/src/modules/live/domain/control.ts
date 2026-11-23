// 자동 제어 다섯 값(늘 여는 흐름 control 사건, asyncapi OpsControl, F-03-3 OPS-380, ADR-0371 결정 6·7).
// 정본: docs/features/control-tower.md §6의 6('긴급 정지, 입력 없음, 일시정지, 자동 증액 멈춤 순으로 앞의 것'), docs/data.md §3 q:{event:E}:ctl·q:{admission}:ctl 칸.
// 칸 이름은 쓰는 쪽(admission-ctrl leader/domain/aimd.ts memoryToFields, F-02-1 운영자 칸)과 같다. 틀린 칸(1·0이 아님, 숫자가 아님)은 없는 것으로 본다.

export const CONTROL_KINDS = ['ok', 'paused', 'raise-stopped', 'no-input', 'emergency-stop', 'unknown'] as const;
export type ControlKind = (typeof CONTROL_KINDS)[number];

/** 대기열 Redis 키(docs/data.md §3) */
export const ctlKeyOf = (eventId: string): string => `q:{event:${eventId}}:ctl`;
export const PLATFORM_CTL_KEY = 'q:{admission}:ctl';
export const ACTIVE_EVENTS_KEY = 'q:{admission}:events';

/** 마지막 감축(admission-ctrl lastDecrease JSON의 화면 몫) */
export interface LastDecrease {
  readonly reason: string;
  readonly journey?: string;
  readonly from: number;
  readonly to: number;
  readonly exposureReduction?: boolean;
}

/** control 사건 본문 */
export interface ControlValue {
  readonly eventId: string;
  readonly kind: ControlKind;
  readonly since?: string;
  readonly inputStaleKinds?: readonly string[];
  readonly targetNow?: number;
  readonly budgetHoldAt?: string;
  readonly lastDecrease?: LastDecrease;
  readonly updatedAt: string;
}

const flag = (v: string | undefined): boolean => v === '1';
const ms = (v: string | undefined): number | undefined => (v !== undefined && /^\d{1,16}$/.test(v) ? Number(v) : undefined);
const iso = (n: number | undefined): string | undefined => (n === undefined ? undefined : new Date(n).toISOString());

function lastDecreaseOf(raw: string | undefined): LastDecrease | undefined {
  if (!raw) return undefined;
  try {
    const d = JSON.parse(raw) as Record<string, unknown>;
    if (typeof d.reason !== 'string' || typeof d.from !== 'number' || typeof d.to !== 'number') return undefined;
    return {
      reason: d.reason,
      ...(typeof d.journey === 'string' ? { journey: d.journey } : {}),
      from: d.from,
      to: d.to,
      ...(d.exposure !== undefined && d.exposure !== null && d.exposure !== false ? { exposureReduction: true } : {}),
    };
  } catch {
    return undefined;
  }
}

/** 입력 없음 칸이 켜졌는가(경보는 표시 값과 따로 이 칸으로 연다: 긴급 정지가 앞서도 입력 없음 경보는 걸린다) */
export const inputStaleOf = (fields: Readonly<Record<string, string>> | undefined): boolean => flag(fields?.inputStale);

/**
 * 회차 ctl 칸과 플랫폼 ctl 칸으로 control 값을 만든다.
 * @param fields 회차 ctl 해시(키가 없으면 undefined → unknown)
 * @param platform 플랫폼 ctl 해시(없으면 빈 것)
 */
export function controlOf(eventId: string, fields: Readonly<Record<string, string>> | undefined, platform: Readonly<Record<string, string>>, nowMs: number): ControlValue {
  const updatedAt = new Date(nowMs).toISOString();
  if (fields === undefined) return { eventId, kind: 'unknown', updatedAt };
  const targetNow = ms(fields.targetNow);
  const staleKinds = (fields.inputStaleKinds ?? '').split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  const budgetHoldAt = ms(fields.budgetHoldAt);
  const lastDecrease = lastDecreaseOf(fields.lastDecrease);
  const extra = {
    ...(targetNow !== undefined ? { targetNow } : {}),
    ...(budgetHoldAt !== undefined ? { budgetHoldAt: iso(budgetHoldAt)! } : {}),
    ...(lastDecrease ? { lastDecrease } : {}),
  };
  const admitPausedUntil = ms(fields.admitPausedUntil);
  const admitPaused = flag(fields.admitPaused) && (admitPausedUntil === undefined || admitPausedUntil > nowMs);
  let kind: ControlKind;
  if (flag(platform.autoStopped)) kind = 'emergency-stop';
  else if (flag(fields.inputStale)) kind = 'no-input';
  else if (admitPaused || flag(fields.paused) || flag(fields.suspended) || flag(platform.allPaused)) kind = 'paused';
  else if (budgetHoldAt !== undefined) kind = 'raise-stopped';
  else kind = 'ok';
  const stale = flag(fields.inputStale);
  const staleAt = ms(fields.inputStaleAt);
  return {
    eventId,
    kind,
    ...(stale && staleAt !== undefined ? { since: iso(staleAt)! } : {}),
    ...(stale && staleKinds.length > 0 ? { inputStaleKinds: staleKinds } : {}),
    ...extra,
    updatedAt,
  };
}

/** 같은 값인가(updatedAt 밖의 칸) */
export function sameControl(a: ControlValue | undefined, b: ControlValue): boolean {
  if (!a) return false;
  return JSON.stringify({ ...a, updatedAt: '' }) === JSON.stringify({ ...b, updatedAt: '' });
}

/** 입력 없음 경보(경보 기록 표 kind control SEV2, d5 §7.2 '제어 입력 없음' 상태 줄의 경보 글) */
export const NO_INPUT_ALERT = { kind: 'control', severity: 'SEV2', source: 'ops-svc.control-watch', reason: '관측 경로와 별개로 입장 제어가 알린 경보입니다' } as const;
