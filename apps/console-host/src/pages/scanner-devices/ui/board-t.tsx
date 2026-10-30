// 디자인 캔버스 보드 SCR-053-t.dc.html를 옮긴 것(dc2tsx 생성 뒤 손질)
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

function qrCells(seed: any): any {
    let n = 29, s = seed, out: any[] = [];
    let rnd = function () { s = (s * 9301 + 49297) % 233280; return s / 233280; };
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        let on: any;
        let fr = r < 7 ? r : (r >= n - 7 ? r - (n - 7) : -1);
        let fc = c < 7 ? c : (c >= n - 7 ? c - (n - 7) : -1);
        let finder = fr >= 0 && fc >= 0 && !(r >= n - 7 && c >= n - 7);
        let sep = !finder && ((r <= 7 && c <= 7) || (r <= 7 && c >= n - 8) || (r >= n - 8 && c <= 7));
        if (finder) on = fr === 0 || fr === 6 || fc === 0 || fc === 6 || (fr >= 2 && fr <= 4 && fc >= 2 && fc <= 4);
        else if (sep) on = false;
        else if (r === 6) on = c % 2 === 0;
        else if (c === 6) on = r % 2 === 0;
        else if (r >= 20 && r <= 24 && c >= 20 && c <= 24) { let ar = r - 20, ac = c - 20; on = ar === 0 || ar === 4 || ac === 0 || ac === 4 || (ar === 2 && ac === 2); }
        else on = rnd() > 0.52;
        out.push({ on: on ? 'on' : '' });
      }
    }
    return out;
  }

export const STATES_T = ["기본", "폐기 확인 대화상자", "등록 코드", "코드 만료", "폐기됨", "빈 화면"] as const;
export const DEFAULT_T = "기본";

export function valsT(state: string) {
    let st = state || '기본';
    let code = st === '등록 코드' || st === '코드 만료';
    let gone = st === '폐기됨' || code;
    let empty = st === '빈 화면';
    return {
      qr: qrCells(37),
      isActive: !gone && !empty,
      isGone: gone,
      isEmpty: empty,
      hasDev: !empty,
      devCount: empty ? '0' : '9',
      isDialog: st === '폐기 확인 대화상자',
      isRevoked: st === '폐기됨',
      isCode: code,
      codeLive: st === '등록 코드',
      codeExp: st === '코드 만료',
      clockA: !gone,
      clockR: st === '폐기됨',
      clockC: st === '등록 코드',
      clockE: st === '코드 만료'
    };
  }

type V = ReturnType<typeof valsT>;

// 보드 루트: {"class": "pk dark cs cs-compact is-tab", "style": "width:768px;min-height:1860px"}

// <main class="cs-main" id="main">
export function MainT({ v, close, go }: { v: V; close?: () => void; go?: (state: string) => void }) {
  void v; void close; void go;
  const ro = useRo();
  return (
    <>
    <div className="row between" style={{ alignItems: "flex-end", gap: "16px" }}>
      <div className="col" style={{ gap: "4px" }}>
        <h1 className="t-xl">스캐너 기기 관리</h1>
        <p className="t-sm muted">현장 스캐너 기기를 등록해 한 파트너에 배정하고, 분실·도난이면 즉시 폐기합니다.</p>
      </div>
      <button onClick={() => go?.('등록 코드')} className="btn btn-primary" type="button" {...ro()}>
        <i className="ic ic-plus" aria-hidden="true" />
        기기 등록하기
      </button>
    </div>
    <section className="col" style={{ gap: "8px" }} aria-labelledby="h-dev">
      <div className="row between wrap" style={{ gap: "8px" }}>
        <h2 className="t-md fw-b" id="h-dev">기기 {v.devCount}대</h2>
        <div className="row" style={{ gap: "8px" }}>
          <label className="t-xs muted" htmlFor="f-pt">파트너</label>
          <div className="input-group input-group-sm" style={{ width: "200px" }}>
            <select id="f-pt" defaultValue="전체 파트너">
              <option>전체 파트너</option>
              <option>(주)스텔라엔터테인먼트</option>
              <option>[예시 파트너 A]</option>
            </select>
            <i className="ic ic-chevron-down ic-16" aria-hidden="true" />
          </div>
          <label className="t-xs muted" htmlFor="f-st">상태</label>
          <div className="input-group input-group-sm" style={{ width: "132px" }}>
            <select id="f-st" defaultValue="전체 상태">
              <option>전체 상태</option>
              <option>사용 중</option>
              <option>폐기됨</option>
              <option>퇴역</option>
            </select>
            <i className="ic ic-chevron-down ic-16" aria-hidden="true" />
          </div>
        </div>
      </div>
      {v.isActive ? (
        <>
          <div className="table-wrap table-scroll">
            <table className="table dense" style={{ minWidth: "860px" }}>
              <caption className="sr-only">스캐너 기기 목록. 이름을 누르면 아래에 상세가 열립니다</caption>
              <thead>
                <tr>
                  <th scope="col">이름</th>
                  <th scope="col">배정 파트너</th>
                  <th scope="col">상태</th>
                  <th scope="col">기기 키 등록일</th>
                  <th scope="col">마지막 연락</th>
                  <th scope="col">로그인 세션</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td><Link to="/scanner-devices" className="fw-b" style={{ color: "inherit" }}>동문-01</Link></td>
                  <td>(주)스텔라엔터테인먼트</td>
                  <td><span className="badge badge-success">사용 중</span></td>
                  <td>10/15(목)</td>
                  <td>9초 전</td>
                  <td>현장 책임자</td>
                </tr>
                <tr>
                  <td><Link to="/scanner-devices" className="fw-b" style={{ color: "inherit" }}>동문-02</Link></td>
                  <td>(주)스텔라엔터테인먼트</td>
                  <td><span className="badge badge-success">사용 중</span></td>
                  <td>10/15(목)</td>
                  <td>14초 전</td>
                  <td>현장 스태프</td>
                </tr>
                <tr>
                  <td><Link to="/scanner-devices" className="fw-b" style={{ color: "inherit" }}>동문-03</Link></td>
                  <td>(주)스텔라엔터테인먼트</td>
                  <td><span className="badge badge-success">사용 중</span></td>
                  <td>10/15(목)</td>
                  <td>21초 전</td>
                  <td>현장 스태프</td>
                </tr>
                <tr>
                  <td><Link to="/scanner-devices" className="fw-b" style={{ color: "inherit" }}>동문-04</Link></td>
                  <td>(주)스텔라엔터테인먼트</td>
                  <td><span className="badge badge-success">사용 중</span></td>
                  <td>10/15(목)</td>
                  <td>38초 전</td>
                  <td>현장 스태프</td>
                </tr>
                <tr>
                  <td><Link to="/scanner-devices" className="fw-b" style={{ color: "inherit" }}>서문-01</Link></td>
                  <td>(주)스텔라엔터테인먼트</td>
                  <td><span className="badge badge-success">사용 중</span></td>
                  <td>10/15(목)</td>
                  <td>11초 전</td>
                  <td>현장 스태프</td>
                </tr>
                <tr className="is-selected">
                  <td><Link to="/scanner-devices" className="fw-b" style={{ color: "inherit" }} aria-current="true">서문-02</Link></td>
                  <td>(주)스텔라엔터테인먼트</td>
                  <td><span className="badge badge-success">사용 중</span></td>
                  <td>10/15(목)</td>
                  <td>6분 전</td>
                  <td>현장 스태프</td>
                </tr>
                <tr>
                  <td><Link to="/scanner-devices" className="fw-b" style={{ color: "inherit" }}>서문-03</Link></td>
                  <td>(주)스텔라엔터테인먼트</td>
                  <td><span className="badge badge-success">사용 중</span></td>
                  <td>10/21(수)</td>
                  <td>15:02 KST</td>
                  <td>없음</td>
                </tr>
                <tr>
                  <td><Link to="/scanner-devices" className="fw-b" style={{ color: "inherit" }}>[예시 기기 1]</Link></td>
                  <td>[예시 파트너 A]</td>
                  <td><span className="badge badge-success">사용 중</span></td>
                  <td>10/10(토)</td>
                  <td>10/23(금) 21:40 KST</td>
                  <td>없음</td>
                </tr>
                <tr>
                  <td><Link to="/scanner-devices" className="fw-b" style={{ color: "inherit" }}>[예시 기기 2]</Link></td>
                  <td>[예시 파트너 A]</td>
                  <td><span className="badge">퇴역</span></td>
                  <td>—</td>
                  <td>9/30(수) 18:10 KST</td>
                  <td>없음</td>
                </tr>
              </tbody>
            </table>
          </div>
        </>
      ) : null}
      {' '}
      {v.isGone ? (
        <>
          <div className="table-wrap table-scroll">
            <table className="table dense" style={{ minWidth: "860px" }}>
              <caption className="sr-only">스캐너 기기 목록. 이름을 누르면 아래에 상세가 열립니다</caption>
              <thead>
                <tr>
                  <th scope="col">이름</th>
                  <th scope="col">배정 파트너</th>
                  <th scope="col">상태</th>
                  <th scope="col">기기 키 등록일</th>
                  <th scope="col">마지막 연락</th>
                  <th scope="col">로그인 세션</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td><Link to="/scanner-devices" className="fw-b" style={{ color: "inherit" }}>동문-01</Link></td>
                  <td>(주)스텔라엔터테인먼트</td>
                  <td><span className="badge badge-success">사용 중</span></td>
                  <td>10/15(목)</td>
                  <td>9초 전</td>
                  <td>현장 책임자</td>
                </tr>
                <tr>
                  <td><Link to="/scanner-devices" className="fw-b" style={{ color: "inherit" }}>동문-02</Link></td>
                  <td>(주)스텔라엔터테인먼트</td>
                  <td><span className="badge badge-success">사용 중</span></td>
                  <td>10/15(목)</td>
                  <td>14초 전</td>
                  <td>현장 스태프</td>
                </tr>
                <tr>
                  <td><Link to="/scanner-devices" className="fw-b" style={{ color: "inherit" }}>동문-03</Link></td>
                  <td>(주)스텔라엔터테인먼트</td>
                  <td><span className="badge badge-success">사용 중</span></td>
                  <td>10/15(목)</td>
                  <td>21초 전</td>
                  <td>현장 스태프</td>
                </tr>
                <tr>
                  <td><Link to="/scanner-devices" className="fw-b" style={{ color: "inherit" }}>동문-04</Link></td>
                  <td>(주)스텔라엔터테인먼트</td>
                  <td><span className="badge badge-success">사용 중</span></td>
                  <td>10/15(목)</td>
                  <td>38초 전</td>
                  <td>현장 스태프</td>
                </tr>
                <tr>
                  <td><Link to="/scanner-devices" className="fw-b" style={{ color: "inherit" }}>서문-01</Link></td>
                  <td>(주)스텔라엔터테인먼트</td>
                  <td><span className="badge badge-success">사용 중</span></td>
                  <td>10/15(목)</td>
                  <td>11초 전</td>
                  <td>현장 스태프</td>
                </tr>
                <tr className="is-selected">
                  <td><Link to="/scanner-devices" className="fw-b" style={{ color: "inherit" }} aria-current="true">서문-02</Link></td>
                  <td>(주)스텔라엔터테인먼트</td>
                  <td><span className="badge badge-danger">폐기됨</span></td>
                  <td>10/15(목)</td>
                  <td>17:06:38 KST</td>
                  <td>끝남</td>
                </tr>
                <tr>
                  <td><Link to="/scanner-devices" className="fw-b" style={{ color: "inherit" }}>서문-03</Link></td>
                  <td>(주)스텔라엔터테인먼트</td>
                  <td><span className="badge badge-success">사용 중</span></td>
                  <td>10/21(수)</td>
                  <td>15:02 KST</td>
                  <td>없음</td>
                </tr>
                <tr>
                  <td><Link to="/scanner-devices" className="fw-b" style={{ color: "inherit" }}>[예시 기기 1]</Link></td>
                  <td>[예시 파트너 A]</td>
                  <td><span className="badge badge-success">사용 중</span></td>
                  <td>10/10(토)</td>
                  <td>10/23(금) 21:40 KST</td>
                  <td>없음</td>
                </tr>
                <tr>
                  <td><Link to="/scanner-devices" className="fw-b" style={{ color: "inherit" }}>[예시 기기 2]</Link></td>
                  <td>[예시 파트너 A]</td>
                  <td><span className="badge">퇴역</span></td>
                  <td>—</td>
                  <td>9/30(수) 18:10 KST</td>
                  <td>없음</td>
                </tr>
              </tbody>
            </table>
          </div>
        </>
      ) : null}
      {' '}
      {v.isEmpty ? (
        <>
          <div className="state" style={{ padding: "48px 24px" }}>
            <span className="state-icon is-primary"><i className="ic ic-device" aria-hidden="true" /></span>
            <h3 className="t-md fw-b">등록된 기기가 없습니다</h3>
            <p className="t-sm muted" style={{ maxWidth: "420px" }}>기기를 등록하면 이곳에 이름·배정 파트너·상태와 마지막 연락이 보입니다.</p>
          </div>
        </>
      ) : null}
    </section>
    {v.isActive ? (
      <>
        <section className="widget" role="region" aria-labelledby="h-d1">
          <div className="widget-head">
            <h2 className="t-sm fw-b" id="h-d1">서문-02</h2>
            <span className="badge badge-success">사용 중</span>
            {' '}
            <span className="actions t-xs muted">(주)스텔라엔터테인먼트</span>
          </div>
          <div className="widget-body" style={{ display: "grid", gridTemplateColumns: "repeat(2,minmax(0,1fr))", gap: "16px", alignItems: "start" }}>
            <div className="col" style={{ gap: "12px" }}>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(2,minmax(0,1fr))", gap: "8px" }}>
                <div className="stat" style={{ padding: "12px 14px" }}>
                  <span className="stat-label">기기 키</span>
                  <span className="stat-value">등록됨</span>
                  <span className="slo slo-ok">만료 없음</span>
                  <span className="stat-meta">10/15(목) 14:20 KST 등록</span>
                </div>
                <div className="stat is-burning" style={{ padding: "12px 14px" }}>
                  <span className="stat-label">마지막 연락</span>
                  <span className="stat-value">6분 전</span>
                  <span className="slo slo-burning">2분 넘음</span>
                  <span className="stat-meta">17:06:38 KST</span>
                </div>
              </div>
              <p className="t-xs muted">로그인 세션 1개 · 현장 스태프</p>
              <div className="field">
                <label className="label" htmlFor="d1-name">기기 이름 (필수)</label>
                {' '}
                <input className="input input-sm" id="d1-name" type="text" autoComplete="off" defaultValue="서문-02" />
              </div>
              <div className="field">
                <label className="label" htmlFor="d1-pt">배정 파트너 (필수)</label>
                <div className="input-group input-group-sm">
                  <select id="d1-pt" aria-describedby="d1-pt-h" defaultValue="(주)스텔라엔터테인먼트">
                    <option>(주)스텔라엔터테인먼트</option>
                    <option>[예시 파트너 A]</option>
                  </select>
                  <i className="ic ic-chevron-down" aria-hidden="true" />
                </div>
                <span className="hint" id="d1-pt-h">이 파트너 공연에 배정된 스태프만 이 기기로 로그인합니다.</span>
              </div>
              <div className="row"><button className="btn btn-secondary btn-sm" type="button" {...ro()}>이름·배정 저장하기</button></div>
            </div>
            <div className="col" style={{ gap: "12px" }}>
              <div className="card-flat col" style={{ gap: "8px", padding: "14px" }}>
                <h3 className="t-sm fw-b">즉시 폐기</h3>
                <p className="t-xs muted">분실·도난이면 바로 폐기합니다(RB-22). 폐기하면 이 기기의 다음 요청부터 막히고 로그인한 스태프 세션이 끝납니다.</p>
                <button onClick={() => go?.('폐기 확인 대화상자')} className="btn btn-danger btn-block" type="button" aria-haspopup="dialog" {...ro()}>
                  <i className="ic ic-ban" aria-hidden="true" />
                  서문-02 즉시 폐기하기
                </button>
              </div>
              <div className="row wrap" style={{ gap: "8px" }}>
                <button className="btn btn-outline btn-sm" type="button" aria-disabled="true" aria-describedby="d1-rr">회수 기기 다시 등록하기</button>
                {' '}
                <button className="btn btn-outline btn-sm" type="button" {...ro()}>퇴역 처리하기</button>
              </div>
              <p className="t-xs muted" id="d1-rr">다시 등록은 폐기한 기기를 회수했을 때 합니다.</p>
              <section className="col" style={{ gap: "8px" }} aria-labelledby="h-d1h">
                <div className="row between">
                  <h3 className="t-sm fw-b" id="h-d1h">등록·폐기 이력</h3>
                  <Link to="/audit" className="link-more">
                    감사 로그
                    <i className="ic ic-chevron-right" aria-hidden="true" />
                  </Link>
                </div>
                <ol className="timeline">
                  <li className="tl-item">
                    <span className="tl-dot ok" aria-hidden="true" />
                    <div className="col" style={{ gap: "2px" }}>
                      <span className="t-sm fw-b">등록 · (주)스텔라엔터테인먼트 배정</span>
                      <span className="t-xs muted">10/15(목) 14:20 KST · 민호 · 등록 코드로 기기 키 등록</span>
                    </div>
                  </li>
                </ol>
              </section>
            </div>
          </div>
        </section>
      </>
    ) : null}
    {' '}
    {v.isRevoked ? (
      <>
        <section className="widget" role="region" aria-labelledby="h-d2">
          <div className="widget-head">
            <h2 className="t-sm fw-b" id="h-d2">서문-02</h2>
            <span className="badge badge-danger">폐기됨</span>
            {' '}
            <span className="actions t-xs muted">(주)스텔라엔터테인먼트</span>
          </div>
          <div className="widget-body" style={{ display: "grid", gridTemplateColumns: "repeat(2,minmax(0,1fr))", gap: "16px", alignItems: "start" }}>
            <div className="col" style={{ gap: "12px" }}>
              <div className="banner" role="status">
                <i className="ic ic-ban" aria-hidden="true" />
                <div className="banner-body">
                  <span className="banner-title">이 기기의 세션이 끝났습니다</span>
                  <p>17:13:02 KST에 폐기했습니다. 이 기기의 다음 요청부터 막힙니다. 남은 스태프 토큰은 이 기기에 묶여 있어 다른 기기에서 쓸 수 없습니다.</p>
                </div>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(2,minmax(0,1fr))", gap: "8px" }}>
                <div className="stat is-stale" style={{ padding: "12px 14px" }}>
                  <span className="stat-label">기기 키</span>
                  <span className="stat-value">폐기됨</span>
                  <span className="slo slo-stale">다시 등록 필요</span>
                  <span className="stat-meta">10/15(목) 14:20 KST 등록</span>
                </div>
                <div className="stat" style={{ padding: "12px 14px" }}>
                  <span className="stat-label">마지막 연락</span>
                  <span className="stat-value">6분 전</span>
                  <span className="slo slo-stale">요청 막힘</span>
                  <span className="stat-meta">17:06:38 KST</span>
                </div>
              </div>
              <section className="col" style={{ gap: "8px" }} aria-labelledby="h-rb">
                <h3 className="t-sm fw-b" id="h-rb">RB-22 분실·도난 대응</h3>
                <ol className="col t-sm" style={{ gap: "6px" }}>
                  <li className="row" style={{ gap: "8px" }}>
                    <span className="step is-done"><span className="step-num"><i className="ic ic-check" aria-hidden="true" /></span></span>
                    즉시 폐기와 스태프 세션 종료
                    <span className="badge badge-success">끝남</span>
                  </li>
                  <li className="row" style={{ gap: "8px" }}>
                    <span className="step-num">2</span>
                    파트너·현장 책임자에게 알림
                  </li>
                  <li className="row" style={{ gap: "8px" }}>
                    <span className="step-num">3</span>
                    예비 기기 투입과 기기 배치
                  </li>
                  <li className="row" style={{ gap: "8px" }}>
                    <span className="step-num">4</span>
                    보내지 못한 기록의 손실 범위를 CS 처리함에 기록
                  </li>
                  <li className="row" style={{ gap: "8px" }}>
                    <span className="step-num">5</span>
                    회수하면 다시 등록한 뒤 남은 기록 업로드
                  </li>
                </ol>
              </section>
            </div>
            <div className="col" style={{ gap: "12px" }}>
              <div className="row wrap" style={{ gap: "8px" }}>
                <button className="btn btn-secondary btn-sm" type="button" {...ro()}>회수 기기 다시 등록하기</button>
                {' '}
                <button className="btn btn-outline btn-sm" type="button" {...ro()}>퇴역 처리하기</button>
              </div>
              <section className="col" style={{ gap: "8px" }} aria-labelledby="h-d2h">
                <div className="row between">
                  <h3 className="t-sm fw-b" id="h-d2h">등록·폐기 이력</h3>
                  <Link to="/audit" className="link-more">
                    감사 로그
                    <i className="ic ic-chevron-right" aria-hidden="true" />
                  </Link>
                </div>
                <ol className="timeline">
                  <li className="tl-item">
                    <span className="tl-dot bad" aria-hidden="true" />
                    <div className="col" style={{ gap: "2px" }}>
                      <span className="t-sm fw-b">폐기 · 사유: 서문 게이트 분실 신고</span>
                      <span className="t-xs muted">10/25(일) 17:13:02 KST · 민호 · 로그인 세션 1개 종료</span>
                    </div>
                  </li>
                  <li className="tl-item">
                    <span className="tl-dot ok" aria-hidden="true" />
                    <div className="col" style={{ gap: "2px" }}>
                      <span className="t-sm fw-b">등록 · (주)스텔라엔터테인먼트 배정</span>
                      <span className="t-xs muted">10/15(목) 14:20 KST · 민호 · 등록 코드로 기기 키 등록</span>
                    </div>
                  </li>
                </ol>
              </section>
            </div>
          </div>
        </section>
      </>
    ) : null}
    {' '}
    {v.isCode ? (
      <>
        <section className="widget" role="region" aria-labelledby="h-d3">
          <div className="widget-head">
            <h2 className="t-sm fw-b" id="h-d3">서문-02 · 다시 등록</h2>
            <span className="badge badge-danger">폐기됨</span>
            {' '}
            <span className="actions t-xs muted">(주)스텔라엔터테인먼트</span>
          </div>
          <div className="widget-body" style={{ display: "grid", gridTemplateColumns: "repeat(2,minmax(0,1fr))", gap: "16px", alignItems: "start" }}>
            <div className="col" style={{ gap: "12px" }}>
              {v.codeLive ? (
                <>
                  <p className="t-sm">회수한 서문-02에서 스캐너 앱의 기기 등록 화면을 열고 이 QR을 찍거나 코드를 입력하세요. 대문자와 하이픈은 구분하지 않습니다. 기기 안에서 만든 키가 이 기기 기록에 묶입니다.</p>
                </>
              ) : null}
              <div className="card-flat col" style={{ gap: "8px", padding: "24px 16px", alignItems: "center", textAlign: "center" }} role="group" aria-labelledby="d3-code-l">
                <span className="eyebrow" id="d3-code-l">등록 코드</span>
                {' '}
                {v.codeLive ? (
                  <>
                    <div className="qr-wrap" role="img" aria-label="등록 코드 QR. 아래 코드와 같은 내용입니다" style={{ width: "144px" }}>
                      <div className="qr">
                        {v.qr.map((m: any, i0: number) => (
                          <Fragment key={i0}>
                            <i className={m.on} />
                          </Fragment>
                        ))}
                      </div>
                    </div>
                    <span className="code-display" style={{ fontSize: "28px", lineHeight: "36px" }}>KDTW-BMQX-HLRP</span>
                    {' '}
                    <span className="t-xs muted">18:14 KST까지 10분 동안 한 번 쓸 수 있습니다</span>
                    {' '}
                    <button onClick={() => go?.('등록 코드')} className="btn btn-outline btn-sm" type="button" {...ro()}>새 코드 만들기</button>
                  </>
                ) : null}
                {' '}
                {v.codeExp ? (
                  <>
                    <span className="state-icon is-warning" style={{ width: "48px", height: "48px" }}>
                      <i className="ic ic-clock" aria-hidden="true" />
                    </span>
                    <p className="t-md fw-b" role="alert">등록 코드가 만료되었습니다. 새 코드를 만드세요</p>
                    <button onClick={() => go?.('등록 코드')} className="btn btn-primary btn-sm" type="button" {...ro()}>새 코드 만들기</button>
                  </>
                ) : null}
              </div>
              {v.codeLive ? (
                <>
                  <p className="row t-sm" role="status" style={{ gap: "8px" }}>
                    <span className="spinner" aria-hidden="true" />
                    기기에서 코드를 입력하기를 기다리는 중입니다
                  </p>
                </>
              ) : null}
            </div>
            <div className="col" style={{ gap: "12px" }}>
              <div className="banner banner-info">
                <i className="ic ic-info" aria-hidden="true" />
                <div className="banner-body">등록 코드로 기기 키를 등록합니다. 관리 앱(mTLS)을 쓰는 기기는 관리 앱이 등록을 이어 갑니다. 다시 등록되면 이 기기에 남은 스캔 기록을 올립니다(RB-22).</div>
              </div>
              <div className="row"><button onClick={close} className="btn btn-outline btn-sm" type="button">등록 화면 닫기</button></div>
              <section className="col" style={{ gap: "8px" }} aria-labelledby="h-d3h">
                <div className="row between">
                  <h3 className="t-sm fw-b" id="h-d3h">등록·폐기 이력</h3>
                  <Link to="/audit" className="link-more">
                    감사 로그
                    <i className="ic ic-chevron-right" aria-hidden="true" />
                  </Link>
                </div>
                <ol className="timeline">
                  <li className="tl-item">
                    <span className="tl-dot info" aria-hidden="true" />
                    <div className="col" style={{ gap: "2px" }}>
                      <span className="t-sm fw-b">다시 등록 시작 · 회수 확인</span>
                      <span className="t-xs muted">10/25(일) 18:04:52 KST · 민호</span>
                    </div>
                  </li>
                  <li className="tl-item">
                    <span className="tl-dot bad" aria-hidden="true" />
                    <div className="col" style={{ gap: "2px" }}>
                      <span className="t-sm fw-b">폐기 · 사유: 서문 게이트 분실 신고</span>
                      <span className="t-xs muted">10/25(일) 17:13:02 KST · 민호 · 로그인 세션 1개 종료</span>
                    </div>
                  </li>
                  <li className="tl-item">
                    <span className="tl-dot ok" aria-hidden="true" />
                    <div className="col" style={{ gap: "2px" }}>
                      <span className="t-sm fw-b">등록 · (주)스텔라엔터테인먼트 배정</span>
                      <span className="t-xs muted">10/15(목) 14:20 KST · 민호 · 등록 코드로 기기 키 등록</span>
                    </div>
                  </li>
                </ol>
              </section>
            </div>
          </div>
        </section>
      </>
    ) : null}
    <section className="widget" aria-labelledby="h-info">
      <div className="widget-head"><h2 className="t-sm fw-b" id="h-info">기기 상태와 기기 키</h2></div>
      <div className="widget-body">
        <dl className="t-sm" style={{ display: "grid", gridTemplateColumns: "auto minmax(0,1fr)", gap: "10px 16px", alignItems: "start" }}>
          <dt><span className="badge badge-success">사용 중</span></dt>
          <dd>스캐너 API가 요청마다 기기 상태를 확인합니다. 이 상태의 기기만 스태프 로그인을 시작할 수 있습니다.</dd>
          <dt><span className="badge badge-danger">폐기됨</span></dt>
          <dd>다음 요청부터 막히고 그 기기의 스태프 세션이 끝납니다. 회수하면 다시 등록합니다.</dd>
          <dt><span className="badge">퇴역</span></dt>
          <dd>더 쓰지 않는 기기입니다.</dd>
          <dt className="fw-b">기기 키</dt>
          <dd>이 기기는 기기 안에서 만든 키로 요청마다 서명합니다(기기 키 + DPoP). 기기 키는 만료가 없고, 잃거나 회수하면 폐기한 뒤 다시 등록합니다. T-30분 점검은 배치된 기기의 자격이 역할 유효 끝 뒤까지 유효한지 봅니다.</dd>
        </dl>
      </div>
    </section>
    </>
  );
}

export function OverlaysT({ v, close, go }: { v: V; close?: () => void; go?: (state: string) => void }) {
  void v; void close; void go;
  const ro = useRo();
  return (
    <>
    {v.isDialog ? (
      <>
        <Overlay placement="center" onClose={close}>
          <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="rv-t" aria-describedby="rv-d" style={{ maxWidth: "520px" }}>
            <div className="row" style={{ gap: "12px" }}>
              <span className="state-icon is-danger" style={{ width: "44px", height: "44px" }}><i className="ic ic-ban" aria-hidden="true" /></span>
              <h2 className="dialog-title" id="rv-t">서문-02를 즉시 폐기합니다</h2>
            </div>
            <p className="t-md fw-b" id="rv-d">폐기하면 이 기기의 다음 요청부터 막히고 로그인한 스태프 세션이 끝납니다</p>
            <dl className="kv">
              <dt>배정 파트너</dt>
              <dd>(주)스텔라엔터테인먼트</dd>
              <dt>로그인 세션</dt>
              <dd>1개 · 현장 스태프</dd>
              <dt>마지막 연락</dt>
              <dd>17:06:38 KST(6분 전)</dd>
            </dl>
            <div className="field">
              <label className="label" htmlFor="rv-reason">폐기 사유 (필수)</label>
              {' '}
              <textarea className="textarea" id="rv-reason" style={{ minHeight: "76px" }} aria-describedby="rv-reason-h" defaultValue="서문 게이트에서 분실 신고. 현장 책임자가 기기가 없음을 확인함" />
              {' '}
              <span className="hint" id="rv-reason-h">사유는 감사 로그에 남습니다.</span>
            </div>
            <div className="field">
              <label className="label" htmlFor="rv-type">확인을 위해 기기 이름 서문-02를 입력하세요 (필수)</label>
              {' '}
              <input className="input input-sm" id="rv-type" type="text" autoComplete="off" defaultValue="서문-02" />
            </div>
            <div className="card-flat col" style={{ gap: "8px", padding: "12px 14px" }}>
              <span className="t-sm fw-b">폐기 뒤 할 일(RB-22)</span>
              <ol className="col t-sm" style={{ gap: "6px" }}>
                <li className="row" style={{ gap: "8px" }}>
                  <span className="step-num">2</span>
                  파트너·현장 책임자에게 알립니다
                </li>
                <li className="row" style={{ gap: "8px" }}>
                  <span className="step-num">3</span>
                  예비 기기를 투입하고 기기 배치를 바꿉니다
                </li>
                <li className="row" style={{ gap: "8px" }}>
                  <span className="step-num">4</span>
                  보내지 못한 기록의 손실 범위를 CS 처리함에 기록합니다
                </li>
                <li className="row" style={{ gap: "8px" }}>
                  <span className="step-num">5</span>
                  회수하면 다시 등록한 뒤 남은 기록을 올립니다
                </li>
              </ol>
            </div>
            <div className="dialog-actions">
              <button onClick={close} className="btn btn-outline" type="button">폐기하지 않고 닫기</button>
              {' '}
              <button onClick={() => go?.('폐기됨')} className="btn btn-danger" type="button" {...ro()}>서문-02를 폐기하고 세션을 끝냅니다</button>
            </div>
          </div>
        </Overlay>
      </>
    ) : null}
    </>
  );
}
