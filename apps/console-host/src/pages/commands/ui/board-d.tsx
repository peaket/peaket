// 디자인 캔버스 보드 SCR-030-d.dc.html를 옮긴 것(dc2tsx 생성 뒤 손질)
/* eslint-disable */
import { Fragment, type FormEvent } from 'react';
import { Link } from 'react-router';
import { Overlay } from '@/shared/ui/Overlay';

const prevent = (e: FormEvent) => e.preventDefault();
void Fragment;
void Link;

type AriaBool = boolean | 'true' | 'false';
type AriaCurrent = boolean | 'true' | 'false' | 'page' | 'step' | 'location' | 'date' | 'time';

export const STATES_D = ["명령 요청 작성", "킬스위치 확인", "두 번째 승인자 화면", "패스키 확인", "패스키 확인 실패", "패스키 없음", "전파 중/ack", "전파 지연", "전파 실패", "적용 확인 중", "적용 확인됨", "적용 확인 안 됨", "확인할 수 없음", "전파 대기", "입장 일시정지 만료 확인", "사후 검토 보고서", "명령 3 사후 검토 보고서", "버짓 연동 감축", "노출 줄이기"] as const;
export const DEFAULT_D = "명령 요청 작성";

export function valsD(state: string) {
    let st = state || '명령 요청 작성';
    let pk = st === '패스키 확인';
    let pkFail = st === '패스키 확인 실패';
    let pkNone = st === '패스키 없음';
    let approve = st === '두 번째 승인자 화면' || pk || pkFail || pkNone;
    let setChk = st === '적용 확인 중';
    let setOk = st === '적용 확인됨';
    let setNo = st === '적용 확인 안 됨';
    let setUnk = st === '확인할 수 없음';
    let setWait = st === '전파 대기';
    let set = setChk || setOk || setNo || setUnk || setWait;
    let delay = st === '전파 지연';
    let prop = st === '전파 중/ack' || delay;
    let fail = st === '전파 실패';
    let pause = st === '입장 일시정지 만료 확인';
    let report = st === '사후 검토 보고서';
    let report3 = st === '명령 3 사후 검토 보고서';
    let cut = st === '버짓 연동 감축';
    let expose = st === '노출 줄이기';
    let idle = st === '명령 요청 작성' || st === '킬스위치 확인' || pause || cut || expose;
    let three = prop || fail || pause || report || approve || report3 || set;
    return {
      asSujin: !approve,
      asMinho: approve,
      cardIdle: idle,
      card3Plain: report || set,
      c5Rej: !approve && !set,
      c11Plain: !approve && !report,
      showCompose: idle,
      showConfirm: st === '킬스위치 확인',
      showApprove: approve,
      pkStep1: approve && !pk && !pkFail && !pkNone,
      pkStep2: pk || pkFail || pkNone,
      pkFail: pkFail,
      pkNone: pkNone,
      pkHave: !pkNone,
      showProp: prop,
      isDelay: delay,
      notDelay: !delay,
      showFail: fail,
      showKs: three,
      noKs: !three,
      ks3Banner: prop || fail || report3,
      isPause: pause,
      isReport: report,
      isReport3: report3,
      isCut: cut,
      isExpose: expose,
      ctlOk: cut || expose,
      autoHold: !report && !cut && !expose,
      showAimd: !report && !cut && !expose,
      cmd1Hold: !cut && !expose,
      isSet: set,
      showSet: set,
      setChk: setChk,
      setOk: setOk,
      setNo: setNo,
      setUnk: setUnk,
      setWait: setWait,
      setOpen: set && !setOk,
      setLive: setChk || setOk || setNo,
      setAt: setNo ? '20:03:40' : '20:03:58',
      setCount: setOk ? '4/4' : (setUnk ? '—' : (setWait ? '0/4' : '3/4')),
      setNow: setOk ? 4 : ((setChk || setNo) ? 3 : 0),
      setPct: 'width:' + (setOk ? 100 : ((setChk || setNo) ? 75 : 0)) + '%',
      setBar: setOk ? 'progress progress-success' : (setNo ? 'progress progress-warning' : 'progress'),
      setVt: setUnk ? '적용한 판 번호를 읽지 못함' : (setWait ? '아직 카프카로 나가지 못함, 준비된 파드 4개 모두 판 17' : ('준비된 파드 4개 중 ' + (setOk ? 4 : 3) + '개가 판 18 이상')),
      sev3: setNo ? 5 : 4
    };
  }

type V = ReturnType<typeof valsD>;

// 보드 루트: {"class": "pk dark cs", "style": "width:100%;min-height:1950px"}

// <main class="cs-main" id="main">
export function MainD({ v, close }: { v: V; close?: () => void }) {
  void v; void close;
  return (
    <>
    <div className="page-head">
      <div className="col" style={{ gap: "4px", maxWidth: "760px" }}>
        <h1>운영 명령</h1>
        <p className="t-sm muted">사유 → dry-run → 재인증(등록한 패스키로 한 번 더 확인) → 두 번째 승인(2인 명령만) → 전파 ack 순서로 실행합니다. 되돌리기는 시간 제한이 없습니다.</p>
      </div>
      <div className="row wrap" style={{ gap: "12px" }} role="group" aria-label="접속 운영자 3명">
        <span className="t-xs muted">접속 운영자</span>
        {' '}
        <span className="row" style={{ gap: "6px" }}>
          <span className="avatar" style={{ width: "24px", height: "24px", fontSize: "11px" }} aria-hidden="true">수</span>
          <span className="t-xs">수진 · commander</span>
        </span>
        {' '}
        <span className="row" style={{ gap: "6px" }}>
          <span className="avatar" style={{ width: "24px", height: "24px", fontSize: "11px" }} aria-hidden="true">민</span>
          <span className="t-xs">민호 · operator</span>
        </span>
        {' '}
        <span className="row" style={{ gap: "6px" }}>
          <span className="avatar" style={{ width: "24px", height: "24px", fontSize: "11px" }} aria-hidden="true">서</span>
          <span className="t-xs">서연 · viewer</span>
        </span>
      </div>
    </div>
    {v.isReport ? (
      <>
        <div className="banner banner-danger" role="status">
          <i className="ic ic-stop" aria-hidden="true" />
          <div className="banner-body">
            <span className="banner-title">입장 제어 자동화를 1인 긴급 실행으로 멈췄습니다. 10/16(금) 20:04 KST까지 사후 검토 보고서를 써야 합니다</span>
            명령 11 · 수진 20:04:02 KST. AIMD 조정·버짓 연동 감축·Degraded 후보 추천이 멈췄고 오토스케일은 계속됩니다. 다시 켜려면 2인 승인이 필요합니다.
          </div>
          <a className="btn btn-outline btn-sm" href="#rp-t">보고서 쓰기</a>
        </div>
      </>
    ) : null}
    {' '}
    {v.ks3Banner ? (
      <>
        <div className="banner banner-danger" role="status">
          <i className="ic ic-stop" aria-hidden="true" />
          <div className="banner-body">
            <span className="banner-title">판매 일시정지를 1인 실행으로 걸었습니다. 10/16(금) 20:04 KST까지 사후 검토 보고서를 써야 합니다</span>
            명령 3 · 수진 20:04:09 KST · 10/25(일) 18:00 회차. 실행은 인시던트 선언 기준이라 보고서는 그 포스트모템의 한 절로 들어갑니다. 판매 재개는 2인 승인이고, 보고서는 재개의 조건이 아닙니다.
          </div>
          <a className="btn btn-outline btn-sm" href="#rp-t-k">보고서 쓰기</a>
        </div>
      </>
    ) : null}
    {' '}
    {v.isCut ? (
      <>
        <div className="banner banner-warning" role="alert">
          <i className="ic ic-alert" aria-hidden="true" />
          <div className="banner-body">
            <span className="banner-title">운영자가 정한 동시 입장 목표를 새 소진 경보로 절반으로 줄였습니다(4,000 → 2,000명). 다시 정하려면 동시 입장 목표 조정(명령 1)을 쓰세요.</span>
            시스템 20:04:07 KST · 10/25(일) 18:00 회차 · 감사 로그 사유 '자동 조절 멈춤 중 버짓 연동 감축'. 자동 조절 멈춤(15분)은 끝났고, 명령 1로 다시 정할 때까지 자동 증액은 멈춥니다.
          </div>
          <button className="btn btn-outline btn-sm" type="button">동시 입장 목표 조정(명령 1)</button>
        </div>
      </>
    ) : null}
    {' '}
    {v.isExpose ? (
      <>
        <div className="banner banner-warning" role="alert">
          <i className="ic ic-alert" aria-hidden="true" />
          <div className="banner-body">
            <span className="banner-title">결제사 쪽 문제로 결제 실패가 늘어, 결제 단계에 들어오는 사람을 줄였습니다(4,000 → 2,000명). 결제사를 빠르게 하지는 않으며, 실패를 겪는 사람 수를 줄입니다.</span>
            시스템 20:04:07 KST · 10/25(일) 18:00 회차 · 결제 확정 예산으로 줄임(토스페이먼츠 결제사 쪽 원인 경보와 함께) · 감사 로그 사유 '노출 줄이기'.
          </div>
          <button className="btn btn-outline btn-sm" type="button">동시 입장 목표 조정(명령 1)</button>
        </div>
      </>
    ) : null}
    {' '}
    {v.showAimd ? (
      <>
        <div className="banner banner-warning" role="status">
          <i className="ic ic-clock" aria-hidden="true" />
          <div className="banner-body">
            <span className="banner-title">자동 조절(AIMD)이 멈춰 있습니다 · 13:12 남음</span>
            민호가 20:02:24 KST에 10/25(일) 18:00 회차의 동시 입장 목표를 1,000명으로 정해 자동 조절이 15분 멈췄습니다. 15분이 지나면 운영자가 확인해야 자동 조절로 돌아갑니다.
          </div>
        </div>
      </>
    ) : null}
    <div className="grid-12" style={{ rowGap: "16px", alignItems: "stretch" }}>
      <section className="widget span-5" aria-labelledby="act-t">
        <div className="widget-head">
          <h2 id="act-t" style={{ fontSize: "13px", lineHeight: "18px" }}>적용 중 명령</h2>
          <div className="actions">
            {v.noKs ? (
              <>
                <span className="badge">2건</span>
              </>
            ) : null}
            {v.showKs ? (
              <>
                <span className="badge">3건</span>
              </>
            ) : null}
          </div>
        </div>
        <ul className="col" style={{ padding: "0 14px 4px" }}>
          {v.cmd1Hold ? (
            <>
              <li className="row" style={{ gap: "10px", padding: "10px 0", borderBottom: "1px solid var(--border)" }}>
                <span className="col grow" style={{ gap: "2px" }}>
                  <span className="t-sm fw-b">명령 1 목표 5,000 → 1,000명</span>
                  <span className="t-xs muted">10/25(일) 18:00 · 민호 20:02:24 KST · 자동 조절 정지 13:12 남음</span>
                </span>
                {' '}
                <button className="btn btn-outline btn-sm" type="button" aria-label="명령 1 동시 입장 목표를 직전 값 5,000명으로 되돌리기">
                  <i className="ic ic-undo" aria-hidden="true" />
                  되돌리기
                </button>
              </li>
            </>
          ) : null}
          {' '}
          {v.isCut ? (
            <>
              <li className="row" style={{ gap: "10px", padding: "10px 0", borderBottom: "1px solid var(--border)" }}>
                <span className="col grow" style={{ gap: "2px" }}>
                  <span className="t-sm fw-b">명령 1 목표 5,000 → 4,000 → 2,000명</span>
                  <span className="t-xs muted">10/25(일) 18:00 · 민호 20:02:24 KST · 시스템 20:04:07 KST 자동 조절 멈춤 중 버짓 연동 감축 · 자동 증액 멈춤</span>
                </span>
              </li>
            </>
          ) : null}
          {' '}
          {v.isExpose ? (
            <>
              <li className="row" style={{ gap: "10px", padding: "10px 0", borderBottom: "1px solid var(--border)" }}>
                <span className="col grow" style={{ gap: "2px" }}>
                  <span className="t-sm fw-b">동시 입장 목표 4,000 → 2,000명</span>
                  <span className="t-xs muted">10/25(일) 18:00 · 시스템 20:04:07 KST 노출 줄이기(결제 확정 예산, 결제사 쪽 원인)</span>
                </span>
              </li>
            </>
          ) : null}
          {' '}
          {v.isPause ? (
            <>
              <li className="row" style={{ gap: "10px", padding: "10px 0", borderBottom: "1px solid var(--border)" }}>
                <span className="col grow" style={{ gap: "2px" }}>
                  <span className="t-sm fw-b">명령 2 입장 일시정지</span>
                  <span className="t-xs muted">10/25(일) 18:00 · 민호 19:55:12 KST · Go/No-Go가 No-Go라 입장 일시정지로 시작 · 자동 만료까지 1:00 남음</span>
                </span>
                {' '}
                <button className="btn btn-outline btn-sm" type="button" aria-label="명령 2 입장 일시정지를 끝내고 지금 입장 재개하기">
                  <i className="ic ic-play" aria-hidden="true" />
                  지금 재개
                </button>
              </li>
            </>
          ) : null}
          {' '}
          {v.isReport ? (
            <>
              <li className="row" style={{ gap: "10px", padding: "10px 0", borderBottom: "1px solid var(--border)" }}>
                <span className="col grow" style={{ gap: "2px" }}>
                  <span className="t-sm fw-b">명령 11 자동화 정지 스위치</span>
                  <span className="t-xs muted">수진 20:04:02 KST · 1인 긴급 · 사후 검토 보고서 기한 10/16(금) 20:04 KST</span>
                </span>
                {' '}
                <button className="btn btn-outline btn-sm" type="button" aria-label="명령 11 자동화 정지 스위치를 풀고 재개를 요청하기(2인 승인)">
                  <i className="ic ic-play" aria-hidden="true" />
                  재개 요청(2인)
                </button>
              </li>
            </>
          ) : null}
          <li className="row" style={{ gap: "10px", padding: "10px 0", borderBottom: "1px solid var(--border)" }}>
            <span className="col grow" style={{ gap: "2px" }}>
              <span className="t-sm fw-b">
                명령 4 차단{' '}
                <span className="mono">203.0.113.0/24</span>
              </span>
              <span className="t-xs muted">민호 19:57:52 KST · 자동 만료까지 23:40 남음</span>
              <span className="t-xs">효과(실행 전 5분 → 지금, 실행 뒤 10분 동안): 차단 비율 1.2% → 3.8% · 추가 검증 통과율 94% → 93% · 이의 제기 1건 · 사람을 막는 신호 없음</span>
            </span>
            {' '}
            <button className="btn btn-outline btn-sm" type="button" aria-label="명령 4 대역 203.0.113.0/24 차단 해제">
              <i className="ic ic-undo" aria-hidden="true" />
              차단 해제
            </button>
          </li>
          {v.isSet ? (
            <>
              <li className="row" style={{ gap: "10px", padding: "10px 0" }}>
                <span className="col grow" style={{ gap: "2px" }}>
                  <span className="t-sm fw-b">명령 5 봇 판정 강도 기본 → 강화</span>
                  <span className="t-xs muted num">수진 요청 20:03:12 KST · 민호 승인 {v.setAt} KST · 판 18</span>
                  {v.setOk ? (
                    <>
                      <span className="t-xs">효과 줄(차단 비율·추가 검증 통과율·이의 제기)은 적용 확인 뒤 10분 동안 이 줄에 보입니다 · 모으는 중</span>
                    </>
                  ) : null}
                </span>
                {' '}
                {v.setChk ? (
                  <>
                    <span className="badge badge-primary">적용 확인 중</span>
                  </>
                ) : null}
                {v.setOk ? (
                  <>
                    <span className="badge badge-success">
                      <i className="ic ic-check" aria-hidden="true" />
                      적용 확인됨
                    </span>
                  </>
                ) : null}
                {v.setNo ? (
                  <>
                    <span className="badge badge-warning">적용 확인 안 됨</span>
                  </>
                ) : null}
                {v.setUnk ? (
                  <>
                    <span className="badge badge-outline">확인할 수 없음</span>
                  </>
                ) : null}
                {v.setWait ? (
                  <>
                    <span className="badge badge-warning">보냄 · 전파 대기</span>
                  </>
                ) : null}
              </li>
            </>
          ) : null}
          {' '}
          {v.showApprove ? (
            <>
              <li className="row" style={{ gap: "10px", padding: "10px 0" }}>
                <span className="col grow" style={{ gap: "2px" }}>
                  <span className="t-sm fw-b">명령 3 판매 일시정지(킬스위치) · 범위 전체</span>
                  <span className="t-xs muted">수진 실행 20:01:40 KST · 판매 재개 승인 대기</span>
                </span>
                {' '}
                <span className="badge badge-warning">재개 승인 대기 9:41</span>
              </li>
            </>
          ) : null}
          {' '}
          {v.showProp ? (
            <>
              <li className="row" style={{ gap: "10px", padding: "10px 0" }}>
                <span className="col grow" style={{ gap: "2px" }}>
                  <span className="t-sm fw-b">명령 3 판매 일시정지(킬스위치)</span>
                  <span className="t-xs muted">10/25(일) 18:00 · 수진 실행 20:04:09 KST</span>
                </span>
                {' '}
                <span className="badge badge-primary">전파 중 4/5</span>
              </li>
            </>
          ) : null}
          {' '}
          {v.isReport3 ? (
            <>
              <li className="row" style={{ gap: "10px", padding: "10px 0" }}>
                <span className="col grow" style={{ gap: "2px" }}>
                  <span className="t-sm fw-b">명령 3 판매 일시정지(킬스위치)</span>
                  <span className="t-xs muted">10/25(일) 18:00 · 수진 실행 20:04:09 KST · 사후 검토 보고서 기한 10/16(금) 20:04 KST</span>
                </span>
                {' '}
                <button className="btn btn-outline btn-sm" type="button" aria-label="명령 3 판매 재개를 요청하기(2인 승인)">
                  <i className="ic ic-play" aria-hidden="true" />
                  재개 요청(2인)
                </button>
              </li>
            </>
          ) : null}
          {' '}
          {v.showFail ? (
            <>
              <li className="row" style={{ gap: "10px", padding: "10px 0" }}>
                <span className="col grow" style={{ gap: "2px" }}>
                  <span className="t-sm fw-b">명령 3 판매 일시정지(킬스위치)</span>
                  <span className="t-xs muted">10/25(일) 18:00 · 수진 실행 20:04:09 KST · ack 4/5</span>
                </span>
                {' '}
                <span className="badge badge-danger">실패</span>
              </li>
            </>
          ) : null}
        </ul>
      </section>
      <section className="widget span-4" aria-labelledby="mine-t">
        <div className="widget-head">
          <h2 id="mine-t" style={{ fontSize: "13px", lineHeight: "18px" }}>내 승인 대기</h2>
          <div className="actions"><span className="badge badge-warning">1건</span></div>
        </div>
        <div className="widget-body" style={{ gap: "8px" }}>
          {v.asSujin ? (
            <>
              <Link to="/commands" className="card-flat" style={{ display: "flex", flexDirection: "column", gap: "4px", padding: "12px 14px", color: "inherit", borderRadius: "var(--r-lg)" }}>
                <span className="row between" style={{ gap: "8px", alignItems: "flex-start" }}>
                  <span className="t-sm fw-b">
                    명령 4 ASN·IP 대역 차단 ·{' '}
                    <span className="mono">AS64500</span>
                  </span>
                  <span className="timer is-warning" role="timer" aria-label="승인 남은 시간 9분 8초" style={{ minHeight: "26px", padding: "0 10px", fontSize: "13px" }}>
                    <i className="ic ic-clock" aria-hidden="true" />
                    9:08
                  </span>
                </span>
                {' '}
                <span className="t-xs muted">요청자 민호 · 20:03:20 KST · ASN 단위라 2인·재인증</span>
                {' '}
                <span className="link-more" style={{ fontSize: "13px" }}>
                  승인 화면 열기
                  <i className="ic ic-chevron-right" aria-hidden="true" />
                </span>
              </Link>
            </>
          ) : null}
          {' '}
          {v.asMinho ? (
            <>
              <Link to="/commands" className="card-flat" aria-current="true" style={{ display: "flex", flexDirection: "column", gap: "4px", padding: "12px 14px", color: "inherit", borderRadius: "var(--r-lg)", boxShadow: "inset 0 0 0 1px var(--border-primary)" }}>
                <span className="row between" style={{ gap: "8px", alignItems: "flex-start" }}>
                  <span className="t-sm fw-b">판매 재개(명령 3 되돌리기)</span>
                  <span className="timer is-warning" role="timer" aria-label="승인 남은 시간 9분 41초" style={{ minHeight: "26px", padding: "0 10px", fontSize: "13px" }}>
                    <i className="ic ic-clock" aria-hidden="true" />
                    9:41
                  </span>
                </span>
                {' '}
                <span className="t-xs muted">요청자 수진 · commander · 20:03:53 KST · 범위 전체</span>
                {' '}
                <span className="t-xs fw-b tx-link">오른쪽에 승인 화면이 열려 있습니다</span>
              </Link>
              <p className="t-xs muted">
                내가 요청한 명령 1건이 두 번째 승인을 기다립니다: 명령 4{' '}
                <span className="mono">AS64500</span>
                {' '}· 9:08 남음
              </p>
            </>
          ) : null}
          <p className="t-xs muted">10분 안에 승인하지 않으면 요청은 취소됩니다.</p>
        </div>
      </section>
      <section className="widget span-3" aria-labelledby="ff-t">
        <div className="widget-head"><h2 id="ff-t" style={{ fontSize: "13px", lineHeight: "18px" }}>비핵심 기능 · 명령 9</h2></div>
        <div className="widget-body" style={{ gap: "10px" }}>
          <label className="check-row" style={{ alignItems: "center", justifyContent: "space-between", fontSize: "14px" }}>
            <span>관람 후기</span>
            <input className="sw" type="checkbox" role="switch" defaultChecked aria-describedby="ff-h" />
          </label>
          {' '}
          <label className="check-row" style={{ alignItems: "center", justifyContent: "space-between", fontSize: "14px" }}>
            <span>좌석 추천</span>
            <input className="sw" type="checkbox" role="switch" defaultChecked aria-describedby="ff-h" />
          </label>
          {' '}
          <label className="check-row" style={{ alignItems: "center", justifyContent: "space-between", fontSize: "14px" }}>
            <span>찜하기</span>
            <input className="sw" type="checkbox" role="switch" defaultChecked aria-describedby="ff-h" />
          </label>
          <h3 className="eyebrow" style={{ marginTop: "4px" }}>배경 작업 멈춤</h3>
          <label className="check-row" style={{ alignItems: "center", justifyContent: "space-between", fontSize: "13px" }}>
            <span>일괄 환불의 새 묶음</span>
            <input className="sw" type="checkbox" role="switch" defaultChecked aria-describedby="ff-h" />
          </label>
          {' '}
          <label className="check-row" style={{ alignItems: "center", justifyContent: "space-between", fontSize: "13px" }}>
            <span>파트너 웹훅 재시도</span>
            <input className="sw" type="checkbox" role="switch" defaultChecked aria-describedby="ff-h" />
          </label>
          {' '}
          <label className="check-row" style={{ alignItems: "center", justifyContent: "space-between", fontSize: "13px" }}>
            <span>광고성 알림 묶음</span>
            <input className="sw" type="checkbox" role="switch" defaultChecked aria-describedby="ff-h" />
          </label>
          {' '}
          <label className="check-row" style={{ alignItems: "center", justifyContent: "space-between", fontSize: "13px" }}>
            <span>공연예술통합전산망 재전송</span>
            <input className="sw" type="checkbox" role="switch" defaultChecked aria-describedby="ff-h" />
          </label>
          <p className="t-xs muted" id="ff-h">끄면 사유와 dry-run을 거쳐 명령 9로 실행하고, 다시 켜기로 되돌립니다.</p>
        </div>
      </section>
    </div>
    <div className="grid-12" style={{ alignItems: "start" }}>
      <section className="span-4 col" style={{ gap: "10px" }} aria-labelledby="cat-t">
        <div className="row between">
          <h2 className="t-md fw-b" id="cat-t">명령 카탈로그</h2>
          <span className="t-xs muted">12종 · 1인 8 · 2인 2 · commander 1인 2</span>
        </div>
        <ul className="col" style={{ gap: "6px" }}>
          <li>
            <button className="card" type="button" style={{ display: "flex", gap: "10px", alignItems: "flex-start", width: "100%", padding: "8px 12px", borderRadius: "var(--r-lg)", textAlign: "left", cursor: "pointer" }}>
              <span className="badge badge-outline num" style={{ minWidth: "26px", justifyContent: "center" }} aria-hidden="true">1</span>
              <span className="col grow" style={{ gap: "2px" }}>
                <span className="t-sm fw-b">
                  <span className="sr-only">명령 1</span>
                  동시 입장 목표 조정
                </span>
                <span className="t-xs muted">1인 · 이 회차 한계 1,000~8,000명</span>
              </span>
              <span className="badge badge-success">적용 중</span>
            </button>
          </li>
          <li>
            <button className="card" type="button" style={{ display: "flex", gap: "10px", alignItems: "flex-start", width: "100%", padding: "8px 12px", borderRadius: "var(--r-lg)", textAlign: "left", cursor: "pointer" }}>
              <span className="badge badge-outline num" style={{ minWidth: "26px", justifyContent: "center" }} aria-hidden="true">2</span>
              <span className="col grow" style={{ gap: "2px" }}>
                <span className="t-sm fw-b">
                  <span className="sr-only">명령 2</span>
                  입장 일시정지
                </span>
                <span className="t-xs muted">1인 · 최대 10분, 연장하지 않으면 자동 만료</span>
              </span>
              {v.isPause ? (
                <>
                  <span className="badge badge-success">적용 중</span>
                </>
              ) : null}
            </button>
          </li>
          {v.card3Plain ? (
            <>
              <li>
                <button className="card" type="button" style={{ display: "flex", gap: "10px", alignItems: "flex-start", width: "100%", padding: "8px 12px", borderRadius: "var(--r-lg)", textAlign: "left", cursor: "pointer" }}>
                  <span className="badge badge-outline num" style={{ minWidth: "26px", justifyContent: "center" }} aria-hidden="true">3</span>
                  <span className="col grow" style={{ gap: "2px" }}>
                    <span className="t-sm fw-b">
                      <span className="sr-only">명령 3</span>
                      판매 일시정지(킬스위치)
                    </span>
                    <span className="t-xs muted">commander 1인 실행(재인증) · 재개 2인</span>
                  </span>
                </button>
              </li>
            </>
          ) : null}
          {' '}
          {v.cardIdle ? (
            <>
              <li>
                <button className="card is-selected" type="button" aria-current="true" style={{ display: "flex", gap: "10px", alignItems: "flex-start", width: "100%", padding: "8px 12px", borderRadius: "var(--r-lg)", textAlign: "left", cursor: "pointer" }}>
                  <span className="badge badge-outline num" style={{ minWidth: "26px", justifyContent: "center" }} aria-hidden="true">3</span>
                  <span className="col grow" style={{ gap: "2px" }}>
                    <span className="t-sm fw-b">
                      <span className="sr-only">명령 3</span>
                      판매 일시정지(킬스위치)
                    </span>
                    <span className="t-xs muted">commander 1인 실행(재인증) · 재개 2인</span>
                  </span>
                </button>
              </li>
            </>
          ) : null}
          {' '}
          {v.asMinho ? (
            <>
              <li>
                <button className="card is-selected" type="button" aria-current="true" aria-describedby="m3-why" style={{ display: "flex", gap: "10px", alignItems: "flex-start", width: "100%", padding: "8px 12px", borderRadius: "var(--r-lg)", textAlign: "left", cursor: "pointer" }}>
                  <span className="badge badge-outline num" style={{ minWidth: "26px", justifyContent: "center" }} aria-hidden="true">3</span>
                  <span className="col grow" style={{ gap: "3px" }}>
                    <span className="t-sm fw-b">
                      <span className="sr-only">명령 3</span>
                      판매 일시정지(킬스위치)
                    </span>
                    <span className="t-xs muted">commander 1인 실행(재인증) · 재개 2인</span>
                    <span className="row t-xs tx-warning" style={{ gap: "4px" }}>
                      <i className="ic ic-lock ic-14" aria-hidden="true" />
                      판매 재개가 승인 대기 중입니다(요청자 수진)
                    </span>
                  </span>
                  <span className="badge badge-warning">재개 승인 대기 9:41</span>
                </button>
                <p className="t-xs muted" id="m3-why" style={{ padding: "4px 0 0 48px" }}>판매 일시정지는 commander만 실행할 수 있습니다</p>
              </li>
            </>
          ) : null}
          {' '}
          {v.showProp ? (
            <>
              <li>
                <button className="card is-selected" type="button" aria-current="true" style={{ display: "flex", gap: "10px", alignItems: "flex-start", width: "100%", padding: "8px 12px", borderRadius: "var(--r-lg)", textAlign: "left", cursor: "pointer" }}>
                  <span className="badge badge-outline num" style={{ minWidth: "26px", justifyContent: "center" }} aria-hidden="true">3</span>
                  <span className="col grow" style={{ gap: "3px" }}>
                    <span className="t-sm fw-b">
                      <span className="sr-only">명령 3</span>
                      판매 일시정지(킬스위치)
                    </span>
                    <span className="t-xs muted">commander 1인 실행(재인증) · 재개 2인</span>
                    <span className="row t-xs tx-warning" style={{ gap: "4px" }}>
                      <i className="ic ic-lock ic-14" aria-hidden="true" />
                      명령 3이 전파 중입니다(실행 수진)
                    </span>
                  </span>
                  <span className="badge badge-primary">전파 중 4/5</span>
                </button>
              </li>
            </>
          ) : null}
          {' '}
          {v.showFail ? (
            <>
              <li>
                <button className="card is-selected" type="button" aria-current="true" style={{ display: "flex", gap: "10px", alignItems: "flex-start", width: "100%", padding: "8px 12px", borderRadius: "var(--r-lg)", textAlign: "left", cursor: "pointer" }}>
                  <span className="badge badge-outline num" style={{ minWidth: "26px", justifyContent: "center" }} aria-hidden="true">3</span>
                  <span className="col grow" style={{ gap: "3px" }}>
                    <span className="t-sm fw-b">
                      <span className="sr-only">명령 3</span>
                      판매 일시정지(킬스위치)
                    </span>
                    <span className="t-xs muted">commander 1인 실행(재인증) · 재개 2인</span>
                    <span className="t-xs tx-danger">ack 4/5 · 다시 보내기나 비상 런북이 필요합니다</span>
                  </span>
                  <span className="badge badge-danger">실패</span>
                </button>
              </li>
            </>
          ) : null}
          {' '}
          {v.isReport3 ? (
            <>
              <li>
                <button className="card is-selected" type="button" aria-current="true" style={{ display: "flex", gap: "10px", alignItems: "flex-start", width: "100%", padding: "8px 12px", borderRadius: "var(--r-lg)", textAlign: "left", cursor: "pointer" }}>
                  <span className="badge badge-outline num" style={{ minWidth: "26px", justifyContent: "center" }} aria-hidden="true">3</span>
                  <span className="col grow" style={{ gap: "3px" }}>
                    <span className="t-sm fw-b">
                      <span className="sr-only">명령 3</span>
                      판매 일시정지(킬스위치)
                    </span>
                    <span className="t-xs muted">commander 1인 실행(재인증) · 재개 2인</span>
                    <span className="t-xs tx-warning">사후 검토 보고서 작성 중 · 기한 10/16(금) 20:04 KST</span>
                  </span>
                  <span className="badge badge-success">적용 중</span>
                </button>
              </li>
            </>
          ) : null}
          <li>
            <button className="card" type="button" style={{ display: "flex", gap: "10px", alignItems: "flex-start", width: "100%", padding: "8px 12px", borderRadius: "var(--r-lg)", textAlign: "left", cursor: "pointer" }}>
              <span className="badge badge-outline num" style={{ minWidth: "26px", justifyContent: "center" }} aria-hidden="true">4</span>
              <span className="col grow" style={{ gap: "3px" }}>
                <span className="t-sm fw-b">
                  <span className="sr-only">명령 4</span>
                  ASN·IP 대역 차단
                </span>
                <span className="t-xs muted">1인(ASN·넓은 대역은 2인) · 최대 24시간</span>
                <span className="row t-xs tx-warning" style={{ gap: "4px" }}>
                  <i className="ic ic-lock ic-14" aria-hidden="true" />
                  명령 4가 승인 대기 중입니다(요청자 민호)
                </span>
              </span>
              <span className="badge badge-success">적용 중</span>
            </button>
          </li>
          {v.c5Rej ? (
            <>
              <li>
                <button className="card" type="button" style={{ display: "flex", gap: "10px", alignItems: "flex-start", width: "100%", padding: "8px 12px", borderRadius: "var(--r-lg)", textAlign: "left", cursor: "pointer" }}>
                  <span className="badge badge-outline num" style={{ minWidth: "26px", justifyContent: "center" }} aria-hidden="true">5</span>
                  <span className="col grow" style={{ gap: "2px" }}>
                    <span className="t-sm fw-b">
                      <span className="sr-only">명령 5</span>
                      봇 판정 강도
                    </span>
                    <span className="t-xs muted">2인 승인 · 재인증 · 완화·기본·강화</span>
                    <span className="t-xs muted">거부되었거나 승인 대기 10분이 지나 취소되었습니다</span>
                  </span>
                  <span className="badge">거부</span>
                </button>
              </li>
            </>
          ) : null}
          {' '}
          {v.asMinho ? (
            <>
              <li>
                <button className="card" type="button" aria-disabled="true" aria-describedby="m5-why" style={{ display: "flex", gap: "10px", alignItems: "flex-start", width: "100%", padding: "8px 12px", borderRadius: "var(--r-lg)", textAlign: "left", background: "var(--surface-muted)", cursor: "not-allowed" }}>
                  <span className="badge badge-outline num" style={{ minWidth: "26px", justifyContent: "center" }} aria-hidden="true">5</span>
                  <span className="col grow" style={{ gap: "2px" }}>
                    <span className="t-sm fw-b tx-disabled">
                      <span className="sr-only">명령 5</span>
                      봇 판정 강도
                    </span>
                    <span className="t-xs tx-disabled">2인 승인 · 재인증 · 완화·기본·강화</span>
                    <span className="t-xs muted">거부되었거나 승인 대기 10분이 지나 취소되었습니다</span>
                  </span>
                  <span className="badge">거부</span>
                </button>
                <p className="row t-xs muted" id="m5-why" style={{ gap: "4px", padding: "4px 0 0 48px" }}>
                  <i className="ic ic-lock ic-14" aria-hidden="true" />
                  commander만 요청할 수 있습니다
                </p>
              </li>
            </>
          ) : null}
          {' '}
          {v.isSet ? (
            <>
              <li>
                <button className="card is-selected" type="button" aria-current="true" style={{ display: "flex", gap: "10px", alignItems: "flex-start", width: "100%", padding: "8px 12px", borderRadius: "var(--r-lg)", textAlign: "left", cursor: "pointer" }}>
                  <span className="badge badge-outline num" style={{ minWidth: "26px", justifyContent: "center" }} aria-hidden="true">5</span>
                  <span className="col grow" style={{ gap: "3px" }}>
                    <span className="t-sm fw-b">
                      <span className="sr-only">명령 5</span>
                      봇 판정 강도
                    </span>
                    <span className="t-xs muted">2인 승인 · 재인증 · 완화·기본·강화</span>
                    <span className="t-xs num">기본 → 강화 · 판 18 · 민호 승인 {v.setAt} KST</span>
                  </span>
                  {v.setChk ? (
                    <>
                      <span className="badge badge-primary">적용 확인 중</span>
                    </>
                  ) : null}
                  {v.setOk ? (
                    <>
                      <span className="badge badge-success">
                        <i className="ic ic-check" aria-hidden="true" />
                        적용 확인됨
                      </span>
                    </>
                  ) : null}
                  {v.setNo ? (
                    <>
                      <span className="badge badge-warning">적용 확인 안 됨</span>
                    </>
                  ) : null}
                  {v.setUnk ? (
                    <>
                      <span className="badge badge-outline">확인할 수 없음</span>
                    </>
                  ) : null}
                  {v.setWait ? (
                    <>
                      <span className="badge badge-warning">보냄 · 전파 대기</span>
                    </>
                  ) : null}
                </button>
              </li>
            </>
          ) : null}
          {' '}
          {v.asSujin ? (
            <>
              <li>
                <button className="card" type="button" style={{ display: "flex", gap: "10px", alignItems: "flex-start", width: "100%", padding: "8px 12px", borderRadius: "var(--r-lg)", textAlign: "left", cursor: "pointer" }}>
                  <span className="badge badge-outline num" style={{ minWidth: "26px", justifyContent: "center" }} aria-hidden="true">6</span>
                  <span className="col grow" style={{ gap: "2px" }}>
                    <span className="t-sm fw-b">
                      <span className="sr-only">명령 6</span>
                      Degraded 전환
                    </span>
                    <span className="t-xs muted">2인 승인 · 재인증 · 표준 모드만</span>
                  </span>
                </button>
              </li>
            </>
          ) : null}
          {' '}
          {v.asMinho ? (
            <>
              <li>
                <button className="card" type="button" aria-disabled="true" aria-describedby="m6-why" style={{ display: "flex", gap: "10px", alignItems: "flex-start", width: "100%", padding: "8px 12px", borderRadius: "var(--r-lg)", textAlign: "left", background: "var(--surface-muted)", cursor: "not-allowed" }}>
                  <span className="badge badge-outline num" style={{ minWidth: "26px", justifyContent: "center" }} aria-hidden="true">6</span>
                  <span className="col grow" style={{ gap: "2px" }}>
                    <span className="t-sm fw-b tx-disabled">
                      <span className="sr-only">명령 6</span>
                      Degraded 전환
                    </span>
                    <span className="t-xs tx-disabled">2인 승인 · 재인증 · 표준 모드만</span>
                  </span>
                </button>
                <p className="row t-xs muted" id="m6-why" style={{ gap: "4px", padding: "4px 0 0 48px" }}>
                  <i className="ic ic-lock ic-14" aria-hidden="true" />
                  commander만 요청할 수 있습니다
                </p>
              </li>
            </>
          ) : null}
          <li>
            <button className="card" type="button" style={{ display: "flex", gap: "10px", alignItems: "flex-start", width: "100%", padding: "8px 12px", borderRadius: "var(--r-lg)", textAlign: "left", cursor: "pointer" }}>
              <span className="badge badge-outline num" style={{ minWidth: "26px", justifyContent: "center" }} aria-hidden="true">7</span>
              <span className="col grow" style={{ gap: "2px" }}>
                <span className="t-sm fw-b">
                  <span className="sr-only">명령 7</span>
                  대기실 공지 배너
                </span>
                <span className="t-xs muted">1인 · 승인된 템플릿만</span>
              </span>
              <span className="badge">되돌림</span>
            </button>
          </li>
          <li>
            <button className="card" type="button" style={{ display: "flex", gap: "10px", alignItems: "flex-start", width: "100%", padding: "8px 12px", borderRadius: "var(--r-lg)", textAlign: "left", cursor: "pointer" }}>
              <span className="badge badge-outline num" style={{ minWidth: "26px", justifyContent: "center" }} aria-hidden="true">8</span>
              <span className="col grow" style={{ gap: "2px" }}>
                <span className="t-sm fw-b">
                  <span className="sr-only">명령 8</span>
                  로그 레벨
                </span>
                <span className="t-xs muted">1인 · 30분 뒤 자동 복귀</span>
              </span>
              <span className="badge">자동 만료</span>
            </button>
          </li>
          <li>
            <button className="card" type="button" style={{ display: "flex", gap: "10px", alignItems: "flex-start", width: "100%", padding: "8px 12px", borderRadius: "var(--r-lg)", textAlign: "left", cursor: "pointer" }}>
              <span className="badge badge-outline num" style={{ minWidth: "26px", justifyContent: "center" }} aria-hidden="true">9</span>
              <span className="col grow" style={{ gap: "2px" }}>
                <span className="t-sm fw-b">
                  <span className="sr-only">명령 9</span>
                  비핵심 기능 끄기
                </span>
                <span className="t-xs muted">1인 · 비핵심 목록만</span>
              </span>
            </button>
          </li>
          <li>
            <Link to="/commands" className="card" style={{ display: "flex", gap: "10px", alignItems: "flex-start", width: "100%", padding: "8px 12px", borderRadius: "var(--r-lg)", color: "inherit" }}>
              <span className="badge badge-outline num" style={{ minWidth: "26px", justifyContent: "center" }} aria-hidden="true">10</span>
              <span className="col grow" style={{ gap: "3px" }}>
                <span className="t-sm fw-b">
                  <span className="sr-only">명령 10</span>
                  게시물 노출 차단
                </span>
                <span className="t-xs muted">1인 · 공문에 적힌 ID만</span>
                <span className="link-more" style={{ fontSize: "12px" }}>
                  법정 조치에서 통보 건으로 실행합니다
                  <i className="ic ic-chevron-right" aria-hidden="true" />
                </span>
              </span>
            </Link>
          </li>
          {v.c11Plain ? (
            <>
              <li>
                <button className="card" type="button" style={{ display: "flex", gap: "10px", alignItems: "flex-start", width: "100%", padding: "8px 12px", borderRadius: "var(--r-lg)", textAlign: "left", cursor: "pointer" }}>
                  <span className="badge badge-outline num" style={{ minWidth: "26px", justifyContent: "center" }} aria-hidden="true">11</span>
                  <span className="col grow" style={{ gap: "2px" }}>
                    <span className="t-sm fw-b">
                      <span className="sr-only">명령 11</span>
                      자동화 정지 스위치(오토스케일 제외)
                    </span>
                    <span className="t-xs muted">commander 1인 긴급 · 재인증 · 재개 2인</span>
                  </span>
                </button>
              </li>
            </>
          ) : null}
          {' '}
          {v.isReport ? (
            <>
              <li>
                <button className="card is-selected" type="button" aria-current="true" style={{ display: "flex", gap: "10px", alignItems: "flex-start", width: "100%", padding: "8px 12px", borderRadius: "var(--r-lg)", textAlign: "left", cursor: "pointer" }}>
                  <span className="badge badge-outline num" style={{ minWidth: "26px", justifyContent: "center" }} aria-hidden="true">11</span>
                  <span className="col grow" style={{ gap: "3px" }}>
                    <span className="t-sm fw-b">
                      <span className="sr-only">명령 11</span>
                      자동화 정지 스위치(오토스케일 제외)
                    </span>
                    <span className="t-xs muted">commander 1인 긴급 · 재인증 · 재개 2인</span>
                    <span className="t-xs tx-warning">사후 검토 보고서 작성 중 · 기한 10/16(금) 20:04 KST</span>
                  </span>
                  <span className="badge badge-success">적용 중</span>
                </button>
              </li>
            </>
          ) : null}
          {' '}
          {v.asMinho ? (
            <>
              <li>
                <button className="card" type="button" aria-disabled="true" aria-describedby="m11-why" style={{ display: "flex", gap: "10px", alignItems: "flex-start", width: "100%", padding: "8px 12px", borderRadius: "var(--r-lg)", textAlign: "left", background: "var(--surface-muted)", cursor: "not-allowed" }}>
                  <span className="badge badge-outline num" style={{ minWidth: "26px", justifyContent: "center" }} aria-hidden="true">11</span>
                  <span className="col grow" style={{ gap: "2px" }}>
                    <span className="t-sm fw-b tx-disabled">
                      <span className="sr-only">명령 11</span>
                      자동화 정지 스위치(오토스케일 제외)
                    </span>
                    <span className="t-xs tx-disabled">commander 1인 긴급 · 재인증 · 재개 2인</span>
                  </span>
                </button>
                <p className="row t-xs muted" id="m11-why" style={{ gap: "4px", padding: "4px 0 0 48px" }}>
                  <i className="ic ic-lock ic-14" aria-hidden="true" />
                  commander만 실행할 수 있습니다
                </p>
              </li>
            </>
          ) : null}
          <li>
            <button className="card" type="button" aria-disabled="true" aria-describedby="c12-why" style={{ display: "flex", gap: "10px", alignItems: "flex-start", width: "100%", padding: "8px 12px", borderRadius: "var(--r-lg)", textAlign: "left", background: "var(--surface-muted)", cursor: "not-allowed" }}>
              <span className="badge badge-outline num" style={{ minWidth: "26px", justifyContent: "center" }} aria-hidden="true">12</span>
              <span className="col grow" style={{ gap: "2px" }}>
                <span className="t-sm fw-b tx-disabled">
                  <span className="sr-only">명령 12</span>
                  결제사 지정
                </span>
                <span className="t-xs tx-disabled">1인 · T-10분~T+60분 밖에서만</span>
              </span>
              <i className="ic ic-clock ic-16 tx-disabled" aria-hidden="true" />
            </button>
            <p className="t-xs muted" id="c12-why" style={{ padding: "4px 0 0 48px" }}>온세일 윈도우 안이라 21:00 KST부터 바꿀 수 있습니다</p>
          </li>
        </ul>
      </section>
      <section className="widget span-8" aria-label="실행·승인 패널">
        {v.showCompose ? (
          <>
            <div className="col">
              <div className="widget-head" style={{ minHeight: "52px", gap: "10px" }}>
                <span className="badge badge-outline num" style={{ minWidth: "26px", justifyContent: "center" }} aria-hidden="true">3</span>
                <h2 className="t-md fw-b">
                  <span className="sr-only">명령 3</span>
                  판매 일시정지(킬스위치) · 요청 작성
                </h2>
                <span className="badge badge-warning">commander 1인</span>
                <span className="badge">재인증</span>
                <div className="actions"><span className="t-xs muted">작성 수진 · commander</span></div>
              </div>
              <div className="widget-body" style={{ gap: "16px", padding: "16px" }}>
                <nav className="stepper" aria-label="명령 진행 단계">
                  <span className="step is-done">
                    <span className="step-num"><i className="ic ic-check" aria-hidden="true" /></span>
                    <span className="sr-only">완료:</span>
                    사유
                  </span>
                  <span className="step-line is-done" />
                  {' '}
                  <span className="step is-done">
                    <span className="step-num"><i className="ic ic-check" aria-hidden="true" /></span>
                    <span className="sr-only">완료:</span>
                    파라미터
                  </span>
                  <span className="step-line is-done" />
                  {' '}
                  <span className="step is-current" aria-current="step">
                    <span className="step-num">3</span>
                    dry-run
                  </span>
                  <span className="step-line" />
                  {' '}
                  <span className="step">
                    <span className="step-num">4</span>
                    재인증
                  </span>
                  <span className="step-line" />
                  {' '}
                  <span className="step">
                    <span className="step-num">5</span>
                    전파 ack
                  </span>
                </nav>
                <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)", gap: "20px", alignItems: "start" }}>
                  <div className="col" style={{ gap: "16px" }}>
                    <div className="field">
                      <label className="label" htmlFor="c3-reason">
                        ① 실행 사유{' '}
                        <span className="opt">(필수)</span>
                      </label>
                      {' '}
                      <textarea className="textarea" id="c3-reason" aria-describedby="c3-reason-h c3-reason-c" style={{ minHeight: "124px", fontSize: "14px", lineHeight: "21px" }} defaultValue="결제사 승인 응답이 늦어 결과 불명 주문이 늘고 있습니다. 원인을 확인하는 동안 10/25(일) 18:00 회차의 새 좌석 홀드와 결제 접수를 멈춥니다. 처리 중 결제는 완결합니다." />
                      <div className="row between" style={{ gap: "8px", alignItems: "flex-start" }}>
                        <span className="hint" id="c3-reason-h">사유는 감사 로그와 사후 검토 보고서에 그대로 남습니다</span>
                        <span className="counter" id="c3-reason-c" aria-live="polite">101자</span>
                      </div>
                    </div>
                    <fieldset className="col" style={{ gap: "10px" }}>
                      <legend className="label" style={{ marginBottom: "8px" }}>② 파라미터 · 범위</legend>
                      <div className="row" style={{ gap: "20px" }}>
                        <label className="check-row" style={{ fontSize: "14px" }}>
                          <input className="rd" type="radio" name="c3-scope" defaultChecked />
                          회차
                        </label>
                        {' '}
                        <label className="check-row" style={{ fontSize: "14px" }}>
                          <input className="rd" type="radio" name="c3-scope" />
                          전체 회차
                        </label>
                      </div>
                      <div className="field">
                        <label className="label" htmlFor="c3-round">회차</label>
                        <div className="input-group input-group-sm">
                          <select id="c3-round" defaultValue="LUMEN 콘서트 2026 서울 · 10/25(일) 18:00">
                            <option>LUMEN 콘서트 2026 서울 · 10/25(일) 18:00</option>
                            <option>LUMEN 콘서트 2026 서울 · 10/26(월) 17:00</option>
                          </select>
                          <i className="ic ic-chevron-down ic-16" aria-hidden="true" />
                        </div>
                      </div>
                    </fieldset>
                    <div className="table-wrap">
                      <table className="table dense" aria-label="명령 3 정의">
                        <tbody>
                          <tr>
                            <th scope="row" style={{ width: "92px" }}>파라미터</th>
                            <td>범위(회차 하나 이상·전체)</td>
                          </tr>
                          <tr>
                            <th scope="row">안전 한계</th>
                            <td>처리 중 결제는 완결, 범위 안 입장도 멈춤, 굿즈 제외, 만료 없음</td>
                          </tr>
                          <tr>
                            <th scope="row">승인</th>
                            <td>commander 1인 실행(재인증). 실행하면 인시던트 선언 기준이 되고 사후 검토 보고서를 씁니다</td>
                          </tr>
                          <tr>
                            <th scope="row">되돌리기</th>
                            <td>재개 2인</td>
                          </tr>
                          <tr>
                            <th scope="row">전달 경로</th>
                            <td>제어 전용 gRPC → purchase-svc 준비된 모든 파드 · admission-ctrl 리더 · queue-svc</td>
                          </tr>
                        </tbody>
                      </table>
                    </div>
                  </div>
                  <div className="col" style={{ gap: "12px" }}>
                    <section className="card-flat" role="region" aria-labelledby="dr1-t" style={{ display: "flex", flexDirection: "column", gap: "10px", padding: "14px", borderRadius: "var(--r-lg)" }}>
                      <div className="row between" style={{ gap: "8px" }}>
                        <h3 className="t-sm fw-b" id="dr1-t">③ dry-run 결과</h3>
                        <span className="badge badge-success">
                          <i className="ic ic-check" aria-hidden="true" />
                          준비됨 20:04:05 KST
                        </span>
                      </div>
                      <dl className="kv" style={{ fontSize: "13px", lineHeight: "18px", gap: "6px 12px" }}>
                        <dt>적용 대상 서비스</dt>
                        <dd>purchase-svc 3 · admission-ctrl 리더 1 · queue-svc 1 · 제어 전용 gRPC</dd>
                        <dt>범위</dt>
                        <dd>10/25(일) 18:00 회차</dd>
                        <dt>진행 중 결제 세션</dt>
                        <dd>312건 · 이미 접수된 결제는 완결</dd>
                        <dt>입장</dt>
                        <dd>입장(serving 전진) 멈춤 · 입장해 있는 구매 세션 980건(무활동 만료 멈춤)</dd>
                        <dt>대기 순서</dt>
                        <dd>그대로 유지</dd>
                      </dl>
                      <div className="table-wrap">
                        <table className="table dense" aria-label="예상 트래픽 변동">
                          <thead>
                            <tr>
                              <th scope="col">예상 트래픽 변동</th>
                              <th scope="col" className="r">지금</th>
                              <th scope="col" className="r">실행 뒤</th>
                            </tr>
                          </thead>
                          <tbody>
                            <tr>
                              <td>새 좌석 홀드</td>
                              <td className="r">초당 약 52건</td>
                              <td className="r">0건</td>
                            </tr>
                            <tr>
                              <td>새 결제 접수</td>
                              <td className="r">초당 약 11건</td>
                              <td className="r">0건</td>
                            </tr>
                            <tr>
                              <td>팬 화면 응답</td>
                              <td className="r">정상</td>
                              <td className="r">423 안내</td>
                            </tr>
                          </tbody>
                        </table>
                      </div>
                      <p className="t-xs muted">팬 화면 안내: "판매가 잠시 멈췄습니다. 고른 좌석은 홀드 시간 동안 유지됩니다"</p>
                    </section>
                    <ol className="col" style={{ gap: "8px" }} aria-label="다음 단계">
                      <li className="row" style={{ gap: "8px", alignItems: "flex-start" }}>
                        <span className="badge num" aria-hidden="true">4</span>
                        <span className="t-xs muted">실행 직전에 비밀번호와 인증 앱 코드로 다시 인증하고, 등록한 패스키로 한 번 더 확인합니다(5분 재인증 토큰).</span>
                      </li>
                      <li className="row" style={{ gap: "8px", alignItems: "flex-start" }}>
                        <span className="badge num" aria-hidden="true">5</span>
                        <span className="t-xs muted">
                          재인증하면 바로 전파합니다. 전파 뒤 대상 5개(purchase-svc 3·admission-ctrl 리더·queue-svc)의 ack를 3초 안에 받습니다. 3초를 넘으면 늦어짐, 10초가 지나면 실패로 알리고 다시 보내기와 비상 런북을 안내합니다.
                        </span>
                      </li>
                    </ol>
                  </div>
                </div>
                <div className="row wrap" style={{ gap: "12px", paddingTop: "14px", borderTop: "1px solid var(--border)" }}>
                  <button className="btn btn-danger btn-lg" type="button">
                    <i className="ic ic-stop" aria-hidden="true" />
                    판매를 전면 중단합니다
                  </button>
                  {' '}
                  <span className="t-xs muted" style={{ maxWidth: "320px" }}>
                    누르면 위험 확인과 재인증을 거쳐 바로 전파합니다. 실행하면 인시던트 선언 기준이 되고 48시간 안에 사후 검토 보고서를 씁니다. 되돌리기(판매 재개)는 2인 승인입니다.
                  </span>
                </div>
              </div>
            </div>
          </>
        ) : null}
        {' '}
        {v.showApprove ? (
          <>
            <div className="col">
              <div className="widget-head" style={{ minHeight: "52px", gap: "10px" }}>
                <span className="badge badge-outline num" style={{ minWidth: "26px", justifyContent: "center" }} aria-hidden="true">3</span>
                <h2 className="t-md fw-b">
                  <span className="sr-only">명령 3</span>
                  판매 재개(명령 3 되돌리기) · 두 번째 승인
                </h2>
                <div className="actions"><span className="badge badge-warning">재개 승인 대기 9:41</span></div>
              </div>
              <div className="widget-body" style={{ gap: "16px", padding: "16px" }}>
                <nav className="stepper" aria-label="명령 진행 단계">
                  <span className="step is-done">
                    <span className="step-num"><i className="ic ic-check" aria-hidden="true" /></span>
                    <span className="sr-only">완료:</span>
                    사유
                  </span>
                  <span className="step-line is-done" />
                  {' '}
                  <span className="step is-done">
                    <span className="step-num"><i className="ic ic-check" aria-hidden="true" /></span>
                    <span className="sr-only">완료:</span>
                    파라미터
                  </span>
                  <span className="step-line is-done" />
                  {' '}
                  <span className="step is-done">
                    <span className="step-num"><i className="ic ic-check" aria-hidden="true" /></span>
                    <span className="sr-only">완료:</span>
                    dry-run
                  </span>
                  <span className="step-line is-done" />
                  {' '}
                  <span className="step is-done">
                    <span className="step-num"><i className="ic ic-check" aria-hidden="true" /></span>
                    <span className="sr-only">완료:</span>
                    재인증
                  </span>
                  <span className="step-line is-done" />
                  {' '}
                  <span className="step is-current" aria-current="step">
                    <span className="step-num">5</span>
                    2인 승인
                  </span>
                  <span className="step-line" />
                  {' '}
                  <span className="step">
                    <span className="step-num">6</span>
                    전파 ack
                  </span>
                </nav>
                <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)", gap: "20px", alignItems: "start" }}>
                  <div className="col" style={{ gap: "12px" }}>
                    <section className="col" style={{ gap: "8px" }} aria-labelledby="rq-t">
                      <h3 className="t-sm fw-b" id="rq-t">요청 내용 · 원문 그대로</h3>
                      <div className="table-wrap">
                        <table className="table dense" aria-label="요청 내용">
                          <tbody>
                            <tr>
                              <th scope="row" style={{ width: "84px" }}>요청자</th>
                              <td>수진 · commander</td>
                            </tr>
                            <tr>
                              <th scope="row">요청 시각</th>
                              <td className="num">20:03:53 KST · 요청자 재인증 20:03:49 KST</td>
                            </tr>
                            <tr>
                              <th scope="row">회차·범위</th>
                              <td>전체 회차(진행 중 3) · 범위 전체</td>
                            </tr>
                            <tr>
                              <th scope="row">되돌릴 명령</th>
                              <td>명령 3 판매 일시정지 · 수진 실행 20:01:40 KST</td>
                            </tr>
                          </tbody>
                        </table>
                      </div>
                      <span className="label" id="rq-reason-l">사유</span>
                      <blockquote className="code" aria-labelledby="rq-reason-l" style={{ fontFamily: "var(--font)", fontSize: "14px", lineHeight: "21px", whiteSpace: "normal" }}>
                        결제사 승인 응답이 정상으로 돌아왔습니다(승인 호출 p99 1.2초). 동시 입장 목표를 1,000명으로 낮춰 둔 채 판매를 다시 엽니다.
                      </blockquote>
                    </section>
                    <section className="card-flat" role="region" aria-labelledby="dr2-t" style={{ display: "flex", flexDirection: "column", gap: "10px", padding: "14px", borderRadius: "var(--r-lg)" }}>
                      <div className="row between" style={{ gap: "8px" }}>
                        <h3 className="t-sm fw-b" id="dr2-t">dry-run 결과 · 요청 때 그대로</h3>
                        <span className="badge">20:03:51 KST 계산</span>
                      </div>
                      <dl className="kv" style={{ fontSize: "13px", lineHeight: "18px", gap: "6px 12px" }}>
                        <dt>적용 대상 서비스</dt>
                        <dd>purchase-svc 3 · admission-ctrl 리더 1 · queue-svc 1 · 제어 전용 gRPC</dd>
                        <dt>범위</dt>
                        <dd>전체 회차(진행 중 3)</dd>
                        <dt>판매 멈춘 시간</dt>
                        <dd>2분 11초 · 멈춘 동안 새 홀드·결제 접수 0건</dd>
                        <dt>입장</dt>
                        <dd>세 회차 입장(serving 전진) 다시 시작 · LUMEN 동시 입장 목표 1,000명(명령 1)</dd>
                        <dt>대기 순서</dt>
                        <dd>그대로 유지</dd>
                      </dl>
                      <div className="table-wrap">
                        <table className="table dense" aria-label="예상 트래픽 변동">
                          <thead>
                            <tr>
                              <th scope="col">예상 트래픽 변동</th>
                              <th scope="col" className="r">요청 때</th>
                              <th scope="col" className="r">실행 뒤</th>
                            </tr>
                          </thead>
                          <tbody>
                            <tr>
                              <td>새 좌석 홀드</td>
                              <td className="r">0건</td>
                              <td className="r">초당 약 30건</td>
                            </tr>
                            <tr>
                              <td>새 결제 접수</td>
                              <td className="r">0건</td>
                              <td className="r">초당 약 6건</td>
                            </tr>
                            <tr>
                              <td>팬 화면 응답</td>
                              <td className="r">423 안내</td>
                              <td className="r">정상</td>
                            </tr>
                          </tbody>
                        </table>
                      </div>
                    </section>
                  </div>
                  <div className="col" style={{ gap: "12px" }}>
                    <section className="card" aria-labelledby="ap-t" style={{ display: "flex", flexDirection: "column", gap: "10px", padding: "14px 16px", borderRadius: "var(--r-lg)", borderColor: "var(--warning)" }}>
                      <h3 className="t-sm fw-b" id="ap-t">
                        두 번째 승인을 기다리는 중 ·{' '}
                        <span className="num" role="timer" aria-label="승인 남은 시간 9분 41초">9:41</span>
                        {' '}남음
                      </h3>
                      <p className="t-xs muted">10분 안에 승인하지 않으면 요청은 취소됩니다. 승인하면 바로 전파합니다.</p>
                      <p className="t-sm fw-b" id="ap-sum" style={{ padding: "10px 12px", borderRadius: "var(--r-md)", background: "var(--surface-muted)" }}>
                        <span className="sr-only">승인 대상:</span>
                        판매 재개 · 범위 전체 · 요청 수진
                      </p>
                      <button className="btn btn-primary btn-block" type="button" aria-describedby="ap-sum">
                        <i className="ic ic-play" aria-hidden="true" />
                        승인
                      </button>
                      {' '}
                      <button className="btn btn-outline btn-block" type="button">거부(사유 필수)</button>
                    </section>
                    <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="ra-t" aria-describedby="ra-d" style={{ maxWidth: "none", padding: "18px", gap: "12px", border: "1px solid var(--border)" }}>
                      <div className="row" style={{ gap: "8px" }}>
                        <i className="ic ic-key" aria-hidden="true" />
                        <h3 className="t-md fw-b" id="ra-t">승인하려면 다시 인증합니다</h3>
                      </div>
                      <p className="t-xs muted" id="ra-d">
                        판매 재개(명령 3 되돌리기) · 요청자 수진. 비밀번호와 인증 앱 코드로 다시 인증하고, 등록한 패스키로 한 번 더 확인하면 5분 동안 쓰는 재인증 토큰을 받고 바로 승인합니다.
                      </p>
                      {v.pkStep1 ? (
                        <>
                          <div className="field">
                            <label className="label" htmlFor="ra-pw">비밀번호</label>
                            <input className="input input-sm" id="ra-pw" type="password" autoComplete="current-password" defaultValue="xxxxxxxxxxxxxxxx" />
                          </div>
                          <div className="field">
                            <label className="label" htmlFor="ra-otp">인증 앱 코드 6자리</label>
                            {' '}
                            <input className="otp-input" id="ra-otp" type="text" inputMode="numeric" autoComplete="one-time-code" maxLength={6} pattern="[0-9]*" defaultValue="48190" />
                          </div>
                          <p className="row t-sm" style={{ gap: "8px", alignItems: "center" }}>
                            <i className="ic ic-key ic-16" aria-hidden="true" />
                            등록한 패스키로 한 번 더 확인합니다
                          </p>
                          <div className="row" style={{ gap: "8px", justifyContent: "flex-end" }}>
                            <button className="btn btn-ghost btn-sm" type="button">닫기</button>
                            <button className="btn btn-primary btn-sm" type="button">인증하고 계속</button>
                          </div>
                        </>
                      ) : null}
                      {' '}
                      {v.pkStep2 ? (
                        <>
                          <p className="row wrap t-xs" style={{ gap: "6px 8px", alignItems: "center" }}>
                            <span className="badge badge-success">
                              <i className="ic ic-check" aria-hidden="true" />
                              비밀번호·인증 앱 코드 확인
                            </span>
                            <span className="muted">2단계 중 2단계</span>
                          </p>
                          <p className="row t-sm" style={{ gap: "8px", alignItems: "center" }}>
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
                          {' '}
                          {v.pkNone ? (
                            <>
                              <p className="error-msg" role="alert" id="ra-none">
                                <i className="ic ic-alert-circle" aria-hidden="true" />
                                등록한 패스키가 없습니다. 내 계정에서 등록하거나, 기기를 잃었으면 운영자에게 재등록을 요청하세요
                              </p>
                            </>
                          ) : null}
                          {' '}
                          {v.pkHave ? (
                            <>
                              <div className="row" style={{ gap: "8px", justifyContent: "flex-end" }}>
                                <button className="btn btn-ghost btn-sm" type="button">닫기</button>
                                <button className="btn btn-primary btn-sm" type="button">
                                  <i className="ic ic-key" aria-hidden="true" />
                                  패스키로 확인
                                </button>
                              </div>
                              <p className="t-xs muted">패스키 창은 브라우저가 띄웁니다. 확인하면 바로 승인하고 전파합니다.</p>
                            </>
                          ) : null}
                          {' '}
                          {v.pkNone ? (
                            <>
                              <Link to="/me" className="link-more" style={{ fontSize: "13px", alignSelf: "flex-start" }}>
                                내 계정 열기
                                <i className="ic ic-chevron-right" aria-hidden="true" />
                              </Link>
                              <div className="row" style={{ gap: "8px", justifyContent: "flex-end" }}>
                                <button className="btn btn-ghost btn-sm" type="button">닫기</button>
                                <button className="btn btn-primary btn-sm" type="button" aria-disabled="true" aria-describedby="ra-none">
                                  <i className="ic ic-key" aria-hidden="true" />
                                  패스키로 확인
                                </button>
                              </div>
                            </>
                          ) : null}
                        </>
                      ) : null}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </>
        ) : null}
        {' '}
        {v.showProp ? (
          <>
            <div className="col">
              <div className="widget-head" style={{ minHeight: "52px", gap: "10px" }}>
                <span className="badge badge-outline num" style={{ minWidth: "26px", justifyContent: "center" }} aria-hidden="true">3</span>
                <h2 className="t-md fw-b">
                  <span className="sr-only">명령 3</span>
                  판매 일시정지(킬스위치) · 전파
                </h2>
                <div className="actions"><span className="badge badge-primary">전파 중 4/5</span></div>
              </div>
              <div className="widget-body" style={{ gap: "16px", padding: "16px" }}>
                <nav className="stepper" aria-label="명령 진행 단계">
                  <span className="step is-done">
                    <span className="step-num"><i className="ic ic-check" aria-hidden="true" /></span>
                    <span className="sr-only">완료:</span>
                    사유
                  </span>
                  <span className="step-line is-done" />
                  {' '}
                  <span className="step is-done">
                    <span className="step-num"><i className="ic ic-check" aria-hidden="true" /></span>
                    <span className="sr-only">완료:</span>
                    파라미터
                  </span>
                  <span className="step-line is-done" />
                  {' '}
                  <span className="step is-done">
                    <span className="step-num"><i className="ic ic-check" aria-hidden="true" /></span>
                    <span className="sr-only">완료:</span>
                    dry-run
                  </span>
                  <span className="step-line is-done" />
                  {' '}
                  <span className="step is-done">
                    <span className="step-num"><i className="ic ic-check" aria-hidden="true" /></span>
                    <span className="sr-only">완료:</span>
                    재인증
                  </span>
                  <span className="step-line is-done" />
                  {' '}
                  <span className="step is-current" aria-current="step">
                    <span className="step-num">5</span>
                    전파 ack
                  </span>
                </nav>
                <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)", gap: "20px", alignItems: "start" }}>
                  <section className="col" style={{ gap: "8px" }} aria-labelledby="rec-t">
                    <h3 className="t-sm fw-b" id="rec-t">실행 기록</h3>
                    <div className="table-wrap">
                      <table className="table dense" aria-label="실행 기록">
                        <tbody>
                          <tr>
                            <th scope="row" style={{ width: "76px" }}>실행</th>
                            <td>수진 · commander · 20:04:09 KST · 재인증 · 1인</td>
                          </tr>
                          <tr>
                            <th scope="row">사후 검토</th>
                            <td>인시던트 선언 기준 · 보고서 기한 10/16(금) 20:04 KST(48시간)</td>
                          </tr>
                          <tr>
                            <th scope="row">회차·범위</th>
                            <td>10/25(일) 18:00 · 회차</td>
                          </tr>
                          <tr>
                            <th scope="row">사유</th>
                            <td>결제사 승인 응답이 늦어 결과 불명 주문이 늘고 있습니다. 원인을 확인하는 동안 10/25(일) 18:00 회차의 새 좌석 홀드와 결제 접수를 멈춥니다. 처리 중 결제는 완결합니다.</td>
                          </tr>
                          <tr>
                            <th scope="row">명령 ID</th>
                            <td>
                              <span className="row" style={{ gap: "6px" }}>
                                <span className="hash">01929f3c-7a1e-7b42-9c3d-6e2a8f4b1d05</span>
                                <button className="icon-btn icon-btn-sm" type="button" aria-label="명령 ID 복사">
                                  <i className="ic ic-copy" aria-hidden="true" />
                                </button>
                              </span>
                            </td>
                          </tr>
                        </tbody>
                      </table>
                    </div>
                  </section>
                  <section className="col" style={{ gap: "10px" }} aria-labelledby="ack-t">
                    <div className="row between">
                      <h3 className="t-sm fw-b" id="ack-t">⑤ 전파 ack</h3>
                      <span className="t-sm fw-b num">4/5</span>
                    </div>
                    <div className="progress" role="progressbar" aria-label="전파 ack 진행" aria-valuemin={0} aria-valuemax={5} aria-valuenow={4} aria-valuetext="대상 5개 중 4개 ack">
                      <span style={{ width: "80%" }} />
                    </div>
                    <ul className="col">
                      <li className="row" style={{ gap: "10px", padding: "10px 0", borderBottom: "1px solid var(--border)" }}>
                        <i className="ic ic-check-circle ic-16 tx-success" aria-hidden="true" />
                        <span className="mono t-sm grow">admission-ctrl 리더</span>
                        <span className="t-xs muted num">0.4초</span>
                        <span className="badge badge-success">ack</span>
                      </li>
                      <li className="row" style={{ gap: "10px", padding: "10px 0", borderBottom: "1px solid var(--border)" }}>
                        <i className="ic ic-check-circle ic-16 tx-success" aria-hidden="true" />
                        <span className="mono t-sm grow">queue-svc</span>
                        <span className="t-xs muted num">0.5초</span>
                        <span className="badge badge-success">ack</span>
                      </li>
                      <li className="row" style={{ gap: "10px", padding: "10px 0", borderBottom: "1px solid var(--border)" }}>
                        <i className="ic ic-check-circle ic-16 tx-success" aria-hidden="true" />
                        <span className="mono t-sm grow">purchase-svc-1</span>
                        <span className="t-xs muted num">0.6초</span>
                        <span className="badge badge-success">ack</span>
                      </li>
                      <li className="row" style={{ gap: "10px", padding: "10px 0", borderBottom: "1px solid var(--border)" }}>
                        <i className="ic ic-check-circle ic-16 tx-success" aria-hidden="true" />
                        <span className="mono t-sm grow">purchase-svc-2</span>
                        <span className="t-xs muted num">1.1초</span>
                        <span className="badge badge-success">ack</span>
                      </li>
                      {v.notDelay ? (
                        <>
                          <li className="row" style={{ gap: "10px", padding: "10px 0", borderBottom: "1px solid var(--border)" }}>
                            <span className="spinner tx-link" aria-hidden="true" />
                            <span className="mono t-sm grow">purchase-svc-3</span>
                            <span className="t-xs muted num">1.4초 경과</span>
                            <span className="badge badge-primary">전파 중</span>
                          </li>
                        </>
                      ) : null}
                      {v.isDelay ? (
                        <>
                          <li className="row" style={{ gap: "10px", padding: "10px 0", borderBottom: "1px solid var(--border)" }}>
                            <span className="spinner tx-link" aria-hidden="true" />
                            <span className="mono t-sm grow">purchase-svc-3</span>
                            <span className="t-xs tx-warning num">3.6초 경과</span>
                            <span className="badge badge-warning">늦음</span>
                          </li>
                        </>
                      ) : null}
                    </ul>
                    {v.notDelay ? (
                      <>
                        <p className="t-sm" role="status" aria-live="polite">전파 중 · ack 4/5 · 3초 안에 모두 받으면 적용 중으로 바뀝니다.</p>
                      </>
                    ) : null}
                    {v.isDelay ? (
                      <>
                        <p className="t-sm tx-warning" role="status" aria-live="polite">
                          전파가 늦어지고 있습니다 · ack 4/5 · purchase-svc-3이 3초 안에 ack를 보내지 않았습니다. 10초가 지나면 실패로 알리고 다시 보내기와 비상 런북을 안내합니다.
                        </p>
                      </>
                    ) : null}
                    <p className="t-xs muted">ack한 파드부터 새 좌석 홀드와 결제 접수를 막습니다. 팬 화면 안내: "판매가 잠시 멈췄습니다. 고른 좌석은 홀드 시간 동안 유지됩니다"</p>
                  </section>
                </div>
                <div className="row wrap" style={{ gap: "12px", paddingTop: "14px", borderTop: "1px solid var(--border)" }}>
                  <button className="btn btn-outline" type="button" aria-disabled="true" aria-describedby="rv-why">
                    <i className="ic ic-undo" aria-hidden="true" />
                    판매 재개를 요청합니다(2인 승인)
                  </button>
                  {' '}
                  <span className="t-xs muted" id="rv-why">모든 파드가 ack한 뒤 되돌릴 수 있습니다. 재개는 2인 승인과 재인증을 거칩니다.</span>
                </div>
              </div>
            </div>
          </>
        ) : null}
        {' '}
        {v.showFail ? (
          <>
            <div className="col">
              <div className="widget-head" style={{ minHeight: "52px", gap: "10px" }}>
                <span className="badge badge-outline num" style={{ minWidth: "26px", justifyContent: "center" }} aria-hidden="true">3</span>
                <h2 className="t-md fw-b">
                  <span className="sr-only">명령 3</span>
                  판매 일시정지(킬스위치) · 전파
                </h2>
                <div className="actions"><span className="badge badge-danger">실패</span></div>
              </div>
              <div className="widget-body" style={{ gap: "16px", padding: "16px" }}>
                <nav className="stepper" aria-label="명령 진행 단계">
                  <span className="step is-done">
                    <span className="step-num"><i className="ic ic-check" aria-hidden="true" /></span>
                    <span className="sr-only">완료:</span>
                    사유
                  </span>
                  <span className="step-line is-done" />
                  {' '}
                  <span className="step is-done">
                    <span className="step-num"><i className="ic ic-check" aria-hidden="true" /></span>
                    <span className="sr-only">완료:</span>
                    파라미터
                  </span>
                  <span className="step-line is-done" />
                  {' '}
                  <span className="step is-done">
                    <span className="step-num"><i className="ic ic-check" aria-hidden="true" /></span>
                    <span className="sr-only">완료:</span>
                    dry-run
                  </span>
                  <span className="step-line is-done" />
                  {' '}
                  <span className="step is-done">
                    <span className="step-num"><i className="ic ic-check" aria-hidden="true" /></span>
                    <span className="sr-only">완료:</span>
                    재인증
                  </span>
                  <span className="step-line is-done" />
                  {' '}
                  <span className="step is-current" aria-current="step">
                    <span className="step-num">5</span>
                    전파 ack
                  </span>
                </nav>
                <div className="banner banner-danger" role="alert">
                  <i className="ic ic-alert-circle" aria-hidden="true" />
                  <div className="banner-body">
                    <span className="banner-title">전파에 실패했습니다</span>
                    ack 4/5 · purchase-svc-3이 10초 안에 ack를 보내지 않았습니다. ack한 purchase-svc 파드 2개는 새 좌석 홀드와 결제 접수를 막았지만 purchase-svc-3은 아직 받고 있을 수 있습니다.
                  </div>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)", gap: "20px", alignItems: "start" }}>
                  <section className="col" style={{ gap: "10px" }} aria-labelledby="ack2-t">
                    <div className="row between">
                      <h3 className="t-sm fw-b" id="ack2-t">⑤ 전파 ack</h3>
                      <span className="t-sm fw-b num tx-danger">4/5</span>
                    </div>
                    <div className="progress" role="progressbar" aria-label="전파 ack 진행" aria-valuemin={0} aria-valuemax={5} aria-valuenow={4} aria-valuetext="대상 5개 중 4개 ack, 1개 실패">
                      <span style={{ width: "80%" }} />
                    </div>
                    <ul className="col">
                      <li className="row" style={{ gap: "10px", padding: "10px 0", borderBottom: "1px solid var(--border)" }}>
                        <i className="ic ic-check-circle ic-16 tx-success" aria-hidden="true" />
                        <span className="mono t-sm grow">admission-ctrl 리더</span>
                        <span className="t-xs muted num">0.4초</span>
                        <span className="badge badge-success">ack</span>
                      </li>
                      <li className="row" style={{ gap: "10px", padding: "10px 0", borderBottom: "1px solid var(--border)" }}>
                        <i className="ic ic-check-circle ic-16 tx-success" aria-hidden="true" />
                        <span className="mono t-sm grow">queue-svc</span>
                        <span className="t-xs muted num">0.5초</span>
                        <span className="badge badge-success">ack</span>
                      </li>
                      <li className="row" style={{ gap: "10px", padding: "10px 0", borderBottom: "1px solid var(--border)" }}>
                        <i className="ic ic-check-circle ic-16 tx-success" aria-hidden="true" />
                        <span className="mono t-sm grow">purchase-svc-1</span>
                        <span className="t-xs muted num">0.6초</span>
                        <span className="badge badge-success">ack</span>
                      </li>
                      <li className="row" style={{ gap: "10px", padding: "10px 0", borderBottom: "1px solid var(--border)" }}>
                        <i className="ic ic-check-circle ic-16 tx-success" aria-hidden="true" />
                        <span className="mono t-sm grow">purchase-svc-2</span>
                        <span className="t-xs muted num">1.1초</span>
                        <span className="badge badge-success">ack</span>
                      </li>
                      <li className="row" style={{ gap: "10px", padding: "10px 0", borderBottom: "1px solid var(--border)" }}>
                        <i className="ic ic-x-circle ic-16 tx-danger" aria-hidden="true" />
                        <span className="mono t-sm grow">purchase-svc-3</span>
                        <span className="t-xs muted num">3.0초 시간 초과</span>
                        <span className="badge badge-danger">실패</span>
                      </li>
                    </ul>
                    <div className="row wrap" style={{ gap: "10px" }}>
                      <button className="btn btn-primary" type="button">
                        <i className="ic ic-refresh" aria-hidden="true" />
                        purchase-svc-3에 다시 보냅니다
                      </button>
                      <a href="https://runbook.ops.peaket.example/RB-08" target="_blank" rel="noreferrer" className="link-more">
                        런북 RB-08 열기
                        <i className="ic ic-chevron-right" aria-hidden="true" />
                      </a>
                    </div>
                  </section>
                  <section className="card-flat" aria-labelledby="rb-t" style={{ display: "flex", flexDirection: "column", gap: "10px", padding: "14px", borderRadius: "var(--r-lg)" }}>
                    <h3 className="t-sm fw-b" id="rb-t">ops-svc나 관제 채널이 응답하지 않으면 · 비상 런북 CLI(RB-08)</h3>
                    <ol className="col" style={{ gap: "8px" }}>
                      <li className="row" style={{ gap: "8px", alignItems: "flex-start" }}>
                        <span className="badge num" aria-hidden="true">1</span>
                        <span className="t-xs">비상 역할로 ops-breakglass 네임스페이스의 런북 Job을 실행합니다.</span>
                      </li>
                      <li className="row" style={{ gap: "8px", alignItems: "flex-start" }}>
                        <span className="badge num" aria-hidden="true">2</span>
                        <span className="t-xs">명령 묶음에 KMS 키로 서명합니다. 명령 3 정지 묶음은 commander 한 명, 판매 재개 묶음은 서로 다른 commander 두 명이 각자 서명합니다.</span>
                      </li>
                      <li className="row" style={{ gap: "8px", alignItems: "flex-start" }}>
                        <span className="badge num" aria-hidden="true">3</span>
                        <span className="t-xs">Job이 메시 신원으로 제어 전용 gRPC 채널에 붙어 purchase-svc·admission-ctrl 리더·queue-svc에 보냅니다. 전파 목표는 p99 10초입니다.</span>
                      </li>
                      <li className="row" style={{ gap: "8px", alignItems: "flex-start" }}>
                        <span className="badge num" aria-hidden="true">4</span>
                        <span className="t-xs">서명된 명령 묶음과 결과는 감사 앵커 버킷에 바로 남고, ops-svc가 돌아오면 감사 체인에 들어갑니다.</span>
                      </li>
                    </ol>
                    <div className="row" style={{ gap: "8px" }}>
                      <span className="code grow" style={{ padding: "8px 10px", fontSize: "12px", lineHeight: "18px" }}>
                        명령 ID 01929f3c-7a1e-7b42-9c3d-6e2a8f4b1d05
                      </span>
                      <button className="icon-btn icon-btn-sm icon-btn-outline" type="button" aria-label="명령 ID 복사">
                        <i className="ic ic-copy" aria-hidden="true" />
                      </button>
                    </div>
                    <p className="t-xs muted">CLI 명령 형식:</p>
                    <div className="row" style={{ gap: "8px", alignItems: "flex-start" }}>
                      <span className="code grow" style={{ padding: "8px 10px", fontSize: "12px", lineHeight: "18px" }}>
                        peaket-runbook draft KILL_SWITCH --event &lt;회차 ID&gt; --param scope=EVENT --command-id 01929f3c-7a1e-7b42-9c3d-6e2a8f4b1d05 --reason "purchase-svc-3 ack 시간 초과" --out ks.json
                      </span>
                      <button className="icon-btn icon-btn-sm icon-btn-outline" type="button" aria-label="런북 CLI 명령 복사">
                        <i className="ic ic-copy" aria-hidden="true" />
                      </button>
                    </div>
                    <p className="t-xs muted">
                      commander가{' '}
                      <span className="mono">peaket-runbook sign ks.json</span>
                      {' '}→ 비상 역할로{' '}
                      <span className="mono">peaket-runbook run ks.json</span>
                      (5분 안)
                    </p>
                  </section>
                </div>
              </div>
            </div>
          </>
        ) : null}
        {' '}
        {v.showSet ? (
          <>
            <div className="col">
              <div className="widget-head" style={{ minHeight: "52px", gap: "10px" }}>
                <span className="badge badge-outline num" style={{ minWidth: "26px", justifyContent: "center" }} aria-hidden="true">5</span>
                <h2 className="t-md fw-b">
                  <span className="sr-only">명령 5</span>
                  봇 판정 강도 · 적용 확인
                </h2>
                <div className="actions">
                  {v.setChk ? (
                    <>
                      <span className="badge badge-primary">적용 확인 중</span>
                    </>
                  ) : null}
                  {v.setOk ? (
                    <>
                      <span className="badge badge-success">
                        <i className="ic ic-check" aria-hidden="true" />
                        적용 확인됨
                      </span>
                    </>
                  ) : null}
                  {v.setNo ? (
                    <>
                      <span className="badge badge-warning">적용 확인 안 됨</span>
                    </>
                  ) : null}
                  {v.setUnk ? (
                    <>
                      <span className="badge badge-outline">확인할 수 없음</span>
                    </>
                  ) : null}
                  {v.setWait ? (
                    <>
                      <span className="badge badge-warning">보냄 · 전파 대기</span>
                    </>
                  ) : null}
                </div>
              </div>
              <div className="widget-body" style={{ gap: "16px", padding: "16px" }}>
                <nav className="stepper" aria-label="명령 진행 단계">
                  <span className="step is-done">
                    <span className="step-num"><i className="ic ic-check" aria-hidden="true" /></span>
                    <span className="sr-only">완료:</span>
                    사유
                  </span>
                  <span className="step-line is-done" />
                  {' '}
                  <span className="step is-done">
                    <span className="step-num"><i className="ic ic-check" aria-hidden="true" /></span>
                    <span className="sr-only">완료:</span>
                    파라미터
                  </span>
                  <span className="step-line is-done" />
                  {' '}
                  <span className="step is-done">
                    <span className="step-num"><i className="ic ic-check" aria-hidden="true" /></span>
                    <span className="sr-only">완료:</span>
                    dry-run
                  </span>
                  <span className="step-line is-done" />
                  {' '}
                  <span className="step is-done">
                    <span className="step-num"><i className="ic ic-check" aria-hidden="true" /></span>
                    <span className="sr-only">완료:</span>
                    재인증
                  </span>
                  <span className="step-line is-done" />
                  {' '}
                  <span className="step is-done">
                    <span className="step-num"><i className="ic ic-check" aria-hidden="true" /></span>
                    <span className="sr-only">완료:</span>
                    2인 승인
                  </span>
                  <span className="step-line is-done" />
                  {' '}
                  {v.setOk ? (
                    <>
                      <span className="step is-done">
                        <span className="step-num"><i className="ic ic-check" aria-hidden="true" /></span>
                        <span className="sr-only">완료:</span>
                        적용 확인
                      </span>
                    </>
                  ) : null}
                  {v.setOpen ? (
                    <>
                      <span className="step is-current" aria-current="step">
                        <span className="step-num">6</span>
                        적용 확인
                      </span>
                    </>
                  ) : null}
                </nav>
                {v.setWait ? (
                  <>
                    <div className="banner banner-warning" role="status">
                      <i className="ic ic-clock" aria-hidden="true" />
                      <div className="banner-body">
                        <span className="banner-title">보냄 · 전파 대기</span>
                        카프카가 돌아오면 이어 보냅니다. 판매 일시정지와 대체 결제사 전환은 그대로 낼 수 있습니다
                      </div>
                    </div>
                  </>
                ) : null}
                <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)", gap: "20px", alignItems: "start" }}>
                  <section className="col" style={{ gap: "8px" }} aria-labelledby="set-rec-t">
                    <h3 className="t-sm fw-b" id="set-rec-t">실행 기록</h3>
                    <div className="table-wrap">
                      <table className="table dense" aria-label="명령 5 실행 기록">
                        <tbody>
                          <tr>
                            <th scope="row" style={{ width: "76px" }}>요청</th>
                            <td className="num">수진 · commander · 20:03:12 KST · 재인증</td>
                          </tr>
                          <tr>
                            <th scope="row">승인</th>
                            <td className="num">민호 · operator · {v.setAt} KST · 재인증</td>
                          </tr>
                          <tr>
                            <th scope="row">파라미터</th>
                            <td>강도 기본 → 강화 · 대기 중 재평가 모드 그림자(그대로)</td>
                          </tr>
                          <tr>
                            <th scope="row">설정 판</th>
                            <td className="num">판 17 → 판 18</td>
                          </tr>
                          <tr>
                            <th scope="row">전달 경로</th>
                            <td>카프카 설정 사건 → trust-svc 준비된 모든 파드</td>
                          </tr>
                          <tr>
                            <th scope="row">사유</th>
                            <td>봇 의심 진입이 늘어 판정 강도를 한 단계 올립니다. 효과 줄을 보며 사람을 막는 신호가 보이면 되돌립니다.</td>
                          </tr>
                          <tr>
                            <th scope="row">명령 ID</th>
                            <td>
                              <span className="row" style={{ gap: "6px" }}>
                                <span className="hash">01929f3b-5c20-7a8e-b4d1-2f6c9e0a7d13</span>
                                <button className="icon-btn icon-btn-sm" type="button" aria-label="명령 ID 복사">
                                  <i className="ic ic-copy" aria-hidden="true" />
                                </button>
                              </span>
                            </td>
                          </tr>
                        </tbody>
                      </table>
                    </div>
                  </section>
                  <section className="col" style={{ gap: "10px" }} aria-labelledby="set-ap-t">
                    <div className="row between">
                      <h3 className="t-sm fw-b" id="set-ap-t">⑥ 적용 확인</h3>
                      <span className="t-sm fw-b num">{v.setCount}</span>
                    </div>
                    <div className={v.setBar} role="progressbar" aria-label="적용 확인 진행" aria-valuemin={0} aria-valuemax={4} aria-valuenow={Number(v.setNow)} aria-valuetext={v.setVt}>
                      <span style={{ width: v.setPct.replace('width:', '') }} />
                    </div>
                    {v.setLive ? (
                      <>
                        <ul className="col">
                          <li className="row" style={{ gap: "10px", padding: "10px 0", borderBottom: "1px solid var(--border)" }}>
                            <i className="ic ic-check-circle ic-16 tx-success" aria-hidden="true" />
                            <span className="mono t-sm grow">trust-svc-1</span>
                            <span className="t-xs muted num">판 18</span>
                            <span className="badge badge-success">적용</span>
                          </li>
                          <li className="row" style={{ gap: "10px", padding: "10px 0", borderBottom: "1px solid var(--border)" }}>
                            <i className="ic ic-check-circle ic-16 tx-success" aria-hidden="true" />
                            <span className="mono t-sm grow">trust-svc-2</span>
                            <span className="t-xs muted num">판 18</span>
                            <span className="badge badge-success">적용</span>
                          </li>
                          {v.setChk ? (
                            <>
                              <li className="row" style={{ gap: "10px", padding: "10px 0", borderBottom: "1px solid var(--border)" }}>
                                <span className="spinner tx-link" aria-hidden="true" />
                                <span className="mono t-sm grow">trust-svc-3</span>
                                <span className="t-xs muted num">판 17</span>
                                <span className="badge badge-primary">확인 중</span>
                              </li>
                            </>
                          ) : null}
                          {v.setOk ? (
                            <>
                              <li className="row" style={{ gap: "10px", padding: "10px 0", borderBottom: "1px solid var(--border)" }}>
                                <i className="ic ic-check-circle ic-16 tx-success" aria-hidden="true" />
                                <span className="mono t-sm grow">trust-svc-3</span>
                                <span className="t-xs muted num">판 18</span>
                                <span className="badge badge-success">적용</span>
                              </li>
                            </>
                          ) : null}
                          {v.setNo ? (
                            <>
                              <li className="row" style={{ gap: "10px", padding: "10px 0", borderBottom: "1px solid var(--border)" }}>
                                <i className="ic ic-alert-circle ic-16 tx-warning" aria-hidden="true" />
                                <span className="mono t-sm grow">trust-svc-3</span>
                                <span className="t-xs tx-warning num">판 17 · 30초 지남</span>
                                <span className="badge badge-warning">못 미침</span>
                              </li>
                            </>
                          ) : null}
                          <li className="row" style={{ gap: "10px", padding: "10px 0" }}>
                            <i className="ic ic-check-circle ic-16 tx-success" aria-hidden="true" />
                            <span className="mono t-sm grow">trust-svc-4</span>
                            <span className="t-xs muted num">판 18</span>
                            <span className="badge badge-success">적용</span>
                          </li>
                        </ul>
                      </>
                    ) : null}
                    {' '}
                    {v.setUnk ? (
                      <>
                        <ul className="col">
                          <li className="row" style={{ gap: "10px", padding: "10px 0", borderBottom: "1px solid var(--border)" }}>
                            <i className="ic ic-help ic-16 muted" aria-hidden="true" />
                            <span className="mono t-sm grow">trust-svc-1</span>
                            <span className="t-xs muted num">판 —</span>
                            <span className="badge">읽지 못함</span>
                          </li>
                          <li className="row" style={{ gap: "10px", padding: "10px 0", borderBottom: "1px solid var(--border)" }}>
                            <i className="ic ic-help ic-16 muted" aria-hidden="true" />
                            <span className="mono t-sm grow">trust-svc-2</span>
                            <span className="t-xs muted num">판 —</span>
                            <span className="badge">읽지 못함</span>
                          </li>
                          <li className="row" style={{ gap: "10px", padding: "10px 0", borderBottom: "1px solid var(--border)" }}>
                            <i className="ic ic-help ic-16 muted" aria-hidden="true" />
                            <span className="mono t-sm grow">trust-svc-3</span>
                            <span className="t-xs muted num">판 —</span>
                            <span className="badge">읽지 못함</span>
                          </li>
                          <li className="row" style={{ gap: "10px", padding: "10px 0" }}>
                            <i className="ic ic-help ic-16 muted" aria-hidden="true" />
                            <span className="mono t-sm grow">trust-svc-4</span>
                            <span className="t-xs muted num">판 —</span>
                            <span className="badge">읽지 못함</span>
                          </li>
                        </ul>
                      </>
                    ) : null}
                    {' '}
                    {v.setWait ? (
                      <>
                        <ul className="col">
                          <li className="row" style={{ gap: "10px", padding: "10px 0", borderBottom: "1px solid var(--border)" }}>
                            <i className="ic ic-clock ic-16 muted" aria-hidden="true" />
                            <span className="mono t-sm grow">trust-svc-1</span>
                            <span className="t-xs muted num">판 17</span>
                            <span className="badge">기다림</span>
                          </li>
                          <li className="row" style={{ gap: "10px", padding: "10px 0", borderBottom: "1px solid var(--border)" }}>
                            <i className="ic ic-clock ic-16 muted" aria-hidden="true" />
                            <span className="mono t-sm grow">trust-svc-2</span>
                            <span className="t-xs muted num">판 17</span>
                            <span className="badge">기다림</span>
                          </li>
                          <li className="row" style={{ gap: "10px", padding: "10px 0", borderBottom: "1px solid var(--border)" }}>
                            <i className="ic ic-clock ic-16 muted" aria-hidden="true" />
                            <span className="mono t-sm grow">trust-svc-3</span>
                            <span className="t-xs muted num">판 17</span>
                            <span className="badge">기다림</span>
                          </li>
                          <li className="row" style={{ gap: "10px", padding: "10px 0" }}>
                            <i className="ic ic-clock ic-16 muted" aria-hidden="true" />
                            <span className="mono t-sm grow">trust-svc-4</span>
                            <span className="t-xs muted num">판 17</span>
                            <span className="badge">기다림</span>
                          </li>
                        </ul>
                      </>
                    ) : null}
                    {' '}
                    {v.setChk ? (
                      <>
                        <p className="t-sm" role="status" aria-live="polite">
                          적용 확인 중 · 3/4 · 받는 파드가 모두 판 18 이상이 되면 '적용 확인됨'으로 바뀝니다. 30초까지 기다리고(14초 지남), 그 안에 맞지 않으면 '적용 확인 안 됨'으로 알립니다.
                        </p>
                      </>
                    ) : null}
                    {' '}
                    {v.setOk ? (
                      <>
                        <p className="t-sm tx-success" role="status" aria-live="polite">적용 확인됨 · 20:04:09 KST · trust-svc 준비된 파드 4개가 모두 판 18 이상입니다.</p>
                      </>
                    ) : null}
                    {' '}
                    {v.setNo ? (
                      <>
                        <p className="t-sm tx-warning" role="status" aria-live="polite">
                          적용 확인 안 됨 · 판 18에 못 미친 파드 1개(trust-svc-3, 판 17) · SEV3 경보를 띄웠습니다. 이 파드는 아직 이전 설정(기본)으로 판정하고 있을 수 있습니다.
                        </p>
                      </>
                    ) : null}
                    {' '}
                    {v.setUnk ? (
                      <>
                        <p className="t-sm" role="status" aria-live="polite">
                          확인할 수 없음 · Prometheus에 닿지 못해 받는 파드가 적용한 판 번호를 읽지 못했습니다(20:04:01 KST부터). 명령은 보냈고, 적용됐는지만 모릅니다.
                        </p>
                      </>
                    ) : null}
                    {' '}
                    {v.setWait ? (
                      <>
                        <p className="t-sm tx-warning" role="status" aria-live="polite">
                          20:03:58 KST에 보낸 명령이 14초째 카프카로 나가지 못하고 기다립니다. 받는 파드는 그동안 이전 설정(판 17, 기본)으로 판정합니다.
                        </p>
                      </>
                    ) : null}
                    <p className="t-xs muted">ack가 아니라 받는 파드가 내는 '적용한 판 번호' 지표로 확인하므로, 지표를 모으는 간격만큼 늦게 보입니다.</p>
                  </section>
                </div>
              </div>
            </div>
          </>
        ) : null}
        {' '}
        {v.isReport ? (
          <>
            <div className="col">
              <div className="widget-head" style={{ minHeight: "52px", gap: "10px" }}>
                <span className="badge badge-outline num" style={{ minWidth: "26px", justifyContent: "center" }} aria-hidden="true">11</span>
                <h2 className="t-md fw-b" id="rp-t">
                  <span className="sr-only">명령 11</span>
                  자동화 정지 스위치 · 사후 검토 보고서
                </h2>
                <span className="badge badge-warning">작성 중</span>
                <div className="actions"><span className="t-xs muted">작성 수진 · commander</span></div>
              </div>
              <div className="widget-body" style={{ gap: "14px", padding: "16px" }}>
                <div className="row wrap" style={{ gap: "6px 12px" }}>
                  <span className="badge badge-outline">
                    <i className="ic ic-clock" aria-hidden="true" />
                    작성 기한 10/16(금) 20:04 KST · 실행 뒤 48시간
                  </span>
                  {' '}
                  <span className="badge badge-outline">
                    <i className="ic ic-clock" aria-hidden="true" />
                    검토 기한 제출 뒤 7일
                  </span>
                </div>
                <p className="t-xs muted">★는 시스템이 감사 로그와 지표에서 채웁니다. 작성이나 검토 기한을 넘기면 SEV3로 알립니다. 보고서는 재개(2인 승인)의 조건이 아닙니다.</p>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(2,minmax(0,1fr))", gap: "16px 20px", alignItems: "start" }}>
                  <section className="card-flat col" style={{ gap: "10px", padding: "14px", borderRadius: "var(--r-lg)" }} aria-labelledby="rp1-t">
                    <div className="row between" style={{ gap: "8px" }}>
                      <h3 className="t-sm fw-b" id="rp1-t">1. 실행 기록</h3>
                      <span className="badge">★ 자동 채움</span>
                    </div>
                    <dl className="kv" style={{ fontSize: "13px", lineHeight: "18px", gap: "6px 12px" }}>
                      <dt>명령 ID</dt>
                      <dd className="hash">01929f3e-2b40-7c11-8d5a-4f7e1c9a3b62</dd>
                      <dt>실행자</dt>
                      <dd>수진 · commander</dd>
                      <dt>실행 시각</dt>
                      <dd>10/14(수) 20:04:02 KST</dd>
                      <dt>재인증 시각</dt>
                      <dd>20:03:58 KST</dd>
                    </dl>
                    <span className="t-xs muted" id="rp1-r">실행 사유 원문</span>
                    <blockquote className="code" aria-labelledby="rp1-r" style={{ fontFamily: "var(--font)", fontSize: "13px", lineHeight: "20px", whiteSpace: "normal", wordBreak: "keep-all" }}>
                      결제 확정 소진 경보가 지표 공백 때문에 잘못 울리는 것으로 보입니다. 확인하는 동안 입장 제어 자동화를 멈춥니다.
                    </blockquote>
                  </section>
                  <section className="card-flat col" style={{ gap: "10px", padding: "14px", borderRadius: "var(--r-lg)" }} aria-labelledby="rp2-t">
                    <h3 className="t-sm fw-b" id="rp2-t">
                      2. 계기{' '}
                      <span className="t-xs muted fw-m">(필수)</span>
                    </h3>
                    <fieldset className="col" style={{ gap: "6px" }}>
                      <legend className="sr-only">계기 고르기</legend>
                      <label className="check-row" style={{ fontSize: "14px" }}>
                        <input className="rd" type="radio" name="rp-cause" defaultChecked />
                        지표·입력 오류
                      </label>
                      {' '}
                      <label className="check-row" style={{ fontSize: "14px" }}>
                        <input className="rd" type="radio" name="rp-cause" />
                        자동 제어 동작 오류
                      </label>
                      {' '}
                      <label className="check-row" style={{ fontSize: "14px" }}>
                        <input className="rd" type="radio" name="rp-cause" />
                        외부 원인에 대한 잘못된 대응
                      </label>
                      {' '}
                      <label className="check-row" style={{ fontSize: "14px" }}>
                        <input className="rd" type="radio" name="rp-cause" />
                        예방 정지(점검·시험)
                      </label>
                      {' '}
                      <label className="check-row" style={{ fontSize: "14px" }}>
                        <input className="rd" type="radio" name="rp-cause" />
                        그 밖
                      </label>
                    </fieldset>
                    <div className="field">
                      <label className="label" htmlFor="rp2-d">
                        무엇을 보고 멈췄는지{' '}
                        <span className="opt">(필수)</span>
                      </label>
                      {' '}
                      <textarea className="textarea" id="rp2-d" style={{ minHeight: "76px", fontSize: "14px", lineHeight: "21px" }} defaultValue="2분 사이 버짓 연동 감축이 세 번 걸렸는데, 같은 시각 결제사 응답 지표가 비어 있었습니다." />
                    </div>
                  </section>
                  <section className="card-flat col" style={{ gap: "10px", padding: "14px", borderRadius: "var(--r-lg)" }} aria-labelledby="rp3-t">
                    <h3 className="t-sm fw-b" id="rp3-t">
                      <label htmlFor="rp3-d">
                        3. 2인 승인을 기다리지 않은 이유{' '}
                        <span className="t-xs muted fw-m">(필수)</span>
                      </label>
                    </h3>
                    <textarea className="textarea is-focus" id="rp3-d" style={{ minHeight: "88px", fontSize: "14px", lineHeight: "21px" }} defaultValue="감축이 1분 안에 다시 걸릴 상황이었고, 두 번째 commander가 접속해 있지 않았습니다." />
                  </section>
                  <section className="card-flat col" style={{ gap: "10px", padding: "14px", borderRadius: "var(--r-lg)" }} aria-labelledby="rp4-t">
                    <div className="row between" style={{ gap: "8px" }}>
                      <h3 className="t-sm fw-b" id="rp4-t">4. 정지 동안의 조치</h3>
                      <span className="badge">★ 자동 채움</span>
                    </div>
                    <p className="t-sm">
                      정지 뒤 실행된 명령 없음{' '}
                      <span className="t-xs muted">· 20:04:12 KST 기준</span>
                    </p>
                    <div className="field">
                      <label className="label" htmlFor="rp4-d">
                        덧붙일 설명{' '}
                        <span className="opt">(선택)</span>
                      </label>
                      {' '}
                      <textarea className="textarea" id="rp4-d" style={{ minHeight: "56px", fontSize: "14px", lineHeight: "21px" }} />
                    </div>
                  </section>
                  <section className="card-flat col" style={{ gap: "10px", padding: "14px", borderRadius: "var(--r-lg)" }} aria-labelledby="rp5-t">
                    <div className="row between" style={{ gap: "8px" }}>
                      <h3 className="t-sm fw-b" id="rp5-t">5. 영향</h3>
                      <span className="badge">★ 자동 채움</span>
                    </div>
                    <dl className="kv" style={{ fontSize: "13px", lineHeight: "18px", gap: "6px 12px" }}>
                      <dt>정지 시간</dt>
                      <dd>10초 · 정지 중</dd>
                      <dt>동시 입장 목표</dt>
                      <dd>1,000명 · 정지 뒤 변화 없음</dd>
                      <dt>남은 허용 실패·버짓 소모</dt>
                      <dd>결제 확정 12건 중 3건 사용 · 변화 없음</dd>
                      <dt>차례 전 입장</dt>
                      <dd>0건</dd>
                      <dt>예상 대기 오차</dt>
                      <dd>—</dd>
                    </dl>
                    <div className="field">
                      <label className="label" htmlFor="rp5-d">
                        해석{' '}
                        <span className="opt">(선택)</span>
                      </label>
                      {' '}
                      <textarea className="textarea" id="rp5-d" style={{ minHeight: "56px", fontSize: "14px", lineHeight: "21px" }} />
                    </div>
                  </section>
                  <section className="card-flat col" style={{ gap: "8px", padding: "14px", borderRadius: "var(--r-lg)" }} aria-labelledby="rp6-t">
                    <div className="row between" style={{ gap: "8px" }}>
                      <h3 className="t-sm fw-b" id="rp6-t">6. 재개</h3>
                      <span className="badge">★ 자동 채움</span>
                    </div>
                    <p className="row t-sm" style={{ gap: "6px" }}>
                      <span className="badge badge-danger">정지 중</span>
                      재개하면 재개 시각과 승인한 두 사람을 채웁니다
                    </p>
                  </section>
                  <section className="card-flat col" style={{ gap: "10px", padding: "14px", borderRadius: "var(--r-lg)" }} aria-labelledby="rp7-t">
                    <h3 className="t-sm fw-b" id="rp7-t">
                      7. 후속 조치{' '}
                      <span className="t-xs muted fw-m">(0개 이상)</span>
                    </h3>
                    <div className="field">
                      <label className="label" htmlFor="rp7-a">할 일</label>
                      <input className="input input-sm" id="rp7-a" type="text" defaultValue="결제사 응답 지표가 비었을 때 버짓 판정을 보류하는 규칙 검토" />
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(3,minmax(0,1fr))", gap: "8px" }}>
                      <div className="field">
                        <label className="label" htmlFor="rp7-o">담당</label>
                        <input className="input input-sm" id="rp7-o" type="text" defaultValue="수진" />
                      </div>
                      <div className="field">
                        <label className="label" htmlFor="rp7-d">기한</label>
                        <input className="input input-sm" id="rp7-d" type="text" defaultValue="10/21(수)" />
                      </div>
                      <div className="field">
                        <label className="label" htmlFor="rp7-l">이슈 링크</label>
                        <input className="input input-sm" id="rp7-l" type="text" defaultValue="[이슈 링크]" />
                      </div>
                    </div>
                    <button className="btn btn-ghost btn-sm" type="button" style={{ alignSelf: "flex-start" }}>
                      <i className="ic ic-plus" aria-hidden="true" />
                      후속 조치 더하기
                    </button>
                    <p className="hint">자동 제어 규칙이나 임계값을 바꿔야 하면 결정 기록이나 ADR로 잇습니다.</p>
                  </section>
                  <section className="card col" style={{ gap: "10px", padding: "14px", borderRadius: "var(--r-lg)", borderStyle: "dashed" }} aria-labelledby="rp8-t">
                    <h3 className="t-sm fw-b" id="rp8-t">
                      8. 검토{' '}
                      <span className="t-xs muted fw-m">(검토자가 씀, 필수)</span>
                    </h3>
                    <fieldset className="col" style={{ gap: "6px" }}>
                      <legend className="t-sm" style={{ marginBottom: "6px" }}>긴급 정지가 적절했는가</legend>
                      <label className="check-row" style={{ fontSize: "14px" }}>
                        <input className="rd" type="radio" name="rp-judge" disabled aria-describedby="rp8-why" />
                        적절했다
                      </label>
                      {' '}
                      <label className="check-row" style={{ fontSize: "14px" }}>
                        <input className="rd" type="radio" name="rp-judge" disabled aria-describedby="rp8-why" />
                        적절하지 않았다
                      </label>
                      {' '}
                      <label className="check-row" style={{ fontSize: "14px" }}>
                        <input className="rd" type="radio" name="rp-judge" disabled aria-describedby="rp8-why" />
                        판단 보류
                      </label>
                    </fieldset>
                    <div className="field">
                      <label className="label" htmlFor="rp8-c">의견</label>
                      <textarea className="textarea" id="rp8-c" disabled aria-describedby="rp8-why" style={{ minHeight: "56px", fontSize: "14px" }} />
                    </div>
                    <button className="btn btn-primary" type="button" aria-disabled="true" aria-describedby="rp8-why" style={{ alignSelf: "flex-start" }}>
                      검토를 마칩니다
                    </button>
                    <p className="row t-xs" id="rp8-why" style={{ gap: "6px", alignItems: "flex-start" }}>
                      <i className="ic ic-lock ic-14" aria-hidden="true" style={{ marginTop: "1px" }} />
                      <span>실행한 분은 검토할 수 없습니다. 다른 commander가 검토합니다</span>
                    </p>
                    <p className="t-xs muted">활성 commander가 실행자 한 명뿐인 1인 기간에는 실행자가 검토하고 감사 로그에 '1인 기간 자기 검토'로 남깁니다. 다른 사람의 검토가 아니므로 한계로 기록합니다.</p>
                  </section>
                </div>
                <div className="row wrap" style={{ gap: "12px", paddingTop: "14px", borderTop: "1px solid var(--border)" }}>
                  <button className="btn btn-primary btn-lg" type="button">
                    <i className="ic ic-check" aria-hidden="true" />
                    보고서를 제출하고 검토를 요청합니다
                  </button>
                  {' '}
                  <span className="t-xs muted" style={{ maxWidth: "360px" }}>제출하면 실행자가 아닌 commander에게 검토 요청이 갑니다. 검토는 제출 뒤 7일 안에 합니다.</span>
                </div>
              </div>
            </div>
          </>
        ) : null}
        {' '}
        {v.isReport3 ? (
          <>
            <div className="col">
              <div className="widget-head" style={{ minHeight: "52px", gap: "10px" }}>
                <span className="badge badge-outline num" style={{ minWidth: "26px", justifyContent: "center" }} aria-hidden="true">3</span>
                <h2 className="t-md fw-b" id="rp-t-k">
                  <span className="sr-only">명령 3</span>
                  판매 일시정지(킬스위치) · 사후 검토 보고서
                </h2>
                <span className="badge badge-warning">작성 중</span>
                <div className="actions"><span className="t-xs muted">작성 수진 · commander</span></div>
              </div>
              <div className="widget-body" style={{ gap: "14px", padding: "16px" }}>
                <div className="row wrap" style={{ gap: "6px 12px" }}>
                  <span className="badge badge-outline">
                    <i className="ic ic-clock" aria-hidden="true" />
                    작성 기한 10/16(금) 20:04 KST · 실행 뒤 48시간
                  </span>
                  {' '}
                  <span className="badge badge-outline">
                    <i className="ic ic-clock" aria-hidden="true" />
                    검토 기한 제출 뒤 7일
                  </span>
                </div>
                <p className="t-xs muted">
                  ★는 시스템이 감사 로그와 지표에서 채웁니다. 작성이나 검토 기한을 넘기면 SEV3로 알립니다. 보고서는 판매 재개(2인 승인)의 조건이 아닙니다. 명령 3 실행은 인시던트 선언 기준이라 이 보고서는 그 포스트모템의 한 절로 들어갑니다.
                </p>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(2,minmax(0,1fr))", gap: "16px 20px", alignItems: "start" }}>
                  <section className="card-flat col" style={{ gap: "10px", padding: "14px", borderRadius: "var(--r-lg)" }} aria-labelledby="rp1-t-k">
                    <div className="row between" style={{ gap: "8px" }}>
                      <h3 className="t-sm fw-b" id="rp1-t-k">1. 실행 기록</h3>
                      <span className="badge">★ 자동 채움</span>
                    </div>
                    <dl className="kv" style={{ fontSize: "13px", lineHeight: "18px", gap: "6px 12px" }}>
                      <dt>명령 ID</dt>
                      <dd className="hash">01929f3c-7a1e-7b42-9c3d-6e2a8f4b1d05</dd>
                      <dt>실행자</dt>
                      <dd>수진 · commander</dd>
                      <dt>실행 시각</dt>
                      <dd>10/14(수) 20:04:09 KST</dd>
                      <dt>재인증 시각</dt>
                      <dd>20:04:06 KST</dd>
                    </dl>
                    <span className="t-xs muted" id="rp1-r-k">실행 사유 원문</span>
                    <blockquote className="code" aria-labelledby="rp1-r-k" style={{ fontFamily: "var(--font)", fontSize: "13px", lineHeight: "20px", whiteSpace: "normal", wordBreak: "keep-all" }}>
                      결제사 승인 응답이 늦어 결과 불명 주문이 늘고 있습니다. 원인을 확인하는 동안 10/25(일) 18:00 회차의 새 좌석 홀드와 결제 접수를 멈춥니다. 처리 중 결제는 완결합니다.
                    </blockquote>
                  </section>
                  <section className="card-flat col" style={{ gap: "10px", padding: "14px", borderRadius: "var(--r-lg)" }} aria-labelledby="rp2-t-k">
                    <h3 className="t-sm fw-b" id="rp2-t-k">
                      2. 계기{' '}
                      <span className="t-xs muted fw-m">(필수)</span>
                    </h3>
                    <fieldset className="col" style={{ gap: "6px" }}>
                      <legend className="sr-only">계기 고르기</legend>
                      <label className="check-row" style={{ fontSize: "14px" }}>
                        <input className="rd" type="radio" name="rp-cause-k" />
                        돈·좌석 의심
                      </label>
                      {' '}
                      <label className="check-row" style={{ fontSize: "14px" }}>
                        <input className="rd" type="radio" name="rp-cause-k" />
                        가격·표시 오류
                      </label>
                      {' '}
                      <label className="check-row" style={{ fontSize: "14px" }}>
                        <input className="rd" type="radio" name="rp-cause-k" defaultChecked />
                        시스템 장애 대응
                      </label>
                      {' '}
                      <label className="check-row" style={{ fontSize: "14px" }}>
                        <input className="rd" type="radio" name="rp-cause-k" />
                        예방 정지
                      </label>
                      {' '}
                      <label className="check-row" style={{ fontSize: "14px" }}>
                        <input className="rd" type="radio" name="rp-cause-k" />
                        그 밖
                      </label>
                    </fieldset>
                    <div className="field">
                      <label className="label" htmlFor="rp2-d-k">
                        무엇을 보고 멈췄는지{' '}
                        <span className="opt">(필수)</span>
                      </label>
                      {' '}
                      <textarea className="textarea" id="rp2-d-k" style={{ minHeight: "76px", fontSize: "14px", lineHeight: "21px" }} defaultValue="결제사 승인 호출 p99가 2초를 넘은 뒤 결과 불명 주문이 2분 사이 41건으로 늘었습니다." />
                    </div>
                  </section>
                  <section className="card-flat col" style={{ gap: "10px", padding: "14px", borderRadius: "var(--r-lg)" }} aria-labelledby="rp4-t-k">
                    <div className="row between" style={{ gap: "8px" }}>
                      <h3 className="t-sm fw-b" id="rp4-t-k">3. 정지 동안의 조치</h3>
                      <span className="badge">★ 자동 채움</span>
                    </div>
                    <p className="t-sm">
                      정지 뒤 실행된 명령 없음{' '}
                      <span className="t-xs muted">· 20:04:12 KST 기준</span>
                    </p>
                    <div className="field">
                      <label className="label" htmlFor="rp4-d-k">
                        덧붙일 설명{' '}
                        <span className="opt">(선택)</span>
                      </label>
                      {' '}
                      <textarea className="textarea" id="rp4-d-k" style={{ minHeight: "56px", fontSize: "14px", lineHeight: "21px" }} />
                    </div>
                  </section>
                  <section className="card-flat col" style={{ gap: "10px", padding: "14px", borderRadius: "var(--r-lg)" }} aria-labelledby="rp5-t-k">
                    <div className="row between" style={{ gap: "8px" }}>
                      <h3 className="t-sm fw-b" id="rp5-t-k">4. 영향</h3>
                      <span className="badge">★ 자동 채움</span>
                    </div>
                    <dl className="kv" style={{ fontSize: "13px", lineHeight: "18px", gap: "6px 12px" }}>
                      <dt>정지 시간</dt>
                      <dd>3초 · 정지 중</dd>
                      <dt>막은 새 홀드·결제 접수</dt>
                      <dd>초당 약 52건·11건 → 0건</dd>
                      <dt>진행 중 결제</dt>
                      <dd>312건 · 완결 중</dd>
                      <dt>차례 전 입장</dt>
                      <dd>0건</dd>
                      <dt>대기 순서</dt>
                      <dd>그대로 유지</dd>
                    </dl>
                    <div className="field">
                      <label className="label" htmlFor="rp5-d-k">
                        해석{' '}
                        <span className="opt">(선택)</span>
                      </label>
                      {' '}
                      <textarea className="textarea" id="rp5-d-k" style={{ minHeight: "56px", fontSize: "14px", lineHeight: "21px" }} />
                    </div>
                  </section>
                  <section className="card-flat col" style={{ gap: "8px", padding: "14px", borderRadius: "var(--r-lg)" }} aria-labelledby="rp6-t-k">
                    <div className="row between" style={{ gap: "8px" }}>
                      <h3 className="t-sm fw-b" id="rp6-t-k">5. 재개</h3>
                      <span className="badge">★ 자동 채움</span>
                    </div>
                    <p className="row t-sm" style={{ gap: "6px" }}>
                      <span className="badge badge-danger">정지 중</span>
                      재개하면 재개 시각과 승인한 두 사람을 채웁니다
                    </p>
                  </section>
                  <section className="card-flat col" style={{ gap: "10px", padding: "14px", borderRadius: "var(--r-lg)" }} aria-labelledby="rp7-t-k">
                    <h3 className="t-sm fw-b" id="rp7-t-k">
                      6. 후속 조치{' '}
                      <span className="t-xs muted fw-m">(0개 이상)</span>
                    </h3>
                    <div className="field">
                      <label className="label" htmlFor="rp7-a-k">할 일</label>
                      <input className="input input-sm" id="rp7-a-k" type="text" defaultValue="결제사 승인 지연 때 명령 6(결제사 전환)으로 먼저 대응하는 기준 다시 보기" />
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(3,minmax(0,1fr))", gap: "8px" }}>
                      <div className="field">
                        <label className="label" htmlFor="rp7-o-k">담당</label>
                        <input className="input input-sm" id="rp7-o-k" type="text" defaultValue="수진" />
                      </div>
                      <div className="field">
                        <label className="label" htmlFor="rp7-d-k">기한</label>
                        <input className="input input-sm" id="rp7-d-k" type="text" defaultValue="10/21(수)" />
                      </div>
                      <div className="field">
                        <label className="label" htmlFor="rp7-l-k">이슈 링크</label>
                        <input className="input input-sm" id="rp7-l-k" type="text" defaultValue="[이슈 링크]" />
                      </div>
                    </div>
                    <button className="btn btn-ghost btn-sm" type="button" style={{ alignSelf: "flex-start" }}>
                      <i className="ic ic-plus" aria-hidden="true" />
                      후속 조치 더하기
                    </button>
                    <p className="hint">자동 제어 규칙이나 임계값을 바꿔야 하면 결정 기록이나 ADR로 잇습니다.</p>
                  </section>
                  <section className="card col" style={{ gap: "10px", padding: "14px", borderRadius: "var(--r-lg)", borderStyle: "dashed" }} aria-labelledby="rp8-t-k">
                    <h3 className="t-sm fw-b" id="rp8-t-k">
                      7. 검토{' '}
                      <span className="t-xs muted fw-m">(검토자가 씀, 필수)</span>
                    </h3>
                    <fieldset className="col" style={{ gap: "6px" }}>
                      <legend className="t-sm" style={{ marginBottom: "6px" }}>판매 일시정지가 적절했는가</legend>
                      <label className="check-row" style={{ fontSize: "14px" }}>
                        <input className="rd" type="radio" name="rp-judge-k" disabled aria-describedby="rp8-why-k" />
                        적절했다
                      </label>
                      {' '}
                      <label className="check-row" style={{ fontSize: "14px" }}>
                        <input className="rd" type="radio" name="rp-judge-k" disabled aria-describedby="rp8-why-k" />
                        적절하지 않았다
                      </label>
                      {' '}
                      <label className="check-row" style={{ fontSize: "14px" }}>
                        <input className="rd" type="radio" name="rp-judge-k" disabled aria-describedby="rp8-why-k" />
                        판단 보류
                      </label>
                    </fieldset>
                    <div className="field">
                      <label className="label" htmlFor="rp8-c-k">의견</label>
                      <textarea className="textarea" id="rp8-c-k" disabled aria-describedby="rp8-why-k" style={{ minHeight: "56px", fontSize: "14px" }} />
                    </div>
                    <button className="btn btn-primary" type="button" aria-disabled="true" aria-describedby="rp8-why-k" style={{ alignSelf: "flex-start" }}>
                      검토를 마칩니다
                    </button>
                    <p className="row t-xs" id="rp8-why-k" style={{ gap: "6px", alignItems: "flex-start" }}>
                      <i className="ic ic-lock ic-14" aria-hidden="true" style={{ marginTop: "1px" }} />
                      <span>실행한 분은 검토할 수 없습니다. 다른 commander가 검토합니다</span>
                    </p>
                    <p className="t-xs muted">활성 commander가 실행자 한 명뿐인 1인 기간에는 실행자가 검토하고 감사 로그에 '1인 기간 자기 검토'로 남깁니다. 다른 사람의 검토가 아니므로 한계로 기록합니다.</p>
                  </section>
                </div>
                <div className="row wrap" style={{ gap: "12px", paddingTop: "14px", borderTop: "1px solid var(--border)" }}>
                  <button className="btn btn-primary btn-lg" type="button">
                    <i className="ic ic-check" aria-hidden="true" />
                    보고서를 제출하고 검토를 요청합니다
                  </button>
                  {' '}
                  <span className="t-xs muted" style={{ maxWidth: "360px" }}>제출하면 실행자가 아닌 commander에게 검토 요청이 갑니다. 검토는 제출 뒤 7일 안에 합니다.</span>
                </div>
              </div>
            </div>
          </>
        ) : null}
      </section>
    </div>
    {v.showConfirm ? (
      <>
        <Overlay placement="center" onClose={close}>
          <div className="dialog" role="alertdialog" aria-modal="true" aria-labelledby="dc-t" aria-describedby="dc-d" style={{ maxWidth: "560px" }}>
            <div className="row" style={{ gap: "12px" }}>
              <span className="state-icon is-danger" style={{ width: "44px", height: "44px" }}><i className="ic ic-stop" aria-hidden="true" /></span>
              <h2 className="dialog-title" id="dc-t">판매 일시정지(킬스위치)를 실행합니다</h2>
            </div>
            <p className="t-sm" id="dc-d">
              LUMEN 콘서트 2026 서울 10/25(일) 18:00 회차의 새 좌석 홀드와 결제 접수가 모두 막힙니다. 처리 중 결제는 완결하고, 이 회차의 입장도 멈춥니다. 대기 순서는 그대로이고 고른 좌석은 홀드 시간 동안 유지됩니다. 재인증하면 바로 전파합니다. 실행하면 인시던트 선언 기준이 되고 사후 검토 보고서를 씁니다.
            </p>
            <dl className="kv" style={{ fontSize: "13px", lineHeight: "18px", padding: "12px 14px", borderRadius: "var(--r-md)", background: "var(--surface-muted)" }}>
              <dt>진행 중 결제 세션</dt>
              <dd>312건 · 완결</dd>
              <dt>새 좌석 홀드·결제 접수</dt>
              <dd>초당 약 52건·11건 → 0건</dd>
              <dt>되돌리기</dt>
              <dd>판매 재개는 2인 승인</dd>
            </dl>
            <div className="field">
              <label className="label" htmlFor="dc-reason">
                실행 사유{' '}
                <span className="opt">(필수)</span>
              </label>
              {' '}
              <textarea className="textarea" id="dc-reason" aria-describedby="dc-reason-h dc-reason-c" style={{ minHeight: "84px", fontSize: "14px", lineHeight: "21px" }} defaultValue="결제사 승인 응답이 늦어 결과 불명 주문이 늘고 있습니다. 원인을 확인하는 동안 10/25(일) 18:00 회차의 새 좌석 홀드와 결제 접수를 멈춥니다. 처리 중 결제는 완결합니다." />
              <div className="row between" style={{ gap: "8px", alignItems: "flex-start" }}>
                <span className="hint" id="dc-reason-h">사유는 감사 로그와 사후 검토 보고서에 그대로 남습니다</span>
                <span className="counter" id="dc-reason-c" aria-live="polite">101자</span>
              </div>
            </div>
            <div className="field">
              <label className="label" htmlFor="dc-phrase">
                확인 문구{' '}
                <span className="opt">(필수)</span>
              </label>
              {' '}
              <input className="input input-sm is-focus" id="dc-phrase" type="text" autoComplete="off" defaultValue="LUMEN 10/25 18:00" aria-describedby="dc-phrase-h" />
              {' '}
              <span className="hint" id="dc-phrase-h">확인하려면 회차 이름 LUMEN 10/25 18:00을 그대로 입력하세요</span>
            </div>
            <div className="dialog-actions">
              <button className="btn btn-outline" type="button">작성 화면으로 돌아가기</button>
              <button className="btn btn-danger" type="button">
                <i className="ic ic-stop" aria-hidden="true" />
                판매를 전면 중단합니다
              </button>
            </div>
            <p className="t-xs muted">다음 단계에서 비밀번호와 인증 앱 코드로 다시 인증하고, 등록한 패스키로 한 번 더 확인합니다. 인증하면 바로 전파합니다.</p>
          </div>
        </Overlay>
      </>
    ) : null}
    {' '}
    {v.isPause ? (
      <>
        <Overlay placement="center" onClose={close}>
          <div className="dialog" role="alertdialog" aria-modal="true" aria-labelledby="pz-t" aria-describedby="pz-d pz-ng" style={{ maxWidth: "560px" }}>
            <div className="row between" style={{ gap: "12px" }}>
              <div className="row" style={{ gap: "12px" }}>
                <span className="state-icon is-warning" style={{ width: "44px", height: "44px" }}><i className="ic ic-pause" aria-hidden="true" /></span>
                <h2 className="dialog-title" id="pz-t">입장 일시정지가 1분 뒤 끝납니다</h2>
              </div>
              <span className="timer is-warning" role="timer" aria-label="자동 재개까지 1분">
                <i className="ic ic-clock" aria-hidden="true" />
                1:00
              </span>
            </div>
            <p className="t-sm" id="pz-d">연장하지 않으면 20:05:12 KST에 이 회차의 입장이 자동으로 다시 시작됩니다. 계속 멈춰야 하면 사유를 적고 10분 연장합니다.</p>
            <dl className="kv" style={{ fontSize: "13px", lineHeight: "18px", padding: "12px 14px", borderRadius: "var(--r-md)", background: "var(--surface-muted)" }}>
              <dt>명령</dt>
              <dd>명령 2 입장 일시정지 · 10/25(일) 18:00 회차</dd>
              <dt>요청</dt>
              <dd>민호 · operator · 19:55:12 KST</dd>
              <dt>시작 사유</dt>
              <dd>Go/No-Go가 No-Go라 입장 일시정지로 시작</dd>
            </dl>
            <div className="banner banner-danger" id="pz-ng">
              <i className="ic ic-alert-circle" aria-hidden="true" />
              <div className="banner-body">아직 실패한 필수 항목: 시계 오프셋</div>
            </div>
            <div className="field">
              <label className="label" htmlFor="pz-reason">
                연장 사유{' '}
                <span className="opt">(필수)</span>
              </label>
              {' '}
              <textarea className="textarea is-focus" id="pz-reason" aria-describedby="pz-h pz-c" style={{ minHeight: "72px", fontSize: "14px", lineHeight: "21px" }} defaultValue="시계 오프셋이 아직 기준(20ms)을 넘습니다. 회복될 때까지 입장을 계속 멈춥니다." />
              <div className="row between" style={{ gap: "8px", alignItems: "flex-start" }}>
                <span className="hint" id="pz-h">연장하면 그때부터 10분이 다시 시작되고 사유는 감사 로그에 남습니다. 오래 멈춰야 하면 명령 3이나 명령 6을 씁니다.</span>
                <span className="counter" id="pz-c" aria-live="polite">47자</span>
              </div>
            </div>
            <div className="dialog-actions">
              <button className="btn btn-ghost" type="button">예정대로 자동 재개</button>
              <button className="btn btn-outline" type="button">
                <i className="ic ic-play" aria-hidden="true" />
                지금 입장 재개하기
              </button>
              <button className="btn btn-primary" type="button">
                <i className="ic ic-pause" aria-hidden="true" />
                10분 더 멈추기
              </button>
            </div>
          </div>
        </Overlay>
      </>
    ) : null}
    </>
  );
}
