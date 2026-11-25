// 대기실 공지 템플릿 표(SCR-068, d5 §7.16). 검토 중 템플릿은 명령 7에서 고를 수 없다.
// 승인은 commander만 하고 재인증은 부르는 쪽(ConnectedPage)이 맡는다. 단추는 보이기만 막고 요청은 부르는 쪽이 막는다.
import type { NoticeRole, NoticeTexts } from '../../model/notices';

export type TemplateRow = {
  templateId: string;
  title: string;
  texts?: NoticeTexts;
  status?: 'IN_REVIEW' | 'APPROVED';
  version?: number;
  approvedBy?: { displayName?: string; role?: string } | null;
  approvedAt?: string | null;
  lastUsedAt?: string | null;
};

const LANGUAGE_MARK = ['ko', 'en', 'ja', 'zh'] as const;

export function TemplateTable({
  role,
  items,
  onEdit,
  onNew,
  onApprove,
  busy,
}: {
  role: NoticeRole;
  items: TemplateRow[];
  onEdit: (row: TemplateRow) => void;
  onNew: () => void;
  onApprove: (row: TemplateRow) => void;
  busy: boolean;
}) {
  const canEdit = role !== 'viewer';
  const canApprove = role === 'commander';
  return (
    <section className="widget" aria-labelledby="h-tpl">
      <div className="widget-head">
        <h2 className="t-sm fw-b" id="h-tpl">
          대기실 공지 템플릿
        </h2>
        <span className="actions">
          {canEdit ? (
            <button className="btn btn-secondary btn-sm" type="button" onClick={onNew} disabled={busy}>
              새 템플릿 작성
            </button>
          ) : null}
        </span>
      </div>
      <div className="banner banner-info" role="note">
        <span className="banner-title">승인 전 템플릿은 운영 명령 7에서 고를 수 없습니다</span>
        템플릿은 법무·운영 검토를 거쳐 commander가 승인합니다. operator는 작성하고 승인을 요청합니다.
      </div>
      <div className="widget-body" style={{ padding: 12 }}>
        <div className="table-wrap">
          <table className="table dense">
            <caption className="sr-only">대기실 공지 템플릿 {items.length}개</caption>
            <thead>
              <tr>
                <th scope="col">제목</th>
                <th scope="col">언어</th>
                <th scope="col">승인 상태</th>
                <th scope="col">마지막 사용</th>
                <th scope="col">
                  <span className="sr-only">작업</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {items.length === 0 ? (
                <tr>
                  <td colSpan={5} className="muted">
                    템플릿이 없습니다. operator가 작성하고 commander가 승인합니다.
                  </td>
                </tr>
              ) : null}
              {items.map((row) => {
                const approved = row.status === 'APPROVED';
                return (
                  <tr key={row.templateId}>
                    <td>
                      <strong className="fw-b">{row.title}</strong>
                      <span className="t-xs muted" style={{ display: 'block' }}>
                        {row.templateId}
                      </span>
                    </td>
                    <td>
                      <span className="row" style={{ gap: 4 }}>
                        {LANGUAGE_MARK.filter((lang) => row.texts?.[lang]?.trim()).map((lang) => (
                          <span key={lang} className="badge badge-outline">
                            {lang}
                          </span>
                        ))}
                      </span>
                    </td>
                    <td>
                      <span className={approved ? 'badge badge-success' : 'badge badge-warning'}>{approved ? '승인됨' : '검토 중'}</span>
                      {!approved ? (
                        <span className="t-xs muted" style={{ display: 'block' }}>
                          commander 승인 대기
                        </span>
                      ) : null}
                    </td>
                    <td className="muted">{row.lastUsedAt ? row.lastUsedAt.slice(0, 10) : '없음'}</td>
                    <td>
                      <span className="row" style={{ gap: 6 }}>
                        {canEdit ? (
                          <button className="btn btn-ghost btn-sm" type="button" onClick={() => onEdit(row)} disabled={busy}>
                            편집
                          </button>
                        ) : null}
                        {!approved && role !== 'viewer' ? (
                          <button
                            className="btn btn-primary btn-sm"
                            type="button"
                            aria-disabled={canApprove ? undefined : 'true'}
                            aria-describedby={canApprove ? undefined : `tpl-approve-why-${row.templateId}`}
                            onClick={() => {
                              if (canApprove && !busy) onApprove(row);
                            }}
                          >
                            승인
                          </button>
                        ) : null}
                        {!approved && !canApprove ? (
                          <span className="t-xs muted" id={`tpl-approve-why-${row.templateId}`}>
                            템플릿 승인은 commander만 할 수 있습니다
                          </span>
                        ) : null}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="hint">검토 중 템플릿은 운영 명령 7의 템플릿 목록에 나오지 않습니다.</p>
      </div>
    </section>
  );
}
