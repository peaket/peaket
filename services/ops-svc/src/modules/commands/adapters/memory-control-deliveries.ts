// 시험·메모리 조립용 ack 기록. DB 구현(drizzle-control-deliveries)과 같은 규칙: 한 번 ack한 줄은 ack를 잃지 않는다.
import type { CommandDeliveryView } from '../domain/command.js';
import type { ControlDeliveries, ControlDeliveryRow } from '../domain/ports.js';

/** 전파 상태 한 줄의 보기 재료 */
export interface DeliveryViewRow {
  readonly service: string;
  readonly scope: string;
  readonly target: string;
  readonly podName?: string;
  readonly acked: boolean;
}

/** 줄들을 openapi CommandState.delivery(ACK)로. 줄이 없으면 undefined. ack하지 않은 대상은 '<서비스>/<파드 이름 또는 주소>@<범위>'다 */
export function deliveryViewOf(rows: readonly DeliveryViewRow[]): CommandDeliveryView | undefined {
  if (rows.length === 0) return undefined;
  const unacked = rows.filter((r) => !r.acked).map((r) => `${r.service}/${r.podName ?? r.target}@${r.scope}`);
  return { kind: 'ACK', ackedCount: rows.length - unacked.length, targetCount: rows.length, unackedTargets: unacked };
}

export class MemoryControlDeliveries implements ControlDeliveries {
  /** '<명령>|<판>|<서비스>|<범위>|<주소>' → 줄 */
  readonly rows = new Map<string, ControlDeliveryRow>();

  async record(r: ControlDeliveryRow): Promise<void> {
    const key = [r.commandId, r.version, r.service, r.scope, r.target].join('|');
    const cur = this.rows.get(key);
    const podName = r.podName ?? cur?.podName;
    const appliedVersion = Math.max(cur?.appliedVersion ?? -1, r.appliedVersion ?? -1);
    const ackedAtMs = cur?.ackedAtMs ?? r.ackedAtMs;
    this.rows.set(key, {
      ...r,
      ...(podName !== undefined ? { podName } : {}),
      ...(appliedVersion >= 0 ? { appliedVersion } : {}),
      ...(ackedAtMs !== undefined ? { ackedAtMs } : {}),
    });
  }

  async summary(commandId: string, version: number): Promise<CommandDeliveryView | undefined> {
    const rows = [...this.rows.values()]
      .filter((r) => r.commandId === commandId && r.version === version)
      .sort((a, b) => (a.service + a.scope + a.target < b.service + b.scope + b.target ? -1 : 1));
    return deliveryViewOf(rows.map((r) => ({ service: r.service, scope: r.scope, target: r.target, ...(r.podName !== undefined ? { podName: r.podName } : {}), acked: r.ackedAtMs !== undefined })));
  }
}
