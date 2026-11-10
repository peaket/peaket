'use client';
// 라이브 에디터의 일(ADR-0264 결정 4·5·8·9·10): Worker 계산(채우기·다듬기·내보내기), [좌석맵 저장]과 답 표, 가져오기, 다시 불러오기.
// 실패한 저장은 문서·변경 수·되돌리기 기록을 그대로 둔다. 브라우저 저장소에는 아무것도 넣지 않는다.
import { docFromLayout, saveBlockers, saveBody } from '../../model/doc';
import type { ExportFormat, ExportedFile } from '../../model/export';
import { fillResultText, type FillResult } from '../../model/fill';
import { importFailureText, importView, precheck, type ImportFormat, type ImportView } from '../../model/import-check';
import { withImportedTiers } from '../../model/price-tiers';
import { removeSeats } from '../../model/refine';
import { failedAnswer, savedAnswer, type SaveAnswer } from '../../model/save-answer';
import { type ApiDeps, BodyTooLarge, failureOf, importSeatmap, loadSeatmap, saveSeatmap } from '../../model/seatmap-api';
import { createEditorStore, type EditorStore, fillCmd, replaceCmd, seatsCmd } from '../../model/store';
import { type EditorDoc, type FillRule, type Seat, sectionOf } from '../../model/types';
import { createWorkerClient, JobEnded, type WorkerClient, type WorkerLike } from '../../model/worker-client';
import { buffersOf, type FillReply, packSection, type PackedSection, type RefineType, unpackSection } from '../../model/worker-protocol';

export const versionOfEtag = (etag: string | null, fallback: number): number => {
  const m = etag ? /^"(\d+)"$/.exec(etag.trim()) : null;
  return m ? Number(m[1]) : fallback;
};

export type Loaded = { kind: 'ok'; store: EditorStore } | { kind: 'none'; store: EditorStore } | { kind: 'error' };

export async function loadInto(productionId: string, signal?: AbortSignal): Promise<Loaded> {
  try {
    const r = await loadSeatmap(productionId, signal);
    if (r.kind === 'none') return { kind: 'none', store: createEditorStore(docFromLayout({}), 0, false) };
    const layout = r.layout as { layoutVersion?: number; geometryLocked?: boolean };
    return { kind: 'ok', store: createEditorStore(docFromLayout(layout), versionOfEtag(r.etag, layout.layoutVersion ?? 0), layout.geometryLocked === true) };
  } catch {
    return { kind: 'error' };
  }
}

let worker: WorkerClient | null = null;
function editorWorker(): WorkerClient {
  // 같은 출처 Worker 파일(CSP worker-src 'self'). 빌드가 파일로 나눠 싣는다
  worker ??= createWorkerClient(() => new Worker(new URL('../../model/editor.worker.ts', import.meta.url), { type: 'module' }) as unknown as WorkerLike);
  return worker;
}

/** Worker 계산이 끝나지 않았을 때의 문구(취소는 조용히) */
export function jobError(e: unknown): string | null {
  if (e instanceof JobEnded) return e.reason === 'cancelled' || e.reason === 'closed' ? null : e.message;
  return '계산하지 못했습니다. 다시 해 주세요';
}

export interface FillPreview {
  result: FillResult;
  text: string;
  /** 계산한 문서 판(ADR-0264 결정 37). 문서가 바뀌면 이 결과는 놓지 않는다 */
  rev: number;
}

/** 채우기 미리보기(Worker). 답을 받는 사이에 문서가 바뀌었으면(되돌리기·가져오기 포함) 버린다 */
export async function previewFill(store: EditorStore, sectionId: string, rule: FillRule): Promise<FillPreview | null> {
  const s = store.getState();
  const sec = sectionOf(s.doc, sectionId);
  if (!sec) return null;
  const rev = s.rev;
  const r = await editorWorker().request<FillReply>('fill', { shape: sec.shape.points, rule, stage: s.doc.stage, canvas: s.doc.canvas });
  if (store.getState().rev !== rev) return null;
  const seats = Array.from({ length: r.xs.length }, (_, i) => ({ row: r.rows[i]!, number: r.numbers[i]!, x: r.xs[i]!, y: r.ys[i]! }));
  const result: FillResult = { seats, target: r.target, capacity: r.capacity };
  return { result, text: fillResultText(result), rev };
}

/** 이 구역에 채우기(명령 하나). 지금 판의 미리보기만 놓는다. 새 좌석 ID는 에디터 자리표시(서버가 UUIDv7로 바꾼다) */
export function applyFill(store: EditorStore, sectionId: string, rule: FillRule, preview: Pick<FillPreview, 'result' | 'rev'>): boolean {
  const s = store.getState();
  if (s.rev !== preview.rev) return false;
  const seats: Seat[] = preview.result.seats.map((x) => ({ seatId: s.newSeatId(), ...x }));
  return s.exec(fillCmd(s.doc, sectionId, seats, rule));
}

const REFINE_LABEL: Record<RefineType, string> = { align: '줄 맞추기', distribute: '간격 고르게', aisle: '통로 만들기', renumber: '번호 다시 매기기' };

/** 다듬기(Worker). 답을 받는 사이에 문서가 바뀌었으면 버린다 */
export async function refine(store: EditorStore, type: RefineType): Promise<boolean> {
  const s = store.getState();
  const ids = [...s.seatSel];
  if (ids.length === 0) return false;
  const rev = s.rev;
  const packs: PackedSection[] = s.doc.order.map((id) => sectionOf(s.doc, id)!).filter((sec) => sec.seats.some((x) => s.seatSel.has(x.seatId))).map(packSection);
  const out = await editorWorker().request<PackedSection[]>(type, { sections: packs, ids, stage: s.doc.stage, canvas: s.doc.canvas }, buffersOf(packs.map((p) => p.seats)));
  const now = store.getState();
  if (now.rev !== rev) return false;
  // 구역 ID는 바깥 글자라 자기 칸으로만 넣는다(Object.fromEntries는 '__proto__'도 자기 칸으로 만든다)
  const changes = Object.fromEntries(out.map((p) => [p.section.sectionId, unpackSection(p)]));
  return now.exec(seatsCmd(now.doc, REFINE_LABEL[type], changes));
}

export function deleteSelectedSeats(store: EditorStore): boolean {
  const s = store.getState();
  return s.exec(seatsCmd(s.doc, '좌석 지우기', removeSeats(s.doc, s.seatSel)));
}

/** 내보내기(Worker)와 내려받기. 파일 이름은 화면이 정한다 */
export async function exportDoc(store: EditorStore, productionId: string, format: ExportFormat): Promise<ExportedFile> {
  const s = store.getState();
  const f = await editorWorker().request<ExportedFile>('export', { format, doc: s.doc, productionId, version: s.version });
  const url = URL.createObjectURL(new Blob([f.text], { type: f.mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = f.name;
  a.rel = 'noopener';
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return f;
}

/**
 * 저장 한 번. 답을 화면 동작으로 바꿔 돌려주고, 200이면 저장소를 응답으로 갈아끼운다.
 * 요청이 오가는 동안 저장소는 명령·되돌리기·다시 하기를 받지 않는다(ADR-0264 결정 30. 응답이 그 사이 편집을 조용히 덮지 않게)
 */
export async function save(store: EditorStore, productionId: string, deps?: ApiDeps): Promise<SaveAnswer | { kind: 'blocked'; text: string }> {
  const s = store.getState();
  if (s.saving) return { kind: 'blocked', text: '저장 중입니다' };
  const body = saveBody(s.doc, s.version);
  const blockers = saveBlockers(s.doc, body);
  if (blockers.length > 0) return { kind: 'blocked', text: blockers.join(' · ') };
  s.setSaving(true);
  try {
    const r = await saveSeatmap(productionId, body as { layoutVersion: number } & Record<string, unknown>, deps);
    const a = savedAnswer(r.layout, r.etag);
    if (a.kind === 'saved') store.getState().reset(docFromLayout(r.layout), a.version, (r.layout as { geometryLocked?: boolean })?.geometryLocked === true);
    return a;
  } catch (e) {
    if (e instanceof BodyTooLarge) return { kind: 'message', text: '좌석맵이 너무 큽니다. 좌석이나 구역을 줄여 주세요' };
    const a = failedAnswer(await failureOf(e, Date.now(), deps), Date.now());
    // 서버가 잠금을 알리면 화면도 잠근다(서버의 409가 최종 판정이다)
    if (a.kind === 'locked') store.setState({ locked: true });
    return a;
  } finally {
    store.getState().setSaving(false);
  }
}

/** 다시 불러오기(412 뒤). 저장하지 않은 변경은 버린다(부른 쪽이 먼저 묻는다) */
export async function reload(store: EditorStore, productionId: string): Promise<boolean> {
  if (store.getState().saving) return false;
  const r = await loadInto(productionId);
  if (r.kind === 'error') return false;
  const s = r.store.getState();
  store.getState().reset(s.doc, s.version, s.locked);
  return true;
}

export type ImportOutcome = { kind: 'view'; view: ImportView } | { kind: 'message'; text: string };

/** 가져오기 보내기(앞 검사를 지난 파일만) */
export async function sendImport(productionId: string, format: ImportFormat, file: File): Promise<ImportOutcome> {
  const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  const pre = precheck(file.size, head);
  if (pre) return { kind: 'message', text: pre };
  try {
    return { kind: 'view', view: importView(await importSeatmap(productionId, format, file)) };
  } catch (e) {
    const f = await failureOf(e, Date.now());
    return { kind: 'message', text: importFailureText(f.status, f.type) };
  }
}

/** 가져온 배치를 문서로(명령 하나, 되돌릴 수 있다). 모르는 등급은 가격이 빈 등급으로 더한다 */
export function applyImport(store: EditorStore, layout: unknown): boolean {
  const s = store.getState();
  const imported: EditorDoc = docFromLayout(layout);
  const next: EditorDoc = { ...imported, priceTiers: withImportedTiers(imported, s.doc.priceTiers), ...(s.doc.templateVenueId !== undefined ? { templateVenueId: s.doc.templateVenueId } : {}) };
  return s.exec(replaceCmd(s.doc, next));
}
