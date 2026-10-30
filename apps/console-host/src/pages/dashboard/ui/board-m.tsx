// 디자인 캔버스 보드 SCR-029-m.dc.html를 옮긴 것(dc2tsx 생성 뒤 손질)
/* eslint-disable */
import { Fragment, type FormEvent } from 'react';
import { Link } from 'react-router';
import { Overlay } from '@/shared/ui/Overlay';
import type { DashCtx } from './ctx';

const prevent = (e: FormEvent) => e.preventDefault();
void Fragment;
void Link;

type AriaBool = boolean | 'true' | 'false';
type AriaCurrent = boolean | 'true' | 'false' | 'page' | 'step' | 'location' | 'date' | 'time';

export const STATES_M = ["T=0", "판매 중", "T-30분 점검", "종료 후 리포트", "입장 탭", "수집 장애", "제어 입력 없음", "메뉴 열림", "자동 조치 걸림", "숨겼다가 돌아옴", "실시간 표 낡음", "거래 사건 끊김", "경보 억제", "버짓 50% 소진", "버짓 100% 소진", "대상 없음", "viewer"] as const;
export const DEFAULT_M = "T=0";

export function valsM(state: string) {
    let st = state || 'T=0';
    let supp = st === '경보 억제';
    let b50 = st === '버짓 50% 소진';
    let b100 = st === '버짓 100% 소진';
    let budget = b50 || b100;
    let empty = st === '대상 없음';
    let viewer = st === 'viewer';
    let menu = st === '메뉴 열림';
    let auto = st === '자동 조치 걸림';
    let back = st === '숨겼다가 돌아옴';
    let stale = st === '실시간 표 낡음';
    let gap = st === '거래 사건 끊김';
    let live = st === '판매 중' || auto || back || stale || gap || supp || budget;
    let noin = st === '제어 입력 없음';
    let t0 = st === 'T=0' || st === '수집 장애' || noin || menu || viewer;
    let shell0 = t0 || live;
    let t30 = st === 'T-30분 점검';
    let after = st === '종료 후 리포트';
    let entry = st === '입장 탭';
    function on(b: any) { return b ? 'is-active' : ''; }
    function sel(b: any) { return b ? 'true' : 'false'; }
    return {
      isSupp: supp,
      notSupp: !supp,
      isB50: b50,
      isB100: b100,
      isBudget: budget,
      notBudget: !budget,
      notSuppBud: !supp && !budget,
      raiseStop: budget,
      sevSupp: supp,
      sevBud: budget,
      sevEmpty: empty,
      isEmpty: empty,
      notEmpty: !empty,
      isViewer: viewer,
      notViewer: !viewer,
      isT0Shell: shell0,
      isT0Grid: t0,
      notT0: !shell0 && !empty,
      isPaused: shell0 && !noin && !budget,
      seatBan: shell0 && !budget,
      isNoInput: noin,
      sev1Cut: !noin,
      isLive: live,
      isAuto: auto,
      isBack: back,
      notBack: !back,
      freshOk: !back && !stale,
      isStale: stale,
      notStale: !stale,
      isGap: gap,
      liveBase: live && !auto,
      ctlNormal: st === 'T=0' || menu || viewer,
      isNormal: st === 'T=0' || menu || noin || viewer,
      isDown: st === '수집 장애',
      isT30: t30,
      isAfter: after,
      isEntry: entry,
      isMenu: menu,
      sevA: ((shell0 && !noin && !supp && !budget) || t30) && !auto,
      sevB: auto,
      tab: { t30: on(t30), t0: on(t0), live: on(live), after: on(after), entry: on(entry) },
      sel: { t30: sel(t30), t0: sel(t0), live: sel(live), after: sel(after), entry: sel(entry) }
    };
  }

type V = ReturnType<typeof valsM>;

// 보드 루트: {"class": "pk dark cs cs-compact", "style": "width:360px;min-height:4150px"}

// <main class="cs-main" id="main">
export function MainM({ v, close, ctx }: { v: V; close?: () => void; ctx: DashCtx }) {
  void v; void close; void ctx;
  return (
    <>
    <div className="col" style={{ gap: "8px" }}>
      <h1 className="t-lg">중앙 관제 대시보드</h1>
      {v.notEmpty ? (
        <>
          <div className="col t-sm" style={{ gap: "4px" }} role="group" aria-label="회차 개요">
            <span className="fw-b">LUMEN 콘서트 2026 서울 · 1회차 10/25(일) 18:00 KST</span>
            {' '}
            <span className="row wrap" style={{ gap: "4px 6px" }}>
              <span className="muted">피켓 아레나 2,400석</span>
              <span className="badge">대형</span>
              <span className="badge badge-primary">하이브리드</span>
              <span className="badge">좌석 직접 선택</span>
            </span>
            {' '}
            <span className="muted">결제사 기본 토스페이먼츠 · 대체 포트원</span>
            {' '}
            {v.isT0Shell ? (
              <>
                <span className="muted">오픈 10/14(수) 20:00 KST · 4분 12초 지남 · 동시 진행 회차 3(대형 1·중형 2)</span>
              </>
            ) : null}
            {' '}
            {v.isT30 ? (
              <>
                <span className="muted">오픈 10/14(수) 20:00 KST · 27분 20초 남음 · 로비 19:50</span>
              </>
            ) : null}
            {' '}
            {v.isAfter ? (
              <>
                <span className="muted">오픈 10/14(수) 20:00 KST · 6분 38초에 매진</span>
              </>
            ) : null}
            {' '}
            {v.isEntry ? (
              <>
                <span className="muted">공연 당일 · 입장 시작 16:30 · 공연 18:00 · 재입장 불가</span>
              </>
            ) : null}
          </div>
        </>
      ) : null}
      <div className="row wrap" style={{ gap: "6px 16px" }}>
        <Link to="/audit" className="link-more">
          감사 타임라인
          <i className="ic ic-chevron-right" aria-hidden="true" />
        </Link>
        <a href="https://grafana.ops.peaket.example/d/onsale" target="_blank" rel="noreferrer" className="link-more">
          Grafana 서비스 대시보드
          <i className="ic ic-external" aria-hidden="true" />
        </a>
      </div>
    </div>
    {v.isNoInput ? (
      <>
        <div className="banner banner-danger" role="alert">
          <i className="ic ic-alert-circle" aria-hidden="true" />
          <div className="banner-body">
            <span className="banner-title">자동 제어 입력이 끊겼습니다 · 목표를 1,000명으로 유지합니다</span>
            20:03:38 KST부터 purchase-svc 지표가 들어오지 않아 20:04:08 KST에 자동 조절과 버짓 연동 감축을 멈췄습니다. 목표를 늘리지도 줄이지도 않습니다. 운영 명령(명령 1·2·3·6)은 그대로 쓸 수 있습니다. 지표가 돌아오면 감축은 바로 다시 하고, 증액은 확인을 받은 뒤에 다시 합니다.
            <div className="row" style={{ gap: "14px", marginTop: "8px" }}>
              <a href="https://runbook.ops.peaket.example/RB-09" target="_blank" rel="noreferrer" className="link-more">
                런북 RB-09
                <i className="ic ic-chevron-right" aria-hidden="true" />
              </a>
              <a href="https://grafana.ops.peaket.example/d/onsale" target="_blank" rel="noreferrer" className="link-more">
                Grafana
                <i className="ic ic-external" aria-hidden="true" />
              </a>
            </div>
          </div>
        </div>
      </>
    ) : null}
    {' '}
    {v.isViewer ? (
      <>
        <div className="banner banner-info" role="status">
          <i className="ic ic-eye" aria-hidden="true" />
          <div className="banner-body">
            <span className="banner-title">읽기 전용(viewer)입니다</span>
            판정·명령·결정 기록 버튼은 보이지 않습니다. 숫자와 경보는 다른 역할과 같게 보입니다.
          </div>
        </div>
      </>
    ) : null}
    {' '}
    {v.isSupp ? (
      <>
        <div className="banner banner-danger" role="alert">
          <i className="ic ic-alert-circle" aria-hidden="true" />
          <div className="banner-body">
            <span className="banner-title">SEV1 · 대기열 진입 에러 버짓 10배 속도로 소진 중</span>
            2분 창과 20초 창에서 허용 소진 속도의 10배를 넘었습니다(경보 시점 예산 소모 29%). 시작 20:04:02 KST · 온콜을 불렀습니다. 대기열 진입은 입장 목표 앞에 있는 여정이라 동시 입장 목표는 바꾸지 않고, 그 여정의 자동 보호(진입 Degraded 자동 전환)가 따로 맡습니다. 같은 여정의 SEV2 1건은 알림을 보내지 않고 경보 패널에 접었습니다.
            <div className="row" style={{ gap: "14px", marginTop: "8px" }}>
              <a href="https://runbook.ops.peaket.example/" target="_blank" rel="noreferrer" className="link-more">
                런북
                <i className="ic ic-chevron-right" aria-hidden="true" />
              </a>
              <a href="https://grafana.ops.peaket.example/d/onsale" target="_blank" rel="noreferrer" className="link-more">
                Grafana
                <i className="ic ic-external" aria-hidden="true" />
              </a>
            </div>
          </div>
        </div>
      </>
    ) : null}
    {' '}
    {v.isB50 ? (
      <>
        <div className="banner banner-warning" role="status">
          <i className="ic ic-alert" aria-hidden="true" />
          <div className="banner-body">
            <span className="banner-title">자동 증액이 멈췄습니다. 명령 1로 목표를 정하세요</span>
            좌석 홀드가 온세일 에러 버짓의 50%를 넘게 써서, 시스템이 20:04:05 KST에 동시 입장 목표를 1,500명에서 1,000명으로 낮췄습니다(50% 감축이 안전 하한 1,000명에서 멈춤). 감축은 입장 목표에 묶인 네 여정(좌석 홀드·좌석 상태 전파·결제 접수·결제 확정)의 예산으로만 합니다. 운영자가 명령 1로 목표를 정할 때까지 자동 증액을 멈춥니다.
            <div className="row" style={{ gap: "14px", marginTop: "8px" }}>
              <Link to="/commands" className="link-more">
                명령 1 동시 입장 목표
                <i className="ic ic-chevron-right" aria-hidden="true" />
              </Link>
              <a href="https://runbook.ops.peaket.example/" target="_blank" rel="noreferrer" className="link-more">
                런북
                <i className="ic ic-chevron-right" aria-hidden="true" />
              </a>
            </div>
          </div>
        </div>
      </>
    ) : null}
    {' '}
    {v.isB100 ? (
      <>
        <div className="banner banner-danger" role="alert">
          <i className="ic ic-alert-circle" aria-hidden="true" />
          <div className="banner-body">
            <span className="banner-title">좌석 홀드 에러 버짓을 모두 썼습니다 · Degraded 후보를 검토하세요</span>
            온세일 예산 75건을 모두 썼습니다(20:04:09 KST). 시스템이 감내 모드 후보를 골랐고 포스트모템을 소집했습니다. 전환은 명령 6으로 하며 운영자 2인 승인이 필요합니다. 동시 입장 목표는 1,000명(안전 하한)이고, 명령 1로 정할 때까지 자동 증액은 멈춰 있습니다.
            <div className="row" style={{ gap: "14px", marginTop: "8px" }}>
              <a href="https://runbook.ops.peaket.example/" target="_blank" rel="noreferrer" className="link-more">
                런북
                <i className="ic ic-chevron-right" aria-hidden="true" />
              </a>
            </div>
          </div>
        </div>
      </>
    ) : null}
    {' '}
    {v.seatBan ? (
      <>
        <div className="banner banner-warning" role="status">
          <i className="ic ic-alert" aria-hidden="true" />
          <div className="banner-body">
            <span className="banner-title">경고: 좌석 홀드 에러 버짓 3.2× 속도로 소진 중 · SEV2</span>
            5분 창과 25초 창에서 허용 소진 속도의 3배를 넘었습니다(경보 시점 예산 소모 21%). 시작 20:03:41 KST · 자동 조치 없이 운영자가 판단합니다. 2분·20초 창 10배(경보 시점 예산 29%)에 닿으면{' '}
            {v.sev1Cut ? (
              <>
                SEV1로 올라가고 동시 입장 목표를 50% 자동 감축합니다.
              </>
            ) : null}
            {v.isNoInput ? (
              <>
                SEV1로 올라갑니다. 자동 제어 입력이 없는 동안에는 50% 자동 감축을 하지 않습니다.
              </>
            ) : null}
            <div className="row" style={{ gap: "14px", marginTop: "8px" }}>
              <a href="https://runbook.ops.peaket.example/" target="_blank" rel="noreferrer" className="link-more">
                런북
                <i className="ic ic-chevron-right" aria-hidden="true" />
              </a>
              {v.notViewer ? (
                <>
                  <Link to="/commands" className="link-more">
                    운영 명령
                    <i className="ic ic-chevron-right" aria-hidden="true" />
                  </Link>
                </>
              ) : null}
            </div>
          </div>
        </div>
      </>
    ) : null}
    {' '}
    {v.isDown ? (
      <>
        <div className="banner banner-warning" role="status">
          <i className="ic ic-pulse" aria-hidden="true" />
          <div className="banner-body">
            <span className="banner-title">시스템 코어 지표만 보입니다</span>
            관제 수집(스트리밍 집계)이 늦어 20:03:20 KST부터 비즈니스 위젯을 시스템 코어 지표로 축소 표시합니다. 비즈니스 숫자는 최대 60초 늦을 수 있습니다. 운영 명령 전달은 관측 경로와 별개라 그대로 동작합니다.
          </div>
        </div>
      </>
    ) : null}
    {' '}
    {v.isT30 ? (
      <>
        <div className="banner banner-warning" role="status">
          <i className="ic ic-alert" aria-hidden="true" />
          <div className="banner-body">
            <span className="banner-title">SEV2 · 노드 시계 오프셋이 20ms를 넘었습니다</span>
            노드 2대, 최대 31ms. 오픈 30분 전 점검의 필수 항목이 실패해 지금 판정은 No-Go입니다. 시작 19:28:05 KST
            <div className="row" style={{ gap: "14px", marginTop: "8px" }}>
              <a href="https://runbook.ops.peaket.example/" target="_blank" rel="noreferrer" className="link-more">
                런북
                <i className="ic ic-chevron-right" aria-hidden="true" />
              </a>
              <a href="https://grafana.ops.peaket.example/d/onsale" target="_blank" rel="noreferrer" className="link-more">
                Grafana
                <i className="ic ic-external" aria-hidden="true" />
              </a>
            </div>
          </div>
        </div>
      </>
    ) : null}
    {' '}
    {v.isEntry ? (
      <>
        <div className="col" style={{ gap: "8px" }}>
          <div className="banner banner-warning" role="status">
            <i className="ic ic-wifi-off" aria-hidden="true" />
            <div className="banner-body">
              <span className="banner-title">SEV2 · 스캐너 1대의 마지막 동기화가 2분을 넘었습니다</span>
              서문-02 · 2분 47초 전 · 업로드 대기 20건. 판정은 오프라인으로 계속되지만 양도·취소 반영이 늦어질 수 있습니다. 서문 구역 책임자 스캐너와 파트너 콘솔에도 알렸습니다. 시작 17:11:43 KST
              <div className="row" style={{ gap: "14px", marginTop: "8px" }}>
                <a href="https://runbook.ops.peaket.example/" target="_blank" rel="noreferrer" className="link-more">
                  런북
                  <i className="ic ic-chevron-right" aria-hidden="true" />
                </a>
                <a href="https://grafana.ops.peaket.example/d/onsale" target="_blank" rel="noreferrer" className="link-more">
                  Grafana
                  <i className="ic ic-external" aria-hidden="true" />
                </a>
              </div>
            </div>
          </div>
          <div className="banner banner-warning" role="status">
            <i className="ic ic-flag" aria-hidden="true" />
            <div className="banner-body">
              <span className="banner-title">SEV3 · 중복 입장 이상 표시가 10분에 12건입니다</span>
              기준 10분에 10건 [가정]을 넘었습니다. 하나하나의 현장 대응은 동문 구역 책임자와 파트너가 하고, 관제는 감시만 합니다. 시작 17:09:20 KST
            </div>
          </div>
        </div>
      </>
    ) : null}
    {' '}
    {v.notEmpty ? (
      <>
        <div className="tabs tabs-scroll" role="tablist" aria-label="온세일 단계">
          {v.isAfter ? (
            <>
              <span aria-hidden="true" style={{ flex: "none", marginLeft: "-44px" }} />
            </>
          ) : null}
          {' '}
          {v.isEntry ? (
            <>
              <span aria-hidden="true" style={{ flex: "none", marginLeft: "-154px" }} />
            </>
          ) : null}
          {' '}
          <Link className={`tab ${v.tab.t30}`} role="tab" to={ctx.tabHref('t30')} id="tab-t30" aria-selected={(v.sel.t30) as AriaBool} aria-controls="panel-t30">
            T-30분 점검
            {v.isT30 ? (
              <>
                <span className="badge badge-primary">지금</span>
              </>
            ) : null}
          </Link>
          {' '}
          <Link className={`tab ${v.tab.t0}`} role="tab" to={ctx.tabHref('t0')} id="tab-t0" aria-selected={(v.sel.t0) as AriaBool} aria-controls="panel-t0">
            T=0
            {v.isT0Shell ? (
              <>
                <span className="badge badge-primary">지금</span>
              </>
            ) : null}
          </Link>
          {' '}
          <Link className={`tab ${v.tab.live}`} role="tab" to={ctx.tabHref('live')} id="tab-live" aria-selected={(v.sel.live) as AriaBool} aria-controls="panel-live">
            판매 중
          </Link>
          {' '}
          <Link className={`tab ${v.tab.after}`} role="tab" to={ctx.tabHref('after')} id="tab-after" aria-selected={(v.sel.after) as AriaBool} aria-controls="panel-after">
            종료 후
            {v.isAfter ? (
              <>
                <span className="badge badge-primary">지금</span>
              </>
            ) : null}
          </Link>
          {' '}
          <Link className={`tab ${v.tab.entry}`} role="tab" to={ctx.tabHref('entry')} id="tab-entry" aria-selected={(v.sel.entry) as AriaBool} aria-controls="panel-entry">
            입장(공연 당일)
            {v.isEntry ? (
              <>
                <span className="badge badge-primary">지금</span>
              </>
            ) : null}
          </Link>
        </div>
      </>
    ) : null}
    {' '}
    {v.isEmpty ? (
      <>
        <section className="widget" role="region" aria-labelledby="w-empty">
          <div className="state" style={{ padding: "56px 24px" }}>
            <span className="state-icon"><i className="ic ic-chart" aria-hidden="true" /></span>
            <h2 className="t-lg" id="w-empty">모니터링 중인 공연이 없습니다</h2>
            <p className="t-sm muted">지금 지켜보는 회차가 없습니다. 오픈을 앞둔 회차는 T-30분 점검부터 여기에 나타납니다.</p>
          </div>
        </section>
        <section className="widget" role="region" aria-labelledby="w-empty-pf">
          <div className="widget-head">
            <h2 className="t-sm fw-b" id="w-empty-pf">경보 패널</h2>
            <div className="actions">
              <Link to="/audit" className="link-more">
                경보 전체 목록
                <i className="ic ic-chevron-right" aria-hidden="true" />
              </Link>
            </div>
          </div>
          <div className="widget-body">
            <div className="row" role="group" aria-label="SEV1 경보" style={{ gap: "8px", padding: "7px 8px", borderRadius: "6px", boxShadow: "inset 0 0 0 1px var(--border)" }}>
              <span className="badge badge-danger">SEV1</span>
              <span className="t-sm muted">울리는 경보 없음</span>
            </div>
            <div className="col" role="group" aria-labelledby="w-empty-pf-h" style={{ gap: "6px" }}>
              <h3 className="eyebrow" id="w-empty-pf-h">플랫폼·위생·법정</h3>
              <ul className="col">
                <li className="row between wrap" style={{ gap: "4px 12px", padding: "7px 8px", borderRadius: "6px", boxShadow: "inset 0 0 0 1px var(--border)" }}>
                  <span className="row" style={{ gap: "8px" }}>
                    <span className="badge">SEV3</span>
                    <span className="t-sm">4건 · 다음 업무일에 처리(GitHub Issues 자동 등록)</span>
                  </span>
                  <a href="#" className="link-more">
                    4건 보기
                    <i className="ic ic-chevron-right" aria-hidden="true" />
                  </a>
                </li>
              </ul>
            </div>
          </div>
        </section>
      </>
    ) : null}
    {' '}
    {v.isT0Grid ? (
      <>
        <div className="col" role="tabpanel" id="panel-t0" aria-labelledby="tab-t0" style={{ gap: "12px" }}>
          <section className="widget" role="region" aria-labelledby="w-alert">
            <div className="widget-head">
              <h2 className="t-sm fw-b" id="w-alert">경보 패널</h2>
              <div className="actions">
                <Link to="/audit" className="link-more">
                  경보 전체 목록
                  <i className="ic ic-chevron-right" aria-hidden="true" />
                </Link>
              </div>
            </div>
            <div className="widget-body">
              <div className="row" style={{ gap: "10px", padding: "10px 12px", borderRadius: "var(--r-md)", boxShadow: "inset 0 0 0 1px var(--border)" }}>
                <span className="badge badge-danger">SEV1</span>
                <span className="t-sm muted">울리는 경보 없음</span>
              </div>
              <div className="col" style={{ gap: "8px" }} role="group" aria-labelledby="w-alert-ev">
                <h3 className="eyebrow" id="w-alert-ev">이 회차 판단 · LUMEN 10/25 18:00</h3>
                <ul className="col" style={{ gap: "8px" }}>
                  {v.isNoInput ? (
                    <>
                      <li className="col" style={{ gap: "6px", padding: "10px 12px", borderRadius: "var(--r-md)", background: "var(--warning-subtle)" }}>
                        <div className="row between" style={{ gap: "8px" }}>
                          <span className="badge badge-warning">
                            <i className="ic ic-alert" aria-hidden="true" />
                            SEV2
                          </span>
                          <span className="t-xs num">20:04:08 KST · 4초 전</span>
                        </div>
                        <strong className="t-sm">자동 제어 입력 없음(purchase-svc 지표 30초 넘게 없음)</strong>
                        {' '}
                        <span className="t-xs muted">대응: 운영자 판단(명령 1·2)</span>
                        <div className="row wrap" style={{ gap: "6px 14px" }}>
                          <a href="https://runbook.ops.peaket.example/" target="_blank" rel="noreferrer" className="link-more">
                            런북
                            <i className="ic ic-chevron-right" aria-hidden="true" />
                          </a>
                          <a href="https://grafana.ops.peaket.example/d/onsale" target="_blank" rel="noreferrer" className="link-more">
                            Grafana
                            <i className="ic ic-external" aria-hidden="true" />
                          </a>
                        </div>
                        <span className="t-xs muted">관측 경로와 별개로 입장 제어가 알린 경보입니다</span>
                      </li>
                    </>
                  ) : null}
                  <li className="col" style={{ gap: "6px", padding: "10px 12px", borderRadius: "var(--r-md)", background: "var(--warning-subtle)" }}>
                    <div className="row between" style={{ gap: "8px" }}>
                      <span className="badge badge-warning">
                        <i className="ic ic-alert" aria-hidden="true" />
                        SEV2
                      </span>
                      <span className="t-xs num">20:03:41 KST · 31초 전</span>
                    </div>
                    <strong className="t-sm">좌석 홀드 에러 버짓 3배 소진(5분·25초 창)</strong>
                    {' '}
                    <span className="t-xs muted">대응: 운영자 상황 판단</span>
                    <div className="row wrap" style={{ gap: "6px 14px" }}>
                      <a href="https://runbook.ops.peaket.example/" target="_blank" rel="noreferrer" className="link-more">
                        런북
                        <i className="ic ic-chevron-right" aria-hidden="true" />
                      </a>
                      <a href="https://grafana.ops.peaket.example/d/onsale" target="_blank" rel="noreferrer" className="link-more">
                        Grafana
                        <i className="ic ic-external" aria-hidden="true" />
                      </a>
                      <a href="https://grafana.ops.peaket.example/d/onsale" target="_blank" rel="noreferrer" className="link-more" aria-label="실패 사건 보기, Grafana Explore, 새 탭">
                        실패 사건 보기
                        <i className="ic ic-external" aria-hidden="true" />
                      </a>
                    </div>
                  </li>
                </ul>
              </div>
              <div className="col" style={{ gap: "8px" }} role="group" aria-labelledby="w-alert-pf">
                <h3 className="eyebrow" id="w-alert-pf">플랫폼·위생·법정</h3>
                <ul className="col" style={{ gap: "8px" }}>
                  <li className="col" style={{ gap: "6px", padding: "10px 12px", borderRadius: "var(--r-md)", boxShadow: "inset 0 0 0 1px var(--border)" }}>
                    <span className="badge" style={{ alignSelf: "flex-start" }}>SEV3</span>
                    {' '}
                    <span className="t-sm">4건 · 다음 업무일에 처리(GitHub Issues 자동 등록)</span>
                    {' '}
                    <span className="t-xs muted">대응: 관제 표시만</span>
                    {' '}
                    <a href="#" className="link-more">
                      4건 보기
                      <i className="ic ic-chevron-right" aria-hidden="true" />
                    </a>
                  </li>
                </ul>
              </div>
              <p className="t-xs muted">
                판단 순서: 돈과 좌석(불변식) → 여정별 남은 허용 실패와 소진 속도 → 4대 신호 → 몇 분짜리 분류 → 되돌릴 수 있는 약한 조치부터(최근 변경이면 되돌리기, 명령 1 → 2 → 6 → 3) → 알림
              </p>
            </div>
          </section>
          {v.ctlNormal ? (
            <>
              <details className="widget" open>
                <summary className="widget-head">
                  <span>자동 제어</span>
                  <span className="fold-meta">
                    <span className="slo slo-burning">운영자 지정</span>
                    <span>목표 1,000명</span>
                    <i className="ic ic-chevron-down fold-ic" aria-hidden="true" />
                  </span>
                </summary>
                <div className="widget-body">
                  <div className="row" style={{ justifyContent: "flex-end" }}>
                    <a href="https://grafana.ops.peaket.example/d/onsale" target="_blank" rel="noreferrer" className="link-more" aria-label="자동 제어 자세히 보기, Grafana, 새 탭">
                      자세히 보기
                      <i className="ic ic-external" aria-hidden="true" />
                    </a>
                  </div>
                  <div className="col" style={{ gap: "2px" }}>
                    <span className="stat-label">동시 입장 목표</span>
                    <span className="stat-value">1,000명</span>
                    <span className="stat-meta">명령 1로 낮춤 · 안전 한계 1,000~8,000명(토스페이먼츠 공연)</span>
                  </div>
                  <div className="col" style={{ gap: "4px" }}>
                    <div className="row between t-xs">
                      <span className="row muted" style={{ gap: "4px" }}>
                        예매 단계 인원
                        <span className="badge badge-outline">잠정</span>
                      </span>
                      <span className="num fw-b">1,920명 · 192%</span>
                    </div>
                    <div className="progress" role="progressbar" aria-label="예매 단계 인원" aria-valuetext="목표의 192%. 목표 아래로 내려올 때까지 새 입장을 멈춥니다" aria-valuenow={100} aria-valuemin={0} aria-valuemax={100}>
                      <span style={{ width: "100%" }} />
                    </div>
                    <span className="t-xs muted">목표 아래로 내려올 때까지 새 입장을 멈춥니다</span>
                  </div>
                  <ul className="col t-xs" style={{ gap: "4px" }}>
                    <li className="row between" style={{ gap: "8px" }}>
                      <span className="muted">자동 조절(AIMD)</span>
                      <span>멈춤 · 13:12 남음</span>
                    </li>
                    <li className="row between" style={{ gap: "8px", alignItems: "flex-start" }}>
                      <span className="muted nowrap">최근 조정</span>
                      <span className="num" style={{ textAlign: "right" }}>20:02:24 KST · 5,000 → 1,000(명령 1)</span>
                    </li>
                    <li className="row between" style={{ gap: "8px" }}>
                      <span className="muted">버짓 연동 감축</span>
                      <span>없음</span>
                    </li>
                    <li className="row between" style={{ gap: "8px" }}>
                      <span className="muted">운영자 지정(15분 멈춤)</span>
                      <span>민호 · 13:12 남음</span>
                    </li>
                  </ul>
                  {v.notViewer ? (
                    <>
                      <Link to="/commands" className="link-more">
                        명령 1 동시 입장 목표
                        <i className="ic ic-chevron-right" aria-hidden="true" />
                      </Link>
                    </>
                  ) : null}
                  <p className="t-xs" style={{ paddingTop: "8px", borderTop: "1px solid var(--border)" }}>
                    <span className="fw-b">판단:</span>
                    {' '}기대와 다르면 자동 제어 상태를 보고 명령 1·2를 씁니다.
                  </p>
                </div>
              </details>
            </>
          ) : null}
          {' '}
          {v.isDown ? (
            <>
              <details className="widget">
                <summary className="widget-head">
                  <span>자동 제어</span>
                  <span className="fold-meta">
                    <span className="slo slo-burning">운영자 지정</span>
                    <span>목표 1,000명</span>
                    <i className="ic ic-chevron-down fold-ic" aria-hidden="true" />
                  </span>
                </summary>
                <div className="widget-body">
                  <div className="row" style={{ justifyContent: "flex-end" }}>
                    <a href="https://grafana.ops.peaket.example/d/onsale" target="_blank" rel="noreferrer" className="link-more" aria-label="자동 제어 자세히 보기, Grafana, 새 탭">
                      자세히 보기
                      <i className="ic ic-external" aria-hidden="true" />
                    </a>
                  </div>
                  <div className="col" style={{ gap: "2px" }}>
                    <span className="stat-label">동시 입장 목표</span>
                    <span className="stat-value">1,000명</span>
                    <span className="stat-meta">명령 1로 낮춤 · 안전 한계 1,000~8,000명(토스페이먼츠 공연)</span>
                  </div>
                  <div className="col" style={{ gap: "4px" }}>
                    <div className="row between t-xs">
                      <span className="row muted" style={{ gap: "4px" }}>
                        예매 단계 인원
                        <span className="badge badge-outline">잠정</span>
                      </span>
                      <span className="num fw-b">1,920명 · 192%</span>
                    </div>
                    <div className="progress" role="progressbar" aria-label="예매 단계 인원" aria-valuetext="목표의 192%. 목표 아래로 내려올 때까지 새 입장을 멈춥니다" aria-valuenow={100} aria-valuemin={0} aria-valuemax={100}>
                      <span style={{ width: "100%" }} />
                    </div>
                    <span className="t-xs muted">목표 아래로 내려올 때까지 새 입장을 멈춥니다</span>
                  </div>
                  <ul className="col t-xs" style={{ gap: "4px" }}>
                    <li className="row between" style={{ gap: "8px" }}>
                      <span className="muted">자동 조절(AIMD)</span>
                      <span>멈춤 · 13:12 남음</span>
                    </li>
                    <li className="row between" style={{ gap: "8px", alignItems: "flex-start" }}>
                      <span className="muted nowrap">최근 조정</span>
                      <span className="num" style={{ textAlign: "right" }}>20:02:24 KST · 5,000 → 1,000(명령 1)</span>
                    </li>
                    <li className="row between" style={{ gap: "8px" }}>
                      <span className="muted">버짓 연동 감축</span>
                      <span>없음</span>
                    </li>
                    <li className="row between" style={{ gap: "8px" }}>
                      <span className="muted">운영자 지정(15분 멈춤)</span>
                      <span>민호 · 13:12 남음</span>
                    </li>
                  </ul>
                  {v.notViewer ? (
                    <>
                      <Link to="/commands" className="link-more">
                        명령 1 동시 입장 목표
                        <i className="ic ic-chevron-right" aria-hidden="true" />
                      </Link>
                    </>
                  ) : null}
                  <p className="t-xs" style={{ paddingTop: "8px", borderTop: "1px solid var(--border)" }}>
                    <span className="fw-b">판단:</span>
                    {' '}기대와 다르면 자동 제어 상태를 보고 명령 1·2를 씁니다.
                  </p>
                </div>
              </details>
            </>
          ) : null}
          {' '}
          {v.isNoInput ? (
            <>
              <details className="widget" open>
                <summary className="widget-head">
                  <span>자동 제어</span>
                  <span className="fold-meta">
                    <span className="slo slo-breached">입력 없음</span>
                    <span>목표 1,000명</span>
                    <i className="ic ic-chevron-down fold-ic" aria-hidden="true" />
                  </span>
                </summary>
                <div className="widget-body">
                  <div className="row" style={{ justifyContent: "flex-end" }}>
                    <a href="https://grafana.ops.peaket.example/d/onsale" target="_blank" rel="noreferrer" className="link-more" aria-label="자동 제어 자세히 보기, Grafana, 새 탭">
                      자세히 보기
                      <i className="ic ic-external" aria-hidden="true" />
                    </a>
                  </div>
                  <span className="badge badge-danger" style={{ alignSelf: "flex-start" }}>
                    <i className="ic ic-alert-circle" aria-hidden="true" />
                    입력 없음 · 20:04:08부터
                  </span>
                  <div className="col" style={{ gap: "2px" }}>
                    <span className="stat-label">동시 입장 목표</span>
                    <span className="stat-value">1,000명</span>
                    <span className="stat-meta">운영자 지정 · 유지</span>
                  </div>
                  <ul className="col t-xs" style={{ gap: "4px" }}>
                    <li className="row between" style={{ gap: "8px" }}>
                      <span className="muted">자동 조절(AIMD)</span>
                      <span>멈춤(입력 없음)</span>
                    </li>
                    <li className="row between" style={{ gap: "8px" }}>
                      <span className="muted">버짓 연동 감축</span>
                      <span>멈춤(입력 없음)</span>
                    </li>
                    <li className="row between" style={{ gap: "8px", alignItems: "flex-start" }}>
                      <span className="muted nowrap">운영자 지정 유예</span>
                      <span style={{ textAlign: "right" }}>13:12 남음 · 유예 시계는 계속 갑니다</span>
                    </li>
                  </ul>
                  <h3 className="eyebrow">입력 상태</h3>
                  <div className="row between t-xs muted" style={{ gap: "8px" }}>
                    <span>입력</span>
                    <span>마지막 표본 · 상태</span>
                  </div>
                  <ul className="col" style={{ gap: "4px" }}>
                    <li className="row between" style={{ gap: "8px", padding: "7px 6px", borderRadius: "6px", background: "var(--danger-subtle)" }}>
                      <span className="t-sm fw-b">뒤쪽 p99(purchase-svc)</span>
                      <span className="row" style={{ gap: "8px" }}>
                        <span className="num t-xs">34초 전</span>
                        <span className="slo slo-breached">끊김</span>
                      </span>
                    </li>
                    <li className="row between" style={{ gap: "8px", padding: "7px 6px", borderRadius: "6px", background: "var(--danger-subtle)" }}>
                      <span className="t-sm fw-b">오류율(purchase-svc)</span>
                      <span className="row" style={{ gap: "8px" }}>
                        <span className="num t-xs">34초 전</span>
                        <span className="slo slo-breached">끊김</span>
                      </span>
                    </li>
                    <li className="row between" style={{ gap: "8px", padding: "7px 6px" }}>
                      <span className="t-sm">예산 소진 신호(게이트웨이)</span>
                      <span className="row" style={{ gap: "8px" }}>
                        <span className="num t-xs">2초 전</span>
                        <span className="slo slo-ok">정상</span>
                      </span>
                    </li>
                  </ul>
                  <p className="t-xs muted">마지막 표본이 30초 [가정]보다 오래되면 입력 없음으로 봅니다. 10초 [가정] 이어서 들어오면 감축은 바로 다시 하고, 증액은 운영자 확인(자동 조절 복귀 확인) 뒤에 합니다.</p>
                  {v.notViewer ? (
                    <>
                      <Link to="/commands" className="link-more">
                        명령 1 동시 입장 목표
                        <i className="ic ic-chevron-right" aria-hidden="true" />
                      </Link>
                    </>
                  ) : null}
                  <p className="t-xs" style={{ paddingTop: "8px", borderTop: "1px solid var(--border)" }}>
                    <span className="fw-b">판단:</span>
                    {' '}기대와 다르면 자동 제어 상태를 보고 명령 1·2를 씁니다.
                  </p>
                </div>
              </details>
            </>
          ) : null}
          <details className="widget">
            <summary className="widget-head">
              <span>여정별 오류율·버짓 소진</span>
              <span className="fold-meta">
                <span className="slo slo-burning">경고 SEV2</span>
                <span>홀드 3.2×</span>
                <i className="ic ic-chevron-down fold-ic" aria-hidden="true" />
              </span>
            </summary>
            <div className="widget-body" style={{ gap: "8px" }}>
              <div className="row" style={{ justifyContent: "flex-end" }}>
                <a href="https://grafana.ops.peaket.example/d/onsale" target="_blank" rel="noreferrer" className="link-more" aria-label="여정별 오류율·버짓 소진 자세히 보기, Grafana, 새 탭">
                  자세히 보기
                  <i className="ic ic-external" aria-hidden="true" />
                </a>
              </div>
              <div className="row between t-xs muted">
                <span>여정</span>
                <span>오류율 · 소진 배수 · 판정</span>
              </div>
              <ul className="col">
                <li className="row between" style={{ gap: "8px", padding: "7px 0", borderBottom: "1px solid var(--border)" }}>
                  <span className="t-sm">공연 상세</span>
                  <span className="row" style={{ gap: "8px" }}>
                    <span className="num t-xs">0.002% · 0.2×</span>
                    <span className="slo slo-ok">정상</span>
                  </span>
                </li>
                <li className="row between" style={{ gap: "8px", padding: "7px 0", borderBottom: "1px solid var(--border)" }}>
                  <span className="t-sm">대기열 진입</span>
                  <span className="row" style={{ gap: "8px" }}>
                    <span className="num t-xs">0.04% · 0.4×</span>
                    <span className="slo slo-ok">정상</span>
                  </span>
                </li>
                <li className="row between" style={{ gap: "8px", padding: "7px 6px", borderRadius: "6px", background: "var(--warning-subtle)" }}>
                  <span className="t-sm fw-b">좌석 홀드</span>
                  <span className="row" style={{ gap: "8px" }}>
                    <span className="num t-xs fw-b">0.16% · 3.2×</span>
                    <span className="slo slo-burning">경고 SEV2</span>
                  </span>
                </li>
                <li className="row between" style={{ gap: "8px", padding: "7px 0" }}>
                  <span className="t-sm">결제 확정</span>
                  <span className="row" style={{ gap: "8px" }}>
                    <span className="num t-xs">0.06% · 1.2×</span>
                    <span className="slo slo-ok">정상</span>
                  </span>
                </li>
              </ul>
              <p className="t-xs muted">SEV1: 2분·20초 창 10배(경보 시점 예산 29%) · SEV2: 5분·25초 창 3배(21%). 결제 확정은 3배 대신 결제사 쪽 임박 원인으로 판정합니다.</p>
              <p className="t-xs" style={{ paddingTop: "8px", borderTop: "1px solid var(--border)" }}>
                <span className="fw-b">판단:</span>
                {' '}판단 순서 ②. 소진이 이어지면 최근 변경이면 되돌리기(RB-23), 명령 1 → 2 → 6 → 3
              </p>
            </div>
          </details>
          {v.isNormal ? (
            <>
              <details className="widget" open>
                <summary className="widget-head">
                  <span>대기열 진입·입장 처리량</span>
                  <span className="fold-meta">
                    <span className="slo slo-ok">p99 정상</span>
                    <span>입장 0명/초</span>
                    <i className="ic ic-chevron-down fold-ic" aria-hidden="true" />
                  </span>
                </summary>
                <div className="widget-body" style={{ gap: "10px" }}>
                  <div className="row" style={{ justifyContent: "flex-end", gap: "12px" }}>
                    <button className="btn btn-ghost btn-sm" type="button" aria-pressed="false">
                      <i className="ic ic-list" aria-hidden="true" />
                      표로 보기
                    </button>
                    <a href="https://grafana.ops.peaket.example/d/onsale" target="_blank" rel="noreferrer" className="link-more" aria-label="대기열 진입·입장 처리량 자세히 보기, Grafana, 새 탭">
                      자세히 보기
                      <i className="ic ic-external" aria-hidden="true" />
                    </a>
                  </div>
                  <figure className="col" style={{ gap: "2px" }}>
                    <figcaption className="col t-xs" style={{ gap: "2px" }}>
                      <span className="fw-b">진입 요청(초당)</span>
                      <span className="num muted">지금 4,900건 · 최고 18.1만 건(20:00:15)</span>
                    </figcaption>
                    <svg className="chart" viewBox="0 0 320 64" role="img" aria-label="대기열 진입 요청량. 오픈 직후 20:00:15에 초당 18만 1천 건으로 최고였고 설계 피크 20만 건 아래였습니다. 지금은 초당 4,900건입니다.">
                      <line className="grid" x1="30" y1="46" x2="312" y2="46" />
                      <line className="grid" x1="30" y1="27.8" x2="312" y2="27.8" />
                      <line className="line-base" x1="30" y1="9.6" x2="312" y2="9.6" />
                      <text className="axis" x="268" y="21" textAnchor="end">설계 피크 20만/초</text>
                      <text className="axis" x="26" y="49" textAnchor="end">0</text>
                      <text className="axis" x="26" y="31" textAnchor="end">10만</text>
                      <polyline className="line" points="30,45.5 53.5,45.3 77,44.9 80.9,15.5 88.7,13.1 100.5,22 124,32.5 147.5,38.5 171,41.6 194.5,43.5 218,44.4 241.5,44.8 265,45.1 274.4,45.1" />
                      <line className="now" x1="274.4" y1="3" x2="274.4" y2="48" />
                      <text className="axis" x="77" y="61" textAnchor="middle">20:00</text>
                      <text className="axis" x="171" y="61" textAnchor="middle">20:02</text>
                      <text className="axis" x="265" y="61" textAnchor="middle">20:04</text>
                    </svg>
                  </figure>
                  <figure className="col" style={{ gap: "2px" }}>
                    <figcaption className="col t-xs" style={{ gap: "2px" }}>
                      <span className="row between" style={{ gap: "8px" }}>
                        <span className="fw-b">진입 응답 p99</span>
                        <span className="slo slo-ok">정상 · 기준 200ms</span>
                      </span>
                      <span className="num muted">지금 93ms · 최고 171ms</span>
                    </figcaption>
                    <svg className="chart" viewBox="0 0 320 64" role="img" aria-label="대기열 진입 응답 p99. 오픈 직후 최고 171ms로 기준 200ms 아래였고 지금은 93ms입니다.">
                      <line className="grid" x1="30" y1="46" x2="312" y2="46" />
                      <line className="grid" x1="30" y1="30" x2="312" y2="30" />
                      <line className="slo-line" x1="30" y1="14" x2="312" y2="14" />
                      <text className="axis" x="268" y="10" textAnchor="end">기준 200ms</text>
                      <text className="axis" x="26" y="49" textAnchor="end">0</text>
                      <text className="axis" x="26" y="33" textAnchor="end">100</text>
                      <polyline className="line" points="30,31.9 53.5,31.6 77,31.3 80.9,21.7 88.7,18.6 100.5,22.3 124,26.6 147.5,28.7 171,29.8 194.5,30.5 218,30.8 241.5,31 265,31.1 274.4,31.1" />
                      <line className="now" x1="274.4" y1="3" x2="274.4" y2="48" />
                      <text className="axis" x="77" y="61" textAnchor="middle">20:00</text>
                      <text className="axis" x="171" y="61" textAnchor="middle">20:02</text>
                      <text className="axis" x="265" y="61" textAnchor="middle">20:04</text>
                    </svg>
                  </figure>
                  <figure className="col" style={{ gap: "2px" }}>
                    <figcaption className="col t-xs" style={{ gap: "2px" }}>
                      <span className="fw-b">입장 처리량(serving 전진, 초당)</span>
                      <span className="num muted">지금 0명(목표 초과로 멈춤) · 기대 5.6명(목표 1,000 ÷ 평균 체류 3분 [가정])</span>
                    </figcaption>
                    <svg className="chart" viewBox="0 0 320 64" role="img" aria-label="입장 처리량. 20:01부터 초당 27~28명이었고, 20:02:24에 동시 입장 목표를 1,000명으로 낮춘 뒤 예매 단계 인원이 목표를 넘어 지금은 초당 0명입니다. 목표 아래로 내려오면 기대치 초당 5.6명 안팎으로 다시 전진합니다.">
                      <line className="grid" x1="30" y1="46" x2="312" y2="46" />
                      <line className="grid" x1="30" y1="19.4" x2="312" y2="19.4" />
                      <line className="line-base" x1="30" y1="38.5" x2="312" y2="38.5" />
                      <text className="axis" x="268" y="35" textAnchor="end">기대 5.6명/초</text>
                      <text className="axis" x="26" y="49" textAnchor="end">0</text>
                      <text className="axis" x="26" y="22.5" textAnchor="end">20</text>
                      <line className="grid" x1="189.8" y1="3" x2="189.8" y2="48" />
                      <text className="axis" x="186" y="31" textAnchor="end">명령 1 · 1,000명</text>
                      <polyline className="line" points="30,46 77,46 80.9,38 88.7,26 100.5,16 124,10.5 147.5,9.3 171,9 189.8,9.2 192.2,40 194.5,46 274.4,46" />
                      <line className="now" x1="274.4" y1="3" x2="274.4" y2="48" />
                      <text className="axis" x="77" y="61" textAnchor="middle">20:00</text>
                      <text className="axis" x="171" y="61" textAnchor="middle">20:02</text>
                      <text className="axis" x="265" y="61" textAnchor="middle">20:04</text>
                    </svg>
                  </figure>
                  <div className="legend" aria-hidden="true">
                    <span className="legend-item">
                      <span className="swatch" />
                      관측
                    </span>
                    <span className="legend-item">
                      <span className="swatch" style={{ background: "var(--danger)" }} />
                      SLO 기준(점선)
                    </span>
                    <span className="legend-item">
                      <span className="swatch" style={{ background: "var(--text-muted)" }} />
                      설계 피크·기대치(점선)
                    </span>
                    <span className="legend-item">
                      <span className="swatch" style={{ width: "2px", height: "12px", background: "var(--text)" }} />
                      지금 20:04:12
                    </span>
                  </div>
                  <p className="t-xs" style={{ paddingTop: "8px", borderTop: "1px solid var(--border)" }}>
                    <span className="fw-b">판단:</span>
                    {' '}진입이 기준 밖이면 진입 Degraded 자동 전환을 확인하고, 한 대역에 몰리면 명령 4. 입장 처리량이 기대와 다르면 명령 1·2
                  </p>
                </div>
              </details>
            </>
          ) : null}
          {' '}
          {v.isDown ? (
            <>
              <details className="widget">
                <summary className="widget-head">
                  <span>대기열 진입·입장 처리량</span>
                  <span className="fold-meta">
                    <span className="slo slo-ok">p99 정상</span>
                    <span>입장 0명/초</span>
                    <i className="ic ic-chevron-down fold-ic" aria-hidden="true" />
                  </span>
                </summary>
                <div className="widget-body" style={{ gap: "10px" }}>
                  <div className="row" style={{ justifyContent: "flex-end", gap: "12px" }}>
                    <button className="btn btn-ghost btn-sm" type="button" aria-pressed="false">
                      <i className="ic ic-list" aria-hidden="true" />
                      표로 보기
                    </button>
                    <a href="https://grafana.ops.peaket.example/d/onsale" target="_blank" rel="noreferrer" className="link-more" aria-label="대기열 진입·입장 처리량 자세히 보기, Grafana, 새 탭">
                      자세히 보기
                      <i className="ic ic-external" aria-hidden="true" />
                    </a>
                  </div>
                  <figure className="col" style={{ gap: "2px" }}>
                    <figcaption className="col t-xs" style={{ gap: "2px" }}>
                      <span className="fw-b">진입 요청(초당)</span>
                      <span className="num muted">지금 4,900건 · 최고 18.1만 건(20:00:15)</span>
                    </figcaption>
                    <svg className="chart" viewBox="0 0 320 64" role="img" aria-label="대기열 진입 요청량. 오픈 직후 20:00:15에 초당 18만 1천 건으로 최고였고 설계 피크 20만 건 아래였습니다. 지금은 초당 4,900건입니다.">
                      <line className="grid" x1="30" y1="46" x2="312" y2="46" />
                      <line className="grid" x1="30" y1="27.8" x2="312" y2="27.8" />
                      <line className="line-base" x1="30" y1="9.6" x2="312" y2="9.6" />
                      <text className="axis" x="268" y="21" textAnchor="end">설계 피크 20만/초</text>
                      <text className="axis" x="26" y="49" textAnchor="end">0</text>
                      <text className="axis" x="26" y="31" textAnchor="end">10만</text>
                      <polyline className="line" points="30,45.5 53.5,45.3 77,44.9 80.9,15.5 88.7,13.1 100.5,22 124,32.5 147.5,38.5 171,41.6 194.5,43.5 218,44.4 241.5,44.8 265,45.1 274.4,45.1" />
                      <line className="now" x1="274.4" y1="3" x2="274.4" y2="48" />
                      <text className="axis" x="77" y="61" textAnchor="middle">20:00</text>
                      <text className="axis" x="171" y="61" textAnchor="middle">20:02</text>
                      <text className="axis" x="265" y="61" textAnchor="middle">20:04</text>
                    </svg>
                  </figure>
                  <figure className="col" style={{ gap: "2px" }}>
                    <figcaption className="col t-xs" style={{ gap: "2px" }}>
                      <span className="row between" style={{ gap: "8px" }}>
                        <span className="fw-b">진입 응답 p99</span>
                        <span className="slo slo-ok">정상 · 기준 200ms</span>
                      </span>
                      <span className="num muted">지금 93ms · 최고 171ms</span>
                    </figcaption>
                    <svg className="chart" viewBox="0 0 320 64" role="img" aria-label="대기열 진입 응답 p99. 오픈 직후 최고 171ms로 기준 200ms 아래였고 지금은 93ms입니다.">
                      <line className="grid" x1="30" y1="46" x2="312" y2="46" />
                      <line className="grid" x1="30" y1="30" x2="312" y2="30" />
                      <line className="slo-line" x1="30" y1="14" x2="312" y2="14" />
                      <text className="axis" x="268" y="10" textAnchor="end">기준 200ms</text>
                      <text className="axis" x="26" y="49" textAnchor="end">0</text>
                      <text className="axis" x="26" y="33" textAnchor="end">100</text>
                      <polyline className="line" points="30,31.9 53.5,31.6 77,31.3 80.9,21.7 88.7,18.6 100.5,22.3 124,26.6 147.5,28.7 171,29.8 194.5,30.5 218,30.8 241.5,31 265,31.1 274.4,31.1" />
                      <line className="now" x1="274.4" y1="3" x2="274.4" y2="48" />
                      <text className="axis" x="77" y="61" textAnchor="middle">20:00</text>
                      <text className="axis" x="171" y="61" textAnchor="middle">20:02</text>
                      <text className="axis" x="265" y="61" textAnchor="middle">20:04</text>
                    </svg>
                  </figure>
                  <figure className="col" style={{ gap: "2px" }}>
                    <figcaption className="col t-xs" style={{ gap: "2px" }}>
                      <span className="fw-b">입장 처리량(serving 전진, 초당)</span>
                      <span className="num muted">지금 0명(목표 초과로 멈춤) · 기대 5.6명(목표 1,000 ÷ 평균 체류 3분 [가정])</span>
                    </figcaption>
                    <svg className="chart" viewBox="0 0 320 64" role="img" aria-label="입장 처리량. 20:01부터 초당 27~28명이었고, 20:02:24에 동시 입장 목표를 1,000명으로 낮춘 뒤 예매 단계 인원이 목표를 넘어 지금은 초당 0명입니다. 목표 아래로 내려오면 기대치 초당 5.6명 안팎으로 다시 전진합니다.">
                      <line className="grid" x1="30" y1="46" x2="312" y2="46" />
                      <line className="grid" x1="30" y1="19.4" x2="312" y2="19.4" />
                      <line className="line-base" x1="30" y1="38.5" x2="312" y2="38.5" />
                      <text className="axis" x="268" y="35" textAnchor="end">기대 5.6명/초</text>
                      <text className="axis" x="26" y="49" textAnchor="end">0</text>
                      <text className="axis" x="26" y="22.5" textAnchor="end">20</text>
                      <line className="grid" x1="189.8" y1="3" x2="189.8" y2="48" />
                      <text className="axis" x="186" y="31" textAnchor="end">명령 1 · 1,000명</text>
                      <polyline className="line" points="30,46 77,46 80.9,38 88.7,26 100.5,16 124,10.5 147.5,9.3 171,9 189.8,9.2 192.2,40 194.5,46 274.4,46" />
                      <line className="now" x1="274.4" y1="3" x2="274.4" y2="48" />
                      <text className="axis" x="77" y="61" textAnchor="middle">20:00</text>
                      <text className="axis" x="171" y="61" textAnchor="middle">20:02</text>
                      <text className="axis" x="265" y="61" textAnchor="middle">20:04</text>
                    </svg>
                  </figure>
                  <div className="legend" aria-hidden="true">
                    <span className="legend-item">
                      <span className="swatch" />
                      관측
                    </span>
                    <span className="legend-item">
                      <span className="swatch" style={{ background: "var(--danger)" }} />
                      SLO 기준(점선)
                    </span>
                    <span className="legend-item">
                      <span className="swatch" style={{ background: "var(--text-muted)" }} />
                      설계 피크·기대치(점선)
                    </span>
                    <span className="legend-item">
                      <span className="swatch" style={{ width: "2px", height: "12px", background: "var(--text)" }} />
                      지금 20:04:12
                    </span>
                  </div>
                  <p className="t-xs" style={{ paddingTop: "8px", borderTop: "1px solid var(--border)" }}>
                    <span className="fw-b">판단:</span>
                    {' '}진입이 기준 밖이면 진입 Degraded 자동 전환을 확인하고, 한 대역에 몰리면 명령 4. 입장 처리량이 기대와 다르면 명령 1·2
                  </p>
                </div>
              </details>
            </>
          ) : null}
          <details className="widget">
            <summary className="widget-head">
              <span>대기 상태 파일 신선도·셔플 게시</span>
              <span className="fold-meta">
                <span className="slo slo-ok">정상</span>
                <span>1.3초</span>
                <i className="ic ic-chevron-down fold-ic" aria-hidden="true" />
              </span>
            </summary>
            <div className="widget-body">
              <div className="row" style={{ justifyContent: "flex-end", gap: "12px" }}>
                <button className="btn btn-ghost btn-sm" type="button" aria-pressed="false">
                  <i className="ic ic-list" aria-hidden="true" />
                  표로 보기
                </button>
                <a href="https://grafana.ops.peaket.example/d/onsale" target="_blank" rel="noreferrer" className="link-more" aria-label="대기 상태 파일 신선도·셔플 게시 자세히 보기, Grafana, 새 탭">
                  자세히 보기
                  <i className="ic ic-external" aria-hidden="true" />
                </a>
              </div>
              <div className="stat">
                <span className="stat-label">신선도 p99(serving 갱신 → 엣지 반영)</span>
                <span className="stat-value">1.3초</span>
                <span className="slo slo-ok">정상 · 기준 2초</span>
                <span className="stat-meta">파일 1초마다 갱신 · 엣지 캐시 1초</span>
              </div>
              <svg className="chart" viewBox="0 0 320 72" role="img" aria-label="대기 상태 파일 신선도 p99. 셔플 결과 게시 때 1.7초까지 올랐다가 지금 1.3초로 기준 2초 아래입니다.">
                <line className="grid" x1="30" y1="50" x2="312" y2="50" />
                <line className="slo-line" x1="30" y1="14.8" x2="312" y2="14.8" />
                <text className="axis" x="268" y="11" textAnchor="end">기준 2초</text>
                <text className="axis" x="26" y="53" textAnchor="end">0</text>
                <polyline className="line" points="30,30.6 77,30.6 88.8,20.1 100.5,23.6 124,27.1 171,28.9 218,27.1 274.4,27.1" />
                <line className="now" x1="274.4" y1="3" x2="274.4" y2="52" />
                <text className="axis" x="77" y="67" textAnchor="middle">20:00</text>
                <text className="axis" x="171" y="67" textAnchor="middle">20:02</text>
                <text className="axis" x="265" y="67" textAnchor="middle">20:04</text>
              </svg>
              <ul className="col t-xs" style={{ gap: "6px" }}>
                <li className="row between">
                  <span>로비 셔플</span>
                  <span className="slo slo-ok">완료 20:00:01</span>
                </li>
                <li className="row between">
                  <span>셔플 결과 파일 게시</span>
                  <span className="slo slo-ok">완료 20:00:09</span>
                </li>
                <li className="row between">
                  <span className="muted">결과 조회 분산</span>
                  <span className="muted">0~8초</span>
                </li>
              </ul>
              <p className="t-xs" style={{ paddingTop: "8px", borderTop: "1px solid var(--border)" }}>
                <span className="fw-b">판단:</span>
                {' '}게시가 실패하거나 늦으면 엔지니어를 부릅니다(결과 파일은 S3 대체 원본으로 다시 게시). 비콘 대기가 60초를 넘어 셔플이 멈추면 SEV1과 RB-35(비상 셔플은 commander 두 명의 서명)
              </p>
            </div>
          </details>
          <details className="widget">
            <summary className="widget-head">
              <span>상태 조회량·CDN·엣지</span>
              <span className="fold-meta">
                <span className="slo slo-ok">정상</span>
                <span>적중 98.4%</span>
                <i className="ic ic-chevron-down fold-ic" aria-hidden="true" />
              </span>
            </summary>
            <div className="widget-body">
              <div className="row" style={{ justifyContent: "flex-end" }}>
                <a href="https://grafana.ops.peaket.example/d/onsale" target="_blank" rel="noreferrer" className="link-more" aria-label="상태 조회량·CDN·엣지 자세히 보기, Grafana, 새 탭">
                  자세히 보기
                  <i className="ic ic-external" aria-hidden="true" />
                </a>
              </div>
              <div className="row" style={{ gap: "16px", alignItems: "flex-start" }}>
                <div className="col" style={{ gap: "2px" }}>
                  <span className="stat-label">엣지 캐시 적중률</span>
                  <span className="stat-value">98.4%</span>
                </div>
                <div className="col" style={{ gap: "2px" }}>
                  <span className="stat-label">상태 조회량</span>
                  <span className="stat-value">
                    4.1만
                    <span className="t-sm muted fw-m">/초</span>
                  </span>
                </div>
              </div>
              <ul className="col t-xs" style={{ gap: "6px" }}>
                <li className="row between" style={{ gap: "8px" }}>
                  <span className="muted">오리진 도달</span>
                  <span className="num">초당 640건 · 설계 1,000건 이하</span>
                </li>
                <li className="row between" style={{ gap: "8px" }}>
                  <span className="muted">엣지 5xx 비율</span>
                  <span className="num">0.01%</span>
                </li>
                <li className="row between" style={{ gap: "8px" }}>
                  <span className="muted">폴링 주기</span>
                  <span>0.5·5·20초, 지터</span>
                </li>
              </ul>
              <div className="divider" />
              <span className="eyebrow">배포별 한도 사용률 · 80% [가정] 넘으면 SEV3</span>
              <div className="col" style={{ gap: "8px" }}>
                <div className="col" style={{ gap: "3px" }}>
                  <div className="row between t-xs">
                    <span>공연 페이지</span>
                    <span className="num">12%</span>
                  </div>
                  <div className="progress" role="progressbar" aria-label="공연 페이지 배포 한도 사용률 12%" aria-valuenow={12} aria-valuemin={0} aria-valuemax={100}>
                    <span style={{ width: "12%" }} />
                  </div>
                </div>
                <div className="col" style={{ gap: "3px" }}>
                  <div className="row between t-xs">
                    <span>대기열 파일</span>
                    <span className="num">41%</span>
                  </div>
                  <div className="progress" role="progressbar" aria-label="대기열 파일 배포 한도 사용률 41%" aria-valuenow={41} aria-valuemin={0} aria-valuemax={100}>
                    <span style={{ width: "41%" }} />
                  </div>
                </div>
                <div className="col" style={{ gap: "3px" }}>
                  <div className="row between t-xs">
                    <span>대기열 API</span>
                    <span className="num">9%</span>
                  </div>
                  <div className="progress" role="progressbar" aria-label="대기열 API 배포 한도 사용률 9%" aria-valuenow={9} aria-valuemin={0} aria-valuemax={100}>
                    <span style={{ width: "9%" }} />
                  </div>
                </div>
              </div>
              <p className="t-xs" style={{ paddingTop: "8px", borderTop: "1px solid var(--border)" }}>
                <span className="fw-b">판단:</span>
                {' '}대기열 CDN 캐시 오류율 1% 초과가 1분 이어지면 RB-04(원본 오류 요청은 S3 사본으로 자동으로 넘기고, 사본으로 고정하려면 명령 6). 적중률이 떨어지면 엔지니어를 부릅니다. 배포별 한도 사용률이 80%를 넘으면 SEV3 경고입니다(다음 회차 전 한도 상향 요청의 근거로 남깁니다).
              </p>
            </div>
          </details>
          <details className="widget">
            <summary className="widget-head">
              <span>좌석 홀드 p99</span>
              <span className="fold-meta">
                <span className="slo slo-burning">경고</span>
                <span>41ms · 3.2×</span>
                <i className="ic ic-chevron-down fold-ic" aria-hidden="true" />
              </span>
            </summary>
            <div className="widget-body">
              <div className="row" style={{ justifyContent: "flex-end", gap: "12px" }}>
                <button className="btn btn-ghost btn-sm" type="button" aria-pressed="false">
                  <i className="ic ic-list" aria-hidden="true" />
                  표로 보기
                </button>
                <a href="https://grafana.ops.peaket.example/d/onsale" target="_blank" rel="noreferrer" className="link-more" aria-label="좌석 홀드 p99 자세히 보기, Grafana, 새 탭">
                  자세히 보기
                  <i className="ic ic-external" aria-hidden="true" />
                </a>
              </div>
              <div className="stat is-burning">
                <span className="stat-label">홀드 응답 p99</span>
                <span className="stat-value">41ms</span>
                <span className="slo slo-burning" style={{ whiteSpace: "normal" }}>경고: 에러 버짓 3.2× 속도로 소진 중</span>
                <span className="stat-meta">기준 p99 50ms · 가용성 99.95% · 경합 패배(409)는 오류로 세지 않음</span>
              </div>
              <figure className="col" style={{ gap: "2px" }}>
                <figcaption className="row between t-xs">
                  <span className="fw-b">5분 창 소진 배수</span>
                  <span className="num muted">지금 3.2×</span>
                </figcaption>
                <svg className="chart" viewBox="0 0 320 72" role="img" aria-label="좌석 홀드 에러 버짓 소진 배수(5분 창). 20:03 무렵 SEV2 기준 3배를 넘어 지금 3.2배이고 SEV1 기준 10배 아래입니다. SEV2 경보는 20:03:41에 울렸습니다.">
                  <line className="grid" x1="30" y1="50" x2="312" y2="50" />
                  <line className="line-base" x1="30" y1="39" x2="312" y2="39" />
                  <line className="slo-line" x1="30" y1="13.3" x2="312" y2="13.3" />
                  <text className="axis" x="32" y="35">SEV2 3×</text>
                  <text className="axis" x="32" y="10">SEV1 10×</text>
                  <text className="axis" x="26" y="53" textAnchor="end">0</text>
                  <polyline className="line" points="80.9,50 100.5,48.5 124,47.4 147.5,46.7 171,44.9 194.5,41.9 218,39.4 241.5,37.9 265,37.5 274.4,38.3" />
                  <circle className="bar-alt" cx="250.1" cy="37.7" r="3.5" />
                  <line className="now" x1="274.4" y1="3" x2="274.4" y2="52" />
                  <text className="axis" x="77" y="67" textAnchor="middle">20:00</text>
                  <text className="axis" x="171" y="67" textAnchor="middle">20:02</text>
                  <text className="axis" x="265" y="67" textAnchor="middle">20:04</text>
                </svg>
              </figure>
              <p className="t-xs" style={{ paddingTop: "8px", borderTop: "1px solid var(--border)" }}>
                <span className="fw-b">판단:</span>
                {' '}판단 순서 ②. 소진이 이어지면 최근 변경이면 되돌리기(RB-23), 명령 1 → 2 → 6 → 3
              </p>
            </div>
          </details>
          <details className="widget">
            <summary className="widget-head">
              <span>결제 확정·남은 허용 실패</span>
              <span className="fold-meta">
                <span className="slo slo-ok">정상</span>
                <span>99.97%</span>
                <i className="ic ic-chevron-down fold-ic" aria-hidden="true" />
              </span>
            </summary>
            <div className="widget-body">
              <div className="row" style={{ justifyContent: "flex-end" }}>
                <a href="https://grafana.ops.peaket.example/d/onsale" target="_blank" rel="noreferrer" className="link-more" aria-label="결제 확정·남은 허용 실패 자세히 보기, Grafana, 새 탭">
                  자세히 보기
                  <i className="ic ic-external" aria-hidden="true" />
                </a>
              </div>
              <div className="stat">
                <span className="stat-label">결제 확정 성공률</span>
                <span className="stat-value">99.97%</span>
                <span className="slo slo-ok">정상 · 기준 99.95%</span>
                <span className="stat-meta">확정 p99 2.1초 · 기준 3초</span>
              </div>
              <h3 className="eyebrow">여정별 남은 허용 실패(온세일 70분 예산)</h3>
              <ul className="col" style={{ gap: "9px" }}>
                <li className="col" style={{ gap: "4px" }}>
                  <div className="row between t-xs" style={{ gap: "8px" }}>
                    <span className="fw-b">결제 확정 12건 중 3건 사용</span>
                    <span className="slo slo-ok">남음 9건</span>
                  </div>
                  <div className="progress" role="progressbar" aria-label="결제 확정 허용 실패 25% 사용" aria-valuenow={25} aria-valuemin={0} aria-valuemax={100}>
                    <span style={{ width: "25%" }} />
                  </div>
                </li>
                <li className="col" style={{ gap: "4px" }}>
                  <div className="row between t-xs" style={{ gap: "8px" }}>
                    <span className="fw-b">좌석 홀드 75건 중 16건 사용</span>
                    <span className="slo slo-burning">남음 59건</span>
                  </div>
                  <div className="progress progress-warning" role="progressbar" aria-label="좌석 홀드 허용 실패 21% 사용" aria-valuenow={21} aria-valuemin={0} aria-valuemax={100}>
                    <span style={{ width: "21%" }} />
                  </div>
                </li>
                <li className="col" style={{ gap: "4px" }}>
                  <div className="row between t-xs" style={{ gap: "8px" }}>
                    <span>대기열 진입 2,000건 중 186건 사용</span>
                    <span className="slo slo-ok">남음 1,814건</span>
                  </div>
                  <div className="progress" role="progressbar" aria-label="대기열 진입 허용 실패 9% 사용" aria-valuenow={9} aria-valuemin={0} aria-valuemax={100}>
                    <span style={{ width: "9%" }} />
                  </div>
                </li>
                <li className="col" style={{ gap: "4px" }}>
                  <div className="row between t-xs" style={{ gap: "8px" }}>
                    <span>공연 상세 1,000건 중 41건 사용</span>
                    <span className="slo slo-ok">남음 959건</span>
                  </div>
                  <div className="progress" role="progressbar" aria-label="공연 상세 허용 실패 4% 사용" aria-valuenow={4} aria-valuemin={0} aria-valuemax={100}>
                    <span style={{ width: "4%" }} />
                  </div>
                </li>
              </ul>
              <p className="t-xs" style={{ paddingTop: "8px", borderTop: "1px solid var(--border)" }}>
                <span className="fw-b">판단:</span>
                {' '}결제사 원인(임박)이 울리면 결제사 상태를 보고 필요하면 명령 1을 씁니다. 결제 확정 소요 p99가 5초를 넘거나 서킷이 열리면 RB-07: 명령 6(결제사 전환, 2인).
              </p>
            </div>
          </details>
          {v.isNormal ? (
            <>
              <details className="widget">
                <summary className="widget-head">
                  <span>구역별 잔여석</span>
                  <span className="fold-meta">
                    <span className="badge badge-outline">잠정</span>
                    <span>남은 970석</span>
                    <i className="ic ic-chevron-down fold-ic" aria-hidden="true" />
                  </span>
                </summary>
                <div className="widget-body">
                  <div className="row" style={{ justifyContent: "flex-end", gap: "12px" }}>
                    <button className="btn btn-ghost btn-sm" type="button" aria-pressed="false">
                      <i className="ic ic-list" aria-hidden="true" />
                      표로 보기
                    </button>
                    <a href="https://grafana.ops.peaket.example/d/onsale" target="_blank" rel="noreferrer" className="link-more" aria-label="구역별 잔여석 자세히 보기, Grafana, 새 탭">
                      자세히 보기
                      <i className="ic ic-external" aria-hidden="true" />
                    </a>
                  </div>
                  <span className="t-xs muted">숫자는 남은 좌석 수입니다. 색이 진할수록 남은 비율이 낮습니다.</span>
                  <div className="heat" aria-hidden="true" style={{ gridTemplateColumns: "repeat(3,minmax(0,1fr))" }}>
                    <span className="h1">50% 이상</span>
                    <span className="h2">10% 이상 50% 미만</span>
                    <span className="h3">10% 미만(매진 포함)</span>
                  </div>
                  <div className="heat" role="img" aria-label="구역별 남은 좌석. R1 4석, R2 12석, S1 120석, S2 160석, A1 300석, A2 374석. 모든 구역이 앞 열부터 팔렸습니다." style={{ gridTemplateColumns: "28px repeat(6,minmax(0,1fr)) 40px" }}>
                    <span style={{ background: "transparent" }}>열</span>
                    <span style={{ background: "transparent" }}>1~3</span>
                    <span style={{ background: "transparent" }}>4~6</span>
                    <span style={{ background: "transparent" }}>7~9</span>
                    <span style={{ background: "transparent" }}>10~12</span>
                    <span style={{ background: "transparent" }}>13~15</span>
                    <span style={{ background: "transparent" }}>16~18</span>
                    <span style={{ background: "transparent" }}>남음</span>
                    {' '}
                    <span style={{ background: "transparent", color: "var(--text)" }}>R1</span>
                    <span className="h3">0</span>
                    <span className="h3">0</span>
                    <span className="h3">0</span>
                    <span className="h3">1</span>
                    <span className="h3">3</span>
                    <span>—</span>
                    <span style={{ background: "transparent", color: "var(--text)" }}>4석</span>
                    {' '}
                    <span style={{ background: "transparent", color: "var(--text)" }}>R2</span>
                    <span className="h3">0</span>
                    <span className="h3">0</span>
                    <span className="h3">1</span>
                    <span className="h3">4</span>
                    <span className="h2">7</span>
                    <span>—</span>
                    <span style={{ background: "transparent", color: "var(--text)" }}>12석</span>
                    {' '}
                    <span style={{ background: "transparent", color: "var(--text)" }}>S1</span>
                    <span className="h3">5</span>
                    <span className="h2">10</span>
                    <span className="h2">17</span>
                    <span className="h2">23</span>
                    <span className="h2">30</span>
                    <span className="h2">35</span>
                    <span style={{ background: "transparent", color: "var(--text)" }}>120석</span>
                    {' '}
                    <span style={{ background: "transparent", color: "var(--text)" }}>S2</span>
                    <span className="h2">9</span>
                    <span className="h2">16</span>
                    <span className="h2">23</span>
                    <span className="h2">30</span>
                    <span className="h1">38</span>
                    <span className="h1">44</span>
                    <span style={{ background: "transparent", color: "var(--text)" }}>160석</span>
                    {' '}
                    <span style={{ background: "transparent", color: "var(--text)" }}>A1</span>
                    <span className="h2">31</span>
                    <span className="h1">41</span>
                    <span className="h1">49</span>
                    <span className="h1">55</span>
                    <span className="h1">61</span>
                    <span className="h1">63</span>
                    <span style={{ background: "transparent", color: "var(--text)" }}>300석</span>
                    {' '}
                    <span style={{ background: "transparent", color: "var(--text)" }}>A2</span>
                    <span className="h1">46</span>
                    <span className="h1">56</span>
                    <span className="h1">63</span>
                    <span className="h1">67</span>
                    <span className="h1">70</span>
                    <span className="h1">72</span>
                    <span style={{ background: "transparent", color: "var(--text)" }}>374석</span>
                  </div>
                  <p className="t-xs muted">남은 970석 / 2,400석 · 홀드·결제 중인 좌석도 남은 좌석에 셉니다(좌석맵이 따로 보임) · R구역은 15열까지라 16~18열이 없습니다(—)</p>
                  <p className="t-xs" style={{ paddingTop: "8px", borderTop: "1px solid var(--border)" }}>
                    <span className="fw-b">판단:</span>
                    {' '}없음(파트너 문의 응대 참고)
                  </p>
                </div>
              </details>
            </>
          ) : null}
          {' '}
          {v.isDown ? (
            <>
              <details className="widget">
                <summary className="widget-head">
                  <span>구역별 잔여석</span>
                  <span className="fold-meta">
                    <span className="badge badge-outline">잠정</span>
                    <span className="badge badge-warning">축소 표시</span>
                    <i className="ic ic-chevron-down fold-ic" aria-hidden="true" />
                  </span>
                </summary>
                <div className="widget-body">
                  <div className="row" style={{ justifyContent: "flex-end" }}>
                    <a href="https://grafana.ops.peaket.example/d/onsale" target="_blank" rel="noreferrer" className="link-more" aria-label="구역별 잔여석 자세히 보기, Grafana, 새 탭">
                      자세히 보기
                      <i className="ic ic-external" aria-hidden="true" />
                    </a>
                  </div>
                  <div className="stat is-stale">
                    <span className="stat-label">구역별 잔여석</span>
                    <span className="stat-value">—</span>
                    <span className="slo slo-stale">수집 지연 · 마지막 수신 20:03:18 KST</span>
                    <span className="stat-meta">시스템 코어 지표로 축소 표시합니다</span>
                  </div>
                  <ul className="col t-sm" style={{ gap: "6px" }}>
                    <li className="row between">
                      <span className="muted">좌석 홀드 성공</span>
                      <span className="num">초당 46건</span>
                    </li>
                    <li className="row between">
                      <span className="muted">홀드 경합 패배(409)</span>
                      <span className="num">초당 71건</span>
                    </li>
                    <li className="row between">
                      <span className="muted">홀드 해제·만료</span>
                      <span className="num">초당 9건</span>
                    </li>
                  </ul>
                  <p className="t-xs muted">서비스 메트릭에서 바로 읽은 값입니다. 구역별 값은 수집이 돌아오면 다시 보입니다.</p>
                  <p className="t-xs" style={{ paddingTop: "8px", borderTop: "1px solid var(--border)" }}>
                    <span className="fw-b">판단:</span>
                    {' '}없음(파트너 문의 응대 참고)
                  </p>
                </div>
              </details>
            </>
          ) : null}
          <details className="widget">
            <summary className="widget-head">
              <span>봇 차단</span>
              <span className="fold-meta">
                <span className="slo slo-ok">정상</span>
                <span>4,812건</span>
                <i className="ic ic-chevron-down fold-ic" aria-hidden="true" />
              </span>
            </summary>
            <div className="widget-body">
              <div className="row" style={{ justifyContent: "flex-end" }}>
                <a href="https://grafana.ops.peaket.example/d/onsale" target="_blank" rel="noreferrer" className="link-more" aria-label="봇 차단 자세히 보기, Grafana, 새 탭">
                  자세히 보기
                  <i className="ic ic-external" aria-hidden="true" />
                </a>
              </div>
              <div className="col" style={{ gap: "2px" }}>
                <span className="stat-label">차단(엣지·진입 단계 합계)</span>
                <span className="stat-value">4,812건</span>
                <span className="stat-meta">오픈 뒤 누계</span>
              </div>
              <ul className="col t-xs" style={{ gap: "6px" }}>
                <li className="row between">
                  <span className="muted">허니팟 접촉</span>
                  <span className="num">337건</span>
                </li>
                <li className="row between">
                  <span className="muted">봇 판정 강도(명령 5)</span>
                  <span>기본</span>
                </li>
                <li className="row between">
                  <span className="muted">대역 차단(명령 4)</span>
                  <span>적용 없음</span>
                </li>
              </ul>
              <p className="t-xs" style={{ paddingTop: "8px", borderTop: "1px solid var(--border)" }}>
                <span className="fw-b">판단:</span>
                {' '}한 대역·ASN에 몰리면 명령 4, 판정을 바꾸려면 명령 5. 실행 뒤 효과 줄을 확인합니다.
              </p>
            </div>
          </details>
          <details className="widget is-error">
            <summary className="widget-head">
              <span>추가 검증 유입·통과율·이의 결과</span>
              <span className="fold-meta">
                <span className="slo slo-stale">받지 못함</span>
                <i className="ic ic-chevron-down fold-ic" aria-hidden="true" />
              </span>
            </summary>
            <div className="widget-body">
              <div className="row" style={{ justifyContent: "flex-end" }}>
                <a href="https://grafana.ops.peaket.example/d/onsale" target="_blank" rel="noreferrer" className="link-more" aria-label="추가 검증 유입·통과율·이의 결과 자세히 보기, Grafana, 새 탭">
                  자세히 보기
                  <i className="ic ic-external" aria-hidden="true" />
                </a>
              </div>
              <div className="col" role="alert" style={{ alignItems: "flex-start", gap: "8px" }}>
                <span className="state-icon is-danger" style={{ width: "40px", height: "40px" }}>
                  <i className="ic ic-alert-circle" aria-hidden="true" style={{ width: "20px", height: "20px" }} />
                </span>
                {' '}
                <strong className="t-sm">이 위젯만 불러오지 못했습니다</strong>
                <p className="t-xs muted">일시적인 오류입니다. 다른 위젯은 그대로 갱신됩니다. 마지막 수신 20:03:52 KST</p>
                <button className="btn btn-outline btn-sm" type="button">
                  <i className="ic ic-refresh" aria-hidden="true" />
                  다시 시도
                </button>
              </div>
              <p className="t-xs" style={{ paddingTop: "8px", borderTop: "1px solid var(--border)" }}>
                <span className="fw-b">판단:</span>
                {' '}통과율이 떨어지면 명령 5 완화를 검토하고 이의 결과를 봅니다.
              </p>
            </div>
          </details>
          <details className="widget">
            <summary className="widget-head">
              <span>제공자 성공률·p99</span>
              <span className="fold-meta">
                <span className="slo slo-ok">정상 3</span>
                <span>대기 1</span>
                <i className="ic ic-chevron-down fold-ic" aria-hidden="true" />
              </span>
            </summary>
            <div className="widget-body">
              <div className="row" style={{ justifyContent: "flex-end" }}>
                <a href="https://grafana.ops.peaket.example/d/onsale" target="_blank" rel="noreferrer" className="link-more" aria-label="제공자 성공률·p99 자세히 보기, Grafana, 새 탭">
                  자세히 보기
                  <i className="ic ic-external" aria-hidden="true" />
                </a>
              </div>
              <ul className="col" style={{ gap: "8px" }}>
                <li className="col" style={{ gap: "2px", paddingBottom: "8px", borderBottom: "1px solid var(--border)" }}>
                  <div className="row between">
                    <span className="t-sm fw-b">본인확인</span>
                    <span className="slo slo-ok">정상</span>
                  </div>
                  <span className="t-xs muted num">성공률 99.2% · p99 1.8초</span>
                </li>
                <li className="col" style={{ gap: "2px", paddingBottom: "8px", borderBottom: "1px solid var(--border)" }}>
                  <div className="row between">
                    <span className="t-sm fw-b">사람 확인</span>
                    <span className="slo slo-ok">정상</span>
                  </div>
                  <span className="t-xs muted num">성공률 98.7% · p99 0.9초</span>
                </li>
                <li className="col" style={{ gap: "2px", paddingBottom: "8px", borderBottom: "1px solid var(--border)" }}>
                  <div className="row between">
                    <span className="t-sm fw-b">토스페이먼츠(기본 결제사)</span>
                    <span className="slo slo-ok">정상</span>
                  </div>
                  <span className="t-xs muted num">승인 99.6% · p99 1.2초 · 한도 사용률 64% · 한도 초과 응답 0건</span>
                </li>
                <li className="col" style={{ gap: "2px" }}>
                  <div className="row between">
                    <span className="t-sm fw-b">포트원(대체 결제사)</span>
                    <span className="slo slo-stale">대기</span>
                  </div>
                  <span className="t-xs muted">전환 후보 없음</span>
                </li>
              </ul>
              <p className="t-xs muted">제공자 오류(5xx·시간 초과)가 1%를 넘은 채 5분 이어지면 SEV2 [가정] · 결제사 한도 초과 응답은 1건이면 SEV2</p>
              <p className="t-xs" style={{ paddingTop: "8px", borderTop: "1px solid var(--border)" }}>
                <span className="fw-b">판단:</span>
                {' '}본인확인·사람 확인이 나빠지면 명령 7(공지)을 씁니다. 본인확인은 서킷이 안내를 띄우고, 사람 확인 한도면 로비를 일찍 엽니다. 엔지니어를 부릅니다.
              </p>
            </div>
          </details>
          {v.isNormal ? (
            <>
              <details className="widget">
                <summary className="widget-head">
                  <span>비즈니스 지표</span>
                  <span className="fold-meta">
                    <span className="badge badge-outline">잠정</span>
                    <span>전환 16.0%</span>
                    <i className="ic ic-chevron-down fold-ic" aria-hidden="true" />
                  </span>
                </summary>
                <div className="widget-body">
                  <div className="row" style={{ justifyContent: "flex-end", gap: "12px" }}>
                    <button className="btn btn-ghost btn-sm" type="button" aria-pressed="false">
                      <i className="ic ic-list" aria-hidden="true" />
                      표로 보기
                    </button>
                    <a href="https://grafana.ops.peaket.example/d/onsale" target="_blank" rel="noreferrer" className="link-more" aria-label="비즈니스 지표 자세히 보기, Grafana, 새 탭">
                      자세히 보기
                      <i className="ic ic-external" aria-hidden="true" />
                    </a>
                  </div>
                  <figure className="col" style={{ gap: "4px" }}>
                    <figcaption className="col t-xs" style={{ gap: "2px" }}>
                      <span className="fw-b">퍼널(F3): 입장 → 첫 홀드 성공 → 결제 접수 → 승인 → 발권</span>
                      <span className="muted">숫자 · 앞 단계 대비</span>
                    </figcaption>
                    <svg className="chart" viewBox="0 0 320 136" role="img" aria-label="퍼널. 입장 4,960, 첫 홀드 성공 1,402(앞 단계 대비 28.3%), 결제 접수 818(58.3%), 승인 793(96.9%), 발권 790(99.6%).">
                      <text className="axis" x="72" y="19" textAnchor="end">입장</text>
                      <rect className="bar" x="78" y="6" width="160" height="18" rx="3" />
                      <text className="axis" x="244" y="19">4,960</text>
                      <text className="axis" x="72" y="46" textAnchor="end">첫 홀드 성공</text>
                      <rect className="bar" x="78" y="33" width="45.2" height="18" rx="3" />
                      <text className="axis" x="129.2" y="46">1,402 · 28.3%</text>
                      <text className="axis" x="72" y="73" textAnchor="end">결제 접수</text>
                      <rect className="bar" x="78" y="60" width="26.4" height="18" rx="3" />
                      <text className="axis" x="110.4" y="73">818 · 58.3%</text>
                      <text className="axis" x="72" y="100" textAnchor="end">승인</text>
                      <rect className="bar" x="78" y="87" width="25.6" height="18" rx="3" />
                      <text className="axis" x="109.6" y="100">793 · 96.9%</text>
                      <text className="axis" x="72" y="127" textAnchor="end">발권</text>
                      <rect className="bar" x="78" y="114" width="25.5" height="18" rx="3" />
                      <text className="axis" x="109.5" y="127">790 · 99.6%</text>
                    </svg>
                  </figure>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(2,minmax(0,1fr))", gap: "8px" }}>
                    <div className="stat" style={{ padding: "12px" }}>
                      <span className="row wrap stat-label" style={{ gap: "4px" }}>
                        입장 → 구매 전환율
                        <span className="badge badge-outline">잠정</span>
                      </span>
                      <span className="stat-value">16.0%</span>
                      <span className="stat-meta">승인 793 ÷ 입장 4,960 · 구매가 진행 중이라 마감(R1)에서 확정합니다</span>
                    </div>
                    <div className="stat" style={{ padding: "12px" }}>
                      <span className="row wrap stat-label" style={{ gap: "4px" }}>
                        잔여석
                        <span className="badge badge-outline">잠정</span>
                      </span>
                      <span className="stat-value">970석</span>
                      <span className="stat-meta">전체 2,400석 − 판매 1,430석 · 홀드·결제 중인 좌석도 셉니다</span>
                    </div>
                  </div>
                  <p className="t-xs muted">실시간 잠정 숫자입니다. 판매 정책과 운영 기본값은 마감된 확정 숫자(공연 리포트)로만 바꿉니다.</p>
                  <p className="t-xs" style={{ paddingTop: "8px", borderTop: "1px solid var(--border)" }}>
                    <span className="fw-b">판단:</span>
                    {' '}잠정 숫자라 운영 명령의 참고로만 씁니다. 판매 정책은 확정 숫자로 바꿉니다(POL-040). 단계 비율이 기준선의 절반 아래로 떨어지면 경보 패널 '이 회차 판단'에 SEV2 처리량 급감이 뜹니다. RB-33: 막힌 단계 찾기 → 최근 변경이면 되돌리기 → 원인을 모르면 명령 2.
                  </p>
                </div>
              </details>
            </>
          ) : null}
          {' '}
          {v.isDown ? (
            <>
              <details className="widget" open>
                <summary className="widget-head">
                  <span>비즈니스 지표</span>
                  <span className="fold-meta">
                    <span className="badge badge-outline">잠정</span>
                    <span className="badge badge-warning">축소 표시</span>
                    <i className="ic ic-chevron-down fold-ic" aria-hidden="true" />
                  </span>
                </summary>
                <div className="widget-body">
                  <div className="row" style={{ justifyContent: "flex-end" }}>
                    <a href="https://grafana.ops.peaket.example/d/onsale" target="_blank" rel="noreferrer" className="link-more" aria-label="비즈니스 지표 자세히 보기, Grafana, 새 탭">
                      자세히 보기
                      <i className="ic ic-external" aria-hidden="true" />
                    </a>
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(2,minmax(0,1fr))", gap: "8px" }}>
                    <div className="stat is-stale" style={{ padding: "12px", gridColumn: "span 2" }}>
                      <span className="stat-label">퍼널(F3)·전환율·잔여석</span>
                      <span className="stat-value">—</span>
                      <span className="slo slo-stale">수집 지연 · 마지막 수신 20:03:18 KST</span>
                    </div>
                    <div className="stat" style={{ padding: "12px" }}>
                      <span className="stat-label">결제 접수(시스템 지표)</span>
                      <span className="stat-value">
                        9.8
                        <span className="t-sm muted fw-m">건/초</span>
                      </span>
                      <span className="stat-meta">게이트웨이 요청 수에서 읽음</span>
                    </div>
                    <div className="stat" style={{ padding: "12px" }}>
                      <span className="stat-label">결제 승인(시스템 지표)</span>
                      <span className="stat-value">
                        9.4
                        <span className="t-sm muted fw-m">건/초</span>
                      </span>
                      <span className="stat-meta">결제사 승인 호출 성공</span>
                    </div>
                    <div className="stat" style={{ padding: "12px" }}>
                      <span className="stat-label">발권 대기(Outbox)</span>
                      <span className="stat-value">12건</span>
                      <span className="slo slo-ok">정상</span>
                    </div>
                  </div>
                  <p className="t-xs muted">시스템 코어 지표로 축소 표시 중입니다. 퍼널·전환율·잔여석은 수집이 돌아오면 다시 보이고, 실시간 숫자는 확정 숫자와 섞지 않습니다.</p>
                  <p className="t-xs" style={{ paddingTop: "8px", borderTop: "1px solid var(--border)" }}>
                    <span className="fw-b">판단:</span>
                    {' '}잠정 숫자라 운영 명령의 참고로만 씁니다. 판매 정책은 확정 숫자로 바꿉니다(POL-040). 단계 비율이 기준선의 절반 아래로 떨어지면 경보 패널 '이 회차 판단'에 SEV2 처리량 급감이 뜹니다. RB-33: 막힌 단계 찾기 → 최근 변경이면 되돌리기 → 원인을 모르면 명령 2.
                  </p>
                </div>
              </details>
            </>
          ) : null}
        </div>
      </>
    ) : null}
    {' '}
    {v.isLive ? (
      <>
        <div className="col" role="tabpanel" id="panel-live" aria-labelledby="tab-live" style={{ gap: "12px" }}>
          <p className="row wrap t-xs" style={{ gap: "4px 8px" }} role="status">
            {v.freshOk ? (
              <>
                <span className="slo slo-ok">실시간 표 2.4초 전</span>
                <span className="muted">5초 넘으면 경고 · 3분 넘게 이어지면 대체 표시</span>
              </>
            ) : null}
            {v.isBack ? (
              <>
                <span className="slo slo-burning">실시간 표 52초 전</span>
                <span className="muted">탭을 다시 열었습니다 · 위젯은 마지막 값을 보이다가 1초 안팎에 새 값으로 바뀝니다 · 그래프는 최근 15분을 다시 채웁니다</span>
              </>
            ) : null}
            {v.isStale ? (
              <>
                <span className="slo slo-burning">실시간 표 3분 20초 전</span>
                <span className="muted">3분 넘게 늦어 구역별 잔여석을 Prometheus 대체 표시(퍼널 카운터의 전체 숫자)로 바꿨습니다</span>
              </>
            ) : null}
          </p>
          <p className="row t-sm muted" style={{ gap: "8px", alignItems: "flex-start" }}>
            <i className="ic ic-info ic-16" aria-hidden="true" style={{ marginTop: "2px" }} />
            <span>판매 중 탭의 비즈니스 숫자는 모두 잠정입니다. 판매 정책과 운영 기본값은 마감된 확정 숫자(공연 리포트)로만 바꿉니다.</span>
          </p>
          {v.isAuto ? (
            <>
              <section className="widget" role="region" id="w-auto" aria-labelledby="w-auto-h">
                <div className="widget-head">
                  <h2 className="t-sm fw-b" id="w-auto-h">걸린 자동 조치</h2>
                  <span className="badge badge-warning">걸림 3</span>
                  <span className="badge">최근 풀림 1</span>
                  <div className="actions"><span className="t-xs muted">15초 전 갱신</span></div>
                </div>
                <div className="widget-body">
                  <div className="col" style={{ gap: "12px" }}>
                    <div className="col" role="group" aria-labelledby="w-auto-ev" style={{ gap: "6px" }}>
                      <h3 className="eyebrow" id="w-auto-ev">이 회차 · LUMEN 10/25 18:00</h3>
                      <ul className="col" style={{ gap: "6px" }}>
                        <li className="col" style={{ gap: "4px", padding: "8px 10px", borderRadius: "6px", boxShadow: "inset 0 0 0 1px var(--border)" }}>
                          <div className="row between wrap" style={{ gap: "4px 12px" }}>
                            <span className="row wrap" style={{ gap: "6px 8px" }}>
                              <span className="badge badge-primary">자동 해제 대기</span>
                              <span className="t-sm fw-b">결제 신규 진입 정지 · 토스페이먼츠</span>
                            </span>
                            <span className="t-xs muted">
                              <span className="num">20:02:51 KST</span>
                              부터 · 1분 21초
                            </span>
                          </div>
                          <p className="t-xs">
                            <span className="fw-b">왜:</span>
                            {' '}서킷 열림, 결제 확정 소요 p99 7.2초(재시도 큐 건 뺌, 기준 5초)
                          </p>
                          <p className="t-xs">
                            <span className="fw-b">풀림:</span>
                            {' '}확인 호출이 3분 정상이면 시험 재개(새 결제 5%), 시험 결제 20건이 기준을 넘으면 모두 엽니다
                          </p>
                          <div className="row between wrap t-xs" style={{ gap: "4px 8px" }}>
                            <span>→ 지금 확인 호출 단계 · 서킷 닫힘(20:03:40) · 성공 100%</span>
                            <span className="num fw-b">32초째 / 3분</span>
                          </div>
                          <div className="progress" role="progressbar" aria-label="결제 신규 진입 정지 확인 호출 단계 18% 채움" aria-valuenow={18} aria-valuemin={0} aria-valuemax={100}>
                            <span style={{ width: "18%" }} />
                          </div>
                          <p className="t-xs">
                            <span className="fw-b">손으로 풀기:</span>
                            {' '}명령 6 해제(commander 1인, 사유·재인증) · 전환은 명령 6(대체 결제사, 2인)
                          </p>
                          <div className="row wrap" style={{ gap: "4px 14px" }}>
                            <span className="t-xs muted">명령 6은 태블릿이나 데스크톱에서 합니다</span>
                            <a href="https://runbook.ops.peaket.example/RB-07" target="_blank" rel="noreferrer" className="link-more">
                              RB-07
                              <i className="ic ic-chevron-right" aria-hidden="true" />
                            </a>
                            <a href="https://grafana.ops.peaket.example/d/onsale" target="_blank" rel="noreferrer" className="link-more" aria-label="결제 신규 진입 정지 자세히 보기, Grafana 새 탭">
                              자세히 보기
                              <i className="ic ic-external" aria-hidden="true" />
                            </a>
                          </div>
                        </li>
                        <li className="row wrap" style={{ gap: "4px 8px", padding: "8px 10px", borderRadius: "6px", boxShadow: "inset 0 0 0 1px var(--border)", opacity: ".75" }}>
                          <span className="badge badge-success">최근 풀림</span>
                          <span className="t-sm">실시간 표 대체 표시</span>
                          <span className="t-xs muted">
                            <span className="num">20:01:58 KST</span>
                            {' '}자동으로 풀림(신선도 p95 5초 미만이 5분)
                          </span>
                        </li>
                      </ul>
                    </div>
                    <div className="col" role="group" aria-labelledby="w-auto-pf" style={{ gap: "6px" }}>
                      <h3 className="eyebrow" id="w-auto-pf">플랫폼</h3>
                      <ul className="col" style={{ gap: "6px" }}>
                        <li className="col" style={{ gap: "4px", padding: "8px 10px", borderRadius: "6px", background: "var(--warning-subtle)" }}>
                          <div className="row between wrap" style={{ gap: "4px 12px" }}>
                            <span className="row wrap" style={{ gap: "6px 8px" }}>
                              <span className="badge badge-warning">사람이 풂</span>
                              <span className="t-sm fw-b">보류 사건(서비스 DB 보류 표) · 알림 3건</span>
                            </span>
                            <span className="t-xs muted">
                              <span className="num">19:41 KST</span>
                              부터
                            </span>
                          </div>
                          <p className="t-xs">
                            <span className="fw-b">왜:</span>
                            {' '}처리하지 못한 사건을 서비스 DB 보류 표에 옮김 · 같은 주문의 뒤 사건도 함께 보류(SEV3)
                          </p>
                          <p className="t-xs">
                            <span className="fw-b">풀림:</span>
                            {' '}원인을 고친 뒤 엔지니어가 RB-11 '보류 사건 다시 처리'로 다시 넣습니다. 이미 반영된 사건은 건너뜁니다
                          </p>
                          <div className="row wrap" style={{ gap: "4px 14px" }}>
                            <a href="https://runbook.ops.peaket.example/RB-11" target="_blank" rel="noreferrer" className="link-more">
                              RB-11
                              <i className="ic ic-chevron-right" aria-hidden="true" />
                            </a>
                            <a href="https://grafana.ops.peaket.example/d/onsale" target="_blank" rel="noreferrer" className="link-more" aria-label="보류 사건 자세히 보기, Grafana 새 탭">
                              자세히 보기
                              <i className="ic ic-external" aria-hidden="true" />
                            </a>
                          </div>
                        </li>
                        <li className="col" style={{ gap: "4px", padding: "8px 10px", borderRadius: "6px", boxShadow: "inset 0 0 0 1px var(--border)" }}>
                          <div className="row between wrap" style={{ gap: "4px 12px" }}>
                            <span className="row wrap" style={{ gap: "6px 8px" }}>
                              <span className="badge badge-primary">자동 해제 대기</span>
                              <span className="t-sm fw-b">배포 잠금 · 28일 에러 버짓 전량 소진(공연 상세)</span>
                            </span>
                            <span className="t-xs muted">
                              <span className="num">10/14(수) 09:40 KST</span>
                              부터
                            </span>
                          </div>
                          <p className="t-xs">
                            <span className="fw-b">풀림:</span>
                            {' '}28일 창의 남은 예산이 0보다 커지면 자동으로 풀립니다 → 지금{' '}
                            <span className="num">−0.3%</span>
                          </p>
                          <p className="t-xs muted">commander는 사유를 적어 연장할 수 있습니다 · 잠금 중 긴급 변경은 RB-23</p>
                        </li>
                      </ul>
                    </div>
                  </div>
                  <p className="t-xs" style={{ marginTop: "auto", paddingTop: "8px", borderTop: "1px solid var(--border)" }}>
                    <span className="fw-b">판단:</span>
                    {' '}사람이 푸는 조치는 그 손잡이(명령·런북)를 봅니다. 자동 해제를 기다리는 조치는 막대가 차는지 보고, 오래 차지 않으면 런북의 다음 단계로 갑니다.
                  </p>
                </div>
              </section>
            </>
          ) : null}
          {' '}
          {v.isBudget ? (
            <>
              <section className="widget" role="region" id="w-auto" aria-labelledby="w-auto-bh">
                <div className="widget-head">
                  <h2 className="t-sm fw-b" id="w-auto-bh">걸린 자동 조치</h2>
                  <span className="badge badge-warning">걸림 1</span>
                  <div className="actions"><span className="t-xs muted">15초 전 갱신</span></div>
                </div>
                <div className="widget-body">
                  <div className="col" style={{ gap: "12px" }}>
                    <div className="col" role="group" aria-labelledby="w-auto-bev" style={{ gap: "6px" }}>
                      <h3 className="eyebrow" id="w-auto-bev">이 회차 · LUMEN 10/25 18:00</h3>
                      <ul className="col" style={{ gap: "6px" }}>
                        {v.isB50 ? (
                          <>
                            <li className="col" style={{ gap: "4px", padding: "8px 10px", borderRadius: "6px", background: "var(--warning-subtle)" }}>
                              <div className="row between wrap" style={{ gap: "4px 12px" }}>
                                <span className="row wrap" style={{ gap: "6px 8px" }}>
                                  <span className="badge badge-warning">사람이 풂</span>
                                  <span className="t-sm fw-b">에러 버짓 연동 감축 · 자동 증액 멈춤</span>
                                </span>
                                <span className="t-xs muted">
                                  <span className="num">20:04:05 KST</span>
                                  부터 · 7초
                                </span>
                              </div>
                              <p className="t-xs">
                                <span className="fw-b">왜:</span>
                                {' '}좌석 홀드 온세일 예산 50% 넘음 · 동시 입장 목표 1,500 → 1,000명(안전 하한)
                              </p>
                              <p className="t-xs">
                                <span className="fw-b">풀림:</span>
                                {' '}운영자가 명령 1로 목표를 정하면 풀립니다. 그 뒤 15분 자동 조절 멈춤과 복귀 확인을 거쳐 자동 조절로 돌아갑니다
                              </p>
                              <div className="row wrap" style={{ gap: "4px 14px" }}>
                                <a href="https://runbook.ops.peaket.example/" target="_blank" rel="noreferrer" className="link-more">
                                  런북
                                  <i className="ic ic-chevron-right" aria-hidden="true" />
                                </a>
                              </div>
                            </li>
                          </>
                        ) : null}
                        {' '}
                        {v.isB100 ? (
                          <>
                            <li className="col" style={{ gap: "4px", padding: "8px 10px", borderRadius: "6px", background: "var(--warning-subtle)" }}>
                              <div className="row between wrap" style={{ gap: "4px 12px" }}>
                                <span className="row wrap" style={{ gap: "6px 8px" }}>
                                  <span className="badge badge-warning">사람이 풂</span>
                                  <span className="t-sm fw-b">에러 버짓 연동 감축 · 자동 증액 멈춤</span>
                                </span>
                                <span className="t-xs muted">
                                  <span className="num">20:02:58 KST</span>
                                  부터 · 1분 14초
                                </span>
                              </div>
                              <p className="t-xs">
                                <span className="fw-b">왜:</span>
                                {' '}좌석 홀드 온세일 예산 50% 넘음 · 동시 입장 목표 1,500 → 1,000명(안전 하한)
                              </p>
                              <p className="t-xs">
                                <span className="fw-b">풀림:</span>
                                {' '}운영자가 명령 1로 목표를 정하면 풀립니다. 그 뒤 15분 자동 조절 멈춤과 복귀 확인을 거쳐 자동 조절로 돌아갑니다
                              </p>
                              <div className="row wrap" style={{ gap: "4px 14px" }}>
                                <a href="https://runbook.ops.peaket.example/" target="_blank" rel="noreferrer" className="link-more">
                                  런북
                                  <i className="ic ic-chevron-right" aria-hidden="true" />
                                </a>
                              </div>
                            </li>
                          </>
                        ) : null}
                      </ul>
                    </div>
                    <div className="col" role="group" aria-labelledby="w-auto-bpf" style={{ gap: "6px" }}>
                      <h3 className="eyebrow" id="w-auto-bpf">플랫폼</h3>
                      <p className="t-sm muted" style={{ padding: "8px 10px", borderRadius: "6px", boxShadow: "inset 0 0 0 1px var(--border)" }}>
                        걸린 조치 없음
                      </p>
                    </div>
                  </div>
                  <p className="t-xs" style={{ marginTop: "auto", paddingTop: "8px", borderTop: "1px solid var(--border)" }}>
                    <span className="fw-b">판단:</span>
                    {' '}사람이 푸는 조치는 그 손잡이(명령·런북)를 봅니다.
                  </p>
                </div>
              </section>
            </>
          ) : null}
          <section className="widget" role="region" aria-labelledby="w-alert-l">
            <div className="widget-head">
              <h2 className="t-sm fw-b" id="w-alert-l">경보 패널</h2>
              <div className="actions">
                <Link to="/audit" className="link-more">
                  경보 전체 목록
                  <i className="ic ic-chevron-right" aria-hidden="true" />
                </Link>
              </div>
            </div>
            <div className="widget-body">
              {v.notSupp ? (
                <>
                  <div className="row" style={{ gap: "10px", padding: "10px 12px", borderRadius: "var(--r-md)", boxShadow: "inset 0 0 0 1px var(--border)" }}>
                    <span className="badge badge-danger">SEV1</span>
                    <span className="t-sm muted">울리는 경보 없음</span>
                  </div>
                </>
              ) : null}
              {' '}
              {v.isSupp ? (
                <>
                  <div className="col" role="group" aria-label="SEV1 경보" style={{ gap: "6px", padding: "10px 12px", borderRadius: "var(--r-md)", background: "var(--danger-subtle)" }}>
                    <div className="row between" style={{ gap: "8px" }}>
                      <span className="badge badge-danger">
                        <i className="ic ic-alert-circle" aria-hidden="true" />
                        SEV1
                      </span>
                      <span className="t-xs num">20:04:02 KST · 10초 전</span>
                    </div>
                    <strong className="t-sm">대기열 진입 에러 버짓 10배 소진(2분·20초 창)</strong>
                    {' '}
                    <span className="t-xs muted">대응: 온콜 호출 · 입장 목표는 그대로(입장 목표 앞 여정)</span>
                    <div className="row wrap" style={{ gap: "6px 14px" }}>
                      <a href="https://runbook.ops.peaket.example/" target="_blank" rel="noreferrer" className="link-more">
                        런북
                        <i className="ic ic-chevron-right" aria-hidden="true" />
                      </a>
                      <a href="https://grafana.ops.peaket.example/d/onsale" target="_blank" rel="noreferrer" className="link-more">
                        Grafana
                        <i className="ic ic-external" aria-hidden="true" />
                      </a>
                      <a href="https://grafana.ops.peaket.example/d/onsale" target="_blank" rel="noreferrer" className="link-more" aria-label="실패 사건 보기, Grafana Explore 새 탭">
                        실패 사건 보기
                        <i className="ic ic-external" aria-hidden="true" />
                      </a>
                    </div>
                    <details style={{ padding: "6px 8px", borderRadius: "6px", background: "var(--surface)" }}>
                      <summary className="row t-xs" style={{ gap: "6px", cursor: "pointer", listStyle: "none" }}>
                        <i className="ic ic-chevron-down ic-14" aria-hidden="true" />
                        <span className="fw-b">관련 경보 1건 접힘 · 알림은 보내지 않았습니다</span>
                      </summary>
                      <p className="t-xs muted" style={{ padding: "6px 0 0 20px" }}>SEV2 대기열 진입 에러 버짓 3배 소진(5분·25초 창) · 20:03:50 KST</p>
                    </details>
                  </div>
                </>
              ) : null}
              <div className="col" style={{ gap: "8px" }} role="group" aria-labelledby="w-alert-l-ev">
                <h3 className="eyebrow" id="w-alert-l-ev">이 회차 판단 · LUMEN 10/25 18:00</h3>
                <ul className="col" style={{ gap: "8px" }}>
                  <li className="col" style={{ gap: "6px", padding: "10px 12px", borderRadius: "var(--r-md)", background: "var(--warning-subtle)" }}>
                    <div className="row between" style={{ gap: "8px" }}>
                      <span className="badge badge-warning">
                        <i className="ic ic-alert" aria-hidden="true" />
                        SEV2
                      </span>
                      <span className="t-xs num">20:03:41 KST · 31초 전</span>
                    </div>
                    <strong className="t-sm">좌석 홀드 에러 버짓 3배 소진(5분·25초 창)</strong>
                    {' '}
                    <span className="t-xs muted">대응: 운영자 상황 판단</span>
                    <div className="row wrap" style={{ gap: "6px 14px" }}>
                      <a href="https://runbook.ops.peaket.example/" target="_blank" rel="noreferrer" className="link-more">
                        런북
                        <i className="ic ic-chevron-right" aria-hidden="true" />
                      </a>
                      <a href="https://grafana.ops.peaket.example/d/onsale" target="_blank" rel="noreferrer" className="link-more">
                        Grafana
                        <i className="ic ic-external" aria-hidden="true" />
                      </a>
                      <a href="https://grafana.ops.peaket.example/d/onsale" target="_blank" rel="noreferrer" className="link-more" aria-label="실패 사건 보기, Grafana Explore, 새 탭">
                        실패 사건 보기
                        <i className="ic ic-external" aria-hidden="true" />
                      </a>
                    </div>
                  </li>
                  {v.isB50 ? (
                    <>
                      <li className="col" style={{ gap: "6px", padding: "10px 12px", borderRadius: "var(--r-md)", background: "var(--warning-subtle)" }}>
                        <div className="row between" style={{ gap: "8px" }}>
                          <span className="badge badge-warning">
                            <i className="ic ic-alert" aria-hidden="true" />
                            SEV2
                          </span>
                          <span className="t-xs num">20:04:05 KST · 7초 전</span>
                        </div>
                        <strong className="t-sm">예산 50% 감축 실행(좌석 홀드 · 동시 입장 목표 1,500 → 1,000명)</strong>
                        {' '}
                        <span className="t-xs muted">대응: 명령 1로 목표를 정합니다</span>
                        <div className="row wrap" style={{ gap: "6px 14px" }}>
                          <a href="https://runbook.ops.peaket.example/" target="_blank" rel="noreferrer" className="link-more">
                            런북
                            <i className="ic ic-chevron-right" aria-hidden="true" />
                          </a>
                          <a href="https://grafana.ops.peaket.example/d/onsale" target="_blank" rel="noreferrer" className="link-more">
                            Grafana
                            <i className="ic ic-external" aria-hidden="true" />
                          </a>
                        </div>
                      </li>
                    </>
                  ) : null}
                  {' '}
                  {v.isB100 ? (
                    <>
                      <li className="col" style={{ gap: "6px", padding: "10px 12px", borderRadius: "var(--r-md)", background: "var(--warning-subtle)" }}>
                        <div className="row between" style={{ gap: "8px" }}>
                          <span className="badge badge-warning">
                            <i className="ic ic-alert" aria-hidden="true" />
                            SEV2
                          </span>
                          <span className="t-xs num">20:02:58 KST · 1분 14초 전</span>
                        </div>
                        <strong className="t-sm">예산 50% 감축 실행(좌석 홀드 · 동시 입장 목표 1,500 → 1,000명)</strong>
                        {' '}
                        <span className="t-xs muted">대응: 명령 1로 목표를 정합니다</span>
                        <div className="row wrap" style={{ gap: "6px 14px" }}>
                          <a href="https://runbook.ops.peaket.example/" target="_blank" rel="noreferrer" className="link-more">
                            런북
                            <i className="ic ic-chevron-right" aria-hidden="true" />
                          </a>
                          <a href="https://grafana.ops.peaket.example/d/onsale" target="_blank" rel="noreferrer" className="link-more">
                            Grafana
                            <i className="ic ic-external" aria-hidden="true" />
                          </a>
                        </div>
                      </li>
                    </>
                  ) : null}
                  {' '}
                  {v.isB100 ? (
                    <>
                      <li className="col" style={{ gap: "6px", padding: "10px 12px", borderRadius: "var(--r-md)", background: "var(--danger-subtle)" }}>
                        <div className="row between" style={{ gap: "8px" }}>
                          <span className="badge badge-danger">
                            <i className="ic ic-alert-circle" aria-hidden="true" />
                            버짓 100%
                          </span>
                          <span className="t-xs num">20:04:09 KST · 3초 전</span>
                        </div>
                        <strong className="t-sm">좌석 홀드 에러 버짓 모두 소진 · Degraded 후보 제시 · 포스트모템 소집</strong>
                        {' '}
                        <span className="t-xs muted">대응: Degraded 후보 검토(명령 6, 2인. 태블릿이나 데스크톱에서)</span>
                        <div className="row wrap" style={{ gap: "6px 14px" }}>
                          <a href="https://runbook.ops.peaket.example/" target="_blank" rel="noreferrer" className="link-more">
                            런북
                            <i className="ic ic-chevron-right" aria-hidden="true" />
                          </a>
                        </div>
                      </li>
                    </>
                  ) : null}
                  {' '}
                  {v.isAuto ? (
                    <>
                      <li className="col" style={{ gap: "6px", padding: "10px 12px", borderRadius: "var(--r-md)", background: "var(--warning-subtle)" }}>
                        <div className="row between" style={{ gap: "8px" }}>
                          <span className="badge badge-warning">
                            <i className="ic ic-alert" aria-hidden="true" />
                            SEV2
                          </span>
                          <span className="t-xs num">20:02:51 KST · 1분 21초 전</span>
                        </div>
                        <strong className="t-sm">결제 Degraded 진입(토스페이먼츠 신규 결제 정지)</strong>
                        {' '}
                        <span className="t-xs muted">대응: 걸린 자동 조치에서 풀림 확인</span>
                        <div className="row wrap" style={{ gap: "6px 14px" }}>
                          <a href="https://runbook.ops.peaket.example/" target="_blank" rel="noreferrer" className="link-more">
                            런북
                            <i className="ic ic-chevron-right" aria-hidden="true" />
                          </a>
                          <a href="https://grafana.ops.peaket.example/d/onsale" target="_blank" rel="noreferrer" className="link-more">
                            Grafana
                            <i className="ic ic-external" aria-hidden="true" />
                          </a>
                        </div>
                      </li>
                    </>
                  ) : null}
                </ul>
              </div>
              <div className="col" style={{ gap: "8px" }} role="group" aria-labelledby="w-alert-l-pf">
                <h3 className="eyebrow" id="w-alert-l-pf">플랫폼·위생·법정</h3>
                <ul className="col" style={{ gap: "8px" }}>
                  <li className="col" style={{ gap: "6px", padding: "10px 12px", borderRadius: "var(--r-md)", boxShadow: "inset 0 0 0 1px var(--border)" }}>
                    <span className="badge" style={{ alignSelf: "flex-start" }}>SEV3</span>
                    {' '}
                    <span className="t-sm">
                      4건 · 다음 업무일에 처리(GitHub Issues 자동 등록)
                      {v.isStale ? (
                        <>
                          · 실시간 표 낡음(대체 표시) 포함
                        </>
                      ) : null}
                      {v.isGap ? (
                        <>
                          · 거래 사건 끊김(판매 사건 60초 넘게 없음) 포함
                        </>
                      ) : null}
                    </span>
                    {' '}
                    <span className="t-xs muted">대응: 관제 표시만</span>
                    {' '}
                    <a href="#" className="link-more">
                      4건 보기
                      <i className="ic ic-chevron-right" aria-hidden="true" />
                    </a>
                  </li>
                </ul>
              </div>
              <p className="t-xs muted">
                판단 순서: 돈과 좌석(불변식) → 여정별 남은 허용 실패와 소진 속도 → 4대 신호 → 몇 분짜리 분류 → 되돌릴 수 있는 약한 조치부터(최근 변경이면 되돌리기, 명령 1 → 2 → 6 → 3) → 알림
              </p>
            </div>
          </section>
          <details className="widget" open>
            <summary className="widget-head">
              <span>퍼널(F3)</span>
              <span className="fold-meta">
                {v.isBack ? (
                  <>
                    <span className="slo slo-burning">52초 전</span>
                  </>
                ) : null}
                <span className="badge badge-outline">잠정</span>
                <span>전환 16.0%</span>
                <i className="ic ic-chevron-down fold-ic" aria-hidden="true" />
              </span>
            </summary>
            <div className="widget-body">
              <div className="row" style={{ justifyContent: "flex-end", gap: "12px" }}>
                <button className="btn btn-ghost btn-sm" type="button" aria-pressed="false">
                  <i className="ic ic-list" aria-hidden="true" />
                  표로 보기
                </button>
                <a href="https://grafana.ops.peaket.example/d/onsale" target="_blank" rel="noreferrer" className="link-more" aria-label="퍼널 자세히 보기, Grafana, 새 탭">
                  자세히 보기
                  <i className="ic ic-external" aria-hidden="true" />
                </a>
              </div>
              <figure className="col" style={{ gap: "4px" }}>
                <figcaption className="col t-xs" style={{ gap: "2px" }}>
                  <span className="fw-b">입장 → 첫 홀드 성공 → 결제 접수 → 승인 → 발권</span>
                  <span className="muted">숫자 · 앞 단계 대비</span>
                </figcaption>
                <svg className="chart" viewBox="0 0 320 136" role="img" aria-label="퍼널. 입장 4,960, 첫 홀드 성공 1,402(앞 단계 대비 28.3%), 결제 접수 818(58.3%), 승인 793(96.9%), 발권 790(99.6%).">
                  <text className="axis" x="72" y="19" textAnchor="end">입장</text>
                  <rect className="bar" x="78" y="6" width="160" height="18" rx="3" />
                  <text className="axis" x="244" y="19">4,960</text>
                  <text className="axis" x="72" y="46" textAnchor="end">첫 홀드 성공</text>
                  <rect className="bar" x="78" y="33" width="45.2" height="18" rx="3" />
                  <text className="axis" x="129.2" y="46">1,402 · 28.3%</text>
                  <text className="axis" x="72" y="73" textAnchor="end">결제 접수</text>
                  <rect className="bar" x="78" y="60" width="26.4" height="18" rx="3" />
                  <text className="axis" x="110.4" y="73">818 · 58.3%</text>
                  <text className="axis" x="72" y="100" textAnchor="end">승인</text>
                  <rect className="bar" x="78" y="87" width="25.6" height="18" rx="3" />
                  <text className="axis" x="109.6" y="100">793 · 96.9%</text>
                  <text className="axis" x="72" y="127" textAnchor="end">발권</text>
                  <rect className="bar" x="78" y="114" width="25.5" height="18" rx="3" />
                  <text className="axis" x="109.5" y="127">790 · 99.6%</text>
                </svg>
              </figure>
              <div className="stat" style={{ padding: "12px" }}>
                <span className="row wrap stat-label" style={{ gap: "4px" }}>
                  입장 → 구매 전환율
                  <span className="badge badge-outline">잠정</span>
                </span>
                <span className="stat-value">16.0%</span>
                <span className="stat-meta">승인 793 ÷ 입장 4,960 · 구매가 진행 중이라 마감(R1)에서 확정합니다</span>
              </div>
              <p className="t-xs" style={{ paddingTop: "8px", borderTop: "1px solid var(--border)" }}>
                <span className="fw-b">판단:</span>
                {' '}잠정 숫자라 운영 명령의 참고로만 씁니다. 판매 정책은 확정 숫자로 바꿉니다(POL-040). 단계 비율이 기준선의 절반 아래로 떨어지면 경보 패널 '이 회차 판단'에 SEV2 처리량 급감이 뜹니다. RB-33: 막힌 단계 찾기 → 최근 변경이면 되돌리기 → 원인을 모르면 명령 2
              </p>
            </div>
          </details>
          <details className="widget">
            <summary className="widget-head">
              <span>입장 비율·빈자리</span>
              <span className="fold-meta">
                {v.isBack ? (
                  <>
                    <span className="slo slo-burning">52초 전</span>
                  </>
                ) : null}
                {v.notBudget ? (
                  <>
                    <span>입장 비율 92%</span>
                  </>
                ) : null}
                {v.isBudget ? (
                  <>
                    <span>입장 비율 92% · 빈자리 0</span>
                  </>
                ) : null}
                <i className="ic ic-chevron-down fold-ic" aria-hidden="true" />
              </span>
            </summary>
            <div className="widget-body">
              <div className="row" style={{ justifyContent: "flex-end" }}>
                <a href="https://grafana.ops.peaket.example/d/onsale" target="_blank" rel="noreferrer" className="link-more" aria-label="입장 비율·빈자리 자세히 보기, Grafana, 새 탭">
                  자세히 보기
                  <i className="ic ic-external" aria-hidden="true" />
                </a>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(2,minmax(0,1fr))", gap: "8px" }}>
                <div className="stat" style={{ padding: "12px" }}>
                  <span className="row wrap stat-label" style={{ gap: "4px" }}>입장 비율</span>
                  <span className="stat-value">92%</span>
                  <span className="stat-meta">불린 번호 가운데 입장 확정을 요청한 비율(불린 지 10~60초인 전진)</span>
                </div>
                {v.notBudget ? (
                  <>
                    <div className="stat" style={{ padding: "12px" }}>
                      <span className="row wrap stat-label" style={{ gap: "4px" }}>빈자리(입장 자리)</span>
                      <span className="stat-value">118자리</span>
                      <span className="stat-meta">동시 입장 목표 1,500명 − 예매 단계 인원 1,382명</span>
                    </div>
                  </>
                ) : null}
                {v.isBudget ? (
                  <>
                    <div className="stat" style={{ padding: "12px" }}>
                      <span className="row wrap stat-label" style={{ gap: "4px" }}>빈자리(입장 자리)</span>
                      <span className="stat-value">0자리</span>
                      <span className="stat-meta">동시 입장 목표 1,000명 − 예매 단계 인원 1,382명 · 목표 아래로 내려올 때까지 새 입장을 멈춥니다</span>
                    </div>
                  </>
                ) : null}
              </div>
              <ul className="col t-xs" style={{ gap: "4px" }}>
                <li className="row between" style={{ gap: "8px" }}>
                  <span className="muted">오는 중(불렀지만 아직 입장 확정 전)</span>
                  <span className="num">24명</span>
                </li>
                <li className="row between" style={{ gap: "8px" }}>
                  <span className="muted">곧 입장 대기</span>
                  <span className="num">30명</span>
                </li>
                <li className="row between" style={{ gap: "8px" }}>
                  <span className="muted">곧 입장 대기 p99(처음 SOON → 입장 확정)</span>
                  <span className="num">3.8초</span>
                </li>
              </ul>
              {v.notBudget ? (
                <>
                  <p className="t-xs muted">자동 제어가 보는 값과 같습니다(잠정 아님). serving 증가 = (빈자리 118 − 곧 입장 대기 30 − 오는 중 24) ÷ 입장 비율 0.92 ≈ 70</p>
                </>
              ) : null}
              {v.isBudget ? (
                <>
                  <p className="t-xs muted">자동 제어가 보는 값과 같습니다(잠정 아님). 빈자리가 0이라 serving 번호를 올리지 않습니다. 예매 단계 인원이 1,000명 아래로 내려오면 다시 올립니다</p>
                </>
              ) : null}
              <p className="t-xs" style={{ paddingTop: "8px", borderTop: "1px solid var(--border)" }}>
                <span className="fw-b">판단:</span>
                {' '}빈자리가 줄면 입장 속도가 자동으로 줄어듭니다(명령 없음)
              </p>
            </div>
          </details>
          <details className="widget">
            <summary className="widget-head">
              <span>구역별 잔여석</span>
              <span className="fold-meta">
                {v.isBack ? (
                  <>
                    <span className="slo slo-burning">52초 전</span>
                  </>
                ) : null}
                <span className="badge badge-outline">잠정</span>
                {v.isStale ? (
                  <>
                    <span className="badge badge-warning">대체 표시</span>
                  </>
                ) : null}
                {v.isGap ? (
                  <>
                    <span className="badge badge-warning">거래 사건 끊김</span>
                  </>
                ) : null}
                <span>남은 970석</span>
                <i className="ic ic-chevron-down fold-ic" aria-hidden="true" />
              </span>
            </summary>
            <div className="widget-body">
              <div className="row" style={{ justifyContent: "flex-end", gap: "12px" }}>
                <button className="btn btn-ghost btn-sm" type="button" aria-pressed="false">
                  <i className="ic ic-list" aria-hidden="true" />
                  표로 보기
                </button>
                <a href="https://grafana.ops.peaket.example/d/onsale" target="_blank" rel="noreferrer" className="link-more" aria-label="구역별 잔여석 자세히 보기, Grafana, 새 탭">
                  자세히 보기
                  <i className="ic ic-external" aria-hidden="true" />
                </a>
              </div>
              {v.notStale ? (
                <>
                  <span className="t-xs muted">숫자는 남은 좌석 수입니다. 색이 진할수록 남은 비율이 낮습니다.</span>
                  <div className="heat" aria-hidden="true" style={{ gridTemplateColumns: "repeat(3,minmax(0,1fr))" }}>
                    <span className="h1">50% 이상</span>
                    <span className="h2">10% 이상 50% 미만</span>
                    <span className="h3">10% 미만(매진 포함)</span>
                  </div>
                  <div className="heat" role="img" aria-label="구역별 남은 좌석. R1 4석, R2 12석, S1 120석, S2 160석, A1 300석, A2 374석. 모든 구역이 앞 열부터 팔렸습니다." style={{ gridTemplateColumns: "28px repeat(6,minmax(0,1fr)) 40px" }}>
                    <span style={{ background: "transparent" }}>열</span>
                    <span style={{ background: "transparent" }}>1~3</span>
                    <span style={{ background: "transparent" }}>4~6</span>
                    <span style={{ background: "transparent" }}>7~9</span>
                    <span style={{ background: "transparent" }}>10~12</span>
                    <span style={{ background: "transparent" }}>13~15</span>
                    <span style={{ background: "transparent" }}>16~18</span>
                    <span style={{ background: "transparent" }}>남음</span>
                    {' '}
                    <span style={{ background: "transparent", color: "var(--text)" }}>R1</span>
                    <span className="h3">0</span>
                    <span className="h3">0</span>
                    <span className="h3">0</span>
                    <span className="h3">1</span>
                    <span className="h3">3</span>
                    <span>—</span>
                    <span style={{ background: "transparent", color: "var(--text)" }}>4석</span>
                    {' '}
                    <span style={{ background: "transparent", color: "var(--text)" }}>R2</span>
                    <span className="h3">0</span>
                    <span className="h3">0</span>
                    <span className="h3">1</span>
                    <span className="h3">4</span>
                    <span className="h2">7</span>
                    <span>—</span>
                    <span style={{ background: "transparent", color: "var(--text)" }}>12석</span>
                    {' '}
                    <span style={{ background: "transparent", color: "var(--text)" }}>S1</span>
                    <span className="h3">5</span>
                    <span className="h2">10</span>
                    <span className="h2">17</span>
                    <span className="h2">23</span>
                    <span className="h2">30</span>
                    <span className="h2">35</span>
                    <span style={{ background: "transparent", color: "var(--text)" }}>120석</span>
                    {' '}
                    <span style={{ background: "transparent", color: "var(--text)" }}>S2</span>
                    <span className="h2">9</span>
                    <span className="h2">16</span>
                    <span className="h2">23</span>
                    <span className="h2">30</span>
                    <span className="h1">38</span>
                    <span className="h1">44</span>
                    <span style={{ background: "transparent", color: "var(--text)" }}>160석</span>
                    {' '}
                    <span style={{ background: "transparent", color: "var(--text)" }}>A1</span>
                    <span className="h2">31</span>
                    <span className="h1">41</span>
                    <span className="h1">49</span>
                    <span className="h1">55</span>
                    <span className="h1">61</span>
                    <span className="h1">63</span>
                    <span style={{ background: "transparent", color: "var(--text)" }}>300석</span>
                    {' '}
                    <span style={{ background: "transparent", color: "var(--text)" }}>A2</span>
                    <span className="h1">46</span>
                    <span className="h1">56</span>
                    <span className="h1">63</span>
                    <span className="h1">67</span>
                    <span className="h1">70</span>
                    <span className="h1">72</span>
                    <span style={{ background: "transparent", color: "var(--text)" }}>374석</span>
                  </div>
                </>
              ) : null}
              {' '}
              {v.isStale ? (
                <>
                  <div className="stat is-stale">
                    <span className="stat-label">전체 남은 좌석(퍼널 카운터로 대체 표시)</span>
                    <span className="stat-value">970석</span>
                    <span className="slo slo-stale">실시간 표가 3분 넘게 늦음</span>
                    <span className="stat-meta">구역별 값은 실시간 표가 돌아오면 다시 보입니다</span>
                  </div>
                </>
              ) : null}
              <p className="t-xs muted">남은 970석 / 2,400석 · 홀드·결제 중인 좌석도 남은 좌석에 셉니다(좌석맵이 따로 보임) · R구역은 15열까지라 16~18열이 없습니다(—)</p>
              <p className="t-xs" style={{ paddingTop: "8px", borderTop: "1px solid var(--border)" }}>
                <span className="fw-b">판단:</span>
                {' '}없음(파트너 문의 응대 참고)
              </p>
            </div>
          </details>
          <details className="widget" open>
            <summary className="widget-head">
              <span>결제사</span>
              <span className="fold-meta">
                {v.isBack ? (
                  <>
                    <span className="slo slo-burning">52초 전</span>
                  </>
                ) : null}
                <span className="slo slo-ok">정상</span>
                <span>승인 99.6%</span>
                <i className="ic ic-chevron-down fold-ic" aria-hidden="true" />
              </span>
            </summary>
            <div className="widget-body">
              <div className="row" style={{ justifyContent: "flex-end" }}>
                <a href="https://grafana.ops.peaket.example/d/onsale" target="_blank" rel="noreferrer" className="link-more" aria-label="결제사 자세히 보기, Grafana, 새 탭">
                  자세히 보기
                  <i className="ic ic-external" aria-hidden="true" />
                </a>
              </div>
              <ul className="col" style={{ gap: "8px" }}>
                <li className="col" style={{ gap: "6px", paddingBottom: "8px", borderBottom: "1px solid var(--border)" }}>
                  <div className="row between" style={{ gap: "8px" }}>
                    <span className="t-sm fw-b">토스페이먼츠(기본)</span>
                    {v.liveBase ? (
                      <>
                        <span className="slo slo-ok">상태 기본</span>
                      </>
                    ) : null}
                    {v.isAuto ? (
                      <>
                        <span className="slo slo-burning">신규 진입 정지(자동)</span>
                      </>
                    ) : null}
                  </div>
                  <ul className="col t-xs" style={{ gap: "4px" }}>
                    <li className="row between" style={{ gap: "8px" }}>
                      <span className="muted">승인</span>
                      <span className="num">99.6%</span>
                    </li>
                    <li className="row between" style={{ gap: "8px", alignItems: "flex-start" }}>
                      <span className="muted nowrap">승인 호출 p99</span>
                      <span className="num" style={{ textAlign: "right" }}>1.2초 · 경보 기준 2초 · 호출은 끊지 않습니다</span>
                    </li>
                    <li className="row between" style={{ gap: "8px", alignItems: "flex-start" }}>
                      <span className="muted nowrap">결제 확정 소요 p99</span>
                      <span className="num" style={{ textAlign: "right" }}>2.3초(재시도 포함) · 전환 검토 기준 5초(RB-07)</span>
                    </li>
                    <li className="row between" style={{ gap: "8px" }}>
                      <span className="muted">한도 사용률</span>
                      <span className="num">64%</span>
                    </li>
                    <li className="row between" style={{ gap: "8px" }}>
                      <span className="muted">한도 초과 응답</span>
                      <span className="num">0건</span>
                    </li>
                  </ul>
                </li>
                <li className="col" style={{ gap: "2px" }}>
                  <div className="row between" style={{ gap: "8px" }}>
                    <span className="t-sm fw-b">포트원(대체)</span>
                    <span className="slo slo-stale">대기</span>
                  </div>
                  <span className="t-xs muted">전환 후보 없음</span>
                </li>
              </ul>
              <p className="t-xs" style={{ paddingTop: "8px", borderTop: "1px solid var(--border)" }}>
                <span className="fw-b">판단:</span>
                {' '}임박 원인이면 결제사 상태를 보고 명령 1. 확정 소요 p99 5초 초과나 서킷 열림이면 RB-07: 명령 6(결제사 전환, 2인)·한도에 가까우면 명령 1
              </p>
            </div>
          </details>
          <details className="widget">
            <summary className="widget-head">
              <span>여정별 남은 허용 실패</span>
              <span className="fold-meta">
                {v.isBack ? (
                  <>
                    <span className="slo slo-burning">52초 전</span>
                  </>
                ) : null}
                {v.notSuppBud ? (
                  <>
                    <span className="slo slo-burning">경고 SEV2</span>
                    <span>홀드 3.2×</span>
                  </>
                ) : null}
                {v.isB50 ? (
                  <>
                    <span className="slo slo-burning">예산 50% 넘음</span>
                    <span>홀드 38/75</span>
                  </>
                ) : null}
                {v.isB100 ? (
                  <>
                    <span className="slo slo-breached">예산 모두 씀</span>
                    <span>홀드 75/75</span>
                  </>
                ) : null}
                {v.isSupp ? (
                  <>
                    <span className="slo slo-breached">SEV1</span>
                    <span>진입 10.6×</span>
                  </>
                ) : null}
                <i className="ic ic-chevron-down fold-ic" aria-hidden="true" />
              </span>
            </summary>
            <div className="widget-body">
              <div className="row" style={{ justifyContent: "flex-end" }}>
                <a href="https://grafana.ops.peaket.example/d/onsale" target="_blank" rel="noreferrer" className="link-more" aria-label="여정별 남은 허용 실패 자세히 보기, Grafana, 새 탭">
                  자세히 보기
                  <i className="ic ic-external" aria-hidden="true" />
                </a>
              </div>
              <ul className="col" style={{ gap: "9px" }}>
                <li className="col" style={{ gap: "4px" }}>
                  <div className="row between t-xs" style={{ gap: "8px" }}>
                    <span className="fw-b">결제 확정 12건 중 3건 사용</span>
                    <span className="slo slo-ok">남음 9건</span>
                  </div>
                  <div className="progress" role="progressbar" aria-label="결제 확정 허용 실패 25% 사용" aria-valuenow={25} aria-valuemin={0} aria-valuemax={100}>
                    <span style={{ width: "25%" }} />
                  </div>
                </li>
                {v.notBudget ? (
                  <>
                    <li className="col" style={{ gap: "4px" }}>
                      <div className="row between t-xs" style={{ gap: "8px" }}>
                        <span className="fw-b">좌석 홀드 75건 중 16건 사용</span>
                        <span className="slo slo-burning">남음 59건</span>
                      </div>
                      <div className="progress progress-warning" role="progressbar" aria-label="좌석 홀드 허용 실패 21% 사용" aria-valuenow={21} aria-valuemin={0} aria-valuemax={100}>
                        <span style={{ width: "21%" }} />
                      </div>
                    </li>
                  </>
                ) : null}
                {v.isB50 ? (
                  <>
                    <li className="col" style={{ gap: "4px" }}>
                      <div className="row between t-xs" style={{ gap: "8px" }}>
                        <span className="fw-b">좌석 홀드 75건 중 38건 사용</span>
                        <span className="slo slo-burning">남음 37건</span>
                      </div>
                      <div className="progress progress-warning" role="progressbar" aria-label="좌석 홀드 허용 실패 51% 사용" aria-valuenow={51} aria-valuemin={0} aria-valuemax={100}>
                        <span style={{ width: "51%" }} />
                      </div>
                    </li>
                  </>
                ) : null}
                {v.isB100 ? (
                  <>
                    <li className="col" style={{ gap: "4px" }}>
                      <div className="row between t-xs" style={{ gap: "8px" }}>
                        <span className="fw-b">좌석 홀드 75건 중 75건 사용</span>
                        <span className="slo slo-breached">남음 0건</span>
                      </div>
                      <div className="progress progress-warning" role="progressbar" aria-label="좌석 홀드 허용 실패 100% 사용" aria-valuenow={100} aria-valuemin={0} aria-valuemax={100}>
                        <span style={{ width: "100%" }} />
                      </div>
                    </li>
                  </>
                ) : null}
                {' '}
                {v.notSupp ? (
                  <>
                    <li className="col" style={{ gap: "4px" }}>
                      <div className="row between t-xs" style={{ gap: "8px" }}>
                        <span>대기열 진입 2,000건 중 186건 사용</span>
                        <span className="slo slo-ok">남음 1,814건</span>
                      </div>
                      <div className="progress" role="progressbar" aria-label="대기열 진입 허용 실패 9% 사용" aria-valuenow={9} aria-valuemin={0} aria-valuemax={100}>
                        <span style={{ width: "9%" }} />
                      </div>
                    </li>
                  </>
                ) : null}
                {v.isSupp ? (
                  <>
                    <li className="col" style={{ gap: "4px" }}>
                      <div className="row between t-xs" style={{ gap: "8px" }}>
                        <span className="fw-b">대기열 진입 2,000건 중 604건 사용</span>
                        <span className="slo slo-burning">남음 1,396건</span>
                      </div>
                      <div className="progress progress-warning" role="progressbar" aria-label="대기열 진입 허용 실패 30% 사용" aria-valuenow={30} aria-valuemin={0} aria-valuemax={100}>
                        <span style={{ width: "30%" }} />
                      </div>
                    </li>
                  </>
                ) : null}
                <li className="col" style={{ gap: "4px" }}>
                  <div className="row between t-xs" style={{ gap: "8px" }}>
                    <span>공연 상세 1,000건 중 41건 사용</span>
                    <span className="slo slo-ok">남음 959건</span>
                  </div>
                  <div className="progress" role="progressbar" aria-label="공연 상세 허용 실패 4% 사용" aria-valuenow={4} aria-valuemin={0} aria-valuemax={100}>
                    <span style={{ width: "4%" }} />
                  </div>
                </li>
              </ul>
              <div className="row between t-xs" style={{ gap: "8px", padding: "7px 6px", borderRadius: "6px", background: "var(--warning-subtle)" }}>
                <span className="fw-b">좌석 홀드 소진 배수</span>
                <span className="row" style={{ gap: "8px" }}>
                  <span className="num fw-b">3.2×</span>
                  <span className="slo slo-burning">경고 SEV2</span>
                </span>
              </div>
              {v.isSupp ? (
                <>
                  <div className="row between t-xs" style={{ gap: "8px", padding: "7px 6px", borderRadius: "6px", background: "var(--danger-subtle)" }}>
                    <span className="fw-b">대기열 진입 소진 배수</span>
                    <span className="row" style={{ gap: "8px" }}>
                      <span className="num fw-b">10.6×</span>
                      <span className="slo slo-breached">위험 SEV1</span>
                    </span>
                  </div>
                </>
              ) : null}
              {' '}
              {v.isBudget ? (
                <>
                  <p className="t-xs muted">입장 목표 감축은 좌석 홀드·좌석 상태 전파·결제 접수·결제 확정 여정의 예산으로만 합니다. 대기열 진입·공연 상세는 소진해도 목표를 바꾸지 않습니다.</p>
                </>
              ) : null}
              <p className="t-xs" style={{ paddingTop: "8px", borderTop: "1px solid var(--border)" }}>
                <span className="fw-b">판단:</span>
                {' '}판단 순서 ②. 최근 변경이면 되돌리기(RB-23), 명령 1 → 2 → 6 → 3
              </p>
            </div>
          </details>
          <details className="widget">
            <summary className="widget-head">
              <span>대기 순서</span>
              <span className="fold-meta">
                {v.isBack ? (
                  <>
                    <span className="slo slo-burning">52초 전</span>
                  </>
                ) : null}
                <span className="slo slo-ok">정상</span>
                <span>차례 전 입장 0건</span>
                <i className="ic ic-chevron-down fold-ic" aria-hidden="true" />
              </span>
            </summary>
            <div className="widget-body">
              <div className="row" style={{ justifyContent: "flex-end" }}>
                <a href="https://grafana.ops.peaket.example/d/onsale" target="_blank" rel="noreferrer" className="link-more" aria-label="대기 순서 자세히 보기, Grafana, 새 탭">
                  자세히 보기
                  <i className="ic ic-external" aria-hidden="true" />
                </a>
              </div>
              <div className="stat">
                <span className="stat-label">차례 전 입장</span>
                <span className="stat-value">0건</span>
                <span className="slo slo-ok">정상 · 0건 불변식</span>
              </div>
              <ul className="col t-xs" style={{ gap: "6px" }}>
                <li className="row between" style={{ gap: "8px", alignItems: "flex-start" }}>
                  <span className="muted">차례가 온 뒤 시스템 원인으로 못 들어간 사람</span>
                  <span className="num nowrap">3명</span>
                </li>
                <li className="row between" style={{ gap: "8px" }}>
                  <span className="muted">예상 대기 오차 중앙값</span>
                  <span className="num">1.1배</span>
                </li>
              </ul>
              <p className="t-xs" style={{ paddingTop: "8px", borderTop: "1px solid var(--border)" }}>
                <span className="fw-b">판단:</span>
                {' '}차례 전 입장이 1건이면 SEV1(불변식, RB-36). 명령 2를 검토하고 엔지니어를 부릅니다
              </p>
            </div>
          </details>
          <details className="widget">
            <summary className="widget-head">
              <span>포화도 요약</span>
              <span className="fold-meta">
                {v.isBack ? (
                  <>
                    <span className="slo slo-burning">52초 전</span>
                  </>
                ) : null}
                <span className="slo slo-burning">주의</span>
                <span>Redis CPU 71%</span>
                <i className="ic ic-chevron-down fold-ic" aria-hidden="true" />
              </span>
            </summary>
            <div className="widget-body" style={{ gap: "8px" }}>
              <div className="row" style={{ justifyContent: "flex-end" }}>
                <a href="https://grafana.ops.peaket.example/d/onsale" target="_blank" rel="noreferrer" className="link-more" aria-label="포화도 요약 자세히 보기, Grafana, 새 탭">
                  자세히 보기
                  <i className="ic ic-external" aria-hidden="true" />
                </a>
              </div>
              <div className="row between t-xs muted">
                <span>자원</span>
                <span>지금 · 판정</span>
              </div>
              <ul className="col">
                <li className="row between" style={{ gap: "8px", padding: "7px 0", borderBottom: "1px solid var(--border)" }}>
                  <span className="t-sm">핫패스 CPU 평균</span>
                  <span className="row" style={{ gap: "8px" }}>
                    <span className="num t-xs">62%</span>
                    <span className="slo slo-ok">정상</span>
                  </span>
                </li>
                <li className="row between" style={{ gap: "8px", padding: "7px 6px", margin: "2px 0", borderRadius: "6px", background: "var(--warning-subtle)" }}>
                  <span className="t-sm fw-b">좌석 Redis CPU</span>
                  <span className="row" style={{ gap: "8px" }}>
                    <span className="num t-xs fw-b">71%</span>
                    <span className="slo slo-burning">주의</span>
                  </span>
                </li>
                <li className="row between" style={{ gap: "8px", padding: "7px 0", borderBottom: "1px solid var(--border)" }}>
                  <span className="t-sm">좌석 Redis 메모리</span>
                  <span className="row" style={{ gap: "8px" }}>
                    <span className="num t-xs">41%</span>
                    <span className="slo slo-ok">정상</span>
                  </span>
                </li>
                <li className="row between" style={{ gap: "8px", padding: "7px 0", borderBottom: "1px solid var(--border)" }}>
                  <span className="t-sm">Kafka lag 최대</span>
                  <span className="row" style={{ gap: "8px" }}>
                    <span className="num t-xs">1.2초</span>
                    <span className="slo slo-ok">정상</span>
                  </span>
                </li>
                <li className="row between" style={{ gap: "8px", padding: "7px 6px", marginTop: "2px", borderRadius: "6px", background: "var(--warning-subtle)" }}>
                  <span className="col" style={{ gap: "2px" }}>
                    <span className="t-sm fw-b">이벤트 루프 지연 p99</span>
                    <span className="t-xs muted">purchase-svc</span>
                  </span>
                  <span className="row" style={{ gap: "8px" }}>
                    <span className="num t-xs fw-b">38ms</span>
                    <span className="slo slo-burning">주의</span>
                  </span>
                </li>
              </ul>
              <p className="t-xs muted">주의·위험 기준은 측정 뒤 확정합니다 [가정]</p>
              <p className="t-xs" style={{ paddingTop: "8px", borderTop: "1px solid var(--border)" }}>
                <span className="fw-b">판단:</span>
                {' '}'위험'이면 명령 1로 목표를 낮추고 엔지니어를 부릅니다
              </p>
            </div>
          </details>
          <details className="widget">
            <summary className="widget-head">
              <span>오류(Sentry)</span>
              <span className="fold-meta">
                {v.isBack ? (
                  <>
                    <span className="slo slo-burning">52초 전</span>
                  </>
                ) : null}
                <span className="slo slo-ok">정상</span>
                <span>새 오류 0종</span>
                <i className="ic ic-chevron-down fold-ic" aria-hidden="true" />
              </span>
            </summary>
            <div className="widget-body">
              <div className="row" style={{ justifyContent: "flex-end" }}>
                <a href="https://grafana.ops.peaket.example/d/onsale" target="_blank" rel="noreferrer" className="link-more" aria-label="오류 자세히 보기, Sentry, 새 탭">
                  자세히 보기
                  <i className="ic ic-external" aria-hidden="true" />
                </a>
              </div>
              <div className="stat">
                <span className="stat-label">배포 뒤 새로 생긴 오류 종류</span>
                <span className="stat-value">0종</span>
                <span className="stat-meta">마지막 배포 10/13(화) 22:10 KST</span>
              </div>
              <h3 className="eyebrow">많이 난 오류 상위 5</h3>
              <ol className="col">
                <li className="row between" style={{ gap: "8px", padding: "7px 0", borderBottom: "1px solid var(--border)" }}>
                  <span className="t-sm">결제창 닫힘 처리 경고(웹)</span>
                  <span className="num t-xs nowrap">212건</span>
                </li>
                <li className="row between" style={{ gap: "8px", padding: "7px 0", borderBottom: "1px solid var(--border)" }}>
                  <span className="t-sm">좌석 상태 스냅샷 재요청(웹)</span>
                  <span className="num t-xs nowrap">148건</span>
                </li>
                <li className="row between" style={{ gap: "8px", padding: "7px 0", borderBottom: "1px solid var(--border)" }}>
                  <span className="t-sm">구매 세션 만료 뒤 요청(서버)</span>
                  <span className="num t-xs nowrap">61건</span>
                </li>
                <li className="row between" style={{ gap: "8px", padding: "7px 0", borderBottom: "1px solid var(--border)" }}>
                  <span className="t-sm">결제사 응답 시간 초과(서버)</span>
                  <span className="num t-xs nowrap">9건</span>
                </li>
                <li className="row between" style={{ gap: "8px", padding: "7px 0" }}>
                  <span className="t-sm">WebSocket 재연결 실패(웹)</span>
                  <span className="num t-xs nowrap">7건</span>
                </li>
              </ol>
              <p className="t-xs" style={{ paddingTop: "8px", borderTop: "1px solid var(--border)" }}>
                <span className="fw-b">판단:</span>
                {' '}배포 뒤 새 오류가 늘면 되돌리기를 검토합니다(RB-23, commander). 엔지니어를 부릅니다
              </p>
            </div>
          </details>
          <details className="widget">
            <summary className="widget-head">
              <span className="col" style={{ gap: "2px" }}>
                <span>진단 힌트 · 운영 명령 없음</span>
                <span className="t-xs muted fw-m">엔지니어가 원인을 볼 때 씁니다</span>
              </span>
              <span className="fold-meta">
                {v.isBack ? (
                  <>
                    <span className="slo slo-burning">52초 전</span>
                  </>
                ) : null}
                <span className="slo slo-ok">정상</span>
                <i className="ic ic-chevron-down fold-ic" aria-hidden="true" />
              </span>
            </summary>
            <div className="widget-body">
              <div className="col" style={{ gap: "6px" }} role="group" aria-labelledby="dh-rum">
                <div className="row between" style={{ gap: "8px" }}>
                  <h3 className="eyebrow" id="dh-rum">① 체감(RUM, 모바일)</h3>
                  <a href="https://grafana.ops.peaket.example/d/onsale" target="_blank" rel="noreferrer" className="link-more" aria-label="체감 자세히 보기, Grafana, 새 탭">
                    자세히 보기
                    <i className="ic ic-external" aria-hidden="true" />
                  </a>
                </div>
                <ul className="col t-xs" style={{ gap: "4px" }}>
                  <li className="row between" style={{ gap: "8px" }}>
                    <span className="muted">INP p75</span>
                    <span className="row" style={{ gap: "8px" }}>
                      <span className="num">168ms · 기준 200ms</span>
                      <span className="slo slo-ok">정상</span>
                    </span>
                  </li>
                  <li className="row between" style={{ gap: "8px" }}>
                    <span className="muted">LCP p75</span>
                    <span className="row" style={{ gap: "8px" }}>
                      <span className="num">2.1초 · 기준 2.5초</span>
                      <span className="slo slo-ok">정상</span>
                    </span>
                  </li>
                </ul>
              </div>
              <div className="divider" />
              <div className="col" style={{ gap: "6px" }} role="group" aria-labelledby="dh-sql">
                <div className="row between" style={{ gap: "8px" }}>
                  <h3 className="eyebrow" id="dh-sql">② 느린 쿼리 상위 5</h3>
                  <a href="https://grafana.ops.peaket.example/d/onsale" target="_blank" rel="noreferrer" className="link-more" aria-label="느린 쿼리 자세히 보기, Grafana, 새 탭">
                    자세히 보기
                    <i className="ic ic-external" aria-hidden="true" />
                  </a>
                </div>
                <div className="row between t-xs muted" style={{ gap: "8px" }}>
                  <span>DB · queryid 앞 8자리</span>
                  <span>호출 수 · 평균 · 최대</span>
                </div>
                <ol className="col">
                  <li className="row between" style={{ gap: "8px", padding: "6px 0", borderBottom: "1px solid var(--border)" }}>
                    <span className="row t-xs" style={{ gap: "6px" }}>
                      <span className="muted">purchase</span>
                      <span className="mono">5c1e9a07</span>
                    </span>
                    <span className="num t-xs">18,420 · 4.1ms · 88ms</span>
                  </li>
                  <li className="row between" style={{ gap: "8px", padding: "6px 0", borderBottom: "1px solid var(--border)" }}>
                    <span className="row t-xs" style={{ gap: "6px" }}>
                      <span className="muted">purchase</span>
                      <span className="mono">9b0f33c2</span>
                    </span>
                    <span className="num t-xs">9,812 · 6.8ms · 140ms</span>
                  </li>
                  <li className="row between" style={{ gap: "8px", padding: "6px 0", borderBottom: "1px solid var(--border)" }}>
                    <span className="row t-xs" style={{ gap: "6px" }}>
                      <span className="muted">payment</span>
                      <span className="mono">2d77e410</span>
                    </span>
                    <span className="num t-xs">1,604 · 12.3ms · 310ms</span>
                  </li>
                  <li className="row between" style={{ gap: "8px", padding: "6px 0", borderBottom: "1px solid var(--border)" }}>
                    <span className="row t-xs" style={{ gap: "6px" }}>
                      <span className="muted">core</span>
                      <span className="mono">71aa0c58</span>
                    </span>
                    <span className="num t-xs">920 · 3.2ms · 41ms</span>
                  </li>
                  <li className="row between" style={{ gap: "8px", padding: "6px 0" }}>
                    <span className="row t-xs" style={{ gap: "6px" }}>
                      <span className="muted">ops</span>
                      <span className="mono">e03b5d19</span>
                    </span>
                    <span className="num t-xs">214 · 8.9ms · 77ms</span>
                  </li>
                </ol>
                <p className="t-xs muted">쿼리 문장은 Grafana 제한 조직의 읽기 전용 계정으로 봅니다</p>
              </div>
              <div className="divider" />
              <div className="col" style={{ gap: "6px" }} role="group" aria-labelledby="dh-net">
                <div className="row between" style={{ gap: "8px" }}>
                  <h3 className="eyebrow" id="dh-net">③ 네트워크</h3>
                  <a href="https://grafana.ops.peaket.example/d/onsale" target="_blank" rel="noreferrer" className="link-more" aria-label="네트워크 자세히 보기, Grafana, 새 탭">
                    자세히 보기
                    <i className="ic ic-external" aria-hidden="true" />
                  </a>
                </div>
                <ul className="col t-xs" style={{ gap: "4px" }}>
                  <li className="row between" style={{ gap: "8px" }}>
                    <span className="muted">상태</span>
                    <span className="slo slo-ok">정상</span>
                  </li>
                  <li className="row between" style={{ gap: "8px" }}>
                    <span className="muted">연결 대기열 넘침</span>
                    <span className="num">0건</span>
                  </li>
                  <li className="row between" style={{ gap: "8px" }}>
                    <span className="muted">TCP 재전송</span>
                    <span className="num">0.08%</span>
                  </li>
                </ul>
              </div>
              <p className="t-xs" style={{ paddingTop: "8px", borderTop: "1px solid var(--border)" }}>
                <span className="fw-b">판단:</span>
                {' '}엔지니어 호출만
              </p>
            </div>
          </details>
        </div>
      </>
    ) : null}
    {' '}
    {v.isT30 ? (
      <>
        <div className="col" role="tabpanel" id="panel-t30" aria-labelledby="tab-t30" style={{ gap: "12px" }}>
          <details className="widget" open>
            <summary className="widget-head">
              <span>T-30분 점검 · 필수 13 · 권고 2</span>
              <span className="fold-meta">
                <span className="slo slo-breached">실패 1</span>
                <i className="ic ic-chevron-down fold-ic" aria-hidden="true" />
              </span>
            </summary>
            <div className="widget-body" style={{ gap: "4px" }}>
              <p className="t-xs muted num">점검 19:32:40 KST · 읽기 전용</p>
              <h3 className="eyebrow" style={{ marginTop: "6px" }}>필수 · 하나라도 실패하면 No-Go</h3>
              <ul className="col">
                <li className="row" style={{ gap: "10px", alignItems: "flex-start", padding: "8px 0", borderBottom: "1px solid var(--border)" }}>
                  <input className="cb" type="checkbox" defaultChecked disabled aria-labelledby="pf1" aria-describedby="pf1d" />
                  <span className="col grow" style={{ gap: "2px" }}>
                    <span className="t-sm fw-m" id="pf1">프리워밍(T-40분 시작 [가정], 최소 복제 수 미달이면 RB-02, T-20분까지 회복 못 하면 입장 일시정지로 오픈)</span>
                    <span className="t-xs muted" id="pf1d">19:20 KST 시작 · 노드·파드 최소 복제 수 충족</span>
                  </span>
                  <span className="slo slo-ok">통과</span>
                </li>
                <li className="row" style={{ gap: "10px", alignItems: "flex-start", padding: "8px 0", borderBottom: "1px solid var(--border)" }}>
                  <input className="cb" type="checkbox" defaultChecked disabled aria-labelledby="pf2" aria-describedby="pf2d" />
                  <span className="col grow" style={{ gap: "2px" }}>
                    <span className="t-sm fw-m" id="pf2">Redis·Kafka·PostgreSQL 헬스</span>
                    <span className="t-xs muted" id="pf2d">세 저장소 헬스체크 정상</span>
                  </span>
                  <span className="slo slo-ok">통과</span>
                </li>
                <li className="row" style={{ gap: "10px", alignItems: "flex-start", padding: "8px 0", borderBottom: "1px solid var(--border)" }}>
                  <input className="cb" type="checkbox" defaultChecked disabled aria-labelledby="pf3" aria-describedby="pf3d" />
                  <span className="col grow" style={{ gap: "2px" }}>
                    <span className="t-sm fw-m" id="pf3">그 공연 결제사 상태와 한도 초과 응답 없음</span>
                    <span className="t-xs muted" id="pf3d">토스페이먼츠 정상 · 한도 초과 응답 0건</span>
                  </span>
                  <span className="slo slo-ok">통과</span>
                </li>
                <li className="row" style={{ gap: "10px", alignItems: "flex-start", padding: "8px 0", borderBottom: "1px solid var(--border)" }}>
                  <input className="cb" type="checkbox" defaultChecked disabled aria-labelledby="pf4" aria-describedby="pf4d" />
                  <span className="col grow" style={{ gap: "2px" }}>
                    <span className="t-sm fw-m" id="pf4">본인확인·사람 확인 제공자</span>
                    <span className="t-xs muted" id="pf4d">두 제공자 정상</span>
                  </span>
                  <span className="slo slo-ok">통과</span>
                </li>
                <li className="row" style={{ gap: "10px", alignItems: "flex-start", padding: "8px 0", borderBottom: "1px solid var(--border)" }}>
                  <input className="cb" type="checkbox" defaultChecked disabled aria-labelledby="pf5" aria-describedby="pf5d" />
                  <span className="col grow" style={{ gap: "2px" }}>
                    <span className="t-sm fw-m" id="pf5">CloudFront 배포별 한도 ≥ 그 회차 설계 피크</span>
                    <span className="t-xs muted" id="pf5d">공연 페이지·대기열 파일·대기열 API 세 배포 모두 승인 한도가 설계 피크 이상</span>
                  </span>
                  <span className="slo slo-ok">통과</span>
                </li>
                <li className="row" style={{ gap: "10px", alignItems: "flex-start", padding: "8px 0", borderBottom: "1px solid var(--border)" }}>
                  <input className="cb" type="checkbox" defaultChecked disabled aria-labelledby="pf6" aria-describedby="pf6d" />
                  <span className="col grow" style={{ gap: "2px" }}>
                    <span className="t-sm fw-m" id="pf6">대기실·상세·결제 종합 합성 점검</span>
                    <span className="t-xs muted" id="pf6d">세 경로 통과 · 19:31 KST</span>
                  </span>
                  <span className="slo slo-ok">통과</span>
                </li>
                <li className="row" style={{ gap: "10px", alignItems: "flex-start", padding: "8px 0", borderBottom: "1px solid var(--border)" }}>
                  <input className="cb" type="checkbox" defaultChecked disabled aria-labelledby="pf7" aria-describedby="pf7d" />
                  <span className="col grow" style={{ gap: "2px" }}>
                    <span className="t-sm fw-m" id="pf7">온콜 채널 시험 발송</span>
                    <span className="t-xs muted" id="pf7d">시험 호출 수신 확인</span>
                  </span>
                  <span className="slo slo-ok">통과</span>
                </li>
                <li className="row" style={{ gap: "10px", alignItems: "flex-start", padding: "8px 8px", margin: "2px 0", borderRadius: "6px", background: "var(--danger-subtle)", boxShadow: "inset 0 0 0 1px var(--slo-breached)" }}>
                  <input className="cb" type="checkbox" disabled aria-labelledby="pf8" aria-describedby="pf8d" />
                  <span className="col grow" style={{ gap: "2px" }}>
                    <span className="t-sm fw-b" id="pf8">시계 오프셋 ≤ 20ms</span>
                    <span className="t-xs" id="pf8d">노드 2대 최대 31ms · SEV2 경보 중</span>
                  </span>
                  <span className="slo slo-breached">실패</span>
                </li>
                <li className="row" style={{ gap: "10px", alignItems: "flex-start", padding: "8px 0", borderBottom: "1px solid var(--border)" }}>
                  <input className="cb" type="checkbox" defaultChecked disabled aria-labelledby="pf9" aria-describedby="pf9d" />
                  <span className="col grow" style={{ gap: "2px" }}>
                    <span className="t-sm fw-m" id="pf9">갱신이 늦은 인증서(SEV2 기준) 없음·배치 기기 자격이 역할 유효 끝 뒤까지 유효</span>
                    <span className="t-xs muted" id="pf9d">갱신이 늦은 인증서 0건 · 배치 기기 7대 모두 역할 유효 끝 뒤까지 유효</span>
                  </span>
                  <span className="slo slo-ok">통과</span>
                </li>
                <li className="row" style={{ gap: "10px", alignItems: "flex-start", padding: "8px 0", borderBottom: "1px solid var(--border)" }}>
                  <input className="cb" type="checkbox" defaultChecked disabled aria-labelledby="pf10" aria-describedby="pf10d" />
                  <span className="col grow" style={{ gap: "2px" }}>
                    <span className="t-sm fw-m" id="pf10">마지막 교차 리전 백업 성공</span>
                    <span className="t-xs muted" id="pf10d">마지막 성공 10/14(수) 03:10 KST</span>
                  </span>
                  <span className="slo slo-ok">통과</span>
                </li>
                <li className="row" style={{ gap: "10px", alignItems: "flex-start", padding: "8px 0", borderBottom: "1px solid var(--border)" }}>
                  <input className="cb" type="checkbox" defaultChecked disabled aria-labelledby="pf11" aria-describedby="pf11d" />
                  <span className="col grow" style={{ gap: "2px" }}>
                    <span className="t-sm fw-m" id="pf11">진행 중 배포 0건(대형·중형 공연. 소형은 T-15분 자동 중단으로 대신하므로 표시만, 판정 제외)</span>
                    <span className="t-xs muted" id="pf11d">대형 회차 · 롤아웃·마이그레이션 0건</span>
                  </span>
                  <span className="slo slo-ok">통과</span>
                </li>
                <li className="row" style={{ gap: "10px", alignItems: "flex-start", padding: "8px 0", borderBottom: "1px solid var(--border)" }}>
                  <input className="cb" type="checkbox" defaultChecked disabled aria-labelledby="pf12" aria-describedby="pf12d" />
                  <span className="col grow" style={{ gap: "2px" }}>
                    <span className="t-sm fw-m" id="pf12">변경 동결 창 적용</span>
                    <span className="t-xs muted" id="pf12d">배포 동기화 창·노드 중단 예산 적용</span>
                  </span>
                  <span className="slo slo-ok">통과</span>
                </li>
                <li className="row" style={{ gap: "10px", alignItems: "flex-start", padding: "8px 0" }}>
                  <input className="cb" type="checkbox" defaultChecked disabled aria-labelledby="pf13" aria-describedby="pf13d" />
                  <span className="col grow" style={{ gap: "2px" }}>
                    <span className="t-sm fw-m" id="pf13">겹치는 관리형 유지보수 없음</span>
                    <span className="t-xs muted" id="pf13d">동결 창에 겹치는 예정 유지보수 0건</span>
                  </span>
                  <span className="slo slo-ok">통과</span>
                </li>
              </ul>
              <h3 className="eyebrow" style={{ marginTop: "10px" }}>권고 · 실패하면 사유를 남기고 진행</h3>
              <ul className="col">
                <li className="row" style={{ gap: "10px", alignItems: "flex-start", padding: "8px 8px", borderRadius: "6px", background: "var(--warning-subtle)" }}>
                  <input className="cb" type="checkbox" disabled aria-labelledby="pf14" aria-describedby="pf14d" />
                  <span className="col grow" style={{ gap: "2px" }}>
                    <span className="t-sm fw-b" id="pf14">CDN 엣지 캐시 적중률(직전 15분 90% 이상, 요청 1,000건 미만은 판정 보류)</span>
                    <span className="t-xs" id="pf14d">적중률 88.2% · 기준값은 측정 뒤 확정 [가정]</span>
                  </span>
                  <span className="slo slo-burning" style={{ whiteSpace: "normal", maxWidth: "72px" }}>실패 · 사유 기록</span>
                </li>
                <li className="row" style={{ gap: "10px", alignItems: "flex-start", padding: "8px 0" }}>
                  <input className="cb" type="checkbox" defaultChecked disabled aria-labelledby="pf15" aria-describedby="pf15d" />
                  <span className="col grow" style={{ gap: "2px" }}>
                    <span className="t-sm fw-m" id="pf15">수요 예측 상단 ≤ 규모 등급 상한(넘으면 표시만)</span>
                    <span className="t-xs muted" id="pf15d">예상 진입 상단 46만 명 · 대형 상한 100만 명 이하</span>
                  </span>
                  <span className="slo slo-ok">통과</span>
                </li>
              </ul>
              <h3 className="eyebrow" style={{ marginTop: "10px" }}>표시</h3>
              <ul className="col">
                <li className="row" style={{ gap: "10px", alignItems: "flex-start", padding: "8px 0" }}>
                  <i className="ic ic-info ic-16 muted" aria-hidden="true" style={{ margin: "3px" }} />
                  <span className="col grow" style={{ gap: "2px" }}>
                    <span className="t-sm fw-m">결제사 지정</span>
                    <span className="t-xs muted">기본 토스페이먼츠 · 대체 포트원(명령 12로 지정)</span>
                  </span>
                  <span className="slo slo-stale">표시만</span>
                </li>
              </ul>
            </div>
          </details>
          <section className="widget" role="region" aria-labelledby="w-gng">
            <div className="widget-head"><h2 className="t-sm fw-b" id="w-gng">Go/No-Go 판정</h2></div>
            <div className="widget-body">
              <div className="stat is-breached">
                <span className="stat-label">지금 결과</span>
                <span className="stat-value">No-Go</span>
                <span className="slo slo-breached">필수 12/13 통과 · 1개 실패</span>
                <span className="stat-meta">실패: 시계 오프셋 ≤ 20ms · 권고 실패 1: CDN 엣지 캐시 적중률</span>
              </div>
              <div className="banner banner-info bigscreen" role="note">
                <i className="ic ic-monitor" aria-hidden="true" />
                <div className="banner-body">
                  <span className="banner-title">Go/No-Go 판정은 태블릿이나 데스크톱에서 합니다</span>
                  휴대폰에서는 볼 수만 있습니다
                </div>
                <button className="btn btn-outline btn-sm" type="button">
                  <i className="ic ic-copy" aria-hidden="true" />
                  링크 복사
                </button>
              </div>
              <p className="t-xs muted">No-Go면 오픈 시각에 입장 일시정지(명령 2)와 대기실 공지(명령 7)로 시작하고, 필수 항목이 회복되면 입장을 재개합니다. 로비 셔플은 예정대로 해 순서는 바뀌지 않습니다.</p>
              <div className="divider" />
              <h3 className="eyebrow">판정 기록</h3>
              <p className="t-sm muted">이 회차의 판정이 아직 없습니다. 판정과 사유는 감사 로그에 남습니다.</p>
            </div>
          </section>
        </div>
      </>
    ) : null}
    {' '}
    {v.isAfter ? (
      <>
        <div className="col" role="tabpanel" id="panel-after" aria-labelledby="tab-after" style={{ gap: "12px" }}>
          <details className="widget" open>
            <summary className="widget-head">
              <span>공연 리포트</span>
              <span className="fold-meta">
                <span className="badge badge-success">
                  <i className="ic ic-check" aria-hidden="true" />
                  확정 R1
                </span>
                <i className="ic ic-chevron-down fold-ic" aria-hidden="true" />
              </span>
            </summary>
            <div className="widget-body" style={{ gap: "10px" }}>
              <div className="row wrap" style={{ gap: "4px 16px" }}>
                <a href="#" className="link-more">
                  결정 기록 목록
                  <i className="ic ic-chevron-right" aria-hidden="true" />
                </a>
                <a href="#" className="link-more">
                  포스트모템 초안
                  <i className="ic ic-chevron-right" aria-hidden="true" />
                </a>
                <button className="btn btn-ghost btn-sm" type="button">
                  <i className="ic ic-download" aria-hidden="true" />
                  리포트 내려받기
                </button>
              </div>
              <ul className="col" style={{ gap: "8px" }} aria-label="리포트 판(마감 단계)">
                <li className="row wrap" style={{ gap: "6px" }}>
                  <span className="badge badge-outline">잠정</span>
                  <a href="#" className="t-sm">R0 · 마감 10/14(수) 21:30 KST</a>
                </li>
                <li className="row wrap" style={{ gap: "6px" }}>
                  <span className="badge badge-success">
                    <i className="ic ic-check" aria-hidden="true" />
                    확정 R1
                  </span>
                  <span className="t-sm fw-b" aria-current="page">마감 10/15(목) 10:00 KST · 지금 보는 판</span>
                </li>
                <li className="row wrap" style={{ gap: "6px" }}>
                  <span className="badge">R2</span>
                  <span className="t-sm muted">예정 10/21(수) 20:00 KST</span>
                </li>
                <li className="row wrap" style={{ gap: "6px" }}>
                  <span className="badge">R3</span>
                  <span className="t-sm muted">예정 10/26(월) 10:00 KST</span>
                </li>
              </ul>
              <p className="t-sm">
                <span className="fw-b">한 줄 결론</span>
                {' '}오픈 6분 38초에 매진했습니다. 입장 → 구매 전환율과 홀드 경합 패배율 규칙이 걸려 결정 검토를 엽니다. 결제사 한도 초과 응답은 0건입니다.
              </p>
              <p className="t-xs muted">마감이 늦어지면 그 판에 '마감 지연'을 붙이고 직전 판을 그대로 보입니다. 봇·CS·환불·입장 숫자는 R2·R3에서 확정합니다.</p>
            </div>
          </details>
          <details className="widget">
            <summary className="widget-head">
              <span>결정 규칙 판정</span>
              <span className="fold-meta">
                <span>걸림 2 · 경계 1 · 안 걸림 3 · 판정 보류 2</span>
                <i className="ic ic-chevron-down fold-ic" aria-hidden="true" />
              </span>
            </summary>
            <div className="widget-body" style={{ gap: "8px" }}>
              <ul className="col">
                <li className="col" style={{ gap: "4px", padding: "10px 0", borderBottom: "1px solid var(--border)" }}>
                  <div className="row between" style={{ gap: "8px" }}>
                    <span className="t-sm fw-b">입장 → 구매 전환율</span>
                    <span className="badge badge-warning">
                      <i className="ic ic-flag" aria-hidden="true" />
                      걸림
                    </span>
                  </div>
                  <span className="t-xs muted num">값 20.8% · 95% 구간 19.8~21.8% · 조건 83% 미만 · 확정 R1</span>
                </li>
                <li className="col" style={{ gap: "4px", padding: "10px 0", borderBottom: "1px solid var(--border)" }}>
                  <div className="row between" style={{ gap: "8px" }}>
                    <span className="t-sm fw-b">홀드 경합 패배율</span>
                    <span className="badge badge-warning">
                      <i className="ic ic-flag" aria-hidden="true" />
                      걸림
                    </span>
                  </div>
                  <span className="t-xs muted num">값 61.7% · 95% 구간 60.6~62.8% · 조건 50% 초과 [가정] · 확정 R0</span>
                </li>
                <li className="col" style={{ gap: "4px", padding: "10px 0", borderBottom: "1px solid var(--border)" }}>
                  <div className="row between" style={{ gap: "8px" }}>
                    <span className="t-sm">매진 소요 시간</span>
                    <span className="badge">안 걸림</span>
                  </div>
                  <span className="t-xs muted num">값 6분 38초 · 조건 22분 초과 · 확정 R1</span>
                </li>
                <li className="col" style={{ gap: "4px", padding: "10px 0", borderBottom: "1px solid var(--border)" }}>
                  <div className="row between" style={{ gap: "8px" }}>
                    <span className="t-sm">에러 버짓(사후)</span>
                    <span className="badge">안 걸림</span>
                  </div>
                  <span className="t-xs muted num">값 좌석 홀드 41% · 조건 50% 이상 사용 [가정] · 확정 R0</span>
                </li>
                <li className="col" style={{ gap: "4px", padding: "10px 0", borderBottom: "1px solid var(--border)" }}>
                  <div className="row between" style={{ gap: "8px" }}>
                    <span className="t-sm">결제사 한도</span>
                    <span className="badge">안 걸림</span>
                  </div>
                  <span className="t-xs muted num">값 0건 · 조건 한도 초과 응답 1건 이상 · 확정 R0</span>
                </li>
                <li className="col" style={{ gap: "4px", padding: "10px 0", borderBottom: "1px solid var(--border)" }}>
                  <div className="row between" style={{ gap: "8px" }}>
                    <span className="t-sm">홀드 만료율</span>
                    <span className="badge badge-outline">판정 보류</span>
                  </div>
                  <span className="t-xs muted num">값 — · 조건 홀드 성공의 30% 초과 [가정] · 확정 R1</span>
                  <span className="t-xs">사유: 데이터 품질 실패</span>
                </li>
                <li className="col" style={{ gap: "4px", padding: "10px 0", borderBottom: "1px solid var(--border)" }}>
                  <div className="row between" style={{ gap: "8px" }}>
                    <span className="t-sm fw-b">결제 실패 사유</span>
                    <span className="badge badge-primary">경계</span>
                  </div>
                  <span className="t-xs muted num">값 54.5%(112건 중 카드사 거절 61건) · 95% 구간 45.3~63.4% · 조건 카드사 거절이 실패의 50% 초과 [가정] · 확정 R1</span>
                  <span className="t-xs">구간이 기준 50%를 품어 결정 검토를 열지 않습니다</span>
                </li>
                <li className="col" style={{ gap: "4px", padding: "10px 0" }}>
                  <div className="row between" style={{ gap: "8px" }}>
                    <span className="t-sm">봇 점유율(하한)</span>
                    <span className="badge badge-outline">판정 보류</span>
                  </div>
                  <span className="t-xs muted num">값 — · 조건 5% 초과 · 확정 R2</span>
                  <span className="t-xs">사유: 미확정(R2에서 판정)</span>
                </li>
              </ul>
              <a href="#" className="link-more">
                리포트 1절에서 적용 조건 보기
                <i className="ic ic-chevron-right" aria-hidden="true" />
              </a>
            </div>
          </details>
          <details className="widget">
            <summary className="widget-head">
              <span>리포트 본문 11개 절</span>
              <span className="fold-meta">
                <span>목차</span>
                <i className="ic ic-chevron-down fold-ic" aria-hidden="true" />
              </span>
            </summary>
            <ol className="widget-body t-sm" style={{ gap: "7px" }}>
              <li><a href="#">1 한 줄 결론과 규칙 판정</a></li>
              <li><a href="#">2 핵심 지표 카드</a></li>
              <li><a href="#">3 판매 곡선</a></li>
              <li><a href="#">4 퍼널</a></li>
              <li><a href="#">5 좌석 경합</a></li>
              <li><a href="#">6 결제</a></li>
              <li><a href="#">7 공정(봇·이의 제기)</a></li>
              <li><a href="#">8 신뢰(SLO·불변식·명령·경보)</a></li>
              <li><a href="#">9 돈(판매 금액·환불·비용)</a></li>
              <li><a href="#">10 데이터 품질</a></li>
              <li><a href="#">11 지난 결정 확인과 다음 회차 제안</a></li>
            </ol>
          </details>
          <details className="widget" open>
            <summary className="widget-head">
              <span>핵심 지표 카드</span>
              <span className="fold-meta">
                <span className="slo slo-breached">걸림 2</span>
                <i className="ic ic-chevron-down fold-ic" aria-hidden="true" />
              </span>
            </summary>
            <div className="widget-body">
              <p className="t-xs muted">같은 규모 기준선: 같은 규모 확정 회차 6회의 범위(최솟값~최댓값)입니다 · 근거 강도 약함</p>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(2,minmax(0,1fr))", gap: "8px" }}>
                <div className="stat is-breached" style={{ padding: "12px" }}>
                  <span className="row wrap stat-label" style={{ gap: "4px" }}>
                    입장 → 구매 전환율
                    <span className="badge badge-success">확정 R1</span>
                  </span>
                  <span className="stat-value">20.8%</span>
                  <span className="slo slo-breached" style={{ whiteSpace: "normal", alignItems: "flex-start" }}>목표 83% 이상에 미달 · 걸림</span>
                  <span className="stat-meta">기준선 24.1~38.6%(6회) · 승인 1,292 ÷ 입장 6,210</span>
                </div>
                <div className="stat" style={{ padding: "12px" }}>
                  <span className="row wrap stat-label" style={{ gap: "4px" }}>
                    매진 소요 시간
                    <span className="badge badge-success">확정 R1</span>
                  </span>
                  <span className="stat-value">6분 38초</span>
                  <span className="slo slo-ok" style={{ whiteSpace: "normal", alignItems: "flex-start" }}>목표 22분 이하 · 안 걸림</span>
                  <span className="stat-meta">기준선 7분 50초~14분 05초(6회) · 20:00 오픈 → 20:06:38 매진</span>
                </div>
                <div className="stat is-breached" style={{ padding: "12px" }}>
                  <span className="row wrap stat-label" style={{ gap: "4px" }}>
                    홀드 경합 패배율
                    <span className="badge badge-success">확정 R0</span>
                  </span>
                  <span className="stat-value">61.7%</span>
                  <span className="slo slo-breached" style={{ whiteSpace: "normal", alignItems: "flex-start" }}>규칙 50% 초과 · 걸림</span>
                  <span className="stat-meta">기준선 44.0~58.7%(6회) · 세션 첫 시도 기준 48.9%</span>
                </div>
                <div className="stat" style={{ padding: "12px" }}>
                  <span className="row wrap stat-label" style={{ gap: "4px" }}>
                    에러 버짓 사용(사후)
                    <span className="badge badge-success">확정 R0</span>
                  </span>
                  <span className="stat-value">41%</span>
                  <span className="slo slo-ok" style={{ whiteSpace: "normal", alignItems: "flex-start" }}>좌석 홀드 · 규칙 50% 이상 · 안 걸림</span>
                  <span className="stat-meta">기준선 9~33%(6회) · 온세일 중 SEV2 1회(20:03:41~20:11:05)</span>
                </div>
              </div>
            </div>
          </details>
          <section className="widget" role="region" aria-labelledby="w-dec">
            <div className="widget-head">
              <h2 className="t-sm fw-b" id="w-dec">결정 기록 작성</h2>
              <span className="badge badge-outline">commander</span>
              <div className="actions">
                <a href="#" className="link-more">
                  결정 기록 목록
                  <i className="ic ic-chevron-right" aria-hidden="true" />
                </a>
              </div>
            </div>
            <div className="widget-body">
              <div className="banner banner-info bigscreen" role="note">
                <i className="ic ic-monitor" aria-hidden="true" />
                <div className="banner-body">
                  <span className="banner-title">결정 기록 작성은 태블릿이나 데스크톱에서 합니다</span>
                  휴대폰에서는 볼 수만 있습니다
                </div>
                <button className="btn btn-outline btn-sm" type="button">
                  <i className="ic ic-copy" aria-hidden="true" />
                  링크 복사
                </button>
              </div>
              <p className="t-xs muted">규칙은 검토를 열 뿐 결정을 강제하지 않습니다. 다음 회차 리포트가 기대 효과 대비 결과를 붙입니다.</p>
            </div>
          </section>
          <details className="widget">
            <summary className="widget-head">
              <span>데이터 품질·지난 결정</span>
              <span className="fold-meta">
                <span className="slo slo-burning">1개 지표 판정 보류</span>
                <i className="ic ic-chevron-down fold-ic" aria-hidden="true" />
              </span>
            </summary>
            <div className="widget-body">
              <ul className="col t-sm" style={{ gap: "6px" }}>
                <li className="row between" style={{ gap: "12px" }}>
                  <span>마감 상태</span>
                  <span className="slo slo-ok">R1 완료 · 예정대로</span>
                </li>
                <li className="row between" style={{ gap: "12px" }}>
                  <span>판매 좌석·금액 실시간 대비</span>
                  <span className="slo slo-ok">차이 0석 · ₩0</span>
                </li>
                <li className="row between" style={{ gap: "12px" }}>
                  <span>퍼널(진입·입장·주문) 실시간 대비</span>
                  <span className="slo slo-ok">0.04% · 기준 0.1% [가정]</span>
                </li>
                <li className="row between" style={{ gap: "12px", padding: "5px 6px", borderRadius: "6px", background: "var(--warning-subtle)" }}>
                  <span className="fw-b">홀드 만료 집계 실시간 대비</span>
                  <span className="slo slo-burning" style={{ whiteSpace: "normal", alignItems: "flex-start", maxWidth: "150px" }}>
                    0.27% · 홀드 만료율 판정 보류
                  </span>
                </li>
                <li className="row between" style={{ gap: "12px" }}>
                  <span>커버리지·유일성·참조 무결성</span>
                  <span className="slo slo-ok">통과</span>
                </li>
              </ul>
              <div className="divider" />
              <h3 className="eyebrow">지난 결정의 확인 줄</h3>
              <p className="t-sm">
                09/30 운영 기본값 "같은 규모 회차 프리워밍을 T-45분에 시작" · 기대 효과: 매진 소요 22분 이하(다음 같은 규모 2회차) · 이번 6분 38초{' '}
                <span className="slo slo-ok">달성 · 1/2회차 확인</span>
              </p>
            </div>
          </details>
          <details className="widget">
            <summary className="widget-head">
              <span>공정·봇 사후 분석</span>
              <span className="fold-meta">
                <span className="badge badge-outline">잠정 · R2에 확정</span>
                <i className="ic ic-chevron-down fold-ic" aria-hidden="true" />
              </span>
            </summary>
            <div className="widget-body">
              <div style={{ display: "grid", gridTemplateColumns: "repeat(2,minmax(0,1fr))", gap: "8px" }}>
                <div className="stat" style={{ padding: "12px" }}>
                  <span className="stat-label">놓친 봇 비율 추정</span>
                  <span className="stat-value">0.8%</span>
                  <span className="stat-meta">95% 신뢰구간 0.3~1.9% · 표본 검토 120/200건</span>
                </div>
                <div className="stat" style={{ padding: "12px" }}>
                  <span className="stat-label">봇 점유율 하한(주문)</span>
                  <span className="stat-value">2.1%</span>
                  <span className="stat-meta">95% 구간 1.4~3.0% · 목표 5% 이하</span>
                </div>
                <div className="stat" style={{ padding: "12px" }}>
                  <span className="stat-label">누적 사후 라벨</span>
                  <span className="stat-value">46건</span>
                  <span className="stat-meta">신고·소명·표본 검토에서 붙은 라벨</span>
                </div>
                <div className="stat" style={{ padding: "12px" }}>
                  <span className="stat-label">그림자 판정 괴리 세션</span>
                  <span className="stat-value">312</span>
                  <span className="stat-meta">실제 판정과 그림자 판정이 다른 세션 수</span>
                </div>
              </div>
            </div>
          </details>
        </div>
      </>
    ) : null}
    {' '}
    {v.isEntry ? (
      <>
        <div className="col" role="tabpanel" id="panel-entry" aria-labelledby="tab-entry" style={{ gap: "12px" }}>
          <p className="row t-sm muted" style={{ gap: "8px", alignItems: "flex-start" }}>
            <i className="ic ic-info ic-16" aria-hidden="true" style={{ marginTop: "2px" }} />
            <span>관제는 감시만 합니다. 이상 표시 처리·예외 통과·기기 배치는 현장 책임자와 파트너가 합니다.</span>
          </p>
          <div role="group" aria-label="입장 요약" style={{ display: "grid", gridTemplateColumns: "repeat(2,minmax(0,1fr))", gap: "8px" }}>
            <div className="stat" style={{ padding: "12px" }}>
              <span className="stat-label">로그인·준비 기기</span>
              <span className="stat-value">7 / 7대</span>
              <span className="slo slo-ok">모두 준비</span>
              <span className="stat-meta">동문 4 · 서문 3 · 모두 입장 모드</span>
            </div>
            <div className="stat is-breached" style={{ padding: "12px" }}>
              <span className="stat-label">2분 넘은 기기</span>
              <span className="stat-value">1대</span>
              <span className="slo slo-breached" style={{ whiteSpace: "normal", alignItems: "flex-start" }}>위반 · 기준 2분 [가정] · SEV2</span>
              <span className="stat-meta">동기화 경과 최대 2분 47초(서문-02)</span>
            </div>
            <div className="stat is-burning" style={{ padding: "12px" }}>
              <span className="stat-label">업로드 대기</span>
              <span className="stat-value">23건</span>
              <span className="slo slo-burning">서문-02에 20건</span>
              <span className="stat-meta">나머지 기기 3건</span>
            </div>
            <div className="stat is-burning" style={{ padding: "12px" }}>
              <span className="stat-label">이상 표시</span>
              <span className="stat-value">15건</span>
              <span className="slo slo-burning" style={{ whiteSpace: "normal", alignItems: "flex-start" }}>중복 입장 급증 · SEV3</span>
              <span className="stat-meta">중복 입장 12 · 퇴장 기록 없음 0 · 취소 뒤 입장 2 · 세션 밖 기록 1</span>
            </div>
            <div className="stat" style={{ padding: "12px", gridColumn: "span 2" }}>
              <span className="stat-label">부스 재발급·예외 통과</span>
              <span className="stat-value">9 · 4건</span>
              <span className="slo slo-ok">책임자별은 아래</span>
              <span className="stat-meta">부스 재발급 허용 9 · 예외 통과 4</span>
            </div>
          </div>
          <details className="widget">
            <summary className="widget-head">
              <span>게이트 구역별 분당 입장</span>
              <span className="fold-meta">
                <span>동문 26 · 서문 11</span>
                <i className="ic ic-chevron-down fold-ic" aria-hidden="true" />
              </span>
            </summary>
            <div className="widget-body" style={{ gap: "6px" }}>
              <div className="row" style={{ justifyContent: "flex-end" }}>
                <button className="btn btn-ghost btn-sm" type="button" aria-pressed="false">
                  <i className="ic ic-list" aria-hidden="true" />
                  표로 보기
                </button>
              </div>
              <figure className="col" style={{ gap: "4px" }}>
                <figcaption className="col t-xs" style={{ gap: "2px" }}>
                  <span className="fw-b">16:30 입장 시작부터 · 분당 입장(통과)</span>
                  <span className="num muted">누계 1,388명 · 동문 778 · 서문 610</span>
                </figcaption>
                <svg className="chart" viewBox="0 0 320 136" role="img" aria-label="게이트 구역별 분당 입장. 동문은 늘어 지금 분당 26명입니다. 서문은 17:06부터 줄어 지금 분당 11명인데, 서문-02의 업로드 대기 20건이 아직 반영되지 않은 값입니다.">
                  <line className="grid" x1="30" y1="112" x2="262" y2="112" />
                  <line className="grid" x1="30" y1="78.7" x2="262" y2="78.7" />
                  <line className="grid" x1="30" y1="45.3" x2="262" y2="45.3" />
                  <line className="grid" x1="30" y1="12" x2="262" y2="12" />
                  <text className="axis" x="26" y="115" textAnchor="end">0</text>
                  <text className="axis" x="26" y="82" textAnchor="end">10</text>
                  <text className="axis" x="26" y="48" textAnchor="end">20</text>
                  <text className="axis" x="26" y="15" textAnchor="end">30</text>
                  <polyline className="line" points="30,112 45.5,82 60.9,65.3 76.4,55.3 91.9,52 107.3,58.7 122.8,48.7 138.3,42 153.7,45.3 169.2,38.7 184.7,32 200.1,35.3 215.6,28.7 231.1,32 246.5,25.3" />
                  <polyline className="line" style={{ stroke: "var(--primary)" }} points="30,112 45.5,85.3 60.9,72 76.4,62 91.9,58.7 107.3,62 122.8,55.3 138.3,52 153.7,55.3 169.2,48.7 184.7,45.3 200.1,48.7 215.6,52 231.1,68.7 246.5,75.3" />
                  <line className="now" x1="249.1" y1="6" x2="249.1" y2="114" />
                  <text className="axis" x="266" y="29">동문 26</text>
                  <text className="axis" x="266" y="79">서문 11</text>
                  <text className="axis" x="30" y="129" textAnchor="middle">16:30</text>
                  <text className="axis" x="107.3" y="129" textAnchor="middle">16:45</text>
                  <text className="axis" x="184.7" y="129" textAnchor="middle">17:00</text>
                  <text className="axis" x="262" y="129" textAnchor="middle">17:15</text>
                </svg>
              </figure>
              <div className="legend" aria-hidden="true">
                <span className="legend-item">
                  <span className="swatch" />
                  동문(밝은 선)
                </span>
                <span className="legend-item">
                  <span className="swatch" style={{ background: "var(--primary)" }} />
                  서문(진한 선)
                </span>
                <span className="legend-item">
                  <span className="swatch" style={{ width: "2px", height: "12px", background: "var(--text)" }} />
                  지금 17:12:30
                </span>
              </div>
            </div>
          </details>
          <details className="widget">
            <summary className="widget-head">
              <span>거부 사유</span>
              <span className="fold-meta">
                <span>46건 · 3.2%</span>
                <i className="ic ic-chevron-down fold-ic" aria-hidden="true" />
              </span>
            </summary>
            <div className="widget-body" style={{ gap: "6px" }}>
              <div className="row" style={{ justifyContent: "flex-end" }}>
                <button className="btn btn-ghost btn-sm" type="button" aria-pressed="false">
                  <i className="ic ic-list" aria-hidden="true" />
                  표로 보기
                </button>
              </div>
              <figure className="col" style={{ gap: "4px" }}>
                <figcaption className="col t-xs" style={{ gap: "2px" }}>
                  <span className="fw-b">거부 46건 · 판정 1,434건 중 3.2%</span>
                  <span className="num muted">오거부 후보 19건(거부 뒤 10분 [가정] 안 정상 통과)</span>
                </figcaption>
                <p className="t-xs muted">확인 필요 3건(퇴장 기록 없음 2 · 입장 기록 없음 1)은 현장 책임자 확인 대상이라 거부율에 넣지 않습니다</p>
                <svg className="chart" viewBox="0 0 320 272" role="img" aria-label="거부 사유별 건수. 유효시간이 지난 QR 14건(30.4%), 다른 게이트 구역 11건(23.9%), 키 미반영 8건(17.4%), 이미 입장한 티켓 6건(13.0%), 폐기된 키 4건(8.7%), 유효하지 않은 QR 2건(4.3%), 취소된 티켓 1건(2.2%), 다른 회차·발권 안 된 티켓 0건, 위조 의심 0건.">
                  <text className="axis" x="0" y="11">유효시간이 지난 QR</text>
                  <rect className="bar" x="0" y="15" width="220" height="10" rx="3" />
                  <text className="axis" x="226" y="24">14건 · 30.4%</text>
                  <text className="axis" x="0" y="41">다른 게이트 구역</text>
                  <rect className="bar" x="0" y="45" width="172.9" height="10" rx="3" />
                  <text className="axis" x="178.9" y="54">11건 · 23.9%</text>
                  <text className="axis" x="0" y="71">키 미반영</text>
                  <rect className="bar" x="0" y="75" width="125.7" height="10" rx="3" />
                  <text className="axis" x="131.7" y="84">8건 · 17.4%</text>
                  <text className="axis" x="0" y="101">이미 입장한 티켓</text>
                  <rect className="bar" x="0" y="105" width="94.3" height="10" rx="3" />
                  <text className="axis" x="100.3" y="114">6건 · 13.0%</text>
                  <text className="axis" x="0" y="131">폐기된 키(옛 QR)</text>
                  <rect className="bar" x="0" y="135" width="62.9" height="10" rx="3" />
                  <text className="axis" x="68.9" y="144">4건 · 8.7%</text>
                  <text className="axis" x="0" y="161">유효하지 않은 QR</text>
                  <rect className="bar" x="0" y="165" width="31.4" height="10" rx="3" />
                  <text className="axis" x="37.4" y="174">2건 · 4.3%</text>
                  <text className="axis" x="0" y="191">취소된 티켓</text>
                  <rect className="bar" x="0" y="195" width="15.7" height="10" rx="3" />
                  <text className="axis" x="21.7" y="204">1건 · 2.2%</text>
                  <text className="axis" x="0" y="221">다른 회차·발권 안 된 티켓</text>
                  <text className="axis" x="0" y="234">0건</text>
                  <text className="axis" x="0" y="251">위조 의심</text>
                  <text className="axis" x="0" y="264">0건</text>
                </svg>
              </figure>
            </div>
          </details>
          <details className="widget" open>
            <summary className="widget-head">
              <span>기기 목록</span>
              <span className="fold-meta">
                <span className="slo slo-breached">2분 넘음 1대</span>
                <span>7대</span>
                <i className="ic ic-chevron-down fold-ic" aria-hidden="true" />
              </span>
            </summary>
            <div className="widget-body" style={{ gap: "8px" }}>
              <div className="row between" style={{ gap: "8px" }}>
                <span className="t-xs muted">감시만 하고 처리 버튼은 없습니다</span>
                <Link to="/scanner-devices" className="link-more">
                  스캐너 기기 관리
                  <i className="ic ic-chevron-right" aria-hidden="true" />
                </Link>
              </div>
              <ul className="col" aria-label="기기 7대, 기기 이름 순">
                <li className="col" style={{ gap: "4px", padding: "10px 0", borderBottom: "1px solid var(--border)" }}>
                  <div className="row between" style={{ gap: "8px" }}>
                    <span className="row" style={{ gap: "6px" }}>
                      <span className="mono fw-b">동문-01</span>
                      <span className="badge mode-in">입장</span>
                    </span>
                    <span className="slo slo-ok">정상</span>
                  </div>
                  <span className="t-xs muted num">동기화 12초 전 · 업로드 대기 0 · 폐기 목록 v418</span>
                  <span className="t-xs muted num">판정 p95 71ms · 통과(서버 반영) 214</span>
                </li>
                <li className="col" style={{ gap: "4px", padding: "10px 0", borderBottom: "1px solid var(--border)" }}>
                  <div className="row between" style={{ gap: "8px" }}>
                    <span className="row" style={{ gap: "6px" }}>
                      <span className="mono fw-b">동문-02</span>
                      <span className="badge mode-in">입장</span>
                    </span>
                    <span className="slo slo-ok">정상</span>
                  </div>
                  <span className="t-xs muted num">동기화 25초 전 · 업로드 대기 2 · 폐기 목록 v418</span>
                  <span className="t-xs muted num">판정 p95 76ms · 통과(서버 반영) 201</span>
                </li>
                <li className="col" style={{ gap: "4px", padding: "10px 0", borderBottom: "1px solid var(--border)" }}>
                  <div className="row between" style={{ gap: "8px" }}>
                    <span className="row" style={{ gap: "6px" }}>
                      <span className="mono fw-b">동문-03</span>
                      <span className="badge mode-in">입장</span>
                    </span>
                    <span className="slo slo-ok">정상</span>
                  </div>
                  <span className="t-xs muted num">동기화 41초 전 · 업로드 대기 0 · 폐기 목록 v418</span>
                  <span className="t-xs muted num">판정 p95 69ms · 통과(서버 반영) 189</span>
                </li>
                <li className="col" style={{ gap: "4px", padding: "10px 0", borderBottom: "1px solid var(--border)" }}>
                  <div className="row between" style={{ gap: "8px" }}>
                    <span className="row" style={{ gap: "6px" }}>
                      <span className="mono fw-b">동문-04</span>
                      <span className="badge mode-in">입장</span>
                    </span>
                    <span className="slo slo-ok">정상</span>
                  </div>
                  <span className="t-xs muted num">동기화 18초 전 · 업로드 대기 1 · 폐기 목록 v418</span>
                  <span className="t-xs muted num">판정 p95 80ms · 통과(서버 반영) 174</span>
                </li>
                <li className="col" style={{ gap: "4px", padding: "10px 0", borderBottom: "1px solid var(--border)" }}>
                  <div className="row between" style={{ gap: "8px" }}>
                    <span className="row" style={{ gap: "6px" }}>
                      <span className="mono fw-b">서문-01</span>
                      <span className="badge mode-in">입장</span>
                    </span>
                    <span className="slo slo-ok">정상</span>
                  </div>
                  <span className="t-xs muted num">동기화 9초 전 · 업로드 대기 0 · 폐기 목록 v418</span>
                  <span className="t-xs muted num">판정 p95 74ms · 통과(서버 반영) 241</span>
                </li>
                <li className="col" style={{ gap: "4px", padding: "10px 8px", margin: "4px 0", borderRadius: "6px", background: "var(--danger-subtle)" }}>
                  <div className="row between" style={{ gap: "8px" }}>
                    <span className="row" style={{ gap: "6px" }}>
                      <span className="mono fw-b">서문-02</span>
                      <span className="badge mode-in">입장</span>
                    </span>
                    <span className="slo slo-breached">2분 넘음 · SEV2</span>
                  </div>
                  <span className="t-xs num fw-b">동기화 2분 47초 전 · 업로드 대기 20</span>
                  <span className="t-xs muted num">폐기 목록 v411 · 차이 7 · 판정 p95 88ms(마지막 보고) · 통과(서버 반영) 152</span>
                </li>
                <li className="col" style={{ gap: "4px", padding: "10px 0" }}>
                  <div className="row between" style={{ gap: "8px" }}>
                    <span className="row" style={{ gap: "6px" }}>
                      <span className="mono fw-b">서문-03</span>
                      <span className="badge mode-in">입장</span>
                    </span>
                    <span className="slo slo-ok">정상</span>
                  </div>
                  <span className="t-xs muted num">동기화 33초 전 · 업로드 대기 0 · 폐기 목록 v418</span>
                  <span className="t-xs muted num">판정 p95 72ms · 통과(서버 반영) 217</span>
                </li>
              </ul>
              <p className="t-xs muted">통과 수는 서버에 올라온 기록 기준입니다. 서문-02의 업로드 대기 20건은 아직 빠져 있습니다.</p>
            </div>
          </details>
          <details className="widget">
            <summary className="widget-head">
              <span>마감·키 등록·판정</span>
              <span className="fold-meta">
                <span className="slo slo-ok">판정 p95 84ms</span>
                <i className="ic ic-chevron-down fold-ic" aria-hidden="true" />
              </span>
            </summary>
            <div className="widget-body">
              <ul className="col t-sm" style={{ gap: "8px" }}>
                <li className="row between" style={{ gap: "8px" }}>
                  <span className="muted">입장 기록 마감</span>
                  <span>마감 전</span>
                </li>
                <li className="row between" style={{ gap: "8px" }}>
                  <span className="muted">미보고 기기</span>
                  <span className="num">0대 · 마감 뒤 집계</span>
                </li>
                <li className="row between" style={{ gap: "8px" }}>
                  <span className="muted">입장 시작 뒤 첫 키 등록</span>
                  <span className="num">6.2%</span>
                </li>
                <li className="row between" style={{ gap: "8px" }}>
                  <span className="muted">폐기 목록 버전 차이</span>
                  <span className="num">최대 7</span>
                </li>
                <li className="row between" style={{ gap: "8px" }}>
                  <span className="muted">판정 p95</span>
                  <span className="slo slo-ok">84ms · 기준 150ms</span>
                </li>
              </ul>
              <div className="divider" />
              <h3 className="eyebrow">부스·예외 통과(책임자별)</h3>
              <ul className="col t-sm" style={{ gap: "6px" }}>
                <li className="row between" style={{ gap: "8px" }}>
                  <span>동문 구역 책임자</span>
                  <span className="num">부스 6 · 예외 3</span>
                </li>
                <li className="row between" style={{ gap: "8px" }}>
                  <span>서문 구역 책임자</span>
                  <span className="num">부스 3 · 예외 1</span>
                </li>
              </ul>
              <p className="t-xs muted">개인 식별자 대신 구역 역할로 보입니다. 예외 통과의 사후 검토는 CS 처리함이 맡습니다.</p>
            </div>
          </details>
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
    {v.isB100 ? (
      <>
        <Overlay placement="bottom" onClose={close}>
          <div className="sheet" role="alertdialog" aria-modal="true" aria-labelledby="dg-t" aria-describedby="dg-d">
            <div className="sheet-handle" aria-hidden="true" />
            <h2 className="dialog-title" id="dg-t">Degraded 후보를 검토하세요</h2>
            <p className="t-sm" id="dg-d">
              좌석 홀드 온세일 에러 버짓을 모두 썼습니다(75건 중 75건 · 20:04:09 KST). 시스템이 미리 정한 감내 모드 가운데 후보를 골랐습니다. 전환은 명령 6으로 하고 운영자 2인 승인이 필요합니다.
            </p>
            <div className="card-flat col" style={{ gap: "8px", padding: "12px 14px" }}>
              <span className="row" style={{ gap: "8px" }}>
                <span className="badge badge-warning">후보</span>
                <span className="t-sm fw-b">좌석 임시 점유(홀드) 감내 모드</span>
              </span>
              <dl className="kv" style={{ fontSize: "13px", lineHeight: "19px" }}>
                <dt>줄이는 것</dt>
                <dd style={{ textAlign: "left" }}>좌석 Redis 장애 조치 동안 이 회차의 구매 요청을 503과 Retry-After로 잠시 미룹니다(장애 조치마다 30초 이하 목표)</dd>
                <dt>끝까지 지키는 것</dt>
                <dd style={{ textAlign: "left" }}>초과 판매 0건</dd>
              </dl>
            </div>
            <p className="row t-sm" style={{ gap: "8px", alignItems: "flex-start" }}>
              <i className="ic ic-users ic-16" aria-hidden="true" style={{ marginTop: "2px" }} />
              <span>포스트모템을 소집했습니다. 온콜 채널에 알렸고 초안은 종료 후 리포트에 생깁니다.</span>
            </p>
            <div className="banner banner-info bigscreen" role="note">
              <i className="ic ic-monitor" aria-hidden="true" />
              <div className="banner-body">
                <span className="banner-title">명령 6 요청은 태블릿이나 데스크톱에서 합니다</span>
                휴대폰에서는 볼 수만 있습니다
              </div>
              <button className="btn btn-outline btn-sm" type="button">
                <i className="ic ic-copy" aria-hidden="true" />
                링크 복사
              </button>
            </div>
            <button className="btn btn-ghost btn-block" type="button" onClick={close}>닫기</button>
          </div>
        </Overlay>
      </>
    ) : null}
    </>
  );
}
