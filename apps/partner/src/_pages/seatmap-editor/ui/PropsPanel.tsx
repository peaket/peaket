// 오른쪽 속성 패널(데스크톱 2열, size "sm")과 태블릿 시트 안 내용(size "md", 44px 누름 영역). 보드 SCR-022-d 'props'·-t 'drawer'.
// 끄는 조작(옮기기·크기·회전·반지름·각도)은 모두 여기 숫자 입력으로도 한다(WCAG 2.5.7).
import { SeatFillPanel } from '@peaket/ds/SeatFillPanel';
import type { CSSProperties, ReactNode } from 'react';
import { formatWon, type PriceTier } from '@/entities/production';
import { GRADE_FILL, type Grade } from '../model/geometry';
import type { PropsView } from '../model/view';

type Size = 'sm' | 'md';

function Heading({ size, id, title, sub, closeLabel }: { size: Size; id: string; title: string; sub?: string; closeLabel?: string }) {
  if (size === 'sm')
    return (
      <div className="col" style={{ gap: 2 }}>
        <h2 className="t-md fw-b" id={id}>
          {title}
        </h2>
        {sub ? <span className="t-xs muted">{sub}</span> : null}
      </div>
    );
  return (
    <div className="drawer-head" style={{ padding: '4px 0 10px 0', marginBottom: 0 }}>
      <div className="col grow" style={{ gap: 2 }}>
        <h2 className="t-lg" id={id}>
          {title}
        </h2>
        {sub ? <span className="t-sm muted">{sub}</span> : null}
      </div>
      <SheetClose label={closeLabel ?? `${title} 시트 닫기`} />
    </div>
  );
}

/** 태블릿 시트 닫기(EditorWorkspace가 data-sheet-close를 듣는다) */
export function SheetClose({ label }: { label: string }) {
  return (
    <button className="icon-btn" type="button" aria-label={label} data-sheet-close="">
      <i className="ic ic-close" aria-hidden="true" />
    </button>
  );
}

function Select({ size, id, label, options, labelStyle }: { size: Size; id: string; label: string; options: string[]; labelStyle?: CSSProperties }) {
  return (
    <div className="field" style={size === 'sm' ? { gap: 4 } : undefined}>
      <label className="label" htmlFor={id} style={labelStyle}>
        {label}
      </label>
      <div className={size === 'sm' ? 'input-group input-group-sm' : 'input-group'}>
        <select id={id} defaultValue={options[0]}>
          {options.map((o) => (
            <option key={o}>{o}</option>
          ))}
        </select>
        <i className="ic ic-chevron-down" aria-hidden="true" />
      </div>
    </div>
  );
}

function Pair({ size, items, describedBy, legend }: { size: Size; legend: string; describedBy?: string; items: { k: string; label: string; value: string; error?: boolean }[] }) {
  const ig = size === 'sm' ? 'input-group input-group-sm' : 'input-group';
  return (
    <fieldset className="col" style={{ gap: size === 'sm' ? 6 : 8 }} aria-describedby={describedBy}>
      <legend className="label" style={{ marginBottom: 6 }}>
        {legend}
      </legend>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,minmax(0,1fr))', gap: size === 'sm' ? 6 : 8 }}>
        {items.map((it) => (
          <div key={it.k} className={`${ig}${it.error ? ' is-error' : ''}`} style={size === 'sm' ? { padding: '0 8px', gap: 4 } : { gap: 6 }}>
            <span className={size === 'sm' ? 't-xs muted' : 't-sm muted'} aria-hidden="true">
              {it.k}
            </span>
            <input type="text" inputMode="decimal" aria-label={it.label} defaultValue={it.value} aria-invalid={it.error || undefined} />
          </div>
        ))}
      </div>
    </fieldset>
  );
}

function Check({ size, label, checked, describedBy }: { size: Size; label: string; checked?: boolean; describedBy?: string }) {
  return (
    <label className="check-row" style={size === 'sm' ? { fontSize: 14 } : { alignItems: 'center', minHeight: 44 }}>
      <input className="cb" type="checkbox" defaultChecked={checked} aria-describedby={describedBy} />
      {label}
    </label>
  );
}

function Warn({ id, children, size }: { id: string; children: ReactNode; size: Size }) {
  return (
    <div className={`row ${size === 'sm' ? 't-xs' : 't-sm'} tx-warning fw-b`} id={id} style={{ gap: 4, alignItems: 'flex-start' }}>
      <i className="ic ic-alert ic-14" aria-hidden="true" />
      {children}
    </div>
  );
}

const TIERS = ['A석', 'R석', 'S석'];
const GATES = ['동문', '서문'];

export function PropsPanel({ view, size, priceTiers }: { view: PropsView; size: Size; priceTiers: readonly PriceTier[] }) {
  const p = (k: string) => `${size}-${k}`;
  const inputCls = size === 'sm' ? 'input input-sm' : 'input';
  const btn = (cls: string) => (size === 'sm' ? `${cls} btn-sm` : cls);
  const btnStyle = size === 'md' ? { height: 44 } : undefined;
  const small = { fontSize: 12 };

  switch (view) {
    case 'shape':
      return (
        <div className="col" style={{ gap: size === 'sm' ? 12 : 14 }}>
          <Heading size={size} id={p('h-props')} title="구역 속성" sub="A1구역 · 곡선 띠" />
          <div className="field" style={size === 'sm' ? { gap: 4 } : undefined}>
            <label className="label" htmlFor={p('z-name')}>
              이름
            </label>
            <input className={inputCls} id={p('z-name')} type="text" defaultValue="A1구역" />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,minmax(0,1fr))', gap: size === 'sm' ? 8 : 10 }}>
            <Select size={size} id={p('z-floor')} label="층" options={['1층']} />
            <Select size={size} id={p('z-tier')} label="등급" options={TIERS} />
          </div>
          <Select size={size} id={p('z-gate')} label="입장 게이트" options={GATES} />
          <Pair
            size={size}
            legend="위치·크기(m)"
            items={[
              { k: 'x', label: '위치 x(m)', value: '9.7' },
              { k: 'y', label: '위치 y(m)', value: '21.7' },
              { k: '가로', label: '가로(m)', value: '21.9' },
              { k: '세로', label: '세로(m)', value: '16.3' },
            ]}
          />
          <div className="field" style={size === 'sm' ? { gap: 4 } : undefined}>
            <label className="label" htmlFor={p('z-rot')}>
              회전(°)
            </label>
            <input className={inputCls} id={p('z-rot')} type="text" inputMode="decimal" defaultValue="0" />
          </div>
          <fieldset className="card-flat col" style={{ padding: size === 'sm' ? 10 : 12, gap: 8 }}>
            <legend className="sr-only">곡선 띠 모양</legend>
            <span className="eyebrow" aria-hidden="true">
              곡선 띠 모양
            </span>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,minmax(0,1fr))', gap: 8 }}>
              {[
                ['z-cx', '중심 x(m)', '32.0'],
                ['z-cy', '중심 y(m)', '8.0'],
                ['z-ri', '안쪽 반지름(m)', '20.5'],
                ['z-ro', '바깥 반지름(m)', '30.0'],
                ['z-sa', '시작각(°)', '91'],
                ['z-ea', '끝각(°)', '138'],
              ].map(([k, label, value]) => (
                <div key={k} className="field" style={{ gap: 4 }}>
                  <label className="label" htmlFor={p(k!)} style={small}>
                    {label}
                  </label>
                  <input className={inputCls} id={p(k!)} type="text" inputMode="decimal" defaultValue={value} />
                </div>
              ))}
            </div>
          </fieldset>
          <div className="col" style={{ gap: size === 'sm' ? 6 : 8 }}>
            <button className={`${btn('btn btn-outline')} btn-block`} type="button" style={btnStyle}>
              <i className="ic ic-mirror" aria-hidden="true" />
              좌우 대칭 복제
            </button>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,minmax(0,1fr))', gap: size === 'sm' ? 6 : 8 }}>
              <button className={btn('btn btn-outline')} type="button" style={btnStyle}>
                <i className="ic ic-copy" aria-hidden="true" />
                복제
              </button>
              <button className={btn('btn btn-danger-outline')} type="button" style={btnStyle}>
                <i className="ic ic-trash" aria-hidden="true" />
                지우기
              </button>
            </div>
          </div>
        </div>
      );

    case 'fill':
      return (
        <SeatFillPanel
          headingId={p('h-props')}
          subtitle="A1구역 · 곡선 띠 · 지금 420석"
          size={size}
          result={{ tone: 'warning', text: '598석이 들어갑니다(목표보다 2석 적습니다). 도형을 넓히거나 좌석 간격을 줄이세요.' }}
          headerEnd={size === 'md' ? <SheetClose label="좌석 채우기 시트 닫기" /> : undefined}
          fillAttrs={{ 'data-modal-open': 'seatmap-refill', 'aria-haspopup': 'dialog' }}
        />
      );

    case 'noShape':
      return (
        <SeatFillPanel
          headingId={p('h-props')}
          subtitle="새 구역 · A석 · 도형 없음"
          size={size}
          disabledReason="먼저 배치 층에서 구역 도형을 그려 주세요"
          headerEnd={size === 'md' ? <SheetClose label="좌석 채우기 시트 닫기" /> : undefined}
        />
      );

    case 'seats':
      return (
        <div className="col" style={{ gap: size === 'sm' ? 12 : 14 }}>
          <Heading size={size} id={p('h-props')} title="좌석 속성" sub="R1구역 12열 5번~16번 · 12석 선택" />
          {size === 'md' ? (
            <p className="breadcrumb" style={{ flexWrap: 'wrap' }}>
              <span className="sr-only">위치: </span>
              {['피켓 아레나', '1층', 'R1구역', '12열', '5번~16번'].map((t, i) => (
                <span key={t} className="row" style={{ gap: 4 }}>
                  {i > 0 ? <i className="ic ic-chevron-right" aria-hidden="true" /> : null}
                  <span>{t}</span>
                </span>
              ))}
            </p>
          ) : null}
          <Select size={size} id={p('s-tier')} label="등급" options={['R석', 'S석', 'A석']} />
          <Check size={size} label="휠체어석" />
          <Check size={size} label="판매 제외" />
          <Select size={size} id={p('s-gate')} label="입장 게이트" options={GATES} />
          <p className="hint">고른 좌석은 끌거나 화살표 키로 옮깁니다(화살표 10cm, Shift+화살표 1m).</p>
        </div>
      );

    case 'over':
      return (
        <div className="col" style={{ gap: 12 }}>
          <Heading size={size} id={p('h-props')} title="좌석 속성" sub="R1구역 12열 7번 · 1석 선택" />
          <Warn id={p('v-w')} size={size}>
            좌석 3석이 겹칩니다
          </Warn>
          <Pair
            size={size}
            legend="위치(m)"
            describedBy={p('v-w')}
            items={[
              { k: 'x', label: '좌석 위치 x(m)', value: '24.0' },
              { k: 'y', label: '좌석 위치 y(m)', value: '21.6', error: true },
            ]}
          />
          <p className="hint">좌석 중심 사이가 좌석 간격의 절반보다 가까우면 겹친 것으로 봅니다.</p>
          <Select size={size} id={p('v-tier')} label="등급" options={['R석', 'S석', 'A석']} />
          <Select size={size} id={p('v-gate')} label="입장 게이트" options={GATES} />
        </div>
      );

    case 'a1':
      return (
        <div className="col" style={{ gap: 12 }}>
          <Heading size={size} id={p('h-props')} title="좌석 속성" sub="A1구역 18열 9번 · 1석 선택" />
          <div className="field" style={size === 'sm' ? { gap: 4 } : undefined}>
            <label className="label" htmlFor={p('q-no')}>
              좌석 번호
            </label>
            <input className={inputCls} id={p('q-no')} type="text" inputMode="numeric" defaultValue="9" />
          </div>
          <Select size={size} id={p('q-tier')} label="등급" options={TIERS} />
          <Check size={size} label="휠체어석" checked describedBy={p('q-wc-w')} />
          <Warn id={p('q-wc-w')} size={size}>
            위치 확인 필요 · 양옆에 일반 좌석이 2석 이상 있어 통로에서 바로 닿지 않을 수 있습니다. 공연장 배치도와 같은지 확인해 주세요.
          </Warn>
          <Check size={size} label="판매 제외" />
          <Select size={size} id={p('q-gate')} label="입장 게이트 구역" options={GATES} />
          <Pair
            size={size}
            legend="위치(m)"
            items={[
              { k: 'x', label: '좌석 위치 x(m)', value: '16.1' },
              { k: 'y', label: '좌석 위치 y(m)', value: '33.0' },
            ]}
          />
        </div>
      );

    case 'out':
      return (
        <div className="col" style={{ gap: 12 }}>
          <Heading size={size} id={p('h-props')} title="좌석 속성" sub="S2구역 1열 1번 · 1석 선택" />
          <Warn id={p('o-w')} size={size}>
            구역 도형 밖에 좌석 3석이 있습니다
          </Warn>
          <Pair
            size={size}
            legend="위치(m)"
            describedBy={p('o-w')}
            items={[
              { k: 'x', label: '좌석 위치 x(m)', value: '50.9', error: true },
              { k: 'y', label: '좌석 위치 y(m)', value: '11.3' },
            ]}
          />
          <Select size={size} id={p('o-tier')} label="등급" options={['S석', 'R석', 'A석']} />
          <Select size={size} id={p('o-gate')} label="입장 게이트 구역" options={['서문', '동문']} />
        </div>
      );

    case 'prices':
      return (
        <div className="col" style={{ gap: 12 }}>
          <Heading size={size} id={p('h-props')} title="등급과 가격" />
          <ul className="col t-sm" style={{ gap: 8 }} aria-labelledby={p('h-props')}>
            {priceTiers.map((t) => (
              <li key={t.grade} className="row between" style={{ gap: 6 }}>
                <span className="row" style={{ gap: 6 }}>
                  <span
                    aria-hidden="true"
                    style={{
                      display: 'inline-block',
                      width: 14,
                      height: 10,
                      borderRadius: 2,
                      background: GRADE_FILL[t.grade as Grade] ?? 'var(--fill-weak)',
                      boxShadow: t.grade === 'A' ? 'inset 0 0 0 1px var(--border)' : undefined,
                    }}
                  />
                  <span className="fw-b">{t.grade}석</span>
                </span>
                <span className="num muted">{formatWon(t.price)}</span>
              </li>
            ))}
          </ul>
        </div>
      );

    case 'idle':
      return (
        <div className="col" style={{ gap: 12 }}>
          <Heading size={size} id={p('h-props')} title="좌석 속성" />
          <p className="t-sm muted">좌석을 고르면 등급·휠체어석·판매 제외·입장 게이트 구역을 바꿀 수 있습니다.</p>
        </div>
      );
  }
}
