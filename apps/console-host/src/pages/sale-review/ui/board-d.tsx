// 디자인 캔버스 보드 SCR-048-d.dc.html를 옮긴 것(dc2tsx 생성 뒤 손질)
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

export const STATES_D = ["확인", "재승인", "승인 불가", "승인 불가 · 채널 미준비", "대형 간격 충돌", "기본 비율", "승인 뒤", "규모 올리기 검토", "올리기 간격 충돌 — operator", "올리기 간격 충돌 — commander", "규모 올리기 닫힘", "판매 중지 요청", "판매 중지 승인 대기", "판매 중지됨", "재개할 수 없는 회차"] as const;
export const DEFAULT_D = "확인";

export function valsD(state: string) {
    let st = state || '확인';
    let re = st === '재승인';
    let no = st === '승인 불가';
    let gap = st === '대형 간격 충돌';
    let def = st === '기본 비율';
    let aOk = st === '승인 뒤';
    let aHi = st === '규모 올리기 검토';
    let gOp = st === '올리기 간격 충돌 — operator';
    let gCmd = st === '올리기 간격 충돌 — commander';
    let closed = st === '규모 올리기 닫힘';
    let after = aOk || aHi || gOp || gCmd || closed;
    let ch = st === '승인 불가 · 채널 미준비';
    let sReq = st === '판매 중지 요청';
    let sPend = st === '판매 중지 승인 대기';
    let sOn = st === '판매 중지됨';
    let sNo = st === '재개할 수 없는 회차';
    let sus = sReq || sPend || sOn || sNo;
    let tabOk = sReq || sPend;
    let tabSus = sOn || sNo;
    return {
      isRe: re,
      notRe: !re,
      isPend: !re && !after && !sus,
      pre: !after && !sus,
      after: after,
      blocked: no,
      canApprove: !no,
      isGap: gap,
      scaleMid: !gap,
      approveOn: !no && !gap && !ch,
      chNo: ch,
      chOk: !ch,
      allOk: !no && !ch,
      sus: sus,
      notSus: !sus,
      susLive: sReq,
      susPend: sPend,
      susOn: tabSus,
      susBefore: tabOk,
      susOkTab: tabOk,
      dlgSus: sReq,
      dlgResume: sNo,
      tWait: sus ? 'false' : 'true',
      tWaitCls: sus ? '' : 'is-active',
      tOk: tabOk ? 'true' : 'false',
      tOkCls: tabOk ? 'is-active' : '',
      tSus: tabSus ? 'true' : 'false',
      tSusCls: tabSus ? 'is-active' : '',
      nWait: (after || sus) ? '0' : '1',
      nOk: (after || tabOk) ? '4' : '3',
      nSus: tabSus ? '1' : '0',
      ratioPast: !def,
      ratioDef: def,
      fcLow: aOk || closed,
      fcHigh: aHi || gOp || gCmd,
      showReview: aHi || gOp || gCmd,
      raiseOpen: aOk || aHi,
      raiseGapOp: gOp,
      raiseGapCmd: gCmd,
      raiseClosed: closed,
      asMinho: !gCmd,
      asSujin: gCmd,
      c3cls: re ? 'card is-selected' : 'card-flat',
      cellCls: re ? 'card is-selected' : ''
    };
  }

type V = ReturnType<typeof valsD>;

// 보드 루트: {"class": "pk dark cs", "style": "width:100%;min-height:1940px;grid-template-rows:auto 1fr"}

// <main class="cs-main" id="main">
export function MainD({ v, close, go }: { v: V; close?: () => void; go?: (state: string) => void }) {
  void v; void close; void go;
  const ro = useRo();
  return (
    <>
    <div className="page-head">
      <div className="col" style={{ gap: "4px" }}>
        <h1>판매 승인</h1>
        <p className="t-sm muted">파트너가 등록한 공연을 확인 항목 6가지로 점검해 공개를 허락합니다. 승인을 받은 공연만 공개하고 오픈을 예약할 수 있습니다.</p>
      </div>
      <div className="row" style={{ gap: "6px" }}>
        {v.pre ? (
          <>
            <span className="badge badge-lg badge-warning">승인 대기 1</span>
          </>
        ) : null}
        {v.after ? (
          <>
            <span className="badge badge-lg">승인 대기 0</span>
          </>
        ) : null}
      </div>
    </div>
    <div style={{ display: "grid", gridTemplateColumns: "repeat(12,minmax(0,1fr))", gap: "16px", alignItems: "start" }}>
      <section className="widget span-4" aria-labelledby="sl-h">
        <div className="widget-head"><h2 className="t-sm fw-b" id="sl-h">공연 목록</h2></div>
        <div className="widget-body" style={{ gap: "12px" }}>
          <div className="tabs tabs-sm" role="tablist" aria-label="판매 승인 목록">
            <button onClick={() => go?.('확인')} className={`tab ${v.tWaitCls}`} type="button" role="tab" aria-selected={(v.tWait) as AriaBool}>
              승인 대기{' '}
              <span className="badge">{v.nWait}</span>
            </button>
            {' '}
            <button onClick={() => go?.('판매 중지 승인 대기')} className={`tab ${v.tOkCls}`} type="button" role="tab" aria-selected={(v.tOk) as AriaBool}>
              승인됨{' '}
              <span className="badge">{v.nOk}</span>
            </button>
            {' '}
            <button onClick={() => go?.('판매 중지됨')} className={`tab ${v.tSusCls}`} type="button" role="tab" aria-selected={(v.tSus) as AriaBool}>
              판매 중지{' '}
              <span className="badge">{v.nSus}</span>
            </button>
          </div>
          {v.pre ? (
            <>
              <table className="table dense">
                <caption className="sr-only">승인 대기 공연</caption>
                <thead>
                  <tr>
                    <th scope="col">공연</th>
                    <th scope="col">첫 오픈 KST</th>
                    <th scope="col">제출 KST</th>
                    <th scope="col">상태</th>
                  </tr>
                </thead>
                <tbody>
                  <tr className="is-selected" aria-selected="true">
                    <td>
                      <Link to="/sale-reviews/prd-lumen-2026" className="fw-b" style={{ color: "inherit" }} aria-current="true">팬미팅</Link>
                      <span className="t-xs muted" style={{ display: "block" }}>(주)스텔라엔터테인먼트</span>
                    </td>
                    <td className="num">
                      10/28(수)
                      <span style={{ display: "block" }}>20:00</span>
                    </td>
                    <td className="num">
                      {v.notRe ? (
                        <>
                          <span>
                            10/16(금)
                            <span style={{ display: "block" }}>15:40</span>
                          </span>
                        </>
                      ) : null}
                      {v.isRe ? (
                        <>
                          <span>
                            10/19(월)
                            <span style={{ display: "block" }}>17:25</span>
                          </span>
                        </>
                      ) : null}
                    </td>
                    <td>
                      {v.notRe ? (
                        <>
                          <span className="badge badge-warning">승인 대기</span>
                        </>
                      ) : null}
                      {v.isRe ? (
                        <>
                          <span className="badge badge-primary">재승인</span>
                        </>
                      ) : null}
                    </td>
                  </tr>
                </tbody>
              </table>
            </>
          ) : null}
          {' '}
          {v.after ? (
            <>
              <p className="t-sm muted" role="status" style={{ padding: "12px 0", textAlign: "center" }}>승인 대기 공연이 없습니다</p>
            </>
          ) : null}
          {' '}
          {v.susOkTab ? (
            <>
              <ul className="col" aria-label="승인된 공연">
                <li className="li">
                  <span className="col grow" style={{ gap: "2px" }}>
                    <span className="t-sm fw-m">팬미팅</span>
                    <span className="t-xs muted">2026-10-16 승인 · 1회차 중형</span>
                  </span>
                  <span className="badge badge-success">승인</span>
                </li>
                <li className="li">
                  <span className="col grow" style={{ gap: "2px" }}>
                    <span className="t-sm fw-m">LUMEN 콘서트 2026 서울</span>
                    <span className="t-xs muted">2026-10-08 승인 · 판매 중</span>
                  </span>
                  <span className="badge badge-success">승인</span>
                </li>
                <li className="li card is-selected" aria-current="true" style={{ padding: "8px 10px" }}>
                  <span className="col grow" style={{ gap: "2px" }}>
                    <span className="t-sm fw-b">가을 야외 페스티벌</span>
                    <span className="t-xs muted">2026-10-02 승인 · 회차 2개 판매 중</span>
                  </span>
                  {v.susLive ? (
                    <>
                      <span className="badge badge-success">승인</span>
                    </>
                  ) : null}
                  {v.susPend ? (
                    <>
                      <span className="badge badge-warning">판매 중지 승인 대기</span>
                    </>
                  ) : null}
                </li>
                <li className="li">
                  <span className="col grow" style={{ gap: "2px" }}>
                    <span className="t-sm fw-m">소극장 뮤지컬</span>
                    <span className="t-xs muted">전석 매진</span>
                  </span>
                  <span className="badge badge-success">승인</span>
                </li>
              </ul>
            </>
          ) : null}
          {' '}
          {v.susOn ? (
            <>
              <ul className="col" aria-label="판매 중지된 공연">
                <li className="li card is-selected" aria-current="true" style={{ padding: "8px 10px" }}>
                  <span className="col grow" style={{ gap: "2px" }}>
                    <span className="t-sm fw-b">가을 야외 페스티벌</span>
                    <span className="t-xs muted">사유: 판매자 신원 확인 필요 · 10/16(금) 11:30 KST 판매 중지</span>
                  </span>
                  <span className="badge badge-danger">판매 중지</span>
                </li>
              </ul>
            </>
          ) : null}
          <p className="t-xs muted">파트너가 공연 등록 5단계에서 판매 승인을 요청하면 이 목록에 올라옵니다. 승인 뒤 가격·회차·좌석 등급·판매 정책이 바뀌면 재승인으로 다시 올라옵니다.</p>
          {v.notSus ? (
            <>
              <div className="col" style={{ gap: "2px" }}>
                <span className="eyebrow">최근 처리</span>
                <ul className="col">
                  {v.after ? (
                    <>
                      <li className="li card is-selected" aria-current="true" style={{ padding: "8px 10px" }}>
                        <span className="col grow" style={{ gap: "2px" }}>
                          <span className="t-sm fw-b">팬미팅</span>
                          <span className="t-xs muted">2026-10-16 승인 · 공연 규모 중형</span>
                        </span>
                        <span className="badge badge-success">승인</span>
                      </li>
                    </>
                  ) : null}
                  <li className="li">
                    <span className="col grow" style={{ gap: "2px" }}>
                      <span className="t-sm fw-m">LUMEN 콘서트 2026 서울</span>
                      <span className="t-xs muted">2026-10-08 승인 · 공연 규모 대형</span>
                    </span>
                    <span className="badge badge-success">승인</span>
                  </li>
                  <li className="li">
                    <span className="col grow" style={{ gap: "2px" }}>
                      <span className="t-sm fw-m">가을 야외 페스티벌</span>
                      <span className="t-xs muted">판매 중</span>
                    </span>
                    <span className="badge badge-success">승인</span>
                  </li>
                  <li className="li">
                    <span className="col grow" style={{ gap: "2px" }}>
                      <span className="t-sm fw-m">소극장 뮤지컬</span>
                      <span className="t-xs muted">전석 매진</span>
                    </span>
                    <span className="badge badge-success">승인</span>
                  </li>
                </ul>
              </div>
            </>
          ) : null}
        </div>
      </section>
      {v.notSus ? (
        <>
          <section className="widget span-8" aria-labelledby="sp-h">
            <div className="widget-head">
              <h2 className="t-sm fw-b" id="sp-h">확인 패널 · 팬미팅</h2>
              {v.isPend ? (
                <>
                  <span className="badge badge-warning">승인 대기</span>
                </>
              ) : null}
              {' '}
              {v.isRe ? (
                <>
                  <span className="badge badge-primary">재승인</span>
                </>
              ) : null}
              {' '}
              {v.after ? (
                <>
                  <span className="badge badge-success">승인</span>
                </>
              ) : null}
              <div className="actions">
                <Link to="/partners" className="link-more">
                  파트너사 정보
                  <i className="ic ic-chevron-right" aria-hidden="true" />
                </Link>
              </div>
            </div>
            <div className="widget-body" style={{ gap: "16px" }}>
              {v.isPend ? (
                <>
                  <p className="t-sm muted">(주)스텔라엔터테인먼트 · 피켓 아레나 · 사전 셔플 · 좌석 직접 선택 · 첫 오픈 10/28(수) 20:00 KST · 제출 10/16(금) 15:40 KST</p>
                </>
              ) : null}
              {' '}
              {v.after ? (
                <>
                  <p className="t-sm muted">(주)스텔라엔터테인먼트 · 피켓 아레나 · 사전 셔플 · 좌석 직접 선택 · 첫 오픈 10/28(수) 20:00 KST · 승인 10/16(금) 18:10 KST</p>
                </>
              ) : null}
              {' '}
              {v.isRe ? (
                <>
                  <p className="t-sm muted">
                    (주)스텔라엔터테인먼트 · 피켓 아레나 · 사전 셔플 · 좌석 직접 선택 · 첫 오픈 10/28(수) 20:00 KST · 처음 승인 10/16(금) 18:10 KST · 재승인 요청 10/19(월) 17:25 KST
                  </p>
                </>
              ) : null}
              <div className="banner banner-info">
                <i className="ic ic-info" aria-hidden="true" />
                <div className="banner-body">판매 조건은 파트너가 정합니다. 확인과 반려만 할 수 있습니다</div>
              </div>
              {v.isRe ? (
                <>
                  <div className="banner banner-warning">
                    <i className="ic ic-refresh" aria-hidden="true" />
                    <div className="banner-body">
                      <span className="banner-title">재승인 대상입니다</span>
                      승인 뒤 파트너가 바꾼 항목: 회차(1개 추가), 판매 정책(규칙 1개 추가). 바뀐 곳에 '바뀜'을 붙였습니다. 다시 승인할 때까지 오픈 예약이 멈춰 있습니다.
                    </div>
                  </div>
                </>
              ) : null}
              {' '}
              {v.showReview ? (
                <>
                  <div className="banner banner-warning" role="status">
                    <i className="ic ic-alert" aria-hidden="true" />
                    <div className="banner-body" style={{ flexBasis: "200px" }}>예상 진입 상단(52만 명)이 지금 등급(중형)의 상한을 넘었습니다. 규모를 올릴지 검토하세요</div>
                    <a className="btn btn-outline btn-sm" href="#su-h">규모 올리기</a>
                  </div>
                </>
              ) : null}
              <div style={{ display: "grid", gridTemplateColumns: "repeat(2,minmax(0,1fr))", gap: "20px", alignItems: "start" }}>
                <section className="col" style={{ gap: "8px" }} aria-labelledby="ck-h">
                  <div className="row between">
                    <h3 className="eyebrow" id="ck-h">확인 항목 6가지</h3>
                    {v.allOk ? (
                      <>
                        <span className="t-xs muted">6/6 확인</span>
                      </>
                    ) : null}
                    {v.blocked ? (
                      <>
                        <span className="t-xs tx-danger">4/6 확인 · 2개 확인 불가</span>
                      </>
                    ) : null}
                    {v.chNo ? (
                      <>
                        <span className="t-xs tx-danger">5/6 확인 · 1개 확인 불가</span>
                      </>
                    ) : null}
                  </div>
                  <ol className="col" style={{ gap: "8px" }}>
                    <li className="card-flat pad col" style={{ gap: "8px" }}>
                      {v.canApprove ? (
                        <>
                          <div className="check-row">
                            <input className="cb" type="checkbox" id="c1" defaultChecked aria-describedby="c1-d" />
                            <label className="t-sm fw-b" htmlFor="c1">판매자 신원정보와 사업자 진위</label>
                          </div>
                        </>
                      ) : null}
                      {' '}
                      {v.blocked ? (
                        <>
                          <div className="check-row">
                            <input className="cb" type="checkbox" id="c1-no" disabled aria-describedby="c1-d c1-e" />
                            <label className="t-sm fw-b" htmlFor="c1-no">판매자 신원정보와 사업자 진위</label>
                            <span className="badge badge-danger" style={{ marginLeft: "auto" }}>확인 불가</span>
                          </div>
                        </>
                      ) : null}
                      <div className="col" id="c1-d" style={{ gap: "2px", paddingLeft: "32px" }}>
                        <span className="t-sm">사업자 진위: 계속사업자(예시)</span>
                        {' '}
                        <span className="t-xs muted">조회 10/16(금) 15:41 KST · 7항목은 판매자 고지 미리보기에</span>
                        {' '}
                        {v.canApprove ? (
                          <>
                            <span className="t-sm">통신판매업 신고번호 [예시]</span>
                          </>
                        ) : null}
                        {' '}
                        {v.blocked ? (
                          <>
                            <span className="error-msg" id="c1-e">
                              <i className="ic ic-alert-circle" aria-hidden="true" />
                              통신판매업 신고번호와 면제 근거가 모두 없습니다
                            </span>
                          </>
                        ) : null}
                      </div>
                    </li>
                    <li className="card-flat pad col" style={{ gap: "6px" }}>
                      <div className="check-row">
                        <input className="cb" type="checkbox" id="c2" defaultChecked aria-describedby="c2-d" />
                        <label className="t-sm fw-b" htmlFor="c2">표시 사항(휠체어석 확인 포함)과 공연예술통합전산망 10개 항목</label>
                        <span className="grow" />
                        {v.isRe ? (
                          <>
                            <span className="badge badge-warning">바뀜</span>
                          </>
                        ) : null}
                      </div>
                      <ul className="col" id="c2-d" aria-label="표시 사항과 공연예술통합전산망 10개 항목" style={{ gap: "4px", paddingLeft: "32px" }}>
                        <li className="t-sm">
                          <span className="muted">명칭·종류</span>
                          {' '}팬미팅 · 팬미팅
                        </li>
                        <li className={`t-sm ${v.cellCls}`} style={{ padding: "2px 6px", margin: "0 -6px" }}>
                          <span className="muted">기간·장소</span>
                          {' '}
                          {v.notRe ? (
                            <>
                              <span>[회차 일시] · 피켓 아레나</span>
                            </>
                          ) : null}
                          {v.isRe ? (
                            <>
                              <span>
                                <span className="badge badge-warning">바뀜</span>
                                {' '}회차 1개 → 2개 · [회차 일시] · [추가 회차 일시] · 피켓 아레나
                              </span>
                            </>
                          ) : null}
                        </li>
                        <li className="t-sm">
                          <span className="muted">시간</span>
                          {' '}[공연 시간] ·{' '}
                          <span className="muted">관람 가능 연령</span>
                          {' '}[관람 연령]
                        </li>
                        <li className="t-sm">
                          <span className="muted">출연진·제작진·기획사·제작사</span>
                          {' '}[출연진] · (주)스텔라엔터테인먼트
                        </li>
                        <li className="t-sm">
                          <span className="muted">좌석 등급·요금</span>
                          {' '}[등급별 요금]
                        </li>
                        <li className="t-sm">
                          <span className="muted">입장권 판매처</span>
                          {' '}PEAKET(통신판매중개)
                        </li>
                        <li className="t-sm">
                          <span className="muted">안내 사항</span>
                          {' '}사전 셔플 · 좌석 직접 선택
                        </li>
                        <li className="t-sm">
                          <span className="muted">예매·결제 금액, 관람자 수</span>
                          {' '}판매 뒤 1일 단위로 집계해 보냅니다
                        </li>
                        <li className="t-sm">
                          <span className="muted">휠체어석</span>
                          {' '}20석(기준 20석 이상) · 위치 확인 0석 · 파트너 확인함
                        </li>
                      </ul>
                      <p className="t-xs muted" style={{ paddingLeft: "32px" }}>휠체어석 기준을 지키는 책임은 공연장에 있습니다. 판매 승인에서는 파트너의 확인과 이유가 좌석맵과 맞는지만 봅니다.</p>
                    </li>
                    <li className={`${v.c3cls} pad col`} style={{ gap: "6px" }}>
                      <div className="check-row">
                        <input className="cb" type="checkbox" id="c3" defaultChecked aria-describedby="c3-d" />
                        <label className="t-sm fw-b" htmlFor="c3">판매 정책 상한(공제율·양도)</label>
                        <span className="grow" />
                        {v.isRe ? (
                          <>
                            <span className="badge badge-warning">바뀜</span>
                          </>
                        ) : null}
                      </div>
                      <div className="col" id="c3-d" style={{ gap: "2px", paddingLeft: "32px" }}>
                        <span className="t-sm">취소 공제 표준 공제표 · 양도 허용(마감 규칙 안)</span>
                        {' '}
                        {v.notRe ? (
                          <>
                            <span className="t-sm">판매 정책 규칙: 없음</span>
                          </>
                        ) : null}
                        {' '}
                        {v.isRe ? (
                          <>
                            <span className="t-sm">
                              <span className="muted">이전</span>
                              {' '}규칙 없음 →{' '}
                              <span className="fw-b">지금</span>
                              {' '}규칙 1개(팬클럽 선예매) · 상한 안
                            </span>
                          </>
                        ) : null}
                        {' '}
                        {v.isRe ? (
                          <>
                            <div className="col" style={{ gap: "4px" }} role="group" aria-labelledby="rp-h">
                              <span className="t-xs fw-b" id="rp-h">판매 정책 규칙 미리보기 · 읽기 전용</span>
                              <pre className="code" style={{ margin: "0", padding: "8px 10px", fontSize: "12px", lineHeight: "18px", whiteSpace: "pre-wrap", overflowX: "auto" }}>
                                {"{\n  \"version\": 1,\n  \"name\": \"팬클럽 선예매\",\n  \"rounds\": \"ALL\",\n  \"during\": { \"from\": \"2026-10-27T20:00+09:00\", \"to\": \"2026-10-27T22:00+09:00\" },\n  \"rule\": {\n    \"if\": { \"fact\": \"buyer.lists\", \"has\": \"lumen-fanclub-2026\" },\n    \"then\": { \"limitPerPerson\": 2 },\n    \"else\": { \"deny\": \"PRESALE_ONLY\" }\n  }\n}"}
                              </pre>
                              <span className="t-xs muted">파트너는 규칙을 폼으로만 고칩니다. 여기서는 고칠 수 없습니다.</span>
                            </div>
                          </>
                        ) : null}
                      </div>
                    </li>
                    <li className="card-flat pad col" style={{ gap: "8px" }}>
                      <div className="check-row">
                        <input className="cb" type="checkbox" id="c6" defaultChecked aria-describedby="c6-d" />
                        <label className="t-sm fw-b" htmlFor="c6">아티스트·공연장 연결</label>
                      </div>
                      <div className="col" id="c6-d" style={{ gap: "8px", paddingLeft: "32px" }}>
                        <div className="row wrap" style={{ gap: "6px 8px", alignItems: "center" }}>
                          <span className="t-sm">파트너 입력 'LUMEN'</span>
                          <span aria-hidden="true">→</span>
                          <div className="input-group input-group-sm" style={{ width: "auto" }}>
                            <select id="c6-ar" aria-label="LUMEN에 연결할 아티스트" defaultValue="기존 아티스트 · LUMEN"><option>기존 아티스트 · LUMEN</option></select>
                            <i className="ic ic-chevron-down" aria-hidden="true" />
                          </div>
                          <button className="btn btn-outline btn-sm" type="button" {...ro()}>새로 만들기</button>
                        </div>
                        <div className="row wrap" style={{ gap: "6px 8px", alignItems: "center" }}>
                          <span className="t-sm">파트너 입력 '피켓 아레나'</span>
                          <span aria-hidden="true">→</span>
                          <div className="input-group input-group-sm" style={{ width: "auto" }}>
                            <select id="c6-vn" aria-label="피켓 아레나에 연결할 공연장" defaultValue="기존 공연장 · 피켓 아레나"><option>기존 공연장 · 피켓 아레나</option></select>
                            <i className="ic ic-chevron-down" aria-hidden="true" />
                          </div>
                          <button className="btn btn-outline btn-sm" type="button" {...ro()}>새로 만들기</button>
                        </div>
                        <div className="row wrap" style={{ gap: "6px 8px", alignItems: "center" }}>
                          <button className="btn btn-outline btn-sm" type="button" {...ro('c6-h')}>다른 이름 고치기</button>
                          <span className="t-xs muted" id="c6-h">공연·아티스트·공연장의 다른 이름을 고칩니다. 사유를 꼭 적고 감사 로그에 남습니다.</span>
                        </div>
                      </div>
                    </li>
                    <li className="card-flat pad col" style={{ gap: "6px" }}>
                      {v.chOk ? (
                        <>
                          <div className="check-row">
                            <input className="cb" type="checkbox" id="c4" defaultChecked aria-describedby="c4-d" />
                            <label className="t-sm fw-b" htmlFor="c4">결제사 지정 · 승인하면 이 지정으로 고정됩니다(바꾸려면 명령 12)</label>
                          </div>
                        </>
                      ) : null}
                      {' '}
                      {v.chNo ? (
                        <>
                          <div className="check-row">
                            <input className="cb" type="checkbox" id="c4-no" disabled aria-describedby="c4-d c4-e" />
                            <label className="t-sm fw-b" htmlFor="c4-no">결제사 지정 · 승인하면 이 지정으로 고정됩니다(바꾸려면 명령 12)</label>
                            <span className="badge badge-danger" style={{ marginLeft: "auto" }}>확인 불가</span>
                          </div>
                        </>
                      ) : null}
                      <div className="row wrap" id="c4-d" style={{ gap: "2px 12px", paddingLeft: "32px" }}>
                        <span className="t-sm">토스페이먼츠(기본) · 대체 포트원 · 동시 입장 상한 8,000명 [추정]</span>
                        {' '}
                        <Link to="/commands" className="link-more">
                          명령 12 결제사 지정
                          <i className="ic ic-chevron-right" aria-hidden="true" />
                        </Link>
                        {' '}
                        {v.chNo ? (
                          <>
                            <span className="error-msg" id="c4-e">
                              <i className="ic ic-alert-circle" aria-hidden="true" />
                              결제사 채널이 준비되지 않았습니다. 명령 12로 다른 결제사를 지정하세요
                            </span>
                          </>
                        ) : null}
                      </div>
                    </li>
                    <li className="card-flat pad col" style={{ gap: "6px" }}>
                      {v.canApprove ? (
                        <>
                          <div className="check-row">
                            <input className="cb" type="checkbox" id="c5" defaultChecked aria-describedby="c5-d" />
                            <label className="t-sm fw-b" htmlFor="c5">결제사 지급대행 등록과 예금주 일치</label>
                          </div>
                        </>
                      ) : null}
                      {' '}
                      {v.blocked ? (
                        <>
                          <div className="check-row">
                            <input className="cb" type="checkbox" id="c5-no" disabled aria-describedby="c5-d c5-e" />
                            <label className="t-sm fw-b" htmlFor="c5-no">결제사 지급대행 등록과 예금주 일치</label>
                            <span className="badge badge-danger" style={{ marginLeft: "auto" }}>확인 불가</span>
                          </div>
                        </>
                      ) : null}
                      <div className="col" id="c5-d" style={{ gap: "4px", paddingLeft: "32px" }}>
                        <div className="row wrap" style={{ gap: "4px 6px" }}>
                          <span className="t-sm">토스페이먼츠 셀러</span>
                          <span className="badge badge-success">부분 승인</span>
                          {' '}
                          <span className="t-sm">포트원 파트너</span>
                          {v.canApprove ? (
                            <>
                              <span className="badge badge-success">등록됨</span>
                            </>
                          ) : null}
                          {v.blocked ? (
                            <>
                              <span className="badge badge-danger">미등록</span>
                            </>
                          ) : null}
                          {' '}
                          <span className="t-sm">예금주</span>
                          <span className="badge badge-success">일치</span>
                        </div>
                        <span className="t-sm">정산 계좌 [은행] · 끝 4자리 [0000]</span>
                        {' '}
                        {v.blocked ? (
                          <>
                            <span className="error-msg" id="c5-e">
                              <i className="ic ic-alert-circle" aria-hidden="true" />
                              결제사 지급대행 등록이 끝나지 않았습니다(포트원 파트너 미등록)
                            </span>
                          </>
                        ) : null}
                        {' '}
                        <span className="t-xs muted">PEAKET에는 은행과 끝 4자리만 남깁니다. 토스페이먼츠 셀러가 부분 승인 이상이어야 승인이 끝납니다.</span>
                      </div>
                    </li>
                  </ol>
                </section>
                <div className="col" style={{ gap: "18px" }}>
                  {v.pre ? (
                    <>
                      <fieldset className="col" style={{ gap: "8px" }}>
                        <legend className="label" style={{ marginBottom: "8px" }}>회차마다 공연 규모 (필수)</legend>
                        <span className="t-sm fw-b">1회차 · 10/28(수) 20:00 오픈</span>
                        {' '}
                        {v.scaleMid ? (
                          <>
                            <div className="row" role="radiogroup" aria-label="1회차 공연 규모" style={{ gap: "20px" }}>
                              <label className="check-row">
                                <input className="rd" type="radio" name="scale" aria-describedby="scale-h" />
                                <span className="t-sm">대형</span>
                              </label>
                              {' '}
                              <label className="check-row">
                                <input className="rd" type="radio" name="scale" defaultChecked aria-describedby="scale-h" />
                                <span className="t-sm">중형</span>
                              </label>
                              {' '}
                              <label className="check-row">
                                <input className="rd" type="radio" name="scale" aria-describedby="scale-h" />
                                <span className="t-sm">소형</span>
                              </label>
                            </div>
                          </>
                        ) : null}
                        {' '}
                        {v.isGap ? (
                          <>
                            <div className="row" role="radiogroup" aria-label="1회차 공연 규모" style={{ gap: "20px" }}>
                              <label className="check-row">
                                <input className="rd" type="radio" name="scale" id="scale-lg" defaultChecked aria-invalid="true" aria-describedby="gap-e scale-h" />
                                <span className="t-sm">대형</span>
                              </label>
                              {' '}
                              <label className="check-row">
                                <input className="rd" type="radio" name="scale" aria-describedby="scale-h" />
                                <span className="t-sm">중형</span>
                              </label>
                              {' '}
                              <label className="check-row">
                                <input className="rd" type="radio" name="scale" aria-describedby="scale-h" />
                                <span className="t-sm">소형</span>
                              </label>
                            </div>
                            <span className="error-msg" id="gap-e">
                              <i className="ic ic-alert-circle" aria-hidden="true" />
                              다른 대형 공연([공연명], 10/28(수) 20:20 KST)과 30분 안이라 대형으로 승인할 수 없습니다. 오픈 시각을 바꾸도록 반려해 주세요
                            </span>
                          </>
                        ) : null}
                        {' '}
                        {v.isRe ? (
                          <>
                            <span className="row" style={{ gap: "6px" }}>
                              <span className="t-sm fw-b">2회차 · [추가 회차 일시]</span>
                              <span className="badge badge-warning">바뀜</span>
                            </span>
                            <div className="row wrap" role="radiogroup" aria-label="2회차 공연 규모" style={{ gap: "8px 20px" }}>
                              <label className="check-row">
                                <input className="rd" type="radio" name="scale2" aria-describedby="scale-h" />
                                <span className="t-sm">대형</span>
                              </label>
                              {' '}
                              <label className="check-row">
                                <input className="rd" type="radio" name="scale2" defaultChecked aria-describedby="scale-h" />
                                <span className="t-sm">중형</span>
                              </label>
                              {' '}
                              <label className="check-row">
                                <input className="rd" type="radio" name="scale2" aria-describedby="scale-h" />
                                <span className="t-sm">소형</span>
                              </label>
                            </div>
                          </>
                        ) : null}
                        {' '}
                        <span className="hint" id="scale-h">CDN 준비량과 변경 동결 창의 기준이 됩니다. 대형이면 다른 대형 공연과 오픈 30분 간격을 검사합니다.</span>
                        <div className="card-flat pad col" style={{ gap: "6px" }} role="group" aria-labelledby="fc-h">
                          <span className="eyebrow" id="fc-h">수요 예측 · 1회차</span>
                          <p className="t-sm">
                            오픈 알림 구독{' '}
                            <span className="num fw-b">82,400명</span>
                            {' '}× 구독 대비 진입 비율(
                            {v.ratioPast ? (
                              <>
                                <span>중앙 2.1·상단 3.4, 비슷한 지난 회차 37개</span>
                              </>
                            ) : null}
                            {v.ratioDef ? (
                              <>
                                <span>중앙 2.0·상단 3.0</span>
                              </>
                            ) : null}
                            )
                          </p>
                          <p className="row wrap t-sm" style={{ gap: "4px 6px" }}>
                            <span aria-hidden="true">→</span>
                            <span>
                              예상 진입{' '}
                              {v.ratioPast ? (
                                <>
                                  <span className="num fw-b">17만~28만 명</span>
                                </>
                              ) : null}
                              {v.ratioDef ? (
                                <>
                                  <span className="num fw-b">16만~25만 명</span>
                                </>
                              ) : null}
                            </span>
                            <span>· 제안</span>
                            <span className="badge badge-primary">중형</span>
                            {v.ratioDef ? (
                              <>
                                <span className="badge badge-warning">기본 비율</span>
                              </>
                            ) : null}
                          </p>
                          {v.ratioDef ? (
                            <>
                              <span className="hint">비슷한 지난 회차가 10개보다 적어 기본 비율(중앙 2.0·상단 3.0)로 계산했습니다</span>
                            </>
                          ) : null}
                          {' '}
                          <span className="t-xs muted">수요 예측과 규모는 회차마다 따로 정합니다.</span>
                        </div>
                      </fieldset>
                    </>
                  ) : null}
                  {' '}
                  {v.after ? (
                    <>
                      <section className="col" style={{ gap: "10px" }} aria-labelledby="su-h">
                        <h3 className="eyebrow" id="su-h">1회차 공연 규모 · 승인 뒤에는 올리기만</h3>
                        <p className="row wrap" style={{ gap: "6px 8px" }}>
                          <span className="badge badge-lg">중형</span>
                          <span className="t-xs muted">승인 10/16(금) 18:10 KST에 정함</span>
                        </p>
                        <div className="card-flat pad col" style={{ gap: "6px" }} role="group" aria-labelledby="fc2-h">
                          <span className="eyebrow" id="fc2-h">수요 예측</span>
                          {' '}
                          {v.fcLow ? (
                            <>
                              <p className="t-sm">
                                오픈 알림 구독{' '}
                                <span className="num fw-b">118,000명</span>
                                {' '}× 구독 대비 진입 비율(중앙 2.1·상단 3.4, 비슷한 지난 회차 33개)
                              </p>
                              <p className="row wrap t-sm" style={{ gap: "4px 6px" }}>
                                <span aria-hidden="true">→</span>
                                <span>
                                  예상 진입{' '}
                                  <span className="num fw-b">25만~40만 명</span>
                                </span>
                                <span>· 제안</span>
                                <span className="badge badge-primary">중형</span>
                              </p>
                            </>
                          ) : null}
                          {' '}
                          {v.fcHigh ? (
                            <>
                              <p className="t-sm">
                                오픈 알림 구독{' '}
                                <span className="num fw-b">153,000명</span>
                                {' '}× 구독 대비 진입 비율(중앙 2.1·상단 3.4, 비슷한 지난 회차 29개)
                              </p>
                              <p className="row wrap t-sm" style={{ gap: "4px 6px" }}>
                                <span aria-hidden="true">→</span>
                                <span>
                                  예상 진입{' '}
                                  <span className="num fw-b">32만~52만 명</span>
                                </span>
                                <span>· 제안</span>
                                <span className="badge badge-primary">대형</span>
                              </p>
                            </>
                          ) : null}
                        </div>
                        {v.raiseOpen ? (
                          <>
                            <div className="field">
                              <label className="label" htmlFor="su-r">
                                올리는 사유{' '}
                                <span className="opt">(필수)</span>
                              </label>
                              {' '}
                              <textarea className="textarea" id="su-r" style={{ minHeight: "64px" }} placeholder="예: 오픈 알림 구독이 예상보다 빨리 늘었습니다" aria-describedby="su-hint" />
                            </div>
                            <div className="row wrap" style={{ gap: "8px", alignItems: "center" }}>
                              <span className="t-sm">올릴 등급</span>
                              <span className="badge badge-primary">대형</span>
                              <button className="btn btn-outline" type="button" {...ro('su-hint')}>규모 올리기</button>
                            </div>
                            <span className="hint" id="su-hint">T-30분 점검 전까지 올리기만 할 수 있습니다. 대형으로 올리면 다른 대형 공연과 오픈 30분 간격을 검사합니다.</span>
                          </>
                        ) : null}
                        {' '}
                        {v.raiseGapOp ? (
                          <>
                            <div className="field">
                              <label className="label" htmlFor="su-r2">
                                올리는 사유{' '}
                                <span className="opt">(필수)</span>
                              </label>
                              {' '}
                              <textarea className="textarea" id="su-r2" style={{ minHeight: "64px" }} defaultValue="오픈 알림 구독이 15만 명을 넘어 예상 진입 상단이 52만 명입니다." />
                            </div>
                            <div className="row wrap" style={{ gap: "8px", alignItems: "center" }}>
                              <span className="t-sm">올릴 등급</span>
                              <span className="badge badge-primary">대형</span>
                              <button className="btn btn-outline" type="button" aria-disabled="true" aria-describedby="su-e">규모 올리기</button>
                            </div>
                            <span className="error-msg" id="su-e" role="alert">
                              <i className="ic ic-alert-circle" aria-hidden="true" />
                              다른 대형 공연([공연명], 10/28(수) 20:20 KST)과 30분 안입니다. commander의 간격 예외가 필요합니다
                            </span>
                          </>
                        ) : null}
                        {' '}
                        {v.raiseGapCmd ? (
                          <>
                            <div className="field">
                              <label className="label" htmlFor="su-r3">
                                올리는 사유{' '}
                                <span className="opt">(필수)</span>
                              </label>
                              {' '}
                              <textarea className="textarea" id="su-r3" style={{ minHeight: "64px" }} aria-describedby="su-xh" defaultValue="오픈 알림 구독이 15만 명을 넘어 예상 진입 상단이 52만 명입니다." />
                            </div>
                            <span className="error-msg" id="su-e2" role="alert">
                              <i className="ic ic-alert-circle" aria-hidden="true" />
                              다른 대형 공연([공연명], 10/28(수) 20:20 KST)과 30분 안입니다
                            </span>
                            <div className="row wrap" style={{ gap: "8px", alignItems: "center" }}>
                              <span className="t-sm">올릴 등급</span>
                              <span className="badge badge-primary">대형</span>
                              <button className="btn btn-outline" type="button" {...ro('su-e2 su-xh')}>간격 예외로 올리기</button>
                            </div>
                            <span className="hint" id="su-xh">사유를 적어야 합니다. 누르면 다시 인증합니다</span>
                          </>
                        ) : null}
                        {' '}
                        {v.raiseClosed ? (
                          <>
                            <div className="row wrap" style={{ gap: "8px", alignItems: "center" }}>
                              <button className="btn btn-outline" type="button" aria-disabled="true" aria-describedby="su-c">규모 올리기</button>
                            </div>
                            <span className="hint" id="su-c">T-30분 점검이 시작되어 규모를 바꿀 수 없습니다</span>
                          </>
                        ) : null}
                        <p className="t-xs muted">규모 올리기는 감사 로그에 남습니다. 올리면 변경 동결 달력이 10분 안에 창을 다시 계산합니다.</p>
                      </section>
                    </>
                  ) : null}
                  <dl className="kv">
                    <dt>중개수수료율</dt>
                    <dd>10.00% · 승인 때 이 공연에 고정</dd>
                  </dl>
                  <div className="banner banner-info">
                    <i className="ic ic-info" aria-hidden="true" />
                    <div className="banner-body">
                      <span className="banner-title">KYC 안내</span>
                      주 1천만 원 이상 첫 지급에서 KYC 때문에 지급이 늦어질 수 있습니다
                    </div>
                  </div>
                  <section className="col" style={{ gap: "8px" }} aria-labelledby="sn-h">
                    <h3 className="eyebrow" id="sn-h">판매자 고지 미리보기 · 공연 상세</h3>
                    <div className="banner banner-legal">
                      <i className="ic ic-scale" aria-hidden="true" />
                      <div className="banner-body">
                        <span className="legal-tag">법정 고지</span>
                        판매자: (주)스텔라엔터테인먼트. PEAKET은 통신판매중개자로서 이 공연의 당사자가 아닙니다. 공연의 개최·변경·취소에 따른 책임은 판매자에게 있고, 예매 취소와 환불은 PEAKET이 처리합니다
                      </div>
                    </div>
                    <dl className="kv" aria-label="판매자 신원정보 7항목">
                      <dt>상호</dt>
                      <dd>(주)스텔라엔터테인먼트</dd>
                      <dt>대표자</dt>
                      <dd>[예시]</dd>
                      <dt>주소</dt>
                      <dd>[예시]</dd>
                      <dt>전화</dt>
                      <dd>[예시]</dd>
                      <dt>전자우편</dt>
                      <dd>[예시]</dd>
                      <dt>사업자등록번호</dt>
                      <dd>[예시]</dd>
                      <dt>통신판매업 신고번호</dt>
                      <dd>
                        {v.canApprove ? (
                          <>
                            <span>[예시]</span>
                          </>
                        ) : null}
                        {v.blocked ? (
                          <>
                            <span className="tx-danger">없음 · 면제 근거 없음</span>
                          </>
                        ) : null}
                      </dd>
                    </dl>
                  </section>
                  {v.after ? (
                    <>
                      <section className="col" style={{ gap: "8px" }} aria-labelledby="ss-h">
                        <h3 className="eyebrow" id="ss-h">판매 중지</h3>
                        <div className="row"><button onClick={() => go?.('판매 중지 요청')} className="btn btn-danger-outline" type="button" {...ro('ss-d')}>판매 중지 요청</button></div>
                        <span className="hint" id="ss-d">판매자 신원·법적 요청·사기 의심으로 공연을 내려야 하면 사유 코드와 사유를 적어 요청합니다. 요청한 분이 아닌 commander가 승인 업무에서 승인합니다.</span>
                      </section>
                    </>
                  ) : null}
                  {' '}
                  {v.pre ? (
                    <>
                      <section className="col" style={{ gap: "10px" }} aria-labelledby="ar-h">
                        <h3 className="eyebrow" id="ar-h">승인 또는 반려 · operator 1인</h3>
                        {v.blocked ? (
                          <>
                            <div className="error-summary" id="ar-why" role="alert">
                              <span className="fw-b">승인할 수 없는 이유 2가지</span>
                              {' '}
                              <a href="#c1-no">통신판매업 신고번호와 면제 근거가 모두 없습니다</a>
                              {' '}
                              <a href="#c5-no">결제사 지급대행 등록이 끝나지 않았습니다(포트원 파트너 미등록)</a>
                              {' '}
                              <span className="t-sm">판매 조건과 판매자 정보는 파트너가 고칩니다. 사유를 적어 반려하세요.</span>
                            </div>
                          </>
                        ) : null}
                        {' '}
                        {v.isGap ? (
                          <>
                            <div className="error-summary" id="gap-why" role="alert">
                              <span className="fw-b">승인할 수 없는 이유 1가지</span>
                              {' '}
                              <a href="#scale-lg">다른 대형 공연([공연명], 10/28(수) 20:20 KST)과 30분 안이라 대형으로 승인할 수 없습니다. 오픈 시각을 바꾸도록 반려해 주세요</a>
                            </div>
                          </>
                        ) : null}
                        {' '}
                        {v.chNo ? (
                          <>
                            <div className="error-summary" id="ch-why" role="alert">
                              <span className="fw-b">승인할 수 없는 이유 1가지</span>
                              {' '}
                              <a href="#c4-no">결제사 채널이 준비되지 않았습니다. 명령 12로 다른 결제사를 지정하세요</a>
                            </div>
                          </>
                        ) : null}
                        {' '}
                        {v.canApprove ? (
                          <>
                            <div className="field">
                              <label className="label" htmlFor="rj">
                                반려 사유{' '}
                                <span className="opt">(반려할 때 필수)</span>
                              </label>
                              {' '}
                              <textarea className="textarea" id="rj" style={{ minHeight: "76px" }} placeholder="예: 통신판매업 신고번호가 없습니다" aria-describedby="rj-h rj-c" />
                              {' '}
                              <span className="hint" id="rj-h">반려 사유는 파트너 공연 목록과 알림함에 그대로 보입니다.</span>
                              {' '}
                              <span className="counter" id="rj-c" aria-live="polite">0 / 500자</span>
                            </div>
                          </>
                        ) : null}
                        {' '}
                        {v.blocked ? (
                          <>
                            <div className="field">
                              <label className="label" htmlFor="rj-b">
                                반려 사유{' '}
                                <span className="opt">(반려할 때 필수)</span>
                              </label>
                              {' '}
                              <textarea className="textarea is-focus" id="rj-b" style={{ minHeight: "76px" }} aria-describedby="rj-bh rj-bc" defaultValue="통신판매업 신고번호나 면제 근거를 판매자 정보에 넣어 주세요. 포트원 파트너 등록이 끝나지 않았습니다." />
                              {' '}
                              <span className="hint" id="rj-bh">반려 사유는 파트너 공연 목록과 알림함에 그대로 보입니다.</span>
                              {' '}
                              <span className="counter" id="rj-bc" aria-live="polite">57 / 500자</span>
                            </div>
                          </>
                        ) : null}
                        <div className="row wrap" style={{ gap: "8px" }}>
                          {v.approveOn ? (
                            <>
                              <button onClick={() => go?.('승인 뒤')} className="btn btn-primary" type="button" {...ro()}>
                                <i className="ic ic-check" aria-hidden="true" />
                                판매를 승인합니다
                              </button>
                            </>
                          ) : null}
                          {' '}
                          {v.isGap ? (
                            <>
                              <button className="btn btn-primary" type="button" aria-disabled="true" aria-describedby="gap-why">
                                <i className="ic ic-check" aria-hidden="true" />
                                판매를 승인합니다
                              </button>
                            </>
                          ) : null}
                          {' '}
                          {v.blocked ? (
                            <>
                              <button className="btn btn-primary" type="button" aria-disabled="true" aria-describedby="ar-why">
                                <i className="ic ic-check" aria-hidden="true" />
                                판매를 승인합니다
                              </button>
                            </>
                          ) : null}
                          {' '}
                          {v.chNo ? (
                            <>
                              <button className="btn btn-primary" type="button" aria-disabled="true" aria-describedby="ch-why">
                                <i className="ic ic-check" aria-hidden="true" />
                                판매를 승인합니다
                              </button>
                            </>
                          ) : null}
                          {' '}
                          <button className="btn btn-outline" type="button" {...ro()}>반려합니다</button>
                        </div>
                        <p className="t-xs muted">승인하면 파트너가 공개와 오픈 예약을 할 수 있습니다. 승인과 반려는 감사 로그에 남고, 승인 뒤 가격·회차·좌석 등급·판매 정책이 바뀌면 다시 승인을 받습니다.</p>
                      </section>
                    </>
                  ) : null}
                </div>
              </div>
            </div>
          </section>
        </>
      ) : null}
      {' '}
      {v.sus ? (
        <>
          <section className="widget span-8" aria-labelledby="fp-h">
            <div className="widget-head">
              <h2 className="t-sm fw-b" id="fp-h">공연 패널 · 가을 야외 페스티벌</h2>
              {v.susLive ? (
                <>
                  <span className="badge badge-success">승인</span>
                </>
              ) : null}
              {' '}
              {v.susPend ? (
                <>
                  <span className="badge badge-warning">판매 중지 승인 대기</span>
                </>
              ) : null}
              {' '}
              {v.susOn ? (
                <>
                  <span className="badge badge-danger">판매 중지</span>
                </>
              ) : null}
              <div className="actions">
                <Link to="/partners" className="link-more">
                  파트너사 정보
                  <i className="ic ic-chevron-right" aria-hidden="true" />
                </Link>
              </div>
            </div>
            <div className="widget-body" style={{ gap: "16px" }}>
              <p className="t-sm muted">(주)스텔라엔터테인먼트 · 피켓 아레나 · 회차 2개 · 판매 승인 10/02(금) 14:20 KST</p>
              {v.susPend ? (
                <>
                  <div className="banner banner-warning" role="status">
                    <i className="ic ic-clock" aria-hidden="true" />
                    <div className="banner-body">판매 중지 승인을 기다립니다. 승인 전까지 공개와 판매는 계속됩니다. 급하면 명령 3으로 판매만 먼저 멈추세요</div>
                    <Link to="/commands" className="link-more">
                      명령 3
                      <i className="ic ic-chevron-right" aria-hidden="true" />
                    </Link>
                  </div>
                </>
              ) : null}
              {' '}
              {v.susOn ? (
                <>
                  <div className="banner banner-danger" role="alert">
                    <i className="ic ic-ban" aria-hidden="true" />
                    <div className="banner-body">
                      <span className="banner-title">판매 중지: 판매자 신원 확인 필요</span>
                      공개와 검색에서 빠졌고 새 판매가 막혔습니다. 이미 판매한 티켓은 유효하고, 정산 지급은 보류됩니다
                    </div>
                  </div>
                </>
              ) : null}
              <div style={{ display: "grid", gridTemplateColumns: "repeat(2,minmax(0,1fr))", gap: "20px", alignItems: "start" }}>
                <section className="col" style={{ gap: "8px" }} aria-labelledby="fr-h">
                  <h3 className="eyebrow" id="fr-h">회차별 판매</h3>
                  <table className="table dense">
                    <caption className="sr-only">회차별 판매</caption>
                    <thead>
                      <tr>
                        <th scope="col">회차</th>
                        <th scope="col">오픈 KST</th>
                        <th scope="col">판매 상태</th>
                        <th scope="col" className="r">판매</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr>
                        <td>11/7(토)</td>
                        <td className="num">10/12(월) 20:00</td>
                        <td>
                          {v.susBefore ? (
                            <>
                              <span className="badge badge-success">판매 중</span>
                            </>
                          ) : null}
                          {v.susOn ? (
                            <>
                              <span className="badge badge-danger">판매 중지</span>
                            </>
                          ) : null}
                        </td>
                        <td className="r num">1,180매</td>
                      </tr>
                      <tr>
                        <td>11/8(일)</td>
                        <td className="num">10/18(일) 20:00</td>
                        <td>
                          {v.susBefore ? (
                            <>
                              <span className="badge badge-success">판매 중</span>
                            </>
                          ) : null}
                          {v.susOn ? (
                            <>
                              <span className="badge badge-warning">오픈 전 · 오픈 시각 지남</span>
                            </>
                          ) : null}
                        </td>
                        <td className="r num">
                          {v.susBefore ? (
                            <>
                              <span>640매</span>
                            </>
                          ) : null}
                          {v.susOn ? (
                            <>
                              <span>0매</span>
                            </>
                          ) : null}
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </section>
                <section className="col" style={{ gap: "8px" }} aria-labelledby="fi-h">
                  <h3 className="eyebrow" id="fi-h">판매 승인과 판매 중지</h3>
                  <dl className="kv">
                    <dt>판매 승인</dt>
                    <dd>10/02(금) 14:20 KST · 민호</dd>
                    <dt>공연 규모</dt>
                    <dd>1회차 중형 · 2회차 중형</dd>
                    {v.susPend ? (
                      <>
                        <dt>판매 중지 요청</dt>
                        <dd>10/19(월) 19:40 KST · 민호(나)</dd>
                        <dt>사유</dt>
                        <dd>판매자 신원 · 판매자 신원 확인 필요</dd>
                        <dt>승인</dt>
                        <dd>요청자가 아닌 commander 1명 · 대기</dd>
                      </>
                    ) : null}
                    {' '}
                    {v.susOn ? (
                      <>
                        <dt>판매 중지</dt>
                        <dd>10/16(금) 11:30 KST · 요청 민호 · 승인 수진(commander)</dd>
                        <dt>사유</dt>
                        <dd>판매자 신원 · 판매자 신원 확인 필요</dd>
                        <dt>정산</dt>
                        <dd className="tx-warning">지급 보류 2건(회차 정산서 2개)</dd>
                      </>
                    ) : null}
                  </dl>
                </section>
              </div>
              {v.susLive ? (
                <>
                  <div className="col" style={{ gap: "6px" }}>
                    <div className="row"><button onClick={() => go?.('판매 중지 요청')} className="btn btn-danger-outline" type="button" {...ro('fa-d1')}>판매 중지 요청</button></div>
                    <span className="hint" id="fa-d1">요청한 분이 아닌 commander가 승인 업무에서 승인합니다.</span>
                  </div>
                </>
              ) : null}
              {' '}
              {v.susPend ? (
                <>
                  <div className="col" style={{ gap: "6px" }}>
                    <div className="row wrap" style={{ gap: "8px", alignItems: "center" }}>
                      <button className="btn btn-danger-outline" type="button" aria-disabled="true" aria-describedby="fa-d2">판매 중지 요청</button>
                      <Link to="/cs/approvals" className="link-more">
                        승인 업무에서 보기
                        <i className="ic ic-chevron-right" aria-hidden="true" />
                      </Link>
                    </div>
                    <span className="hint" id="fa-d2">판매 중지 요청이 이미 승인을 기다립니다.</span>
                  </div>
                </>
              ) : null}
              {' '}
              {v.susOn ? (
                <>
                  <div className="col" style={{ gap: "6px" }}>
                    <div className="row wrap" style={{ gap: "8px" }}>
                      <button onClick={() => go?.('재개할 수 없는 회차')} className="btn btn-primary" type="button" {...ro('fa-d3')}>판매 재개 요청</button>
                      <button className="btn btn-outline" type="button" aria-disabled="true" aria-describedby="fa-d4">회차 취소 요청</button>
                    </div>
                    <span className="hint" id="fa-d3">재개도 요청한 분이 아닌 commander가 승인 업무에서 승인합니다.</span>
                    <span className="hint" id="fa-d4">회차 취소 요청은 commander가 합니다. 회차를 골라 회차 취소 판정으로 넘깁니다.</span>
                  </div>
                </>
              ) : null}
            </div>
          </section>
        </>
      ) : null}
    </div>
    </>
  );
}

export function OverlaysD({ v, close, go }: { v: V; close?: () => void; go?: (state: string) => void }) {
  void v; void close; void go;
  const ro = useRo();
  return (
    <>
    {v.dlgSus ? (
      <>
        <Overlay placement="center" onClose={close}>
          <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="sr-t" aria-describedby="sr-d" style={{ maxWidth: "520px" }}>
            <h2 className="dialog-title" id="sr-t">판매 중지를 요청합니다</h2>
            <dl className="kv card-flat pad">
              <dt>공연</dt>
              <dd>가을 야외 페스티벌 · 회차 2개</dd>
              <dt>지금</dt>
              <dd>11/7(토) 판매 중 · 11/8(일) 판매 중</dd>
            </dl>
            <fieldset className="col" style={{ gap: "8px", border: "0", margin: "0", padding: "0" }}>
              <legend className="label" style={{ marginBottom: "8px" }}>사유 코드 (필수)</legend>
              <div className="row wrap" style={{ gap: "12px 20px" }}>
                <label className="check-row" htmlFor="sr-c1">
                  <input className="rd" id="sr-c1" type="radio" name="sr-code" defaultChecked />
                  판매자 신원
                </label>
                {' '}
                <label className="check-row" htmlFor="sr-c2">
                  <input className="rd" id="sr-c2" type="radio" name="sr-code" />
                  법적 요청
                </label>
                {' '}
                <label className="check-row" htmlFor="sr-c3">
                  <input className="rd" id="sr-c3" type="radio" name="sr-code" />
                  사기 의심
                </label>
                {' '}
                <label className="check-row" htmlFor="sr-c4">
                  <input className="rd" id="sr-c4" type="radio" name="sr-code" />
                  기타
                </label>
              </div>
            </fieldset>
            <div className="field">
              <label className="label" htmlFor="sr-r">사유 (필수)</label>
              {' '}
              <textarea className="textarea is-focus" id="sr-r" style={{ minHeight: "64px" }} aria-describedby="sr-h" defaultValue="판매자 신원 확인 필요" />
              {' '}
              <span className="hint" id="sr-h">사유는 파트너에게 보이는 판매 중지 안내와 감사 로그에 남습니다.</span>
            </div>
            <div className="banner banner-info" id="sr-d">
              <i className="ic ic-users" aria-hidden="true" />
              <div className="banner-body">요청한 분이 아닌 commander가 승인 업무에서 승인하면 공개와 새 판매가 멈춥니다. 승인 전까지 공개와 판매는 계속됩니다.</div>
            </div>
            <div className="dialog-actions">
              <button onClick={close} className="btn btn-outline" type="button">닫기</button>
              {' '}
              <button onClick={() => go?.('판매 중지 승인 대기')} className="btn btn-danger" type="button" {...ro()}>판매 중지를 요청합니다</button>
            </div>
          </div>
        </Overlay>
      </>
    ) : null}
    {v.dlgResume ? (
      <>
        <Overlay placement="center" onClose={close}>
          <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="rs-t" aria-describedby="rs-w" style={{ maxWidth: "520px" }}>
            <h2 className="dialog-title" id="rs-t">판매 재개를 요청합니다</h2>
            <dl className="kv card-flat pad">
              <dt>공연</dt>
              <dd>가을 야외 페스티벌</dd>
              <dt>판매 중지</dt>
              <dd>10/16(금) 11:30 KST부터 · 판매자 신원 확인 필요</dd>
              <dt>다시 열리는 회차</dt>
              <dd>11/7(토)</dd>
            </dl>
            <div className="banner banner-warning" id="rs-w" role="alert">
              <i className="ic ic-alert" aria-hidden="true" />
              <div className="banner-body">
                <span className="banner-title">오픈 시각이 지난 오픈 전 회차 1개는 열리지 않습니다</span>
                파트너가 오픈 시각을 바꿔 다시 승인을 받아야 합니다. 11/8(일) 회차 · 오픈 예정 10/18(일) 20:00 KST가 판매 중지 동안 지났습니다.
              </div>
            </div>
            <div className="field">
              <label className="label" htmlFor="rs-r">재개 사유 (필수)</label>
              {' '}
              <textarea className="textarea is-focus" id="rs-r" style={{ minHeight: "64px" }} aria-describedby="rs-h" defaultValue="판매자 신원 확인을 마쳤습니다." />
              {' '}
              <span className="hint" id="rs-h">요청한 분이 아닌 commander가 승인 업무에서 승인하면 다시 열리고, 보류한 정산 지급도 풀립니다.</span>
            </div>
            <div className="dialog-actions">
              <button onClick={close} className="btn btn-outline" type="button">닫기</button>
              {' '}
              <button onClick={close} className="btn btn-primary" type="button" {...ro()}>판매 재개를 요청합니다</button>
            </div>
          </div>
        </Overlay>
      </>
    ) : null}
    </>
  );
}
