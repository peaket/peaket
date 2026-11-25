// 적용 확인 바퀴(F-02-5 OPS-300, ADR-0365 결정 10·14·15, C-T54). 정비 작업이 5초마다 부르고,
// 나간 설정 사건의 받는 서비스 파드들이 그 판을 냈는지 Prometheus로 본다. 판정은 nextApplyCheck 순수 함수가 맡는다.
import { nextApplyCheck, SETTINGS_APPLY_ALERT, type ApplyCheckRow } from '../domain/apply-check.js';
import type { ApplyCheckStore, SettingsApplyProbe } from '../domain/ports.js';
import type { RecordOpsAlert } from '../../alerts/index.js';

export interface CheckSettingsApplyDeps {
  readonly store: ApplyCheckStore;
  readonly probe: SettingsApplyProbe;
  readonly alerts?: Pick<RecordOpsAlert, 'handle' | 'resolve'>;
  readonly clock: { now(): number };
}

export interface ApplyCheckRound {
  readonly checked: number;
  readonly opened: number;
  readonly resolved: number;
}

export class CheckSettingsApply {
  constructor(private readonly deps: CheckSettingsApplyDeps) {}

  /** 지금 볼 행을 limit개까지 본다. 한 행이 실패해도 다음 행은 본다(다음 바퀴에 다시) */
  async runOnce(limit = 50): Promise<ApplyCheckRound> {
    const now = this.deps.clock.now();
    const rows = await this.deps.store.due(now, limit);
    let checked = 0;
    let opened = 0;
    let resolved = 0;
    for (const row of rows) {
      // 10분 30초를 넘긴 UNCONFIRMED는 더 묻지 않는다(경보는 열린 채, B11)
      if (row.status === 'UNCONFIRMED' && row.sentAtMs !== undefined && now > row.sentAtMs + 630_000) continue;
      const outbox = await this.deps.store.outboxOf(row.outboxId);
      let probe: Awaited<ReturnType<SettingsApplyProbe['probe']>> | undefined;
      if (row.service !== undefined && outbox.sentAtMs !== undefined) {
        try {
          probe = await this.deps.probe.probe({ service: row.service, messageKey: row.messageKey, version: row.version });
        } catch (err) {
          probe = { ok: false, reason: err instanceof Error ? err.message : 'probe-failed' };
        }
      }
      const next = nextApplyCheck(row, { nowMs: now, outbox, ...(probe !== undefined ? { probe } : {}) });
      await this.deps.store.save(next.row);
      checked += 1;
      if (next.alert === 'OPEN') {
        opened += 1;
        await this.deps.alerts?.handle({
          eventKey: next.row.commandId,
          kind: SETTINGS_APPLY_ALERT,
          severity: 'SEV3',
          source: 'ops-svc',
          reason: SETTINGS_APPLY_ALERT,
          detail: { messageKey: next.row.messageKey, version: next.row.version, pods: next.row.pods },
        });
      } else if (next.alert === 'RESOLVE') {
        resolved += 1;
        await this.deps.alerts?.resolve({ eventKey: next.row.commandId, kind: SETTINGS_APPLY_ALERT, reason: 'settings-applied' });
      }
    }
    return { checked, opened, resolved };
  }
}

export type { ApplyCheckRow };
