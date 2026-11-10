'use client';
// SCR-022 실제 좌석맵 에디터(ADR-0264). LiveSeatmapEditor가 늦게 싣는 덩어리다: 캔버스(Konva, CMP-051)·저장소·Worker·도구가 여기서부터 실린다.
// 불러오기(GET …/seatmap)로 열고 [좌석맵 저장]을 누를 때만 PUT을 보낸다. 배치본이 없으면(404) 시작 화면이다. 다른 파트너 공연도 같은 404라
// 시작 화면을 보이고, 저장·가져오기가 404면 '공연을 찾을 수 없습니다'로 바꾼다(ADR-0264 결정 19). 저장하지 않은 채 떠나면 브라우저 확인을 묻고,
// 앱 안 링크도 같은 확인을 묻는다(결정 32). 저장 요청이 오가는 동안은 편집을 받지 않는다(결정 30).
import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from 'zustand';
import { mountSeatmapCanvas, type CanvasHandle } from '@/widgets/seatmap-canvas';
import { emptyDoc, sectionsInOrder } from '../../model/doc';
import type { ExportFormat } from '../../model/export';
import { removeShapeCmd, seatsCmd, type EditorStore } from '../../model/store';
import { canSave, fieldLabel, TEXT, type SaveAnswer } from '../../model/save-answer';
import { moveSeats } from '../../model/refine';
import { moveShape, NUDGE_BIG_CM, NUDGE_CM } from '../../model/shapes';
import { updateSectionCmd, updateStageCmd } from '../../model/store';
import { sectionOf } from '../../model/types';
import { canvasHost } from './canvas-host';
import { deleteSelectedSeats, exportDoc, jobError, loadInto, refine, reload, save } from './controller';
import { ImportDialog } from './ImportDialog';
import { LiveDialog } from './LiveDialog';
import { PropsArea } from './Panels';
import { Preview } from './Preview';
import { Summary } from './Summary';
import { SelectionBar, Toolbar } from './Toolbar';
import { Tree } from './Tree';

type Phase = { kind: 'loading' } | { kind: 'error' } | { kind: 'notFound' } | { kind: 'start'; store: EditorStore } | { kind: 'edit'; store: EditorStore };

const kstTime = (t: number) => new Date(t + 9 * 3_600_000).toISOString().slice(11, 16);
/** 앱 안 링크를 누를 때 묻는 말(beforeunload는 브라우저 문구다) */
const LEAVE_TEXT = '저장하지 않은 변경이 있습니다. 이 화면을 떠날까요?';

/** 이 창에서 같은 출처로 옮기는 링크 누르기인가(새 탭·수정 키·내려받기·다른 출처는 아니다) */
function sameTabLink(e: MouseEvent): HTMLAnchorElement | null {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return null;
  const a = e.target instanceof Element ? e.target.closest('a[href]') : null;
  if (!(a instanceof HTMLAnchorElement) || a.hasAttribute('download') || (a.target !== '' && a.target !== '_self')) return null;
  const to = new URL(a.href, location.href);
  if (to.origin !== location.origin) return null;
  // 같은 화면 안의 자리 옮기기(#)는 떠나기가 아니다
  if (to.pathname === location.pathname && to.search === location.search && to.hash !== '') return null;
  return a;
}

const inField = (t: EventTarget | null) => t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement || (t instanceof HTMLElement && t.isContentEditable);

export default function EditorApp({ productionId }: { productionId: string }) {
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [importOpen, setImportOpen] = useState(false);
  const load = useCallback(async () => {
    setPhase({ kind: 'loading' });
    const r = await loadInto(productionId);
    setPhase(r.kind === 'error' ? { kind: 'error' } : r.kind === 'none' ? { kind: 'start', store: r.store } : { kind: 'edit', store: r.store });
  }, [productionId]);
  useEffect(() => {
    void load();
  }, [load]);

  if (phase.kind === 'loading') return <p className="t-sm muted" role="status">좌석맵을 불러오는 중입니다</p>;
  if (phase.kind === 'notFound') return <NotFound />;
  if (phase.kind === 'error')
    return (
      <div className="banner banner-danger" role="alert">
        <div className="banner-body">좌석맵을 불러오지 못했습니다.</div>
        <button className="btn btn-outline btn-sm" type="button" onClick={() => void load()}>
          다시 불러오기
        </button>
      </div>
    );
  if (phase.kind === 'start') {
    const st = phase.store;
    return (
      <>
        <section className="card pad-lg col" style={{ gap: 14 }} aria-labelledby="h-start">
          <h2 className="t-lg" id="h-start">
            어떻게 시작할까요?
          </h2>
          <div className="grid gap-3 md:grid-cols-2">
            <button className="card pad col" type="button" style={{ gap: 6, textAlign: 'left' }} onClick={() => { st.getState().reset(emptyDoc(), 0, st.getState().locked); setPhase({ kind: 'edit', store: st }); }}>
              <span className="t-md fw-b">빈 캔버스에서 그리기</span>
              <span className="t-sm muted">무대와 구역을 처음부터 그립니다</span>
            </button>
            <button className="card pad col" type="button" style={{ gap: 6, textAlign: 'left' }} onClick={() => setImportOpen(true)}>
              <span className="t-md fw-b">파일 가져오기</span>
              <span className="t-sm muted">SVG·JSON·CSV 좌석맵 파일을 불러옵니다</span>
            </button>
          </div>
        </section>
        {importOpen ? <ImportDialog store={st} productionId={productionId} onClose={() => setImportOpen(false)} onApplied={() => setPhase({ kind: 'edit', store: st })} onNotFound={() => setPhase({ kind: 'notFound' })} /> : null}
      </>
    );
  }
  return <Workspace store={phase.store} productionId={productionId} onNotFound={() => setPhase({ kind: 'notFound' })} />;
}

function NotFound() {
  return (
    <section className="card pad-lg col" style={{ gap: 8 }} role="alert">
      <h2 className="t-lg">공연을 찾을 수 없습니다</h2>
      <p className="t-sm muted">주소를 확인하거나 공연 관리에서 다시 고르세요.</p>
    </section>
  );
}

function Workspace({ store, productionId, onNotFound }: { store: EditorStore; productionId: string; onNotFound: () => void }) {
  const step = useStore(store, (s) => s.step);
  const locked = useStore(store, (s) => s.locked);
  const changes = useStore(store, (s) => s.changes);
  const [scale, setScale] = useState(1);
  const saving = useStore(store, (s) => s.saving);
  const [busyUntil, setBusyUntil] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [answer, setAnswer] = useState<SaveAnswer | { kind: 'blocked'; text: string } | null>(null);
  // 422 표의 자리 이름은 보낸 때의 구역 이름으로 읽는다
  const [sentNames, setSentNames] = useState<readonly string[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [refill, setRefill] = useState<{ n: number; go: () => void } | null>(null);
  const [working, setWorking] = useState(false);
  const canvasEl = useRef<HTMLDivElement>(null);
  const canvas = useRef<CanvasHandle | null>(null);
  // 앱 안 링크에서 떠나기로 한 뒤에는 브라우저 확인을 다시 묻지 않는다
  const leaving = useRef(false);

  // 캔버스(Konva)는 이 덩어리에서만 실린다
  useEffect(() => {
    if (step === 4 || !canvasEl.current) return;
    const h = mountSeatmapCanvas(canvasEl.current, canvasHost(store, setScale, setMessage));
    canvas.current = h;
    return () => {
      h.destroy();
      canvas.current = null;
    };
  }, [store, step === 4]);

  // 저장하지 않은 편집이 있으면 떠날 때 묻는다(브라우저 저장소에는 넣지 않는다)
  useEffect(() => {
    if (changes === 0) return;
    const onLeave = (e: BeforeUnloadEvent) => {
      if (leaving.current) return;
      e.preventDefault();
      e.returnValue = '';
    };
    // 앱 안 이동(빵부스러기·셸 메뉴 링크)은 beforeunload가 없어 누르기를 캡처 단계에서 먼저 받아 묻는다(ADR-0264 결정 32)
    const onClick = (e: MouseEvent) => {
      if (!sameTabLink(e)) return;
      if (window.confirm(LEAVE_TEXT)) {
        leaving.current = true;
        return;
      }
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener('beforeunload', onLeave);
    window.addEventListener('click', onClick, true);
    return () => {
      window.removeEventListener('beforeunload', onLeave);
      window.removeEventListener('click', onClick, true);
    };
  }, [changes]);

  // 429·503 뒤 Retry-After 동안 [좌석맵 저장]을 잠근다
  useEffect(() => {
    if (busyUntil === null || busyUntil <= now) return;
    const t = setTimeout(() => setNow(Date.now()), busyUntil - now + 20);
    return () => clearTimeout(t);
  }, [busyUntil, now]);

  // 키보드: 되돌리기·다시 하기, 화살표 10cm·Shift 1m, 지우기, Esc
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (inField(e.target) || document.querySelector('[aria-modal="true"]')) return;
      const s = store.getState();
      // 저장 중에는 편집 키를 받지 않는다(저장소도 명령을 받지 않는다)
      if (s.saving) return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) s.redo();
        else s.undo();
        return;
      }
      if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        s.redo();
        return;
      }
      const arrows: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
      const a = arrows[e.key];
      if (a) {
        const d = e.shiftKey ? NUDGE_BIG_CM : NUDGE_CM;
        if (s.step === 3 && s.seatSel.size > 0) {
          e.preventDefault();
          const r = moveSeats(s.doc, s.seatSel, a[0] * d, a[1] * d);
          s.exec(seatsCmd(s.doc, '좌석 옮기기', r.changes));
        } else if (s.step === 1 && s.sel) {
          e.preventDefault();
          const sel = s.sel;
          const shape = sel.kind === 'stage' ? s.doc.stage[sel.index] : sectionOf(s.doc, sel.id)?.shape;
          if (!shape) return;
          const moved = moveShape(shape, a[0] * d, a[1] * d, s.doc.canvas);
          s.exec(sel.kind === 'stage' ? updateStageCmd(s.doc, sel.index, moved) : updateSectionCmd(s.doc, sel.id, { shape: moved }));
        }
        return;
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (s.step === 3 && s.seatSel.size > 0) deleteSelectedSeats(store);
        else if (s.step === 1 && s.sel) s.exec(removeShapeCmd(s.doc, s.sel));
        return;
      }
      if (e.key === 'Escape') {
        s.select(null);
        s.selectSeats([]);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [store]);

  const onSave = async () => {
    if (store.getState().saving) return;
    setMessage(null);
    setSentNames(sectionsInOrder(store.getState().doc).map((x) => x.name));
    const a = await save(store, productionId);
    setAnswer(a.kind === 'saved' ? null : a);
    if (a.kind === 'saved') {
      setSavedAt(kstTime(Date.now()));
      setNotice(a.notice);
      setBusyUntil(null);
    } else if (a.kind === 'busy') {
      setBusyUntil(a.retryAt);
      setNow(Date.now());
    } else if (a.kind === 'notFound') onNotFound();
  };
  const onExport = async (f: ExportFormat) => {
    try {
      const out = await exportDoc(store, productionId, f);
      setNotice(out.skippedSections > 0 ? `좌석이 없는 구역 ${out.skippedSections}개는 CSV에 싣지 못해 뺐습니다` : `${out.name} 파일을 내보냈습니다`);
    } catch (e) {
      const t = jobError(e);
      if (t) setMessage(t);
    }
  };
  const onReload = async () => {
    if (store.getState().saving) return;
    if (store.getState().changes > 0 && !window.confirm('저장하지 않은 변경을 버리고 서버의 좌석맵을 다시 불러올까요?')) return;
    if (await reload(store, productionId)) setAnswer(null);
    else setMessage('좌석맵을 불러오지 못했습니다. 다시 해 주세요');
  };
  const onRefine = async (t: 'align' | 'distribute' | 'aisle' | 'renumber') => {
    setWorking(true);
    try {
      await refine(store, t);
    } catch (e) {
      const m = jobError(e);
      if (m) setMessage(m);
    } finally {
      setWorking(false);
    }
  };

  const saveLocked = !canSave(busyUntil, now);
  return (
    <div className="col gap-4" style={{ flex: 1 }}>
      {locked && answer?.kind !== 'locked' ? (
        <div className="banner banner-warn" role="status">
          <i className="ic ic-lock" aria-hidden="true" />
          <div className="banner-body">{TEXT.locked}</div>
        </div>
      ) : null}
      {answer?.kind === 'conflict' ? (
        <div className="banner banner-danger" role="alert">
          <div className="banner-body">{answer.text}</div>
          <button className="btn btn-outline btn-sm" type="button" onClick={() => void onExport('JSON')}>
            JSON으로 내보내기
          </button>
          <button className="btn btn-outline btn-sm" type="button" disabled={saving} onClick={() => void onReload()}>
            다시 불러오기
          </button>
        </div>
      ) : null}
      {answer?.kind === 'locked' ? (
        // 저장이 잠김 409로 끝났다: 화면을 잠그고, 문서에 남은 도형·좌석·등급 변경은 다음 저장도 막으므로 다시 불러오라고 안내한다(ADR-0264 결정 33)
        <div className="banner banner-danger" role="alert">
          <i className="ic ic-lock" aria-hidden="true" />
          <div className="banner-body">
            {answer.text}
            <br />
            {TEXT.lockedGuide}
          </div>
          <button className="btn btn-outline btn-sm" type="button" onClick={() => void onExport('JSON')}>
            JSON으로 내보내기
          </button>
          <button className="btn btn-outline btn-sm" type="button" disabled={saving} onClick={() => void onReload()}>
            다시 불러오기
          </button>
        </div>
      ) : null}
      {answer && answer.kind !== 'conflict' && answer.kind !== 'invalid' && answer.kind !== 'saved' && answer.kind !== 'locked' ? (
        <div className="banner banner-danger" role="alert">
          <div className="banner-body">{answer.text}</div>
          {answer.kind === 'unknown' ? (
            <button className="btn btn-outline btn-sm" type="button" disabled={saving} onClick={() => void onReload()}>
              다시 불러오기
            </button>
          ) : null}
        </div>
      ) : null}
      {answer?.kind === 'invalid' ? (
        <div className="banner banner-danger col" role="alert" style={{ alignItems: 'stretch' }}>
          <div className="banner-body">{answer.text}</div>
          <div className="table-wrap table-scroll" role="region" aria-label="저장 오류" tabIndex={0} style={{ maxHeight: 220 }}>
            <table className="table dense">
              <thead>
                <tr>
                  <th scope="col">자리</th>
                  <th scope="col">내용</th>
                </tr>
              </thead>
              <tbody>
                {answer.rows.map((r, i) => (
                  <tr key={i}>
                    <td>{fieldLabel(r.field, sentNames)}</td>
                    <td>{r.text}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
      {notice ? (
        <div className="banner banner-success" role="status">
          <div className="banner-body">{notice}</div>
          <button className="icon-btn icon-btn-sm" type="button" aria-label="안내 닫기" onClick={() => setNotice(null)}>
            <i className="ic ic-close" aria-hidden="true" />
          </button>
        </div>
      ) : null}
      {message ? (
        <p className="error-msg" role="alert">
          <i className="ic ic-alert-circle" aria-hidden="true" />
          {message}
        </p>
      ) : null}

      <Toolbar
        store={store}
        scale={scale}
        saveLocked={saveLocked}
        savedAt={savedAt}
        onZoom={(f) => canvas.current?.zoomBy(f)}
        onFit={() => canvas.current?.fit()}
        onSave={() => void onSave()}
        onImport={() => setImportOpen(true)}
        onExport={(f) => void onExport(f)}
      />
      {step === 3 ? <SelectionBar store={store} busy={working} onRefine={(t) => void onRefine(t)} onDelete={() => deleteSelectedSeats(store)} /> : null}

      <div className="grid gap-4 lg:[grid-template-columns:minmax(0,2fr)_minmax(0,7fr)_minmax(0,3fr)]" style={{ alignItems: 'stretch' }}>
        <section className="card col" style={{ padding: '12px 8px', gap: 10, minWidth: 0 }} aria-labelledby="h-tree">
          <h2 className="t-md fw-b" id="h-tree" style={{ padding: '0 4px' }}>
            좌석 계층
          </h2>
          <Tree store={store} />
        </section>
        <section className="card col" id="canvas-panel" role="tabpanel" aria-label={['배치 그리기', '좌석 채우기', '좌석 다듬기', '미리보기'][step - 1]} style={{ padding: 10, gap: 8, minWidth: 0 }}>
          {step === 4 ? <Preview store={store} /> : <div ref={canvasEl} data-testid="seatmap-canvas" style={{ width: '100%', height: 560, borderRadius: 8, overflow: 'hidden', background: '#f2f3f5', touchAction: 'none' }} />}
        </section>
        <section className="card col" style={{ padding: '14px 12px', gap: 12, minWidth: 0 }} aria-label="속성">
          <PropsArea store={store} onMessage={setMessage} onConfirmRefill={(n, go) => setRefill({ n, go })} />
        </section>
      </div>
      <Summary store={store} />

      {importOpen ? <ImportDialog store={store} productionId={productionId} onClose={() => setImportOpen(false)} onApplied={() => setNotice('가져온 파일로 바꿨습니다. 되돌리기로 되돌릴 수 있습니다')} onNotFound={onNotFound} /> : null}
      {refill ? (
        <LiveDialog id="refill-dialog" role="alertdialog" title="이미 좌석이 있는 구역입니다" onClose={() => setRefill(null)} maxWidth={420}>
          <p className="t-sm">{`이 구역의 좌석 ${refill.n.toLocaleString('ko-KR')}석을 지우고 새로 채웁니다`}</p>
          <div className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
            <button className="btn btn-outline" type="button" onClick={() => setRefill(null)}>
              그대로 두기
            </button>
            <button className="btn btn-danger" type="button" onClick={() => { refill.go(); setRefill(null); }}>
              지우고 채우기
            </button>
          </div>
        </LiveDialog>
      ) : null}
    </div>
  );
}
