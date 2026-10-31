// CMP-080 LinkGraph 목업 그림(d2 CMP-080, d5 §7.19 ②). 실제 배치 엔진·대량 점 그리기는 데이터 연결 단계의 몫이고(design.md 결정 5),
// 여기서는 계정을 바깥 원에, 연결 값(기기·결제 수단·연락처·IP·ASN)을 안쪽 원에 고정 좌표로 놓은 SVG다.
// - 점은 종류마다 모양과 색을 함께 달리한다(색만으로 가르지 않는다, WCAG 1.4.1). 묶음 밖 계정은 점선 테두리다.
// - 표시값은 서버가 준 것만: 가명은 앞 8글자, IP는 가린 값(IPv4 /24, IPv6 /48). 원문 IP는 그리지 않는다(authz-matrix §4.3 5).
// - 그림은 role="img"와 요약 문장을 갖고, 같은 내용을 [표로 보기] 표로 준다. 점 고르기는 표의 행 단추로도 된다.
import { useId } from 'react';
import { NODE_KIND_LABEL, type CaseGraph, type GraphNode, type GraphNodeKind } from '@/entities/fraud-case';

const COLOR: Record<GraphNodeKind, string> = {
  ACCOUNT: 'var(--link)',
  DEVICE: 'var(--warning)',
  PAYMENT_METHOD: 'var(--danger)',
  CONTACT: 'var(--success)',
  IP: 'var(--primary)',
  ASN: 'var(--text-muted)',
};


function Shape({ kind, x, y, selected, dashed }: { kind: GraphNodeKind; x: number; y: number; selected: boolean; dashed: boolean }) {
  const stroke = selected ? 'var(--text)' : 'var(--surface)';
  const sw = selected ? 3 : 1.5;
  const common = { fill: COLOR[kind], stroke, strokeWidth: sw, strokeDasharray: dashed ? '3 2' : undefined };
  switch (kind) {
    case 'ACCOUNT':
      return <circle cx={x} cy={y} r={11} {...common} fill={dashed ? 'var(--surface)' : COLOR.ACCOUNT} stroke={dashed ? COLOR.ACCOUNT : stroke} strokeWidth={dashed ? 2 : sw} />;
    case 'DEVICE':
      return <rect x={x - 11} y={y - 11} width={22} height={22} rx={3} {...common} />;
    case 'PAYMENT_METHOD':
      return <polygon points={`${x},${y - 14} ${x + 14},${y} ${x},${y + 14} ${x - 14},${y}`} {...common} />;
    case 'CONTACT':
      return <polygon points={`${x},${y - 13} ${x + 13},${y + 10} ${x - 13},${y + 10}`} {...common} />;
    case 'IP': {
      const r = 13;
      const pts = Array.from({ length: 6 }, (_, i) => {
        const a = (Math.PI / 3) * i + Math.PI / 6;
        return `${(x + r * Math.cos(a)).toFixed(1)},${(y + r * Math.sin(a)).toFixed(1)}`;
      }).join(' ');
      return <polygon points={pts} {...common} />;
    }
    case 'ASN':
      return <rect x={x - 22} y={y - 9} width={44} height={18} rx={9} {...common} />;
  }
}

/** 범례의 작은 모양(그림과 같은 모양·색). 장식이라 aria-hidden이고, 옆에 종류 글자가 있다 */
export function LegendShape({ kind, dashed = false }: { kind: GraphNodeKind; dashed?: boolean }) {
  return (
    <svg width={18} height={18} viewBox="-14 -14 28 28" aria-hidden="true" style={{ flex: 'none' }}>
      <g transform={kind === 'ASN' ? 'scale(0.55)' : 'scale(0.9)'}>
        <Shape kind={kind} x={0} y={0} selected={false} dashed={dashed} />
      </g>
    </svg>
  );
}

export interface LinkGraphProps {
  graph: CaseGraph;
  selectedId: string | null;
  onSelect(id: string): void;
  /** 그림 높이(태블릿은 조금 낮춘다) */
  height?: number;
}

/** 점 좌표: 계정은 바깥 원, 연결 값은 안쪽 원. 묶음 밖 계정은 오른쪽 위 바깥에 둔다 */
function layout(graph: CaseGraph, w: number, h: number) {
  const cx = w / 2;
  const cy = h / 2;
  const accounts = graph.nodes.filter((n) => n.kind === 'ACCOUNT' && n.inCluster !== false);
  const outside = graph.nodes.filter((n) => n.kind === 'ACCOUNT' && n.inCluster === false);
  const values = graph.nodes.filter((n) => n.kind !== 'ACCOUNT');
  const pos = new Map<string, { x: number; y: number }>();
  const ro = Math.min(w, h) / 2 - 34;
  accounts.forEach((n, i) => {
    const a = -Math.PI / 2 + (2 * Math.PI * i) / Math.max(accounts.length, 1);
    pos.set(n.nodeId, { x: cx + ro * 1.35 * Math.cos(a), y: cy + ro * Math.sin(a) });
  });
  const ri = values.length > 1 ? ro * 0.45 : 0;
  values.forEach((n, i) => {
    const a = -Math.PI / 2 + Math.PI / values.length + (2 * Math.PI * i) / Math.max(values.length, 1);
    pos.set(n.nodeId, { x: cx + ri * 1.5 * Math.cos(a), y: cy + ri * Math.sin(a) });
  });
  outside.forEach((n, i) => pos.set(n.nodeId, { x: w - 30, y: 30 + i * 36 }));
  return pos;
}

export function LinkGraph({ graph, selectedId, onSelect, height = 380 }: LinkGraphProps) {
  const uid = useId();
  const w = 640;
  const h = height;
  const pos = layout(graph, w, h);
  const accounts = graph.nodes.filter((n) => n.kind === 'ACCOUNT');
  const kinds = new Set(graph.nodes.filter((n) => n.kind !== 'ACCOUNT').map((n) => NODE_KIND_LABEL[n.kind]));
  const summary = `계정 ${accounts.filter((a) => a.inCluster !== false).length}개(묶음 밖 ${accounts.filter((a) => a.inCluster === false).length}개)가 ${[...kinds].join('·')} 연결 값에 이어진 그림입니다. 같은 내용을 표로 보기에서 볼 수 있습니다.`;
  return (
    <svg className="chart" viewBox={`0 0 ${w} ${h}`} role="img" aria-labelledby={`${uid}-t ${uid}-d`} style={{ height: 'auto', maxHeight: h }}>
      <title id={`${uid}-t`}>연결 그래프</title>
      <desc id={`${uid}-d`}>{summary}</desc>
      {graph.edges.map((e, i) => {
        const a = pos.get(e.from);
        const b = pos.get(e.to);
        if (!a || !b) return null;
        const on = selectedId === e.from || selectedId === e.to;
        return (
          <line
            key={i}
            x1={a.x}
            y1={a.y}
            x2={b.x}
            y2={b.y}
            stroke={on ? 'var(--text)' : 'var(--border)'}
            strokeWidth={on ? 2 : Math.min(1 + e.count * 0.4, 2.4)}
            strokeDasharray={e.kind === 'IDENTITY_CONFLICT' || e.kind === 'IP' || e.kind === 'ASN' ? '4 3' : undefined}
          />
        );
      })}
      {graph.nodes.map((n) => {
        const p = pos.get(n.nodeId);
        if (!p) return null;
        return (
          <g key={n.nodeId} onClick={() => onSelect(n.nodeId)} style={{ cursor: 'pointer' }} aria-hidden="true">
            <Shape kind={n.kind} x={p.x} y={p.y} selected={selectedId === n.nodeId} dashed={n.kind === 'ACCOUNT' && n.inCluster === false} />
            <text className="axis" x={p.x} y={p.y + (n.kind === 'ACCOUNT' ? 25 : 28)} textAnchor="middle" style={{ fill: 'var(--text)' }}>
              {n.label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

/** 표로 보기(CMP-080 table, 휴대폰은 그림 대신 이것만) */
export function LinkTable({ graph, selectedId, onSelect, interactive }: LinkGraphProps & { interactive: boolean }) {
  // 묶음 안 계정 → 묶음 밖 계정 → 연결 값 차례. 계정 행도 고를 수 있어야 키보드·화면 낭독기로 [묶음에서 빼기]에 닿는다
  const rank = (n: GraphNode) => (n.kind !== 'ACCOUNT' ? 2 : n.inCluster === false ? 1 : 0);
  const values = [...graph.nodes].sort((a, b) => rank(a) - rank(b));
  const linked = (n: GraphNode) => graph.edges.filter((e) => e.from === n.nodeId || e.to === n.nodeId).length;
  return (
    <div className="table-wrap table-scroll">
      <table className="table" style={{ minWidth: interactive ? 520 : 0 }}>
        <caption className="sr-only">계정과 연결 값, 이어진 점의 수. IP는 가린 값입니다</caption>
        <thead>
          <tr>
            <th scope="col">종류</th>
            <th scope="col">표시값</th>
            <th scope="col" className="num">
              이어진 점
            </th>
            {interactive ? <th scope="col">고르기</th> : null}
          </tr>
        </thead>
        <tbody>
          {values.map((n) => (
            <tr key={n.nodeId} aria-selected={selectedId === n.nodeId || undefined}>
              <td className="t-sm nowrap">
                <span style={{ display: 'inline-flex', verticalAlign: 'middle', marginRight: 4 }}>
                  <LegendShape kind={n.kind} dashed={n.kind === 'ACCOUNT' && n.inCluster === false} />
                </span>
                {n.kind === 'ACCOUNT' ? (n.inCluster === false ? '묶음 밖 계정' : '계정') : NODE_KIND_LABEL[n.kind]}
              </td>
              <td className="mono t-xs">{n.label}</td>
              <td className="num">{linked(n)}</td>
              {interactive ? (
                <td>
                  <button className="btn btn-text btn-sm" type="button" aria-pressed={selectedId === n.nodeId} onClick={() => onSelect(n.nodeId)}>
                    {n.label} 고르기
                  </button>
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
