// 디자인 캔버스 보드 SCR-031-t.dc.html를 옮긴 것(dc2tsx 생성 뒤 손질)
/* eslint-disable */
import { Fragment, type FormEvent } from 'react';
import { Link } from 'react-router';
import { Overlay } from '@/shared/ui/Overlay';

const prevent = (e: FormEvent) => e.preventDefault();
void Fragment;
void Link;

type AriaBool = boolean | 'true' | 'false';
type AriaCurrent = boolean | 'true' | 'false' | 'page' | 'step' | 'location' | 'date' | 'time';

export const STATES_T = ["기본", "재생 중", "빈 결과", "명단 다운로드 기록", "체인 변조", "공개 타임스탬프 대기", "공개 앵커 지연"] as const;
export const DEFAULT_T = "기본";

export function valsT(state: string) {
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
      hasRows: !empty,
      showReplay: !empty,
      isPlaying: st === '재생 중',
      isPaused: st === '기본' || tamper || aWait || aLate
    };
  }

type V = ReturnType<typeof valsT>;

// 보드 루트: {"class": "pk dark cs cs-compact is-tab", "style": "width:768px;min-height:1950px"}

// <main class="cs-main" id="main">
export function MainT({ v, close, go }: { v: V; close?: () => void; go?: (state: string) => void }) {
  void v; void close; void go;
  return (
    <>
    <div className="page-head">
      <div className="col" style={{ gap: "4px", maxWidth: "820px" }}>
        <h1>감사 로그·인시던트 리플레이</h1>
        <p className="t-sm muted">운영 명령, 자동 조치, 개인정보 열람 기록을 보고 경보·명령·지표를 같은 시간축에서 다시 재생합니다. 기록 시각은 UTC이고, 팬 관련 대상은 가명 참조값만 보입니다.</p>
      </div>
      <div className="row" style={{ gap: "10px" }}>
        <span className="t-xs muted" id="exp-h">규제 기관 제출용 · 사유 필수 · 접속기록에 남습니다</span>
        {' '}
        <button className="btn btn-outline btn-sm" type="button" aria-describedby="exp-h">
          <i className="ic ic-download" aria-hidden="true" />
          원본 로그 내보내기
        </button>
      </div>
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
              <form className="toolbar" role="search" aria-label="감사 기록 찾기" style={{ alignItems: "flex-end", gap: "12px" }} onSubmit={prevent}>
                <div className="field" style={{ flex: "1 1 240px" }}>
                  <label className="label" htmlFor="f-period">기간(UTC)</label>
                  <div className="input-group input-group-sm">
                    <i className="ic ic-calendar ic-16" aria-hidden="true" />
                    <input id="f-period" type="text" defaultValue="2026-10-14 10:50 ~ 11:40" />
                  </div>
                </div>
                <div className="field" style={{ width: "150px" }}>
                  <label className="label" htmlFor="f-actor">행위자</label>
                  <div className="input-group input-group-sm">
                    <select id="f-actor" defaultValue="전체">
                      <option>전체</option>
                      <option>사람</option>
                      <option>시스템</option>
                      <option>런북 CLI</option>
                    </select>
                    <i className="ic ic-chevron-down ic-16" aria-hidden="true" />
                  </div>
                </div>
                <div className="field" style={{ width: "200px" }}>
                  <label className="label" htmlFor="f-kind">종류</label>
                  <div className="input-group input-group-sm">
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
                <div className="field" style={{ flex: "1 1 320px" }}>
                  <label className="label" htmlFor="f-target">대상</label>
                  <div className="input-group input-group-sm">
                    <i className="ic ic-search ic-16" aria-hidden="true" />
                    <input id="f-target" type="search" placeholder="주문 ID, 좌석 ID, 명령 ID로 찾기" />
                  </div>
                </div>
                <button className="btn btn-secondary" type="submit">조건으로 찾기</button>
              </form>
            </>
          ) : null}
          {' '}
          {v.isEmpty ? (
            <>
              <form className="toolbar" role="search" aria-label="감사 기록 찾기" style={{ alignItems: "flex-end", gap: "12px" }} onSubmit={prevent}>
                <div className="field" style={{ flex: "1 1 240px" }}>
                  <label className="label" htmlFor="f-period0">기간(UTC)</label>
                  <div className="input-group input-group-sm">
                    <i className="ic ic-calendar ic-16" aria-hidden="true" />
                    <input id="f-period0" type="text" defaultValue="2026-10-14 03:00 ~ 03:30" />
                  </div>
                </div>
                <div className="field" style={{ width: "150px" }}>
                  <label className="label" htmlFor="f-actor0">행위자</label>
                  <div className="input-group input-group-sm">
                    <select id="f-actor0" defaultValue="런북 CLI">
                      <option>전체</option>
                      <option>사람</option>
                      <option>시스템</option>
                      <option>런북 CLI</option>
                    </select>
                    <i className="ic ic-chevron-down ic-16" aria-hidden="true" />
                  </div>
                </div>
                <div className="field" style={{ width: "200px" }}>
                  <label className="label" htmlFor="f-kind0">종류</label>
                  <div className="input-group input-group-sm">
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
                <div className="field" style={{ flex: "1 1 320px" }}>
                  <label className="label" htmlFor="f-target0">대상</label>
                  <div className="input-group input-group-sm">
                    <i className="ic ic-search ic-16" aria-hidden="true" />
                    <input id="f-target0" type="search" placeholder="주문 ID, 좌석 ID, 명령 ID로 찾기" />
                  </div>
                </div>
                <button className="btn btn-secondary" type="submit">조건으로 찾기</button>
              </form>
            </>
          ) : null}
          <div className="row between wrap" style={{ gap: "8px" }}>
            {v.hasRows ? (
              <>
                <span className="t-xs muted">13건 · 시각 오름차순 · 줄을 누르면 전문을 펼칩니다</span>
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
              <div className="table-wrap table-scroll" style={{ maxHeight: "540px", overflow: "auto" }}>
                <table className="table dense" style={{ tableLayout: "fixed", minWidth: "1100px" }} aria-label="감사 기록 13건, 시각 오름차순">
                  <thead>
                    <tr>
                      <th scope="col" aria-sort="ascending" style={{ width: "80px", position: "sticky", top: "0", zIndex: "1" }}>시각(UTC)</th>
                      <th scope="col" style={{ width: "150px", position: "sticky", top: "0", zIndex: "1" }}>행위자</th>
                      <th scope="col" style={{ width: "180px", position: "sticky", top: "0", zIndex: "1" }}>행위</th>
                      <th scope="col" style={{ width: "140px", position: "sticky", top: "0", zIndex: "1" }}>대상</th>
                      <th scope="col" style={{ position: "sticky", top: "0", zIndex: "1" }}>사유</th>
                      <th scope="col" style={{ width: "100px", position: "sticky", top: "0", zIndex: "1" }}>승인자</th>
                      <th scope="col" style={{ width: "150px", position: "sticky", top: "0", zIndex: "1" }}>dry-run 결과</th>
                      <th scope="col" style={{ width: "110px", position: "sticky", top: "0", zIndex: "1" }}>결과</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td className="mono">10:50:00</td>
                      <td>
                        <span className="row" style={{ gap: "6px" }}>
                          <span className="badge badge-inverse">시스템</span>
                          <span className="t-xs ellipsis">만료 처리</span>
                        </span>
                      </td>
                      <td><span className="ellipsis" style={{ display: "block" }}>명령 8 로그 레벨 자동 복귀</span></td>
                      <td><span className="mono t-xs">queue-svc</span></td>
                      <td><span className="ellipsis muted" style={{ display: "block" }}>30분 만료</span></td>
                      <td className="muted">—</td>
                      <td><span className="ellipsis muted" style={{ display: "block" }}>DEBUG → INFO</span></td>
                      <td><span className="badge">자동 만료</span></td>
                    </tr>
                    <tr>
                      <td className="mono">10:52:10</td>
                      <td>
                        <span className="row" style={{ gap: "6px" }}>
                          <span className="badge badge-outline">사람</span>
                          <span className="t-xs ellipsis">민호 · operator</span>
                        </span>
                      </td>
                      <td><span className="ellipsis" style={{ display: "block" }}>명령 7 대기실 공지 배너</span></td>
                      <td><span className="ellipsis" style={{ display: "block" }}>10/25(일) 18:00 회차</span></td>
                      <td><span className="ellipsis" style={{ display: "block" }}>로비 입장 안내가 늦어 승인된 공지를 띄웁니다</span></td>
                      <td className="muted">1인</td>
                      <td><span className="ellipsis muted" style={{ display: "block" }}>대기실·좌석·결제 화면 상단</span></td>
                      <td>
                        <span className="col" style={{ gap: "3px", alignItems: "flex-start" }}>
                          <span className="badge badge-success">acked 2/2</span>
                          {v.isTamper ? (
                            <>
                              <span className="badge badge-danger">체인 불일치</span>
                            </>
                          ) : null}
                        </span>
                      </td>
                    </tr>
                    <tr>
                      <td className="mono">10:57:52</td>
                      <td>
                        <span className="row" style={{ gap: "6px" }}>
                          <span className="badge badge-outline">사람</span>
                          <span className="t-xs ellipsis">민호 · operator</span>
                        </span>
                      </td>
                      <td><span className="ellipsis" style={{ display: "block" }}>명령 4 ASN·IP 대역 차단</span></td>
                      <td><span className="mono t-xs ellipsis" style={{ display: "block" }}>203.0.113.0/24 · 30분</span></td>
                      <td><span className="ellipsis" style={{ display: "block" }}>로비 진입 요청이 한 대역에 몰리고 봇 판정 점수가 높습니다</span></td>
                      <td className="muted">1인</td>
                      <td><span className="ellipsis muted" style={{ display: "block" }}>최근 5분 이 대역 요청 18,420건</span></td>
                      <td>
                        <span className="col" style={{ gap: "3px", alignItems: "flex-start" }}>
                          <span className="badge badge-success">acked 1/1</span>
                          {v.isTamper ? (
                            <>
                              <span className="badge badge-danger">체인 불일치</span>
                            </>
                          ) : null}
                        </span>
                      </td>
                    </tr>
                    <tr>
                      <td className="mono">10:58:30</td>
                      <td>
                        <span className="row" style={{ gap: "6px" }}>
                          <span className="badge badge-outline">사람</span>
                          <span className="t-xs ellipsis">민호 · operator</span>
                        </span>
                      </td>
                      <td><span className="ellipsis" style={{ display: "block" }}>명령 7 되돌리기(공지 내리기)</span></td>
                      <td><span className="ellipsis" style={{ display: "block" }}>10/25(일) 18:00 회차</span></td>
                      <td><span className="ellipsis" style={{ display: "block" }}>로비 안내가 정상화되어 공지를 내립니다</span></td>
                      <td className="muted">1인</td>
                      <td><span className="ellipsis muted" style={{ display: "block" }}>공지 즉시 내림</span></td>
                      <td>
                        <span className="col" style={{ gap: "3px", alignItems: "flex-start" }}>
                          <span className="badge">되돌림</span>
                          {v.isTamper ? (
                            <>
                              <span className="badge badge-danger">체인 불일치</span>
                            </>
                          ) : null}
                        </span>
                      </td>
                    </tr>
                    <tr>
                      <td className="mono">11:02:24</td>
                      <td>
                        <span className="row" style={{ gap: "6px" }}>
                          <span className="badge badge-outline">사람</span>
                          <span className="t-xs ellipsis">민호 · operator</span>
                        </span>
                      </td>
                      <td><span className="ellipsis" style={{ display: "block" }}>명령 1 동시 입장 목표 조정</span></td>
                      <td><span className="ellipsis" style={{ display: "block" }}>10/25 18:00 · 5,000 → 1,000명</span></td>
                      <td><span className="ellipsis" style={{ display: "block" }}>SEV2 결제 확정 임박(승인 호출 p99 2초 초과). 결제 단계 동시 체류를 줄입니다</span></td>
                      <td className="muted">1인</td>
                      <td><span className="ellipsis muted" style={{ display: "block" }}>serving 초당 41.0 → 32.8명</span></td>
                      <td><span className="badge badge-success">acked 1/1</span></td>
                    </tr>
                    <tr>
                      <td className="mono">11:02:24</td>
                      <td>
                        <span className="row" style={{ gap: "6px" }}>
                          <span className="badge badge-inverse">시스템</span>
                          <span className="t-xs ellipsis">자동 제어</span>
                        </span>
                      </td>
                      <td><span className="ellipsis" style={{ display: "block" }}>자동 조절(AIMD) 15분 정지</span></td>
                      <td><span className="ellipsis" style={{ display: "block" }}>10/25(일) 18:00 회차</span></td>
                      <td><span className="ellipsis muted" style={{ display: "block" }}>운영자가 목표를 정함</span></td>
                      <td className="muted">—</td>
                      <td className="muted">—</td>
                      <td><span className="badge badge-success">적용</span></td>
                    </tr>
                    <tr>
                      <td className="mono">11:03:20</td>
                      <td>
                        <span className="row" style={{ gap: "6px" }}>
                          <span className="badge badge-outline">사람</span>
                          <span className="t-xs ellipsis">민호 · operator</span>
                        </span>
                      </td>
                      <td><span className="ellipsis" style={{ display: "block" }}>명령 4 ASN·IP 대역 차단(2인)</span></td>
                      <td><span className="mono t-xs ellipsis" style={{ display: "block" }}>AS64500 · 60분</span></td>
                      <td><span className="ellipsis" style={{ display: "block" }}>같은 ASN의 다른 대역에서 요청이 다시 몰립니다</span></td>
                      <td><span className="t-xs">수진 11:05:02</span></td>
                      <td><span className="ellipsis muted" style={{ display: "block" }}>최근 5분 이 ASN 요청 41,370건</span></td>
                      <td><span className="badge badge-success">acked 1/1</span></td>
                    </tr>
                    <tr className="is-selected">
                      <td className="mono">11:03:53</td>
                      <td>
                        <span className="row" style={{ gap: "6px" }}>
                          <span className="badge badge-outline">사람</span>
                          <span className="t-xs ellipsis">수진 · commander</span>
                        </span>
                      </td>
                      <td><span className="ellipsis fw-b" style={{ display: "block" }}>명령 3 판매 일시정지(킬스위치)</span></td>
                      <td><span className="ellipsis" style={{ display: "block" }}>10/25(일) 18:00 · 범위 회차</span></td>
                      <td><span className="ellipsis" style={{ display: "block" }}>결제사 승인 응답이 늦어 결과 불명 주문이 늘고 있습니다</span></td>
                      <td className="muted"><span className="t-xs">—(1인)</span></td>
                      <td><span className="ellipsis muted" style={{ display: "block" }}>진행 중 결제 세션 312건 완결</span></td>
                      <td><span className="badge badge-success">acked 3/3</span></td>
                    </tr>
                    <tr className="is-selected">
                      <td colSpan={8} style={{ padding: "12px 14px" }}>
                        <div style={{ display: "grid", gridTemplateColumns: "repeat(2,minmax(0,1fr))", gap: "12px 24px", maxWidth: "690px" }}>
                          <div className="col" style={{ gap: "4px" }}>
                            <span className="t-xs fw-b muted">사유 전문</span>
                            <span className="t-sm">
                              결제사 승인 응답이 늦어 결과 불명 주문이 늘고 있습니다. 원인을 확인하는 동안 10/25(일) 18:00 회차의 새 좌석 홀드와 결제 접수를 멈춥니다. 처리 중 결제는 완결합니다.
                            </span>
                          </div>
                          <div className="col" style={{ gap: "4px" }}>
                            <span className="t-xs fw-b muted">dry-run 결과 전문</span>
                            <span className="t-sm">
                              적용 대상 purchase-svc 전체 파드 3개(제어 전용 gRPC) · 범위 10/25(일) 18:00 회차 · 진행 중 결제 세션 312건(이미 접수된 결제는 완결) · 새 좌석 홀드 초당 약 52건 → 0건 · 새 결제 접수 초당 약 11건 → 0건 · 대기 순서 유지
                            </span>
                          </div>
                          <div className="col" style={{ gap: "4px", gridColumn: "1/-1" }}>
                            <span className="t-xs fw-b muted">실행·전파</span>
                            <span className="t-sm">
                              실행자 재인증 11:03:49 · 실행 11:03:53(1인) · ack purchase-svc-1 0.6초, purchase-svc-2 1.1초, purchase-svc-3 1.9초
                            </span>
                          </div>
                        </div>
                        <div className="row wrap" style={{ gap: "8px 18px", marginTop: "10px", maxWidth: "690px" }}>
                          <span className="t-xs muted">
                            명령 ID{' '}
                            <span className="mono">01929f3c-7a1e-7b42-9c3d-6e2a8f4b1d05</span>
                          </span>
                          {' '}
                          <span className="t-xs muted">
                            감사 체인 seq{' '}
                            <span className="mono">1,204,377</span>
                            {' '}· mac 확인됨 · 앵커 11:05 UTC
                          </span>
                          {' '}
                          <button className="btn btn-ghost btn-sm" type="button">
                            <i className="ic ic-download" aria-hidden="true" />
                            검증 묶음 내보내기
                          </button>
                          <span className="t-xs muted">분쟁 당사자 제공용 · 사유 필수</span>
                          {' '}
                          <a href="#" className="link-more" style={{ fontSize: "12px" }}>
                            이 시각으로 리플레이 옮기기
                            <i className="ic ic-chevron-right" aria-hidden="true" />
                          </a>
                        </div>
                      </td>
                    </tr>
                    <tr>
                      <td className="mono">11:09:31</td>
                      <td>
                        <span className="row" style={{ gap: "6px" }}>
                          <span className="badge badge-outline">사람</span>
                          <span className="t-xs ellipsis">다은 · cs_agent</span>
                        </span>
                      </td>
                      <td><span className="ellipsis" style={{ display: "block" }}>결제자 연락처 열람</span></td>
                      <td><span className="mono t-xs ellipsis" style={{ display: "block" }}>주문 018f2c7a-…</span></td>
                      <td><span className="ellipsis" style={{ display: "block" }}>결제 상태 불명 문의 확인</span></td>
                      <td className="muted">—</td>
                      <td className="muted">—</td>
                      <td><span className="badge badge-outline">열람 기록</span></td>
                    </tr>
                    <tr>
                      <td className="mono">11:12:40</td>
                      <td>
                        <span className="row" style={{ gap: "6px" }}>
                          <span className="badge badge-outline">사람</span>
                          <span className="t-xs ellipsis">수진 · commander</span>
                        </span>
                      </td>
                      <td><span className="ellipsis" style={{ display: "block" }}>명령 3 되돌리기(판매 재개, 2인)</span></td>
                      <td><span className="ellipsis" style={{ display: "block" }}>10/25(일) 18:00 회차</span></td>
                      <td><span className="ellipsis" style={{ display: "block" }}>결제사 승인 지연이 풀려 결제 확정 p99가 기준 안으로 돌아왔습니다</span></td>
                      <td><span className="t-xs">민호 11:13:05</span></td>
                      <td><span className="ellipsis muted" style={{ display: "block" }}>새 홀드와 결제 접수를 다시 받습니다</span></td>
                      <td><span className="badge">되돌림</span></td>
                    </tr>
                    <tr>
                      <td className="mono">11:17:24</td>
                      <td>
                        <span className="row" style={{ gap: "6px" }}>
                          <span className="badge badge-inverse">시스템</span>
                          <span className="t-xs ellipsis">자동 제어</span>
                        </span>
                      </td>
                      <td><span className="ellipsis" style={{ display: "block" }}>자동 조절 15분 정지 끝</span></td>
                      <td><span className="ellipsis" style={{ display: "block" }}>10/25(일) 18:00 회차</span></td>
                      <td><span className="ellipsis muted" style={{ display: "block" }}>15분 지남 · 운영자 확인 필요</span></td>
                      <td className="muted">—</td>
                      <td className="muted">—</td>
                      <td><span className="badge badge-warning">확인 대기</span></td>
                    </tr>
                    <tr>
                      <td className="mono">11:18:02</td>
                      <td>
                        <span className="row" style={{ gap: "6px" }}>
                          <span className="badge badge-outline">사람</span>
                          <span className="t-xs ellipsis">민호 · operator</span>
                        </span>
                      </td>
                      <td><span className="ellipsis" style={{ display: "block" }}>자동 조절 복귀 확인</span></td>
                      <td><span className="ellipsis" style={{ display: "block" }}>10/25(일) 18:00 회차</span></td>
                      <td><span className="ellipsis" style={{ display: "block" }}>목표 1,000명에서 자동 조절로 돌아갑니다</span></td>
                      <td className="muted">—</td>
                      <td className="muted">—</td>
                      <td><span className="badge badge-success">적용</span></td>
                    </tr>
                    <tr>
                      <td className="mono">11:27:52</td>
                      <td>
                        <span className="row" style={{ gap: "6px" }}>
                          <span className="badge badge-inverse">시스템</span>
                          <span className="t-xs ellipsis">만료 처리</span>
                        </span>
                      </td>
                      <td><span className="ellipsis" style={{ display: "block" }}>명령 4 자동 만료</span></td>
                      <td><span className="mono t-xs ellipsis" style={{ display: "block" }}>203.0.113.0/24</span></td>
                      <td><span className="ellipsis muted" style={{ display: "block" }}>30분 만료</span></td>
                      <td className="muted">—</td>
                      <td className="muted">—</td>
                      <td><span className="badge">자동 만료</span></td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </>
          ) : null}
          {' '}
          {v.isEmpty ? (
            <>
              <div className="table-wrap">
                <div className="state">
                  <span className="state-icon"><i className="ic ic-history" aria-hidden="true" /></span>
                  <h2 className="t-lg">이 기간에 기록이 없습니다</h2>
                  <p className="t-sm muted">2026-10-14 03:00~03:30 UTC에 런북 CLI로 남은 기록이 없습니다. 기간을 넓히거나 행위자 조건을 바꿔 보세요.</p>
                  <button className="btn btn-secondary" type="button">기간을 오늘 전체로 넓힙니다</button>
                </div>
              </div>
            </>
          ) : null}
          {' '}
          {v.showReplay ? (
            <>
              <section className="widget" aria-labelledby="rp-t">
                <div className="widget-head" style={{ flexWrap: "wrap" }}>
                  <h2 id="rp-t" style={{ fontSize: "13px", lineHeight: "18px" }}>인시던트 리플레이 · 10/14 11:00~11:20 UTC</h2>
                  <span className="badge badge-warning">SEV2 결제 확정 임박(승인 호출 p99 2초 초과)</span>
                  <div className="actions">
                    <button className="btn btn-ghost btn-sm" type="button">지표를 표로 보기</button>
                    <a href="https://grafana.ops.peaket.example/d/onsale" target="_blank" rel="noreferrer" className="link-more" style={{ fontSize: "13px" }}>
                      Grafana에서 같은 구간 보기
                      <i className="ic ic-external" aria-hidden="true" />
                    </a>
                  </div>
                </div>
                <div className="widget-body" style={{ gap: "12px" }}>
                  <div className="row wrap" style={{ gap: "10px 12px" }}>
                    {v.isPaused ? (
                      <>
                        <span className="row" style={{ gap: "12px" }}>
                          <button className="btn btn-primary btn-sm" type="button" aria-keyshortcuts="Space" onClick={() => go?.('재생 중')}>
                            <i className="ic ic-play" aria-hidden="true" />
                            재생
                          </button>
                          <span className="mono t-sm" role="status" aria-live="polite">일시정지 · 11:01:40 / 11:20:00 UTC</span>
                        </span>
                      </>
                    ) : null}
                    {' '}
                    {v.isPlaying ? (
                      <>
                        <span className="row" style={{ gap: "12px" }}>
                          <button className="btn btn-primary btn-sm" type="button" aria-keyshortcuts="Space" onClick={() => go?.('기본')}>
                            <i className="ic ic-pause" aria-hidden="true" />
                            일시정지
                          </button>
                          <span className="mono t-sm" role="status" aria-live="polite">재생 중 · 11:03:55 / 11:20:00 UTC · 지금 4번 명령 3 실행·전파 ack 3/3</span>
                        </span>
                      </>
                    ) : null}
                    {' '}
                    <span className="grow" />
                    {' '}
                    <span className="row t-xs muted" style={{ gap: "6px" }}>
                      <span className="kbd">Space</span>
                      로 재생·일시정지
                    </span>
                    <div className="legend" aria-hidden="true">
                      <span className="legend-item">
                        <span className="dot" style={{ color: "var(--danger)" }} />
                        장애 주입·발생
                      </span>
                      {' '}
                      <span className="legend-item">
                        <span className="dot" style={{ color: "var(--warning)" }} />
                        경보
                      </span>
                      {' '}
                      <span className="legend-item">
                        <span className="dot" style={{ color: "var(--link)" }} />
                        명령
                      </span>
                      {' '}
                      <span className="legend-item">
                        <span className="dot" style={{ color: "var(--success)" }} />
                        지표 복구
                      </span>
                      {' '}
                      <span className="legend-item">
                        <span className="swatch" />
                        결제 확정 소요 p99(재시도 포함)
                      </span>
                      {' '}
                      <span className="legend-item">
                        <span className="swatch" style={{ background: "var(--danger)" }} />
                        RB-07 전환 검토 5초
                      </span>
                    </div>
                  </div>
                  {v.isPaused ? (
                    <>
                      <svg className="chart" viewBox="0 0 690 166" role="img" aria-label="결제 확정 소요 p99(재시도 포함)와 이벤트 7개. 11:01:40 UTC에 RB-07 전환 검토 기준 5초를 넘어 최고 6.1초까지 올랐고 11:04 판매 일시정지 뒤 내려가 11:10:30에 2초 아래로 돌아왔습니다. 재생 위치는 11:01:40입니다.">
                        <line className="grid" x1="46" y1="40" x2="676" y2="40" />
                        <line className="grid" x1="46" y1="65" x2="676" y2="65" />
                        <line className="grid" x1="46" y1="90" x2="676" y2="90" />
                        <line className="grid" x1="46" y1="115" x2="676" y2="115" />
                        <line className="grid" x1="46" y1="140" x2="676" y2="140" />
                        <text className="axis" x="40" y="44" textAnchor="end">8초</text>
                        <text className="axis" x="40" y="69" textAnchor="end">6초</text>
                        <text className="axis" x="40" y="94" textAnchor="end">4초</text>
                        <text className="axis" x="40" y="119" textAnchor="end">2초</text>
                        <text className="axis" x="40" y="144" textAnchor="end">0</text>
                        <text className="axis" x="46" y="160" textAnchor="middle">11:00</text>
                        <text className="axis" x="203.5" y="160" textAnchor="middle">11:05</text>
                        <text className="axis" x="361" y="160" textAnchor="middle">11:10</text>
                        <text className="axis" x="518.5" y="160" textAnchor="middle">11:15</text>
                        <text className="axis" x="676" y="160" textAnchor="middle">11:20</text>
                        <line className="slo-line" x1="46" y1="77.5" x2="676" y2="77.5" />
                        <text className="axis" x="672" y="73" textAnchor="end">RB-07 전환 검토 5초</text>
                        <polyline className="line" points="46.0,125 61.8,123.8 77.5,124.4 93.3,105 98.5,72.5 109.0,65 124.8,63.8 140.5,66.3 156.3,68.8 172.0,75 187.8,82.5 219.3,88.8 250.8,95 282.3,102.5 313.8,110 345.3,116.3 376.8,120 408.3,122.5 439.8,122.5 458.1,121.3 471.3,113.8 487.0,117.5 518.5,121.3 550.0,122.5 581.5,123.8 613.0,123.8 644.5,125 676.0,125" />
                        <line className="now" x1="98.5" y1="23" x2="98.5" y2="142" />
                        <circle cx="98.5" cy="14" r="7" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "2" }} />
                        <circle cx="114.3" cy="31" r="7" style={{ fill: "var(--warning)", stroke: "var(--surface)", strokeWidth: "2" }} />
                        <circle cx="121.6" cy="14" r="7" style={{ fill: "var(--link)", stroke: "var(--surface)", strokeWidth: "2" }} />
                        <circle cx="168.3" cy="31" r="7" style={{ fill: "var(--link)", stroke: "var(--surface)", strokeWidth: "2" }} />
                        <circle cx="376.8" cy="31" r="7" style={{ fill: "var(--success)", stroke: "var(--surface)", strokeWidth: "2" }} />
                        <circle cx="458.1" cy="14" r="7" style={{ fill: "var(--link)", stroke: "var(--surface)", strokeWidth: "2" }} />
                        <circle cx="614" cy="31" r="7" style={{ fill: "var(--link)", stroke: "var(--surface)", strokeWidth: "2" }} />
                        <text x="98.5" y="17.5" textAnchor="middle" style={{ fill: "var(--surface)", fontSize: "9px", fontWeight: "700", fontFamily: "var(--font)" }}>
                          1
                        </text>
                        <text x="114.3" y="34.5" textAnchor="middle" style={{ fill: "var(--surface)", fontSize: "9px", fontWeight: "700", fontFamily: "var(--font)" }}>
                          2
                        </text>
                        <text x="121.6" y="17.5" textAnchor="middle" style={{ fill: "var(--surface)", fontSize: "9px", fontWeight: "700", fontFamily: "var(--font)" }}>
                          3
                        </text>
                        <text x="168.3" y="34.5" textAnchor="middle" style={{ fill: "var(--surface)", fontSize: "9px", fontWeight: "700", fontFamily: "var(--font)" }}>
                          4
                        </text>
                        <text x="376.8" y="34.5" textAnchor="middle" style={{ fill: "var(--surface)", fontSize: "9px", fontWeight: "700", fontFamily: "var(--font)" }}>
                          5
                        </text>
                        <text x="458.1" y="17.5" textAnchor="middle" style={{ fill: "var(--surface)", fontSize: "9px", fontWeight: "700", fontFamily: "var(--font)" }}>
                          6
                        </text>
                        <text x="614" y="34.5" textAnchor="middle" style={{ fill: "var(--surface)", fontSize: "9px", fontWeight: "700", fontFamily: "var(--font)" }}>
                          7
                        </text>
                      </svg>
                    </>
                  ) : null}
                  {' '}
                  {v.isPlaying ? (
                    <>
                      <svg className="chart" viewBox="0 0 690 166" role="img" aria-label="결제 확정 소요 p99(재시도 포함)와 이벤트 7개. 11:01:40 UTC에 RB-07 전환 검토 기준 5초를 넘어 최고 6.1초까지 올랐고 11:04 판매 일시정지 뒤 내려가 11:10:30에 2초 아래로 돌아왔습니다. 재생 위치는 11:03:55입니다.">
                        <line className="grid" x1="46" y1="40" x2="676" y2="40" />
                        <line className="grid" x1="46" y1="65" x2="676" y2="65" />
                        <line className="grid" x1="46" y1="90" x2="676" y2="90" />
                        <line className="grid" x1="46" y1="115" x2="676" y2="115" />
                        <line className="grid" x1="46" y1="140" x2="676" y2="140" />
                        <text className="axis" x="40" y="44" textAnchor="end">8초</text>
                        <text className="axis" x="40" y="69" textAnchor="end">6초</text>
                        <text className="axis" x="40" y="94" textAnchor="end">4초</text>
                        <text className="axis" x="40" y="119" textAnchor="end">2초</text>
                        <text className="axis" x="40" y="144" textAnchor="end">0</text>
                        <text className="axis" x="46" y="160" textAnchor="middle">11:00</text>
                        <text className="axis" x="203.5" y="160" textAnchor="middle">11:05</text>
                        <text className="axis" x="361" y="160" textAnchor="middle">11:10</text>
                        <text className="axis" x="518.5" y="160" textAnchor="middle">11:15</text>
                        <text className="axis" x="676" y="160" textAnchor="middle">11:20</text>
                        <line className="slo-line" x1="46" y1="77.5" x2="676" y2="77.5" />
                        <text className="axis" x="672" y="73" textAnchor="end">RB-07 전환 검토 5초</text>
                        <polyline className="line" points="46.0,125 61.8,123.8 77.5,124.4 93.3,105 98.5,72.5 109.0,65 124.8,63.8 140.5,66.3 156.3,68.8 172.0,75 187.8,82.5 219.3,88.8 250.8,95 282.3,102.5 313.8,110 345.3,116.3 376.8,120 408.3,122.5 439.8,122.5 458.1,121.3 471.3,113.8 487.0,117.5 518.5,121.3 550.0,122.5 581.5,123.8 613.0,123.8 644.5,125 676.0,125" />
                        <line className="now" x1="169.3" y1="23" x2="169.3" y2="142" />
                        <circle cx="98.5" cy="14" r="7" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "2" }} />
                        <circle cx="114.3" cy="31" r="7" style={{ fill: "var(--warning)", stroke: "var(--surface)", strokeWidth: "2" }} />
                        <circle cx="121.6" cy="14" r="7" style={{ fill: "var(--link)", stroke: "var(--surface)", strokeWidth: "2" }} />
                        <circle cx="168.3" cy="31" r="8" style={{ fill: "var(--link)", stroke: "var(--text)", strokeWidth: "2" }} />
                        <circle cx="376.8" cy="31" r="7" style={{ fill: "var(--success)", stroke: "var(--surface)", strokeWidth: "2" }} />
                        <circle cx="458.1" cy="14" r="7" style={{ fill: "var(--link)", stroke: "var(--surface)", strokeWidth: "2" }} />
                        <circle cx="614" cy="31" r="7" style={{ fill: "var(--link)", stroke: "var(--surface)", strokeWidth: "2" }} />
                        <text x="98.5" y="17.5" textAnchor="middle" style={{ fill: "var(--surface)", fontSize: "9px", fontWeight: "700", fontFamily: "var(--font)" }}>
                          1
                        </text>
                        <text x="114.3" y="34.5" textAnchor="middle" style={{ fill: "var(--surface)", fontSize: "9px", fontWeight: "700", fontFamily: "var(--font)" }}>
                          2
                        </text>
                        <text x="121.6" y="17.5" textAnchor="middle" style={{ fill: "var(--surface)", fontSize: "9px", fontWeight: "700", fontFamily: "var(--font)" }}>
                          3
                        </text>
                        <text x="168.3" y="34.5" textAnchor="middle" style={{ fill: "var(--surface)", fontSize: "9px", fontWeight: "700", fontFamily: "var(--font)" }}>
                          4
                        </text>
                        <text x="376.8" y="34.5" textAnchor="middle" style={{ fill: "var(--surface)", fontSize: "9px", fontWeight: "700", fontFamily: "var(--font)" }}>
                          5
                        </text>
                        <text x="458.1" y="17.5" textAnchor="middle" style={{ fill: "var(--surface)", fontSize: "9px", fontWeight: "700", fontFamily: "var(--font)" }}>
                          6
                        </text>
                        <text x="614" y="34.5" textAnchor="middle" style={{ fill: "var(--surface)", fontSize: "9px", fontWeight: "700", fontFamily: "var(--font)" }}>
                          7
                        </text>
                      </svg>
                    </>
                  ) : null}
                  <ol aria-label="리플레이 이벤트" style={{ display: "grid", gridTemplateColumns: "repeat(2,minmax(0,1fr))", gap: "8px 16px" }}>
                    <li className="row" style={{ gap: "8px", alignItems: "flex-start" }}>
                      <span className="badge badge-danger num" style={{ minWidth: "22px", justifyContent: "center" }} aria-hidden="true">1</span>
                      <span className="col" style={{ gap: "1px" }}>
                        <span className="t-xs muted mono">11:01:40 · 장애 발생</span>
                        <span className="t-xs">결제 확정 소요 p99가 5초를 넘음(승인 호출 p99가 2초를 넘기 시작)</span>
                      </span>
                    </li>
                    <li className="row" style={{ gap: "8px", alignItems: "flex-start" }}>
                      <span className="badge badge-warning num" style={{ minWidth: "22px", justifyContent: "center" }} aria-hidden="true">2</span>
                      <span className="col" style={{ gap: "1px" }}>
                        <span className="t-xs muted mono">11:02:10 · 경보</span>
                        <span className="t-xs">SEV2 결제 확정 임박(승인 호출 p99 2초 초과)</span>
                      </span>
                    </li>
                    <li className="row" style={{ gap: "8px", alignItems: "flex-start" }}>
                      <span className="badge badge-primary num" style={{ minWidth: "22px", justifyContent: "center" }} aria-hidden="true">3</span>
                      <span className="col" style={{ gap: "1px" }}>
                        <span className="t-xs muted mono">11:02:24 · 명령</span>
                        <span className="t-xs">명령 1 목표 5,000 → 1,000명(민호)</span>
                      </span>
                    </li>
                    <li className="row" style={{ gap: "8px", alignItems: "flex-start" }}>
                      <span className="badge badge-primary num" style={{ minWidth: "22px", justifyContent: "center" }} aria-hidden="true">4</span>
                      <span className="col" style={{ gap: "1px" }}>
                        <span className="t-xs muted mono">11:03:53 · 명령</span>
                        <span className="t-xs">명령 3 판매 일시정지 실행(수진, 1인·재인증) · 전파 ack 3/3(11:03:55)</span>
                      </span>
                    </li>
                    <li className="row" style={{ gap: "8px", alignItems: "flex-start" }}>
                      <span className="badge badge-success num" style={{ minWidth: "22px", justifyContent: "center" }} aria-hidden="true">5</span>
                      <span className="col" style={{ gap: "1px" }}>
                        <span className="t-xs muted mono">11:10:30 · 지표 복구</span>
                        <span className="t-xs">결제 확정 소요 p99가 2초 아래로</span>
                      </span>
                    </li>
                    <li className="row" style={{ gap: "8px", alignItems: "flex-start" }}>
                      <span className="badge badge-primary num" style={{ minWidth: "22px", justifyContent: "center" }} aria-hidden="true">6</span>
                      <span className="col" style={{ gap: "1px" }}>
                        <span className="t-xs muted mono">11:13:05 · 명령</span>
                        <span className="t-xs">명령 3 되돌리기 · 판매 재개 ack 3/3</span>
                      </span>
                    </li>
                    <li className="row" style={{ gap: "8px", alignItems: "flex-start" }}>
                      <span className="badge badge-primary num" style={{ minWidth: "22px", justifyContent: "center" }} aria-hidden="true">7</span>
                      <span className="col" style={{ gap: "1px" }}>
                        <span className="t-xs muted mono">11:18:02 · 명령</span>
                        <span className="t-xs">자동 조절 복귀 확인(민호)</span>
                      </span>
                    </li>
                  </ol>
                </div>
              </section>
            </>
          ) : null}
          {' '}
          {v.isEmpty ? (
            <>
              <section className="widget" aria-labelledby="rp0-t">
                <div className="widget-head"><h2 id="rp0-t" style={{ fontSize: "13px", lineHeight: "18px" }}>인시던트 리플레이</h2></div>
                <div className="widget-body">
                  <div className="row wrap" style={{ gap: "12px" }}>
                    <button className="btn btn-primary btn-sm" type="button" aria-disabled="true" aria-describedby="rp0-why">
                      <i className="ic ic-play" aria-hidden="true" />
                      재생
                    </button>
                    <span className="t-sm muted" id="rp0-why">재생할 기록이 없습니다. 기록이 있는 기간을 고르면 경보·명령·지표를 같은 시간축으로 재생합니다.</span>
                  </div>
                </div>
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
          <form className="toolbar" role="search" aria-label="명단 다운로드 기록 찾기" style={{ alignItems: "flex-end", gap: "12px" }} onSubmit={prevent}>
            <div className="field" style={{ flex: "1 1 220px" }}>
              <label className="label" htmlFor="d-period">기간(UTC)</label>
              <div className="input-group input-group-sm">
                <i className="ic ic-calendar ic-16" aria-hidden="true" />
                <input id="d-period" type="text" defaultValue="2026-10-08 ~ 2026-10-14" />
              </div>
            </div>
            <div className="field" style={{ flex: "1 1 220px" }}>
              <label className="label" htmlFor="d-account">계정</label>
              <div className="input-group input-group-sm">
                <select id="d-account" defaultValue="전체">
                  <option>전체</option>
                  <option>파트너 관리자 · (주)스텔라엔터테인먼트</option>
                </select>
                <i className="ic ic-chevron-down ic-16" aria-hidden="true" />
              </div>
            </div>
            <div className="field" style={{ flex: "1 1 220px" }}>
              <label className="label" htmlFor="d-event">공연</label>
              <div className="input-group input-group-sm">
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
            <button className="btn btn-secondary" type="submit">조건으로 찾기</button>
          </form>
          <span className="t-xs muted">4건 · 일시 내림차순</span>
          <div className="table-wrap table-scroll">
            <table className="table dense" style={{ minWidth: "1000px" }} aria-label="명단 다운로드 기록 4건, 일시 내림차순">
              <thead>
                <tr>
                  <th scope="col" aria-sort="descending">일시(UTC)</th>
                  <th scope="col">계정</th>
                  <th scope="col">공연·회차</th>
                  <th scope="col">사유</th>
                  <th scope="col" className="r">건수</th>
                  <th scope="col">형식</th>
                  <th scope="col">점검</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td className="mono">2026-10-14 07:12:40</td>
                  <td>파트너 관리자 · (주)스텔라엔터테인먼트</td>
                  <td>가을 야외 페스티벌 · 11/7(토)</td>
                  <td>현장 입장 동선 준비</td>
                  <td className="r">1,180</td>
                  <td>CSV</td>
                  <td><span className="badge badge-warning">24시간에 3회</span></td>
                </tr>
                <tr>
                  <td className="mono">2026-10-14 02:40:11</td>
                  <td>파트너 관리자 · (주)스텔라엔터테인먼트</td>
                  <td>가을 야외 페스티벌 · 11/7(토)</td>
                  <td>명단 재확인</td>
                  <td className="r">1,180</td>
                  <td>XLSX</td>
                  <td><span className="badge badge-warning">24시간에 3회</span></td>
                </tr>
                <tr>
                  <td className="mono">2026-10-13 14:05:52</td>
                  <td>파트너 관리자 · (주)스텔라엔터테인먼트</td>
                  <td>가을 야외 페스티벌 · 11/7(토)</td>
                  <td>현장 운영 인원 배치</td>
                  <td className="r">1,180</td>
                  <td>CSV</td>
                  <td><span className="badge badge-warning">24시간에 3회</span></td>
                </tr>
                <tr>
                  <td className="mono">2026-10-09 06:20:31</td>
                  <td>파트너 관리자 · (주)스텔라엔터테인먼트</td>
                  <td>소극장 뮤지컬 · 회차 3개</td>
                  <td>현장 명단 준비</td>
                  <td className="r">860</td>
                  <td>CSV</td>
                  <td className="muted">—</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="t-xs muted">명단을 내려받을 때 적은 사유와 건수는 접속기록에 남습니다. 같은 명단을 24시간에 3회 이상 내려받으면 법정 조치의 접속기록 점검 목록에 올라갑니다(기준 값은 내부 관리계획에서 확정합니다).</p>
        </div>
      </>
    ) : null}
    </>
  );
}
