// 가운데 캔버스 패널의 상태별 내용(보드 SCR-022-d·t 'canvas-panel'). 그림은 CMP-051(@peaket/ds/SeatMapEditorCanvas)로 그린다.
import {
  CanvasMiniMap,
  CanvasText,
  DimensionTag,
  DrawToolRail,
  GuideLine,
  MarqueeBox,
  OutsideSeatMarker,
  SeatMapEditorCanvas,
  SelectionHandles,
  StageDirection,
  ZoneShape,
} from '@peaket/ds/SeatMapEditorCanvas';
import type { CSSProperties, ReactNode } from 'react';
import {
  A1_VIEW,
  FULL_VIEW,
  GRADE_FILL,
  OUTSIDE_SEATS,
  R_VIEW,
  STAGE,
  ZONES,
  a1Seats,
  ghostSeats,
  miniShapes,
  r1Rows,
  rSeats,
  zone,
} from '../model/geometry';
import type { CanvasView } from '../model/view';

function Head({ title, layer, end }: { title: string; layer?: string; end?: ReactNode }) {
  return (
    <div className="row between wrap" style={{ gap: '6px 12px' }}>
      <div className="row" style={{ gap: 8 }}>
        <h2 className="t-md fw-b">{title}</h2>
        {layer ? <span className="badge badge-outline">{layer}</span> : null}
      </div>
      {end}
    </div>
  );
}

function Legend({ items, center = false }: { items: ReactNode[]; center?: boolean }) {
  return (
    <div className="legend" style={center ? { justifyContent: 'center' } : undefined}>
      {items.map((it, i) => (
        <span key={i} className="legend-item">
          {it}
        </span>
      ))}
    </div>
  );
}

const swatch = (style: CSSProperties) => <span aria-hidden="true" style={{ display: 'inline-block', ...style }} />;
const seatDot = (cls = '', extra: CSSProperties = {}) => <span className={`seat ${cls}`} aria-hidden="true" style={{ borderRadius: '50%', ...extra }} />;
const warnRing: CSSProperties = { outline: '2px solid var(--warning)', outlineOffset: 1 };

const GATES = (
  <>
    <CanvasText x={8} y={345} size={16} bold anchor="start" color="var(--text-muted)">
      동문
    </CanvasText>
    <CanvasText x={632} y={345} size={16} bold anchor="end" color="var(--text-muted)">
      서문
    </CanvasText>
  </>
);

const STAGE_FULL = (
  <>
    <ZoneShape shape={STAGE} fill="var(--fill-weak-strong)" stroke="var(--border-input)" />
    <CanvasText x={320} y={63} size={20} bold color="var(--text-muted)" spacing=".2em">
      무대
    </CanvasText>
  </>
);

/** A1구역 확대 그림의 주변 도형(S1·R1·A2 일부와 무대 방향) */
function A1Surroundings({ a1Stroke, label, sub, labelColor }: { a1Stroke: string; label: string; sub: string; labelColor: string }) {
  return (
    <>
      <ZoneShape shape={zone('S1').shape} stroke="var(--border)" strokeWidth={1.2} />
      <ZoneShape shape={{ kind: 'rect', x: 205, y: 105, w: 110, h: 135, rx: 3 }} stroke="var(--border)" strokeWidth={1.2} />
      <ZoneShape shape={zone('A2').shape} stroke="var(--border)" strokeWidth={1.2} />
      <ZoneShape shape={zone('A1').shape} stroke={a1Stroke} strokeWidth={a1Stroke === 'var(--border-primary)' ? 2 : 1.5} />
      <CanvasText x={112} y={212} size={9} bold anchor="start" color="var(--text-muted)">
        S1구역
      </CanvasText>
      <CanvasText x={262} y={226} size={9} bold color="var(--text-muted)">
        R1구역
      </CanvasText>
      <StageDirection x={320} y1={238} y2={206} />
      <CanvasText x={86} y={300} size={10} bold anchor="start" color={labelColor}>
        {label}
      </CanvasText>
      <CanvasText x={86} y={312} size={8} anchor="start" color="var(--text-muted)">
        {sub}
      </CanvasText>
    </>
  );
}

/** R1·R2 확대 그림(무대·두 구역·열 이름) */
function RZoom({ highlight }: { highlight: 'primary' | 'warning' }) {
  const hl = highlight === 'primary' ? 'var(--link)' : 'var(--warning)';
  const rows = Array.from({ length: 15 }, (_, i) => i + 1);
  return (
    <>
      <ZoneShape shape={STAGE} fill="var(--fill-weak-strong)" stroke="var(--border-input)" strokeWidth={1} />
      <CanvasText x={320} y={76} size={9} bold color="var(--text-muted)" spacing=".2em">
        무대
      </CanvasText>
      <ZoneShape shape={zone('R1').shape} stroke="var(--border-input)" strokeWidth={1} />
      <ZoneShape shape={zone('R2').shape} stroke="var(--border-input)" strokeWidth={1} />
      <CanvasText x={260} y={100} size={9} bold color={highlight === 'primary' ? 'var(--link)' : 'var(--text-muted)'}>
        R1구역
      </CanvasText>
      <CanvasText x={380} y={100} size={9} bold color="var(--text-muted)">
        R2구역
      </CanvasText>
      {rows.map((r) => (
        <CanvasText key={`l${r}`} x={201} y={112 + (r - 1) * 9} size={6.5} anchor="end" bold={r === 12} color={r === 12 ? hl : 'var(--text-muted)'}>
          {r}열
        </CanvasText>
      ))}
      {rows.map((r) => (
        <CanvasText key={`r${r}`} x={439} y={112 + (r - 1) * 9} size={6.5} anchor="start" color="var(--text-muted)">
          {r}열
        </CanvasText>
      ))}
    </>
  );
}

const MINI_A1 = <CanvasMiniMap viewBox={FULL_VIEW} width={110} height={69} shapes={miniShapes('edit', 'A1')} focus={[80, 196, 340, 392]} />;

export function ZoomControls() {
  return (
    <div className="row" role="group" aria-label="미리보기 확대·축소" style={{ position: 'absolute', top: 10, right: 10, gap: 6 }}>
      <button className="btn btn-outline btn-sm" type="button">
        전체 보기
      </button>
      <button className="icon-btn icon-btn-sm icon-btn-outline" type="button" aria-label="축소">
        <i className="ic ic-minus" aria-hidden="true" />
      </button>
      <button className="icon-btn icon-btn-sm icon-btn-outline" type="button" aria-label="확대">
        <i className="ic ic-plus" aria-hidden="true" />
      </button>
    </div>
  );
}

/** 미리보기 전체 배치(등급 색 + 구역 이름 알약). 휴대폰 미리보기도 같은 그림을 쓴다 */
export function PreviewOverview({ mobile = false, outWarn = false }: { mobile?: boolean; outWarn?: boolean }) {
  return (
    <>
      <ZoneShape shape={STAGE} fill="var(--fill-weak-strong)" />
      <CanvasText x={320} y={mobile ? 68 : 63} size={mobile ? 28 : 20} bold color="var(--text-muted)" spacing=".2em">
        무대
      </CanvasText>
      {ZONES.map((z) => {
        const warn = outWarn && z.id === 'S2';
        return (
          <ZoneShape
            key={z.id}
            shape={z.shape}
            fill={GRADE_FILL[z.grade]}
            stroke={warn ? 'var(--warning)' : 'var(--border)'}
            strokeWidth={warn ? 6 : mobile ? 2 : 1.5}
          />
        );
      })}
      {ZONES.map((z) => {
        if (mobile) {
          const warn = outWarn && z.id === 'S2';
          const p = warn ? { x: 520, y: 140 } : z.mPill;
          return (
            <g key={`p${z.id}`}>
              <rect
                x={p.x}
                y={p.y}
                width={100}
                height={56}
                rx={14}
                style={{ fill: 'var(--surface)', stroke: warn ? 'var(--warning)' : 'var(--border)', strokeWidth: warn ? 3 : undefined }}
              />
              <CanvasText x={p.x + 50} y={p.y + 40} size={34} bold>
                {z.id}
              </CanvasText>
            </g>
          );
        }
        return (
          <g key={`p${z.id}`}>
            <rect x={z.pill.x} y={z.pill.y} width={92} height={40} rx={10} style={{ fill: 'var(--surface)', stroke: 'var(--border)' }} />
            <CanvasText x={z.pill.x + 46} y={z.pill.y + 18} size={17} bold>
              {z.name}
            </CanvasText>
            <CanvasText x={z.pill.x + 46} y={z.pill.y + 34} size={14}>
              {z.grade}석
            </CanvasText>
          </g>
        );
      })}
      {outWarn &&
        OUTSIDE_SEATS.map(([x, y]) => <OutsideSeatMarker key={`${x}`} x={x} y={y} r={mobile ? 7 : 5.5} ring={mobile ? 13 : 10} ringWidth={mobile ? 5 : 3} />)}
    </>
  );
}

/** 확대 미리보기 좌석 행(팬 좌석 선택과 같은 모양) */
export function PreviewRows({ over = false, seatPx = 18, gap = 4, labelWidth }: { over?: boolean; seatPx?: number; gap?: number; labelWidth?: number }) {
  return (
    <div className="seatmap" style={{ gap }}>
      {r1Rows(over).map((r) => (
        <div key={r.label} className="seat-row" style={{ gap }}>
          <span className="seat-row-label" style={labelWidth ? { width: labelWidth } : undefined}>
            {r.label}
          </span>
          {r.seats.map((s, i) => (
            <span
              key={i}
              className={s.gap ? 'seat gap' : 'seat'}
              style={{
                width: seatPx,
                height: seatPx,
                borderRadius: '50%',
                ...(s.warn ? { top: 7, left: 1, ...warnRing } : {}),
              }}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

export function CanvasPanel({ view }: { view: CanvasView }) {
  switch (view) {
    case 'layout':
      return (
        <div className="col" style={{ gap: 10, flex: 1 }}>
          <Head title="배치 그리기" layer="배치 층" end={<span className="t-xs muted">A1구역 · 곡선 띠 선택</span>} />
          <p className="sr-only">캔버스는 화면 읽기 프로그램에서 숨깁니다. 왼쪽 좌석 계층과 오른쪽 구역 속성에서 같은 편집을 할 수 있습니다.</p>
          <div style={{ display: 'grid', gridTemplateColumns: 'auto minmax(0,1fr)', gap: 10, flex: 1 }}>
            <DrawToolRail />
            <SeatMapEditorCanvas viewBox={FULL_VIEW} grid padding={6}>
              {STAGE_FULL}
              {ZONES.map((z) =>
                z.id === 'A1' ? null : <ZoneShape key={z.id} shape={z.shape} stroke="var(--border-input)" />,
              )}
              <ZoneShape shape={zone('A1').shape} fill="var(--primary-subtle)" stroke="var(--border-primary)" strokeWidth={3} />
              {ZONES.map((z) => (
                <g key={`t${z.id}`}>
                  <CanvasText x={z.label.x} y={z.label.y} size={22} bold color={z.id === 'A1' ? 'var(--link)' : 'var(--text)'}>
                    {z.name}
                  </CanvasText>
                  <CanvasText x={z.label.x} y={z.label.y + 22} size={16} color={z.id === 'A1' ? 'var(--link)' : 'var(--text-muted)'}>
                    {z.grade}석 · {z.seats}석
                  </CanvasText>
                </g>
              ))}
              {GATES}
              <GuideLine x1={320} y1={24} x2={320} y2={414} />
              <SelectionHandles
                bbox={[97.1, 217.2, 219.3, 162.8]}
                radiusHandles={[
                  [235, 266.5],
                  [195.6, 353],
                ]}
                angleHandles={[
                  [315.6, 332.5],
                  [132.4, 249],
                ]}
              />
              <DimensionTag x={108} y={390} width={170} text="가로 21.9m · 세로 16.3m" />
            </SeatMapEditorCanvas>
          </div>
          <div className="row between wrap" style={{ gap: '6px 16px' }}>
            <Legend
              items={[
                <>
                  {swatch({ width: 14, height: 10, borderRadius: 2, background: 'var(--primary-subtle)', boxShadow: 'inset 0 0 0 2px var(--border-primary)' })}
                  선택한 구역
                </>,
                <>
                  {swatch({ width: 9, height: 9, background: 'var(--surface)', boxShadow: 'inset 0 0 0 2px var(--primary)' })}
                  모서리·변 손잡이
                </>,
                <>
                  {swatch({ width: 11, height: 11, borderRadius: '50%', background: 'var(--surface)', boxShadow: 'inset 0 0 0 2px var(--primary)' })}
                  회전(오른쪽 아래)
                </>,
                <>
                  {swatch({ width: 8, height: 8, background: 'var(--primary)', transform: 'rotate(45deg)' })}
                  안쪽·바깥 반지름
                </>,
                <>
                  {swatch({ width: 10, height: 10, borderRadius: '50%', background: 'var(--surface)', boxShadow: 'inset 0 0 0 3px var(--primary)' })}
                  시작·끝 각도
                </>,
                <>
                  {swatch({ width: 16, height: 0, borderTop: '2px dashed var(--danger)' })}
                  정렬 안내선
                </>,
              ]}
            />
            <span className="t-xs muted">
              구역을 두 번 누르면 그 구역의 좌석 층으로 확대합니다 · 화살표 10cm · Shift+화살표 1m 이동 · 끄는 조작은 구역 속성의 숫자로도 바꿀 수 있습니다
            </span>
          </div>
        </div>
      );

    case 'fill':
      return (
        <div className="col" style={{ gap: 10, flex: 1 }}>
          <Head title="좌석 채우기" layer="좌석 층" end={<span className="badge badge-primary">채우기 미리보기</span>} />
          <p className="sr-only">캔버스는 화면 읽기 프로그램에서 숨깁니다. 오른쪽 좌석 채우기 패널의 결과 줄이 같은 내용을 알립니다.</p>
          <SeatMapEditorCanvas viewBox={A1_VIEW} seats={ghostSeats()} seatSize={6} minimap={MINI_A1}>
            <A1Surroundings a1Stroke="var(--border-primary)" label="A1구역" sub="곡선 띠 · 20행" labelColor="var(--link)" />
          </SeatMapEditorCanvas>
          <Legend
            center
            items={[
              <>
                {seatDot('', { background: 'var(--primary-subtle)', boxShadow: 'inset 0 0 0 1px var(--link)' })}
                채울 좌석(미리보기) 598석
              </>,
              <>
                {swatch({ width: 14, height: 10, borderRadius: 2, background: 'var(--surface)', boxShadow: 'inset 0 0 0 2px var(--border-primary)' })}
                고른 구역 도형
              </>,
              <>행 모양 무대를 향한 곡선 · 세로 통로 2개</>,
            ]}
          />
        </div>
      );

    case 'noShape':
      return (
        <div className="col" style={{ gap: 10, flex: 1 }}>
          <Head title="좌석 채우기" layer="좌석 층" />
          <div className="state" role="alert" style={{ flex: 1, justifyContent: 'center' }}>
            <span className="state-icon is-warning">
              <i className="ic ic-polygon" aria-hidden="true" />
            </span>
            <p className="t-lg">먼저 배치 층에서 구역 도형을 그려 주세요</p>
            <p className="t-sm muted">새 구역 · A석 · 좌석 0석</p>
            <a className="btn btn-primary btn-sm" href="?state=%EB%B0%B0%EC%B9%98%20%EA%B7%B8%EB%A6%AC%EA%B8%B0">
              <i className="ic ic-polygon" aria-hidden="true" />
              배치 그리기로 가기
            </a>
          </div>
        </div>
      );

    case 'refine':
      return (
        <div className="col" style={{ gap: 10, flex: 1 }}>
          <Head title="좌석 다듬기" layer="좌석 층" end={<span className="t-xs muted num">R1구역 · R석 · 15열 × 20석 = 300석 · 입장 게이트 동문</span>} />
          <div className="card-raised row wrap" role="toolbar" aria-label="고른 좌석 도구" style={{ padding: '6px 8px', gap: 6 }}>
            <span className="t-sm fw-b" role="status" style={{ padding: '0 4px' }}>
              좌석 12석 선택
            </span>
            <span className="vdivider" aria-hidden="true" />
            <button className="btn btn-ghost btn-sm" type="button" aria-label="옮기기(끌기·화살표)">
              <i className="ic ic-grip" aria-hidden="true" />
              옮기기
            </button>
            <button className="btn btn-ghost btn-sm" type="button">
              줄 맞추기
            </button>
            <button className="btn btn-ghost btn-sm" type="button">
              간격 고르게
            </button>
            <button className="btn btn-ghost btn-sm" type="button" aria-label="통로 만들기(고른 좌석 사이를 비움)">
              통로 만들기
            </button>
            <button className="btn btn-danger-outline btn-sm" type="button" aria-label="지우기(기둥·카메라 자리)">
              <i className="ic ic-trash" aria-hidden="true" />
              지우기
            </button>
            <button className="btn btn-ghost btn-sm" type="button">
              <i className="ic ic-plus" aria-hidden="true" />
              좌석 넣기
            </button>
            <button className="btn btn-ghost btn-sm" type="button">
              <i className="ic ic-sort" aria-hidden="true" />
              번호 다시 매기기
            </button>
          </div>
          <p className="sr-only">캔버스는 화면 읽기 프로그램에서 숨깁니다. 왼쪽 좌석 계층에서 같은 편집을 할 수 있습니다.</p>
          <SeatMapEditorCanvas viewBox={R_VIEW} seats={rSeats('sel')} seatSize={6} padding={10} maxWidth={640}>
            <RZoom highlight="primary" />
            <MarqueeBox x={226} y={203.5} w={68} h={10} />
          </SeatMapEditorCanvas>
          <div className="row between wrap" style={{ gap: '6px 16px' }}>
            <Legend
              items={[
                <>{seatDot()}판매 대상</>,
                <>{seatDot('unav')}판매 제외</>,
                <>{seatDot('wc')}휠체어석</>,
                <>{seatDot('mine')}선택한 좌석</>,
                <>
                  {swatch({ width: 16, height: 10, borderRadius: 2, border: '1px dashed var(--primary)' })}
                  끌어 고른 상자
                </>,
              ]}
            />
            <span className="t-xs muted">누르기 · 끌어 상자로 고르기 · 행 이름을 누르면 그 행 전체 · Shift로 더하기</span>
          </div>
        </div>
      );

    case 'over':
      return (
        <div className="col" style={{ gap: 10, flex: 1 }}>
          <Head
            title="좌석 다듬기"
            layer="좌석 층"
            end={
              <span className="row t-xs tx-warning fw-b" style={{ gap: 4 }}>
                <i className="ic ic-alert ic-14" aria-hidden="true" />
                좌석 3석이 겹칩니다
              </span>
            }
          />
          <p className="t-xs muted">테두리 친 좌석 3석은 13열 좌석과 중심 사이가 좌석 간격의 절반보다 가깝습니다. 저장은 막지 않습니다.</p>
          <p className="sr-only">캔버스는 화면 읽기 프로그램에서 숨깁니다. 왼쪽 좌석 계층의 겹침 표시가 같은 내용입니다.</p>
          <SeatMapEditorCanvas viewBox={R_VIEW} seats={rSeats('over')} seatSize={6} padding={10} maxWidth={640}>
            <RZoom highlight="warning" />
            <MarqueeBox x={235} y={211} w={18.5} h={11} tone="warning" />
          </SeatMapEditorCanvas>
          <Legend center items={[<>{seatDot()}판매 대상</>, <>{seatDot('', warnRing)}겹친 좌석(테두리)</>]} />
        </div>
      );

    case 'a1':
      return (
        <div className="col" style={{ gap: 10, flex: 1 }}>
          <Head title="좌석 다듬기 · A1구역" layer="좌석 층" end={<span className="t-xs tx-warning fw-b">테두리 친 휠체어석 2석은 위치 확인이 필요합니다</span>} />
          <p className="sr-only">캔버스는 화면 읽기 프로그램에서 숨깁니다. 왼쪽 좌석 계층에서 같은 편집을 할 수 있습니다.</p>
          <SeatMapEditorCanvas viewBox={A1_VIEW} seats={a1Seats()} seatSize={6} minimap={MINI_A1}>
            <A1Surroundings a1Stroke="var(--border-input)" label="A1구역" sub="18열 × 25석" labelColor="var(--text)" />
          </SeatMapEditorCanvas>
          <Legend
            center
            items={[
              <>{seatDot()}판매 대상</>,
              <>{seatDot('unav')}판매 제외</>,
              <>{seatDot('wc')}휠체어석</>,
              <>{seatDot('wc', warnRing)}위치 확인 필요(테두리)</>,
            ]}
          />
        </div>
      );

    case 'preview':
      return (
        <div className="col" style={{ gap: 12, flex: 1 }}>
          <Head title="미리보기 · 전체 배치" end={<span className="t-xs muted">팬이 보는 좌석 선택 화면과 같습니다</span>} />
          <SeatMapEditorCanvas
            viewBox={FULL_VIEW}
            padding="12px 12px 84px"
            minimap={<CanvasMiniMap viewBox={FULL_VIEW} width={110} height={69} shapes={miniShapes('preview')} focus={[0, 20, 640, 420]} />}
            controls={<ZoomControls />}
          >
            <PreviewOverview />
          </SeatMapEditorCanvas>
          <p className="hint" style={{ textAlign: 'center' }}>
            구역을 확대하면 좌석을 고를 수 있습니다
          </p>
        </div>
      );

    case 'previewZoom':
      return (
        <div className="col" style={{ gap: 12, flex: 1 }}>
          <Head title="미리보기 · R1구역 확대" end={<span className="t-xs muted">팬이 보는 좌석 선택 화면과 같습니다</span>} />
          <div style={{ position: 'relative', flex: 1, display: 'flex', minWidth: 0 }}>
            <div
              className="card-flat col"
              style={{ position: 'relative', flex: 1, gap: 8, alignItems: 'center', justifyContent: 'center', padding: '16px 12px 88px', overflowX: 'auto' }}
              aria-hidden="true"
            >
              <div className="stage" style={{ width: 300, maxWidth: '100%' }}>
                무대 방향
              </div>
              <PreviewRows />
              <CanvasMiniMap viewBox={FULL_VIEW} width={110} height={69} shapes={miniShapes('preview')} focus={[195, 95, 325, 250]} />
            </div>
            <ZoomControls />
          </div>
          <Legend center items={[<>{seatDot()}예매 가능</>, <>{seatDot('unav')}판매 제외</>, <>{seatDot('wc')}휠체어석</>]} />
        </div>
      );

    case 'out':
      return (
        <div className="col" style={{ gap: 12, flex: 1 }}>
          <Head
            title="가져오기 결과"
            end={
              <span className="badge badge-warning">
                <i className="ic ic-alert" aria-hidden="true" />
                확인 필요
              </span>
            }
          />
          <div className="card-flat col" role="status" style={{ gap: 8, padding: '12px 14px' }}>
            <div className="row wrap" style={{ gap: '6px 10px' }}>
              <span className="t-sm mono">picket-arena-layout.json</span>
              <span className="badge badge-outline">JSON</span>
              <span className="t-xs muted">SVG·JSON·CSV 모두 구역 도형과 좌석 좌표를 함께 받습니다</span>
            </div>
            <div className="row wrap t-sm" style={{ gap: '4px 18px' }}>
              <span>
                <span className="muted">무대 도형</span> <strong className="num">1</strong>
              </span>
              <span>
                <span className="muted">구역 도형</span> <strong className="num">6</strong>
              </span>
              <span>
                <span className="muted">좌석 좌표</span> <strong className="num">2,400석</strong>
              </span>
              <span>
                <span className="muted">오류</span> <strong className="num">0행</strong>
              </span>
            </div>
            <p className="row t-sm tx-warning fw-b" style={{ gap: 6 }}>
              <i className="ic ic-alert ic-16" aria-hidden="true" />
              구역 도형 밖에 좌석 3석이 있습니다
            </p>
          </div>
          <SeatMapEditorCanvas viewBox={FULL_VIEW} padding={12}>
            <ZoneShape shape={STAGE} fill="var(--fill-weak-strong)" stroke="var(--border)" strokeWidth={1} />
            <CanvasText x={320} y={63} size={20} bold color="var(--text-muted)" spacing=".2em">
              무대
            </CanvasText>
            {ZONES.map((z) =>
              z.id === 'S2' ? (
                <ZoneShape key={z.id} shape={z.shape} fill="var(--warning-subtle)" stroke="var(--warning)" strokeWidth={3} />
              ) : (
                <ZoneShape key={z.id} shape={z.shape} stroke="var(--border-input)" />
              ),
            )}
            {ZONES.map((z) => (
              <CanvasText key={`t${z.id}`} x={z.label.x} y={z.label.y + (z.grade === 'S' ? 14 : 12)} size={22} bold color={z.id === 'S2' ? 'var(--warning)' : 'var(--text)'}>
                {z.name}
              </CanvasText>
            ))}
            {OUTSIDE_SEATS.map(([x, y]) => (
              <OutsideSeatMarker key={`${x}`} x={x} y={y} />
            ))}
            {GATES}
          </SeatMapEditorCanvas>
          <Legend center items={[<>{seatDot('', warnRing)}구역 도형 밖 좌석(테두리)</>]} />
        </div>
      );

    case 'import':
      return (
        <div className="col" style={{ gap: 12, flex: 1 }}>
          <Head title="파일 가져오기" end={<span className="badge badge-primary">검사 중</span>} />
          <div className="state" role="status" aria-live="polite" style={{ flex: 1, justifyContent: 'center' }}>
            <span className="state-icon is-primary">
              <i className="ic ic-upload" aria-hidden="true" />
            </span>
            <p className="t-lg">파일을 가져오는 중입니다</p>
            <p className="t-sm mono">picket-arena-seats.csv</p>
            <div className="col" style={{ gap: 6, width: '100%', maxWidth: 360 }}>
              <div className="row between t-sm">
                <span>행마다 형식·중복 검사</span>
                <span className="num muted">1,320 / 2,400행 · 55%</span>
              </div>
              <div
                className="progress"
                role="progressbar"
                aria-label="picket-arena-seats.csv 가져오기"
                aria-valuenow={55}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuetext="2,400행 중 1,320행 검사, 55%"
              >
                <span style={{ width: '55%' }} />
              </div>
            </div>
            <p className="t-sm muted">검사를 마치기 전에는 좌석맵을 바꾸지 않습니다. 오류 행이 하나라도 있으면 파일 전체를 반영하지 않습니다.</p>
          </div>
        </div>
      );

    case 'fail':
      return (
        <div className="col" style={{ gap: 12, flex: 1 }}>
          <Head title="가져오기 검증 결과" end={<span className="badge badge-danger">오류 3행</span>} />
          <div className="banner banner-danger" role="alert">
            <i className="ic ic-alert-circle" aria-hidden="true" />
            <div className="banner-body">
              <span className="banner-title">파일을 좌석맵에 반영하지 않았습니다</span>
              picket-arena-seats.csv 2,400행 중 3행에 오류가 있습니다. 오류 행을 고친 뒤 다시 가져와 주세요. 지금 좌석맵은 바뀌지 않았습니다.
            </div>
          </div>
          <div className="table-wrap table-scroll" role="region" aria-label="가져오기 오류 행" tabIndex={0}>
            <table className="table dense">
              <caption className="sr-only">가져오기 오류 3행의 위치·항목·원인</caption>
              <thead>
                <tr>
                  <th scope="col">위치</th>
                  <th scope="col">항목</th>
                  <th scope="col">원인</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td className="mono nowrap">CSV 12행</td>
                  <td className="nowrap">좌석 번호</td>
                  <td>좌석 번호 중복(R1구역 12열 7번이 7행과 같습니다)</td>
                </tr>
                <tr>
                  <td className="mono nowrap">CSV 38행</td>
                  <td className="nowrap">등급</td>
                  <td>가격 등급에 없는 등급 &quot;VIP&quot;입니다</td>
                </tr>
                <tr>
                  <td className="mono nowrap">CSV 205행</td>
                  <td className="nowrap">입장 게이트 구역</td>
                  <td>없는 게이트 구역 &quot;북문&quot;입니다(동문·서문만 있습니다)</td>
                </tr>
              </tbody>
            </table>
          </div>
          <div className="row wrap" style={{ gap: 8 }}>
            <button className="btn btn-primary btn-sm max-lg:min-h-11" type="button">
              <i className="ic ic-upload" aria-hidden="true" />
              고친 파일 다시 가져오기
            </button>
            <button className="btn btn-ghost btn-sm max-lg:min-h-11" type="button">
              검증 결과 닫기
            </button>
          </div>
        </div>
      );
  }
}
