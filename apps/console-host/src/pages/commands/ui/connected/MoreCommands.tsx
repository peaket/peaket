// 그 밖의 운영 명령(2·4·5·8·9·11·12) 작성 카드(F-03-7). 명령 7·10은 계약·경로가 없어 두지 않는다(계획 '하지 않는다').
// 막힘·본문은 model/command-form.ts가 정하고, 이 부품은 칸만 그린다. 8·9는 계약 확정 전 표지를 단다.
import { useState } from 'react';
import { commandAvailability, commandBodyOf, COMMAND_NAMES, type CommandDraft, type CommandKind, type ConsoleLayoutKind, type ConsoleRole } from '../../model/command-form';

const KINDS: readonly CommandKind[] = ['ADMISSION_PAUSE', 'BLOCK_ASN_IP', 'BOT_LEVEL', 'LOG_LEVEL', 'FEATURE_OFF', 'AUTOMATION_STOP', 'PG_ASSIGN'];
const OPEN_CONTRACT = new Set<CommandKind>(['LOG_LEVEL', 'FEATURE_OFF']);

function initial(kind: CommandKind, eventId: string): CommandDraft {
  switch (kind) {
    case 'ADMISSION_PAUSE':
      return { kind, eventId, reason: '' };
    case 'BLOCK_ASN_IP':
      return { kind, cidrsText: '', asnsText: '', expiresAt: '', reason: '' };
    case 'BOT_LEVEL':
      return { kind, level: 'STANDARD', reason: '' };
    case 'LOG_LEVEL':
      return { kind, service: '', level: 'DEBUG', reason: '' };
    case 'FEATURE_OFF':
      return { kind, flag: '', reason: '' };
    case 'AUTOMATION_STOP':
      return { kind, reason: '' };
    case 'PG_ASSIGN':
      return { kind, eventId, primaryPg: 'TOSS', reason: '' };
    default:
      return { kind: 'ADMISSION_TARGET', eventId, target: Number.NaN, reason: '' };
  }
}

export function MoreCommands({
  role,
  layout,
  eventId,
  busy,
  onSend,
}: {
  role: ConsoleRole;
  layout: ConsoleLayoutKind;
  eventId: string | null;
  busy: boolean;
  onSend: (draft: CommandDraft) => void;
}) {
  const [kind, setKind] = useState<CommandKind>('ADMISSION_PAUSE');
  const [draft, setDraft] = useState<CommandDraft>(() => initial('ADMISSION_PAUSE', eventId ?? ''));
  const availability = commandAvailability({ role, layout, kind });
  const ready = commandBodyOf(draft) !== null;
  const pick = (k: CommandKind) => {
    setKind(k);
    setDraft(initial(k, eventId ?? ''));
  };
  const set = (patch: Record<string, unknown>) => setDraft((d) => ({ ...d, ...patch }) as CommandDraft);
  if (layout === 'phone' && kind !== 'AUTOMATION_STOP') {
    return (
      <section className="widget" aria-labelledby="more-h">
        <div className="widget-head"><h2 className="t-sm fw-b" id="more-h">그 밖의 명령</h2></div>
        <div className="widget-body t-sm muted">{availability.reason}</div>
      </section>
    );
  }
  return (
    <section className="widget" aria-labelledby="more-h">
      <div className="widget-head">
        <h2 className="t-sm fw-b" id="more-h">그 밖의 명령</h2>
        {OPEN_CONTRACT.has(kind) ? <span className="badge badge-warning">계약 확정 전</span> : null}
      </div>
      <div className="widget-body col" style={{ gap: 8 }}>
        <label className="field">
          <span className="label">명령</span>
          <select className="input" value={kind} onChange={(e) => pick(e.target.value as CommandKind)}>
            {KINDS.map((k) => <option key={k} value={k}>{COMMAND_NAMES[k]}</option>)}
          </select>
        </label>
        {kind === 'ADMISSION_PAUSE' || kind === 'PG_ASSIGN' ? (
          <label className="field"><span className="label">회차</span><input className="input" value={'eventId' in draft ? draft.eventId : ''} onChange={(e) => set({ eventId: e.target.value })} /></label>
        ) : null}
        {kind === 'BLOCK_ASN_IP' && draft.kind === 'BLOCK_ASN_IP' ? (
          <>
            <label className="field"><span className="label">CIDR(쉼표·줄바꿈)</span><textarea className="input" value={draft.cidrsText} onChange={(e) => set({ cidrsText: e.target.value })} /></label>
            <label className="field"><span className="label">ASN(쉼표·줄바꿈)</span><input className="input" value={draft.asnsText} onChange={(e) => set({ asnsText: e.target.value })} /></label>
            <label className="field"><span className="label">만료 시각(24시간 이하)</span><input className="input" type="datetime-local" value={draft.expiresAt ? draft.expiresAt.slice(0, 16) : ''} onChange={(e) => set({ expiresAt: e.target.value ? new Date(e.target.value).toISOString() : '' })} /></label>
          </>
        ) : null}
        {kind === 'BOT_LEVEL' && draft.kind === 'BOT_LEVEL' ? (
          <div className="row wrap" style={{ gap: 8 }}>
            <label className="field"><span className="label">강도</span><select className="input" value={draft.level} onChange={(e) => set({ level: e.target.value })}><option value="RELAXED">완화</option><option value="STANDARD">기본</option><option value="AGGRESSIVE">강화</option></select></label>
            <label className="field"><span className="label">대기 중 재평가</span><select className="input" value={draft.reassessMode ?? ''} onChange={(e) => set({ reassessMode: e.target.value || undefined })}><option value="">고르지 않음</option><option value="OFF">끔</option><option value="SHADOW">그림자</option><option value="ENFORCE">적용</option></select></label>
          </div>
        ) : null}
        {kind === 'LOG_LEVEL' && draft.kind === 'LOG_LEVEL' ? (
          <div className="row wrap" style={{ gap: 8 }}>
            <label className="field"><span className="label">서비스</span><input className="input" value={draft.service} onChange={(e) => set({ service: e.target.value })} /></label>
            <label className="field"><span className="label">레벨(30분 자동 복귀)</span><select className="input" value={draft.level} onChange={(e) => set({ level: e.target.value })}><option value="DEBUG">DEBUG</option><option value="TRACE">TRACE</option><option value="INFO">INFO</option></select></label>
          </div>
        ) : null}
        {kind === 'FEATURE_OFF' && draft.kind === 'FEATURE_OFF' ? (
          <label className="field"><span className="label">기능 플래그</span><input className="input" value={draft.flag} onChange={(e) => set({ flag: e.target.value })} /></label>
        ) : null}
        {kind === 'PG_ASSIGN' && draft.kind === 'PG_ASSIGN' ? (
          <div className="row wrap" style={{ gap: 8 }}>
            <label className="field"><span className="label">기본 결제사</span><select className="input" value={draft.primaryPg} onChange={(e) => set({ primaryPg: e.target.value })}><option value="TOSS">토스페이먼츠</option><option value="PORTONE">포트원</option></select></label>
            <label className="field"><span className="label">대체 결제사(선택)</span><select className="input" value={draft.fallbackPg ?? ''} onChange={(e) => set({ fallbackPg: e.target.value || undefined })}><option value="">없음</option><option value="TOSS">토스페이먼츠</option><option value="PORTONE">포트원</option></select></label>
          </div>
        ) : null}
        {kind === 'AUTOMATION_STOP' ? <p className="t-xs muted">입장 제어의 모든 자동 제어 알고리즘을 멈춥니다. 오토스케일링은 대상이 아닙니다. 재개는 2인 승인입니다.</p> : null}
        <label className="field"><span className="label">실행 사유(필수)</span><textarea className="input" maxLength={2000} value={draft.reason} onChange={(e) => set({ reason: e.target.value })} /></label>
        {!availability.canRequest ? <p className="hint">{availability.reason}</p> : null}
        <button className="btn btn-primary" type="button" disabled={!availability.canRequest || !ready || busy} aria-disabled={!availability.canRequest || !ready} title={availability.reason} onClick={() => onSend(draft)}>
          {kind === 'AUTOMATION_STOP' ? '자동화 정지' : '보내기'}
        </button>
      </div>
    </section>
  );
}
