// 결제 확정·남은 허용 실패(SCR-029 T=0 탭, d5 §7.2 '남은 허용 실패'). 보드 SCR-029-d의 w-pay 마크업.
import { Fragment } from 'react';
import { Judgement, Progress, WidgetFrame, type WidgetBaseProps } from './common';

export interface JourneyBudget {
  /** '결제 확정 12건 중 3건 사용' */
  label: string;
  /** '남음 9건' */
  remain: string;
  /** 사용 비율(0~100) */
  pct: number;
  /** 소진 중이면 burning(막대·글자 warning) */
  burning?: boolean;
  /** 판단에 먼저 보는 여정은 굵게 */
  strong?: boolean;
  /** 화면 낭독기용 여정 이름 */
  name: string;
}

export interface PaymentBudgetData {
  successRate: string;
  ok: boolean;
  status: string;
  meta: string;
  journeys: JourneyBudget[];
}

export interface PaymentBudgetWidgetProps extends WidgetBaseProps {
  data: PaymentBudgetData;
}

export function PaymentBudgetWidget({ data, ...base }: PaymentBudgetWidgetProps) {
  return (
    <WidgetFrame
      id="w-pay"
      title="결제 확정·남은 허용 실패"
      base={base}
      wrapHead
      foldMeta={
        <>
          <span className={data.ok ? 'slo slo-ok' : 'slo slo-burning'}>{data.ok ? '정상' : '주의'}</span>
          <span>성공률 {data.successRate}</span>
        </>
      }
    >
      <div className="stat">
        <span className="stat-label">결제 확정 성공률</span>
        <span className="stat-value">{data.successRate}</span>
        <span className={data.ok ? 'slo slo-ok' : 'slo slo-burning'}>{data.status}</span>
        <span className="stat-meta">{data.meta}</span>
      </div>
      <h3 className="eyebrow">여정별 남은 허용 실패(온세일 70분 예산)</h3>
      <ul className="col" style={{ gap: 9 }}>
        {data.journeys.map((j) => (
          <Fragment key={j.name}>
            <li className="col" style={{ gap: 4 }}>
              <div className="row between t-xs">
                <span className={j.strong ? 'fw-b' : undefined}>{j.label}</span>
                <span className={j.burning ? 'slo slo-burning' : 'slo slo-ok'}>{j.remain}</span>
              </div>
              <Progress label={`${j.name} 허용 실패 ${j.pct}% 사용`} pct={j.pct} tone={j.burning ? 'warning' : undefined} />
            </li>
          </Fragment>
        ))}
      </ul>
      <Judgement>
        결제사 원인(임박)이 울리면 결제사 상태를 보고 필요하면 명령 1을 씁니다. 결제 확정 소요 p99가 5초를 넘거나 서킷이 열리면 RB-07: 명령 6(결제사 전환, 2인).
      </Judgement>
    </WidgetFrame>
  );
}
