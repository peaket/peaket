// 2단계 회차·가격·입장 정책(보드 SCR-021-t·xl s2 '오픈 시각 오류'). lg 보드는 없어 lg는 7+5열, xl은 보드대로 2칸+1칸으로 둔다.
// 오류 종류: 정비 시간(POL-041, 보드) · 오픈 간격 충돌(POL-030, d5 §6.4 상태 표에서 더함). 2회차는 대형 간격 경고(저장은 된다)를 보인다.
import { ReorderList } from '@peaket/ds/ReorderList';
import { draftRounds, tiers } from '../model/fixtures';

const OPEN_ERROR = {
  maintenance: { value: '10/14(수) 04:00', text: '수요일 03:00~06:30에는 오픈할 수 없습니다' },
  gap: { value: '10/14(수) 20:03', text: '다른 공연과 5분 이상 떨어져야 합니다(가능: 20:05)' },
} as const;

export function StepRounds({ openError }: { openError: 'maintenance' | 'gap' | null }) {
  const err = openError ? OPEN_ERROR[openError] : null;
  return (
    <div className="col" style={{ gap: 16 }}>
      {err ? (
        <div className="error-summary" role="alert" aria-labelledby="x-err-t">
          <strong className="row" id="x-err-t" style={{ gap: 6 }}>
            <i className="ic ic-alert-circle tx-danger" aria-hidden="true" />
            오픈 시각 1건을 고쳐야 다음 단계로 갈 수 있습니다
          </strong>
          <a href="#x-open1">1회차 오픈 시각: {err.text}</a>
        </div>
      ) : null}

      <div className="grid items-start gap-5 lg:grid-cols-12 xl:grid-cols-3 xl:gap-6">
        <section className="card pad-lg col lg:col-span-7 xl:col-span-2" style={{ gap: 16 }} aria-labelledby="x-h-round">
          <div className="section-title">
            <h2 id="x-h-round">회차와 오픈 시각</h2>
            <button className="btn btn-outline btn-sm" type="button" aria-describedby="x-round-add-h">
              <i className="ic ic-plus" aria-hidden="true" />
              회차 더하기
            </button>
          </div>
          <p className="hint" id="x-round-add-h">
            같은 공연장·배치본으로 더합니다. 판매 승인 뒤에 더하면 다시 판매 승인을 받습니다
          </p>
          <p className="hint">
            오픈 시각은 다른 공연과 5분 이상 떨어져야 하고 수요일 03:00~06:30에는 오픈할 수 없습니다(POL-030·041). 대형 공연끼리의 30분 간격은 판매 승인에서 규모를 정할 때
            검사합니다.
          </p>

          {draftRounds.map((r) => {
            const isFirst = r.no === 1;
            const openErr = isFirst ? err : null;
            return (
              <div
                key={r.no}
                className="col"
                role="group"
                aria-labelledby={`x-r${r.no}`}
                style={{ gap: 14, padding: 16, border: '1px solid var(--border)', borderRadius: 'var(--r-lg)' }}
              >
                <div className="row between">
                  <strong className="t-md" id={`x-r${r.no}`}>
                    {r.no}회차 · {r.title}
                  </strong>
                  <button className="icon-btn" type="button" aria-label={`${r.no}회차 빼기`}>
                    <i className="ic ic-trash" aria-hidden="true" />
                  </button>
                </div>
                <div className="grid grid-cols-2 items-start gap-x-4 gap-y-[14px] xl:grid-cols-3">
                  <DateField id={`x-s${r.no}`} label="공연 시작(KST)" value={r.start} />
                  <DateField id={`x-e${r.no}`} label="입장 시작(KST)" value={r.entry} />
                  <DateField id={`x-f${r.no}`} label="공연 종료 예정(KST)" value={r.end} />
                  <div className="field">
                    <label className="label" htmlFor={`x-open${r.no}`}>
                      오픈 시각(KST) <span className="opt">(필수)</span>
                    </label>
                    <div className={openErr ? 'input-group input-group-sm is-error' : 'input-group input-group-sm'}>
                      <i className="ic ic-calendar" aria-hidden="true" />
                      <input
                        id={`x-open${r.no}`}
                        type="text"
                        defaultValue={openErr ? openErr.value : r.open}
                        aria-invalid={openErr ? true : undefined}
                        aria-describedby={openErr ? `x-open${r.no}-e` : isFirst ? undefined : `x-open${r.no}-w`}
                      />
                    </div>
                    {openErr ? (
                      <span className="error-msg" id={`x-open${r.no}-e`}>
                        <i className="ic ic-alert-circle" aria-hidden="true" />
                        {openErr.text}
                      </span>
                    ) : null}
                    {!isFirst ? (
                      <>
                        <span className="hint row" id={`x-open${r.no}-w`} style={{ gap: 4, alignItems: 'flex-start' }}>
                          <i className="ic ic-alert ic-14 tx-warning" aria-hidden="true" />이 공연이 판매 승인에서 대형 공연으로 정해지면 다른 대형 공연과 30분 이상 떨어져야 합니다(가능:
                          20:00)
                        </span>
                        <button className="btn btn-secondary btn-sm" type="button" style={{ alignSelf: 'flex-start' }}>
                          20:00으로 바꾸기
                        </button>
                      </>
                    ) : null}
                  </div>
                  <div className="field">
                    <label className="label" htmlFor={`x-l${r.no}`}>
                      로비 개방
                    </label>
                    <div className="input-group input-group-sm">
                      <input id={`x-l${r.no}`} type="text" inputMode="numeric" defaultValue={r.lobbyMin} aria-describedby={`x-l${r.no}-h`} />
                      <span className="t-sm muted nowrap">분 전</span>
                    </div>
                    <span className="hint" id={`x-l${r.no}-h`}>
                      {isFirst ? '기본 10분 · 하이브리드·사전 셔플 공연에서 씁니다' : '기본 10분'}
                    </span>
                  </div>
                  <div className="field">
                    <span className="label" aria-hidden="true">
                      재입장
                    </span>
                    <label className="check-row" style={{ alignItems: 'center', minHeight: 40, fontSize: 14 }}>
                      <input className="sw" type="checkbox" role="switch" aria-describedby={`x-re${r.no}-h`} />
                      재입장 허용
                    </label>
                    <span className="hint" id={`x-re${r.no}-h`}>
                      {isFirst ? '지금 불허(기본) · 판매 조건으로 공연 상세에 공시합니다' : '지금 불허(기본)'}
                    </span>
                  </div>
                </div>
              </div>
            );
          })}
        </section>

        <div className="col gap-5 lg:col-span-5 xl:col-span-1 xl:gap-6">
          <section className="card pad-lg col" style={{ gap: 14 }} aria-labelledby="x-h-tier">
            <div className="section-title">
              <h2 id="x-h-tier">가격 등급</h2>
              <button className="btn btn-outline btn-sm" type="button">
                <i className="ic ic-plus" aria-hidden="true" />
                등급 추가
              </button>
            </div>
            <p className="hint" id="x-tier-h">
              위로·아래로 버튼으로 순서를 바꿉니다. 위에 있는 등급이 공연 상세에서 먼저 보입니다.
            </p>
            <ReorderList
              label="가격 등급 순서"
              describedBy="x-tier-h"
              items={tiers.map((t) => ({
                id: t.id,
                label: t.name,
                content: (
                  <>
                    <input className="input input-sm" type="text" defaultValue={t.name} aria-label={`${t.name} 등급 이름`} style={{ width: 96, flex: 'none' }} />
                    <div className="input-group input-group-sm grow">
                      <span className="t-sm muted">₩</span>
                      <input type="text" inputMode="numeric" defaultValue={t.price} aria-label={`${t.name} 가격(원)`} />
                    </div>
                  </>
                ),
              }))}
            />
          </section>

          <section className="card pad-lg col" style={{ gap: 12 }} aria-labelledby="x-h-pay">
            <div className="section-title">
              <h2 id="x-h-pay">결제</h2>
            </div>
            <label className="check-row">
              <input className="cb" type="checkbox" aria-describedby="x-va-h" />
              가상계좌 허용
            </label>
            <p className="hint" id="x-va-h">
              고수요 공연에서는 가상계좌를 자동으로 숨깁니다
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}

function DateField({ id, label, value }: { id: string; label: string; value: string }) {
  return (
    <div className="field">
      <label className="label" htmlFor={id}>
        {label} <span className="opt">(필수)</span>
      </label>
      <div className="input-group input-group-sm">
        <i className="ic ic-calendar" aria-hidden="true" />
        <input id={id} type="text" defaultValue={value} />
      </div>
    </div>
  );
}
