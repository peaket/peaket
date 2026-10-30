// 디자인 캔버스 보드 SCR-065-m.dc.html를 옮긴 것(dc2tsx 생성 뒤 손질)
/* eslint-disable */
import { Fragment, type FormEvent } from 'react';
import { Link } from 'react-router';
import { Overlay } from '@/shared/ui/Overlay';
import { useRo } from '@/features/screen-access';
import { copyLink } from '@/shared/lib/clipboard';

const prevent = (e: FormEvent) => e.preventDefault();
void Fragment;
void Link;

type AriaBool = boolean | 'true' | 'false';
type AriaCurrent = boolean | 'true' | 'false' | 'page' | 'step' | 'location' | 'date' | 'time';

export const STATES_M = ["계약(기본)", "결제사 등록 탭", "변경 승인 대기"] as const;
export const DEFAULT_M = "계약(기본)";

export function valsM(state: string) {
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

type V = ReturnType<typeof valsM>;

// 보드 루트: {"class": "pk dark cs cs-compact", "style": "width:360px;min-height:2560px"}

// <main class="cs-main" id="main">
export function MainM({ v, close, go }: { v: V; close?: () => void; go?: (state: string) => void }) {
  void v; void close; void go;
  const ro = useRo();
  return (
    <>
    <div className="col" style={{ gap: "4px" }}>
      <h1 className="t-lg">파트너사·계약</h1>
      <p className="t-sm muted">파트너의 계약 수수료율·보증, 판매자 정보, 결제사 등록, 공연정보 전송 기록을 봅니다. 수수료율·보증 변경은 commander 승인(2인)을 거칩니다.</p>
    </div>
    <section className="col" style={{ gap: "8px" }} aria-labelledby="h-pl">
      <div className="row between wrap" style={{ gap: "4px 8px" }}>
        <h2 className="t-md fw-b" id="h-pl">파트너 4곳</h2>
        <span className="t-xs muted">결제사 등록 상태</span>
      </div>
      <ul className="col" style={{ gap: "8px" }}>
        <li>
          <a onClick={(e) => { e.preventDefault(); go?.('계약(기본)'); }} href="/partners" className={`card col ${v.rowStella}`} aria-current={(v.curStella) as AriaCurrent} style={{ gap: "8px", padding: "10px 14px", color: "inherit" }}>
            <span className="t-md fw-b">(주)스텔라엔터테인먼트</span>
            {' '}
            <span style={{ display: "grid", gridTemplateColumns: "repeat(2,minmax(0,1fr))", gap: "8px" }}>
              <span className="col" style={{ gap: "4px" }}>
                <span className="t-xs muted">수수료율</span>
                <span className="row wrap" style={{ gap: "4px" }}>
                  <span className="t-sm fw-m num">10.0%</span>
                  {v.isPending ? (
                    <>
                      <span className="badge badge-warning">승인 대기</span>
                    </>
                  ) : null}
                </span>
              </span>
              {' '}
              <span className="col" style={{ gap: "4px" }}>
                <span className="t-xs muted">포트원</span>
                <span className="row"><span className="badge badge-success">등록됨</span></span>
              </span>
              {' '}
              <span className="col" style={{ gap: "4px", gridColumn: "1/-1" }}>
                <span className="t-xs muted">토스페이먼츠 셀러</span>
                <span className="row wrap" style={{ gap: "4px" }}>
                  <span className="badge">일반 · 부분 승인</span>
                  <span className="badge">에스크로 · 부분 승인</span>
                </span>
              </span>
            </span>
          </a>
        </li>
        <li>
          <Link to="/partners" className="card col" style={{ gap: "8px", padding: "10px 14px", color: "inherit" }}>
            <span className="t-md fw-b">[예시 파트너 A]</span>
            {' '}
            <span style={{ display: "grid", gridTemplateColumns: "repeat(2,minmax(0,1fr))", gap: "8px" }}>
              <span className="col" style={{ gap: "4px" }}>
                <span className="t-xs muted">수수료율</span>
                <span className="t-sm fw-m num">10.0%</span>
              </span>
              {' '}
              <span className="col" style={{ gap: "4px" }}>
                <span className="t-xs muted">포트원</span>
                <span className="row"><span className="badge badge-success">등록됨</span></span>
              </span>
              {' '}
              <span className="col" style={{ gap: "4px", gridColumn: "1/-1" }}>
                <span className="t-xs muted">토스페이먼츠 셀러</span>
                <span className="row wrap" style={{ gap: "4px" }}>
                  <span className="badge badge-success">일반 · 승인됨</span>
                  <span className="badge badge-success">에스크로 · 승인됨</span>
                </span>
              </span>
            </span>
          </Link>
        </li>
        <li>
          <Link onClick={(e) => { e.preventDefault(); go?.('결제사 등록 탭'); }} to="/partners" className={`card col ${v.rowB}`} aria-current={(v.curB) as AriaCurrent} style={{ gap: "8px", padding: "10px 14px", color: "inherit" }}>
            <span className="t-md fw-b">[예시 파트너 B]</span>
            {' '}
            <span style={{ display: "grid", gridTemplateColumns: "repeat(2,minmax(0,1fr))", gap: "8px" }}>
              <span className="col" style={{ gap: "4px" }}>
                <span className="t-xs muted">수수료율</span>
                <span className="t-sm fw-m num">10.0%</span>
              </span>
              {' '}
              <span className="col" style={{ gap: "4px" }}>
                <span className="t-xs muted">포트원</span>
                <span className="row"><span className="badge badge-success">등록됨</span></span>
              </span>
              {' '}
              <span className="col" style={{ gap: "4px", gridColumn: "1/-1" }}>
                <span className="t-xs muted">토스페이먼츠 셀러</span>
                <span className="row wrap" style={{ gap: "4px" }}>
                  <span className="badge badge-warning">일반 · KYC 필요</span>
                  <span className="badge">에스크로 · 부분 승인</span>
                </span>
              </span>
            </span>
          </Link>
        </li>
        <li>
          <Link to="/partners" className="card col" style={{ gap: "8px", padding: "10px 14px", color: "inherit" }}>
            <span className="t-md fw-b">[예시 파트너 C]</span>
            {' '}
            <span style={{ display: "grid", gridTemplateColumns: "repeat(2,minmax(0,1fr))", gap: "8px" }}>
              <span className="col" style={{ gap: "4px" }}>
                <span className="t-xs muted">수수료율</span>
                <span className="t-sm fw-m num">10.0%</span>
              </span>
              {' '}
              <span className="col" style={{ gap: "4px" }}>
                <span className="t-xs muted">포트원</span>
                <span className="row"><span className="badge badge-success">등록됨</span></span>
              </span>
              {' '}
              <span className="col" style={{ gap: "4px", gridColumn: "1/-1" }}>
                <span className="t-xs muted">토스페이먼츠 셀러</span>
                <span className="row wrap" style={{ gap: "4px" }}>
                  <span className="badge badge-success">일반 · 승인됨</span>
                  <span className="badge badge-warning">에스크로 · 승인 필요</span>
                </span>
              </span>
            </span>
          </Link>
        </li>
      </ul>
      <p className="t-xs muted">
        토스페이먼츠 셀러가 부분 승인 이상이고 포트원 파트너 등록과 예금주 일치가 끝나야 판매 승인을 받을 수 있습니다. 셀러는 토스페이먼츠 일반·에스크로 두 상점에 함께 등록하고, 택배 상품은 에스크로 상점 셀러가 부분 승인 이상일 때만 공개됩니다.
      </p>
    </section>
    {v.isStella ? (
      <>
        <div className="col" style={{ gap: "6px" }}>
          <p className="eyebrow">선택한 파트너</p>
          <section className="widget" role="region" aria-labelledby="h-st">
            <div className="widget-head"><h2 className="t-sm fw-b" id="h-st">(주)스텔라엔터테인먼트</h2></div>
            <div className="tabs tabs-sm tabs-scroll" role="tablist" aria-label="파트너 상세" style={{ padding: "0 14px" }}>
              <button className="tab is-active" type="button" role="tab" aria-selected="true" id="st-t1" aria-controls="st-p1">계약</button>
              {' '}
              <button className="tab" type="button" role="tab" aria-selected="false">판매자 정보</button>
              {' '}
              <button onClick={() => go?.('결제사 등록 탭')} className="tab" type="button" role="tab" aria-selected="false">결제사 등록</button>
              {' '}
              <button className="tab" type="button" role="tab" aria-selected="false">공연정보 전송</button>
            </div>
            <div className="widget-body" id="st-p1" role="tabpanel" aria-labelledby="st-t1" style={{ gap: "14px" }}>
              <div className="row" style={{ gap: "16px" }}>
                <Link to="/sale-reviews/prd-lumen-2026" className="link-more">
                  판매 승인
                  <i className="ic ic-chevron-right" aria-hidden="true" />
                </Link>
                <Link to="/partners" className="link-more">
                  파트너 계정
                  <i className="ic ic-chevron-right" aria-hidden="true" />
                </Link>
              </div>
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
              <div style={{ display: "grid", gridTemplateColumns: "repeat(2,minmax(0,1fr))", gap: "8px" }}>
                <div className="stat" style={{ padding: "12px 14px" }}>
                  <span className="stat-label">중개수수료율</span>
                  <span className="stat-value">10.0%</span>
                  {v.isPending ? (
                    <>
                      <span className="badge badge-warning" style={{ alignSelf: "flex-start" }}>승인 대기 9.0%</span>
                    </>
                  ) : null}
                  <span className="stat-meta">판매 대금에서 환급을 뺀 금액에 곱합니다.</span>
                </div>
                <div className="stat" style={{ padding: "12px 14px" }}>
                  <span className="stat-label">계약 보증</span>
                  <span className="stat-value">10%</span>
                  <span className="stat-meta">회차 예상 매출 기준</span>
                  <span className="stat-meta">미수금을 상계로 받지 못하면 보증에서 충당합니다.</span>
                </div>
              </div>
              <div className="banner banner-info">
                <i className="ic ic-info" aria-hidden="true" />
                <div className="banner-body">수수료율·보증 변경은 operator가 요청하고 commander가 승인합니다(2인). 바뀐 수수료율은 승인 뒤 판매 승인을 받는 공연부터 쓰고, 판매 승인 때 공연에 고정됩니다.</div>
              </div>
              <div className="banner banner-info bigscreen" role="note">
                <i className="ic ic-monitor" aria-hidden="true" />
                <div className="banner-body">
                  <span className="banner-title">계약 입력과 수수료율·보증 변경 요청은 태블릿이나 데스크톱에서 합니다</span>
                  휴대폰에서는 볼 수만 있습니다
                </div>
                <button onClick={copyLink} className="btn btn-outline btn-sm" type="button">
                  <i className="ic ic-copy" aria-hidden="true" />
                  링크 복사
                </button>
              </div>
              <section className="col" style={{ gap: "8px" }} aria-labelledby="h-fix">
                <div className="row between wrap" style={{ gap: "4px 8px" }}>
                  <h3 className="t-sm fw-b" id="h-fix">공연에 고정된 수수료율</h3>
                  <Link to="/partners" className="link-more">
                    이 파트너 공연 모두
                    <i className="ic ic-chevron-right" aria-hidden="true" />
                  </Link>
                </div>
                <div className="card col" style={{ gap: "4px", padding: "12px 14px" }}>
                  <div className="row between" style={{ gap: "8px" }}>
                    <span className="t-sm fw-b">LUMEN 콘서트 2026 서울</span>
                    <span className="t-sm fw-b num">10.0%</span>
                  </div>
                  <span className="t-xs muted">고정한 때 · 판매 승인 [일시]</span>
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
        </div>
      </>
    ) : null}
    {' '}
    {v.isPB ? (
      <>
        <div className="col" style={{ gap: "6px" }}>
          <p className="eyebrow">선택한 파트너</p>
          <section className="widget" role="region" aria-labelledby="h-pb">
            <div className="widget-head"><h2 className="t-sm fw-b" id="h-pb">[예시 파트너 B]</h2></div>
            <div className="tabs tabs-sm tabs-scroll" role="tablist" aria-label="파트너 상세" style={{ padding: "0 14px" }}>
              <button onClick={() => go?.('계약(기본)')} className="tab" type="button" role="tab" aria-selected="false">계약</button>
              {' '}
              <button className="tab" type="button" role="tab" aria-selected="false">판매자 정보</button>
              {' '}
              <button className="tab is-active" type="button" role="tab" aria-selected="true" id="pb-t3" aria-controls="pb-p3">결제사 등록</button>
              {' '}
              <button className="tab" type="button" role="tab" aria-selected="false">공연정보 전송</button>
            </div>
            <div className="widget-body" id="pb-p3" role="tabpanel" aria-labelledby="pb-t3" style={{ gap: "14px" }}>
              <div className="row" style={{ gap: "16px" }}>
                <Link to="/sale-reviews/prd-lumen-2026" className="link-more">
                  판매 승인
                  <i className="ic ic-chevron-right" aria-hidden="true" />
                </Link>
                <Link to="/partners" className="link-more">
                  파트너 계정
                  <i className="ic ic-chevron-right" aria-hidden="true" />
                </Link>
              </div>
              <section className="card-flat col" style={{ gap: "10px", padding: "14px" }} aria-labelledby="h-pb-ts">
                <div className="row between wrap" style={{ gap: "8px" }}>
                  <h3 className="t-sm fw-b" id="h-pb-ts">토스페이먼츠 셀러</h3>
                  <div className="row wrap" style={{ gap: "6px" }}>
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
              <section className="card-flat row between" style={{ padding: "14px" }} aria-labelledby="h-pb-po">
                <h3 className="t-sm fw-b" id="h-pb-po">포트원 파트너</h3>
                <span className="badge badge-success">등록됨</span>
              </section>
              <section className="card-flat col" style={{ gap: "10px", padding: "14px" }} aria-labelledby="h-pb-ac">
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
        </div>
      </>
    ) : null}
    <details className="widget">
      <summary className="widget-head">
        <span>계약·정산 기준</span>
        <span className="fold-meta"><i className="ic ic-chevron-down fold-ic" aria-hidden="true" /></span>
      </summary>
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
    </details>
    </>
  );
}

