// 세 원천(합성·조사·연구)에서 달라지는 자리를 세 배치 보드(board-d·t·m)가 함께 쓴다(d5 §7.17, docs/features/forensic-replay.md §2.1·§2.2).
// 보드 마크업은 캔버스 보드를 옮긴 것이라 손대는 곳을 조건 줄로만 줄이고, 조사·연구에서 새로 그리는 자리는 여기 한 벌만 둔다.
// 조사·연구 원천의 변형은 디자인 캔버스 보드가 없어 d5 그림이 시각 기준이다. 데이터는 목업이다(계정 ID·가명·IP 없음, §6.7.1).
import type { CSSProperties } from 'react';
import { ReplaySourceBadge } from '@peaket/ds/ReplaySourceBadge';
import { CONSOLE_ORIGIN } from '../lib/origins';
import { DENY_BODY, DENY_STATE, DENY_TITLE, REVIEW_PENDING_BODY, REVIEW_PENDING_STATE, parseOpened, sourceSpec, type Source } from '../lib/source';
import { useSearch } from '../lib/url';

export { ReplaySourceBadge };

/** 보드 값(valsD·T·M)에 더하는 원천 값 */
export function sourceVals(st: string, source: Source) {
  const cand = st === '후보 고름';
  const inv = source === 'investigation';
  const deny = st === DENY_STATE;
  const recv = st === '받는 중';
  const expired = st === '원천 만료';
  // 연구 내보내기 403 pseudonymization-review-pending(연구 원천만, ADR-0173 결정 8, apply-legal-review-to-screens)
  const reviewPending = source === 'research' && st === REVIEW_PENDING_STATE;
  return {
    src: source,
    spec: sourceSpec(source),
    isSyn: source === 'synthetic',
    notSyn: source !== 'synthetic',
    isInv: inv,
    isRes: source === 'research',
    isDeny: deny,
    isRecv: recv,
    isExpired: expired,
    isReviewPending: reviewPending,
    /** 조사는 고른 칸의 계정 좌석을 기본 좌석맵 위에 점등한다(합성·연구는 후보 좌석맵으로 바꾼다) */
    candMap: cand && !inv,
    /** 요약 칸의 '고른 세션' 값은 합성·연구만(조사의 고르기는 계정 하나라 전체 범위 값을 둔다) */
    statCand: cand && !inv,
    /** 좌석맵 그림 설명에 붙이는 점등 설명(조사) */
    mapNote: inv ? SEAT_MARK_NOTE + (cand ? SEAT_PICK_NOTE : '') : '',
    /** 그릴 사건이 있는 상태(받는 중·원천 만료·검토 전·권한 없음은 아무것도 그리지 않는다) */
    hasData: !deny && !recv && !expired && !reviewPending,
  };
}

const SEAT_MARK_NOTE = ' 묶음 계정이 잡은 좌석은 플로어 F2·F3과 아래층 A5·A6에 있고, 그 가운데 F3의 2석이 외부 게시물과 맞았습니다.';
const SEAT_PICK_NOTE = ' 고른 칸의 묶음 계정 #3이 잡은 좌석 3석을 점등했습니다.';

/** 연 길이 넘긴 사건·회차(?case=·?event=)를 반영한 원천의 보일 자리 */
function useSpec(source: Source) {
  const search = useSearch();
  return sourceSpec(source, parseOpened(search));
}

const consoleHref = (path: string) => `${CONSOLE_ORIGIN}${path}`;

function ConsoleLink({ path, style }: { path: string; style?: CSSProperties }) {
  return (
    <a href={consoleHref(path)} className="link-more" style={style}>
      관제 콘솔
      <i className="ic ic-chevron-right" aria-hidden="true" />
    </a>
  );
}

/**
 * 조사·연구 원천의 머리(데스크톱·태블릿): 회차 · 사건(조사) · 시간창 · 안내 글 · ( 관제 콘솔 › ).
 * 권한 없음에서는 회차·사건을 보이지 않고(지정이 없는 사람에게 사건 번호를 드러내지 않는다) 관제 콘솔 링크만 둔다.
 */
export function SourceHead({ source, deny }: { source: Source; deny: boolean }) {
  const s = useSpec(source);
  if (deny) return <ConsoleLink path="/dashboard" style={{ marginLeft: 'auto' }} />;
  return (
    <>
      <span className="sep" aria-hidden="true" />
      <span className="fw-b">{s.event}</span>
      {s.caseLabel ? <span className="mono" style={{ whiteSpace: 'nowrap' }}>{s.caseLabel}</span> : null}
      <span className="mono t-xs muted" style={{ whiteSpace: 'nowrap' }}>{s.window}</span>
      <span className="row t-xs muted" style={{ gap: 4 }}>
        <i className="ic ic-lock ic-14" aria-hidden="true" />
        {s.headerNote}
      </span>
      <ConsoleLink path={s.consolePath ?? '/dashboard'} style={{ marginLeft: 'auto' }} />
    </>
  );
}

/** 조사·연구 원천의 머리(휴대폰): 머리 아래 한 단에 회차·안내 글·관제 콘솔 링크 */
export function SourceHeadCompact({ source, deny }: { source: Source; deny: boolean }) {
  const s = useSpec(source);
  if (deny) return <ConsoleLink path="/dashboard" style={{ marginLeft: 'auto' }} />;
  return (
    <div className="col" style={{ gap: 4, width: '100%', minWidth: 0 }}>
      <span className="row t-xs" style={{ flexWrap: 'wrap', gap: '0 6px', whiteSpace: 'normal' }}>
        {[s.event, s.caseLabel, s.window].filter(Boolean).map((t, i) => (
          <span key={i} style={{ whiteSpace: 'nowrap' }}>
            {i > 0 ? '· ' : ''}
            {t}
          </span>
        ))}
      </span>
      <div className="row between" style={{ gap: '4px 8px', flexWrap: 'wrap' }}>
        <span className="row t-xs muted" style={{ gap: 4, whiteSpace: 'normal' }}>
          <i className="ic ic-lock ic-14" aria-hidden="true" />
          {s.headerNote}
        </span>
        <ConsoleLink path={s.consolePath ?? '/dashboard'} />
      </div>
    </div>
  );
}

// ── 좌석 리플레이 점등(조사, CMP-021 replay. 색만으로 가르지 않는다: 굵은 테두리와 깃발 모양) ──

/** 묶음 계정이 잡은 좌석(대표 몇 석). [x, y, 계정 번호] */
const MEMBER_SEATS: readonly [number, number, number][] = [
  [386, 86, 3], [396, 86, 3], [406, 86, 1], [386, 95, 2], [396, 95, 5], [406, 95, 7],
  [452, 86, 4], [462, 86, 8], [452, 95, 6],
  [418, 398, 3], [428, 398, 9], [438, 398, 1], [448, 398, 2], [418, 407, 5], [428, 407, 4],
  [492, 392, 6], [501, 390, 7], [510, 388, 8],
];
/** 외부 게시물과 맞은 좌석(F3의 2석) */
const POST_SEATS: readonly [number, number][] = [
  [462, 86],
  [452, 95],
];

/** 좌석맵 SVG 안에 넣는다(viewBox 880×520, 콘서트 배치) */
export function SeatMarks({ picked }: { picked: boolean }) {
  return (
    <g aria-hidden="true">
      {MEMBER_SEATS.map(([x, y]) => (
        <rect key={`m${x}-${y}`} x={x} y={y} width="7" height="7" rx="1.5" style={{ fill: 'var(--link)', stroke: 'var(--text)', strokeWidth: 2 }} />
      ))}
      {POST_SEATS.map(([x, y]) => (
        <g key={`p${x}-${y}`}>
          <line x1={x + 3.5} y1={y} x2={x + 3.5} y2={y - 10} style={{ stroke: 'var(--text)', strokeWidth: 1.5 }} />
          <polygon points={`${x + 3.5},${y - 10} ${x + 11},${y - 7.5} ${x + 3.5},${y - 5}`} style={{ fill: 'var(--warning)', stroke: 'var(--text)', strokeWidth: 1 }} />
        </g>
      ))}
      {picked
        ? MEMBER_SEATS.filter(([, , n]) => n === 3).map(([x, y]) => (
            <circle key={`c${x}-${y}`} cx={x + 3.5} cy={y + 3.5} r="7" style={{ fill: 'none', stroke: 'var(--danger)', strokeWidth: 1.8 }} />
          ))
        : null}
    </g>
  );
}

/** 좌석맵 범례에 더하는 두 항목(글자로 적는다, d2 CMP-021) */
export function SeatMarkLegend() {
  return (
    <>
      <li className="legend-item">
        <span aria-hidden="true" style={{ display: 'inline-block', width: 12, height: 12, borderRadius: 2, background: 'var(--link)', boxShadow: 'inset 0 0 0 2px var(--text)' }} />
        묶음 계정 좌석
      </li>
      <li className="legend-item">
        <svg width="12" height="14" viewBox="0 0 12 14" aria-hidden="true">
          <line x1="2" y1="1" x2="2" y2="13" style={{ stroke: 'var(--text)', strokeWidth: 1.5 }} />
          <polygon points="2,1 11,4 2,7" style={{ fill: 'var(--warning)', stroke: 'var(--text)', strokeWidth: 1 }} />
        </svg>
        게시물 대조 좌석
      </li>
    </>
  );
}

/** 요약 넷째 칸(조사): 후보 비율 대신 묶음 계정 수(d5 §7.17) */
export function GroupCountStat() {
  return (
    <div className="stat">
      <span className="stat-label">묶음 계정 수</span>
      <span className="stat-value">9</span>
      <span className="stat-meta">파일 안 번호 #1~#9</span>
    </div>
  );
}

/** 교차 필터의 묶음(조사만). 다른 필터처럼 '전체'를 처음 값으로 둔다 */
export function GroupFilter() {
  return (
    <div className="col" style={{ gap: 6 }}>
      <span className="label">묶음</span>
      <div className="seg" role="group" aria-label="묶음">
        <button className="seg-item" type="button" aria-pressed="true">전체</button>
        <button className="seg-item" type="button" aria-pressed="false">묶음 계정</button>
        <button className="seg-item" type="button" aria-pressed="false">나머지</button>
      </div>
    </div>
  );
}

// ── 후보 패널(조사·연구). 합성은 보드의 산점도(CMP-079) 그대로다 ──

function Notice({ source }: { source: Source }) {
  return (
    <div className="banner banner-info">
      <i className="ic ic-info" aria-hidden="true" />
      <div className="banner-body">{sourceSpec(source).notice}</div>
    </div>
  );
}

/** 오른쪽 아래(데스크톱)·패널 쌓기(태블릿)의 후보 패널. 조사는 CMP-083, 연구는 CMP-079 한 축 */
export function CandidatePanel({ source, picked, fallback }: { source: Source; picked: boolean; fallback: boolean }) {
  const s = useSpec(source);
  return (
    <section className="widget" aria-labelledby="fx-cand-h">
      <div className="widget-head">
        <h2 className="t-sm fw-b" id="fx-cand-h">{s.candidateTitle}</h2>
        <div className="actions"><button className="btn btn-text btn-sm" type="button">표로 보기</button></div>
      </div>
      <div className="widget-body">
        {s.candidate === 'baseline' ? <BaselineBody picked={picked} /> : <DistributionBody picked={picked} fallback={fallback} />}
        <Notice source={source} />
        {s.candidate === 'baseline' ? <DeviceGroupsInFile /> : null}
      </div>
    </section>
  );
}

// CMP-083 StepBaselineChart 목업: 행은 묶음 계정(파일 안 번호 #1~#9), 열은 단계 사이 걸린 시간.
// 열마다 가로는 10ms~100초 로그 눈금이고, 띠는 같은 파일의 묶음 밖 여정 1~99 백분위(빗금), 세로 금은 50 백분위, 점은 묶음 계정이다.
const STEPS = ['판매 시작', '대기열 진입', '입장 확정', '첫 홀드', '결제 시도', '판매'] as const;
/** 열마다 [1, 50, 99 백분위](열 안 비율) */
const BANDS: readonly [number, number, number][] = [
  [0.3, 0.55, 0.86],
  [0.12, 0.5, 0.9],
  [0.38, 0.62, 0.88],
  [0.26, 0.54, 0.84],
  [0.2, 0.46, 0.8],
];
/** 계정 #1~#9의 열마다 걸린 시간(열 안 비율) */
const DOTS: readonly (readonly number[])[] = [
  [0.06, 0.41, 0.07, 0.12, 0.38],
  [0.05, 0.63, 0.08, 0.14, 0.44],
  [0.07, 0.36, 0.06, 0.11, 0.52],
  [0.06, 0.55, 0.09, 0.15, 0.35],
  [0.08, 0.47, 0.07, 0.13, 0.48],
  [0.05, 0.71, 0.1, 0.12, 0.41],
  [0.07, 0.29, 0.08, 0.16, 0.57],
  [0.06, 0.52, 0.06, 0.1, 0.39],
  [0.09, 0.44, 0.09, 0.14, 0.46],
];
const COL0 = 30;
const COL_W = 70;
const VB_W = COL0 + 5 * COL_W;
const PAD = 5;
const TOP = 44;
const ROW_H = 26;
const PICK_ROW = 2; // #3
const PICK_COL = 2; // 입장 확정 → 첫 홀드

const colX = (c: number) => COL0 + c * COL_W;
const cellX = (c: number, f: number) => colX(c) + PAD + f * (COL_W - 2 * PAD - 1);

function BaselineBody({ picked }: { picked: boolean }) {
  const bottom = TOP + DOTS.length * ROW_H;
  return (
    <>
      <p className="t-xs muted">
        행은 묶음 계정(파일 안 번호), 열은 판매 시작 → 대기열 진입 → 입장 확정 → 첫 홀드 → 결제 시도 → 판매 단계 사이에 걸린 시간입니다. 칸을 고르면 그 계정이 잡은 좌석이 좌석맵에 표시됩니다
      </p>
      <svg
        className="chart"
        viewBox={`0 0 ${VB_W} ${bottom + 20}`}
        role="img"
        aria-label="단계별 시간 대 정상 기준선. 묶음 계정 9개(#1~#9)는 판매 시작 → 대기열 진입, 입장 확정 → 첫 홀드, 첫 홀드 → 결제 시도에서 묶음 밖 여정의 1 백분위보다 짧게 걸렸고, 대기열 진입 → 입장 확정과 결제 시도 → 판매는 기준선 띠 안에 있습니다."
        style={{ height: 'auto', maxWidth: 520 }}
      >
        <defs>
          <pattern id="fx-bl-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <line x1="0" y1="0" x2="0" y2="6" style={{ stroke: 'var(--text-muted)', strokeWidth: 2, opacity: 0.4 }} />
          </pattern>
        </defs>
        {BANDS.map((_, c) => (
          <g key={`h${c}`}>
            <text className="axis" x={colX(c) + COL_W / 2} y="14" textAnchor="middle" style={{ fontSize: '10.5px' }}>
              {STEPS[c]} →
            </text>
            <text x={colX(c) + COL_W / 2} y="30" textAnchor="middle" style={{ fill: 'var(--text)', fontSize: '11.5px', fontWeight: 700 }}>
              {STEPS[c + 1]}
            </text>
          </g>
        ))}
        {DOTS.map((_, r) => (
          <g key={`r${r}`}>
            <line className="grid" x1={COL0} y1={TOP + r * ROW_H} x2={VB_W} y2={TOP + r * ROW_H} />
            <text x="24" y={TOP + r * ROW_H + 17} textAnchor="end" className="mono" style={{ fill: 'var(--text)', fontSize: '11px' }}>
              #{r + 1}
            </text>
          </g>
        ))}
        <line className="grid" x1={COL0} y1={bottom} x2={VB_W} y2={bottom} />
        {BANDS.map(([p1, p50, p99], c) => (
          <g key={`b${c}`}>
            <rect x={cellX(c, p1)} y={TOP} width={cellX(c, p99) - cellX(c, p1)} height={bottom - TOP} style={{ fill: 'url(#fx-bl-hatch)', stroke: 'var(--border)', strokeWidth: 1 }} />
            <line x1={cellX(c, p50)} y1={TOP} x2={cellX(c, p50)} y2={bottom} style={{ stroke: 'var(--text)', strokeWidth: 1.5 }} />
            {c > 0 ? <line className="grid" x1={colX(c) - 0.6} y1={TOP} x2={colX(c) - 0.6} y2={bottom} /> : null}
          </g>
        ))}
        {picked ? (
          <rect x={colX(PICK_COL) + 1} y={TOP + PICK_ROW * ROW_H + 1} width={COL_W - 2} height={ROW_H - 2} rx="4" style={{ fill: 'var(--primary-subtle)', opacity: 0.55, stroke: 'var(--link)', strokeWidth: 2 }} />
        ) : null}
        {DOTS.map((row, r) =>
          row.map((f, c) => {
            const on = picked && r === PICK_ROW && c === PICK_COL;
            return <circle key={`d${r}-${c}`} cx={cellX(c, f)} cy={TOP + r * ROW_H + ROW_H / 2} r={on ? 6 : 4.5} style={{ fill: 'var(--danger)', stroke: 'var(--surface)', strokeWidth: 1.2 }} />;
          }),
        )}
        <text className="axis" x={cellX(0, 0)} y={bottom + 14} textAnchor="start">10ms</text>
        <text className="axis" x={cellX(0, 1)} y={bottom + 14} textAnchor="end">100초</text>
      </svg>
      <ul className="legend" aria-label="범례: 단계별 시간 대 정상 기준선">
        <li className="legend-item">
          <span aria-hidden="true" style={{ display: 'inline-block', width: 10, height: 10, borderRadius: '50%', background: 'var(--danger)' }} />
          묶음 계정
        </li>
        <li className="legend-item">
          <span aria-hidden="true" style={{ display: 'inline-block', width: 16, height: 12, borderRadius: 2, boxShadow: 'inset 0 0 0 1px var(--border)', background: 'repeating-linear-gradient(45deg, var(--text-muted) 0 1.5px, transparent 1.5px 5px)' }} />
          묶음 밖 여정 1~99 백분위
        </li>
        <li className="legend-item">
          <span aria-hidden="true" style={{ display: 'inline-block', width: 2, height: 12, background: 'var(--text)' }} />
          50 백분위
        </li>
      </ul>
      <p className="t-xs muted">칸마다 가로는 걸린 시간(로그 눈금, 10ms~100초)입니다</p>
      {picked ? (
        <dl className="kv">
          <dt>고른 칸</dt>
          <dd>묶음 계정 #3 · 입장 확정 → 첫 홀드</dd>
          <dt>걸린 시간</dt>
          <dd className="num">42ms</dd>
          <dt>묶음 밖 50 백분위</dt>
          <dd className="num">1.8초</dd>
          <dt>이 계정이 잡은 좌석</dt>
          <dd className="num">3석</dd>
        </dl>
      ) : null}
    </>
  );
}

/** 묶음 안 기기 묶음(파일 안에서만 뜻이 있는 번호, §6.7.1) */
function DeviceGroupsInFile() {
  return (
    <div className="col" style={{ gap: 6 }}>
      <span className="label">묶음 안 기기 묶음(파일 안에서만 뜻이 있는 번호)</span>
      <ul className="col t-sm" style={{ gap: 4, margin: 0, padding: 0, listStyle: 'none' }}>
        <li className="row between">
          <span className="mono">기기 묶음 #1</span>
          <span>계정 4(#1·#2·#5·#7)</span>
        </li>
        <li className="row between">
          <span className="mono">기기 묶음 #2</span>
          <span>계정 3(#3·#4·#8)</span>
        </li>
        <li className="row between">
          <span className="mono">기기 묶음 #3</span>
          <span>계정 2(#6·#9)</span>
        </li>
      </ul>
    </div>
  );
}

// CMP-079 한 축 분포(연구): '입장 확정 → 첫 홀드'(ms, 로그 눈금) 막대. 엔트로피와 기기 묶음은 연구 원천에 없다(§6.3).
/** 10ms~10초를 24칸(10배마다 8칸)으로 나눈 세션 수(그림 높이) */
const BINS = [4, 8, 18, 46, 78, 92, 64, 30, 12, 8, 7, 9, 14, 24, 42, 70, 108, 140, 150, 122, 84, 46, 20, 8];
const AX0 = 44;
const AX1 = 430;
const BASE = 176;
const PICK_TO = 8; // 10ms~100ms(앞 8칸)

function DistributionBody({ picked, fallback }: { picked: boolean; fallback: boolean }) {
  const w = (AX1 - AX0) / BINS.length;
  const ticks: [number, string][] = [
    [AX0, '10ms'],
    [AX0 + w * 8, '100ms'],
    [AX0 + w * 16, '1초'],
    [AX1, '10초'],
  ];
  return (
    <>
      <p className="t-xs muted">
        가로: 입장 확정 → 첫 홀드 시도(로그 눈금) · 세로: 세션 수. 끌어서 구간을 고르면 그 세션들이 잡은 좌석이 좌석맵에 표시됩니다. 구간은 시작·끝 값을 숫자로도 고를 수 있습니다
      </p>
      <svg
        className="chart"
        viewBox="0 0 440 200"
        role="img"
        aria-label="'입장 확정 → 첫 홀드' 분포. 가로는 걸린 시간(로그 눈금), 세로는 세션 수입니다. 대부분의 세션은 1~2초에 모이고, 30~80ms에 따로 모인 작은 무리가 있습니다."
        style={{ height: 'auto' }}
      >
        {ticks.map(([x, label]) => (
          <g key={label}>
            <line className="grid" x1={x} y1="12" x2={x} y2={BASE} />
            <text className="axis" x={x} y={BASE + 18} textAnchor="middle">{label}</text>
          </g>
        ))}
        <line className="grid" x1={AX0} y1={BASE} x2={AX1} y2={BASE} />
        <text className="axis" x={AX0 - 6} y="20" textAnchor="end">세션</text>
        {picked ? (
          <rect x={AX0} y="8" width={w * PICK_TO} height={BASE - 8} style={{ fill: 'var(--primary-subtle)', opacity: 0.45, stroke: 'var(--link)', strokeWidth: 1.5 }} />
        ) : null}
        {BINS.map((h, i) => (
          <rect
            key={i}
            className={picked && i >= PICK_TO ? undefined : 'bar'}
            x={AX0 + i * w + 1}
            y={BASE - h}
            width={w - 2}
            height={h}
            style={picked && i >= PICK_TO ? { fill: 'var(--text-muted)', opacity: 0.5 } : undefined}
          />
        ))}
      </svg>
      {fallback ? (
        <p className="t-xs muted">
          <i className="ic ic-info ic-14" aria-hidden="true" />
          {' '}이 기기는 표본으로 그립니다(2만 점)
        </p>
      ) : null}
      {picked ? (
        <dl className="kv">
          <dt>고른 구간</dt>
          <dd className="num">10ms~100ms</dd>
          <dt>고른 세션</dt>
          <dd className="num">9,412</dd>
        </dl>
      ) : null}
    </>
  );
}

// ── 그릴 것이 없는 상태(받는 중·원천 만료·권한 없음) ──

const centerMain: CSSProperties = { flex: '1', alignItems: 'center', justifyContent: 'center', gap: '10px', padding: '80px 20px', textAlign: 'center' };

/** 받는 중: 진행 막대 "기록 받는 중"(조사 원천 파일·연구 내보내기). 아직 받은 기록이 없어 좌석맵은 그리지 않는다 */
export function ReceivingMain({ source }: { source: Source }) {
  const s = useSpec(source);
  return (
    <main id="main" className="col" style={centerMain}>
      <h1 className="sr-only">{s.title}</h1>
      <div className="card col" role="status" style={{ gap: 10, padding: 20, width: '100%', maxWidth: 420, textAlign: 'left' }}>
        <p className="t-md fw-b">기록 받는 중</p>
        <p className="t-sm num">62%</p>
        <div className="progress" role="progressbar" aria-label="기록 받는 중" aria-valuenow={62} aria-valuemin={0} aria-valuemax={100}>
          <span style={{ width: '62%' }} />
        </div>
        <p className="t-xs muted">
          {source === 'investigation' ? `${s.caseLabel} 조사 원천 리플레이 파일 · ${s.headerNote}` : `연구 내보내기 · ${s.headerNote}`}
        </p>
      </div>
    </main>
  );
}

/** 원천 만료: 아무것도 그리지 않는다(조사는 서버 410 investigation-source-expired, 연구는 실버 보존 90일) */
export function ExpiredMain({ source }: { source: Source }) {
  const s = useSpec(source);
  return (
    <main id="main" className="col" style={centerMain}>
      <span className="state-icon" style={{ width: 56, height: 56 }}><i className="ic ic-history" aria-hidden="true" /></span>
      <h1 className="t-lg">{s.expired}</h1>
      <ConsoleLink path={s.consolePath ?? '/dashboard'} />
    </main>
  );
}

/** 가명처리 적정성 검토 전(연구 내보내기 403 pseudonymization-review-pending, d5 §9.2): 받을 기록이 없어 아무것도 그리지 않는다 */
export function ReviewPendingMain() {
  return (
    <main id="main" className="col" style={centerMain}>
      <span className="state-icon is-warning" style={{ width: 56, height: 56 }}><i className="ic ic-lock" aria-hidden="true" /></span>
      <h1 className="t-lg" style={{ maxWidth: 560 }}>{REVIEW_PENDING_BODY}</h1>
      <ConsoleLink path="/dashboard" />
    </main>
  );
}

/** 권한 없음(지정 없음): 서버 403 investigator-required·pseudonym-handler-required */
export function DenyMain() {
  return (
    <main id="main" className="col" style={centerMain}>
      <span className="state-icon is-danger" style={{ width: 56, height: 56 }}><i className="ic ic-lock" aria-hidden="true" /></span>
      <h1 className="t-xl">{DENY_TITLE}</h1>
      <p className="t-md muted">{DENY_BODY}</p>
      <ConsoleLink path="/dashboard" />
    </main>
  );
}
