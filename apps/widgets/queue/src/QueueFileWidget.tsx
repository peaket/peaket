// 대기 상태 파일 신선도·셔플 게시(SCR-029 T=0 탭, d5 §7.2 '셔플·결과 파일 게시'). 보드 SCR-029-d의 w-file 마크업.
import { Judgement, TableToggle, WidgetFrame, type WidgetBaseProps } from './common';

export interface QueueFileData {
  /** 신선도 p99(serving 갱신 → 엣지 반영) */
  p99: string;
  ok: boolean;
  status: string;
  meta: string;
  chart: { aria: string; points: string; nowX: number; ticks: { x: number; label: string }[] };
  steps: { label: string; value: string; state: 'ok' | 'burning' | 'muted' }[];
}

export interface QueueFileWidgetProps extends WidgetBaseProps {
  data: QueueFileData;
}

const TITLE = '대기 상태 파일 신선도·셔플 게시';

export function QueueFileWidget({ data, ...base }: QueueFileWidgetProps) {
  return (
    <WidgetFrame
      id="w-file"
      title={TITLE}
      base={base}
      wrapHead
      actions={<TableToggle />}
      foldMeta={
        <>
          <span className={data.ok ? 'slo slo-ok' : 'slo slo-burning'}>{data.ok ? '정상' : '주의'}</span>
          <span>신선도 p99 {data.p99}</span>
        </>
      }
    >
      <div className="stat">
        <span className="stat-label">신선도 p99(serving 갱신 → 엣지 반영)</span>
        <span className="stat-value">{data.p99}</span>
        <span className={data.ok ? 'slo slo-ok' : 'slo slo-burning'}>{data.status}</span>
        <span className="stat-meta">{data.meta}</span>
      </div>
      <svg className="chart" viewBox="0 0 260 72" role="img" aria-label={data.chart.aria}>
        <line className="grid" x1="28" y1="50" x2="252" y2="50" />
        <line className="slo-line" x1="28" y1="14.8" x2="252" y2="14.8" />
        <text className="axis" x="248" y="11" textAnchor="end">
          기준 2초
        </text>
        <text className="axis" x="22" y="53" textAnchor="end">
          0
        </text>
        <polyline className="line" points={data.chart.points} />
        <line className="now" x1={data.chart.nowX} y1="3" x2={data.chart.nowX} y2="52" />
        {data.chart.ticks.map((t) => (
          <text key={t.label} className="axis" x={t.x} y="67" textAnchor="middle">
            {t.label}
          </text>
        ))}
      </svg>
      <ul className="col t-xs" style={{ gap: 6 }}>
        {data.steps.map((s) => (
          <li key={s.label} className="row between">
            <span className={s.state === 'muted' ? 'muted' : undefined}>{s.label}</span>
            <span className={s.state === 'muted' ? 'muted' : s.state === 'ok' ? 'slo slo-ok' : 'slo slo-burning'}>{s.value}</span>
          </li>
        ))}
      </ul>
      <Judgement>
        게시가 실패하거나 늦으면 엔지니어를 부릅니다(결과 파일은 S3 대체 원본으로 다시 게시). 비콘 대기가 60초를 넘어 셔플이 멈추면 SEV1과 RB-35(비상 셔플은 commander 두 명의
        서명)
      </Judgement>
    </WidgetFrame>
  );
}
