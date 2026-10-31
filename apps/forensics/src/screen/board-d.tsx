// 디자인 캔버스 보드 SCR-069-d.dc.html를 옮긴 것(dc2tsx 생성 뒤 손질). 재생·정지·배속·시나리오 단추만 controls.tsx로 잇는다
/* eslint-disable */
import { Fragment, type FormEvent } from 'react';

import { Overlay } from '../shared/Overlay';
import { useReplay } from './controls';
import type { Source } from '../lib/source';
import { CandidatePanel, DenyMain, ExpiredMain, GroupCountStat, GroupFilter, ReceivingMain, ReplaySourceBadge, SeatMarkLegend, SeatMarks, SourceHead, sourceVals } from './sources';

const prevent = (e: FormEvent) => e.preventDefault();
void Fragment;


type AriaBool = boolean | 'true' | 'false';
type AriaCurrent = boolean | 'true' | 'false' | 'page' | 'step' | 'location' | 'date' | 'time';


// 상태 목록은 원천(합성·조사·연구)마다 다르다: lib/source.ts statesFor(d5 §7.17 상태 표). 보드 SCR-069-d의 state 열거값은 합성 원천 목록이다

export function valsD(state: string, source: Source = 'synthetic') {
    let st = state || '재생';
    let cand = st === '후보 고름';
    let gen = st === '만드는 중';
    let reject = st === '파일 거절';
    let copy = st === '복사 방식';
    let fallback = st === '그래픽 대체';
    let cant = st === '돌릴 수 없음';
    let drop = st === '사건 일부 버림';
    let pause = st === '일시정지';
    let pick = st === '시나리오 고르기';
    let sport = st === '스포츠 플레이오프 오픈';
    let mimic = st === '사람 흉내 봇 · 후보 고름';
    const sv = sourceVals(st, source);
    let conc = !sport && !mimic;
    return {
      isCand: cand,
      notCand: !cand,
      mapConc: (!cand || sv.isInv) && conc,
      statBase: (!cand || sv.isInv) && conc,
      scatConc: !cand && conc,
      tlBase: !cand && !mimic,
      tlCand: cand || mimic,
      anyCand: cand || mimic,
      scConc: conc,
      isSport: sport,
      isMimic: mimic,
      isStad: sport || mimic,
      isPick: pick,
      pickExp: pick ? 'true' : 'false',
      isGen: gen,
      isReject: reject,
      isCopy: copy,
      notCopy: !copy,
      isFallback: fallback,
      fullScatter: !fallback,
      isCant: cant,
      isDrop: drop,
      showMain: !cant && sv.hasData,
      showFoot: sv.hasData,
      showMap: !reject,
      showStats: !reject,
      playing: st === '재생' || copy || fallback || gen || drop || pick || sport,
      paused: cand || reject || pause || mimic,
      ...sv
    };
  }

type V = ReturnType<typeof valsD>;

// 보드 루트: {"class": "pk dark", "style": "width:100%;min-height:1480px;display:flex;flex-direction:column;background:var(--surface-basement);position:relative"}

// <header class="cs-bar" style="flex-wrap:wrap;white-space:normal">
export function BarD({ v, close }: { v: V; close?: () => void }) {
  void v; void close;
  const ctl = useReplay();
  void ctl;
  return (
    <>
    <span className="logo logo-sm">
      <i className="logo-mark" aria-hidden="true" />
      PEAKET
    </span>
    <span className="badge badge-inverse">포렌식 리플레이</span>
    <ReplaySourceBadge source={v.src} />
    {' '}
    {v.isSyn ? (
      <>
        <span className="sep" aria-hidden="true" />
        {' '}
        <span style={{ position: "relative", display: "inline-flex" }}>
          <button className="chip chip-sm" type="button" aria-haspopup="listbox" aria-expanded={(v.pickExp) as AriaBool} aria-controls={v.isPick ? "fx-sc-list" : undefined} onClick={ctl.togglePick}>
            {v.scConc ? (
              <>
                인기 콘서트 오픈(5만 석·봇 30%)
              </>
            ) : null}
            {v.isSport ? (
              <>
                스포츠 플레이오프 오픈(3만 석·봇 10%)
              </>
            ) : null}
            {v.isMimic ? (
              <>
                사람 흉내 봇(3만 석·봇 30%)
              </>
            ) : null}
            <i className="ic ic-chevron-down" aria-hidden="true" />
          </button>
          {v.isPick ? (
            <>
              <ul className="menu" role="listbox" id="fx-sc-list" aria-label="시나리오" style={{ position: "absolute", top: "calc(100% + 6px)", left: "0", zIndex: "120", width: "380px" }}>
                <li className="menu-item is-active" role="option" aria-selected="true" style={{ padding: "8px 10px", alignItems: "flex-start", whiteSpace: "normal" }}>
                  <span className="col grow" style={{ gap: "2px", minWidth: "0" }}>
                    <span className="t-sm fw-b">인기 콘서트 오픈(5만 석·봇 30%)</span>
                    <span className="t-xs muted">아레나 · 대기 30만 · 하이브리드(셔플)</span>
                  </span>
                  <i className="ic ic-check ic-16" aria-hidden="true" style={{ marginTop: "2px", flex: "none" }} />
                </li>
                <li className="menu-item" role="option" aria-selected="false" style={{ padding: "8px 10px", alignItems: "flex-start", whiteSpace: "normal" }}>
                  <span className="col grow" style={{ gap: "2px", minWidth: "0" }}>
                    <span className="t-sm fw-b">스포츠 플레이오프 오픈(3만 석·봇 10%)</span>
                    <span className="t-xs muted">원형 경기장 · 대기 15만 · 선착순</span>
                  </span>
                </li>
                <li className="menu-item" role="option" aria-selected="false" style={{ padding: "8px 10px", alignItems: "flex-start", whiteSpace: "normal" }}>
                  <span className="col grow" style={{ gap: "2px", minWidth: "0" }}>
                    <span className="t-sm fw-b">사람 흉내 봇(3만 석·봇 30%)</span>
                    <span className="t-xs muted">원형 경기장 · 대기 15만 · 하이브리드(셔플) · 봇이 사람과 같은 반응 시간·움직임을 흉내 내 산점도로는 갈리지 않습니다</span>
                  </span>
                </li>
                <li className="menu-sep" role="presentation" />
                <li className="t-xs muted" role="presentation" style={{ padding: "2px 10px 6px", whiteSpace: "normal" }}>
                  고르면 지금 시드(20261021)로 사건을 다시 만듭니다
                </li>
              </ul>
            </>
          ) : null}
        </span>
        {' '}
        <label className="row" style={{ gap: "6px" }} htmlFor="fx-seed">
          <span className="t-xs muted">시드</span>
          <input className="input input-sm mono" id="fx-seed" defaultValue="20261021" style={{ width: "110px" }} />
        </label>
        {' '}
        <button className="btn btn-outline btn-sm" type="button" onClick={ctl.regenerate}>
          <i className="ic ic-refresh" aria-hidden="true" />
          다시 만들기
        </button>
        {' '}
        <span className="sep" aria-hidden="true" />
        {' '}
        <button className="btn btn-ghost btn-sm" type="button">
          <i className="ic ic-upload" aria-hidden="true" />
          파일 불러오기
        </button>
        {' '}
        <button className="btn btn-ghost btn-sm" type="button">
          <i className="ic ic-download" aria-hidden="true" />
          이 시나리오 내려받기
        </button>
        {' '}
        <button className="icon-btn icon-btn-sm" type="button" aria-label="공유 주소 복사" style={{ marginLeft: "auto" }}>
          <i className="ic ic-link" aria-hidden="true" />
        </button>
      </>
    ) : null}
    {' '}
    {v.notSyn ? <SourceHead source={v.src} deny={v.isDeny} /> : null}
    </>
  );
}

export function OverlaysD({ v, close }: { v: V; close?: () => void }) {
  void v; void close;
  const ctl = useReplay();
  void ctl;
  return (
    <>
    {v.isReject ? (
      <>
        <div className="banner banner-danger" role="alert" style={{ margin: "16px 20px 0" }}>
          <i className="ic ic-alert-circle" aria-hidden="true" />
          <div className="banner-body">
            <span className="banner-title">이 파일은 열 수 없습니다(형식이 다릅니다)</span>
            {v.spec.rejectReason}
          </div>
        </div>
      </>
    ) : null}
    {v.isCopy ? (
      <>
        <div className="banner banner-info" role="status" style={{ margin: "16px 20px 0" }}>
          <i className="ic ic-info" aria-hidden="true" />
          <div className="banner-body">{v.spec.copyNote}</div>
        </div>
      </>
    ) : null}
    {v.isDrop ? (
      <>
        <div className="banner banner-warning" role="status" style={{ margin: "16px 20px 0" }}>
          <i className="ic ic-alert" aria-hidden="true" />
          <div className="banner-body">규칙에 맞지 않는 사건 12건을 빼고 보입니다</div>
        </div>
      </>
    ) : null}
    {v.showMain ? (
      <>
        <main id="main" style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) var(--fx-panel, 460px)", gap: "16px", padding: "16px 20px 12px", alignItems: "start" }}>
          <h1 className="sr-only">{v.spec.title}</h1>
          <div className="col" style={{ gap: "16px", minWidth: "0" }}>
            <section className="widget" aria-labelledby="fx-map-h">
              <div className="widget-head wrap">
                <h2 className="t-sm fw-b" id="fx-map-h">좌석 리플레이</h2>
                <span className="mono t-sm">T+02:14.350</span>
                <div className="actions" style={{ gap: "8px" }}>
                  <div className="seg" role="group" aria-label="레이어">
                    <button className="seg-item" type="button" aria-pressed="true">상태</button>
                    <button className="seg-item" type="button" aria-pressed="false">경합</button>
                    <button className="seg-item" type="button" aria-pressed="false">이탈</button>
                  </div>
                  <button className="icon-btn icon-btn-sm" type="button" aria-label="확대"><i className="ic ic-zoom-in" aria-hidden="true" /></button>
                  <button className="icon-btn icon-btn-sm" type="button" aria-label="축소"><i className="ic ic-zoom-out" aria-hidden="true" /></button>
                  <button className="btn btn-ghost btn-sm" type="button">전체 보기</button>
                </div>
              </div>
              <div className="widget-body">
                {v.showMap ? (
                  <>
                    {v.mapConc ? (
                      <>
                        <svg viewBox="0 0 880 520" role="img" aria-label={"좌석 리플레이. 오픈 뒤 2분 14초의 좌석 상태입니다. 무대 앞 플로어와 아래층 가운데 구역이 거의 다 팔렸고 위층 끝 구역에 빈 좌석이 남았습니다." + v.mapNote} style={{ display: "block", width: "100%", height: "auto" }}>
                          <rect x="330" y="18" width="220" height="36" rx="6" style={{ fill: "var(--fill-weak-strong)" }} />
                          <text x="440" y="41" textAnchor="middle" style={{ fill: "var(--text-muted)", fontSize: "13px", fontWeight: "700" }}>무대</text>
                          <rect x="312" y="82" width="58" height="54" rx="4" style={{ fill: "var(--heat-2)" }} />
                          <text x="341" y="113" textAnchor="middle" style={{ fill: "var(--text)", fontSize: "11px", fontWeight: "700" }}>F1</text>
                          <rect x="378" y="82" width="58" height="54" rx="4" style={{ fill: "var(--heat-2)" }} />
                          <text x="407" y="113" textAnchor="middle" style={{ fill: "var(--text)", fontSize: "11px", fontWeight: "700" }}>F2</text>
                          <rect x="444" y="82" width="58" height="54" rx="4" style={{ fill: "var(--heat-3)" }} />
                          <text x="473" y="113" textAnchor="middle" style={{ fill: "var(--text)", fontSize: "11px", fontWeight: "700" }}>F3</text>
                          <rect x="510" y="82" width="58" height="54" rx="4" style={{ fill: "var(--heat-2)" }} />
                          <text x="539" y="113" textAnchor="middle" style={{ fill: "var(--text)", fontSize: "11px", fontWeight: "700" }}>F4</text>
                          <rect x="312" y="144" width="58" height="54" rx="4" style={{ fill: "var(--heat-2)" }} />
                          <text x="341" y="175" textAnchor="middle" style={{ fill: "var(--text)", fontSize: "11px", fontWeight: "700" }}>F5</text>
                          <rect x="378" y="144" width="58" height="54" rx="4" style={{ fill: "var(--heat-2)" }} />
                          <text x="407" y="175" textAnchor="middle" style={{ fill: "var(--text)", fontSize: "11px", fontWeight: "700" }}>F6</text>
                          <rect x="444" y="144" width="58" height="54" rx="4" style={{ fill: "var(--heat-2)" }} />
                          <text x="473" y="175" textAnchor="middle" style={{ fill: "var(--text)", fontSize: "11px", fontWeight: "700" }}>F7</text>
                          <rect x="510" y="144" width="58" height="54" rx="4" style={{ fill: "var(--heat-2)" }} />
                          <text x="539" y="175" textAnchor="middle" style={{ fill: "var(--text)", fontSize: "11px", fontWeight: "700" }}>F8</text>
                          <polygon points="707,79.1 711.3,92.9 714.8,106.9 717.7,121 719.9,135.3 721.3,149.7 721.9,164.1 662,165.4 661.4,154 660.3,142.7 658.6,131.5 656.4,120.3 653.5,109.3 650.2,98.5" style={{ fill: "var(--heat-2)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <text x="688.2" y="130.2" textAnchor="middle" style={{ fill: "var(--text)", fontSize: "11px", fontWeight: "700" }}>A1</text>
                          <polygon points="721.9,175.9 721.3,190.3 719.9,204.7 717.7,219 714.8,233.1 711.3,247.1 707,260.9 650.2,241.5 653.5,230.7 656.4,219.7 658.6,208.5 660.3,197.3 661.4,186 662,174.6" style={{ fill: "var(--heat-2)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <text x="688.2" y="217.8" textAnchor="middle" style={{ fill: "var(--text)", fontSize: "11px", fontWeight: "700" }}>A2</text>
                          <polygon points="702.9,272 697.4,285.3 691.1,298.3 684.2,311 676.7,323.3 668.5,335.2 659.8,346.7 613,309.1 619.9,300.1 626.3,290.7 632.3,281 637.7,271 642.6,260.8 647,250.3" style={{ fill: "var(--heat-2)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <text x="658.2" y="300" textAnchor="middle" style={{ fill: "var(--text)", fontSize: "11px", fontWeight: "700" }}>A3</text>
                          <polygon points="652.2,355.8 642.4,366.4 632.1,376.5 621.3,386 610,395 598.2,403.4 586.1,411.2 555,359.9 564.6,353.8 573.8,347.1 582.7,340.1 591.2,332.5 599.3,324.6 607,316.2" style={{ fill: "var(--heat-2)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <text x="602" y="367" textAnchor="middle" style={{ fill: "var(--text)", fontSize: "11px", fontWeight: "700" }}>A4</text>
                          <polygon points="575.9,417.1 563,423.7 549.9,429.7 536.4,435 522.8,439.6 508.9,443.5 494.8,446.6 483.1,387.8 494.2,385.3 505.2,382.2 515.9,378.6 526.5,374.5 536.9,369.8 546.9,364.5" style={{ fill: "var(--heat-2)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <text x="526.2" y="410.8" textAnchor="middle" style={{ fill: "var(--text)", fontSize: "11px", fontWeight: "700" }}>A5</text>
                          <polygon points="483.1,448.7 468.8,450.5 454.4,451.6 440,452 425.6,451.6 411.2,450.5 396.9,448.7 406,389.4 417.3,390.8 428.6,391.7 440,392 451.4,391.7 462.7,390.8 474,389.4" style={{ fill: "var(--heat-2)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <text x="440" y="426" textAnchor="middle" style={{ fill: "var(--text)", fontSize: "11px", fontWeight: "700" }}>A6</text>
                          <polygon points="385.2,446.6 371.1,443.5 357.2,439.6 343.6,435 330.1,429.7 317,423.7 304.1,417.1 333.1,364.5 343.1,369.8 353.5,374.5 364.1,378.6 374.8,382.2 385.8,385.3 396.9,387.8" style={{ fill: "var(--heat-2)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <text x="353.8" y="410.8" textAnchor="middle" style={{ fill: "var(--text)", fontSize: "11px", fontWeight: "700" }}>A7</text>
                          <polygon points="293.9,411.2 281.8,403.4 270,395 258.7,386 247.9,376.5 237.6,366.4 227.8,355.8 273,316.2 280.7,324.6 288.8,332.5 297.3,340.1 306.2,347.1 315.4,353.8 325,359.9" style={{ fill: "var(--heat-2)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <text x="278" y="367" textAnchor="middle" style={{ fill: "var(--text)", fontSize: "11px", fontWeight: "700" }}>A8</text>
                          <polygon points="220.2,346.7 211.5,335.2 203.3,323.3 195.8,311 188.9,298.3 182.6,285.3 177.1,272 233,250.3 237.4,260.8 242.3,271 247.7,281 253.7,290.7 260.1,300.1 267,309.1" style={{ fill: "var(--heat-2)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <text x="221.8" y="300" textAnchor="middle" style={{ fill: "var(--text)", fontSize: "11px", fontWeight: "700" }}>A9</text>
                          <polygon points="173,260.9 168.7,247.1 165.2,233.1 162.3,219 160.1,204.7 158.7,190.3 158.1,175.9 218,174.6 218.6,186 219.7,197.3 221.4,208.5 223.6,219.7 226.5,230.7 229.8,241.5" style={{ fill: "var(--heat-2)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <text x="191.8" y="217.8" textAnchor="middle" style={{ fill: "var(--text)", fontSize: "11px", fontWeight: "700" }}>A10</text>
                          <polygon points="158.1,164.1 158.7,149.7 160.1,135.3 162.3,121 165.2,106.9 168.7,92.9 173,79.1 229.8,98.5 226.5,109.3 223.6,120.3 221.4,131.5 219.7,142.7 218.6,154 218,165.4" style={{ fill: "var(--heat-2)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <text x="191.8" y="130.2" textAnchor="middle" style={{ fill: "var(--text)", fontSize: "11px", fontWeight: "700" }}>A11</text>
                          <polygon points="761.9,60.4 767,77 771.4,93.9 774.8,111 777.4,128.2 779.1,145.5 779.9,162.9 731.9,163.9 731.2,149 729.8,134.1 727.6,119.3 724.6,104.6 720.9,90.2 716.4,75.9" style={{ fill: "var(--heat-1)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <text x="751.2" y="119.1" textAnchor="middle" style={{ fill: "var(--text)", fontSize: "11px", fontWeight: "700" }}>B1</text>
                          <polygon points="779.9,177.1 779.1,194.5 777.4,211.8 774.8,229 771.4,246.1 767,263 761.9,279.6 716.4,264.1 720.9,249.8 724.6,235.4 727.6,220.7 729.8,205.9 731.2,191 731.9,176.1" style={{ fill: "var(--heat-1)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <text x="751.2" y="228.9" textAnchor="middle" style={{ fill: "var(--text)", fontSize: "11px", fontWeight: "700" }}>B2</text>
                          <polygon points="757,293 750.3,309 742.8,324.7 734.4,340 725.4,354.8 715.5,369.2 705,383 667.6,353 676.6,341.1 685.1,328.7 692.9,316 700,302.9 706.5,289.4 712.2,275.6" style={{ fill: "var(--heat-1)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <text x="713.7" y="332" textAnchor="middle" style={{ fill: "var(--text)", fontSize: "11px", fontWeight: "700" }}>B3</text>
                          <polygon points="695.8,394 684,406.8 671.6,418.9 658.5,430.5 644.9,441.3 630.8,451.4 616.1,460.8 591.3,419.8 603.8,411.7 616,403 627.7,393.7 638.9,383.8 649.6,373.3 659.7,362.3" style={{ fill: "var(--heat-1)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <text x="643.1" y="416.1" textAnchor="middle" style={{ fill: "var(--text)", fontSize: "11px", fontWeight: "700" }}>B4</text>
                          <polygon points="603.8,467.9 588.3,475.9 572.5,483.1 556.3,489.5 539.8,495 523,499.7 506,503.5 496.7,456.4 511.3,453.2 525.7,449.1 539.9,444.4 553.8,438.9 567.4,432.7 580.7,425.9" style={{ fill: "var(--heat-1)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <text x="548.1" y="470.9" textAnchor="middle" style={{ fill: "var(--text)", fontSize: "11px", fontWeight: "700" }}>B5</text>
                          <polygon points="492,506 474.8,508.2 457.4,509.6 440,510 422.6,509.6 405.2,508.2 388,506 395.3,458.6 410.2,460.5 425.1,461.6 440,462 454.9,461.6 469.8,460.5 484.7,458.6" style={{ fill: "var(--heat-1)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <text x="440" y="490" textAnchor="middle" style={{ fill: "var(--text)", fontSize: "11px", fontWeight: "700" }}>B6</text>
                          <polygon points="374,503.5 357,499.7 340.2,495 323.7,489.5 307.5,483.1 291.7,475.9 276.2,467.9 299.3,425.9 312.6,432.7 326.2,438.9 340.1,444.4 354.3,449.1 368.7,453.2 383.3,456.4" style={{ fill: "var(--heat-2)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <text x="331.9" y="470.9" textAnchor="middle" style={{ fill: "var(--text)", fontSize: "11px", fontWeight: "700" }}>B7</text>
                          <polygon points="263.9,460.8 249.2,451.4 235.1,441.3 221.5,430.5 208.4,418.9 196,406.8 184.2,394 220.3,362.3 230.4,373.3 241.1,383.8 252.3,393.7 264,403 276.2,411.7 288.7,419.8" style={{ fill: "var(--heat-1)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <text x="236.9" y="416.1" textAnchor="middle" style={{ fill: "var(--text)", fontSize: "11px", fontWeight: "700" }}>B8</text>
                          <polygon points="175,383 164.5,369.2 154.6,354.8 145.6,340 137.2,324.7 129.7,309 123,293 167.8,275.6 173.5,289.4 180,302.9 187.1,316 194.9,328.7 203.4,341.1 212.4,353" style={{ fill: "var(--heat-1)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <text x="166.3" y="332" textAnchor="middle" style={{ fill: "var(--text)", fontSize: "11px", fontWeight: "700" }}>B9</text>
                          <polygon points="118.1,279.6 113,263 108.6,246.1 105.2,229 102.6,211.8 100.9,194.5 100.1,177.1 148.1,176.1 148.8,191 150.2,205.9 152.4,220.7 155.4,235.4 159.1,249.8 163.6,264.1" style={{ fill: "var(--heat-1)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <text x="128.8" y="228.9" textAnchor="middle" style={{ fill: "var(--text)", fontSize: "11px", fontWeight: "700" }}>B10</text>
                          <polygon points="100.1,162.9 100.9,145.5 102.6,128.2 105.2,111 108.6,93.9 113,77 118.1,60.4 163.6,75.9 159.1,90.2 155.4,104.6 152.4,119.3 150.2,134.1 148.8,149 148.1,163.9" style={{ fill: "var(--heat-1)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <text x="128.8" y="119.1" textAnchor="middle" style={{ fill: "var(--text)", fontSize: "11px", fontWeight: "700" }}>B11</text>
                          {v.isInv ? <SeatMarks picked={v.isCand} /> : null}
                        </svg>
                      </>
                    ) : null}
                    {' '}
                    {v.candMap ? (
                      <>
                        <svg viewBox="0 0 880 520" role="img" aria-label="좌석 리플레이. 오픈 뒤 2분 14초의 좌석 상태입니다. 무대 앞 플로어와 아래층 가운데 구역이 거의 다 팔렸고 위층 끝 구역에 빈 좌석이 남았습니다. 후보 세션이 잡은 좌석은 플로어 F2와 아래층 A5·A6에 몰려 있습니다." style={{ display: "block", width: "100%", height: "auto" }}>
                          <rect x="330" y="18" width="220" height="36" rx="6" style={{ fill: "var(--fill-weak-strong)" }} />
                          <text x="440" y="41" textAnchor="middle" style={{ fill: "var(--text-muted)", fontSize: "13px", fontWeight: "700" }}>무대</text>
                          <rect x="312" y="82" width="58" height="54" rx="4" style={{ fill: "var(--heat-2)" }} />
                          <text x="341" y="113" textAnchor="middle" style={{ fill: "var(--text)", fontSize: "11px", fontWeight: "700" }}>F1</text>
                          <rect x="378" y="82" width="58" height="54" rx="4" style={{ fill: "var(--heat-2)" }} />
                          <text x="407" y="113" textAnchor="middle" style={{ fill: "var(--text)", fontSize: "11px", fontWeight: "700" }}>F2</text>
                          <rect x="444" y="82" width="58" height="54" rx="4" style={{ fill: "var(--heat-3)" }} />
                          <text x="473" y="113" textAnchor="middle" style={{ fill: "var(--text)", fontSize: "11px", fontWeight: "700" }}>F3</text>
                          <rect x="510" y="82" width="58" height="54" rx="4" style={{ fill: "var(--heat-2)" }} />
                          <text x="539" y="113" textAnchor="middle" style={{ fill: "var(--text)", fontSize: "11px", fontWeight: "700" }}>F4</text>
                          <rect x="312" y="144" width="58" height="54" rx="4" style={{ fill: "var(--heat-2)" }} />
                          <text x="341" y="175" textAnchor="middle" style={{ fill: "var(--text)", fontSize: "11px", fontWeight: "700" }}>F5</text>
                          <rect x="378" y="144" width="58" height="54" rx="4" style={{ fill: "var(--heat-2)" }} />
                          <text x="407" y="175" textAnchor="middle" style={{ fill: "var(--text)", fontSize: "11px", fontWeight: "700" }}>F6</text>
                          <rect x="444" y="144" width="58" height="54" rx="4" style={{ fill: "var(--heat-2)" }} />
                          <text x="473" y="175" textAnchor="middle" style={{ fill: "var(--text)", fontSize: "11px", fontWeight: "700" }}>F7</text>
                          <rect x="510" y="144" width="58" height="54" rx="4" style={{ fill: "var(--heat-2)" }} />
                          <text x="539" y="175" textAnchor="middle" style={{ fill: "var(--text)", fontSize: "11px", fontWeight: "700" }}>F8</text>
                          <polygon points="707,79.1 711.3,92.9 714.8,106.9 717.7,121 719.9,135.3 721.3,149.7 721.9,164.1 662,165.4 661.4,154 660.3,142.7 658.6,131.5 656.4,120.3 653.5,109.3 650.2,98.5" style={{ fill: "var(--heat-2)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <text x="688.2" y="130.2" textAnchor="middle" style={{ fill: "var(--text)", fontSize: "11px", fontWeight: "700" }}>A1</text>
                          <polygon points="721.9,175.9 721.3,190.3 719.9,204.7 717.7,219 714.8,233.1 711.3,247.1 707,260.9 650.2,241.5 653.5,230.7 656.4,219.7 658.6,208.5 660.3,197.3 661.4,186 662,174.6" style={{ fill: "var(--heat-2)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <text x="688.2" y="217.8" textAnchor="middle" style={{ fill: "var(--text)", fontSize: "11px", fontWeight: "700" }}>A2</text>
                          <polygon points="702.9,272 697.4,285.3 691.1,298.3 684.2,311 676.7,323.3 668.5,335.2 659.8,346.7 613,309.1 619.9,300.1 626.3,290.7 632.3,281 637.7,271 642.6,260.8 647,250.3" style={{ fill: "var(--heat-2)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <text x="658.2" y="300" textAnchor="middle" style={{ fill: "var(--text)", fontSize: "11px", fontWeight: "700" }}>A3</text>
                          <polygon points="652.2,355.8 642.4,366.4 632.1,376.5 621.3,386 610,395 598.2,403.4 586.1,411.2 555,359.9 564.6,353.8 573.8,347.1 582.7,340.1 591.2,332.5 599.3,324.6 607,316.2" style={{ fill: "var(--heat-2)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <text x="602" y="367" textAnchor="middle" style={{ fill: "var(--text)", fontSize: "11px", fontWeight: "700" }}>A4</text>
                          <polygon points="575.9,417.1 563,423.7 549.9,429.7 536.4,435 522.8,439.6 508.9,443.5 494.8,446.6 483.1,387.8 494.2,385.3 505.2,382.2 515.9,378.6 526.5,374.5 536.9,369.8 546.9,364.5" style={{ fill: "var(--heat-2)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <text x="526.2" y="410.8" textAnchor="middle" style={{ fill: "var(--text)", fontSize: "11px", fontWeight: "700" }}>A5</text>
                          <polygon points="483.1,448.7 468.8,450.5 454.4,451.6 440,452 425.6,451.6 411.2,450.5 396.9,448.7 406,389.4 417.3,390.8 428.6,391.7 440,392 451.4,391.7 462.7,390.8 474,389.4" style={{ fill: "var(--heat-2)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <text x="440" y="426" textAnchor="middle" style={{ fill: "var(--text)", fontSize: "11px", fontWeight: "700" }}>A6</text>
                          <polygon points="385.2,446.6 371.1,443.5 357.2,439.6 343.6,435 330.1,429.7 317,423.7 304.1,417.1 333.1,364.5 343.1,369.8 353.5,374.5 364.1,378.6 374.8,382.2 385.8,385.3 396.9,387.8" style={{ fill: "var(--heat-2)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <text x="353.8" y="410.8" textAnchor="middle" style={{ fill: "var(--text)", fontSize: "11px", fontWeight: "700" }}>A7</text>
                          <polygon points="293.9,411.2 281.8,403.4 270,395 258.7,386 247.9,376.5 237.6,366.4 227.8,355.8 273,316.2 280.7,324.6 288.8,332.5 297.3,340.1 306.2,347.1 315.4,353.8 325,359.9" style={{ fill: "var(--heat-2)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <text x="278" y="367" textAnchor="middle" style={{ fill: "var(--text)", fontSize: "11px", fontWeight: "700" }}>A8</text>
                          <polygon points="220.2,346.7 211.5,335.2 203.3,323.3 195.8,311 188.9,298.3 182.6,285.3 177.1,272 233,250.3 237.4,260.8 242.3,271 247.7,281 253.7,290.7 260.1,300.1 267,309.1" style={{ fill: "var(--heat-2)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <text x="221.8" y="300" textAnchor="middle" style={{ fill: "var(--text)", fontSize: "11px", fontWeight: "700" }}>A9</text>
                          <polygon points="173,260.9 168.7,247.1 165.2,233.1 162.3,219 160.1,204.7 158.7,190.3 158.1,175.9 218,174.6 218.6,186 219.7,197.3 221.4,208.5 223.6,219.7 226.5,230.7 229.8,241.5" style={{ fill: "var(--heat-2)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <text x="191.8" y="217.8" textAnchor="middle" style={{ fill: "var(--text)", fontSize: "11px", fontWeight: "700" }}>A10</text>
                          <polygon points="158.1,164.1 158.7,149.7 160.1,135.3 162.3,121 165.2,106.9 168.7,92.9 173,79.1 229.8,98.5 226.5,109.3 223.6,120.3 221.4,131.5 219.7,142.7 218.6,154 218,165.4" style={{ fill: "var(--heat-2)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <text x="191.8" y="130.2" textAnchor="middle" style={{ fill: "var(--text)", fontSize: "11px", fontWeight: "700" }}>A11</text>
                          <polygon points="761.9,60.4 767,77 771.4,93.9 774.8,111 777.4,128.2 779.1,145.5 779.9,162.9 731.9,163.9 731.2,149 729.8,134.1 727.6,119.3 724.6,104.6 720.9,90.2 716.4,75.9" style={{ fill: "var(--heat-1)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <text x="751.2" y="119.1" textAnchor="middle" style={{ fill: "var(--text)", fontSize: "11px", fontWeight: "700" }}>B1</text>
                          <polygon points="779.9,177.1 779.1,194.5 777.4,211.8 774.8,229 771.4,246.1 767,263 761.9,279.6 716.4,264.1 720.9,249.8 724.6,235.4 727.6,220.7 729.8,205.9 731.2,191 731.9,176.1" style={{ fill: "var(--heat-1)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <text x="751.2" y="228.9" textAnchor="middle" style={{ fill: "var(--text)", fontSize: "11px", fontWeight: "700" }}>B2</text>
                          <polygon points="757,293 750.3,309 742.8,324.7 734.4,340 725.4,354.8 715.5,369.2 705,383 667.6,353 676.6,341.1 685.1,328.7 692.9,316 700,302.9 706.5,289.4 712.2,275.6" style={{ fill: "var(--heat-1)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <text x="713.7" y="332" textAnchor="middle" style={{ fill: "var(--text)", fontSize: "11px", fontWeight: "700" }}>B3</text>
                          <polygon points="695.8,394 684,406.8 671.6,418.9 658.5,430.5 644.9,441.3 630.8,451.4 616.1,460.8 591.3,419.8 603.8,411.7 616,403 627.7,393.7 638.9,383.8 649.6,373.3 659.7,362.3" style={{ fill: "var(--heat-1)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <text x="643.1" y="416.1" textAnchor="middle" style={{ fill: "var(--text)", fontSize: "11px", fontWeight: "700" }}>B4</text>
                          <polygon points="603.8,467.9 588.3,475.9 572.5,483.1 556.3,489.5 539.8,495 523,499.7 506,503.5 496.7,456.4 511.3,453.2 525.7,449.1 539.9,444.4 553.8,438.9 567.4,432.7 580.7,425.9" style={{ fill: "var(--heat-1)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <text x="548.1" y="470.9" textAnchor="middle" style={{ fill: "var(--text)", fontSize: "11px", fontWeight: "700" }}>B5</text>
                          <polygon points="492,506 474.8,508.2 457.4,509.6 440,510 422.6,509.6 405.2,508.2 388,506 395.3,458.6 410.2,460.5 425.1,461.6 440,462 454.9,461.6 469.8,460.5 484.7,458.6" style={{ fill: "var(--heat-1)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <text x="440" y="490" textAnchor="middle" style={{ fill: "var(--text)", fontSize: "11px", fontWeight: "700" }}>B6</text>
                          <polygon points="374,503.5 357,499.7 340.2,495 323.7,489.5 307.5,483.1 291.7,475.9 276.2,467.9 299.3,425.9 312.6,432.7 326.2,438.9 340.1,444.4 354.3,449.1 368.7,453.2 383.3,456.4" style={{ fill: "var(--heat-2)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <text x="331.9" y="470.9" textAnchor="middle" style={{ fill: "var(--text)", fontSize: "11px", fontWeight: "700" }}>B7</text>
                          <polygon points="263.9,460.8 249.2,451.4 235.1,441.3 221.5,430.5 208.4,418.9 196,406.8 184.2,394 220.3,362.3 230.4,373.3 241.1,383.8 252.3,393.7 264,403 276.2,411.7 288.7,419.8" style={{ fill: "var(--heat-1)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <text x="236.9" y="416.1" textAnchor="middle" style={{ fill: "var(--text)", fontSize: "11px", fontWeight: "700" }}>B8</text>
                          <polygon points="175,383 164.5,369.2 154.6,354.8 145.6,340 137.2,324.7 129.7,309 123,293 167.8,275.6 173.5,289.4 180,302.9 187.1,316 194.9,328.7 203.4,341.1 212.4,353" style={{ fill: "var(--heat-1)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <text x="166.3" y="332" textAnchor="middle" style={{ fill: "var(--text)", fontSize: "11px", fontWeight: "700" }}>B9</text>
                          <polygon points="118.1,279.6 113,263 108.6,246.1 105.2,229 102.6,211.8 100.9,194.5 100.1,177.1 148.1,176.1 148.8,191 150.2,205.9 152.4,220.7 155.4,235.4 159.1,249.8 163.6,264.1" style={{ fill: "var(--heat-1)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <text x="128.8" y="228.9" textAnchor="middle" style={{ fill: "var(--text)", fontSize: "11px", fontWeight: "700" }}>B10</text>
                          <polygon points="100.1,162.9 100.9,145.5 102.6,128.2 105.2,111 108.6,93.9 113,77 118.1,60.4 163.6,75.9 159.1,90.2 155.4,104.6 152.4,119.3 150.2,134.1 148.8,149 148.1,163.9" style={{ fill: "var(--heat-1)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <text x="128.8" y="119.1" textAnchor="middle" style={{ fill: "var(--text)", fontSize: "11px", fontWeight: "700" }}>B11</text>
                          <circle cx="399" cy="111.3" r="3.4" style={{ fill: "none", stroke: "var(--danger)", strokeWidth: "1.8" }} />
                          <circle cx="387.9" cy="101.3" r="3.4" style={{ fill: "none", stroke: "var(--danger)", strokeWidth: "1.8" }} />
                          <circle cx="404" cy="125.7" r="3.4" style={{ fill: "none", stroke: "var(--danger)", strokeWidth: "1.8" }} />
                          <circle cx="385.2" cy="97.5" r="3.4" style={{ fill: "none", stroke: "var(--danger)", strokeWidth: "1.8" }} />
                          <circle cx="400.6" cy="92.2" r="3.4" style={{ fill: "none", stroke: "var(--danger)", strokeWidth: "1.8" }} />
                          <circle cx="430.5" cy="106.6" r="3.4" style={{ fill: "none", stroke: "var(--danger)", strokeWidth: "1.8" }} />
                          <circle cx="390.6" cy="88.7" r="3.4" style={{ fill: "none", stroke: "var(--danger)", strokeWidth: "1.8" }} />
                          <circle cx="397.1" cy="117.5" r="3.4" style={{ fill: "none", stroke: "var(--danger)", strokeWidth: "1.8" }} />
                          <circle cx="393.9" cy="120.1" r="3.4" style={{ fill: "none", stroke: "var(--danger)", strokeWidth: "1.8" }} />
                          <circle cx="411.9" cy="89.3" r="3.4" style={{ fill: "none", stroke: "var(--danger)", strokeWidth: "1.8" }} />
                          <circle cx="383.8" cy="99.6" r="3.4" style={{ fill: "none", stroke: "var(--danger)", strokeWidth: "1.8" }} />
                          <circle cx="392.6" cy="115.2" r="3.4" style={{ fill: "none", stroke: "var(--danger)", strokeWidth: "1.8" }} />
                          <circle cx="429.2" cy="101.8" r="3.4" style={{ fill: "none", stroke: "var(--danger)", strokeWidth: "1.8" }} />
                          <circle cx="389.2" cy="111.2" r="3.4" style={{ fill: "none", stroke: "var(--danger)", strokeWidth: "1.8" }} />
                          <circle cx="427.9" cy="91.7" r="3.4" style={{ fill: "none", stroke: "var(--danger)", strokeWidth: "1.8" }} />
                          <circle cx="399.4" cy="90.9" r="3.4" style={{ fill: "none", stroke: "var(--danger)", strokeWidth: "1.8" }} />
                          <circle cx="417" cy="97.1" r="3.4" style={{ fill: "none", stroke: "var(--danger)", strokeWidth: "1.8" }} />
                          <circle cx="414.8" cy="97.5" r="3.4" style={{ fill: "none", stroke: "var(--danger)", strokeWidth: "1.8" }} />
                          <circle cx="422.3" cy="88.2" r="3.4" style={{ fill: "none", stroke: "var(--danger)", strokeWidth: "1.8" }} />
                          <circle cx="404.3" cy="96" r="3.4" style={{ fill: "none", stroke: "var(--danger)", strokeWidth: "1.8" }} />
                          <circle cx="386.9" cy="110.7" r="3.4" style={{ fill: "none", stroke: "var(--danger)", strokeWidth: "1.8" }} />
                          <circle cx="430.2" cy="122.4" r="3.4" style={{ fill: "none", stroke: "var(--danger)", strokeWidth: "1.8" }} />
                          <circle cx="406.4" cy="95.6" r="3.4" style={{ fill: "none", stroke: "var(--danger)", strokeWidth: "1.8" }} />
                          <circle cx="396.1" cy="126.4" r="3.4" style={{ fill: "none", stroke: "var(--danger)", strokeWidth: "1.8" }} />
                          <circle cx="425.2" cy="97.8" r="3.4" style={{ fill: "none", stroke: "var(--danger)", strokeWidth: "1.8" }} />
                          <circle cx="411" cy="104.4" r="3.4" style={{ fill: "none", stroke: "var(--danger)", strokeWidth: "1.8" }} />
                          <circle cx="408.5" cy="443.9" r="3.4" style={{ fill: "none", stroke: "var(--danger)", strokeWidth: "1.8" }} />
                          <circle cx="498.8" cy="404.2" r="3.4" style={{ fill: "none", stroke: "var(--danger)", strokeWidth: "1.8" }} />
                          <circle cx="478.6" cy="403.8" r="3.4" style={{ fill: "none", stroke: "var(--danger)", strokeWidth: "1.8" }} />
                          <circle cx="453.5" cy="432.2" r="3.4" style={{ fill: "none", stroke: "var(--danger)", strokeWidth: "1.8" }} />
                          <circle cx="484.9" cy="436.6" r="3.4" style={{ fill: "none", stroke: "var(--danger)", strokeWidth: "1.8" }} />
                          <circle cx="474.6" cy="431.5" r="3.4" style={{ fill: "none", stroke: "var(--danger)", strokeWidth: "1.8" }} />
                          <circle cx="471.7" cy="407.7" r="3.4" style={{ fill: "none", stroke: "var(--danger)", strokeWidth: "1.8" }} />
                          <circle cx="414.8" cy="431.5" r="3.4" style={{ fill: "none", stroke: "var(--danger)", strokeWidth: "1.8" }} />
                          <circle cx="487.4" cy="432.2" r="3.4" style={{ fill: "none", stroke: "var(--danger)", strokeWidth: "1.8" }} />
                          <circle cx="395.3" cy="421.5" r="3.4" style={{ fill: "none", stroke: "var(--danger)", strokeWidth: "1.8" }} />
                          <circle cx="404" cy="404" r="3.4" style={{ fill: "none", stroke: "var(--danger)", strokeWidth: "1.8" }} />
                          <circle cx="414" cy="427.8" r="3.4" style={{ fill: "none", stroke: "var(--danger)", strokeWidth: "1.8" }} />
                          <circle cx="491.5" cy="407.1" r="3.4" style={{ fill: "none", stroke: "var(--danger)", strokeWidth: "1.8" }} />
                          <circle cx="442.7" cy="431.7" r="3.4" style={{ fill: "none", stroke: "var(--danger)", strokeWidth: "1.8" }} />
                          <circle cx="393.9" cy="400.5" r="3.4" style={{ fill: "none", stroke: "var(--danger)", strokeWidth: "1.8" }} />
                          <circle cx="397.6" cy="431.9" r="3.4" style={{ fill: "none", stroke: "var(--danger)", strokeWidth: "1.8" }} />
                          <circle cx="428.1" cy="436.5" r="3.4" style={{ fill: "none", stroke: "var(--danger)", strokeWidth: "1.8" }} />
                          <circle cx="370.4" cy="415.9" r="3.4" style={{ fill: "none", stroke: "var(--danger)", strokeWidth: "1.8" }} />
                          <circle cx="432" cy="415.1" r="3.4" style={{ fill: "none", stroke: "var(--danger)", strokeWidth: "1.8" }} />
                          <circle cx="488.2" cy="438" r="3.4" style={{ fill: "none", stroke: "var(--danger)", strokeWidth: "1.8" }} />
                          <circle cx="392.8" cy="434.1" r="3.4" style={{ fill: "none", stroke: "var(--danger)", strokeWidth: "1.8" }} />
                          <circle cx="481.3" cy="398.1" r="3.4" style={{ fill: "none", stroke: "var(--danger)", strokeWidth: "1.8" }} />
                          <circle cx="464.9" cy="421.7" r="3.4" style={{ fill: "none", stroke: "var(--danger)", strokeWidth: "1.8" }} />
                          <circle cx="379.1" cy="405.3" r="3.4" style={{ fill: "none", stroke: "var(--danger)", strokeWidth: "1.8" }} />
                          <circle cx="427.4" cy="400.1" r="3.4" style={{ fill: "none", stroke: "var(--danger)", strokeWidth: "1.8" }} />
                          <circle cx="424.8" cy="417" r="3.4" style={{ fill: "none", stroke: "var(--danger)", strokeWidth: "1.8" }} />
                          <circle cx="509.8" cy="395.2" r="3.4" style={{ fill: "none", stroke: "var(--danger)", strokeWidth: "1.8" }} />
                          <circle cx="520" cy="393.1" r="3.4" style={{ fill: "none", stroke: "var(--danger)", strokeWidth: "1.8" }} />
                          <circle cx="437.9" cy="407.9" r="3.4" style={{ fill: "none", stroke: "var(--danger)", strokeWidth: "1.8" }} />
                          <circle cx="427.2" cy="411.9" r="3.4" style={{ fill: "none", stroke: "var(--danger)", strokeWidth: "1.8" }} />
                          <circle cx="447.9" cy="432.4" r="3.4" style={{ fill: "none", stroke: "var(--danger)", strokeWidth: "1.8" }} />
                          <circle cx="515.6" cy="400.8" r="3.4" style={{ fill: "none", stroke: "var(--danger)", strokeWidth: "1.8" }} />
                          <circle cx="485.5" cy="403.3" r="3.4" style={{ fill: "none", stroke: "var(--danger)", strokeWidth: "1.8" }} />
                          <circle cx="402.5" cy="417" r="3.4" style={{ fill: "none", stroke: "var(--danger)", strokeWidth: "1.8" }} />
                        </svg>
                      </>
                    ) : null}
                    {' '}
                    {v.isSport ? (
                      <>
                        <svg viewBox="0 0 880 520" role="img" aria-label="좌석 리플레이. 오픈 뒤 2분 14초의 좌석 상태입니다. 원형 경기장 긴 변 가운데의 아래층 구역은 90% 넘게 팔렸고 위층 양 끝 구역에는 빈 좌석이 절반 넘게 남았습니다." style={{ display: "block", width: "100%", height: "auto" }}>
                          <ellipse cx="440" cy="262" rx="150" ry="84" style={{ fill: "var(--fill-weak-strong)" }} />
                          <text x="440" y="267" textAnchor="middle" style={{ fill: "var(--text-muted)", fontSize: "13px", fontWeight: "700" }}>경기장</text>
                          <polygon points="444.4,96 459.4,96.5 474.3,97.5 489.2,99.2 503.8,101.4 518.2,104.2 532.4,107.6 503,165.2 493.4,163.1 483.5,161.4 473.6,160 463.4,159 453.2,158.3 443,158" style={{ fill: "var(--heat-3)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <text x="481.4" y="133.6" textAnchor="middle" style={{ fill: "var(--text)", fontSize: "11px", fontWeight: "700" }}>101</text>
                          <polygon points="540.5,109.8 554.1,114 567.3,118.7 580,124 592.2,129.7 603.9,135.9 615.1,142.6 559.5,187.2 551.9,183 543.9,179.1 535.6,175.5 526.9,172.2 517.9,169.3 508.6,166.6" style={{ fill: "var(--heat-2)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <text x="557.8" y="153.8" textAnchor="middle" style={{ fill: "var(--text)", fontSize: "11px", fontWeight: "700" }}>102</text>
                          <polygon points="621.3,146.7 631.4,154 640.8,161.7 649.5,169.8 657.5,178.2 664.7,186.9 671.1,195.8 597.7,220.5 593.4,214.9 588.5,209.5 583,204.2 577.1,199.2 570.6,194.3 563.7,189.8" style={{ fill: "var(--heat-2)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <text x="616.3" y="191" textAnchor="middle" style={{ fill: "var(--text)", fontSize: "11px", fontWeight: "700" }}>103</text>
                          <polygon points="674.5,201.2 679.6,210.5 683.8,220 687.2,229.6 689.6,239.4 691.3,249.2 692,259.1 612,260.2 611.5,254 610.4,247.8 608.7,241.7 606.4,235.7 603.5,229.7 600,223.9" style={{ fill: "var(--heat-2)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <text x="647.9" y="239.7" textAnchor="middle" style={{ fill: "var(--text)", fontSize: "11px", fontWeight: "700" }}>104</text>
                          <polygon points="692,264.9 691.3,274.8 689.6,284.6 687.2,294.4 683.8,304 679.6,313.5 674.5,322.8 600,300.1 603.5,294.3 606.4,288.3 608.7,282.3 610.4,276.2 611.5,270 612,263.8" style={{ fill: "var(--heat-2)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <text x="647.9" y="292.3" textAnchor="middle" style={{ fill: "var(--text)", fontSize: "11px", fontWeight: "700" }}>105</text>
                          <polygon points="671.1,328.2 664.7,337.1 657.5,345.8 649.5,354.2 640.8,362.3 631.4,370 621.3,377.3 563.7,334.2 570.6,329.7 577.1,324.8 583,319.8 588.5,314.5 593.4,309.1 597.7,303.5" style={{ fill: "var(--heat-2)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <text x="616.3" y="341" textAnchor="middle" style={{ fill: "var(--text)", fontSize: "11px", fontWeight: "700" }}>106</text>
                          <polygon points="615.1,381.4 603.9,388.1 592.2,394.3 580,400 567.3,405.3 554.1,410 540.5,414.2 508.6,357.4 517.9,354.7 526.9,351.8 535.6,348.5 543.9,344.9 551.9,341 559.5,336.8" style={{ fill: "var(--heat-3)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <text x="557.8" y="378.2" textAnchor="middle" style={{ fill: "var(--text)", fontSize: "11px", fontWeight: "700" }}>107</text>
                          <polygon points="532.4,416.4 518.2,419.8 503.8,422.6 489.2,424.8 474.3,426.5 459.4,427.5 444.4,428 443,366 453.2,365.7 463.4,365 473.6,364 483.5,362.6 493.4,360.9 503,358.8" style={{ fill: "var(--heat-3)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <text x="481.4" y="398.4" textAnchor="middle" style={{ fill: "var(--text)", fontSize: "11px", fontWeight: "700" }}>108</text>
                          <polygon points="435.6,428 420.6,427.5 405.7,426.5 390.8,424.8 376.2,422.6 361.8,419.8 347.6,416.4 377,358.8 386.6,360.9 396.5,362.6 406.4,364 416.6,365 426.8,365.7 437,366" style={{ fill: "var(--heat-3)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <text x="398.6" y="398.4" textAnchor="middle" style={{ fill: "var(--text)", fontSize: "11px", fontWeight: "700" }}>109</text>
                          <polygon points="339.5,414.2 325.9,410 312.7,405.3 300,400 287.8,394.3 276.1,388.1 264.9,381.4 320.5,336.8 328.1,341 336.1,344.9 344.4,348.5 353.1,351.8 362.1,354.7 371.4,357.4" style={{ fill: "var(--heat-2)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <text x="322.2" y="378.2" textAnchor="middle" style={{ fill: "var(--text)", fontSize: "11px", fontWeight: "700" }}>110</text>
                          <polygon points="258.7,377.3 248.6,370 239.2,362.3 230.5,354.2 222.5,345.8 215.3,337.1 208.9,328.2 282.3,303.5 286.6,309.1 291.5,314.5 297,319.8 302.9,324.8 309.4,329.7 316.3,334.2" style={{ fill: "var(--heat-2)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <text x="263.7" y="341" textAnchor="middle" style={{ fill: "var(--text)", fontSize: "11px", fontWeight: "700" }}>111</text>
                          <polygon points="205.5,322.8 200.4,313.5 196.2,304 192.8,294.4 190.4,284.6 188.7,274.8 188,264.9 268,263.8 268.5,270 269.6,276.2 271.3,282.3 273.6,288.3 276.5,294.3 280,300.1" style={{ fill: "var(--heat-2)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <text x="232.1" y="292.3" textAnchor="middle" style={{ fill: "var(--text)", fontSize: "11px", fontWeight: "700" }}>112</text>
                          <polygon points="188,259.1 188.7,249.2 190.4,239.4 192.8,229.6 196.2,220 200.4,210.5 205.5,201.2 280,223.9 276.5,229.7 273.6,235.7 271.3,241.7 269.6,247.8 268.5,254 268,260.2" style={{ fill: "var(--heat-2)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <text x="232.1" y="239.7" textAnchor="middle" style={{ fill: "var(--text)", fontSize: "11px", fontWeight: "700" }}>113</text>
                          <polygon points="208.9,195.8 215.3,186.9 222.5,178.2 230.5,169.8 239.2,161.7 248.6,154 258.7,146.7 316.3,189.8 309.4,194.3 302.9,199.2 297,204.2 291.5,209.5 286.6,214.9 282.3,220.5" style={{ fill: "var(--heat-2)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <text x="263.7" y="191" textAnchor="middle" style={{ fill: "var(--text)", fontSize: "11px", fontWeight: "700" }}>114</text>
                          <polygon points="264.9,142.6 276.1,135.9 287.8,129.7 300,124 312.7,118.7 325.9,114 339.5,109.8 371.4,166.6 362.1,169.3 353.1,172.2 344.4,175.5 336.1,179.1 328.1,183 320.5,187.2" style={{ fill: "var(--heat-3)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <text x="322.2" y="153.8" textAnchor="middle" style={{ fill: "var(--text)", fontSize: "11px", fontWeight: "700" }}>115</text>
                          <polygon points="347.6,107.6 361.8,104.2 376.2,101.4 390.8,99.2 405.7,97.5 420.6,96.5 435.6,96 437,158 426.8,158.3 416.6,159 406.4,160 396.5,161.4 386.6,163.1 377,165.2" style={{ fill: "var(--heat-3)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <text x="398.6" y="133.6" textAnchor="middle" style={{ fill: "var(--text)", fontSize: "11px", fontWeight: "700" }}>116</text>
                          <polygon points="445.8,30 465.4,30.7 485,32.2 504.4,34.5 523.6,37.6 542.4,41.5 560.9,46.1 536,100.1 521.3,96.6 506.3,93.7 491.1,91.3 475.7,89.6 460.2,88.5 444.6,88" style={{ fill: "var(--heat-2)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <text x="497.7" y="66.9" textAnchor="middle" style={{ fill: "var(--text)", fontSize: "11px", fontWeight: "700" }}>201</text>
                          <polygon points="571.6,49.2 589.4,55.1 606.7,61.8 623.3,69.1 639.4,77.1 654.7,85.8 669.2,95.1 622,136.8 610.4,129.9 598.3,123.3 585.6,117.3 572.3,111.8 558.6,106.9 544.5,102.4" style={{ fill: "var(--heat-2)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <text x="604.4" y="97.2" textAnchor="middle" style={{ fill: "var(--text)", fontSize: "11px", fontWeight: "700" }}>202</text>
                          <polygon points="677.4,100.8 690.6,111.1 703,121.8 714.4,133.1 724.8,144.8 734.2,157 742.6,169.5 680.3,192.6 673.6,183.2 666.1,174.1 657.8,165.3 648.8,156.9 639,148.8 628.5,141.1" style={{ fill: "var(--heat-2)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <text x="686.1" y="153.2" textAnchor="middle" style={{ fill: "var(--text)", fontSize: "11px", fontWeight: "700" }}>203</text>
                          <polygon points="747,177 753.7,190 759.2,203.3 763.7,216.7 766.9,230.4 769,244.1 769.9,258 702,259 701.2,248.6 699.6,238.3 697,228.1 693.5,217.9 689.1,208 683.8,198.2" style={{ fill: "var(--heat-1)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <text x="730.3" y="226.4" textAnchor="middle" style={{ fill: "var(--text)", fontSize: "11px", fontWeight: "700" }}>204</text>
                          <polygon points="769.9,266 769,279.9 766.9,293.6 763.7,307.3 759.2,320.7 753.7,334 747,347 683.8,325.8 689.1,316 693.5,306.1 697,295.9 699.6,285.7 701.2,275.4 702,265" style={{ fill: "var(--heat-1)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <text x="730.3" y="305.6" textAnchor="middle" style={{ fill: "var(--text)", fontSize: "11px", fontWeight: "700" }}>205</text>
                          <polygon points="742.6,354.5 734.2,367 724.8,379.2 714.4,390.9 703,402.2 690.6,412.9 677.4,423.2 628.5,382.9 639,375.2 648.8,367.1 657.8,358.7 666.1,349.9 673.6,340.8 680.3,331.4" style={{ fill: "var(--heat-1)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <text x="686.1" y="378.8" textAnchor="middle" style={{ fill: "var(--text)", fontSize: "11px", fontWeight: "700" }}>206</text>
                          <polygon points="669.2,428.9 654.7,438.2 639.4,446.9 623.3,454.9 606.7,462.2 589.4,468.9 571.6,474.8 544.5,421.6 558.6,417.1 572.3,412.2 585.6,406.7 598.3,400.7 610.4,394.1 622,387.2" style={{ fill: "var(--heat-2)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <text x="604.4" y="434.8" textAnchor="middle" style={{ fill: "var(--text)", fontSize: "11px", fontWeight: "700" }}>207</text>
                          <polygon points="560.9,477.9 542.4,482.5 523.6,486.4 504.4,489.5 485,491.8 465.4,493.3 445.8,494 444.6,436 460.2,435.5 475.7,434.4 491.1,432.7 506.3,430.3 521.3,427.4 536,423.9" style={{ fill: "var(--heat-2)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <text x="497.7" y="465.1" textAnchor="middle" style={{ fill: "var(--text)", fontSize: "11px", fontWeight: "700" }}>208</text>
                          <polygon points="434.2,494 414.6,493.3 395,491.8 375.6,489.5 356.4,486.4 337.6,482.5 319.1,477.9 344,423.9 358.7,427.4 373.7,430.3 388.9,432.7 404.3,434.4 419.8,435.5 435.4,436" style={{ fill: "var(--heat-2)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <text x="382.3" y="465.1" textAnchor="middle" style={{ fill: "var(--text)", fontSize: "11px", fontWeight: "700" }}>209</text>
                          <polygon points="308.4,474.8 290.6,468.9 273.3,462.2 256.7,454.9 240.6,446.9 225.3,438.2 210.8,428.9 258,387.2 269.6,394.1 281.7,400.7 294.4,406.7 307.7,412.2 321.4,417.1 335.5,421.6" style={{ fill: "var(--heat-2)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <text x="275.6" y="434.8" textAnchor="middle" style={{ fill: "var(--text)", fontSize: "11px", fontWeight: "700" }}>210</text>
                          <polygon points="202.6,423.2 189.4,412.9 177,402.2 165.6,390.9 155.2,379.2 145.8,367 137.4,354.5 199.7,331.4 206.4,340.8 213.9,349.9 222.2,358.7 231.2,367.1 241,375.2 251.5,382.9" style={{ fill: "var(--heat-1)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <text x="193.9" y="378.8" textAnchor="middle" style={{ fill: "var(--text)", fontSize: "11px", fontWeight: "700" }}>211</text>
                          <polygon points="133,347 126.3,334 120.8,320.7 116.3,307.3 113.1,293.6 111,279.9 110.1,266 178,265 178.8,275.4 180.4,285.7 183,295.9 186.5,306.1 190.9,316 196.2,325.8" style={{ fill: "var(--heat-1)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <text x="149.7" y="305.6" textAnchor="middle" style={{ fill: "var(--text)", fontSize: "11px", fontWeight: "700" }}>212</text>
                          <polygon points="110.1,258 111,244.1 113.1,230.4 116.3,216.7 120.8,203.3 126.3,190 133,177 196.2,198.2 190.9,208 186.5,217.9 183,228.1 180.4,238.3 178.8,248.6 178,259" style={{ fill: "var(--heat-1)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <text x="149.7" y="226.4" textAnchor="middle" style={{ fill: "var(--text)", fontSize: "11px", fontWeight: "700" }}>213</text>
                          <polygon points="137.4,169.5 145.8,157 155.2,144.8 165.6,133.1 177,121.8 189.4,111.1 202.6,100.8 251.5,141.1 241,148.8 231.2,156.9 222.2,165.3 213.9,174.1 206.4,183.2 199.7,192.6" style={{ fill: "var(--heat-1)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <text x="193.9" y="153.2" textAnchor="middle" style={{ fill: "var(--text)", fontSize: "11px", fontWeight: "700" }}>214</text>
                          <polygon points="210.8,95.1 225.3,85.8 240.6,77.1 256.7,69.1 273.3,61.8 290.6,55.1 308.4,49.2 335.5,102.4 321.4,106.9 307.7,111.8 294.4,117.3 281.7,123.3 269.6,129.9 258,136.8" style={{ fill: "var(--heat-2)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <text x="275.6" y="97.2" textAnchor="middle" style={{ fill: "var(--text)", fontSize: "11px", fontWeight: "700" }}>215</text>
                          <polygon points="319.1,46.1 337.6,41.5 356.4,37.6 375.6,34.5 395,32.2 414.6,30.7 434.2,30 435.4,88 419.8,88.5 404.3,89.6 388.9,91.3 373.7,93.7 358.7,96.6 344,100.1" style={{ fill: "var(--heat-2)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <text x="382.3" y="66.9" textAnchor="middle" style={{ fill: "var(--text)", fontSize: "11px", fontWeight: "700" }}>216</text>
                        </svg>
                      </>
                    ) : null}
                    {' '}
                    {v.isMimic ? (
                      <>
                        <svg viewBox="0 0 880 520" role="img" aria-label="좌석 리플레이. 오픈 뒤 2분 14초의 좌석 상태입니다. 원형 경기장 긴 변 가운데의 아래층 구역은 90% 넘게 팔렸고 위층 양 끝 구역에는 빈 좌석이 절반 넘게 남았습니다. 후보 세션이 잡은 좌석이 여러 구역에 고르게 흩어져 있습니다." style={{ display: "block", width: "100%", height: "auto" }}>
                          <ellipse cx="440" cy="262" rx="150" ry="84" style={{ fill: "var(--fill-weak-strong)" }} />
                          <text x="440" y="267" textAnchor="middle" style={{ fill: "var(--text-muted)", fontSize: "13px", fontWeight: "700" }}>경기장</text>
                          <polygon points="444.4,96 459.4,96.5 474.3,97.5 489.2,99.2 503.8,101.4 518.2,104.2 532.4,107.6 503,165.2 493.4,163.1 483.5,161.4 473.6,160 463.4,159 453.2,158.3 443,158" style={{ fill: "var(--heat-3)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <text x="481.4" y="133.6" textAnchor="middle" style={{ fill: "var(--text)", fontSize: "11px", fontWeight: "700" }}>101</text>
                          <polygon points="540.5,109.8 554.1,114 567.3,118.7 580,124 592.2,129.7 603.9,135.9 615.1,142.6 559.5,187.2 551.9,183 543.9,179.1 535.6,175.5 526.9,172.2 517.9,169.3 508.6,166.6" style={{ fill: "var(--heat-2)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <text x="557.8" y="153.8" textAnchor="middle" style={{ fill: "var(--text)", fontSize: "11px", fontWeight: "700" }}>102</text>
                          <polygon points="621.3,146.7 631.4,154 640.8,161.7 649.5,169.8 657.5,178.2 664.7,186.9 671.1,195.8 597.7,220.5 593.4,214.9 588.5,209.5 583,204.2 577.1,199.2 570.6,194.3 563.7,189.8" style={{ fill: "var(--heat-2)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <text x="616.3" y="191" textAnchor="middle" style={{ fill: "var(--text)", fontSize: "11px", fontWeight: "700" }}>103</text>
                          <polygon points="674.5,201.2 679.6,210.5 683.8,220 687.2,229.6 689.6,239.4 691.3,249.2 692,259.1 612,260.2 611.5,254 610.4,247.8 608.7,241.7 606.4,235.7 603.5,229.7 600,223.9" style={{ fill: "var(--heat-2)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <text x="647.9" y="239.7" textAnchor="middle" style={{ fill: "var(--text)", fontSize: "11px", fontWeight: "700" }}>104</text>
                          <polygon points="692,264.9 691.3,274.8 689.6,284.6 687.2,294.4 683.8,304 679.6,313.5 674.5,322.8 600,300.1 603.5,294.3 606.4,288.3 608.7,282.3 610.4,276.2 611.5,270 612,263.8" style={{ fill: "var(--heat-2)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <text x="647.9" y="292.3" textAnchor="middle" style={{ fill: "var(--text)", fontSize: "11px", fontWeight: "700" }}>105</text>
                          <polygon points="671.1,328.2 664.7,337.1 657.5,345.8 649.5,354.2 640.8,362.3 631.4,370 621.3,377.3 563.7,334.2 570.6,329.7 577.1,324.8 583,319.8 588.5,314.5 593.4,309.1 597.7,303.5" style={{ fill: "var(--heat-2)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <text x="616.3" y="341" textAnchor="middle" style={{ fill: "var(--text)", fontSize: "11px", fontWeight: "700" }}>106</text>
                          <polygon points="615.1,381.4 603.9,388.1 592.2,394.3 580,400 567.3,405.3 554.1,410 540.5,414.2 508.6,357.4 517.9,354.7 526.9,351.8 535.6,348.5 543.9,344.9 551.9,341 559.5,336.8" style={{ fill: "var(--heat-3)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <text x="557.8" y="378.2" textAnchor="middle" style={{ fill: "var(--text)", fontSize: "11px", fontWeight: "700" }}>107</text>
                          <polygon points="532.4,416.4 518.2,419.8 503.8,422.6 489.2,424.8 474.3,426.5 459.4,427.5 444.4,428 443,366 453.2,365.7 463.4,365 473.6,364 483.5,362.6 493.4,360.9 503,358.8" style={{ fill: "var(--heat-3)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <text x="481.4" y="398.4" textAnchor="middle" style={{ fill: "var(--text)", fontSize: "11px", fontWeight: "700" }}>108</text>
                          <polygon points="435.6,428 420.6,427.5 405.7,426.5 390.8,424.8 376.2,422.6 361.8,419.8 347.6,416.4 377,358.8 386.6,360.9 396.5,362.6 406.4,364 416.6,365 426.8,365.7 437,366" style={{ fill: "var(--heat-3)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <text x="398.6" y="398.4" textAnchor="middle" style={{ fill: "var(--text)", fontSize: "11px", fontWeight: "700" }}>109</text>
                          <polygon points="339.5,414.2 325.9,410 312.7,405.3 300,400 287.8,394.3 276.1,388.1 264.9,381.4 320.5,336.8 328.1,341 336.1,344.9 344.4,348.5 353.1,351.8 362.1,354.7 371.4,357.4" style={{ fill: "var(--heat-2)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <text x="322.2" y="378.2" textAnchor="middle" style={{ fill: "var(--text)", fontSize: "11px", fontWeight: "700" }}>110</text>
                          <polygon points="258.7,377.3 248.6,370 239.2,362.3 230.5,354.2 222.5,345.8 215.3,337.1 208.9,328.2 282.3,303.5 286.6,309.1 291.5,314.5 297,319.8 302.9,324.8 309.4,329.7 316.3,334.2" style={{ fill: "var(--heat-2)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <text x="263.7" y="341" textAnchor="middle" style={{ fill: "var(--text)", fontSize: "11px", fontWeight: "700" }}>111</text>
                          <polygon points="205.5,322.8 200.4,313.5 196.2,304 192.8,294.4 190.4,284.6 188.7,274.8 188,264.9 268,263.8 268.5,270 269.6,276.2 271.3,282.3 273.6,288.3 276.5,294.3 280,300.1" style={{ fill: "var(--heat-2)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <text x="232.1" y="292.3" textAnchor="middle" style={{ fill: "var(--text)", fontSize: "11px", fontWeight: "700" }}>112</text>
                          <polygon points="188,259.1 188.7,249.2 190.4,239.4 192.8,229.6 196.2,220 200.4,210.5 205.5,201.2 280,223.9 276.5,229.7 273.6,235.7 271.3,241.7 269.6,247.8 268.5,254 268,260.2" style={{ fill: "var(--heat-2)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <text x="232.1" y="239.7" textAnchor="middle" style={{ fill: "var(--text)", fontSize: "11px", fontWeight: "700" }}>113</text>
                          <polygon points="208.9,195.8 215.3,186.9 222.5,178.2 230.5,169.8 239.2,161.7 248.6,154 258.7,146.7 316.3,189.8 309.4,194.3 302.9,199.2 297,204.2 291.5,209.5 286.6,214.9 282.3,220.5" style={{ fill: "var(--heat-2)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <text x="263.7" y="191" textAnchor="middle" style={{ fill: "var(--text)", fontSize: "11px", fontWeight: "700" }}>114</text>
                          <polygon points="264.9,142.6 276.1,135.9 287.8,129.7 300,124 312.7,118.7 325.9,114 339.5,109.8 371.4,166.6 362.1,169.3 353.1,172.2 344.4,175.5 336.1,179.1 328.1,183 320.5,187.2" style={{ fill: "var(--heat-3)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <text x="322.2" y="153.8" textAnchor="middle" style={{ fill: "var(--text)", fontSize: "11px", fontWeight: "700" }}>115</text>
                          <polygon points="347.6,107.6 361.8,104.2 376.2,101.4 390.8,99.2 405.7,97.5 420.6,96.5 435.6,96 437,158 426.8,158.3 416.6,159 406.4,160 396.5,161.4 386.6,163.1 377,165.2" style={{ fill: "var(--heat-3)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <text x="398.6" y="133.6" textAnchor="middle" style={{ fill: "var(--text)", fontSize: "11px", fontWeight: "700" }}>116</text>
                          <polygon points="445.8,30 465.4,30.7 485,32.2 504.4,34.5 523.6,37.6 542.4,41.5 560.9,46.1 536,100.1 521.3,96.6 506.3,93.7 491.1,91.3 475.7,89.6 460.2,88.5 444.6,88" style={{ fill: "var(--heat-2)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <text x="497.7" y="66.9" textAnchor="middle" style={{ fill: "var(--text)", fontSize: "11px", fontWeight: "700" }}>201</text>
                          <polygon points="571.6,49.2 589.4,55.1 606.7,61.8 623.3,69.1 639.4,77.1 654.7,85.8 669.2,95.1 622,136.8 610.4,129.9 598.3,123.3 585.6,117.3 572.3,111.8 558.6,106.9 544.5,102.4" style={{ fill: "var(--heat-2)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <text x="604.4" y="97.2" textAnchor="middle" style={{ fill: "var(--text)", fontSize: "11px", fontWeight: "700" }}>202</text>
                          <polygon points="677.4,100.8 690.6,111.1 703,121.8 714.4,133.1 724.8,144.8 734.2,157 742.6,169.5 680.3,192.6 673.6,183.2 666.1,174.1 657.8,165.3 648.8,156.9 639,148.8 628.5,141.1" style={{ fill: "var(--heat-2)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <text x="686.1" y="153.2" textAnchor="middle" style={{ fill: "var(--text)", fontSize: "11px", fontWeight: "700" }}>203</text>
                          <polygon points="747,177 753.7,190 759.2,203.3 763.7,216.7 766.9,230.4 769,244.1 769.9,258 702,259 701.2,248.6 699.6,238.3 697,228.1 693.5,217.9 689.1,208 683.8,198.2" style={{ fill: "var(--heat-1)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <text x="730.3" y="226.4" textAnchor="middle" style={{ fill: "var(--text)", fontSize: "11px", fontWeight: "700" }}>204</text>
                          <polygon points="769.9,266 769,279.9 766.9,293.6 763.7,307.3 759.2,320.7 753.7,334 747,347 683.8,325.8 689.1,316 693.5,306.1 697,295.9 699.6,285.7 701.2,275.4 702,265" style={{ fill: "var(--heat-1)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <text x="730.3" y="305.6" textAnchor="middle" style={{ fill: "var(--text)", fontSize: "11px", fontWeight: "700" }}>205</text>
                          <polygon points="742.6,354.5 734.2,367 724.8,379.2 714.4,390.9 703,402.2 690.6,412.9 677.4,423.2 628.5,382.9 639,375.2 648.8,367.1 657.8,358.7 666.1,349.9 673.6,340.8 680.3,331.4" style={{ fill: "var(--heat-1)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <text x="686.1" y="378.8" textAnchor="middle" style={{ fill: "var(--text)", fontSize: "11px", fontWeight: "700" }}>206</text>
                          <polygon points="669.2,428.9 654.7,438.2 639.4,446.9 623.3,454.9 606.7,462.2 589.4,468.9 571.6,474.8 544.5,421.6 558.6,417.1 572.3,412.2 585.6,406.7 598.3,400.7 610.4,394.1 622,387.2" style={{ fill: "var(--heat-2)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <text x="604.4" y="434.8" textAnchor="middle" style={{ fill: "var(--text)", fontSize: "11px", fontWeight: "700" }}>207</text>
                          <polygon points="560.9,477.9 542.4,482.5 523.6,486.4 504.4,489.5 485,491.8 465.4,493.3 445.8,494 444.6,436 460.2,435.5 475.7,434.4 491.1,432.7 506.3,430.3 521.3,427.4 536,423.9" style={{ fill: "var(--heat-2)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <text x="497.7" y="465.1" textAnchor="middle" style={{ fill: "var(--text)", fontSize: "11px", fontWeight: "700" }}>208</text>
                          <polygon points="434.2,494 414.6,493.3 395,491.8 375.6,489.5 356.4,486.4 337.6,482.5 319.1,477.9 344,423.9 358.7,427.4 373.7,430.3 388.9,432.7 404.3,434.4 419.8,435.5 435.4,436" style={{ fill: "var(--heat-2)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <text x="382.3" y="465.1" textAnchor="middle" style={{ fill: "var(--text)", fontSize: "11px", fontWeight: "700" }}>209</text>
                          <polygon points="308.4,474.8 290.6,468.9 273.3,462.2 256.7,454.9 240.6,446.9 225.3,438.2 210.8,428.9 258,387.2 269.6,394.1 281.7,400.7 294.4,406.7 307.7,412.2 321.4,417.1 335.5,421.6" style={{ fill: "var(--heat-2)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <text x="275.6" y="434.8" textAnchor="middle" style={{ fill: "var(--text)", fontSize: "11px", fontWeight: "700" }}>210</text>
                          <polygon points="202.6,423.2 189.4,412.9 177,402.2 165.6,390.9 155.2,379.2 145.8,367 137.4,354.5 199.7,331.4 206.4,340.8 213.9,349.9 222.2,358.7 231.2,367.1 241,375.2 251.5,382.9" style={{ fill: "var(--heat-1)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <text x="193.9" y="378.8" textAnchor="middle" style={{ fill: "var(--text)", fontSize: "11px", fontWeight: "700" }}>211</text>
                          <polygon points="133,347 126.3,334 120.8,320.7 116.3,307.3 113.1,293.6 111,279.9 110.1,266 178,265 178.8,275.4 180.4,285.7 183,295.9 186.5,306.1 190.9,316 196.2,325.8" style={{ fill: "var(--heat-1)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <text x="149.7" y="305.6" textAnchor="middle" style={{ fill: "var(--text)", fontSize: "11px", fontWeight: "700" }}>212</text>
                          <polygon points="110.1,258 111,244.1 113.1,230.4 116.3,216.7 120.8,203.3 126.3,190 133,177 196.2,198.2 190.9,208 186.5,217.9 183,228.1 180.4,238.3 178.8,248.6 178,259" style={{ fill: "var(--heat-1)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <text x="149.7" y="226.4" textAnchor="middle" style={{ fill: "var(--text)", fontSize: "11px", fontWeight: "700" }}>213</text>
                          <polygon points="137.4,169.5 145.8,157 155.2,144.8 165.6,133.1 177,121.8 189.4,111.1 202.6,100.8 251.5,141.1 241,148.8 231.2,156.9 222.2,165.3 213.9,174.1 206.4,183.2 199.7,192.6" style={{ fill: "var(--heat-1)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <text x="193.9" y="153.2" textAnchor="middle" style={{ fill: "var(--text)", fontSize: "11px", fontWeight: "700" }}>214</text>
                          <polygon points="210.8,95.1 225.3,85.8 240.6,77.1 256.7,69.1 273.3,61.8 290.6,55.1 308.4,49.2 335.5,102.4 321.4,106.9 307.7,111.8 294.4,117.3 281.7,123.3 269.6,129.9 258,136.8" style={{ fill: "var(--heat-2)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <text x="275.6" y="97.2" textAnchor="middle" style={{ fill: "var(--text)", fontSize: "11px", fontWeight: "700" }}>215</text>
                          <polygon points="319.1,46.1 337.6,41.5 356.4,37.6 375.6,34.5 395,32.2 414.6,30.7 434.2,30 435.4,88 419.8,88.5 404.3,89.6 388.9,91.3 373.7,93.7 358.7,96.6 344,100.1" style={{ fill: "var(--heat-2)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <text x="382.3" y="66.9" textAnchor="middle" style={{ fill: "var(--text)", fontSize: "11px", fontWeight: "700" }}>216</text>
                          <circle cx="635.7" cy="125.6" r="3.4" style={{ fill: "none", stroke: "var(--danger)", strokeWidth: "1.8" }} />
                          <circle cx="661.6" cy="122.6" r="3.4" style={{ fill: "none", stroke: "var(--danger)", strokeWidth: "1.8" }} />
                          <circle cx="475.1" cy="131.8" r="3.4" style={{ fill: "none", stroke: "var(--danger)", strokeWidth: "1.8" }} />
                          <circle cx="656.8" cy="209" r="3.4" style={{ fill: "none", stroke: "var(--danger)", strokeWidth: "1.8" }} />
                          <circle cx="299.8" cy="160" r="3.4" style={{ fill: "none", stroke: "var(--danger)", strokeWidth: "1.8" }} />
                          <circle cx="166.2" cy="362.8" r="3.4" style={{ fill: "none", stroke: "var(--danger)", strokeWidth: "1.8" }} />
                          <circle cx="308.1" cy="159.1" r="3.4" style={{ fill: "none", stroke: "var(--danger)", strokeWidth: "1.8" }} />
                          <circle cx="254.2" cy="118" r="3.4" style={{ fill: "none", stroke: "var(--danger)", strokeWidth: "1.8" }} />
                          <circle cx="618.6" cy="337" r="3.4" style={{ fill: "none", stroke: "var(--danger)", strokeWidth: "1.8" }} />
                          <circle cx="158.5" cy="296" r="3.4" style={{ fill: "none", stroke: "var(--danger)", strokeWidth: "1.8" }} />
                          <circle cx="251.5" cy="108.2" r="3.4" style={{ fill: "none", stroke: "var(--danger)", strokeWidth: "1.8" }} />
                          <circle cx="583.4" cy="439.9" r="3.4" style={{ fill: "none", stroke: "var(--danger)", strokeWidth: "1.8" }} />
                          <circle cx="612.6" cy="99.9" r="3.4" style={{ fill: "none", stroke: "var(--danger)", strokeWidth: "1.8" }} />
                          <circle cx="559.3" cy="366.6" r="3.4" style={{ fill: "none", stroke: "var(--danger)", strokeWidth: "1.8" }} />
                          <circle cx="469.6" cy="480.3" r="3.4" style={{ fill: "none", stroke: "var(--danger)", strokeWidth: "1.8" }} />
                          <circle cx="155.4" cy="183.6" r="3.4" style={{ fill: "none", stroke: "var(--danger)", strokeWidth: "1.8" }} />
                          <circle cx="456.4" cy="474.5" r="3.4" style={{ fill: "none", stroke: "var(--danger)", strokeWidth: "1.8" }} />
                          <circle cx="659.6" cy="295.6" r="3.4" style={{ fill: "none", stroke: "var(--danger)", strokeWidth: "1.8" }} />
                          <circle cx="338.9" cy="149.6" r="3.4" style={{ fill: "none", stroke: "var(--danger)", strokeWidth: "1.8" }} />
                          <circle cx="277.6" cy="154.4" r="3.4" style={{ fill: "none", stroke: "var(--danger)", strokeWidth: "1.8" }} />
                          <circle cx="502.6" cy="371.8" r="3.4" style={{ fill: "none", stroke: "var(--danger)", strokeWidth: "1.8" }} />
                          <circle cx="697" cy="370" r="3.4" style={{ fill: "none", stroke: "var(--danger)", strokeWidth: "1.8" }} />
                          <circle cx="309.7" cy="153.8" r="3.4" style={{ fill: "none", stroke: "var(--danger)", strokeWidth: "1.8" }} />
                          <circle cx="358.3" cy="471" r="3.4" style={{ fill: "none", stroke: "var(--danger)", strokeWidth: "1.8" }} />
                          <circle cx="546.9" cy="154.6" r="3.4" style={{ fill: "none", stroke: "var(--danger)", strokeWidth: "1.8" }} />
                          <circle cx="341.8" cy="148.7" r="3.4" style={{ fill: "none", stroke: "var(--danger)", strokeWidth: "1.8" }} />
                          <circle cx="283.4" cy="150.9" r="3.4" style={{ fill: "none", stroke: "var(--danger)", strokeWidth: "1.8" }} />
                          <circle cx="730.8" cy="311.1" r="3.4" style={{ fill: "none", stroke: "var(--danger)", strokeWidth: "1.8" }} />
                          <circle cx="478.3" cy="114.2" r="3.4" style={{ fill: "none", stroke: "var(--danger)", strokeWidth: "1.8" }} />
                          <circle cx="662.3" cy="137.1" r="3.4" style={{ fill: "none", stroke: "var(--danger)", strokeWidth: "1.8" }} />
                          <circle cx="147.5" cy="310.5" r="3.4" style={{ fill: "none", stroke: "var(--danger)", strokeWidth: "1.8" }} />
                          <circle cx="265.1" cy="303.5" r="3.4" style={{ fill: "none", stroke: "var(--danger)", strokeWidth: "1.8" }} />
                          <circle cx="299.5" cy="77" r="3.4" style={{ fill: "none", stroke: "var(--danger)", strokeWidth: "1.8" }} />
                          <circle cx="601" cy="353.1" r="3.4" style={{ fill: "none", stroke: "var(--danger)", strokeWidth: "1.8" }} />
                          <circle cx="162.6" cy="203.6" r="3.4" style={{ fill: "none", stroke: "var(--danger)", strokeWidth: "1.8" }} />
                          <circle cx="298.5" cy="180.8" r="3.4" style={{ fill: "none", stroke: "var(--danger)", strokeWidth: "1.8" }} />
                          <circle cx="216.5" cy="300.3" r="3.4" style={{ fill: "none", stroke: "var(--danger)", strokeWidth: "1.8" }} />
                          <circle cx="578.7" cy="363.8" r="3.4" style={{ fill: "none", stroke: "var(--danger)", strokeWidth: "1.8" }} />
                          <circle cx="422.6" cy="119.8" r="3.4" style={{ fill: "none", stroke: "var(--danger)", strokeWidth: "1.8" }} />
                          <circle cx="569.8" cy="449.7" r="3.4" style={{ fill: "none", stroke: "var(--danger)", strokeWidth: "1.8" }} />
                          <circle cx="537.7" cy="368.9" r="3.4" style={{ fill: "none", stroke: "var(--danger)", strokeWidth: "1.8" }} />
                          <circle cx="136.8" cy="300.5" r="3.4" style={{ fill: "none", stroke: "var(--danger)", strokeWidth: "1.8" }} />
                          <circle cx="630.3" cy="306.4" r="3.4" style={{ fill: "none", stroke: "var(--danger)", strokeWidth: "1.8" }} />
                          <circle cx="137.7" cy="196.5" r="3.4" style={{ fill: "none", stroke: "var(--danger)", strokeWidth: "1.8" }} />
                          <circle cx="642.3" cy="332" r="3.4" style={{ fill: "none", stroke: "var(--danger)", strokeWidth: "1.8" }} />
                          <circle cx="378.3" cy="127.4" r="3.4" style={{ fill: "none", stroke: "var(--danger)", strokeWidth: "1.8" }} />
                        </svg>
                      </>
                    ) : null}
                  </>
                ) : null}
                {' '}
                {v.isReject ? (
                  <>
                    <div className="card-flat col" style={{ minHeight: "360px", alignItems: "center", justifyContent: "center", gap: "8px", textAlign: "center" }}>
                      <i className="ic ic-map ic-32 muted" aria-hidden="true" />
                      <p className="t-md fw-b">그릴 사건이 없습니다</p>
                      <p className="t-sm muted">{v.spec.rejectHint}</p>
                    </div>
                  </>
                ) : null}
                <div className="row between wrap" style={{ gap: "8px" }}>
                  <ul className="legend" aria-label="범례: 구역 색은 그 시각까지 판매된 비율">
                    <li className="legend-item">
                      <span aria-hidden="true" style={{ display: "inline-block", width: "16px", height: "12px", borderRadius: "3px", background: "var(--heat-1)" }} />
                      판매 50% 미만
                    </li>
                    <li className="legend-item">
                      <span aria-hidden="true" style={{ display: "inline-block", width: "16px", height: "12px", borderRadius: "3px", background: "var(--heat-2)" }} />
                      50% 이상 90% 미만
                    </li>
                    <li className="legend-item">
                      <span aria-hidden="true" style={{ display: "inline-block", width: "16px", height: "12px", borderRadius: "3px", background: "var(--heat-3)" }} />
                      90% 이상
                    </li>
                    {v.isInv ? <SeatMarkLegend /> : null}
                    {v.anyCand ? (
                      <>
                        <li className="legend-item">
                          <span aria-hidden="true" style={{ display: "inline-block", width: "12px", height: "12px", borderRadius: "50%", border: "2px solid var(--danger)" }} />
                          {v.isInv ? '고른 칸의 묶음 계정이 잡은 좌석' : '후보 세션이 잡은 좌석'}
                        </li>
                      </>
                    ) : null}
                  </ul>
                  <button className="btn btn-text btn-sm" type="button">표로 보기</button>
                </div>
              </div>
            </section>
            {v.showStats ? (
              <>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(4,minmax(0,1fr))", gap: "10px" }}>
                  <div className="stat">
                    <span className="stat-label">홀드 시도</span>
                    {v.statBase ? (
                      <>
                        <span className="stat-value">41,882</span>
                        <span className="stat-meta">전체 범위</span>
                      </>
                    ) : null}
                    {v.statCand ? (
                      <>
                        <span className="stat-value">42,118</span>
                        <span className="stat-meta">고른 세션 9,412</span>
                      </>
                    ) : null}
                    {v.isSport ? (
                      <>
                        <span className="stat-value">24,560</span>
                        <span className="stat-meta">전체 범위</span>
                      </>
                    ) : null}
                    {v.isMimic ? (
                      <>
                        <span className="stat-value">9,870</span>
                        <span className="stat-meta">고른 세션 8,020</span>
                      </>
                    ) : null}
                  </div>
                  <div className="stat">
                    <span className="stat-label">경합 패배율</span>
                    {v.statBase ? (
                      <>
                        <span className="stat-value">37.2%</span>
                        <span className="stat-meta">전체 범위</span>
                      </>
                    ) : null}
                    {v.statCand ? (
                      <>
                        <span className="stat-value">61.5%</span>
                        <span className="stat-meta">고른 세션 9,412</span>
                      </>
                    ) : null}
                    {v.isSport ? (
                      <>
                        <span className="stat-value">31.8%</span>
                        <span className="stat-meta">전체 범위</span>
                      </>
                    ) : null}
                    {v.isMimic ? (
                      <>
                        <span className="stat-value">38.9%</span>
                        <span className="stat-meta">고른 세션 8,020</span>
                      </>
                    ) : null}
                  </div>
                  <div className="stat">
                    <span className="stat-label">홀드 → 판매</span>
                    {v.statBase ? (
                      <>
                        <span className="stat-value">61.4%</span>
                        <span className="stat-meta">전체 범위</span>
                      </>
                    ) : null}
                    {v.statCand ? (
                      <>
                        <span className="stat-value">22.0%</span>
                        <span className="stat-meta">고른 세션 9,412</span>
                      </>
                    ) : null}
                    {v.isSport ? (
                      <>
                        <span className="stat-value">64.2%</span>
                        <span className="stat-meta">전체 범위</span>
                      </>
                    ) : null}
                    {v.isMimic ? (
                      <>
                        <span className="stat-value">58.7%</span>
                        <span className="stat-meta">고른 세션 8,020</span>
                      </>
                    ) : null}
                  </div>
                  {v.isInv ? (
                    <GroupCountStat />
                  ) : (
                  <div className="stat">
                    <span className="stat-label">후보 비율</span>
                    {v.statBase ? (
                      <>
                        <span className="stat-value">28.9%</span>
                        <span className="stat-meta">전체 범위</span>
                      </>
                    ) : null}
                    {v.statCand ? (
                      <>
                        <span className="stat-value">96.3%</span>
                        <span className="stat-meta">고른 세션 9,412</span>
                      </>
                    ) : null}
                    {v.isSport ? (
                      <>
                        <span className="stat-value">9.7%</span>
                        <span className="stat-meta">전체 범위</span>
                      </>
                    ) : null}
                    {v.isMimic ? (
                      <>
                        <span className="stat-value">30.6%</span>
                        <span className="stat-meta">고른 세션 8,020</span>
                      </>
                    ) : null}
                  </div>
                  )}
                </div>
              </>
            ) : null}
          </div>
          <div className="col" style={{ gap: "16px", minWidth: "0" }}>
            <section className="widget" aria-labelledby="fx-flt-h">
              <div className="widget-head">
                <h2 className="t-sm fw-b" id="fx-flt-h">교차 필터</h2>
                <div className="actions">
                  {v.anyCand ? (
                    <>
                      <button className="btn btn-ghost btn-sm" type="button">고르기 지우기</button>
                    </>
                  ) : null}
                </div>
              </div>
              <div className="widget-body">
                {v.isCand ? (
                  <>
                    <p className="t-xs">
                      <span className="fw-b">고른 범위</span>
                      {' '}· 시간 T+02:00~T+02:30 · {v.spec.pickedArea}
                    </p>
                  </>
                ) : null}
                {' '}
                {v.isMimic ? (
                  <>
                    <p className="t-xs">
                      <span className="fw-b">고른 범위</span>
                      {' '}· 시간 T+02:00~T+02:30 · 산점도 영역(1~3초, 엔트로피 0.55~0.8)
                    </p>
                  </>
                ) : null}
                <div className="col" style={{ gap: "6px" }}>
                  <span className="label">구역</span>
                  <div className="row wrap" style={{ gap: "6px" }}>
                    <button className="chip chip-sm" type="button" aria-pressed="true">전체</button>
                    {v.scConc ? (
                      <>
                        <button className="chip chip-sm" type="button" aria-pressed="false">플로어 F1~F8</button>
                        <button className="chip chip-sm" type="button" aria-pressed="false">아래층 A1~A11</button>
                        <button className="chip chip-sm" type="button" aria-pressed="false">위층 B1~B11</button>
                      </>
                    ) : null}
                    {v.isStad ? (
                      <>
                        <button className="chip chip-sm" type="button" aria-pressed="false">아래층 101~116</button>
                        <button className="chip chip-sm" type="button" aria-pressed="false">위층 201~216</button>
                      </>
                    ) : null}
                  </div>
                </div>
                <fieldset className="col" style={{ gap: "6px", border: "0", padding: "0", margin: "0" }}>
                  <legend className="label" style={{ marginBottom: "6px" }}>홀드 결과</legend>
                  <div className="row wrap" style={{ gap: "4px 14px" }}>
                    <label className="check-row" htmlFor="fx-r1">
                      <input className="cb" id="fx-r1" type="checkbox" defaultChecked />
                      HELD
                    </label>
                    {' '}
                    <label className="check-row" htmlFor="fx-r2">
                      <input className="cb" id="fx-r2" type="checkbox" defaultChecked />
                      CONFLICT
                    </label>
                    {' '}
                    <label className="check-row" htmlFor="fx-r3">
                      <input className="cb" id="fx-r3" type="checkbox" defaultChecked />
                      LIMIT
                    </label>
                    {' '}
                    <label className="check-row" htmlFor="fx-r4">
                      <input className="cb" id="fx-r4" type="checkbox" defaultChecked />
                      ERROR
                    </label>
                  </div>
                </fieldset>
                {v.isSyn ? (
                  <>
                <div className="col" style={{ gap: "6px" }}>
                  <span className="label">봇 등급(합성 정답)</span>
                  <div className="seg" role="group" aria-label="봇 등급">
                    <button className="seg-item" type="button" aria-pressed="true">전체</button>
                    <button className="seg-item" type="button" aria-pressed="false">사람</button>
                    <button className="seg-item" type="button" aria-pressed="false">1단계</button>
                    <button className="seg-item" type="button" aria-pressed="false">2단계</button>
                    <button className="seg-item" type="button" aria-pressed="false">3단계</button>
                  </div>
                </div>
                <div className="col" style={{ gap: "6px" }}>
                  <span className="label">네트워크 유형</span>
                  <div className="row wrap" style={{ gap: "6px" }}>
                    <button className="chip chip-sm" type="button" aria-pressed="true">전체</button>
                    <button className="chip chip-sm" type="button" aria-pressed="false">호스팅</button>
                    <button className="chip chip-sm" type="button" aria-pressed="false">프록시</button>
                    <button className="chip chip-sm" type="button" aria-pressed="false">그 밖</button>
                  </div>
                </div>
                  </>
                ) : null}
                {v.isInv ? <GroupFilter /> : null}
              </div>
            </section>
            {v.isSyn ? (
            <section className="widget" aria-labelledby="fx-bot-h">
              <div className="widget-head">
                <h2 className="t-sm fw-b" id="fx-bot-h">봇 후보</h2>
                <div className="actions"><button className="btn btn-text btn-sm" type="button">표로 보기</button></div>
              </div>
              <div className="widget-body">
                <p className="t-xs muted">가로: 입장 확정 → 첫 홀드 시도 · 세로: 포인터 이동 엔트로피. 끌어서 영역을 고르면 그 세션들이 잡은 좌석이 좌석맵에 표시됩니다</p>
                {v.fullScatter ? (
                  <>
                    {v.scatConc ? (
                      <>
                        <svg className="chart" viewBox="0 0 440 260" role="img" aria-label="봇 후보 산점도. 가로는 입장 확정에서 첫 홀드 시도까지 걸린 시간(로그 눈금), 세로는 포인터 이동 엔트로피입니다. 대부분의 세션은 1초 안팎·엔트로피 0.6 근처에 모이고, 왼쪽 아래 100ms 안·엔트로피 0.2 아래에 따로 모인 무리가 있습니다." style={{ height: "auto" }}>
                          <line className="grid" x1="44" y1="12" x2="44" y2="230" />
                          <text className="axis" x="44" y="248" textAnchor="middle">10ms</text>
                          <line className="grid" x1="172.7" y1="12" x2="172.7" y2="230" />
                          <text className="axis" x="172.7" y="248" textAnchor="middle">100ms</text>
                          <line className="grid" x1="301.3" y1="12" x2="301.3" y2="230" />
                          <text className="axis" x="301.3" y="248" textAnchor="middle">1초</text>
                          <line className="grid" x1="430" y1="12" x2="430" y2="230" />
                          <text className="axis" x="430" y="248" textAnchor="middle">10초</text>
                          <line className="grid" x1="44" y1="230" x2="430" y2="230" />
                          <text className="axis" x="38" y="234" textAnchor="end">0</text>
                          <line className="grid" x1="44" y1="121" x2="430" y2="121" />
                          <text className="axis" x="38" y="125" textAnchor="end">0.5</text>
                          <line className="grid" x1="44" y1="12" x2="430" y2="12" />
                          <text className="axis" x="38" y="16" textAnchor="end">1</text>
                          <circle cx="324.3" cy="79.2" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="325.4" cy="104.5" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="300" cy="101.3" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="373.6" cy="81.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="370.9" cy="87.2" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="347.7" cy="89.2" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="273.5" cy="68.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="351.7" cy="79.6" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="272.6" cy="148.1" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="301.5" cy="109.1" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="344.5" cy="96.2" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="352.3" cy="114.4" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="344.6" cy="82.8" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="309.7" cy="42.4" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="353.6" cy="58.3" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="311.2" cy="117.4" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="321.1" cy="98.1" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="356.3" cy="87.3" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="317.4" cy="124" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="314.7" cy="57.6" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="304.4" cy="87.4" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="348.9" cy="140.3" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="335.2" cy="55" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="260.9" cy="104.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="329.7" cy="119.8" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="351.4" cy="96.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="280.7" cy="69.6" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="357.6" cy="66" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="385.4" cy="83.8" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="337.8" cy="134.5" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="355.7" cy="113.5" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="317.2" cy="133.4" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="298.6" cy="111" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="379.9" cy="156.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="281" cy="87.5" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="385.5" cy="77.2" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="265.1" cy="171.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="346.4" cy="117.3" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="293.2" cy="65" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="373.2" cy="90" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="342.4" cy="81.6" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="390.9" cy="75.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="352.2" cy="78.1" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="277" cy="55.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="367.9" cy="78.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="262.4" cy="114.2" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="363.8" cy="150.1" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="326.9" cy="63.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="286.3" cy="45.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="353.4" cy="99.4" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="345.2" cy="75" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="337.8" cy="59.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="309.7" cy="107.5" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="371" cy="94" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="301.8" cy="66" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="386.3" cy="108.4" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="283.8" cy="99" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="328.1" cy="103.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="384.1" cy="126.2" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="378.9" cy="133.5" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="305.1" cy="75.6" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="374.2" cy="68.6" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="345.9" cy="90.5" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="339" cy="77.3" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="327.2" cy="86.4" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="354.1" cy="94.8" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="361" cy="77.6" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="405.9" cy="84.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="318.1" cy="106.2" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="333" cy="66.6" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="321.4" cy="83.1" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="399.7" cy="173.1" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="293" cy="87.4" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="347.9" cy="87.6" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="318" cy="74.8" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="343.7" cy="110.8" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="421" cy="84" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="313.5" cy="97.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="325.4" cy="96.8" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="235.2" cy="109.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="369.8" cy="130.5" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="331.1" cy="65.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="364.3" cy="49.3" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="272.2" cy="105.6" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="321.2" cy="75.8" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="372.8" cy="176.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="372.7" cy="139" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="358.1" cy="140.4" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="339.8" cy="58.4" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="328.1" cy="89" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="362.2" cy="90.5" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="330.3" cy="48" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="371.3" cy="103.8" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="432.4" cy="129.8" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="366.5" cy="102.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="338.3" cy="73.3" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="341.5" cy="75.3" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="278.5" cy="140.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="355.7" cy="124.2" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="296.5" cy="139.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="379.1" cy="72.1" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="386.6" cy="123.5" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="333.5" cy="129.6" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="361.1" cy="46.3" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="301.4" cy="47.2" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="369.1" cy="100.3" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="262.5" cy="51.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="330" cy="113.2" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="347.9" cy="82.3" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="387.5" cy="126" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="374.4" cy="49.4" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="385.8" cy="100.4" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="306.7" cy="63.8" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="337.6" cy="91" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="384.8" cy="102.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="250.8" cy="106.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="266.7" cy="69.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="344.9" cy="113.5" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="333.2" cy="69.4" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="336.3" cy="54.4" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="331.3" cy="63.1" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="387.2" cy="45.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="309.3" cy="68" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="265.9" cy="127.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="262.8" cy="62.2" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="289.1" cy="95.2" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="326.6" cy="95.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="312.2" cy="87.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="398" cy="93.5" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="352.6" cy="64.3" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="326.4" cy="133.3" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="313.5" cy="62.1" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="274.2" cy="113.1" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="369.8" cy="70.6" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="333.8" cy="70.3" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="339.5" cy="130.8" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="277.2" cy="114.3" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="366.7" cy="112.1" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="301" cy="118.4" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="278.3" cy="98.4" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="136.8" cy="210.4" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="138.8" cy="197" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="155.9" cy="199.2" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="174.6" cy="219.3" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="145.1" cy="197" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="166.7" cy="223.3" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="111.3" cy="213.4" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="107.5" cy="220" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="107.5" cy="205.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="162.4" cy="198.5" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="113.8" cy="204.4" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="152.9" cy="223.1" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="170.1" cy="196.2" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="118.9" cy="196.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="132.6" cy="211.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="178.3" cy="200.6" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="114.4" cy="213.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="141.7" cy="216.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="117" cy="217.4" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="157.7" cy="227.2" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="144.7" cy="213.4" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="103.3" cy="217" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="150.1" cy="211.1" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="106.9" cy="195.6" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="162.8" cy="196" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="110" cy="219.1" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="105" cy="202.3" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="122.8" cy="223.6" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="134.5" cy="198" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="165.1" cy="219.4" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="113.4" cy="197.8" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="145.9" cy="204.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="108.8" cy="225.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="155" cy="213.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="107.5" cy="197.1" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="150.9" cy="201.6" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="108.4" cy="199.8" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="107" cy="199.6" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="136.9" cy="216.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="144.6" cy="197.5" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="122.6" cy="223.6" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="142.6" cy="220" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="110.3" cy="222.5" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="105.8" cy="221.2" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="126" cy="217.8" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="160.5" cy="218.3" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="140.5" cy="222" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="128.7" cy="227.2" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="121.2" cy="227.3" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="158.5" cy="209.8" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="116.5" cy="212.3" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="174.1" cy="224.3" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="165.1" cy="213.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="140.1" cy="200.5" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="132.2" cy="211.3" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="155" cy="195.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="128.4" cy="200.6" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="156.5" cy="207" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="133.1" cy="216.5" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="106.1" cy="223.6" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        </svg>
                      </>
                    ) : null}
                    {' '}
                    {v.isCand ? (
                      <>
                        <svg className="chart" viewBox="0 0 440 260" role="img" aria-label="봇 후보 산점도. 가로는 입장 확정에서 첫 홀드 시도까지 걸린 시간(로그 눈금), 세로는 포인터 이동 엔트로피입니다. 대부분의 세션은 1초 안팎·엔트로피 0.6 근처에 모이고, 왼쪽 아래 100ms 안·엔트로피 0.2 아래에 따로 모인 무리가 있습니다. 왼쪽 아래 영역을 골랐습니다." style={{ height: "auto" }}>
                          <line className="grid" x1="44" y1="12" x2="44" y2="230" />
                          <text className="axis" x="44" y="248" textAnchor="middle">10ms</text>
                          <line className="grid" x1="172.7" y1="12" x2="172.7" y2="230" />
                          <text className="axis" x="172.7" y="248" textAnchor="middle">100ms</text>
                          <line className="grid" x1="301.3" y1="12" x2="301.3" y2="230" />
                          <text className="axis" x="301.3" y="248" textAnchor="middle">1초</text>
                          <line className="grid" x1="430" y1="12" x2="430" y2="230" />
                          <text className="axis" x="430" y="248" textAnchor="middle">10초</text>
                          <line className="grid" x1="44" y1="230" x2="430" y2="230" />
                          <text className="axis" x="38" y="234" textAnchor="end">0</text>
                          <line className="grid" x1="44" y1="121" x2="430" y2="121" />
                          <text className="axis" x="38" y="125" textAnchor="end">0.5</text>
                          <line className="grid" x1="44" y1="12" x2="430" y2="12" />
                          <text className="axis" x="38" y="16" textAnchor="end">1</text>
                          <rect x="76.8" y="177.7" width="114.6" height="52.3" rx="3" style={{ fill: "var(--danger-subtle)", stroke: "var(--danger)", strokeWidth: "1.5", strokeDasharray: "5 3" }} />
                          <circle cx="324.3" cy="79.2" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="325.4" cy="104.5" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="300" cy="101.3" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="373.6" cy="81.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="370.9" cy="87.2" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="347.7" cy="89.2" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="273.5" cy="68.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="351.7" cy="79.6" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="272.6" cy="148.1" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="301.5" cy="109.1" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="344.5" cy="96.2" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="352.3" cy="114.4" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="344.6" cy="82.8" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="309.7" cy="42.4" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="353.6" cy="58.3" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="311.2" cy="117.4" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="321.1" cy="98.1" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="356.3" cy="87.3" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="317.4" cy="124" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="314.7" cy="57.6" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="304.4" cy="87.4" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="348.9" cy="140.3" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="335.2" cy="55" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="260.9" cy="104.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="329.7" cy="119.8" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="351.4" cy="96.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="280.7" cy="69.6" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="357.6" cy="66" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="385.4" cy="83.8" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="337.8" cy="134.5" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="355.7" cy="113.5" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="317.2" cy="133.4" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="298.6" cy="111" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="379.9" cy="156.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="281" cy="87.5" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="385.5" cy="77.2" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="265.1" cy="171.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="346.4" cy="117.3" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="293.2" cy="65" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="373.2" cy="90" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="342.4" cy="81.6" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="390.9" cy="75.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="352.2" cy="78.1" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="277" cy="55.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="367.9" cy="78.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="262.4" cy="114.2" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="363.8" cy="150.1" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="326.9" cy="63.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="286.3" cy="45.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="353.4" cy="99.4" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="345.2" cy="75" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="337.8" cy="59.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="309.7" cy="107.5" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="371" cy="94" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="301.8" cy="66" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="386.3" cy="108.4" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="283.8" cy="99" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="328.1" cy="103.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="384.1" cy="126.2" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="378.9" cy="133.5" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="305.1" cy="75.6" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="374.2" cy="68.6" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="345.9" cy="90.5" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="339" cy="77.3" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="327.2" cy="86.4" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="354.1" cy="94.8" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="361" cy="77.6" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="405.9" cy="84.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="318.1" cy="106.2" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="333" cy="66.6" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="321.4" cy="83.1" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="399.7" cy="173.1" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="293" cy="87.4" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="347.9" cy="87.6" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="318" cy="74.8" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="343.7" cy="110.8" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="421" cy="84" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="313.5" cy="97.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="325.4" cy="96.8" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="235.2" cy="109.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="369.8" cy="130.5" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="331.1" cy="65.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="364.3" cy="49.3" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="272.2" cy="105.6" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="321.2" cy="75.8" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="372.8" cy="176.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="372.7" cy="139" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="358.1" cy="140.4" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="339.8" cy="58.4" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="328.1" cy="89" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="362.2" cy="90.5" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="330.3" cy="48" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="371.3" cy="103.8" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="432.4" cy="129.8" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="366.5" cy="102.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="338.3" cy="73.3" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="341.5" cy="75.3" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="278.5" cy="140.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="355.7" cy="124.2" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="296.5" cy="139.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="379.1" cy="72.1" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="386.6" cy="123.5" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="333.5" cy="129.6" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="361.1" cy="46.3" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="301.4" cy="47.2" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="369.1" cy="100.3" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="262.5" cy="51.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="330" cy="113.2" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="347.9" cy="82.3" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="387.5" cy="126" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="374.4" cy="49.4" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="385.8" cy="100.4" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="306.7" cy="63.8" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="337.6" cy="91" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="384.8" cy="102.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="250.8" cy="106.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="266.7" cy="69.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="344.9" cy="113.5" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="333.2" cy="69.4" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="336.3" cy="54.4" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="331.3" cy="63.1" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="387.2" cy="45.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="309.3" cy="68" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="265.9" cy="127.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="262.8" cy="62.2" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="289.1" cy="95.2" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="326.6" cy="95.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="312.2" cy="87.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="398" cy="93.5" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="352.6" cy="64.3" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="326.4" cy="133.3" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="313.5" cy="62.1" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="274.2" cy="113.1" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="369.8" cy="70.6" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="333.8" cy="70.3" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="339.5" cy="130.8" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="277.2" cy="114.3" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="366.7" cy="112.1" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="301" cy="118.4" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="278.3" cy="98.4" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="136.8" cy="210.4" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <circle cx="138.8" cy="197" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <circle cx="155.9" cy="199.2" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <circle cx="174.6" cy="219.3" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <circle cx="145.1" cy="197" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <circle cx="166.7" cy="223.3" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <circle cx="111.3" cy="213.4" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <circle cx="107.5" cy="220" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <circle cx="107.5" cy="205.9" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <circle cx="162.4" cy="198.5" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <circle cx="113.8" cy="204.4" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <circle cx="152.9" cy="223.1" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <circle cx="170.1" cy="196.2" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <circle cx="118.9" cy="196.7" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <circle cx="132.6" cy="211.9" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <circle cx="178.3" cy="200.6" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <circle cx="114.4" cy="213.7" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <circle cx="141.7" cy="216.7" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <circle cx="117" cy="217.4" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <circle cx="157.7" cy="227.2" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <circle cx="144.7" cy="213.4" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <circle cx="103.3" cy="217" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <circle cx="150.1" cy="211.1" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <circle cx="106.9" cy="195.6" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <circle cx="162.8" cy="196" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <circle cx="110" cy="219.1" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <circle cx="105" cy="202.3" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <circle cx="122.8" cy="223.6" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <circle cx="134.5" cy="198" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <circle cx="165.1" cy="219.4" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <circle cx="113.4" cy="197.8" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <circle cx="145.9" cy="204.9" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <circle cx="108.8" cy="225.9" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <circle cx="155" cy="213.9" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <circle cx="107.5" cy="197.1" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <circle cx="150.9" cy="201.6" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <circle cx="108.4" cy="199.8" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <circle cx="107" cy="199.6" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <circle cx="136.9" cy="216.7" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <circle cx="144.6" cy="197.5" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <circle cx="122.6" cy="223.6" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <circle cx="142.6" cy="220" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <circle cx="110.3" cy="222.5" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <circle cx="105.8" cy="221.2" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <circle cx="126" cy="217.8" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <circle cx="160.5" cy="218.3" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <circle cx="140.5" cy="222" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <circle cx="128.7" cy="227.2" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <circle cx="121.2" cy="227.3" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <circle cx="158.5" cy="209.8" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <circle cx="116.5" cy="212.3" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <circle cx="174.1" cy="224.3" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <circle cx="165.1" cy="213.7" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <circle cx="140.1" cy="200.5" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <circle cx="132.2" cy="211.3" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <circle cx="155" cy="195.7" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <circle cx="128.4" cy="200.6" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <circle cx="156.5" cy="207" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <circle cx="133.1" cy="216.5" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <circle cx="106.1" cy="223.6" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                        </svg>
                      </>
                    ) : null}
                    {' '}
                    {v.isSport ? (
                      <>
                        <svg className="chart" viewBox="0 0 440 260" role="img" aria-label="봇 후보 산점도. 가로는 입장 확정에서 첫 홀드 시도까지 걸린 시간(로그 눈금), 세로는 포인터 이동 엔트로피입니다. 대부분의 세션은 1초 안팎·엔트로피 0.6 근처에 모이고, 왼쪽 아래 100ms 안·엔트로피 0.2 아래에 작은 무리가 있습니다." style={{ height: "auto" }}>
                          <line className="grid" x1="44" y1="12" x2="44" y2="230" />
                          <text className="axis" x="44" y="248" textAnchor="middle">10ms</text>
                          <line className="grid" x1="172.7" y1="12" x2="172.7" y2="230" />
                          <text className="axis" x="172.7" y="248" textAnchor="middle">100ms</text>
                          <line className="grid" x1="301.3" y1="12" x2="301.3" y2="230" />
                          <text className="axis" x="301.3" y="248" textAnchor="middle">1초</text>
                          <line className="grid" x1="430" y1="12" x2="430" y2="230" />
                          <text className="axis" x="430" y="248" textAnchor="middle">10초</text>
                          <line className="grid" x1="44" y1="230" x2="430" y2="230" />
                          <text className="axis" x="38" y="234" textAnchor="end">0</text>
                          <line className="grid" x1="44" y1="121" x2="430" y2="121" />
                          <text className="axis" x="38" y="125" textAnchor="end">0.5</text>
                          <line className="grid" x1="44" y1="12" x2="430" y2="12" />
                          <text className="axis" x="38" y="16" textAnchor="end">1</text>
                          <circle cx="301.8" cy="103.2" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="350.2" cy="115.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="300.5" cy="96.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="249.6" cy="53.1" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="364.6" cy="74.8" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="338.8" cy="66.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="365.7" cy="95.1" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="304.2" cy="114.8" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="328.7" cy="127.8" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="351.9" cy="66.3" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="280" cy="65.3" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="311.5" cy="102.6" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="319.5" cy="117.6" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="308.2" cy="96.4" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="279.9" cy="66.3" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="273.6" cy="99.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="335.5" cy="135.4" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="311.3" cy="119.1" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="287.4" cy="130.5" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="402.4" cy="52.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="320.3" cy="82.5" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="352.8" cy="72.3" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="366.4" cy="81.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="288.2" cy="72.2" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="251" cy="80" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="316.4" cy="117.5" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="373" cy="128.3" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="390.9" cy="105" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="357.4" cy="99.3" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="316.4" cy="16.4" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="414.5" cy="85.4" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="350" cy="103.6" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="380.3" cy="39.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="403.9" cy="110.3" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="323.8" cy="145.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="331.9" cy="91.4" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="281.8" cy="140.3" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="374.6" cy="106.4" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="355.8" cy="93.8" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="308.7" cy="87.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="356.7" cy="91.4" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="314.7" cy="94.8" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="350" cy="82.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="395.1" cy="83.6" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="349.6" cy="110.2" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="284.4" cy="141.4" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="334.8" cy="67.4" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="378.4" cy="129.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="287.1" cy="132.3" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="305.4" cy="106.6" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="308.5" cy="143.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="363.4" cy="85.6" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="312.8" cy="33.6" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="320.7" cy="50.5" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="301.3" cy="83" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="257" cy="94.8" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="314" cy="120.2" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="352.9" cy="72.1" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="282.4" cy="86.8" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="365.4" cy="95.1" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="407.2" cy="119.5" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="309.6" cy="87.2" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="341.6" cy="26.4" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="357.5" cy="55.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="321" cy="109.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="383.9" cy="86.3" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="376.5" cy="82.3" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="373.1" cy="100.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="327" cy="81.5" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="323.4" cy="69.4" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="375.1" cy="62.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="287.6" cy="124" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="354.9" cy="80.4" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="337.8" cy="96.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="288" cy="53.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="336.9" cy="73.5" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="315.7" cy="112.5" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="315" cy="68.8" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="317.6" cy="52.1" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="327.6" cy="146.2" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="347.4" cy="96.3" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="329.1" cy="16.4" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="351.6" cy="144.1" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="336.8" cy="79.1" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="321.4" cy="31.1" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="333.6" cy="124" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="301.6" cy="136.6" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="329.6" cy="80.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="354.7" cy="139.2" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="354.4" cy="141.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="298.7" cy="61.5" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="281.3" cy="45.8" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="373.1" cy="61.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="288.5" cy="39.8" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="340.9" cy="112.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="359.7" cy="92.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="393.3" cy="107.4" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="326.8" cy="115" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="342.7" cy="62.6" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="284.7" cy="103.5" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="398" cy="73.2" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="335.4" cy="46.6" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="321.1" cy="71.5" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="350.8" cy="110.3" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="260" cy="96.4" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="360.5" cy="137.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="335.7" cy="52" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="303.2" cy="90.5" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="341" cy="140.2" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="363.3" cy="114.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="351.2" cy="75.8" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="330" cy="142.3" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="310.9" cy="118.8" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="321.5" cy="100.3" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="388.4" cy="65.1" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="372" cy="67.4" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="326.8" cy="77" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="349.6" cy="156.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="325.1" cy="78.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="316.4" cy="91.2" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="341.1" cy="96.5" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="312" cy="95.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="455.8" cy="93.3" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="309.5" cy="138.1" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="341.3" cy="148.1" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="292.3" cy="123.3" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="326.8" cy="81.8" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="324.8" cy="144" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="329.6" cy="138.8" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="378.3" cy="72.6" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="396" cy="63.1" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="361.7" cy="93.5" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="262.5" cy="107.8" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="323" cy="108.3" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="329.6" cy="115.4" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="316.1" cy="70.1" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="340.9" cy="114.8" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="320.6" cy="72.6" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="334.8" cy="73.6" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="316.6" cy="82.1" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="332.5" cy="79.5" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="284.9" cy="117.8" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="336.7" cy="61.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="253.5" cy="144.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="350.6" cy="98" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="394.9" cy="113.6" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="337.3" cy="74.8" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="304.1" cy="95.1" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="319.5" cy="65.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="290.1" cy="104.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="370.4" cy="87.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="347.2" cy="27.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="345.4" cy="82.1" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="316.9" cy="76.5" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="338.1" cy="102.6" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="378" cy="112.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="331.7" cy="118.4" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="308.2" cy="97" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="336.5" cy="132.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="331.8" cy="68.5" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="348.7" cy="93.5" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="215.6" cy="158.5" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="359.8" cy="110.8" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="303.6" cy="58.6" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="269.9" cy="90.6" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="344.3" cy="66.3" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="361.1" cy="103.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="318.2" cy="125.4" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="265.4" cy="93.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="379.5" cy="101.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="362" cy="96.1" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="318.6" cy="69.6" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="276.6" cy="18.8" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="373.9" cy="46" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="322.9" cy="135.8" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="263.6" cy="90.1" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="415.8" cy="83.1" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="315.6" cy="78.3" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="397.4" cy="94.8" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="400.3" cy="85.1" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="119.6" cy="195.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="149.2" cy="195.6" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="105.6" cy="216.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="179" cy="226.6" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="125.3" cy="216.1" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="138.9" cy="205.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="131.4" cy="215.8" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="127.6" cy="215.5" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="155.1" cy="198.8" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="144.4" cy="218.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="176.6" cy="218.5" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="155.8" cy="203.6" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="141.2" cy="218.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="127.1" cy="204.1" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="176.6" cy="197.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="136.6" cy="207.1" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="137.7" cy="219.4" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="166.9" cy="207.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="127.3" cy="223.2" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="155" cy="227.2" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        </svg>
                      </>
                    ) : null}
                    {' '}
                    {v.isMimic ? (
                      <>
                        <svg className="chart" viewBox="0 0 440 260" role="img" aria-label="봇 후보 산점도. 가로는 입장 확정에서 첫 홀드 시도까지 걸린 시간(로그 눈금), 세로는 포인터 이동 엔트로피입니다. 모든 세션이 1초 안팎·엔트로피 0.6 근처의 한 무리에 모이고 따로 떨어진 무리가 없습니다. 가운데 영역을 골랐습니다." style={{ height: "auto" }}>
                          <line className="grid" x1="44" y1="12" x2="44" y2="230" />
                          <text className="axis" x="44" y="248" textAnchor="middle">10ms</text>
                          <line className="grid" x1="172.7" y1="12" x2="172.7" y2="230" />
                          <text className="axis" x="172.7" y="248" textAnchor="middle">100ms</text>
                          <line className="grid" x1="301.3" y1="12" x2="301.3" y2="230" />
                          <text className="axis" x="301.3" y="248" textAnchor="middle">1초</text>
                          <line className="grid" x1="430" y1="12" x2="430" y2="230" />
                          <text className="axis" x="430" y="248" textAnchor="middle">10초</text>
                          <line className="grid" x1="44" y1="230" x2="430" y2="230" />
                          <text className="axis" x="38" y="234" textAnchor="end">0</text>
                          <line className="grid" x1="44" y1="121" x2="430" y2="121" />
                          <text className="axis" x="38" y="125" textAnchor="end">0.5</text>
                          <line className="grid" x1="44" y1="12" x2="430" y2="12" />
                          <text className="axis" x="38" y="16" textAnchor="end">1</text>
                          <rect x="301.3" y="55.6" width="61.4" height="54.5" rx="3" style={{ fill: "var(--danger-subtle)", stroke: "var(--danger)", strokeWidth: "1.5", strokeDasharray: "5 3" }} />
                          <circle cx="345.5" cy="96.2" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <circle cx="327.2" cy="129.5" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="367.9" cy="106" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="352" cy="103.6" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <circle cx="370.7" cy="95.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="347" cy="69.2" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <circle cx="327" cy="100.7" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <circle cx="329.4" cy="91.9" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <circle cx="353.5" cy="87" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <circle cx="337" cy="70.6" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <circle cx="340.1" cy="126" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="381.7" cy="145.8" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="402.7" cy="140.2" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="285.8" cy="115.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="366.7" cy="120.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="360.9" cy="66" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <circle cx="311.2" cy="98.5" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <circle cx="352.7" cy="84.1" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <circle cx="312.1" cy="147.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="312.5" cy="121.6" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="336.8" cy="94.3" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <circle cx="308.6" cy="125.8" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="312.2" cy="89.8" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <circle cx="349.7" cy="81.4" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <circle cx="367.2" cy="65" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="317.4" cy="58.5" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <circle cx="292.5" cy="78.3" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="331.3" cy="148" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="387.3" cy="32.3" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="373.8" cy="139.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="248.6" cy="73" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="343.7" cy="115.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="306.4" cy="149.6" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="334.9" cy="160.3" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="280.7" cy="103.1" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="380.7" cy="74.1" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="368.6" cy="55.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="361.9" cy="111.8" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="343.2" cy="91" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <circle cx="312.6" cy="96.7" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <circle cx="330.1" cy="136.6" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="279.8" cy="94.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="356.8" cy="67.4" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <circle cx="377" cy="83.8" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="339.1" cy="111.8" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="290" cy="185.4" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="322.5" cy="76.2" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <circle cx="332.5" cy="37.1" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="388" cy="69.2" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="329.1" cy="43.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="386.5" cy="133.4" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="349.6" cy="58.9" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <circle cx="303.6" cy="38" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="327.4" cy="77" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <circle cx="320.8" cy="87.6" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <circle cx="343.1" cy="48" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="322.8" cy="77.6" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <circle cx="359.2" cy="104.3" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <circle cx="348.9" cy="139.3" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="284.6" cy="110.1" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="273.1" cy="123.3" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="323.7" cy="117.5" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="309.6" cy="125" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="349.3" cy="101.9" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <circle cx="243.7" cy="71.2" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="386.4" cy="74.6" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="373.4" cy="119.4" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="391.9" cy="76.3" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="329.9" cy="58.1" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <circle cx="346.3" cy="119" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="334.2" cy="79.6" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <circle cx="324.3" cy="83" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <circle cx="310.4" cy="148.8" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="375" cy="82" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="349.9" cy="145.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="329.3" cy="57.5" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <circle cx="315.5" cy="128.5" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="412.6" cy="95.2" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="351.7" cy="98.2" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <circle cx="381" cy="88.5" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="308.6" cy="106.2" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <circle cx="336.1" cy="41.3" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="335.2" cy="99.7" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <circle cx="374.7" cy="60.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="315.1" cy="86.6" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <circle cx="364.1" cy="103.4" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="366.3" cy="80.1" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="290.4" cy="70.3" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="334.9" cy="107.4" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <circle cx="257.1" cy="83.2" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="258.4" cy="89.4" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="386.2" cy="127.2" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="323.4" cy="106.8" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <circle cx="363.8" cy="97.6" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="318.8" cy="60.9" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <circle cx="273.2" cy="106.3" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="254.8" cy="111.8" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="345.1" cy="137.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="325.6" cy="51.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="272.8" cy="95.1" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="323.7" cy="41.3" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="328.3" cy="113.5" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="371.9" cy="108.1" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="303" cy="84.8" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <circle cx="284.4" cy="59.1" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="369.3" cy="111" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="293.8" cy="101.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="387.8" cy="50.4" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="326.2" cy="91.4" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <circle cx="336.7" cy="69.2" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <circle cx="338.5" cy="113.5" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="376.4" cy="39.8" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="305.1" cy="28.5" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="349" cy="94" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <circle cx="342.4" cy="65.4" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <circle cx="302.3" cy="101.4" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <circle cx="417.8" cy="111.4" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="237.9" cy="131.6" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="396.8" cy="158.3" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="318.8" cy="102.3" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <circle cx="323.1" cy="98.8" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <circle cx="235.8" cy="41.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="290.3" cy="66.4" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="387.4" cy="109.5" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="301.5" cy="70.2" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <circle cx="378.7" cy="57.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="314.5" cy="116.5" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="269.2" cy="70.3" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="357.7" cy="88.3" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <circle cx="289.2" cy="133.6" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="284.4" cy="105.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="380.3" cy="92.3" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="320.3" cy="98.9" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <circle cx="306.4" cy="99.1" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <circle cx="297.6" cy="50.2" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="336.4" cy="99" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <circle cx="377.4" cy="72.4" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="378.7" cy="114.8" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="301.3" cy="52.4" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="344.7" cy="100.8" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <circle cx="371.1" cy="87.4" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="323.4" cy="131" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="312.5" cy="92.3" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <circle cx="339" cy="87" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <circle cx="306" cy="89.8" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <circle cx="298.1" cy="111.5" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="307.3" cy="48" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="312.7" cy="65.8" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <circle cx="279.7" cy="82" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="392.2" cy="100.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="393.6" cy="94.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="282.6" cy="101.3" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="339.6" cy="93.8" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <circle cx="351.4" cy="93.4" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <circle cx="376.3" cy="63.3" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="336.9" cy="126" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="341.7" cy="62.8" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <circle cx="353.7" cy="79.6" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <circle cx="261.4" cy="72.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="331" cy="109.7" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <circle cx="363.3" cy="175.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="350.2" cy="106.8" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <circle cx="259" cy="133" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="332.5" cy="54.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="271.1" cy="151.5" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="352.1" cy="125.3" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="313.1" cy="106.1" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <circle cx="345.2" cy="115.4" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="323.2" cy="109.3" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <circle cx="323.5" cy="149.5" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="361.9" cy="75" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <circle cx="357.1" cy="63.4" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <circle cx="341.4" cy="24" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="339.9" cy="104.4" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <circle cx="334.4" cy="70.9" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <circle cx="363.1" cy="65.3" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="325.9" cy="129.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="311.6" cy="95.9" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <circle cx="266.6" cy="79.1" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="356.1" cy="84.5" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <circle cx="291.5" cy="99.8" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="354.1" cy="46.8" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="374.8" cy="98.3" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="418.4" cy="99.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="333.5" cy="120.5" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="253.9" cy="121.1" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="357" cy="123.1" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="334.2" cy="71.3" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <circle cx="283.4" cy="61.1" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="296.5" cy="75.5" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="346.2" cy="63.8" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <circle cx="339.7" cy="86.8" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <circle cx="345.2" cy="58" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <circle cx="299" cy="136.6" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="290.8" cy="66.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                          <circle cx="342.7" cy="98.7" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <circle cx="309" cy="101.9" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <circle cx="353.1" cy="99.2" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <circle cx="317.7" cy="69.1" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                          <circle cx="335.3" cy="140.6" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        </svg>
                      </>
                    ) : null}
                  </>
                ) : null}
                {' '}
                {v.isFallback ? (
                  <>
                    <svg className="chart" viewBox="0 0 440 260" role="img" aria-label="봇 후보 산점도. 가로는 입장 확정에서 첫 홀드 시도까지 걸린 시간(로그 눈금), 세로는 포인터 이동 엔트로피입니다. 대부분의 세션은 1초 안팎·엔트로피 0.6 근처에 모이고, 왼쪽 아래 100ms 안·엔트로피 0.2 아래에 따로 모인 무리가 있습니다." style={{ height: "auto" }}>
                      <line className="grid" x1="44" y1="12" x2="44" y2="230" />
                      <text className="axis" x="44" y="248" textAnchor="middle">10ms</text>
                      <line className="grid" x1="172.7" y1="12" x2="172.7" y2="230" />
                      <text className="axis" x="172.7" y="248" textAnchor="middle">100ms</text>
                      <line className="grid" x1="301.3" y1="12" x2="301.3" y2="230" />
                      <text className="axis" x="301.3" y="248" textAnchor="middle">1초</text>
                      <line className="grid" x1="430" y1="12" x2="430" y2="230" />
                      <text className="axis" x="430" y="248" textAnchor="middle">10초</text>
                      <line className="grid" x1="44" y1="230" x2="430" y2="230" />
                      <text className="axis" x="38" y="234" textAnchor="end">0</text>
                      <line className="grid" x1="44" y1="121" x2="430" y2="121" />
                      <text className="axis" x="38" y="125" textAnchor="end">0.5</text>
                      <line className="grid" x1="44" y1="12" x2="430" y2="12" />
                      <text className="axis" x="38" y="16" textAnchor="end">1</text>
                      <circle cx="324.3" cy="79.2" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                      <circle cx="325.4" cy="104.5" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                      <circle cx="300" cy="101.3" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                      <circle cx="373.6" cy="81.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                      <circle cx="370.9" cy="87.2" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                      <circle cx="347.7" cy="89.2" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                      <circle cx="273.5" cy="68.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                      <circle cx="351.7" cy="79.6" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                      <circle cx="272.6" cy="148.1" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                      <circle cx="301.5" cy="109.1" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                      <circle cx="344.5" cy="96.2" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                      <circle cx="352.3" cy="114.4" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                      <circle cx="344.6" cy="82.8" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                      <circle cx="309.7" cy="42.4" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                      <circle cx="353.6" cy="58.3" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                      <circle cx="311.2" cy="117.4" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                      <circle cx="321.1" cy="98.1" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                      <circle cx="356.3" cy="87.3" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                      <circle cx="317.4" cy="124" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                      <circle cx="314.7" cy="57.6" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                      <circle cx="304.4" cy="87.4" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                      <circle cx="348.9" cy="140.3" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                      <circle cx="335.2" cy="55" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                      <circle cx="260.9" cy="104.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                      <circle cx="329.7" cy="119.8" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                      <circle cx="351.4" cy="96.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                      <circle cx="280.7" cy="69.6" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                      <circle cx="357.6" cy="66" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                      <circle cx="385.4" cy="83.8" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                      <circle cx="337.8" cy="134.5" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                      <circle cx="355.7" cy="113.5" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                      <circle cx="317.2" cy="133.4" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                      <circle cx="298.6" cy="111" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                      <circle cx="379.9" cy="156.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                      <circle cx="281" cy="87.5" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                      <circle cx="385.5" cy="77.2" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                      <circle cx="265.1" cy="171.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                      <circle cx="346.4" cy="117.3" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                      <circle cx="293.2" cy="65" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                      <circle cx="373.2" cy="90" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                      <circle cx="342.4" cy="81.6" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                      <circle cx="390.9" cy="75.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                      <circle cx="352.2" cy="78.1" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                      <circle cx="277" cy="55.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                      <circle cx="367.9" cy="78.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                      <circle cx="262.4" cy="114.2" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                      <circle cx="363.8" cy="150.1" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                      <circle cx="326.9" cy="63.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                      <circle cx="286.3" cy="45.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                      <circle cx="353.4" cy="99.4" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                      <circle cx="345.2" cy="75" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                      <circle cx="337.8" cy="59.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                      <circle cx="309.7" cy="107.5" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                      <circle cx="371" cy="94" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                      <circle cx="301.8" cy="66" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                      <circle cx="386.3" cy="108.4" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                      <circle cx="283.8" cy="99" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                      <circle cx="328.1" cy="103.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                      <circle cx="384.1" cy="126.2" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                      <circle cx="378.9" cy="133.5" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                      <circle cx="305.1" cy="75.6" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                      <circle cx="374.2" cy="68.6" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                      <circle cx="345.9" cy="90.5" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                      <circle cx="339" cy="77.3" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                      <circle cx="327.2" cy="86.4" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                      <circle cx="354.1" cy="94.8" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                      <circle cx="361" cy="77.6" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                      <circle cx="405.9" cy="84.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                      <circle cx="318.1" cy="106.2" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                      <circle cx="333" cy="66.6" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                      <circle cx="130" cy="223.8" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                      <circle cx="167.4" cy="195.3" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                      <circle cx="137.9" cy="212" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                      <circle cx="108.5" cy="224.5" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                      <circle cx="128.4" cy="219.2" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                      <circle cx="165.9" cy="222.5" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                      <circle cx="103.7" cy="196.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                      <circle cx="142.7" cy="223" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                      <circle cx="143.8" cy="226.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                      <circle cx="142.7" cy="195.8" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                      <circle cx="168.5" cy="205.1" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                      <circle cx="122.1" cy="215.8" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                      <circle cx="114.8" cy="202.6" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                      <circle cx="143" cy="202.3" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                      <circle cx="127.4" cy="220.5" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                      <circle cx="164.5" cy="195.6" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                      <circle cx="167.7" cy="201.5" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                      <circle cx="165.1" cy="203.6" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                      <circle cx="119.4" cy="210.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                      <circle cx="129.3" cy="226.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                      <circle cx="104.1" cy="218.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                      <circle cx="121.9" cy="205.2" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                      <circle cx="175.7" cy="213.2" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                      <circle cx="174.2" cy="195.5" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                      <circle cx="175.6" cy="215.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                      <circle cx="118.9" cy="220.4" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                      <circle cx="117.1" cy="221.1" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                      <circle cx="150.1" cy="198.4" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                      <circle cx="166.8" cy="212.1" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                      <circle cx="152.3" cy="201.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                    </svg>
                    <p className="t-xs muted">
                      <i className="ic ic-info ic-14" aria-hidden="true" />
                      {' '}이 기기는 표본으로 그립니다(2만 점)
                    </p>
                  </>
                ) : null}
                <div className="banner banner-info">
                  <i className="ic ic-info" aria-hidden="true" />
                  <div className="banner-body">후보 찾기용입니다. 봇 판정은 표본 검토(SCR-067)와 정해진 규칙(POL-006)으로 합니다.</div>
                </div>
                {v.isCand ? (
                  <>
                    <dl className="kv">
                      <dt>고른 세션</dt>
                      <dd className="num">9,412</dd>
                      <dt>정밀도(합성 정답 기준)</dt>
                      <dd className="num">0.93</dd>
                      <dt>재현율(합성 정답 기준)</dt>
                      <dd className="num">0.81</dd>
                    </dl>
                    <p className="row t-xs tx-warning" role="note" style={{ gap: "6px", alignItems: "flex-start" }}>
                      <i className="ic ic-alert ic-14" aria-hidden="true" style={{ marginTop: "1px" }} />
                      <span>합성 데이터의 정답으로 잰 값입니다. 봇을 이 특징으로 만들었기 때문에 높게 나오며, 실제 봇 탐지 성능을 뜻하지 않습니다</span>
                    </p>
                    <div className="col" style={{ gap: "6px" }}>
                      <span className="label">기기 묶음(10ms 안에 서로 다른 좌석을 동시에 시도)</span>
                      <ul className="col t-sm" style={{ gap: "4px", margin: "0", padding: "0", listStyle: "none" }}>
                        <li className="row between">
                          <span className="mono">묶음 #A17</span>
                          <span>세션 42 · 동시 시도 38건</span>
                        </li>
                        <li className="row between">
                          <span className="mono">묶음 #C03</span>
                          <span>세션 31 · 동시 시도 27건</span>
                        </li>
                        <li className="row between">
                          <span className="mono">묶음 #B88</span>
                          <span>세션 19 · 동시 시도 16건</span>
                        </li>
                      </ul>
                    </div>
                  </>
                ) : null}
                {' '}
                {v.isMimic ? (
                  <>
                    <dl className="kv">
                      <dt>고른 세션</dt>
                      <dd className="num">8,020</dd>
                      <dt>정밀도(합성 정답 기준)</dt>
                      <dd className="num">0.31</dd>
                      <dt>재현율(합성 정답 기준)</dt>
                      <dd className="num">0.34</dd>
                    </dl>
                    <p className="row t-xs tx-warning" role="note" style={{ gap: "6px", alignItems: "flex-start" }}>
                      <i className="ic ic-alert ic-14" aria-hidden="true" style={{ marginTop: "1px" }} />
                      <span>합성 데이터의 정답으로 잰 값입니다. 봇을 이 특징으로 만들었기 때문에 높게 나오며, 실제 봇 탐지 성능을 뜻하지 않습니다</span>
                    </p>
                    <p className="t-xs muted">
                      이 시나리오의 봇은 반응 시간과 포인터 엔트로피를 사람과 같은 분포에서 뽑습니다. 그래서 산점도로는 사람과 갈리지 않고, 정밀도·재현율이 봇 비율(30%) 근처로 떨어집니다. 이런 봇은 재시도 간격·기기 묶음 같은 다른 신호나 표본 검토로만 드러납니다
                    </p>
                  </>
                ) : null}
              </div>
            </section>
            ) : (
              <CandidatePanel source={v.src} picked={v.isCand} fallback={v.isFallback} />
            )}
          </div>
          <div style={{ gridColumn: "1/-1", minWidth: "0" }}>
            <section className="widget" aria-labelledby="fx-tl-h">
              <div className="widget-head wrap">
                <h2 className="t-sm fw-b" id="fx-tl-h">타임라인</h2>
                <span className="t-xs muted">초당 홀드 시도(파랑)·경합(빨강)</span>
                <div className="actions" style={{ gap: "8px" }}>
                  {v.playing ? (
                    <>
                      <button className="icon-btn icon-btn-outline" type="button" aria-label="일시정지" onClick={ctl.pause}>
                        <i className="ic ic-pause" aria-hidden="true" />
                      </button>
                    </>
                  ) : null}
                  {' '}
                  {v.paused ? (
                    <>
                      <button className="icon-btn icon-btn-outline" type="button" aria-label="재생" onClick={ctl.play}>
                        <i className="ic ic-play" aria-hidden="true" />
                      </button>
                    </>
                  ) : null}
                  <div className="seg" role="group" aria-label="배속">
                    <button className="seg-item" type="button" aria-pressed={ctl.speed === '×1'} onClick={() => ctl.setSpeed('×1')}>×1</button>
                    <button className="seg-item" type="button" aria-pressed={ctl.speed === '×10'} onClick={() => ctl.setSpeed('×10')}>×10</button>
                    <button className="seg-item" type="button" aria-pressed={ctl.speed === '×60'} onClick={() => ctl.setSpeed('×60')}>×60</button>
                  </div>
                  <span className="mono t-sm">T+02:14.350</span>
                </div>
              </div>
              <div className="widget-body">
                {v.tlBase ? (
                  <>
                    <svg className="chart" viewBox="0 0 900 120" role="img" aria-label="타임라인. 오픈 직후 1분 동안 홀드 시도가 가장 많고 경합도 그때 몰렸다가 3분 뒤부터 줄어듭니다. 재생 위치는 오픈 뒤 2분 14초입니다." style={{ height: "auto" }}>
                      <line className="grid" x1="44" y1="94" x2="890" y2="94" />
                      <rect className="bar" x="45" y="7.7" width="12.1" height="86.3" />
                      <rect className="bar-bad" x="45" y="42.2" width="12.1" height="51.8" />
                      <rect className="bar" x="59.1" y="13" width="12.1" height="81" />
                      <rect className="bar-bad" x="59.1" y="49.8" width="12.1" height="44.2" />
                      <rect className="bar" x="73.2" y="16.6" width="12.1" height="77.4" />
                      <rect className="bar-bad" x="73.2" y="55.5" width="12.1" height="38.5" />
                      <rect className="bar" x="87.3" y="23.9" width="12.1" height="70.1" />
                      <rect className="bar-bad" x="87.3" y="62.3" width="12.1" height="31.7" />
                      <rect className="bar" x="101.4" y="28.3" width="12.1" height="65.7" />
                      <rect className="bar-bad" x="101.4" y="66.9" width="12.1" height="27.1" />
                      <rect className="bar" x="115.5" y="32.2" width="12.1" height="61.8" />
                      <rect className="bar-bad" x="115.5" y="70.7" width="12.1" height="23.3" />
                      <rect className="bar" x="129.6" y="38.2" width="12.1" height="55.8" />
                      <rect className="bar-bad" x="129.6" y="74.8" width="12.1" height="19.2" />
                      <rect className="bar" x="143.7" y="40.3" width="12.1" height="53.7" />
                      <rect className="bar-bad" x="143.7" y="77.1" width="12.1" height="16.9" />
                      <rect className="bar" x="157.8" y="43.1" width="12.1" height="50.9" />
                      <rect className="bar-bad" x="157.8" y="79.3" width="12.1" height="14.7" />
                      <rect className="bar" x="171.9" y="45.4" width="12.1" height="48.6" />
                      <rect className="bar-bad" x="171.9" y="81.1" width="12.1" height="12.9" />
                      <rect className="bar" x="186" y="51.9" width="12.1" height="42.1" />
                      <rect className="bar-bad" x="186" y="83.7" width="12.1" height="10.3" />
                      <rect className="bar" x="200.1" y="53.6" width="12.1" height="40.4" />
                      <rect className="bar-bad" x="200.1" y="84.9" width="12.1" height="9.1" />
                      <rect className="bar" x="214.2" y="57.2" width="12.1" height="36.8" />
                      <rect className="bar-bad" x="214.2" y="86.4" width="12.1" height="7.6" />
                      <rect className="bar" x="228.3" y="55.9" width="12.1" height="38.1" />
                      <rect className="bar-bad" x="228.3" y="86.7" width="12.1" height="7.3" />
                      <rect className="bar" x="242.4" y="58.7" width="12.1" height="35.3" />
                      <rect className="bar-bad" x="242.4" y="87.7" width="12.1" height="6.3" />
                      <rect className="bar" x="256.5" y="64" width="12.1" height="30" />
                      <rect className="bar-bad" x="256.5" y="89" width="12.1" height="5" />
                      <rect className="bar" x="270.6" y="61.1" width="12.1" height="32.9" />
                      <rect className="bar-bad" x="270.6" y="88.9" width="12.1" height="5.1" />
                      <rect className="bar" x="284.7" y="62.9" width="12.1" height="31.1" />
                      <rect className="bar-bad" x="284.7" y="89.5" width="12.1" height="4.5" />
                      <rect className="bar" x="298.8" y="66.1" width="12.1" height="27.9" />
                      <rect className="bar-bad" x="298.8" y="90.3" width="12.1" height="3.7" />
                      <rect className="bar" x="312.9" y="67.8" width="12.1" height="26.2" />
                      <rect className="bar-bad" x="312.9" y="90.7" width="12.1" height="3.3" />
                      <rect className="bar" x="327" y="71.5" width="12.1" height="22.5" />
                      <rect className="bar-bad" x="327" y="91.3" width="12.1" height="2.7" />
                      <rect className="bar" x="341.1" y="73.5" width="12.1" height="20.5" />
                      <rect className="bar-bad" x="341.1" y="91.7" width="12.1" height="2.3" />
                      <rect className="bar" x="355.2" y="72.1" width="12.1" height="21.9" />
                      <rect className="bar-bad" x="355.2" y="91.7" width="12.1" height="2.3" />
                      <rect className="bar" x="369.3" y="75.5" width="12.1" height="18.5" />
                      <rect className="bar-bad" x="369.3" y="92.2" width="12.1" height="1.8" />
                      <rect className="bar" x="383.4" y="75.9" width="12.1" height="18.1" />
                      <rect className="bar-bad" x="383.4" y="92.3" width="12.1" height="1.7" />
                      <rect className="bar" x="397.5" y="76.6" width="12.1" height="17.4" />
                      <rect className="bar-bad" x="397.5" y="92.4" width="12.1" height="1.6" />
                      <rect className="bar" x="411.6" y="78.5" width="12.1" height="15.5" />
                      <rect className="bar-bad" x="411.6" y="92.7" width="12.1" height="1.3" />
                      <rect className="bar" x="425.7" y="77.1" width="12.1" height="16.9" />
                      <rect className="bar-bad" x="425.7" y="92.6" width="12.1" height="1.4" />
                      <rect className="bar" x="439.8" y="78" width="12.1" height="16" />
                      <rect className="bar-bad" x="439.8" y="92.7" width="12.1" height="1.3" />
                      <rect className="bar" x="453.9" y="76.7" width="12.1" height="17.3" />
                      <rect className="bar-bad" x="453.9" y="92.7" width="12.1" height="1.3" />
                      <rect className="bar" x="468" y="79" width="12.1" height="15" />
                      <rect className="bar-bad" x="468" y="92.9" width="12.1" height="1.1" />
                      <rect className="bar" x="482.1" y="79" width="12.1" height="15" />
                      <rect className="bar-bad" x="482.1" y="92.9" width="12.1" height="1.1" />
                      <rect className="bar" x="496.2" y="80.2" width="12.1" height="13.8" />
                      <rect className="bar-bad" x="496.2" y="93" width="12.1" height="1" />
                      <rect className="bar" x="510.3" y="79.9" width="12.1" height="14.1" />
                      <rect className="bar-bad" x="510.3" y="93" width="12.1" height="1" />
                      <rect className="bar" x="524.4" y="81.4" width="12.1" height="12.6" />
                      <rect className="bar-bad" x="524.4" y="93.2" width="12.1" height="0.8" />
                      <rect className="bar" x="538.5" y="82.8" width="12.1" height="11.2" />
                      <rect className="bar-bad" x="538.5" y="93.3" width="12.1" height="0.7" />
                      <rect className="bar" x="552.6" y="79.6" width="12.1" height="14.4" />
                      <rect className="bar-bad" x="552.6" y="93.1" width="12.1" height="0.9" />
                      <rect className="bar" x="566.7" y="79.9" width="12.1" height="14.1" />
                      <rect className="bar-bad" x="566.7" y="93.1" width="12.1" height="0.9" />
                      <rect className="bar" x="580.8" y="81.1" width="12.1" height="12.9" />
                      <rect className="bar-bad" x="580.8" y="93.2" width="12.1" height="0.8" />
                      <rect className="bar" x="594.9" y="82.1" width="12.1" height="11.9" />
                      <rect className="bar-bad" x="594.9" y="93.3" width="12.1" height="0.7" />
                      <rect className="bar" x="609" y="84.4" width="12.1" height="9.6" />
                      <rect className="bar-bad" x="609" y="93.4" width="12.1" height="0.6" />
                      <rect className="bar" x="623.1" y="85.1" width="12.1" height="8.9" />
                      <rect className="bar-bad" x="623.1" y="93.5" width="12.1" height="0.5" />
                      <rect className="bar" x="637.2" y="85" width="12.1" height="9" />
                      <rect className="bar-bad" x="637.2" y="93.5" width="12.1" height="0.5" />
                      <rect className="bar" x="651.3" y="86.4" width="12.1" height="7.6" />
                      <rect className="bar-bad" x="651.3" y="93.6" width="12.1" height="0.4" />
                      <rect className="bar" x="665.4" y="83.1" width="12.1" height="10.9" />
                      <rect className="bar-bad" x="665.4" y="93.4" width="12.1" height="0.6" />
                      <rect className="bar" x="679.5" y="85.1" width="12.1" height="8.9" />
                      <rect className="bar-bad" x="679.5" y="93.5" width="12.1" height="0.5" />
                      <rect className="bar" x="693.6" y="83.1" width="12.1" height="10.9" />
                      <rect className="bar-bad" x="693.6" y="93.4" width="12.1" height="0.6" />
                      <rect className="bar" x="707.7" y="85.6" width="12.1" height="8.4" />
                      <rect className="bar-bad" x="707.7" y="93.5" width="12.1" height="0.5" />
                      <rect className="bar" x="721.8" y="82.9" width="12.1" height="11.1" />
                      <rect className="bar-bad" x="721.8" y="93.4" width="12.1" height="0.6" />
                      <rect className="bar" x="735.9" y="83.6" width="12.1" height="10.4" />
                      <rect className="bar-bad" x="735.9" y="93.4" width="12.1" height="0.6" />
                      <rect className="bar" x="750" y="88" width="12.1" height="6" />
                      <rect className="bar-bad" x="750" y="93.7" width="12.1" height="0.3" />
                      <rect className="bar" x="764.1" y="87.1" width="12.1" height="6.9" />
                      <rect className="bar-bad" x="764.1" y="93.6" width="12.1" height="0.4" />
                      <rect className="bar" x="778.2" y="83.7" width="12.1" height="10.3" />
                      <rect className="bar-bad" x="778.2" y="93.5" width="12.1" height="0.5" />
                      <rect className="bar" x="792.3" y="86" width="12.1" height="8" />
                      <rect className="bar-bad" x="792.3" y="93.6" width="12.1" height="0.4" />
                      <rect className="bar" x="806.4" y="83.5" width="12.1" height="10.5" />
                      <rect className="bar-bad" x="806.4" y="93.5" width="12.1" height="0.5" />
                      <rect className="bar" x="820.5" y="86.6" width="12.1" height="7.4" />
                      <rect className="bar-bad" x="820.5" y="93.6" width="12.1" height="0.4" />
                      <rect className="bar" x="834.6" y="88.3" width="12.1" height="5.7" />
                      <rect className="bar-bad" x="834.6" y="93.7" width="12.1" height="0.3" />
                      <rect className="bar" x="848.7" y="85.6" width="12.1" height="8.4" />
                      <rect className="bar-bad" x="848.7" y="93.6" width="12.1" height="0.4" />
                      <rect className="bar" x="862.8" y="84.9" width="12.1" height="9.1" />
                      <rect className="bar-bad" x="862.8" y="93.5" width="12.1" height="0.5" />
                      <rect className="bar" x="876.9" y="87.5" width="12.1" height="6.5" />
                      <rect className="bar-bad" x="876.9" y="93.7" width="12.1" height="0.3" />
                      <text className="axis" x="44" y="112" textAnchor="middle">T+00:00</text>
                      <text className="axis" x="213.2" y="112" textAnchor="middle">T+02:00</text>
                      <text className="axis" x="382.4" y="112" textAnchor="middle">T+04:00</text>
                      <text className="axis" x="551.6" y="112" textAnchor="middle">T+06:00</text>
                      <text className="axis" x="720.8" y="112" textAnchor="middle">T+08:00</text>
                      <text className="axis" x="890" y="112" textAnchor="middle">T+10:00</text>
                      <line className="now" x1="232.9" y1="4" x2="232.9" y2="94" style={{ strokeWidth: "2" }} />
                      <circle cx="232.9" cy="4" r="5" style={{ fill: "var(--text)" }} />
                    </svg>
                  </>
                ) : null}
                {v.tlCand ? (
                  <>
                    <svg className="chart" viewBox="0 0 900 120" role="img" aria-label="타임라인. 오픈 직후 1분 동안 홀드 시도가 가장 많고 경합도 그때 몰렸다가 3분 뒤부터 줄어듭니다. 재생 위치는 오픈 뒤 2분 14초입니다. 오픈 뒤 2분부터 2분 30초까지를 골랐습니다." style={{ height: "auto" }}>
                      <line className="grid" x1="44" y1="94" x2="890" y2="94" />
                      <rect className="bar" x="45" y="7.7" width="12.1" height="86.3" />
                      <rect className="bar-bad" x="45" y="42.2" width="12.1" height="51.8" />
                      <rect className="bar" x="59.1" y="13" width="12.1" height="81" />
                      <rect className="bar-bad" x="59.1" y="49.8" width="12.1" height="44.2" />
                      <rect className="bar" x="73.2" y="16.6" width="12.1" height="77.4" />
                      <rect className="bar-bad" x="73.2" y="55.5" width="12.1" height="38.5" />
                      <rect className="bar" x="87.3" y="23.9" width="12.1" height="70.1" />
                      <rect className="bar-bad" x="87.3" y="62.3" width="12.1" height="31.7" />
                      <rect className="bar" x="101.4" y="28.3" width="12.1" height="65.7" />
                      <rect className="bar-bad" x="101.4" y="66.9" width="12.1" height="27.1" />
                      <rect className="bar" x="115.5" y="32.2" width="12.1" height="61.8" />
                      <rect className="bar-bad" x="115.5" y="70.7" width="12.1" height="23.3" />
                      <rect className="bar" x="129.6" y="38.2" width="12.1" height="55.8" />
                      <rect className="bar-bad" x="129.6" y="74.8" width="12.1" height="19.2" />
                      <rect className="bar" x="143.7" y="40.3" width="12.1" height="53.7" />
                      <rect className="bar-bad" x="143.7" y="77.1" width="12.1" height="16.9" />
                      <rect className="bar" x="157.8" y="43.1" width="12.1" height="50.9" />
                      <rect className="bar-bad" x="157.8" y="79.3" width="12.1" height="14.7" />
                      <rect className="bar" x="171.9" y="45.4" width="12.1" height="48.6" />
                      <rect className="bar-bad" x="171.9" y="81.1" width="12.1" height="12.9" />
                      <rect className="bar" x="186" y="51.9" width="12.1" height="42.1" />
                      <rect className="bar-bad" x="186" y="83.7" width="12.1" height="10.3" />
                      <rect className="bar" x="200.1" y="53.6" width="12.1" height="40.4" />
                      <rect className="bar-bad" x="200.1" y="84.9" width="12.1" height="9.1" />
                      <rect className="bar" x="214.2" y="57.2" width="12.1" height="36.8" />
                      <rect className="bar-bad" x="214.2" y="86.4" width="12.1" height="7.6" />
                      <rect className="bar" x="228.3" y="55.9" width="12.1" height="38.1" />
                      <rect className="bar-bad" x="228.3" y="86.7" width="12.1" height="7.3" />
                      <rect className="bar" x="242.4" y="58.7" width="12.1" height="35.3" />
                      <rect className="bar-bad" x="242.4" y="87.7" width="12.1" height="6.3" />
                      <rect className="bar" x="256.5" y="64" width="12.1" height="30" />
                      <rect className="bar-bad" x="256.5" y="89" width="12.1" height="5" />
                      <rect className="bar" x="270.6" y="61.1" width="12.1" height="32.9" />
                      <rect className="bar-bad" x="270.6" y="88.9" width="12.1" height="5.1" />
                      <rect className="bar" x="284.7" y="62.9" width="12.1" height="31.1" />
                      <rect className="bar-bad" x="284.7" y="89.5" width="12.1" height="4.5" />
                      <rect className="bar" x="298.8" y="66.1" width="12.1" height="27.9" />
                      <rect className="bar-bad" x="298.8" y="90.3" width="12.1" height="3.7" />
                      <rect className="bar" x="312.9" y="67.8" width="12.1" height="26.2" />
                      <rect className="bar-bad" x="312.9" y="90.7" width="12.1" height="3.3" />
                      <rect className="bar" x="327" y="71.5" width="12.1" height="22.5" />
                      <rect className="bar-bad" x="327" y="91.3" width="12.1" height="2.7" />
                      <rect className="bar" x="341.1" y="73.5" width="12.1" height="20.5" />
                      <rect className="bar-bad" x="341.1" y="91.7" width="12.1" height="2.3" />
                      <rect className="bar" x="355.2" y="72.1" width="12.1" height="21.9" />
                      <rect className="bar-bad" x="355.2" y="91.7" width="12.1" height="2.3" />
                      <rect className="bar" x="369.3" y="75.5" width="12.1" height="18.5" />
                      <rect className="bar-bad" x="369.3" y="92.2" width="12.1" height="1.8" />
                      <rect className="bar" x="383.4" y="75.9" width="12.1" height="18.1" />
                      <rect className="bar-bad" x="383.4" y="92.3" width="12.1" height="1.7" />
                      <rect className="bar" x="397.5" y="76.6" width="12.1" height="17.4" />
                      <rect className="bar-bad" x="397.5" y="92.4" width="12.1" height="1.6" />
                      <rect className="bar" x="411.6" y="78.5" width="12.1" height="15.5" />
                      <rect className="bar-bad" x="411.6" y="92.7" width="12.1" height="1.3" />
                      <rect className="bar" x="425.7" y="77.1" width="12.1" height="16.9" />
                      <rect className="bar-bad" x="425.7" y="92.6" width="12.1" height="1.4" />
                      <rect className="bar" x="439.8" y="78" width="12.1" height="16" />
                      <rect className="bar-bad" x="439.8" y="92.7" width="12.1" height="1.3" />
                      <rect className="bar" x="453.9" y="76.7" width="12.1" height="17.3" />
                      <rect className="bar-bad" x="453.9" y="92.7" width="12.1" height="1.3" />
                      <rect className="bar" x="468" y="79" width="12.1" height="15" />
                      <rect className="bar-bad" x="468" y="92.9" width="12.1" height="1.1" />
                      <rect className="bar" x="482.1" y="79" width="12.1" height="15" />
                      <rect className="bar-bad" x="482.1" y="92.9" width="12.1" height="1.1" />
                      <rect className="bar" x="496.2" y="80.2" width="12.1" height="13.8" />
                      <rect className="bar-bad" x="496.2" y="93" width="12.1" height="1" />
                      <rect className="bar" x="510.3" y="79.9" width="12.1" height="14.1" />
                      <rect className="bar-bad" x="510.3" y="93" width="12.1" height="1" />
                      <rect className="bar" x="524.4" y="81.4" width="12.1" height="12.6" />
                      <rect className="bar-bad" x="524.4" y="93.2" width="12.1" height="0.8" />
                      <rect className="bar" x="538.5" y="82.8" width="12.1" height="11.2" />
                      <rect className="bar-bad" x="538.5" y="93.3" width="12.1" height="0.7" />
                      <rect className="bar" x="552.6" y="79.6" width="12.1" height="14.4" />
                      <rect className="bar-bad" x="552.6" y="93.1" width="12.1" height="0.9" />
                      <rect className="bar" x="566.7" y="79.9" width="12.1" height="14.1" />
                      <rect className="bar-bad" x="566.7" y="93.1" width="12.1" height="0.9" />
                      <rect className="bar" x="580.8" y="81.1" width="12.1" height="12.9" />
                      <rect className="bar-bad" x="580.8" y="93.2" width="12.1" height="0.8" />
                      <rect className="bar" x="594.9" y="82.1" width="12.1" height="11.9" />
                      <rect className="bar-bad" x="594.9" y="93.3" width="12.1" height="0.7" />
                      <rect className="bar" x="609" y="84.4" width="12.1" height="9.6" />
                      <rect className="bar-bad" x="609" y="93.4" width="12.1" height="0.6" />
                      <rect className="bar" x="623.1" y="85.1" width="12.1" height="8.9" />
                      <rect className="bar-bad" x="623.1" y="93.5" width="12.1" height="0.5" />
                      <rect className="bar" x="637.2" y="85" width="12.1" height="9" />
                      <rect className="bar-bad" x="637.2" y="93.5" width="12.1" height="0.5" />
                      <rect className="bar" x="651.3" y="86.4" width="12.1" height="7.6" />
                      <rect className="bar-bad" x="651.3" y="93.6" width="12.1" height="0.4" />
                      <rect className="bar" x="665.4" y="83.1" width="12.1" height="10.9" />
                      <rect className="bar-bad" x="665.4" y="93.4" width="12.1" height="0.6" />
                      <rect className="bar" x="679.5" y="85.1" width="12.1" height="8.9" />
                      <rect className="bar-bad" x="679.5" y="93.5" width="12.1" height="0.5" />
                      <rect className="bar" x="693.6" y="83.1" width="12.1" height="10.9" />
                      <rect className="bar-bad" x="693.6" y="93.4" width="12.1" height="0.6" />
                      <rect className="bar" x="707.7" y="85.6" width="12.1" height="8.4" />
                      <rect className="bar-bad" x="707.7" y="93.5" width="12.1" height="0.5" />
                      <rect className="bar" x="721.8" y="82.9" width="12.1" height="11.1" />
                      <rect className="bar-bad" x="721.8" y="93.4" width="12.1" height="0.6" />
                      <rect className="bar" x="735.9" y="83.6" width="12.1" height="10.4" />
                      <rect className="bar-bad" x="735.9" y="93.4" width="12.1" height="0.6" />
                      <rect className="bar" x="750" y="88" width="12.1" height="6" />
                      <rect className="bar-bad" x="750" y="93.7" width="12.1" height="0.3" />
                      <rect className="bar" x="764.1" y="87.1" width="12.1" height="6.9" />
                      <rect className="bar-bad" x="764.1" y="93.6" width="12.1" height="0.4" />
                      <rect className="bar" x="778.2" y="83.7" width="12.1" height="10.3" />
                      <rect className="bar-bad" x="778.2" y="93.5" width="12.1" height="0.5" />
                      <rect className="bar" x="792.3" y="86" width="12.1" height="8" />
                      <rect className="bar-bad" x="792.3" y="93.6" width="12.1" height="0.4" />
                      <rect className="bar" x="806.4" y="83.5" width="12.1" height="10.5" />
                      <rect className="bar-bad" x="806.4" y="93.5" width="12.1" height="0.5" />
                      <rect className="bar" x="820.5" y="86.6" width="12.1" height="7.4" />
                      <rect className="bar-bad" x="820.5" y="93.6" width="12.1" height="0.4" />
                      <rect className="bar" x="834.6" y="88.3" width="12.1" height="5.7" />
                      <rect className="bar-bad" x="834.6" y="93.7" width="12.1" height="0.3" />
                      <rect className="bar" x="848.7" y="85.6" width="12.1" height="8.4" />
                      <rect className="bar-bad" x="848.7" y="93.6" width="12.1" height="0.4" />
                      <rect className="bar" x="862.8" y="84.9" width="12.1" height="9.1" />
                      <rect className="bar-bad" x="862.8" y="93.5" width="12.1" height="0.5" />
                      <rect className="bar" x="876.9" y="87.5" width="12.1" height="6.5" />
                      <rect className="bar-bad" x="876.9" y="93.7" width="12.1" height="0.3" />
                      <text className="axis" x="44" y="112" textAnchor="middle">T+00:00</text>
                      <text className="axis" x="213.2" y="112" textAnchor="middle">T+02:00</text>
                      <text className="axis" x="382.4" y="112" textAnchor="middle">T+04:00</text>
                      <text className="axis" x="551.6" y="112" textAnchor="middle">T+06:00</text>
                      <text className="axis" x="720.8" y="112" textAnchor="middle">T+08:00</text>
                      <text className="axis" x="890" y="112" textAnchor="middle">T+10:00</text>
                      <rect x="213.2" y="6" width="42.3" height="88" style={{ fill: "var(--primary-subtle)", opacity: ".45", stroke: "var(--link)", strokeWidth: "1.5" }} />
                      <line className="now" x1="232.9" y1="4" x2="232.9" y2="94" style={{ strokeWidth: "2" }} />
                      <circle cx="232.9" cy="4" r="5" style={{ fill: "var(--text)" }} />
                    </svg>
                  </>
                ) : null}
                <p className="t-xs muted">←→ 1초 · Shift+←→ 10초 · Space 재생·일시정지 · 시작·끝 시각을 숫자로도 고를 수 있습니다</p>
              </div>
            </section>
          </div>
        </main>
      </>
    ) : null}
    {v.isGen ? (
      <>
        <Overlay placement="center" onClose={close}>
          <div className="dialog" role="status" aria-labelledby="fx-gen-t" style={{ maxWidth: "420px" }}>
            <h2 className="dialog-title" id="fx-gen-t">합성 사건 만드는 중</h2>
            <p className="t-md num">62만 / 100만</p>
            <div className="progress" role="progressbar" aria-label="합성 사건 만드는 중" aria-valuenow={62} aria-valuemin={0} aria-valuemax={100}>
              <span style={{ width: "62%" }} />
            </div>
            <p className="t-xs muted">시드 20261021 · 인기 콘서트 오픈 · 만드는 동안에도 화면을 쓸 수 있습니다</p>
          </div>
        </Overlay>
      </>
    ) : null}
    {v.isCant ? (
      <>
        <main id="main" className="col" style={{ flex: "1", alignItems: "center", justifyContent: "center", gap: "10px", padding: "80px 20px", textAlign: "center" }}>
          <span className="state-icon is-warning" style={{ width: "56px", height: "56px" }}><i className="ic ic-monitor" aria-hidden="true" /></span>
          <h1 className="t-xl">이 기기에서는 리플레이를 돌릴 수 없습니다</h1>
          <p className="t-md muted">이 브라우저는 화면 뒤 계산(Web Worker)이나 화면 밖 그리기(OffscreenCanvas)를 지원하지 않습니다. 최신 브라우저로 열어 주세요</p>
        </main>
      </>
    ) : null}
    {v.isDeny ? <DenyMain /> : null}
    {v.isRecv ? <ReceivingMain source={v.src} /> : null}
    {v.isExpired ? <ExpiredMain source={v.src} /> : null}
    {v.showFoot ? (
      <>
        <footer className="row wrap" style={{ gap: "8px 16px", padding: "10px 20px 16px", marginTop: "auto", fontSize: "12px", color: "var(--text-muted)" }} aria-label="이 기기에서 잰 값(예시)">
          <span>이 기기에서 잰 값(예시)</span>
          {' '}
          {v.notCopy ? (
            <>
              <span>필터 반영 9ms</span>
              <span>프레임 11ms</span>
              <span>긴 작업 0</span>
              <span className="badge badge-success">공유 메모리 켜짐</span>
            </>
          ) : null}
          {' '}
          {v.isCopy ? (
            <>
              <span>필터 반영 14ms</span>
              <span>프레임 13ms</span>
              <span>긴 작업 0</span>
              <span className="badge">복사 방식</span>
            </>
          ) : null}
        </footer>
      </>
    ) : null}
    </>
  );
}
