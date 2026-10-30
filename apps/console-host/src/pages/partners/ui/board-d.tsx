// 디자인 캔버스 보드 SCR-065-d.dc.html를 옮긴 것(dc2tsx 생성 뒤 손질)
/* eslint-disable */
import { Fragment, type FormEvent } from 'react';
import { Link } from 'react-router';
import { Overlay } from '@/shared/ui/Overlay';
import { useRo } from '@/features/screen-access';

const prevent = (e: FormEvent) => e.preventDefault();
void Fragment;
void Link;

type AriaBool = boolean | 'true' | 'false';
type AriaCurrent = boolean | 'true' | 'false' | 'page' | 'step' | 'location' | 'date' | 'time';

export const STATES_D = ["계약(기본)", "결제사 등록 탭", "변경 승인 대기"] as const;
export const DEFAULT_D = "계약(기본)";

export function valsD(state: string) {
    let st = state || '계약(기본)';
    let pg = st === '결제사 등록 탭';
    let pending = st === '변경 승인 대기';
    return {
      isStella: !pg,
      isPB: pg,
      isPending: pending,
      notPending: !pending,
      rowStella: pg ? '' : 'is-selected',
      curStella: pg ? 'false' : 'true',
      rowB: pg ? 'is-selected' : '',
      curB: pg ? 'true' : 'false'
    };
  }

type V = ReturnType<typeof valsD>;

// 보드 루트: {"class": "pk dark cs", "style": "width:100%;min-height:1220px;grid-template-rows:auto 1fr"}

// <main class="cs-main" id="main">
export function MainD({ v, close, go }: { v: V; close?: () => void; go?: (state: string) => void }) {
  void v; void close; void go;
  const ro = useRo();
  return (
    <>
    <div className="col" style={{ gap: "4px" }}>
      <h1 className="t-xl">파트너사·계약</h1>
      <p className="t-sm muted">파트너의 계약 수수료율·보증, 판매자 정보, 결제사 등록, 공연정보 전송 기록을 봅니다. 수수료율·보증 변경은 commander 승인(2인)을 거칩니다.</p>
    </div>
    <div className="grid-12" style={{ rowGap: "16px", alignItems: "start" }}>
      <div className="span-5 col" style={{ gap: "16px" }}>
        <section className="widget" aria-labelledby="h-pl">
          <div className="widget-head">
            <h2 className="t-sm fw-b" id="h-pl">파트너 4곳</h2>
            <span className="actions t-xs muted">결제사 등록 상태</span>
          </div>
          <table className="table dense">
            <caption className="sr-only">파트너 목록. 이름을 누르면 오른쪽에 상세가 열립니다</caption>
            <thead>
              <tr>
                <th scope="col">파트너</th>
                <th scope="col" className="r">수수료율</th>
                <th scope="col">토스페이먼츠 셀러</th>
                <th scope="col">포트원</th>
              </tr>
            </thead>
            <tbody>
              <tr className={v.rowStella}>
                <td><a onClick={(e) => { e.preventDefault(); go?.('계약(기본)'); }} href="/partners" className="fw-b" style={{ color: "inherit" }} aria-current={(v.curStella) as AriaCurrent}>(주)스텔라엔터테인먼트</a></td>
                <td className="r">
                  <div className="row" style={{ gap: "4px", justifyContent: "flex-end" }}>
                    10.0%
                    {v.isPending ? (
                      <>
                        <span className="badge badge-warning">승인 대기</span>
                      </>
                    ) : null}
                  </div>
                </td>
                <td>
                  <span className="col" style={{ gap: "4px", alignItems: "flex-start" }}>
                    <span className="badge">일반 · 부분 승인</span>
                    <span className="badge">에스크로 · 부분 승인</span>
                  </span>
                </td>
                <td><span className="badge badge-success">등록됨</span></td>
              </tr>
              <tr>
                <td><Link to="/partners" className="fw-b" style={{ color: "inherit" }}>[예시 파트너 A]</Link></td>
                <td className="r">10.0%</td>
                <td>
                  <span className="col" style={{ gap: "4px", alignItems: "flex-start" }}>
                    <span className="badge badge-success">일반 · 승인됨</span>
                    <span className="badge badge-success">에스크로 · 승인됨</span>
                  </span>
                </td>
                <td><span className="badge badge-success">등록됨</span></td>
              </tr>
              <tr className={v.rowB}>
                <td><Link onClick={(e) => { e.preventDefault(); go?.('결제사 등록 탭'); }} to="/partners" className="fw-b" style={{ color: "inherit" }} aria-current={(v.curB) as AriaCurrent}>[예시 파트너 B]</Link></td>
                <td className="r">10.0%</td>
                <td>
                  <span className="col" style={{ gap: "4px", alignItems: "flex-start" }}>
                    <span className="badge badge-warning">일반 · KYC 필요</span>
                    <span className="badge">에스크로 · 부분 승인</span>
                  </span>
                </td>
                <td><span className="badge badge-success">등록됨</span></td>
              </tr>
              <tr>
                <td><Link to="/partners" className="fw-b" style={{ color: "inherit" }}>[예시 파트너 C]</Link></td>
                <td className="r">10.0%</td>
                <td>
                  <span className="col" style={{ gap: "4px", alignItems: "flex-start" }}>
                    <span className="badge badge-success">일반 · 승인됨</span>
                    <span className="badge badge-warning">에스크로 · 승인 필요</span>
                  </span>
                </td>
                <td><span className="badge badge-success">등록됨</span></td>
              </tr>
            </tbody>
          </table>
          <p className="t-xs muted" style={{ padding: "10px 14px" }}>
            토스페이먼츠 셀러가 부분 승인 이상이고 포트원 파트너 등록과 예금주 일치가 끝나야 판매 승인을 받을 수 있습니다. 셀러는 토스페이먼츠 일반·에스크로 두 상점에 함께 등록하고, 택배 상품은 에스크로 상점 셀러가 부분 승인 이상일 때만 공개됩니다.
          </p>
        </section>
        <section className="widget" aria-labelledby="h-basis">
          <div className="widget-head"><h2 className="t-sm fw-b" id="h-basis">계약·정산 기준</h2></div>
          <div className="widget-body">
            <dl className="col t-sm" style={{ gap: "12px" }}>
              <div className="col" style={{ gap: "2px" }}>
                <dt className="fw-b">중개수수료</dt>
                <dd className="muted">(판매 대금 − 환급) × 계약 수수료율, 원 미만 버림. 수수료 부가세 10%는 따로 붙습니다.</dd>
              </div>
              <div className="col" style={{ gap: "2px" }}>
                <dt className="fw-b">계약 보증</dt>
                <dd className="muted">회차 예상 매출의 10%. 보증금이나 이행보증보험으로 받습니다.</dd>
              </div>
              <div className="col" style={{ gap: "2px" }}>
                <dt className="fw-b">미수금 회수</dt>
                <dd className="muted">다음 정산서 상계 → 계약 보증 → 청구 순서입니다.</dd>
              </div>
              <div className="col" style={{ gap: "2px" }}>
                <dt className="fw-b">정산 계좌 변경</dt>
                <dd className="muted">예금주가 판매자 상호나 대표자와 같은 계좌만 받고, 바꾼 뒤 3영업일 동안 지급을 미룹니다. PEAKET에는 은행과 끝 4자리만 남깁니다.</dd>
              </div>
            </dl>
          </div>
        </section>
      </div>
      <div className="span-7 col" style={{ gap: "16px" }}>
        {v.isStella ? (
          <>
            <section className="widget" role="region" aria-labelledby="h-st">
              <div className="widget-head">
                <h2 className="t-sm fw-b" id="h-st">(주)스텔라엔터테인먼트</h2>
                <div className="actions" style={{ gap: "12px" }}>
                  <Link to="/sale-reviews/prd-lumen-2026" className="link-more">
                    판매 승인
                    <i className="ic ic-chevron-right" aria-hidden="true" />
                  </Link>
                  <Link to="/partners" className="link-more">
                    파트너 계정
                    <i className="ic ic-chevron-right" aria-hidden="true" />
                  </Link>
                </div>
              </div>
              <div className="tabs tabs-sm" role="tablist" aria-label="파트너 상세" style={{ padding: "0 14px" }}>
                <button className="tab is-active" type="button" role="tab" aria-selected="true" id="st-t1" aria-controls="st-p1">계약</button>
                {' '}
                <button className="tab" type="button" role="tab" aria-selected="false">판매자 정보</button>
                {' '}
                <button onClick={() => go?.('결제사 등록 탭')} className="tab" type="button" role="tab" aria-selected="false">결제사 등록</button>
                {' '}
                <button className="tab" type="button" role="tab" aria-selected="false">공연정보 전송</button>
              </div>
              <div className="widget-body" id="st-p1" role="tabpanel" aria-labelledby="st-t1" style={{ gap: "14px" }}>
                {v.isPending ? (
                  <>
                    <div className="banner banner-warning" role="status">
                      <i className="ic ic-stamp" aria-hidden="true" />
                      <div className="banner-body">
                        <span className="banner-title">변경 승인 대기 · 중개수수료율 10.0% → 9.0%</span>
                        민호가 10/14(수) 19:40 KST에 요청했습니다. 요청한 분이 아닌 commander 1명이 승인해야 적용되고, 승인 전까지는 지금 값 10.0%를 씁니다.{' '}
                        <Link to="/cs/approvals" className="link">승인 업무에서 보기</Link>
                      </div>
                    </div>
                  </>
                ) : null}
                <div style={{ display: "grid", gridTemplateColumns: "repeat(2,minmax(0,1fr))", gap: "16px" }}>
                  <div className="field">
                    <label className="label" htmlFor="ct-rate">
                      중개수수료율 (필수)
                      {v.isPending ? (
                        <>
                          <span className="badge badge-warning">승인 대기 9.0%</span>
                        </>
                      ) : null}
                    </label>
                    <div className="input-group input-group-sm">
                      <input id="ct-rate" type="number" inputMode="decimal" min="0" max="100" step="0.1" defaultValue="10.0" aria-describedby="ct-rate-h" />
                      <span className="t-sm muted">%</span>
                    </div>
                    <span className="hint" id="ct-rate-h">판매 대금에서 환급을 뺀 금액에 곱합니다.</span>
                  </div>
                  <div className="field">
                    <label className="label" htmlFor="ct-guar">계약 보증 (필수)</label>
                    <div className="input-group input-group-sm">
                      <input id="ct-guar" type="number" inputMode="decimal" min="0" max="100" step="1" defaultValue="10" aria-describedby="ct-guar-h" />
                      <span className="t-sm muted nowrap">% · 회차 예상 매출 기준</span>
                    </div>
                    <span className="hint" id="ct-guar-h">미수금을 상계로 받지 못하면 보증에서 충당합니다.</span>
                  </div>
                </div>
                <div className="banner banner-info">
                  <i className="ic ic-info" aria-hidden="true" />
                  <div className="banner-body">수수료율·보증 변경은 operator가 요청하고 commander가 승인합니다(2인). 바뀐 수수료율은 승인 뒤 판매 승인을 받는 공연부터 쓰고, 판매 승인 때 공연에 고정됩니다.</div>
                </div>
                {v.notPending ? (
                  <>
                    <div className="row" style={{ justifyContent: "flex-end" }}>
                      <button onClick={() => go?.('변경 승인 대기')} className="btn btn-primary" type="button" {...ro()}>변경 승인 요청 보내기</button>
                    </div>
                  </>
                ) : null}
                <section className="col" style={{ gap: "8px" }} aria-labelledby="h-fix">
                  <div className="row between">
                    <h3 className="t-sm fw-b" id="h-fix">공연에 고정된 수수료율</h3>
                    <Link to="/partners" className="link-more">
                      이 파트너 공연 모두
                      <i className="ic ic-chevron-right" aria-hidden="true" />
                    </Link>
                  </div>
                  <div className="table-wrap">
                    <table className="table dense">
                      <caption className="sr-only">판매 승인 때 공연에 고정된 수수료율</caption>
                      <thead>
                        <tr>
                          <th scope="col">공연</th>
                          <th scope="col" className="r">수수료율</th>
                          <th scope="col">고정한 때</th>
                        </tr>
                      </thead>
                      <tbody>
                        <tr>
                          <td>LUMEN 콘서트 2026 서울</td>
                          <td className="r">10.0%</td>
                          <td>판매 승인 [일시]</td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                  <p className="hint">이미 판매 승인된 공연의 수수료율은 계약을 바꿔도 그대로입니다.</p>
                </section>
                <section className="col" style={{ gap: "8px" }} aria-labelledby="h-chg">
                  <h3 className="t-sm fw-b" id="h-chg">변경 이력</h3>
                  {v.isPending ? (
                    <>
                      <ol className="timeline">
                        <li className="tl-item">
                          <span className="tl-dot warn" aria-hidden="true" />
                          <div className="col" style={{ gap: "2px" }}>
                            <span className="t-sm fw-b">중개수수료율 변경 요청 10.0% → 9.0% · 승인 대기</span>
                            <span className="t-xs muted">10/14(수) 19:40 KST · 요청 민호</span>
                          </div>
                        </li>
                        <li className="tl-item">
                          <span className="tl-dot ok" aria-hidden="true" />
                          <div className="col" style={{ gap: "2px" }}>
                            <span className="t-sm fw-b">LUMEN 콘서트 2026 서울 판매 승인 · 수수료율 10.0% 고정</span>
                            <span className="t-xs muted">[판매 승인 일시] · [승인한 운영자]</span>
                          </div>
                        </li>
                        <li className="tl-item">
                          <span className="tl-dot info" aria-hidden="true" />
                          <div className="col" style={{ gap: "2px" }}>
                            <span className="t-sm fw-b">계약 입력 · 수수료율 10.0% · 보증 회차 예상 매출의 10%</span>
                            <span className="t-xs muted">9/21(월) 10:30 KST · 민호</span>
                          </div>
                        </li>
                      </ol>
                    </>
                  ) : null}
                  {' '}
                  {v.notPending ? (
                    <>
                      <ol className="timeline">
                        <li className="tl-item">
                          <span className="tl-dot ok" aria-hidden="true" />
                          <div className="col" style={{ gap: "2px" }}>
                            <span className="t-sm fw-b">LUMEN 콘서트 2026 서울 판매 승인 · 수수료율 10.0% 고정</span>
                            <span className="t-xs muted">[판매 승인 일시] · [승인한 운영자]</span>
                          </div>
                        </li>
                        <li className="tl-item">
                          <span className="tl-dot info" aria-hidden="true" />
                          <div className="col" style={{ gap: "2px" }}>
                            <span className="t-sm fw-b">계약 입력 · 수수료율 10.0% · 보증 회차 예상 매출의 10%</span>
                            <span className="t-xs muted">9/21(월) 10:30 KST · 민호</span>
                          </div>
                        </li>
                      </ol>
                    </>
                  ) : null}
                </section>
              </div>
            </section>
          </>
        ) : null}
        {' '}
        {v.isPB ? (
          <>
            <section className="widget" role="region" aria-labelledby="h-pb">
              <div className="widget-head">
                <h2 className="t-sm fw-b" id="h-pb">[예시 파트너 B]</h2>
                <div className="actions" style={{ gap: "12px" }}>
                  <Link to="/sale-reviews/prd-lumen-2026" className="link-more">
                    판매 승인
                    <i className="ic ic-chevron-right" aria-hidden="true" />
                  </Link>
                  <Link to="/partners" className="link-more">
                    파트너 계정
                    <i className="ic ic-chevron-right" aria-hidden="true" />
                  </Link>
                </div>
              </div>
              <div className="tabs tabs-sm" role="tablist" aria-label="파트너 상세" style={{ padding: "0 14px" }}>
                <button onClick={() => go?.('계약(기본)')} className="tab" type="button" role="tab" aria-selected="false">계약</button>
                {' '}
                <button className="tab" type="button" role="tab" aria-selected="false">판매자 정보</button>
                {' '}
                <button className="tab is-active" type="button" role="tab" aria-selected="true" id="pb-t3" aria-controls="pb-p3">결제사 등록</button>
                {' '}
                <button className="tab" type="button" role="tab" aria-selected="false">공연정보 전송</button>
              </div>
              <div className="widget-body" id="pb-p3" role="tabpanel" aria-labelledby="pb-t3" style={{ gap: "14px" }}>
                <section className="card-flat col" style={{ gap: "10px", padding: "14px 16px" }} aria-labelledby="h-pb-ts">
                  <div className="row between wrap" style={{ gap: "8px" }}>
                    <h3 className="t-sm fw-b" id="h-pb-ts">토스페이먼츠 셀러</h3>
                    <div className="row" style={{ gap: "6px" }}>
                      <span className="badge badge-warning">
                        <i className="ic ic-alert" aria-hidden="true" />
                        일반 상점 KYC 필요
                      </span>
                      <span className="badge badge-warning">
                        <i className="ic ic-clock" aria-hidden="true" />
                        지급 보류 · KYC 끝날 때까지
                      </span>
                    </div>
                  </div>
                  <dl className="kv">
                    <dt>일반 상점</dt>
                    <dd>
                      <span className="badge badge-warning">KYC 필요</span>
                      {' '}티켓·부가 상품·현장 수령 굿즈
                    </dd>
                    <dt>에스크로 상점</dt>
                    <dd>
                      <span className="badge">부분 승인</span>
                      {' '}굿즈 택배
                    </dd>
                  </dl>
                  <p className="t-sm">
                    결제사가 10/13(화) 16:05 KST에 KYC를 요청했습니다. 파트너에게 결제사 안내 이메일을 확인하라고 알렸고, CS 처리함 'KYC 필요' 건으로 추적합니다. 그동안 이 파트너의 토스페이먼츠 일반 상점 결제분은 지급을 보류하고, 에스크로 상점과 포트원 결제분은 그대로 지급합니다. KYC는 상점마다 따로 요청될 수 있어 보류도 그 상점분만 합니다.
                  </p>
                  <p className="t-xs muted">
                    결제사 심사는 서류가 갖춰지면 2영업일 안에 끝납니다(토스페이먼츠 안내). 보완 요청이나 승인 보류가 있으면 더 걸리고, 제출·심사 상태는 토스페이먼츠 상점관리자의 '셀러 KYC 심사'에서 봅니다. 보통 KYC 필요 뒤 5영업일 안팎에 지급을 다시 시작합니다(추정). KYC는 1년이나 3년마다 다시 받을 수 있습니다.
                  </p>
                  <div className="row wrap" style={{ gap: "6px 16px" }}>
                    <Link to="/cs/inbox" className="link-more">
                      CS 처리함 KYC 건
                      <i className="ic ic-chevron-right" aria-hidden="true" />
                    </Link>
                    <a href="https://app.tosspayments.com/" className="link-more" target="_blank" rel="noopener noreferrer">
                      토스페이먼츠 상점관리자
                      <i className="ic ic-external" aria-hidden="true" />
                      <span className="sr-only">(새 창)</span>
                    </a>
                  </div>
                </section>
                <section className="card-flat row between" style={{ padding: "14px 16px" }} aria-labelledby="h-pb-po">
                  <h3 className="t-sm fw-b" id="h-pb-po">포트원 파트너</h3>
                  <span className="badge badge-success">등록됨</span>
                </section>
                <section className="card-flat col" style={{ gap: "10px", padding: "14px 16px" }} aria-labelledby="h-pb-ac">
                  <div className="row between wrap" style={{ gap: "8px" }}>
                    <h3 className="t-sm fw-b" id="h-pb-ac">정산 계좌</h3>
                    <span className="badge badge-warning">
                      <i className="ic ic-clock" aria-hidden="true" />
                      지급 보류 10/20(화)까지
                    </span>
                  </div>
                  <dl className="kv">
                    <dt>계좌</dt>
                    <dd>[은행] ****1234</dd>
                    <dt>예금주</dt>
                    <dd>판매자 상호와 같음</dd>
                    <dt>바꾼 시각</dt>
                    <dd>10/14(수) 11:20 KST · 파트너(다시 인증함)</dd>
                  </dl>
                  <p className="t-xs muted">정산 계좌를 바꾸면 3영업일 동안 지급을 미루고, 바뀐 사실을 파트너의 등록 이메일과 전화로 알립니다. 계좌번호 전체는 PEAKET에 남기지 않습니다.</p>
                </section>
                <section className="col" style={{ gap: "8px" }} aria-labelledby="h-pb-h">
                  <h3 className="t-sm fw-b" id="h-pb-h">변경 이력</h3>
                  <ol className="timeline">
                    <li className="tl-item">
                      <span className="tl-dot warn" aria-hidden="true" />
                      <div className="col" style={{ gap: "2px" }}>
                        <span className="t-sm fw-b">정산 계좌 변경 · 지급 보류 10/20(화)까지</span>
                        <span className="t-xs muted">10/14(수) 11:20 KST · 파트너(다시 인증함)</span>
                      </div>
                    </li>
                    <li className="tl-item">
                      <span className="tl-dot bad" aria-hidden="true" />
                      <div className="col" style={{ gap: "2px" }}>
                        <span className="t-sm fw-b">토스페이먼츠 셀러 KYC 필요</span>
                        <span className="t-xs muted">10/13(화) 16:05 KST · 결제사 알림</span>
                      </div>
                    </li>
                    <li className="tl-item">
                      <span className="tl-dot ok" aria-hidden="true" />
                      <div className="col" style={{ gap: "2px" }}>
                        <span className="t-sm fw-b">결제사 등록 · 토스페이먼츠 일반·에스크로 셀러 부분 승인 · 포트원 등록됨</span>
                        <span className="t-xs muted">9/28(월) 14:00 KST · 판매 승인 요청 때</span>
                      </div>
                    </li>
                  </ol>
                </section>
              </div>
            </section>
          </>
        ) : null}
      </div>
    </div>
    </>
  );
}
