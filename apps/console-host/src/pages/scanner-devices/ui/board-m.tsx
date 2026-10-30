// 디자인 캔버스 보드 SCR-053-m.dc.html를 옮긴 것(dc2tsx 생성 뒤 손질)
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

export const STATES_M = ["기본", "폐기 확인 대화상자", "폐기됨", "빈 화면"] as const;
export const DEFAULT_M = "기본";

export function valsM(state: string) {
    let st = state || '기본';
    let gone = st === '폐기됨';
    let empty = st === '빈 화면';
    return {
      isEmpty: empty,
      hasDev: !empty,
      devCount: empty ? '0' : '9',
      isActive: !gone && !empty,
      isGone: gone,
      isDialog: st === '폐기 확인 대화상자',
      clockA: !gone,
      clockR: gone
    };
  }

type V = ReturnType<typeof valsM>;

// 보드 루트: {"class": "pk dark cs cs-compact", "style": "width:360px;min-height:2680px"}

// <main class="cs-main" id="main">
export function MainM({ v, close, go }: { v: V; close?: () => void; go?: (state: string) => void }) {
  void v; void close; void go;
  const ro = useRo();
  return (
    <>
    <div className="col" style={{ gap: "4px" }}>
      <h1 className="t-lg">스캐너 기기 관리</h1>
      <p className="t-sm muted">현장 스캐너 기기를 등록해 한 파트너에 배정하고, 분실·도난이면 즉시 폐기합니다.</p>
    </div>
    <div className="banner banner-info bigscreen" role="note">
      <i className="ic ic-monitor" aria-hidden="true" />
      <div className="banner-body">
        <span className="banner-title">기기 등록은 태블릿이나 데스크톱에서 합니다</span>
        휴대폰에서는 볼 수만 있습니다
      </div>
      <button onClick={copyLink} className="btn btn-outline btn-sm" type="button">
        <i className="ic ic-copy" aria-hidden="true" />
        링크 복사
      </button>
    </div>
    <section className="col" style={{ gap: "10px" }} aria-labelledby="h-dev">
      <h2 className="t-md fw-b" id="h-dev">기기 {v.devCount}대</h2>
      <div className="row" style={{ gap: "8px", alignItems: "flex-end" }}>
        <div className="field grow" style={{ gap: "4px" }}>
          <label className="t-xs muted" htmlFor="f-pt">파트너</label>
          <div className="input-group">
            <select id="f-pt" defaultValue="전체 파트너">
              <option>전체 파트너</option>
              <option>(주)스텔라엔터테인먼트</option>
              <option>[예시 파트너 A]</option>
            </select>
            <i className="ic ic-chevron-down ic-16" aria-hidden="true" />
          </div>
        </div>
        <div className="field" style={{ gap: "4px", width: "128px" }}>
          <label className="t-xs muted" htmlFor="f-st">상태</label>
          <div className="input-group">
            <select id="f-st" defaultValue="전체 상태">
              <option>전체 상태</option>
              <option>사용 중</option>
              <option>폐기됨</option>
              <option>퇴역</option>
            </select>
            <i className="ic ic-chevron-down ic-16" aria-hidden="true" />
          </div>
        </div>
      </div>
      {v.hasDev ? (
        <>
          <ul className="col" style={{ gap: "8px" }}>
            <li>
              <Link to="/scanner-devices" className="card col" style={{ gap: "6px", padding: "10px 14px", color: "inherit" }}>
                <span className="row" style={{ gap: "8px" }}>
                  <span className="t-md fw-b grow">동문-01</span>
                  <span className="badge badge-success">사용 중</span>
                </span>
                {' '}
                <span className="t-xs muted">(주)스텔라엔터테인먼트</span>
                {' '}
                <span className="row between wrap" style={{ gap: "4px 12px" }}>
                  <span className="row t-xs" style={{ gap: "6px" }}>
                    <span className="muted">기기 키 등록일</span>
                    <span className="t-sm fw-m">10/15(목)</span>
                  </span>
                  <span className="row t-xs" style={{ gap: "6px" }}>
                    <span className="muted">마지막 연락</span>
                    <span className="t-sm fw-m">9초 전</span>
                  </span>
                </span>
              </Link>
            </li>
            <li>
              <Link to="/scanner-devices" className="card col" style={{ gap: "6px", padding: "10px 14px", color: "inherit" }}>
                <span className="row" style={{ gap: "8px" }}>
                  <span className="t-md fw-b grow">동문-02</span>
                  <span className="badge badge-success">사용 중</span>
                </span>
                {' '}
                <span className="t-xs muted">(주)스텔라엔터테인먼트</span>
                {' '}
                <span className="row between wrap" style={{ gap: "4px 12px" }}>
                  <span className="row t-xs" style={{ gap: "6px" }}>
                    <span className="muted">기기 키 등록일</span>
                    <span className="t-sm fw-m">10/15(목)</span>
                  </span>
                  <span className="row t-xs" style={{ gap: "6px" }}>
                    <span className="muted">마지막 연락</span>
                    <span className="t-sm fw-m">14초 전</span>
                  </span>
                </span>
              </Link>
            </li>
            <li>
              <Link to="/scanner-devices" className="card col" style={{ gap: "6px", padding: "10px 14px", color: "inherit" }}>
                <span className="row" style={{ gap: "8px" }}>
                  <span className="t-md fw-b grow">동문-03</span>
                  <span className="badge badge-success">사용 중</span>
                </span>
                {' '}
                <span className="t-xs muted">(주)스텔라엔터테인먼트</span>
                {' '}
                <span className="row between wrap" style={{ gap: "4px 12px" }}>
                  <span className="row t-xs" style={{ gap: "6px" }}>
                    <span className="muted">기기 키 등록일</span>
                    <span className="t-sm fw-m">10/15(목)</span>
                  </span>
                  <span className="row t-xs" style={{ gap: "6px" }}>
                    <span className="muted">마지막 연락</span>
                    <span className="t-sm fw-m">21초 전</span>
                  </span>
                </span>
              </Link>
            </li>
            <li>
              <Link to="/scanner-devices" className="card col" style={{ gap: "6px", padding: "10px 14px", color: "inherit" }}>
                <span className="row" style={{ gap: "8px" }}>
                  <span className="t-md fw-b grow">동문-04</span>
                  <span className="badge badge-success">사용 중</span>
                </span>
                {' '}
                <span className="t-xs muted">(주)스텔라엔터테인먼트</span>
                {' '}
                <span className="row between wrap" style={{ gap: "4px 12px" }}>
                  <span className="row t-xs" style={{ gap: "6px" }}>
                    <span className="muted">기기 키 등록일</span>
                    <span className="t-sm fw-m">10/15(목)</span>
                  </span>
                  <span className="row t-xs" style={{ gap: "6px" }}>
                    <span className="muted">마지막 연락</span>
                    <span className="t-sm fw-m">38초 전</span>
                  </span>
                </span>
              </Link>
            </li>
            <li>
              <Link to="/scanner-devices" className="card col" style={{ gap: "6px", padding: "10px 14px", color: "inherit" }}>
                <span className="row" style={{ gap: "8px" }}>
                  <span className="t-md fw-b grow">서문-01</span>
                  <span className="badge badge-success">사용 중</span>
                </span>
                {' '}
                <span className="t-xs muted">(주)스텔라엔터테인먼트</span>
                {' '}
                <span className="row between wrap" style={{ gap: "4px 12px" }}>
                  <span className="row t-xs" style={{ gap: "6px" }}>
                    <span className="muted">기기 키 등록일</span>
                    <span className="t-sm fw-m">10/15(목)</span>
                  </span>
                  <span className="row t-xs" style={{ gap: "6px" }}>
                    <span className="muted">마지막 연락</span>
                    <span className="t-sm fw-m">11초 전</span>
                  </span>
                </span>
              </Link>
            </li>
            <li>
              <Link to="/scanner-devices" className="card col is-selected" aria-current="true" style={{ gap: "6px", padding: "10px 14px", color: "inherit" }}>
                <span className="row" style={{ gap: "8px" }}>
                  <span className="t-md fw-b grow">서문-02</span>
                  {v.isActive ? (
                    <>
                      <span className="badge badge-success">사용 중</span>
                    </>
                  ) : null}
                  {v.isGone ? (
                    <>
                      <span className="badge badge-danger">폐기됨</span>
                    </>
                  ) : null}
                </span>
                {' '}
                <span className="t-xs muted">(주)스텔라엔터테인먼트</span>
                {' '}
                <span className="row between wrap" style={{ gap: "4px 12px" }}>
                  <span className="row t-xs" style={{ gap: "6px" }}>
                    <span className="muted">기기 키 등록일</span>
                    <span className="t-sm fw-m">10/15(목)</span>
                  </span>
                  <span className="row t-xs" style={{ gap: "6px" }}>
                    <span className="muted">마지막 연락</span>
                    <span className="t-sm fw-m">
                      {v.isActive ? (
                        <>
                          6분 전
                        </>
                      ) : null}
                      {v.isGone ? (
                        <>
                          17:06:38 KST
                        </>
                      ) : null}
                    </span>
                  </span>
                </span>
              </Link>
            </li>
            <li>
              <Link to="/scanner-devices" className="card col" style={{ gap: "6px", padding: "10px 14px", color: "inherit" }}>
                <span className="row" style={{ gap: "8px" }}>
                  <span className="t-md fw-b grow">서문-03</span>
                  <span className="badge badge-success">사용 중</span>
                </span>
                {' '}
                <span className="t-xs muted">(주)스텔라엔터테인먼트</span>
                {' '}
                <span className="row between wrap" style={{ gap: "4px 12px" }}>
                  <span className="row t-xs" style={{ gap: "6px" }}>
                    <span className="muted">기기 키 등록일</span>
                    <span className="t-sm fw-m">10/21(수)</span>
                  </span>
                  <span className="row t-xs" style={{ gap: "6px" }}>
                    <span className="muted">마지막 연락</span>
                    <span className="t-sm fw-m">15:02 KST</span>
                  </span>
                </span>
              </Link>
            </li>
            <li>
              <Link to="/partners" className="card col" style={{ gap: "6px", padding: "10px 14px", color: "inherit" }}>
                <span className="row" style={{ gap: "8px" }}>
                  <span className="t-md fw-b grow">[예시 기기 1]</span>
                  <span className="badge badge-success">사용 중</span>
                </span>
                {' '}
                <span className="t-xs muted">[예시 파트너 A]</span>
                {' '}
                <span className="row between wrap" style={{ gap: "4px 12px" }}>
                  <span className="row t-xs" style={{ gap: "6px" }}>
                    <span className="muted">기기 키 등록일</span>
                    <span className="t-sm fw-m">10/10(토)</span>
                  </span>
                  <span className="row t-xs" style={{ gap: "6px" }}>
                    <span className="muted">마지막 연락</span>
                    <span className="t-sm fw-m">10/23(금) 21:40 KST</span>
                  </span>
                </span>
              </Link>
            </li>
            <li>
              <Link to="/partners" className="card col" style={{ gap: "6px", padding: "10px 14px", color: "inherit" }}>
                <span className="row" style={{ gap: "8px" }}>
                  <span className="t-md fw-b grow">[예시 기기 2]</span>
                  <span className="badge">퇴역</span>
                </span>
                {' '}
                <span className="t-xs muted">[예시 파트너 A]</span>
                {' '}
                <span className="row between wrap" style={{ gap: "4px 12px" }}>
                  <span className="row t-xs" style={{ gap: "6px" }}>
                    <span className="muted">기기 키 등록일</span>
                    <span className="t-sm fw-m">—</span>
                  </span>
                  <span className="row t-xs" style={{ gap: "6px" }}>
                    <span className="muted">마지막 연락</span>
                    <span className="t-sm fw-m">9/30(수) 18:10 KST</span>
                  </span>
                </span>
              </Link>
            </li>
          </ul>
        </>
      ) : null}
      {' '}
      {v.isEmpty ? (
        <>
          <div className="card state" style={{ padding: "36px 20px" }}>
            <span className="state-icon is-primary"><i className="ic ic-device" aria-hidden="true" /></span>
            <h3 className="t-md fw-b">등록된 기기가 없습니다</h3>
            <p className="t-sm muted">기기를 등록하면 이곳에 이름·배정 파트너·상태와 마지막 연락이 보입니다.</p>
          </div>
        </>
      ) : null}
    </section>
    {v.isActive ? (
      <>
        <div className="col" style={{ gap: "6px" }}>
          <p className="eyebrow">선택한 기기</p>
          <section className="widget" role="region" aria-labelledby="h-d1">
            <div className="widget-head">
              <h2 className="t-sm fw-b" id="h-d1">서문-02</h2>
              <span className="badge badge-success">사용 중</span>
              {' '}
              <span className="actions t-xs muted">(주)스텔라엔터테인먼트</span>
            </div>
            <div className="widget-body" style={{ gap: "12px" }}>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(2,minmax(0,1fr))", gap: "8px" }}>
                <div className="stat" style={{ padding: "12px 14px" }}>
                  <span className="stat-label">기기 키</span>
                  <span className="stat-value">등록됨</span>
                  <span className="slo slo-ok">만료 없음</span>
                  <span className="stat-meta">10/15(목) 14:20 KST 등록</span>
                </div>
                <div className="stat is-burning" style={{ padding: "12px 14px" }}>
                  <span className="stat-label">마지막 연락</span>
                  <span className="stat-value">6분 전</span>
                  <span className="slo slo-burning">2분 넘음</span>
                  <span className="stat-meta">17:06:38 KST</span>
                </div>
              </div>
              <p className="t-xs muted">로그인 세션 1개 · 현장 스태프</p>
              <p className="hint">이 파트너 공연에 배정된 스태프만 이 기기로 로그인합니다.</p>
              <div className="card-flat col" style={{ gap: "8px", padding: "14px" }}>
                <h3 className="t-sm fw-b">즉시 폐기</h3>
                <p className="t-xs muted">분실·도난이면 바로 폐기합니다(RB-22). 폐기하면 이 기기의 다음 요청부터 막히고 로그인한 스태프 세션이 끝납니다.</p>
                <button onClick={() => go?.('폐기 확인 대화상자')} className="btn btn-danger btn-lg btn-block" type="button" aria-haspopup="dialog" {...ro()}>
                  <i className="ic ic-ban" aria-hidden="true" />
                  서문-02 즉시 폐기하기
                </button>
              </div>
              <div className="banner banner-info bigscreen" role="note">
                <i className="ic ic-monitor" aria-hidden="true" />
                <div className="banner-body">
                  <span className="banner-title">이름·배정 변경, 다시 등록, 퇴역 처리는 태블릿이나 데스크톱에서 합니다</span>
                  휴대폰에서는 볼 수만 있습니다
                </div>
                <button onClick={copyLink} className="btn btn-outline btn-sm" type="button">
                  <i className="ic ic-copy" aria-hidden="true" />
                  링크 복사
                </button>
              </div>
              <section className="col" style={{ gap: "8px" }} aria-labelledby="h-d1h">
                <div className="row between">
                  <h3 className="t-sm fw-b" id="h-d1h">등록·폐기 이력</h3>
                  <Link to="/audit" className="link-more">
                    감사 로그
                    <i className="ic ic-chevron-right" aria-hidden="true" />
                  </Link>
                </div>
                <ol className="timeline">
                  <li className="tl-item">
                    <span className="tl-dot ok" aria-hidden="true" />
                    <div className="col" style={{ gap: "2px" }}>
                      <span className="t-sm fw-b">등록 · (주)스텔라엔터테인먼트 배정</span>
                      <span className="t-xs muted">10/15(목) 14:20 KST · 민호 · 등록 코드로 기기 키 등록</span>
                    </div>
                  </li>
                </ol>
              </section>
            </div>
          </section>
        </div>
      </>
    ) : null}
    {' '}
    {v.isGone ? (
      <>
        <div className="col" style={{ gap: "6px" }}>
          <p className="eyebrow">선택한 기기</p>
          <section className="widget" role="region" aria-labelledby="h-d2">
            <div className="widget-head">
              <h2 className="t-sm fw-b" id="h-d2">서문-02</h2>
              <span className="badge badge-danger">폐기됨</span>
              {' '}
              <span className="actions t-xs muted">(주)스텔라엔터테인먼트</span>
            </div>
            <div className="widget-body" style={{ gap: "12px" }}>
              <div className="banner" role="status">
                <i className="ic ic-ban" aria-hidden="true" />
                <div className="banner-body">
                  <span className="banner-title">이 기기의 세션이 끝났습니다</span>
                  <p>17:13:02 KST에 폐기했습니다. 이 기기의 다음 요청부터 막힙니다. 남은 스태프 토큰은 이 기기에 묶여 있어 다른 기기에서 쓸 수 없습니다.</p>
                </div>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(2,minmax(0,1fr))", gap: "8px" }}>
                <div className="stat is-stale" style={{ padding: "12px 14px" }}>
                  <span className="stat-label">기기 키</span>
                  <span className="stat-value">폐기됨</span>
                  <span className="slo slo-stale">다시 등록 필요</span>
                  <span className="stat-meta">10/15(목) 14:20 KST 등록</span>
                </div>
                <div className="stat" style={{ padding: "12px 14px" }}>
                  <span className="stat-label">마지막 연락</span>
                  <span className="stat-value">6분 전</span>
                  <span className="slo slo-stale">요청 막힘</span>
                  <span className="stat-meta">17:06:38 KST</span>
                </div>
              </div>
              <section className="col" style={{ gap: "8px" }} aria-labelledby="h-rb">
                <h3 className="t-sm fw-b" id="h-rb">RB-22 분실·도난 대응</h3>
                <ol className="col t-sm" style={{ gap: "6px" }}>
                  <li className="row" style={{ gap: "8px" }}>
                    <span className="step is-done"><span className="step-num"><i className="ic ic-check" aria-hidden="true" /></span></span>
                    즉시 폐기와 스태프 세션 종료
                    <span className="badge badge-success">끝남</span>
                  </li>
                  <li className="row" style={{ gap: "8px" }}>
                    <span className="step-num">2</span>
                    파트너·현장 책임자에게 알림
                  </li>
                  <li className="row" style={{ gap: "8px" }}>
                    <span className="step-num">3</span>
                    예비 기기 투입과 기기 배치
                  </li>
                  <li className="row" style={{ gap: "8px" }}>
                    <span className="step-num">4</span>
                    보내지 못한 기록의 손실 범위를 CS 처리함에 기록
                  </li>
                  <li className="row" style={{ gap: "8px" }}>
                    <span className="step-num">5</span>
                    회수하면 다시 등록한 뒤 남은 기록 업로드
                  </li>
                </ol>
              </section>
              <div className="banner banner-info bigscreen" role="note">
                <i className="ic ic-monitor" aria-hidden="true" />
                <div className="banner-body">
                  <span className="banner-title">다시 등록·퇴역 처리는 태블릿이나 데스크톱에서 합니다</span>
                  휴대폰에서는 볼 수만 있습니다
                </div>
                <button onClick={copyLink} className="btn btn-outline btn-sm" type="button">
                  <i className="ic ic-copy" aria-hidden="true" />
                  링크 복사
                </button>
              </div>
              <section className="col" style={{ gap: "8px" }} aria-labelledby="h-d2h">
                <div className="row between">
                  <h3 className="t-sm fw-b" id="h-d2h">등록·폐기 이력</h3>
                  <Link to="/audit" className="link-more">
                    감사 로그
                    <i className="ic ic-chevron-right" aria-hidden="true" />
                  </Link>
                </div>
                <ol className="timeline">
                  <li className="tl-item">
                    <span className="tl-dot bad" aria-hidden="true" />
                    <div className="col" style={{ gap: "2px" }}>
                      <span className="t-sm fw-b">폐기 · 사유: 서문 게이트 분실 신고</span>
                      <span className="t-xs muted">10/25(일) 17:13:02 KST · 민호 · 로그인 세션 1개 종료</span>
                    </div>
                  </li>
                  <li className="tl-item">
                    <span className="tl-dot ok" aria-hidden="true" />
                    <div className="col" style={{ gap: "2px" }}>
                      <span className="t-sm fw-b">등록 · (주)스텔라엔터테인먼트 배정</span>
                      <span className="t-xs muted">10/15(목) 14:20 KST · 민호 · 등록 코드로 기기 키 등록</span>
                    </div>
                  </li>
                </ol>
              </section>
            </div>
          </section>
        </div>
      </>
    ) : null}
    <details className="widget">
      <summary className="widget-head">
        <span>기기 상태와 기기 키</span>
        <span className="fold-meta"><i className="ic ic-chevron-down fold-ic" aria-hidden="true" /></span>
      </summary>
      <div className="widget-body">
        <dl className="t-sm" style={{ display: "grid", gridTemplateColumns: "auto minmax(0,1fr)", gap: "10px 12px", alignItems: "start" }}>
          <dt><span className="badge badge-success">사용 중</span></dt>
          <dd>스캐너 API가 요청마다 기기 상태를 확인합니다. 이 상태의 기기만 스태프 로그인을 시작할 수 있습니다.</dd>
          <dt><span className="badge badge-danger">폐기됨</span></dt>
          <dd>다음 요청부터 막히고 그 기기의 스태프 세션이 끝납니다. 회수하면 다시 등록합니다.</dd>
          <dt><span className="badge">퇴역</span></dt>
          <dd>더 쓰지 않는 기기입니다.</dd>
          <dt className="fw-b">기기 키</dt>
          <dd>이 기기는 기기 안에서 만든 키로 요청마다 서명합니다(기기 키 + DPoP). 기기 키는 만료가 없고, 잃거나 회수하면 폐기한 뒤 다시 등록합니다. T-30분 점검은 배치된 기기의 자격이 역할 유효 끝 뒤까지 유효한지 봅니다.</dd>
        </dl>
      </div>
    </details>
    </>
  );
}

export function OverlaysM({ v, close, go }: { v: V; close?: () => void; go?: (state: string) => void }) {
  void v; void close; void go;
  const ro = useRo();
  return (
    <>
    {v.isDialog ? (
      <>
        <Overlay placement="bottom" onClose={close}>
          <div className="sheet" role="dialog" aria-modal="true" aria-labelledby="rv-t" aria-describedby="rv-d" style={{ gap: "12px" }}>
            <span className="sheet-handle" aria-hidden="true" />
            <div className="row" style={{ gap: "12px" }}>
              <span className="state-icon is-danger" style={{ width: "40px", height: "40px" }}><i className="ic ic-ban" aria-hidden="true" /></span>
              <h2 className="dialog-title" id="rv-t">서문-02를 즉시 폐기합니다</h2>
            </div>
            <p className="t-md fw-b" id="rv-d">폐기하면 이 기기의 다음 요청부터 막히고 로그인한 스태프 세션이 끝납니다</p>
            <dl className="kv">
              <dt>배정 파트너</dt>
              <dd>(주)스텔라엔터테인먼트</dd>
              <dt>로그인 세션</dt>
              <dd>1개 · 현장 스태프</dd>
              <dt>마지막 연락</dt>
              <dd>17:06:38 KST(6분 전)</dd>
            </dl>
            <div className="field">
              <label className="label" htmlFor="rv-reason">폐기 사유 (필수)</label>
              {' '}
              <textarea className="textarea" id="rv-reason" style={{ minHeight: "68px" }} aria-describedby="rv-reason-h" defaultValue="서문 게이트에서 분실 신고. 현장 책임자가 기기가 없음을 확인함" />
              {' '}
              <span className="hint" id="rv-reason-h">사유는 감사 로그에 남습니다.</span>
            </div>
            <div className="field">
              <label className="label" htmlFor="rv-type">확인을 위해 기기 이름 서문-02를 입력하세요 (필수)</label>
              {' '}
              <input className="input" id="rv-type" type="text" autoComplete="off" defaultValue="서문-02" />
            </div>
            <div className="card-flat col" style={{ gap: "6px", padding: "12px 14px" }}>
              <span className="t-sm fw-b">폐기 뒤 할 일(RB-22)</span>
              <ol className="col t-xs" style={{ gap: "4px" }}>
                <li className="row" style={{ gap: "8px" }}>
                  <span className="step-num">2</span>
                  파트너·현장 책임자에게 알립니다
                </li>
                <li className="row" style={{ gap: "8px" }}>
                  <span className="step-num">3</span>
                  예비 기기를 투입하고 기기 배치를 바꿉니다
                </li>
                <li className="row" style={{ gap: "8px" }}>
                  <span className="step-num">4</span>
                  보내지 못한 기록의 손실 범위를 CS 처리함에 기록합니다
                </li>
                <li className="row" style={{ gap: "8px" }}>
                  <span className="step-num">5</span>
                  회수하면 다시 등록한 뒤 남은 기록을 올립니다
                </li>
              </ol>
            </div>
            <div className="col" style={{ gap: "8px" }}>
              <button onClick={() => go?.('폐기됨')} className="btn btn-danger btn-lg btn-block" type="button" {...ro()}>서문-02를 폐기하고 세션을 끝냅니다</button>
              {' '}
              <button onClick={close} className="btn btn-outline btn-block" type="button">폐기하지 않고 닫기</button>
            </div>
          </div>
        </Overlay>
      </>
    ) : null}
    </>
  );
}
