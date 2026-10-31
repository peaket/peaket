// 디자인 캔버스 보드 SCR-069-t.dc.html를 옮긴 것(dc2tsx 생성 뒤 손질). 재생·정지·배속·시나리오 단추만 controls.tsx로 잇는다
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


// 상태 목록은 원천(합성·조사·연구)마다 다르다: lib/source.ts statesFor(d5 §7.17 상태 표). 보드 SCR-069-t의 state 열거값은 합성 원천 목록이다

export function valsT(state: string, source: Source = 'synthetic') {
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

type V = ReturnType<typeof valsT>;

// 보드 루트: {"class": "pk dark", "style": "width:768px;min-height:2300px;display:flex;flex-direction:column;background:var(--surface-basement);position:relative"}

// <header class="cs-bar" style="flex-wrap:wrap;white-space:normal">
export function BarT({ v, close }: { v: V; close?: () => void }) {
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

export function OverlaysT({ v, close }: { v: V; close?: () => void }) {
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
        <main id="main" className="col" style={{ gap: "16px", padding: "16px" }}>
          <h1 className="sr-only">{v.spec.title}</h1>
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
              <div style={{ display: "grid", gridTemplateColumns: "repeat(2,minmax(0,1fr))", gap: "10px" }}>
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
                    <button className="icon-btn icon-btn-outline" type="button" aria-label="재생" onClick={ctl.play}><i className="ic ic-play" aria-hidden="true" /></button>
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
                  <svg className="chart" viewBox="0 0 736 130" role="img" aria-label="타임라인. 오픈 직후 1분 동안 홀드 시도가 가장 많고 경합도 그때 몰렸다가 3분 뒤부터 줄어듭니다. 재생 위치는 오픈 뒤 2분 14초입니다." style={{ height: "auto" }}>
                    <line className="grid" x1="44" y1="104" x2="726" y2="104" />
                    <rect className="bar" x="45" y="7.4" width="9.4" height="96.6" />
                    <rect className="bar-bad" x="45" y="46.1" width="9.4" height="57.9" />
                    <rect className="bar" x="56.4" y="13.4" width="9.4" height="90.6" />
                    <rect className="bar-bad" x="56.4" y="54.5" width="9.4" height="49.5" />
                    <rect className="bar" x="67.7" y="17.3" width="9.4" height="86.7" />
                    <rect className="bar-bad" x="67.7" y="61" width="9.4" height="43" />
                    <rect className="bar" x="79.1" y="25.5" width="9.4" height="78.5" />
                    <rect className="bar-bad" x="79.1" y="68.5" width="9.4" height="35.5" />
                    <rect className="bar" x="90.5" y="30.5" width="9.4" height="73.5" />
                    <rect className="bar-bad" x="90.5" y="73.7" width="9.4" height="30.3" />
                    <rect className="bar" x="101.8" y="34.8" width="9.4" height="69.2" />
                    <rect className="bar-bad" x="101.8" y="77.9" width="9.4" height="26.1" />
                    <rect className="bar" x="113.2" y="41.6" width="9.4" height="62.4" />
                    <rect className="bar-bad" x="113.2" y="82.5" width="9.4" height="21.5" />
                    <rect className="bar" x="124.6" y="43.9" width="9.4" height="60.1" />
                    <rect className="bar-bad" x="124.6" y="85" width="9.4" height="19" />
                    <rect className="bar" x="135.9" y="47" width="9.4" height="57" />
                    <rect className="bar-bad" x="135.9" y="87.5" width="9.4" height="16.5" />
                    <rect className="bar" x="147.3" y="49.7" width="9.4" height="54.3" />
                    <rect className="bar-bad" x="147.3" y="89.6" width="9.4" height="14.4" />
                    <rect className="bar" x="158.7" y="56.9" width="9.4" height="47.1" />
                    <rect className="bar-bad" x="158.7" y="92.5" width="9.4" height="11.5" />
                    <rect className="bar" x="170" y="58.8" width="9.4" height="45.2" />
                    <rect className="bar-bad" x="170" y="93.8" width="9.4" height="10.2" />
                    <rect className="bar" x="181.4" y="62.8" width="9.4" height="41.2" />
                    <rect className="bar-bad" x="181.4" y="95.4" width="9.4" height="8.6" />
                    <rect className="bar" x="192.8" y="61.4" width="9.4" height="42.6" />
                    <rect className="bar-bad" x="192.8" y="95.8" width="9.4" height="8.2" />
                    <rect className="bar" x="204.1" y="64.5" width="9.4" height="39.5" />
                    <rect className="bar-bad" x="204.1" y="97" width="9.4" height="7" />
                    <rect className="bar" x="215.5" y="70.4" width="9.4" height="33.6" />
                    <rect className="bar-bad" x="215.5" y="98.4" width="9.4" height="5.6" />
                    <rect className="bar" x="226.9" y="67.2" width="9.4" height="36.8" />
                    <rect className="bar-bad" x="226.9" y="98.3" width="9.4" height="5.7" />
                    <rect className="bar" x="238.2" y="69.2" width="9.4" height="34.8" />
                    <rect className="bar-bad" x="238.2" y="99" width="9.4" height="5" />
                    <rect className="bar" x="249.6" y="72.8" width="9.4" height="31.2" />
                    <rect className="bar-bad" x="249.6" y="99.8" width="9.4" height="4.2" />
                    <rect className="bar" x="261" y="74.7" width="9.4" height="29.3" />
                    <rect className="bar-bad" x="261" y="100.3" width="9.4" height="3.7" />
                    <rect className="bar" x="272.3" y="78.8" width="9.4" height="25.2" />
                    <rect className="bar-bad" x="272.3" y="101" width="9.4" height="3" />
                    <rect className="bar" x="283.7" y="81" width="9.4" height="23" />
                    <rect className="bar-bad" x="283.7" y="101.4" width="9.4" height="2.6" />
                    <rect className="bar" x="295.1" y="79.5" width="9.4" height="24.5" />
                    <rect className="bar-bad" x="295.1" y="101.4" width="9.4" height="2.6" />
                    <rect className="bar" x="306.4" y="83.3" width="9.4" height="20.7" />
                    <rect className="bar-bad" x="306.4" y="101.9" width="9.4" height="2.1" />
                    <rect className="bar" x="317.8" y="83.7" width="9.4" height="20.3" />
                    <rect className="bar-bad" x="317.8" y="102.1" width="9.4" height="1.9" />
                    <rect className="bar" x="329.2" y="84.5" width="9.4" height="19.5" />
                    <rect className="bar-bad" x="329.2" y="102.2" width="9.4" height="1.8" />
                    <rect className="bar" x="340.5" y="86.7" width="9.4" height="17.3" />
                    <rect className="bar-bad" x="340.5" y="102.5" width="9.4" height="1.5" />
                    <rect className="bar" x="351.9" y="85.1" width="9.4" height="18.9" />
                    <rect className="bar-bad" x="351.9" y="102.4" width="9.4" height="1.6" />
                    <rect className="bar" x="363.3" y="86.1" width="9.4" height="17.9" />
                    <rect className="bar-bad" x="363.3" y="102.6" width="9.4" height="1.4" />
                    <rect className="bar" x="374.6" y="84.6" width="9.4" height="19.4" />
                    <rect className="bar-bad" x="374.6" y="102.5" width="9.4" height="1.5" />
                    <rect className="bar" x="386" y="87.2" width="9.4" height="16.8" />
                    <rect className="bar-bad" x="386" y="102.8" width="9.4" height="1.2" />
                    <rect className="bar" x="397.4" y="87.2" width="9.4" height="16.8" />
                    <rect className="bar-bad" x="397.4" y="102.8" width="9.4" height="1.2" />
                    <rect className="bar" x="408.7" y="88.6" width="9.4" height="15.4" />
                    <rect className="bar-bad" x="408.7" y="102.9" width="9.4" height="1.1" />
                    <rect className="bar" x="420.1" y="88.2" width="9.4" height="15.8" />
                    <rect className="bar-bad" x="420.1" y="102.9" width="9.4" height="1.1" />
                    <rect className="bar" x="431.5" y="89.9" width="9.4" height="14.1" />
                    <rect className="bar-bad" x="431.5" y="103.1" width="9.4" height="0.9" />
                    <rect className="bar" x="442.8" y="91.4" width="9.4" height="12.6" />
                    <rect className="bar-bad" x="442.8" y="103.2" width="9.4" height="0.8" />
                    <rect className="bar" x="454.2" y="87.8" width="9.4" height="16.2" />
                    <rect className="bar-bad" x="454.2" y="103" width="9.4" height="1" />
                    <rect className="bar" x="465.6" y="88.3" width="9.4" height="15.7" />
                    <rect className="bar-bad" x="465.6" y="103" width="9.4" height="1" />
                    <rect className="bar" x="476.9" y="89.5" width="9.4" height="14.5" />
                    <rect className="bar-bad" x="476.9" y="103.1" width="9.4" height="0.9" />
                    <rect className="bar" x="488.3" y="90.7" width="9.4" height="13.3" />
                    <rect className="bar-bad" x="488.3" y="103.2" width="9.4" height="0.8" />
                    <rect className="bar" x="499.7" y="93.2" width="9.4" height="10.8" />
                    <rect className="bar-bad" x="499.7" y="103.4" width="9.4" height="0.6" />
                    <rect className="bar" x="511" y="94" width="9.4" height="10" />
                    <rect className="bar-bad" x="511" y="103.4" width="9.4" height="0.6" />
                    <rect className="bar" x="522.4" y="94" width="9.4" height="10" />
                    <rect className="bar-bad" x="522.4" y="103.4" width="9.4" height="0.6" />
                    <rect className="bar" x="533.8" y="95.5" width="9.4" height="8.5" />
                    <rect className="bar-bad" x="533.8" y="103.5" width="9.4" height="0.5" />
                    <rect className="bar" x="545.1" y="91.8" width="9.4" height="12.2" />
                    <rect className="bar-bad" x="545.1" y="103.3" width="9.4" height="0.7" />
                    <rect className="bar" x="556.5" y="94.1" width="9.4" height="9.9" />
                    <rect className="bar-bad" x="556.5" y="103.5" width="9.4" height="0.5" />
                    <rect className="bar" x="567.9" y="91.8" width="9.4" height="12.2" />
                    <rect className="bar-bad" x="567.9" y="103.3" width="9.4" height="0.7" />
                    <rect className="bar" x="579.2" y="94.6" width="9.4" height="9.4" />
                    <rect className="bar-bad" x="579.2" y="103.5" width="9.4" height="0.5" />
                    <rect className="bar" x="590.6" y="91.5" width="9.4" height="12.5" />
                    <rect className="bar-bad" x="590.6" y="103.3" width="9.4" height="0.7" />
                    <rect className="bar" x="602" y="92.3" width="9.4" height="11.7" />
                    <rect className="bar-bad" x="602" y="103.4" width="9.4" height="0.6" />
                    <rect className="bar" x="613.3" y="97.3" width="9.4" height="6.7" />
                    <rect className="bar-bad" x="613.3" y="103.6" width="9.4" height="0.4" />
                    <rect className="bar" x="624.7" y="96.2" width="9.4" height="7.8" />
                    <rect className="bar-bad" x="624.7" y="103.6" width="9.4" height="0.4" />
                    <rect className="bar" x="636.1" y="92.4" width="9.4" height="11.6" />
                    <rect className="bar-bad" x="636.1" y="103.4" width="9.4" height="0.6" />
                    <rect className="bar" x="647.4" y="95" width="9.4" height="9" />
                    <rect className="bar-bad" x="647.4" y="103.5" width="9.4" height="0.5" />
                    <rect className="bar" x="658.8" y="92.3" width="9.4" height="11.7" />
                    <rect className="bar-bad" x="658.8" y="103.4" width="9.4" height="0.6" />
                    <rect className="bar" x="670.2" y="95.7" width="9.4" height="8.3" />
                    <rect className="bar-bad" x="670.2" y="103.6" width="9.4" height="0.4" />
                    <rect className="bar" x="681.5" y="97.6" width="9.4" height="6.4" />
                    <rect className="bar-bad" x="681.5" y="103.7" width="9.4" height="0.3" />
                    <rect className="bar" x="692.9" y="94.6" width="9.4" height="9.4" />
                    <rect className="bar-bad" x="692.9" y="103.5" width="9.4" height="0.5" />
                    <rect className="bar" x="704.3" y="93.8" width="9.4" height="10.2" />
                    <rect className="bar-bad" x="704.3" y="103.5" width="9.4" height="0.5" />
                    <rect className="bar" x="715.6" y="96.8" width="9.4" height="7.2" />
                    <rect className="bar-bad" x="715.6" y="103.6" width="9.4" height="0.4" />
                    <text className="axis" x="44" y="122" textAnchor="middle">T+00:00</text>
                    <text className="axis" x="180.4" y="122" textAnchor="middle">T+02:00</text>
                    <text className="axis" x="316.8" y="122" textAnchor="middle">T+04:00</text>
                    <text className="axis" x="453.2" y="122" textAnchor="middle">T+06:00</text>
                    <text className="axis" x="589.6" y="122" textAnchor="middle">T+08:00</text>
                    <text className="axis" x="726" y="122" textAnchor="middle">T+10:00</text>
                    <line className="now" x1="196.3" y1="4" x2="196.3" y2="104" style={{ strokeWidth: "2" }} />
                    <circle cx="196.3" cy="4" r="5" style={{ fill: "var(--text)" }} />
                  </svg>
                </>
              ) : null}
              {v.tlCand ? (
                <>
                  <svg className="chart" viewBox="0 0 736 130" role="img" aria-label="타임라인. 오픈 직후 1분 동안 홀드 시도가 가장 많고 경합도 그때 몰렸다가 3분 뒤부터 줄어듭니다. 재생 위치는 오픈 뒤 2분 14초입니다. 오픈 뒤 2분부터 2분 30초까지를 골랐습니다." style={{ height: "auto" }}>
                    <line className="grid" x1="44" y1="104" x2="726" y2="104" />
                    <rect className="bar" x="45" y="7.4" width="9.4" height="96.6" />
                    <rect className="bar-bad" x="45" y="46.1" width="9.4" height="57.9" />
                    <rect className="bar" x="56.4" y="13.4" width="9.4" height="90.6" />
                    <rect className="bar-bad" x="56.4" y="54.5" width="9.4" height="49.5" />
                    <rect className="bar" x="67.7" y="17.3" width="9.4" height="86.7" />
                    <rect className="bar-bad" x="67.7" y="61" width="9.4" height="43" />
                    <rect className="bar" x="79.1" y="25.5" width="9.4" height="78.5" />
                    <rect className="bar-bad" x="79.1" y="68.5" width="9.4" height="35.5" />
                    <rect className="bar" x="90.5" y="30.5" width="9.4" height="73.5" />
                    <rect className="bar-bad" x="90.5" y="73.7" width="9.4" height="30.3" />
                    <rect className="bar" x="101.8" y="34.8" width="9.4" height="69.2" />
                    <rect className="bar-bad" x="101.8" y="77.9" width="9.4" height="26.1" />
                    <rect className="bar" x="113.2" y="41.6" width="9.4" height="62.4" />
                    <rect className="bar-bad" x="113.2" y="82.5" width="9.4" height="21.5" />
                    <rect className="bar" x="124.6" y="43.9" width="9.4" height="60.1" />
                    <rect className="bar-bad" x="124.6" y="85" width="9.4" height="19" />
                    <rect className="bar" x="135.9" y="47" width="9.4" height="57" />
                    <rect className="bar-bad" x="135.9" y="87.5" width="9.4" height="16.5" />
                    <rect className="bar" x="147.3" y="49.7" width="9.4" height="54.3" />
                    <rect className="bar-bad" x="147.3" y="89.6" width="9.4" height="14.4" />
                    <rect className="bar" x="158.7" y="56.9" width="9.4" height="47.1" />
                    <rect className="bar-bad" x="158.7" y="92.5" width="9.4" height="11.5" />
                    <rect className="bar" x="170" y="58.8" width="9.4" height="45.2" />
                    <rect className="bar-bad" x="170" y="93.8" width="9.4" height="10.2" />
                    <rect className="bar" x="181.4" y="62.8" width="9.4" height="41.2" />
                    <rect className="bar-bad" x="181.4" y="95.4" width="9.4" height="8.6" />
                    <rect className="bar" x="192.8" y="61.4" width="9.4" height="42.6" />
                    <rect className="bar-bad" x="192.8" y="95.8" width="9.4" height="8.2" />
                    <rect className="bar" x="204.1" y="64.5" width="9.4" height="39.5" />
                    <rect className="bar-bad" x="204.1" y="97" width="9.4" height="7" />
                    <rect className="bar" x="215.5" y="70.4" width="9.4" height="33.6" />
                    <rect className="bar-bad" x="215.5" y="98.4" width="9.4" height="5.6" />
                    <rect className="bar" x="226.9" y="67.2" width="9.4" height="36.8" />
                    <rect className="bar-bad" x="226.9" y="98.3" width="9.4" height="5.7" />
                    <rect className="bar" x="238.2" y="69.2" width="9.4" height="34.8" />
                    <rect className="bar-bad" x="238.2" y="99" width="9.4" height="5" />
                    <rect className="bar" x="249.6" y="72.8" width="9.4" height="31.2" />
                    <rect className="bar-bad" x="249.6" y="99.8" width="9.4" height="4.2" />
                    <rect className="bar" x="261" y="74.7" width="9.4" height="29.3" />
                    <rect className="bar-bad" x="261" y="100.3" width="9.4" height="3.7" />
                    <rect className="bar" x="272.3" y="78.8" width="9.4" height="25.2" />
                    <rect className="bar-bad" x="272.3" y="101" width="9.4" height="3" />
                    <rect className="bar" x="283.7" y="81" width="9.4" height="23" />
                    <rect className="bar-bad" x="283.7" y="101.4" width="9.4" height="2.6" />
                    <rect className="bar" x="295.1" y="79.5" width="9.4" height="24.5" />
                    <rect className="bar-bad" x="295.1" y="101.4" width="9.4" height="2.6" />
                    <rect className="bar" x="306.4" y="83.3" width="9.4" height="20.7" />
                    <rect className="bar-bad" x="306.4" y="101.9" width="9.4" height="2.1" />
                    <rect className="bar" x="317.8" y="83.7" width="9.4" height="20.3" />
                    <rect className="bar-bad" x="317.8" y="102.1" width="9.4" height="1.9" />
                    <rect className="bar" x="329.2" y="84.5" width="9.4" height="19.5" />
                    <rect className="bar-bad" x="329.2" y="102.2" width="9.4" height="1.8" />
                    <rect className="bar" x="340.5" y="86.7" width="9.4" height="17.3" />
                    <rect className="bar-bad" x="340.5" y="102.5" width="9.4" height="1.5" />
                    <rect className="bar" x="351.9" y="85.1" width="9.4" height="18.9" />
                    <rect className="bar-bad" x="351.9" y="102.4" width="9.4" height="1.6" />
                    <rect className="bar" x="363.3" y="86.1" width="9.4" height="17.9" />
                    <rect className="bar-bad" x="363.3" y="102.6" width="9.4" height="1.4" />
                    <rect className="bar" x="374.6" y="84.6" width="9.4" height="19.4" />
                    <rect className="bar-bad" x="374.6" y="102.5" width="9.4" height="1.5" />
                    <rect className="bar" x="386" y="87.2" width="9.4" height="16.8" />
                    <rect className="bar-bad" x="386" y="102.8" width="9.4" height="1.2" />
                    <rect className="bar" x="397.4" y="87.2" width="9.4" height="16.8" />
                    <rect className="bar-bad" x="397.4" y="102.8" width="9.4" height="1.2" />
                    <rect className="bar" x="408.7" y="88.6" width="9.4" height="15.4" />
                    <rect className="bar-bad" x="408.7" y="102.9" width="9.4" height="1.1" />
                    <rect className="bar" x="420.1" y="88.2" width="9.4" height="15.8" />
                    <rect className="bar-bad" x="420.1" y="102.9" width="9.4" height="1.1" />
                    <rect className="bar" x="431.5" y="89.9" width="9.4" height="14.1" />
                    <rect className="bar-bad" x="431.5" y="103.1" width="9.4" height="0.9" />
                    <rect className="bar" x="442.8" y="91.4" width="9.4" height="12.6" />
                    <rect className="bar-bad" x="442.8" y="103.2" width="9.4" height="0.8" />
                    <rect className="bar" x="454.2" y="87.8" width="9.4" height="16.2" />
                    <rect className="bar-bad" x="454.2" y="103" width="9.4" height="1" />
                    <rect className="bar" x="465.6" y="88.3" width="9.4" height="15.7" />
                    <rect className="bar-bad" x="465.6" y="103" width="9.4" height="1" />
                    <rect className="bar" x="476.9" y="89.5" width="9.4" height="14.5" />
                    <rect className="bar-bad" x="476.9" y="103.1" width="9.4" height="0.9" />
                    <rect className="bar" x="488.3" y="90.7" width="9.4" height="13.3" />
                    <rect className="bar-bad" x="488.3" y="103.2" width="9.4" height="0.8" />
                    <rect className="bar" x="499.7" y="93.2" width="9.4" height="10.8" />
                    <rect className="bar-bad" x="499.7" y="103.4" width="9.4" height="0.6" />
                    <rect className="bar" x="511" y="94" width="9.4" height="10" />
                    <rect className="bar-bad" x="511" y="103.4" width="9.4" height="0.6" />
                    <rect className="bar" x="522.4" y="94" width="9.4" height="10" />
                    <rect className="bar-bad" x="522.4" y="103.4" width="9.4" height="0.6" />
                    <rect className="bar" x="533.8" y="95.5" width="9.4" height="8.5" />
                    <rect className="bar-bad" x="533.8" y="103.5" width="9.4" height="0.5" />
                    <rect className="bar" x="545.1" y="91.8" width="9.4" height="12.2" />
                    <rect className="bar-bad" x="545.1" y="103.3" width="9.4" height="0.7" />
                    <rect className="bar" x="556.5" y="94.1" width="9.4" height="9.9" />
                    <rect className="bar-bad" x="556.5" y="103.5" width="9.4" height="0.5" />
                    <rect className="bar" x="567.9" y="91.8" width="9.4" height="12.2" />
                    <rect className="bar-bad" x="567.9" y="103.3" width="9.4" height="0.7" />
                    <rect className="bar" x="579.2" y="94.6" width="9.4" height="9.4" />
                    <rect className="bar-bad" x="579.2" y="103.5" width="9.4" height="0.5" />
                    <rect className="bar" x="590.6" y="91.5" width="9.4" height="12.5" />
                    <rect className="bar-bad" x="590.6" y="103.3" width="9.4" height="0.7" />
                    <rect className="bar" x="602" y="92.3" width="9.4" height="11.7" />
                    <rect className="bar-bad" x="602" y="103.4" width="9.4" height="0.6" />
                    <rect className="bar" x="613.3" y="97.3" width="9.4" height="6.7" />
                    <rect className="bar-bad" x="613.3" y="103.6" width="9.4" height="0.4" />
                    <rect className="bar" x="624.7" y="96.2" width="9.4" height="7.8" />
                    <rect className="bar-bad" x="624.7" y="103.6" width="9.4" height="0.4" />
                    <rect className="bar" x="636.1" y="92.4" width="9.4" height="11.6" />
                    <rect className="bar-bad" x="636.1" y="103.4" width="9.4" height="0.6" />
                    <rect className="bar" x="647.4" y="95" width="9.4" height="9" />
                    <rect className="bar-bad" x="647.4" y="103.5" width="9.4" height="0.5" />
                    <rect className="bar" x="658.8" y="92.3" width="9.4" height="11.7" />
                    <rect className="bar-bad" x="658.8" y="103.4" width="9.4" height="0.6" />
                    <rect className="bar" x="670.2" y="95.7" width="9.4" height="8.3" />
                    <rect className="bar-bad" x="670.2" y="103.6" width="9.4" height="0.4" />
                    <rect className="bar" x="681.5" y="97.6" width="9.4" height="6.4" />
                    <rect className="bar-bad" x="681.5" y="103.7" width="9.4" height="0.3" />
                    <rect className="bar" x="692.9" y="94.6" width="9.4" height="9.4" />
                    <rect className="bar-bad" x="692.9" y="103.5" width="9.4" height="0.5" />
                    <rect className="bar" x="704.3" y="93.8" width="9.4" height="10.2" />
                    <rect className="bar-bad" x="704.3" y="103.5" width="9.4" height="0.5" />
                    <rect className="bar" x="715.6" y="96.8" width="9.4" height="7.2" />
                    <rect className="bar-bad" x="715.6" y="103.6" width="9.4" height="0.4" />
                    <text className="axis" x="44" y="122" textAnchor="middle">T+00:00</text>
                    <text className="axis" x="180.4" y="122" textAnchor="middle">T+02:00</text>
                    <text className="axis" x="316.8" y="122" textAnchor="middle">T+04:00</text>
                    <text className="axis" x="453.2" y="122" textAnchor="middle">T+06:00</text>
                    <text className="axis" x="589.6" y="122" textAnchor="middle">T+08:00</text>
                    <text className="axis" x="726" y="122" textAnchor="middle">T+10:00</text>
                    <rect x="180.4" y="6" width="34.1" height="98" style={{ fill: "var(--primary-subtle)", opacity: ".45", stroke: "var(--link)", strokeWidth: "1.5" }} />
                    <line className="now" x1="196.3" y1="4" x2="196.3" y2="104" style={{ strokeWidth: "2" }} />
                    <circle cx="196.3" cy="4" r="5" style={{ fill: "var(--text)" }} />
                  </svg>
                </>
              ) : null}
              <p className="t-xs muted">←→ 1초 · Shift+←→ 10초 · Space 재생·일시정지 · 시작·끝 시각을 숫자로도 고를 수 있습니다</p>
            </div>
          </section>
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
                      <svg className="chart" viewBox="0 0 704 300" role="img" aria-label="봇 후보 산점도. 가로는 입장 확정에서 첫 홀드 시도까지 걸린 시간(로그 눈금), 세로는 포인터 이동 엔트로피입니다. 대부분의 세션은 1초 안팎·엔트로피 0.6 근처에 모이고, 왼쪽 아래 100ms 안·엔트로피 0.2 아래에 따로 모인 무리가 있습니다." style={{ height: "auto" }}>
                        <line className="grid" x1="44" y1="12" x2="44" y2="270" />
                        <text className="axis" x="44" y="288" textAnchor="middle">10ms</text>
                        <line className="grid" x1="260.7" y1="12" x2="260.7" y2="270" />
                        <text className="axis" x="260.7" y="288" textAnchor="middle">100ms</text>
                        <line className="grid" x1="477.3" y1="12" x2="477.3" y2="270" />
                        <text className="axis" x="477.3" y="288" textAnchor="middle">1초</text>
                        <line className="grid" x1="694" y1="12" x2="694" y2="270" />
                        <text className="axis" x="694" y="288" textAnchor="middle">10초</text>
                        <line className="grid" x1="44" y1="270" x2="694" y2="270" />
                        <text className="axis" x="38" y="274" textAnchor="end">0</text>
                        <line className="grid" x1="44" y1="141" x2="694" y2="141" />
                        <text className="axis" x="38" y="145" textAnchor="end">0.5</text>
                        <line className="grid" x1="44" y1="12" x2="694" y2="12" />
                        <text className="axis" x="38" y="16" textAnchor="end">1</text>
                        <circle cx="516" cy="91.6" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="517.8" cy="121.4" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="475.1" cy="117.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="599" cy="94.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="594.4" cy="101" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="555.4" cy="103.3" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="430.4" cy="79.1" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="562.2" cy="92" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="428.9" cy="173" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="477.5" cy="127" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="550" cy="111.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="563.1" cy="133.2" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="550.2" cy="95.8" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="491.4" cy="48" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="565.3" cy="66.8" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="493.9" cy="136.8" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="510.6" cy="113.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="569.8" cy="101.1" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="504.4" cy="144.6" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="499.9" cy="65.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="482.5" cy="101.2" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="557.4" cy="163.8" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="534.4" cy="62.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="409.3" cy="121.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="525.1" cy="139.6" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="561.7" cy="112.3" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="442.6" cy="80.1" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="572.1" cy="75.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="618.9" cy="97" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="538.7" cy="157" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="568.8" cy="132.1" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="504" cy="155.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="472.8" cy="129.2" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="609.7" cy="183.4" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="443.1" cy="101.4" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="619.1" cy="89.1" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="416.2" cy="201" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="553.2" cy="136.6" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="463.6" cy="74.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="598.3" cy="104.4" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="546.4" cy="94.4" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="628.2" cy="87.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="563" cy="90.3" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="436.4" cy="63.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="589.4" cy="90.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="411.8" cy="132.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="582.6" cy="175.5" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="520.3" cy="73.2" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="452" cy="51.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="565" cy="115.5" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="551.2" cy="86.6" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="538.8" cy="68.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="491.4" cy="125" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="594.7" cy="109.1" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="478.1" cy="75.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="620.4" cy="126.1" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="447.8" cy="114.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="522.5" cy="120.8" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="616.7" cy="147.1" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="608" cy="155.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="483.8" cy="87.2" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="600" cy="79" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="552.4" cy="104.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="540.8" cy="89.3" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="520.8" cy="100" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="566.2" cy="110" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="577.8" cy="89.6" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="653.5" cy="98.3" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="505.6" cy="123.5" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="530.7" cy="76.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="511.1" cy="96.1" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="643" cy="202.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="463.3" cy="101.2" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="555.7" cy="101.4" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="505.3" cy="86.4" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="548.6" cy="128.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="678.9" cy="97.2" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="497.9" cy="113.6" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="517.8" cy="112.3" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="366" cy="127.6" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="592.7" cy="152.2" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="527.5" cy="75.6" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="583.4" cy="56.2" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="428.3" cy="122.8" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="510.8" cy="87.5" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="597.7" cy="206.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="597.5" cy="162.3" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="572.9" cy="163.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="542.2" cy="66.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="522.4" cy="103.1" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="579.9" cy="104.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="526.1" cy="54.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="595.1" cy="120.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="698" cy="151.5" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="587" cy="119.6" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="539.5" cy="84.6" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="545" cy="87" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="438.8" cy="164.6" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="568.8" cy="144.8" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="469.2" cy="163.1" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="608.3" cy="83.1" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="620.9" cy="143.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="531.6" cy="151.2" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="578" cy="52.6" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="477.5" cy="53.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="591.4" cy="116.5" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="411.9" cy="59.2" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="525.7" cy="131.8" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="555.7" cy="95.2" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="622.4" cy="146.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="600.4" cy="56.3" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="619.6" cy="116.6" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="486.4" cy="73.2" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="538.5" cy="105.6" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="617.9" cy="119.6" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="392.2" cy="124" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="419" cy="80.5" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="550.7" cy="132.1" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="530.9" cy="80" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="536.3" cy="62.1" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="527.8" cy="72.5" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="622" cy="51.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="490.7" cy="78.3" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="417.7" cy="149.2" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="412.4" cy="71.4" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="456.8" cy="110.5" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="519.8" cy="111.1" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="495.6" cy="101.6" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="640.2" cy="108.4" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="563.7" cy="73.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="519.5" cy="155.5" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="497.8" cy="71.3" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="431.6" cy="131.6" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="592.6" cy="81.4" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="532" cy="81" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="541.6" cy="152.6" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="436.6" cy="133.1" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="587.5" cy="130.5" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="476.8" cy="137.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="438.6" cy="114.3" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="200.3" cy="246.8" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="203.6" cy="231" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="232.4" cy="233.5" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="264" cy="257.4" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="214.2" cy="230.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="250.7" cy="262.1" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="157.3" cy="250.3" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="150.9" cy="258.1" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="151" cy="241.5" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="243.4" cy="232.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="161.6" cy="239.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="227.3" cy="261.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="256.3" cy="230" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="170" cy="230.6" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="193.3" cy="248.6" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="270.2" cy="235.2" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="162.5" cy="250.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="208.5" cy="254.3" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="166.9" cy="255.1" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="235.4" cy="266.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="213.5" cy="250.4" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="143.9" cy="254.6" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="222.6" cy="247.6" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="149.9" cy="229.3" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="244" cy="229.8" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="155.1" cy="257.1" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="146.6" cy="237.3" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="176.7" cy="262.4" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="196.4" cy="232.1" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="248" cy="257.4" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="160.9" cy="231.8" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="215.7" cy="240.3" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="153.1" cy="265.2" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="231" cy="251" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="150.9" cy="231.1" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="224" cy="236.4" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="152.4" cy="234.3" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="150.2" cy="234" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="200.5" cy="254.3" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="213.4" cy="231.6" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="176.3" cy="262.4" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="210" cy="258.2" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="155.7" cy="261.2" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="148" cy="259.6" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="182.1" cy="255.6" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="240.2" cy="256.2" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="206.5" cy="260.5" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="186.6" cy="266.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="174.1" cy="266.8" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="236.8" cy="246.1" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="166.1" cy="249" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="263" cy="263.3" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="248" cy="250.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="205.9" cy="235.1" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="192.6" cy="247.8" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="230.9" cy="229.4" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="186.1" cy="235.2" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="233.4" cy="242.8" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="194.1" cy="254" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="148.6" cy="262.4" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                      </svg>
                    </>
                  ) : null}
                  {' '}
                  {v.isCand ? (
                    <>
                      <svg className="chart" viewBox="0 0 704 300" role="img" aria-label="봇 후보 산점도. 가로는 입장 확정에서 첫 홀드 시도까지 걸린 시간(로그 눈금), 세로는 포인터 이동 엔트로피입니다. 대부분의 세션은 1초 안팎·엔트로피 0.6 근처에 모이고, 왼쪽 아래 100ms 안·엔트로피 0.2 아래에 따로 모인 무리가 있습니다. 왼쪽 아래 영역을 골랐습니다." style={{ height: "auto" }}>
                        <line className="grid" x1="44" y1="12" x2="44" y2="270" />
                        <text className="axis" x="44" y="288" textAnchor="middle">10ms</text>
                        <line className="grid" x1="260.7" y1="12" x2="260.7" y2="270" />
                        <text className="axis" x="260.7" y="288" textAnchor="middle">100ms</text>
                        <line className="grid" x1="477.3" y1="12" x2="477.3" y2="270" />
                        <text className="axis" x="477.3" y="288" textAnchor="middle">1초</text>
                        <line className="grid" x1="694" y1="12" x2="694" y2="270" />
                        <text className="axis" x="694" y="288" textAnchor="middle">10초</text>
                        <line className="grid" x1="44" y1="270" x2="694" y2="270" />
                        <text className="axis" x="38" y="274" textAnchor="end">0</text>
                        <line className="grid" x1="44" y1="141" x2="694" y2="141" />
                        <text className="axis" x="38" y="145" textAnchor="end">0.5</text>
                        <line className="grid" x1="44" y1="12" x2="694" y2="12" />
                        <text className="axis" x="38" y="16" textAnchor="end">1</text>
                        <rect x="99.3" y="208.1" width="193" height="61.9" rx="3" style={{ fill: "var(--danger-subtle)", stroke: "var(--danger)", strokeWidth: "1.5", strokeDasharray: "5 3" }} />
                        <circle cx="516" cy="91.6" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="517.8" cy="121.4" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="475.1" cy="117.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="599" cy="94.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="594.4" cy="101" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="555.4" cy="103.3" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="430.4" cy="79.1" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="562.2" cy="92" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="428.9" cy="173" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="477.5" cy="127" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="550" cy="111.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="563.1" cy="133.2" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="550.2" cy="95.8" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="491.4" cy="48" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="565.3" cy="66.8" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="493.9" cy="136.8" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="510.6" cy="113.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="569.8" cy="101.1" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="504.4" cy="144.6" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="499.9" cy="65.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="482.5" cy="101.2" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="557.4" cy="163.8" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="534.4" cy="62.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="409.3" cy="121.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="525.1" cy="139.6" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="561.7" cy="112.3" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="442.6" cy="80.1" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="572.1" cy="75.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="618.9" cy="97" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="538.7" cy="157" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="568.8" cy="132.1" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="504" cy="155.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="472.8" cy="129.2" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="609.7" cy="183.4" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="443.1" cy="101.4" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="619.1" cy="89.1" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="416.2" cy="201" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="553.2" cy="136.6" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="463.6" cy="74.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="598.3" cy="104.4" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="546.4" cy="94.4" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="628.2" cy="87.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="563" cy="90.3" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="436.4" cy="63.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="589.4" cy="90.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="411.8" cy="132.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="582.6" cy="175.5" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="520.3" cy="73.2" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="452" cy="51.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="565" cy="115.5" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="551.2" cy="86.6" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="538.8" cy="68.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="491.4" cy="125" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="594.7" cy="109.1" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="478.1" cy="75.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="620.4" cy="126.1" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="447.8" cy="114.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="522.5" cy="120.8" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="616.7" cy="147.1" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="608" cy="155.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="483.8" cy="87.2" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="600" cy="79" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="552.4" cy="104.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="540.8" cy="89.3" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="520.8" cy="100" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="566.2" cy="110" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="577.8" cy="89.6" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="653.5" cy="98.3" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="505.6" cy="123.5" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="530.7" cy="76.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="511.1" cy="96.1" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="643" cy="202.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="463.3" cy="101.2" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="555.7" cy="101.4" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="505.3" cy="86.4" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="548.6" cy="128.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="678.9" cy="97.2" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="497.9" cy="113.6" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="517.8" cy="112.3" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="366" cy="127.6" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="592.7" cy="152.2" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="527.5" cy="75.6" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="583.4" cy="56.2" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="428.3" cy="122.8" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="510.8" cy="87.5" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="597.7" cy="206.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="597.5" cy="162.3" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="572.9" cy="163.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="542.2" cy="66.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="522.4" cy="103.1" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="579.9" cy="104.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="526.1" cy="54.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="595.1" cy="120.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="698" cy="151.5" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="587" cy="119.6" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="539.5" cy="84.6" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="545" cy="87" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="438.8" cy="164.6" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="568.8" cy="144.8" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="469.2" cy="163.1" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="608.3" cy="83.1" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="620.9" cy="143.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="531.6" cy="151.2" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="578" cy="52.6" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="477.5" cy="53.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="591.4" cy="116.5" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="411.9" cy="59.2" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="525.7" cy="131.8" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="555.7" cy="95.2" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="622.4" cy="146.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="600.4" cy="56.3" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="619.6" cy="116.6" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="486.4" cy="73.2" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="538.5" cy="105.6" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="617.9" cy="119.6" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="392.2" cy="124" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="419" cy="80.5" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="550.7" cy="132.1" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="530.9" cy="80" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="536.3" cy="62.1" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="527.8" cy="72.5" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="622" cy="51.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="490.7" cy="78.3" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="417.7" cy="149.2" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="412.4" cy="71.4" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="456.8" cy="110.5" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="519.8" cy="111.1" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="495.6" cy="101.6" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="640.2" cy="108.4" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="563.7" cy="73.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="519.5" cy="155.5" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="497.8" cy="71.3" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="431.6" cy="131.6" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="592.6" cy="81.4" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="532" cy="81" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="541.6" cy="152.6" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="436.6" cy="133.1" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="587.5" cy="130.5" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="476.8" cy="137.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="438.6" cy="114.3" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="200.3" cy="246.8" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                        <circle cx="203.6" cy="231" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                        <circle cx="232.4" cy="233.5" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                        <circle cx="264" cy="257.4" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                        <circle cx="214.2" cy="230.9" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                        <circle cx="250.7" cy="262.1" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                        <circle cx="157.3" cy="250.3" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                        <circle cx="150.9" cy="258.1" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                        <circle cx="151" cy="241.5" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                        <circle cx="243.4" cy="232.7" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                        <circle cx="161.6" cy="239.7" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                        <circle cx="227.3" cy="261.9" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                        <circle cx="256.3" cy="230" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                        <circle cx="170" cy="230.6" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                        <circle cx="193.3" cy="248.6" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                        <circle cx="270.2" cy="235.2" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                        <circle cx="162.5" cy="250.7" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                        <circle cx="208.5" cy="254.3" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                        <circle cx="166.9" cy="255.1" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                        <circle cx="235.4" cy="266.7" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                        <circle cx="213.5" cy="250.4" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                        <circle cx="143.9" cy="254.6" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                        <circle cx="222.6" cy="247.6" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                        <circle cx="149.9" cy="229.3" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                        <circle cx="244" cy="229.8" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                        <circle cx="155.1" cy="257.1" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                        <circle cx="146.6" cy="237.3" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                        <circle cx="176.7" cy="262.4" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                        <circle cx="196.4" cy="232.1" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                        <circle cx="248" cy="257.4" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                        <circle cx="160.9" cy="231.8" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                        <circle cx="215.7" cy="240.3" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                        <circle cx="153.1" cy="265.2" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                        <circle cx="231" cy="251" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                        <circle cx="150.9" cy="231.1" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                        <circle cx="224" cy="236.4" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                        <circle cx="152.4" cy="234.3" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                        <circle cx="150.2" cy="234" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                        <circle cx="200.5" cy="254.3" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                        <circle cx="213.4" cy="231.6" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                        <circle cx="176.3" cy="262.4" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                        <circle cx="210" cy="258.2" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                        <circle cx="155.7" cy="261.2" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                        <circle cx="148" cy="259.6" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                        <circle cx="182.1" cy="255.6" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                        <circle cx="240.2" cy="256.2" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                        <circle cx="206.5" cy="260.5" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                        <circle cx="186.6" cy="266.7" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                        <circle cx="174.1" cy="266.8" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                        <circle cx="236.8" cy="246.1" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                        <circle cx="166.1" cy="249" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                        <circle cx="263" cy="263.3" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                        <circle cx="248" cy="250.7" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                        <circle cx="205.9" cy="235.1" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                        <circle cx="192.6" cy="247.8" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                        <circle cx="230.9" cy="229.4" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                        <circle cx="186.1" cy="235.2" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                        <circle cx="233.4" cy="242.8" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                        <circle cx="194.1" cy="254" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                        <circle cx="148.6" cy="262.4" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                      </svg>
                    </>
                  ) : null}
                  {' '}
                  {v.isSport ? (
                    <>
                      <svg className="chart" viewBox="0 0 704 300" role="img" aria-label="봇 후보 산점도. 가로는 입장 확정에서 첫 홀드 시도까지 걸린 시간(로그 눈금), 세로는 포인터 이동 엔트로피입니다. 대부분의 세션은 1초 안팎·엔트로피 0.6 근처에 모이고, 왼쪽 아래 100ms 안·엔트로피 0.2 아래에 작은 무리가 있습니다." style={{ height: "auto" }}>
                        <line className="grid" x1="44" y1="12" x2="44" y2="270" />
                        <text className="axis" x="44" y="288" textAnchor="middle">10ms</text>
                        <line className="grid" x1="260.7" y1="12" x2="260.7" y2="270" />
                        <text className="axis" x="260.7" y="288" textAnchor="middle">100ms</text>
                        <line className="grid" x1="477.3" y1="12" x2="477.3" y2="270" />
                        <text className="axis" x="477.3" y="288" textAnchor="middle">1초</text>
                        <line className="grid" x1="694" y1="12" x2="694" y2="270" />
                        <text className="axis" x="694" y="288" textAnchor="middle">10초</text>
                        <line className="grid" x1="44" y1="270" x2="694" y2="270" />
                        <text className="axis" x="38" y="274" textAnchor="end">0</text>
                        <line className="grid" x1="44" y1="141" x2="694" y2="141" />
                        <text className="axis" x="38" y="145" textAnchor="end">0.5</text>
                        <line className="grid" x1="44" y1="12" x2="694" y2="12" />
                        <text className="axis" x="38" y="16" textAnchor="end">1</text>
                        <circle cx="478.1" cy="119.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="559.6" cy="134.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="475.9" cy="112.2" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="390.3" cy="60.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="583.8" cy="86.3" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="540.4" cy="77" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="585.7" cy="110.3" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="482.2" cy="133.6" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="523.4" cy="149.1" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="562.5" cy="76.2" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="441.3" cy="75" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="494.4" cy="119.2" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="508" cy="137" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="488.9" cy="111.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="441.3" cy="76.3" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="430.6" cy="116" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="534.9" cy="158" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="494.1" cy="138.8" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="453.9" cy="152.3" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="647.5" cy="60.4" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="509.2" cy="95.4" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="564" cy="83.4" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="586.9" cy="94.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="455.3" cy="83.2" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="392.7" cy="92.4" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="502.7" cy="136.8" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="597.9" cy="149.6" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="628.2" cy="122" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="571.7" cy="115.3" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="502.7" cy="17.2" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="667.8" cy="98.8" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="559.2" cy="120.5" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="610.3" cy="44.8" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="650.1" cy="128.3" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="515.2" cy="170.3" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="528.9" cy="105.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="444.4" cy="163.8" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="600.7" cy="123.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="569" cy="108.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="489.8" cy="101.8" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="570.6" cy="106" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="499.9" cy="110" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="559.2" cy="95.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="635.3" cy="96.8" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="558.6" cy="128.2" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="448.9" cy="165.1" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="533.7" cy="77.5" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="607" cy="151.5" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="453.4" cy="154.3" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="484.2" cy="123.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="489.5" cy="168.1" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="581.8" cy="99.2" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="496.7" cy="37.6" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="510" cy="57.5" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="477.2" cy="96" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="402.7" cy="110" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="498.6" cy="140.1" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="564.2" cy="83.1" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="445.5" cy="100.6" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="585.3" cy="110.3" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="655.5" cy="139.2" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="491.2" cy="101.1" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="545.2" cy="29" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="572" cy="63.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="510.4" cy="127.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="616.3" cy="100" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="603.8" cy="95.2" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="598.1" cy="117.2" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="520.6" cy="94.2" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="514.4" cy="80" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="601.5" cy="72.3" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="454.3" cy="144.5" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="567.5" cy="92.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="538.7" cy="112.2" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="454.9" cy="61.4" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="537.2" cy="84.8" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="501.5" cy="131" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="500.4" cy="79.2" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="504.7" cy="59.5" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="521.6" cy="170.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="554.9" cy="111.8" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="524" cy="17.2" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="562" cy="168.3" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="537" cy="91.4" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="511.2" cy="34.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="531.7" cy="144.6" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="477.8" cy="159.5" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="524.9" cy="93.4" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="567.2" cy="162.6" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="566.6" cy="165.8" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="472.8" cy="70.6" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="443.6" cy="52" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="598.2" cy="70.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="455.8" cy="44.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="544" cy="131.2" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="575.6" cy="107.5" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="632.2" cy="124.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="520.2" cy="133.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="547" cy="71.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="449.3" cy="120.2" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="640.1" cy="84.5" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="534.7" cy="52.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="510.6" cy="82.4" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="560.7" cy="128.4" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="407.8" cy="111.8" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="577" cy="160.8" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="535.3" cy="59.3" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="480.5" cy="104.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="544.1" cy="163.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="581.6" cy="133.6" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="561.3" cy="87.5" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="525.5" cy="166.2" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="493.5" cy="138.4" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="511.3" cy="116.5" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="624" cy="74.8" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="596.4" cy="77.6" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="520.2" cy="88.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="558.6" cy="183.2" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="517.3" cy="91.1" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="502.7" cy="105.8" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="544.4" cy="112" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="495.4" cy="111.3" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="737.4" cy="108.2" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="491.2" cy="161.2" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="544.7" cy="173.1" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="462.1" cy="143.8" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="520.1" cy="94.6" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="516.8" cy="168.3" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="524.9" cy="162" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="607" cy="83.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="636.7" cy="72.5" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="579" cy="108.5" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="411.9" cy="125.3" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="513.9" cy="126" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="525" cy="134.4" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="502.2" cy="80.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="543.9" cy="133.6" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="509.8" cy="83.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="533.7" cy="84.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="503.1" cy="94.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="529.9" cy="91.8" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="449.7" cy="137.3" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="537" cy="70.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="396.8" cy="169" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="560.4" cy="113.8" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="634.9" cy="132.2" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="537.8" cy="86.3" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="481.9" cy="110.3" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="507.9" cy="75.8" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="458.4" cy="121.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="593.7" cy="101.6" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="554.6" cy="30.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="551.5" cy="95" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="503.5" cy="88.3" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="539.2" cy="119.2" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="606.4" cy="131.1" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="528.4" cy="137.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="489" cy="112.6" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="536.5" cy="155" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="528.6" cy="78.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="557.2" cy="108.4" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="333" cy="185.3" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="575.8" cy="129" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="481.2" cy="67.2" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="424.4" cy="105" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="549.7" cy="76.3" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="578" cy="120.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="505.7" cy="146.2" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="416.8" cy="108.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="608.9" cy="118.3" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="579.4" cy="111.5" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="506.4" cy="80.1" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="435.7" cy="20" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="599.6" cy="52.3" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="513.6" cy="158.6" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="413.8" cy="104.5" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="670.1" cy="96.2" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="501.4" cy="90.5" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="639.1" cy="110" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="644" cy="98.5" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="171.3" cy="229.6" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="221.1" cy="229.3" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="147.8" cy="254.2" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="271.4" cy="266" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="180.9" cy="253.6" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="203.7" cy="241.2" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="191.2" cy="253.2" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="184.8" cy="252.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="231" cy="233.1" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="213" cy="256.6" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="267.2" cy="256.4" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="232.3" cy="238.8" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="207.6" cy="256.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="183.9" cy="239.3" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="267.2" cy="231.8" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="199.9" cy="242.8" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="201.8" cy="257.4" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="250.9" cy="243.6" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="184.3" cy="262" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="230.9" cy="266.6" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                      </svg>
                    </>
                  ) : null}
                  {' '}
                  {v.isMimic ? (
                    <>
                      <svg className="chart" viewBox="0 0 704 300" role="img" aria-label="봇 후보 산점도. 가로는 입장 확정에서 첫 홀드 시도까지 걸린 시간(로그 눈금), 세로는 포인터 이동 엔트로피입니다. 모든 세션이 1초 안팎·엔트로피 0.6 근처의 한 무리에 모이고 따로 떨어진 무리가 없습니다. 가운데 영역을 골랐습니다." style={{ height: "auto" }}>
                        <line className="grid" x1="44" y1="12" x2="44" y2="270" />
                        <text className="axis" x="44" y="288" textAnchor="middle">10ms</text>
                        <line className="grid" x1="260.7" y1="12" x2="260.7" y2="270" />
                        <text className="axis" x="260.7" y="288" textAnchor="middle">100ms</text>
                        <line className="grid" x1="477.3" y1="12" x2="477.3" y2="270" />
                        <text className="axis" x="477.3" y="288" textAnchor="middle">1초</text>
                        <line className="grid" x1="694" y1="12" x2="694" y2="270" />
                        <text className="axis" x="694" y="288" textAnchor="middle">10초</text>
                        <line className="grid" x1="44" y1="270" x2="694" y2="270" />
                        <text className="axis" x="38" y="274" textAnchor="end">0</text>
                        <line className="grid" x1="44" y1="141" x2="694" y2="141" />
                        <text className="axis" x="38" y="145" textAnchor="end">0.5</text>
                        <line className="grid" x1="44" y1="12" x2="694" y2="12" />
                        <text className="axis" x="38" y="16" textAnchor="end">1</text>
                        <rect x="477.3" y="63.6" width="103.4" height="64.5" rx="3" style={{ fill: "var(--danger-subtle)", stroke: "var(--danger)", strokeWidth: "1.5", strokeDasharray: "5 3" }} />
                        <circle cx="551.6" cy="111.7" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                        <circle cx="520.9" cy="151.1" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="589.4" cy="123.3" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="562.7" cy="120.4" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                        <circle cx="594.1" cy="111.3" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="554.3" cy="79.6" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                        <circle cx="520.6" cy="117" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                        <circle cx="524.6" cy="106.5" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                        <circle cx="565.1" cy="100.7" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                        <circle cx="537.4" cy="81.3" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                        <circle cx="542.6" cy="146.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="612.6" cy="170.4" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="648.1" cy="163.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="451.1" cy="134.8" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="587.4" cy="140.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="577.6" cy="75.9" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                        <circle cx="494" cy="114.3" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                        <circle cx="563.9" cy="97.3" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                        <circle cx="495.5" cy="172.5" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="496.1" cy="141.8" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="537" cy="109.4" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                        <circle cx="489.6" cy="146.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="495.6" cy="104.1" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                        <circle cx="558.8" cy="94.1" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                        <circle cx="588.2" cy="74.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="504.4" cy="67" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                        <circle cx="462.5" cy="90.5" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="527.7" cy="172.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="622.1" cy="36.1" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="599.3" cy="163.4" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="388.5" cy="84.1" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="548.6" cy="134.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="485.9" cy="174.8" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="533.9" cy="187.5" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="442.5" cy="119.8" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="611.1" cy="85.5" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="590.6" cy="64" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="579.3" cy="130.1" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="547.8" cy="105.5" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                        <circle cx="496.4" cy="112.2" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                        <circle cx="525.8" cy="159.5" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="441" cy="110.1" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="570.7" cy="77.6" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                        <circle cx="604.7" cy="97" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="541" cy="130.2" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="458.3" cy="217.2" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="513" cy="87.9" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                        <circle cx="529.8" cy="41.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="623.3" cy="79.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="524.1" cy="49.5" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="620.8" cy="155.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="558.7" cy="67.5" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                        <circle cx="481.1" cy="42.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="521.2" cy="88.9" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                        <circle cx="510.1" cy="101.5" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                        <circle cx="547.6" cy="54.6" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="513.5" cy="89.6" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                        <circle cx="574.8" cy="121.2" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                        <circle cx="557.5" cy="162.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="449.2" cy="128.1" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="429.8" cy="143.8" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="514.9" cy="136.8" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="491.2" cy="145.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="558.2" cy="118.4" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                        <circle cx="380.3" cy="82" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="620.6" cy="86" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="598.7" cy="139.2" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="629.8" cy="88.1" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="525.4" cy="66.5" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                        <circle cx="553" cy="138.6" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="532.6" cy="92.1" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                        <circle cx="516" cy="96" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                        <circle cx="492.6" cy="173.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="601.3" cy="94.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="559" cy="170.5" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="524.5" cy="65.8" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                        <circle cx="501.2" cy="149.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="664.8" cy="110.5" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="562.2" cy="114" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                        <circle cx="611.5" cy="102.6" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="489.6" cy="123.5" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                        <circle cx="535.9" cy="46.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="534.4" cy="115.7" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                        <circle cx="600.8" cy="69.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="500.5" cy="100.3" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                        <circle cx="583" cy="120.2" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="586.7" cy="92.6" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="458.9" cy="81" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="533.9" cy="124.9" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                        <circle cx="402.8" cy="96.2" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="405.1" cy="103.6" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="620.3" cy="148.3" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="514.4" cy="124.2" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                        <circle cx="582.6" cy="113.3" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="506.7" cy="69.9" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                        <circle cx="429.9" cy="123.6" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="398.9" cy="130.1" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="551.1" cy="160.8" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="518.1" cy="59.3" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="429.2" cy="110.4" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="515" cy="46.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="522.7" cy="132.1" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="596.2" cy="125.8" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="480.2" cy="98.2" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                        <circle cx="448.9" cy="67.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="591.8" cy="129.1" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="464.6" cy="118.2" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="622.9" cy="57.4" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="519.1" cy="106" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                        <circle cx="536.9" cy="79.7" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                        <circle cx="540" cy="132.1" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="603.8" cy="44.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="483.7" cy="31.5" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="557.7" cy="109" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                        <circle cx="546.4" cy="75.2" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                        <circle cx="478.9" cy="117.8" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                        <circle cx="673.5" cy="129.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="370.6" cy="153.6" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="638.1" cy="185.1" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="506.8" cy="118.9" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                        <circle cx="514" cy="114.7" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                        <circle cx="367" cy="47.2" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="458.7" cy="76.3" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="622.3" cy="127.3" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="477.6" cy="80.9" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                        <circle cx="607.5" cy="66.1" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="499.4" cy="135.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="423.2" cy="81" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="572.2" cy="102.3" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                        <circle cx="456.9" cy="155.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="448.7" cy="123.1" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="610.2" cy="107.1" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="509.2" cy="114.8" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                        <circle cx="485.8" cy="115.1" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                        <circle cx="471" cy="57.2" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="536.5" cy="114.9" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                        <circle cx="605.4" cy="83.5" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="607.7" cy="133.6" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="477.2" cy="59.8" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="550.4" cy="117.1" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                        <circle cx="594.9" cy="101.3" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="514.5" cy="152.8" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="496.2" cy="107" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                        <circle cx="540.7" cy="100.8" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                        <circle cx="485.2" cy="104" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                        <circle cx="471.9" cy="129.8" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="487.4" cy="54.6" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="496.4" cy="75.7" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                        <circle cx="440.9" cy="94.8" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="630.4" cy="117.2" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="632.7" cy="109.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="445.8" cy="117.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="541.8" cy="108.8" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                        <circle cx="561.7" cy="108.3" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                        <circle cx="603.5" cy="72.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="537.1" cy="146.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="545.4" cy="72.1" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                        <circle cx="565.6" cy="92" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                        <circle cx="410.2" cy="84.1" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="527.2" cy="127.6" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                        <circle cx="581.7" cy="206" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="559.7" cy="124.2" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                        <circle cx="406" cy="155.2" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="529.9" cy="62.8" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="426.4" cy="177.1" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="562.8" cy="146.1" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="497.2" cy="123.4" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                        <circle cx="551.1" cy="134.3" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="514.2" cy="127.2" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                        <circle cx="514.7" cy="174.8" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="579.3" cy="86.6" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                        <circle cx="571.3" cy="72.9" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                        <circle cx="544.9" cy="26.2" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="542.3" cy="121.3" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                        <circle cx="533.1" cy="81.7" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                        <circle cx="581.3" cy="75" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="518.7" cy="151.3" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="494.6" cy="111.3" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                        <circle cx="418.8" cy="91.4" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="569.6" cy="97.8" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                        <circle cx="460.9" cy="115.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="566.1" cy="53.1" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="601" cy="114.2" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="674.5" cy="116" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="531.5" cy="140.4" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="397.5" cy="141.1" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="571.1" cy="143.5" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="532.7" cy="82.2" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                        <circle cx="447.1" cy="70.1" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="469.3" cy="87.1" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="552.9" cy="73.3" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                        <circle cx="542" cy="100.5" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                        <circle cx="551.1" cy="66.4" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                        <circle cx="473.3" cy="159.5" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="459.6" cy="76.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                        <circle cx="547" cy="114.7" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                        <circle cx="490.3" cy="118.4" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                        <circle cx="564.5" cy="115.2" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                        <circle cx="504.9" cy="79.6" r="3" style={{ fill: "var(--danger)", stroke: "var(--surface)", strokeWidth: "1" }} />
                        <circle cx="534.5" cy="164.2" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                      </svg>
                    </>
                  ) : null}
                </>
              ) : null}
              {' '}
              {v.isFallback ? (
                <>
                  <svg className="chart" viewBox="0 0 704 300" role="img" aria-label="봇 후보 산점도. 가로는 입장 확정에서 첫 홀드 시도까지 걸린 시간(로그 눈금), 세로는 포인터 이동 엔트로피입니다. 대부분의 세션은 1초 안팎·엔트로피 0.6 근처에 모이고, 왼쪽 아래 100ms 안·엔트로피 0.2 아래에 따로 모인 무리가 있습니다." style={{ height: "auto" }}>
                    <line className="grid" x1="44" y1="12" x2="44" y2="270" />
                    <text className="axis" x="44" y="288" textAnchor="middle">10ms</text>
                    <line className="grid" x1="260.7" y1="12" x2="260.7" y2="270" />
                    <text className="axis" x="260.7" y="288" textAnchor="middle">100ms</text>
                    <line className="grid" x1="477.3" y1="12" x2="477.3" y2="270" />
                    <text className="axis" x="477.3" y="288" textAnchor="middle">1초</text>
                    <line className="grid" x1="694" y1="12" x2="694" y2="270" />
                    <text className="axis" x="694" y="288" textAnchor="middle">10초</text>
                    <line className="grid" x1="44" y1="270" x2="694" y2="270" />
                    <text className="axis" x="38" y="274" textAnchor="end">0</text>
                    <line className="grid" x1="44" y1="141" x2="694" y2="141" />
                    <text className="axis" x="38" y="145" textAnchor="end">0.5</text>
                    <line className="grid" x1="44" y1="12" x2="694" y2="12" />
                    <text className="axis" x="38" y="16" textAnchor="end">1</text>
                    <circle cx="516" cy="91.6" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                    <circle cx="517.8" cy="121.4" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                    <circle cx="475.1" cy="117.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                    <circle cx="599" cy="94.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                    <circle cx="594.4" cy="101" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                    <circle cx="555.4" cy="103.3" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                    <circle cx="430.4" cy="79.1" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                    <circle cx="562.2" cy="92" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                    <circle cx="428.9" cy="173" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                    <circle cx="477.5" cy="127" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                    <circle cx="550" cy="111.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                    <circle cx="563.1" cy="133.2" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                    <circle cx="550.2" cy="95.8" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                    <circle cx="491.4" cy="48" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                    <circle cx="565.3" cy="66.8" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                    <circle cx="493.9" cy="136.8" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                    <circle cx="510.6" cy="113.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                    <circle cx="569.8" cy="101.1" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                    <circle cx="504.4" cy="144.6" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                    <circle cx="499.9" cy="65.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                    <circle cx="482.5" cy="101.2" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                    <circle cx="557.4" cy="163.8" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                    <circle cx="534.4" cy="62.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                    <circle cx="409.3" cy="121.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                    <circle cx="525.1" cy="139.6" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                    <circle cx="561.7" cy="112.3" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                    <circle cx="442.6" cy="80.1" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                    <circle cx="572.1" cy="75.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                    <circle cx="618.9" cy="97" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                    <circle cx="538.7" cy="157" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                    <circle cx="568.8" cy="132.1" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                    <circle cx="504" cy="155.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                    <circle cx="472.8" cy="129.2" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                    <circle cx="609.7" cy="183.4" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                    <circle cx="443.1" cy="101.4" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                    <circle cx="619.1" cy="89.1" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                    <circle cx="416.2" cy="201" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                    <circle cx="553.2" cy="136.6" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                    <circle cx="463.6" cy="74.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                    <circle cx="598.3" cy="104.4" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                    <circle cx="546.4" cy="94.4" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                    <circle cx="628.2" cy="87.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                    <circle cx="563" cy="90.3" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                    <circle cx="436.4" cy="63.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                    <circle cx="589.4" cy="90.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                    <circle cx="411.8" cy="132.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                    <circle cx="582.6" cy="175.5" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                    <circle cx="520.3" cy="73.2" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                    <circle cx="452" cy="51.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                    <circle cx="565" cy="115.5" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                    <circle cx="551.2" cy="86.6" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                    <circle cx="538.8" cy="68.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                    <circle cx="491.4" cy="125" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                    <circle cx="594.7" cy="109.1" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                    <circle cx="478.1" cy="75.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                    <circle cx="620.4" cy="126.1" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                    <circle cx="447.8" cy="114.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                    <circle cx="522.5" cy="120.8" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                    <circle cx="616.7" cy="147.1" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                    <circle cx="608" cy="155.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                    <circle cx="483.8" cy="87.2" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                    <circle cx="600" cy="79" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                    <circle cx="552.4" cy="104.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                    <circle cx="540.8" cy="89.3" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                    <circle cx="520.8" cy="100" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                    <circle cx="566.2" cy="110" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                    <circle cx="577.8" cy="89.6" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                    <circle cx="653.5" cy="98.3" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                    <circle cx="505.6" cy="123.5" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                    <circle cx="530.7" cy="76.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                    <circle cx="188.8" cy="262.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                    <circle cx="251.9" cy="229" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                    <circle cx="202.1" cy="248.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                    <circle cx="152.7" cy="263.5" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                    <circle cx="186" cy="257.2" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                    <circle cx="249.3" cy="261.2" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                    <circle cx="144.5" cy="230.6" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                    <circle cx="210.2" cy="261.7" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                    <circle cx="212.1" cy="266.4" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                    <circle cx="210.2" cy="229.6" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                    <circle cx="253.7" cy="240.5" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                    <circle cx="175.4" cy="253.2" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                    <circle cx="163.2" cy="237.5" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                    <circle cx="210.7" cy="237.3" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                    <circle cx="184.4" cy="258.8" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                    <circle cx="247" cy="229.3" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                    <circle cx="252.3" cy="236.2" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                    <circle cx="247.9" cy="238.8" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                    <circle cx="171" cy="247.4" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                    <circle cx="187.7" cy="266.3" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                    <circle cx="145.1" cy="256.6" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                    <circle cx="175.2" cy="240.6" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                    <circle cx="265.8" cy="250.1" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                    <circle cx="263.3" cy="229.2" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                    <circle cx="265.7" cy="253.3" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                    <circle cx="170.2" cy="258.6" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                    <circle cx="167.1" cy="259.5" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                    <circle cx="222.6" cy="232.6" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                    <circle cx="250.8" cy="248.9" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
                    <circle cx="226.4" cy="236.5" r="2.4" style={{ fill: "var(--text-muted)", opacity: ".55" }} />
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
