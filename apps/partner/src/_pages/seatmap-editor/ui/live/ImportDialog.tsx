'use client';
// 가져오기 대화상자(ADR-0264 결정 9, d5 §6.5 '가져오기 결과'): 형식과 파일을 고른다. 10MB를 넘거나 압축 파일이면 보내지 않는다.
// 오류는 표(줄·칸·쉬운 문구)로 보이고 반영하지 않는다. SVG에서 읽지 않은 요소는 이름만 글자로 보인다(svg·foreignObject 요소를 문서에 넣지 않는다).
// ok면 [에디터에 올리기]이고 지금 배치가 있으면 바꿀지 먼저 묻는다. 반영은 문서 바꾸기 명령 하나라 되돌릴 수 있다.
import { useState } from 'react';
import { IMPORT_MAX_BYTES, type ImportFormat, type ImportView } from '../../model/import-check';
import type { EditorStore } from '../../model/store';
import { applyImport, sendImport } from './controller';
import { LiveDialog } from './LiveDialog';

const ACCEPT: Record<ImportFormat, string> = { SVG: '.svg,image/svg+xml', JSON: '.json,application/json', CSV: '.csv,text/csv' };

export function ImportDialog({ store, productionId, onClose, onApplied, onNotFound }: { store: EditorStore; productionId: string; onClose: () => void; onApplied: () => void; onNotFound: () => void }) {
  const [format, setFormat] = useState<ImportFormat>('JSON');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [view, setView] = useState<ImportView | null>(null);
  const [confirm, setConfirm] = useState(false);
  const hasLayout = store.getState().doc.order.length > 0 || store.getState().doc.stage.length > 0;
  const send = async () => {
    if (!file) return;
    setBusy(true);
    setMessage(null);
    setView(null);
    try {
      const r = await sendImport(productionId, format, file);
      if (r.kind === 'message') {
        setMessage(r.text);
        if (r.text === '공연을 찾을 수 없습니다') onNotFound();
      } else setView(r.view);
    } finally {
      setBusy(false);
    }
  };
  const apply = () => {
    if (!view?.layout) return;
    if (hasLayout && !confirm) return setConfirm(true);
    if (applyImport(store, view.layout)) {
      onApplied();
      onClose();
    }
  };
  return (
    <LiveDialog id="import-dialog" title="좌석맵 파일 가져오기" onClose={onClose} maxWidth={720}>
      <div className="col" style={{ gap: 12 }}>
        <fieldset className="col" style={{ gap: 4, border: 0, padding: 0, margin: 0 }}>
          <legend className="label">형식</legend>
          <div className="row" style={{ gap: 12 }}>
            {(['SVG', 'JSON', 'CSV'] as const).map((f) => (
              <label key={f} className="check-row t-sm">
                <input type="radio" name="import-format" value={f} checked={format === f} onChange={() => { setFormat(f); setView(null); }} />
                {f}
              </label>
            ))}
          </div>
        </fieldset>
        <div className="field" style={{ gap: 4 }}>
          <label className="label" htmlFor="import-file">
            파일 <span className="opt">({(IMPORT_MAX_BYTES / 1024 / 1024).toFixed(0)}MB까지, 압축 파일은 받지 않습니다)</span>
          </label>
          <input id="import-file" type="file" accept={ACCEPT[format]} onChange={(e) => { setFile(e.target.files?.[0] ?? null); setView(null); setMessage(null); setConfirm(false); }} />
        </div>
        {message ? (
          <p className="error-msg" role="alert">
            <i className="ic ic-alert-circle" aria-hidden="true" />
            {message}
          </p>
        ) : null}
        {busy ? (
          <p className="t-sm" role="status">
            가져오는 중입니다
          </p>
        ) : null}
        {view && !view.ok ? (
          <div className="col" style={{ gap: 6 }}>
            <p className="error-msg" role="alert">
              <i className="ic ic-alert-circle" aria-hidden="true" />
              {`고칠 곳이 ${view.errorCount.toLocaleString('ko-KR')}개 있어 반영하지 않았습니다`}
            </p>
            <div className="table-wrap table-scroll" role="region" aria-label="가져오기 오류 행" tabIndex={0} style={{ maxHeight: 280 }}>
              <table className="table dense">
                <thead>
                  <tr>
                    <th scope="col">줄</th>
                    <th scope="col">칸</th>
                    <th scope="col">내용</th>
                  </tr>
                </thead>
                <tbody>
                  {view.rows.map((r, i) => (
                    <tr key={i}>
                      <td className="num">{r.line > 0 ? `${r.line}행` : '-'}</td>
                      <td>{r.field}</td>
                      <td>{r.text}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : null}
        {view?.ignoredText ? (
          <p className="t-sm" role="status" data-testid="import-ignored">
            {view.ignoredText}
          </p>
        ) : null}
        {view?.ok ? (
          <p className="t-sm" role="status">
            파일을 읽었습니다. 에디터에 올리면 되돌리기로 되돌릴 수 있습니다.
          </p>
        ) : null}
        {confirm ? (
          <p className="banner banner-warn t-sm" role="alert">
            지금 좌석맵을 가져온 파일로 바꿉니다. [바꾸기]를 다시 누르면 바뀝니다.
          </p>
        ) : null}
        <div className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
          <button className="btn btn-outline" type="button" onClick={onClose}>
            닫기
          </button>
          {view?.ok ? (
            <button className="btn btn-primary" type="button" onClick={apply}>
              {confirm ? '바꾸기' : '에디터에 올리기'}
            </button>
          ) : (
            <button className="btn btn-primary" type="button" disabled={!file || busy} onClick={() => void send()}>
              가져오기
            </button>
          )}
        </div>
      </div>
    </LiveDialog>
  );
}
