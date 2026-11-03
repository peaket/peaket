// 디자인 캔버스 보드 SCR-032-m.dc.html를 옮긴 것(dc2tsx 생성 뒤 손질)
/* eslint-disable */
import { Fragment, type FormEvent } from 'react';
import { Link } from 'react-router';
import { Overlay } from '@/shared/ui/Overlay';

const prevent = (e: FormEvent) => e.preventDefault();
void Fragment;
void Link;

type AriaBool = boolean | 'true' | 'false';
type AriaCurrent = boolean | 'true' | 'false' | 'page' | 'step' | 'location' | 'date' | 'time';

export const STATES_M = ["통보", "기한 초과", "보안 사고", "접속기록 점검", "자료 요청 · 접수", "자료 요청 · 승인 대기(본인 요청)", "자료 요청 · commander 승인", "자료 요청 · 승인 대기 만료", "자료 요청 · 제출 기록", "보안 사고 · 판단 기록 뒤", "접속기록 점검 · 데모 환경", "접속기록 점검 · 데모 자기 점검 종결"] as const;
export const DEFAULT_M = "통보";

export function valsM(state: string) {
    let st = state || '통보';
    let drRecv = st === '자료 요청 · 접수';
    let drPend = st === '자료 요청 · 승인 대기(본인 요청)';
    let drAppr = st === '자료 요청 · commander 승인';
    let drExp = st === '자료 요청 · 승인 대기 만료';
    let drSubOk = st === '자료 요청 · 제출 기록';
    let drHash = false;
    let drSub = drSubOk || drHash;
    let d22 = drRecv || drPend || drExp || drSub;
    let dr = d22 || drAppr;
    let wd = false;
    let incDone = st === '보안 사고 · 판단 기록 뒤';
    let demo = st === '접속기록 점검 · 데모 환경';
    let demoDone = st === '접속기록 점검 · 데모 자기 점검 종결';
    let notice = st === '통보' || st === '기한 초과' || dr;
    let incident = st === '보안 사고' || incDone;
    let review = st === '접속기록 점검' || demo || demoDone;
    return {
      isNoticeTab: notice,
      isIncident: incident,
      isReview: review,
      isOverdue: st === '기한 초과',
      onTime: st === '통보' || dr,
      isWithdraw: wd,
      isNd: !dr,
      isDr: dr,
      drForm: drRecv || drExp,
      drPend: drPend,
      drExp: drExp,
      drSub: drSub,
      drSubOk: drSubOk,
      drHash: drHash,
      n41Sel: dr ? '' : 'is-selected',
      n41Cur: dr ? 'false' : 'true',
      d22Sel: d22 ? 'is-selected' : '',
      d22Cur: d22 ? 'true' : 'false',
      d23Sel: drAppr ? 'is-selected' : '',
      d23Cur: drAppr ? 'true' : 'false',
      drAppr: drAppr,
      drTitle: drAppr ? 'D-2026-0023 · 한국콘텐츠진흥원 자료 제출 요청' : 'D-2026-0022 · 경찰청 통신이용자정보 제공 요청',
      drBadge: drAppr ? '승인 대기' : (drPend ? '승인 대기' : (drSub ? '제출 기록 대기' : '접수')),
      drCls: drSub ? 'badge-primary' : 'badge-warning',
      drOrg: drAppr ? '한국콘텐츠진흥원' : '경찰청([경찰서명])',
      drKind: drAppr ? '부정판매 사실 확인' : '통신이용자정보',
      drRecvAt: drAppr ? '10/14(수) 15:16 KST' : '10/12(월) 11:05 KST',
      drTarget: drAppr ? '요청서에 적힌 게시물 2건 관련 예매 내역·접속기록' : '요청서에 적힌 회원 1명',
      drFile: drAppr ? 'official-letter_D-2026-0023_20261014.pdf' : 'official-letter_D-2026-0022_20261012.pdf',
      drRecvLog: drAppr ? '10/14 15:16' : '10/12 11:05',
      d22Badge: drPend ? '승인 대기' : (drSub ? '제출 기록 대기' : '접수'),
      d22Cls: drSub ? 'badge-primary' : 'badge-warning',
      ijOpen: !incDone,
      ijDone: incDone,
      incBadge: incDone ? '신고·통지 준비' : '해당 판단 중',
      closeWhy: incDone ? '남은 신고·통지 의무를 모두 기록하면 닫을 수 있습니다.' : '해당 판단을 기록하고 남은 신고·통지 의무를 모두 기록하면 닫을 수 있습니다.',
      envLbl: (demo || demoDone) ? '데모' : '운영',
      selfProd: !(demo || demoDone),
      selfDemo: demo,
      selfDone: demoDone,
      selfOpen: !demoDone,
      sevNormal: !incident,
      t1c: notice ? 'is-active' : '',
      t1s: notice ? 'true' : 'false',
      t2c: incident ? 'is-active' : '',
      t2s: incident ? 'true' : 'false',
      t3c: review ? 'is-active' : '',
      t3s: review ? 'true' : 'false'
    };
  }

type V = ReturnType<typeof valsM>;

// 보드 루트: {"class": "pk dark cs cs-compact", "style": "width:360px;min-height:3920px"}

// <main class="cs-main" id="main">
export function MainM({ v, close, go }: { v: V; close?: () => void; go?: (state: string) => void }) {
  void v; void close; void go;
  return (
    <>
    <div className="page-head" style={{ flexDirection: "column", alignItems: "stretch", gap: "12px" }}>
      <div className="col" style={{ gap: "4px" }}>
        <h1>법정 조치</h1>
        <p className="t-sm muted">통보·자료 요청, 보안 사고, 접속기록 점검을 법정 기한과 함께 처리합니다. 기한은 접수·인지 시각부터 셉니다.</p>
      </div>
      <div className="banner banner-info bigscreen" role="note">
        <i className="ic ic-monitor" aria-hidden="true" />
        <div className="banner-body">
          <span className="banner-title">통보·자료 요청·보안 사고 등록은 태블릿이나 데스크톱에서 합니다</span>
          휴대폰에서는 볼 수만 있습니다
        </div>
        <button className="btn btn-outline btn-sm" type="button">
          <i className="ic ic-copy" aria-hidden="true" />
          링크 복사
        </button>
      </div>
    </div>
    {v.isOverdue ? (
      <>
        <div className="banner banner-danger" role="alert">
          <i className="ic ic-alert-circle" aria-hidden="true" />
          <div className="banner-body">
            <span className="banner-title">법정 기한이 지났습니다 · N-2026-0141</span>
            한국콘텐츠진흥원 통보의 처리 기한(10/14(수) 19:31:12 KST)이 33분 지났습니다. 남은 게시물 1건을 차단하고 결과를 회신하세요. 기한 2시간 전인 17:31에 SEV2로 알렸습니다.
          </div>
        </div>
      </>
    ) : null}
    {' '}
    {v.isIncident ? (
      <>
        <div className="banner banner-danger" role="alert">
          <i className="ic ic-shield" aria-hidden="true" />
          <div className="banner-body">
            <span className="banner-title">보안 사고가 등록되었습니다 · INC-2026-007 · SEV1</span>
            관리 계정 탈취·개인정보 유출 의심 1,180명 · 인지 10/14(수) 19:48 KST · 등록 20:01 KST. 의무별 기한을 아래에서 추적하고, 24시간 기한은 22시간, 72시간 기한은 60시간이 지나면 SEV2로 다시 알립니다.
          </div>
        </div>
      </>
    ) : null}
    <div className="tabs tabs-scroll" role="tablist" aria-label="법정 조치 종류">
      <button className={`tab ${v.t1c}`} id="tb-n" role="tab" type="button" onClick={() => go?.('통보')} aria-selected={(v.t1s) as AriaBool}>
        통보·자료 요청
        <span className="badge">3</span>
      </button>
      {' '}
      <button className={`tab ${v.t2c}`} id="tb-i" role="tab" type="button" onClick={() => go?.('보안 사고')} aria-selected={(v.t2s) as AriaBool}>
        보안 사고
        {v.isIncident ? (
          <>
            <span className="badge badge-danger">1</span>
          </>
        ) : null}
      </button>
      {' '}
      <button className={`tab ${v.t3c}`} id="tb-r" role="tab" type="button" onClick={() => go?.('접속기록 점검')} aria-selected={(v.t3s) as AriaBool}>
        접속기록 점검
        <span className="badge">3</span>
      </button>
    </div>
    {v.isNoticeTab ? (
      <>
        <div className="col" role="tabpanel" aria-labelledby="tb-n" style={{ gap: "12px" }}>
          <section className="widget" aria-labelledby="nl-t">
            <div className="widget-head">
              <h2 className="t-sm fw-b" id="nl-t">통보·자료 요청</h2>
              <div className="actions"><span className="t-xs muted">처리 중 3 · 이번 달 5</span></div>
            </div>
            <div className="widget-body" style={{ gap: "10px" }}>
              <div className="row between wrap" style={{ gap: "6px 8px" }}>
                <div className="row" style={{ gap: "6px" }} role="group" aria-label="상태로 거르기">
                  <button className="chip chip-sm" type="button" aria-pressed="false">처리 중</button>
                  <button className="chip chip-sm" type="button" aria-pressed="false">완료</button>
                  <button className="chip chip-sm is-selected" type="button" aria-pressed="true">전체</button>
                </div>
                <div className="input-group input-group-sm" style={{ width: "132px" }}>
                  <select id="nl-sort" aria-label="정렬" defaultValue="기한 순">
                    <option>기한 순</option>
                    <option>최근 등록 순</option>
                  </select>
                  <i className="ic ic-chevron-down" aria-hidden="true" />
                </div>
              </div>
              <ul className="col" style={{ gap: "8px" }}>
                <li>
                  <button className={`card ${v.n41Sel}`} type="button" aria-current={(v.n41Cur) as AriaCurrent} style={{ display: "flex", flexDirection: "column", gap: "6px", width: "100%", padding: "12px", borderRadius: "var(--r-lg)", textAlign: "left", cursor: "pointer" }}>
                    <span className="row between" style={{ gap: "6px" }}>
                      <span className="row" style={{ gap: "6px" }}>
                        <span className="badge badge-primary">통보</span>
                        <span className="mono t-xs">N-2026-0141</span>
                      </span>
                      <span>
                        {v.onTime ? (
                          <>
                            <span className="badge badge-warning">처리 중</span>
                          </>
                        ) : null}
                        {v.isOverdue ? (
                          <>
                            <span className="badge badge-danger">기한 초과</span>
                          </>
                        ) : null}
                      </span>
                    </span>
                    {' '}
                    <span className="t-sm fw-b">한국콘텐츠진흥원 · 게시물 2건</span>
                    {' '}
                    {v.onTime ? (
                      <>
                        <span className="col" style={{ gap: "6px", alignItems: "flex-start" }}>
                          <span className="t-xs muted">접수 10/14(수) 15:16 KST · 10시간(고시 사항)</span>
                          <span className="badge">
                            <i className="ic ic-clock" aria-hidden="true" />
                            법정 기한 남은 시간: 5시간 12분
                          </span>
                        </span>
                      </>
                    ) : null}
                    {' '}
                    {v.isOverdue ? (
                      <>
                        <span className="col" style={{ gap: "6px", alignItems: "flex-start" }}>
                          <span className="t-xs muted">접수 10/14(수) 09:31 KST · 10시간(고시 사항)</span>
                          <span className="badge badge-danger">
                            <i className="ic ic-alert" aria-hidden="true" />
                            법정 기한 33분 초과
                          </span>
                        </span>
                      </>
                    ) : null}
                  </button>
                </li>
                <li>
                  <button className={`card ${v.d22Sel}`} type="button" aria-current={(v.d22Cur) as AriaCurrent} style={{ display: "flex", flexDirection: "column", gap: "6px", width: "100%", padding: "12px", borderRadius: "var(--r-lg)", textAlign: "left", cursor: "pointer" }}>
                    <span className="row between" style={{ gap: "6px" }}>
                      <span className="row" style={{ gap: "6px" }}>
                        <span className="badge">자료 요청</span>
                        <span className="mono t-xs">D-2026-0022</span>
                      </span>
                      <span className={`badge ${v.d22Cls}`}>{v.d22Badge}</span>
                    </span>
                    {' '}
                    <span className="t-sm fw-b">경찰청 · 통신이용자정보 1건</span>
                    {' '}
                    <span className="t-xs muted">접수 10/12(월) 11:05 KST · 제출 기한 10/21(수)</span>
                  </button>
                </li>
                <li>
                  <button className={`card ${v.d23Sel}`} type="button" aria-current={(v.d23Cur) as AriaCurrent} style={{ display: "flex", flexDirection: "column", gap: "6px", width: "100%", padding: "12px", borderRadius: "var(--r-lg)", textAlign: "left", cursor: "pointer" }}>
                    <span className="row between" style={{ gap: "6px" }}>
                      <span className="row" style={{ gap: "6px" }}>
                        <span className="badge">자료 요청</span>
                        <span className="mono t-xs">D-2026-0023</span>
                      </span>
                      <span className="badge badge-warning">승인 대기</span>
                    </span>
                    {' '}
                    <span className="t-sm fw-b">한국콘텐츠진흥원 · 예매 내역·접속기록</span>
                    {' '}
                    <span className="t-xs muted">
                      접수 10/14(수){' '}
                      {v.onTime ? (
                        <>
                          <span>15:16</span>
                        </>
                      ) : null}
                      {v.isOverdue ? (
                        <>
                          <span>09:31</span>
                        </>
                      ) : null}
                      {' '}KST · 제출 기한 10/21(수)
                    </span>
                  </button>
                </li>
                <li>
                  <button className="card" type="button" style={{ display: "flex", flexDirection: "column", gap: "6px", width: "100%", padding: "12px", borderRadius: "var(--r-lg)", textAlign: "left", cursor: "pointer" }}>
                    <span className="row between" style={{ gap: "6px" }}>
                      <span className="row" style={{ gap: "6px" }}>
                        <span className="badge badge-primary">통보</span>
                        <span className="mono t-xs">N-2026-0139</span>
                      </span>
                      <span className="badge badge-success">회신 완료</span>
                    </span>
                    {' '}
                    <span className="t-sm fw-b">경찰청 · 게시물 1건</span>
                    {' '}
                    <span className="t-xs muted">접수 10/13(화) 22:40 KST · 24시간 · 회신 10/14(수) 09:05</span>
                  </button>
                </li>
                <li>
                  <button className="card" type="button" style={{ display: "flex", flexDirection: "column", gap: "6px", width: "100%", padding: "12px", borderRadius: "var(--r-lg)", textAlign: "left", cursor: "pointer" }}>
                    <span className="row between" style={{ gap: "6px" }}>
                      <span className="row" style={{ gap: "6px" }}>
                        <span className="badge badge-primary">통보</span>
                        <span className="mono t-xs">N-2026-0137</span>
                      </span>
                      <span className="badge badge-success">회신 완료</span>
                    </span>
                    {' '}
                    <span className="t-sm fw-b">문화체육관광부 · 게시물 3건</span>
                    {' '}
                    <span className="t-xs muted">접수 10/12(월) 14:10 KST · 24시간 · 회신 10/12(월) 18:42</span>
                  </button>
                </li>
              </ul>
              <button className="btn btn-ghost btn-sm" type="button" style={{ alignSelf: "center" }}>더 보기</button>
              <div className="card-flat" style={{ display: "flex", flexDirection: "column", gap: "4px", padding: "12px 14px", borderRadius: "var(--r-lg)" }}>
                <span className="t-xs fw-b">반기 보고 현황 · 2026년 하반기</span>
                {' '}
                <span className="t-xs muted">통신이용자정보 제공 3건(반기 종료 뒤 30일 안, 2027-01-30까지 보고) · 통신사실확인자료 0건(연 2회 보고) · 받는 곳 과학기술정보통신부</span>
              </div>
            </div>
          </section>
          <p className="eyebrow" style={{ marginTop: "4px" }}>선택한 항목</p>
          {v.isNd ? (
            <>
              <section className="widget" aria-labelledby="nd-t">
                <div className="widget-head" style={{ flexDirection: "column", alignItems: "stretch", gap: "6px", padding: "12px 14px" }}>
                  <span className="row between" style={{ gap: "6px" }}>
                    <span className="badge badge-primary">통보</span>
                    <span>
                      {v.onTime ? (
                        <>
                          <span className="badge badge-warning">처리 중</span>
                        </>
                      ) : null}
                      {v.isOverdue ? (
                        <>
                          <span className="badge badge-danger">기한 초과</span>
                        </>
                      ) : null}
                    </span>
                  </span>
                  <h2 className="t-md fw-b" id="nd-t">N-2026-0141 · 한국콘텐츠진흥원 게시물 노출 차단 통보</h2>
                </div>
                <div className="widget-body" style={{ gap: "20px" }}>
                  {v.onTime ? (
                    <>
                      <div className="col" style={{ gap: "6px", padding: "14px", borderRadius: "var(--r-lg)", background: "var(--surface-muted)", boxShadow: "inset 0 0 0 1px var(--border)" }}>
                        <span className="row between" style={{ gap: "8px" }}>
                          <span className="eyebrow">법정 처리 기한 · 10시간(고시 사항)</span>
                          <span className="badge">
                            <i className="ic ic-clock" aria-hidden="true" />
                            기한 안
                          </span>
                        </span>
                        {' '}
                        <span className="t-lg num" role="timer">법정 기한 남은 시간: 5시간 12분</span>
                        {' '}
                        <span className="t-xs muted">접수 10/14(수) 15:16:12 → 기한 10/15(목) 01:16:12 KST · 2시간 전 SEV2</span>
                      </div>
                    </>
                  ) : null}
                  {' '}
                  {v.isOverdue ? (
                    <>
                      <div className="col" style={{ gap: "6px", padding: "14px", borderRadius: "var(--r-lg)", background: "var(--danger-subtle)", boxShadow: "inset 0 0 0 1px var(--danger)" }}>
                        <span className="row between" style={{ gap: "8px" }}>
                          <span className="eyebrow">법정 처리 기한 · 10시간(고시 사항)</span>
                          <span className="badge badge-danger">
                            <i className="ic ic-alert" aria-hidden="true" />
                            기한 초과
                          </span>
                        </span>
                        {' '}
                        <span className="t-lg num tx-danger" role="timer">법정 기한 33분 초과</span>
                        {' '}
                        <span className="t-xs muted">접수 10/14(수) 09:31:12 → 기한 10/14(수) 19:31:12 KST · 17:31 SEV2 알림</span>
                      </div>
                    </>
                  ) : null}
                  <div className="banner banner-info bigscreen" role="note">
                    <i className="ic ic-monitor" aria-hidden="true" />
                    <div className="banner-body">
                      <span className="banner-title">노출 차단·복원과 회신 기록은 태블릿이나 데스크톱에서 합니다</span>
                      휴대폰에서는 볼 수만 있습니다
                    </div>
                    <button className="btn btn-outline btn-sm" type="button">
                      <i className="ic ic-copy" aria-hidden="true" />
                      링크 복사
                    </button>
                  </div>
                  <section className="col" style={{ gap: "8px" }} aria-labelledby="reg-t">
                    <h3 className="t-sm fw-b" id="reg-t">통보 등록</h3>
                    <dl className="kv">
                      <dt>발송 기관</dt>
                      <dd>한국콘텐츠진흥원(신고기관)</dd>
                      <dt>공문 번호</dt>
                      <dd>[공문 번호]</dd>
                      <dt>접수 시각</dt>
                      <dd>
                        {v.onTime ? (
                          <>
                            <span>10/14(수) 15:16:12 KST</span>
                          </>
                        ) : null}
                        {v.isOverdue ? (
                          <>
                            <span>10/14(수) 09:31:12 KST</span>
                          </>
                        ) : null}
                      </dd>
                      <dt>처리 기한</dt>
                      <dd>10시간(고시 사항)</dd>
                      <dt>근거</dt>
                      <dd>공연법 §4의2, 시행령 §3의3</dd>
                      <dt>공문 원본</dt>
                      <dd>
                        <span className="mono t-xs">official-letter_N-2026-0141_20261014.pdf</span>
                        {' '}· 검사 위협 없음
                      </dd>
                    </dl>
                  </section>
                  <section className="col" style={{ gap: "8px" }} aria-labelledby="post-t">
                    <h3 className="t-sm fw-b" id="post-t">대상 게시물</h3>
                    <p className="t-xs muted">공문에 적힌 게시물 ID만 차단할 수 있습니다(명령 10, operator 1인)</p>
                    <ul className="col" style={{ gap: "8px" }} aria-label="대상 게시물 2건">
                      <li className="card" style={{ display: "flex", flexDirection: "column", gap: "6px", padding: "12px", borderRadius: "var(--r-lg)" }}>
                        <span className="row between" style={{ gap: "6px" }}>
                          <span className="mono t-sm fw-b">rv_7Q2K9</span>
                          <span className="badge badge-warning">노출 중</span>
                        </span>
                        {' '}
                        <span className="t-sm">[지난 공연명] · 관람 후기</span>
                        {' '}
                        <span className="t-xs muted">
                          작성 10/14 13:02 KST · 본문 지문{' '}
                          <span className="mono">9f3c…51e0</span>
                        </span>
                      </li>
                      <li className="card" style={{ display: "flex", flexDirection: "column", gap: "6px", padding: "12px", borderRadius: "var(--r-lg)" }}>
                        <span className="row between" style={{ gap: "6px" }}>
                          <span className="mono t-sm fw-b">rv_7Q2M1</span>
                          <span className="badge badge-success">차단함 15:31</span>
                        </span>
                        {' '}
                        <span className="t-sm">[지난 공연명] · 관람 후기</span>
                        {' '}
                        <span className="t-xs muted">
                          작성 10/14 13:05 KST · 본문 지문{' '}
                          <span className="mono">2b7a…c419</span>
                        </span>
                      </li>
                    </ul>
                    <p className="t-xs muted">통보가 정식으로 철회되면 통보 단위로 되살립니다. 이 통보로 가린 게시물과 같은 내용으로 자동 숨긴 글을 함께 되살립니다.</p>
                  </section>
                  <section className="col" style={{ gap: "8px" }} aria-labelledby="fp-t">
                    <h3 className="t-sm fw-b" id="fp-t">같은 내용 차단 목록</h3>
                    <div className="card" style={{ padding: "12px 14px", borderRadius: "var(--r-lg)" }}>
                      <dl className="kv" aria-label="같은 내용 차단 지문 1건">
                        <dt>본문 지문</dt>
                        <dd className="mono">2b7a…c419</dd>
                        <dt>출처</dt>
                        <dd className="mono">rv_7Q2M1</dd>
                        <dt>자동 숨김</dt>
                        <dd>1건</dd>
                        <dt>등록</dt>
                        <dd>15:31</dd>
                      </dl>
                    </div>
                    <p className="t-xs muted">본문을 NFKC로 맞추고 공백·문장부호를 뺀 SHA-256 지문으로 비교합니다. 글자를 바꾼 게시물은 이 대조로 막지 못해 신고와 통보로 처리합니다.</p>
                  </section>
                  <section className="col" style={{ gap: "8px" }} aria-labelledby="log-t">
                    <h3 className="t-sm fw-b" id="log-t">조치·회신·제출 기록</h3>
                    <ul className="col" aria-labelledby="log-t">
                      <li className="col" style={{ gap: "4px", padding: "10px 0", borderBottom: "1px solid var(--border)" }}>
                        <span className="row" style={{ gap: "8px", alignItems: "flex-start" }}>
                          <span className="badge">차단</span>
                          <span className="t-sm">rv_7Q2M1 노출 차단 · 증적 리포트 생성</span>
                        </span>
                        <span className="t-xs muted">10/14 15:31 KST · 명령 10 · 민호</span>
                      </li>
                      <li className="col" style={{ gap: "4px", padding: "10px 0", borderBottom: "1px solid var(--border)" }}>
                        <span className="row" style={{ gap: "8px", alignItems: "flex-start" }}>
                          <span className="badge">접수</span>
                          <span className="t-sm">통보 등록 · 10시간(고시 사항)</span>
                        </span>
                        <span className="t-xs muted">
                          {v.onTime ? (
                            <>
                              <span>10/14 15:16 KST</span>
                            </>
                          ) : null}
                          {v.isOverdue ? (
                            <>
                              <span>10/14 09:31 KST</span>
                            </>
                          ) : null}
                          {' '}· 공문 · 민호
                        </span>
                      </li>
                      <li className="col" style={{ gap: "4px", padding: "10px 0" }}>
                        <span className="row" style={{ gap: "8px", alignItems: "flex-start" }}>
                          <span className="badge badge-warning">회신</span>
                          <span className="t-sm">결과 회신 대기 · 남은 1건 차단 뒤 회신</span>
                        </span>
                      </li>
                    </ul>
                  </section>
                </div>
              </section>
            </>
          ) : null}
          {' '}
          {v.isDr ? (
            <>
              <section className="widget" aria-labelledby="dr-t">
                <div className="widget-head" style={{ flexDirection: "column", alignItems: "stretch", gap: "6px", padding: "12px 14px" }}>
                  <span className="row between" style={{ gap: "6px" }}>
                    <span className="badge">자료 요청</span>
                    <span className={`badge ${v.drCls}`}>{v.drBadge}</span>
                  </span>
                  <h2 className="t-md fw-b" id="dr-t">{v.drTitle}</h2>
                </div>
                <div className="widget-body" style={{ gap: "20px" }}>
                  {v.drExp ? (
                    <>
                      <div className="banner banner-warning" role="status">
                        <i className="ic ic-clock" aria-hidden="true" />
                        <div className="banner-body">승인 대기가 끝나 접수 상태로 돌아갔습니다. 범위를 확인하고 다시 요청해 주세요</div>
                      </div>
                    </>
                  ) : null}
                  <div className="banner banner-info bigscreen" role="note">
                    <i className="ic ic-monitor" aria-hidden="true" />
                    <div className="banner-body">
                      <span className="banner-title">자료 추출 요청·승인·거부와 제출 기록은 태블릿이나 데스크톱에서 합니다</span>
                      휴대폰에서는 볼 수만 있습니다
                    </div>
                    <button className="btn btn-outline btn-sm" type="button">
                      <i className="ic ic-copy" aria-hidden="true" />
                      링크 복사
                    </button>
                  </div>
                  <section className="col" style={{ gap: "8px" }} aria-labelledby="drq-t">
                    <h3 className="t-sm fw-b" id="drq-t">요청서 · 요건 확인</h3>
                    <dl className="kv">
                      <dt>요청 기관</dt>
                      <dd>{v.drOrg}</dd>
                      <dt>종류</dt>
                      <dd>{v.drKind}</dd>
                      <dt>접수</dt>
                      <dd>{v.drRecvAt}</dd>
                      <dt>제출 기한</dt>
                      <dd>10/21(수)</dd>
                      <dt>대상</dt>
                      <dd>{v.drTarget}</dd>
                      <dt>요청서 원본</dt>
                      <dd>
                        <span className="mono t-xs">{v.drFile}</span>
                        {' '}· 검사 위협 없음
                      </dd>
                    </dl>
                    <p className="row t-sm" style={{ gap: "8px", alignItems: "flex-start" }}>
                      <i className="ic ic-check-circle ic-16 tx-success" aria-hidden="true" style={{ marginTop: "2px" }} />
                      <span>
                        <span className="sr-only">통과:</span>
                        법적 근거 · 요청 목적 · 대상 범위 · 제출 기한
                      </span>
                    </p>
                  </section>
                  <section className="col" style={{ gap: "8px" }} aria-labelledby="drs-t">
                    {v.drForm ? (
                      <>
                        <h3 className="t-sm fw-b" id="drs-t">추출 범위</h3>
                        <p className="t-sm muted">아직 추출을 요청하지 않았습니다. 요청서에 있는 항목은 가입자 정보(1행)입니다.</p>
                      </>
                    ) : null}
                    {' '}
                    {v.drPend ? (
                      <>
                        <h3 className="t-sm fw-b" id="drs-t">추출 요청 · commander 승인</h3>
                        <span className="badge badge-warning" style={{ alignSelf: "flex-start" }}>
                          <i className="ic ic-clock" aria-hidden="true" />
                          승인 대기 23:58 남음
                        </span>
                        <p className="t-xs muted">요청 수진(commander, 본인) · 10/14(수) 20:02 KST</p>
                        <ul className="col" style={{ gap: "6px" }} aria-label="고른 범위와 항목별 행 수">
                          <li className="row between t-sm" style={{ gap: "8px" }}>
                            <span>가입자 정보(통신이용자정보)</span>
                            <span className="num muted nowrap">10/1~10/12 · 1행</span>
                          </li>
                        </ul>
                        <p className="row t-sm" style={{ gap: "6px", alignItems: "flex-start" }}>
                          <i className="ic ic-lock ic-16 muted" aria-hidden="true" style={{ marginTop: "2px" }} />
                          <span>요청한 분은 승인할 수 없습니다. 다른 commander가 승인합니다</span>
                        </p>
                      </>
                    ) : null}
                    {' '}
                    {v.drAppr ? (
                      <>
                        <h3 className="t-sm fw-b" id="drs-t">추출 요청 · commander 승인</h3>
                        <span className="badge badge-warning" style={{ alignSelf: "flex-start" }}>
                          <i className="ic ic-clock" aria-hidden="true" />
                          승인 대기 23:36 남음
                        </span>
                        <p className="t-xs muted">요청 민호(operator) · 10/14(수) 19:40 KST</p>
                        <ul className="col" style={{ gap: "6px" }} aria-label="고른 범위와 항목별 행 수">
                          <li className="row between t-sm" style={{ gap: "8px" }}>
                            <span>예매 내역(게시물 2건 관련 주문)</span>
                            <span className="num muted nowrap">10/1~10/14 · 3행</span>
                          </li>
                          <li className="row between t-sm" style={{ gap: "8px" }}>
                            <span>접속기록(일시·IP·기기)</span>
                            <span className="num muted nowrap">10/1~10/14 · 41행</span>
                          </li>
                          <li className="row between t-sm" style={{ gap: "8px" }}>
                            <span>게시물 데이터</span>
                            <span className="num muted nowrap">10/13~10/14 · 2행</span>
                          </li>
                        </ul>
                        <p className="t-xs muted">구매자 연락처는 요청 범위 밖이라 고르지 않았습니다.</p>
                      </>
                    ) : null}
                    {' '}
                    {v.drSub ? (
                      <>
                        <h3 className="t-sm fw-b" id="drs-t">제출 파일</h3>
                        <span className="badge badge-success" style={{ alignSelf: "flex-start" }}>
                          <i className="ic ic-check" aria-hidden="true" />
                          승인됨 · 제출 기록 대기
                        </span>
                        <p className="t-xs muted">요청 수진 · 19:10 KST → 승인 [두 번째 commander] · 19:52 KST</p>
                        <dl className="kv">
                          <dt>파일</dt>
                          <dd>
                            <span className="mono t-xs">submission_D-2026-0022_20261014.csv</span>
                            {' '}· 1행
                          </dd>
                          <dt>SHA-256</dt>
                          <dd className="mono">d2684315…55bf</dd>
                        </dl>
                      </>
                    ) : null}
                  </section>
                  <section className="col" style={{ gap: "8px" }} aria-labelledby="drl-t">
                    <h3 className="t-sm fw-b" id="drl-t">처리 기록</h3>
                    <ul className="col" aria-labelledby="drl-t">
                      {v.drSub ? (
                        <>
                          <li className="col" style={{ gap: "4px", padding: "10px 0", borderBottom: "1px solid var(--border)" }}>
                            <span className="row" style={{ gap: "8px", alignItems: "flex-start" }}>
                              <span className="badge badge-success">승인</span>
                              <span className="t-sm">추출 승인 · 제출 파일 만듦</span>
                            </span>
                            <span className="t-xs muted">10/14 19:52 KST · [두 번째 commander]</span>
                          </li>
                        </>
                      ) : null}
                      {' '}
                      {v.drPend ? (
                        <>
                          <li className="col" style={{ gap: "4px", padding: "10px 0", borderBottom: "1px solid var(--border)" }}>
                            <span className="row" style={{ gap: "8px", alignItems: "flex-start" }}>
                              <span className="badge badge-warning">추출 요청</span>
                              <span className="t-sm">가입자 정보 1행</span>
                            </span>
                            <span className="t-xs muted">10/14 20:02 KST · 수진</span>
                          </li>
                        </>
                      ) : null}
                      {' '}
                      {v.drAppr ? (
                        <>
                          <li className="col" style={{ gap: "4px", padding: "10px 0", borderBottom: "1px solid var(--border)" }}>
                            <span className="row" style={{ gap: "8px", alignItems: "flex-start" }}>
                              <span className="badge badge-warning">추출 요청</span>
                              <span className="t-sm">예매 내역 3행 · 접속기록 41행 · 게시물 데이터 2행</span>
                            </span>
                            <span className="t-xs muted">10/14 19:40 KST · 민호</span>
                          </li>
                        </>
                      ) : null}
                      {' '}
                      {v.drExp ? (
                        <>
                          <li className="col" style={{ gap: "4px", padding: "10px 0", borderBottom: "1px solid var(--border)" }}>
                            <span className="row" style={{ gap: "8px", alignItems: "flex-start" }}>
                              <span className="badge badge-warning">만료</span>
                              <span className="t-sm">승인 대기 끝남 · 접수로 돌아감</span>
                            </span>
                            <span className="t-xs muted">10/14 19:40 KST · 시스템(10/13 19:40 수진 요청)</span>
                          </li>
                        </>
                      ) : null}
                      <li className="col" style={{ gap: "4px", padding: "10px 0" }}>
                        <span className="row" style={{ gap: "8px", alignItems: "flex-start" }}>
                          <span className="badge">접수</span>
                          <span className="t-sm">등록 · 요건 확인 통과</span>
                        </span>
                        <span className="t-xs muted">{v.drRecvLog} KST · 민호</span>
                      </li>
                    </ul>
                    <p className="t-xs muted">제출을 기록하면 제공 대장에 한 줄이 생기고, 보존 기간을 제공한 날부터 다시 셉니다.</p>
                  </section>
                </div>
              </section>
            </>
          ) : null}
        </div>
      </>
    ) : null}
    {' '}
    {v.isIncident ? (
      <>
        <div className="col" role="tabpanel" aria-labelledby="tb-i" style={{ gap: "12px" }}>
          <section className="widget" aria-labelledby="il-t">
            <div className="widget-head">
              <h2 className="t-sm fw-b" id="il-t">보안 사고</h2>
              <div className="actions"><span className="t-xs muted">진행 중 1</span></div>
            </div>
            <div className="widget-body" style={{ gap: "10px" }}>
              <ul className="col" style={{ gap: "8px" }}>
                <li>
                  <button className="card is-selected" type="button" aria-current="true" style={{ display: "flex", flexDirection: "column", gap: "6px", width: "100%", padding: "12px", borderRadius: "var(--r-lg)", textAlign: "left", cursor: "pointer" }}>
                    <span className="row between" style={{ gap: "6px" }}>
                      <span className="row" style={{ gap: "6px" }}>
                        <span className="badge badge-danger">SEV1</span>
                        <span className="mono t-xs">INC-2026-007</span>
                      </span>
                      <span className="badge badge-warning">{v.incBadge}</span>
                    </span>
                    {' '}
                    <span className="t-sm fw-b">관리 계정 탈취·개인정보 유출 의심</span>
                    {' '}
                    <span className="t-xs muted">인지 10/14(수) 19:48 KST · 대상 1,180명</span>
                    {' '}
                    <span className="row wrap" style={{ gap: "6px" }}>
                      <span className="t-xs muted">가장 가까운 기한: 침해사고 신고</span>
                      <span className="badge">
                        <i className="ic ic-clock" aria-hidden="true" />
                        23시간 43분
                      </span>
                    </span>
                  </button>
                </li>
              </ul>
              <Link to="/compliance" className="link-more" style={{ alignSelf: "flex-start" }}>
                종결된 보안 사고 보기
                <i className="ic ic-chevron-right" aria-hidden="true" />
              </Link>
              <div className="card-flat" style={{ display: "flex", flexDirection: "column", gap: "4px", padding: "12px 14px", borderRadius: "var(--r-lg)" }}>
                <span className="t-xs fw-b">경보 규칙</span>
                {' '}
                <span className="t-xs muted">등록하면 바로 SEV1로 알립니다. 24시간 기한은 22시간, 72시간 기한은 60시간이 지나면 SEV2로 다시 알립니다.</span>
              </div>
            </div>
          </section>
          <p className="eyebrow" style={{ marginTop: "4px" }}>선택한 항목</p>
          <section className="widget" aria-labelledby="idt-t">
            <div className="widget-head" style={{ flexDirection: "column", alignItems: "stretch", gap: "6px", padding: "12px 14px" }}>
              <span className="row between" style={{ gap: "6px" }}>
                <span className="badge badge-danger">SEV1</span>
                <span className="t-xs muted">등록 수진 · 20:01:40 KST</span>
              </span>
              <h2 className="t-md fw-b" id="idt-t">INC-2026-007 · 관리 계정 탈취·개인정보 유출 의심</h2>
            </div>
            <div className="widget-body" style={{ gap: "20px" }}>
              <section className="col" style={{ gap: "8px" }} aria-labelledby="ir-t">
                <h3 className="t-sm fw-b" id="ir-t">등록 정보</h3>
                <dl className="col" style={{ gap: "10px" }}>
                  <div className="col" style={{ gap: "2px" }}>
                    <dt className="t-xs muted">종류</dt>
                    <dd className="t-sm">침해사고 · 개인정보 유출</dd>
                  </div>
                  <div className="col" style={{ gap: "2px" }}>
                    <dt className="t-xs muted">인지 시각</dt>
                    <dd className="t-sm num">10/14(수) 19:48:00 KST · 기한은 이 시각부터 셉니다</dd>
                  </div>
                  <div className="col" style={{ gap: "2px" }}>
                    <dt className="t-xs muted">대상 수</dt>
                    <dd className="t-sm num">1,180명</dd>
                  </div>
                  <div className="col" style={{ gap: "2px" }}>
                    <dt className="t-xs muted">민감정보·고유식별정보</dt>
                    <dd className="t-sm">없음</dd>
                  </div>
                  <div className="col" style={{ gap: "2px" }}>
                    <dt className="t-xs muted">외부 불법 접근</dt>
                    <dd className="t-sm">있음(의심) · 처음 보는 해외 IP에서 파트너 관리 계정 로그인</dd>
                  </div>
                  <div className="col" style={{ gap: "2px" }}>
                    <dt className="t-xs muted">공격으로 생긴 장애</dt>
                    <dd className="t-sm">없음 · 관제 지표에서 자동으로 채움(20:04 KST 기준)</dd>
                  </div>
                </dl>
              </section>
              <section className="col" style={{ gap: "8px" }} aria-labelledby="ij-t">
                <h3 className="t-sm fw-b" id="ij-t">commander 해당 판단</h3>
                <p className="t-sm muted">해당 여부는 commander가 판단합니다. 판단이 서지 않으면 신고·통지하는 쪽으로 합니다.</p>
                {v.ijDone ? (
                  <>
                    <div className="card-flat" role="status" style={{ display: "flex", flexDirection: "column", gap: "6px", padding: "12px 14px", borderRadius: "var(--r-lg)" }}>
                      <span className="row wrap" style={{ gap: "6px" }}>
                        <span className="badge badge-warning">판단이 서지 않음</span>
                        <span className="t-xs">신고·통지하는 쪽으로</span>
                      </span>
                      {' '}
                      <span className="t-sm">계정 탈취 경로를 확인하는 중입니다. 외부 접근과 1천 명 이상이 겹쳐 신고·통지를 준비합니다.</span>
                      {' '}
                      <span className="t-xs muted">판단 수진 · 10/14(수) 20:03:10 KST</span>
                    </div>
                    <p className="t-xs muted">판단은 한 번만 기록합니다. 고칠 일이 생기면 사후 검토에 적습니다.</p>
                  </>
                ) : null}
                <div className="banner banner-info bigscreen" role="note">
                  <i className="ic ic-monitor" aria-hidden="true" />
                  <div className="banner-body">
                    <span className="banner-title">해당 판단과 신고·통지 기록은 태블릿이나 데스크톱에서 합니다</span>
                    휴대폰에서는 볼 수만 있습니다
                  </div>
                  <button className="btn btn-outline btn-sm" type="button">
                    <i className="ic ic-copy" aria-hidden="true" />
                    링크 복사
                  </button>
                </div>
              </section>
              <section className="col" style={{ gap: "8px" }} aria-labelledby="io-t">
                <h3 className="t-sm fw-b" id="io-t">의무별 기한</h3>
                <p className="t-xs muted">시간 기한은 2시간 전, 72시간 기한은 12시간 전부터 경고로 바뀝니다</p>
                <ul className="card" style={{ display: "flex", flexDirection: "column", padding: "2px 12px", borderRadius: "var(--r-lg)" }} aria-label="의무별 신고·통지 기한 7개">
                  <li className="col" style={{ gap: "4px", padding: "10px 0", borderBottom: "1px solid var(--border)" }}>
                    <span className="row between" style={{ gap: "8px" }}>
                      <span className="t-sm fw-b">침해사고 신고</span>
                      <span className="badge">
                        <i className="ic ic-clock" aria-hidden="true" />
                        <span className="sr-only">남은 시간</span>
                        23시간 43분
                      </span>
                    </span>
                    {' '}
                    <span className="t-xs muted">정보통신망법 §48의3① · 과학기술정보통신부·한국인터넷진흥원</span>
                    {' '}
                    <span className="row between t-xs" style={{ gap: "8px" }}>
                      <span className="num">24시간 · 10/15(목) 19:48</span>
                      <span>준비 중</span>
                    </span>
                  </li>
                  <li className="col" style={{ gap: "4px", padding: "10px 0", borderBottom: "1px solid var(--border)" }}>
                    <span className="t-sm fw-b">추가 사실 신고</span>
                    {' '}
                    <span className="t-xs muted">시행령 §58의8② · 같은 기관</span>
                    {' '}
                    <span className="row between t-xs" style={{ gap: "8px" }}>
                      <span>추가 사실 확인 뒤 24시간</span>
                      <span className="muted">확인 때 시작</span>
                    </span>
                  </li>
                  <li className="col" style={{ gap: "4px", padding: "10px 0", borderBottom: "1px solid var(--border)" }}>
                    <span className="row between" style={{ gap: "8px" }}>
                      <span className="t-sm fw-b">이용자 통지</span>
                      <span className="badge badge-warning">
                        <i className="ic ic-alert" aria-hidden="true" />
                        <span className="sr-only">남은 시간</span>
                        지체 없이
                      </span>
                    </span>
                    {' '}
                    <span className="t-xs muted">정보통신망법 §48의3④ · 이용자</span>
                    {' '}
                    <span className="row between t-xs" style={{ gap: "8px", alignItems: "flex-start" }}>
                      <span>지체 없이(유출 가능성·장애 2시간 이상)</span>
                      <span className="nowrap">준비 중</span>
                    </span>
                  </li>
                  <li className="col" style={{ gap: "4px", padding: "10px 0", borderBottom: "1px solid var(--border)" }}>
                    <span className="t-sm fw-b">피해구제 조치 제출</span>
                    {' '}
                    <span className="t-xs muted">시행령 §60의16 · 과학기술정보통신부</span>
                    {' '}
                    <span className="row between t-xs" style={{ gap: "8px" }}>
                      <span>신고일부터 14일</span>
                      <span className="muted">신고 뒤 시작</span>
                    </span>
                  </li>
                  <li className="col" style={{ gap: "4px", padding: "10px 0", borderBottom: "1px solid var(--border)" }}>
                    <span className="row between" style={{ gap: "8px" }}>
                      <span className="t-sm fw-b">정보주체 통지</span>
                      <span className="badge">
                        <i className="ic ic-clock" aria-hidden="true" />
                        <span className="sr-only">남은 시간</span>
                        71시간 43분
                      </span>
                    </span>
                    {' '}
                    <span className="t-xs muted">개인정보 보호법 §34 · 정보주체 1,180명</span>
                    {' '}
                    <span className="row between t-xs" style={{ gap: "8px" }}>
                      <span className="num">72시간 · 10/17(토) 19:48</span>
                      <span>준비 중</span>
                    </span>
                  </li>
                  <li className="col" style={{ gap: "4px", padding: "10px 0", borderBottom: "1px solid var(--border)" }}>
                    <span className="row between" style={{ gap: "8px" }}>
                      <span className="t-sm fw-b">유출 신고</span>
                      <span className="badge">
                        <i className="ic ic-clock" aria-hidden="true" />
                        <span className="sr-only">남은 시간</span>
                        71시간 43분
                      </span>
                    </span>
                    {' '}
                    <span className="t-xs muted">개인정보 보호법 §34, 시행령 §40 · 개인정보보호위원회·한국인터넷진흥원</span>
                    {' '}
                    <span className="row between t-xs" style={{ gap: "8px" }}>
                      <span className="num">72시간 · 10/17(토) 19:48</span>
                      <span>준비 중</span>
                    </span>
                  </li>
                  <li className="col" style={{ gap: "4px", padding: "10px 0" }}>
                    <span className="t-sm fw-b">유출 가능성 통지</span>
                    {' '}
                    <span className="t-xs muted">시행령 §39의2·§39의3 · 정보주체</span>
                    {' '}
                    <span className="row between t-xs" style={{ gap: "8px" }}>
                      <span>72시간</span>
                      <span className="muted">해당 없음(유출로 등록)</span>
                    </span>
                  </li>
                </ul>
              </section>
              <section className="col" style={{ gap: "8px" }} aria-labelledby="if-t">
                <h3 className="t-sm fw-b" id="if-t">신고·통지 기록</h3>
                <p className="card-flat t-sm muted" style={{ padding: "14px 16px", borderRadius: "var(--r-lg)", textAlign: "center" }}>
                  아직 기록이 없습니다. 신고·통지할 때마다 기관, 방법, 시각, 내용 요약을 남깁니다.
                </p>
                <div className="card-flat" style={{ display: "flex", flexDirection: "column", gap: "4px", padding: "12px 14px", borderRadius: "var(--r-lg)" }}>
                  <span className="t-xs fw-b">이용자 통지 문안 미리보기</span>
                  {' '}
                  <span className="t-xs muted">문안 A · 개인정보 유출 통지(개인정보 보호법 §34①·시행령 §39) · 받는 사람 1,180명 · 이메일</span>
                  {' '}
                  <span className="t-sm fw-b">제목: [피켓] 개인정보 유출 사실을 알려 드립니다</span>
                  {' '}
                  <span className="t-sm">안녕하세요, PEAKET(피켓)입니다. 회원님의 개인정보가 유출된 사실을 10/14(수) 19:48에 확인했습니다. …</span>
                  {' '}
                  <span className="t-sm">
                    1. 유출된 개인정보 항목 [항목] · 2. 유출된 시점과 경위 [시점] · [경위] · 3. 회원님이 하실 수 있는 일 · 4. 대응 조치와 피해 구제 절차 · 5. 피해 신고·문의 · 6. 법적 권리
                  </span>
                  {' '}
                  <span className="t-xs muted">3~6번을 채워야 보낼 수 있습니다. 1·2번이 확인 중이면 '확인 중' 단서를 붙여 먼저 보냅니다(시행령 §39②).</span>
                </div>
              </section>
              <p className="t-xs muted" style={{ paddingTop: "12px", borderTop: "1px solid var(--border)" }}>{v.closeWhy} 종결은 태블릿이나 데스크톱에서 합니다.</p>
            </div>
          </section>
        </div>
      </>
    ) : null}
    {' '}
    {v.isReview ? (
      <>
        <div className="col" role="tabpanel" aria-labelledby="tb-r" style={{ gap: "12px" }}>
          <section className="widget" aria-labelledby="rl-t">
            <div className="widget-head">
              <h2 className="t-sm fw-b" id="rl-t">10월 정기 점검</h2>
              <div className="actions"><span className="t-xs muted">점검자 수진 · commander</span></div>
            </div>
            <div className="widget-body" style={{ gap: "10px" }}>
              <div className="col" style={{ gap: "6px" }}>
                {v.selfOpen ? (
                  <>
                    <div className="row between">
                      <span className="t-xs">이상 건 5건 중 2건 종결</span>
                      <span className="t-xs muted num">40%</span>
                    </div>
                    <div className="progress" role="progressbar" aria-label="10월 정기 점검 진행" aria-valuemin={0} aria-valuemax={5} aria-valuenow={2} aria-valuetext="5건 중 2건 종결">
                      <span style={{ width: "40%" }} />
                    </div>
                  </>
                ) : null}
                {v.selfDone ? (
                  <>
                    <div className="row between">
                      <span className="t-xs">이상 건 5건 중 3건 종결</span>
                      <span className="t-xs muted num">60%</span>
                    </div>
                    <div className="progress" role="progressbar" aria-label="10월 정기 점검 진행" aria-valuemin={0} aria-valuemax={5} aria-valuenow={3} aria-valuetext="5건 중 3건 종결">
                      <span style={{ width: "60%" }} />
                    </div>
                  </>
                ) : null}
                {' '}
                <span className="t-xs muted">10/31까지 끝내지 않으면 SEV3로 알립니다</span>
              </div>
              <ul className="col" style={{ gap: "8px" }}>
                <li>
                  <button className="card" type="button" style={{ display: "flex", flexDirection: "column", gap: "4px", width: "100%", padding: "10px 12px", borderRadius: "var(--r-lg)", textAlign: "left", cursor: "pointer" }}>
                    <span className="row between" style={{ gap: "6px" }}>
                      <span className="mono t-xs">A-1031</span>
                      <span className="badge badge-danger">유출 의심</span>
                    </span>
                    {' '}
                    <span className="t-sm fw-b">같은 명단을 24시간에 3회 이상 내려받음</span>
                    {' '}
                    <span className="t-xs muted">파트너 관리자 · (주)스텔라엔터테인먼트 · 2026-10-14 07:12 UTC</span>
                  </button>
                </li>
                <li>
                  <button className="card is-selected" type="button" aria-current="true" style={{ display: "flex", flexDirection: "column", gap: "4px", width: "100%", padding: "10px 12px", borderRadius: "var(--r-lg)", textAlign: "left", cursor: "pointer" }}>
                    <span className="row between" style={{ gap: "6px" }}>
                      <span className="mono t-xs">A-1032</span>
                      <span className="badge badge-warning">확인 중</span>
                    </span>
                    {' '}
                    <span className="t-sm fw-b">근무 일정 밖 조회</span>
                    {' '}
                    <span className="t-xs muted">다은 · cs_agent · 2026-10-11 17:14 UTC</span>
                  </button>
                </li>
                <li>
                  <button className="card" type="button" style={{ display: "flex", flexDirection: "column", gap: "4px", width: "100%", padding: "10px 12px", borderRadius: "var(--r-lg)", textAlign: "left", cursor: "pointer" }}>
                    <span className="row between" style={{ gap: "6px" }}>
                      <span className="mono t-xs">A-1034</span>
                      {v.selfOpen ? (
                        <>
                          <span className="badge">
                            <i className="ic ic-lock" aria-hidden="true" />
                            본인 기록
                          </span>
                        </>
                      ) : null}
                      {v.selfDone ? (
                        <>
                          <span className="row" style={{ gap: "4px" }}>
                            <span className="badge badge-success">종결</span>
                            <span className="badge badge-outline">자기 점검(시연)</span>
                          </span>
                        </>
                      ) : null}
                    </span>
                    {' '}
                    <span className="t-sm fw-b">허용 IP 밖 접속 시도</span>
                    {' '}
                    <span className="t-xs muted">수진 · commander · 2026-10-14 00:42 UTC</span>
                  </button>
                </li>
                <li>
                  <button className="card" type="button" style={{ display: "flex", flexDirection: "column", gap: "4px", width: "100%", padding: "10px 12px", borderRadius: "var(--r-lg)", textAlign: "left", cursor: "pointer" }}>
                    <span className="row between" style={{ gap: "6px" }}>
                      <span className="mono t-xs">A-1033</span>
                      <span className="badge badge-success">종결</span>
                    </span>
                    {' '}
                    <span className="t-sm fw-b">근무 일정 밖 조회</span>
                    {' '}
                    <span className="t-xs muted">준 · cs_lead · 2026-10-08 16:20 UTC</span>
                  </button>
                </li>
                <li>
                  <button className="card" type="button" style={{ display: "flex", flexDirection: "column", gap: "4px", width: "100%", padding: "10px 12px", borderRadius: "var(--r-lg)", textAlign: "left", cursor: "pointer" }}>
                    <span className="row between" style={{ gap: "6px" }}>
                      <span className="mono t-xs">A-1030</span>
                      <span className="badge badge-success">종결</span>
                    </span>
                    {' '}
                    <span className="t-sm fw-b">권한 밖 조회 시도</span>
                    {' '}
                    <span className="t-xs muted">서연 · viewer · 2026-10-05 02:31 UTC</span>
                  </button>
                </li>
              </ul>
              <p className="t-xs muted">
                자동 탐지 규칙: 같은 명단 24시간 3회 이상 · 한 번에 1만 건 이상 · 근무 일정 밖 조회·다운로드 · 허용 IP 밖 접속 시도 · 권한 밖 조회 시도. 기준 값은 내부 관리계획에서 확정합니다.
              </p>
            </div>
          </section>
          <p className="eyebrow" style={{ marginTop: "4px" }}>선택한 항목</p>
          <section className="widget" aria-labelledby="rd-t">
            <div className="widget-head" style={{ flexDirection: "column", alignItems: "stretch", gap: "6px", padding: "12px 14px" }}>
              <span className="row between" style={{ gap: "6px" }}>
                <span className="mono t-xs">A-1032</span>
                <span className="badge badge-warning">확인 중</span>
              </span>
              <h2 className="t-md fw-b" id="rd-t">근무 일정 밖 조회 · 다은(cs_agent)</h2>
            </div>
            <div className="widget-body" style={{ gap: "20px" }}>
              <dl className="col" style={{ gap: "10px" }} aria-label="이상 건 기록">
                <div className="col" style={{ gap: "2px" }}>
                  <dt className="t-xs muted">계정</dt>
                  <dd className="t-sm">다은 · cs_agent</dd>
                </div>
                <div className="col" style={{ gap: "2px" }}>
                  <dt className="t-xs muted">시각</dt>
                  <dd className="t-sm num">2026-10-11 17:14:51 UTC (10/12(월) 02:14 KST)</dd>
                </div>
                <div className="col" style={{ gap: "2px" }}>
                  <dt className="t-xs muted">행위</dt>
                  <dd className="t-sm">CS 처리함 건 3건 열람 · 결제자 연락처 가림 해제 2건</dd>
                </div>
                <div className="col" style={{ gap: "2px" }}>
                  <dt className="t-xs muted">당시 열람 사유</dt>
                  <dd className="t-sm">결제 상태 불명 문의 회신</dd>
                </div>
                <div className="col" style={{ gap: "2px" }}>
                  <dt className="t-xs muted">탐지 규칙</dt>
                  <dd className="t-sm">근무 일정 밖 조회·다운로드</dd>
                </div>
                <div className="col" style={{ gap: "2px" }}>
                  <dt className="t-xs muted">접속</dt>
                  <dd className="t-sm">허용 IP 안 · 등록된 관리 기기</dd>
                </div>
              </dl>
              <div className="banner banner-info bigscreen" role="note">
                <i className="ic ic-monitor" aria-hidden="true" />
                <div className="banner-body">
                  <span className="banner-title">접속기록 점검과 보안 사고 등록은 태블릿이나 데스크톱에서 합니다</span>
                  휴대폰에서는 볼 수만 있습니다
                </div>
                <button className="btn btn-outline btn-sm" type="button">
                  <i className="ic ic-copy" aria-hidden="true" />
                  링크 복사
                </button>
              </div>
              <section className="card-flat" aria-labelledby="self-t" style={{ display: "flex", flexDirection: "column", gap: "8px", padding: "14px 16px", borderRadius: "var(--r-lg)" }}>
                <div className="row" style={{ gap: "8px" }}>
                  <i className="ic ic-lock ic-16" aria-hidden="true" />
                  <h3 className="t-sm fw-b" id="self-t">내 접속기록 이상 건 1건 · A-1034</h3>
                </div>
                <p className="t-xs muted">허용 IP 밖 접속 시도 · 수진 · commander · 2026-10-14 00:42:05 UTC</p>
                {v.selfProd ? (
                  <>
                    <p className="t-xs">본인 접속기록은 다른 commander가 점검하고 종결합니다.</p>
                  </>
                ) : null}
                {v.selfDemo ? (
                  <>
                    <p className="t-xs">데모 환경에서만 본인 기록을 '자기 점검(시연)'으로 종결할 수 있습니다. 종결은 태블릿이나 데스크톱에서 합니다.</p>
                  </>
                ) : null}
                {v.selfDone ? (
                  <>
                    <div className="col" style={{ gap: "6px" }} role="status">
                      <span className="row wrap" style={{ gap: "6px" }}>
                        <span className="badge badge-success">종결</span>
                        <span className="badge badge-outline">자기 점검(시연)</span>
                      </span>
                      <span className="t-xs">사유 확인: VPN을 다시 잇는 동안 허용 IP 밖에서 한 번 접속을 시도했습니다 · 사후조치 없음</span>
                      <span className="t-xs muted">종결 수진 · 10/14(수) 20:04 KST · 데모 환경 기록</span>
                    </div>
                  </>
                ) : null}
              </section>
            </div>
          </section>
        </div>
      </>
    ) : null}
    </>
  );
}

