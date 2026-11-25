// 적용 확인 바퀴(F-02-5 OPS-300, ADR-0365 결정 10·14·15, C-T54). 정비 작업이 5초마다 부르고,
// 나간 설정 사건의 받는 서비스 파드들이 그 판을 냈는지 Prometheus로 본다. 판정은 nextApplyCheck 순수 함수가 맡는다.
import { APPLY_CHECK_RECHECK_MS, APPLY_CHECK_ROUND_MS, nextApplyCheck, SETTINGS_APPLY_ALERT, type ApplyCheckRow } from '../domain/apply-check.js';
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
      const outbox = await this.deps.store.outboxOf(row.outboxId);
      let probe: Awaited<ReturnType<SettingsApplyProbe['probe']>> | undefined;
      // 없어진 Outbox 행은 '나갔다'로 본다(파티션 지우기, ADR-0365 결정 14). 없음도 probe를 묻는 조건이다(IR-06)
      if (row.service !== undefined && (outbox.sentAtMs !== undefined || !outbox.exists)) {
        try {
          probe = await this.deps.probe.probe({ service: row.service, messageKey: row.messageKey, version: row.version });
        } catch (err) {
          probe = { ok: false, reason: err instanceof Error ? err.message : 'probe-failed' };
        }
      }
      const next = nextApplyCheck(row, { nowMs: now, outbox, ...(probe !== undefined ? { probe } : {}) });
      if (next.alert === 'OPEN') {
        // 경보 저장이 먼저 성공해야 alertOpen을 연다. 실패하면 다음 바퀴에 다시 연다(IR-08)
        try {
          await this.deps.alerts?.handle({
            eventKey: next.row.commandId,
            kind: SETTINGS_APPLY_ALERT,
            severity: 'SEV3',
            source: 'ops-svc',
            reason: SETTINGS_APPLY_ALERT,
            detail: { messageKey: next.row.messageKey, version: next.row.version, pods: next.row.pods },
          });
          opened += 1;
          await this.deps.store.save(next.row);
        } catch {
          await this.deps.store.save({ ...next.row, alertOpen: false, nextCheckAtMs: now + APPLY_CHECK_ROUND_MS });
        }
      } else if (next.alert === 'RESOLVE') {
        // 경보를 닫은 뒤에만 alertOpen을 내린다. 닫기 실패면 열린 채로 다음 바퀴에 다시 닫는다
        try {
          await this.deps.alerts?.resolve({ eventKey: next.row.commandId, kind: SETTINGS_APPLY_ALERT, reason: 'settings-applied' });
          resolved += 1;
          await this.deps.store.save(next.row);
        } catch {
          await this.deps.store.save({ ...next.row, status: 'UNCONFIRMED', alertOpen: true, nextCheckAtMs: now + APPLY_CHECK_RECHECK_MS });
        }
      } else {
        await this.deps.store.save(next.row);
      }
      checked += 1;
    }
    return { checked, opened, resolved };
  }
}

export type { ApplyCheckRow };
