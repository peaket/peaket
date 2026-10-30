// 결제사(SCR-029 판매 중 탭, d5 §7.2 '결제사별 승인률·승인 호출 p99·결제 확정 소요 p99·한도 사용률·전환 상태'). 보드 SCR-029-d의 w-lpg 마크업.
// 승인 호출은 끊지 않는다(경보 기준 2초, 기술 검토 높음-16). 자동 조치가 걸리면 상태가 '신규 진입 정지(자동)'가 된다(ADR-0078).
import { Judgement, WidgetFrame, type WidgetBaseProps } from './common';

export interface PgStatusData {
  primary: {
    name: string;
    approval: string;
    callP99: string;
    confirmP99: string;
    limitUse: string;
    overLimit: string;
    /** 상태 글. warning이면 배지로 그린다 */
    state: { text: string; warning?: boolean };
  };
  fallback: { name: string; status: string };
}

export interface PgStatusWidgetProps extends WidgetBaseProps {
  data: PgStatusData;
}

export function PgStatusWidget({ data, ...base }: PgStatusWidgetProps) {
  const p = data.primary;
  return (
    <WidgetFrame
      id="w-lpg"
      title="결제사"
      base={base}
      foldMeta={
        <>
          {p.state.warning ? <span className="badge badge-warning">{p.state.text}</span> : <span className="slo slo-ok">정상</span>}
          <span>승인 {p.approval}</span>
        </>
      }
    >
      <div className="col" style={{ gap: 6 }}>
        <h3 className="t-sm fw-b">{p.name}</h3>
        <ul className="col t-xs" style={{ gap: 4 }}>
          <li className="row between" style={{ gap: 8 }}>
            <span className="muted">승인</span>
            <span className="num fw-b">{p.approval}</span>
          </li>
          <li className="col" style={{ gap: 2 }}>
            <div className="row between" style={{ gap: 8 }}>
              <span className="muted">승인 호출 p99</span>
              <span className="num fw-b">{p.callP99}</span>
            </div>
            <span className="muted">경보 기준 2초 · 호출은 끊지 않습니다</span>
          </li>
          <li className="col" style={{ gap: 2 }}>
            <div className="row between" style={{ gap: 8 }}>
              <span className="muted">결제 확정 소요 p99(재시도 포함)</span>
              <span className="num fw-b">{p.confirmP99}</span>
            </div>
            <span className="muted">전환 검토 기준 5초(RB-07)</span>
          </li>
          <li className="row between" style={{ gap: 8 }}>
            <span className="muted">한도 사용률</span>
            <span className="num">{p.limitUse}</span>
          </li>
          <li className="row between" style={{ gap: 8 }}>
            <span className="muted">한도 초과 응답</span>
            <span className="num">{p.overLimit}</span>
          </li>
          <li className="row between" style={{ gap: 8 }}>
            <span className="muted">상태</span>
            {p.state.warning ? <span className="badge badge-warning">{p.state.text}</span> : <span>{p.state.text}</span>}
          </li>
        </ul>
      </div>
      <div className="divider" />
      <div className="row between" style={{ gap: 8 }}>
        <h3 className="t-sm fw-b">{data.fallback.name}</h3>
        <span className="slo slo-stale">{data.fallback.status}</span>
      </div>
      <Judgement>
        임박 원인이 울리면 결제사 상태를 보고 필요하면 명령 1을 씁니다. 결제 확정 소요 p99가 5초를 넘거나 서킷이 열리면 RB-07: 명령 6(결제사 전환, 2인). 한도에 가까우면 명령
        1을 씁니다.
      </Judgement>
    </WidgetFrame>
  );
}
