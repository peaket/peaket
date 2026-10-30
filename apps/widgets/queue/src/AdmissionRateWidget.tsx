// 입장 비율·빈자리(SCR-029 판매 중 탭, d5 §7.2, ADR-0104). 보드 SCR-029-d의 w-lrate 마크업.
// 제어 숫자라 <잠정> 표시가 없다(자동 제어와 같은 Prometheus 값).
import { Judgement, WidgetFrame, type WidgetBaseProps } from './common';

export interface AdmissionRateData {
  /** 입장 비율(불린 번호 가운데 입장 확정을 요청한 비율) */
  rate: string;
  vacancy: { value: string; meta: string };
  coming: string;
  soon: string;
  soonP99: string;
  /** 위젯 안 식 한 줄(예: serving 증가 = …) */
  formula: string;
}

export interface AdmissionRateWidgetProps extends WidgetBaseProps {
  data: AdmissionRateData;
}

export function AdmissionRateWidget({ data, ...base }: AdmissionRateWidgetProps) {
  return (
    <WidgetFrame
      id="w-lrate"
      title="입장 비율·빈자리"
      base={base}
      foldMeta={
        <span>
          입장 비율 {data.rate} · 빈자리 {data.vacancy.value}
        </span>
      }
    >
      <div className="col" style={{ gap: 2 }}>
        <span className="stat-label">입장 비율</span>
        <span className="stat-value">{data.rate}</span>
        <span className="stat-meta">불린 번호 가운데 입장 확정을 요청한 비율(불린 지 10~60초인 전진)</span>
      </div>
      <div className="divider" />
      <div className="col" style={{ gap: 2 }}>
        <span className="stat-label">빈자리(입장 자리)</span>
        <span className="stat-value">{data.vacancy.value}</span>
        <span className="stat-meta">{data.vacancy.meta}</span>
      </div>
      <ul className="col t-xs" style={{ gap: 4 }}>
        <li className="row between" style={{ gap: 8 }}>
          <span className="muted">오는 중(불렀지만 아직 입장 확정 전)</span>
          <span className="num">{data.coming}</span>
        </li>
        <li className="row between" style={{ gap: 8 }}>
          <span className="muted">곧 입장 대기</span>
          <span className="num">{data.soon}</span>
        </li>
        <li className="row between" style={{ gap: 8 }}>
          <span className="muted">곧 입장 대기 p99(처음 SOON → 입장 확정)</span>
          <span className="num">{data.soonP99}</span>
        </li>
      </ul>
      <p className="t-xs muted">{data.formula}</p>
      <Judgement>빈자리가 줄면 입장 속도가 자동으로 줄어듭니다(명령 없음).</Judgement>
    </WidgetFrame>
  );
}
