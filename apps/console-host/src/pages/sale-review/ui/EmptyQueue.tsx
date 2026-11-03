// SCR-048 '빈 화면'(d5 §7.9 상태 표: "승인 대기 공연이 없습니다", 0건). 보드에 없는 상태라 보드의 머리와 키트 빈 상태 모양으로 그린다.
export function EmptyQueue() {
  return (
    <>
      <div className="page-head">
        <div className="col" style={{ gap: 4 }}>
          <h1>판매 승인</h1>
          <p className="t-sm muted">파트너가 등록한 공연을 확인 항목 6가지로 점검해 공개를 허락합니다. 승인을 받은 공연만 공개하고 오픈을 예약할 수 있습니다.</p>
        </div>
      </div>
      <section className="widget" aria-label="판매 승인 목록">
        <div className="state" role="status" style={{ padding: '64px 16px', gap: 12 }}>
          <span className="state-icon">
            <i className="ic ic-check-circle" aria-hidden="true" />
          </span>
          <h2 className="t-lg">승인 대기 공연이 없습니다</h2>
        </div>
      </section>
    </>
  );
}
