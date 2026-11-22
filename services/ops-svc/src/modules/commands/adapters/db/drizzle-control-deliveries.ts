// 받는 파드마다의 ack 기록(ops DB command_delivery, F-02-1 OPS-300, ADR-0365 결정 4, 마이그레이션 0025).
// 한 줄 = (명령, 판, 서비스, 범위, 부른 주소). 판 이상을 답한 줄은 ack를 잃지 않는다(다시 쓰기가 ack 시각을 지우지 않는다).
import { Inject, Injectable } from '@nestjs/common';
import { DATABASE, type Database } from '@peaket/platform';
import { sql } from 'drizzle-orm';
import type { CommandDeliveryView } from '../../domain/command.js';
import type { ControlDeliveries, ControlDeliveryRow } from '../../domain/ports.js';
import { deliveryViewOf } from '../memory-control-deliveries.js';

@Injectable()
export class DrizzleControlDeliveries implements ControlDeliveries {
  constructor(@Inject(DATABASE) private readonly database: Database) {}

  async record(r: ControlDeliveryRow): Promise<void> {
    await this.database.db.execute(sql`
      insert into command_delivery (command_id, version, service, scope, target, pod_name, applied_version, acked_at, updated_at)
      values (${r.commandId}::uuid, ${r.version}::bigint, ${r.service}, ${r.scope}, ${r.target}, ${r.podName ?? null}, ${r.appliedVersion ?? null}::bigint,
              ${r.ackedAtMs !== undefined ? new Date(r.ackedAtMs) : null}::timestamptz, ${new Date(r.nowMs)}::timestamptz)
      on conflict (command_id, version, service, scope, target) do update set
        pod_name = coalesce(excluded.pod_name, command_delivery.pod_name),
        applied_version = greatest(command_delivery.applied_version, excluded.applied_version),
        acked_at = coalesce(command_delivery.acked_at, excluded.acked_at),
        updated_at = excluded.updated_at`);
  }

  async summary(commandId: string, version: number): Promise<CommandDeliveryView | undefined> {
    const rows = (
      await this.database.db.execute(sql`
        select service, scope, target, pod_name, acked_at from command_delivery where command_id = ${commandId}::uuid and version = ${version}::bigint
        order by service, scope, target`)
    ).rows as { service: string; scope: string; target: string; pod_name: string | null; acked_at: Date | string | null }[];
    return deliveryViewOf(rows.map((x) => ({ service: x.service, scope: x.scope, target: x.target, ...(x.pod_name !== null ? { podName: x.pod_name } : {}), acked: x.acked_at !== null })));
  }
}
