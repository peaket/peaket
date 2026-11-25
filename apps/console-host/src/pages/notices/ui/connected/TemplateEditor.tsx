// 템플릿 작성·고치기(SCR-068, d5 §7.16). 네 언어가 모두 있어야 저장·승인 요청할 수 있다.
import { PhoneScopeCard } from '@/shared/ui/PhoneScopeCard';
import { NOTICE_LANGS, TEXT_MAX, missingLanguages, templateIssue, type NoticeLayout, type NoticeRole, type NoticeTexts } from '../../model/notices';

export type TemplateDraft = { templateId: string; title: string; texts: NoticeTexts };

export function TemplateEditor({
  role,
  layout,
  draft,
  onChange,
  onSave,
  onClose,
  busy,
}: {
  role: NoticeRole;
  layout: NoticeLayout;
  draft: TemplateDraft;
  onChange: (draft: TemplateDraft) => void;
  onSave: () => void;
  onClose: () => void;
  busy: boolean;
}) {
  if (layout === 'phone') return <PhoneScopeCard title="템플릿 작성" />;
  const issue = templateIssue(draft);
  const missing = missingLanguages(draft.texts);
  const readOnly = role === 'viewer';
  const set = (patch: Partial<TemplateDraft>) => onChange({ ...draft, ...patch });
  const setText = (lang: keyof NoticeTexts, value: string) => onChange({ ...draft, texts: { ...draft.texts, [lang]: value } });
  return (
    <section className="widget" aria-labelledby="h-edit">
      <div className="widget-head">
        <h2 className="t-sm fw-b" id="h-edit">
          템플릿 편집 · {draft.title || '새 템플릿'}
        </h2>
        <span className="actions">
          <button className="btn btn-ghost btn-sm" type="button" onClick={onClose}>
            편집 닫기
          </button>
        </span>
      </div>
      <div className="widget-body" style={{ padding: 16, display: 'grid', gap: 14 }}>
        <div className="field">
          <label className="label" htmlFor="te-title">
            제목 (필수, 60자까지)
          </label>
          <input className="input input-sm" id="te-title" name="template-title" type="text" value={draft.title} readOnly={readOnly} maxLength={60} onChange={(e) => set({ title: e.target.value })} />
        </div>
        <div className="field">
          <label className="label" htmlFor="te-id">
            템플릿 id (영문 소문자·숫자·하이픈, 만든 뒤 바꾸지 않음)
          </label>
          <input className="input input-sm" id="te-id" name="template-id" type="text" value={draft.templateId} readOnly={readOnly} onChange={(e) => set({ templateId: e.target.value })} />
        </div>
        {NOTICE_LANGS.map((lang) => (
          <div className="field" key={lang}>
            <label className="label" htmlFor={`te-${lang}`}>
              {lang} 문구 {missing.includes(lang) ? '(필수, 빠짐)' : '(필수)'}
            </label>
            <textarea
              className="textarea"
              id={`te-${lang}`}
              name={`template-${lang}`}
              lang={lang}
              value={draft.texts[lang]}
              readOnly={readOnly}
              maxLength={TEXT_MAX}
              onChange={(e) => setText(lang, e.target.value)}
            />
            <span className="counter" aria-live="polite">
              남은 글자 {TEXT_MAX - draft.texts[lang].length}자 · 최대 {TEXT_MAX}자
            </span>
          </div>
        ))}
        {issue ? (
          <p className="hint" id="te-issue" role="status">
            {issue}
          </p>
        ) : null}
        <p className="t-xs muted">저장하면 검토 중으로 남고, commander가 승인한 뒤에 운영 명령 7에서 고를 수 있습니다.</p>
        <div className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
          {role !== 'viewer' ? (
            <button
              className="btn btn-primary"
              type="button"
              aria-disabled={issue ? 'true' : undefined}
              aria-describedby={issue ? 'te-issue' : undefined}
              onClick={() => {
                if (!issue && !busy) onSave();
              }}
            >
              저장하고 승인 요청하기
            </button>
          ) : null}
        </div>
      </div>
    </section>
  );
}
