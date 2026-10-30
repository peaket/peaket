// CMP-021 좌석맵 근사(보드 SCR-010의 SVG·CSS 그림 그대로, design.md 결정 8). 실제 서비스는 Canvas(aria-hidden) + Web Worker다.
// 전체 배치(구역 색·많음/적음/매진) → 확대 중간 → 확대 좌석(좌석 점·열 이름·무대 방향) · 로딩(구역 외곽선만).
// 보드의 세 폭(휴대폰·태블릿·데스크톱)마다 배율이 달라 배경 그림·미니맵·팝오버는 중단점마다 하나씩 그리고 보이는 것만 남긴다.
// 좌석 점은 휴대폰 층 하나와 태블릿 위 층 하나만 그린다(태블릿은 데스크톱 배율을 같이 쓴다, model/map.ts).
import type { CSSProperties } from 'react';
import { GRADE_FILL, SEAT_ZONES, STAGE_BOX, type SeatScene } from '@/entities/seat';
import { cx } from '@/shared/lib/cx';
import { camFor, layerStyle, MAP_BP, minimapRect, nearStyle, rowLabels, seatDots, type MapBp } from '../model/map';
import type { MapLevel } from '../model/view';
import { NavButton } from './SeatControls';

const HATCH_FEW = 'scr010-hatch-few';
const HATCH_SOLD = 'scr010-hatch-sold';

/** 구역 무늬 정의(한 번만, 보이는 곳에 둔다: display:none 안의 pattern은 그려지지 않는다) */
function Patterns() {
  return (
    <svg width="0" height="0" style={{ position: 'absolute' }} focusable="false" aria-hidden="true">
      <defs>
        <pattern id={HATCH_FEW} patternUnits="userSpaceOnUse" width="12" height="12" patternTransform="rotate(45)">
          <rect x="0" y="0" width="4" height="12" style={{ fill: 'var(--surface)', opacity: 0.7 }} />
        </pattern>
        <pattern id={HATCH_SOLD} patternUnits="userSpaceOnUse" width="12" height="12" patternTransform="rotate(45)">
          <rect x="0" y="0" width="2" height="12" style={{ fill: 'var(--text-muted)', opacity: 0.6 }} />
          <rect x="0" y="0" width="12" height="2" style={{ fill: 'var(--text-muted)', opacity: 0.6 }} />
        </pattern>
      </defs>
    </svg>
  );
}

const zoneFill = (z: (typeof SEAT_ZONES)[number]) => (z.level === '매진' ? 'var(--fill-weak-strong)' : GRADE_FILL[z.grade]);

/** 전체 배치·확대 중간: 등급 색 + 남은 좌석 무늬 + 구역 이름표 */
function ZoneArt() {
  return (
    <svg width="1000" height="600" viewBox="0 0 1000 600" focusable="false">
      <rect x={STAGE_BOX.x} y={STAGE_BOX.y} width={STAGE_BOX.w} height={STAGE_BOX.h} rx="8" style={{ fill: 'var(--fill-weak-strong)' }} />
      <text x="500" y="84" textAnchor="middle" style={{ fill: 'var(--text-muted)', fontSize: 22, fontWeight: 700, letterSpacing: '.2em' }}>
        무대
      </text>
      {SEAT_ZONES.map((z) => (
        <g key={z.id}>
          <polygon points={z.points} style={{ fill: zoneFill(z), stroke: 'var(--border)', strokeWidth: 2 }} />
          {z.level !== '많음' ? <polygon points={z.points} style={{ fill: `url(#${z.level === '매진' ? HATCH_SOLD : HATCH_FEW})` }} /> : null}
        </g>
      ))}
      {SEAT_ZONES.map((z) => (
        <g key={`l-${z.id}`}>
          <rect x={z.label.x} y={z.label.y} width={z.label.w} height="60" rx="12" style={{ fill: 'var(--surface)', stroke: 'var(--border)' }} />
          <text x={z.label.x + z.label.w / 2} y={z.label.y + 27} textAnchor="middle" style={{ fill: 'var(--text)', fontSize: 24, fontWeight: 700 }}>
            {z.name}
          </text>
          <text x={z.label.x + z.label.w / 2} y={z.label.y + 51} textAnchor="middle" style={{ fill: 'var(--text)', fontSize: 20 }}>
            {z.grade} · {z.level}
          </text>
        </g>
      ))}
    </svg>
  );
}

/** 로딩: 구역 외곽선 와이어프레임만(좌석맵 정적 파일의 구역 도형) · 확대 좌석: 구역 면을 바탕색으로 */
function OutlineArt({ variant }: { variant: 'loading' | 'seats' }) {
  const shape: CSSProperties =
    variant === 'loading'
      ? { fill: 'none', stroke: 'var(--border-input)', strokeWidth: 1.5, strokeDasharray: '6 4' }
      : { fill: 'var(--surface)', stroke: 'var(--border)', strokeWidth: 1.5 };
  return (
    <svg width="1000" height="600" viewBox="0 0 1000 600" focusable="false">
      <rect
        x={STAGE_BOX.x}
        y={STAGE_BOX.y}
        width={STAGE_BOX.w}
        height={STAGE_BOX.h}
        rx="8"
        style={variant === 'loading' ? shape : { fill: 'var(--fill-weak-strong)' }}
        vectorEffect={variant === 'loading' ? 'non-scaling-stroke' : undefined}
      />
      {SEAT_ZONES.map((z) => (
        <polygon key={z.id} points={z.points} style={shape} vectorEffect="non-scaling-stroke" />
      ))}
    </svg>
  );
}

function Minimap({ bp, level }: { bp: MapBp; level: MapLevel }) {
  const { mm } = MAP_BP[bp];
  return (
    <div className="card" style={{ position: 'absolute', left: mm.inset, bottom: mm.inset, width: mm.w, height: mm.h, overflow: 'hidden', borderRadius: 'var(--r-md)' }}>
      <svg width={mm.w} height={mm.h} viewBox="150 30 700 490" focusable="false">
        <rect x={STAGE_BOX.x} y={STAGE_BOX.y} width={STAGE_BOX.w} height={STAGE_BOX.h} rx="8" style={{ fill: 'var(--fill-weak-strong)' }} />
        {SEAT_ZONES.map((z) => (
          <polygon key={z.id} points={z.points} style={{ fill: zoneFill(z) }} />
        ))}
      </svg>
      <span style={minimapRect(bp, level)} />
    </div>
  );
}

const BP_SHOW: Record<MapBp, string> = { m: 'md:hidden', t: 'hidden md:block lg:hidden', d: 'hidden lg:block' };

/** 중단점 하나의 배경 그림(구역·외곽선) */
function Background({ bp, level }: { bp: MapBp; level: MapLevel }) {
  return (
    <div className={cx('absolute inset-0', BP_SHOW[bp])}>
      <div style={layerStyle(camFor(bp, level === 'loading' ? 'overview' : level))}>
        {level === 'overview' || level === 'mid' ? <ZoneArt /> : <OutlineArt variant={level === 'loading' ? 'loading' : 'seats'} />}
      </div>
    </div>
  );
}

/** 중단점 하나의 앞 그림(무대 방향 띠·팝오버·말풍선·미니맵) */
function Foreground({ bp, level, popover, lost, recent }: { bp: MapBp; level: MapLevel; popover: boolean; lost: boolean; recent: boolean }) {
  const c = MAP_BP[bp];
  return (
    <div className={cx('absolute inset-0', BP_SHOW[bp])}>
      {level === 'seats' ? (
        <>
          <div
            className="stage"
            style={{ position: 'absolute', left: '50%', top: 0, width: c.stage.w, marginLeft: -c.stage.w / 2, minHeight: c.stage.h, fontSize: 11, letterSpacing: '.1em' }}
          >
            무대 방향
          </div>
          {popover ? (
            <div style={nearStyle(bp, 12, 8, c.pop, 58)}>
              <div className="popover col" style={{ gap: 4, padding: '10px 12px' }}>
                <div className="row between" style={{ gap: 6 }}>
                  <strong className="t-sm">R1구역 12열 8번</strong>
                  <span className="badge badge-primary">내 선택</span>
                </div>
                <span className="t-xs muted num">R석 ₩154,000</span>
              </div>
            </div>
          ) : null}
          {lost ? (
            <div style={nearStyle(bp, 12, 9, 84, 28)}>
              <span className="tooltip">가까운 좌석</span>
            </div>
          ) : null}
          {recent ? (
            <div style={nearStyle(bp, 12, 8, c.rec, 112)}>
              <div className="popover col" style={{ gap: 4, padding: '10px 12px' }}>
                <div className="row between" style={{ gap: 6 }}>
                  <strong className="t-sm">R1구역 12열 8번</strong>
                  <span className="badge badge-outline">방금 놓은 좌석</span>
                </div>
                <span className="t-xs muted num">R석 ₩154,000</span>
                <p className="t-xs">
                  방금 놓은 좌석은 <span className="num">0:24</span> 뒤에 다시 고를 수 있습니다. 그동안 다른 분이 고를 수 있습니다
                </p>
              </div>
            </div>
          ) : null}
        </>
      ) : null}
      <Minimap bp={bp} level={level} />
    </div>
  );
}

/** 좌석 점과 열 이름표. 휴대폰 층은 액자가 가장 넓을 때(767 - 16) 반폭까지, 태블릿 위 층은 데스크톱 액자 반폭까지 그린다 */
function SeatLayer({ bp, scene, className }: { bp: MapBp; scene: SeatScene; className: string }) {
  const halfW = bp === 'm' ? 376 : MAP_BP.d.fw / 2;
  return (
    <div className={cx('absolute inset-0', className)}>
      {rowLabels(bp).map((l) => (
        <span key={l.key} className="seat-row-label" style={l.style}>
          {l.text}
        </span>
      ))}
      {seatDots(bp, scene, halfW).map((s) => (
        <span key={s.key} className={cx('seat', s.cls)} style={s.style} />
      ))}
    </div>
  );
}

export interface SeatMapProps {
  level: MapLevel;
  scene: SeatScene;
  popover: boolean;
  lost: boolean;
  recent: boolean;
  zoom: { zoomIn: string; zoomOut: string; fit: string };
}

export function SeatMap({ level, scene, popover, lost, recent, zoom }: SeatMapProps) {
  return (
    <div className="relative mx-2 md:mx-0">
      <div className="card-flat relative h-[420px] overflow-hidden md:h-[560px] lg:h-[600px]" aria-hidden="true">
        <Patterns />
        <Background bp="m" level={level} />
        <Background bp="t" level={level} />
        <Background bp="d" level={level} />
        {level === 'seats' ? (
          <>
            <SeatLayer bp="m" scene={scene} className="md:hidden" />
            <SeatLayer bp="d" scene={scene} className="hidden md:block" />
          </>
        ) : null}
        <Foreground bp="m" level={level} popover={popover} lost={lost} recent={recent} />
        <Foreground bp="t" level={level} popover={popover} lost={lost} recent={recent} />
        <Foreground bp="d" level={level} popover={popover} lost={lost} recent={recent} />
      </div>

      {/* 휴대폰·태블릿: 오른쪽 위 세로(+ − 전체 보기) · 데스크톱: 가로(전체 보기 − +) */}
      <div
        className="absolute top-2 right-2 flex flex-col-reverse items-end gap-1.5 md:top-2.5 md:right-2.5 lg:top-3 lg:right-3 lg:flex-row lg:items-center"
        role="group"
        aria-label="배치도 확대·축소"
      >
        <NavButton href={zoom.fit} className="btn btn-outline btn-sm">
          전체 보기
        </NavButton>
        <NavButton href={zoom.zoomOut} className="icon-btn icon-btn-sm icon-btn-outline" label="축소">
          <i className="ic ic-minus" aria-hidden="true" />
        </NavButton>
        <NavButton href={zoom.zoomIn} className="icon-btn icon-btn-sm icon-btn-outline" label="확대">
          <i className="ic ic-plus" aria-hidden="true" />
        </NavButton>
      </div>

      {lost ? (
        <div
          className="toast absolute right-2 bottom-[76px] left-2 items-start md:right-auto md:bottom-3.5 md:left-1/2 md:w-[500px] md:-translate-x-1/2 md:items-center lg:w-[540px]"
          role="status"
        >
          <i className="ic ic-alert-circle" aria-hidden="true" />
          <span>이 좌석은 방금 다른 분이 선택했습니다. 가까운 좌석: R1구역 12열 9번, 10번</span>
        </div>
      ) : null}
    </div>
  );
}
