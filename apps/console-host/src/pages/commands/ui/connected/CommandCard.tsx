// 명령 카드(d5 §7.3 CMP-036 상태 표). 상세(REST)와 카드 상태(card-state.ts)로 그린다. props만으로 그린다.
// 승인 대기(남은 시간)·전파 중·전파 지연(ack 못 한 대상)·실패와 [다시 시도]·적용 확인·재개 승인 대기·되돌림·자동 만료.
// 승인자도 접수 때 남긴 dry-run을 그대로 본다(d2 §3.5). 실패하면 런북 CLI 한 줄(C-T7 ③, runbook.ts)도 보인다. 모든 값은 글자로만 그린다(ASVS v5.0.0-1.2.1).
import type { ReactNode } from 'react';
import { formatKstDateTime, stateLabel, stateTone, typeLabel, type CommandStateValue } from '../../model/commands';
import { revertAvailability, type CommandDetail } from '../../model/command-actions';
import type { ConsoleLayoutKind, ConsoleRole } from '../../model/command-form';
import type { CardState } from '../../model/card-state';
import { dryRunView } from '../../model/dry-run';
import { runbookLineOf } from '../../model/runbook';
import { DryRunPanel } from './DryRunPanel';

export interface CommandCardProps {
  detail: CommandDetail & { postReviewDueAt?: string | null; delivery?: unknown };
  state: CardState;
  role: ConsoleRole;
  layout?: ConsoleLayoutKind;
  busy?: boolean;
  onApprove: () => void;
  onReject: () => void;
  onRetry: () => void;
  onRevert: () => void;
}

/** 남은 시간 m:ss(올림, 9:41) */
export function formatRemaining(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** 카드 이름: 명령 6의 결제 갈래는 '대체 결제사 전환', 해제 갈래는 '새 결제 진입 정지 열기' */
export function cardTitle(d: Pick<CommandDetail, 'type' | 'params'>): string {
  const mode = (d.params as { mode?: unknown } | undefined)?.mode;
  if (d.type === 'DEGRADED_MODE' && mode === 'PAYMENT_PG_FALLBACK') return '대체 결제사 전환';
  if (d.type === 'DEGRADED_MODE' && mode === 'PAYMENT_ENTRY_RELEASE') return '새 결제 진입 정지 열기';
  return typeLabel(d.type ?? '');
}

function revertLabel(type: string | undefined): string {
  if (type === 'KILL_SWITCH') return '판매 재개 요청';
  if (type === 'DEGRADED_MODE') return 'Degraded 모두 해제';
  if (type === 'ADMISSION_TARGET') return '자동 조절로 되돌리기';
  return '되돌리기';
}

const ack = (s: CardState) => (typeof s.acked === 'number' && typeof s.target === 'number' ? `ack ${s.acked}/${s.target}` : null);

export function CommandCard({ detail, state, role, layout = 'desktop', busy = false, onApprove, onReject, onRetry, onRevert }: CommandCardProps) {
  const canOperate = role === 'operator' || role === 'commander';
  const progress = ack(state);
  const revert = revertAvailability({ role, layout, type: detail.type, params: detail.params ?? null });
  const view = detail.dryRun ? dryRunView(detail.dryRun) : null;
  const unacked = state.unacked && state.unacked.length > 0 ? state.unacked : null;
  const runbook = state.kind === 'failed' ? runbookLineOf(detail) : null;

  let line: ReactNode = null;
  let actions: ReactNode = null;
  switch (state.kind) {
    case 'pending-approval':
      line = (
        <p className="t-sm">
          승인 대기{state.remainingMs !== undefined ? ` · 남은 시간 ${formatRemaining(state.remainingMs)}` : ''}
        </p>
      );
      if (canOperate && detail.canApprove === true) {
        actions = (
          <>
            <button className="btn btn-primary" type="button" disabled={busy} onClick={onApprove}>
              승인
            </button>
            <button className="btn btn-outline" type="button" disabled={busy} onClick={onReject}>
              반려
            </button>
          </>
        );
      } else if (detail.canApprove === false) {
        actions = <p className="t-xs muted">요청자 본인은 승인할 수 없습니다</p>;
      }
      break;
    case 'rejected':
      line = <p className="t-sm">거부되었거나 승인 대기 10분이 지나 취소되었습니다</p>;
      break;
    case 'propagating':
      line = <p className="t-sm">전파 중{progress ? ` · ${progress}` : ''}</p>;
      break;
    case 'propagating-delayed':
      line = (
        <div className="col" style={{ gap: 4 }}>
          <p className="t-sm" role="status" style={{ color: 'var(--warning)' }}>
            전파가 늦어지고 있습니다{progress ? ` · ${progress}` : ''}
          </p>
          {unacked ? <p className="t-xs muted">아직 적용을 알리지 않은 곳: {unacked.join(', ')}</p> : null}
        </div>
      );
      break;
    case 'failed':
      line = (
        <div className="col" style={{ gap: 4 }}>
          <p className="t-sm" role="alert" style={{ color: 'var(--danger)' }}>
            전파에 실패했습니다{progress ? ` · ${progress}` : ''}
          </p>
          {unacked ? <p className="t-xs muted">적용을 알리지 않은 곳: {unacked.join(', ')}</p> : null}
        </div>
      );
      if (canOperate && layout !== 'phone') {
        actions = (
          <button className="btn btn-primary" type="button" disabled={busy} onClick={onRetry}>
            다시 시도
          </button>
        );
      }
      break;
    case 'acked':
      line = <p className="t-sm">적용 확인{progress ? ` · ${progress}` : ''}</p>;
      if (revert.canRequest) {
        actions = (
          <button className="btn btn-outline" type="button" disabled={busy} onClick={onRevert}>
            {revertLabel(detail.type)}
          </button>
        );
      }
      break;
    case 'revert-pending':
      line = (
        <p className="t-sm">
          재개 승인을 기다립니다{state.remainingMs !== undefined ? ` · 남은 시간 ${formatRemaining(state.remainingMs)}` : ''}
        </p>
      );
      if (canOperate && detail.canApprove === true) {
        actions = (
          <>
            <button className="btn btn-primary" type="button" disabled={busy} onClick={onApprove}>
              재개 승인
            </button>
            <button className="btn btn-outline" type="button" disabled={busy} onClick={onReject}>
              반려
            </button>
          </>
        );
      } else if (detail.canApprove === false) {
        actions = <p className="t-xs muted">요청자 본인은 승인할 수 없습니다</p>;
      }
      break;
    case 'reverted':
      line = <p className="t-sm">되돌림 · 이전 상태로 돌아갔습니다</p>;
      break;
    case 'auto-expired':
      line = <p className="t-sm">자동 만료 · 정한 시간이 지나 풀렸습니다</p>;
      break;
    case 'apply-unknown':
      line = <p className="t-sm">적용 여부를 이 화면에서 확인할 수 없습니다</p>;
      break;
    case 'done':
      line = <p className="t-sm">{stateLabel((detail.state ?? 'DRAFTED') as CommandStateValue)}</p>;
      break;
  }

  const due = detail.type === 'KILL_SWITCH' && state.kind === 'acked' && detail.postReviewDueAt ? formatKstDateTime(detail.postReviewDueAt) : null;

  return (
    <article className="col" style={{ gap: 12 }} aria-label={`명령 ${cardTitle(detail)}`}>
      <div className="row between" style={{ gap: 8 }}>
        <h3 className="t-sm fw-b">{cardTitle(detail)}</h3>
        <span className={`badge badge-${stateTone((detail.state ?? 'DRAFTED') as CommandStateValue)}`}>{stateLabel((detail.state ?? 'DRAFTED') as CommandStateValue)}</span>
      </div>
      {due ? (
        <p className="t-sm" role="status" style={{ padding: 8, border: '1px solid var(--warning)', borderRadius: 6 }}>
          판매 일시정지를 1인 실행으로 걸었습니다. {due}까지 사후 검토 보고서를 써야 합니다
        </p>
      ) : null}
      {line}
      {runbook ? (
        <p className="t-xs" style={{ margin: 0 }}>
          런북 CLI 한 줄: <code style={{ overflowWrap: 'anywhere' }}>{runbook}</code>
        </p>
      ) : null}
      <dl className="t-sm" style={{ display: 'grid', gridTemplateColumns: '120px 1fr', gap: 6, margin: 0 }}>
        <dt className="muted">사유</dt>
        <dd style={{ margin: 0 }}>{detail.reason}</dd>
        <dt className="muted">요청자</dt>
        <dd style={{ margin: 0 }}>
          {detail.requestedBy?.displayName ?? detail.requestedBy?.adminAccountId} · {detail.requestedBy?.role}
        </dd>
        <dt className="muted">요청 시각</dt>
        <dd style={{ margin: 0 }}>{formatKstDateTime(detail.createdAt)}</dd>
        {detail.lastError ? (
          <>
            <dt className="muted">마지막 실패</dt>
            <dd style={{ margin: 0 }}>{detail.lastError}</dd>
          </>
        ) : null}
      </dl>
      {actions ? (
        <div className="row" style={{ gap: 8, alignItems: 'center' }}>
          {actions}
        </div>
      ) : null}
      {view ? (
        <details>
          <summary className="t-sm fw-b">접수 때 본 실행 전 모의</summary>
          <DryRunPanel view={view} />
        </details>
      ) : null}
    </article>
  );
}
