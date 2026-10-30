// 디자인 캔버스 보드 SCR-032-d.dc.html를 옮긴 것(dc2tsx 생성 뒤 손질)
/* eslint-disable */
import { Fragment, type FormEvent } from 'react';
import { Link } from 'react-router';
import { Overlay } from '@/shared/ui/Overlay';

const prevent = (e: FormEvent) => e.preventDefault();
void Fragment;
void Link;

type AriaBool = boolean | 'true' | 'false';
type AriaCurrent = boolean | 'true' | 'false' | 'page' | 'step' | 'location' | 'date' | 'time';

export const STATES_D = ["통보", "노출 차단 확인", "기한 초과", "보안 사고", "접속기록 점검", "자료 요청 · 접수", "자료 요청 · 승인 대기(본인 요청)", "자료 요청 · commander 승인", "자료 요청 · 승인 대기 만료", "자료 요청 · 제출 기록", "자료 요청 · 해시 불일치", "통보 철회 복원", "보안 사고 · 판단 기록 뒤", "접속기록 점검 · 데모 환경", "접속기록 점검 · 데모 자기 점검 종결"] as const;
export const DEFAULT_D = "통보";

export function valsD(state: string) {
    let st = state || '통보';
    let drRecv = st === '자료 요청 · 접수';
    let drPend = st === '자료 요청 · 승인 대기(본인 요청)';
    let drAppr = st === '자료 요청 · commander 승인';
    let drExp = st === '자료 요청 · 승인 대기 만료';
    let drSubOk = st === '자료 요청 · 제출 기록';
    let drHash = st === '자료 요청 · 해시 불일치';
    let drSub = drSubOk || drHash;
    let d22 = drRecv || drPend || drExp || drSub;
    let dr = d22 || drAppr;
    let wd = st === '통보 철회 복원';
    let incDone = st === '보안 사고 · 판단 기록 뒤';
    let demo = st === '접속기록 점검 · 데모 환경';
    let demoDone = st === '접속기록 점검 · 데모 자기 점검 종결';
    let notice = st === '통보' || st === '노출 차단 확인' || st === '기한 초과' || dr || wd;
    let incident = st === '보안 사고' || incDone;
    let review = st === '접속기록 점검' || demo || demoDone;
    return {
      isNoticeTab: notice,
      isIncident: incident,
      isReview: review,
      isOverdue: st === '기한 초과',
      onTime: st === '통보' || st === '노출 차단 확인' || dr || wd,
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
      drKind: drAppr ? '부정판매 사실 확인 · 공연법 §4의3' : '통신이용자정보 · 전기통신사업법 §83',
      drRecvAt: drAppr ? '10/14(수) 15:16 KST · 민호' : '10/12(월) 11:05 KST · 민호',
      drTarget: drAppr ? '요청서에 적힌 게시물 2건 관련 예매 내역·접속기록' : '요청서에 적힌 회원 1명',
      drFile: drAppr ? 'official-letter_D-2026-0023_20261014.pdf' : 'official-letter_D-2026-0022_20261012.pdf',
      drRecvLog: drAppr ? '10/14 15:16' : '10/12 11:05',
      d22Badge: drPend ? '승인 대기' : (drSub ? '제출 기록 대기' : '접수'),
      d22Cls: drSub ? 'badge-primary' : 'badge-warning',
      ijOpen: !incDone,
      ijDone: incDone,
      incBadge: incDone ? '신고·통지 준비' : '해당 판단 중',
      closeWhy: incDone ? '남은 신고·통지 의무를 모두 기록하면 닫을 수 있습니다.' : '해당 판단을 기록하고 남은 신고·통지 의무를 모두 기록하면 닫을 수 있습니다.',
      envLbl: (demo || demoDone) ? '데모 환경' : '운영 환경',
      selfProd: !(demo || demoDone),
      selfDemo: demo,
      selfDone: demoDone,
      selfOpen: !demoDone,
      isTakedown: st === '노출 차단 확인',
      sevNormal: !incident,
      t1c: notice ? 'is-active' : '',
      t1s: notice ? 'true' : 'false',
      t2c: incident ? 'is-active' : '',
      t2s: incident ? 'true' : 'false',
      t3c: review ? 'is-active' : '',
      t3s: review ? 'true' : 'false'
    };
  }

type V = ReturnType<typeof valsD>;

// 보드 루트: {"class": "pk dark cs", "style": "width:100%;min-height:1980px"}

// <main class="cs-main" id="main">
export function MainD({ v, close, go }: { v: V; close?: () => void; go?: (state: string) => void }) {
  void v; void close; void go;
  return (
    <>
    <div className="page-head">
      <div className="col" style={{ gap: "4px", maxWidth: "760px" }}>
        <h1>법정 조치</h1>
        <p className="t-sm muted">통보·자료 요청, 보안 사고, 접속기록 점검을 법정 기한과 함께 처리합니다. 기한은 접수·인지 시각부터 셉니다.</p>
      </div>
      <div className="row wrap" style={{ gap: "8px" }}>
        <button className="btn btn-outline btn-sm" type="button">
          <i className="ic ic-plus" aria-hidden="true" />
          통보 등록하기
        </button>
        {' '}
        <button className="btn btn-outline btn-sm" type="button">
          <i className="ic ic-plus" aria-hidden="true" />
          자료 요청 등록하기
        </button>
        {' '}
        <button className="btn btn-danger-outline btn-sm" type="button">
          <i className="ic ic-shield" aria-hidden="true" />
          보안 사고 등록하기
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
    <div className="tabs" role="tablist" aria-label="법정 조치 종류">
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
        <div className="grid-12" role="tabpanel" aria-labelledby="tb-n" style={{ alignItems: "start" }}>
          <section className="widget span-4" aria-labelledby="nl-t">
            <div className="widget-head">
              <h2 id="nl-t" style={{ fontSize: "13px", lineHeight: "18px" }}>통보·자료 요청</h2>
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
              <ul className="col" style={{ gap: "6px" }}>
                <li>
                  <button className={`card ${v.n41Sel}`} type="button" aria-current={(v.n41Cur) as AriaCurrent} style={{ display: "flex", flexDirection: "column", gap: "6px", width: "100%", padding: "12px", borderRadius: "var(--r-lg)", textAlign: "left", cursor: "pointer" }}>
                    <span className="row between" style={{ gap: "6px" }}>
                      <span className="row" style={{ gap: "6px" }}>
                        <span className="badge badge-primary">통보</span>
                        <span className="mono t-xs">N-2026-0141</span>
                      </span>
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
                <span className="t-xs fw-b">⑥ 반기 보고 현황 · 2026년 하반기</span>
                {' '}
                <span className="t-xs muted">통신이용자정보 제공 3건(반기 종료 뒤 30일 안, 2027-01-30까지 보고) · 통신사실확인자료 0건(연 2회 보고) · 받는 곳 과학기술정보통신부</span>
              </div>
            </div>
          </section>
          {v.isNd ? (
            <>
              <section className="widget span-8" aria-labelledby="nd-t">
                <div className="widget-head" style={{ minHeight: "52px", gap: "10px" }}>
                  <span className="badge badge-primary">통보</span>
                  <h2 className="t-md fw-b" id="nd-t">N-2026-0141 · 한국콘텐츠진흥원 게시물 노출 차단 통보</h2>
                  <div className="actions">
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
                  </div>
                </div>
                <div className="widget-body" style={{ gap: "16px", padding: "16px" }}>
                  {v.onTime ? (
                    <>
                      <div className="row between wrap" style={{ gap: "12px", padding: "14px 16px", borderRadius: "var(--r-lg)", background: "var(--surface-muted)", boxShadow: "inset 0 0 0 1px var(--border)" }}>
                        <div className="col" style={{ gap: "4px" }}>
                          <span className="eyebrow">법정 처리 기한 · 10시간(고시 사항)</span>
                          {' '}
                          <span className="t-xl num" role="timer">법정 기한 남은 시간: 5시간 12분</span>
                          {' '}
                          <span className="t-xs muted">접수 10/14(수) 15:16:12 → 기한 10/15(목) 01:16:12 KST · 2시간 전 SEV2</span>
                        </div>
                        <span className="badge badge-lg">
                          <i className="ic ic-clock" aria-hidden="true" />
                          기한 안
                        </span>
                      </div>
                    </>
                  ) : null}
                  {' '}
                  {v.isOverdue ? (
                    <>
                      <div className="row between wrap" style={{ gap: "12px", padding: "14px 16px", borderRadius: "var(--r-lg)", background: "var(--danger-subtle)", boxShadow: "inset 0 0 0 1px var(--danger)" }}>
                        <div className="col" style={{ gap: "4px" }}>
                          <span className="eyebrow">법정 처리 기한 · 10시간(고시 사항)</span>
                          {' '}
                          <span className="t-xl num tx-danger" role="timer">법정 기한 33분 초과</span>
                          {' '}
                          <span className="t-xs muted">접수 10/14(수) 09:31:12 → 기한 10/14(수) 19:31:12 KST · 17:31 SEV2 알림</span>
                        </div>
                        <span className="badge badge-lg badge-danger">
                          <i className="ic ic-alert" aria-hidden="true" />
                          기한 초과
                        </span>
                      </div>
                    </>
                  ) : null}
                  <section className="col" style={{ gap: "8px" }} aria-labelledby="reg-t">
                    <h3 className="t-sm fw-b" id="reg-t">① 통보 등록</h3>
                    <div className="table-wrap">
                      <table className="table dense" aria-label="통보 등록 정보">
                        <tbody>
                          <tr>
                            <th scope="row" style={{ width: "84px" }}>발송 기관</th>
                            <td>한국콘텐츠진흥원(신고기관)</td>
                          </tr>
                          <tr>
                            <th scope="row">공문 번호</th>
                            <td>[공문 번호]</td>
                          </tr>
                          <tr>
                            <th scope="row">접수 시각</th>
                            <td className="num">
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
                            </td>
                          </tr>
                          <tr>
                            <th scope="row">처리 기한</th>
                            <td>
                              <span className="row wrap" style={{ gap: "4px 14px" }}>
                                <label className="check-row" style={{ fontSize: "13px", lineHeight: "18px" }}>
                                  <input className="rd" type="radio" name="dl-kind" disabled />
                                  24시간
                                </label>
                                <label className="check-row" style={{ fontSize: "13px", lineHeight: "18px" }}>
                                  <input className="rd" type="radio" name="dl-kind" defaultChecked disabled />
                                  10시간(고시 사항)
                                </label>
                              </span>
                            </td>
                          </tr>
                          <tr>
                            <th scope="row">근거</th>
                            <td>공연법 §4의2, 시행령 §3의3</td>
                          </tr>
                          <tr>
                            <th scope="row">공문 원본</th>
                            <td>
                              <span className="col" style={{ gap: "6px", alignItems: "flex-start" }}>
                                <span className="row wrap" style={{ gap: "6px" }}>
                                  <i className="ic ic-doc ic-16 muted" aria-hidden="true" />
                                  <span className="mono t-xs">official-letter_N-2026-0141_20261014.pdf</span>
                                  <span className="badge badge-success">검사 위협 없음</span>
                                </span>
                                <span className="row wrap" style={{ gap: "6px" }}>
                                  <button className="btn btn-outline btn-sm" type="button">
                                    <i className="ic ic-download" aria-hidden="true" />
                                    내려받기
                                  </button>
                                  <button className="btn btn-ghost btn-sm" type="button" aria-describedby="doc-h">
                                    <i className="ic ic-upload" aria-hidden="true" />
                                    원본 올리기
                                  </button>
                                </span>
                                <span className="t-xs muted" id="doc-h">PDF만, 한 파일 20MB까지 받습니다. 악성 코드 검사에서 위협이 없다고 나온 파일만 내려받을 수 있습니다.</span>
                              </span>
                            </td>
                          </tr>
                        </tbody>
                      </table>
                    </div>
                  </section>
                  <section className="col" style={{ gap: "8px" }} aria-labelledby="post-t">
                    <div className="row between wrap" style={{ gap: "8px" }}>
                      <h3 className="t-sm fw-b" id="post-t">② 대상 게시물</h3>
                      <span className="t-xs muted">공문에 적힌 게시물 ID만 차단할 수 있습니다(명령 10, operator 1인)</span>
                    </div>
                    <div className="table-wrap">
                      <table className="table dense" aria-label="대상 게시물 2건">
                        <thead>
                          <tr>
                            <th scope="col">게시물 ID</th>
                            <th scope="col">위치</th>
                            <th scope="col">작성 시각(KST)</th>
                            <th scope="col">본문 지문</th>
                            <th scope="col">상태</th>
                            <th scope="col">조치</th>
                          </tr>
                        </thead>
                        <tbody>
                          <tr>
                            <td className="mono">rv_7Q2K9</td>
                            <td>[지난 공연명] · 관람 후기</td>
                            <td className="num">10/14 13:02</td>
                            <td className="mono t-xs">9f3c…51e0</td>
                            <td><span className="badge badge-warning">노출 중</span></td>
                            <td>
                              <button className="btn btn-danger btn-sm" type="button">
                                <i className="ic ic-ban" aria-hidden="true" />
                                노출 차단
                                <span className="sr-only">게시물 rv_7Q2K9</span>
                              </button>
                            </td>
                          </tr>
                          <tr>
                            <td className="mono">rv_7Q2M1</td>
                            <td>[지난 공연명] · 관람 후기</td>
                            <td className="num">10/14 13:05</td>
                            <td className="mono t-xs">2b7a…c419</td>
                            <td><span className="badge badge-success">차단함 15:31</span></td>
                            <td className="muted">—</td>
                          </tr>
                        </tbody>
                      </table>
                    </div>
                    <div className="row between wrap" style={{ gap: "8px", alignItems: "center" }}>
                      <p className="t-xs muted" id="rs-why" style={{ flex: "1", minWidth: "240px" }}>
                        통보가 정식으로 철회되면 통보 단위로 되살립니다. 이 통보로 가린 게시물과 같은 내용으로 자동 숨긴 글을 함께 되살립니다.
                      </p>
                      <button className="btn btn-outline btn-sm" type="button" aria-haspopup="dialog" aria-describedby="rs-why">
                        <i className="ic ic-undo" aria-hidden="true" />
                        통보 철회로 복원하기
                      </button>
                    </div>
                  </section>
                  <section className="col" style={{ gap: "8px" }} aria-labelledby="fp-t">
                    <h3 className="t-sm fw-b" id="fp-t">같은 내용 차단 목록</h3>
                    <div className="table-wrap">
                      <table className="table dense" aria-label="같은 내용 차단 지문 1건">
                        <thead>
                          <tr>
                            <th scope="col">본문 지문</th>
                            <th scope="col">출처</th>
                            <th scope="col" className="r">자동 숨김</th>
                            <th scope="col">등록</th>
                          </tr>
                        </thead>
                        <tbody>
                          <tr>
                            <td className="mono t-xs">2b7a…c419</td>
                            <td className="mono">rv_7Q2M1</td>
                            <td className="r">1건</td>
                            <td className="num">15:31</td>
                          </tr>
                        </tbody>
                      </table>
                    </div>
                    <p className="t-xs muted">본문을 NFKC로 맞추고 공백·문장부호를 뺀 SHA-256 지문으로 비교합니다. 글자를 바꾼 게시물은 이 대조로 막지 못해 신고와 통보로 처리합니다.</p>
                  </section>
                  <section className="col" style={{ gap: "8px" }} aria-labelledby="log-t">
                    <div className="row between wrap" style={{ gap: "8px" }}>
                      <h3 className="t-sm fw-b" id="log-t">③ 조치·회신·제출 기록</h3>
                      <button className="btn btn-outline btn-sm" type="button">
                        <i className="ic ic-plus" aria-hidden="true" />
                        회신 기록 추가하기
                      </button>
                    </div>
                    <div className="table-wrap">
                      <table className="table dense" aria-label="조치·회신·제출 기록">
                        <thead>
                          <tr>
                            <th scope="col">일시(KST)</th>
                            <th scope="col">구분</th>
                            <th scope="col">내용</th>
                            <th scope="col">방법</th>
                            <th scope="col">담당</th>
                          </tr>
                        </thead>
                        <tbody>
                          <tr>
                            <td className="num">10/14 15:31</td>
                            <td><span className="badge">차단</span></td>
                            <td>rv_7Q2M1 노출 차단 · 증적 리포트 생성</td>
                            <td>명령 10</td>
                            <td>민호</td>
                          </tr>
                          <tr>
                            <td className="num">
                              {v.onTime ? (
                                <>
                                  <span>10/14 15:16</span>
                                </>
                              ) : null}
                              {v.isOverdue ? (
                                <>
                                  <span>10/14 09:31</span>
                                </>
                              ) : null}
                            </td>
                            <td><span className="badge">접수</span></td>
                            <td>통보 등록 · 10시간(고시 사항)</td>
                            <td>공문</td>
                            <td>민호</td>
                          </tr>
                          <tr>
                            <td className="muted">—</td>
                            <td><span className="badge badge-warning">회신</span></td>
                            <td>결과 회신 대기 · 남은 1건 차단 뒤 회신</td>
                            <td className="muted">—</td>
                            <td className="muted">—</td>
                          </tr>
                        </tbody>
                      </table>
                    </div>
                  </section>
                </div>
              </section>
            </>
          ) : null}
          {' '}
          {v.isDr ? (
            <>
              <section className="widget span-8" aria-labelledby="dr-t">
                <div className="widget-head" style={{ minHeight: "52px", gap: "10px" }}>
                  <span className="badge">자료 요청</span>
                  <h2 className="t-md fw-b" id="dr-t">{v.drTitle}</h2>
                  <div className="actions"><span className={`badge ${v.drCls}`}>{v.drBadge}</span></div>
                </div>
                <div className="widget-body" style={{ gap: "16px", padding: "16px" }}>
                  {v.drExp ? (
                    <>
                      <div className="banner banner-warning" role="status">
                        <i className="ic ic-clock" aria-hidden="true" />
                        <div className="banner-body">승인 대기가 끝나 접수 상태로 돌아갔습니다. 범위를 확인하고 다시 요청해 주세요</div>
                      </div>
                    </>
                  ) : null}
                  <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)", gap: "16px", alignItems: "start" }}>
                    <section className="col" style={{ gap: "8px" }} aria-labelledby="drq-t">
                      <h3 className="t-sm fw-b" id="drq-t">④ 요청서 · 요건 확인</h3>
                      <div className="table-wrap">
                        <table className="table dense" aria-label="자료 요청 등록 정보">
                          <tbody>
                            <tr>
                              <th scope="row" style={{ width: "84px" }}>요청 기관</th>
                              <td>{v.drOrg}</td>
                            </tr>
                            <tr>
                              <th scope="row">종류</th>
                              <td>{v.drKind}</td>
                            </tr>
                            <tr>
                              <th scope="row">접수</th>
                              <td className="num">{v.drRecvAt}</td>
                            </tr>
                            <tr>
                              <th scope="row">제출 기한</th>
                              <td className="num">10/21(수)</td>
                            </tr>
                            <tr>
                              <th scope="row">대상</th>
                              <td>{v.drTarget}</td>
                            </tr>
                            <tr>
                              <th scope="row">요청서 원본</th>
                              <td>
                                <span className="col" style={{ gap: "6px", alignItems: "flex-start" }}>
                                  <span className="row wrap" style={{ gap: "6px" }}>
                                    <i className="ic ic-doc ic-16 muted" aria-hidden="true" />
                                    <span className="mono t-xs">{v.drFile}</span>
                                    <span className="badge badge-success">검사 위협 없음</span>
                                  </span>
                                  <span className="row wrap" style={{ gap: "6px" }}>
                                    <button className="btn btn-outline btn-sm" type="button">
                                      <i className="ic ic-download" aria-hidden="true" />
                                      내려받기
                                    </button>
                                    <button className="btn btn-ghost btn-sm" type="button">
                                      <i className="ic ic-upload" aria-hidden="true" />
                                      원본 올리기
                                    </button>
                                  </span>
                                </span>
                              </td>
                            </tr>
                          </tbody>
                        </table>
                      </div>
                      <ul className="col" style={{ gap: "6px" }} aria-label="요청서 법적 요건 확인 결과">
                        <li className="row t-sm" style={{ gap: "8px", alignItems: "flex-start" }}>
                          <i className="ic ic-check-circle ic-16 tx-success" aria-hidden="true" style={{ marginTop: "2px" }} />
                          <span>
                            <span className="sr-only">통과:</span>
                            법적 근거 · 요청 목적 · 대상 범위 · 제출 기한
                          </span>
                        </li>
                        <li className="row t-sm muted" style={{ gap: "8px", alignItems: "flex-start" }}>
                          <i className="ic ic-minus ic-16" aria-hidden="true" style={{ marginTop: "2px" }} />
                          <span>
                            <span className="sr-only">해당 없음:</span>
                            법원 허가서: 해당 없음(통신사실확인자료 요청이 아닙니다)
                          </span>
                        </li>
                      </ul>
                    </section>
                    <section className="col" style={{ gap: "8px" }} aria-labelledby="drs-t">
                      {v.drForm ? (
                        <>
                          <h3 className="t-sm fw-b" id="drs-t">⑤ 추출 범위 고르기</h3>
                          <fieldset className="col" style={{ gap: "6px" }}>
                            <legend className="sr-only">뽑을 자료 항목(최소 범위)</legend>
                            <label className="check-row" style={{ fontSize: "13px", lineHeight: "19px" }}>
                              <input className="cb" type="checkbox" defaultChecked />
                              <span className="grow">가입자 정보(통신이용자정보)</span>
                              <span className="t-xs muted num">1행</span>
                            </label>
                            {' '}
                            <label className="check-row" style={{ fontSize: "13px", lineHeight: "19px" }}>
                              <input className="cb" type="checkbox" disabled aria-describedby="drs-out" />
                              <span className="grow">접속기록(일시·IP·기기)</span>
                              <span className="t-xs muted">범위 밖</span>
                            </label>
                            {' '}
                            <label className="check-row" style={{ fontSize: "13px", lineHeight: "19px" }}>
                              <input className="cb" type="checkbox" disabled aria-describedby="drs-out" />
                              <span className="grow">예매 내역</span>
                              <span className="t-xs muted">범위 밖</span>
                            </label>
                          </fieldset>
                          <p className="t-xs muted" id="drs-out">요청서에 없는 항목과 대상자는 더할 수 없습니다. 행 수는 서버가 센 값입니다.</p>
                          <div className="field">
                            <label className="label" htmlFor="drs-per">대상 기간</label>
                            <input className="input input-sm" id="drs-per" type="text" defaultValue="2026-10-01 ~ 2026-10-12" />
                          </div>
                          <div className="field">
                            <label className="label" htmlFor="drs-why">
                              사유{' '}
                              <span className="opt">(필수)</span>
                            </label>
                            <textarea className="textarea" id="drs-why" style={{ minHeight: "64px", fontSize: "14px", lineHeight: "21px" }} defaultValue="요청서의 대상 회원 1명에 대해 요청서에 적힌 가입자 정보만 고릅니다." />
                          </div>
                          <button className="btn btn-primary btn-sm" type="button" style={{ alignSelf: "flex-start" }} aria-describedby="drs-h">
                            추출 요청하기
                          </button>
                          <p className="hint" id="drs-h">요청하기 전에 비밀번호와 인증 앱 코드로 다시 인증하고, 등록한 패스키로 한 번 더 확인합니다. 요청한 분이 아닌 commander가 승인한 뒤에만 자료를 뽑습니다.</p>
                        </>
                      ) : null}
                      {' '}
                      {v.drPend ? (
                        <>
                          <div className="row between wrap" style={{ gap: "6px 8px" }}>
                            <h3 className="t-sm fw-b" id="drs-t">⑤ 추출 요청 · commander 승인</h3>
                            <span className="badge badge-warning">
                              <i className="ic ic-clock" aria-hidden="true" />
                              승인 대기 23:58 남음
                            </span>
                          </div>
                          <p className="t-xs muted">요청 수진(commander, 본인) · 10/14(수) 20:02 KST</p>
                          <div className="table-wrap">
                            <table className="table dense" aria-label="고른 범위와 항목별 행 수">
                              <thead>
                                <tr>
                                  <th scope="col">항목</th>
                                  <th scope="col">기간</th>
                                  <th scope="col" className="r">행 수</th>
                                </tr>
                              </thead>
                              <tbody>
                                <tr>
                                  <td>가입자 정보(통신이용자정보)</td>
                                  <td className="num">10/1~10/12</td>
                                  <td className="r num">1</td>
                                </tr>
                              </tbody>
                            </table>
                          </div>
                          <div className="row wrap" style={{ gap: "8px" }}>
                            <button className="btn btn-primary btn-sm" type="button" aria-disabled="true" aria-describedby="drp-why">
                              <i className="ic ic-stamp" aria-hidden="true" />
                              승인하기
                            </button>
                            {' '}
                            <button className="btn btn-outline btn-sm" type="button">범위를 고쳐 다시 요청</button>
                            {' '}
                            <button className="btn btn-danger-outline btn-sm" type="button">제공하지 않음</button>
                          </div>
                          <p className="row t-sm" id="drp-why" style={{ gap: "6px", alignItems: "flex-start" }}>
                            <i className="ic ic-lock ic-16 muted" aria-hidden="true" style={{ marginTop: "2px" }} />
                            <span>요청한 분은 승인할 수 없습니다. 다른 commander가 승인합니다</span>
                          </p>
                          <p className="t-xs muted">승인 대기는 24시간이나 제출 기한 가운데 이른 때에 끝나 접수로 돌아갑니다.</p>
                        </>
                      ) : null}
                      {' '}
                      {v.drAppr ? (
                        <>
                          <div className="row between wrap" style={{ gap: "6px 8px" }}>
                            <h3 className="t-sm fw-b" id="drs-t">⑤ 추출 요청 · commander 승인</h3>
                            <span className="badge badge-warning">
                              <i className="ic ic-clock" aria-hidden="true" />
                              승인 대기 23:36 남음
                            </span>
                          </div>
                          <p className="t-xs muted">요청 민호(operator) · 10/14(수) 19:40 KST · 사유 "공문의 게시물 2건과 관련된 주문·접속기록만 고릅니다"</p>
                          <div className="table-wrap">
                            <table className="table dense" aria-label="고른 범위와 항목별 행 수">
                              <thead>
                                <tr>
                                  <th scope="col">항목</th>
                                  <th scope="col">기간</th>
                                  <th scope="col" className="r">행 수</th>
                                </tr>
                              </thead>
                              <tbody>
                                <tr>
                                  <td>예매 내역(게시물 2건 관련 주문)</td>
                                  <td className="num">10/1~10/14</td>
                                  <td className="r num">3</td>
                                </tr>
                                <tr>
                                  <td>접속기록(일시·IP·기기)</td>
                                  <td className="num">10/1~10/14</td>
                                  <td className="r num">41</td>
                                </tr>
                                <tr>
                                  <td>게시물 데이터</td>
                                  <td className="num">10/13~10/14</td>
                                  <td className="r num">2</td>
                                </tr>
                              </tbody>
                            </table>
                          </div>
                          <p className="t-xs muted">구매자 연락처는 요청 범위 밖이라 고르지 않았습니다. 대상자는 요청서의 대상자 그대로입니다.</p>
                          <div className="row wrap" style={{ gap: "8px" }}>
                            <button className="btn btn-primary btn-sm" type="button" aria-describedby="ap-h">
                              <i className="ic ic-stamp" aria-hidden="true" />
                              승인하기
                            </button>
                            {' '}
                            <button className="btn btn-outline btn-sm" type="button">범위를 고쳐 다시 요청</button>
                            {' '}
                            <button className="btn btn-danger-outline btn-sm" type="button">제공하지 않음</button>
                          </div>
                          <p className="hint" id="ap-h">
                            승인하기 전에 비밀번호와 인증 앱 코드로 다시 인증하고, 등록한 패스키로 한 번 더 확인합니다. 다시 요청과 제공하지 않음은 사유를 적습니다. 승인하면 시스템이 고른 범위의 행만 뽑아 제출 파일을 만듭니다.
                          </p>
                          <p className="t-xs muted">승인 대기는 24시간이나 제출 기한 가운데 이른 때에 끝나 접수로 돌아갑니다.</p>
                        </>
                      ) : null}
                      {' '}
                      {v.drSub ? (
                        <>
                          <div className="row between wrap" style={{ gap: "6px 8px" }}>
                            <h3 className="t-sm fw-b" id="drs-t">⑤ 제출 파일 · 제출 기록</h3>
                            <span className="badge badge-success">
                              <i className="ic ic-check" aria-hidden="true" />
                              승인됨
                            </span>
                          </div>
                          <p className="t-xs muted">요청 수진 · 10/14(수) 19:10 KST → 승인 [두 번째 commander] · 19:52 KST</p>
                          <div className="card-flat" style={{ display: "flex", flexDirection: "column", gap: "6px", padding: "12px 14px", borderRadius: "var(--r-lg)" }}>
                            <span className="row wrap" style={{ gap: "6px" }}>
                              <i className="ic ic-doc ic-16 muted" aria-hidden="true" />
                              <span className="mono t-xs">submission_D-2026-0022_20261014.csv</span>
                              <span className="t-xs muted">1행</span>
                            </span>
                            {' '}
                            <span className="t-xs">
                              SHA-256{' '}
                              <span className="mono">d2684315…55bf</span>
                            </span>
                            {' '}
                            <button className="btn btn-outline btn-sm" type="button" style={{ alignSelf: "flex-start" }}>
                              <i className="ic ic-download" aria-hidden="true" />
                              제출 파일 내려받기
                            </button>
                          </div>
                          <div className="field">
                            <label className="label" htmlFor="sb-at">제출 일시</label>
                            <input className="input input-sm" id="sb-at" type="text" defaultValue="2026-10-14 20:00 KST" />
                          </div>
                          <div className="field">
                            <label className="label" htmlFor="sb-to">받는 기관</label>
                            <input className="input input-sm" id="sb-to" type="text" defaultValue="경찰청([경찰서명])" />
                          </div>
                          <div className="field">
                            <label className="label" htmlFor="sb-how">방법</label>
                            <input className="input input-sm" id="sb-how" type="text" defaultValue="전자 제출" />
                          </div>
                          <div className="field">
                            <label className="label" htmlFor="sb-sha">낸 파일의 SHA-256</label>
                            {' '}
                            {v.drSubOk ? (
                              <>
                                <input className="input input-sm mono" id="sb-sha" type="text" spellCheck="false" autoComplete="off" defaultValue="d2684315a852e03f3e89f7a55d2baed775091101cf8e90392e2f98a378df55bf" />
                              </>
                            ) : null}
                            {' '}
                            {v.drHash ? (
                              <>
                                <input className="input input-sm mono is-error" id="sb-sha" type="text" spellCheck="false" autoComplete="off" aria-invalid="true" aria-describedby="sb-sha-e" defaultValue="4b98ec52213abd8f3189054ff683778405560d94a46ab16e6d321e769080e16f" />
                                <p className="error-msg" id="sb-sha-e" role="alert">
                                  <i className="ic ic-alert-circle" aria-hidden="true" />
                                  내려받은 제출 파일과 해시가 다릅니다. 승인된 파일을 다시 내려받아 주세요
                                </p>
                              </>
                            ) : null}
                          </div>
                          <button className="btn btn-primary btn-sm" type="button" style={{ alignSelf: "flex-start" }}>제출 기록하기</button>
                        </>
                      ) : null}
                    </section>
                  </div>
                  <section className="col" style={{ gap: "8px" }} aria-labelledby="drl-t">
                    <h3 className="t-sm fw-b" id="drl-t">⑥ 처리 기록 · 제공 대장</h3>
                    <div className="table-wrap">
                      <table className="table dense" aria-label="자료 요청 처리 기록">
                        <thead>
                          <tr>
                            <th scope="col">일시(KST)</th>
                            <th scope="col">구분</th>
                            <th scope="col">내용</th>
                            <th scope="col">담당</th>
                          </tr>
                        </thead>
                        <tbody>
                          {v.drSub ? (
                            <>
                              <tr>
                                <td className="num">10/14 19:52</td>
                                <td><span className="badge">제출 파일</span></td>
                                <td>CSV 1행 · SHA-256 d2684315…55bf</td>
                                <td>시스템</td>
                              </tr>
                              <tr>
                                <td className="num">10/14 19:52</td>
                                <td><span className="badge badge-success">승인</span></td>
                                <td>추출 승인 · 패스키 확인</td>
                                <td>[두 번째 commander]</td>
                              </tr>
                              <tr>
                                <td className="num">10/14 19:10</td>
                                <td><span className="badge">추출 요청</span></td>
                                <td>가입자 정보 1행 · 다시 인증함</td>
                                <td>수진</td>
                              </tr>
                            </>
                          ) : null}
                          {' '}
                          {v.drPend ? (
                            <>
                              <tr>
                                <td className="num">10/14 20:02</td>
                                <td><span className="badge badge-warning">추출 요청</span></td>
                                <td>가입자 정보 1행 · 다시 인증함</td>
                                <td>수진</td>
                              </tr>
                            </>
                          ) : null}
                          {' '}
                          {v.drAppr ? (
                            <>
                              <tr>
                                <td className="num">10/14 19:40</td>
                                <td><span className="badge badge-warning">추출 요청</span></td>
                                <td>예매 내역 3행 · 접속기록 41행 · 게시물 데이터 2행 · 다시 인증함</td>
                                <td>민호</td>
                              </tr>
                            </>
                          ) : null}
                          {' '}
                          {v.drExp ? (
                            <>
                              <tr>
                                <td className="num">10/14 19:40</td>
                                <td><span className="badge badge-warning">만료</span></td>
                                <td>승인 대기 끝남 · 접수로 돌아감</td>
                                <td>시스템</td>
                              </tr>
                              <tr>
                                <td className="num">10/13 19:40</td>
                                <td><span className="badge">추출 요청</span></td>
                                <td>가입자 정보 1행 · 다시 인증함</td>
                                <td>수진</td>
                              </tr>
                            </>
                          ) : null}
                          <tr>
                            <td className="num">{v.drRecvLog}</td>
                            <td><span className="badge">접수</span></td>
                            <td>등록 · 요건 확인 통과</td>
                            <td>민호</td>
                          </tr>
                        </tbody>
                      </table>
                    </div>
                    <p className="t-xs muted">제출을 기록하면 제공 대장에 한 줄이 생기고, 보존 기간을 제공한 날부터 다시 셉니다(통신사실확인자료 7년, 통신이용자정보 1년).</p>
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
        <div className="grid-12" role="tabpanel" aria-labelledby="tb-i" style={{ alignItems: "start" }}>
          <section className="widget span-4" aria-labelledby="il-t">
            <div className="widget-head">
              <h2 id="il-t" style={{ fontSize: "13px", lineHeight: "18px" }}>보안 사고</h2>
              <div className="actions"><span className="t-xs muted">진행 중 1</span></div>
            </div>
            <div className="widget-body" style={{ gap: "10px" }}>
              <ul className="col" style={{ gap: "6px" }}>
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
                    <span className="badge">
                      <i className="ic ic-clock" aria-hidden="true" />
                      가장 가까운 기한: 침해사고 신고 23시간 43분
                    </span>
                  </button>
                </li>
              </ul>
              <Link to="/compliance" className="link-more" style={{ fontSize: "13px" }}>
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
          <section className="widget span-8" aria-labelledby="idt-t">
            <div className="widget-head" style={{ minHeight: "52px", gap: "10px" }}>
              <span className="badge badge-danger">SEV1</span>
              <h2 className="t-md fw-b" id="idt-t">INC-2026-007 · 관리 계정 탈취·개인정보 유출 의심</h2>
              <div className="actions"><span className="t-xs muted">등록 수진 · 20:01:40 KST</span></div>
            </div>
            <div className="widget-body" style={{ gap: "16px", padding: "16px" }}>
              <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1.1fr) minmax(0,1fr)", gap: "16px", alignItems: "start" }}>
                <section className="col" style={{ gap: "8px" }} aria-labelledby="ir-t">
                  <h3 className="t-sm fw-b" id="ir-t">⑦ 등록 정보</h3>
                  <div className="table-wrap">
                    <table className="table dense" aria-label="보안 사고 등록 정보">
                      <tbody>
                        <tr>
                          <th scope="row" style={{ width: "132px", whiteSpace: "normal" }}>종류</th>
                          <td>
                            <span className="row wrap" style={{ gap: "4px 12px" }}>
                              <label className="check-row" style={{ fontSize: "13px", lineHeight: "18px" }}>
                                <input className="cb" type="checkbox" defaultChecked />
                                침해사고
                              </label>
                              <label className="check-row" style={{ fontSize: "13px", lineHeight: "18px" }}>
                                <input className="cb" type="checkbox" defaultChecked />
                                개인정보 유출
                              </label>
                              <label className="check-row" style={{ fontSize: "13px", lineHeight: "18px" }}>
                                <input className="cb" type="checkbox" />
                                유출 가능성
                              </label>
                            </span>
                          </td>
                        </tr>
                        <tr>
                          <th scope="row" style={{ whiteSpace: "normal" }}>인지 시각</th>
                          <td className="num">10/14(수) 19:48:00 KST · 기한은 이 시각부터 셉니다</td>
                        </tr>
                        <tr>
                          <th scope="row" style={{ whiteSpace: "normal" }}>대상 수</th>
                          <td className="num">1,180명</td>
                        </tr>
                        <tr>
                          <th scope="row" style={{ whiteSpace: "normal" }}>민감정보·고유식별정보</th>
                          <td>없음</td>
                        </tr>
                        <tr>
                          <th scope="row" style={{ whiteSpace: "normal" }}>외부 불법 접근</th>
                          <td>있음(의심) · 처음 보는 해외 IP에서 파트너 관리 계정 로그인</td>
                        </tr>
                        <tr>
                          <th scope="row" style={{ whiteSpace: "normal" }}>공격으로 생긴 장애</th>
                          <td>없음 · 관제 지표에서 자동으로 채움(20:04 KST 기준)</td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                </section>
                <section className="col" style={{ gap: "10px" }} aria-labelledby="ij-t">
                  <h3 className="t-sm fw-b" id="ij-t">commander 해당 판단</h3>
                  {v.ijOpen ? (
                    <>
                      <fieldset className="col" style={{ gap: "8px" }}>
                        <legend className="sr-only">신고·통지 대상인지 판단</legend>
                        <label className="check-row" style={{ fontSize: "14px" }}>
                          <input className="rd" type="radio" name="ij" />
                          해당합니다
                        </label>
                        {' '}
                        <label className="check-row" style={{ fontSize: "14px" }}>
                          <input className="rd" type="radio" name="ij" />
                          해당하지 않습니다
                        </label>
                        {' '}
                        <label className="check-row" style={{ fontSize: "14px" }}>
                          <input className="rd" type="radio" name="ij" defaultChecked />
                          판단이 서지 않습니다(신고·통지하는 쪽으로)
                        </label>
                      </fieldset>
                      <div className="field">
                        <label className="label" htmlFor="ij-why">
                          판단 근거{' '}
                          <span className="opt">(필수)</span>
                        </label>
                        {' '}
                        <textarea className="textarea" id="ij-why" aria-describedby="ij-h ij-c" style={{ minHeight: "84px", fontSize: "14px", lineHeight: "21px" }} defaultValue="계정 탈취 경로를 확인하는 중입니다. 외부 접근과 1천 명 이상이 겹쳐 신고·통지를 준비합니다." />
                        <div className="row between" style={{ gap: "8px", alignItems: "flex-start" }}>
                          <span className="hint" id="ij-h">해당 여부는 commander가 판단합니다. 판단이 서지 않으면 신고·통지하는 쪽으로 합니다.</span>
                          <span className="counter" id="ij-c" aria-live="polite">53자</span>
                        </div>
                      </div>
                      <button className="btn btn-primary btn-sm" type="button" style={{ alignSelf: "flex-start" }}>
                        <i className="ic ic-check" aria-hidden="true" />
                        판단을 기록합니다
                      </button>
                      <p className="t-xs muted">판단은 한 번만 기록합니다. 기록한 뒤에 신고·통지를 기록할 수 있습니다.</p>
                    </>
                  ) : null}
                  {' '}
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
                </section>
              </div>
              <section className="col" style={{ gap: "8px" }} aria-labelledby="io-t">
                <div className="row between wrap" style={{ gap: "8px" }}>
                  <h3 className="t-sm fw-b" id="io-t">의무별 기한</h3>
                  <span className="t-xs muted">시간 기한은 2시간 전, 72시간 기한은 12시간 전부터 경고로 바뀝니다</span>
                </div>
                <div className="table-wrap">
                  <table className="table dense" aria-label="의무별 신고·통지 기한 7개">
                    <thead>
                      <tr>
                        <th scope="col">의무</th>
                        <th scope="col">근거</th>
                        <th scope="col">받는 곳</th>
                        <th scope="col">기한</th>
                        <th scope="col">남은 시간</th>
                        <th scope="col">상태</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr>
                        <td className="fw-b">침해사고 신고</td>
                        <td className="t-xs muted">정보통신망법 §48의3①</td>
                        <td>과학기술정보통신부·한국인터넷진흥원</td>
                        <td className="num">24시간 · 10/15(목) 19:48</td>
                        <td>
                          <span className="badge">
                            <i className="ic ic-clock" aria-hidden="true" />
                            23시간 43분
                          </span>
                        </td>
                        <td>준비 중</td>
                      </tr>
                      <tr>
                        <td className="fw-b">추가 사실 신고</td>
                        <td className="t-xs muted">시행령 §58의8②</td>
                        <td>같은 기관</td>
                        <td>추가 사실 확인 뒤 24시간</td>
                        <td className="muted">—</td>
                        <td className="muted">확인 때 시작</td>
                      </tr>
                      <tr>
                        <td className="fw-b">이용자 통지</td>
                        <td className="t-xs muted">정보통신망법 §48의3④</td>
                        <td>이용자</td>
                        <td>지체 없이(유출 가능성·장애 2시간 이상)</td>
                        <td>
                          <span className="badge badge-warning">
                            <i className="ic ic-alert" aria-hidden="true" />
                            지체 없이
                          </span>
                        </td>
                        <td>준비 중</td>
                      </tr>
                      <tr>
                        <td className="fw-b">피해구제 조치 제출</td>
                        <td className="t-xs muted">시행령 §60의16</td>
                        <td>과학기술정보통신부</td>
                        <td>신고일부터 14일</td>
                        <td className="muted">—</td>
                        <td className="muted">신고 뒤 시작</td>
                      </tr>
                      <tr>
                        <td className="fw-b">정보주체 통지</td>
                        <td className="t-xs muted">개인정보 보호법 §34</td>
                        <td>정보주체 1,180명</td>
                        <td className="num">72시간 · 10/17(토) 19:48</td>
                        <td>
                          <span className="badge">
                            <i className="ic ic-clock" aria-hidden="true" />
                            71시간 43분
                          </span>
                        </td>
                        <td>준비 중</td>
                      </tr>
                      <tr>
                        <td className="fw-b">유출 신고</td>
                        <td className="t-xs muted">개인정보 보호법 §34, 시행령 §40</td>
                        <td>개인정보보호위원회·한국인터넷진흥원</td>
                        <td className="num">72시간 · 10/17(토) 19:48</td>
                        <td>
                          <span className="badge">
                            <i className="ic ic-clock" aria-hidden="true" />
                            71시간 43분
                          </span>
                        </td>
                        <td>준비 중</td>
                      </tr>
                      <tr>
                        <td className="fw-b">유출 가능성 통지</td>
                        <td className="t-xs muted">시행령 §39의2·§39의3</td>
                        <td>정보주체</td>
                        <td>72시간</td>
                        <td className="muted">—</td>
                        <td className="muted">해당 없음(유출로 등록)</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </section>
              <section className="col" style={{ gap: "8px" }} aria-labelledby="if-t">
                <div className="row between wrap" style={{ gap: "8px" }}>
                  <h3 className="t-sm fw-b" id="if-t">신고·통지 기록</h3>
                  {v.ijDone ? (
                    <>
                      <button className="btn btn-outline btn-sm" type="button">
                        <i className="ic ic-plus" aria-hidden="true" />
                        신고·통지 기록 추가하기
                      </button>
                    </>
                  ) : null}
                  {v.ijOpen ? (
                    <>
                      <button className="btn btn-outline btn-sm" type="button" aria-disabled="true" aria-describedby="if-why">
                        <i className="ic ic-plus" aria-hidden="true" />
                        신고·통지 기록 추가하기
                      </button>
                    </>
                  ) : null}
                </div>
                {v.ijOpen ? (
                  <>
                    <p className="t-xs muted" id="if-why">commander가 해당 판단을 기록한 뒤에 신고·통지를 기록할 수 있습니다.</p>
                  </>
                ) : null}
                <div className="table-wrap">
                  <table className="table dense" aria-label="신고·통지 기록">
                    <thead>
                      <tr>
                        <th scope="col">의무</th>
                        <th scope="col">기관</th>
                        <th scope="col">방법</th>
                        <th scope="col">시각</th>
                        <th scope="col">내용 요약</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr><td colSpan={5} className="muted" style={{ textAlign: "center" }}>아직 기록이 없습니다. 신고·통지할 때마다 기관, 방법, 시각, 내용 요약을 남깁니다.</td></tr>
                    </tbody>
                  </table>
                </div>
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
              <div className="row between wrap" style={{ gap: "8px", paddingTop: "12px", borderTop: "1px solid var(--border)" }}>
                <p className="t-xs muted" id="ic-why" style={{ flex: "1", minWidth: "240px" }}>{v.closeWhy}</p>
                <button className="btn btn-outline btn-sm" type="button" aria-disabled="true" aria-describedby="ic-why">
                  <i className="ic ic-check-circle" aria-hidden="true" />
                  보안 사고 종결하기
                </button>
              </div>
            </div>
          </section>
        </div>
      </>
    ) : null}
    {' '}
    {v.isReview ? (
      <>
        <div className="grid-12" role="tabpanel" aria-labelledby="tb-r" style={{ alignItems: "start" }}>
          <section className="widget span-4" aria-labelledby="rl-t">
            <div className="widget-head">
              <h2 id="rl-t" style={{ fontSize: "13px", lineHeight: "18px" }}>10월 정기 점검</h2>
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
              <ul className="col" style={{ gap: "6px" }}>
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
          <section className="widget span-8" aria-labelledby="rd-t">
            <div className="widget-head" style={{ minHeight: "52px", gap: "10px" }}>
              <span className="mono t-xs">A-1032</span>
              <h2 className="t-md fw-b" id="rd-t">근무 일정 밖 조회 · 다은(cs_agent)</h2>
              <div className="actions"><span className="badge badge-warning">확인 중</span></div>
            </div>
            <div className="widget-body" style={{ gap: "16px", padding: "16px" }}>
              <div className="table-wrap">
                <table className="table dense" aria-label="이상 건 기록">
                  <tbody>
                    <tr>
                      <th scope="row" style={{ width: "120px" }}>계정</th>
                      <td>다은 · cs_agent</td>
                    </tr>
                    <tr>
                      <th scope="row">시각</th>
                      <td className="num">2026-10-11 17:14:51 UTC (10/12(월) 02:14 KST)</td>
                    </tr>
                    <tr>
                      <th scope="row">행위</th>
                      <td>CS 처리함 건 3건 열람 · 결제자 연락처 가림 해제 2건</td>
                    </tr>
                    <tr>
                      <th scope="row">당시 열람 사유</th>
                      <td>결제 상태 불명 문의 회신</td>
                    </tr>
                    <tr>
                      <th scope="row">탐지 규칙</th>
                      <td>근무 일정 밖 조회·다운로드</td>
                    </tr>
                    <tr>
                      <th scope="row">접속</th>
                      <td>허용 IP 안 · 등록된 관리 기기</td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)", gap: "16px", alignItems: "start" }}>
                <div className="field">
                  <label className="label" htmlFor="rv-why">
                    ① 사유 확인(소명){' '}
                    <span className="opt">(필수)</span>
                  </label>
                  {' '}
                  <textarea className="textarea" id="rv-why" aria-describedby="rv-why-c" style={{ minHeight: "132px", fontSize: "14px", lineHeight: "21px" }} defaultValue="10/11 야간 당직표에 다은 님이 있었고, 결제 상태 불명 문의 2건에 답하려고 열람했다는 소명을 받았습니다. 문의 기록과 열람 시각이 맞습니다." />
                  {' '}
                  <span className="counter" id="rv-why-c" aria-live="polite">82자</span>
                </div>
                <fieldset className="col" style={{ gap: "8px" }}>
                  <legend className="label" style={{ marginBottom: "8px" }}>② 사후조치</legend>
                  <label className="check-row" style={{ fontSize: "14px" }}>
                    <input className="cb" type="checkbox" />
                    보고
                  </label>
                  {' '}
                  <label className="check-row" style={{ fontSize: "14px" }}>
                    <input className="cb" type="checkbox" />
                    회수·파기 요청
                  </label>
                  {' '}
                  <label className="check-row" style={{ fontSize: "14px" }}>
                    <input className="cb" type="checkbox" />
                    권한 회수
                  </label>
                  <div className="field">
                    <label className="label" htmlFor="rv-act">
                      조치 내용{' '}
                      <span className="opt">(선택)</span>
                    </label>
                    {' '}
                    <textarea className="textarea" id="rv-act" aria-describedby="rv-act-c" style={{ minHeight: "64px", fontSize: "14px", lineHeight: "21px" }} defaultValue="근무 일정 데이터에 야간 당직을 반영해 달라고 요청했습니다." />
                    {' '}
                    <span className="counter" id="rv-act-c" aria-live="polite">33자</span>
                  </div>
                </fieldset>
              </div>
              <div className="row wrap" style={{ gap: "8px", justifyContent: "flex-end" }}>
                <button className="btn btn-danger-outline" type="button">
                  <i className="ic ic-shield" aria-hidden="true" />
                  보안 사고로 등록하기
                </button>
                {' '}
                <button className="btn btn-primary" type="button">
                  <i className="ic ic-check" aria-hidden="true" />
                  점검 완료로 기록합니다
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
                    <div className="row wrap" style={{ gap: "10px" }}>
                      <button className="btn btn-outline btn-sm" type="button" aria-disabled="true" aria-describedby="self-why">점검 완료로 기록합니다</button>
                      <span className="t-xs" id="self-why">본인 접속기록은 다른 commander가 점검하고 종결합니다.</span>
                    </div>
                  </>
                ) : null}
                {v.selfDemo ? (
                  <>
                    <div className="col" style={{ gap: "8px" }}>
                      <span className="t-xs" id="self-demo-h">
                        데모 환경에서만 본인 기록을 종결할 수 있습니다. 종결 기록과 점검 보고 요약에 '자기 점검(시연)'이 남습니다. 운영 환경에서는 다른 commander가 점검하고 종결합니다.
                      </span>
                      <button className="btn btn-outline btn-sm" type="button" style={{ alignSelf: "flex-start" }} aria-describedby="self-demo-h">
                        자기 점검(시연)으로 종결
                      </button>
                    </div>
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
    {' '}
    {v.isWithdraw ? (
      <>
        <Overlay placement="center" onClose={close}>
          <div className="dialog" role="alertdialog" aria-modal="true" aria-labelledby="wd-t" aria-describedby="wd-d" style={{ maxWidth: "540px" }}>
            <div className="row" style={{ gap: "12px" }}>
              <span className="state-icon is-primary" style={{ width: "44px", height: "44px" }}><i className="ic ic-undo" aria-hidden="true" /></span>
              <h2 className="dialog-title" id="wd-t">통보 N-2026-0141의 철회로 노출을 되살립니다</h2>
            </div>
            <p className="t-sm" id="wd-d">통보가 정식으로 철회되었을 때만 씁니다. 이 통보로 가린 게시물과 같은 내용으로 자동 숨긴 글을 모두 다시 보이게 하고, 통보를 '철회'로 닫습니다.</p>
            <dl className="kv" style={{ fontSize: "13px", lineHeight: "18px", padding: "12px 14px", borderRadius: "var(--r-md)", background: "var(--surface-muted)" }}>
              <dt>되살릴 게시물</dt>
              <dd>rv_7Q2M1(15:31 차단)</dd>
              <dt>같은 내용 자동 숨김</dt>
              <dd>1건(지문 2b7a…c419)</dd>
              <dt>기록</dt>
              <dd>조치·회신·제출 기록과 감사 로그에 남깁니다</dd>
            </dl>
            <div className="field">
              <label className="label" htmlFor="wd-reason">
                사유{' '}
                <span className="opt">(필수)</span>
              </label>
              {' '}
              <textarea className="textarea is-focus" id="wd-reason" aria-describedby="wd-reason-c" style={{ minHeight: "76px", fontSize: "14px", lineHeight: "21px" }} defaultValue="한국콘텐츠진흥원이 10/14(수) 19:50 공문으로 통보를 철회했습니다. 철회 공문을 원본으로 올렸습니다." />
              {' '}
              <span className="counter" id="wd-reason-c" aria-live="polite">60자</span>
            </div>
            <div className="dialog-actions">
              <button className="btn btn-outline" type="button">닫고 통보 상세로 돌아가기</button>
              <button className="btn btn-primary" type="button">
                <i className="ic ic-undo" aria-hidden="true" />
                노출을 되살립니다
              </button>
            </div>
          </div>
        </Overlay>
      </>
    ) : null}
    {' '}
    {v.isTakedown ? (
      <>
        <Overlay placement="center" onClose={close}>
          <div className="dialog" role="alertdialog" aria-modal="true" aria-labelledby="tk-t" aria-describedby="tk-d" style={{ maxWidth: "540px" }}>
            <div className="row" style={{ gap: "12px" }}>
              <span className="state-icon is-danger" style={{ width: "44px", height: "44px" }}><i className="ic ic-ban" aria-hidden="true" /></span>
              <h2 className="dialog-title" id="tk-t">게시물 rv_7Q2K9의 노출을 차단합니다</h2>
            </div>
            <p className="t-sm" id="tk-d">서비스의 모든 화면에서 이 게시물을 숨기고, 본문 지문을 같은 내용 차단 목록에 올리고, 결과 회신에 쓸 증적 리포트를 만듭니다. 통보가 철회되면 같은 내용으로 숨긴 글까지 함께 복원합니다.</p>
            <dl className="kv" style={{ fontSize: "13px", lineHeight: "18px", padding: "12px 14px", borderRadius: "var(--r-md)", background: "var(--surface-muted)" }}>
              <dt>통보</dt>
              <dd>N-2026-0141 · 한국콘텐츠진흥원</dd>
              <dt>법정 기한</dt>
              <dd>남은 시간 5시간 12분</dd>
              <dt>실행</dt>
              <dd>명령 10 게시물 노출 차단 · operator 1인</dd>
            </dl>
            <div className="field">
              <label className="label" htmlFor="tk-reason">
                사유{' '}
                <span className="opt">(필수)</span>
              </label>
              {' '}
              <textarea className="textarea" id="tk-reason" aria-describedby="tk-reason-c" style={{ minHeight: "76px", fontSize: "14px", lineHeight: "21px" }} defaultValue="통보 N-2026-0141에 적힌 게시물입니다. 공문의 게시물 ID와 일치하는 것을 확인했습니다." />
              {' '}
              <span className="counter" id="tk-reason-c" aria-live="polite">54자</span>
            </div>
            <div className="field">
              <label className="label" htmlFor="tk-phrase">
                확인 문구{' '}
                <span className="opt">(필수)</span>
              </label>
              {' '}
              <input className="input input-sm is-focus" id="tk-phrase" type="text" autoComplete="off" defaultValue="rv_7Q2K9" aria-describedby="tk-phrase-h" />
              {' '}
              <span className="hint" id="tk-phrase-h">확인하려면 게시물 ID rv_7Q2K9를 그대로 입력하세요</span>
            </div>
            <div className="dialog-actions">
              <button className="btn btn-outline" type="button">닫고 통보 상세로 돌아가기</button>
              <button className="btn btn-danger" type="button">
                <i className="ic ic-ban" aria-hidden="true" />
                게시물 노출을 차단합니다
              </button>
            </div>
          </div>
        </Overlay>
      </>
    ) : null}
    </>
  );
}
