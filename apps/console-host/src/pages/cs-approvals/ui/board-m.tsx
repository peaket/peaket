// 디자인 캔버스 보드 SCR-046-m.dc.html를 옮긴 것(dc2tsx 생성 뒤 손질)
/* eslint-disable */
import { Fragment, type FormEvent } from 'react';
import { Link } from 'react-router';
import { Overlay } from '@/shared/ui/Overlay';
import { useRo } from '@/features/screen-access';
import { copyLink } from '@/shared/lib/clipboard';
import { fraudVariant } from '../states';
import { fraudListVals } from '../model/fraud-approval';
import { FraudActionPanel, FraudAllCount, FraudListItem } from './FraudActionPanel';

const prevent = (e: FormEvent) => e.preventDefault();
void Fragment;
void Link;

type AriaBool = boolean | 'true' | 'false';
type AriaCurrent = boolean | 'true' | 'false' | 'page' | 'step' | 'location' | 'date' | 'time';

export const STATES_M = ["승인 대기", "요청자 본인", "실행 직전 재인증", "실행 직전 재인증 — commander", "재인증 · 패스키 확인", "재인증 · 패스키 확인 실패", "실행 실패", "권한 밖 승인"] as const;
export const DEFAULT_M = "승인 대기";

export function valsM(state: string) {
    let st = state || '승인 대기';
    let own = st === '요청자 본인';
    let fail = st === '실행 실패';
    let deny = st === '권한 밖 승인';
    let cmdRa = st === '실행 직전 재인증 — commander';
    let pk = st === '재인증 · 패스키 확인' || st === '재인증 · 패스키 확인 실패';
    let cmd = cmdRa || pk;
    let form = false;
    let f409 = false;
    let showB = own || cmd;
    // 부정 예매 조치(보드에 없는 변형): 공용 패널 하나가 그리고, 요청 목록 머리는 그 상태의 사람 글이다
    let fv = fraudVariant(st);
    let fl = fv ? fraudListVals(fv) : null;
    let offA = own || fail || deny || cmd || form || !!fv;
    return {
      showA: !offA,
      showB: showB,
      showD: fail,
      showE: deny,
      showF: form,
      showFraud: fv,
      fraudKinds: fl ? fl.kinds : '',
      is409: f409,
      notF409: !f409,
      fIdCls: f409 ? 'is-error' : '',
      fIdBad: f409 ? 'true' : 'false',
      fIdDesc: f409 ? 'f-id-e f-id-h' : 'f-id-h',
      isFail: fail,
      notFail: !fail,
      selD: fail ? 'is-selected' : '',
      curD: fail ? 'true' : 'false',
      showReauth: st === '실행 직전 재인증' || cmdRa,
      showPk: pk,
      pkFail: st === '재인증 · 패스키 확인 실패',
      asLead: !cmd && !fl,
      asCmd: cmd,
      nMine: fl ? fl.nMine : cmd ? '1' : '2',
      nReq: fl ? fl.nReq : cmd ? '0' : '1',
      reqB: cmd || fl ? '준' : '준(나)',
      reqBLong: cmd || fl ? '준(cs_lead)' : '준(cs_lead, 나)',
      selA: offA ? '' : 'is-selected',
      selB: showB ? 'is-selected' : '',
      curA: offA ? 'false' : 'true',
      curB: showB ? 'true' : 'false'
    };
  }

type V = ReturnType<typeof valsM>;

// 보드 루트: {"class": "pk dark cs cs-compact", "style": "width:360px;min-height:3560px"}

// <main class="cs-main" id="main">
export function MainM({ v, close, go }: { v: V; close?: () => void; go?: (state: string) => void }) {
  void v; void close; void go;
  const ro = useRo();
  return (
    <>
    <div className="page-head" style={{ flexDirection: "column", alignItems: "stretch", gap: "10px" }}>
      <div className="col" style={{ gap: "4px" }}>
        <h1>승인 업무</h1>
        <p className="t-sm muted">정책 밖으로 돈이나 티켓 소유권이 움직이는 요청을 승인합니다. 요청자와 승인자는 서버가 나누고, 필요한 승인 인원도 서버가 정합니다.</p>
      </div>
      <div className="row wrap" style={{ gap: "6px" }}>
        <span className="badge badge-lg badge-warning">내 승인 대기 {v.nMine}</span>
        <span className="badge badge-lg">상위 승인자 알림 1</span>
      </div>
    </div>
    <section className="widget" aria-labelledby="rq-h">
      <div className="widget-head">
        <h2 className="t-sm fw-b" id="rq-h">요청 목록</h2>
        <div className="actions">
          <button className="icon-btn icon-btn-sm" type="button" aria-label="요청 목록 필터"><i className="ic ic-filter" aria-hidden="true" /></button>
        </div>
      </div>
      <div className="widget-body" style={{ gap: "12px" }}>
        <div className="banner banner-info bigscreen" role="note">
          <i className="ic ic-monitor" aria-hidden="true" />
          <div className="banner-body">
            <span className="banner-title">새 요청 만들기는 태블릿이나 데스크톱에서 합니다</span>
            휴대폰에서는 요청 보기와 승인·반려를 합니다
          </div>
          <button onClick={copyLink} className="btn btn-outline btn-sm" type="button">
            <i className="ic ic-copy" aria-hidden="true" />
            링크 복사
          </button>
        </div>
        {v.asLead ? (
          <>
            <p className="t-xs muted">준(CS 책임자)이 요청할 수 있는 종류: 양도 회수, 정산서 수기 조정</p>
          </>
        ) : null}
        {v.asCmd ? (
          <>
            <p className="t-xs muted">수진(commander)이 요청할 수 있는 종류: commander 역할 부여·회수</p>
          </>
        ) : null}
        {v.fraudKinds ? <p className="t-xs muted">{v.fraudKinds}</p> : null}
        <div className="tabs tabs-sm tabs-scroll" role="tablist" aria-label="요청 보기">
          <button className="tab is-active" type="button" role="tab" aria-selected="true">
            전체{' '}
            <FraudAllCount variant={v.showFraud} />
          </button>
          {' '}
          <button className="tab" type="button" role="tab" aria-selected="false">
            내 승인 대기{' '}
            <span className="badge">{v.nMine}</span>
          </button>
          {' '}
          <button className="tab" type="button" role="tab" aria-selected="false">
            내 요청{' '}
            <span className="badge">{v.nReq}</span>
          </button>
        </div>
        <ul className="col" style={{ gap: "8px" }} aria-label="승인 요청">
          <li>
            <Link onClick={(e) => { e.preventDefault(); go?.('승인 대기'); }} to="/cs/approvals" className={`card ${v.selA}`} aria-current={(v.curA) as AriaCurrent} style={{ display: "flex", flexDirection: "column", gap: "6px", padding: "12px 14px", color: "inherit" }}>
              <span className="row between" style={{ gap: "6px" }}>
                <span className="t-sm fw-b">재량 면제</span>
                <span className="badge badge-warning">승인 대기 0/2</span>
              </span>
              {' '}
              <span className="t-xs muted">주문 2026101400271 · 주문 금액 ₩308,000 · 면제분 ₩61,600</span>
              {' '}
              <span className="row between" style={{ gap: "6px" }}>
                <span className="t-xs muted">요청 다은 · 10/19(월) 15:42 KST</span>
                <span className="badge badge-warning">
                  <span className="sr-only">승인 기한</span>
                  1영업일 남음
                </span>
              </span>
            </Link>
          </li>
          <li>
            <Link to="/cs/approvals" className="card" aria-current="false" style={{ display: "flex", flexDirection: "column", gap: "6px", padding: "12px 14px", color: "inherit" }}>
              <span className="row between" style={{ gap: "6px" }}>
                <span className="t-sm fw-b">시스템 잘못 환불</span>
                <span className="badge badge-warning">
                  <i className="ic ic-bell" aria-hidden="true" />
                  상위 승인자 알림
                </span>
              </span>
              {' '}
              <span className="t-xs muted">결제 상태 불명 사후 확정 · 주문 2026101400590 · ₩264,000</span>
              {' '}
              <span className="row between" style={{ gap: "6px" }}>
                <span className="t-xs muted">요청 다은 · 10/15(목) 16:20 KST</span>
                <span className="badge badge-danger">
                  <span className="sr-only">승인 기한</span>
                  1영업일 초과
                </span>
              </span>
            </Link>
          </li>
          <li>
            <Link onClick={(e) => { e.preventDefault(); go?.('요청자 본인'); }} to="/cs/approvals" className={`card ${v.selB}`} aria-current={(v.curB) as AriaCurrent} style={{ display: "flex", flexDirection: "column", gap: "6px", padding: "12px 14px", color: "inherit" }}>
              <span className="row between" style={{ gap: "6px" }}>
                <span className="t-sm fw-b">양도 회수</span>
                <span className="badge badge-warning">commander 승인 대기</span>
              </span>
              {' '}
              <span className="t-xs muted">티켓 T-39914-02 · LUMEN 10/25(일) 18:00 · R석 1매</span>
              {' '}
              <span className="row between" style={{ gap: "6px" }}>
                <span className="t-xs muted">요청 {v.reqB} · 10/19(월) 10:20 KST</span>
                <span className="badge badge-warning">
                  <span className="sr-only">승인 기한</span>
                  1영업일 남음
                </span>
              </span>
            </Link>
          </li>
          <li>
            <Link onClick={(e) => { e.preventDefault(); go?.('실행 실패'); }} to="/cs/approvals" className={`card ${v.selD}`} aria-current={(v.curD) as AriaCurrent} style={{ display: "flex", flexDirection: "column", gap: "6px", padding: "12px 14px", color: "inherit" }}>
              <span className="row between" style={{ gap: "6px" }}>
                <span className="t-sm fw-b">시스템 잘못 환불</span>
                {v.notFail ? (
                  <>
                    <span className="badge badge-success">
                      <i className="ic ic-check" aria-hidden="true" />
                      완료
                    </span>
                  </>
                ) : null}
                {v.isFail ? (
                  <>
                    <span className="badge badge-danger">
                      <i className="ic ic-alert-circle" aria-hidden="true" />
                      실행 실패
                    </span>
                  </>
                ) : null}
              </span>
              {' '}
              <span className="t-xs muted">중복 결제 · 주문 2026101400530 · ₩132,000</span>
              {' '}
              {v.notFail ? (
                <>
                  <span className="t-xs muted">요청 다은 · 승인 준 · 환급 완료 10/16(금)</span>
                </>
              ) : null}
              {' '}
              {v.isFail ? (
                <>
                  <span className="row between" style={{ gap: "6px" }}>
                    <span className="t-xs muted">요청 다은 · 승인 준(나) · 10/16(금)</span>
                    <span className="badge badge-warning">
                      <span className="sr-only">처리 기한</span>
                      10/21(수)까지
                    </span>
                  </span>
                </>
              ) : null}
            </Link>
          </li>
          <FraudListItem variant={v.showFraud} go={go} />
        </ul>
        <p className="t-xs muted">1영업일 동안 응답이 없으면 상위 승인자에게 알립니다. 실패한 실행은 CS 처리함 건으로 넘어갑니다.</p>
      </div>
    </section>
    <p className="eyebrow" style={{ marginTop: "4px" }}>선택한 항목</p>
    <section className="col" aria-label="승인 패널" style={{ gap: "12px" }}>
      {v.showFraud ? <FraudActionPanel variant={v.showFraud} go={go} /> : null}
      {v.showA ? (
        <>
          <div className="col" style={{ gap: "12px" }}>
            <section className="widget" aria-labelledby="a-h">
              <div className="widget-head" style={{ flexDirection: "column", alignItems: "stretch", gap: "6px", padding: "12px 14px" }}>
                <span className="row wrap" style={{ gap: "6px" }}>
                  <span className="badge badge-warning">승인 대기 0/2</span>
                  <span className="badge badge-outline">2인 승인</span>
                </span>
                <h2 className="t-md fw-b" id="a-h">재량 면제 · 주문 2026101400271</h2>
              </div>
              <div className="widget-body" style={{ gap: "20px" }}>
                <div className="col" style={{ gap: "6px" }}>
                  <span className="t-sm">요청 다은(cs_agent) · 10/19(월) 15:42 KST</span>
                  {' '}
                  <span className="row wrap" style={{ gap: "6px" }}>
                    <span className="t-sm">승인 기한 10/20(화) 15:42 KST</span>
                    <span className="badge badge-warning">
                      <i className="ic ic-clock" aria-hidden="true" />
                      <span className="sr-only">승인 기한</span>
                      1영업일 남음
                    </span>
                  </span>
                </div>
                <section className="col" style={{ gap: "8px" }} aria-labelledby="a-req">
                  <h3 className="eyebrow" id="a-req">요청 내용</h3>
                  <dl className="kv">
                    <dt>종류</dt>
                    <dd>재량 면제(정책 밖 공제 면제)</dd>
                    <dt>사유</dt>
                    <dd>질병(입원)</dd>
                    <dt>대상</dt>
                    <dd>
                      <span className="mono">2026101400271</span>
                      {' '}· R석 2매
                    </dd>
                    <dt>공연</dt>
                    <dd>LUMEN 콘서트 2026 서울 · 10/25(일) 18:00</dd>
                    <dt>결제</dt>
                    <dd>₩308,000 · 토스페이먼츠</dd>
                    <dt>취소</dt>
                    <dd>10/19(월) 11:05 KST · 관람 6일 전 · 공제 20%</dd>
                  </dl>
                  <p className="card-flat pad t-sm">"결제자가 10/18에 입원해 관람할 수 없다는 문의입니다. 공제분 면제를 요청합니다." · 다은</p>
                </section>
                <section className="col" style={{ gap: "8px" }} aria-labelledby="a-amt">
                  <h3 className="eyebrow" id="a-amt">금액</h3>
                  <div className="col" style={{ gap: "8px" }}>
                    <div className="stat">
                      <span className="stat-label">기본 환불 · 자동</span>
                      <span className="stat-value">₩246,400</span>
                      <span className="stat-meta">공제 20% 뒤 금액. 승인을 기다리지 않고 10/19 환급 접수</span>
                    </div>
                    <div className="stat">
                      <span className="stat-label">면제분 · 승인 뒤 추가 환불</span>
                      <span className="stat-value">₩61,600</span>
                      <span className="stat-meta">승인되면 원결제 수단으로 돌려줍니다. 비용은 PEAKET 부담</span>
                    </div>
                  </div>
                </section>
                <section className="col" style={{ gap: "8px" }} aria-labelledby="a-ev">
                  <h3 className="eyebrow" id="a-ev">증빙 확인 사실 · 요청자 기록</h3>
                  <div className="check-row">
                    <input className="cb" type="checkbox" id="evA1" defaultChecked disabled />
                    <label className="t-sm" htmlFor="evA1">입원 사실을 진단서 원본으로 화면에서 확인했습니다</label>
                  </div>
                  <div className="check-row">
                    <input className="cb" type="checkbox" id="evA2" defaultChecked disabled />
                    <label className="t-sm" htmlFor="evA2">입원 기간에 관람일 10/25가 들어갑니다</label>
                  </div>
                  <div className="check-row">
                    <input className="cb" type="checkbox" id="evA3" defaultChecked disabled />
                    <label className="t-sm" htmlFor="evA3">결제자 본인 계정에서 온 요청입니다</label>
                  </div>
                  <div className="banner banner-info">
                    <i className="ic ic-shield" aria-hidden="true" />
                    <div className="banner-body">증빙 파일은 받거나 저장하지 않습니다. 확인한 사실과 확인자(다은, 10/19(월) 15:30 KST)만 남깁니다.</div>
                  </div>
                </section>
                <section className="col" style={{ gap: "10px" }} aria-labelledby="a-need">
                  <h3 className="eyebrow" id="a-need">필요한 승인</h3>
                  <div className="banner banner-announce">
                    <i className="ic ic-users" aria-hidden="true" />
                    <div className="banner-body">
                      <span className="banner-title">30만 원을 넘어 두 분의 승인이 필요합니다</span>
                      서버가 정한 인원입니다. 남은 승인 2명: CS 책임자 1명, commander 1명.
                    </div>
                  </div>
                  <dl className="kv">
                    <dt>주문 1건·30만 원 이하</dt>
                    <dd className="tx-warning">아니요 · ₩308,000</dd>
                    <dt>여러 주문을 한 번에</dt>
                    <dd>아니요 · 1건</dd>
                    <dt>같은 팬 90일 안 두 번째</dt>
                    <dd>아니요 · 자동 판정</dd>
                  </dl>
                  <ol className="col" style={{ gap: "8px" }} aria-label="승인자">
                    <li className="row between">
                      <span className="step is-current" aria-current="step">
                        <span className="step-num">1</span>
                        CS 책임자 · 준(나)
                      </span>
                      <span className="badge badge-warning">지금 차례</span>
                    </li>
                    <li className="row between">
                      <span className="step">
                        <span className="step-num">2</span>
                        commander
                      </span>
                      <span className="badge">대기</span>
                    </li>
                  </ol>
                  <p className="t-xs muted">요청한 다은은 승인할 수 없습니다.</p>
                </section>
                <div className="field">
                  <label className="label" htmlFor="a-note">
                    검토 의견{' '}
                    <span className="opt">(반려할 때 필수)</span>
                  </label>
                  {' '}
                  <textarea className="textarea" id="a-note" style={{ minHeight: "84px" }} placeholder="예: 진단서 확인 사실과 금액을 검토했습니다" aria-describedby="a-note-h a-note-c" />
                  {' '}
                  <span className="hint" id="a-note-h">감사 기록에 남습니다. 진단명 같은 민감정보는 적지 마세요.</span>
                  {' '}
                  <span className="counter" id="a-note-c" aria-live="polite">0 / 500자</span>
                </div>
              </div>
            </section>
            <div className="col" style={{ gap: "8px" }}>
              <p className="card-flat t-sm fw-b" id="a-sum" style={{ padding: "10px 14px", borderRadius: "var(--r-md)" }}>
                재량 면제 · 면제분 ₩61,600 추가 환불 · 주문 2026101400271 · 요청 다은
              </p>
              <button onClick={() => go?.('실행 직전 재인증')} className="btn btn-primary btn-lg btn-block" type="button" {...ro('a-sum a-re')}>면제분 ₩61,600 추가 환불을 승인합니다</button>
              {' '}
              <button className="btn btn-outline btn-lg btn-block" type="button" {...ro('a-sum')}>반려합니다</button>
              <p className="t-xs muted" id="a-re">승인 직전에 비밀번호와 인증 앱 코드로 다시 인증합니다. commander 승인까지 끝나면 원결제 수단으로 환불하고, 실행된 환불은 되돌릴 수 없습니다.</p>
            </div>
            <section className="widget" aria-labelledby="a-log">
              <div className="widget-head"><h3 className="t-sm fw-b" id="a-log">실행 결과와 감사 기록</h3></div>
              <div className="widget-body">
                <ol className="timeline">
                  <li className="tl-item">
                    <span className="tl-dot" />
                    <span className="col" style={{ gap: "2px" }}>
                      <span className="t-sm">결제자 예매 취소 · 공제 20% 적용</span>
                      <span className="t-xs muted">10/19(월) 11:05 KST</span>
                    </span>
                  </li>
                  <li className="tl-item">
                    <span className="tl-dot ok" />
                    <span className="col" style={{ gap: "2px" }}>
                      <span className="t-sm">기본 환불 ₩246,400 자동 환급 접수</span>
                      <span className="t-xs muted">10/19(월) 11:05 KST · 시스템</span>
                    </span>
                  </li>
                  <li className="tl-item">
                    <span className="tl-dot info" />
                    <span className="col" style={{ gap: "2px" }}>
                      <span className="t-sm">재량 면제 요청 · 필요한 승인 2명으로 판정</span>
                      <span className="t-xs muted">10/19(월) 15:42 KST · 다은 요청, 서버 판정</span>
                    </span>
                  </li>
                </ol>
              </div>
            </section>
          </div>
        </>
      ) : null}
      {' '}
      {v.showB ? (
        <>
          <div className="col" style={{ gap: "12px" }}>
            <section className="widget" aria-labelledby="b-h">
              <div className="widget-head" style={{ flexDirection: "column", alignItems: "stretch", gap: "6px", padding: "12px 14px" }}>
                <span className="row wrap" style={{ gap: "6px" }}>
                  <span className="badge badge-warning">commander 승인 대기</span>
                  <span className="badge badge-outline">요청자 외 commander 승인</span>
                </span>
                <h2 className="t-md fw-b" id="b-h">양도 회수 · 티켓 T-39914-02</h2>
              </div>
              <div className="widget-body" style={{ gap: "20px" }}>
                <div className="col" style={{ gap: "6px" }}>
                  <span className="t-sm">요청 {v.reqBLong} · 10/19(월) 10:20 KST</span>
                  {' '}
                  <span className="row wrap" style={{ gap: "6px" }}>
                    <span className="t-sm">승인 기한 10/20(화) 10:20 KST</span>
                    <span className="badge badge-warning">
                      <i className="ic ic-clock" aria-hidden="true" />
                      <span className="sr-only">승인 기한</span>
                      1영업일 남음
                    </span>
                  </span>
                </div>
                <section className="col" style={{ gap: "8px" }} aria-labelledby="b-req">
                  <h3 className="eyebrow" id="b-req">요청 내용</h3>
                  <dl className="kv">
                    <dt>종류</dt>
                    <dd>양도 회수(계정 탈취)</dd>
                    <dt>대상</dt>
                    <dd>
                      <span className="mono">T-39914-02</span>
                      {' '}· R석 1매
                    </dd>
                    <dt>공연</dt>
                    <dd>LUMEN 콘서트 2026 서울 · 10/25(일) 18:00</dd>
                    <dt>양도 수락</dt>
                    <dd>10/15(목) 02:14 KST</dd>
                    <dt>계정</dt>
                    <dd>결제자·받은 분 모두 가림</dd>
                  </dl>
                  <p className="card-flat pad t-sm">"결제자 계정이 탈취되어 본인 모르게 양도되었습니다. 새 기기 로그인 기록으로 확인했습니다." · 준</p>
                  <Link to="/customers" className="link-more" style={{ alignSelf: "flex-start" }}>
                    팬 조회에서 두 계정 보기
                    <i className="ic ic-chevron-right" aria-hidden="true" />
                  </Link>
                </section>
                <section className="col" style={{ gap: "8px" }} aria-labelledby="b-cond">
                  <h3 className="eyebrow" id="b-cond">회수 조건</h3>
                  <ul className="col" style={{ gap: "8px" }}>
                    <li className="row between" style={{ gap: "8px" }}>
                      <span className="row t-sm" style={{ gap: "8px" }}>
                        <i className="ic ic-check-circle ic-16 tx-success" aria-hidden="true" />
                        피해자 본인확인 재확인
                      </span>
                      <span className="badge badge-success">완료 · 10/16</span>
                    </li>
                    <li className="row between" style={{ gap: "8px" }}>
                      <span className="row t-sm" style={{ gap: "8px" }}>
                        <i className="ic ic-check-circle ic-16 tx-success" aria-hidden="true" />
                        소명 기간 1일 지남
                      </span>
                      <span className="badge badge-success">예 · 기한 10/17(토) 18:00 KST</span>
                    </li>
                    <li className="row between" style={{ gap: "8px" }}>
                      <span className="row t-sm" style={{ gap: "8px" }}>
                        <i className="ic ic-info ic-16" aria-hidden="true" />
                        받은 분 소명
                      </span>
                      <span className="badge">없음</span>
                    </li>
                    <li className="row between" style={{ gap: "8px" }}>
                      <span className="row t-sm" style={{ gap: "8px" }}>
                        <i className="ic ic-check-circle ic-16 tx-success" aria-hidden="true" />
                        입장 시작 전
                      </span>
                      <span className="badge badge-success">예 · 입장 시작 10/25(일) 16:30 KST</span>
                    </li>
                    <li className="row between" style={{ gap: "8px" }}>
                      <span className="row t-sm" style={{ gap: "8px" }}>
                        <i className="ic ic-check-circle ic-16 tx-success" aria-hidden="true" />
                        입장 기록 없음
                      </span>
                      <span className="badge badge-success">예</span>
                    </li>
                  </ul>
                  <p className="t-xs muted">받은 분의 소명이 합리적이면 회수하지 않습니다. 입장이 시작되면 회수할 수 없습니다.</p>
                </section>
                <section className="col" style={{ gap: "10px" }} aria-labelledby="b-need">
                  <h3 className="eyebrow" id="b-need">필요한 승인</h3>
                  <p className="t-sm">commander 1명의 승인이 필요합니다. 남은 승인 1명: commander.</p>
                  <ol className="col" style={{ gap: "8px" }} aria-label="승인자">
                    {v.asLead ? (
                      <>
                        <li className="row between">
                          <span className="step">
                            <span className="step-num">1</span>
                            commander
                          </span>
                          <span className="badge">대기</span>
                        </li>
                      </>
                    ) : null}
                    {v.asCmd ? (
                      <>
                        <li className="row between">
                          <span className="step is-current" aria-current="step">
                            <span className="step-num">1</span>
                            commander · 수진(나)
                          </span>
                          <span className="badge badge-warning">지금 차례</span>
                        </li>
                      </>
                    ) : null}
                  </ol>
                </section>
              </div>
            </section>
            <div className="col" style={{ gap: "8px" }}>
              <p className="card-flat t-sm fw-b" id="b-sum" style={{ padding: "10px 14px", borderRadius: "var(--r-md)" }}>
                양도 회수 · 티켓 T-39914-02 · R석 1매 · 요청 {v.reqB}
              </p>
              {v.asLead ? (
                <>
                  <button className="btn btn-primary btn-block" type="button" aria-disabled="true" aria-describedby="b-why">
                    회수를 승인하고 티켓을 결제자에게 되돌립니다
                  </button>
                  <p className="row t-sm" id="b-why" style={{ gap: "6px" }}>
                    <i className="ic ic-lock ic-16" aria-hidden="true" />
                    요청한 분은 승인할 수 없습니다
                  </p>
                </>
              ) : null}
              {' '}
              {v.asCmd ? (
                <>
                  <button onClick={() => go?.('실행 직전 재인증 — commander')} className="btn btn-primary btn-lg btn-block" type="button" {...ro('b-sum b-re')}>회수를 승인하고 티켓을 결제자에게 되돌립니다</button>
                  <button className="btn btn-outline btn-lg btn-block" type="button" {...ro('b-sum')}>반려합니다</button>
                  <p className="t-xs muted" id="b-re">승인 직전에 비밀번호와 인증 앱 코드로 다시 인증하고, 등록한 패스키로 한 번 더 확인합니다.</p>
                </>
              ) : null}
            </div>
            <div className="card-flat pad col" style={{ gap: "4px" }}>
              <span className="t-xs fw-b">승인되면</span>
              {' '}
              <span className="t-xs muted">실행 직전 재인증·패스키 확인 → 받은 분의 입장 키 폐기 → 티켓이 결제자에게 돌아감(결제자가 입장용 휴대폰을 다시 등록) → 스캐너에는 1분 변경분으로 반영</span>
            </div>
            <section className="widget" aria-labelledby="b-log">
              <div className="widget-head"><h3 className="t-sm fw-b" id="b-log">감사 기록</h3></div>
              <div className="widget-body">
                <ol className="timeline">
                  <li className="tl-item">
                    <span className="tl-dot info" />
                    <span className="col" style={{ gap: "2px" }}>
                      <span className="t-sm">결제자 계정 탈취 신고 · 분쟁 접수</span>
                      <span className="t-xs muted">10/16(금) 10:40 KST</span>
                    </span>
                  </li>
                  <li className="tl-item">
                    <span className="tl-dot ok" />
                    <span className="col" style={{ gap: "2px" }}>
                      <span className="t-sm">피해자 본인확인 재확인 완료</span>
                      <span className="t-xs muted">10/16(금) 11:02 KST · 준</span>
                    </span>
                  </li>
                  <li className="tl-item">
                    <span className="tl-dot" />
                    <span className="col" style={{ gap: "2px" }}>
                      <span className="t-sm">받은 분에게 회수 예고·소명 요청(이메일)</span>
                      <span className="t-xs muted">10/16(금) 18:00 KST</span>
                    </span>
                  </li>
                  <li className="tl-item">
                    <span className="tl-dot info" />
                    <span className="col" style={{ gap: "2px" }}>
                      <span className="t-sm">회수 요청 · 필요한 승인 commander 1명</span>
                      <span className="t-xs muted">10/19(월) 10:20 KST · 준</span>
                    </span>
                  </li>
                </ol>
              </div>
            </section>
          </div>
        </>
      ) : null}
      {' '}
      {v.showD ? (
        <>
          <div className="col" style={{ gap: "12px" }}>
            <section className="widget" aria-labelledby="d-h">
              <div className="widget-head" style={{ flexDirection: "column", alignItems: "stretch", gap: "6px", padding: "12px 14px" }}>
                <span className="row wrap" style={{ gap: "6px" }}>
                  <span className="badge badge-danger">실행 실패</span>
                  <span className="badge badge-outline">1인 승인</span>
                </span>
                <h2 className="t-md fw-b" id="d-h">시스템 잘못 환불 · 주문 2026101400530</h2>
              </div>
              <div className="widget-body" style={{ gap: "16px" }}>
                <div className="col" style={{ gap: "6px" }}>
                  <span className="t-sm">요청 다은(cs_agent) · 10/16(금) 09:30 KST</span>
                  {' '}
                  <span className="t-sm">승인 준(cs_lead, 나) · 10/16(금) 10:05 KST</span>
                  {' '}
                  <span className="row wrap" style={{ gap: "6px" }}>
                    <span className="badge badge-warning">
                      <i className="ic ic-clock" aria-hidden="true" />
                      처리 기한 10/21(수)
                    </span>
                  </span>
                </div>
                <div className="banner banner-danger" role="alert">
                  <i className="ic ic-alert-circle" aria-hidden="true" />
                  <div className="banner-body">
                    <span className="banner-title">환불을 실행하지 못했습니다</span>
                    10/16(금) 10:05 KST · 토스페이먼츠가 환불 요청을 처리하지 못했습니다(결제사 일시 장애). CS 처리함에 '승인 업무 실행 실패' 건을 만들었습니다.
                  </div>
                </div>
                <dl className="kv">
                  <dt>종류</dt>
                  <dd>시스템 잘못 환불(중복 결제)</dd>
                  <dt>대상</dt>
                  <dd><span className="mono">2026101400530</span></dd>
                  <dt>금액</dt>
                  <dd>₩132,000 · 토스페이먼츠</dd>
                </dl>
                <p className="t-sm">원인을 고친 뒤 같은 대상·금액으로 다시 실행합니다. 같은 승인으로 실행하므로 새 승인은 필요 없고, 두 번 환불되지 않습니다. 대상이나 금액이 바뀌면 새 승인 업무를 만드세요.</p>
                <button className="btn btn-primary btn-lg btn-block" type="button" {...ro('d-re')}>₩132,000 환불을 다시 실행합니다</button>
                {' '}
                <Link to="/cs/inbox" className="btn btn-outline btn-block">CS 처리함 건 보기</Link>
                <p className="t-xs muted" id="d-re">실행 직전에 비밀번호와 인증 앱 코드로 다시 인증합니다. 처리 기한 10/21(수) 안에 다시 실행하지 못하면 분쟁 접수로 바뀝니다.</p>
              </div>
            </section>
            <section className="widget" aria-labelledby="d-log">
              <div className="widget-head"><h2 className="t-sm fw-b" id="d-log">실행 결과와 감사 기록</h2></div>
              <div className="widget-body">
                <ol className="timeline">
                  <li className="tl-item">
                    <span className="tl-dot info" />
                    <span className="col" style={{ gap: "2px" }}>
                      <span className="t-sm">시스템 잘못 환불 요청 · 필요한 승인 1명으로 판정</span>
                      <span className="t-xs muted">10/16(금) 09:30 KST · 다은 요청, 서버 판정</span>
                    </span>
                  </li>
                  <li className="tl-item">
                    <span className="tl-dot ok" />
                    <span className="col" style={{ gap: "2px" }}>
                      <span className="t-sm">승인 · 비밀번호·인증 앱 코드로 다시 인증함</span>
                      <span className="t-xs muted">10/16(금) 10:05 KST · 준</span>
                    </span>
                  </li>
                  <li className="tl-item">
                    <span className="tl-dot bad" />
                    <span className="col" style={{ gap: "2px" }}>
                      <span className="t-sm">실행 실패 · 결제사 일시 장애</span>
                      <span className="t-xs muted">10/16(금) 10:05 KST · 시스템</span>
                    </span>
                  </li>
                  <li className="tl-item">
                    <span className="tl-dot" />
                    <span className="col" style={{ gap: "2px" }}>
                      <span className="t-sm">CS 처리함 건 생성 · 승인 업무 실행 실패</span>
                      <span className="t-xs muted">10/16(금) 10:05 KST · 시스템</span>
                    </span>
                  </li>
                </ol>
              </div>
            </section>
          </div>
        </>
      ) : null}
      {' '}
      {v.showE ? (
        <>
          <section className="widget" aria-labelledby="e-h">
            <div className="widget-body">
              <div className="state" role="alert" style={{ padding: "32px 8px", gap: "12px" }}>
                <span className="state-icon is-danger"><i className="ic ic-ban" aria-hidden="true" /></span>
                <h2 className="t-lg" id="e-h">권한 밖 승인입니다</h2>
                <p className="t-sm muted">이 승인 요청은 지금 역할(cs_lead)로 열 수 없습니다. 역할마다 승인할 수 있는 종류만 열립니다. 링크를 잘못 받았다면 보낸 분에게 알려 주세요.</p>
                <Link to="/cs/approvals" className="btn btn-outline btn-block">요청 목록으로</Link>
              </div>
            </div>
          </section>
        </>
      ) : null}
    </section>
    </>
  );
}

export function OverlaysM({ v, close, go }: { v: V; close?: () => void; go?: (state: string) => void }) {
  void v; void close; void go;
  const ro = useRo();
  return (
    <>
    {v.showReauth ? (
      <>
        <Overlay placement="bottom" onClose={close}>
          <div className="sheet" role="dialog" aria-modal="true" aria-labelledby="ra-t" aria-describedby="ra-d">
            <span className="sheet-handle" aria-hidden="true" />
            <div className="row" style={{ gap: "10px" }}>
              <span className="state-icon is-primary" style={{ width: "40px", height: "40px" }}><i className="ic ic-lock" aria-hidden="true" /></span>
              <h2 className="t-lg" id="ra-t">관리 계정을 다시 확인합니다</h2>
            </div>
            {v.asLead ? (
              <>
                <p className="t-sm" id="ra-d">면제분 ₩61,600 추가 환불 승인을 기록하기 전에 비밀번호와 인증 앱 코드로 다시 인증합니다. 재인증은 5분 동안 한 번만 쓸 수 있습니다.</p>
                <dl className="kv card-flat pad">
                  <dt>승인할 일</dt>
                  <dd>재량 면제 · 2026101400271</dd>
                  <dt>금액</dt>
                  <dd>면제분 ₩61,600</dd>
                  <dt>승인 뒤</dt>
                  <dd>1/2 · 남은 승인 commander 1명</dd>
                </dl>
              </>
            ) : null}
            {' '}
            {v.asCmd ? (
              <>
                <p className="t-sm" id="ra-d">양도 회수 승인을 기록하기 전에 비밀번호와 인증 앱 코드로 다시 인증하고, 등록한 패스키로 한 번 더 확인합니다. 재인증은 5분 동안 한 번만 쓸 수 있습니다.</p>
                <dl className="kv card-flat pad">
                  <dt>승인할 일</dt>
                  <dd>양도 회수 · T-39914-02</dd>
                  <dt>대상</dt>
                  <dd>R석 1매 · LUMEN 10/25(일) 18:00</dd>
                  <dt>승인 뒤</dt>
                  <dd>바로 실행 · 받은 분의 입장 키 폐기</dd>
                </dl>
              </>
            ) : null}
            <div className="field">
              <label className="label" htmlFor="ra-pw">비밀번호</label>
              {' '}
              <input className="input is-focus" id="ra-pw" type="password" autoComplete="current-password" />
            </div>
            <div className="field">
              <label className="label" id="ra-otp-l" htmlFor="ra-otp">인증 앱 코드 6자리</label>
              {' '}
              <input className="otp-input" id="ra-otp" type="text" inputMode="numeric" autoComplete="one-time-code" maxLength={6} pattern="[0-9]*" aria-describedby="ra-otp-h0 ra-otp-h" defaultValue="" />
              {' '}
              <span className="hint" id="ra-otp-h0">인증 앱에 보이는 6자리 숫자입니다.</span>
              {' '}
              <span className="hint" id="ra-otp-h">휴대폰을 잃을 때 로그인과 인증 앱 코드를 함께 잃지 않도록, 인증 앱은 이 휴대폰이 아닌 다른 기기에 두기를 권합니다.</span>
            </div>
            {v.asCmd ? (
              <>
                <p className="row t-sm" style={{ gap: "8px", alignItems: "center" }}>
                  <i className="ic ic-key ic-16" aria-hidden="true" />
                  등록한 패스키로 한 번 더 확인합니다
                </p>
              </>
            ) : null}
            {v.asLead ? (
              <>
                <p className="t-xs muted">CS 책임자의 승인은 비밀번호와 인증 앱 코드에서 끝납니다. 패스키 확인은 commander의 승인·실행에만 있습니다.</p>
              </>
            ) : null}
            {' '}
            <button onClick={() => go?.('재인증 · 패스키 확인')} className="btn btn-primary btn-lg btn-block" type="button" {...ro()}>재인증하고 승인합니다</button>
            {' '}
            <button onClick={close} className="btn btn-outline btn-block" type="button">닫기</button>
          </div>
        </Overlay>
      </>
    ) : null}
    {v.showPk ? (
      <>
        <Overlay placement="bottom" onClose={close}>
          <div className="sheet" role="dialog" aria-modal="true" aria-labelledby="pk-t" aria-describedby="pk-d">
            <span className="sheet-handle" aria-hidden="true" />
            <nav className="stepper" aria-label="다시 확인 단계">
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
            <h2 className="t-lg" id="pk-t">관리 계정을 다시 확인합니다</h2>
            <p className="row t-sm tx-success" style={{ gap: "6px", alignItems: "flex-start" }}>
              <i className="ic ic-check-circle ic-16" aria-hidden="true" style={{ marginTop: "2px" }} />
              <span>비밀번호와 인증 앱 코드를 확인했습니다</span>
            </p>
            <dl className="kv card-flat pad">
              <dt>승인할 일</dt>
              <dd>양도 회수 · T-39914-02</dd>
              <dt>대상</dt>
              <dd>R석 1매 · LUMEN 10/25(일) 18:00</dd>
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
            <button onClick={close} className="btn btn-primary btn-lg btn-block is-focus" type="button" {...ro()}>
              <i className="ic ic-key" aria-hidden="true" />
              패스키로 확인
            </button>
            {' '}
            <button onClick={close} className="btn btn-outline btn-block" type="button">닫기</button>
          </div>
        </Overlay>
      </>
    ) : null}
    </>
  );
}
