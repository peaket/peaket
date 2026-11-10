'use client';
// 오른쪽 속성 패널(d5 §6.5): ① 고른 도형의 이름·층·등급·게이트와 숫자 칸(끄는 조작의 숫자 대안, WCAG 2.5.7), ② 좌석 채우기, ③ 좌석 속성,
// 아무것도 고르지 않았을 때 '등급과 가격'(ADR-0264 결정 11). 잠긴 배치본(geometryLocked)은 도형·좌석 칸과 가격 등급을 끄고 판매 제외·휠체어석·게이트만 받는다.
// 저장 요청이 오가는 동안은 패널 전체를 끈다(ADR-0264 결정 30).
// 글자(구역 이름 등)는 React 글자 자식과 칸 값으로만 그린다.
import { useEffect, useState } from 'react';
import { useStore } from 'zustand';
import { canvasCmd, type Command, copySectionCmd, type EditorStore, removeShapeCmd, seatsCmd, tiersCmd, updateSectionCmd, updateStageCmd } from '../../model/store';
import { FILL_DEFAULTS, fillRuleErrors } from '../../model/fill';
import { addTier, canRemoveTier, moveTier, removeTier, tierErrors, TIERS_MAX, updateTier } from '../../model/price-tiers';
import { patchSeats } from '../../model/refine';
import { arcProblem, isRectLike, moveVertex, rectParams, withArc, withRect } from '../../model/shapes';
import { type FillRule, sectionOf, type Shape } from '../../model/types';
import { NumField, Radio, TextField } from './fields';
import { applyFill, type FillPreview, jobError, previewFill } from './controller';

const H = ({ children }: { children: string }) => <h2 className="t-md fw-b">{children}</h2>;

export function PropsArea(props: { store: EditorStore; onMessage: (t: string) => void; onConfirmRefill: (n: number, go: () => void) => void }) {
  const saving = useStore(props.store, (s) => s.saving);
  return (
    <fieldset className="col" disabled={saving} aria-busy={saving} style={{ gap: 12, border: 0, padding: 0, margin: 0, minWidth: 0 }}>
      <PropsInner {...props} />
    </fieldset>
  );
}

function PropsInner({ store, onMessage, onConfirmRefill }: { store: EditorStore; onMessage: (t: string) => void; onConfirmRefill: (n: number, go: () => void) => void }) {
  const step = useStore(store, (s) => s.step);
  const sel = useStore(store, (s) => s.sel);
  const seatCount = useStore(store, (s) => s.seatSel.size);
  if (step === 4) return <p className="t-sm muted">미리보기는 팬 화면처럼 읽기만 합니다. 구역을 누르면 확대됩니다.</p>;
  if (step === 3 && seatCount > 0) return <SeatProps store={store} />;
  if (step === 2 && sel?.kind === 'section') return <FillPanel key={sel.id} store={store} sectionId={sel.id} onMessage={onMessage} onConfirmRefill={onConfirmRefill} />;
  if (step === 1 && sel) return <ShapeProps store={store} />;
  return (
    <>
      {step === 2 ? <p className="t-sm muted">채울 구역을 캔버스나 좌석 계층에서 고르세요.</p> : null}
      {step === 3 ? <p className="t-sm muted">좌석을 누르거나 끌어 상자로 고르세요. 두 번 누르면 그 행 전체, Shift로 더합니다.</p> : null}
      <TiersPanel store={store} />
      {step === 1 ? <CanvasSize store={store} /> : null}
    </>
  );
}

function ShapeProps({ store }: { store: EditorStore }) {
  const sel = useStore(store, (s) => s.sel)!;
  const doc = useStore(store, (s) => s.doc);
  const locked = useStore(store, (s) => s.locked);
  const section = sel.kind === 'section' ? sectionOf(doc, sel.id) : undefined;
  const shape: Shape | undefined = sel.kind === 'stage' ? doc.stage[sel.index] : section?.shape;
  if (!shape) return null;
  const exec = (cmd: Command | null) => store.getState().exec(cmd);
  const putShape = (next: Shape) => store.getState().exec(sel.kind === 'stage' ? updateStageCmd(store.getState().doc, sel.index, next) : updateSectionCmd(store.getState().doc, sel.id, { shape: next }));
  const c = doc.canvas;
  const p = (k: string) => `sp-${k}`;
  const kindLabel = { RECT: '사각형', POLYGON: '다각형', SECTOR: '부채꼴', ARC_BAND: '곡선 띠' }[shape.kind];
  return (
    <div className="col" style={{ gap: 10 }}>
      <H>{sel.kind === 'stage' ? '무대' : '구역 속성'}</H>
      <p className="t-xs muted">{kindLabel}</p>
      {section ? (
        <>
          <TextField id={p('name')} label="이름" value={section.name} disabled={locked} onCommit={(v) => exec(updateSectionCmd(store.getState().doc, sel.kind === 'section' ? sel.id : '', { name: v }))} />
          <TextField id={p('level')} label="층" value={section.level ?? ''} disabled={locked} onCommit={(v) => exec(updateSectionCmd(store.getState().doc, section.sectionId, { level: v === '' ? undefined : v }))} />
          <div className="field" style={{ gap: 4 }}>
            <label className="label" htmlFor={p('tier')}>
              등급
            </label>
            <select className="input input-sm" id={p('tier')} value={section.tierId ?? ''} disabled={locked} onChange={(e) => exec(updateSectionCmd(store.getState().doc, section.sectionId, { tierId: e.target.value === '' ? undefined : e.target.value }))}>
              <option value="">없음</option>
              {doc.priceTiers.map((t) => (
                <option key={t.tierId} value={t.tierId}>
                  {t.name}
                </option>
              ))}
            </select>
          </div>
          <TextField id={p('gate')} label="입장 게이트" value={section.gateZone ?? ''} onCommit={(v) => exec(updateSectionCmd(store.getState().doc, section.sectionId, { gateZone: v === '' ? undefined : v }))} />
        </>
      ) : (
        <TextField id={p('name')} label="이름" value={shape.name ?? ''} disabled={locked} onCommit={(v) => putShape({ ...shape, ...(v === '' ? {} : { name: v }) })} />
      )}
      {shape.kind === 'RECT' && isRectLike(shape.points) ? <RectFields shape={shape} disabled={locked} onShape={putShape} canvas={c} /> : null}
      {(shape.kind === 'SECTOR' || shape.kind === 'ARC_BAND') && shape.arc ? <ArcFields shape={shape} disabled={locked} onShape={putShape} canvas={c} /> : null}
      {shape.kind === 'POLYGON' || (shape.kind === 'RECT' && !isRectLike(shape.points)) || ((shape.kind === 'SECTOR' || shape.kind === 'ARC_BAND') && !shape.arc) ? (
        <fieldset className="col" style={{ gap: 6, border: 0, padding: 0, margin: 0 }}>
          <legend className="label">꼭짓점(cm)</legend>
          <ol className="col" style={{ gap: 4, maxHeight: 220, overflowY: 'auto', paddingLeft: 0, listStyle: 'none' }}>
            {shape.points.map(([x, y], i) => (
              <li key={i} className="row" style={{ gap: 6 }}>
                <NumField id={p(`v${i}x`)} label={`${i + 1} x`} value={x} disabled={locked} onCommit={(v) => putShape(moveVertex(shape, i, v, y, c))} />
                <NumField id={p(`v${i}y`)} label={`${i + 1} y`} value={y} disabled={locked} onCommit={(v) => putShape(moveVertex(shape, i, x, v, c))} />
              </li>
            ))}
          </ol>
        </fieldset>
      ) : null}
      <div className="row wrap" style={{ gap: 6 }}>
        {section ? (
          <>
            <button className="btn btn-outline btn-sm" type="button" disabled={locked} onClick={() => copy('mirror')}>
              <i className="ic ic-mirror" aria-hidden="true" />
              좌우 대칭 복제
            </button>
            <button className="btn btn-outline btn-sm" type="button" disabled={locked} onClick={() => copy('duplicate')}>
              <i className="ic ic-copy" aria-hidden="true" />
              복제
            </button>
          </>
        ) : null}
        <button className="btn btn-outline btn-sm" type="button" disabled={locked} onClick={() => store.getState().exec(removeShapeCmd(store.getState().doc, sel))}>
          <i className="ic ic-trash" aria-hidden="true" />
          지우기
        </button>
      </div>
    </div>
  );
  function copy(mode: 'mirror' | 'duplicate') {
    const s = store.getState();
    if (sel.kind !== 'section') return;
    const id = s.newSectionId();
    if (s.exec(copySectionCmd(s.doc, sel.id, id, () => s.newSeatId(), mode))) s.select({ kind: 'section', id });
  }
}

function RectFields({ shape, disabled, onShape, canvas }: { shape: Shape; disabled: boolean; onShape: (s: Shape) => void; canvas: { width: number; height: number } }) {
  const r = rectParams(shape.points);
  const put = (k: keyof typeof r) => (v: number) => onShape(withRect(shape, { ...r, [k]: v }, canvas));
  return (
    <div className="grid" style={{ gridTemplateColumns: '1fr 1fr', gap: 8 }}>
      <NumField id="sp-x" label="위치 x" unit="cm" value={r.x} disabled={disabled} onCommit={put('x')} />
      <NumField id="sp-y" label="위치 y" unit="cm" value={r.y} disabled={disabled} onCommit={put('y')} />
      <NumField id="sp-w" label="가로" unit="cm" value={r.w} disabled={disabled} onCommit={put('w')} />
      <NumField id="sp-h" label="세로" unit="cm" value={r.h} disabled={disabled} onCommit={put('h')} />
      <NumField id="sp-rot" label="회전" unit="°" value={r.rotation} disabled={disabled} onCommit={put('rotation')} />
    </div>
  );
}

function ArcFields({ shape, disabled, onShape, canvas }: { shape: Shape; disabled: boolean; onShape: (s: Shape) => void; canvas: { width: number; height: number } }) {
  const a = shape.arc!;
  const [error, setError] = useState<string | null>(null);
  const put = (k: keyof typeof a) => (v: number) => {
    const next = { ...a, [k]: Math.round(v) };
    const problem = arcProblem(next, canvas);
    setError(problem);
    if (!problem) onShape(withArc(shape, next, canvas));
  };
  return (
    <div className="grid" style={{ gridTemplateColumns: '1fr 1fr', gap: 8 }}>
      <NumField id="sp-cx" label="중심 x" unit="cm" value={a.cx} disabled={disabled} onCommit={put('cx')} />
      <NumField id="sp-cy" label="중심 y" unit="cm" value={a.cy} disabled={disabled} onCommit={put('cy')} />
      {shape.kind === 'ARC_BAND' ? <NumField id="sp-in" label="안쪽 반지름" unit="cm" value={a.innerRadius} disabled={disabled} onCommit={put('innerRadius')} /> : null}
      <NumField id="sp-out" label="바깥 반지름" unit="cm" value={a.outerRadius} disabled={disabled} onCommit={put('outerRadius')} />
      <NumField id="sp-start" label="시작각" unit="°" value={a.startAngle} disabled={disabled} onCommit={put('startAngle')} />
      <NumField id="sp-end" label="끝각" unit="°" value={a.endAngle} disabled={disabled} onCommit={put('endAngle')} error={error ?? undefined} />
    </div>
  );
}

function FillPanel({ store, sectionId, onMessage, onConfirmRefill }: { store: EditorStore; sectionId: string; onMessage: (t: string) => void; onConfirmRefill: (n: number, go: () => void) => void }) {
  const section = useStore(store, (s) => sectionOf(s.doc, sectionId));
  const locked = useStore(store, (s) => s.locked);
  const rev = useStore(store, (s) => s.rev);
  const [rule, setRule] = useState<FillRule>(() => ({ ...FILL_DEFAULTS, method: 'COUNT', targetCount: 600, rows: 20, seatsPerRow: 30, ...(section?.fillRule ?? {}) }));
  const [kept, setResult] = useState<FillPreview | null>(null);
  // 미리보기는 그때의 문서 판에 묶는다. 문서가 바뀌면(되돌리기·가져오기 포함) 옛 결과를 보이지도 놓지도 않는다(ADR-0264 결정 37)
  const result = kept && kept.rev === rev ? kept : null;
  const [busy, setBusy] = useState(false);
  useEffect(() => () => store.getState().setGhost(null), [store]);
  if (!section) return null;
  const errors = fillRuleErrors(rule);
  const set = (patch: Partial<FillRule>) => {
    setRule((r) => ({ ...r, ...patch }));
    setResult(null);
    store.getState().setGhost(null);
  };
  const ruleToSave = (): FillRule => {
    const { targetCount, rows, seatsPerRow, ...rest } = rule;
    return rule.method === 'COUNT' ? { ...rest, targetCount } : { ...rest, rows, seatsPerRow };
  };
  const preview = async () => {
    setBusy(true);
    try {
      const r = await previewFill(store, sectionId, ruleToSave());
      if (!r) return;
      setResult(r);
      store.getState().setGhost({ sectionId, seats: r.result.seats });
    } catch (e) {
      const t = jobError(e);
      if (t) onMessage(t);
    } finally {
      setBusy(false);
    }
  };
  const apply = async () => {
    let r: FillPreview | null = result;
    if (!r) {
      setBusy(true);
      try {
        r = await previewFill(store, sectionId, ruleToSave());
      } catch (e) {
        const t = jobError(e);
        if (t) onMessage(t);
        return;
      } finally {
        setBusy(false);
      }
    }
    if (!r) return;
    const go = () => {
      if (applyFill(store, sectionId, ruleToSave(), r!)) setResult(null);
    };
    if (section.seats.length > 0) onConfirmRefill(section.seats.length, go);
    else go();
  };
  const num = (k: keyof FillRule, label: string, unit?: string) => (
    <NumField id={`fill-${k}`} label={label} unit={unit} value={(rule[k] as number | undefined) ?? null} disabled={locked} error={errors[k]} onCommit={(v) => set({ [k]: Math.round(v) } as Partial<FillRule>)} />
  );
  return (
    <div className="col" style={{ gap: 10 }}>
      <H>좌석 채우기</H>
      <p className="t-sm">{section.name}</p>
      <Radio name="fill-method" legend="채우는 방식" value={rule.method} disabled={locked} options={[{ value: 'COUNT', label: '좌석 수로 채우기' }, { value: 'GRID', label: '행 수 × 행마다 좌석 수' }] as const} onChange={(v) => set({ method: v })} />
      {rule.method === 'COUNT' ? num('targetCount', '좌석 수', '석') : (
        <div className="row" style={{ gap: 6 }}>
          {num('rows', '행 수')}
          {num('seatsPerRow', '행마다 좌석 수')}
        </div>
      )}
      <Radio name="fill-shape" legend="행 모양" value={rule.rowShape ?? 'STRAIGHT'} disabled={locked} options={[{ value: 'STRAIGHT', label: '직선' }, { value: 'CURVED', label: '무대를 향한 곡선' }] as const} onChange={(v) => set({ rowShape: v })} />
      <div className="grid" style={{ gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        {num('seatSpacingCm', '좌석 간격(옆)', 'cm')}
        {num('rowSpacingCm', '행 간격(앞뒤)', 'cm')}
        {num('aisles', '세로 통로', '개')}
        {num('aisleWidthCm', '통로 폭', 'cm')}
        {num('firstNumber', '첫 번호')}
      </div>
      <Radio name="fill-label" legend="행 이름" value={rule.rowLabel ?? 'NUMBER'} disabled={locked} options={[{ value: 'NUMBER', label: '1열·2열' }, { value: 'ALPHA', label: 'A·B·C' }] as const} onChange={(v) => set({ rowLabel: v })} />
      <Radio name="fill-from" legend="번호 방향" value={rule.numberFrom ?? 'LEFT'} disabled={locked} options={[{ value: 'LEFT', label: '무대를 보고 왼쪽부터' }, { value: 'RIGHT', label: '오른쪽부터' }] as const} onChange={(v) => set({ numberFrom: v })} />
      <div className="row wrap" style={{ gap: 6 }}>
        <button className="btn btn-outline btn-sm" type="button" disabled={locked || busy || Object.keys(errors).length > 0} onClick={() => void preview()}>
          채우기 미리보기
        </button>
        <button className="btn btn-primary btn-sm" type="button" disabled={locked || busy || Object.keys(errors).length > 0} onClick={() => void apply()}>
          이 구역에 채우기
        </button>
      </div>
      <p className="t-sm" role="status" aria-live="polite">
        {result?.text ?? ''}
      </p>
    </div>
  );
}

function SeatProps({ store }: { store: EditorStore }) {
  const doc = useStore(store, (s) => s.doc);
  const ids = useStore(store, (s) => s.seatSel);
  const locked = useStore(store, (s) => s.locked);
  const seats = doc.order.flatMap((id) => doc.sections[id]!.seats.filter((x) => ids.has(x.seatId)));
  if (seats.length === 0) return null;
  const all = (f: (x: (typeof seats)[number]) => boolean) => seats.every(f);
  const patch = (p: Parameters<typeof patchSeats>[2], geometry: boolean) => store.getState().exec(seatsCmd(store.getState().doc, '좌석 속성', patchSeats(store.getState().doc, ids, p), geometry));
  const one = seats.length === 1 ? seats[0]! : null;
  const tier = all((x) => x.tierId === seats[0]!.tierId) ? (seats[0]!.tierId ?? '') : '*';
  const gate = all((x) => x.gateZone === seats[0]!.gateZone) ? (seats[0]!.gateZone ?? '') : '';
  return (
    <div className="col" style={{ gap: 10 }}>
      <H>좌석 속성</H>
      <p className="t-sm">{one ? `${one.row}열 ${one.number}번` : `좌석 ${seats.length.toLocaleString('ko-KR')}석`}</p>
      <div className="field" style={{ gap: 4 }}>
        <label className="label" htmlFor="seat-tier">
          좌석 등급
        </label>
        <select className="input input-sm" id="seat-tier" value={tier} disabled={locked} onChange={(e) => patch({ tierId: e.target.value === '' ? null : e.target.value }, true)}>
          {tier === '*' ? <option value="*">여러 등급</option> : null}
          <option value="">구역 등급 따름</option>
          {doc.priceTiers.map((t) => (
            <option key={t.tierId} value={t.tierId}>
              {t.name}
            </option>
          ))}
        </select>
      </div>
      <label className="check-row t-sm">
        <input className="cb" type="checkbox" checked={all((x) => x.wheelchair === true)} onChange={(e) => patch({ wheelchair: e.target.checked }, false)} />
        휠체어석
      </label>
      <label className="check-row t-sm">
        <input className="cb" type="checkbox" checked={all((x) => x.unavailable === true)} onChange={(e) => patch({ unavailable: e.target.checked }, false)} />
        판매 제외
      </label>
      <TextField id="seat-gate" label="입장 게이트" value={gate} onCommit={(v) => patch({ gateZone: v === '' ? null : v }, false)} />
      {one ? (
        <div className="row" style={{ gap: 6 }}>
          <NumField id="seat-x" label="x" unit="cm" value={one.x} disabled={locked} onCommit={(v) => moveOne(v - one.x, 0)} />
          <NumField id="seat-y" label="y" unit="cm" value={one.y} disabled={locked} onCommit={(v) => moveOne(0, v - one.y)} />
        </div>
      ) : null}
    </div>
  );
  function moveOne(dx: number, dy: number) {
    const s = store.getState();
    const id = [...ids][0]!;
    const sec = s.doc.order.find((sid) => s.doc.sections[sid]!.seats.some((x) => x.seatId === id))!;
    const cur = s.doc.sections[sec]!;
    const seats2 = cur.seats.map((x) => (x.seatId === id ? { ...x, x: Math.min(s.doc.canvas.width, Math.max(0, Math.round(x.x + dx))), y: Math.min(s.doc.canvas.height, Math.max(0, Math.round(x.y + dy))) } : x));
    s.exec(seatsCmd(s.doc, '좌석 옮기기', { [sec]: { ...cur, seats: seats2 } }));
  }
}

export function TiersPanel({ store }: { store: EditorStore }) {
  const doc = useStore(store, (s) => s.doc);
  const locked = useStore(store, (s) => s.locked);
  const step = useStore(store, (s) => s.step);
  const ro = locked || step === 4;
  const tiers = doc.priceTiers;
  const put = (next: typeof tiers | undefined) => next && store.getState().exec(tiersCmd(store.getState().doc, next));
  return (
    <section className="col" style={{ gap: 8 }} aria-labelledby="h-tiers">
      <h2 className="t-md fw-b" id="h-tiers">
        등급과 가격
      </h2>
      {tiers.length === 0 ? <p className="t-sm muted">가격 등급이 없습니다. 좌석을 저장하려면 등급을 하나 이상 더하세요.</p> : null}
      <ol className="col" style={{ gap: 8, paddingLeft: 0, listStyle: 'none' }} aria-label="가격 등급 차례">
        {tiers.map((t, i) => {
          const e = tierErrors(t);
          return (
            <li key={t.tierId} className="card-flat col" style={{ gap: 6, padding: 8 }}>
              <div className="row" style={{ gap: 6 }}>
                <TextField id={`tier-${t.tierId}-name`} label={`${i + 1}번째 등급 이름`} value={t.name} disabled={ro} onCommit={(v) => put(updateTier(store.getState().doc.priceTiers, t.tierId, { name: v }))} />
                <NumField id={`tier-${t.tierId}-price`} label="가격" unit="원" value={t.price} disabled={ro} error={e.price ?? e.name} onCommit={(v) => put(updateTier(store.getState().doc.priceTiers, t.tierId, { price: Math.round(v) }))} />
              </div>
              <div className="row" style={{ gap: 4 }}>
                <button className="btn btn-outline btn-sm" type="button" disabled={ro || i === 0} aria-label={`${t.name} 위로`} onClick={() => put(moveTier(store.getState().doc.priceTiers, i, -1))}>
                  위로
                </button>
                <button className="btn btn-outline btn-sm" type="button" disabled={ro || i === tiers.length - 1} aria-label={`${t.name} 아래로`} onClick={() => put(moveTier(store.getState().doc.priceTiers, i, 1))}>
                  아래로
                </button>
                <button className="btn btn-text btn-sm" type="button" disabled={ro || !canRemoveTier(doc, t.tierId)} aria-label={`${t.name} 지우기`} onClick={() => put(removeTier(store.getState().doc, t.tierId))}>
                  지우기
                </button>
              </div>
            </li>
          );
        })}
      </ol>
      <button className="btn btn-outline btn-sm" type="button" disabled={ro || tiers.length >= TIERS_MAX} onClick={() => put(addTier(store.getState().doc.priceTiers))}>
        등급 더하기
      </button>
      <p className="t-xs muted">{`${tiers.length}/${TIERS_MAX}개. 좌석이 쓰는 등급은 먼저 좌석 등급을 바꾼 뒤 지웁니다.`}</p>
    </section>
  );
}

function CanvasSize({ store }: { store: EditorStore }) {
  const canvas = useStore(store, (s) => s.doc.canvas);
  const locked = useStore(store, (s) => s.locked);
  const [error, setError] = useState<string | null>(null);
  const put = (w: number, h: number) => {
    const cmd = canvasCmd(store.getState().doc, Math.round(w), Math.round(h));
    setError(cmd ? null : '모든 도형과 좌석이 들어가는 1~100,000cm로 넣어 주세요');
    if (cmd) store.getState().exec(cmd);
  };
  return (
    <section className="col" style={{ gap: 6 }} aria-labelledby="h-canvas">
      <h2 className="t-md fw-b" id="h-canvas">
        캔버스 크기
      </h2>
      <div className="row" style={{ gap: 6 }}>
        <NumField id="canvas-w" label="가로" unit="cm" value={canvas.width} disabled={locked} onCommit={(v) => put(v, canvas.height)} />
        <NumField id="canvas-h" label="세로" unit="cm" value={canvas.height} disabled={locked} onCommit={(v) => put(canvas.width, v)} error={error ?? undefined} />
      </div>
    </section>
  );
}
