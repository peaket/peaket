// 디자인 캔버스 보드 SCR-047-m.dc.html를 옮긴 것(dc2tsx 생성 뒤 손질)
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

export const STATES_M = ["제2 승인 대기", "확정 직전 확인", "판정 대기", "일괄 환불 진행 중", "자동 정지", "일부 실패로 완료"] as const;
export const DEFAULT_M = "제2 승인 대기";

export function valsM(state: string) {
    let st = state || '제2 승인 대기';
    let isWait = st === '제2 승인 대기';
    let isConfirm = st === '확정 직전 확인';
    let isJudge = st === '판정 대기';
    let isRun = st === '일괄 환불 진행 중';
    let isPaused = st === '자동 정지';
    let isDone = st === '일부 실패로 완료';
    let isApprover = isWait || isConfirm;
    return {
      viewerMinho: isApprover,
      viewerSujin: !isApprover,
      isJudge: isJudge,
      isApprover: isApprover,
      isConfirm: isConfirm,
      isRun: isRun,
      isPaused: isPaused,
      isDone: isDone,
      judged: !isJudge,
      beforeConfirm: isJudge || isApprover,
      afterConfirm: isRun || isPaused || isDone
    };
  }

type V = ReturnType<typeof valsM>;

// 보드 루트: {"class": "pk dark cs cs-compact", "style": "width:360px;min-height:3770px"}

// <main class="cs-main" id="main">
export function MainM({ v, close, go }: { v: V; close?: () => void; go?: (state: string) => void }) {
  void v; void close; void go;
  const ro = useRo();
  return (
    <>
    <div className="col" style={{ gap: "8px" }}>
      <nav className="breadcrumb" aria-label="위치">
        <Link to="/cancellations/cr-lumen-r1">회차 취소</Link>
        <i className="ic ic-chevron-right" aria-hidden="true" />
        <span>LUMEN 콘서트 2026 서울 · 10/26(월) 17:00</span>
      </nav>
      <h1 className="t-lg">회차 취소 판정·일괄 환불</h1>
      <div className="row wrap" style={{ gap: "6px" }}>
        {v.isJudge ? (
          <>
            <span className="badge badge-lg badge-warning">판정 대기</span>
          </>
        ) : null}
        {' '}
        {v.isApprover ? (
          <>
            <span className="badge badge-lg badge-warning">두 번째 승인 대기</span>
          </>
        ) : null}
        {' '}
        {v.isRun ? (
          <>
            <span className="badge badge-lg badge-primary">환불 진행 중</span>
          </>
        ) : null}
        {' '}
        {v.isPaused ? (
          <>
            <span className="badge badge-lg badge-danger">자동 정지</span>
          </>
        ) : null}
        {' '}
        {v.isDone ? (
          <>
            <span className="badge badge-lg badge-success">환불 완료 · 실패 3건</span>
          </>
        ) : null}
      </div>
      <p className="t-sm muted">파트너 요청의 귀책을 판정하고, 판정한 분 외 한 분의 승인으로 확정한 뒤 결제사 처리 한도 안에서 나눠 환불합니다.</p>
    </div>
    {v.isPaused ? (
      <>
        <div className="banner banner-danger" role="alert">
          <i className="ic ic-stop" aria-hidden="true" />
          <div className="banner-body">
            <span className="banner-title">토스페이먼츠 몫이 멈췄습니다: 1분 취소 실패율 5% 이상. 다른 결제사 몫은 계속합니다</span>
            20:01 KST에 스스로 멈췄습니다. 실패 37건을 CS 처리함에서 확인하고 재개 조건을 본 뒤 재개하세요. 결과 모름 4건은 재개 때 결제사 조회로 먼저 확인합니다. 재개는 2인 확정 범위 안에서 commander가 합니다.
            <div style={{ marginTop: "8px" }}>
              <a className="link-more" href="#bk-h">
                일괄 환불 보기
                <i className="ic ic-chevron-right" aria-hidden="true" />
              </a>
            </div>
          </div>
        </div>
      </>
    ) : null}
    <section className="widget" aria-labelledby="req-h">
      <div className="widget-head">
        <h2 className="t-sm fw-b" id="req-h">파트너 요청</h2>
        <span className="mono t-xs muted">CR-0003</span>
        <div className="actions"><span className="badge badge-outline">(주)스텔라엔터테인먼트</span></div>
      </div>
      <div className="widget-body">
        <div style={{ display: "grid", gridTemplateColumns: "repeat(2,minmax(0,1fr))", gap: "14px 16px" }}>
          <div className="col" style={{ gap: "4px", gridColumn: "1/-1" }}>
            <span className="eyebrow">회차</span>
            <span className="t-sm fw-b">LUMEN 콘서트 2026 서울</span>
            <span className="t-sm">10/26(월) 17:00 · 피켓 아레나</span>
          </div>
          <div className="col" style={{ gap: "4px" }}>
            <span className="eyebrow">요청</span>
            <span className="badge badge-danger" style={{ alignSelf: "flex-start" }}>회차 취소</span>
            <span className="t-xs muted">접수 10/19(월) 14:20 KST</span>
          </div>
          <div className="col" style={{ gap: "4px" }}>
            <span className="eyebrow">귀책 의견 · 파트너 참고값</span>
            <span className="t-sm">주최 측 귀책</span>
          </div>
          <div className="col" style={{ gap: "4px", gridColumn: "1/-1" }}>
            <span className="eyebrow">판매</span>
            <span className="t-sm">2,400석 모두 판매 · 주문 1,152건</span>
          </div>
          <div className="col" style={{ gap: "4px", gridColumn: "1/-1" }}>
            <span className="eyebrow">사유</span>
            <p className="t-sm">"무대 장치 제작이 늦어져 10/26 공연 준비를 마칠 수 없습니다."</p>
          </div>
          <div className="col" style={{ gap: "4px", gridColumn: "1/-1" }}>
            <span className="eyebrow">증빙</span>
            <span className="t-sm">참조만 받음 · [증빙 참조]</span>
            <span className="t-xs muted">파일은 받지 않습니다</span>
          </div>
        </div>
      </div>
    </section>
    <section className="widget" aria-label="귀책 판정">
      {v.isJudge ? (
        <>
          <div className="col">
            <div className="widget-head"><h2 className="t-sm fw-b">귀책 판정</h2></div>
            <div className="widget-body" style={{ gap: "12px" }}>
              <div className="row wrap" style={{ gap: "6px" }}>
                <span className="badge badge-warning">
                  <i className="ic ic-clock" aria-hidden="true" />
                  <span className="sr-only">판정 기한</span>
                  10/20(화) 14:20 KST까지 · 1영업일 남음
                </span>
              </div>
              <div className="banner banner-info bigscreen" role="note">
                <i className="ic ic-monitor" aria-hidden="true" />
                <div className="banner-body" style={{ flexBasis: "200px" }}>
                  <span className="banner-title">귀책 판정과 요청 반려는 태블릿이나 데스크톱에서 합니다</span>
                  휴대폰에서는 볼 수만 있습니다
                </div>
                <button onClick={copyLink} className="btn btn-outline btn-sm" type="button">
                  <i className="ic ic-copy" aria-hidden="true" />
                  링크 복사
                </button>
              </div>
              <div className="col" style={{ gap: "6px" }}>
                <h3 className="eyebrow">통지 문안 미리보기 · 취소</h3>
                <div className="card-flat pad col" style={{ gap: "6px" }}>
                  <span className="t-xs muted">받는 사람: 결제자와 보유자(환급 일정은 결제자) · 이메일(알림톡은 발송 대행 계약 뒤)</span>
                  {' '}
                  <span className="t-sm fw-b">제목: [피켓] LUMEN 콘서트 2026 서울 10/26(월) 17:00 공연이 취소되었습니다</span>
                  <p className="t-sm">
                    LUMEN 콘서트 2026 서울 10/26(월) 17:00(피켓 아레나) 공연이 취소되었습니다. 취소 사유: 무대 장치 제작이 늦어져 공연 준비를 마칠 수 없습니다. 결제하신 금액은 공제 없이 전액 환급합니다. 결제하신 수단으로 10/22(목)까지 결제 취소를 마치며, 카드사나 은행에 따라 실제로 돌려받는 날은 이보다 늦을 수 있습니다. 이번 취소는 소비자분쟁해결기준의 배상 대상으로 판정되어, 배상금(실제 결제 금액의 10%)을 판매자를 대신해 피켓이 먼저 지급합니다.
                  </p>
                  <span className="btn btn-outline btn-sm" style={{ alignSelf: "flex-start" }}>배상금 계좌 입력하기</span>
                  <p className="t-xs muted">… 판매자: (주)스텔라엔터테인먼트. PEAKET은 통신판매중개자로서 …</p>
                  <span className="t-xs muted">양도받은 분에게는 '환급은 결제하신 분께 갑니다' 문단이 갑니다</span>
                </div>
              </div>
            </div>
          </div>
        </>
      ) : null}
      {' '}
      {v.judged ? (
        <>
          <div className="col">
            <div className="widget-head">
              <h2 className="t-sm fw-b">귀책 판정</h2>
              <div className="actions">
                <span className="badge badge-success">
                  <i className="ic ic-check" aria-hidden="true" />
                  판정함
                </span>
              </div>
            </div>
            <div className="widget-body" style={{ gap: "12px" }}>
              <div className="col" style={{ gap: "6px" }}>
                <span className="badge badge-lg badge-primary" style={{ alignSelf: "flex-start" }}>주최 측 귀책</span>
                <span className="t-sm muted">판정 수진(commander) · 10/19(월) 19:40 KST · 기한 안</span>
              </div>
              <div className="col" style={{ gap: "6px" }}>
                <span className="eyebrow">판정 사유</span>
                <p className="card-flat pad t-sm">"파트너 공문에서 무대 장치 제작 지연이 주최 측 사정임을 확인했습니다."</p>
              </div>
              <div className="check-row">
                <input className="cb" type="checkbox" id="jd-ev2" defaultChecked disabled />
                <label className="t-sm" htmlFor="jd-ev2">파트너가 보낸 증빙 참조를 확인했습니다</label>
              </div>
              <div className="col" style={{ gap: "6px" }}>
                <div className="row between">
                  <h3 className="eyebrow">통지 문안 · 취소</h3>
                  {v.afterConfirm ? (
                    <>
                      <span className="badge badge-success">발송함 19:52 KST</span>
                    </>
                  ) : null}
                </div>
                <div className="card-flat pad col" style={{ gap: "6px" }}>
                  <span className="t-xs muted">받는 사람: 결제자와 보유자(환급 일정은 결제자) · 이메일(알림톡은 발송 대행 계약 뒤)</span>
                  {' '}
                  <span className="t-sm fw-b">제목: [피켓] LUMEN 콘서트 2026 서울 10/26(월) 17:00 공연이 취소되었습니다</span>
                  <p className="t-sm">
                    LUMEN 콘서트 2026 서울 10/26(월) 17:00(피켓 아레나) 공연이 취소되었습니다. 취소 사유: 무대 장치 제작이 늦어져 공연 준비를 마칠 수 없습니다. 결제하신 금액은 공제 없이 전액 환급합니다. 결제하신 수단으로 10/22(목)까지 결제 취소를 마치며, 카드사나 은행에 따라 실제로 돌려받는 날은 이보다 늦을 수 있습니다. 이번 취소는 소비자분쟁해결기준의 배상 대상으로 판정되어, 배상금(실제 결제 금액의 10%)을 판매자를 대신해 피켓이 먼저 지급합니다.
                  </p>
                  <span className="btn btn-outline btn-sm" style={{ alignSelf: "flex-start" }}>배상금 계좌 입력하기</span>
                  <p className="t-xs muted">… 판매자: (주)스텔라엔터테인먼트. PEAKET은 통신판매중개자로서 …</p>
                  <span className="t-xs muted">양도받은 분에게는 '환급은 결제하신 분께 갑니다' 문단이 갑니다</span>
                </div>
              </div>
            </div>
          </div>
        </>
      ) : null}
    </section>
    <section className="widget" aria-labelledby="dry-h">
      <div className="widget-head">
        <h2 className="t-sm fw-b" id="dry-h">미리보기(dry-run)</h2>
        <div className="actions">
          {v.isJudge ? (
            <>
              <span className="badge">고른 판정 기준</span>
            </>
          ) : null}
          {' '}
          {v.judged ? (
            <>
              <span className="badge badge-outline">확정에 쓰는 값</span>
            </>
          ) : null}
        </div>
      </div>
      <div className="widget-body" style={{ gap: "14px" }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(2,minmax(0,1fr))", gap: "8px" }}>
          <div className="stat" style={{ padding: "10px 12px" }}>
            <span className="stat-label">대상 주문</span>
            <span className="t-md fw-b num">1,152건</span>
            <span className="stat-meta">티켓 2,400매</span>
          </div>
          <div className="stat" style={{ padding: "10px 12px" }}>
            <span className="stat-label">환급 총액</span>
            <span className="t-md fw-b num">₩310,200,000</span>
            <span className="stat-meta">전액 · 원결제 수단</span>
          </div>
          <div className="stat" style={{ padding: "10px 12px" }}>
            <span className="stat-label">배상 대상</span>
            <span className="t-md fw-b num">1,152건</span>
            <span className="stat-meta">결제자 · 계좌 입금</span>
          </div>
          <div className="stat" style={{ padding: "10px 12px" }}>
            <span className="stat-label">배상 총액</span>
            <span className="t-md fw-b num">₩31,020,000</span>
            <span className="stat-meta">실제 결제 금액의 10%</span>
          </div>
        </div>
        <div className="col" style={{ gap: "2px" }}>
          <h3 className="eyebrow" id="dry-pv">결제사별 건수와 예상 소요 시간</h3>
          <ul className="col" aria-labelledby="dry-pv">
            <li className="li between">
              <span className="col" style={{ gap: "2px", minWidth: "0" }}>
                <span className="t-sm fw-b">토스페이먼츠</span>
                <span className="t-xs muted">초당 1건 · 온세일 윈도우 동안 새 묶음 미룸 반영</span>
              </span>
              <span className="col" style={{ gap: "2px", alignItems: "flex-end" }}>
                <span className="t-sm fw-b num">1,129건</span>
                <span className="t-xs muted">약 19분</span>
              </span>
            </li>
            <li className="li between">
              <span className="col" style={{ gap: "2px", minWidth: "0" }}>
                <span className="t-sm fw-b">포트원(결제사 전환분)</span>
                <span className="t-xs muted">초당 1건</span>
              </span>
              <span className="col" style={{ gap: "2px", alignItems: "flex-end" }}>
                <span className="t-sm fw-b num">23건</span>
                <span className="t-xs muted">1분 이내</span>
              </span>
            </li>
          </ul>
        </div>
        <p className="t-xs muted">배상금은 PEAKET이 먼저 지급하고 같은 파트너의 다른 회차 미지급 정산금 상계 → 계약 보증 → 청구 순으로 회수합니다. 판정을 바꾸면 다시 계산하고, 불가항력이면 배상 없이 전액 환불만 합니다.</p>
      </div>
    </section>
    <section className="widget" aria-labelledby="cf-h">
      <div className="widget-head">
        <h2 className="t-sm fw-b" id="cf-h">확정 승인 · 2인</h2>
        <div className="actions">
          {v.isJudge ? (
            <>
              <span className="badge">판정 전</span>
            </>
          ) : null}
          {' '}
          {v.isApprover ? (
            <>
              <span className="badge badge-warning">두 번째 승인 대기</span>
            </>
          ) : null}
          {' '}
          {v.afterConfirm ? (
            <>
              <span className="badge badge-success">
                <i className="ic ic-check" aria-hidden="true" />
                확정 19:51 KST
              </span>
            </>
          ) : null}
        </div>
      </div>
      <div className="widget-body" style={{ gap: "12px" }}>
        {v.isJudge ? (
          <>
            <ol className="col" style={{ gap: "10px" }} aria-label="승인 단계">
              <li className="col" style={{ gap: "4px" }}>
                <span className="step is-current" aria-current="step">
                  <span className="step-num">1</span>
                  판정 · 수진(commander, 나)
                </span>
                <span className="badge badge-warning" style={{ alignSelf: "flex-start", marginLeft: "32px" }}>판정 전</span>
              </li>
              <li className="col" style={{ gap: "4px" }}>
                <span className="step">
                  <span className="step-num">2</span>
                  두 번째 승인 · operator 이상 1명
                </span>
                <span className="badge" style={{ alignSelf: "flex-start", marginLeft: "32px" }}>대기</span>
              </li>
            </ol>
          </>
        ) : null}
        {' '}
        {v.isApprover ? (
          <>
            <ol className="col" style={{ gap: "10px" }} aria-label="승인 단계">
              <li className="col" style={{ gap: "4px" }}>
                <span className="step is-done">
                  <span className="step-num"><i className="ic ic-check" aria-hidden="true" /></span>
                  <span className="sr-only">완료:</span>
                  판정 · 수진(commander)
                </span>
                <span className="t-xs muted" style={{ paddingLeft: "32px" }}>19:40 KST · 주최 측 귀책</span>
              </li>
              <li className="col" style={{ gap: "4px" }}>
                <span className="step is-current" aria-current="step">
                  <span className="step-num">2</span>
                  두 번째 승인 · 민호(operator, 나)
                </span>
                <span className="badge badge-warning" style={{ alignSelf: "flex-start", marginLeft: "32px" }}>지금 차례</span>
              </li>
            </ol>
          </>
        ) : null}
        {' '}
        {v.afterConfirm ? (
          <>
            <ol className="col" style={{ gap: "10px" }} aria-label="승인 단계">
              <li className="col" style={{ gap: "4px" }}>
                <span className="step is-done">
                  <span className="step-num"><i className="ic ic-check" aria-hidden="true" /></span>
                  <span className="sr-only">완료:</span>
                  판정 · 수진(commander)
                </span>
                <span className="t-xs muted" style={{ paddingLeft: "32px" }}>19:40 KST · 주최 측 귀책</span>
              </li>
              <li className="col" style={{ gap: "4px" }}>
                <span className="step is-done">
                  <span className="step-num"><i className="ic ic-check" aria-hidden="true" /></span>
                  <span className="sr-only">완료:</span>
                  두 번째 승인 · 민호(operator)
                </span>
                <span className="t-xs muted" style={{ paddingLeft: "32px" }}>19:51 KST · 재인증함</span>
              </li>
            </ol>
          </>
        ) : null}
        <p className="t-sm muted">판정한 분은 두 번째 승인을 할 수 없습니다. 두 번째 승인은 operator 이상 한 분이 합니다.</p>
        {v.isJudge ? (
          <>
            <div className="col" style={{ gap: "8px" }}>
              <button className="btn btn-danger btn-lg btn-block" type="button" aria-disabled="true" aria-describedby="cf-why">
                <span>
                  회차 취소를 확정하고
                  <br />
                  일괄 환불을 시작합니다
                </span>
              </button>
              <p className="row t-sm" id="cf-why" style={{ gap: "6px", alignItems: "flex-start" }}>
                <i className="ic ic-lock ic-16" aria-hidden="true" />
                판정 전에는 확정할 수 없습니다. 귀책을 판정하면 두 번째 승인자에게 요청이 갑니다.
              </p>
              <p className="t-xs muted">확정할 때 "실행된 환불은 되돌릴 수 없습니다"를 확인하고, 비밀번호와 인증 앱 코드로 다시 인증하고, 등록한 패스키로 한 번 더 확인합니다.</p>
            </div>
          </>
        ) : null}
        {' '}
        {v.isApprover ? (
          <>
            <div className="col" style={{ gap: "8px" }}>
              <p className="card-flat t-sm fw-b" id="cf-sum" style={{ padding: "10px 14px", borderRadius: "var(--r-md)" }}>
                회차 취소 확정 · LUMEN 10/26(월) 17:00 회차 · 주문 1,152건 일괄 환불 · 판정 수진
              </p>
              <button onClick={() => go?.('확정 직전 확인')} className="btn btn-danger btn-lg btn-block" type="button" {...ro('cf-sum cf-note')}>
                <span>
                  회차 취소를 확정하고
                  <br />
                  일괄 환불을 시작합니다
                </span>
              </button>
              {' '}
              <button onClick={() => go?.('반려·연기 처리')} className="btn btn-outline btn-lg btn-block" type="button" {...ro('cf-note')}>판정을 반려합니다</button>
              <p className="t-xs muted" id="cf-note">확정하면 위험 확인, 관리 계정 재인증, 패스키 확인을 거칩니다. 판정이 맞지 않으면 사유를 적어 반려하세요. 판정한 분이 다시 판정합니다.</p>
            </div>
          </>
        ) : null}
        {' '}
        {v.afterConfirm ? (
          <>
            <div className="banner banner-success">
              <i className="ic ic-check-circle" aria-hidden="true" />
              <div className="banner-body">
                <span className="banner-title">확정했습니다 · 10/19(월) 19:51 KST</span>
                결제자와 보유자에게 공연 취소를, 결제자에게 환급 일정을 알렸습니다(19:52 KST). 실행된 환불은 되돌릴 수 없습니다.
              </div>
            </div>
          </>
        ) : null}
      </div>
    </section>
    <section className="widget" aria-labelledby="bk-h">
      <div className="widget-head">
        <h2 className="t-sm fw-b" id="bk-h">일괄 환불</h2>
        {v.beforeConfirm ? (
          <>
            <span className="badge">시작 전</span>
          </>
        ) : null}
        {' '}
        {v.isRun ? (
          <>
            <span className="badge badge-primary">진행 중</span>
          </>
        ) : null}
        {' '}
        {v.isPaused ? (
          <>
            <span className="badge badge-danger">자동 정지</span>
          </>
        ) : null}
        {' '}
        {v.isDone ? (
          <>
            <span className="badge badge-success">완료 · 실패 3건</span>
          </>
        ) : null}
      </div>
      <div className="widget-body" style={{ gap: "12px" }}>
        {v.beforeConfirm ? (
          <>
            <p className="t-sm muted" id="bk-why0">
              확정하면 결제사 처리 한도 안에서 나눠 환불합니다. 진행률, 결제사별 처리 속도, 실패 건이 여기에 보입니다. 시작 전이라 일시정지·재개할 작업이 없고, 일시정지·재개는 commander만 합니다.
            </p>
          </>
        ) : null}
        {' '}
        {v.isRun ? (
          <>
            <div className="col" style={{ gap: "12px" }}>
              <div className="banner banner-warning">
                <i className="ic ic-alert" aria-hidden="true" />
                <div className="banner-body">대형·중형 공연의 온세일 윈도우라 새 환불 묶음을 미뤘습니다. 이미 시작한 묶음은 끝냅니다</div>
              </div>
              <div className="col" style={{ gap: "6px" }} role="status" aria-live="polite">
                <span className="t-md fw-b">64% · 1,152건 중 737건 환불</span>
                {' '}
                <span className="t-sm muted">실패 3건 · 남은 412건 · 예상 약 7분</span>
                <div className="progress progress-lg" role="progressbar" aria-label="일괄 환불 진행률" aria-valuenow={64} aria-valuemin={0} aria-valuemax={100}>
                  <span style={{ width: "64%" }} />
                </div>
                <span className="t-xs muted">시작 10/19(월) 19:52 KST · 갱신 20:04:10 KST</span>
              </div>
              <div className="col" style={{ gap: "6px" }}>
                <h3 className="eyebrow" id="bk-pv1">결제사별 처리 현황</h3>
                <ul className="col" style={{ gap: "8px" }} aria-labelledby="bk-pv1">
                  <li className="card-flat col" style={{ gap: "8px", padding: "12px 14px" }}>
                    <div className="row between">
                      <span className="t-sm fw-b">토스페이먼츠</span>
                      <span className="row" style={{ gap: "6px" }}>
                        <span className="t-xs">초당 1건</span>
                        <span className="badge badge-warning">새 묶음 미룸</span>
                      </span>
                    </div>
                    <dl style={{ display: "grid", gridTemplateColumns: "repeat(3,minmax(0,1fr))", gap: "8px" }}>
                      <div className="col" style={{ gap: "2px" }}>
                        <dt className="t-xs muted">환불 완료</dt>
                        <dd className="t-md fw-b num">714</dd>
                      </div>
                      <div className="col" style={{ gap: "2px" }}>
                        <dt className="t-xs muted">실패</dt>
                        <dd className="t-md fw-b num">3</dd>
                      </div>
                      <div className="col" style={{ gap: "2px" }}>
                        <dt className="t-xs muted">남음</dt>
                        <dd className="t-md fw-b num">412</dd>
                      </div>
                    </dl>
                    <span className="t-xs muted">예상 남은 시간 약 7분</span>
                  </li>
                  <li className="card-flat col" style={{ gap: "8px", padding: "12px 14px" }}>
                    <div className="row between">
                      <span className="t-sm fw-b">포트원(결제사 전환분)</span>
                      <span className="t-xs">끝남</span>
                    </div>
                    <dl style={{ display: "grid", gridTemplateColumns: "repeat(3,minmax(0,1fr))", gap: "8px" }}>
                      <div className="col" style={{ gap: "2px" }}>
                        <dt className="t-xs muted">환불 완료</dt>
                        <dd className="t-md fw-b num">23</dd>
                      </div>
                      <div className="col" style={{ gap: "2px" }}>
                        <dt className="t-xs muted">실패</dt>
                        <dd className="t-md fw-b num">0</dd>
                      </div>
                      <div className="col" style={{ gap: "2px" }}>
                        <dt className="t-xs muted">남음</dt>
                        <dd className="t-md fw-b num">0</dd>
                      </div>
                    </dl>
                  </li>
                </ul>
              </div>
              <p className="t-sm">
                실패 3건은 CS 처리함 '환급 실패'로 보냈습니다{' '}
                <Link to="/cs/inbox" className="link-more">
                  CS 처리함
                  <i className="ic ic-chevron-right" aria-hidden="true" />
                </Link>
              </p>
              <p className="t-xs muted">배상금은 결제자에게 계좌 입력을 요청했습니다. 입력하지 않았거나 송금이 실패한 건은 CS 처리함 '배상 대기'에 남습니다.</p>
            </div>
          </>
        ) : null}
        {' '}
        {v.isPaused ? (
          <>
            <div className="col" style={{ gap: "12px" }}>
              <div className="col" style={{ gap: "6px" }} role="status" aria-live="polite">
                <span className="t-md fw-b">41% · 1,152건 중 472건 환불 · 멈춤</span>
                {' '}
                <span className="t-sm muted">실패 37건 · 남은 643건</span>
                <div className="progress progress-lg progress-warning" role="progressbar" aria-label="일괄 환불 진행률, 멈춤" aria-valuenow={41} aria-valuemin={0} aria-valuemax={100}>
                  <span style={{ width: "41%" }} />
                </div>
                <span className="t-xs muted">시작 10/19(월) 19:52 KST · 토스페이먼츠 몫 자동 정지 20:01 KST · 1분 취소 실패율 5% 이상</span>
              </div>
              <div className="col" style={{ gap: "6px" }}>
                <h3 className="eyebrow" id="bk-pv2">결제사별 처리 현황</h3>
                <ul className="col" style={{ gap: "8px" }} aria-labelledby="bk-pv2">
                  <li className="card-flat col" style={{ gap: "8px", padding: "12px 14px" }}>
                    <div className="row between">
                      <span className="t-sm fw-b">토스페이먼츠</span>
                      <span className="badge badge-danger">멈춤</span>
                    </div>
                    <dl style={{ display: "grid", gridTemplateColumns: "repeat(3,minmax(0,1fr))", gap: "8px" }}>
                      <div className="col" style={{ gap: "2px" }}>
                        <dt className="t-xs muted">환불 완료</dt>
                        <dd className="t-md fw-b num">449</dd>
                      </div>
                      <div className="col" style={{ gap: "2px" }}>
                        <dt className="t-xs muted">실패</dt>
                        <dd className="t-md fw-b num tx-danger">37</dd>
                      </div>
                      <div className="col" style={{ gap: "2px" }}>
                        <dt className="t-xs muted">남음</dt>
                        <dd className="t-md fw-b num">643</dd>
                      </div>
                    </dl>
                  </li>
                  <li className="card-flat col" style={{ gap: "8px", padding: "12px 14px" }}>
                    <div className="row between">
                      <span className="t-sm fw-b">포트원(결제사 전환분)</span>
                      <span className="t-xs">끝남</span>
                    </div>
                    <dl style={{ display: "grid", gridTemplateColumns: "repeat(3,minmax(0,1fr))", gap: "8px" }}>
                      <div className="col" style={{ gap: "2px" }}>
                        <dt className="t-xs muted">환불 완료</dt>
                        <dd className="t-md fw-b num">23</dd>
                      </div>
                      <div className="col" style={{ gap: "2px" }}>
                        <dt className="t-xs muted">실패</dt>
                        <dd className="t-md fw-b num">0</dd>
                      </div>
                      <div className="col" style={{ gap: "2px" }}>
                        <dt className="t-xs muted">남음</dt>
                        <dd className="t-md fw-b num">0</dd>
                      </div>
                    </dl>
                  </li>
                </ul>
              </div>
              <p className="row wrap t-sm" style={{ gap: "6px" }}>
                재개 조건{' '}
                <span className="badge badge-warning">충족 전</span>
                <span>결제사 차단기 닫힘 · 최근 5분 실패율 8.1%</span>
              </p>
              <p className="t-sm">
                실패 37건은 CS 처리함 '환급 실패'로 보냈습니다{' '}
                <Link to="/cs/inbox" className="link-more">
                  CS 처리함
                  <i className="ic ic-chevron-right" aria-hidden="true" />
                </Link>
              </p>
            </div>
          </>
        ) : null}
        {' '}
        {v.isDone ? (
          <>
            <div className="col" style={{ gap: "12px" }}>
              <div className="banner banner-success" role="status">
                <i className="ic ic-check-circle" aria-hidden="true" />
                <div className="banner-body">
                  <span className="banner-title">완료했습니다. 실패 3건은 CS 처리함에서 처리합니다</span>
                  1,152건 중 1,149건을 환불했습니다.
                </div>
              </div>
              <div className="col" style={{ gap: "6px" }}>
                <span className="t-md fw-b">100% · 1,152건 중 1,149건 환불</span>
                {' '}
                <span className="t-sm muted">실패 3건 · 남은 0건</span>
                <div className="progress progress-lg progress-success" role="progressbar" aria-label="일괄 환불 진행률, 완료" aria-valuenow={100} aria-valuemin={0} aria-valuemax={100}>
                  <span style={{ width: "100%" }} />
                </div>
                <span className="t-xs muted">시작 10/19(월) 19:52 KST · 모든 결제사 몫 끝남</span>
              </div>
              <div className="col" style={{ gap: "6px" }}>
                <h3 className="eyebrow" id="bk-pv3">결제사별 처리 결과</h3>
                <ul className="col" style={{ gap: "8px" }} aria-labelledby="bk-pv3">
                  <li className="card-flat col" style={{ gap: "8px", padding: "12px 14px" }}>
                    <div className="row between">
                      <span className="t-sm fw-b">토스페이먼츠</span>
                      <span className="t-xs">끝남</span>
                    </div>
                    <dl style={{ display: "grid", gridTemplateColumns: "repeat(3,minmax(0,1fr))", gap: "8px" }}>
                      <div className="col" style={{ gap: "2px" }}>
                        <dt className="t-xs muted">환불 완료</dt>
                        <dd className="t-md fw-b num">1,126</dd>
                      </div>
                      <div className="col" style={{ gap: "2px" }}>
                        <dt className="t-xs muted">실패</dt>
                        <dd className="t-md fw-b num tx-danger">3</dd>
                      </div>
                      <div className="col" style={{ gap: "2px" }}>
                        <dt className="t-xs muted">남음</dt>
                        <dd className="t-md fw-b num">0</dd>
                      </div>
                    </dl>
                  </li>
                  <li className="card-flat col" style={{ gap: "8px", padding: "12px 14px" }}>
                    <div className="row between">
                      <span className="t-sm fw-b">포트원(결제사 전환분)</span>
                      <span className="t-xs">끝남</span>
                    </div>
                    <dl style={{ display: "grid", gridTemplateColumns: "repeat(3,minmax(0,1fr))", gap: "8px" }}>
                      <div className="col" style={{ gap: "2px" }}>
                        <dt className="t-xs muted">환불 완료</dt>
                        <dd className="t-md fw-b num">23</dd>
                      </div>
                      <div className="col" style={{ gap: "2px" }}>
                        <dt className="t-xs muted">실패</dt>
                        <dd className="t-md fw-b num">0</dd>
                      </div>
                      <div className="col" style={{ gap: "2px" }}>
                        <dt className="t-xs muted">남음</dt>
                        <dd className="t-md fw-b num">0</dd>
                      </div>
                    </dl>
                  </li>
                </ul>
              </div>
              <p className="t-sm">
                실패 3건은 CS 처리함 '환급 실패'로 보냈습니다{' '}
                <Link to="/cs/inbox" className="link-more">
                  CS 처리함
                  <i className="ic ic-chevron-right" aria-hidden="true" />
                </Link>
              </p>
            </div>
          </>
        ) : null}
        {' '}
        {v.beforeConfirm ? (
          <>
            <button className="btn btn-outline btn-lg btn-block" type="button" aria-disabled="true" aria-describedby="bk-why0">
              <i className="ic ic-pause" aria-hidden="true" />
              일괄 환불을 일시정지합니다
            </button>
          </>
        ) : null}
        {' '}
        {v.isRun ? (
          <>
            <button onClick={() => go?.('자동 정지')} className="btn btn-outline btn-lg btn-block" type="button" {...ro()}>
              <i className="ic ic-pause" aria-hidden="true" />
              일괄 환불을 일시정지합니다
            </button>
          </>
        ) : null}
        {' '}
        {v.isPaused ? (
          <>
            <div className="col" style={{ gap: "6px" }}>
              <button className="btn btn-outline btn-lg btn-block" type="button" aria-disabled="true" aria-describedby="bk-why2">
                <i className="ic ic-pause" aria-hidden="true" />
                일괄 환불을 일시정지합니다
              </button>
              {' '}
              <span className="hint" id="bk-why2">이미 멈춰 있습니다. 실패 원인을 확인한 뒤 재개하세요.</span>
            </div>
          </>
        ) : null}
        {' '}
        {v.isDone ? (
          <>
            <div className="col" style={{ gap: "6px" }}>
              <button className="btn btn-outline btn-lg btn-block" type="button" aria-disabled="true" aria-describedby="bk-why3">
                <i className="ic ic-pause" aria-hidden="true" />
                일괄 환불을 일시정지합니다
              </button>
              {' '}
              <span className="hint" id="bk-why3">작업이 끝나 일시정지·재개할 것이 없습니다.</span>
            </div>
          </>
        ) : null}
        <div className="banner banner-info bigscreen" role="note">
          <i className="ic ic-monitor" aria-hidden="true" />
          <div className="banner-body" style={{ flexBasis: "200px" }}>
            <span className="banner-title">일괄 환불 재개는 태블릿이나 데스크톱에서 합니다</span>
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
  );
}

export function OverlaysM({ v, close, go }: { v: V; close?: () => void; go?: (state: string) => void }) {
  void v; void close; void go;
  const ro = useRo();
  return (
    <>
    {v.isConfirm ? (
      <>
        <Overlay placement="bottom" onClose={close}>
          <div className="sheet" role="dialog" aria-modal="true" aria-labelledby="dc-t" aria-describedby="dc-w" style={{ gap: "10px" }}>
            <span className="sheet-handle" aria-hidden="true" />
            <nav className="stepper" aria-label="확정 단계">
              <span className="step is-current" aria-current="step">
                <span className="step-num">1</span>
                위험 확인
              </span>
              <span className="step-line" />
              <span className="step">
                <span className="step-num">2</span>
                재인증·패스키 확인
              </span>
            </nav>
            <h2 className="t-lg" id="dc-t">회차 취소를 확정합니다</h2>
            <dl className="kv card-flat" style={{ padding: "12px 14px", gap: "6px 12px" }}>
              <dt>회차</dt>
              <dd>LUMEN 콘서트 2026 서울 · 10/26(월) 17:00</dd>
              <dt>판정</dt>
              <dd>주최 측 귀책 · 수진</dd>
              <dt>대상 주문</dt>
              <dd>1,152건 · 티켓 2,400매</dd>
              <dt>환급 총액</dt>
              <dd>₩310,200,000</dd>
              <dt>배상 총액</dt>
              <dd>₩31,020,000</dd>
            </dl>
            <div className="banner banner-danger" id="dc-w">
              <i className="ic ic-alert" aria-hidden="true" />
              <div className="banner-body">
                <span className="banner-title">실행된 환불은 되돌릴 수 없습니다</span>
                확정하면 결제자와 보유자에게 공연 취소를, 결제자에게 환급 일정을 바로 알리고 일괄 환불을 시작합니다.
              </div>
            </div>
            <div className="field">
              <label className="label" htmlFor="dc-reason">두 번째 승인 사유 (필수)</label>
              {' '}
              <textarea className="textarea" id="dc-reason" rows={2} style={{ minHeight: "64px" }} aria-describedby="dc-rc" defaultValue="파트너 공문, 판정 사유, 미리보기 수치를 확인했습니다" />
              {' '}
              <span className="counter" id="dc-rc" aria-live="polite">30 / 500자</span>
            </div>
            <div className="field">
              <label className="label" htmlFor="dc-phrase">확인 문구 입력 (필수)</label>
              {' '}
              <span className="hint" id="dc-ph">"10/26 회차 취소 확정"을 그대로 입력하세요</span>
              {' '}
              <input className="input input-sm is-focus" id="dc-phrase" type="text" defaultValue="10/26 회차 취소 확정" aria-describedby="dc-ph" />
            </div>
            <div className="row" style={{ gap: "8px" }}>
              <button onClick={close} className="btn btn-outline btn-lg" type="button">닫기</button>
              {' '}
              <button onClick={() => go?.('일괄 환불 진행')} className="btn btn-danger btn-lg grow" type="button" {...ro()}>회차 취소를 확정합니다</button>
            </div>
            <p className="t-xs muted">다음 단계에서 비밀번호와 인증 앱 코드로 다시 인증하고, 등록한 패스키로 한 번 더 확인하면 확정됩니다.</p>
            <p className="t-xs muted">휴대폰을 잃을 때 로그인과 인증 앱 코드를 함께 잃지 않도록, 인증 앱은 이 휴대폰이 아닌 다른 기기에 두기를 권합니다.</p>
          </div>
        </Overlay>
      </>
    ) : null}
    </>
  );
}
