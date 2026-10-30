// 디자인 캔버스 보드 SCR-049-m.dc.html를 옮긴 것(dc2tsx 생성 뒤 손질)
/* eslint-disable */
import { Fragment, type FormEvent } from 'react';
import { Link } from 'react-router';
import { Overlay } from '@/shared/ui/Overlay';
import { copyLink } from '@/shared/lib/clipboard';

const prevent = (e: FormEvent) => e.preventDefault();
void Fragment;
void Link;

type AriaBool = boolean | 'true' | 'false';
type AriaCurrent = boolean | 'true' | 'false' | 'page' | 'step' | 'location' | 'date' | 'time';

export const STATES_M = ["기본", "잔액 부족", "지급 실패·지연", "포트원 원장 대조 다름", "출금 대사 멈춤", "빈 화면", "viewer 보기", "CS 담당자"] as const;
export const DEFAULT_M = "기본";

export function valsM(state: string) {
    let st = state || '기본';
    let cs = st === 'CS 담당자';
    let vw = st === 'viewer 보기';
    return {
      isLedger: st === '포트원 원장 대조 다름',
      notLedger: st !== '포트원 원장 대조 다름',
      isRecon: st === '출금 대사 멈춤',
      isEmpty: st === '빈 화면',
      notEmpty: st !== '빈 화면' && !cs,
      isCs: cs,
      notCs: !cs,
      asCs: cs,
      asViewer: vw,
      asOp: !cs && !vw,
      myAppr: cs ? '2' : (vw ? '0' : '1'),
      isShort: st === '잔액 부족',
      notShort: st !== '잔액 부족',
      balCls: st === '잔액 부족' ? 'is-burning' : '',
      isFail: st === '지급 실패·지연',
      notFail: st !== '지급 실패·지연',
      nKyc: '1',
      nPay: st === '지급 실패·지연' ? '2' : '0',
      nExec: '0',
      nLedgerCase: st === '포트원 원장 대조 다름' ? '1' : '0',
      nPgDiff: '1'
    };
  }

type V = ReturnType<typeof valsM>;

// 보드 루트: {"class": "pk dark cs cs-compact", "style": "width:360px;min-height:4140px"}

// <main class="cs-main" id="main">
export function MainM({ v, close, go }: { v: V; close?: () => void; go?: (state: string) => void }) {
  void v; void close; void go;
  return (
    <>
    <div className="col" style={{ gap: "6px" }}>
      <h1 className="t-lg">정산 지급</h1>
      <p className="t-sm muted">지급 묶음은 지급일 전 영업일 09:00에 만들고, 15:00까지 commander가 승인해야 그 지급일에 지급합니다.</p>
    </div>
    {v.notCs ? (
      <>
        <div className="tabs tabs-scroll" role="tablist" aria-label="지급일">
          <button className="tab" type="button" role="tab" aria-selected="false">
            10/29(목)
            {v.notFail ? (
              <>
                <span className="badge badge-success">지급 중</span>
              </>
            ) : null}
            {v.isFail ? (
              <>
                <span className="badge badge-danger">실패 1</span>
              </>
            ) : null}
          </button>
          {' '}
          <button className="tab is-active" type="button" role="tab" aria-selected="true" aria-controls="pd-1030" id="tab-1030">
            10/30(금)
            <span className="badge badge-warning">승인 대기</span>
          </button>
          {' '}
          <button className="tab" type="button" role="tab" aria-selected="false">
            11/2(월)
            {v.notShort ? (
              <>
                <span className="badge">묶음 만들기 전</span>
              </>
            ) : null}
            {v.isShort ? (
              <>
                <span className="badge badge-warning">연기된 묶음 1</span>
              </>
            ) : null}
          </button>
          {' '}
          <button className="tab" type="button" role="tab" aria-selected="false">지난 지급</button>
        </div>
      </>
    ) : null}
    {' '}
    {v.notEmpty ? (
      <>
        <div className="col" id="pd-1030" role="tabpanel" aria-labelledby="tab-1030" style={{ gap: "12px" }}>
          {v.isRecon ? (
            <>
              <div className="banner banner-danger" role="alert">
                <i className="ic ic-alert-circle" aria-hidden="true" />
                <div className="banner-body">
                  <span className="banner-title">포트원 출금 대사가 멈췄습니다</span>
                  <p>실행 전에 commander가 콘솔에서 계좌와 출금을 확인해 주세요. 마지막 대사 10/29(목) 10:20 KST.</p>
                </div>
              </div>
            </>
          ) : null}
          {' '}
          {v.isFail ? (
            <>
              <div className="banner banner-danger" role="alert">
                <i className="ic ic-alert-circle" aria-hidden="true" />
                <div className="banner-body">
                  <span className="banner-title">지급 실패 1건 · 지급 지연 1건</span>
                  <p>
                    10/29(목) 토스페이먼츠 [예시 파트너 A] 지급 ₩7,820,000이 실패했고, 10/27(화) 토스페이먼츠 [예시 파트너 C] 지급 ₩3,260,000은 다음 영업일 12:00가 지나도 끝나지 않았습니다.{' '}
                    <Link to="/cs/inbox" className="link">CS 처리함에서 처리하기</Link>
                  </p>
                </div>
              </div>
            </>
          ) : null}
          {' '}
          {v.isShort ? (
            <>
              <div className="banner banner-warning" role="status">
                <i className="ic ic-alert" aria-hidden="true" />
                <div className="banner-body">
                  <span className="banner-title">결제사 잔액이 모자라 지급일을 미룹니다</span>
                  <p>토스페이먼츠 지급 가능 잔액 ₩286,400,000이 묶음 합계 ₩313,753,200보다 ₩27,353,200 적어 다음 영업일 11/2(월)에 지급하고 파트너에게 알립니다. 포트원 묶음은 그대로 지급합니다.</p>
                </div>
              </div>
            </>
          ) : null}
          <section className="col" style={{ gap: "8px" }} aria-labelledby="h-bal">
            <h2 className="eyebrow" id="h-bal">결제사 지급 가능 잔액</h2>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(2,minmax(0,1fr))", gap: "8px" }}>
              <div className={`stat ${v.balCls}`} style={{ padding: "10px 12px" }}>
                <span className="stat-label">토스페이먼츠</span>
                {' '}
                {v.notShort ? (
                  <>
                    <div className="col" style={{ gap: "6px" }}>
                      <span className="t-lg num">₩402,180,000</span>
                      <span className="slo slo-ok">합계보다 많음</span>
                    </div>
                  </>
                ) : null}
                {' '}
                {v.isShort ? (
                  <>
                    <div className="col" style={{ gap: "6px" }}>
                      <span className="t-lg num">₩286,400,000</span>
                      <span className="slo slo-burning">₩27,353,200 모자람</span>
                    </div>
                  </>
                ) : null}
                {' '}
                <span className="stat-meta">API · 09:00 조회 · 정산 대기 ₩61,250,000</span>
              </div>
              <div className="stat is-stale" style={{ padding: "10px 12px" }}>
                <span className="stat-label">포트원</span>
                <span className="t-lg num muted">—</span>
                <span className="stat-meta">
                  <a href="https://admin.portone.io/" className="link" target="_blank" rel="noopener noreferrer">
                    콘솔에서 확인
                    <i className="ic ic-external ic-14" aria-hidden="true" />
                    <span className="sr-only">(새 창)</span>
                  </a>
                </span>
              </div>
            </div>
          </section>
          <section className="col" style={{ gap: "12px" }} aria-labelledby="h-batch">
            <h2 className="eyebrow" id="h-batch">결제사·결제 상점별 지급 묶음 · 10/30(금)</h2>
            <article className="card is-selected col" style={{ gap: "10px", padding: "12px 14px" }} aria-labelledby="b-toss">
              <div className="row between" style={{ gap: "8px", alignItems: "flex-start" }}>
                <div className="col" style={{ gap: "4px" }}>
                  <h3 className="t-md fw-b" id="b-toss">토스페이먼츠</h3>
                  <span className="t-xs">
                    결제 상점 일반 ·{' '}
                    <span className="muted">선택한 묶음</span>
                  </span>
                </div>
                {v.notShort ? (
                  <>
                    <span className="badge badge-warning">승인 대기</span>
                  </>
                ) : null}
                {' '}
                {v.isShort ? (
                  <>
                    <span className="badge badge-warning">지급일 연기</span>
                  </>
                ) : null}
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "88px minmax(0,1fr)", gap: "8px" }}>
                <div className="stat" style={{ padding: "10px 12px" }}>
                  <span className="stat-label">건수</span>
                  <span className="t-lg num">2건</span>
                  <span className="stat-meta">제외 1</span>
                </div>
                <div className="stat" style={{ padding: "10px 12px" }}>
                  <span className="stat-label">합계</span>
                  <span className="t-lg num">₩313,753,200</span>
                  <span className="stat-meta">확정 정산서 지급액</span>
                </div>
              </div>
              {v.notShort ? (
                <>
                  <div className="col" style={{ gap: "4px" }}>
                    <div className="row wrap" style={{ gap: "6px" }}>
                      <span className="badge badge-outline">
                        <i className="ic ic-clock" aria-hidden="true" />
                        승인 기한 10/29(목) 15:00 KST
                      </span>
                      <span className="t-xs fw-b">남은 시간 3시간 17분</span>
                    </div>
                    <span className="t-xs muted">확인 요청 민호 · 10:05 KST</span>
                  </div>
                </>
              ) : null}
              {' '}
              {v.isShort ? (
                <>
                  <div className="col" style={{ gap: "4px" }}>
                    <div className="row wrap" style={{ gap: "6px" }}>
                      <span className="badge badge-warning">새 지급일 11/2(월)</span>
                      <span className="t-xs fw-b">승인 기한 10/30(금) 15:00 KST</span>
                    </div>
                    <span className="t-xs muted">파트너에게 지급 연기를 알립니다</span>
                  </div>
                </>
              ) : null}
              <p className="t-xs muted">제외 1건: [예시 파트너 B] · [공연 B] 10/23(금) · 보류(토스페이먼츠 KYC 필요) · ₩19,188,400</p>
            </article>
            <article className="card col" style={{ gap: "10px", padding: "12px 14px" }} aria-labelledby="b-po">
              <div className="row between" style={{ gap: "8px", alignItems: "flex-start" }}>
                <div className="col" style={{ gap: "4px" }}>
                  <h3 className="t-md fw-b" id="b-po">포트원</h3>
                  <span className="t-xs muted">콘솔에서 일괄 지급</span>
                </div>
                <span className="badge">확인 요청 전</span>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "88px minmax(0,1fr)", gap: "8px" }}>
                <div className="stat" style={{ padding: "10px 12px" }}>
                  <span className="stat-label">건수</span>
                  <span className="t-lg num">1건</span>
                  <span className="stat-meta">제외 1</span>
                </div>
                <div className="stat" style={{ padding: "10px 12px" }}>
                  <span className="stat-label">합계</span>
                  <span className="t-lg num">₩11,392,000</span>
                  <span className="stat-meta">확정 정산서 지급액</span>
                </div>
              </div>
              {v.isLedger ? (
                <>
                  <div className="stat" style={{ padding: "10px 12px" }}>
                    <span className="stat-label">지급 가능 잔액 · 작은 값</span>
                    <span className="t-lg num">₩181,970,000</span>
                    <span className="stat-meta">운영자 입력 ₩182,450,000 · 포트원 콘솔 기준 · 민호 10/29(목) 11:40 KST</span>
                    <span className="stat-meta">이체 원장 계산값 ₩181,970,000</span>
                    <span className="t-xs fw-b tx-warning">차이 ₩480,000 · 작은 값으로 판정합니다</span>
                  </div>
                </>
              ) : null}
              <div className="row wrap" style={{ gap: "6px" }}>
                <span className="badge badge-outline">
                  <i className="ic ic-clock" aria-hidden="true" />
                  승인 기한 10/29(목) 15:00 KST
                </span>
                <span className="t-xs fw-b">남은 시간 3시간 17분</span>
              </div>
              {v.notLedger ? (
                <>
                  <span className="t-xs muted">제외 1건(이의) ₩8,410,500</span>
                </>
              ) : null}
              {v.isLedger ? (
                <>
                  <span className="t-xs muted">제외 2건(이의 1 · 보류 1) ₩13,750,500</span>
                </>
              ) : null}
              <p className="t-xs fw-b">
                <i className="ic ic-alert ic-14 tx-warning" aria-hidden="true" />
                {' '}지급한 돈은 결제사가 되돌려 주지 않습니다. 합계와 제외 목록을 확인하세요
              </p>
              <div className="col" style={{ gap: "6px" }}>
                <h4 className="eyebrow">포트원 일괄 지급 실행 기록</h4>
                <div className="row wrap" style={{ gap: "6px" }}>
                  <span className="badge badge-outline">
                    <i className="ic ic-clock" aria-hidden="true" />
                    실행 기한 10/30(금) 15:00 KST
                  </span>
                  <span className="t-xs fw-b">27시간 17분 남음</span>
                </div>
                <p className="t-xs muted">승인되면 지급일 09:00에 CS 처리함에 실행 건이 생깁니다. 기록하면 30분마다 포트원 지급 내역을 불러 이 묶음(1건 · ₩11,392,000)과 대조해 보입니다.</p>
                {v.isLedger ? (
                  <>
                    <div className="card-flat pad col" style={{ gap: "4px" }}>
                      <span className="t-xs fw-b">출금 대사 · 직전 포트원 묶음(10/29(목) 지급)</span>
                      <span className="t-sm">지급 42건 · 맞음 41 · 다름 0 · 없음 1(결제사 반영 대기)</span>
                      <span className="t-xs muted">계좌가 맞지 않은 파트너의 정산서는 보류로 빠지고, 정산서 표의 '보류'에 사유 '포트원 계좌 불일치'로 나옵니다.</span>
                    </div>
                  </>
                ) : null}
              </div>
              <div className="banner banner-info bigscreen" role="note">
                <i className="ic ic-monitor" aria-hidden="true" />
                <div className="banner-body" style={{ flexBasis: "200px" }}>
                  <span className="banner-title">확인 요청과 포트원 실행 기록은 태블릿이나 데스크톱에서 합니다</span>
                  휴대폰에서는 볼 수만 있습니다
                </div>
                <button onClick={copyLink} className="btn btn-outline btn-sm" type="button">
                  <i className="ic ic-copy" aria-hidden="true" />
                  링크 복사
                </button>
              </div>
            </article>
          </section>
          <section className="widget" aria-labelledby="h-ap">
            <div className="widget-head">
              <h2 className="t-sm fw-b" id="h-ap">묶음 상세 · 토스페이먼츠 일반 상점 10/30(금)</h2>
              <div className="actions">
                {v.notShort ? (
                  <>
                    <span className="badge badge-warning">승인 대기</span>
                  </>
                ) : null}
                {v.isShort ? (
                  <>
                    <span className="badge badge-warning">지급일 연기</span>
                  </>
                ) : null}
              </div>
            </div>
            <div className="widget-body" style={{ gap: "10px" }}>
              <dl className="kv">
                <dt>요청</dt>
                <dd>민호(operator) · 10:05 KST</dd>
                <dt>대상</dt>
                <dd>정산서 2건 · ₩313,753,200</dd>
                <dt>제외</dt>
                <dd>보류 1건 · ₩19,188,400</dd>
                <dt>필요 승인</dt>
                <dd>commander 1명 · 아직 없음</dd>
              </dl>
              {v.notShort ? (
                <>
                  <div className="col" style={{ gap: "4px" }}>
                    <div className="row wrap" style={{ gap: "6px" }}>
                      <span className="badge badge-outline">
                        <i className="ic ic-clock" aria-hidden="true" />
                        승인 기한 10/29(목) 15:00 KST
                      </span>
                      <span className="t-xs fw-b">3시간 17분 남음</span>
                    </div>
                    <p className="t-xs muted">15:00가 지나면 지급일을 다음 영업일로 미룹니다.</p>
                  </div>
                </>
              ) : null}
              {' '}
              {v.isShort ? (
                <>
                  <div className="col" style={{ gap: "4px" }}>
                    <div className="row wrap" style={{ gap: "6px" }}>
                      <span className="badge badge-warning">새 지급일 11/2(월)</span>
                      <span className="badge badge-outline">
                        <i className="ic ic-clock" aria-hidden="true" />
                        승인 기한 10/30(금) 15:00 KST
                      </span>
                    </div>
                    <p className="t-xs muted">결제사 잔액이 생긴 영업일에 지급합니다.</p>
                  </div>
                </>
              ) : null}
              <div className="card-flat col" style={{ gap: "4px", padding: "10px 12px" }}>
                <p className="row t-sm" style={{ gap: "6px" }}>
                  <i className="ic ic-stamp ic-16" aria-hidden="true" />
                  <span className="grow">묶음 승인은 승인 업무 화면에서 합니다</span>
                  <Link to="/cs/approvals" className="link-more">
                    승인 업무
                    <i className="ic ic-chevron-right" aria-hidden="true" />
                  </Link>
                </p>
                {v.asOp ? (
                  <>
                    <p className="t-xs muted">요청한 분은 승인할 수 없습니다(승인은 commander).</p>
                  </>
                ) : null}
                {v.asViewer ? (
                  <>
                    <p className="t-xs muted">지급 묶음 승인은 commander가 합니다.</p>
                  </>
                ) : null}
              </div>
              <hr className="divider" />
              <h3 className="t-sm fw-b">지급 건</h3>
              <ul className="col">
                <li className="li between">
                  <div className="col" style={{ gap: "2px", minWidth: "0" }}>
                    <span className="t-xs">(주)스텔라엔터테인먼트 · LUMEN 10/25(일)</span>
                    <span className="hash">[정산서 ID]-1</span>
                    <span className="t-xs muted">
                      정산 계좌 ○○은행{' '}
                      <span aria-hidden="true">****</span>
                      1234
                      <span className="sr-only">(끝 4자리)</span>
                    </span>
                  </div>
                  <div className="col" style={{ gap: "4px", alignItems: "flex-end" }}>
                    <span className="t-sm num">₩271,966,200</span>
                    <span className="badge">요청 전</span>
                  </div>
                </li>
                <li className="li between">
                  <div className="col" style={{ gap: "2px", minWidth: "0" }}>
                    <span className="t-xs">[예시 파트너 A] · [공연 A] 10/24(토)</span>
                    <span className="hash">[정산서 ID]-1</span>
                    <span className="t-xs muted">
                      정산 계좌 [은행]{' '}
                      <span aria-hidden="true">****</span>
                      [끝 4자리]
                      <span className="sr-only">(끝 4자리)</span>
                    </span>
                  </div>
                  <div className="col" style={{ gap: "4px", alignItems: "flex-end" }}>
                    <span className="t-sm num">₩41,787,000</span>
                    <span className="badge">요청 전</span>
                  </div>
                </li>
              </ul>
              <div className="banner banner-info bigscreen" role="note">
                <i className="ic ic-monitor" aria-hidden="true" />
                <div className="banner-body" style={{ flexBasis: "200px" }}>
                  <span className="banner-title">예약지급 취소는 태블릿이나 데스크톱에서 합니다</span>
                  휴대폰에서는 볼 수만 있습니다. 정산 계좌는 은행과 끝 4자리만 보입니다
                </div>
                <button onClick={copyLink} className="btn btn-outline btn-sm" type="button">
                  <i className="ic ic-copy" aria-hidden="true" />
                  링크 복사
                </button>
              </div>
            </div>
          </section>
          <section className="widget" role="region" aria-labelledby="h-cases">
            <div className="widget-head">
              <h2 className="t-sm fw-b" id="h-cases">정산 건 · 종류별 건수</h2>
              <div className="actions"><span className="t-xs muted">열린 건</span></div>
            </div>
            <div className="widget-body" style={{ gap: "8px" }}>
              {v.asOp ? (
                <>
                  <ul className="col" aria-label="정산 건 종류별 건수">
                    <li className="row between" style={{ gap: "8px", padding: "6px 0", borderBottom: "1px solid var(--border)" }}>
                      <span className="t-sm">KYC 필요</span>
                      <Link to="/cs/inbox" className="link-more" aria-label={`KYC 필요 ${v.nKyc}건, CS 처리함에서 보기`}>
                        {v.nKyc}건
                        <i className="ic ic-chevron-right" aria-hidden="true" />
                      </Link>
                    </li>
                    <li className="row between" style={{ gap: "8px", padding: "6px 0", borderBottom: "1px solid var(--border)" }}>
                      <span className="t-sm">지급 요청 오류·실패·지연</span>
                      <Link to="/cs/inbox" className="link-more" aria-label={`지급 요청 오류·실패·지연 ${v.nPay}건, CS 처리함에서 보기`}>
                        {v.nPay}건
                        <i className="ic ic-chevron-right" aria-hidden="true" />
                      </Link>
                    </li>
                    <li className="row between" style={{ gap: "8px", padding: "6px 0", borderBottom: "1px solid var(--border)" }}>
                      <span className="t-sm">포트원 일괄 지급 실행</span>
                      <Link to="/cs/inbox" className="link-more" aria-label={`포트원 일괄 지급 실행 ${v.nExec}건, CS 처리함에서 보기`}>
                        {v.nExec}건
                        <i className="ic ic-chevron-right" aria-hidden="true" />
                      </Link>
                    </li>
                    <li className="row between" style={{ gap: "8px", padding: "6px 0", borderBottom: "1px solid var(--border)" }}>
                      <span className="t-sm">포트원 원장 불일치</span>
                      <Link to="/cs/inbox" className="link-more" aria-label={`포트원 원장 불일치 ${v.nLedgerCase}건, CS 처리함에서 보기`}>
                        {v.nLedgerCase}건
                        <i className="ic ic-chevron-right" aria-hidden="true" />
                      </Link>
                    </li>
                    <li className="row between" style={{ gap: "8px", padding: "6px 0", borderBottom: "1px solid var(--border)" }}>
                      <span className="t-sm">결제사 잔액 대사 차이</span>
                      <Link to="/cs/inbox" className="link-more" aria-label={`결제사 잔액 대사 차이 ${v.nPgDiff}건, CS 처리함에서 보기`}>
                        {v.nPgDiff}건
                        <i className="ic ic-chevron-right" aria-hidden="true" />
                      </Link>
                    </li>
                  </ul>
                  <p className="t-xs muted">건수를 누르면 CS 처리함의 그 종류 목록으로 갑니다. 이 건들은 operator·commander가 처리합니다.</p>
                </>
              ) : null}
              {' '}
              {v.asViewer ? (
                <>
                  <ul className="col" aria-label="정산 건 종류별 건수">
                    <li className="row between" style={{ gap: "8px", padding: "6px 0", borderBottom: "1px solid var(--border)" }}>
                      <span className="t-sm">KYC 필요</span>
                      <span className="t-sm fw-b num">{v.nKyc}건</span>
                    </li>
                    <li className="row between" style={{ gap: "8px", padding: "6px 0", borderBottom: "1px solid var(--border)" }}>
                      <span className="t-sm">지급 요청 오류·실패·지연</span>
                      <span className="t-sm fw-b num">{v.nPay}건</span>
                    </li>
                    <li className="row between" style={{ gap: "8px", padding: "6px 0", borderBottom: "1px solid var(--border)" }}>
                      <span className="t-sm">포트원 일괄 지급 실행</span>
                      <span className="t-sm fw-b num">{v.nExec}건</span>
                    </li>
                    <li className="row between" style={{ gap: "8px", padding: "6px 0", borderBottom: "1px solid var(--border)" }}>
                      <span className="t-sm">포트원 원장 불일치</span>
                      <span className="t-sm fw-b num">{v.nLedgerCase}건</span>
                    </li>
                    <li className="row between" style={{ gap: "8px", padding: "6px 0", borderBottom: "1px solid var(--border)" }}>
                      <span className="t-sm">결제사 잔액 대사 차이</span>
                      <span className="t-sm fw-b num">{v.nPgDiff}건</span>
                    </li>
                  </ul>
                  <p className="t-xs muted">viewer는 CS 처리함을 쓰지 않아 건수만 봅니다.</p>
                </>
              ) : null}
            </div>
          </section>
          <section className="widget" aria-labelledby="h-st">
            <div className="widget-head"><h2 className="t-sm fw-b" id="h-st">정산서 · 10/30(금) 지급</h2></div>
            <div className="widget-body" style={{ gap: "12px" }}>
              <div className="row wrap" role="group" aria-label="상태 필터" style={{ gap: "6px" }}>
                <button className="chip chip-sm is-selected" type="button" aria-pressed="true">
                  전체{' '}
                  {v.notLedger ? (
                    <>
                      5
                    </>
                  ) : null}
                  {v.isLedger ? (
                    <>
                      6
                    </>
                  ) : null}
                </button>
                {' '}
                <button className="chip chip-sm" type="button" aria-pressed="false">이의 1</button>
                {' '}
                <button className="chip chip-sm" type="button" aria-pressed="false">
                  보류{' '}
                  {v.notLedger ? (
                    <>
                      1
                    </>
                  ) : null}
                  {v.isLedger ? (
                    <>
                      2
                    </>
                  ) : null}
                </button>
                {' '}
                <button className="chip chip-sm" type="button" aria-pressed="false">실패 0</button>
                {' '}
                <button className="chip chip-sm" type="button" aria-pressed="false">미수금 이월 0</button>
              </div>
              <div className="row wrap" role="group" aria-label="정산서 종류 필터" style={{ gap: "6px" }}>
                <span className="t-xs muted">종류</span>
                <button className="chip chip-sm is-selected" type="button" aria-pressed="true">
                  전체{' '}
                  {v.notLedger ? (
                    <>
                      5
                    </>
                  ) : null}
                  {v.isLedger ? (
                    <>
                      6
                    </>
                  ) : null}
                </button>
                <button className="chip chip-sm" type="button" aria-pressed="false">
                  회차{' '}
                  {v.notLedger ? (
                    <>
                      5
                    </>
                  ) : null}
                  {v.isLedger ? (
                    <>
                      6
                    </>
                  ) : null}
                </button>
                <button className="chip chip-sm" type="button" aria-pressed="false">상품 0</button>
              </div>
              <div className="row wrap" role="group" aria-label="결제 상점 필터" style={{ gap: "6px" }}>
                <span className="t-xs muted">결제 상점</span>
                <button className="chip chip-sm is-selected" type="button" aria-pressed="true">전체</button>
                <button className="chip chip-sm" type="button" aria-pressed="false">일반</button>
                <button className="chip chip-sm" type="button" aria-pressed="false">에스크로</button>
              </div>
              <div className="col" style={{ gap: "8px" }}>
                <h3 className="eyebrow" id="st-toss">토스페이먼츠 일반 상점 · 3건</h3>
                <ul className="col" style={{ gap: "8px" }} aria-labelledby="st-toss">
                  <li className="card-flat col" style={{ gap: "6px", padding: "12px 14px" }}>
                    <div className="row between" style={{ gap: "8px", alignItems: "flex-start" }}>
                      <Link to="/partners" className="row t-sm fw-b" style={{ gap: "2px", color: "inherit" }}>
                        (주)스텔라엔터테인먼트
                        <i className="ic ic-chevron-right ic-16" aria-hidden="true" />
                      </Link>
                      <span className="badge badge-primary">확정</span>
                    </div>
                    <div className="row between" style={{ gap: "8px" }}>
                      <span className="t-xs muted">LUMEN 10/25(일)</span>
                      <span className="row" style={{ gap: "6px" }}>
                        <span className="t-xs muted">지급액</span>
                        <span className="t-sm fw-b num">₩271,966,200</span>
                      </span>
                    </div>
                  </li>
                  <li className="card-flat col" style={{ gap: "6px", padding: "12px 14px" }}>
                    <div className="row between" style={{ gap: "8px", alignItems: "flex-start" }}>
                      <Link to="/partners" className="row t-sm fw-b" style={{ gap: "2px", color: "inherit" }}>
                        [예시 파트너 A]
                        <i className="ic ic-chevron-right ic-16" aria-hidden="true" />
                      </Link>
                      <span className="badge badge-primary">확정</span>
                    </div>
                    <div className="row between" style={{ gap: "8px" }}>
                      <span className="t-xs muted">[공연 A] 10/24(토)</span>
                      <span className="row" style={{ gap: "6px" }}>
                        <span className="t-xs muted">지급액</span>
                        <span className="t-sm fw-b num">₩41,787,000</span>
                      </span>
                    </div>
                    <span className="t-xs muted" style={{ alignSelf: "flex-end" }}>상계 ₩1,200,000</span>
                  </li>
                  <li className="card-flat col" style={{ gap: "6px", padding: "12px 14px" }}>
                    <div className="row between" style={{ gap: "8px", alignItems: "flex-start" }}>
                      <Link to="/partners" className="row t-sm fw-b" style={{ gap: "2px", color: "inherit" }}>
                        [예시 파트너 B]
                        <i className="ic ic-chevron-right ic-16" aria-hidden="true" />
                      </Link>
                      <span className="badge badge-warning">보류 · KYC 필요</span>
                    </div>
                    <div className="row between" style={{ gap: "8px" }}>
                      <span className="t-xs muted">[공연 B] 10/23(금)</span>
                      <span className="row" style={{ gap: "6px" }}>
                        <span className="t-xs muted">지급액</span>
                        <span className="t-sm fw-b num">₩19,188,400</span>
                      </span>
                    </div>
                  </li>
                </ul>
              </div>
              <div className="col" style={{ gap: "8px" }}>
                <h3 className="eyebrow" id="st-po">
                  포트원 ·{' '}
                  {v.notLedger ? (
                    <>
                      2
                    </>
                  ) : null}
                  {v.isLedger ? (
                    <>
                      3
                    </>
                  ) : null}
                  건
                </h3>
                <ul className="col" style={{ gap: "8px" }} aria-labelledby="st-po">
                  <li className="card-flat col" style={{ gap: "6px", padding: "12px 14px" }}>
                    <div className="row between" style={{ gap: "8px", alignItems: "flex-start" }}>
                      <Link to="/partners" className="row t-sm fw-b" style={{ gap: "2px", color: "inherit" }}>
                        [예시 파트너 A]
                        <i className="ic ic-chevron-right ic-16" aria-hidden="true" />
                      </Link>
                      <span className="badge badge-primary">확정</span>
                    </div>
                    <div className="row between" style={{ gap: "8px" }}>
                      <span className="t-xs muted">[공연 C] 10/25(일)</span>
                      <span className="row" style={{ gap: "6px" }}>
                        <span className="t-xs muted">지급액</span>
                        <span className="t-sm fw-b num">₩11,392,000</span>
                      </span>
                    </div>
                  </li>
                  <li className="card-flat col" style={{ gap: "6px", padding: "12px 14px" }}>
                    <div className="row between" style={{ gap: "8px", alignItems: "flex-start" }}>
                      <Link to="/partners" className="row t-sm fw-b" style={{ gap: "2px", color: "inherit" }}>
                        [예시 파트너 C]
                        <i className="ic ic-chevron-right ic-16" aria-hidden="true" />
                      </Link>
                      <span className="badge badge-warning">이의</span>
                    </div>
                    <div className="row between" style={{ gap: "8px" }}>
                      <span className="t-xs muted">[공연 D] 10/24(토)</span>
                      <span className="row" style={{ gap: "6px" }}>
                        <span className="t-xs muted">지급액</span>
                        <span className="t-sm fw-b num">₩8,410,500</span>
                      </span>
                    </div>
                  </li>
                  {v.isLedger ? (
                    <>
                      <li className="card-flat col" style={{ gap: "6px", padding: "12px 14px" }}>
                        <div className="row between" style={{ gap: "8px", alignItems: "flex-start" }}>
                          <Link to="/partners" className="row t-sm fw-b" style={{ gap: "2px", color: "inherit" }}>
                            [예시 파트너 D]
                            <i className="ic ic-chevron-right ic-16" aria-hidden="true" />
                          </Link>
                          <span className="badge badge-warning">보류 · 포트원 계좌 불일치</span>
                        </div>
                        <div className="row between" style={{ gap: "8px" }}>
                          <span className="t-xs muted">[공연 E] 10/24(토)</span>
                          <span className="row" style={{ gap: "6px" }}>
                            <span className="t-xs muted">지급액</span>
                            <span className="t-sm fw-b num">₩5,340,000</span>
                          </span>
                        </div>
                      </li>
                    </>
                  ) : null}
                </ul>
              </div>
              <p className="t-xs muted">거래액 = 판매 대금 − 환급 · 수수료 = 중개수수료 + 부가세 10% · 지급액 = 거래액 − 수수료 − 상계</p>
            </div>
          </section>
          <section className="widget" aria-labelledby="h-rc">
            <div className="widget-head"><h2 className="t-sm fw-b" id="h-rc">미수금</h2></div>
            <div className="widget-body" style={{ gap: "10px" }}>
              <p className="t-xs muted">돌려받는 순서: 상계 → 보증(30일 안에 정산서가 없을 때) → 청구 → 손실</p>
              <ul className="col" style={{ gap: "8px" }} aria-label="열린 미수금">
                <li className="card-flat col" style={{ gap: "8px", padding: "12px 14px" }}>
                  <div className="row between" style={{ gap: "8px" }}>
                    <span className="t-sm fw-b">[예시 파트너 A]</span>
                    <span className="badge badge-primary">상계</span>
                  </div>
                  <dl className="kv">
                    <dt>원인</dt>
                    <dd>지급 뒤 환불</dd>
                    <dt>남은 금액</dt>
                    <dd>₩1,200,000</dd>
                    <dt>다음 처리</dt>
                    <dd>10/30(금) 정산서에 반영</dd>
                  </dl>
                </li>
                <li className="card-flat col" style={{ gap: "8px", padding: "12px 14px" }}>
                  <div className="row between" style={{ gap: "8px" }}>
                    <span className="t-sm fw-b">[예시 파트너 C]</span>
                    <span className="badge">상계 대기</span>
                  </div>
                  <dl className="kv">
                    <dt>원인</dt>
                    <dd>카드 이의제기</dd>
                    <dt>남은 금액</dt>
                    <dd>₩154,000</dd>
                    <dt>다음 처리</dt>
                    <dd>다음 정산서에서 상계</dd>
                  </dl>
                </li>
              </ul>
            </div>
          </section>
        </div>
      </>
    ) : null}
    {' '}
    {v.isCs ? (
      <>
        <div className="state" role="status" style={{ padding: "64px 16px", gap: "12px" }}>
          <span className="state-icon"><i className="ic ic-lock" aria-hidden="true" /></span>
          <h2 className="t-lg">정산 지급은 관제 역할이 봅니다</h2>
          <p className="t-sm muted">정산 이의는 CS 처리함에서 처리합니다.</p>
          <Link to="/cs/inbox" className="btn btn-outline">CS 처리함으로</Link>
        </div>
      </>
    ) : null}
    {' '}
    {v.isEmpty ? (
      <>
        <div className="state" role="status" style={{ padding: "64px 16px", gap: "12px" }}>
          <span className="state-icon"><i className="ic ic-won" aria-hidden="true" /></span>
          <h2 className="t-lg">오늘 처리할 지급 묶음이 없습니다</h2>
          <p className="t-sm muted">지급일 탭에서 다른 날을 고르면 그날의 지급 묶음과 정산서를 봅니다.</p>
        </div>
      </>
    ) : null}
    </>
  );
}

