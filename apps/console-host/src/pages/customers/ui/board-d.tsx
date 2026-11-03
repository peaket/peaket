// 디자인 캔버스 보드 SCR-066-d.dc.html를 옮긴 것(dc2tsx 생성 뒤 손질)
/* eslint-disable */
import { Fragment, type FormEvent } from 'react';
import { Link } from 'react-router';
import { Overlay } from '@/shared/ui/Overlay';

const prevent = (e: FormEvent) => e.preventDefault();
void Fragment;
void Link;

type AriaBool = boolean | 'true' | 'false';
type AriaCurrent = boolean | 'true' | 'false' | 'page' | 'step' | 'location' | 'date' | 'time';

export const STATES_D = ["기본", "열람 사유 대화상자", "열람 뒤", "찾는 계정 없음"] as const;
export const DEFAULT_D = "기본";

export function valsD(state: string) {
    let st = state || '기본';
    return {
      found: st !== '찾는 계정 없음',
      notFound: st === '찾는 계정 없음',
      masked: st !== '열람 뒤',
      revealed: st === '열람 뒤',
      showDialog: st === '열람 사유 대화상자'
    };
  }

type V = ReturnType<typeof valsD>;

// 보드 루트: {"class": "pk dark cs", "style": "width:100%;min-height:1120px;grid-template-rows:auto 1fr"}

// <main class="cs-main" id="main">
export function MainD({ v, close, go }: { v: V; close?: () => void; go?: (state: string) => void }) {
  void v; void close; void go;
  return (
    <>
    <div className="page-head">
      <div className="col" style={{ gap: "4px" }}>
        <h1>팬 조회</h1>
        <p className="t-sm muted">분쟁·예외 환불·양도 회수를 판단하려고 팬 계정의 이력을 봅니다. 이름·연락처는 가려서 보이고, 사유를 남긴 뒤에만 엽니다.</p>
      </div>
    </div>
    {v.found ? (
      <>
        <form className="widget" role="search" aria-label="팬 계정 찾기" onSubmit={prevent}>
          <div className="widget-body" style={{ padding: "16px" }}>
            <div className="row" style={{ gap: "12px", alignItems: "flex-start" }}>
              <div className="field" style={{ width: "520px" }}>
                <label className="label" htmlFor="fs-q">주문번호·예매번호·회원 코드</label>
                <div className="input-group">
                  <i className="ic ic-search" aria-hidden="true" />
                  <input id="fs-q" type="search" defaultValue="2026101400123" autoComplete="off" aria-describedby="fs-q-h" />
                </div>
                <span className="hint" id="fs-q-h">이름·전화번호로는 찾지 않습니다</span>
              </div>
              <button className="btn btn-primary" type="button" style={{ height: "48px", marginTop: "25px" }}>찾기</button>
              <p className="t-sm muted" role="status" style={{ marginTop: "39px" }}>예매번호로 계정 1개를 찾았습니다</p>
            </div>
          </div>
        </form>
      </>
    ) : null}
    {' '}
    {v.notFound ? (
      <>
        <div className="col" style={{ gap: "16px" }}>
          <form className="widget" role="search" aria-label="팬 계정 찾기" onSubmit={prevent}>
            <div className="widget-body" style={{ padding: "16px" }}>
              <div className="row" style={{ gap: "12px", alignItems: "flex-start" }}>
                <div className="field" style={{ width: "520px" }}>
                  <label className="label" htmlFor="fs-q2">주문번호·예매번호·회원 코드</label>
                  <div className="input-group">
                    <i className="ic ic-search" aria-hidden="true" />
                    <input id="fs-q2" type="search" defaultValue="2026101400999" autoComplete="off" aria-describedby="fs-q2-h" />
                  </div>
                  <span className="hint" id="fs-q2-h">이름·전화번호로는 찾지 않습니다</span>
                </div>
                <button className="btn btn-primary" type="button" style={{ height: "48px", marginTop: "25px" }}>찾기</button>
              </div>
            </div>
          </form>
          <section className="widget" aria-labelledby="h-none">
            <div className="state" role="status">
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
        <div className="col" style={{ gap: "16px" }}>
          <section className="widget" aria-labelledby="h-log">
            <div className="widget-head">
              <h2 className="t-sm fw-b" id="h-log">열람 기록</h2>
              <span className="actions">
                <span className="badge badge-outline">
                  <i className="ic ic-shield" aria-hidden="true" />
                  접속기록 점검 대상
                </span>
              </span>
            </div>
            <div className="widget-body" aria-live="polite">
              {v.masked ? (
                <>
                  <p className="t-sm muted">아직 열람하지 않았습니다. 가린 값을 열람하면 사유·시각·열람자가 여기에 표시되고 접속기록에 남습니다.</p>
                </>
              ) : null}
              {' '}
              {v.revealed ? (
                <>
                  <ul className="col" style={{ gap: "6px" }}>
                    <li className="row wrap" style={{ gap: "6px 12px" }}>
                      <i className="ic ic-eye ic-16" aria-hidden="true" />
                      <strong className="t-sm fw-b">열람 사유: 분쟁 접수 #123 확인 · 14:02 KST</strong>
                      <span className="t-sm muted">열람자 다은(cs_agent) · 이름·휴대폰 번호·이메일</span>
                    </li>
                  </ul>
                </>
              ) : null}
            </div>
          </section>
          <section className="widget" aria-labelledby="h-acct">
            <div className="widget-head"><h2 className="t-sm fw-b" id="h-acct">계정 요약</h2></div>
            <div className="widget-body" style={{ padding: "16px" }}>
              <div className="grid-12" style={{ rowGap: "16px", alignItems: "start" }}>
                <dl className="span-7" style={{ display: "grid", gridTemplateColumns: "repeat(3,minmax(0,1fr))", gap: "18px 24px" }}>
                  <div className="col" style={{ gap: "4px" }}>
                    <dt className="eyebrow">닉네임</dt>
                    <dd className="t-md fw-b">지민</dd>
                  </div>
                  <div className="col" style={{ gap: "4px" }}>
                    <dt className="eyebrow">회원 코드</dt>
                    <dd className="mono t-md">PK7-42Q9</dd>
                  </div>
                  <div className="col" style={{ gap: "4px" }}>
                    <dt className="eyebrow">상태</dt>
                    <dd><span className="badge badge-success">정상</span></dd>
                  </div>
                  <div className="col" style={{ gap: "4px" }}>
                    <dt className="eyebrow">본인확인</dt>
                    <dd className="row wrap" style={{ gap: "4px 6px" }}>
                      <span className="badge badge-success">
                        <i className="ic ic-check" aria-hidden="true" />
                        완료
                      </span>
                      <span className="t-sm muted">10/02(금) 21:14 KST</span>
                    </dd>
                  </div>
                  <div className="col" style={{ gap: "4px" }}>
                    <dt className="eyebrow">로그인 수단</dt>
                    <dd className="t-md">카카오</dd>
                  </div>
                  <div className="col" style={{ gap: "4px" }}>
                    <dt className="eyebrow">병합 이력</dt>
                    <dd className="t-md">없음</dd>
                  </div>
                  <div className="col" style={{ gap: "4px" }}>
                    <dt className="eyebrow">예매 제한</dt>
                    <dd className="t-md">없음</dd>
                  </div>
                </dl>
                <div className="span-5 card-flat" style={{ padding: "14px 16px", display: "flex", flexDirection: "column", gap: "12px" }} role="group" aria-labelledby="h-pii">
                  <div className="row between">
                    <h3 className="t-sm fw-b" id="h-pii">가린 개인정보</h3>
                    {v.masked ? (
                      <>
                        <span className="badge">
                          <i className="ic ic-lock" aria-hidden="true" />
                          가림
                        </span>
                      </>
                    ) : null}
                    {' '}
                    {v.revealed ? (
                      <>
                        <span className="badge badge-warning">
                          <i className="ic ic-eye" aria-hidden="true" />
                          열람함 · 14:02 KST
                        </span>
                      </>
                    ) : null}
                  </div>
                  <dl className="t-sm" style={{ display: "grid", gridTemplateColumns: "96px minmax(0,1fr)", gap: "8px 12px" }}>
                    <dt className="muted">이름</dt>
                    <dd>
                      {v.masked ? (
                        <>
                          <span className="mono" aria-hidden="true">●●●</span>
                          <span className="sr-only">가려짐</span>
                        </>
                      ) : null}
                      {v.revealed ? (
                        <>
                          <span className="fw-m">[예시 이름]</span>
                        </>
                      ) : null}
                    </dd>
                    <dt className="muted">휴대폰 번호</dt>
                    <dd>
                      {v.masked ? (
                        <>
                          <span className="mono" aria-hidden="true">●●●-●●●●-●●●●</span>
                          <span className="sr-only">가려짐</span>
                        </>
                      ) : null}
                      {v.revealed ? (
                        <>
                          <span className="fw-m">[예시 휴대폰 번호]</span>
                        </>
                      ) : null}
                    </dd>
                    <dt className="muted">이메일</dt>
                    <dd>
                      {v.masked ? (
                        <>
                          <span className="mono" aria-hidden="true">●●●●@●●●●</span>
                          <span className="sr-only">가려짐</span>
                        </>
                      ) : null}
                      {v.revealed ? (
                        <>
                          <span className="fw-m">[예시 이메일]</span>
                        </>
                      ) : null}
                    </dd>
                  </dl>
                  {v.masked ? (
                    <>
                      <div className="col" style={{ gap: "8px", alignItems: "flex-start" }}>
                        <button onClick={() => go?.('열람 사유 대화상자')} className="btn btn-outline" type="button" aria-haspopup="dialog" aria-describedby="pii-h">
                          <i className="ic ic-eye" aria-hidden="true" />
                          열람 사유 입력
                        </button>
                        <p className="hint" id="pii-h">열람 사유는 접속기록에 남습니다. 열람은 접속기록 정기 점검 대상입니다.</p>
                      </div>
                    </>
                  ) : null}
                  {' '}
                  {v.revealed ? (
                    <>
                      <p className="hint">사유를 남기고 열람했습니다. 사유·시각·열람자는 접속기록에 남았습니다.</p>
                    </>
                  ) : null}
                </div>
              </div>
            </div>
          </section>
          <section className="widget" aria-labelledby="h-hist">
            <div className="widget-head"><h2 className="t-sm fw-b" id="h-hist">계정 이력</h2></div>
            <div className="tabs" role="tablist" aria-label="계정 이력 종류" style={{ padding: "0 8px" }}>
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
            <p className="hint row" id="ht-queue-why" style={{ gap: "6px", padding: "10px 14px 0" }}>
              <i className="ic ic-info ic-14" aria-hidden="true" />
              대기 참여는 본인이 확인을 요청한 문의·건이 있을 때만 열립니다. 이 계정에는 그런 건이 없습니다.
            </p>
            <div role="tabpanel" id="hp-order" aria-labelledby="ht-order" style={{ padding: "10px 14px 14px" }}>
              <div className="table-wrap">
                <table className="table dense">
                  <caption className="sr-only">주문 1건, 주문 시각 최근 순</caption>
                  <thead>
                    <tr>
                      <th scope="col">예매번호</th>
                      <th scope="col">공연·회차</th>
                      <th scope="col">좌석·매수</th>
                      <th scope="col" className="r">결제 금액</th>
                      <th scope="col">결제사</th>
                      <th scope="col">상태</th>
                      <th scope="col" aria-sort="descending">주문 시각</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td className="mono">2026101400123</td>
                      <td>
                        LUMEN 콘서트 2026 서울
                        <span className="t-xs muted" style={{ display: "block" }}>10/25(일) 18:00 KST · 피켓 아레나</span>
                      </td>
                      <td>
                        R석 2매
                        <span className="t-xs muted" style={{ display: "block" }}>R구역 12열 7번·8번</span>
                      </td>
                      <td className="r">₩308,000</td>
                      <td>토스페이먼츠</td>
                      <td><span className="badge badge-success">결제 완료</span></td>
                      <td className="num">10/14(수) 20:21 KST</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          </section>
          <div className="row" style={{ gap: "12px", justifyContent: "flex-end" }}>
            <span className="t-xs muted">이 역할이 요청할 수 있는 종류: 예외 환불</span>
            {' '}
            <Link to="/cs/approvals" className="btn btn-secondary">
              <i className="ic ic-stamp" aria-hidden="true" />
              이 계정으로 승인 업무 만들기
            </Link>
          </div>
        </div>
      </>
    ) : null}
    </>
  );
}

export function OverlaysD({ v, close, go }: { v: V; close?: () => void; go?: (state: string) => void }) {
  void v; void close; void go;
  return (
    <>
    {v.showDialog ? (
      <>
        <Overlay placement="center" onClose={close}>
          <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="rv-t" aria-describedby="rv-d" style={{ maxWidth: "480px" }}>
            <h2 className="dialog-title" id="rv-t">가린 개인정보를 열람합니다</h2>
            <p className="t-sm muted" id="rv-d">계정 지민(PK7-42Q9)의 이름·휴대폰 번호·이메일을 엽니다. 열람 사유와 시각, 열람자는 접속기록에 남고 정기 점검 대상입니다.</p>
            <div className="field">
              <label className="label" htmlFor="rv-reason">열람 사유 (필수)</label>
              {' '}
              <input className="input is-focus" id="rv-reason" type="text" defaultValue="분쟁 접수 #123 확인" autoComplete="off" aria-describedby="rv-reason-h" />
              {' '}
              <span className="hint" id="rv-reason-h">처리 중인 건 번호와 무엇을 확인하는지 적어 주세요</span>
            </div>
            <div className="dialog-actions">
              <button onClick={close} className="btn btn-ghost" type="button">닫기</button>
              {' '}
              <button onClick={() => go?.('열람 뒤')} className="btn btn-primary" type="button">
                <i className="ic ic-eye" aria-hidden="true" />
                사유를 남기고 열람하기
              </button>
            </div>
          </div>
        </Overlay>
      </>
    ) : null}
    </>
  );
}
