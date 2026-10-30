// 디자인 캔버스 보드 SCR-045-t.dc.html를 옮긴 것(dc2tsx 생성 뒤 손질)
/* eslint-disable */
import { Fragment, type FormEvent } from 'react';
import { Link } from 'react-router';
import { Overlay } from '@/shared/ui/Overlay';

const prevent = (e: FormEvent) => e.preventDefault();
void Fragment;
void Link;

type AriaBool = boolean | 'true' | 'false';
type AriaCurrent = boolean | 'true' | 'false' | 'page' | 'step' | 'location' | 'date' | 'time';

export const STATES_T = ["기본", "열람 사유 입력", "기한 초과", "문의 답변", "게시물 신고", "빈 화면", "정산 이의", "정산 이의 · 이의 인정", "소명", "operator 보기", "없는 건(404)"] as const;
export const DEFAULT_T = "기본";

export function valsT(state: string) {
    let st = state || '기본';
    let empty = st === '빈 화면';
    let inq = st === '문의 답변';
    let rep = st === '게시물 신고';
    let acc = st === '정산 이의 · 이의 인정';
    let disp = st === '정산 이의' || acc;
    let apl = st === '소명';
    let op = st === 'operator 보기';
    let gone = st === '없는 건(404)';
    let lead = disp || apl;
    let c58 = !inq && !rep && !disp && !apl && !op && !gone;
    return {
      isEmpty: empty,
      hasRows: !empty,
      isReason: st === '열람 사유 입력',
      isOverdue: st === '기한 초과',
      notOverdue: st !== '기한 초과',
      showCase58: c58,
      isInquiry: inq,
      isReport: rep,
      isDispute: disp,
      disputeAsk: disp && !acc,
      disputeForm: acc,
      isAppeal: apl,
      isPgDiff: op,
      isGone: gone,
      inProgress: c58 || inq || disp,
      headOpen: rep || apl || op,
      asAgent: !lead && !op,
      asLead: lead,
      asOp: op,
      notOp: !op,
      myAppr: lead ? '2' : (op ? '1' : '0'),
      nAll: op ? '13' : '11',
      zeroKinds: op ? '0건인 종류 18개 보기(미성년자 계약 취소·결제 뒤 미발권·포트원 원장 불일치 포함)' : '0건인 종류 15개 보기(미성년자 계약 취소·결제 뒤 미발권 포함)',
      dueOps: op ? ', KYC 필요 2영업일(그 뒤 2영업일마다) [가정], 포트원 일괄 지급 실행 지급일 15시, 포트원 원장 불일치 당일 [가정]' : '',
      sel58: c58 ? 'is-selected' : '',
      ariaSel58: c58 ? 'true' : 'false',
      sel52: disp ? 'is-selected' : '',
      ariaSel52: disp ? 'true' : 'false',
      sel72: inq ? 'is-selected' : '',
      ariaSel72: inq ? 'true' : 'false',
      sel73: rep ? 'is-selected' : '',
      ariaSel73: rep ? 'true' : 'false',
      sel76: apl ? 'is-selected' : '',
      ariaSel76: apl ? 'true' : 'false'
    };
  }

type V = ReturnType<typeof valsT>;

// 보드 루트: {"class": "pk dark cs cs-compact is-tab", "style": "width:768px;min-height:2450px"}

// <main class="cs-main" id="main">
export function MainT({ v, close, go }: { v: V; close?: () => void; go?: (state: string) => void }) {
  void v; void close; void go;
  return (
    <>
    <div className="page-head">
      <div className="col" style={{ gap: "4px", maxWidth: "720px" }}>
        <h1>CS 처리함</h1>
        <p className="t-sm muted">사람이 판단할 건을 기한과 함께 처리합니다. 결제자 이름·전화는 가려 보이고, 열람하면 사유가 접속기록에 남습니다.</p>
      </div>
      <div className="row" style={{ gap: "6px" }}>
        <span className="badge badge-lg">열린 건 {v.nAll}</span>
        {' '}
        {v.notOverdue ? (
          <>
            <span className="row" style={{ gap: "6px" }}>
              <span className="badge badge-lg badge-warning">1영업일 이내 4</span>
              <span className="badge badge-lg">기한 초과 0</span>
            </span>
          </>
        ) : null}
        {' '}
        {v.isOverdue ? (
          <>
            <span className="row" style={{ gap: "6px" }}>
              <span className="badge badge-lg badge-warning">1영업일 이내 3</span>
              <span className="badge badge-lg badge-danger">기한 초과 1</span>
            </span>
          </>
        ) : null}
      </div>
    </div>
    {v.isOverdue ? (
      <>
        <div className="banner banner-danger" role="alert">
          <i className="ic ic-alert-circle" aria-hidden="true" />
          <div className="banner-body">
            <span className="banner-title">기한을 넘긴 건이 1건 있습니다</span>
            결제 상태 불명 CS-0049의 확정·환급 기한(3영업일)이 1영업일 지났습니다. 담당자와 CS 책임자에게 알림이 갔습니다. 이 건부터 처리해 주세요.
          </div>
          <Link to="/cs/inbox" className="link-more">
            CS-0049 열기
            <i className="ic ic-chevron-right" aria-hidden="true" />
          </Link>
        </div>
      </>
    ) : null}
    <div className="tabs" role="tablist" aria-label="CS 처리함 보기">
      <button className="tab is-active" type="button" role="tab" aria-selected="true" aria-controls="cs-panel">
        처리함{' '}
        <span className="badge">{v.nAll}</span>
      </button>
      {' '}
      <button className="tab" type="button" role="tab" aria-selected="false">
        예매 제한 목록{' '}
        <span className="badge">2</span>
      </button>
    </div>
    <div className="col" id="cs-panel" role="tabpanel" style={{ gap: "16px" }}>
      <section className="widget" aria-labelledby="flt-h">
        <div className="widget-head">
          <h2 className="t-sm fw-b" id="flt-h">필터</h2>
          <div className="actions"><button className="btn btn-text btn-sm" type="button">필터 초기화</button></div>
        </div>
        <div className="widget-body" style={{ gap: "14px" }}>
          <div style={{ display: "grid", gridTemplateColumns: "minmax(0,2fr) minmax(0,1fr) minmax(0,1fr)", gap: "20px", alignItems: "start" }}>
            <div className="col" style={{ gap: "6px" }}>
              <span className="eyebrow" id="flt-kind">건 종류</span>
              <div className="row wrap" role="tablist" aria-labelledby="flt-kind" style={{ gap: "6px" }}>
                <button className="chip chip-sm is-selected" type="button" role="tab" aria-selected="true" aria-controls="case-list">전체 {v.nAll}</button>
                {' '}
                <button className="chip chip-sm" type="button" role="tab" aria-selected="false" aria-controls="case-list">분쟁 접수 1</button>
                {' '}
                <button className="chip chip-sm" type="button" role="tab" aria-selected="false" aria-controls="case-list">문의 1</button>
                {' '}
                <button className="chip chip-sm" type="button" role="tab" aria-selected="false" aria-controls="case-list">게시물 신고 1</button>
                {' '}
                <button className="chip chip-sm" type="button" role="tab" aria-selected="false" aria-controls="case-list">권리 침해 삭제 요청 1</button>
                {' '}
                <button className="chip chip-sm" type="button" role="tab" aria-selected="false" aria-controls="case-list">결제 상태 불명 2</button>
                {' '}
                <button className="chip chip-sm" type="button" role="tab" aria-selected="false" aria-controls="case-list">추가 검증 이의 1</button>
                {' '}
                <button className="chip chip-sm" type="button" role="tab" aria-selected="false" aria-controls="case-list">정산 이의 1</button>
                {' '}
                <button className="chip chip-sm" type="button" role="tab" aria-selected="false" aria-controls="case-list">환불 대기 1</button>
                {' '}
                <button className="chip chip-sm" type="button" role="tab" aria-selected="false" aria-controls="case-list">판정 대기 1</button>
                {' '}
                <button className="chip chip-sm" type="button" role="tab" aria-selected="false" aria-controls="case-list">소명 1</button>
                {' '}
                {v.asOp ? (
                  <>
                    <button className="chip chip-sm" type="button" role="tab" aria-selected="false" aria-controls="case-list">KYC 필요 1</button>
                    <button className="chip chip-sm" type="button" role="tab" aria-selected="false" aria-controls="case-list">결제사 잔액 대사 차이 1</button>
                  </>
                ) : null}
              </div>
              <button className="btn btn-text btn-sm" type="button" aria-expanded="false" style={{ alignSelf: "flex-start" }}>
                {v.zeroKinds}
                <i className="ic ic-chevron-down" aria-hidden="true" />
              </button>
            </div>
            <fieldset className="col" style={{ gap: "8px" }}>
              <legend className="eyebrow" style={{ marginBottom: "8px" }}>기한</legend>
              <label className="check-row">
                <input className="rd" type="radio" name="due" defaultChecked />
                <span className="t-sm">전체</span>
              </label>
              {' '}
              <label className="check-row">
                <input className="rd" type="radio" name="due" />
                <span className="t-sm">1영업일 이내</span>
              </label>
              {' '}
              <label className="check-row">
                <input className="rd" type="radio" name="due" />
                <span className="t-sm">기한 초과</span>
              </label>
            </fieldset>
            <fieldset className="col" style={{ gap: "8px" }}>
              <legend className="eyebrow" style={{ marginBottom: "8px" }}>상태</legend>
              <label className="check-row">
                <input className="cb" type="checkbox" defaultChecked />
                <span className="t-sm">열림</span>
              </label>
              {' '}
              <label className="check-row">
                <input className="cb" type="checkbox" defaultChecked />
                <span className="t-sm">진행 중</span>
              </label>
              {' '}
              <label className="check-row">
                <input className="cb" type="checkbox" />
                <span className="t-sm">해결</span>
              </label>
            </fieldset>
          </div>
          <p className="t-xs muted">
            종류별 기한: 환급 3영업일, 분쟁 진행 경과 3영업일·결과 10영업일, 문의 답변 3영업일, 게시물 신고 결과 3영업일(불법 촬영물 신고는 바로 가리고 1영업일 안에 판단), 권리 침해 삭제 요청 1영업일(지체 없이), 판정 1영업일, 추가 검증 이의 결과 10영업일(판매 중 30분 판정 목표), 현장 건 3영업일, 배상 대기 10영업일, 미성년자 계약 취소 확인 결과 안내 3영업일·승인 뒤 환급 3영업일, 결제 뒤 미발권 확인 4시간 [가정], 소명 결과 3영업일 [가정](양도 회수 소명은 입장 시작 전){v.dueOps}. 기한 1영업일 전에 담당자와 CS 책임자에게 알립니다.
          </p>
        </div>
      </section>
      <section className="widget" aria-labelledby="lst-h">
        <div className="widget-head">
          <h2 className="t-sm fw-b" id="lst-h">건 목록</h2>
          {v.hasRows ? (
            <>
              <span className="t-xs muted">{v.nAll}건 · 기한 가까운 순</span>
            </>
          ) : null}
          {v.isEmpty ? (
            <>
              <span className="t-xs muted">0건</span>
            </>
          ) : null}
          <div className="actions">
            <div className="input-group input-group-sm" style={{ width: "200px", height: "32px" }}>
              <i className="ic ic-search ic-16" aria-hidden="true" />
              <input type="search" aria-label="접수 번호나 주문 번호로 찾기" placeholder="접수·주문 번호" />
            </div>
          </div>
        </div>
        {v.hasRows ? (
          <>
            <table className="table dense" id="case-list">
              <caption className="sr-only">CS 건 목록. 기한이 가까운 순으로 정렬했습니다</caption>
              <thead>
                <tr>
                  <th scope="col">접수 번호</th>
                  <th scope="col">종류</th>
                  <th scope="col">요약</th>
                  <th scope="col" aria-sort="ascending">
                    기한
                    <i className="ic ic-sort ic-14" aria-hidden="true" />
                  </th>
                  <th scope="col">담당</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td className="mono">CS-0049</td>
                  <td>결제 상태 불명</td>
                  <td>
                    <Link to="/cs/inbox" style={{ color: "inherit" }}>결과 불명 1시간 넘음</Link>
                    <span className="t-xs muted mono" style={{ display: "block" }}>2026101400118</span>
                  </td>
                  <td>
                    {v.notOverdue ? (
                      <>
                        <span className="badge badge-warning">
                          <span className="sr-only">확정·환급 기한</span>
                          1영업일 남음
                        </span>
                      </>
                    ) : null}
                    {v.isOverdue ? (
                      <>
                        <span className="badge badge-danger">
                          <span className="sr-only">확정·환급 기한</span>
                          1영업일 초과
                        </span>
                      </>
                    ) : null}
                  </td>
                  <td>다은</td>
                </tr>
                <tr className={v.sel58} aria-selected={(v.ariaSel58) as AriaBool}>
                  <td className="mono">CS-0058</td>
                  <td>분쟁 접수</td>
                  <td>
                    <Link onClick={(e) => { e.preventDefault(); go?.('기본'); }} to="/cs/inbox" style={{ color: "inherit" }} aria-current={(v.ariaSel58) as AriaCurrent}>결제 승인 2건 문의</Link>
                    <span className="t-xs muted mono" style={{ display: "block" }}>2026101400123</span>
                  </td>
                  <td>
                    <span className="badge badge-warning">
                      <span className="sr-only">진행 경과 통지 기한</span>
                      1영업일 남음
                    </span>
                  </td>
                  <td>다은</td>
                </tr>
                <tr>
                  <td className="mono">CS-0071</td>
                  <td>판정 대기</td>
                  <td>
                    <Link to="/cancellations/cr-lumen-r1" style={{ color: "inherit" }}>LUMEN 10/26(월) 17:00 회차 취소 요청</Link>
                    <span className="t-xs muted" style={{ display: "block" }}>(주)스텔라엔터테인먼트</span>
                  </td>
                  <td>
                    <span className="badge badge-warning">
                      <span className="sr-only">판정 기한</span>
                      1영업일 남음
                    </span>
                  </td>
                  <td>수진</td>
                </tr>
                <tr>
                  <td className="mono">CS-0074</td>
                  <td>권리 침해 삭제 요청</td>
                  <td>
                    <Link to="/cs/inbox" style={{ color: "inherit" }}>권리를 침해받은 본인의 후기 삭제 요청</Link>
                    <span className="t-xs muted" style={{ display: "block" }}>개인정보 노출·명예훼손 · 게시물 [예시]</span>
                  </td>
                  <td>
                    <span className="badge badge-warning">
                      <span className="sr-only">처리 기한</span>
                      1영업일 남음
                    </span>
                  </td>
                  <td><span className="muted">미배정</span></td>
                </tr>
                <tr className={v.sel52} aria-selected={(v.ariaSel52) as AriaBool}>
                  <td className="mono">CS-0052</td>
                  <td>정산 이의</td>
                  <td>
                    <Link onClick={(e) => { e.preventDefault(); go?.('정산 이의'); }} to="/cs/inbox" style={{ color: "inherit" }} aria-current={(v.ariaSel52) as AriaCurrent}>중개수수료 계산 이의</Link>
                    <span className="t-xs muted" style={{ display: "block" }}>[예시 파트너 C] · [공연 D] 10/24(토)</span>
                  </td>
                  <td>
                    <span className="badge">
                      <span className="sr-only">진행 경과 통지 기한</span>
                      2영업일 남음
                    </span>
                  </td>
                  <td>준</td>
                </tr>
                <tr className={v.sel72} aria-selected={(v.ariaSel72) as AriaBool}>
                  <td className="mono">CS-0072</td>
                  <td>문의</td>
                  <td>
                    <Link onClick={(e) => { e.preventDefault(); go?.('문의 답변'); }} to="/cs/inbox" style={{ color: "inherit" }} aria-current={(v.ariaSel72) as AriaCurrent}>아이가 아파서 공연 3일 전 취소 수수료를 면제받을 수 있을까요</Link>
                    <span className="t-xs muted" style={{ display: "block" }}>
                      <span className="mono">Q-2610-0042</span>
                      {' '}· 취소·환불
                    </span>
                  </td>
                  <td>
                    <span className="badge">
                      <span className="sr-only">답변 기한</span>
                      2영업일 남음
                    </span>
                  </td>
                  <td>다은</td>
                </tr>
                {v.asOp ? (
                  <>
                    <tr>
                      <td className="mono">CS-0079</td>
                      <td>KYC 필요</td>
                      <td>
                        <Link to="/cs/inbox" style={{ color: "inherit" }}>토스페이먼츠 셀러 KYC 필요 · 지급 보류</Link>
                        <span className="t-xs muted" style={{ display: "block" }}>[예시 파트너 B] · [공연 B] 10/23(금) · ₩19,188,400</span>
                      </td>
                      <td>
                        <span className="badge">
                          <span className="sr-only">파트너 안내 기한</span>
                          2영업일 남음
                        </span>
                      </td>
                      <td>민호</td>
                    </tr>
                  </>
                ) : null}
                <tr>
                  <td className="mono">CS-0061</td>
                  <td>결제 상태 불명</td>
                  <td>
                    <Link to="/cs/inbox" style={{ color: "inherit" }}>결과 불명 1시간 넘음</Link>
                    <span className="t-xs muted mono" style={{ display: "block" }}>2026101400702</span>
                  </td>
                  <td>
                    <span className="badge">
                      <span className="sr-only">확정·환급 기한</span>
                      3영업일 남음
                    </span>
                  </td>
                  <td><span className="muted">미배정</span></td>
                </tr>
                <tr className={v.sel73} aria-selected={(v.ariaSel73) as AriaBool}>
                  <td className="mono">CS-0073</td>
                  <td>게시물 신고</td>
                  <td>
                    <Link onClick={(e) => { e.preventDefault(); go?.('게시물 신고'); }} to="/cs/inbox" style={{ color: "inherit" }} aria-current={(v.ariaSel73) as AriaCurrent}>후기 게시물 1234 · 신고 3건</Link>
                    <span className="t-xs muted" style={{ display: "block" }}>LUMEN 콘서트 2026 서울 · 김**의 후기</span>
                  </td>
                  <td>
                    <span className="badge">
                      <span className="sr-only">결과 통지 기한</span>
                      3영업일 남음
                    </span>
                  </td>
                  <td>다은</td>
                </tr>
                <tr className={v.sel76} aria-selected={(v.ariaSel76) as AriaBool}>
                  <td className="mono">CS-0076</td>
                  <td>소명</td>
                  <td>
                    <Link onClick={(e) => { e.preventDefault(); go?.('소명'); }} to="/cs/inbox" style={{ color: "inherit" }} aria-current={(v.ariaSel76) as AriaCurrent}>예매 제한에 대한 소명</Link>
                    <span className="t-xs muted" style={{ display: "block" }}>최근 1개월 취소가 많음 · 10/25(일) 15:20 제출</span>
                  </td>
                  <td>
                    <span className="badge">
                      <span className="sr-only">결과 통지 기한</span>
                      3영업일 남음
                    </span>
                  </td>
                  <td>준</td>
                </tr>
                <tr>
                  <td className="mono">CS-0066</td>
                  <td>추가 검증 이의</td>
                  <td>
                    <Link to="/cs/inbox" style={{ color: "inherit" }}>로비 추가 검증 재검토 신청</Link>
                    <span className="t-xs muted" style={{ display: "block" }}>LUMEN 10/25(일) 18:00</span>
                  </td>
                  <td><span className="badge badge-outline">판정 목표 접수 뒤 30분 · 결과 통지 10영업일</span></td>
                  <td>다은</td>
                </tr>
                <tr>
                  <td className="mono">CS-0063</td>
                  <td>환불 대기</td>
                  <td>
                    <Link to="/cs/inbox" style={{ color: "inherit" }}>가상계좌 환불 계좌 미입력</Link>
                    <span className="t-xs muted mono" style={{ display: "block" }}>2026101400877</span>
                  </td>
                  <td><span className="badge badge-outline">다음 재발송 10/15(목) 10:00 · 환급 기한 3영업일</span></td>
                  <td><span className="muted">미배정</span></td>
                </tr>
                {v.asOp ? (
                  <>
                    <tr className="is-selected" aria-selected="true">
                      <td className="mono">CS-0081</td>
                      <td>결제사 잔액 대사 차이</td>
                      <td>
                        <Link onClick={(e) => { e.preventDefault(); go?.('operator 보기'); }} to="/cs/inbox" style={{ color: "inherit" }} aria-current="true">토스페이먼츠 일반 상점 · 차이 ₩12,400</Link>
                        <span className="t-xs muted" style={{ display: "block" }}>지급 묶음 대사 10/29(목) 09:00 · SEV3 경보</span>
                      </td>
                      <td><span className="badge badge-outline">기한 없음</span></td>
                      <td>민호</td>
                    </tr>
                  </>
                ) : null}
              </tbody>
            </table>
            <div className="row between" style={{ padding: "10px 14px" }}>
              <span className="t-xs muted">{v.nAll}건 모두 표시 · 많아지면 가상 스크롤</span>
              <span className="t-xs muted mono">갱신 20:04:05 KST</span>
            </div>
          </>
        ) : null}
        {' '}
        {v.isEmpty ? (
          <>
            <div className="state">
              <span className="state-icon"><i className="ic ic-inbox" aria-hidden="true" /></span>
              <h3 className="t-md fw-b">처리할 건이 없습니다</h3>
            </div>
          </>
        ) : null}
      </section>
      {v.hasRows ? (
        <>
          <section className="widget" aria-labelledby="dt-h">
            <div className="widget-head">
              <h2 className="t-sm fw-b" id="dt-h">건 상세</h2>
              <div className="actions">
                {v.inProgress ? (
                  <>
                    <span className="badge badge-outline">진행 중</span>
                  </>
                ) : null}
                {v.headOpen ? (
                  <>
                    <span className="badge">열림</span>
                  </>
                ) : null}
              </div>
            </div>
            {v.showCase58 ? (
              <>
                <div className="widget-body" style={{ display: "grid", gridTemplateColumns: "repeat(2,minmax(0,1fr))", gap: "20px", alignItems: "start" }}>
                  <div className="col" style={{ gap: "14px" }}>
                    <div className="col" style={{ gap: "6px" }}>
                      <div className="row wrap" style={{ gap: "6px" }}>
                        <span className="badge badge-primary">분쟁 접수</span>
                        <span className="mono t-xs muted">CS-0058</span>
                        <span className="t-xs muted">접수 10/15(목) 10:12 KST · 고객센터</span>
                      </div>
                      <p className="t-md fw-b">결제 승인이 두 번 왔다는 문의</p>
                      <p className="t-sm muted">결제사 대사에서 같은 주문에 승인 2건을 확인했습니다. 1건은 시스템 잘못 환불로 돌려줘야 합니다.</p>
                      <div className="row wrap" style={{ gap: "6px" }}>
                        <span className="badge badge-warning">
                          <i className="ic ic-clock" aria-hidden="true" />
                          <span className="sr-only">진행 경과 통지 기한</span>
                          경과 10/20(화)까지 · 1영업일 남음
                        </span>
                        {' '}
                        <span className="badge">
                          <i className="ic ic-clock" aria-hidden="true" />
                          <span className="sr-only">결과 통지 기한</span>
                          결과 10/29(목)까지 · 8영업일 남음
                        </span>
                      </div>
                    </div>
                    <section className="col" style={{ gap: "6px" }} aria-labelledby="ord-h">
                      <div className="row between">
                        <h3 className="eyebrow" id="ord-h">관련 주문·티켓</h3>
                        <Link to="/customers" className="link-more">
                          팬 조회
                          <i className="ic ic-chevron-right" aria-hidden="true" />
                        </Link>
                      </div>
                      <p className="t-sm">
                        <span className="mono">2026101400123</span>
                        {' '}· LUMEN 콘서트 2026 서울 10/25(일) 18:00
                      </p>
                      <p className="t-sm">R구역 12열 7번·8번 · 티켓 2매 사용 가능 · ₩308,000 · 토스페이먼츠</p>
                      <p className="t-sm tx-warning">결제사 대사: 승인 2건 · 주문 1건</p>
                    </section>
                    <section className="col" style={{ gap: "6px" }} aria-labelledby="pii-h">
                      <h3 className="eyebrow" id="pii-h">결제자</h3>
                      <p className="t-sm">
                        이름{' '}
                        <span aria-hidden="true">●●●</span>
                        <span className="sr-only">가려져 있음</span>
                        {' '}· 전화{' '}
                        <span aria-hidden="true">010-●●●●-●●●●</span>
                        <span className="sr-only">가려져 있음</span>
                      </p>
                      <div className="row wrap" style={{ gap: "8px" }}>
                        <button onClick={() => go?.('열람 사유 입력')} className="btn btn-outline btn-sm" type="button" aria-describedby="pii-hint">
                          <i className="ic ic-eye" aria-hidden="true" />
                          열람 사유 입력
                        </button>
                        <span className="hint" id="pii-hint">열람 사유는 접속기록에 남습니다</span>
                      </div>
                    </section>
                  </div>
                  <div className="col" style={{ gap: "14px" }}>
                    <section className="col" style={{ gap: "6px" }} aria-labelledby="log-h">
                      <h3 className="eyebrow" id="log-h">처리 기록 · 시각 KST</h3>
                      <ol className="timeline">
                        <li className="tl-item">
                          <span className="tl-dot info" />
                          <span className="t-sm">
                            <span className="mono t-xs muted">10/15 10:12</span>
                            {' '}팬 문의를 분쟁 접수로 등록 · 자동
                          </span>
                        </li>
                        <li className="tl-item">
                          <span className="tl-dot" />
                          <span className="t-sm">
                            <span className="mono t-xs muted">10/15 11:30</span>
                            {' '}준이 다은에게 배정
                          </span>
                        </li>
                        <li className="tl-item">
                          <span className="tl-dot warn" />
                          <span className="t-sm">
                            <span className="mono t-xs muted">10/16 14:05</span>
                            {' '}결제사 대사: 같은 주문에 승인 2건 · 다은
                          </span>
                        </li>
                      </ol>
                    </section>
                    <div className="col" style={{ gap: "8px" }}>
                      <Link to="/cs/approvals" className="btn btn-primary btn-block" aria-describedby="mk-hint">
                        <i className="ic ic-stamp" aria-hidden="true" />
                        승인 업무 만들기
                      </Link>
                      {' '}
                      <span className="hint" id="mk-hint">대상 주문과 금액을 채운 요청으로 시작합니다. 시스템 잘못 환불은 CS 책임자 1인이 승인합니다.</span>
                      <div className="row" style={{ gap: "8px" }}>
                        <button className="btn btn-secondary btn-sm grow" type="button" aria-describedby="ntf-hint">진행 경과를 알립니다</button>
                        <button className="btn btn-outline btn-sm grow" type="button" aria-describedby="ntf-hint">결과를 알립니다</button>
                      </div>
                      <span className="hint" id="ntf-hint">팬에게 이메일로 알립니다. 진행 경과는 접수 뒤 3영업일, 결과는 10영업일 안에 알립니다.</span>
                      {' '}
                      <button className="btn btn-ghost btn-block" type="button">
                        <i className="ic ic-check-circle" aria-hidden="true" />
                        이 건을 처리 완료로 닫습니다
                      </button>
                    </div>
                  </div>
                </div>
              </>
            ) : null}
            {' '}
            {v.isInquiry ? (
              <>
                <div className="widget-body" style={{ display: "grid", gridTemplateColumns: "repeat(2,minmax(0,1fr))", gap: "20px", alignItems: "start" }}>
                  <div className="col" style={{ gap: "14px" }}>
                    <div className="col" style={{ gap: "6px" }}>
                      <div className="row wrap" style={{ gap: "6px" }}>
                        <span className="badge badge-primary">문의</span>
                        <span className="mono t-xs muted">CS-0072</span>
                        <span className="t-xs muted">접수 10/14(수) 20:31 KST · 팬 문의</span>
                      </div>
                      <p className="t-md fw-b">아이가 아파서 공연 3일 전 취소 수수료를 면제받을 수 있을까요</p>
                      <p className="t-sm muted">
                        <span className="mono">Q-2610-0042</span>
                        {' '}· 취소·환불(사정이 있어 공제 면제를 요청)
                      </p>
                      <div className="row wrap" style={{ gap: "6px" }}>
                        <span className="badge">
                          <i className="ic ic-clock" aria-hidden="true" />
                          <span className="sr-only">답변 기한</span>
                          답변 10/19(월)까지 · 2영업일 남음
                        </span>
                      </div>
                    </div>
                    <section className="col" style={{ gap: "6px" }} aria-labelledby="iq-h">
                      <h3 className="eyebrow" id="iq-h">팬 문의 내용</h3>
                      <p className="card-flat t-sm" style={{ padding: "10px 12px" }}>
                        10/25(일) 18:00 공연을 예매했는데 아이가 아파서 공연에 가기 어려울 것 같습니다. 공연 3일 전에 취소하면 취소 수수료가 생기는데, 이런 사정이면 면제받을 수 있는지 궁금합니다.
                      </p>
                    </section>
                    <section className="col" style={{ gap: "6px" }} aria-labelledby="iq-ord-h">
                      <div className="row between">
                        <h3 className="eyebrow" id="iq-ord-h">관련 주문·문의한 계정</h3>
                        <Link to="/customers" className="link-more">
                          팬 조회
                          <i className="ic ic-chevron-right" aria-hidden="true" />
                        </Link>
                      </div>
                      <p className="t-sm">
                        <span className="mono">2026101400123</span>
                        {' '}· LUMEN 콘서트 2026 서울 10/25(일) 18:00
                      </p>
                      <p className="t-sm">R구역 12열 7번·8번 · 티켓 2매 사용 가능 · ₩308,000 · 토스페이먼츠</p>
                      <p className="t-sm">
                        계정 지민 · 이메일{' '}
                        <span aria-hidden="true">ji****@k*****.com</span>
                        <span className="sr-only">가려져 있음</span>
                      </p>
                    </section>
                  </div>
                  <div className="col" style={{ gap: "14px" }}>
                    <section className="col" style={{ gap: "6px" }} aria-labelledby="iq-log-h">
                      <h3 className="eyebrow" id="iq-log-h">처리 기록 · 시각 KST</h3>
                      <ol className="timeline">
                        <li className="tl-item">
                          <span className="tl-dot info" />
                          <span className="t-sm">
                            <span className="mono t-xs muted">10/14 20:31</span>
                            {' '}팬 문의 접수 · 자동 등록
                          </span>
                        </li>
                        <li className="tl-item">
                          <span className="tl-dot warn" />
                          <span className="col t-sm" style={{ gap: "4px" }}>
                            <span>
                              <span className="mono t-xs muted">10/15 11:02</span>
                              {' '}진행 경과를 보냈습니다 · 다은
                            </span>
                            <span className="muted">판매자에게 사실 확인을 요청했습니다. 10/27까지 결과를 알려 드립니다.</span>
                          </span>
                        </li>
                      </ol>
                    </section>
                    <section className="col" style={{ gap: "8px" }} aria-labelledby="rp-h">
                      <h3 className="eyebrow" id="rp-h">답변 쓰기</h3>
                      <div className="field">
                        <label className="label" htmlFor="rp-body">
                          팬에게 보낼 내용{' '}
                          <span className="opt">(필수)</span>
                        </label>
                        {' '}
                        <textarea className="textarea is-focus" id="rp-body" aria-describedby="rp-hint rp-c" style={{ minHeight: "132px" }} defaultValue="확인 결과 공연 3일 전 질병으로 인한 취소는 증빙을 확인한 뒤 수수료를 면제할 수 있습니다. 진단서는 사본을 받지 않고 상담 중 화면으로 확인합니다." />
                        <div className="row between" style={{ gap: "8px", alignItems: "flex-start" }}>
                          <span className="hint" id="rp-hint">팬에게는 담당자 이름 대신 '피켓 고객센터'로 보입니다</span>
                          <span className="counter nowrap" id="rp-c" aria-live="polite">남은 글자 1,916자</span>
                        </div>
                      </div>
                      <div className="row wrap" style={{ gap: "8px" }}>
                        <button className="btn btn-primary btn-sm" type="button" aria-describedby="rp-ntf">
                          <i className="ic ic-mail" aria-hidden="true" />
                          답변 보내기
                        </button>
                        {' '}
                        <button className="btn btn-secondary btn-sm" type="button" aria-describedby="rp-ntf">진행 경과 남기기</button>
                        {' '}
                        <button className="btn btn-ghost btn-sm" type="button">문의 닫기</button>
                      </div>
                      <span className="hint" id="rp-ntf">보낸 글은 팬의 '내 문의 내역'에 남고 알림으로 갑니다.</span>
                    </section>
                  </div>
                </div>
              </>
            ) : null}
            {' '}
            {v.isReport ? (
              <>
                <div className="widget-body" style={{ display: "grid", gridTemplateColumns: "repeat(2,minmax(0,1fr))", gap: "20px", alignItems: "start" }}>
                  <div className="col" style={{ gap: "14px" }}>
                    <div className="col" style={{ gap: "6px" }}>
                      <div className="row wrap" style={{ gap: "6px" }}>
                        <span className="badge badge-primary">게시물 신고</span>
                        <span className="mono t-xs muted">CS-0073</span>
                        <span className="t-xs muted">첫 신고 10/26(월) 10:15 KST</span>
                      </div>
                      <p className="t-md fw-b">후기 게시물 1234 · 신고 3건</p>
                      <div className="row wrap" style={{ gap: "6px" }}>
                        <span className="badge">
                          <i className="ic ic-clock" aria-hidden="true" />
                          <span className="sr-only">결과 통지 기한</span>
                          결과 10/29(목)까지 · 3영업일 남음
                        </span>
                        <span className="badge badge-outline">후기 공개 중</span>
                      </div>
                    </div>
                    <section className="col" style={{ gap: "6px" }} aria-labelledby="rr-h">
                      <h3 className="eyebrow" id="rr-h">이유별 신고 수</h3>
                      <dl className="kv">
                        <dt>광고·도배</dt>
                        <dd>2건</dd>
                        <dt>공연과 관계없는 내용</dt>
                        <dd>1건</dd>
                      </dl>
                    </section>
                    <section className="col" style={{ gap: "6px" }} aria-labelledby="rt-h">
                      <h3 className="eyebrow" id="rt-h">신고된 후기</h3>
                      <article className="card-flat col" style={{ padding: "12px", gap: "8px" }}>
                        <div className="row wrap" style={{ gap: "4px 8px" }}>
                          <strong className="t-sm fw-b">김**</strong>
                          <span className="t-xs muted">10월 25일 18:00 관람</span>
                          <span className="t-xs muted num">10/25 작성</span>
                          <span className="t-xs muted">5점 만점에 4점</span>
                        </div>
                        <p className="t-sm">무대 연출과 음향이 좋았습니다. 입장 줄이 길었지만 안내가 잘 되어 있어 금방 들어갔습니다. 다음 공연도 보러 오겠습니다.</p>
                        <ul className="row" style={{ gap: "8px" }} aria-label="후기 사진 2장">
                          <li>
                            <span className="center" role="img" aria-label="후기 사진 1/2" style={{ width: "72px", height: "72px", borderRadius: "var(--r-md)", background: "var(--fill-weak)", color: "var(--text-muted)" }}>
                              <i className="ic ic-image ic-24" aria-hidden="true" />
                            </span>
                          </li>
                          <li>
                            <span className="center" role="img" aria-label="후기 사진 2/2" style={{ width: "72px", height: "72px", borderRadius: "var(--r-md)", background: "var(--fill-weak)", color: "var(--text-muted)" }}>
                              <i className="ic ic-image ic-24" aria-hidden="true" />
                            </span>
                          </li>
                        </ul>
                        <span className="t-xs muted">LUMEN 콘서트 2026 서울 · 게시물 1234</span>
                      </article>
                    </section>
                    <section className="col" style={{ gap: "6px" }} aria-labelledby="rw-h">
                      <h3 className="eyebrow" id="rw-h">신고한 계정</h3>
                      <p className="t-sm">
                        3개 계정 ·{' '}
                        <span aria-hidden="true">●●●</span>
                        <span className="sr-only">가려져 있음</span>
                      </p>
                      <div className="row wrap" style={{ gap: "8px" }}>
                        <button className="btn btn-outline btn-sm" type="button" aria-describedby="rw-hint">
                          <i className="ic ic-eye" aria-hidden="true" />
                          열람 사유 입력
                        </button>
                        <span className="hint" id="rw-hint">신고한 분은 글쓴이에게 알리지 않습니다. 열람 사유는 접속기록에 남습니다</span>
                      </div>
                    </section>
                  </div>
                  <div className="col" style={{ gap: "14px" }}>
                    <section className="col" style={{ gap: "6px" }} aria-labelledby="rl-h">
                      <h3 className="eyebrow" id="rl-h">처리 기록 · 시각 KST</h3>
                      <ol className="timeline">
                        <li className="tl-item">
                          <span className="tl-dot info" />
                          <span className="t-sm">
                            <span className="mono t-xs muted">10/26 10:15</span>
                            {' '}첫 신고로 건 생성 · 자동
                          </span>
                        </li>
                        <li className="tl-item">
                          <span className="tl-dot" />
                          <span className="t-sm">
                            <span className="mono t-xs muted">10/26 18:02</span>
                            {' '}같은 후기 신고를 모아 3건 · 자동
                          </span>
                        </li>
                      </ol>
                    </section>
                    <section className="col" style={{ gap: "10px" }} aria-labelledby="md-h">
                      <h3 className="eyebrow" id="md-h">처리</h3>
                      <div className="field">
                        <label className="label" htmlFor="md-kind">
                          위반 사유 종류{' '}
                          <span className="opt">(임시조치·노출 차단 때 필수)</span>
                        </label>
                        <div className="input-group input-group-sm">
                          <select id="md-kind" defaultValue="고르지 않음">
                            <option>고르지 않음</option>
                            <option>암표·부정판매</option>
                            <option>매크로·부정 예매 프로그램</option>
                            <option>욕설·비방·혐오 표현</option>
                            <option>개인정보 노출·명예훼손</option>
                            <option>음란물·불법 촬영물</option>
                            <option>광고·도배</option>
                            <option>공연과 관계없는 내용</option>
                            <option>기타</option>
                          </select>
                          <i className="ic ic-chevron-down" aria-hidden="true" />
                        </div>
                      </div>
                      <div className="field">
                        <label className="label" htmlFor="md-reason">
                          처리 사유{' '}
                          <span className="opt">(필수)</span>
                        </label>
                        {' '}
                        <textarea className="textarea" id="md-reason" aria-describedby="md-reason-h" style={{ minHeight: "88px" }} />
                        {' '}
                        <span className="hint" id="md-reason-h">감사 기록에 남습니다. 글쓴이에게는 조치 사실과 사유 종류만 알립니다</span>
                      </div>
                      <div className="field">
                        <label className="label" htmlFor="md-end">임시조치 끝 날짜</label>
                        {' '}
                        <input className="input input-sm" id="md-end" type="text" defaultValue="11/25(수)" aria-describedby="md-end-h" />
                        {' '}
                        <span className="hint" id="md-end-h">오늘부터 30일 이내로 정합니다(11/25(수)까지)</span>
                      </div>
                      <div className="row wrap" style={{ gap: "8px" }}>
                        <button className="btn btn-outline btn-sm" type="button" aria-describedby="md-ntf">조치 없음</button>
                        {' '}
                        <button className="btn btn-secondary btn-sm" type="button" aria-describedby="md-ntf md-end-h">임시조치</button>
                        {' '}
                        <button className="btn btn-danger-outline btn-sm" type="button" aria-describedby="md-ntf">
                          <i className="ic ic-eye-off" aria-hidden="true" />
                          노출 차단
                        </button>
                      </div>
                      <span className="hint" id="md-ntf">결과는 신고한 분께 알립니다. 임시조치·노출 차단은 글쓴이에게 조치 사실과 사유 종류만 알리고 신고한 분은 밝히지 않습니다.</span>
                    </section>
                  </div>
                </div>
              </>
            ) : null}
            {' '}
            {v.isDispute ? (
              <>
                <div className="widget-body" style={{ display: "grid", gridTemplateColumns: "repeat(2,minmax(0,1fr))", gap: "20px", alignItems: "start" }}>
                  <div className="col" style={{ gap: "14px" }}>
                    <div className="col" style={{ gap: "6px" }}>
                      <div className="row wrap" style={{ gap: "6px" }}>
                        <span className="badge badge-primary">정산 이의</span>
                        <span className="mono t-xs muted">CS-0052</span>
                        <span className="t-xs muted">제기 10/26(월) 16:20 KST · 파트너</span>
                      </div>
                      <p className="t-md fw-b">중개수수료 계산 이의</p>
                      <p className="t-sm muted">[예시 파트너 C] · [공연 D] 10/24(토) 회차 정산서 · 포트원</p>
                      <div className="row wrap" style={{ gap: "6px" }}>
                        <span className="badge">
                          <i className="ic ic-clock" aria-hidden="true" />
                          <span className="sr-only">진행 경과 통지 기한</span>
                          경과 10/29(목)까지 · 2영업일 남음
                        </span>
                        {' '}
                        <span className="badge">
                          <i className="ic ic-clock" aria-hidden="true" />
                          <span className="sr-only">결과 통지 기한</span>
                          결과 11/9(월)까지 · 9영업일 남음
                        </span>
                      </div>
                    </div>
                    <section className="col" style={{ gap: "6px" }} aria-labelledby="sd-h">
                      <div className="row between">
                        <h3 className="eyebrow" id="sd-h">이의가 걸린 정산서</h3>
                        <span className="badge badge-warning">이의</span>
                      </div>
                      <dl className="kv">
                        <dt>판매 대금</dt>
                        <dd className="num">₩9,800,000</dd>
                        <dt>환급</dt>
                        <dd className="num">−₩350,000</dd>
                        <dt>중개수수료(10.0%)</dt>
                        <dd className="num">−₩945,000</dd>
                        <dt>부가세</dt>
                        <dd className="num">−₩94,500</dd>
                        <dt>상계</dt>
                        <dd className="num">₩0</dd>
                        <dt>지급액</dt>
                        <dd className="num fw-b">₩8,410,500</dd>
                        <dt>상태</dt>
                        <dd>이의 · 10/30(금) 포트원 묶음에서 빠짐</dd>
                        <dt>이의 기한</dt>
                        <dd>10/28(수)</dd>
                      </dl>
                      <p className="t-xs muted">결제사 내부 ID · 결제사 오류 원문 · 정산 계좌는 이 건에 보이지 않습니다.</p>
                    </section>
                  </div>
                  <div className="col" style={{ gap: "14px" }}>
                    <section className="col" style={{ gap: "6px" }} aria-labelledby="sx-h">
                      <h3 className="eyebrow" id="sx-h">이의 내용</h3>
                      <dl className="kv">
                        <dt>사유 코드</dt>
                        <dd>중개수수료·부가세 차이(COMMISSION)</dd>
                        <dt>제기 시각</dt>
                        <dd>10/26(월) 16:20 KST</dd>
                      </dl>
                      <p className="card-flat t-sm" style={{ padding: "10px 12px" }}>
                        [공연 D]는 판매 승인 때 수수료율 9.0%로 고정됐는데, 정산서는 10.0%로 계산했습니다. 9.0%로 다시 계산해 주세요.
                      </p>
                      <Link to="/partners" className="link-more" style={{ alignSelf: "flex-start" }}>
                        파트너사에서 공연에 고정된 수수료율 보기
                        <i className="ic ic-chevron-right" aria-hidden="true" />
                      </Link>
                    </section>
                    {v.disputeAsk ? (
                      <>
                        <section className="col" style={{ gap: "10px" }} aria-labelledby="sp-h">
                          <h3 className="eyebrow" id="sp-h">처리 · CS 책임자</h3>
                          <div className="field">
                            <label className="label" htmlFor="sp-reason">
                              기각 사유{' '}
                              <span className="opt">(이의 기각 때 필수)</span>
                            </label>
                            {' '}
                            <textarea className="textarea" id="sp-reason" aria-describedby="sp-reason-h" style={{ minHeight: "72px" }} />
                            {' '}
                            <span className="hint" id="sp-reason-h">기각하면 이 사유로 파트너에게 다시 알립니다. 감사 기록에 남습니다</span>
                          </div>
                          <div className="row wrap" style={{ gap: "8px" }}>
                            <button className="btn btn-outline btn-sm" type="button" aria-describedby="sp-reason-h">이의 기각</button>
                            {' '}
                            <button onClick={() => go?.('정산 이의 · 이의 인정')} className="btn btn-primary btn-sm" type="button" aria-describedby="sp-acc-h">이의 인정 → 수기 조정 요청</button>
                          </div>
                          <span className="hint" id="sp-acc-h">이의를 인정하면 수기 조정 양식이 열립니다. 사유는 이 이의의 코드로 고정되고, commander가 승인 업무에서 승인해야 정산서에 반영됩니다.</span>
                        </section>
                      </>
                    ) : null}
                    {' '}
                    {v.disputeForm ? (
                      <>
                        <section className="col" style={{ gap: "10px" }} aria-labelledby="sa-h">
                          <div className="row between" style={{ gap: "8px" }}>
                            <h3 className="eyebrow" id="sa-h">이의 인정 · 수기 조정 요청</h3>
                            <span className="badge badge-outline">commander 승인</span>
                          </div>
                          <div className="field">
                            <label className="label" htmlFor="sa-code">사유</label>
                            <div className="input-group input-group-sm is-disabled">
                              <select id="sa-code" disabled aria-describedby="sa-code-h" defaultValue="중개수수료·부가세 차이(이의 인정)">
                                <option>중개수수료·부가세 차이(이의 인정)</option>
                              </select>
                              <i className="ic ic-lock ic-16" aria-hidden="true" />
                            </div>
                            <span className="hint" id="sa-code-h">이의를 받아들인 조정이라 그 이의의 코드로 고정했습니다</span>
                          </div>
                          <div className="field">
                            <label className="label" htmlFor="sa-amt">
                              금액(±){' '}
                              <span className="opt">(필수)</span>
                            </label>
                            <div className="input-group input-group-sm">
                              <span className="t-sm muted" aria-hidden="true">₩</span>
                              <input id="sa-amt" type="text" inputMode="numeric" defaultValue="+103,950" aria-describedby="sa-amt-h" />
                            </div>
                            <span className="hint" id="sa-amt-h">+면 지급을 늘리고 −면 줄입니다. 조정 뒤 지급액 ₩8,514,450</span>
                          </div>
                          <div className="field">
                            <label className="label" htmlFor="sa-memo">
                              근거 메모{' '}
                              <span className="opt">(선택)</span>
                            </label>
                            {' '}
                            <textarea className="textarea is-focus" id="sa-memo" style={{ minHeight: "88px" }} aria-describedby="sa-memo-h sa-memo-c" defaultValue="판매 승인 때 고정한 수수료율 9.0%로 다시 계산했습니다. 중개수수료 ₩94,500과 부가세 ₩9,450이 많았습니다." />
                            <div className="row between" style={{ gap: "8px", alignItems: "flex-start" }}>
                              <span className="hint" id="sa-memo-h">2,000자까지 적습니다. 팬 개인정보를 적지 않습니다</span>
                              <span className="counter nowrap" id="sa-memo-c" aria-live="polite">67 / 2,000자</span>
                            </div>
                          </div>
                          <p className="row t-xs muted" style={{ gap: "6px", alignItems: "flex-start" }}>
                            <i className="ic ic-stamp ic-14" aria-hidden="true" style={{ marginTop: "1px" }} />
                            <span>요청하면 승인 업무가 되고, commander가 승인해야 정산서에 반영됩니다. 반영되면 파트너에게 조정한 정산서를 다시 알립니다.</span>
                          </p>
                          <div className="row wrap" style={{ gap: "8px" }}>
                            <button onClick={close} className="btn btn-outline btn-sm" type="button">닫기</button>
                            <button onClick={close} className="btn btn-primary btn-sm" type="button">
                              <i className="ic ic-stamp" aria-hidden="true" />
                              수기 조정 승인을 요청합니다
                            </button>
                          </div>
                        </section>
                      </>
                    ) : null}
                  </div>
                </div>
              </>
            ) : null}
            {' '}
            {v.isAppeal ? (
              <>
                <div className="widget-body" style={{ display: "grid", gridTemplateColumns: "repeat(2,minmax(0,1fr))", gap: "20px", alignItems: "start" }}>
                  <div className="col" style={{ gap: "14px" }}>
                    <div className="col" style={{ gap: "6px" }}>
                      <div className="row wrap" style={{ gap: "6px" }}>
                        <span className="badge badge-primary">소명</span>
                        <span className="mono t-xs muted">CS-0076</span>
                        <span className="t-xs muted">제출 10/25(일) 15:20 KST · 소명 제출 화면</span>
                      </div>
                      <p className="t-md fw-b">예매 제한에 대한 소명</p>
                      <div className="row wrap" style={{ gap: "6px" }}>
                        <span className="badge">
                          <i className="ic ic-clock" aria-hidden="true" />
                          <span className="sr-only">결과 통지 기한</span>
                          결과 10/28(수)까지 · 3영업일 남음
                        </span>
                      </div>
                    </div>
                    <section className="col" style={{ gap: "6px" }} aria-labelledby="ap-txt-h">
                      <h3 className="eyebrow" id="ap-txt-h">소명 글</h3>
                      <p className="card-flat t-sm" style={{ padding: "10px 12px" }}>회사 단체 관람 일정이 바뀌어 한꺼번에 취소했습니다. 되팔 목적은 없었습니다.</p>
                    </section>
                    <section className="col" style={{ gap: "6px" }} aria-labelledby="ap-tg-h">
                      <div className="row between">
                        <h3 className="eyebrow" id="ap-tg-h">이어진 대상 · 예매 제한</h3>
                        <Link to="/customers" className="link-more">
                          팬 조회
                          <i className="ic ic-chevron-right" aria-hidden="true" />
                        </Link>
                      </div>
                      <dl className="kv">
                        <dt>상태</dt>
                        <dd><span className="badge badge-warning">제한 중</span></dd>
                        <dt>사유 범주</dt>
                        <dd>최근 1개월 취소가 많음</dd>
                        <dt>소명 기한</dt>
                        <dd>10/27(화) 18:00 KST · 기한 안에 냄</dd>
                        <dt>계정</dt>
                        <dd>
                          <span aria-hidden="true">●●●</span>
                          <span className="sr-only">가려져 있음</span>
                        </dd>
                      </dl>
                    </section>
                  </div>
                  <div className="col" style={{ gap: "14px" }}>
                    <section className="col" style={{ gap: "10px" }} aria-labelledby="ap-do-h">
                      <h3 className="eyebrow" id="ap-do-h">판단 · CS 책임자</h3>
                      <div className="field">
                        <label className="label" htmlFor="ap-rv">
                          검토 사유{' '}
                          <span className="opt">(제한 유지 때 필수)</span>
                        </label>
                        {' '}
                        <textarea className="textarea" id="ap-rv" aria-describedby="ap-rv-h" style={{ minHeight: "72px" }} />
                        {' '}
                        <span className="hint" id="ap-rv-h">제한을 유지하면 적은 검토 사유가 팬의 소명 결과에 그대로 보입니다. 감사 기록에 남습니다</span>
                      </div>
                      <div className="row wrap" style={{ gap: "8px" }}>
                        <button className="btn btn-primary btn-sm" type="button" aria-describedby="ap-ntf">해제</button>
                        {' '}
                        <button className="btn btn-outline btn-sm" type="button" aria-describedby="ap-rv-h ap-ntf">제한 유지</button>
                      </div>
                      <span className="hint" id="ap-ntf">예매 제한 목록의 [해제]와 같은 판단입니다. 결과는 팬에게 알리고 소명 결과에 보입니다.</span>
                    </section>
                  </div>
                </div>
              </>
            ) : null}
            {' '}
            {v.isPgDiff ? (
              <>
                <div className="widget-body" style={{ display: "grid", gridTemplateColumns: "repeat(2,minmax(0,1fr))", gap: "20px", alignItems: "start" }}>
                  <div className="col" style={{ gap: "14px" }}>
                    <div className="col" style={{ gap: "6px" }}>
                      <div className="row wrap" style={{ gap: "6px" }}>
                        <span className="badge badge-primary">결제사 잔액 대사 차이</span>
                        <span className="mono t-xs muted">CS-0081</span>
                        <span className="t-xs muted">생성 10/29(목) 09:00 KST · 지급 묶음 대사 · 자동</span>
                      </div>
                      <p className="t-md fw-b">토스페이먼츠 일반 상점 잔액이 장부와 ₩12,400 다릅니다</p>
                      <div className="row wrap" style={{ gap: "6px" }}>
                        <span className="badge badge-outline">기한 없음</span>
                        <span className="badge">SEV3 경보 함께 옴</span>
                        <span className="badge badge-outline">지급 묶음은 멈추지 않음</span>
                      </div>
                    </div>
                    <section className="col" style={{ gap: "6px" }} aria-labelledby="pg-h">
                      <h3 className="eyebrow" id="pg-h">대사 결과 · 10/29(목) 09:00 KST</h3>
                      <dl className="kv">
                        <dt>장부로 계산한 있어야 할 잔액</dt>
                        <dd className="num">₩463,442,400</dd>
                        <dt>결제사가 보여 주는 잔액</dt>
                        <dd className="num">₩463,430,000</dd>
                        <dt>차이</dt>
                        <dd className="num fw-b tx-warning">₩12,400 · 1만 원 [가정] 넘음</dd>
                      </dl>
                      <p className="t-xs muted">결제사 잔액은 지급 가능 ₩402,180,000과 정산 대기 ₩61,250,000을 더한 값입니다. 잔액이 모자라는지는 정산 지급 화면에서 따로 봅니다.</p>
                    </section>
                  </div>
                  <div className="col" style={{ gap: "14px" }}>
                    <section className="col" style={{ gap: "10px" }} aria-labelledby="pg-do-h">
                      <h3 className="eyebrow" id="pg-do-h">처리 · operator·commander</h3>
                      <div className="field">
                        <label className="label" htmlFor="pg-why">
                          차이의 설명{' '}
                          <span className="opt">(필수)</span>
                        </label>
                        <div className="input-group input-group-sm">
                          <select id="pg-why" aria-describedby="pg-why-h" defaultValue="정산 대기 시점 차이">
                            <option>원 미만 끝수</option>
                            <option>정산 대기 시점 차이</option>
                            <option>그 밖의 원인(결제사 거래와 장부 대조)</option>
                          </select>
                          <i className="ic ic-chevron-down" aria-hidden="true" />
                        </div>
                        <span className="hint" id="pg-why-h">
                          원 미만 끝수나 정산 대기 시점 차이로 설명되면 '설명된 차이'로 적고 닫습니다. 그 밖이면 결제사 거래와 장부(승인·취소·수수료·지급)를 대조해 원인을 적습니다
                        </span>
                      </div>
                      <div className="field">
                        <label className="label" htmlFor="pg-memo">
                          원인 메모{' '}
                          <span className="opt">(필수)</span>
                        </label>
                        {' '}
                        <textarea className="textarea is-focus" id="pg-memo" style={{ minHeight: "72px" }} aria-describedby="pg-memo-h" defaultValue="09:00 조회 뒤에 정산 대기에 잡힌 승인 1건(₩12,400) 때문입니다. 10:30에 다시 조회해 차이가 0인 것을 확인했습니다." />
                        {' '}
                        <span className="hint" id="pg-memo-h">감사 기록에 남습니다</span>
                      </div>
                      <div className="row wrap" style={{ gap: "8px" }}>
                        <button className="btn btn-primary btn-sm" type="button">'설명된 차이'로 적고 닫기</button>
                        {' '}
                        <button className="btn btn-outline btn-sm" type="button">원인을 적어 두기</button>
                      </div>
                    </section>
                  </div>
                </div>
              </>
            ) : null}
            {' '}
            {v.isGone ? (
              <>
                <div className="widget-body">
                  <div className="state" role="alert" style={{ padding: "40px 16px", gap: "10px" }}>
                    <span className="state-icon"><i className="ic ic-inbox" aria-hidden="true" /></span>
                    <h3 className="t-md fw-b">없는 건입니다</h3>
                    <p className="t-sm muted">접수 번호를 확인해 주세요.</p>
                    <Link to="/cs/inbox" className="btn btn-outline btn-sm">건 목록으로</Link>
                  </div>
                </div>
              </>
            ) : null}
          </section>
        </>
      ) : null}
    </div>
    </>
  );
}

export function OverlaysT({ v, close, go }: { v: V; close?: () => void; go?: (state: string) => void }) {
  void v; void close; void go;
  return (
    <>
    {v.isReason ? (
      <>
        <Overlay placement="center" onClose={close}>
          <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="rv-t" aria-describedby="rv-d" style={{ maxWidth: "480px" }}>
            <h2 className="dialog-title" id="rv-t">가린 개인정보를 열람합니다</h2>
            <div className="col" id="rv-d" style={{ gap: "6px" }}>
              <p className="t-sm">CS-0058 결제자의 이름과 전화번호를 봅니다.</p>
              <p className="t-sm muted">열람 사유는 접속기록에 남습니다. 열람 기록은 매월 접속기록 점검 대상입니다.</p>
            </div>
            <div className="field">
              <label className="label" htmlFor="rv-reason">열람 사유 (필수)</label>
              {' '}
              <textarea className="textarea is-focus" id="rv-reason" aria-describedby="rv-h rv-c" style={{ minHeight: "96px" }} defaultValue="팬이 전화 상담을 요청해 결제자 본인인지 확인합니다" />
              {' '}
              <span className="hint" id="rv-h">무엇 때문에 보는지 적어 주세요. 사유를 적어야 열람할 수 있습니다.</span>
              {' '}
              <span className="counter" id="rv-c" aria-live="polite">28 / 500자</span>
            </div>
            <div className="dialog-actions">
              <button onClick={close} className="btn btn-outline" type="button">닫기</button>
              {' '}
              <button onClick={close} className="btn btn-primary" type="button">
                <i className="ic ic-eye" aria-hidden="true" />
                사유를 남기고 열람합니다
              </button>
            </div>
          </div>
        </Overlay>
      </>
    ) : null}
    </>
  );
}
