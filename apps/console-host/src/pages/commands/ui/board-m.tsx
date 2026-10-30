// 디자인 캔버스 보드 SCR-030-m.dc.html를 옮긴 것(dc2tsx 생성 뒤 손질)
/* eslint-disable */
import { Fragment, type FormEvent } from 'react';
import { Link } from 'react-router';
import { Overlay } from '@/shared/ui/Overlay';

const prevent = (e: FormEvent) => e.preventDefault();
void Fragment;
void Link;

type AriaBool = boolean | 'true' | 'false';
type AriaCurrent = boolean | 'true' | 'false' | 'page' | 'step' | 'location' | 'date' | 'time';

export const STATES_M = ["두 번째 승인(민호)", "재인증 시트", "패스키 확인", "패스키 없음", "적용 중 명령", "전파 ack", "적용 확인 중", "적용 확인됨", "적용 확인 안 됨", "확인할 수 없음", "전파 대기", "입장 일시정지 만료 확인", "사후 검토 보고서", "버짓 연동 감축", "노출 줄이기", "자동화 정지 확인 시트"] as const;
export const DEFAULT_M = "두 번째 승인(민호)";

export function valsM(state: string) {
    let st = state || '두 번째 승인(민호)';
    let pk = st === '패스키 확인';
    let pkNone = st === '패스키 없음';
    let approve = st === '두 번째 승인(민호)' || st === '재인증 시트' || pk || pkNone;
    let setChk = st === '적용 확인 중';
    let setOk = st === '적용 확인됨';
    let setNo = st === '적용 확인 안 됨';
    let setUnk = st === '확인할 수 없음';
    let setWait = st === '전파 대기';
    let set = setChk || setOk || setNo || setUnk || setWait;
    let pause = st === '입장 일시정지 만료 확인';
    let report = st === '사후 검토 보고서';
    let cut = st === '버짓 연동 감축';
    let expose = st === '노출 줄이기';
    let c11 = st === '자동화 정지 확인 시트';
    return {
      isApprove: approve,
      showReauth: st === '재인증 시트' || pk || pkNone,
      pkStep1: st === '재인증 시트',
      pkStep2: pk || pkNone,
      pkNone: pkNone,
      pkHave: !pkNone,
      isList: st === '적용 중 명령' || pause || cut || expose,
      isProp: st === '전파 ack',
      hasPending: st !== '전파 ack',
      isPause: pause,
      isReport: report,
      isCut: cut,
      isExpose: expose,
      ctlOk: cut || expose,
      isC11: c11,
      asMinho: !report && !c11,
      asSujin: report || c11,
      autoHold: !report && !cut && !expose,
      showAimd: !cut && !expose,
      cmd1Hold: !cut && !expose,
      cnt2: !pause,
      isSet: set,
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

type V = ReturnType<typeof valsM>;

// 보드 루트: {"class": "pk dark cs cs-compact", "style": "width:360px;min-height:2660px"}

// <main class="cs-main" id="main">
export function MainM({ v, close }: { v: V; close?: () => void }) {
  void v; void close;
  return (
    <>
    {v.isApprove ? (
      <>
        <div className="col" style={{ gap: "16px" }}>
          <Link to="/commands" className="link-more" style={{ alignSelf: "flex-start" }}>
            <i className="ic ic-chevron-left" aria-hidden="true" />
            운영 명령
          </Link>
          <div className="col" style={{ gap: "10px" }}>
            <div className="row" style={{ gap: "8px", alignItems: "flex-start" }}>
              <span className="badge badge-outline num" style={{ minWidth: "26px", justifyContent: "center", marginTop: "2px" }} aria-hidden="true">
                3
              </span>
              <h1 className="t-lg">
                <span className="sr-only">명령 3</span>
                판매 재개(명령 3 되돌리기) · 두 번째 승인
              </h1>
            </div>
            <div className="row wrap" style={{ gap: "6px" }}><span className="badge badge-warning">재개 승인 대기 9:41</span></div>
          </div>
          <nav aria-label="명령 진행 단계">
            <ol className="stepper" style={{ display: "grid", gridTemplateColumns: "repeat(3,minmax(0,1fr))", gap: "10px 8px" }}>
              <li className="step is-done">
                <span className="step-num"><i className="ic ic-check" aria-hidden="true" /></span>
                <span className="sr-only">완료:</span>
                사유
              </li>
              <li className="step is-done">
                <span className="step-num"><i className="ic ic-check" aria-hidden="true" /></span>
                <span className="sr-only">완료:</span>
                파라미터
              </li>
              <li className="step is-done">
                <span className="step-num"><i className="ic ic-check" aria-hidden="true" /></span>
                <span className="sr-only">완료:</span>
                dry-run
              </li>
              <li className="step is-done">
                <span className="step-num"><i className="ic ic-check" aria-hidden="true" /></span>
                <span className="sr-only">완료:</span>
                재인증
              </li>
              <li className="step is-current" aria-current="step">
                <span className="step-num">5</span>
                2인 승인
              </li>
              <li className="step">
                <span className="step-num">6</span>
                전파 ack
              </li>
            </ol>
          </nav>
          <section className="widget" aria-labelledby="rq-t">
            <div className="widget-head"><h2 id="rq-t" style={{ fontSize: "13px", lineHeight: "18px" }}>요청 내용 · 원문 그대로</h2></div>
            <div className="widget-body" style={{ gap: "12px" }}>
              <dl className="col" style={{ gap: "10px" }}>
                <div className="col" style={{ gap: "2px" }}>
                  <dt className="t-xs muted">요청자</dt>
                  <dd className="t-sm fw-m">수진 · commander</dd>
                </div>
                <div className="col" style={{ gap: "2px" }}>
                  <dt className="t-xs muted">요청 시각</dt>
                  <dd className="t-sm fw-m num">20:03:53 KST · 요청자 재인증 20:03:49 KST</dd>
                </div>
                <div className="col" style={{ gap: "2px" }}>
                  <dt className="t-xs muted">회차·범위</dt>
                  <dd className="t-sm fw-m">전체 회차(진행 중 3) · 범위 전체</dd>
                </div>
                <div className="col" style={{ gap: "2px" }}>
                  <dt className="t-xs muted">되돌릴 명령</dt>
                  <dd className="t-sm fw-m">명령 3 판매 일시정지 · 수진 실행 20:01:40 KST</dd>
                </div>
              </dl>
              <div className="col" style={{ gap: "6px" }}>
                <span className="t-xs muted" id="rq-reason-l">사유</span>
                <blockquote className="code" aria-labelledby="rq-reason-l" style={{ fontFamily: "var(--font)", fontSize: "14px", lineHeight: "21px", whiteSpace: "normal", wordBreak: "keep-all" }}>
                  결제사 승인 응답이 정상으로 돌아왔습니다(승인 호출 p99 1.2초). 동시 입장 목표를 1,000명으로 낮춰 둔 채 판매를 다시 엽니다.
                </blockquote>
              </div>
            </div>
          </section>
          <section className="widget" aria-labelledby="pr-t">
            <div className="widget-head"><h2 id="pr-t" style={{ fontSize: "13px", lineHeight: "18px" }}>파라미터</h2></div>
            <div className="widget-body">
              <dl className="col" style={{ gap: "10px" }}>
                <div className="col" style={{ gap: "2px" }}>
                  <dt className="t-xs muted">범위</dt>
                  <dd className="t-sm fw-m">전체 회차</dd>
                </div>
                <div className="col" style={{ gap: "2px" }}>
                  <dt className="t-xs muted">되돌리기 대상</dt>
                  <dd className="t-sm fw-m">명령 3 판매 일시정지(킬스위치)</dd>
                </div>
                <div className="col" style={{ gap: "2px" }}>
                  <dt className="t-xs muted">승인</dt>
                  <dd className="t-sm fw-m">재개 2인 · 요청자 아닌 operator 이상 1인 승인, 둘 다 재인증</dd>
                </div>
                <div className="col" style={{ gap: "2px" }}>
                  <dt className="t-xs muted">전달 경로</dt>
                  <dd className="t-sm fw-m">제어 전용 gRPC → purchase-svc 준비된 모든 파드 · admission-ctrl 리더 · queue-svc</dd>
                </div>
              </dl>
            </div>
          </section>
          <section className="widget" role="region" aria-labelledby="dr-t">
            <div className="widget-head">
              <h2 id="dr-t" style={{ fontSize: "13px", lineHeight: "18px" }}>dry-run 결과 · 요청 때 그대로</h2>
              <div className="actions"><span className="badge">20:03:51 KST 계산</span></div>
            </div>
            <div className="widget-body" style={{ gap: "12px" }}>
              <dl className="kv" style={{ fontSize: "13px", lineHeight: "18px", gap: "8px 12px" }}>
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
              <div className="col" style={{ gap: "4px" }}>
                <div className="row between" style={{ gap: "8px" }}>
                  <h3 className="t-xs fw-b muted">예상 트래픽 변동</h3>
                  <span className="t-xs muted">요청 때 → 실행 뒤</span>
                </div>
                <ul className="col">
                  <li className="row between" style={{ gap: "8px", padding: "8px 0", borderBottom: "1px solid var(--border)" }}>
                    <span className="t-sm">새 좌석 홀드</span>
                    <span className="t-sm num">0건 → 초당 약 30건</span>
                  </li>
                  <li className="row between" style={{ gap: "8px", padding: "8px 0", borderBottom: "1px solid var(--border)" }}>
                    <span className="t-sm">새 결제 접수</span>
                    <span className="t-sm num">0건 → 초당 약 6건</span>
                  </li>
                  <li className="row between" style={{ gap: "8px", padding: "8px 0" }}>
                    <span className="t-sm">팬 화면 응답</span>
                    <span className="t-sm num">423 안내 → 정상</span>
                  </li>
                </ul>
              </div>
              <p className="t-xs muted">재개하면 팬 화면의 판매 멈춤 안내(423)가 사라지고, 대기 순서는 그대로 이어집니다.</p>
            </div>
          </section>
          <section className="card" aria-labelledby="ap-t" style={{ display: "flex", flexDirection: "column", gap: "12px", padding: "16px", borderRadius: "var(--r-lg)", borderColor: "var(--warning)" }}>
            <h2 className="t-md fw-b" id="ap-t">
              두 번째 승인을 기다리는 중 ·{' '}
              <span className="num" role="timer" aria-label="승인 남은 시간 9분 41초">9:41</span>
              {' '}남음
            </h2>
            <p className="t-sm muted">10분 안에 승인하지 않으면 요청은 취소됩니다. 승인하면 바로 전파합니다.</p>
            <p className="t-sm fw-b" id="ap-sum" style={{ padding: "10px 12px", borderRadius: "var(--r-md)", background: "var(--surface-muted)" }}>
              <span className="sr-only">승인 대상:</span>
              판매 재개 · 범위 전체 · 요청 수진
            </p>
            <button className="btn btn-primary btn-lg btn-block" type="button" aria-describedby="ap-sum ap-re">
              <i className="ic ic-play" aria-hidden="true" />
              승인
            </button>
            <p className="t-xs muted" id="ap-re">누르면 비밀번호와 인증 앱 코드로 다시 인증하고, 등록한 패스키로 한 번 더 확인합니다(5분 재인증 토큰).</p>
            <button className="btn btn-outline btn-lg btn-block" type="button">거부(사유 필수)</button>
          </section>
        </div>
      </>
    ) : null}
    {' '}
    {v.isList ? (
      <>
        <div className="col" style={{ gap: "16px" }}>
          <div className="col" style={{ gap: "6px" }}>
            <h1 className="t-lg">운영 명령</h1>
            <p className="t-sm muted">사유 → dry-run → 재인증(등록한 패스키로 한 번 더 확인) → 두 번째 승인(2인 명령만) → 전파 ack 순서로 실행합니다. 되돌리기는 시간 제한이 없습니다.</p>
          </div>
          <div className="row wrap" style={{ gap: "6px 12px" }} role="group" aria-label="접속 운영자 3명">
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
          {v.isCut ? (
            <>
              <div className="banner banner-warning" role="alert">
                <i className="ic ic-alert" aria-hidden="true" />
                <div className="banner-body">
                  <span className="banner-title">운영자가 정한 동시 입장 목표를 새 소진 경보로 절반으로 줄였습니다(4,000 → 2,000명). 다시 정하려면 동시 입장 목표 조정(명령 1)을 쓰세요.</span>
                  시스템 20:04:07 KST · 10/25(일) 18:00 회차 · 감사 로그 사유 '자동 조절 멈춤 중 버짓 연동 감축'. 자동 조절 멈춤(15분)은 끝났고, 명령 1로 다시 정할 때까지 자동 증액은 멈춥니다.
                </div>
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
          <section className="widget" aria-labelledby="act-t">
            <div className="widget-head">
              <h2 id="act-t" style={{ fontSize: "13px", lineHeight: "18px" }}>적용 중 명령</h2>
              <div className="actions">
                {v.cnt2 ? (
                  <>
                    <span className="badge">3건</span>
                  </>
                ) : null}
                {v.isPause ? (
                  <>
                    <span className="badge">4건</span>
                  </>
                ) : null}
              </div>
            </div>
            <ul className="col" style={{ padding: "0 14px" }}>
              {v.cmd1Hold ? (
                <>
                  <li className="col" style={{ gap: "2px", padding: "10px 0", borderBottom: "1px solid var(--border)" }}>
                    <span className="t-sm fw-b">명령 1 목표 5,000 → 1,000명</span>
                    <span className="t-xs muted">10/25(일) 18:00 · 민호 20:02:24 KST · 자동 조절 정지 13:12 남음</span>
                  </li>
                </>
              ) : null}
              {' '}
              {v.isCut ? (
                <>
                  <li className="col" style={{ gap: "2px", padding: "10px 0", borderBottom: "1px solid var(--border)" }}>
                    <span className="t-sm fw-b">명령 1 목표 5,000 → 4,000 → 2,000명</span>
                    <span className="t-xs muted">10/25(일) 18:00 · 민호 20:02:24 KST · 시스템 20:04:07 KST 자동 조절 멈춤 중 버짓 연동 감축 · 자동 증액 멈춤</span>
                  </li>
                </>
              ) : null}
              {' '}
              {v.isExpose ? (
                <>
                  <li className="col" style={{ gap: "2px", padding: "10px 0", borderBottom: "1px solid var(--border)" }}>
                    <span className="t-sm fw-b">동시 입장 목표 4,000 → 2,000명</span>
                    <span className="t-xs muted">10/25(일) 18:00 · 시스템 20:04:07 KST 노출 줄이기(결제 확정 예산, 결제사 쪽 원인)</span>
                  </li>
                </>
              ) : null}
              {' '}
              {v.isPause ? (
                <>
                  <li className="col" style={{ gap: "2px", padding: "10px 0", borderBottom: "1px solid var(--border)" }}>
                    <span className="t-sm fw-b">명령 2 입장 일시정지</span>
                    <span className="t-xs muted">10/25(일) 18:00 · 민호 19:55:12 KST · Go/No-Go가 No-Go라 입장 일시정지로 시작 · 자동 만료까지 1:00 남음</span>
                  </li>
                </>
              ) : null}
              <li className="col" style={{ gap: "2px", padding: "10px 0", borderBottom: "1px solid var(--border)" }}>
                <span className="t-sm fw-b">명령 3 판매 일시정지(킬스위치) · 범위 전체</span>
                <span className="t-xs muted">수진 실행 20:01:40 KST · 판매 재개 승인 대기 9:41</span>
              </li>
              <li className="col" style={{ gap: "2px", padding: "10px 0", borderBottom: "1px solid var(--border)" }}>
                <span className="t-sm fw-b">
                  명령 4 차단{' '}
                  <span className="mono">203.0.113.0/24</span>
                </span>
                <span className="t-xs muted">민호 19:57:52 KST · 자동 만료까지 23:40 남음</span>
                <span className="t-xs">효과(실행 전 5분 → 지금, 실행 뒤 10분 동안): 차단 비율 1.2% → 3.8% · 추가 검증 통과율 94% → 93% · 이의 제기 1건 · 사람을 막는 신호 없음</span>
              </li>
            </ul>
            <div style={{ padding: "12px 14px 14px" }}>
              <div className="banner banner-info bigscreen" role="note">
                <i className="ic ic-monitor" aria-hidden="true" />
                <div className="banner-body" style={{ flexBasis: "200px" }}>
                  <span className="banner-title">되돌리기와 차단 해제는 태블릿이나 데스크톱에서 합니다</span>
                  휴대폰에서는 볼 수만 있습니다
                </div>
                <button className="btn btn-outline btn-sm" type="button">
                  <i className="ic ic-copy" aria-hidden="true" />
                  링크 복사
                </button>
              </div>
            </div>
          </section>
          <details className="widget" open>
            <summary className="widget-head">
              <span>내 승인 대기</span>
              <span className="fold-meta">
                <span className="slo slo-burning">9:41 남음</span>
                <span className="badge badge-warning">1건</span>
                <i className="ic ic-chevron-down fold-ic" aria-hidden="true" />
              </span>
            </summary>
            <div className="widget-body" style={{ gap: "8px" }}>
              <Link to="/commands" className="card-flat" style={{ display: "flex", flexDirection: "column", gap: "4px", padding: "12px 14px", color: "inherit", borderRadius: "var(--r-lg)" }}>
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
                <span className="link-more" style={{ fontSize: "13px" }}>
                  승인 화면 열기
                  <i className="ic ic-chevron-right" aria-hidden="true" />
                </span>
              </Link>
              <p className="t-xs muted">
                내가 요청한 명령 1건이 두 번째 승인을 기다립니다: 명령 4{' '}
                <span className="mono">AS64500</span>
                {' '}· 9:08 남음
              </p>
              <p className="t-xs muted">10분 안에 승인하지 않으면 요청은 취소됩니다.</p>
            </div>
          </details>
          <details className="widget">
            <summary className="widget-head">
              <span>비핵심 기능 · 명령 9</span>
              <span className="fold-meta">
                <span className="slo slo-ok">모두 켜짐</span>
                <span>7개</span>
                <i className="ic ic-chevron-down fold-ic" aria-hidden="true" />
              </span>
            </summary>
            <div className="widget-body" style={{ gap: "8px" }}>
              <ul className="col">
                <li className="row between" style={{ gap: "8px", padding: "8px 0", borderBottom: "1px solid var(--border)" }}>
                  <span className="t-sm">관람 후기</span>
                  <span className="badge badge-success">켜짐</span>
                </li>
                <li className="row between" style={{ gap: "8px", padding: "8px 0", borderBottom: "1px solid var(--border)" }}>
                  <span className="t-sm">좌석 추천</span>
                  <span className="badge badge-success">켜짐</span>
                </li>
                <li className="row between" style={{ gap: "8px", padding: "8px 0" }}>
                  <span className="t-sm">찜하기</span>
                  <span className="badge badge-success">켜짐</span>
                </li>
              </ul>
              <h3 className="eyebrow" style={{ marginTop: "4px" }}>배경 작업 멈춤</h3>
              <ul className="col">
                <li className="row between" style={{ gap: "8px", padding: "8px 0", borderBottom: "1px solid var(--border)" }}>
                  <span className="t-sm">일괄 환불의 새 묶음</span>
                  <span className="badge badge-success">켜짐</span>
                </li>
                <li className="row between" style={{ gap: "8px", padding: "8px 0", borderBottom: "1px solid var(--border)" }}>
                  <span className="t-sm">파트너 웹훅 재시도</span>
                  <span className="badge badge-success">켜짐</span>
                </li>
                <li className="row between" style={{ gap: "8px", padding: "8px 0", borderBottom: "1px solid var(--border)" }}>
                  <span className="t-sm">광고성 알림 묶음</span>
                  <span className="badge badge-success">켜짐</span>
                </li>
                <li className="row between" style={{ gap: "8px", padding: "8px 0" }}>
                  <span className="t-sm">공연예술통합전산망 재전송</span>
                  <span className="badge badge-success">켜짐</span>
                </li>
              </ul>
              <p className="t-xs muted">끄면 사유와 dry-run을 거쳐 명령 9로 실행하고, 다시 켜기로 되돌립니다.</p>
            </div>
          </details>
          <section className="col" style={{ gap: "10px" }} aria-labelledby="cat-t">
            <div className="row between" style={{ gap: "8px" }}>
              <h2 className="t-md fw-b" id="cat-t">명령 카탈로그</h2>
              <span className="t-xs muted">12종 · 1인 8 · 2인 2 · commander 1인 2</span>
            </div>
            <div className="banner banner-info bigscreen" role="note">
              <i className="ic ic-monitor" aria-hidden="true" />
              <div className="banner-body" style={{ flexBasis: "200px" }}>
                <span className="banner-title">명령 11(자동화 정지 스위치) 말고는 명령 요청을 태블릿이나 데스크톱에서 합니다</span>
                휴대폰에서는 볼 수만 있습니다
              </div>
              <button className="btn btn-outline btn-sm" type="button">
                <i className="ic ic-copy" aria-hidden="true" />
                링크 복사
              </button>
            </div>
            <ul className="col" style={{ gap: "6px" }}>
              <li className="card" style={{ display: "flex", gap: "10px", alignItems: "flex-start", padding: "10px 12px", borderRadius: "var(--r-lg)" }}>
                <span className="badge badge-outline num" style={{ minWidth: "26px", justifyContent: "center" }} aria-hidden="true">1</span>
                <span className="col grow" style={{ gap: "2px" }}>
                  <span className="t-sm fw-b">
                    <span className="sr-only">명령 1</span>
                    동시 입장 목표 조정
                  </span>
                  <span className="t-xs muted">1인 · 이 회차 한계 1,000~8,000명</span>
                </span>
                <span className="badge badge-success">적용 중</span>
              </li>
              <li className="card" style={{ display: "flex", gap: "10px", alignItems: "flex-start", padding: "10px 12px", borderRadius: "var(--r-lg)" }}>
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
              </li>
              <li className="card" style={{ display: "flex", gap: "10px", alignItems: "flex-start", padding: "10px 12px", borderRadius: "var(--r-lg)", borderColor: "var(--warning)" }}>
                <span className="badge badge-outline num" style={{ minWidth: "26px", justifyContent: "center" }} aria-hidden="true">3</span>
                <span className="col grow" style={{ gap: "3px" }}>
                  <span className="t-sm fw-b">
                    <span className="sr-only">명령 3</span>
                    판매 일시정지(킬스위치)
                  </span>
                  <span className="t-xs muted">commander 1인 실행(재인증) · 재개 2인</span>
                  <span className="row t-xs tx-warning" style={{ gap: "4px", alignItems: "flex-start" }}>
                    <i className="ic ic-lock ic-14" aria-hidden="true" style={{ marginTop: "1px" }} />
                    판매 재개가 승인 대기 중입니다(요청자 수진)
                  </span>
                  <span className="t-xs muted">판매 일시정지는 commander만 실행할 수 있습니다</span>
                </span>
                <span className="badge badge-warning">재개 승인 대기 9:41</span>
              </li>
              <li className="card" style={{ display: "flex", gap: "10px", alignItems: "flex-start", padding: "10px 12px", borderRadius: "var(--r-lg)" }}>
                <span className="badge badge-outline num" style={{ minWidth: "26px", justifyContent: "center" }} aria-hidden="true">4</span>
                <span className="col grow" style={{ gap: "3px" }}>
                  <span className="t-sm fw-b">
                    <span className="sr-only">명령 4</span>
                    ASN·IP 대역 차단
                  </span>
                  <span className="t-xs muted">1인(ASN·넓은 대역은 2인) · 최대 24시간</span>
                  <span className="row t-xs tx-warning" style={{ gap: "4px", alignItems: "flex-start" }}>
                    <i className="ic ic-lock ic-14" aria-hidden="true" style={{ marginTop: "1px" }} />
                    명령 4가 승인 대기 중입니다(요청자 민호)
                  </span>
                </span>
                <span className="badge badge-success">적용 중</span>
              </li>
              <li className="card" style={{ display: "flex", gap: "10px", alignItems: "flex-start", padding: "10px 12px", borderRadius: "var(--r-lg)", background: "var(--surface-muted)" }}>
                <span className="badge badge-outline num" style={{ minWidth: "26px", justifyContent: "center" }} aria-hidden="true">5</span>
                <span className="col grow" style={{ gap: "3px" }}>
                  <span className="t-sm fw-b">
                    <span className="sr-only">명령 5</span>
                    봇 판정 강도
                  </span>
                  <span className="t-xs muted">2인 승인 · 재인증 · 완화·기본·강화</span>
                  <span className="row t-xs muted" style={{ gap: "4px" }}>
                    <i className="ic ic-lock ic-14" aria-hidden="true" />
                    commander만 요청할 수 있습니다
                  </span>
                </span>
                <span className="badge">거부</span>
              </li>
              <li className="card" style={{ display: "flex", gap: "10px", alignItems: "flex-start", padding: "10px 12px", borderRadius: "var(--r-lg)", background: "var(--surface-muted)" }}>
                <span className="badge badge-outline num" style={{ minWidth: "26px", justifyContent: "center" }} aria-hidden="true">6</span>
                <span className="col grow" style={{ gap: "3px" }}>
                  <span className="t-sm fw-b">
                    <span className="sr-only">명령 6</span>
                    Degraded 전환
                  </span>
                  <span className="t-xs muted">2인 승인 · 재인증 · 표준 모드만</span>
                  <span className="row t-xs muted" style={{ gap: "4px" }}>
                    <i className="ic ic-lock ic-14" aria-hidden="true" />
                    commander만 요청할 수 있습니다
                  </span>
                </span>
              </li>
              <li className="card" style={{ display: "flex", gap: "10px", alignItems: "flex-start", padding: "10px 12px", borderRadius: "var(--r-lg)" }}>
                <span className="badge badge-outline num" style={{ minWidth: "26px", justifyContent: "center" }} aria-hidden="true">7</span>
                <span className="col grow" style={{ gap: "2px" }}>
                  <span className="t-sm fw-b">
                    <span className="sr-only">명령 7</span>
                    대기실 공지 배너
                  </span>
                  <span className="t-xs muted">1인 · 승인된 템플릿만</span>
                </span>
                <span className="badge">되돌림</span>
              </li>
              <li className="card" style={{ display: "flex", gap: "10px", alignItems: "flex-start", padding: "10px 12px", borderRadius: "var(--r-lg)" }}>
                <span className="badge badge-outline num" style={{ minWidth: "26px", justifyContent: "center" }} aria-hidden="true">8</span>
                <span className="col grow" style={{ gap: "2px" }}>
                  <span className="t-sm fw-b">
                    <span className="sr-only">명령 8</span>
                    로그 레벨
                  </span>
                  <span className="t-xs muted">1인 · 30분 뒤 자동 복귀</span>
                </span>
                <span className="badge">자동 만료</span>
              </li>
              <li className="card" style={{ display: "flex", gap: "10px", alignItems: "flex-start", padding: "10px 12px", borderRadius: "var(--r-lg)" }}>
                <span className="badge badge-outline num" style={{ minWidth: "26px", justifyContent: "center" }} aria-hidden="true">9</span>
                <span className="col grow" style={{ gap: "2px" }}>
                  <span className="t-sm fw-b">
                    <span className="sr-only">명령 9</span>
                    비핵심 기능 끄기
                  </span>
                  <span className="t-xs muted">1인 · 비핵심 목록만</span>
                </span>
              </li>
              <li className="card" style={{ display: "flex", gap: "10px", alignItems: "flex-start", padding: "10px 12px", borderRadius: "var(--r-lg)" }}>
                <span className="badge badge-outline num" style={{ minWidth: "26px", justifyContent: "center" }} aria-hidden="true">10</span>
                <span className="col grow" style={{ gap: "3px" }}>
                  <span className="t-sm fw-b">
                    <span className="sr-only">명령 10</span>
                    게시물 노출 차단
                  </span>
                  <span className="t-xs muted">1인 · 공문에 적힌 ID만</span>
                  <Link to="/compliance" className="link-more" style={{ fontSize: "12px" }}>
                    법정 조치에서 통보 건으로 실행합니다
                    <i className="ic ic-chevron-right" aria-hidden="true" />
                  </Link>
                </span>
              </li>
              <li className="card" style={{ display: "flex", gap: "10px", alignItems: "flex-start", padding: "10px 12px", borderRadius: "var(--r-lg)", background: "var(--surface-muted)" }}>
                <span className="badge badge-outline num" style={{ minWidth: "26px", justifyContent: "center" }} aria-hidden="true">11</span>
                <span className="col grow" style={{ gap: "3px" }}>
                  <span className="t-sm fw-b">
                    <span className="sr-only">명령 11</span>
                    자동화 정지 스위치(오토스케일 제외)
                  </span>
                  <span className="t-xs muted">commander 1인 긴급 · 재인증 · 재개 2인</span>
                  <span className="row t-xs muted" style={{ gap: "4px" }}>
                    <i className="ic ic-lock ic-14" aria-hidden="true" />
                    commander만 실행할 수 있습니다
                  </span>
                </span>
              </li>
              <li className="card" style={{ display: "flex", gap: "10px", alignItems: "flex-start", padding: "10px 12px", borderRadius: "var(--r-lg)", background: "var(--surface-muted)" }}>
                <span className="badge badge-outline num" style={{ minWidth: "26px", justifyContent: "center" }} aria-hidden="true">12</span>
                <span className="col grow" style={{ gap: "3px" }}>
                  <span className="t-sm fw-b">
                    <span className="sr-only">명령 12</span>
                    결제사 지정
                  </span>
                  <span className="t-xs muted">1인 · T-10분~T+60분 밖에서만</span>
                  <span className="row t-xs muted" style={{ gap: "4px", alignItems: "flex-start" }}>
                    <i className="ic ic-clock ic-14" aria-hidden="true" style={{ marginTop: "1px" }} />
                    온세일 윈도우 안이라 21:00 KST부터 바꿀 수 있습니다
                  </span>
                </span>
              </li>
            </ul>
          </section>
        </div>
      </>
    ) : null}
    {' '}
    {v.isProp ? (
      <>
        <div className="col" style={{ gap: "16px" }}>
          <Link to="/commands" className="link-more" style={{ alignSelf: "flex-start" }}>
            <i className="ic ic-chevron-left" aria-hidden="true" />
            운영 명령
          </Link>
          <div className="col" style={{ gap: "10px" }}>
            <div className="row" style={{ gap: "8px", alignItems: "flex-start" }}>
              <span className="badge badge-outline num" style={{ minWidth: "26px", justifyContent: "center", marginTop: "2px" }} aria-hidden="true">
                3
              </span>
              <h1 className="t-lg">
                <span className="sr-only">명령 3</span>
                판매 일시정지(킬스위치) · 전파
              </h1>
            </div>
            <div className="row wrap" style={{ gap: "6px" }}><span className="badge badge-primary">전파 중 4/5</span></div>
          </div>
          <nav aria-label="명령 진행 단계">
            <ol className="stepper" style={{ display: "grid", gridTemplateColumns: "repeat(3,minmax(0,1fr))", gap: "10px 8px" }}>
              <li className="step is-done">
                <span className="step-num"><i className="ic ic-check" aria-hidden="true" /></span>
                <span className="sr-only">완료:</span>
                사유
              </li>
              <li className="step is-done">
                <span className="step-num"><i className="ic ic-check" aria-hidden="true" /></span>
                <span className="sr-only">완료:</span>
                파라미터
              </li>
              <li className="step is-done">
                <span className="step-num"><i className="ic ic-check" aria-hidden="true" /></span>
                <span className="sr-only">완료:</span>
                dry-run
              </li>
              <li className="step is-done">
                <span className="step-num"><i className="ic ic-check" aria-hidden="true" /></span>
                <span className="sr-only">완료:</span>
                재인증
              </li>
              <li className="step is-current" aria-current="step">
                <span className="step-num">5</span>
                전파 ack
              </li>
            </ol>
          </nav>
          <div className="banner banner-danger" role="status">
            <i className="ic ic-stop" aria-hidden="true" />
            <div className="banner-body">
              <span className="banner-title">판매 일시정지를 1인 실행으로 걸었습니다. 10/16(금) 20:04 KST까지 사후 검토 보고서를 써야 합니다</span>
              명령 3 · 수진 20:04:09 KST · 10/25(일) 18:00 회차. 실행은 인시던트 선언 기준입니다.
            </div>
          </div>
          <section className="widget" aria-labelledby="ack-t">
            <div className="widget-head">
              <h2 id="ack-t" style={{ fontSize: "13px", lineHeight: "18px" }}>⑤ 전파 ack</h2>
              <div className="actions"><span className="t-sm fw-b num">4/5</span></div>
            </div>
            <div className="widget-body" style={{ gap: "10px" }}>
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
                <li className="row" style={{ gap: "10px", padding: "10px 0" }}>
                  <span className="spinner tx-link" aria-hidden="true" />
                  <span className="mono t-sm grow">purchase-svc-3</span>
                  <span className="t-xs muted num">1.4초 경과</span>
                  <span className="badge badge-primary">전파 중</span>
                </li>
              </ul>
              <p className="t-sm" role="status" aria-live="polite">전파 중 · ack 4/5 · 3초 안에 모두 받으면 적용 중으로 바뀝니다.</p>
              <p className="t-xs muted">ack한 파드부터 새 좌석 홀드와 결제 접수를 막습니다. 팬 화면 안내: "판매가 잠시 멈췄습니다. 고른 좌석은 홀드 시간 동안 유지됩니다"</p>
            </div>
          </section>
          <section className="widget" aria-labelledby="rec-t">
            <div className="widget-head"><h2 id="rec-t" style={{ fontSize: "13px", lineHeight: "18px" }}>실행 기록</h2></div>
            <div className="widget-body">
              <dl className="col" style={{ gap: "10px" }}>
                <div className="col" style={{ gap: "2px" }}>
                  <dt className="t-xs muted">실행</dt>
                  <dd className="t-sm fw-m num">수진 · commander · 20:04:09 KST · 재인증 · 1인</dd>
                </div>
                <div className="col" style={{ gap: "2px" }}>
                  <dt className="t-xs muted">사후 검토</dt>
                  <dd className="t-sm fw-m">인시던트 선언 기준 · 보고서 기한 10/16(금) 20:04 KST(48시간)</dd>
                </div>
                <div className="col" style={{ gap: "2px" }}>
                  <dt className="t-xs muted">회차·범위</dt>
                  <dd className="t-sm fw-m">10/25(일) 18:00 · 회차</dd>
                </div>
                <div className="col" style={{ gap: "2px" }}>
                  <dt className="t-xs muted">사유</dt>
                  <dd className="t-sm">결제사 승인 응답이 늦어 결과 불명 주문이 늘고 있습니다. 원인을 확인하는 동안 10/25(일) 18:00 회차의 새 좌석 홀드와 결제 접수를 멈춥니다. 처리 중 결제는 완결합니다.</dd>
                </div>
                <div className="col" style={{ gap: "2px" }}>
                  <dt className="t-xs muted">명령 ID</dt>
                  <dd className="row" style={{ gap: "6px" }}>
                    <span className="hash grow">01929f3c-7a1e-7b42-9c3d-6e2a8f4b1d05</span>
                    <button className="icon-btn icon-btn-sm" type="button" aria-label="명령 ID 복사"><i className="ic ic-copy" aria-hidden="true" /></button>
                  </dd>
                </div>
              </dl>
            </div>
          </section>
          <div className="banner banner-info bigscreen" role="note">
            <i className="ic ic-monitor" aria-hidden="true" />
            <div className="banner-body" style={{ flexBasis: "200px" }}>
              <span className="banner-title">판매 재개 요청과 사후 검토 보고서 작성은 태블릿이나 데스크톱에서 합니다</span>
              휴대폰에서는 볼 수만 있습니다
            </div>
            <button className="btn btn-outline btn-sm" type="button">
              <i className="ic ic-copy" aria-hidden="true" />
              링크 복사
            </button>
          </div>
        </div>
      </>
    ) : null}
    {' '}
    {v.isSet ? (
      <>
        <div className="col" style={{ gap: "16px" }}>
          <Link to="/commands" className="link-more" style={{ alignSelf: "flex-start" }}>
            <i className="ic ic-chevron-left" aria-hidden="true" />
            운영 명령
          </Link>
          <div className="col" style={{ gap: "10px" }}>
            <div className="row" style={{ gap: "8px", alignItems: "flex-start" }}>
              <span className="badge badge-outline num" style={{ minWidth: "26px", justifyContent: "center", marginTop: "2px" }} aria-hidden="true">
                5
              </span>
              <h1 className="t-lg">
                <span className="sr-only">명령 5</span>
                봇 판정 강도 · 적용 확인
              </h1>
            </div>
            <div className="row wrap" style={{ gap: "6px" }}>
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
          <nav aria-label="명령 진행 단계">
            <ol className="stepper" style={{ display: "grid", gridTemplateColumns: "repeat(3,minmax(0,1fr))", gap: "10px 8px" }}>
              <li className="step is-done">
                <span className="step-num"><i className="ic ic-check" aria-hidden="true" /></span>
                <span className="sr-only">완료:</span>
                사유
              </li>
              <li className="step is-done">
                <span className="step-num"><i className="ic ic-check" aria-hidden="true" /></span>
                <span className="sr-only">완료:</span>
                파라미터
              </li>
              <li className="step is-done">
                <span className="step-num"><i className="ic ic-check" aria-hidden="true" /></span>
                <span className="sr-only">완료:</span>
                dry-run
              </li>
              <li className="step is-done">
                <span className="step-num"><i className="ic ic-check" aria-hidden="true" /></span>
                <span className="sr-only">완료:</span>
                재인증
              </li>
              <li className="step is-done">
                <span className="step-num"><i className="ic ic-check" aria-hidden="true" /></span>
                <span className="sr-only">완료:</span>
                2인 승인
              </li>
              {v.setOk ? (
                <>
                  <li className="step is-done">
                    <span className="step-num"><i className="ic ic-check" aria-hidden="true" /></span>
                    <span className="sr-only">완료:</span>
                    적용 확인
                  </li>
                </>
              ) : null}
              {v.setOpen ? (
                <>
                  <li className="step is-current" aria-current="step">
                    <span className="step-num">6</span>
                    적용 확인
                  </li>
                </>
              ) : null}
            </ol>
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
          <section className="widget" aria-labelledby="set-ap-t">
            <div className="widget-head">
              <h2 id="set-ap-t" style={{ fontSize: "13px", lineHeight: "18px" }}>⑥ 적용 확인</h2>
              <div className="actions"><span className="t-sm fw-b num">{v.setCount}</span></div>
            </div>
            <div className="widget-body" style={{ gap: "10px" }}>
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
            </div>
          </section>
          <section className="widget" aria-labelledby="set-rec-t">
            <div className="widget-head"><h2 id="set-rec-t" style={{ fontSize: "13px", lineHeight: "18px" }}>실행 기록</h2></div>
            <div className="widget-body">
              <dl className="col" style={{ gap: "10px" }}>
                <div className="col" style={{ gap: "2px" }}>
                  <dt className="t-xs muted">요청</dt>
                  <dd className="t-sm fw-m num">수진 · commander · 20:03:12 KST · 재인증</dd>
                </div>
                <div className="col" style={{ gap: "2px" }}>
                  <dt className="t-xs muted">승인</dt>
                  <dd className="t-sm fw-m num">민호 · operator · {v.setAt} KST · 재인증</dd>
                </div>
                <div className="col" style={{ gap: "2px" }}>
                  <dt className="t-xs muted">파라미터</dt>
                  <dd className="t-sm fw-m">강도 기본 → 강화 · 대기 중 재평가 모드 그림자(그대로)</dd>
                </div>
                <div className="col" style={{ gap: "2px" }}>
                  <dt className="t-xs muted">설정 판</dt>
                  <dd className="t-sm fw-m num">판 17 → 판 18</dd>
                </div>
                <div className="col" style={{ gap: "2px" }}>
                  <dt className="t-xs muted">전달 경로</dt>
                  <dd className="t-sm fw-m">카프카 설정 사건 → trust-svc 준비된 모든 파드</dd>
                </div>
                <div className="col" style={{ gap: "2px" }}>
                  <dt className="t-xs muted">사유</dt>
                  <dd className="t-sm">봇 의심 진입이 늘어 판정 강도를 한 단계 올립니다. 효과 줄을 보며 사람을 막는 신호가 보이면 되돌립니다.</dd>
                </div>
                <div className="col" style={{ gap: "2px" }}>
                  <dt className="t-xs muted">명령 ID</dt>
                  <dd className="row" style={{ gap: "6px" }}>
                    <span className="hash grow">01929f3b-5c20-7a8e-b4d1-2f6c9e0a7d13</span>
                    <button className="icon-btn icon-btn-sm" type="button" aria-label="명령 ID 복사"><i className="ic ic-copy" aria-hidden="true" /></button>
                  </dd>
                </div>
              </dl>
            </div>
          </section>
          <div className="banner banner-info bigscreen" role="note">
            <i className="ic ic-monitor" aria-hidden="true" />
            <div className="banner-body" style={{ flexBasis: "200px" }}>
              <span className="banner-title">되돌리기(직전 단계로)는 태블릿이나 데스크톱에서 합니다</span>
              휴대폰에서는 볼 수만 있습니다
            </div>
            <button className="btn btn-outline btn-sm" type="button">
              <i className="ic ic-copy" aria-hidden="true" />
              링크 복사
            </button>
          </div>
        </div>
      </>
    ) : null}
    {' '}
    {v.isReport ? (
      <>
        <div className="col" style={{ gap: "16px" }}>
          <Link to="/commands" className="link-more" style={{ alignSelf: "flex-start" }}>
            <i className="ic ic-chevron-left" aria-hidden="true" />
            운영 명령
          </Link>
          <div className="col" style={{ gap: "10px" }}>
            <div className="row" style={{ gap: "8px", alignItems: "flex-start" }}>
              <span className="badge badge-outline num" style={{ minWidth: "26px", justifyContent: "center", marginTop: "2px" }} aria-hidden="true">
                11
              </span>
              <h1 className="t-lg">
                <span className="sr-only">명령 11</span>
                자동화 정지 스위치 · 사후 검토 보고서
              </h1>
            </div>
            <div className="row wrap" style={{ gap: "6px" }}>
              <span className="badge badge-success">적용 중</span>
              <span className="badge badge-warning">보고서 작성 전</span>
            </div>
          </div>
          <div className="banner banner-danger" role="status">
            <i className="ic ic-stop" aria-hidden="true" />
            <div className="banner-body">
              <span className="banner-title">입장 제어 자동화를 1인 긴급 실행으로 멈췄습니다. 10/16(금) 20:04 KST까지 사후 검토 보고서를 써야 합니다</span>
              AIMD 조정·버짓 연동 감축·Degraded 후보 추천이 멈췄고 오토스케일은 계속됩니다. 다시 켜려면 2인 승인이 필요합니다.
            </div>
          </div>
          <div className="banner banner-info bigscreen" role="note">
            <i className="ic ic-monitor" aria-hidden="true" />
            <div className="banner-body" style={{ flexBasis: "200px" }}>
              <span className="banner-title">사후 검토 보고서 작성과 재개 요청은 태블릿이나 데스크톱에서 합니다</span>
              휴대폰에서는 볼 수만 있습니다
            </div>
            <button className="btn btn-outline btn-sm" type="button">
              <i className="ic ic-copy" aria-hidden="true" />
              링크 복사
            </button>
          </div>
          <section className="widget" aria-labelledby="rp1-t">
            <div className="widget-head">
              <h2 id="rp1-t" style={{ fontSize: "13px", lineHeight: "18px" }}>실행 기록</h2>
              <div className="actions"><span className="badge">★ 자동 채움</span></div>
            </div>
            <div className="widget-body">
              <dl className="col" style={{ gap: "10px" }}>
                <div className="col" style={{ gap: "2px" }}>
                  <dt className="t-xs muted">명령 ID</dt>
                  <dd className="hash">01929f3e-2b40-7c11-8d5a-4f7e1c9a3b62</dd>
                </div>
                <div className="col" style={{ gap: "2px" }}>
                  <dt className="t-xs muted">실행자</dt>
                  <dd className="t-sm fw-m">수진 · commander</dd>
                </div>
                <div className="col" style={{ gap: "2px" }}>
                  <dt className="t-xs muted">실행 시각</dt>
                  <dd className="t-sm fw-m num">10/14(수) 20:04:02 KST · 재인증 20:03:58 KST</dd>
                </div>
                <div className="col" style={{ gap: "2px" }}>
                  <dt className="t-xs muted">실행 사유 원문</dt>
                  <dd className="t-sm">결제 확정 소진 경보가 지표 공백 때문에 잘못 울리는 것으로 보입니다. 확인하는 동안 입장 제어 자동화를 멈춥니다.</dd>
                </div>
              </dl>
            </div>
          </section>
          <section className="widget" aria-labelledby="rp-dl-t">
            <div className="widget-head"><h2 id="rp-dl-t" style={{ fontSize: "13px", lineHeight: "18px" }}>보고서 기한</h2></div>
            <div className="widget-body" style={{ gap: "8px" }}>
              <dl className="kv">
                <dt>작성</dt>
                <dd>10/16(금) 20:04 KST · 실행 뒤 48시간</dd>
                <dt>검토</dt>
                <dd>제출 뒤 7일 · 다른 commander</dd>
                <dt>재개</dt>
                <dd><span className="badge badge-danger">정지 중</span></dd>
              </dl>
              <p className="t-xs muted">기한을 넘기면 SEV3로 알립니다. 보고서는 재개(2인 승인)의 조건이 아닙니다.</p>
            </div>
          </section>
        </div>
      </>
    ) : null}
    {' '}
    {v.isC11 ? (
      <>
        <div className="col" style={{ gap: "16px" }}>
          <Link to="/commands" className="link-more" style={{ alignSelf: "flex-start" }}>
            <i className="ic ic-chevron-left" aria-hidden="true" />
            운영 명령
          </Link>
          <div className="col" style={{ gap: "10px" }}>
            <div className="row" style={{ gap: "8px", alignItems: "flex-start" }}>
              <span className="badge badge-outline num" style={{ minWidth: "26px", justifyContent: "center", marginTop: "2px" }} aria-hidden="true">
                11
              </span>
              <h1 className="t-lg">
                <span className="sr-only">명령 11</span>
                자동화 정지 스위치(오토스케일 제외)
              </h1>
            </div>
            <div className="row wrap" style={{ gap: "6px" }}>
              <span className="badge badge-outline">commander 1인 긴급</span>
              <span className="badge">재인증</span>
              <span className="badge">재개 2인</span>
            </div>
          </div>
          <p className="t-sm muted">휴대폰에서도 하는 안전 쪽 조치입니다. 잘못 눌러도 자동 조절이 멈추고 목표가 그 자리에 머물 뿐이며(오토스케일은 계속), 다시 켜기는 2인 승인입니다.</p>
          <button className="btn btn-danger btn-lg btn-block" type="button">
            <i className="ic ic-stop" aria-hidden="true" />
            자동화 정지
          </button>
        </div>
      </>
    ) : null}
    </>
  );
}

export function OverlaysM({ v, close }: { v: V; close?: () => void }) {
  void v; void close;
  return (
    <>
    {v.showReauth ? (
      <>
        <Overlay placement="bottom" onClose={close}>
          <div className="sheet" role="dialog" aria-modal="true" aria-labelledby="ra-t" aria-describedby="ra-d">
            <span className="sheet-handle" aria-hidden="true" />
            <div className="row" style={{ gap: "8px" }}>
              <i className="ic ic-key" aria-hidden="true" />
              <h2 className="t-lg" id="ra-t">승인하려면 다시 인증합니다</h2>
            </div>
            <p className="t-sm muted" id="ra-d">판매 재개(명령 3 되돌리기) · 요청자 수진. 비밀번호와 인증 앱 코드로 다시 인증하고, 등록한 패스키로 한 번 더 확인하면 5분 동안 쓰는 재인증 토큰을 받고 바로 승인합니다.</p>
            {v.pkStep1 ? (
              <>
                <div className="field">
                  <label className="label" htmlFor="ra-pw">비밀번호</label>
                  <input className="input" id="ra-pw" type="password" autoComplete="current-password" defaultValue="xxxxxxxxxxxxxxxx" />
                </div>
                <div className="field">
                  <label className="label" htmlFor="ra-otp">인증 앱 코드 6자리</label>
                  {' '}
                  <input className="otp-input" id="ra-otp" type="text" inputMode="numeric" autoComplete="one-time-code" maxLength={6} pattern="[0-9]*" defaultValue="48190" aria-describedby="ra-otp-h" />
                  {' '}
                  <span className="hint" id="ra-otp-h">휴대폰을 잃을 때 로그인과 인증 앱 코드를 함께 잃지 않도록, 인증 앱은 이 휴대폰이 아닌 다른 기기에 두기를 권합니다.</span>
                </div>
                <p className="row t-sm" style={{ gap: "8px", alignItems: "center" }}>
                  <i className="ic ic-key ic-16" aria-hidden="true" />
                  등록한 패스키로 한 번 더 확인합니다
                </p>
                <button className="btn btn-primary btn-lg btn-block" type="button">인증하고 계속</button>
                {' '}
                <button className="btn btn-ghost btn-block" type="button">닫기</button>
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
                    <button className="btn btn-primary btn-lg btn-block" type="button">
                      <i className="ic ic-key" aria-hidden="true" />
                      패스키로 확인
                    </button>
                    <p className="t-xs muted">패스키 창은 브라우저가 띄웁니다. 확인하면 바로 승인하고 전파합니다.</p>
                  </>
                ) : null}
                {' '}
                {v.pkNone ? (
                  <>
                    <button className="btn btn-primary btn-lg btn-block" type="button" aria-disabled="true" aria-describedby="ra-none">
                      <i className="ic ic-key" aria-hidden="true" />
                      패스키로 확인
                    </button>
                    {' '}
                    <Link to="/me" className="link-more" style={{ alignSelf: "flex-start" }}>
                      내 계정 열기
                      <i className="ic ic-chevron-right" aria-hidden="true" />
                    </Link>
                  </>
                ) : null}
                {' '}
                <button className="btn btn-ghost btn-block" type="button">닫기</button>
              </>
            ) : null}
          </div>
        </Overlay>
      </>
    ) : null}
    {v.isC11 ? (
      <>
        <Overlay placement="bottom" onClose={close}>
          <div className="sheet" role="alertdialog" aria-modal="true" aria-labelledby="c11-t" aria-describedby="c11-d">
            <span className="sheet-handle" aria-hidden="true" />
            <div className="row" style={{ gap: "8px" }}>
              <i className="ic ic-stop" aria-hidden="true" />
              <h2 className="t-lg" id="c11-t">자동화 정지 스위치를 실행합니다</h2>
            </div>
            <dl className="kv" id="c11-d" style={{ fontSize: "13px", lineHeight: "18px", padding: "12px 14px", borderRadius: "var(--r-md)", background: "var(--surface-muted)" }}>
              <dt>멈추는 것</dt>
              <dd>AIMD · 에러 버짓 연동 감축 · Degraded 후보 추천</dd>
              <dt>계속되는 것</dt>
              <dd>오토스케일</dd>
            </dl>
            <p className="t-sm fw-b">다시 켜려면 2인 승인이 필요합니다</p>
            <div className="field">
              <label className="label" htmlFor="c11-r">
                실행 사유{' '}
                <span className="opt">(필수)</span>
              </label>
              <textarea className="textarea" id="c11-r" style={{ minHeight: "76px", fontSize: "14px", lineHeight: "21px" }} defaultValue="결제 확정 소진 경보가 지표 공백 때문에 잘못 울리는 것으로 보입니다. 확인하는 동안 입장 제어 자동화를 멈춥니다." />
            </div>
            <p className="t-xs muted">누르면 비밀번호와 인증 앱 코드로 다시 인증하고, 등록한 패스키로 한 번 더 확인합니다. 실행 뒤 48시간 안에 쓰는 사후 검토 보고서는 태블릿이나 데스크톱에서 씁니다.</p>
            <button className="btn btn-danger btn-lg btn-block" type="button">
              <i className="ic ic-stop" aria-hidden="true" />
              자동화 정지
            </button>
            {' '}
            <button className="btn btn-ghost btn-block" type="button">닫기</button>
          </div>
        </Overlay>
      </>
    ) : null}
    {v.isPause ? (
      <>
        <Overlay placement="bottom" onClose={close}>
          <div className="sheet" role="alertdialog" aria-modal="true" aria-labelledby="pz-t" aria-describedby="pz-d pz-ng">
            <span className="sheet-handle" aria-hidden="true" />
            <div className="row between" style={{ gap: "8px" }}>
              <span className="state-icon is-warning" style={{ width: "44px", height: "44px" }}><i className="ic ic-pause" aria-hidden="true" /></span>
              <span className="timer is-warning" role="timer" aria-label="자동 재개까지 1분">
                <i className="ic ic-clock" aria-hidden="true" />
                1:00
              </span>
            </div>
            <h2 className="t-lg" id="pz-t">입장 일시정지가 1분 뒤 끝납니다</h2>
            <p className="t-sm" id="pz-d">연장하지 않으면 20:05:12 KST에 이 회차의 입장이 자동으로 다시 시작됩니다. 계속 멈춰야 하면 사유를 적고 10분 연장합니다.</p>
            <dl className="col" style={{ gap: "8px", padding: "12px 14px", borderRadius: "var(--r-md)", background: "var(--surface-muted)" }}>
              <div className="col" style={{ gap: "2px" }}>
                <dt className="t-xs muted">명령</dt>
                <dd className="t-sm fw-m">명령 2 입장 일시정지 · 10/25(일) 18:00 회차</dd>
              </div>
              <div className="col" style={{ gap: "2px" }}>
                <dt className="t-xs muted">요청</dt>
                <dd className="t-sm fw-m">민호 · operator · 19:55:12 KST · Go/No-Go가 No-Go라 입장 일시정지로 시작</dd>
              </div>
            </dl>
            <div className="banner banner-danger" id="pz-ng">
              <i className="ic ic-alert-circle" aria-hidden="true" />
              <div className="banner-body">아직 실패한 필수 항목: 시계 오프셋</div>
            </div>
            <div className="banner banner-info bigscreen" role="note">
              <i className="ic ic-monitor" aria-hidden="true" />
              <div className="banner-body" style={{ flexBasis: "200px" }}>
                <span className="banner-title">연장과 재개는 태블릿이나 데스크톱에서 합니다</span>
                휴대폰에서는 볼 수만 있습니다
              </div>
              <button className="btn btn-outline btn-sm" type="button">
                <i className="ic ic-copy" aria-hidden="true" />
                링크 복사
              </button>
            </div>
            <button className="btn btn-ghost btn-block" type="button">닫기</button>
          </div>
        </Overlay>
      </>
    ) : null}
    </>
  );
}
