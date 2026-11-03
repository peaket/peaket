// '자동 조치 최근 풀림'(d5 §7.2 상태 표): 걸린 것은 없고 10분 [가정] 안에 풀린 줄만 흐리게 남은 '걸린 자동 조치' 위젯.
// 줄 마크업은 보드 SCR-029-d '자동 조치 걸림'의 최근 풀림 줄 그대로다. 위 상태 바 '자동 조치 n'은 최근 풀림을 세지 않아 보이지 않는다.
export function RecentReleased() {
  return (
    <section className="widget" role="region" id="w-auto" aria-labelledby="w-auto-rh" style={{ gridColumn: '1/-1' }}>
      <div className="widget-head">
        <h2 className="t-sm fw-b" id="w-auto-rh">
          걸린 자동 조치
        </h2>
        <span className="badge">걸림 0</span>
        <span className="badge">최근 풀림 1</span>
        <div className="actions">
          <span className="t-xs muted">15초 전 갱신</span>
        </div>
      </div>
      <div className="widget-body">
        <div className="col" role="group" aria-labelledby="w-auto-rev" style={{ gap: 6 }}>
          <h3 className="eyebrow" id="w-auto-rev">
            이 회차 · LUMEN 10/25 18:00
          </h3>
          <ul className="col" style={{ gap: 6 }}>
            <li
              className="row wrap"
              style={{ gap: '4px 8px', padding: '8px 10px', borderRadius: 6, boxShadow: 'inset 0 0 0 1px var(--border)', opacity: 0.75 }}
            >
              <span className="badge badge-success">최근 풀림</span>
              <span className="t-sm">결제 신규 진입 정지 · 토스페이먼츠</span>
              <span className="t-xs muted">
                <span className="num">20:06:12 KST</span> 자동으로 풀림(시험 결제 20건이 기준을 넘음) · 10분 뒤 지웁니다
              </span>
            </li>
          </ul>
        </div>
        <p className="t-xs" style={{ marginTop: 'auto', paddingTop: 8, borderTop: '1px solid var(--border)' }}>
          <span className="fw-b">판단:</span> 걸린 것도 최근 풀린 것도 없으면 이 위젯은 사라집니다.
        </p>
      </div>
    </section>
  );
}
