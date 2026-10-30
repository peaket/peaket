// 퍼널(F3)(SCR-029 판매 중 탭, d5 §7.2 '퍼널·전환'). 보드 SCR-029-d의 w-lfun 마크업.
// 다섯 단계 숫자와 단계 비율은 처리량 급감 경보와 같은 Prometheus 값이고 <잠정>이다(ADR-0071 결정 4).
import { Fragment } from 'react';
import { Judgement, WidgetFrame, type WidgetBaseProps } from './common';

export interface FunnelStep {
  label: string;
  /** 막대 옆 글(예: '1,402 · 28.3%') */
  text: string;
  /** 막대 길이(0~300) */
  width: number;
}

export interface FunnelData {
  steps: FunnelStep[];
  aria: string;
  conversion: { headline: string; detail: string };
}

export interface FunnelWidgetProps extends WidgetBaseProps {
  data: FunnelData;
}

export function FunnelWidget({ data, ...base }: FunnelWidgetProps) {
  return (
    <WidgetFrame
      id="w-lfun"
      title="퍼널(F3)"
      base={base}
      badges={<span className="badge badge-outline">잠정</span>}
      foldMeta={
        <>
          <span className="badge badge-outline">잠정</span>
          <span>{data.conversion.headline}</span>
        </>
      }
    >
      <figure className="col" style={{ gap: 4 }}>
        <figcaption className="row between t-xs">
          <span className="fw-b">입장 → 첫 홀드 성공 → 결제 접수 → 승인 → 발권</span>
          <span className="muted">숫자 · 앞 단계 대비</span>
        </figcaption>
        <svg className="chart" viewBox="0 0 560 136" role="img" aria-label={data.aria}>
          {data.steps.map((s, i) => {
            const y = 6 + i * 27;
            return (
              <Fragment key={s.label}>
                <text className="axis" x="104" y={y + 13} textAnchor="end">
                  {s.label}
                </text>
                <rect className="bar" x="112" y={y} width={s.width} height="18" rx="3" />
                <text className="axis" x={112 + s.width + 8} y={y + 13}>
                  {s.text}
                </text>
              </Fragment>
            );
          })}
        </svg>
      </figure>
      <p className="t-sm">
        <span className="fw-b">{data.conversion.headline}</span> <span className="muted">{data.conversion.detail}</span>
      </p>
      <Judgement>
        잠정 숫자라 운영 명령의 참고로만 씁니다. 판매 정책은 확정 숫자로 바꿉니다(POL-040). 단계 비율이 기준선의 절반 아래로 떨어지면 경보 패널 &apos;이 회차 판단&apos;에 SEV2
        처리량 급감이 뜹니다. RB-33: 막힌 단계 찾기 → 최근 변경이면 되돌리기 → 원인을 모르면 명령 2.
      </Judgement>
    </WidgetFrame>
  );
}
