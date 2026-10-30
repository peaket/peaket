// 고치는 화면의 회차·재입장 구역(보드 e2 '오픈 뒤 수정 · 회차 재입장'). 판매 시작 뒤에는 구매자에게 불리한 쪽(허용 → 불허)으로 바꿀 수 없다.
import { edit } from '../model/fixtures';

export function EditRounds() {
  const r = edit.round;
  return (
    <div className="grid items-start gap-5 lg:grid-cols-12">
      <section className="card pad-lg col lg:col-span-7" style={{ gap: 16 }} aria-labelledby="h-e-round">
        <div className="section-title">
          <h2 id="h-e-round">회차와 오픈 시각</h2>
          <button className="btn btn-outline btn-sm" type="button" aria-describedby="e-round-add-h">
            <i className="ic ic-plus" aria-hidden="true" />
            회차 더하기
          </button>
        </div>
        <p className="hint" id="e-round-add-h">
          같은 공연장·배치본으로 더합니다. 판매 승인 뒤에 더하면 다시 판매 승인을 받습니다
        </p>
        <div className="col" role="group" aria-labelledby="e-r1" style={{ gap: 14, padding: 16, border: '1px solid var(--border)', borderRadius: 'var(--r-lg)' }}>
          <div className="row between">
            <strong className="t-md" id="e-r1">
              {r.title}
            </strong>
            <span className="badge badge-primary">판매 중</span>
          </div>
          <dl className="kv">
            <dt>오픈 시각</dt>
            <dd>{r.open}</dd>
            <dt>로비 개방</dt>
            <dd>{r.lobby}</dd>
          </dl>
          <div className="grid grid-cols-2 items-start gap-x-4 gap-y-[14px]">
            {[
              ['e-start', '공연 시작(KST)'],
              ['e-entry', '입장 시작(KST)'],
              ['e-end', '공연 종료 예정(KST)'],
            ].map(([id, label]) => (
              <div key={id} className="field">
                <label className="label" htmlFor={id}>
                  {label} <span className="opt">(필수)</span>
                </label>
                <div className="input-group input-group-sm">
                  <i className="ic ic-calendar" aria-hidden="true" />
                  <input id={id} type="text" defaultValue={r.start} />
                </div>
              </div>
            ))}
            <div className="field">
              <span className="label" aria-hidden="true">
                재입장
              </span>
              <label className="check-row" style={{ alignItems: 'center', minHeight: 40, fontSize: 14 }}>
                <input className="sw" type="checkbox" role="switch" defaultChecked disabled aria-describedby="e-re-lock" />
                재입장 허용
              </label>
              <span className="row t-sm fw-m" id="e-re-lock" style={{ gap: 6, alignItems: 'flex-start' }}>
                <i className="ic ic-lock ic-16" aria-hidden="true" />
                구매자에게 불리한 변경은 할 수 없습니다
              </span>
            </div>
          </div>
        </div>
      </section>
      <section className="card pad-lg col lg:col-span-5" style={{ gap: 12 }} aria-labelledby="h-e-reentry">
        <div className="section-title">
          <h2 id="h-e-reentry">회차별 입장 정책</h2>
        </div>
        <ul className="col t-sm" style={{ gap: 10, listStyle: 'disc', paddingLeft: 18 }}>
          <li>재입장 허용 여부는 회차마다 정하고, 판매 조건으로 공연 상세에 공시합니다.</li>
          <li>판매를 시작한 뒤에는 구매자에게 유리한 쪽(불허 → 허용)으로만 바꿀 수 있습니다.</li>
          <li>바꾼 입장 정책은 스캐너 변경분으로 현장에 전달됩니다.</li>
          <li>재입장을 허용한 회차에서만 현장에서 퇴장 모드를 씁니다.</li>
        </ul>
      </section>
    </div>
  );
}
