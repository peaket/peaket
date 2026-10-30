// 디자인 캔버스 보드 SCR-067-d.dc.html를 옮긴 것(dc2tsx 생성 뒤 손질)
/* eslint-disable */
import { Fragment, type FormEvent } from 'react';
import { Link } from 'react-router';
import { Overlay } from '@/shared/ui/Overlay';

const prevent = (e: FormEvent) => e.preventDefault();
void Fragment;
void Link;

type AriaBool = boolean | 'true' | 'false';
type AriaCurrent = boolean | 'true' | 'false' | 'page' | 'step' | 'location' | 'date' | 'time';

export const STATES_D = ["검토", "중간 결과", "표본 없음"] as const;
export const DEFAULT_D = "검토";

export function valsD(state: string) {
    let st = state || '검토';
    return {
      hasSample: st !== '표본 없음',
      reviewing: st === '검토',
      interim: st === '중간 결과',
      empty: st === '표본 없음'
    };
  }

type V = ReturnType<typeof valsD>;

// 보드 루트: {"class": "pk dark cs", "style": "width:100%;min-height:1020px;grid-template-rows:auto 1fr"}

// <main class="cs-main" id="main">
export function MainD({ v, close, go }: { v: V; close?: () => void; go?: (state: string) => void }) {
  void v; void close; void go;
  return (
    <>
    <div className="page-head">
      <div className="col" style={{ gap: "4px" }}>
        <h1>봇 판정 표본 검토</h1>
        <p className="t-sm muted">온세일이 끝난 뒤 검증을 통과한 세션에서 무작위로 뽑은 표본을 사람이 검토합니다. 개인 식별 정보와 판정 가중치는 보이지 않습니다.</p>
      </div>
    </div>
    {v.hasSample ? (
      <>
        <section className="widget" aria-label="검토 대상과 진행">
          <div className="widget-body" style={{ padding: "16px", gap: "14px" }}>
            <div className="grid-12" style={{ rowGap: "16px", alignItems: "end" }}>
              <div className="field span-4">
                <label className="label" htmlFor="br-round">회차</label>
                <div className="input-group input-group-sm">
                  <select id="br-round">
                    <option>LUMEN 콘서트 2026 서울 1회차 · 10/25(일) 18:00 KST</option>
                    <option>LUMEN 콘서트 2026 서울 2회차 · 10/26(월) 17:00 KST</option>
                  </select>
                  <i className="ic ic-chevron-down" aria-hidden="true" />
                </div>
              </div>
              <div className="span-4 col" style={{ gap: "6px" }}>
                <div className="row between t-sm">
                  <span className="fw-b" id="pg-l">검토 진행</span>
                  <span className="num">
                    <strong>137</strong>
                    {' '}/ 200건
                  </span>
                </div>
                <div className="progress" role="progressbar" aria-labelledby="pg-l" aria-valuemin={0} aria-valuemax={200} aria-valuenow={137} aria-valuetext="표본 200건 중 137건 검토">
                  <span style={{ width: "68.5%" }} />
                </div>
                <span className="t-xs muted">남은 표본 63건 · 표본 크기 200건 [가정]</span>
              </div>
              <div className="span-4 col" style={{ gap: "6px" }}>
                <span className="eyebrow">기한</span>
                {' '}
                <span className="badge" style={{ alignSelf: "flex-start" }}>
                  <i className="ic ic-clock" aria-hidden="true" />
                  R2 마감 10/21(수) 20:00 KST · 5일 남음
                </span>
                {' '}
                <span className="badge" style={{ alignSelf: "flex-start" }}>
                  <i className="ic ic-clock" aria-hidden="true" />
                  행동 신호 삭제 11/13(금) 20:00 KST · 28일 남음
                </span>
              </div>
            </div>
            <p className="t-xs muted">R2 마감(오픈 + 7일)까지 검토를 끝내지 못하면 봇 지표는 '판정 보류'로 남습니다. 행동 신호는 오픈 30일 뒤 지워지므로 그 뒤에는 검토할 수 없습니다.</p>
          </div>
        </section>
      </>
    ) : null}
    {' '}
    {v.reviewing ? (
      <>
        <div className="col" style={{ gap: "16px" }}>
          <div className="grid-12" style={{ rowGap: "16px", alignItems: "start" }}>
            <section className="widget span-8" aria-labelledby="h-sess">
              <div className="widget-head">
                <h2 className="t-sm fw-b" id="h-sess">세션 카드 · 표본 138번째</h2>
                <span className="actions"><span className="badge badge-outline">가명 참조값만 표시</span></span>
              </div>
              <div className="widget-body" style={{ padding: "16px", gap: "16px" }}>
                <dl className="row wrap" style={{ gap: "12px 32px", alignItems: "flex-start" }}>
                  <div className="col" style={{ gap: "4px" }}>
                    <dt className="eyebrow">세션 가명</dt>
                    <dd className="mono t-md fw-b">7F3A-91C2</dd>
                  </div>
                  <div className="col" style={{ gap: "4px" }}>
                    <dt className="eyebrow">통과 경로</dt>
                    <dd className="t-md">바로 통과</dd>
                  </div>
                  <div className="col" style={{ gap: "4px" }}>
                    <dt className="eyebrow">위험 점수 범주</dt>
                    <dd><span className="badge">낮음</span></dd>
                  </div>
                  <div className="col" style={{ gap: "4px" }}>
                    <dt className="eyebrow">허니팟 접촉</dt>
                    <dd className="t-md">없음</dd>
                  </div>
                  <div className="col" style={{ gap: "4px" }}>
                    <dt className="eyebrow">결과</dt>
                    <dd className="t-md">2매 발권</dd>
                  </div>
                </dl>
                <div className="divider" />
                <div style={{ display: "grid", gridTemplateColumns: "minmax(0,5fr) minmax(0,7fr)", gap: "24px" }}>
                  <div className="col" style={{ gap: "8px" }}>
                    <h3 className="eyebrow">행동 신호 요약 범주</h3>
                    <dl className="t-sm" style={{ display: "grid", gridTemplateColumns: "auto minmax(0,1fr)", gap: "8px 16px" }}>
                      <dt className="muted">사람 확인</dt>
                      <dd>통과 · 재시도 없음</dd>
                      <dt className="muted">기기 신뢰도</dt>
                      <dd>이 기기의 본인확인 계정 1개</dd>
                      <dt className="muted">입력 간격</dt>
                      <dd>균일에 가까움</dd>
                      <dt className="muted">포인터 이동</dt>
                      <dd>곡선 · 속도 변화 있음</dd>
                      <dt className="muted">IP·ASN 대역</dt>
                      <dd>가정·모바일 망</dd>
                      <dt className="muted">쿠키·세션 나이</dt>
                      <dd>7일 넘음</dd>
                      <dt className="muted">브라우저 정보</dt>
                      <dd>일치</dd>
                    </dl>
                    <p className="t-xs muted">범주만 보입니다. 원시 신호 값, 위험 점수, 판정 기준의 세부 가중치는 보이지 않습니다.</p>
                  </div>
                  <div className="col" style={{ gap: "8px" }}>
                    <h3 className="eyebrow">세션 타임라인 · 오픈 10/14(수) 20:00 KST 기준</h3>
                    <ol className="timeline">
                      <li className="tl-item">
                        <span className="tl-dot info" aria-hidden="true" />
                        <div className="row" style={{ gap: "10px", alignItems: "baseline" }}>
                          <span className="mono t-xs muted" style={{ width: "72px", flex: "none" }}>T−8:12</span>
                          <span className="t-sm">로비 참가 · 사람 확인 통과</span>
                        </div>
                      </li>
                      <li className="tl-item">
                        <span className="tl-dot info" aria-hidden="true" />
                        <div className="row" style={{ gap: "10px", alignItems: "baseline" }}>
                          <span className="mono t-xs muted" style={{ width: "72px", flex: "none" }}>T+0:00</span>
                          <span className="t-sm">오픈 · 무작위 순번 배정</span>
                        </div>
                      </li>
                      <li className="tl-item">
                        <span className="tl-dot ok" aria-hidden="true" />
                        <div className="row" style={{ gap: "10px", alignItems: "baseline" }}>
                          <span className="mono t-xs muted" style={{ width: "72px", flex: "none" }}>T+3:41.0</span>
                          <span className="t-sm">차례 도래 → 2.1초 뒤 입장 확정</span>
                        </div>
                      </li>
                      <li className="tl-item">
                        <span className="tl-dot warn" aria-hidden="true" />
                        <div className="row" style={{ gap: "10px", alignItems: "baseline" }}>
                          <span className="mono t-xs muted" style={{ width: "72px", flex: "none" }}>T+3:44.7</span>
                          <span className="t-sm">첫 홀드 요청 · 좌석맵을 받고 1.6초 뒤</span>
                        </div>
                      </li>
                      <li className="tl-item">
                        <span className="tl-dot warn" aria-hidden="true" />
                        <div className="row" style={{ gap: "10px", alignItems: "baseline" }}>
                          <span className="mono t-xs muted" style={{ width: "72px", flex: "none" }}>T+3:47.5</span>
                          <span className="t-sm">홀드 요청 4회째 · 간격 0.9·1.0·0.9초로 고름 · 경합 2회 뒤 2석 홀드</span>
                        </div>
                      </li>
                      <li className="tl-item">
                        <span className="tl-dot ok" aria-hidden="true" />
                        <div className="row" style={{ gap: "10px", alignItems: "baseline" }}>
                          <span className="mono t-xs muted" style={{ width: "72px", flex: "none" }}>T+4:05.4</span>
                          <span className="t-sm">주문 생성 → T+4:31.8 결제 접수</span>
                        </div>
                      </li>
                      <li className="tl-item">
                        <span className="tl-dot ok" aria-hidden="true" />
                        <div className="row" style={{ gap: "10px", alignItems: "baseline" }}>
                          <span className="mono t-xs muted" style={{ width: "72px", flex: "none" }}>T+4:52.2</span>
                          <span className="t-sm">결제 승인 · 2매 발권</span>
                        </div>
                      </li>
                    </ol>
                  </div>
                </div>
              </div>
            </section>
            <section className="widget span-4" aria-labelledby="h-verdict">
              <div className="widget-head"><h2 className="t-sm fw-b" id="h-verdict">판정</h2></div>
              <div className="widget-body" style={{ padding: "16px", gap: "14px" }}>
                <fieldset className="col" style={{ gap: "10px" }} role="radiogroup" aria-labelledby="vd-legend" aria-describedby="vd-note">
                  <legend className="label" id="vd-legend" style={{ marginBottom: "6px" }}>이 세션의 판정 (필수)</legend>
                  <label className="check-row" htmlFor="vd-human">
                    <input className="rd" type="radio" name="vd" id="vd-human" />
                    <span className="col">
                      <strong className="fw-b">사람</strong>
                      <span className="t-sm muted">사람이 조작한 것으로 봅니다</span>
                    </span>
                  </label>
                  {' '}
                  <label className="check-row" htmlFor="vd-bot">
                    <input className="rd" type="radio" name="vd" id="vd-bot" />
                    <span className="col">
                      <strong className="fw-b">봇</strong>
                      <span className="t-sm muted">자동화 도구가 조작한 것으로 봅니다</span>
                    </span>
                  </label>
                  {' '}
                  <label className="check-row" htmlFor="vd-unk">
                    <input className="rd" type="radio" name="vd" id="vd-unk" />
                    <span className="col">
                      <strong className="fw-b">판단 불가</strong>
                      <span className="t-sm muted">근거가 부족해 정하지 않습니다</span>
                    </span>
                  </label>
                </fieldset>
                <p className="t-xs muted" id="vd-note">기록에는 세션 가명과 판정 결과만 남습니다. 메모나 근거는 남기지 않습니다.</p>
                <button className="btn btn-primary btn-block" type="button" aria-disabled="true" aria-describedby="vd-why">
                  기록하고 다음 표본으로
                  <i className="ic ic-arrow-right" aria-hidden="true" />
                </button>
                <p className="hint" id="vd-why">판정을 고르면 기록할 수 있습니다</p>
                <ul className="col t-xs muted" style={{ gap: "6px" }} aria-label="키보드 안내">
                  <li className="row" style={{ gap: "6px" }}>
                    <span className="kbd">↑</span>
                    <span className="kbd">↓</span>
                    판정 고르기
                  </li>
                  <li className="row" style={{ gap: "6px" }}>
                    <span className="kbd">Tab</span>
                    <span className="kbd">Enter</span>
                    기록하고 다음 표본으로
                  </li>
                  <li className="row" style={{ gap: "6px" }}>
                    <span className="kbd">?</span>
                    단축키 도움말
                  </li>
                </ul>
              </div>
            </section>
          </div>
          <section className="widget" aria-labelledby="h-interim-s">
            <div className="widget-head">
              <h2 className="t-sm fw-b" id="h-interim-s">중간 결과</h2>
              <span className="badge badge-outline">잠정</span>
              <span className="actions">
                <button onClick={() => go?.('중간 결과')} className="btn btn-ghost btn-sm" type="button">
                  중간 결과 자세히 보기
                  <i className="ic ic-chevron-right" aria-hidden="true" />
                </button>
              </span>
            </div>
            <div className="widget-body" style={{ padding: "12px 14px" }}>
              <p className="t-md">
                <strong className="num">놓친 봇 비율 추정 1.5%</strong>
                <span className="muted num">· 95% 구간 0.2~5.3% · 검토 137건 중 판정한 134건 기준</span>
              </p>
            </div>
          </section>
        </div>
      </>
    ) : null}
    {' '}
    {v.interim ? (
      <>
        <section className="widget" aria-labelledby="h-interim">
          <div className="widget-head">
            <h2 className="t-sm fw-b" id="h-interim">중간 결과</h2>
            <span className="badge badge-outline">잠정</span>
            <span className="actions">
              <button onClick={() => go?.('검토')} className="btn btn-secondary btn-sm" type="button">
                <i className="ic ic-arrow-left" aria-hidden="true" />
                표본 검토로 돌아가기
              </button>
            </span>
          </div>
          <div className="widget-body" style={{ padding: "16px" }}>
            <div className="grid-12" style={{ rowGap: "16px", alignItems: "start" }}>
              <div className="span-5" style={{ display: "grid", gridTemplateColumns: "repeat(2,minmax(0,1fr))", gap: "12px" }}>
                <div className="stat">
                  <span className="stat-label">검토한 표본</span>
                  <span className="stat-value">137</span>
                  <span className="stat-meta">표본 200건 중 · 남은 63건</span>
                </div>
                <div className="stat">
                  <span className="stat-label">봇</span>
                  <span className="stat-value">2</span>
                  <span className="stat-meta">판정한 134건 중</span>
                </div>
                <div className="stat">
                  <span className="stat-label">사람</span>
                  <span className="stat-value">132</span>
                  <span className="stat-meta">판정한 134건 중</span>
                </div>
                <div className="stat">
                  <span className="stat-label">판단 불가</span>
                  <span className="stat-value">3</span>
                  <span className="stat-meta">추정에서 뺌 [가정]</span>
                </div>
              </div>
              <div className="span-7 col" style={{ gap: "12px" }}>
                <div className="col" style={{ gap: "4px" }}>
                  <span className="stat-label">놓친 봇 비율 추정 · 검증을 통과한 세션 중</span>
                  <p className="num">
                    <span className="t-2xl">1.5%</span>
                    {' '}
                    <span className="t-md muted">95% 구간 0.2~5.3%</span>
                  </p>
                </div>
                <figure className="col" style={{ gap: "8px", maxWidth: "640px" }}>
                  <div className="row between">
                    <span className="eyebrow">추정값과 95% 구간</span>
                    <button className="btn btn-ghost btn-sm" type="button">
                      <i className="ic ic-list" aria-hidden="true" />
                      표로 보기
                    </button>
                  </div>
                  <svg className="chart" viewBox="0 0 640 80" role="img" aria-label="놓친 봇 비율 추정 1.5%, 95% 구간 0.2%에서 5.3%, 잠정">
                    <line className="grid" x1="20" y1="44" x2="620" y2="44" />
                    <line className="grid" x1="20" y1="39" x2="20" y2="49" />
                    <line className="grid" x1="140" y1="39" x2="140" y2="49" />
                    <line className="grid" x1="260" y1="39" x2="260" y2="49" />
                    <line className="grid" x1="380" y1="39" x2="380" y2="49" />
                    <line className="grid" x1="500" y1="39" x2="500" y2="49" />
                    <line className="grid" x1="620" y1="39" x2="620" y2="49" />
                    <line className="line" x1="30.8" y1="44" x2="337.4" y2="44" style={{ strokeWidth: "6" }} />
                    <circle cx="109.4" cy="44" r="7" style={{ fill: "var(--link)", stroke: "var(--surface)", strokeWidth: "2" }} />
                    <text className="axis" x="109.4" y="24" textAnchor="middle">추정 1.5%</text>
                    <text className="axis" x="20" y="70" textAnchor="middle">0%</text>
                    <text className="axis" x="140" y="70" textAnchor="middle">2%</text>
                    <text className="axis" x="260" y="70" textAnchor="middle">4%</text>
                    <text className="axis" x="380" y="70" textAnchor="middle">6%</text>
                    <text className="axis" x="500" y="70" textAnchor="middle">8%</text>
                    <text className="axis" x="620" y="70" textAnchor="middle">10%</text>
                  </svg>
                  <figcaption className="t-xs muted">막대는 95% 구간(0.2~5.3%), 점은 추정값(1.5%)입니다.</figcaption>
                </figure>
                <ul className="col t-sm muted" style={{ gap: "4px" }}>
                  <li>추정은 봇 2건 ÷ 판정한 134건입니다. 판단 불가 3건은 분모에서 뺐습니다 [가정].</li>
                  <li>검토가 끝나면 결과는 대시보드 종료 후 탭에 하한 추정치로 표시됩니다.</li>
                </ul>
                <Link to="/dashboard" className="link-more">
                  대시보드 종료 후 탭
                  <i className="ic ic-chevron-right" aria-hidden="true" />
                </Link>
              </div>
            </div>
          </div>
        </section>
      </>
    ) : null}
    {' '}
    {v.empty ? (
      <>
        <div className="col" style={{ gap: "16px" }}>
          <section className="widget" aria-label="검토 대상">
            <div className="widget-body" style={{ padding: "16px" }}>
              <div className="field" style={{ width: "420px" }}>
                <label className="label" htmlFor="br-round2">회차</label>
                <div className="input-group input-group-sm">
                  <select id="br-round2">
                    <option>팬미팅 · 오픈 10/28(수) 20:00 KST</option>
                    <option>LUMEN 콘서트 2026 서울 1회차 · 10/25(일) 18:00 KST</option>
                  </select>
                  <i className="ic ic-chevron-down" aria-hidden="true" />
                </div>
              </div>
            </div>
          </section>
          <section className="widget" aria-labelledby="h-empty">
            <div className="state" role="status">
              <span className="state-icon"><i className="ic ic-bot" aria-hidden="true" /></span>
              <h2 className="t-lg" id="h-empty">검토할 표본이 없습니다</h2>
              <p className="t-sm muted">표본은 온세일이 끝난 뒤 검증을 통과한 세션에서 뽑습니다. 다른 회차를 고르세요.</p>
            </div>
          </section>
        </div>
      </>
    ) : null}
    </>
  );
}
