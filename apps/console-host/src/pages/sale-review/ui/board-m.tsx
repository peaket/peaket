// 디자인 캔버스 보드 SCR-048-m.dc.html를 옮긴 것(dc2tsx 생성 뒤 손질)
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

export const STATES_M = ["확인", "재승인", "승인 불가", "승인 불가 · 채널 미준비", "기본 비율", "승인 뒤", "규모 올리기 검토", "판매 중지 승인 대기", "판매 중지됨"] as const;
export const DEFAULT_M = "확인";

export function valsM(state: string) {
    let st = state || '확인';
    let re = st === '재승인';
    let no = st === '승인 불가';
    let def = st === '기본 비율';
    let aOk = st === '승인 뒤';
    let aHi = st === '규모 올리기 검토';
    let after = aOk || aHi;
    let ch = st === '승인 불가 · 채널 미준비';
    let sPend = st === '판매 중지 승인 대기';
    let sOn = st === '판매 중지됨';
    let sus = sPend || sOn;
    return {
      isRe: re,
      notRe: !re,
      isPend: !re && !after && !sus,
      pre: !after && !sus,
      chNo: ch,
      chOk: !ch,
      allOk: !no && !ch,
      sus: sus,
      notSus: !sus,
      susLive: false,
      susPend: sPend,
      susOn: sOn,
      susBefore: sPend,
      susOkTab: sPend,
      tWait: sus ? 'false' : 'true',
      tWaitCls: sus ? '' : 'is-active',
      tOk: sPend ? 'true' : 'false',
      tOkCls: sPend ? 'is-active' : '',
      tSus: sOn ? 'true' : 'false',
      tSusCls: sOn ? 'is-active' : '',
      nWait: (after || sus) ? '0' : '1',
      nOk: (after || sPend) ? '4' : '3',
      nSus: sOn ? '1' : '0',
      after: after,
      blocked: no,
      canApprove: !no,
      ratioPast: !def,
      ratioDef: def,
      fcLow: aOk,
      fcHigh: aHi,
      showReview: aHi,
      c3cls: re ? 'card is-selected' : 'card-flat',
      cellCls: re ? 'card is-selected' : ''
    };
  }

type V = ReturnType<typeof valsM>;

// 보드 루트: {"class": "pk dark cs cs-compact", "style": "width:360px;min-height:3940px"}

// <main class="cs-main" id="main">
export function MainM({ v, close, go }: { v: V; close?: () => void; go?: (state: string) => void }) {
  void v; void close; void go;
  const ro = useRo();
  return (
    <>
    <div className="col" style={{ gap: "8px" }}>
      <h1 className="t-lg">판매 승인</h1>
      <div className="row wrap" style={{ gap: "6px" }}>
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
      <p className="t-sm muted">파트너가 등록한 공연을 확인 항목 6가지로 점검해 공개를 허락합니다. 승인을 받은 공연만 공개하고 오픈을 예약할 수 있습니다.</p>
    </div>
    <section className="widget" aria-labelledby="sl-h">
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
            <ul className="col" style={{ gap: "8px" }} aria-label="승인 대기 공연">
              <li>
                <a className="card is-selected col" href="#sp-h" aria-current="true" style={{ gap: "8px", padding: "12px 14px", color: "inherit" }}>
                  <span className="row between" style={{ gap: "8px" }}>
                    <span className="t-md fw-b">팬미팅</span>
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
                  </span>
                  {' '}
                  <span className="t-xs muted">(주)스텔라엔터테인먼트</span>
                  {' '}
                  <span className="row between t-sm" style={{ gap: "8px" }}>
                    <span className="muted">첫 오픈</span>
                    <span className="num">10/28(수) 20:00 KST</span>
                  </span>
                  {' '}
                  <span className="row between t-sm" style={{ gap: "8px" }}>
                    <span className="muted">제출</span>
                    {v.notRe ? (
                      <>
                        <span className="num">10/16(금) 15:40 KST</span>
                      </>
                    ) : null}
                    {v.isRe ? (
                      <>
                        <span className="num">10/19(월) 17:25 KST</span>
                      </>
                    ) : null}
                  </span>
                </a>
              </li>
            </ul>
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
        <section className="widget" aria-labelledby="sp-h">
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
          </div>
          <div className="widget-body" style={{ gap: "16px" }}>
            <div className="col" style={{ gap: "6px" }}>
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
              {' '}
              <Link to="/partners" className="link-more" style={{ alignSelf: "flex-start" }}>
                파트너사 정보
                <i className="ic ic-chevron-right" aria-hidden="true" />
              </Link>
            </div>
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
                  <div className="banner-body">예상 진입 상단(52만 명)이 지금 등급(중형)의 상한을 넘었습니다. 규모를 올릴지 검토하세요</div>
                </div>
              </>
            ) : null}
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
                <li className="card-flat pad col" id="ck1" style={{ gap: "8px" }}>
                  <div className="row between" style={{ gap: "8px", alignItems: "flex-start" }}>
                    <span className="t-sm fw-b">판매자 신원정보와 사업자 진위</span>
                    {' '}
                    {v.canApprove ? (
                      <>
                        <span className="badge badge-success">
                          <i className="ic ic-check" aria-hidden="true" />
                          확인함
                        </span>
                      </>
                    ) : null}
                    {' '}
                    {v.blocked ? (
                      <>
                        <span className="badge badge-danger">
                          <i className="ic ic-x-circle" aria-hidden="true" />
                          확인 불가
                        </span>
                      </>
                    ) : null}
                  </div>
                  <div className="col" style={{ gap: "2px" }}>
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
                        <span className="error-msg">
                          <i className="ic ic-alert-circle" aria-hidden="true" />
                          통신판매업 신고번호와 면제 근거가 모두 없습니다
                        </span>
                      </>
                    ) : null}
                  </div>
                </li>
                <li className="card-flat pad col" style={{ gap: "8px" }}>
                  <div className="row between" style={{ gap: "8px", alignItems: "flex-start" }}>
                    <span className="t-sm fw-b">표시 사항(휠체어석 확인 포함)과 공연예술통합전산망 10개 항목</span>
                    {' '}
                    <span className="row" style={{ gap: "4px" }}>
                      {v.isRe ? (
                        <>
                          <span className="badge badge-warning">바뀜</span>
                        </>
                      ) : null}
                      <span className="badge badge-success">
                        <i className="ic ic-check" aria-hidden="true" />
                        확인함
                      </span>
                    </span>
                  </div>
                  <ul className="col" aria-label="표시 사항과 공연예술통합전산망 10개 항목" style={{ gap: "4px" }}>
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
                  <p className="t-xs muted">휠체어석 기준을 지키는 책임은 공연장에 있습니다. 판매 승인에서는 파트너의 확인과 이유가 좌석맵과 맞는지만 봅니다.</p>
                </li>
                <li className={`${v.c3cls} pad col`} style={{ gap: "8px" }}>
                  <div className="row between" style={{ gap: "8px", alignItems: "flex-start" }}>
                    <span className="t-sm fw-b">판매 정책 상한(공제율·양도)</span>
                    {' '}
                    <span className="row" style={{ gap: "4px" }}>
                      {v.isRe ? (
                        <>
                          <span className="badge badge-warning">바뀜</span>
                        </>
                      ) : null}
                      <span className="badge badge-success">
                        <i className="ic ic-check" aria-hidden="true" />
                        확인함
                      </span>
                    </span>
                  </div>
                  <div className="col" style={{ gap: "2px" }}>
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
                  <div className="row between" style={{ gap: "8px", alignItems: "flex-start" }}>
                    <span className="t-sm fw-b">아티스트·공연장 연결</span>
                    {' '}
                    <span className="badge badge-success">
                      <i className="ic ic-check" aria-hidden="true" />
                      확인함
                    </span>
                  </div>
                  <dl className="kv">
                    <dt>'LUMEN'</dt>
                    <dd>기존 아티스트 LUMEN</dd>
                    <dt>'피켓 아레나'</dt>
                    <dd>기존 공연장 피켓 아레나</dd>
                  </dl>
                  <span className="t-xs muted">연결과 다른 이름 고치기는 태블릿이나 데스크톱에서 합니다.</span>
                </li>
                <li className="card-flat pad col" id="ck4" style={{ gap: "8px" }}>
                  <div className="row between" style={{ gap: "8px", alignItems: "flex-start" }}>
                    <span className="t-sm fw-b">결제사 지정 · 승인하면 이 지정으로 고정됩니다(바꾸려면 명령 12)</span>
                    {' '}
                    {v.chOk ? (
                      <>
                        <span className="badge badge-success">
                          <i className="ic ic-check" aria-hidden="true" />
                          확인함
                        </span>
                      </>
                    ) : null}
                    {' '}
                    {v.chNo ? (
                      <>
                        <span className="badge badge-danger">
                          <i className="ic ic-x-circle" aria-hidden="true" />
                          확인 불가
                        </span>
                      </>
                    ) : null}
                  </div>
                  <div className="col" style={{ gap: "4px" }}>
                    <span className="t-sm">토스페이먼츠(기본) · 대체 포트원 · 동시 입장 상한 8,000명 [추정]</span>
                    {' '}
                    <Link to="/commands" className="link-more" style={{ alignSelf: "flex-start" }}>
                      명령 12 결제사 지정
                      <i className="ic ic-chevron-right" aria-hidden="true" />
                    </Link>
                    {' '}
                    {v.chNo ? (
                      <>
                        <span className="error-msg">
                          <i className="ic ic-alert-circle" aria-hidden="true" />
                          결제사 채널이 준비되지 않았습니다. 명령 12로 다른 결제사를 지정하세요
                        </span>
                      </>
                    ) : null}
                  </div>
                </li>
                <li className="card-flat pad col" id="ck5" style={{ gap: "8px" }}>
                  <div className="row between" style={{ gap: "8px", alignItems: "flex-start" }}>
                    <span className="t-sm fw-b">결제사 지급대행 등록과 예금주 일치</span>
                    {' '}
                    {v.canApprove ? (
                      <>
                        <span className="badge badge-success">
                          <i className="ic ic-check" aria-hidden="true" />
                          확인함
                        </span>
                      </>
                    ) : null}
                    {' '}
                    {v.blocked ? (
                      <>
                        <span className="badge badge-danger">
                          <i className="ic ic-x-circle" aria-hidden="true" />
                          확인 불가
                        </span>
                      </>
                    ) : null}
                  </div>
                  <div className="col" style={{ gap: "8px" }}>
                    <dl className="kv">
                      <dt>토스페이먼츠 셀러</dt>
                      <dd><span className="badge badge-success">부분 승인</span></dd>
                      <dt>포트원 파트너</dt>
                      <dd>
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
                      </dd>
                      <dt>예금주</dt>
                      <dd><span className="badge badge-success">일치</span></dd>
                      <dt>정산 계좌</dt>
                      <dd>[은행] · 끝 4자리 [0000]</dd>
                    </dl>
                    {v.blocked ? (
                      <>
                        <span className="error-msg">
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
            {v.pre ? (
              <>
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
                  <div className="banner banner-info bigscreen" role="note">
                    <i className="ic ic-monitor" aria-hidden="true" />
                    <div className="banner-body" style={{ flexBasis: "200px" }}>
                      <span className="banner-title">규모 올리기는 태블릿이나 데스크톱에서 합니다</span>
                      휴대폰에서는 볼 수만 있습니다
                    </div>
                    <button onClick={copyLink} className="btn btn-outline btn-sm" type="button">
                      <i className="ic ic-copy" aria-hidden="true" />
                      링크 복사
                    </button>
                  </div>
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
                  <div className="banner banner-info bigscreen" role="note">
                    <i className="ic ic-monitor" aria-hidden="true" />
                    <div className="banner-body" style={{ flexBasis: "200px" }}>
                      <span className="banner-title">판매 중지 요청은 태블릿이나 데스크톱에서 합니다</span>
                      휴대폰에서는 볼 수만 있습니다
                    </div>
                    <button onClick={copyLink} className="btn btn-outline btn-sm" type="button">
                      <i className="ic ic-copy" aria-hidden="true" />
                      링크 복사
                    </button>
                  </div>
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
                      <div className="error-summary" role="alert">
                        <span className="fw-b">승인할 수 없는 이유 2가지</span>
                        {' '}
                        <a href="#ck1">통신판매업 신고번호와 면제 근거가 모두 없습니다</a>
                        {' '}
                        <a href="#ck5">결제사 지급대행 등록이 끝나지 않았습니다(포트원 파트너 미등록)</a>
                        {' '}
                        <span className="t-sm">판매 조건과 판매자 정보는 파트너가 고칩니다. 사유를 적어 반려하세요.</span>
                      </div>
                    </>
                  ) : null}
                  {' '}
                  {v.chNo ? (
                    <>
                      <div className="error-summary" role="alert">
                        <span className="fw-b">승인할 수 없는 이유 1가지</span>
                        {' '}
                        <a href="#ck4">결제사 채널이 준비되지 않았습니다. 명령 12로 다른 결제사를 지정하세요</a>
                      </div>
                    </>
                  ) : null}
                  <div className="banner banner-info bigscreen" role="note">
                    <i className="ic ic-monitor" aria-hidden="true" />
                    <div className="banner-body" style={{ flexBasis: "200px" }}>
                      <span className="banner-title">판매 승인과 반려(공연 규모 지정 포함)는 태블릿이나 데스크톱에서 합니다</span>
                      휴대폰에서는 볼 수만 있습니다
                    </div>
                    <button onClick={copyLink} className="btn btn-outline btn-sm" type="button">
                      <i className="ic ic-copy" aria-hidden="true" />
                      링크 복사
                    </button>
                  </div>
                  <p className="t-xs muted">승인하면 파트너가 공개와 오픈 예약을 할 수 있습니다. 승인과 반려는 감사 로그에 남고, 승인 뒤 가격·회차·좌석 등급·판매 정책이 바뀌면 다시 승인을 받습니다.</p>
                </section>
              </>
            ) : null}
          </div>
        </section>
      </>
    ) : null}
    {' '}
    {v.sus ? (
      <>
        <section className="widget" aria-labelledby="fp-h">
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
            <div className="col" style={{ gap: "16px" }}>
              <section className="col" style={{ gap: "8px" }} aria-labelledby="fr-h">
                <h3 className="eyebrow" id="fr-h">회차별 판매</h3>
                {/* 320 폭에서 화면 전체가 가로로 밀리지 않게 표만 상자 안에서 가로 스크롤 */}
                <div style={{ overflowX: "auto" }} tabIndex={0} role="region" aria-labelledby="fr-h">
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
                </div>
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
            <div className="banner banner-info bigscreen" role="note">
              <i className="ic ic-monitor" aria-hidden="true" />
              <div className="banner-body" style={{ flexBasis: "200px" }}>
                <span className="banner-title">판매 중지·재개 요청은 태블릿이나 데스크톱에서 합니다</span>
                휴대폰에서는 볼 수만 있습니다
              </div>
              <button onClick={copyLink} className="btn btn-outline btn-sm" type="button">
                <i className="ic ic-copy" aria-hidden="true" />
                링크 복사
              </button>
            </div>
          </div>
        </section>
      </>
    ) : null}
    </>
  );
}

