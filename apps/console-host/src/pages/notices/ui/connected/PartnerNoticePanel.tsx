// 파트너 긴급 공지 작성·발송 이력(SCR-068, d5 §7.16, POL-022). operator가 1인으로 보내고 감사 로그에 남는다.
import { PhoneScopeCard } from '@/shared/ui/PhoneScopeCard';
import {
  PARTNER_BODY_MAX,
  PARTNER_PHASE_PREFIX,
  PARTNER_TITLE_MAX,
  partnerIssue,
  type NoticeLayout,
  type NoticeRole,
  type PartnerChannel,
  type PartnerDraft,
  type PartnerPhase,
} from '../../model/notices';

export type PartnerRow = {
  noticeId: string;
  targetKind: 'ALL' | 'EVENT';
  eventId?: string | null;
  phase: PartnerPhase;
  title: string;
  body: string;
  channels: PartnerChannel[];
  sentAt?: string;
  sentBy?: { displayName?: string };
  recipientCount?: number | null;
};

export function PartnerNoticePanel({
  role,
  layout,
  draft,
  onChange,
  onSend,
  history,
  busy,
  error,
}: {
  role: NoticeRole;
  layout: NoticeLayout;
  draft: PartnerDraft;
  onChange: (draft: PartnerDraft) => void;
  onSend: () => void;
  history: PartnerRow[];
  busy: boolean;
  error?: string | null;
}) {
  const phone = layout === 'phone';
  const issue = partnerIssue(draft);
  const set = (patch: Partial<PartnerDraft>) => onChange({ ...draft, ...patch });
  const toggleChannel = (channel: PartnerChannel, on: boolean) =>
    set({ channels: on ? [...new Set([...draft.channels, channel])] : draft.channels.filter((c) => c !== channel) });

  return (
    <div className="col" style={{ gap: 16 }}>
      {phone ? <PhoneScopeCard title="파트너 긴급 공지 보내기" /> : null}
      {phone || role === 'viewer' ? null : (
        <section className="widget" aria-labelledby="h-pn">
          <div className="widget-head">
            <h2 className="t-sm fw-b" id="h-pn">
              파트너 긴급 공지
            </h2>
            <span className="t-xs muted">operator 1인 발송 · 감사 로그</span>
          </div>
          <div className="widget-body" style={{ padding: 16, display: 'grid', gap: 12 }}>
            <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
              <div className="field">
                <label className="label" htmlFor="pn-target">
                  대상
                </label>
                <select id="pn-target" name="partner-target" className="select" value={draft.targetKind} onChange={(e) => set({ targetKind: e.target.value as 'ALL' | 'EVENT' })}>
                  <option value="ALL">전체 파트너</option>
                  <option value="EVENT">회차의 파트너</option>
                </select>
              </div>
              {draft.targetKind === 'EVENT' ? (
                <div className="field">
                  <label className="label" htmlFor="pn-event">
                    회차 ID
                  </label>
                  <input id="pn-event" name="partner-event" className="input input-sm" type="text" value={draft.eventId ?? ''} onChange={(e) => set({ eventId: e.target.value })} />
                </div>
              ) : null}
              <div className="field">
                <label className="label" htmlFor="pn-phase">
                  말머리
                </label>
                <select id="pn-phase" name="partner-phase" className="select" value={draft.phase} onChange={(e) => set({ phase: e.target.value as PartnerPhase })}>
                  {(['OCCURRED', 'ONGOING', 'RESOLVED'] as const).map((phase) => (
                    <option key={phase} value={phase}>
                      {PARTNER_PHASE_PREFIX[phase]} {phase === 'OCCURRED' ? '발생' : phase === 'ONGOING' ? '진행' : '해결'}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="field">
              <label className="label" htmlFor="pn-title">
                제목 (말머리 뒤, 최대 {PARTNER_TITLE_MAX}자)
              </label>
              <input id="pn-title" name="partner-title" className="input input-sm" type="text" value={draft.title} maxLength={PARTNER_TITLE_MAX} onChange={(e) => set({ title: e.target.value })} />
            </div>
            <div className="field">
              <label className="label" htmlFor="pn-body">
                본문 (최대 {PARTNER_BODY_MAX}자)
              </label>
              <textarea id="pn-body" name="partner-body" className="textarea" value={draft.body} maxLength={PARTNER_BODY_MAX} onChange={(e) => set({ body: e.target.value })} />
              <span className="hint">무슨 일 → 언제부터·지금 상태 → 파트너 영향과 할 일 → 다음 안내 시각 순서로 씁니다.</span>
            </div>
            <fieldset className="field">
              <legend className="label">채널</legend>
              <label className="row" style={{ gap: 6 }}>
                <input type="checkbox" name="channel-console" checked={draft.channels.includes('CONSOLE_POPUP')} onChange={(e) => toggleChannel('CONSOLE_POPUP', e.target.checked)} />
                콘솔 팝업
              </label>
              <label className="row" style={{ gap: 6 }}>
                <input type="checkbox" name="channel-email" checked={draft.channels.includes('EMAIL')} onChange={(e) => toggleChannel('EMAIL', e.target.checked)} />
                이메일
              </label>
            </fieldset>
            {issue ? (
              <p className="hint" role="status">
                {issue}
              </p>
            ) : null}
            {error ? (
              <p className="hint" role="alert">
                {error}
              </p>
            ) : null}
            <div className="row" style={{ justifyContent: 'flex-end' }}>
              <button
                className="btn btn-primary"
                type="button"
                aria-disabled={issue ? 'true' : undefined}
                onClick={() => {
                  if (!issue && !busy) onSend();
                }}
              >
                보내기
              </button>
            </div>
          </div>
        </section>
      )}
      {phone || role === 'viewer' ? null : (
        <section className="widget" aria-labelledby="h-pn">
          <div className="widget-head">
            <h2 className="t-sm fw-b" id="h-pn">
              발송 이력
            </h2>
          </div>
          <div className="widget-body" style={{ padding: 12 }}>
            <div className="table-wrap">
              <table className="table dense">
                <caption className="sr-only">파트너 긴급 공지 발송 이력 {history.length}건</caption>
                <thead>
                  <tr>
                    <th scope="col">말머리</th>
                    <th scope="col">제목</th>
                    <th scope="col">채널</th>
                    <th scope="col">보낸 시각</th>
                    <th scope="col">받는 파트너</th>
                  </tr>
                </thead>
                <tbody>
                  {history.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="muted">
                        발송 이력이 없습니다.
                      </td>
                    </tr>
                  ) : null}
                  {history.map((row) => (
                    <tr key={row.noticeId}>
                      <td>{PARTNER_PHASE_PREFIX[row.phase]}</td>
                      <td>
                        <strong className="fw-b">{row.title}</strong>
                        <span className="t-xs muted" style={{ display: 'block' }}>
                          {row.body}
                        </span>
                      </td>
                      <td>{row.channels.map((c) => (c === 'EMAIL' ? '이메일' : '콘솔 팝업')).join(' · ')}</td>
                      <td className="muted">{row.sentAt ? row.sentAt.slice(0, 16).replace('T', ' ') : '—'}</td>
                      <td className="muted">{row.recipientCount ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      )}
      {phone ? (
        <section className="widget" aria-labelledby="h-pn">
          <div className="widget-head">
            <h2 className="t-sm fw-b" id="h-pn">
              최근 발송
            </h2>
          </div>
          <div className="widget-body" style={{ padding: 12, display: 'grid', gap: 8 }}>
            {history.length === 0 ? <p className="muted">발송 이력이 없습니다.</p> : null}
            {history.map((row) => (
              <article key={row.noticeId} className="col" style={{ gap: 2 }}>
                <span className="t-sm fw-b">{row.title}</span>
                <span className="t-xs muted">{row.body}</span>
              </article>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
