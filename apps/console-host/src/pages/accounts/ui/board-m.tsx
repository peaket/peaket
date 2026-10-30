// 디자인 캔버스 보드 SCR-064-m.dc.html를 옮긴 것(dc2tsx 생성 뒤 손질)
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

export const STATES_M = ["기본", "자기 계정", "파트너 계정 탭", "파트너 계정 탭 · 시간 잠금", "마지막 관리자", "초대됨", "초대 만료", "파트너 계정 탭 · 보호 잠금(비밀번호 누계)", "commander 역할 승인 대기", "삭제한 계정"] as const;
export const DEFAULT_M = "기본";

export function valsM(state: string) {
    let st = state || '기본';
    let last = st === '마지막 관리자';
    let lost = false;
    let ptT = st === '파트너 계정 탭 · 시간 잠금' || lost;
    let ptPw = st === '파트너 계정 탭 · 보호 잠금(비밀번호 누계)';
    let ptA = st === '파트너 계정 탭' || ptT || ptPw;
    let mhPend = st === 'commander 역할 승인 대기';
    let invOk = st === '초대됨';
    let invExp = st === '초대 만료';
    let invd = invOk || invExp;
    let cmd = false;
    let del = st === '삭제한 계정';
    let pt = ptA || last;
    let self = st === '자기 계정';
    let mh = st === '기본' || mhPend;
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
      isMinho: mh,
      isSelf: self,
      rowMinho: mh ? 'is-selected' : '',
      curMinho: mh ? 'true' : 'false',
      rowSelf: self ? 'is-selected' : '',
      curSelf: self ? 'true' : 'false'
    };
  }

type V = ReturnType<typeof valsM>;

// 보드 루트: {"class": "pk dark cs cs-compact", "style": "width:360px;min-height:2700px"}

// <main class="cs-main" id="main">
export function MainM({ v, close, go }: { v: V; close?: () => void; go?: (state: string) => void }) {
  void v; void close; void go;
  const ro = useRo();
  return (
    <>
    <div className="col" style={{ gap: "4px" }}>
      <h1 className="t-lg">관리 계정·세션</h1>
      <p className="t-sm muted">운영자·CS와 파트너의 관리 계정을 초대하고 역할·지정·세션을 관리합니다. 권한 부여·변경·말소 내역은 3년 보관합니다.</p>
    </div>
    <div className="banner banner-info bigscreen" role="note">
      <i className="ic ic-monitor" aria-hidden="true" />
      <div className="banner-body">
        <span className="banner-title">초대는 태블릿이나 데스크톱에서 합니다</span>
        휴대폰에서는 볼 수만 있습니다
      </div>
      <button onClick={copyLink} className="btn btn-outline btn-sm" type="button">
        <i className="ic ic-copy" aria-hidden="true" />
        링크 복사
      </button>
    </div>
    <div className="tabs" role="tablist" aria-label="계정 종류">
      <button onClick={() => go?.('기본')} className={`tab ${v.tabOpsCls}`} type="button" role="tab" aria-selected={(v.tabOpsSel) as AriaBool} id="tab-ops" aria-controls="tp-ops" style={{ flex: "1", justifyContent: "center" }}>
        운영자·CS
        <span className="badge">9</span>
      </button>
      {' '}
      <button onClick={() => go?.('파트너 계정 탭')} className={`tab ${v.tabPtCls}`} type="button" role="tab" aria-selected={(v.tabPtSel) as AriaBool} id="tab-pt" aria-controls="tp-pt" style={{ flex: "1", justifyContent: "center" }}>
        파트너 계정
        <span className="badge">4</span>
      </button>
    </div>
    {v.isOps ? (
      <>
        <div className="col" style={{ gap: "12px" }} id="tp-ops" role="tabpanel" aria-labelledby="tab-ops">
          <section className="col" style={{ gap: "8px" }} aria-labelledby="h-ops">
            <div className="row between wrap" style={{ gap: "4px 8px" }}>
              <h2 className="t-md fw-b" id="h-ops">운영자·CS 계정 9개</h2>
              <span className="t-xs muted">이메일은 일부만 보입니다</span>
            </div>
            <ul className="col" style={{ gap: "8px" }}>
              <li>
                <Link onClick={(e) => { e.preventDefault(); go?.('자기 계정'); }} to="/accounts" className={`card col ${v.rowSelf}`} aria-current={(v.curSelf) as AriaCurrent} style={{ gap: "6px", padding: "10px 14px", color: "inherit" }}>
                  <span className="row" style={{ gap: "6px" }}>
                    <span className="t-md fw-b">수진</span>
                    <span className="badge badge-outline">본인</span>
                    <span className="grow" />
                    <span className="badge badge-outline">commander</span>
                    <span className="badge badge-success">활성</span>
                  </span>
                  {' '}
                  <span className="row between wrap t-xs" style={{ gap: "2px 12px" }}>
                    <span>su***@peaket.example</span>
                    <span>
                      <span className="muted">마지막 접속</span>
                      {' '}지금 · 이 기기
                    </span>
                  </span>
                </Link>
              </li>
              <li>
                <Link to="/accounts" className="card col" style={{ gap: "6px", padding: "10px 14px", color: "inherit" }}>
                  <span className="row" style={{ gap: "6px" }}>
                    <span className="t-md fw-b grow">[두 번째 commander]</span>
                    <span className="badge badge-outline">commander</span>
                    <span className="badge badge-success">활성</span>
                  </span>
                  {' '}
                  <span className="row between wrap t-xs" style={{ gap: "2px 12px" }}>
                    <span>co***@peaket.example</span>
                    <span>
                      <span className="muted">마지막 접속</span>
                      {' '}19:52 KST
                    </span>
                  </span>
                </Link>
              </li>
              <li>
                <Link onClick={(e) => { e.preventDefault(); go?.('기본'); }} to="/accounts" className={`card col ${v.rowMinho}`} aria-current={(v.curMinho) as AriaCurrent} style={{ gap: "6px", padding: "10px 14px", color: "inherit" }}>
                  <span className="row" style={{ gap: "6px" }}>
                    <span className="t-md fw-b grow">민호</span>
                    <span className="badge badge-outline">operator</span>
                    <span className="badge badge-success">활성</span>
                  </span>
                  {' '}
                  <span className="row between wrap t-xs" style={{ gap: "2px 12px" }}>
                    <span>mi***@peaket.example</span>
                    <span>
                      <span className="muted">마지막 접속</span>
                      {' '}19:58 KST
                    </span>
                  </span>
                </Link>
              </li>
              <li>
                <Link to="/accounts" className="card col" style={{ gap: "6px", padding: "10px 14px", color: "inherit" }}>
                  <span className="row" style={{ gap: "6px" }}>
                    <span className="t-md fw-b grow">서연</span>
                    <span className="badge badge-outline">viewer</span>
                    <span className="badge badge-success">활성</span>
                  </span>
                  {' '}
                  <span className="row between wrap t-xs" style={{ gap: "2px 12px" }}>
                    <span>se***@peaket.example</span>
                    <span>
                      <span className="muted">마지막 접속</span>
                      {' '}19:40 KST
                    </span>
                  </span>
                </Link>
              </li>
              <li>
                <Link to="/accounts" className="card col" style={{ gap: "6px", padding: "10px 14px", color: "inherit" }}>
                  <span className="row" style={{ gap: "6px" }}>
                    <span className="t-md fw-b grow">다은</span>
                    <span className="badge badge-outline">cs_agent</span>
                    <span className="badge badge-success">활성</span>
                  </span>
                  {' '}
                  <span className="row between wrap t-xs" style={{ gap: "2px 12px" }}>
                    <span>da***@peaket.example</span>
                    <span>
                      <span className="muted">마지막 접속</span>
                      {' '}18:12 KST
                    </span>
                  </span>
                </Link>
              </li>
              <li>
                <Link to="/accounts" className="card col" style={{ gap: "6px", padding: "10px 14px", color: "inherit" }}>
                  <span className="row" style={{ gap: "6px" }}>
                    <span className="t-md fw-b grow">준</span>
                    <span className="badge badge-outline">cs_lead</span>
                    <span className="badge badge-success">활성</span>
                  </span>
                  {' '}
                  <span className="row between wrap t-xs" style={{ gap: "2px 12px" }}>
                    <span>ju***@peaket.example</span>
                    <span>
                      <span className="muted">마지막 접속</span>
                      {' '}17:55 KST
                    </span>
                  </span>
                </Link>
              </li>
              <li>
                <Link onClick={(e) => { e.preventDefault(); go?.('초대됨'); }} to="/accounts" className={`card col ${v.rowInv}`} aria-current={(v.curInv) as AriaCurrent} style={{ gap: "6px", padding: "10px 14px", color: "inherit" }}>
                  <span className="row" style={{ gap: "6px" }}>
                    <span className="t-md fw-b grow">[운영자 A]</span>
                    <span className="badge badge-outline">viewer</span>
                    <span className="badge badge-primary">초대됨</span>
                  </span>
                  {' '}
                  <span className="row between wrap t-xs" style={{ gap: "2px 12px" }}>
                    <span>op***@peaket.example</span>
                    <span>
                      <span className="muted">마지막 접속</span>
                      {' '}—
                    </span>
                  </span>
                </Link>
              </li>
              <li>
                <Link to="/accounts" className="card col" style={{ gap: "6px", padding: "10px 14px", color: "inherit" }}>
                  <span className="row" style={{ gap: "6px" }}>
                    <span className="t-md fw-b grow">[CS 담당자 B]</span>
                    <span className="badge badge-outline">cs_agent</span>
                    <span className="badge badge-danger">잠김</span>
                  </span>
                  {' '}
                  <span className="row between wrap t-xs" style={{ gap: "2px 12px" }}>
                    <span>cs***@peaket.example</span>
                    <span>
                      <span className="muted">마지막 접속</span>
                      {' '}10/13(화) 09:12 KST
                    </span>
                  </span>
                </Link>
              </li>
              <li>
                <Link onClick={(e) => { e.preventDefault(); go?.('삭제한 계정'); }} to="/accounts" className={`card col ${v.rowDel}`} aria-current={(v.curDel) as AriaCurrent} style={{ gap: "6px", padding: "10px 14px", color: "inherit" }}>
                  <span className="row" style={{ gap: "6px" }}>
                    <span className="t-md fw-b grow muted">삭제된 계정</span>
                    <span className="badge badge-outline">operator</span>
                    <span className="badge">삭제</span>
                  </span>
                  {' '}
                  <span className="row between wrap t-xs" style={{ gap: "2px 12px" }}>
                    <span>—</span>
                    <span>
                      <span className="muted">마지막 접속</span>
                      {' '}9/30(수) 18:00 KST
                    </span>
                  </span>
                </Link>
              </li>
            </ul>
            <p className="t-xs muted">초대됨은 비밀번호와 인증 앱을 등록하면 활성이 됩니다. 보호 잠금은 재초대로만 풀립니다. 시간 잠금은 본인이 이메일 링크로 풉니다. 삭제한 계정의 권한 말소 내역은 3년 보관합니다.</p>
          </section>
          {v.isMinho ? (
            <>
              <div className="col" style={{ gap: "6px" }}>
                <p className="eyebrow">선택한 계정</p>
                <section className="widget" role="region" aria-labelledby="h-mh">
                  <div className="widget-head">
                    <h2 className="t-sm fw-b" id="h-mh">민호</h2>
                    <span className="badge badge-outline">operator</span>
                    <span className="badge badge-success">활성</span>
                  </div>
                  <div className="widget-body" style={{ gap: "14px" }}>
                    <dl className="kv">
                      <dt>이메일</dt>
                      <dd>mi***@peaket.example</dd>
                      <dt>역할</dt>
                      <dd>
                        operator
                        {v.mhPend ? (
                          <>
                            <span className="badge badge-warning">commander 변경 승인 대기</span>
                          </>
                        ) : null}
                      </dd>
                      <dt>인증 앱</dt>
                      <dd>등록됨</dd>
                    </dl>
                    {v.mhPend ? (
                      <>
                        <p className="hint" role="status">다른 commander가 승인 업무에서 승인하면 바뀝니다</p>
                      </>
                    ) : null}
                    <section className="col" style={{ gap: "8px" }} aria-labelledby="h-mh-ss">
                      <div className="row between">
                        <h3 className="t-sm fw-b" id="h-mh-ss">활성 세션</h3>
                        <span className="t-xs muted">2개 · 최대 2개</span>
                      </div>
                      <ul className="col" style={{ gap: "8px" }}>
                        <li className="card col" style={{ gap: "10px", padding: "12px" }}>
                          <div className="row" style={{ gap: "10px", alignItems: "flex-start" }}>
                            <i className="ic ic-globe ic-16 muted" aria-hidden="true" />
                            <div className="col grow" style={{ gap: "2px" }}>
                              <span className="t-sm fw-b">Chrome · Windows</span>
                              <span className="t-xs muted">로그인 19:31 KST · 마지막 활동 19:58 KST</span>
                            </div>
                          </div>
                          <button className="btn btn-danger-outline btn-lg btn-block" type="button" aria-label="민호의 Chrome · Windows 세션 강제 종료">
                            강제 종료
                          </button>
                        </li>
                        <li className="card col" style={{ gap: "10px", padding: "12px" }}>
                          <div className="row" style={{ gap: "10px", alignItems: "flex-start" }}>
                            <i className="ic ic-globe ic-16 muted" aria-hidden="true" />
                            <div className="col grow" style={{ gap: "2px" }}>
                              <span className="t-sm fw-b">Edge · Windows</span>
                              <span className="t-xs muted">로그인 19:02 KST · 마지막 활동 19:47 KST</span>
                            </div>
                          </div>
                          <button className="btn btn-danger-outline btn-lg btn-block" type="button" aria-label="민호의 Edge · Windows 세션 강제 종료">
                            강제 종료
                          </button>
                        </li>
                      </ul>
                      <p className="hint">강제 종료하면 그 기기에 "보안을 위해 운영자가 로그아웃시켰습니다. 다시 로그인해 주세요"가 보입니다.</p>
                    </section>
                    <div className="banner banner-info bigscreen" role="note">
                      <i className="ic ic-monitor" aria-hidden="true" />
                      <div className="banner-body">
                        <span className="banner-title">역할 변경·지정·잠금 해제·삭제는 태블릿이나 데스크톱에서 합니다</span>
                        휴대폰에서는 볼 수만 있습니다
                      </div>
                      <button onClick={copyLink} className="btn btn-outline btn-sm" type="button">
                        <i className="ic ic-copy" aria-hidden="true" />
                        링크 복사
                      </button>
                    </div>
                    <section className="col" style={{ gap: "8px" }} aria-labelledby="h-mh-dg">
                      <h3 className="t-sm fw-b" id="h-mh-dg">지정</h3>
                      <dl className="kv">
                        <dt>접속기록 점검자</dt>
                        <dd>지정 안 됨</dd>
                        <dt>가명정보 취급자</dt>
                        <dd>지정 안 됨</dd>
                      </dl>
                      <p className="hint">접속기록 점검자는 commander 가운데에서 지정합니다.</p>
                    </section>
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
              </div>
            </>
          ) : null}
          {' '}
          {v.isInvited ? (
            <>
              <div className="col" style={{ gap: "6px" }}>
                <p className="eyebrow">선택한 계정</p>
                <section className="widget" role="region" aria-labelledby="h-iv">
                  <div className="widget-head">
                    <h2 className="t-sm fw-b" id="h-iv">[운영자 A]</h2>
                    <span className="badge badge-outline">viewer</span>
                    <span className="badge badge-primary">초대됨</span>
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
                      <dt>이메일</dt>
                      <dd>op***@peaket.example</dd>
                      <dt>표시 이름</dt>
                      <dd>[운영자 A]</dd>
                      <dt>역할</dt>
                      <dd>viewer</dd>
                      <dt>인증 앱</dt>
                      <dd>등록 전</dd>
                    </dl>
                    <div className="banner banner-info bigscreen" role="note">
                      <i className="ic ic-monitor" aria-hidden="true" />
                      <div className="banner-body">
                        <span className="banner-title">초대 다시 보내기와 계정 삭제는 태블릿이나 데스크톱에서 합니다</span>
                        휴대폰에서는 볼 수만 있습니다
                      </div>
                      <button onClick={copyLink} className="btn btn-outline btn-sm" type="button">
                        <i className="ic ic-copy" aria-hidden="true" />
                        링크 복사
                      </button>
                    </div>
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
              </div>
            </>
          ) : null}
          {' '}
          {v.isDel ? (
            <>
              <div className="col" style={{ gap: "6px" }}>
                <p className="eyebrow">선택한 계정</p>
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
              </div>
            </>
          ) : null}
          {' '}
          {v.isSelf ? (
            <>
              <div className="col" style={{ gap: "6px" }}>
                <p className="eyebrow">선택한 계정</p>
                <section className="widget" role="region" aria-labelledby="h-sj">
                  <div className="widget-head">
                    <h2 className="t-sm fw-b" id="h-sj">수진</h2>
                    <span className="badge badge-outline">본인</span>
                    <span className="badge badge-outline">commander</span>
                    <span className="badge badge-success">활성</span>
                  </div>
                  <div className="widget-body" style={{ gap: "14px" }}>
                    <div className="banner banner-info">
                      <i className="ic ic-lock" aria-hidden="true" />
                      <div className="banner-body">
                        <span className="banner-title">자기 권한은 바꿀 수 없습니다</span>
                        내 역할·지정 변경과 계정 삭제는 다른 commander가 합니다.
                      </div>
                    </div>
                    <dl className="kv">
                      <dt>이메일</dt>
                      <dd>su***@peaket.example</dd>
                      <dt>역할</dt>
                      <dd>commander</dd>
                      <dt>인증 앱</dt>
                      <dd>등록됨</dd>
                    </dl>
                    <section className="col" style={{ gap: "8px" }} aria-labelledby="h-sj-ss">
                      <div className="row between">
                        <h3 className="t-sm fw-b" id="h-sj-ss">활성 세션</h3>
                        <span className="t-xs muted">2개 · 최대 2개</span>
                      </div>
                      <ul className="col" style={{ gap: "8px" }}>
                        <li className="card row" style={{ gap: "10px", padding: "10px 12px", alignItems: "flex-start" }}>
                          <i className="ic ic-globe ic-16 muted" aria-hidden="true" />
                          <div className="col grow" style={{ gap: "2px" }}>
                            <span className="t-sm fw-b">Chrome · Windows</span>
                            <span className="t-xs muted">로그인 18:40 KST · 마지막 활동 20:04 KST</span>
                          </div>
                          <span className="badge badge-primary">지금 이 기기</span>
                        </li>
                        <li className="card row" style={{ gap: "10px", padding: "10px 12px", alignItems: "flex-start" }}>
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
                    <section className="col" style={{ gap: "8px" }} aria-labelledby="h-sj-dg">
                      <h3 className="t-sm fw-b" id="h-sj-dg">지정</h3>
                      <dl className="kv">
                        <dt>접속기록 점검자</dt>
                        <dd>지정됨</dd>
                        <dt>가명정보 취급자</dt>
                        <dd>지정 안 됨</dd>
                      </dl>
                      <p className="hint">접속기록 점검자 지정 10/1(목) · 근거 [개인정보 보호책임자 지정 근거]. 내 접속기록은 다른 commander가 점검합니다.</p>
                    </section>
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
              </div>
            </>
          ) : null}
        </div>
      </>
    ) : null}
    {' '}
    {v.isPt ? (
      <>
        <div className="col" style={{ gap: "12px" }} id="tp-pt" role="tabpanel" aria-labelledby="tab-pt">
          <section className="col" style={{ gap: "8px" }} aria-labelledby="h-pts">
            <div className="row between wrap" style={{ gap: "4px 8px" }}>
              <h2 className="t-md fw-b" id="h-pts">파트너 계정 4개</h2>
              <span className="t-xs muted">파트너 계정은 소속 파트너 하나에 묶입니다</span>
            </div>
            <ul className="col" style={{ gap: "8px" }}>
              <li>
                <Link onClick={(e) => { e.preventDefault(); go?.('마지막 관리자'); }} to="/partners" className={`card col ${v.rowStAdm}`} aria-current={(v.curStAdm) as AriaCurrent} style={{ gap: "6px", padding: "10px 14px", color: "inherit" }}>
                  <span className="row" style={{ gap: "6px" }}>
                    <span className="t-md fw-b grow">파트너 관리자</span>
                    <span className="badge badge-success">활성</span>
                  </span>
                  {' '}
                  <span className="t-sm">(주)스텔라엔터테인먼트 · 파트너 관리자</span>
                  {' '}
                  <span className="row between wrap t-xs" style={{ gap: "2px 12px" }}>
                    <span>op***@stella.example</span>
                    <span>
                      <span className="muted">마지막 접속</span>
                      {' '}19:20 KST
                    </span>
                  </span>
                </Link>
              </li>
              <li>
                <Link to="/partners" className="card col" style={{ gap: "6px", padding: "10px 14px", color: "inherit" }}>
                  <span className="row" style={{ gap: "6px" }}>
                    <span className="t-md fw-b grow">파트너 실무자</span>
                    <span className="badge badge-success">활성</span>
                  </span>
                  {' '}
                  <span className="t-sm">(주)스텔라엔터테인먼트 · 파트너 실무자</span>
                  {' '}
                  <span className="row between wrap t-xs" style={{ gap: "2px 12px" }}>
                    <span>tk***@stella.example</span>
                    <span>
                      <span className="muted">마지막 접속</span>
                      {' '}18:05 KST
                    </span>
                  </span>
                </Link>
              </li>
              <li>
                <Link onClick={(e) => { e.preventDefault(); go?.('파트너 계정 탭'); }} to="/partners" className={`card col ${v.rowPtA}`} aria-current={(v.curPtA) as AriaCurrent} style={{ gap: "6px", padding: "10px 14px", color: "inherit" }}>
                  <span className="row" style={{ gap: "6px" }}>
                    <span className="t-md fw-b grow">[예시 파트너 A] 담당자</span>
                    <span className="badge badge-danger">잠김</span>
                  </span>
                  {' '}
                  <span className="t-sm">[예시 파트너 A] · 파트너 관리자</span>
                  {' '}
                  <span className="row between wrap t-xs" style={{ gap: "2px 12px" }}>
                    <span>ad***@partner-a.example</span>
                    <span>
                      <span className="muted">마지막 접속</span>
                      {' '}10/13(화) 22:41 KST
                    </span>
                  </span>
                </Link>
              </li>
              <li>
                <Link to="/partners" className="card col" style={{ gap: "6px", padding: "10px 14px", color: "inherit" }}>
                  <span className="row" style={{ gap: "6px" }}>
                    <span className="t-md fw-b grow">[예시 파트너 B] 담당자</span>
                    <span className="badge badge-primary">초대됨</span>
                  </span>
                  {' '}
                  <span className="t-sm">[예시 파트너 B] · 파트너 관리자</span>
                  {' '}
                  <span className="row between wrap t-xs" style={{ gap: "2px 12px" }}>
                    <span>ad***@partner-b.example</span>
                    <span>
                      <span className="muted">마지막 접속</span>
                      {' '}—
                    </span>
                  </span>
                </Link>
              </li>
            </ul>
            <p className="t-xs muted">파트너 계정의 초대와 잠금 해제는 operator 이상이 합니다. 보호 잠금은 재초대로만 풀립니다. 시간 잠금은 본인이 이메일 링크로 풉니다. 파트너사마다 파트너 관리자가 1명 이상 있어야 합니다.</p>
          </section>
          {v.isPtA ? (
            <>
              <div className="col" style={{ gap: "6px" }}>
                <p className="eyebrow">선택한 계정</p>
                <section className="widget" role="region" aria-labelledby="h-pa">
                  <div className="widget-head">
                    <h2 className="t-sm fw-b" id="h-pa">[예시 파트너 A] 담당자</h2>
                    <span className="badge badge-outline">파트너</span>
                    <span className="badge badge-danger">잠김</span>
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
                    <div className="col" style={{ gap: "8px" }}>
                      <dl className="kv">
                        <dt>이메일</dt>
                        <dd>ad***@partner-a.example</dd>
                        <dt>소속 파트너</dt>
                        <dd>[예시 파트너 A]</dd>
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
                      <p className="hint">파트너 계정은 소속 파트너 하나에 묶여 다른 파트너로 옮길 수 없습니다.</p>
                    </div>
                    <section className="col" style={{ gap: "8px" }} aria-labelledby="h-pa-ul">
                      <h3 className="t-sm fw-b" id="h-pa-ul">잠금 해제</h3>
                      <p className="t-sm">
                        보호 잠금은 재초대로만 풀립니다. 시간 잠금은 본인이 이메일 링크로 풉니다. 재초대하면 등록 이메일로 24시간 동안 한 번만 쓰는 링크를 보내고, 받은 분이 비밀번호와 인증 앱을 다시 등록하면 활성이 됩니다.
                      </p>
                      {v.lkProt ? (
                        <>
                          <div className="banner banner-info bigscreen" role="note">
                            <i className="ic ic-monitor" aria-hidden="true" />
                            <div className="banner-body">
                              <span className="banner-title">잠금 해제(재초대)는 태블릿이나 데스크톱에서 합니다</span>
                              휴대폰에서는 볼 수만 있습니다
                            </div>
                            <button onClick={copyLink} className="btn btn-outline btn-sm" type="button">
                              <i className="ic ic-copy" aria-hidden="true" />
                              링크 복사
                            </button>
                          </div>
                        </>
                      ) : null}
                      {' '}
                      {v.lkTime ? (
                        <>
                          <p className="t-xs muted">시간 잠금은 재초대로 풀지 않습니다. 인증 수단을 잃은 경우에만 [재초대(분실)]를 씁니다. 재초대(분실)은 태블릿이나 데스크톱에서 합니다.</p>
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
              </div>
            </>
          ) : null}
          {' '}
          {v.isLast ? (
            <>
              <div className="col" style={{ gap: "6px" }}>
                <p className="eyebrow">선택한 계정</p>
                <section className="widget" role="region" aria-labelledby="h-la">
                  <div className="widget-head">
                    <h2 className="t-sm fw-b" id="h-la">파트너 관리자</h2>
                    <span className="badge badge-outline">파트너</span>
                    <span className="badge badge-success">활성</span>
                  </div>
                  <div className="widget-body" style={{ gap: "14px" }}>
                    <div className="banner banner-info" role="status">
                      <i className="ic ic-lock" aria-hidden="true" />
                      <div className="banner-body">
                        <span className="banner-title">파트너사마다 파트너 관리자가 1명 이상 있어야 합니다</span>
                        (주)스텔라엔터테인먼트의 활성 파트너 관리자는 이 계정 1명이라 역할 변경과 계정 삭제를 할 수 없습니다.
                      </div>
                    </div>
                    <div className="col" style={{ gap: "8px" }}>
                      <dl className="kv">
                        <dt>이메일</dt>
                        <dd>op***@stella.example</dd>
                        <dt>소속 파트너</dt>
                        <dd>(주)스텔라엔터테인먼트</dd>
                        <dt>역할</dt>
                        <dd>파트너 관리자</dd>
                        <dt>인증 앱</dt>
                        <dd>등록됨</dd>
                      </dl>
                      <p className="hint">파트너 계정은 소속 파트너 하나에 묶여 다른 파트너로 옮길 수 없습니다.</p>
                    </div>
                    <section className="col" style={{ gap: "8px" }} aria-labelledby="h-la-ss">
                      <div className="row between">
                        <h3 className="t-sm fw-b" id="h-la-ss">활성 세션</h3>
                        <span className="t-xs muted">1개 · 최대 2개</span>
                      </div>
                      <ul className="col" style={{ gap: "6px" }}>
                        <li className="card col" style={{ gap: "8px", padding: "10px 12px" }}>
                          <div className="row" style={{ gap: "10px" }}>
                            <i className="ic ic-globe ic-16 muted" aria-hidden="true" />
                            <div className="col grow" style={{ gap: "2px" }}>
                              <span className="t-sm fw-b">Chrome · macOS</span>
                              <span className="t-xs muted">로그인 18:52 KST · 마지막 활동 19:20 KST</span>
                            </div>
                          </div>
                          <button className="btn btn-danger-outline btn-sm" type="button" style={{ alignSelf: "flex-start", marginLeft: "26px" }} aria-label="파트너 관리자의 Chrome · macOS 세션 강제 종료">
                            강제 종료
                          </button>
                        </li>
                      </ul>
                    </section>
                    <div className="banner banner-info bigscreen" role="note">
                      <i className="ic ic-monitor" aria-hidden="true" />
                      <div className="banner-body">
                        <span className="banner-title">역할 변경과 계정 삭제는 태블릿이나 데스크톱에서 합니다</span>
                        휴대폰에서는 볼 수만 있습니다
                      </div>
                      <button onClick={copyLink} className="btn btn-outline btn-sm" type="button">
                        <i className="ic ic-copy" aria-hidden="true" />
                        링크 복사
                      </button>
                    </div>
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
              </div>
            </>
          ) : null}
        </div>
      </>
    ) : null}
    </>
  );
}

