// 휴대폰(md 미만) 좌석맵(보드 SCR-022-m, d5 §3.9): 편집·템플릿·가져오기·내보내기는 하지 않고 안내 카드를 둔다.
// 배치 미리보기(전체 → 확대)와 좌석 요약만 보인다. 그림은 화면 읽기 프로그램에서 숨기고 아래 목록이 같은 내용이다.
import { CanvasMiniMap, CanvasText, SeatMapEditorCanvas, StageDirection, ZoneShape } from '@peaket/ds/SeatMapEditorCanvas';
import { BigScreenNotice } from '@/shared/ui/BigScreenNotice';
import { A1_VIEW, FULL_VIEW, a1Seats, miniShapes, zone } from '../model/geometry';
import type { EditorView } from '../model/view';
import { PreviewOverview, PreviewRows } from './CanvasPanel';
import { CriteriaToggle } from './EditorChrome';
import { W1_TEXT, W3_TEXT } from './SummaryCard';

function Row({ name, value, warn }: { name: string; value: string; warn?: string }) {
  return (
    <li className="row between" style={{ gap: 8, alignItems: warn ? 'flex-start' : undefined }}>
      <span className="fw-m">{name}</span>
      {warn ? (
        <span className="col" style={{ gap: 2, alignItems: 'flex-end' }}>
          <span className="muted num">{value}</span>
          <span className="row tx-warning fw-b" style={{ gap: 4 }}>
            <i className="ic ic-alert ic-16" aria-hidden="true" />
            {warn}
          </span>
        </span>
      ) : (
        <span className="muted num">{value}</span>
      )}
    </li>
  );
}

const swatch = (bg: string, outlined = false) => (
  <span
    aria-hidden="true"
    style={{ display: 'inline-block', width: 14, height: 10, borderRadius: 2, background: bg, boxShadow: outlined ? 'inset 0 0 0 1px var(--border)' : undefined }}
  />
);
const dot = (cls: string, warn = false) => (
  <span
    className={`seat ${cls}`}
    aria-hidden="true"
    style={{ width: 10, height: 10, borderRadius: '50%', ...(warn ? { outline: '2px solid var(--warning)', outlineOffset: 1 } : {}) }}
  />
);

export function MobileSeatmap({ v, isW1, isW3 }: { v: EditorView; isW1: boolean; isW3: boolean }) {
  const m = v.mobile;
  const wcWarnTile = m === 'warn' || isW1 || isW3;
  return (
    <>
      {m === 'start' ? (
        <section className="card col" style={{ padding: 16, gap: 12 }} aria-labelledby="m-h-start">
          <h2 className="t-md fw-b" id="m-h-start">
            어떻게 시작할까요?
          </h2>
          <BigScreenNotice always title="이 작업은 태블릿이나 데스크톱에서 합니다" />
          <p className="t-xs muted">템플릿으로 시작, 빈 캔버스에서 그리기, 파일 가져오기는 큰 화면에서 합니다.</p>
        </section>
      ) : (
        <>
          <BigScreenNotice always title="좌석맵 편집은 태블릿이나 데스크톱에서 합니다" />
          <p className="t-xs muted" style={{ marginTop: -8 }}>
            배치 그리기·좌석 채우기·좌석 다듬기, 템플릿으로 시작, 가져오기·내보내기도 큰 화면에서 합니다.
          </p>
          <section className="card col" style={{ padding: 16, gap: 12 }} aria-labelledby="m-h-prev">
            <div className="row between" style={{ gap: 8 }}>
              <h2 className="t-md fw-b" id="m-h-prev">
                배치 미리보기
              </h2>
              <span className="t-xs muted">피켓 아레나 · 1층</span>
            </div>
            <div className="col" style={{ gap: 10 }}>
              <p className="sr-only">배치 그림과 좌석 확대 그림은 화면 읽기 프로그램에서 숨깁니다. 아래 목록이 같은 내용입니다.</p>
              {m === 'overview' || m === 'out' ? (
                <SeatMapEditorCanvas viewBox={FULL_VIEW} padding={8}>
                  <PreviewOverview mobile outWarn={m === 'out'} />
                </SeatMapEditorCanvas>
              ) : null}
              {m === 'zoom' || m === 'over' ? (
                <div
                  className="card-flat col"
                  style={{ position: 'relative', gap: 6, alignItems: 'center', padding: '10px 8px 56px', overflowX: 'auto' }}
                  aria-hidden="true"
                >
                  <span className="eyebrow" style={{ alignSelf: 'flex-start' }}>
                    {m === 'over' ? 'R1구역 확대 · 12열 겹침 확인' : 'R1구역 확대 · 15열 × 20석'}
                  </span>
                  <div className="stage" style={{ width: 160, minHeight: 22 }}>
                    무대 방향
                  </div>
                  <PreviewRows over={m === 'over'} seatPx={9} gap={3} labelWidth={20} />
                  <CanvasMiniMap viewBox={FULL_VIEW} width={72} height={45} inset={8} shapes={miniShapes('preview')} focus={[195, 95, 325, 250]} />
                </div>
              ) : null}
              {m === 'warn' ? (
                <div className="card-flat col" style={{ position: 'relative', gap: 6, padding: '10px 8px 58px' }}>
                  <span className="eyebrow" aria-hidden="true">
                    A1구역 확대 · 18열 × 25석
                  </span>
                  <SeatMapEditorCanvas viewBox={A1_VIEW} seats={a1Seats()} seatSize={4} padding={0} style={{ background: 'transparent' }}>
                    <ZoneShape shape={zone('S1').shape} stroke="var(--border)" strokeWidth={1.2} />
                    <ZoneShape shape={{ kind: 'rect', x: 205, y: 105, w: 110, h: 135, rx: 3 }} stroke="var(--border)" strokeWidth={1.2} />
                    <ZoneShape shape={zone('A2').shape} stroke="var(--border)" strokeWidth={1.2} />
                    <ZoneShape shape={zone('A1').shape} stroke="var(--border-input)" />
                    <StageDirection x={320} y1={238} y2={206} />
                    <CanvasText x={86} y={300} size={10} bold anchor="start">
                      A1구역
                    </CanvasText>
                  </SeatMapEditorCanvas>
                  <div aria-hidden="true">
                    <CanvasMiniMap viewBox={FULL_VIEW} width={72} height={45} inset={8} shapes={miniShapes('edit', 'A1')} focus={[80, 196, 340, 392]} />
                  </div>
                </div>
              ) : null}

              <div className="row between wrap" style={{ gap: 8 }}>
                {m === 'overview' || m === 'out' ? <p className="hint">구역을 확대하면 좌석을 고를 수 있습니다</p> : null}
                <div className="row" role="group" aria-label="미리보기 확대·축소" style={{ gap: 6, marginLeft: 'auto' }}>
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
              </div>

              <div className="legend">
                <span className="legend-item">{swatch('var(--heat-3)')}R석</span>
                <span className="legend-item">{swatch('var(--heat-2)')}S석</span>
                <span className="legend-item">{swatch('var(--heat-1)', true)}A석</span>
                {m === 'warn' ? (
                  <>
                    <span className="legend-item">{dot('wc')}휠체어석</span>
                    <span className="legend-item">{dot('wc', true)}위치 확인 필요(테두리)</span>
                  </>
                ) : null}
                {m === 'out' ? <span className="legend-item">{dot('', true)}구역 도형 밖 좌석(테두리)</span> : null}
                {m === 'over' ? <span className="legend-item">{dot('', true)}겹친 좌석(테두리)</span> : null}
              </div>

              {m === 'warn' ? (
                <p className="row t-xs tx-warning fw-b" style={{ gap: 4, alignItems: 'flex-start' }}>
                  <i className="ic ic-alert ic-16" aria-hidden="true" />
                  18열 9번·10번 위치 확인 필요 · 양옆에 일반 좌석이 2석 이상 있어 통로에서 바로 닿지 않을 수 있습니다. 공연장 배치도와 같은지 확인해 주세요.
                </p>
              ) : null}
              {m === 'over' ? (
                <p className="row t-xs tx-warning fw-b" style={{ gap: 4, alignItems: 'flex-start' }}>
                  <i className="ic ic-alert ic-16" aria-hidden="true" />
                  좌석 3석이 겹칩니다 · 12열 7번·8번·9번이 13열 좌석과 중심 사이가 좌석 간격의 절반보다 가깝습니다. 저장은 막지 않습니다.
                </p>
              ) : null}

              <ul className="col t-sm" style={{ gap: 6 }}>
                {m === 'over' ? (
                  <>
                    <Row name="R1구역" value="R석 · 300석" warn="12열 7번·8번·9번 겹침" />
                    <Row name="R2구역" value="R석 · 300석" />
                  </>
                ) : (
                  <Row name="R1·R2구역" value="R석 · 각 300석" />
                )}
                {m === 'out' ? (
                  <>
                    <Row name="S1구역" value="S석 · 450석" />
                    <Row name="S2구역" value="S석 · 450석" warn="1열 1번·2번·3번 도형 밖" />
                  </>
                ) : (
                  <Row name="S1·S2구역" value="S석 · 각 450석" />
                )}
                {m === 'warn' ? (
                  <>
                    <Row name="A1구역" value="A석 · 450석 · 휠체어석 10석" warn="18열 9번·10번 위치 확인" />
                    <Row name="A2구역" value="A석 · 450석 · 휠체어석 10석" />
                  </>
                ) : (
                  <Row name="A1·A2구역" value={`A석 · 각 450석 · 휠체어석 각 ${v.wcPerZone}석`} />
                )}
                <li className="row between" style={{ gap: 8 }}>
                  <span className="fw-m">입장 게이트 구역</span>
                  <span className="muted">동문·서문</span>
                </li>
              </ul>
            </div>
          </section>
        </>
      )}

      <section className="col" style={{ gap: 12 }} aria-labelledby="m-h-sum">
        <h2 className="t-md fw-b" id="m-h-sum">
          좌석 요약
        </h2>
        <div className="col">
          {m === 'start' ? (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,minmax(0,1fr))', gap: 12 }}>
              <div className="stat">
                <span className="stat-label">총 좌석</span>
                <span className="stat-value">0석</span>
              </div>
              <div className="stat">
                <span className="stat-label">휠체어석</span>
                <span className="stat-value">0석</span>
                <span className="badge" style={{ alignSelf: 'flex-start' }}>
                  검사 전
                </span>
              </div>
              <div className="stat" style={{ gridColumn: 'span 2' }}>
                <span className="stat-label">등급별</span>
                <span className="t-lg muted">없음</span>
              </div>
              <div className="stat" style={{ gridColumn: 'span 2' }}>
                <span className="stat-label">예상 매출</span>
                <span className="t-lg muted">계산 전</span>
              </div>
            </div>
          ) : (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,minmax(0,1fr))', gap: 12 }}>
                <div className="stat">
                  <span className="stat-label">총 좌석</span>
                  <span className="stat-value">2,400석</span>
                  <span className="stat-meta">구역 6 · 게이트 구역 2</span>
                </div>
                <div className={wcWarnTile ? 'stat is-burning' : 'stat'}>
                  <span className="stat-label">휠체어석(A석에 포함)</span>
                  <span className="stat-value">{isW1 ? '12석' : '20석'}</span>
                  <span className="stat-meta">{isW3 ? '판매 대상 0석 · 기준 20석 이상' : '기준 20석 이상'}</span>
                  <div className="col" style={{ gap: 6, alignItems: 'flex-start' }}>
                    {m === 'warn' ? (
                      <>
                        <span className="badge badge-warning">
                          <i className="ic ic-alert" aria-hidden="true" />
                          위치 확인 2석
                        </span>
                        <span className="stat-meta">A1구역 18열 9번·10번</span>
                      </>
                    ) : isW1 || isW3 ? (
                      <span className="badge badge-warning">
                        <i className="ic ic-alert" aria-hidden="true" />
                        확인 필요
                      </span>
                    ) : (
                      <span className="badge badge-success">
                        <i className="ic ic-check" aria-hidden="true" />
                        수량 기준 충족
                      </span>
                    )}
                  </div>
                </div>
                {m === 'out' || m === 'over' ? (
                  <div className="stat is-burning" style={{ gridColumn: 'span 2' }}>
                    <span className="stat-label">좌석 위치</span>
                    <span className="row wrap" style={{ gap: '6px 8px' }}>
                      <span className="badge badge-warning">
                        <i className="ic ic-alert" aria-hidden="true" />
                        확인 필요
                      </span>
                      <span className="t-md fw-b">{m === 'out' ? '구역 도형 밖에 좌석 3석이 있습니다' : '좌석 3석이 겹칩니다'}</span>
                    </span>
                    <span className="stat-meta">{m === 'out' ? 'S2구역 1열 1번·2번·3번' : 'R1구역 12열 7번·8번·9번'}</span>
                  </div>
                ) : null}
                <div className="stat" style={{ gridColumn: 'span 2' }}>
                  <span className="stat-label">등급별</span>
                  <span className="t-lg num">R 600 · S 900 · A 900</span>
                </div>
                <div className="stat" style={{ gridColumn: 'span 2' }}>
                  <span className="stat-label">예상 매출</span>
                  <span className="stat-value">{isW3 ? '₩308,000,000' : '₩310,200,000'}</span>
                  <span className="stat-meta">{isW3 ? '회차당, 판매 대상 좌석 기준' : '회차당, 전석 판매 기준'}</span>
                </div>
              </div>
              {isW1 || isW3 ? (
                <div className="banner banner-warning" role="status" style={{ marginTop: 12 }}>
                  <i className="ic ic-alert" aria-hidden="true" />
                  <div className="banner-body">{isW1 ? W1_TEXT : W3_TEXT}</div>
                </div>
              ) : null}
            </>
          )}
          <CriteriaToggle defaultOpen={v.showCriteria} idPrefix="m" stacked />
        </div>
      </section>
    </>
  );
}
