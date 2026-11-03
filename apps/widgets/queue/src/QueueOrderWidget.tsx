// 대기 순서(SCR-029 판매 중 탭, d5 §7.2 '대기 순서'). 보드 SCR-029-d의 w-lord 마크업.
// 차례 전 입장은 0건이어야 하는 불변식이다(1건이면 SEV1, RB-36).
import { Judgement, WidgetFrame, type WidgetBaseProps } from './common';

export interface QueueOrderData {
  beforeTurn: string;
  failedAfterTurn: string;
  etaError: string;
}

export interface QueueOrderWidgetProps extends WidgetBaseProps {
  data: QueueOrderData;
}

export function QueueOrderWidget({ data, ...base }: QueueOrderWidgetProps) {
  return (
    <WidgetFrame id="w-lord" title="대기 순서" base={base} foldMeta={<span>차례 전 입장 {data.beforeTurn}</span>}>
      <div className="col" style={{ gap: 2 }}>
        <span className="stat-label">차례 전 입장</span>
        <span className="stat-value">{data.beforeTurn}</span>
        <span className="stat-meta">0건이어야 하는 불변식입니다</span>
      </div>
      <ul className="col t-xs" style={{ gap: 4 }}>
        <li className="row between" style={{ gap: 8 }}>
          <span className="muted">차례가 온 뒤 시스템 원인으로 못 들어간 사람</span>
          <span className="num">{data.failedAfterTurn}</span>
        </li>
        <li className="row between" style={{ gap: 8 }}>
          <span className="muted">예상 대기 오차 중앙값</span>
          <span className="num">{data.etaError}</span>
        </li>
      </ul>
      <Judgement>차례 전 입장이 1건이면 SEV1입니다(불변식, RB-36). 명령 2를 검토하고 엔지니어를 부릅니다.</Judgement>
    </WidgetFrame>
  );
}
