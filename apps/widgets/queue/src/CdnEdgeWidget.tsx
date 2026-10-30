// 상태 조회량·CDN·엣지(SCR-029 T=0 탭, d5 §7.2 '상태 조회량·CDN 적중률·배포별 한도'). 보드 SCR-029-d의 w-cdn 마크업.
import { Fragment } from 'react';
import { Judgement, Progress, WidgetFrame, type WidgetBaseProps } from './common';

export interface CdnEdgeData {
  status: { text: string; ok: boolean };
  hitRate: string;
  /** 상태 조회량(초당). 단위 '/초'는 위젯이 붙인다 */
  statusQps: string;
  rows: { label: string; value: string; num?: boolean }[];
  /** 배포별 한도 사용률(0~100) */
  limits: { label: string; pct: number }[];
}

export interface CdnEdgeWidgetProps extends WidgetBaseProps {
  data: CdnEdgeData;
}

export function CdnEdgeWidget({ data, ...base }: CdnEdgeWidgetProps) {
  const statusEl = <span className={data.status.ok ? 'slo slo-ok' : 'slo slo-burning'}>{data.status.text}</span>;
  return (
    <WidgetFrame
      id="w-cdn"
      title="상태 조회량·CDN·엣지"
      base={base}
      wrapHead
      actions={statusEl}
      foldMeta={
        <>
          {statusEl}
          <span>적중률 {data.hitRate}</span>
        </>
      }
    >
      <div className="row" style={{ gap: 16, alignItems: 'flex-start' }}>
        <div className="col" style={{ gap: 2 }}>
          <span className="stat-label">엣지 캐시 적중률</span>
          <span className="stat-value">{data.hitRate}</span>
        </div>
        <div className="col" style={{ gap: 2 }}>
          <span className="stat-label">상태 조회량</span>
          <span className="stat-value">
            {data.statusQps}
            <span className="t-sm muted fw-m">/초</span>
          </span>
        </div>
      </div>
      <ul className="col t-xs" style={{ gap: 6 }}>
        {data.rows.map((r) => (
          <li key={r.label} className="row between">
            <span className="muted">{r.label}</span>
            <span className={r.num ? 'num' : undefined}>{r.value}</span>
          </li>
        ))}
      </ul>
      <div className="divider" />
      <span className="eyebrow">배포별 한도 사용률 · 80% [가정] 넘으면 SEV3</span>
      <div className="col" style={{ gap: 8 }}>
        {data.limits.map((l) => (
          <Fragment key={l.label}>
            <div className="col" style={{ gap: 3 }}>
              <div className="row between t-xs">
                <span>{l.label}</span>
                <span className="num">{l.pct}%</span>
              </div>
              <Progress label={`${l.label} 배포 한도 사용률 ${l.pct}%`} pct={l.pct} tone={l.pct > 80 ? 'warning' : undefined} />
            </div>
          </Fragment>
        ))}
      </div>
      <Judgement>
        대기열 CDN 캐시 오류율 1% 초과가 1분 이어지면 RB-04(원본 오류 요청은 S3 사본으로 자동으로 넘기고, 사본으로 고정하려면 명령 6). 적중률이 떨어지면 엔지니어를 부릅니다.
        배포별 한도 사용률이 80%를 넘으면 SEV3 경고입니다(다음 회차 전 한도 상향 요청의 근거로 남깁니다).
      </Judgement>
    </WidgetFrame>
  );
}
