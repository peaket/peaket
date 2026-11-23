// 경보 접기(F-03-3 OPS-380, docs/features/control-tower.md §8 '예산 SEV1 아래 같은 회차·여정의 SEV2는 접힌 줄', d5 §7.2 '경보 억제').
// 걸린 위 경보에 foldedUnder로 붙은 경보만 접는다(접기는 한 단계). 위 경보가 풀렸거나 목록에 없으면 펼친다.
// 위 상태 바 SEV 수(features/preview-host)와 경보 패널 나누기(pages/dashboard/model/alert-groups)가 함께 쓴다.
import type { LiveAlert } from './live-host';

export interface FoldedAlerts {
  /** 펼쳐 보이는 경보 */
  shown: LiveAlert[];
  /** 위 경보 alertId → 그 아래 접힌 경보 */
  foldedBy: Map<string, LiveAlert[]>;
}

export function foldAlerts(alerts: readonly LiveAlert[]): FoldedAlerts {
  const firingTop = new Map(alerts.filter((a) => a.status === 'firing').map((a) => [a.alertId, a] as const));
  const foldedBy = new Map<string, LiveAlert[]>();
  const shown: LiveAlert[] = [];
  for (const a of alerts) {
    const top = a.foldedUnder && a.foldedUnder !== a.alertId ? firingTop.get(a.foldedUnder) : undefined;
    if (top && !(top.foldedUnder && firingTop.has(top.foldedUnder))) {
      const list = foldedBy.get(top.alertId) ?? [];
      list.push(a);
      foldedBy.set(top.alertId, list);
    } else {
      shown.push(a);
    }
  }
  return { shown, foldedBy };
}

/** 펼친 걸린 경보의 SEV 수(접힌 것·풀린 것은 세지 않는다) */
export function firingCounts(shown: readonly LiveAlert[]): { sev1: number; sev2: number; sev3: number } {
  const counts = { sev1: 0, sev2: 0, sev3: 0 };
  for (const a of shown) {
    if (a.status !== 'firing') continue;
    if (a.severity === 'SEV1') counts.sev1 += 1;
    else if (a.severity === 'SEV2') counts.sev2 += 1;
    else if (a.severity === 'SEV3') counts.sev3 += 1;
  }
  return counts;
}
