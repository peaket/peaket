// 원천을 못 읽은 위젯(값 error source-unavailable): 보드 SCR-029-d의 w-verify '받지 못함' 카드 마크업. 다른 위젯은 그대로 그린다.
export function Unavailable({ title, detailHref, at }: { title: string; detailHref: string; at: string }) {
  const kst = new Date(at).toLocaleTimeString('ko-KR', { timeZone: 'Asia/Seoul', hour12: false });
  return (
    <section className="widget is-error" role="region" aria-label={title}>
      <div className="widget-head wrap">
        <h2 className="t-sm fw-b">{title}</h2>
        <div className="actions" style={{ gap: 12 }}>
          <span className="slo slo-stale">받지 못함</span>
          <a className="link-more" href={detailHref} target="_blank" rel="noreferrer" aria-label={`${title} 자세히 보기, Grafana 새 탭`}>
            자세히 보기
            <i className="ic ic-external" aria-hidden="true" />
          </a>
        </div>
      </div>
      <div className="widget-body grow" style={{ alignItems: 'flex-start', gap: 8 }}>
        <div className="col" role="alert" style={{ alignItems: 'flex-start', gap: 8 }}>
          <strong className="t-sm">지표 원천을 읽지 못했습니다</strong>
          <p className="t-xs muted">일시적인 오류입니다. 다른 위젯은 그대로 갱신됩니다. 마지막 시도 {kst} KST</p>
        </div>
      </div>
    </section>
  );
}

/** 첫 값을 받기 전(위젯 조회 응답 전) */
export function Loading({ title }: { title: string }) {
  return (
    <section className="widget" role="region" aria-label={title} aria-busy="true">
      <div className="widget-head">
        <h2 className="t-sm fw-b">{title}</h2>
      </div>
      <div className="widget-body grow" style={{ gap: 10 }}>
        <span className="sr-only">불러오는 중</span>
        <span className="skel" style={{ height: 14, width: '40%' }} />
        <span className="skel" style={{ height: 34, width: '55%' }} />
        <span className="skel" style={{ height: 14, width: '80%' }} />
      </div>
    </section>
  );
}
