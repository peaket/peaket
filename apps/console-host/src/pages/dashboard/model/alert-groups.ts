// 경보 패널 나누기·접기(F-03-3 OPS-380, docs/features/control-tower.md §8, C-T32 ②③, d5 §7.2 '경보 억제', ADR-0069).
// - 고른 회차의 경보(위생·법정 종류 빼고)는 '이 회차 판단', 다른 회차·회차 밖 경보와 위생·법정은 '플랫폼·위생·법정'
// - 걸린 위 경보에 foldedUnder로 붙은 경보는 그 아래 접힌 줄로 든다. 위 경보가 풀렸거나 목록에 없으면 펼쳐 제 묶음에 둔다
// - 위 상태 바 SEV 수는 펼친 걸린 경보만 센다(접힌 것·풀린 것은 세지 않는다)
import { firingCounts, foldAlerts } from '@/shared/model/alert-fold';
import type { LiveAlert } from '@/shared/model/live-host';

export interface AlertRow {
  alert: LiveAlert;
  /** 이 경보 아래 접힌 경보 */
  folded: LiveAlert[];
}

export interface AlertGroups {
  event: AlertRow[];
  platform: AlertRow[];
  counts: { sev1: number; sev2: number; sev3: number };
}

/** 회차와 상관없이 플랫폼 묶음에 두는 종류 */
const PLATFORM_KINDS = new Set(['hygiene', 'legal']);
const SEV_ORDER: Record<string, number> = { SEV1: 1, SEV2: 2, SEV3: 3 };

const byPriority = (a: AlertRow, b: AlertRow): number => {
  const s = (SEV_ORDER[a.alert.severity] ?? 9) - (SEV_ORDER[b.alert.severity] ?? 9);
  if (s !== 0) return s;
  // 걸린 것 먼저, 같으면 최근에 시작한 것 먼저
  const f = (a.alert.status === 'firing' ? 0 : 1) - (b.alert.status === 'firing' ? 0 : 1);
  if (f !== 0) return f;
  return (Date.parse(b.alert.startsAt) || 0) - (Date.parse(a.alert.startsAt) || 0);
};

/**
 * 경보를 두 묶음으로 나누고 접는다.
 * @param alerts 호스트 alerts 슬라이스
 * @param eventId 고른 회차(없으면 모두 플랫폼 쪽)
 */
export function groupAlerts(alerts: readonly LiveAlert[], eventId: string | null | undefined): AlertGroups {
  const { shown, foldedBy } = foldAlerts(alerts);
  const mine = (a: LiveAlert) => !!eventId && a.eventId?.toLowerCase() === eventId.toLowerCase() && !PLATFORM_KINDS.has(a.kind);
  const rows = shown.map((a) => ({ alert: a, folded: foldedBy.get(a.alertId) ?? [] }));
  return {
    event: rows.filter((r) => mine(r.alert)).sort(byPriority),
    platform: rows.filter((r) => !mine(r.alert)).sort(byPriority),
    counts: firingCounts(shown),
  };
}
