// 디자인 캔버스 보드 SCR-066-m.dc.html를 옮긴 것(dc2tsx 생성 뒤 손질)
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

export const STATES_M = ["기본", "찾는 계정 없음"] as const;
export const DEFAULT_M = "기본";

export function valsM(state: string) {
    let st = state || '기본';
    return {
      found: st !== '찾는 계정 없음',
      notFound: st === '찾는 계정 없음'
    };
  }

type V = ReturnType<typeof valsM>;

// 보드 루트: {"class": "pk dark cs cs-compact", "style": "width:360px;min-height:1840px"}

// <main class="cs-main" id="main">
export function MainM({ v, close, go }: { v: V; close?: () => void; go?: (state: string) => void }) {
  void v; void close; void go;
  return (
    <>
    <div className="page-head">
      <div className="col" style={{ gap: "4px" }}>
        <h1>팬 조회</h1>
        <p className="t-sm muted">분쟁·예외 환불·양도 회수를 판단하려고 팬 계정의 이력을 봅니다. 이름·연락처는 가려서 보이고, 사유를 남긴 뒤에만 엽니다.</p>
      </div>
    </div>
    {v.notFound ? (
      <>
        <div className="col" style={{ gap: "12px" }}>
          <form className="widget" role="search" aria-label="팬 계정 찾기" onSubmit={prevent}>
            <div className="widget-body" style={{ padding: "16px", gap: "10px" }}>
              <div className="field">
                <label className="label" htmlFor="fs-q2">주문번호·예매번호·회원 코드</label>
                <div className="row" style={{ gap: "8px" }}>
                  <div className="input-group grow">
                    <i className="ic ic-search" aria-hidden="true" />
                    <input id="fs-q2" type="search" defaultValue="2026101400999" autoComplete="off" aria-describedby="fs-q2-h" />
                  </div>
                  <button className="btn btn-primary" type="button" style={{ height: "48px" }}>찾기</button>
                </div>
                <span className="hint" id="fs-q2-h">이름·전화번호로는 찾지 않습니다</span>
              </div>
            </div>
          </form>
          <section className="widget" aria-labelledby="h-none">
            <div className="state" role="status" style={{ padding: "32px 20px" }}>
              <span className="state-icon"><i className="ic ic-search" aria-hidden="true" /></span>
              <h2 className="t-lg" id="h-none">찾는 계정이 없습니다</h2>
              <p className="t-sm muted">주문번호·예매번호·회원 코드를 다시 확인해 주세요. 이름·전화번호로는 찾지 않습니다.</p>
            </div>
          </section>
        </div>
      </>
    ) : null}
    {' '}
    {v.found ? (
      <>
        <div className="col" style={{ gap: "12px" }}>
          <form className="widget" role="search" aria-label="팬 계정 찾기" onSubmit={prevent}>
            <div className="widget-body" style={{ padding: "16px", gap: "10px" }}>
              <div className="field">
                <label className="label" htmlFor="fs-q">주문번호·예매번호·회원 코드</label>
                <div className="row" style={{ gap: "8px" }}>
                  <div className="input-group grow">
                    <i className="ic ic-search" aria-hidden="true" />
                    <input id="fs-q" type="search" defaultValue="2026101400123" autoComplete="off" aria-describedby="fs-q-h" />
                  </div>
                  <button className="btn btn-primary" type="button" style={{ height: "48px" }}>찾기</button>
                </div>
                <span className="hint" id="fs-q-h">이름·전화번호로는 찾지 않습니다</span>
              </div>
              <p className="t-sm muted" role="status">예매번호로 계정 1개를 찾았습니다</p>
            </div>
          </form>
          <details className="widget">
            <summary className="widget-head">
              <h2 className="t-sm fw-b" id="h-log">열람 기록</h2>
              <span className="fold-meta">
                <span className="badge badge-outline">
                  <i className="ic ic-shield" aria-hidden="true" />
                  접속기록 점검 대상
                </span>
                <span>아직 없음</span>
                <i className="ic ic-chevron-down fold-ic" aria-hidden="true" />
              </span>
            </summary>
            <div className="widget-body" aria-live="polite"><p className="t-sm muted">아직 열람하지 않았습니다. 가린 값을 열람하면 사유·시각·열람자가 여기에 표시되고 접속기록에 남습니다.</p></div>
          </details>
          <section className="widget" aria-labelledby="h-acct">
            <div className="widget-head"><h2 className="t-sm fw-b" id="h-acct">계정 요약</h2></div>
            <div className="widget-body" style={{ padding: "16px", gap: "14px" }}>
              <dl className="kv">
                <dt>닉네임</dt>
                <dd className="fw-b">지민</dd>
                <dt>회원 코드</dt>
                <dd className="mono">PK7-42Q9</dd>
                <dt>상태</dt>
                <dd><span className="badge badge-success">정상</span></dd>
                <dt>본인확인</dt>
                <dd>
                  <span className="row wrap" style={{ gap: "4px 6px", justifyContent: "flex-end" }}>
                    <span className="badge badge-success">
                      <i className="ic ic-check" aria-hidden="true" />
                      완료
                    </span>
                    <span className="t-sm muted fw-r">10/02(금) 21:14 KST</span>
                  </span>
                </dd>
                <dt>로그인 수단</dt>
                <dd>카카오</dd>
                <dt>병합 이력</dt>
                <dd>없음</dd>
                <dt>예매 제한</dt>
                <dd>없음</dd>
              </dl>
              <div className="card-flat" style={{ padding: "14px 16px", display: "flex", flexDirection: "column", gap: "10px" }} role="group" aria-labelledby="h-pii">
                <div className="row between">
                  <h3 className="t-sm fw-b" id="h-pii">가린 개인정보</h3>
                  <span className="badge">
                    <i className="ic ic-lock" aria-hidden="true" />
                    가림
                  </span>
                </div>
                <dl className="kv">
                  <dt>이름</dt>
                  <dd>
                    <span className="mono" aria-hidden="true">●●●</span>
                    <span className="sr-only">가려짐</span>
                  </dd>
                  <dt>휴대폰 번호</dt>
                  <dd>
                    <span className="mono" aria-hidden="true">●●●-●●●●-●●●●</span>
                    <span className="sr-only">가려짐</span>
                  </dd>
                  <dt>이메일</dt>
                  <dd>
                    <span className="mono" aria-hidden="true">●●●●@●●●●</span>
                    <span className="sr-only">가려짐</span>
                  </dd>
                </dl>
              </div>
            </div>
          </section>
          <div className="banner banner-info bigscreen" role="note">
            <i className="ic ic-monitor" aria-hidden="true" />
            <div className="banner-body" style={{ flexBasis: "200px" }}>
              <span className="banner-title" id="bg-pii">가림 해제(열람)는 태블릿이나 데스크톱에서 합니다</span>
              휴대폰에서는 볼 수만 있습니다
            </div>
            <button onClick={copyLink} className="btn btn-outline btn-sm" type="button" aria-describedby="bg-pii">
              <i className="ic ic-copy" aria-hidden="true" />
              링크 복사
            </button>
          </div>
          <section className="widget" aria-labelledby="h-hist">
            <div className="widget-head"><h2 className="t-sm fw-b" id="h-hist">계정 이력</h2></div>
            <div className="tabs tabs-scroll" role="tablist" aria-label="계정 이력 종류" style={{ padding: "0 8px" }}>
              <button className="tab is-active" role="tab" id="ht-order" aria-selected="true" aria-controls="hp-order" type="button">
                주문{' '}
                <span className="badge">1</span>
              </button>
              {' '}
              <button className="tab" role="tab" id="ht-ticket" aria-selected="false" type="button">
                티켓{' '}
                <span className="badge">2</span>
              </button>
              {' '}
              <button className="tab" role="tab" id="ht-transfer" aria-selected="false" type="button">
                양도{' '}
                <span className="badge">0</span>
              </button>
              {' '}
              <button className="tab tx-disabled" role="tab" id="ht-queue" aria-selected="false" aria-disabled="true" aria-describedby="ht-queue-why" type="button">
                대기 참여
              </button>
              {' '}
              <button className="tab" role="tab" id="ht-case" aria-selected="false" type="button">
                문의·건{' '}
                <span className="badge">1</span>
              </button>
            </div>
            <p className="hint row" id="ht-queue-why" style={{ gap: "6px", alignItems: "flex-start", padding: "10px 14px 0" }}>
              <i className="ic ic-info ic-14" aria-hidden="true" style={{ marginTop: "2px" }} />
              대기 참여는 본인이 확인을 요청한 문의·건이 있을 때만 열립니다. 이 계정에는 그런 건이 없습니다.
            </p>
            <div role="tabpanel" id="hp-order" aria-labelledby="ht-order" style={{ padding: "12px 14px 14px" }}>
              <ul className="col" style={{ gap: "10px" }} aria-label="주문 1건, 주문 시각 최근 순">
                <li className="card" style={{ padding: "14px 16px", display: "flex", flexDirection: "column", gap: "10px" }}>
                  <div className="row between" style={{ gap: "8px" }}>
                    <span className="mono t-md fw-b">2026101400123</span>
                    <span className="badge badge-success">결제 완료</span>
                  </div>
                  <p className="t-sm fw-m">
                    LUMEN 콘서트 2026 서울
                    <span className="t-xs muted fw-r" style={{ display: "block" }}>10/25(일) 18:00 KST · 피켓 아레나</span>
                  </p>
                  <dl className="kv">
                    <dt>좌석·매수</dt>
                    <dd>
                      R석 2매
                      <span className="t-xs muted fw-r" style={{ display: "block" }}>R구역 12열 7번·8번</span>
                    </dd>
                    <dt>결제 금액</dt>
                    <dd>₩308,000</dd>
                    <dt>주문 시각</dt>
                    <dd>10/14(수) 20:21 KST</dd>
                  </dl>
                  <Link to="/customers" className="link-more" style={{ alignSelf: "flex-start" }}>
                    주문 상세
                    <i className="ic ic-chevron-right" aria-hidden="true" />
                  </Link>
                </li>
              </ul>
            </div>
          </section>
          <div className="col" style={{ gap: "8px" }}>
            <p className="t-xs muted">이 역할이 요청할 수 있는 종류: 예외 환불</p>
            <div className="banner banner-info bigscreen" role="note">
              <i className="ic ic-monitor" aria-hidden="true" />
              <div className="banner-body" style={{ flexBasis: "200px" }}>
                <span className="banner-title" id="bg-req">승인 업무 만들기는 태블릿이나 데스크톱에서 합니다</span>
                휴대폰에서는 볼 수만 있습니다
              </div>
              <button onClick={copyLink} className="btn btn-outline btn-sm" type="button" aria-describedby="bg-req">
                <i className="ic ic-copy" aria-hidden="true" />
                링크 복사
              </button>
            </div>
          </div>
        </div>
      </>
    ) : null}
    </>
  );
}

