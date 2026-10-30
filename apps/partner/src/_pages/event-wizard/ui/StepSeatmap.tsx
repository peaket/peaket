// 3단계 좌석맵(d5 §6.4 '3단계 ( 좌석맵 에디터 열기 › ) → SCR-022 · 공연장 템플릿 ▾'). 캔버스 보드에는 이 단계 그림이 없어 d5 줄로 그렸다(추천안).
// 편집은 좌석맵 에디터(SCR-022)에서 하고, 여기서는 요약과 바로가기만 둔다.
import Link from 'next/link';
import { venues } from '@/entities/venue';
import { routes } from '@/shared/config/routes';
import { summary } from '../model/fixtures';

export function StepSeatmap({ eventId }: { eventId: string }) {
  return (
    <div className="grid items-start gap-5 lg:grid-cols-12">
      <section className="card pad-lg col lg:col-span-7" style={{ gap: 16 }} aria-labelledby="h-seat">
        <div className="section-title">
          <h2 id="h-seat">좌석맵</h2>
          <span className="badge badge-success">
            <i className="ic ic-check" aria-hidden="true" />
            휠체어석 수량 기준 충족
          </span>
        </div>
        <p className="t-sm muted">구역 도형을 그리고 좌석을 채우는 일은 좌석맵 에디터에서 합니다. 저장하면 이 요약이 바뀝니다.</p>
        <dl className="kv">
          {summary.seatmap.map(([k, v]) => (
            <div key={k} className="contents">
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
        <Link className="btn btn-primary" href={routes.eventTab(eventId, 'seatmap')} style={{ alignSelf: 'flex-start' }}>
          <i className="ic ic-seat" aria-hidden="true" />
          좌석맵 에디터 열기
        </Link>
      </section>
      <section className="card pad-lg col lg:col-span-5" style={{ gap: 14 }} aria-labelledby="h-seat-tpl">
        <div className="section-title">
          <h2 id="h-seat-tpl">공연장 배치본</h2>
        </div>
        <div className="field">
          <label className="label" htmlFor="w-layout">
            공연장 템플릿
          </label>
          <div className="input-group input-group-sm">
            <select id="w-layout" defaultValue={venues[0]?.layoutName} aria-describedby="w-layout-h">
              {venues.map((v) => (
                <option key={v.id}>{v.layoutName}</option>
              ))}
            </select>
            <i className="ic ic-chevron-down" aria-hidden="true" />
          </div>
          <span className="hint" id="w-layout-h">
            1단계에서 고른 공연장의 배치본입니다. 템플릿은 흔한 공연장 모양을 본뜬 출발점이니 공연장 좌석 배치도와 같게 고친 뒤 판매 승인을 요청하세요.
          </span>
        </div>
      </section>
    </div>
  );
}
