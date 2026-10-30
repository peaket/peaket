// 디자인 캔버스 보드 SCR-064-d.dc.html를 옮긴 것(dc2tsx 생성 뒤 손질)
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

export const STATES_D = ["기본", "자기 계정", "역할 변경 재인증", "역할 변경 · 패스키 확인", "역할 변경 · 패스키 확인 실패", "파트너 계정 탭", "파트너 계정 탭 · 시간 잠금", "초대 보내기", "마지막 관리자", "초대됨", "초대 만료", "파트너 계정 탭 · 재초대(분실)", "파트너 계정 탭 · 보호 잠금(비밀번호 누계)", "commander 역할 승인 대기", "commander 계정 삭제", "삭제한 계정"] as const;
export const DEFAULT_D = "기본";

export function valsD(state: string) {
    let st = state || '기본';
    let last = st === '마지막 관리자';
    let lost = st === '파트너 계정 탭 · 재초대(분실)';
    let ptT = st === '파트너 계정 탭 · 시간 잠금' || lost;
    let ptPw = st === '파트너 계정 탭 · 보호 잠금(비밀번호 누계)';
    let ptA = st === '파트너 계정 탭' || ptT || ptPw;
    let mhPend = st === 'commander 역할 승인 대기';
    let invOk = st === '초대됨';
    let invExp = st === '초대 만료';
    let invd = invOk || invExp;
    let cmd = st === 'commander 계정 삭제';
    let del = st === '삭제한 계정';
    let pt = ptA || last;
    let pk = st === '역할 변경 · 패스키 확인' || st === '역할 변경 · 패스키 확인 실패';
    let mh = st === '기본' || st === '역할 변경 재인증' || pk || mhPend;
    let self = st === '자기 계정';
    return {
      isOps: !pt,
      isPt: pt,
      isPtA: ptA,
      lkProt: !ptT,
      lkTime: ptT,
      lkOtp: !ptT && !ptPw,
      lkPw: ptPw,
      mhPend: mhPend,
      isInvited: invd,
      invOk: invOk,
      invExp: invExp,
      invAt: invExp ? '10/12(월) 15:00 KST' : '10/14(수) 14:00 KST',
      isCmd: cmd,
      isDel: del,
      isLostDlg: lost,
      rowInv: invd ? 'is-selected' : '',
      curInv: invd ? 'true' : 'false',
      rowCmd: cmd ? 'is-selected' : '',
      curCmd: cmd ? 'true' : 'false',
      rowDel: del ? 'is-selected' : '',
      curDel: del ? 'true' : 'false',
      isLast: last,
      rowPtA: ptA ? 'is-selected' : '',
      curPtA: ptA ? 'true' : 'false',
      rowStAdm: last ? 'is-selected' : '',
      curStAdm: last ? 'true' : 'false',
      tabOpsCls: pt ? '' : 'is-active',
      tabPtCls: pt ? 'is-active' : '',
      tabOpsSel: pt ? 'false' : 'true',
      tabPtSel: pt ? 'true' : 'false',
      tabLbl: pt ? 'tab-pt' : 'tab-ops',
      isMinho: mh,
      isSelf: self,
      isInvite: st === '초대 보내기',
      isReauth: st === '역할 변경 재인증',
      isPk: pk,
      pkFail: st === '역할 변경 · 패스키 확인 실패',
      rowMinho: mh ? 'is-selected' : '',
      curMinho: mh ? 'true' : 'false',
      rowSelf: self ? 'is-selected' : '',
      curSelf: self ? 'true' : 'false'
    };
  }

type V = ReturnType<typeof valsD>;

// 보드 루트: {"class": "pk dark cs", "style": "width:100%;min-height:1240px;grid-template-rows:auto 1fr"}

// <main class="cs-main" id="main">
export function MainD({ v, close, go }: { v: V; close?: () => void; go?: (state: string) => void }) {
  void v; void close; void go;
  const ro = useRo();
  return (
    <>
    <div className="row between" style={{ alignItems: "flex-end", gap: "24px" }}>
      <div className="col" style={{ gap: "4px" }}>
        <h1 className="t-xl">관리 계정·세션</h1>
        <p className="t-sm muted">운영자·CS와 파트너의 관리 계정을 초대하고 역할·지정·세션을 관리합니다. 권한 부여·변경·말소 내역은 3년 보관합니다.</p>
      </div>
      <button onClick={() => go?.('초대 보내기')} className="btn btn-primary" type="button">
        <i className="ic ic-plus" aria-hidden="true" />
        초대 보내기
      </button>
    </div>
    <div className="tabs" role="tablist" aria-label="계정 종류">
      <button onClick={() => go?.('기본')} className={`tab ${v.tabOpsCls}`} type="button" role="tab" aria-selected={(v.tabOpsSel) as AriaBool} id="tab-ops" aria-controls="tp-acc">
        운영자·CS
        <span className="badge">9</span>
      </button>
      {' '}
      <button onClick={() => go?.('파트너 계정 탭')} className={`tab ${v.tabPtCls}`} type="button" role="tab" aria-selected={(v.tabPtSel) as AriaBool} id="tab-pt" aria-controls="tp-acc">
        파트너 계정
        <span className="badge">4</span>
      </button>
    </div>
    <div className="grid-12" id="tp-acc" role="tabpanel" aria-labelledby={v.tabLbl} style={{ rowGap: "16px", alignItems: "start" }}>
      <div className="span-7 col" style={{ gap: "16px" }}>
        {v.isOps ? (
          <>
            <section className="widget" aria-labelledby="h-ops">
              <div className="widget-head">
                <h2 className="t-sm fw-b" id="h-ops">운영자·CS 계정 9개</h2>
                <span className="actions t-xs muted">이메일은 일부만 보입니다</span>
              </div>
              <table className="table dense">
                <caption className="sr-only">운영자·CS 관리 계정. 이름을 누르면 오른쪽에 상세가 열립니다</caption>
                <thead>
                  <tr>
                    <th scope="col">이름</th>
                    <th scope="col">이메일</th>
                    <th scope="col">역할</th>
                    <th scope="col">상태</th>
                    <th scope="col">마지막 접속</th>
                    <th scope="col">인증 앱</th>
                  </tr>
                </thead>
                <tbody>
                  <tr className={v.rowSelf}>
                    <td>
                      <div className="row" style={{ gap: "6px" }}>
                        <Link onClick={(e) => { e.preventDefault(); go?.('자기 계정'); }} to="/accounts" className="fw-b" style={{ color: "inherit" }} aria-current={(v.curSelf) as AriaCurrent}>수진</Link>
                        <span className="badge badge-outline">본인</span>
                      </div>
                    </td>
                    <td>su***@peaket.example</td>
                    <td>commander</td>
                    <td><span className="badge badge-success">활성</span></td>
                    <td>지금 · 이 기기</td>
                    <td>등록됨</td>
                  </tr>
                  <tr className={v.rowCmd}>
                    <td><Link onClick={(e) => { e.preventDefault(); go?.('commander 계정 삭제'); }} to="/accounts" className="fw-b" style={{ color: "inherit" }} aria-current={(v.curCmd) as AriaCurrent}>[두 번째 commander]</Link></td>
                    <td>co***@peaket.example</td>
                    <td>commander</td>
                    <td><span className="badge badge-success">활성</span></td>
                    <td>19:52 KST</td>
                    <td>등록됨</td>
                  </tr>
                  <tr className={v.rowMinho}>
                    <td><Link onClick={(e) => { e.preventDefault(); go?.('기본'); }} to="/accounts" className="fw-b" style={{ color: "inherit" }} aria-current={(v.curMinho) as AriaCurrent}>민호</Link></td>
                    <td>mi***@peaket.example</td>
                    <td>operator</td>
                    <td><span className="badge badge-success">활성</span></td>
                    <td>19:58 KST</td>
                    <td>등록됨</td>
                  </tr>
                  <tr>
                    <td><Link to="/accounts" className="fw-b" style={{ color: "inherit" }}>서연</Link></td>
                    <td>se***@peaket.example</td>
                    <td>viewer</td>
                    <td><span className="badge badge-success">활성</span></td>
                    <td>19:40 KST</td>
                    <td>등록됨</td>
                  </tr>
                  <tr>
                    <td><Link to="/accounts" className="fw-b" style={{ color: "inherit" }}>다은</Link></td>
                    <td>da***@peaket.example</td>
                    <td>cs_agent</td>
                    <td><span className="badge badge-success">활성</span></td>
                    <td>18:12 KST</td>
                    <td>등록됨</td>
                  </tr>
                  <tr>
                    <td><Link to="/accounts" className="fw-b" style={{ color: "inherit" }}>준</Link></td>
                    <td>ju***@peaket.example</td>
                    <td>cs_lead</td>
                    <td><span className="badge badge-success">활성</span></td>
                    <td>17:55 KST</td>
                    <td>등록됨</td>
                  </tr>
                  <tr className={v.rowInv}>
                    <td><Link onClick={(e) => { e.preventDefault(); go?.('초대됨'); }} to="/accounts" className="fw-b" style={{ color: "inherit" }} aria-current={(v.curInv) as AriaCurrent}>[운영자 A]</Link></td>
                    <td>op***@peaket.example</td>
                    <td>viewer</td>
                    <td><span className="badge badge-primary">초대됨</span></td>
                    <td>—</td>
                    <td>등록 전</td>
                  </tr>
                  <tr>
                    <td><Link to="/accounts" className="fw-b" style={{ color: "inherit" }}>[CS 담당자 B]</Link></td>
                    <td>cs***@peaket.example</td>
                    <td>cs_agent</td>
                    <td><span className="badge badge-danger">잠김</span></td>
                    <td>10/13(화) 09:12 KST</td>
                    <td>등록됨</td>
                  </tr>
                  <tr className={v.rowDel}>
                    <td><Link onClick={(e) => { e.preventDefault(); go?.('삭제한 계정'); }} to="/accounts" className="fw-b" style={{ color: "var(--text-muted)" }} aria-current={(v.curDel) as AriaCurrent}>삭제된 계정</Link></td>
                    <td>—</td>
                    <td>operator</td>
                    <td><span className="badge">삭제</span></td>
                    <td>9/30(수) 18:00 KST</td>
                    <td>—</td>
                  </tr>
                </tbody>
              </table>
              <p className="t-xs muted" style={{ padding: "10px 14px" }}>
                초대됨은 비밀번호와 인증 앱을 등록하면 활성이 됩니다. 보호 잠금은 재초대로만 풀립니다. 시간 잠금은 본인이 이메일 링크로 풉니다. 삭제한 계정의 권한 말소 내역은 3년 보관합니다.
              </p>
            </section>
          </>
        ) : null}
        {' '}
        {v.isPt ? (
          <>
            <section className="widget" aria-labelledby="h-pts">
              <div className="widget-head">
                <h2 className="t-sm fw-b" id="h-pts">파트너 계정 4개</h2>
                <span className="actions t-xs muted">파트너 계정은 소속 파트너 하나에 묶입니다</span>
              </div>
              <table className="table dense">
                <caption className="sr-only">파트너 관리 계정. 이름을 누르면 오른쪽에 상세가 열립니다</caption>
                <thead>
                  <tr>
                    <th scope="col">이름</th>
                    <th scope="col">이메일</th>
                    <th scope="col">소속 파트너</th>
                    <th scope="col">역할</th>
                    <th scope="col">상태</th>
                    <th scope="col">마지막 접속</th>
                    <th scope="col">인증 앱</th>
                  </tr>
                </thead>
                <tbody>
                  <tr className={v.rowStAdm}>
                    <td><Link onClick={(e) => { e.preventDefault(); go?.('마지막 관리자'); }} to="/partners" className="fw-b" style={{ color: "inherit" }} aria-current={(v.curStAdm) as AriaCurrent}>파트너 관리자</Link></td>
                    <td>op***@stella.example</td>
                    <td>(주)스텔라엔터테인먼트</td>
                    <td>파트너 관리자</td>
                    <td><span className="badge badge-success">활성</span></td>
                    <td>19:20 KST</td>
                    <td>등록됨</td>
                  </tr>
                  <tr>
                    <td><Link to="/partners" className="fw-b" style={{ color: "inherit" }}>파트너 실무자</Link></td>
                    <td>tk***@stella.example</td>
                    <td>(주)스텔라엔터테인먼트</td>
                    <td>파트너 실무자</td>
                    <td><span className="badge badge-success">활성</span></td>
                    <td>18:05 KST</td>
                    <td>등록됨</td>
                  </tr>
                  <tr className={v.rowPtA}>
                    <td>
                      <Link onClick={(e) => { e.preventDefault(); go?.('파트너 계정 탭'); }} to="/partners" className="fw-b" style={{ color: "inherit" }} aria-current={(v.curPtA) as AriaCurrent}>[예시 파트너 A] 담당자</Link>
                    </td>
                    <td>ad***@partner-a.example</td>
                    <td>[예시 파트너 A]</td>
                    <td>파트너 관리자</td>
                    <td><span className="badge badge-danger">잠김</span></td>
                    <td>10/13(화) 22:41 KST</td>
                    <td>등록됨</td>
                  </tr>
                  <tr>
                    <td><Link to="/partners" className="fw-b" style={{ color: "inherit" }}>[예시 파트너 B] 담당자</Link></td>
                    <td>ad***@partner-b.example</td>
                    <td>[예시 파트너 B]</td>
                    <td>파트너 관리자</td>
                    <td><span className="badge badge-primary">초대됨</span></td>
                    <td>—</td>
                    <td>등록 전</td>
                  </tr>
                </tbody>
              </table>
              <p className="t-xs muted" style={{ padding: "10px 14px" }}>
                파트너 계정의 초대와 잠금 해제는 operator 이상이 합니다. 보호 잠금은 재초대로만 풀립니다. 시간 잠금은 본인이 이메일 링크로 풉니다. 파트너사마다 파트너 관리자가 1명 이상 있어야 합니다.
              </p>
            </section>
          </>
        ) : null}
      </div>
      <div className="span-5 col" style={{ gap: "16px" }}>
        {v.isMinho ? (
          <>
            <section className="widget" role="region" aria-labelledby="h-mh">
              <div className="widget-head">
                <h2 className="t-sm fw-b" id="h-mh">민호</h2>
                <span className="badge badge-outline">operator</span>
                <span className="badge badge-success">활성</span>
                <span className="actions t-xs muted">mi***@peaket.example</span>
              </div>
              <div className="widget-body" style={{ gap: "12px" }}>
                <div className="field">
                  <label className="label" htmlFor="mh-role">역할</label>
                  <div className="row" style={{ gap: "8px" }}>
                    <div className="input-group input-group-sm grow">
                      <select id="mh-role" aria-describedby="mh-role-h" defaultValue="operator">
                        <option>viewer</option>
                        <option>operator</option>
                        <option>commander</option>
                        <option>cs_agent</option>
                        <option>cs_lead</option>
                      </select>
                      <i className="ic ic-chevron-down" aria-hidden="true" />
                    </div>
                    <button onClick={() => go?.('역할 변경 재인증')} className="btn btn-secondary" type="button" {...ro()}>역할 바꾸기</button>
                  </div>
                  {v.mhPend ? (
                    <>
                      <div className="row wrap" role="status" style={{ gap: "6px", alignItems: "center" }}>
                        <span className="badge badge-warning">
                          <i className="ic ic-clock" aria-hidden="true" />
                          commander 변경 승인 대기
                        </span>
                        <span className="t-sm">다른 commander가 승인 업무에서 승인하면 바뀝니다</span>
                      </div>
                    </>
                  ) : null}
                  {' '}
                  <span className="hint" id="mh-role-h">
                    바꾸기 직전에 비밀번호와 인증 앱 코드로 다시 인증하고, 등록한 패스키로 한 번 더 확인합니다. commander 역할의 부여·회수는 다른 commander의 승인 요청(승인 업무, 2인)으로 넘깁니다.
                  </span>
                </div>
                <section className="col" style={{ gap: "8px" }} aria-labelledby="h-mh-ss">
                  <div className="row between">
                    <h3 className="t-sm fw-b" id="h-mh-ss">활성 세션</h3>
                    <span className="t-xs muted">2개 · 최대 2개</span>
                  </div>
                  <ul className="col" style={{ gap: "6px" }}>
                    <li className="card row" style={{ gap: "10px", padding: "8px 10px" }}>
                      <i className="ic ic-globe ic-16 muted" aria-hidden="true" />
                      <div className="col grow" style={{ gap: "2px" }}>
                        <span className="t-sm fw-b">Chrome · Windows</span>
                        <span className="t-xs muted">로그인 19:31 KST · 마지막 활동 19:58 KST</span>
                      </div>
                      <button className="btn btn-danger-outline btn-sm" type="button" aria-label="민호의 Chrome · Windows 세션 강제 종료">강제 종료</button>
                    </li>
                    <li className="card row" style={{ gap: "10px", padding: "8px 10px" }}>
                      <i className="ic ic-globe ic-16 muted" aria-hidden="true" />
                      <div className="col grow" style={{ gap: "2px" }}>
                        <span className="t-sm fw-b">Edge · Windows</span>
                        <span className="t-xs muted">로그인 19:02 KST · 마지막 활동 19:47 KST</span>
                      </div>
                      <button className="btn btn-danger-outline btn-sm" type="button" aria-label="민호의 Edge · Windows 세션 강제 종료">강제 종료</button>
                    </li>
                  </ul>
                  <p className="hint">강제 종료하면 그 기기에 "보안을 위해 운영자가 로그아웃시켰습니다. 다시 로그인해 주세요"가 보입니다.</p>
                </section>
                <section className="col" style={{ gap: "8px" }} aria-labelledby="h-mh-op">
                  <h3 className="t-sm fw-b" id="h-mh-op">계정 작업</h3>
                  <div className="row wrap" style={{ gap: "8px" }}>
                    <button className="btn btn-outline btn-sm" type="button" aria-disabled="true" aria-describedby="mh-ul-why">재초대로 잠금 풀기</button>
                    {' '}
                    <button className="btn btn-outline btn-sm" type="button" aria-haspopup="dialog" {...ro('mh-lost-h')}>재초대(분실)</button>
                    {' '}
                    <button className="btn btn-danger-outline btn-sm" type="button" aria-haspopup="dialog" {...ro('mh-del-h')}>
                      민호 계정 삭제하기
                    </button>
                  </div>
                  <p className="hint">
                    <span id="mh-ul-why">이 계정은 잠기지 않았습니다.</span>
                    {' '}
                    <span id="mh-lost-h">재초대(분실)은 비밀번호나 인증 앱을 잃었다고 요청한 분에게만 씁니다.</span>
                    {' '}
                    <span id="mh-del-h">삭제는 확인, 다시 인증, 패스키 확인을 거치고, 권한 말소 내역은 3년 보관합니다.</span>
                  </p>
                </section>
                <fieldset className="col" style={{ gap: "8px" }}>
                  <legend className="t-sm fw-b" style={{ marginBottom: "8px" }}>지정</legend>
                  <div className="row wrap" style={{ gap: "8px 20px" }}>
                    <label className="check-row">
                      <input className="cb" type="checkbox" disabled aria-describedby="mh-dg-why" />
                      접속기록 점검자
                    </label>
                    {' '}
                    <label className="check-row">
                      <input className="cb" type="checkbox" />
                      가명정보 취급자
                    </label>
                  </div>
                  <p className="hint" id="mh-dg-why">접속기록 점검자는 commander 가운데에서 지정합니다.</p>
                  <div className="row" style={{ gap: "8px", alignItems: "flex-end" }}>
                    <div className="field grow">
                      <label className="label" htmlFor="mh-basis">
                        지정 근거{' '}
                        <span className="opt">(지정할 때 필수)</span>
                      </label>
                      <input className="input input-sm" id="mh-basis" type="text" autoComplete="off" aria-describedby="mh-basis-h" />
                    </div>
                    <button className="btn btn-secondary" type="button" {...ro()}>지정 저장하기</button>
                  </div>
                  <span className="hint" id="mh-basis-h">개인정보 보호책임자의 지정 근거를 적고, 저장 직전에 다시 인증하고 패스키로 한 번 더 확인합니다.</span>
                </fieldset>
                <section className="col" style={{ gap: "8px" }} aria-labelledby="h-mh-h">
                  <div className="row between">
                    <h3 className="t-sm fw-b" id="h-mh-h">권한 이력</h3>
                    <span className="t-xs muted">3년 보관</span>
                  </div>
                  <ol className="timeline">
                    {v.mhPend ? (
                      <>
                        <li className="tl-item">
                          <span className="tl-dot warn" aria-hidden="true" />
                          <div className="col" style={{ gap: "2px" }}>
                            <span className="t-sm fw-b">역할 변경 요청 operator → commander · 승인 대기</span>
                            <span className="t-xs muted">10/14(수) 20:02 KST · 수진 · 다시 인증함</span>
                          </div>
                        </li>
                      </>
                    ) : null}
                    <li className="tl-item">
                      <span className="tl-dot info" aria-hidden="true" />
                      <div className="col" style={{ gap: "2px" }}>
                        <span className="t-sm fw-b">역할 변경 viewer → operator</span>
                        <span className="t-xs muted">10/5(월) 14:10 KST · 수진 · 다시 인증함</span>
                      </div>
                    </li>
                    <li className="tl-item">
                      <span className="tl-dot ok" aria-hidden="true" />
                      <div className="col" style={{ gap: "2px" }}>
                        <span className="t-sm fw-b">초대(viewer) → 활성</span>
                        <span className="t-xs muted">9/14(월) 10:05 KST · 수진</span>
                      </div>
                    </li>
                  </ol>
                </section>
              </div>
            </section>
          </>
        ) : null}
        {' '}
        {v.isSelf ? (
          <>
            <section className="widget" role="region" aria-labelledby="h-sj">
              <div className="widget-head">
                <h2 className="t-sm fw-b" id="h-sj">수진</h2>
                <span className="badge badge-outline">본인</span>
                <span className="badge badge-outline">commander</span>
                <span className="badge badge-success">활성</span>
                <span className="actions t-xs muted">su***@peaket.example</span>
              </div>
              <div className="widget-body" style={{ gap: "14px" }}>
                <div className="banner banner-info">
                  <i className="ic ic-lock" aria-hidden="true" />
                  <div className="banner-body" id="sj-why">
                    <span className="banner-title">자기 권한은 바꿀 수 없습니다</span>
                    내 역할·지정 변경과 계정 삭제는 다른 commander가 합니다.
                  </div>
                </div>
                <div className="field">
                  <label className="label" htmlFor="sj-role">역할</label>
                  <div className="row" style={{ gap: "8px" }}>
                    <div className="input-group input-group-sm grow is-disabled">
                      <select id="sj-role" disabled aria-describedby="sj-why" defaultValue="commander"><option>commander</option></select>
                      <i className="ic ic-chevron-down" aria-hidden="true" />
                    </div>
                    <button className="btn btn-secondary" type="button" aria-disabled="true" aria-describedby="sj-why">역할 바꾸기</button>
                  </div>
                </div>
                <section className="col" style={{ gap: "8px" }} aria-labelledby="h-sj-ss">
                  <div className="row between">
                    <h3 className="t-sm fw-b" id="h-sj-ss">활성 세션</h3>
                    <span className="t-xs muted">2개 · 최대 2개</span>
                  </div>
                  <ul className="col" style={{ gap: "6px" }}>
                    <li className="card row" style={{ gap: "10px", padding: "8px 10px" }}>
                      <i className="ic ic-globe ic-16 muted" aria-hidden="true" />
                      <div className="col grow" style={{ gap: "2px" }}>
                        <span className="t-sm fw-b">Chrome · Windows</span>
                        <span className="t-xs muted">로그인 18:40 KST · 마지막 활동 20:04 KST</span>
                      </div>
                      <span className="badge badge-primary">지금 이 기기</span>
                    </li>
                    <li className="card row" style={{ gap: "10px", padding: "8px 10px" }}>
                      <i className="ic ic-globe ic-16 muted" aria-hidden="true" />
                      <div className="col grow" style={{ gap: "2px" }}>
                        <span className="t-sm fw-b">Safari · macOS</span>
                        <span className="t-xs muted">로그인 19:05 KST · 마지막 활동 19:21 KST</span>
                      </div>
                    </li>
                  </ul>
                  <p className="hint">
                    내 세션은 내 계정 화면에서 로그아웃합니다.{' '}
                    <Link to="/me" className="link">내 계정으로 가기</Link>
                  </p>
                </section>
                <section className="col" style={{ gap: "8px" }} aria-labelledby="h-sj-op">
                  <h3 className="t-sm fw-b" id="h-sj-op">계정 작업</h3>
                  <div className="row wrap" style={{ gap: "8px" }}>
                    <button className="btn btn-outline btn-sm" type="button" aria-disabled="true" aria-describedby="sj-ul">재초대로 잠금 풀기</button>
                    {' '}
                    <button className="btn btn-danger-outline btn-sm" type="button" aria-disabled="true" aria-describedby="sj-why">수진 계정 삭제하기</button>
                  </div>
                  <p className="hint" id="sj-ul">이 계정은 잠기지 않았습니다.</p>
                </section>
                <fieldset className="col" style={{ gap: "8px" }}>
                  <legend className="t-sm fw-b" style={{ marginBottom: "8px" }}>지정</legend>
                  <div className="row wrap" style={{ gap: "8px 20px" }}>
                    <label className="check-row">
                      <input className="cb" type="checkbox" defaultChecked disabled aria-describedby="sj-why" />
                      접속기록 점검자
                    </label>
                    {' '}
                    <label className="check-row">
                      <input className="cb" type="checkbox" disabled aria-describedby="sj-why" />
                      가명정보 취급자
                    </label>
                  </div>
                  <p className="hint">접속기록 점검자 지정 10/1(목) · 근거 [개인정보 보호책임자 지정 근거]. 내 접속기록은 다른 commander가 점검합니다.</p>
                </fieldset>
                <section className="col" style={{ gap: "8px" }} aria-labelledby="h-sj-h">
                  <div className="row between">
                    <h3 className="t-sm fw-b" id="h-sj-h">권한 이력</h3>
                    <span className="t-xs muted">3년 보관</span>
                  </div>
                  <ol className="timeline">
                    <li className="tl-item">
                      <span className="tl-dot info" aria-hidden="true" />
                      <div className="col" style={{ gap: "2px" }}>
                        <span className="t-sm fw-b">접속기록 점검자 지정</span>
                        <span className="t-xs muted">10/1(목) 11:00 KST · [두 번째 commander] · 다시 인증함</span>
                      </div>
                    </li>
                    <li className="tl-item">
                      <span className="tl-dot ok" aria-hidden="true" />
                      <div className="col" style={{ gap: "2px" }}>
                        <span className="t-sm fw-b">초대(commander) → 활성</span>
                        <span className="t-xs muted">9/1(화) 10:20 KST · 비밀번호·인증 앱 등록</span>
                      </div>
                    </li>
                  </ol>
                </section>
              </div>
            </section>
          </>
        ) : null}
        {' '}
        {v.isPtA ? (
          <>
            <section className="widget" role="region" aria-labelledby="h-pa">
              <div className="widget-head">
                <h2 className="t-sm fw-b" id="h-pa">[예시 파트너 A] 담당자</h2>
                <span className="badge badge-outline">파트너</span>
                <span className="badge badge-danger">잠김</span>
                <span className="actions t-xs muted">ad***@partner-a.example</span>
              </div>
              <div className="widget-body" style={{ gap: "14px" }}>
                <div className="banner banner-warning" role="status">
                  <i className="ic ic-lock" aria-hidden="true" />
                  <div className="banner-body">
                    {v.lkProt ? (
                      <>
                        <span className="banner-title">보안을 위해 잠갔습니다</span>
                        10/13(화) 22:41 KST ·{' '}
                        {v.lkOtp ? (
                          <>
                            비밀번호가 맞은 뒤 인증 앱·복구 코드를 5회 연속 틀렸습니다.
                          </>
                        ) : null}
                        {v.lkPw ? (
                          <>
                            로그인 성공 없이 비밀번호가 100번 틀렸습니다.
                          </>
                        ) : null}
                        {' '}계정 주인에게는 "보안을 위해 계정을 잠갔습니다. 운영자에게 재초대를 요청하세요"가 보였습니다. 본인인지 확인한 뒤 재초대하세요.
                      </>
                    ) : null}
                    {v.lkTime ? (
                      <>
                        <span className="banner-title">로그인 실패가 반복되어 시간 잠금 중입니다</span>
                        10/13(화) 22:56 KST에 풀립니다 · 본인이 업무 이메일 링크와 인증 앱 코드로 바로 풀 수 있습니다.
                      </>
                    ) : null}
                  </div>
                </div>
                <div className="field">
                  <label className="label" htmlFor="pa-pt">소속 파트너</label>
                  <div className="input-group input-group-sm is-disabled">
                    <select id="pa-pt" disabled aria-describedby="pa-pt-h" defaultValue="[예시 파트너 A]"><option>[예시 파트너 A]</option></select>
                    <i className="ic ic-chevron-down" aria-hidden="true" />
                  </div>
                  <span className="hint" id="pa-pt-h">파트너 계정은 소속 파트너 하나에 묶여 다른 파트너로 옮길 수 없습니다.</span>
                </div>
                <dl className="kv">
                  <dt>역할</dt>
                  <dd>파트너 관리자</dd>
                  <dt>잠금</dt>
                  <dd>
                    {v.lkProt ? (
                      <>
                        보호 잠금(재초대로만 풂)
                      </>
                    ) : null}
                    {v.lkTime ? (
                      <>
                        시간 잠금 15분 · 10/13(화) 22:56 KST에 풀림
                      </>
                    ) : null}
                  </dd>
                  <dt>인증 앱</dt>
                  <dd>등록됨</dd>
                  <dt>활성 세션</dt>
                  <dd>없음</dd>
                </dl>
                <section className="col" style={{ gap: "8px" }} aria-labelledby="h-pa-ul">
                  <h3 className="t-sm fw-b" id="h-pa-ul">잠금 해제</h3>
                  <p className="t-sm">
                    보호 잠금은 재초대로만 풀립니다. 시간 잠금은 본인이 이메일 링크로 풉니다. 재초대하면 등록 이메일로 24시간 동안 한 번만 쓰는 링크를 보내고, 받은 분이 비밀번호와 인증 앱을 다시 등록하면 활성이 됩니다.
                  </p>
                  {v.lkProt ? (
                    <>
                      <div className="row"><button onClick={() => go?.('초대됨')} className="btn btn-primary" type="button" {...ro()}>재초대 링크 보내기</button></div>
                    </>
                  ) : null}
                  {' '}
                  {v.lkTime ? (
                    <>
                      <p className="t-xs muted" id="pa-lost-h">시간 잠금은 재초대로 풀지 않습니다. 인증 수단을 잃은 경우에만 [재초대(분실)]를 씁니다.</p>
                      <div className="row">
                        <button onClick={() => go?.('파트너 계정 탭 · 재초대(분실)')} className="btn btn-outline" type="button" aria-haspopup="dialog" {...ro('pa-lost-h')}>재초대(분실)</button>
                      </div>
                    </>
                  ) : null}
                </section>
                <section className="col" style={{ gap: "8px" }} aria-labelledby="h-pa-h">
                  <div className="row between">
                    <h3 className="t-sm fw-b" id="h-pa-h">권한 이력</h3>
                    <span className="t-xs muted">3년 보관</span>
                  </div>
                  <ol className="timeline">
                    <li className="tl-item">
                      <span className="tl-dot bad" aria-hidden="true" />
                      <div className="col" style={{ gap: "2px" }}>
                        <span className="t-sm fw-b">
                          {v.lkOtp ? (
                            <>
                              보호 잠금 · 인증 앱·복구 코드 실패 5회
                            </>
                          ) : null}
                          {v.lkPw ? (
                            <>
                              보호 잠금 · 비밀번호 연속 실패 누계 100
                            </>
                          ) : null}
                          {v.lkTime ? (
                            <>
                              시간 잠금 · 연속 인증 실패 5회 · 15분
                            </>
                          ) : null}
                        </span>
                        <span className="t-xs muted">10/13(화) 22:41 KST · 시스템</span>
                      </div>
                    </li>
                    <li className="tl-item">
                      <span className="tl-dot ok" aria-hidden="true" />
                      <div className="col" style={{ gap: "2px" }}>
                        <span className="t-sm fw-b">활성 · 비밀번호·인증 앱 등록</span>
                        <span className="t-xs muted">10/2(금) 11:00 KST · [예시 파트너 A] 담당자</span>
                      </div>
                    </li>
                    <li className="tl-item">
                      <span className="tl-dot" aria-hidden="true" />
                      <div className="col" style={{ gap: "2px" }}>
                        <span className="t-sm fw-b">초대 · [예시 파트너 A] 소속 · 파트너 관리자</span>
                        <span className="t-xs muted">10/1(목) 15:20 KST · 민호</span>
                      </div>
                    </li>
                  </ol>
                </section>
              </div>
            </section>
          </>
        ) : null}
        {' '}
        {v.isLast ? (
          <>
            <section className="widget" role="region" aria-labelledby="h-la">
              <div className="widget-head">
                <h2 className="t-sm fw-b" id="h-la">파트너 관리자</h2>
                <span className="badge badge-outline">파트너</span>
                <span className="badge badge-success">활성</span>
                <span className="actions t-xs muted">op***@stella.example</span>
              </div>
              <div className="widget-body" style={{ gap: "14px" }}>
                <div className="banner banner-info" role="status">
                  <i className="ic ic-lock" aria-hidden="true" />
                  <div className="banner-body" id="la-why">
                    <span className="banner-title">파트너사마다 파트너 관리자가 1명 이상 있어야 합니다</span>
                    (주)스텔라엔터테인먼트의 활성 파트너 관리자는 이 계정 1명이라 역할 변경과 계정 삭제를 할 수 없습니다.
                  </div>
                </div>
                <div className="field">
                  <label className="label" htmlFor="la-pt">소속 파트너</label>
                  <div className="input-group input-group-sm is-disabled">
                    <select id="la-pt" disabled aria-describedby="la-pt-h" defaultValue="(주)스텔라엔터테인먼트"><option>(주)스텔라엔터테인먼트</option></select>
                    <i className="ic ic-chevron-down" aria-hidden="true" />
                  </div>
                  <span className="hint" id="la-pt-h">파트너 계정은 소속 파트너 하나에 묶여 다른 파트너로 옮길 수 없습니다.</span>
                </div>
                <div className="field">
                  <label className="label" htmlFor="la-role">역할</label>
                  <div className="row" style={{ gap: "8px" }}>
                    <div className="input-group input-group-sm grow is-disabled">
                      <select id="la-role" disabled aria-describedby="la-why" defaultValue="파트너 관리자">
                        <option>파트너 관리자</option>
                        <option>파트너 실무자</option>
                      </select>
                      <i className="ic ic-chevron-down" aria-hidden="true" />
                    </div>
                    <button className="btn btn-secondary" type="button" aria-disabled="true" aria-describedby="la-why">역할 바꾸기</button>
                  </div>
                </div>
                <section className="col" style={{ gap: "8px" }} aria-labelledby="h-la-ss">
                  <div className="row between">
                    <h3 className="t-sm fw-b" id="h-la-ss">활성 세션</h3>
                    <span className="t-xs muted">1개 · 최대 2개</span>
                  </div>
                  <ul className="col" style={{ gap: "6px" }}>
                    <li className="card row" style={{ gap: "10px", padding: "8px 10px" }}>
                      <i className="ic ic-globe ic-16 muted" aria-hidden="true" />
                      <div className="col grow" style={{ gap: "2px" }}>
                        <span className="t-sm fw-b">Chrome · macOS</span>
                        <span className="t-xs muted">로그인 18:52 KST · 마지막 활동 19:20 KST</span>
                      </div>
                      <button className="btn btn-danger-outline btn-sm" type="button" aria-label="파트너 관리자의 Chrome · macOS 세션 강제 종료">강제 종료</button>
                    </li>
                  </ul>
                </section>
                <section className="col" style={{ gap: "8px" }} aria-labelledby="h-la-op">
                  <h3 className="t-sm fw-b" id="h-la-op">계정 작업</h3>
                  <div className="row wrap" style={{ gap: "8px" }}>
                    <button className="btn btn-outline btn-sm" type="button" aria-disabled="true" aria-describedby="la-ul">재초대로 잠금 풀기</button>
                    {' '}
                    <button className="btn btn-danger-outline btn-sm" type="button" aria-disabled="true" aria-describedby="la-why">
                      파트너 관리자 계정 삭제하기
                    </button>
                  </div>
                  <p className="hint" id="la-ul">이 계정은 잠기지 않았습니다.</p>
                </section>
                <section className="col" style={{ gap: "8px" }} aria-labelledby="h-la-h">
                  <div className="row between">
                    <h3 className="t-sm fw-b" id="h-la-h">권한 이력</h3>
                    <span className="t-xs muted">3년 보관</span>
                  </div>
                  <ol className="timeline">
                    <li className="tl-item">
                      <span className="tl-dot ok" aria-hidden="true" />
                      <div className="col" style={{ gap: "2px" }}>
                        <span className="t-sm fw-b">활성 · 비밀번호·인증 앱 등록</span>
                        <span className="t-xs muted">9/22(화) 10:30 KST · 파트너 관리자</span>
                      </div>
                    </li>
                    <li className="tl-item">
                      <span className="tl-dot" aria-hidden="true" />
                      <div className="col" style={{ gap: "2px" }}>
                        <span className="t-sm fw-b">초대 · (주)스텔라엔터테인먼트 소속 · 파트너 관리자(계약 때 첫 계정)</span>
                        <span className="t-xs muted">9/21(월) 16:00 KST · 민호</span>
                      </div>
                    </li>
                  </ol>
                </section>
              </div>
            </section>
          </>
        ) : null}
        {' '}
        {v.isInvited ? (
          <>
            <section className="widget" role="region" aria-labelledby="h-iv">
              <div className="widget-head">
                <h2 className="t-sm fw-b" id="h-iv">[운영자 A]</h2>
                <span className="badge badge-outline">viewer</span>
                <span className="badge badge-primary">초대됨</span>
                <span className="actions t-xs muted">op***@peaket.example</span>
              </div>
              <div className="widget-body" style={{ gap: "14px" }}>
                {v.invOk ? (
                  <>
                    <p className="row t-sm" role="status" style={{ gap: "8px", alignItems: "flex-start" }}>
                      <i className="ic ic-clock ic-16 muted" aria-hidden="true" style={{ marginTop: "2px" }} />
                      <span>초대 링크는 10/15(목) 14:00 KST까지 쓸 수 있습니다</span>
                    </p>
                  </>
                ) : null}
                {' '}
                {v.invExp ? (
                  <>
                    <p className="row t-sm tx-warning" role="status" style={{ gap: "8px", alignItems: "flex-start" }}>
                      <i className="ic ic-clock ic-16" aria-hidden="true" style={{ marginTop: "2px" }} />
                      <span>초대가 만료되었습니다</span>
                    </p>
                  </>
                ) : null}
                <dl className="kv">
                  <dt>표시 이름</dt>
                  <dd>[운영자 A]</dd>
                  <dt>역할</dt>
                  <dd>viewer</dd>
                  <dt>인증 앱</dt>
                  <dd>등록 전</dd>
                  <dt>활성 세션</dt>
                  <dd>없음</dd>
                </dl>
                <section className="col" style={{ gap: "8px" }} aria-labelledby="h-iv-op">
                  <h3 className="t-sm fw-b" id="h-iv-op">계정 작업</h3>
                  <div className="row wrap" style={{ gap: "8px" }}>
                    <button className="btn btn-outline btn-sm" type="button" {...ro('iv-re-h iv-ra-h')}>초대 다시 보내기</button>
                    {' '}
                    <button className="btn btn-danger-outline btn-sm" type="button" aria-haspopup="dialog" {...ro('iv-del-h iv-ra-h')}>
                      [운영자 A] 계정 삭제하기
                    </button>
                  </div>
                  <p className="hint">
                    <span id="iv-re-h">다시 보내면 새 링크가 가고 옛 링크는 쓸 수 없습니다.</span>
                    {' '}
                    <span id="iv-del-h">삭제하면 초대를 거둡니다. 링크가 바로 무효가 되고 이메일을 지웁니다.</span>
                    {' '}
                    <span id="iv-ra-h">두 작업 모두 직전에 다시 인증하고 패스키로 한 번 더 확인합니다.</span>
                  </p>
                </section>
                <section className="col" style={{ gap: "8px" }} aria-labelledby="h-iv-h">
                  <div className="row between">
                    <h3 className="t-sm fw-b" id="h-iv-h">권한 이력</h3>
                    <span className="t-xs muted">3년 보관</span>
                  </div>
                  <ol className="timeline">
                    {v.invExp ? (
                      <>
                        <li className="tl-item">
                          <span className="tl-dot bad" aria-hidden="true" />
                          <div className="col" style={{ gap: "2px" }}>
                            <span className="t-sm fw-b">초대 만료</span>
                            <span className="t-xs muted">10/13(화) 15:00 KST · 시스템</span>
                          </div>
                        </li>
                      </>
                    ) : null}
                    <li className="tl-item">
                      <span className="tl-dot" aria-hidden="true" />
                      <div className="col" style={{ gap: "2px" }}>
                        <span className="t-sm fw-b">초대(viewer) · 표시 이름 [운영자 A]</span>
                        <span className="t-xs muted">{v.invAt} · 수진 · 다시 인증함</span>
                      </div>
                    </li>
                  </ol>
                </section>
              </div>
            </section>
          </>
        ) : null}
        {' '}
        {v.isCmd ? (
          <>
            <section className="widget" role="region" aria-labelledby="h-cm">
              <div className="widget-head">
                <h2 className="t-sm fw-b" id="h-cm">[두 번째 commander]</h2>
                <span className="badge badge-outline">commander</span>
                <span className="badge badge-success">활성</span>
                <span className="actions t-xs muted">co***@peaket.example</span>
              </div>
              <div className="widget-body" style={{ gap: "14px" }}>
                <div className="field">
                  <label className="label" htmlFor="cm-role">역할</label>
                  <div className="row" style={{ gap: "8px" }}>
                    <div className="input-group input-group-sm grow">
                      <select id="cm-role" aria-describedby="cm-role-h" defaultValue="commander">
                        <option>viewer</option>
                        <option>operator</option>
                        <option>commander</option>
                        <option>cs_agent</option>
                        <option>cs_lead</option>
                      </select>
                      <i className="ic ic-chevron-down" aria-hidden="true" />
                    </div>
                    <button onClick={() => go?.('역할 변경 재인증')} className="btn btn-secondary" type="button" {...ro()}>역할 바꾸기</button>
                  </div>
                  <span className="hint" id="cm-role-h">commander 역할을 거두는 변경도 다른 commander의 승인(승인 업무, 2인)을 거쳐 바뀝니다.</span>
                </div>
                <section className="col" style={{ gap: "8px" }} aria-labelledby="h-cm-ss">
                  <div className="row between">
                    <h3 className="t-sm fw-b" id="h-cm-ss">활성 세션</h3>
                    <span className="t-xs muted">1개 · 최대 2개</span>
                  </div>
                  <ul className="col" style={{ gap: "6px" }}>
                    <li className="card row" style={{ gap: "10px", padding: "8px 10px" }}>
                      <i className="ic ic-globe ic-16 muted" aria-hidden="true" />
                      <div className="col grow" style={{ gap: "2px" }}>
                        <span className="t-sm fw-b">Chrome · macOS</span>
                        <span className="t-xs muted">로그인 18:10 KST · 마지막 활동 19:52 KST</span>
                      </div>
                      <button className="btn btn-danger-outline btn-sm" type="button" aria-label="[두 번째 commander]의 Chrome · macOS 세션 강제 종료">
                        강제 종료
                      </button>
                    </li>
                  </ul>
                </section>
                <section className="col" style={{ gap: "8px" }} aria-labelledby="h-cm-op">
                  <h3 className="t-sm fw-b" id="h-cm-op">계정 작업</h3>
                  <div className="row wrap" style={{ gap: "8px" }}>
                    <button className="btn btn-outline btn-sm" type="button" aria-disabled="true" aria-describedby="cm-ul">재초대로 잠금 풀기</button>
                    {' '}
                    <button className="btn btn-outline btn-sm" type="button" aria-haspopup="dialog" {...ro()}>재초대(분실)</button>
                    {' '}
                    <button className="btn btn-danger-outline btn-sm" type="button" aria-disabled="true" aria-describedby="cm-del-why">
                      [두 번째 commander] 계정 삭제하기
                    </button>
                  </div>
                  <p className="hint" id="cm-ul">이 계정은 잠기지 않았습니다.</p>
                  <p className="row t-sm" id="cm-del-why" style={{ gap: "6px", alignItems: "flex-start" }}>
                    <i className="ic ic-lock ic-16 muted" aria-hidden="true" style={{ marginTop: "2px" }} />
                    <span>commander 역할을 먼저 거두세요. 역할을 거두는 데는 다른 commander의 승인이 필요합니다</span>
                  </p>
                </section>
                <section className="col" style={{ gap: "8px" }} aria-labelledby="h-cm-h">
                  <div className="row between">
                    <h3 className="t-sm fw-b" id="h-cm-h">권한 이력</h3>
                    <span className="t-xs muted">3년 보관</span>
                  </div>
                  <ol className="timeline">
                    <li className="tl-item">
                      <span className="tl-dot info" aria-hidden="true" />
                      <div className="col" style={{ gap: "2px" }}>
                        <span className="t-sm fw-b">역할 변경 operator → commander · 승인 업무 2인 승인</span>
                        <span className="t-xs muted">9/3(목) 14:00 KST · 요청 수진</span>
                      </div>
                    </li>
                    <li className="tl-item">
                      <span className="tl-dot ok" aria-hidden="true" />
                      <div className="col" style={{ gap: "2px" }}>
                        <span className="t-sm fw-b">초대(operator) → 활성</span>
                        <span className="t-xs muted">9/2(수) 10:00 KST · 수진</span>
                      </div>
                    </li>
                  </ol>
                </section>
              </div>
            </section>
          </>
        ) : null}
        {' '}
        {v.isDel ? (
          <>
            <section className="widget" role="region" aria-labelledby="h-dl">
              <div className="widget-head">
                <h2 className="t-sm fw-b" id="h-dl">삭제된 계정</h2>
                <span className="badge badge-outline">operator</span>
                <span className="badge">삭제</span>
              </div>
              <div className="widget-body" style={{ gap: "14px" }}>
                <p className="t-sm muted">삭제할 때 업무 이메일, 표시 이름, 인증 수단을 지웠습니다. 권한 변경·말소 이력만 3년 보관합니다.</p>
                <section className="col" style={{ gap: "8px" }} aria-labelledby="h-dl-h">
                  <div className="row between">
                    <h3 className="t-sm fw-b" id="h-dl-h">권한 변경·말소 이력</h3>
                    <span className="t-xs muted">3년 보관</span>
                  </div>
                  <ol className="timeline">
                    <li className="tl-item">
                      <span className="tl-dot bad" aria-hidden="true" />
                      <div className="col" style={{ gap: "2px" }}>
                        <span className="t-sm fw-b">계정 삭제 · 권한 말소(operator) · 사유 퇴사</span>
                        <span className="t-xs muted">9/30(수) 18:20 KST · 수진 · 다시 인증함</span>
                      </div>
                    </li>
                    <li className="tl-item">
                      <span className="tl-dot info" aria-hidden="true" />
                      <div className="col" style={{ gap: "2px" }}>
                        <span className="t-sm fw-b">역할 변경 viewer → operator</span>
                        <span className="t-xs muted">8/3(월) 10:00 KST · 수진 · 다시 인증함</span>
                      </div>
                    </li>
                    <li className="tl-item">
                      <span className="tl-dot ok" aria-hidden="true" />
                      <div className="col" style={{ gap: "2px" }}>
                        <span className="t-sm fw-b">초대(viewer) → 활성</span>
                        <span className="t-xs muted">7/20(월) 09:30 KST · 수진</span>
                      </div>
                    </li>
                  </ol>
                </section>
              </div>
            </section>
          </>
        ) : null}
        {' '}
        {v.isInvite ? (
          <>
            <section className="widget" role="region" aria-labelledby="h-inv">
              <div className="widget-head"><h2 className="t-sm fw-b" id="h-inv">초대 보내기</h2></div>
              <div className="widget-body" style={{ gap: "14px" }}>
                <div className="field">
                  <label className="label" htmlFor="inv-email">업무용 이메일 (필수)</label>
                  <div className="row" style={{ gap: "8px" }}>
                    <input className="input input-sm grow" id="inv-email" type="email" inputMode="email" autoComplete="off" spellCheck="false" defaultValue="new-operator@peaket.example" aria-describedby="inv-email-r" />
                    {' '}
                    <button className="btn btn-secondary" type="button" {...ro()}>중복 확인하기</button>
                  </div>
                  <span className="hint row" id="inv-email-r" role="status" style={{ gap: "4px" }}>
                    <i className="ic ic-check-circle ic-14 tx-success" aria-hidden="true" />
                    이 이메일로 된 관리 계정이 없습니다
                  </span>
                </div>
                <div className="field">
                  <label className="label" htmlFor="inv-name">표시 이름 (필수)</label>
                  {' '}
                  <input className="input input-sm" id="inv-name" type="text" autoComplete="off" maxLength={30} defaultValue="도윤" aria-describedby="inv-name-h" />
                  {' '}
                  <span className="hint" id="inv-name-h">계정 표와 권한 이력에 보이는 이름입니다. 30자까지 쓰고, 계정을 삭제하면 바로 지웁니다.</span>
                </div>
                <div className="field">
                  <label className="label" htmlFor="inv-role">역할 (필수)</label>
                  <div className="input-group input-group-sm">
                    <select id="inv-role" aria-describedby="inv-role-h">
                      <optgroup label="운영자·CS">
                        <option>viewer</option>
                        <option>operator</option>
                        <option>cs_agent</option>
                        <option>cs_lead</option>
                      </optgroup>
                      <optgroup label="파트너 계정">
                        <option>파트너 관리자</option>
                        <option>파트너 실무자</option>
                      </optgroup>
                    </select>
                    <i className="ic ic-chevron-down" aria-hidden="true" />
                  </div>
                  <span className="hint" id="inv-role-h">
                    초대로는 commander 역할을 주지 않습니다. 다른 역할로 초대해 활성화한 뒤 역할 변경과 다른 commander의 승인(승인 업무, 2인)으로 줍니다. 파트너 계정은 소속 파트너사와 역할을 고르고, 계약 때 첫 계정은 파트너 관리자로 초대합니다.
                  </span>
                </div>
                <div className="field">
                  <label className="label" htmlFor="inv-pt">소속 파트너 (파트너 계정일 때 필수)</label>
                  <div className="input-group input-group-sm is-disabled">
                    <select id="inv-pt" disabled aria-describedby="inv-pt-h" defaultValue=""><option value="">파트너를 고르세요</option></select>
                    <i className="ic ic-chevron-down" aria-hidden="true" />
                  </div>
                  <span className="hint" id="inv-pt-h">역할에서 파트너 관리자나 파트너 실무자를 고르면 고를 수 있습니다.</span>
                </div>
                <div className="banner banner-info">
                  <i className="ic ic-mail" aria-hidden="true" />
                  <div className="banner-body">초대 링크는 24시간 동안 한 번만 쓸 수 있습니다. 받은 분이 비밀번호(15자 이상)를 만들고 인증 앱을 등록하면 활성이 됩니다.</div>
                </div>
                <p className="hint">보내기 직전에 비밀번호와 인증 앱 코드로 다시 인증하고, 등록한 패스키로 한 번 더 확인합니다.</p>
                <div className="row" style={{ gap: "8px", justifyContent: "flex-end" }}>
                  <button onClick={close} className="btn btn-outline" type="button">초대하지 않고 닫기</button>
                  {' '}
                  <button onClick={() => go?.('초대됨')} className="btn btn-primary" type="button" {...ro()}>초대 링크 보내기</button>
                </div>
              </div>
            </section>
          </>
        ) : null}
      </div>
    </div>
    </>
  );
}

export function OverlaysD({ v, close, go }: { v: V; close?: () => void; go?: (state: string) => void }) {
  void v; void close; void go;
  const ro = useRo();
  return (
    <>
    {v.isLostDlg ? (
      <>
        <Overlay placement="center" onClose={close}>
          <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="lo-t" aria-describedby="lo-d" style={{ maxWidth: "520px" }}>
            <div className="row" style={{ gap: "12px" }}>
              <span className="state-icon is-warning" style={{ width: "44px", height: "44px" }}><i className="ic ic-key" aria-hidden="true" /></span>
              <h2 className="dialog-title" id="lo-t">비밀번호·인증 앱을 잃은 계정 재초대</h2>
            </div>
            <p className="t-sm" id="lo-d">
              업무 이메일이 아닌 길(전화·대면 등)로 본인인지 확인한 뒤 재초대하세요. 재초대하면 지금 비밀번호·인증 앱·패스키·복구 코드를 모두 지우고 로그인 세션을 끝냅니다. 새 링크는 등록된 업무 이메일로만 갑니다.
            </p>
            <dl className="kv" style={{ fontSize: "13px", lineHeight: "18px", padding: "12px 14px", borderRadius: "var(--r-md)", background: "var(--surface-muted)" }}>
              <dt>계정</dt>
              <dd>[예시 파트너 A] 담당자 · ad***@partner-a.example</dd>
              <dt>지금 상태</dt>
              <dd>시간 잠금 · 10/13(화) 22:56 KST에 풀림</dd>
            </dl>
            <div className="field">
              <label className="label" htmlFor="lo-why">
                확인한 방법과 사유{' '}
                <span className="opt">(필수)</span>
              </label>
              {' '}
              <textarea className="textarea is-focus" id="lo-why" aria-describedby="lo-why-h" style={{ minHeight: "84px", fontSize: "14px", lineHeight: "21px" }} defaultValue="계약서에 적힌 대표 번호로 담당자와 통화해 휴대폰을 잃었다는 것을 확인했습니다. 인증 앱을 다시 등록해야 합니다." />
              {' '}
              <span className="hint" id="lo-why-h">[재초대합니다]를 누르면 비밀번호와 인증 앱 코드로 다시 인증하고, 등록한 패스키로 한 번 더 확인합니다.</span>
            </div>
            <div className="dialog-actions">
              <button onClick={close} className="btn btn-outline" type="button">재초대하지 않고 닫기</button>
              <button onClick={close} className="btn btn-primary" type="button" {...ro()}>재초대합니다</button>
            </div>
          </div>
        </Overlay>
      </>
    ) : null}
    {v.isReauth ? (
      <>
        <Overlay placement="center" onClose={close}>
          <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="ra-t" aria-describedby="ra-d" style={{ maxWidth: "480px" }}>
            <div className="row" style={{ gap: "12px" }}>
              <span className="state-icon is-primary" style={{ width: "44px", height: "44px" }}><i className="ic ic-shield" aria-hidden="true" /></span>
              <h2 className="dialog-title" id="ra-t">역할을 바꾸기 전에 다시 인증합니다</h2>
            </div>
            <p className="t-sm muted" id="ra-d">비밀번호와 인증 앱 코드로 다시 인증하고, 등록한 패스키로 한 번 더 확인합니다. 인증은 5분 동안 이 작업에 쓸 수 있습니다.</p>
            <dl className="kv">
              <dt>계정</dt>
              <dd>민호 · mi***@peaket.example</dd>
              <dt>역할</dt>
              <dd>operator → viewer</dd>
              <dt>기록</dt>
              <dd>권한 이력에 남기고 3년 보관</dd>
            </dl>
            <div className="field">
              <label className="label" htmlFor="ra-pw">비밀번호</label>
              {' '}
              <input className="input" id="ra-pw" type="password" autoComplete="current-password" defaultValue="sample-password-1" />
            </div>
            <div className="field">
              <label className="label" id="ra-otp-l" htmlFor="ra-otp">인증 앱 코드 6자리</label>
              {' '}
              <input className="otp-input is-focus" id="ra-otp" type="text" inputMode="numeric" autoComplete="one-time-code" maxLength={6} pattern="[0-9]*" defaultValue="481" />
            </div>
            <p className="row t-sm" style={{ gap: "8px", alignItems: "center" }}>
              <i className="ic ic-key ic-16" aria-hidden="true" />
              등록한 패스키로 한 번 더 확인합니다
            </p>
            <div className="dialog-actions">
              <button onClick={close} className="btn btn-outline" type="button">인증하지 않고 닫기</button>
              {' '}
              <button onClick={() => go?.('역할 변경 · 패스키 확인')} className="btn btn-primary" type="button" {...ro()}>인증하고 민호의 역할을 viewer로 바꿉니다</button>
            </div>
          </div>
        </Overlay>
      </>
    ) : null}
    {v.isPk ? (
      <>
        <Overlay placement="center" onClose={close}>
          <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="pk-t" aria-describedby="pk-d" style={{ maxWidth: "480px" }}>
            <nav className="stepper" aria-label="다시 인증 단계">
              <span className="step is-done">
                <span className="step-num"><i className="ic ic-check" aria-hidden="true" /></span>
                비밀번호·인증 앱 코드
              </span>
              <span className="step-line is-done" />
              <span className="step is-current" aria-current="step">
                <span className="step-num">2</span>
                패스키 확인
              </span>
            </nav>
            <h2 className="dialog-title" id="pk-t">역할을 바꾸기 전에 다시 인증합니다</h2>
            <p className="row t-sm tx-success" style={{ gap: "6px", alignItems: "flex-start" }}>
              <i className="ic ic-check-circle ic-16" aria-hidden="true" style={{ marginTop: "2px" }} />
              <span>비밀번호와 인증 앱 코드를 확인했습니다</span>
            </p>
            <dl className="kv">
              <dt>계정</dt>
              <dd>민호 · mi***@peaket.example</dd>
              <dt>역할</dt>
              <dd>operator → viewer</dd>
            </dl>
            <p className="row t-sm" id="pk-d" style={{ gap: "8px", alignItems: "center" }}>
              <i className="ic ic-key ic-16" aria-hidden="true" />
              등록한 패스키로 한 번 더 확인합니다
            </p>
            {v.pkFail ? (
              <>
                <p className="error-msg" role="alert">
                  <i className="ic ic-alert-circle" aria-hidden="true" />
                  패스키로 확인하지 못했습니다. 다시 시도해 주세요
                </p>
              </>
            ) : null}
            <p className="t-xs muted">[패스키로 확인]을 누르면 브라우저의 패스키 창이 뜹니다.</p>
            <div className="dialog-actions">
              <button onClick={close} className="btn btn-outline" type="button">인증하지 않고 닫기</button>
              {' '}
              <button onClick={close} className="btn btn-primary is-focus" type="button" {...ro()}>
                <i className="ic ic-key" aria-hidden="true" />
                패스키로 확인
              </button>
            </div>
          </div>
        </Overlay>
      </>
    ) : null}
    </>
  );
}
