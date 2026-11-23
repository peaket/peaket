// 명령 1·3·6(결제 갈래) 작성 칸(F-03-4, d5 §7.3 '중앙 작성 폼'). props만으로 그린다.
// 막히면 단추는 aria-disabled(초점은 받음, disabled 없음)이고 카드 안에 이유 글이 늘 보이며 aria-describedby로 잇는다(d5 CMP-036 disabled).
// 막힌 단추를 눌러도 onSubmit을 부르지 않는다(요청 0). 명령 3은 단추를 누르면 위험 확인 대화상자가 사유를 다시 받는다(여기 적은 사유를 채워 둔다).
import type { Availability, CommandDraft, CommandScope, PgName } from '../../model/command-form';

export interface CommandFormProps {
  draft: CommandDraft;
  onChange: (next: CommandDraft) => void;
  availability: Availability;
  /** [보내기]·[판매를 전면 중단합니다]를 눌렀을 때(막혔으면 부르지 않는다) */
  onSubmit?: () => void;
  /** 보내는 중 */
  busy?: boolean;
  /** 본문을 만들 수 있는가(칸이 다 찼는가). 명령 3은 사유를 대화상자에서 받으므로 보지 않는다 */
  ready?: boolean;
}

const BLOCK_ID = 'cmd-form-block-reason';
const REASON_ID = 'cmd-form-reason';
const REASON_MAX = 2000;

function ScopeChoice({ scope, onPick, name }: { scope: CommandScope; onPick: (s: CommandScope) => void; name: string }) {
  return (
    <fieldset className="row" style={{ gap: 12, border: 0, padding: 0, margin: 0 }}>
      <legend className="t-xs muted">범위</legend>
      <label className="t-sm">
        <input type="radio" name={name} checked={scope === 'EVENT'} onChange={() => onPick('EVENT')} /> 이 회차
      </label>
      <label className="t-sm">
        <input type="radio" name={name} checked={scope === 'PLATFORM'} onChange={() => onPick('PLATFORM')} /> 전체 회차
      </label>
    </fieldset>
  );
}

function ReasonField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <label className="field" htmlFor={REASON_ID}>
      <span className="label">사유(필수)</span>
      <textarea id={REASON_ID} className="input" rows={3} maxLength={REASON_MAX} value={value} onChange={(e) => onChange(e.currentTarget.value)} />
      <span className="t-xs muted">
        {value.length.toLocaleString('ko-KR')}/{REASON_MAX.toLocaleString('ko-KR')}자 · 사유는 감사 로그에 그대로 남습니다
      </span>
    </label>
  );
}

export function CommandForm({ draft, onChange, availability, onSubmit, busy = false, ready = true }: CommandFormProps) {
  const blocked = !availability.canRequest;
  const reasonLine = blocked && availability.reason ? (
    <p className="t-xs" id={BLOCK_ID} style={{ color: 'var(--danger)' }}>
      {availability.reason}
    </p>
  ) : null;
  const press = () => {
    if (blocked || busy) return;
    onSubmit?.();
  };

  if (draft.kind === 'KILL_SWITCH') {
    return (
      <div className="col" style={{ gap: 12 }}>
        <ScopeChoice name="kill-scope" scope={draft.scope} onPick={(scope) => onChange({ ...draft, scope })} />
        <ReasonField value={draft.reason} onChange={(reason) => onChange({ ...draft, reason })} />
        <p className="t-xs muted">판매를 멈추면 새 결제가 막힙니다. 되돌리기(판매 재개)는 2인 승인입니다.</p>
        <button
          className="btn btn-danger"
          type="button"
          aria-disabled={blocked || busy ? 'true' : undefined}
          aria-describedby={reasonLine ? BLOCK_ID : undefined}
          onClick={press}
        >
          ! 판매를 전면 중단합니다
        </button>
        {reasonLine}
      </div>
    );
  }

  const canSend = !blocked && !busy && ready;
  return (
    <div className="col" style={{ gap: 12 }}>
      {draft.kind === 'ADMISSION_TARGET' ? (
        <label className="field">
          <span className="label">새 동시 입장 목표(명)</span>
          <input
            className="input"
            type="number"
            inputMode="numeric"
            min={1}
            step={1}
            value={Number.isFinite(draft.target) ? String(draft.target) : ''}
            onChange={(e) => onChange({ ...draft, target: e.currentTarget.value === '' ? Number.NaN : Number(e.currentTarget.value) })}
          />
          {draft.fromTarget !== undefined ? <span className="t-xs muted">지금 목표 {draft.fromTarget.toLocaleString('ko-KR')}명</span> : null}
        </label>
      ) : (
        <>
          <ScopeChoice name="pg-scope" scope={draft.scope} onPick={(scope) => onChange({ ...draft, scope })} />
          <label className="field">
            <span className="label">보낼 결제사</span>
            <select
              className="input"
              value={draft.toPg ?? ''}
              onChange={(e) => {
                const v = e.currentTarget.value as PgName | '';
                const next: CommandDraft = { kind: 'PG_FALLBACK', scope: draft.scope, reason: draft.reason, ...(draft.eventId ? { eventId: draft.eventId } : {}), ...(v ? { toPg: v } : {}) };
                onChange(next);
              }}
            >
              <option value="">대체 결제사(서버가 고름)</option>
              <option value="TOSS">토스페이먼츠</option>
              <option value="PORTONE">포트원</option>
            </select>
          </label>
          <p className="t-xs muted">대체 결제사 전환은 2인 승인입니다. 요청자가 아닌 운영자가 승인하면 전환됩니다.</p>
        </>
      )}
      <ReasonField value={draft.reason} onChange={(reason) => onChange({ ...draft, reason })} />
      <button
        className="btn btn-primary"
        type="button"
        aria-disabled={canSend ? undefined : 'true'}
        aria-describedby={reasonLine ? BLOCK_ID : undefined}
        onClick={() => {
          if (canSend) press();
        }}
      >
        {draft.kind === 'ADMISSION_TARGET' ? '보내기' : '전환 요청'}
      </button>
      {reasonLine}
    </div>
  );
}
