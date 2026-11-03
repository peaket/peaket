// 디자인 캔버스 보드 SCR-031-m.dc.html를 옮긴 것(dc2tsx 생성 뒤 손질)
/* eslint-disable */
import { Fragment, type FormEvent } from 'react';
import { Link } from 'react-router';
import { Overlay } from '@/shared/ui/Overlay';

const prevent = (e: FormEvent) => e.preventDefault();
void Fragment;
void Link;

type AriaBool = boolean | 'true' | 'false';
type AriaCurrent = boolean | 'true' | 'false' | 'page' | 'step' | 'location' | 'date' | 'time';

export const STATES_M = ["기본", "빈 결과", "명단 다운로드 기록", "체인 변조", "공개 타임스탬프 대기", "공개 앵커 지연"] as const;
export const DEFAULT_M = "기본";

export function valsM(state: string) {
    let st = state || '기본';
    let dl = st === '명단 다운로드 기록';
    let empty = st === '빈 결과';
    let tamper = st === '체인 변조';
    let aWait = st === '공개 타임스탬프 대기';
    let aLate = st === '공개 앵커 지연';
    return {
      isTamper: tamper,
      anchorWait: aWait,
      anchorLate: aLate,
      anchorOk: !aWait && !aLate,
      notTamper: !tamper,
      isLogTab: !dl,
      isDl: dl,
      logCls: dl ? '' : 'is-active',
      logSel: dl ? 'false' : 'true',
      dlCls: dl ? 'is-active' : '',
      dlSel: dl ? 'true' : 'false',
      isEmpty: empty,
      hasRows: !empty
    };
  }

type V = ReturnType<typeof valsM>;

// 보드 루트: {"class": "pk dark cs cs-compact", "style": "width:360px;min-height:3640px"}

// <main class="cs-main" id="main">
export function MainM({ v, close, go }: { v: V; close?: () => void; go?: (state: string) => void }) {
  void v; void close; void go;
  return (
    <>
    <div className="col" style={{ gap: "6px" }}>
      <h1 className="t-lg">감사 로그·인시던트 리플레이</h1>
      <p className="t-sm muted">운영 명령, 자동 조치, 개인정보 열람 기록을 보고 경보·명령·지표를 같은 시간축에서 다시 재생합니다. 기록 시각은 UTC이고, 팬 관련 대상은 가명 참조값만 보입니다.</p>
    </div>
    <div className="banner banner-info bigscreen" role="note">
      <i className="ic ic-monitor" aria-hidden="true" />
      <div className="banner-body" style={{ flexBasis: "200px" }}>
        <span className="banner-title">원본 로그 내보내기는 태블릿이나 데스크톱에서 합니다</span>
        휴대폰에서는 볼 수만 있습니다
      </div>
      <button className="btn btn-outline btn-sm" type="button">
        <i className="ic ic-copy" aria-hidden="true" />
        링크 복사
      </button>
    </div>
    {v.isTamper ? (
      <>
        <div className="banner banner-danger" role="alert">
          <i className="ic ic-alert-circle" aria-hidden="true" />
          <div className="banner-body">
            <span className="banner-title">감사 체인 검증에 실패했습니다</span>
            11:00 UTC 검증에서 seq 1,204,361~1,204,363(10:52~10:58 UTC 기록 3건)이 5분 앵커와 맞지 않습니다. SEV2로 알렸고 보안 사고 기록에 올렸습니다. 이 3건은 앵커 버킷의 원본과 대조한 뒤에 근거로 쓰세요.
            <div style={{ marginTop: "10px" }}><Link to="/compliance" className="btn btn-outline btn-sm">법정 조치 · 보안 사고 보기</Link></div>
          </div>
        </div>
      </>
    ) : null}
    {' '}
    {v.anchorLate ? (
      <>
        <div className="banner banner-warning" role="status">
          <i className="ic ic-clock" aria-hidden="true" />
          <div className="banner-body">
            <span className="banner-title">공개 앵커 게시가 6시간 넘게 밀렸습니다</span>
            마지막 공개 체크포인트 #1284 · 04:40 UTC 게시. 내부 5분 앵커와 1시간마다 하는 감사 체인 검증은 계속됩니다. SEV3로 알렸습니다.
          </div>
        </div>
      </>
    ) : null}
    {' '}
    {v.anchorWait ? (
      <>
        <p className="row t-xs muted" style={{ gap: "6px" }}>
          <i className="ic ic-info ic-14" aria-hidden="true" />
          마지막 체크포인트 #1285의 공개 타임스탬프 증명이 비트코인 확정 전이라 대기 중입니다(보통 몇 시간). 그동안 이 체크포인트의 검증 묶음에는 대기 중인 증명이 들어갑니다.
        </p>
      </>
    ) : null}
    <div className="tabs" role="tablist" aria-label="감사 보기">
      <button className={`tab ${v.logCls}`} id="tb-log" role="tab" type="button" onClick={() => go?.('기본')} aria-selected={(v.logSel) as AriaBool}>감사 로그</button>
      {' '}
      <button className={`tab ${v.dlCls}`} id="tb-dl" role="tab" type="button" onClick={() => go?.('명단 다운로드 기록')} aria-selected={(v.dlSel) as AriaBool}>
        명단 다운로드 기록
        <span className="badge">4</span>
      </button>
    </div>
    {v.isLogTab ? (
      <>
        <div className="col" role="tabpanel" aria-labelledby="tb-log" style={{ gap: "12px" }}>
          {v.hasRows ? (
            <>
              <form className="col" role="search" aria-label="감사 기록 찾기" style={{ gap: "10px" }} onSubmit={prevent}>
                <div className="field">
                  <label className="label" htmlFor="f-period">기간(UTC)</label>
                  <div className="input-group">
                    <i className="ic ic-calendar ic-16" aria-hidden="true" />
                    <input id="f-period" type="text" defaultValue="2026-10-14 10:50 ~ 11:40" />
                  </div>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(2,minmax(0,1fr))", gap: "10px" }}>
                  <div className="field">
                    <label className="label" htmlFor="f-actor">행위자</label>
                    <div className="input-group">
                      <select id="f-actor" defaultValue="전체">
                        <option>전체</option>
                        <option>사람</option>
                        <option>시스템</option>
                        <option>런북 CLI</option>
                      </select>
                      <i className="ic ic-chevron-down ic-16" aria-hidden="true" />
                    </div>
                  </div>
                  <div className="field">
                    <label className="label" htmlFor="f-kind">종류</label>
                    <div className="input-group">
                      <select id="f-kind" defaultValue="전체">
                        <option>전체</option>
                        <option>운영 명령</option>
                        <option>자동 조치</option>
                        <option>Degraded 전환</option>
                        <option>개인정보 열람·다운로드</option>
                        <option>주문·좌석 이벤트</option>
                      </select>
                      <i className="ic ic-chevron-down ic-16" aria-hidden="true" />
                    </div>
                  </div>
                </div>
                <div className="field">
                  <label className="label" htmlFor="f-target">대상</label>
                  <div className="input-group">
                    <i className="ic ic-search ic-16" aria-hidden="true" />
                    <input id="f-target" type="search" placeholder="주문 ID, 좌석 ID, 명령 ID로 찾기" />
                  </div>
                </div>
                <button className="btn btn-secondary btn-block" type="submit" style={{ height: "44px" }}>조건으로 찾기</button>
              </form>
            </>
          ) : null}
          {' '}
          {v.isEmpty ? (
            <>
              <form className="col" role="search" aria-label="감사 기록 찾기" style={{ gap: "10px" }} onSubmit={prevent}>
                <div className="field">
                  <label className="label" htmlFor="f-period0">기간(UTC)</label>
                  <div className="input-group">
                    <i className="ic ic-calendar ic-16" aria-hidden="true" />
                    <input id="f-period0" type="text" defaultValue="2026-10-14 03:00 ~ 03:30" />
                  </div>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(2,minmax(0,1fr))", gap: "10px" }}>
                  <div className="field">
                    <label className="label" htmlFor="f-actor0">행위자</label>
                    <div className="input-group">
                      <select id="f-actor0" defaultValue="런북 CLI">
                        <option>전체</option>
                        <option>사람</option>
                        <option>시스템</option>
                        <option>런북 CLI</option>
                      </select>
                      <i className="ic ic-chevron-down ic-16" aria-hidden="true" />
                    </div>
                  </div>
                  <div className="field">
                    <label className="label" htmlFor="f-kind0">종류</label>
                    <div className="input-group">
                      <select id="f-kind0" defaultValue="전체">
                        <option>전체</option>
                        <option>운영 명령</option>
                        <option>자동 조치</option>
                        <option>Degraded 전환</option>
                        <option>개인정보 열람·다운로드</option>
                        <option>주문·좌석 이벤트</option>
                      </select>
                      <i className="ic ic-chevron-down ic-16" aria-hidden="true" />
                    </div>
                  </div>
                </div>
                <div className="field">
                  <label className="label" htmlFor="f-target0">대상</label>
                  <div className="input-group">
                    <i className="ic ic-search ic-16" aria-hidden="true" />
                    <input id="f-target0" type="search" placeholder="주문 ID, 좌석 ID, 명령 ID로 찾기" />
                  </div>
                </div>
                <button className="btn btn-secondary btn-block" type="submit" style={{ height: "44px" }}>조건으로 찾기</button>
              </form>
            </>
          ) : null}
          <div className="col" style={{ gap: "6px" }}>
            {v.hasRows ? (
              <>
                <span className="t-xs muted">13건 · 시각 오름차순 · 카드를 누르면 상세를 펼칩니다</span>
              </>
            ) : null}
            {' '}
            {v.isEmpty ? (
              <>
                <span className="t-xs muted">0건</span>
              </>
            ) : null}
            {' '}
            {v.notTamper ? (
              <>
                <span className="row wrap" style={{ gap: "6px 8px" }}>
                  <span className="badge badge-success">
                    <i className="ic ic-shield" aria-hidden="true" />
                    감사 체인 검증됨
                  </span>
                  {v.anchorOk ? (
                    <>
                      <span className="badge badge-success">
                        <i className="ic ic-check" aria-hidden="true" />
                        공개 앵커 #1284 완료
                      </span>
                    </>
                  ) : null}
                  {v.anchorWait ? (
                    <>
                      <span className="badge badge-warning">
                        <i className="ic ic-clock" aria-hidden="true" />
                        공개 앵커 #1285 확정 대기
                      </span>
                    </>
                  ) : null}
                  {v.anchorLate ? (
                    <>
                      <span className="badge badge-warning">
                        <i className="ic ic-clock" aria-hidden="true" />
                        공개 앵커 #1284 · 게시 밀림
                      </span>
                    </>
                  ) : null}
                  <span className="t-xs muted">11:00 UTC 검증(1시간마다) · 앵커 5분마다, 마지막 11:40 UTC · 그 뒤 기록은 다음 앵커 때부터 검증</span>
                </span>
              </>
            ) : null}
            {' '}
            {v.isTamper ? (
              <>
                <span className="row wrap" style={{ gap: "6px 8px" }}>
                  <span className="badge badge-danger">
                    <i className="ic ic-alert" aria-hidden="true" />
                    감사 체인 검증 실패
                  </span>
                  <span className="t-xs muted">11:00 UTC 검증 · seq 1,204,361~1,204,363 불일치</span>
                </span>
              </>
            ) : null}
          </div>
          {v.hasRows ? (
            <>
              <ol className="col" style={{ gap: "8px" }} aria-label="감사 기록 13건, 시각 오름차순">
                <li>
                  <button className="card" type="button" aria-expanded="false" style={{ display: "flex", flexDirection: "column", gap: "4px", width: "100%", padding: "10px 12px", borderRadius: "var(--r-lg)", textAlign: "left", cursor: "pointer" }}>
                    <span className="row between" style={{ gap: "8px", width: "100%" }}>
                      <span className="row" style={{ gap: "6px", minWidth: "0" }}>
                        <span className="mono t-sm">10:50:00</span>
                        <span className="badge badge-inverse">시스템</span>
                        <span className="t-xs muted ellipsis">만료 처리</span>
                      </span>
                      <span className="badge">자동 만료</span>
                    </span>
                    {' '}
                    <span className="row between" style={{ gap: "8px", width: "100%", alignItems: "flex-start" }}>
                      <span className="t-sm fw-b">명령 8 로그 레벨 자동 복귀</span>
                      <i className="ic ic-chevron-down ic-16 muted" aria-hidden="true" style={{ marginTop: "2px" }} />
                    </span>
                    {' '}
                    <span className="t-xs muted">
                      대상{' '}
                      <span className="mono">queue-svc</span>
                    </span>
                  </button>
                </li>
                <li>
                  <button className="card" type="button" aria-expanded="false" style={{ display: "flex", flexDirection: "column", gap: "4px", width: "100%", padding: "10px 12px", borderRadius: "var(--r-lg)", textAlign: "left", cursor: "pointer" }}>
                    <span className="row between" style={{ gap: "8px", width: "100%" }}>
                      <span className="row" style={{ gap: "6px", minWidth: "0" }}>
                        <span className="mono t-sm">10:52:10</span>
                        <span className="badge badge-outline">사람</span>
                        <span className="t-xs muted ellipsis">민호 · operator</span>
                      </span>
                      <span className="badge badge-success">acked 2/2</span>
                    </span>
                    {' '}
                    <span className="row between" style={{ gap: "8px", width: "100%", alignItems: "flex-start" }}>
                      <span className="t-sm fw-b">명령 7 대기실 공지 배너</span>
                      <i className="ic ic-chevron-down ic-16 muted" aria-hidden="true" style={{ marginTop: "2px" }} />
                    </span>
                    {' '}
                    <span className="row between" style={{ gap: "8px", width: "100%" }}>
                      <span className="t-xs muted">대상 10/25(일) 18:00 회차</span>
                      {v.isTamper ? (
                        <>
                          <span className="badge badge-danger">체인 불일치</span>
                        </>
                      ) : null}
                    </span>
                  </button>
                </li>
                <li>
                  <button className="card" type="button" aria-expanded="false" style={{ display: "flex", flexDirection: "column", gap: "4px", width: "100%", padding: "10px 12px", borderRadius: "var(--r-lg)", textAlign: "left", cursor: "pointer" }}>
                    <span className="row between" style={{ gap: "8px", width: "100%" }}>
                      <span className="row" style={{ gap: "6px", minWidth: "0" }}>
                        <span className="mono t-sm">10:57:52</span>
                        <span className="badge badge-outline">사람</span>
                        <span className="t-xs muted ellipsis">민호 · operator</span>
                      </span>
                      <span className="badge badge-success">acked 1/1</span>
                    </span>
                    {' '}
                    <span className="row between" style={{ gap: "8px", width: "100%", alignItems: "flex-start" }}>
                      <span className="t-sm fw-b">명령 4 ASN·IP 대역 차단</span>
                      <i className="ic ic-chevron-down ic-16 muted" aria-hidden="true" style={{ marginTop: "2px" }} />
                    </span>
                    {' '}
                    <span className="row between" style={{ gap: "8px", width: "100%" }}>
                      <span className="t-xs muted">
                        대상{' '}
                        <span className="mono">203.0.113.0/24 · 30분</span>
                      </span>
                      {v.isTamper ? (
                        <>
                          <span className="badge badge-danger">체인 불일치</span>
                        </>
                      ) : null}
                    </span>
                  </button>
                </li>
                <li>
                  <button className="card" type="button" aria-expanded="false" style={{ display: "flex", flexDirection: "column", gap: "4px", width: "100%", padding: "10px 12px", borderRadius: "var(--r-lg)", textAlign: "left", cursor: "pointer" }}>
                    <span className="row between" style={{ gap: "8px", width: "100%" }}>
                      <span className="row" style={{ gap: "6px", minWidth: "0" }}>
                        <span className="mono t-sm">10:58:30</span>
                        <span className="badge badge-outline">사람</span>
                        <span className="t-xs muted ellipsis">민호 · operator</span>
                      </span>
                      <span className="badge">되돌림</span>
                    </span>
                    {' '}
                    <span className="row between" style={{ gap: "8px", width: "100%", alignItems: "flex-start" }}>
                      <span className="t-sm fw-b">명령 7 되돌리기(공지 내리기)</span>
                      <i className="ic ic-chevron-down ic-16 muted" aria-hidden="true" style={{ marginTop: "2px" }} />
                    </span>
                    {' '}
                    <span className="row between" style={{ gap: "8px", width: "100%" }}>
                      <span className="t-xs muted">대상 10/25(일) 18:00 회차</span>
                      {v.isTamper ? (
                        <>
                          <span className="badge badge-danger">체인 불일치</span>
                        </>
                      ) : null}
                    </span>
                  </button>
                </li>
                <li>
                  <button className="card" type="button" aria-expanded="false" style={{ display: "flex", flexDirection: "column", gap: "4px", width: "100%", padding: "10px 12px", borderRadius: "var(--r-lg)", textAlign: "left", cursor: "pointer" }}>
                    <span className="row between" style={{ gap: "8px", width: "100%" }}>
                      <span className="row" style={{ gap: "6px", minWidth: "0" }}>
                        <span className="mono t-sm">11:02:24</span>
                        <span className="badge badge-outline">사람</span>
                        <span className="t-xs muted ellipsis">민호 · operator</span>
                      </span>
                      <span className="badge badge-success">acked 1/1</span>
                    </span>
                    {' '}
                    <span className="row between" style={{ gap: "8px", width: "100%", alignItems: "flex-start" }}>
                      <span className="t-sm fw-b">명령 1 동시 입장 목표 조정</span>
                      <i className="ic ic-chevron-down ic-16 muted" aria-hidden="true" style={{ marginTop: "2px" }} />
                    </span>
                    {' '}
                    <span className="t-xs muted">대상 10/25 18:00 · 5,000 → 1,000명</span>
                  </button>
                </li>
                <li>
                  <button className="card" type="button" aria-expanded="false" style={{ display: "flex", flexDirection: "column", gap: "4px", width: "100%", padding: "10px 12px", borderRadius: "var(--r-lg)", textAlign: "left", cursor: "pointer" }}>
                    <span className="row between" style={{ gap: "8px", width: "100%" }}>
                      <span className="row" style={{ gap: "6px", minWidth: "0" }}>
                        <span className="mono t-sm">11:02:24</span>
                        <span className="badge badge-inverse">시스템</span>
                        <span className="t-xs muted ellipsis">자동 제어</span>
                      </span>
                      <span className="badge badge-success">적용</span>
                    </span>
                    {' '}
                    <span className="row between" style={{ gap: "8px", width: "100%", alignItems: "flex-start" }}>
                      <span className="t-sm fw-b">자동 조절(AIMD) 15분 정지</span>
                      <i className="ic ic-chevron-down ic-16 muted" aria-hidden="true" style={{ marginTop: "2px" }} />
                    </span>
                    {' '}
                    <span className="t-xs muted">대상 10/25(일) 18:00 회차</span>
                  </button>
                </li>
                <li>
                  <button className="card" type="button" aria-expanded="false" style={{ display: "flex", flexDirection: "column", gap: "4px", width: "100%", padding: "10px 12px", borderRadius: "var(--r-lg)", textAlign: "left", cursor: "pointer" }}>
                    <span className="row between" style={{ gap: "8px", width: "100%" }}>
                      <span className="row" style={{ gap: "6px", minWidth: "0" }}>
                        <span className="mono t-sm">11:03:20</span>
                        <span className="badge badge-outline">사람</span>
                        <span className="t-xs muted ellipsis">민호 · operator</span>
                      </span>
                      <span className="badge badge-success">acked 1/1</span>
                    </span>
                    {' '}
                    <span className="row between" style={{ gap: "8px", width: "100%", alignItems: "flex-start" }}>
                      <span className="t-sm fw-b">명령 4 ASN·IP 대역 차단(2인)</span>
                      <i className="ic ic-chevron-down ic-16 muted" aria-hidden="true" style={{ marginTop: "2px" }} />
                    </span>
                    {' '}
                    <span className="t-xs muted">
                      대상{' '}
                      <span className="mono">AS64500 · 60분</span>
                    </span>
                  </button>
                </li>
                <li className="card is-selected" style={{ display: "flex", flexDirection: "column", borderRadius: "var(--r-lg)", overflow: "hidden" }}>
                  <button type="button" aria-expanded="true" aria-controls="rec-d" style={{ display: "flex", flexDirection: "column", gap: "4px", width: "100%", padding: "10px 12px", border: "0", background: "var(--primary-subtle)", textAlign: "left", cursor: "pointer" }}>
                    <span className="row between" style={{ gap: "8px", width: "100%" }}>
                      <span className="row" style={{ gap: "6px", minWidth: "0" }}>
                        <span className="mono t-sm">11:03:53</span>
                        <span className="badge badge-outline">사람</span>
                        <span className="t-xs muted ellipsis">수진 · commander</span>
                      </span>
                      <span className="badge badge-success">acked 3/3</span>
                    </span>
                    {' '}
                    <span className="row between" style={{ gap: "8px", width: "100%", alignItems: "flex-start" }}>
                      <span className="t-sm fw-b">명령 3 판매 일시정지(킬스위치)</span>
                      <i className="ic ic-chevron-up ic-16 muted" aria-hidden="true" style={{ marginTop: "2px" }} />
                    </span>
                    {' '}
                    <span className="t-xs muted">대상 10/25(일) 18:00 · 범위 회차</span>
                  </button>
                  <div className="col" id="rec-d" style={{ gap: "10px", padding: "12px 12px 14px" }}>
                    <dl className="col" style={{ gap: "10px" }}>
                      <div className="col" style={{ gap: "2px" }}>
                        <dt className="t-xs fw-b muted">승인자</dt>
                        <dd className="t-sm muted">—(commander 1인 실행)</dd>
                      </div>
                      <div className="col" style={{ gap: "2px" }}>
                        <dt className="t-xs fw-b muted">사유 전문</dt>
                        <dd className="t-sm">결제사 승인 응답이 늦어 결과 불명 주문이 늘고 있습니다. 원인을 확인하는 동안 10/25(일) 18:00 회차의 새 좌석 홀드와 결제 접수를 멈춥니다. 처리 중 결제는 완결합니다.</dd>
                      </div>
                      <div className="col" style={{ gap: "2px" }}>
                        <dt className="t-xs fw-b muted">dry-run 결과 전문</dt>
                        <dd className="t-sm">
                          적용 대상 purchase-svc 전체 파드 3개(제어 전용 gRPC) · 범위 10/25(일) 18:00 회차 · 진행 중 결제 세션 312건(이미 접수된 결제는 완결) · 새 좌석 홀드 초당 약 52건 → 0건 · 새 결제 접수 초당 약 11건 → 0건 · 대기 순서 유지
                        </dd>
                      </div>
                      <div className="col" style={{ gap: "2px" }}>
                        <dt className="t-xs fw-b muted">실행·전파</dt>
                        <dd className="t-sm">실행자 재인증 11:03:49 · 실행 11:03:53(1인) · ack purchase-svc-1 0.6초, purchase-svc-2 1.1초, purchase-svc-3 1.9초</dd>
                      </div>
                      <div className="col" style={{ gap: "2px" }}>
                        <dt className="t-xs fw-b muted">명령 ID</dt>
                        <dd className="hash">01929f3c-7a1e-7b42-9c3d-6e2a8f4b1d05</dd>
                      </div>
                      <div className="col" style={{ gap: "2px" }}>
                        <dt className="t-xs fw-b muted">감사 체인</dt>
                        <dd className="t-xs">
                          seq{' '}
                          <span className="mono">1,204,377</span>
                          {' '}· mac 확인됨 · 앵커 11:05 UTC
                        </dd>
                      </div>
                    </dl>
                    <p className="t-xs muted">검증 묶음 내보내기(분쟁 당사자 제공용, 사유 필수)는 태블릿이나 데스크톱에서 합니다</p>
                  </div>
                </li>
                <li>
                  <button className="card" type="button" aria-expanded="false" style={{ display: "flex", flexDirection: "column", gap: "4px", width: "100%", padding: "10px 12px", borderRadius: "var(--r-lg)", textAlign: "left", cursor: "pointer" }}>
                    <span className="row between" style={{ gap: "8px", width: "100%" }}>
                      <span className="row" style={{ gap: "6px", minWidth: "0" }}>
                        <span className="mono t-sm">11:09:31</span>
                        <span className="badge badge-outline">사람</span>
                        <span className="t-xs muted ellipsis">다은 · cs_agent</span>
                      </span>
                      <span className="badge badge-outline">열람 기록</span>
                    </span>
                    {' '}
                    <span className="row between" style={{ gap: "8px", width: "100%", alignItems: "flex-start" }}>
                      <span className="t-sm fw-b">결제자 연락처 열람</span>
                      <i className="ic ic-chevron-down ic-16 muted" aria-hidden="true" style={{ marginTop: "2px" }} />
                    </span>
                    {' '}
                    <span className="t-xs muted">
                      대상{' '}
                      <span className="mono">주문 018f2c7a-…</span>
                    </span>
                  </button>
                </li>
                <li>
                  <button className="card" type="button" aria-expanded="false" style={{ display: "flex", flexDirection: "column", gap: "4px", width: "100%", padding: "10px 12px", borderRadius: "var(--r-lg)", textAlign: "left", cursor: "pointer" }}>
                    <span className="row between" style={{ gap: "8px", width: "100%" }}>
                      <span className="row" style={{ gap: "6px", minWidth: "0" }}>
                        <span className="mono t-sm">11:12:40</span>
                        <span className="badge badge-outline">사람</span>
                        <span className="t-xs muted ellipsis">수진 · commander</span>
                      </span>
                      <span className="badge">되돌림</span>
                    </span>
                    {' '}
                    <span className="row between" style={{ gap: "8px", width: "100%", alignItems: "flex-start" }}>
                      <span className="t-sm fw-b">명령 3 되돌리기(판매 재개, 2인)</span>
                      <i className="ic ic-chevron-down ic-16 muted" aria-hidden="true" style={{ marginTop: "2px" }} />
                    </span>
                    {' '}
                    <span className="t-xs muted">대상 10/25(일) 18:00 회차</span>
                  </button>
                </li>
                <li>
                  <button className="card" type="button" aria-expanded="false" style={{ display: "flex", flexDirection: "column", gap: "4px", width: "100%", padding: "10px 12px", borderRadius: "var(--r-lg)", textAlign: "left", cursor: "pointer" }}>
                    <span className="row between" style={{ gap: "8px", width: "100%" }}>
                      <span className="row" style={{ gap: "6px", minWidth: "0" }}>
                        <span className="mono t-sm">11:17:24</span>
                        <span className="badge badge-inverse">시스템</span>
                        <span className="t-xs muted ellipsis">자동 제어</span>
                      </span>
                      <span className="badge badge-warning">확인 대기</span>
                    </span>
                    {' '}
                    <span className="row between" style={{ gap: "8px", width: "100%", alignItems: "flex-start" }}>
                      <span className="t-sm fw-b">자동 조절 15분 정지 끝</span>
                      <i className="ic ic-chevron-down ic-16 muted" aria-hidden="true" style={{ marginTop: "2px" }} />
                    </span>
                    {' '}
                    <span className="t-xs muted">대상 10/25(일) 18:00 회차</span>
                  </button>
                </li>
                <li>
                  <button className="card" type="button" aria-expanded="false" style={{ display: "flex", flexDirection: "column", gap: "4px", width: "100%", padding: "10px 12px", borderRadius: "var(--r-lg)", textAlign: "left", cursor: "pointer" }}>
                    <span className="row between" style={{ gap: "8px", width: "100%" }}>
                      <span className="row" style={{ gap: "6px", minWidth: "0" }}>
                        <span className="mono t-sm">11:18:02</span>
                        <span className="badge badge-outline">사람</span>
                        <span className="t-xs muted ellipsis">민호 · operator</span>
                      </span>
                      <span className="badge badge-success">적용</span>
                    </span>
                    {' '}
                    <span className="row between" style={{ gap: "8px", width: "100%", alignItems: "flex-start" }}>
                      <span className="t-sm fw-b">자동 조절 복귀 확인</span>
                      <i className="ic ic-chevron-down ic-16 muted" aria-hidden="true" style={{ marginTop: "2px" }} />
                    </span>
                    {' '}
                    <span className="t-xs muted">대상 10/25(일) 18:00 회차</span>
                  </button>
                </li>
                <li>
                  <button className="card" type="button" aria-expanded="false" style={{ display: "flex", flexDirection: "column", gap: "4px", width: "100%", padding: "10px 12px", borderRadius: "var(--r-lg)", textAlign: "left", cursor: "pointer" }}>
                    <span className="row between" style={{ gap: "8px", width: "100%" }}>
                      <span className="row" style={{ gap: "6px", minWidth: "0" }}>
                        <span className="mono t-sm">11:27:52</span>
                        <span className="badge badge-inverse">시스템</span>
                        <span className="t-xs muted ellipsis">만료 처리</span>
                      </span>
                      <span className="badge">자동 만료</span>
                    </span>
                    {' '}
                    <span className="row between" style={{ gap: "8px", width: "100%", alignItems: "flex-start" }}>
                      <span className="t-sm fw-b">명령 4 자동 만료</span>
                      <i className="ic ic-chevron-down ic-16 muted" aria-hidden="true" style={{ marginTop: "2px" }} />
                    </span>
                    {' '}
                    <span className="t-xs muted">
                      대상{' '}
                      <span className="mono">203.0.113.0/24</span>
                    </span>
                  </button>
                </li>
              </ol>
            </>
          ) : null}
          {' '}
          {v.isEmpty ? (
            <>
              <div className="card">
                <div className="state" style={{ padding: "32px 20px" }}>
                  <span className="state-icon"><i className="ic ic-history" aria-hidden="true" /></span>
                  <h2 className="t-lg">이 기간에 기록이 없습니다</h2>
                  <p className="t-sm muted">2026-10-14 03:00~03:30 UTC에 런북 CLI로 남은 기록이 없습니다. 기간을 넓히거나 행위자 조건을 바꿔 보세요.</p>
                  <button className="btn btn-secondary" type="button" style={{ height: "44px" }}>기간을 오늘 전체로 넓힙니다</button>
                </div>
              </div>
            </>
          ) : null}
          {' '}
          {v.hasRows ? (
            <>
              <section className="widget" aria-labelledby="rp-t">
                <div className="widget-head">
                  <h2 id="rp-t" style={{ fontSize: "13px", lineHeight: "18px" }}>인시던트 리플레이</h2>
                  <div className="actions"><span className="badge badge-warning">SEV2 결제 확정 임박(승인 호출 p99 2초 초과)</span></div>
                </div>
                <div className="widget-body" style={{ gap: "12px" }}>
                  <p className="t-xs muted">10/14 11:00~11:20 UTC</p>
                  <div className="banner banner-info bigscreen" role="note">
                    <i className="ic ic-monitor" aria-hidden="true" />
                    <div className="banner-body" style={{ flexBasis: "200px" }}>
                      <span className="banner-title">리플레이 재생은 태블릿이나 데스크톱에서 합니다</span>
                      휴대폰에서는 볼 수만 있습니다
                    </div>
                    <button className="btn btn-outline btn-sm" type="button">
                      <i className="ic ic-copy" aria-hidden="true" />
                      링크 복사
                    </button>
                  </div>
                  <ol className="col" aria-label="리플레이 이벤트" style={{ gap: "10px" }}>
                    <li className="row" style={{ gap: "8px", alignItems: "flex-start" }}>
                      <span className="badge badge-danger num" style={{ minWidth: "22px", justifyContent: "center" }} aria-hidden="true">1</span>
                      <span className="col" style={{ gap: "1px" }}>
                        <span className="t-xs muted mono">11:01:40 · 장애 발생</span>
                        <span className="t-sm">결제 확정 소요 p99가 5초를 넘음(승인 호출 p99가 2초를 넘기 시작)</span>
                      </span>
                    </li>
                    <li className="row" style={{ gap: "8px", alignItems: "flex-start" }}>
                      <span className="badge badge-warning num" style={{ minWidth: "22px", justifyContent: "center" }} aria-hidden="true">2</span>
                      <span className="col" style={{ gap: "1px" }}>
                        <span className="t-xs muted mono">11:02:10 · 경보</span>
                        <span className="t-sm">SEV2 결제 확정 임박(승인 호출 p99 2초 초과)</span>
                      </span>
                    </li>
                    <li className="row" style={{ gap: "8px", alignItems: "flex-start" }}>
                      <span className="badge badge-primary num" style={{ minWidth: "22px", justifyContent: "center" }} aria-hidden="true">3</span>
                      <span className="col" style={{ gap: "1px" }}>
                        <span className="t-xs muted mono">11:02:24 · 명령</span>
                        <span className="t-sm">명령 1 목표 5,000 → 1,000명(민호)</span>
                      </span>
                    </li>
                    <li className="row" style={{ gap: "8px", alignItems: "flex-start" }}>
                      <span className="badge badge-primary num" style={{ minWidth: "22px", justifyContent: "center" }} aria-hidden="true">4</span>
                      <span className="col" style={{ gap: "1px" }}>
                        <span className="t-xs muted mono">11:03:53 · 명령</span>
                        <span className="t-sm">명령 3 판매 일시정지 실행(수진, 1인·재인증) · 전파 ack 3/3(11:03:55)</span>
                      </span>
                    </li>
                    <li className="row" style={{ gap: "8px", alignItems: "flex-start" }}>
                      <span className="badge badge-success num" style={{ minWidth: "22px", justifyContent: "center" }} aria-hidden="true">5</span>
                      <span className="col" style={{ gap: "1px" }}>
                        <span className="t-xs muted mono">11:10:30 · 지표 복구</span>
                        <span className="t-sm">결제 확정 소요 p99가 2초 아래로</span>
                      </span>
                    </li>
                    <li className="row" style={{ gap: "8px", alignItems: "flex-start" }}>
                      <span className="badge badge-primary num" style={{ minWidth: "22px", justifyContent: "center" }} aria-hidden="true">6</span>
                      <span className="col" style={{ gap: "1px" }}>
                        <span className="t-xs muted mono">11:13:05 · 명령</span>
                        <span className="t-sm">명령 3 되돌리기 · 판매 재개 ack 3/3</span>
                      </span>
                    </li>
                    <li className="row" style={{ gap: "8px", alignItems: "flex-start" }}>
                      <span className="badge badge-primary num" style={{ minWidth: "22px", justifyContent: "center" }} aria-hidden="true">7</span>
                      <span className="col" style={{ gap: "1px" }}>
                        <span className="t-xs muted mono">11:18:02 · 명령</span>
                        <span className="t-sm">자동 조절 복귀 확인(민호)</span>
                      </span>
                    </li>
                  </ol>
                  <a href="https://grafana.ops.peaket.example/d/onsale" target="_blank" rel="noreferrer" className="link-more" style={{ fontSize: "13px" }}>
                    Grafana에서 같은 구간 보기
                    <i className="ic ic-external" aria-hidden="true" />
                  </a>
                </div>
              </section>
            </>
          ) : null}
          {' '}
          {v.isEmpty ? (
            <>
              <section className="widget" aria-labelledby="rp0-t">
                <div className="widget-head"><h2 id="rp0-t" style={{ fontSize: "13px", lineHeight: "18px" }}>인시던트 리플레이</h2></div>
                <div className="widget-body"><p className="t-sm muted">재생할 기록이 없습니다. 기록이 있는 기간을 고르면 경보·명령·지표를 같은 시간축으로 재생합니다.</p></div>
              </section>
            </>
          ) : null}
        </div>
      </>
    ) : null}
    {' '}
    {v.isDl ? (
      <>
        <div className="col" role="tabpanel" aria-labelledby="tb-dl" style={{ gap: "12px" }}>
          <form className="col" role="search" aria-label="명단 다운로드 기록 찾기" style={{ gap: "10px" }} onSubmit={prevent}>
            <div className="field">
              <label className="label" htmlFor="d-period">기간(UTC)</label>
              <div className="input-group">
                <i className="ic ic-calendar ic-16" aria-hidden="true" />
                <input id="d-period" type="text" defaultValue="2026-10-08 ~ 2026-10-14" />
              </div>
            </div>
            <div className="field">
              <label className="label" htmlFor="d-account">계정</label>
              <div className="input-group">
                <select id="d-account" defaultValue="전체">
                  <option>전체</option>
                  <option>파트너 관리자 · (주)스텔라엔터테인먼트</option>
                </select>
                <i className="ic ic-chevron-down ic-16" aria-hidden="true" />
              </div>
            </div>
            <div className="field">
              <label className="label" htmlFor="d-event">공연</label>
              <div className="input-group">
                <select id="d-event" defaultValue="전체">
                  <option>전체</option>
                  <option>LUMEN 콘서트 2026 서울</option>
                  <option>가을 야외 페스티벌</option>
                  <option>소극장 뮤지컬</option>
                  <option>팬미팅</option>
                </select>
                <i className="ic ic-chevron-down ic-16" aria-hidden="true" />
              </div>
            </div>
            <button className="btn btn-secondary btn-block" type="submit" style={{ height: "44px" }}>조건으로 찾기</button>
          </form>
          <span className="t-xs muted">4건 · 일시 내림차순</span>
          <ul className="col" style={{ gap: "8px" }} aria-label="명단 다운로드 기록 4건, 일시 내림차순">
            <li className="card" style={{ display: "flex", flexDirection: "column", gap: "8px", padding: "12px 14px", borderRadius: "var(--r-lg)" }}>
              <span className="row between" style={{ gap: "8px" }}>
                <span className="mono t-sm">2026-10-14 07:12:40</span>
                <span className="badge badge-warning">24시간에 3회</span>
              </span>
              {' '}
              <span className="t-sm fw-b">가을 야외 페스티벌 · 11/7(토)</span>
              <dl className="kv" style={{ fontSize: "13px", lineHeight: "18px", gap: "4px 12px" }}>
                <dt>계정</dt>
                <dd>파트너 관리자 · (주)스텔라엔터테인먼트</dd>
                <dt>사유</dt>
                <dd>현장 입장 동선 준비</dd>
                <dt>건수</dt>
                <dd>1,180</dd>
                <dt>형식</dt>
                <dd>CSV</dd>
              </dl>
            </li>
            <li className="card" style={{ display: "flex", flexDirection: "column", gap: "8px", padding: "12px 14px", borderRadius: "var(--r-lg)" }}>
              <span className="row between" style={{ gap: "8px" }}>
                <span className="mono t-sm">2026-10-14 02:40:11</span>
                <span className="badge badge-warning">24시간에 3회</span>
              </span>
              {' '}
              <span className="t-sm fw-b">가을 야외 페스티벌 · 11/7(토)</span>
              <dl className="kv" style={{ fontSize: "13px", lineHeight: "18px", gap: "4px 12px" }}>
                <dt>계정</dt>
                <dd>파트너 관리자 · (주)스텔라엔터테인먼트</dd>
                <dt>사유</dt>
                <dd>명단 재확인</dd>
                <dt>건수</dt>
                <dd>1,180</dd>
                <dt>형식</dt>
                <dd>XLSX</dd>
              </dl>
            </li>
            <li className="card" style={{ display: "flex", flexDirection: "column", gap: "8px", padding: "12px 14px", borderRadius: "var(--r-lg)" }}>
              <span className="row between" style={{ gap: "8px" }}>
                <span className="mono t-sm">2026-10-13 14:05:52</span>
                <span className="badge badge-warning">24시간에 3회</span>
              </span>
              {' '}
              <span className="t-sm fw-b">가을 야외 페스티벌 · 11/7(토)</span>
              <dl className="kv" style={{ fontSize: "13px", lineHeight: "18px", gap: "4px 12px" }}>
                <dt>계정</dt>
                <dd>파트너 관리자 · (주)스텔라엔터테인먼트</dd>
                <dt>사유</dt>
                <dd>현장 운영 인원 배치</dd>
                <dt>건수</dt>
                <dd>1,180</dd>
                <dt>형식</dt>
                <dd>CSV</dd>
              </dl>
            </li>
            <li className="card" style={{ display: "flex", flexDirection: "column", gap: "8px", padding: "12px 14px", borderRadius: "var(--r-lg)" }}>
              <span className="row between" style={{ gap: "8px" }}>
                <span className="mono t-sm">2026-10-09 06:20:31</span>
                <span className="t-xs muted">점검 —</span>
              </span>
              {' '}
              <span className="t-sm fw-b">소극장 뮤지컬 · 회차 3개</span>
              <dl className="kv" style={{ fontSize: "13px", lineHeight: "18px", gap: "4px 12px" }}>
                <dt>계정</dt>
                <dd>파트너 관리자 · (주)스텔라엔터테인먼트</dd>
                <dt>사유</dt>
                <dd>현장 명단 준비</dd>
                <dt>건수</dt>
                <dd>860</dd>
                <dt>형식</dt>
                <dd>CSV</dd>
              </dl>
            </li>
          </ul>
          <p className="t-xs muted">명단을 내려받을 때 적은 사유와 건수는 접속기록에 남습니다. 같은 명단을 24시간에 3회 이상 내려받으면 법정 조치의 접속기록 점검 목록에 올라갑니다(기준 값은 내부 관리계획에서 확정합니다).</p>
        </div>
      </>
    ) : null}
    </>
  );
}

