// 디자인 캔버스 보드 SCR-069-m.dc.html를 옮긴 것(dc2tsx 생성 뒤 손질). 재생·정지·배속·시나리오 단추만 controls.tsx로 잇는다
/* eslint-disable */
import { Fragment, type FormEvent } from 'react';

import { CONSOLE_ORIGIN } from '../lib/origins';
import { Overlay } from '../shared/Overlay';
import { useReplay } from './controls';

const prevent = (e: FormEvent) => e.preventDefault();
void Fragment;


type AriaBool = boolean | 'true' | 'false';
type AriaCurrent = boolean | 'true' | 'false' | 'page' | 'step' | 'location' | 'date' | 'time';


export const STATES_M = ["재생", "만드는 중", "돌릴 수 없음", "사건 일부 버림", "일시정지", "시나리오 고르기", "스포츠 플레이오프 오픈", "권한 없음(2단계)"] as const;
export const DEFAULT_M = "재생";

export function valsM(state: string) {
    let st = state || '재생';
    let cand = false; // 휴대폰에는 봇 후보 자리가 없다(d5 §7.17 sm)
    let gen = st === '만드는 중';
    let reject = false; // 휴대폰 머리에는 파일 불러오기가 없다
    let copy = false;
    let fallback = false;
    let cant = st === '돌릴 수 없음';
    let drop = st === '사건 일부 버림';
    let pause = st === '일시정지';
    let pick = st === '시나리오 고르기';
    let sport = st === '스포츠 플레이오프 오픈';
    let mimic = false;
    let deny = st === '권한 없음(2단계)';
    let conc = !sport && !mimic;
    return {
      isCand: cand,
      notCand: !cand,
      mapConc: !cand && conc,
      statBase: !cand && conc,
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
      isDeny: deny,
      stage1: !deny,
      isGen: gen,
      isReject: reject,
      isCopy: copy,
      notCopy: !copy,
      isFallback: fallback,
      fullScatter: !fallback,
      isCant: cant,
      isDrop: drop,
      showMain: !cant && !deny,
      showMap: !reject,
      showStats: !reject,
      playing: st === '재생' || copy || fallback || gen || drop || pick || sport,
      paused: cand || reject || pause || mimic
    };
  }

type V = ReturnType<typeof valsM>;

// 보드 루트: {"class": "pk dark", "style": "width:360px;min-height:1360px;display:flex;flex-direction:column;background:var(--surface-basement);position:relative"}

// <header class="cs-bar" style="flex-wrap:wrap;white-space:normal;gap:8px">
export function BarM({ v, close }: { v: V; close?: () => void }) {
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
    {v.stage1 ? (
      <>
        <span className="badge badge-warning">합성 데이터</span>
      </>
    ) : null}
    {' '}
    {v.stage1 ? (
      <>
        <div className="row" style={{ gap: "6px", width: "100%" }}>
          <span style={{ position: "relative", display: "flex", flex: "1 1 0", minWidth: "0" }}>
            <button className="chip chip-sm grow" type="button" aria-haspopup="listbox" aria-expanded={(v.pickExp) as AriaBool} aria-controls={v.isPick ? "fx-sc-list" : undefined} onClick={ctl.togglePick} style={{ justifyContent: "space-between", flex: "1 1 0", minWidth: "0", gap: "4px" }}>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
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
              </span>
              <i className="ic ic-chevron-down" aria-hidden="true" />
            </button>
            {v.isPick ? (
              <>
                <ul className="menu" role="listbox" id="fx-sc-list" aria-label="시나리오" style={{ position: "absolute", top: "calc(100% + 6px)", left: "0", zIndex: "120", width: "100%", minWidth: "0" }}>
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
          <button className="icon-btn icon-btn-outline" type="button" aria-label="같은 프리셋으로 다시 만들기" onClick={ctl.regenerate}>
            <i className="ic ic-refresh" aria-hidden="true" />
          </button>
          <button className="icon-btn icon-btn-outline" type="button" aria-label="공유 주소 복사"><i className="ic ic-link" aria-hidden="true" /></button>
        </div>
      </>
    ) : null}
    {' '}
    {v.isDeny ? (
      <>
        <a href={`${CONSOLE_ORIGIN}/dashboard`} className="link-more" style={{ marginLeft: "auto" }}>
          관제 콘솔
          <i className="ic ic-chevron-right" aria-hidden="true" />
        </a>
      </>
    ) : null}
    </>
  );
}

export function OverlaysM({ v, close }: { v: V; close?: () => void }) {
  void v; void close;
  const ctl = useReplay();
  void ctl;
  return (
    <>
    {v.isDrop ? (
      <>
        <div className="banner banner-warning" role="status" style={{ margin: "12px 12px 0" }}>
          <i className="ic ic-alert" aria-hidden="true" />
          <div className="banner-body">규칙에 맞지 않는 사건 12건을 빼고 보입니다</div>
        </div>
      </>
    ) : null}
    {v.showMain ? (
      <>
        <main id="main" className="col" style={{ gap: "12px", padding: "12px" }}>
          <h1 className="sr-only">포렌식 리플레이 · 합성 데이터 데모</h1>
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
              </div>
            </div>
            <div className="widget-body">
              {v.showMap ? (
                <>
                  {v.mapConc ? (
                    <>
                      <svg viewBox="0 0 880 520" role="img" aria-label="좌석 리플레이. 오픈 뒤 2분 14초의 좌석 상태입니다. 무대 앞 플로어와 아래층 가운데 구역이 거의 다 팔렸고 위층 끝 구역에 빈 좌석이 남았습니다." style={{ display: "block", width: "100%", height: "auto" }}>
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
                      </svg>
                    </>
                  ) : null}
                  {' '}
                  {v.isCand ? (
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
                </>
              ) : null}
              {' '}
              {v.isReject ? (
                <>
                  <div className="card-flat col" style={{ minHeight: "360px", alignItems: "center", justifyContent: "center", gap: "8px", textAlign: "center" }}>
                    <i className="ic ic-map ic-32 muted" aria-hidden="true" />
                    <p className="t-md fw-b">그릴 사건이 없습니다</p>
                    <p className="t-sm muted">프리셋을 고르거나 다른 파일을 불러오세요</p>
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
                  {v.anyCand ? (
                    <>
                      <li className="legend-item">
                        <span aria-hidden="true" style={{ display: "inline-block", width: "12px", height: "12px", borderRadius: "50%", border: "2px solid var(--danger)" }} />
                        후보 세션이 잡은 좌석
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
                  {v.isCand ? (
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
                </div>
                <div className="stat">
                  <span className="stat-label">경합 패배율</span>
                  {v.statBase ? (
                    <>
                      <span className="stat-value">37.2%</span>
                      <span className="stat-meta">전체 범위</span>
                    </>
                  ) : null}
                  {v.isCand ? (
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
                </div>
                <div className="stat">
                  <span className="stat-label">홀드 → 판매</span>
                  {v.statBase ? (
                    <>
                      <span className="stat-value">61.4%</span>
                      <span className="stat-meta">전체 범위</span>
                    </>
                  ) : null}
                  {v.isCand ? (
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
                </div>
                <div className="stat">
                  <span className="stat-label">후보 비율</span>
                  {v.statBase ? (
                    <>
                      <span className="stat-value">28.9%</span>
                      <span className="stat-meta">전체 범위</span>
                    </>
                  ) : null}
                  {v.isCand ? (
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
                </div>
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
                {' '}
                <span className="mono t-sm">T+02:14.350</span>
              </div>
            </div>
            <div className="widget-body">
              {v.tlBase ? (
                <>
                  <svg className="chart" viewBox="0 0 336 130" role="img" aria-label="타임라인. 오픈 직후 1분 동안 홀드 시도가 가장 많고 경합도 그때 몰렸다가 3분 뒤부터 줄어듭니다. 재생 위치는 오픈 뒤 2분 14초입니다." style={{ height: "auto" }}>
                    <line className="grid" x1="44" y1="104" x2="326" y2="104" />
                    <rect className="bar" x="45" y="7.4" width="2.7" height="96.6" />
                    <rect className="bar-bad" x="45" y="46.1" width="2.7" height="57.9" />
                    <rect className="bar" x="49.7" y="13.4" width="2.7" height="90.6" />
                    <rect className="bar-bad" x="49.7" y="54.5" width="2.7" height="49.5" />
                    <rect className="bar" x="54.4" y="17.3" width="2.7" height="86.7" />
                    <rect className="bar-bad" x="54.4" y="61" width="2.7" height="43" />
                    <rect className="bar" x="59.1" y="25.5" width="2.7" height="78.5" />
                    <rect className="bar-bad" x="59.1" y="68.5" width="2.7" height="35.5" />
                    <rect className="bar" x="63.8" y="30.5" width="2.7" height="73.5" />
                    <rect className="bar-bad" x="63.8" y="73.7" width="2.7" height="30.3" />
                    <rect className="bar" x="68.5" y="34.8" width="2.7" height="69.2" />
                    <rect className="bar-bad" x="68.5" y="77.9" width="2.7" height="26.1" />
                    <rect className="bar" x="73.2" y="41.6" width="2.7" height="62.4" />
                    <rect className="bar-bad" x="73.2" y="82.5" width="2.7" height="21.5" />
                    <rect className="bar" x="77.9" y="43.9" width="2.7" height="60.1" />
                    <rect className="bar-bad" x="77.9" y="85" width="2.7" height="19" />
                    <rect className="bar" x="82.6" y="47" width="2.7" height="57" />
                    <rect className="bar-bad" x="82.6" y="87.5" width="2.7" height="16.5" />
                    <rect className="bar" x="87.3" y="49.7" width="2.7" height="54.3" />
                    <rect className="bar-bad" x="87.3" y="89.6" width="2.7" height="14.4" />
                    <rect className="bar" x="92" y="56.9" width="2.7" height="47.1" />
                    <rect className="bar-bad" x="92" y="92.5" width="2.7" height="11.5" />
                    <rect className="bar" x="96.7" y="58.8" width="2.7" height="45.2" />
                    <rect className="bar-bad" x="96.7" y="93.8" width="2.7" height="10.2" />
                    <rect className="bar" x="101.4" y="62.8" width="2.7" height="41.2" />
                    <rect className="bar-bad" x="101.4" y="95.4" width="2.7" height="8.6" />
                    <rect className="bar" x="106.1" y="61.4" width="2.7" height="42.6" />
                    <rect className="bar-bad" x="106.1" y="95.8" width="2.7" height="8.2" />
                    <rect className="bar" x="110.8" y="64.5" width="2.7" height="39.5" />
                    <rect className="bar-bad" x="110.8" y="97" width="2.7" height="7" />
                    <rect className="bar" x="115.5" y="70.4" width="2.7" height="33.6" />
                    <rect className="bar-bad" x="115.5" y="98.4" width="2.7" height="5.6" />
                    <rect className="bar" x="120.2" y="67.2" width="2.7" height="36.8" />
                    <rect className="bar-bad" x="120.2" y="98.3" width="2.7" height="5.7" />
                    <rect className="bar" x="124.9" y="69.2" width="2.7" height="34.8" />
                    <rect className="bar-bad" x="124.9" y="99" width="2.7" height="5" />
                    <rect className="bar" x="129.6" y="72.8" width="2.7" height="31.2" />
                    <rect className="bar-bad" x="129.6" y="99.8" width="2.7" height="4.2" />
                    <rect className="bar" x="134.3" y="74.7" width="2.7" height="29.3" />
                    <rect className="bar-bad" x="134.3" y="100.3" width="2.7" height="3.7" />
                    <rect className="bar" x="139" y="78.8" width="2.7" height="25.2" />
                    <rect className="bar-bad" x="139" y="101" width="2.7" height="3" />
                    <rect className="bar" x="143.7" y="81" width="2.7" height="23" />
                    <rect className="bar-bad" x="143.7" y="101.4" width="2.7" height="2.6" />
                    <rect className="bar" x="148.4" y="79.5" width="2.7" height="24.5" />
                    <rect className="bar-bad" x="148.4" y="101.4" width="2.7" height="2.6" />
                    <rect className="bar" x="153.1" y="83.3" width="2.7" height="20.7" />
                    <rect className="bar-bad" x="153.1" y="101.9" width="2.7" height="2.1" />
                    <rect className="bar" x="157.8" y="83.7" width="2.7" height="20.3" />
                    <rect className="bar-bad" x="157.8" y="102.1" width="2.7" height="1.9" />
                    <rect className="bar" x="162.5" y="84.5" width="2.7" height="19.5" />
                    <rect className="bar-bad" x="162.5" y="102.2" width="2.7" height="1.8" />
                    <rect className="bar" x="167.2" y="86.7" width="2.7" height="17.3" />
                    <rect className="bar-bad" x="167.2" y="102.5" width="2.7" height="1.5" />
                    <rect className="bar" x="171.9" y="85.1" width="2.7" height="18.9" />
                    <rect className="bar-bad" x="171.9" y="102.4" width="2.7" height="1.6" />
                    <rect className="bar" x="176.6" y="86.1" width="2.7" height="17.9" />
                    <rect className="bar-bad" x="176.6" y="102.6" width="2.7" height="1.4" />
                    <rect className="bar" x="181.3" y="84.6" width="2.7" height="19.4" />
                    <rect className="bar-bad" x="181.3" y="102.5" width="2.7" height="1.5" />
                    <rect className="bar" x="186" y="87.2" width="2.7" height="16.8" />
                    <rect className="bar-bad" x="186" y="102.8" width="2.7" height="1.2" />
                    <rect className="bar" x="190.7" y="87.2" width="2.7" height="16.8" />
                    <rect className="bar-bad" x="190.7" y="102.8" width="2.7" height="1.2" />
                    <rect className="bar" x="195.4" y="88.6" width="2.7" height="15.4" />
                    <rect className="bar-bad" x="195.4" y="102.9" width="2.7" height="1.1" />
                    <rect className="bar" x="200.1" y="88.2" width="2.7" height="15.8" />
                    <rect className="bar-bad" x="200.1" y="102.9" width="2.7" height="1.1" />
                    <rect className="bar" x="204.8" y="89.9" width="2.7" height="14.1" />
                    <rect className="bar-bad" x="204.8" y="103.1" width="2.7" height="0.9" />
                    <rect className="bar" x="209.5" y="91.4" width="2.7" height="12.6" />
                    <rect className="bar-bad" x="209.5" y="103.2" width="2.7" height="0.8" />
                    <rect className="bar" x="214.2" y="87.8" width="2.7" height="16.2" />
                    <rect className="bar-bad" x="214.2" y="103" width="2.7" height="1" />
                    <rect className="bar" x="218.9" y="88.3" width="2.7" height="15.7" />
                    <rect className="bar-bad" x="218.9" y="103" width="2.7" height="1" />
                    <rect className="bar" x="223.6" y="89.5" width="2.7" height="14.5" />
                    <rect className="bar-bad" x="223.6" y="103.1" width="2.7" height="0.9" />
                    <rect className="bar" x="228.3" y="90.7" width="2.7" height="13.3" />
                    <rect className="bar-bad" x="228.3" y="103.2" width="2.7" height="0.8" />
                    <rect className="bar" x="233" y="93.2" width="2.7" height="10.8" />
                    <rect className="bar-bad" x="233" y="103.4" width="2.7" height="0.6" />
                    <rect className="bar" x="237.7" y="94" width="2.7" height="10" />
                    <rect className="bar-bad" x="237.7" y="103.4" width="2.7" height="0.6" />
                    <rect className="bar" x="242.4" y="94" width="2.7" height="10" />
                    <rect className="bar-bad" x="242.4" y="103.4" width="2.7" height="0.6" />
                    <rect className="bar" x="247.1" y="95.5" width="2.7" height="8.5" />
                    <rect className="bar-bad" x="247.1" y="103.5" width="2.7" height="0.5" />
                    <rect className="bar" x="251.8" y="91.8" width="2.7" height="12.2" />
                    <rect className="bar-bad" x="251.8" y="103.3" width="2.7" height="0.7" />
                    <rect className="bar" x="256.5" y="94.1" width="2.7" height="9.9" />
                    <rect className="bar-bad" x="256.5" y="103.5" width="2.7" height="0.5" />
                    <rect className="bar" x="261.2" y="91.8" width="2.7" height="12.2" />
                    <rect className="bar-bad" x="261.2" y="103.3" width="2.7" height="0.7" />
                    <rect className="bar" x="265.9" y="94.6" width="2.7" height="9.4" />
                    <rect className="bar-bad" x="265.9" y="103.5" width="2.7" height="0.5" />
                    <rect className="bar" x="270.6" y="91.5" width="2.7" height="12.5" />
                    <rect className="bar-bad" x="270.6" y="103.3" width="2.7" height="0.7" />
                    <rect className="bar" x="275.3" y="92.3" width="2.7" height="11.7" />
                    <rect className="bar-bad" x="275.3" y="103.4" width="2.7" height="0.6" />
                    <rect className="bar" x="280" y="97.3" width="2.7" height="6.7" />
                    <rect className="bar-bad" x="280" y="103.6" width="2.7" height="0.4" />
                    <rect className="bar" x="284.7" y="96.2" width="2.7" height="7.8" />
                    <rect className="bar-bad" x="284.7" y="103.6" width="2.7" height="0.4" />
                    <rect className="bar" x="289.4" y="92.4" width="2.7" height="11.6" />
                    <rect className="bar-bad" x="289.4" y="103.4" width="2.7" height="0.6" />
                    <rect className="bar" x="294.1" y="95" width="2.7" height="9" />
                    <rect className="bar-bad" x="294.1" y="103.5" width="2.7" height="0.5" />
                    <rect className="bar" x="298.8" y="92.3" width="2.7" height="11.7" />
                    <rect className="bar-bad" x="298.8" y="103.4" width="2.7" height="0.6" />
                    <rect className="bar" x="303.5" y="95.7" width="2.7" height="8.3" />
                    <rect className="bar-bad" x="303.5" y="103.6" width="2.7" height="0.4" />
                    <rect className="bar" x="308.2" y="97.6" width="2.7" height="6.4" />
                    <rect className="bar-bad" x="308.2" y="103.7" width="2.7" height="0.3" />
                    <rect className="bar" x="312.9" y="94.6" width="2.7" height="9.4" />
                    <rect className="bar-bad" x="312.9" y="103.5" width="2.7" height="0.5" />
                    <rect className="bar" x="317.6" y="93.8" width="2.7" height="10.2" />
                    <rect className="bar-bad" x="317.6" y="103.5" width="2.7" height="0.5" />
                    <rect className="bar" x="322.3" y="96.8" width="2.7" height="7.2" />
                    <rect className="bar-bad" x="322.3" y="103.6" width="2.7" height="0.4" />
                    <text className="axis" x="44" y="122" textAnchor="middle">T+00:00</text>
                    <text className="axis" x="100.4" y="122" textAnchor="middle">T+02:00</text>
                    <text className="axis" x="156.8" y="122" textAnchor="middle">T+04:00</text>
                    <text className="axis" x="213.2" y="122" textAnchor="middle">T+06:00</text>
                    <text className="axis" x="269.6" y="122" textAnchor="middle">T+08:00</text>
                    <text className="axis" x="326" y="122" textAnchor="middle">T+10:00</text>
                    <line className="now" x1="107" y1="4" x2="107" y2="104" style={{ strokeWidth: "2" }} />
                    <circle cx="107" cy="4" r="5" style={{ fill: "var(--text)" }} />
                  </svg>
                </>
              ) : null}
              {v.tlCand ? (
                <>
                  <svg className="chart" viewBox="0 0 336 130" role="img" aria-label="타임라인. 오픈 직후 1분 동안 홀드 시도가 가장 많고 경합도 그때 몰렸다가 3분 뒤부터 줄어듭니다. 재생 위치는 오픈 뒤 2분 14초입니다. 오픈 뒤 2분부터 2분 30초까지를 골랐습니다." style={{ height: "auto" }}>
                    <line className="grid" x1="44" y1="104" x2="326" y2="104" />
                    <rect className="bar" x="45" y="7.4" width="2.7" height="96.6" />
                    <rect className="bar-bad" x="45" y="46.1" width="2.7" height="57.9" />
                    <rect className="bar" x="49.7" y="13.4" width="2.7" height="90.6" />
                    <rect className="bar-bad" x="49.7" y="54.5" width="2.7" height="49.5" />
                    <rect className="bar" x="54.4" y="17.3" width="2.7" height="86.7" />
                    <rect className="bar-bad" x="54.4" y="61" width="2.7" height="43" />
                    <rect className="bar" x="59.1" y="25.5" width="2.7" height="78.5" />
                    <rect className="bar-bad" x="59.1" y="68.5" width="2.7" height="35.5" />
                    <rect className="bar" x="63.8" y="30.5" width="2.7" height="73.5" />
                    <rect className="bar-bad" x="63.8" y="73.7" width="2.7" height="30.3" />
                    <rect className="bar" x="68.5" y="34.8" width="2.7" height="69.2" />
                    <rect className="bar-bad" x="68.5" y="77.9" width="2.7" height="26.1" />
                    <rect className="bar" x="73.2" y="41.6" width="2.7" height="62.4" />
                    <rect className="bar-bad" x="73.2" y="82.5" width="2.7" height="21.5" />
                    <rect className="bar" x="77.9" y="43.9" width="2.7" height="60.1" />
                    <rect className="bar-bad" x="77.9" y="85" width="2.7" height="19" />
                    <rect className="bar" x="82.6" y="47" width="2.7" height="57" />
                    <rect className="bar-bad" x="82.6" y="87.5" width="2.7" height="16.5" />
                    <rect className="bar" x="87.3" y="49.7" width="2.7" height="54.3" />
                    <rect className="bar-bad" x="87.3" y="89.6" width="2.7" height="14.4" />
                    <rect className="bar" x="92" y="56.9" width="2.7" height="47.1" />
                    <rect className="bar-bad" x="92" y="92.5" width="2.7" height="11.5" />
                    <rect className="bar" x="96.7" y="58.8" width="2.7" height="45.2" />
                    <rect className="bar-bad" x="96.7" y="93.8" width="2.7" height="10.2" />
                    <rect className="bar" x="101.4" y="62.8" width="2.7" height="41.2" />
                    <rect className="bar-bad" x="101.4" y="95.4" width="2.7" height="8.6" />
                    <rect className="bar" x="106.1" y="61.4" width="2.7" height="42.6" />
                    <rect className="bar-bad" x="106.1" y="95.8" width="2.7" height="8.2" />
                    <rect className="bar" x="110.8" y="64.5" width="2.7" height="39.5" />
                    <rect className="bar-bad" x="110.8" y="97" width="2.7" height="7" />
                    <rect className="bar" x="115.5" y="70.4" width="2.7" height="33.6" />
                    <rect className="bar-bad" x="115.5" y="98.4" width="2.7" height="5.6" />
                    <rect className="bar" x="120.2" y="67.2" width="2.7" height="36.8" />
                    <rect className="bar-bad" x="120.2" y="98.3" width="2.7" height="5.7" />
                    <rect className="bar" x="124.9" y="69.2" width="2.7" height="34.8" />
                    <rect className="bar-bad" x="124.9" y="99" width="2.7" height="5" />
                    <rect className="bar" x="129.6" y="72.8" width="2.7" height="31.2" />
                    <rect className="bar-bad" x="129.6" y="99.8" width="2.7" height="4.2" />
                    <rect className="bar" x="134.3" y="74.7" width="2.7" height="29.3" />
                    <rect className="bar-bad" x="134.3" y="100.3" width="2.7" height="3.7" />
                    <rect className="bar" x="139" y="78.8" width="2.7" height="25.2" />
                    <rect className="bar-bad" x="139" y="101" width="2.7" height="3" />
                    <rect className="bar" x="143.7" y="81" width="2.7" height="23" />
                    <rect className="bar-bad" x="143.7" y="101.4" width="2.7" height="2.6" />
                    <rect className="bar" x="148.4" y="79.5" width="2.7" height="24.5" />
                    <rect className="bar-bad" x="148.4" y="101.4" width="2.7" height="2.6" />
                    <rect className="bar" x="153.1" y="83.3" width="2.7" height="20.7" />
                    <rect className="bar-bad" x="153.1" y="101.9" width="2.7" height="2.1" />
                    <rect className="bar" x="157.8" y="83.7" width="2.7" height="20.3" />
                    <rect className="bar-bad" x="157.8" y="102.1" width="2.7" height="1.9" />
                    <rect className="bar" x="162.5" y="84.5" width="2.7" height="19.5" />
                    <rect className="bar-bad" x="162.5" y="102.2" width="2.7" height="1.8" />
                    <rect className="bar" x="167.2" y="86.7" width="2.7" height="17.3" />
                    <rect className="bar-bad" x="167.2" y="102.5" width="2.7" height="1.5" />
                    <rect className="bar" x="171.9" y="85.1" width="2.7" height="18.9" />
                    <rect className="bar-bad" x="171.9" y="102.4" width="2.7" height="1.6" />
                    <rect className="bar" x="176.6" y="86.1" width="2.7" height="17.9" />
                    <rect className="bar-bad" x="176.6" y="102.6" width="2.7" height="1.4" />
                    <rect className="bar" x="181.3" y="84.6" width="2.7" height="19.4" />
                    <rect className="bar-bad" x="181.3" y="102.5" width="2.7" height="1.5" />
                    <rect className="bar" x="186" y="87.2" width="2.7" height="16.8" />
                    <rect className="bar-bad" x="186" y="102.8" width="2.7" height="1.2" />
                    <rect className="bar" x="190.7" y="87.2" width="2.7" height="16.8" />
                    <rect className="bar-bad" x="190.7" y="102.8" width="2.7" height="1.2" />
                    <rect className="bar" x="195.4" y="88.6" width="2.7" height="15.4" />
                    <rect className="bar-bad" x="195.4" y="102.9" width="2.7" height="1.1" />
                    <rect className="bar" x="200.1" y="88.2" width="2.7" height="15.8" />
                    <rect className="bar-bad" x="200.1" y="102.9" width="2.7" height="1.1" />
                    <rect className="bar" x="204.8" y="89.9" width="2.7" height="14.1" />
                    <rect className="bar-bad" x="204.8" y="103.1" width="2.7" height="0.9" />
                    <rect className="bar" x="209.5" y="91.4" width="2.7" height="12.6" />
                    <rect className="bar-bad" x="209.5" y="103.2" width="2.7" height="0.8" />
                    <rect className="bar" x="214.2" y="87.8" width="2.7" height="16.2" />
                    <rect className="bar-bad" x="214.2" y="103" width="2.7" height="1" />
                    <rect className="bar" x="218.9" y="88.3" width="2.7" height="15.7" />
                    <rect className="bar-bad" x="218.9" y="103" width="2.7" height="1" />
                    <rect className="bar" x="223.6" y="89.5" width="2.7" height="14.5" />
                    <rect className="bar-bad" x="223.6" y="103.1" width="2.7" height="0.9" />
                    <rect className="bar" x="228.3" y="90.7" width="2.7" height="13.3" />
                    <rect className="bar-bad" x="228.3" y="103.2" width="2.7" height="0.8" />
                    <rect className="bar" x="233" y="93.2" width="2.7" height="10.8" />
                    <rect className="bar-bad" x="233" y="103.4" width="2.7" height="0.6" />
                    <rect className="bar" x="237.7" y="94" width="2.7" height="10" />
                    <rect className="bar-bad" x="237.7" y="103.4" width="2.7" height="0.6" />
                    <rect className="bar" x="242.4" y="94" width="2.7" height="10" />
                    <rect className="bar-bad" x="242.4" y="103.4" width="2.7" height="0.6" />
                    <rect className="bar" x="247.1" y="95.5" width="2.7" height="8.5" />
                    <rect className="bar-bad" x="247.1" y="103.5" width="2.7" height="0.5" />
                    <rect className="bar" x="251.8" y="91.8" width="2.7" height="12.2" />
                    <rect className="bar-bad" x="251.8" y="103.3" width="2.7" height="0.7" />
                    <rect className="bar" x="256.5" y="94.1" width="2.7" height="9.9" />
                    <rect className="bar-bad" x="256.5" y="103.5" width="2.7" height="0.5" />
                    <rect className="bar" x="261.2" y="91.8" width="2.7" height="12.2" />
                    <rect className="bar-bad" x="261.2" y="103.3" width="2.7" height="0.7" />
                    <rect className="bar" x="265.9" y="94.6" width="2.7" height="9.4" />
                    <rect className="bar-bad" x="265.9" y="103.5" width="2.7" height="0.5" />
                    <rect className="bar" x="270.6" y="91.5" width="2.7" height="12.5" />
                    <rect className="bar-bad" x="270.6" y="103.3" width="2.7" height="0.7" />
                    <rect className="bar" x="275.3" y="92.3" width="2.7" height="11.7" />
                    <rect className="bar-bad" x="275.3" y="103.4" width="2.7" height="0.6" />
                    <rect className="bar" x="280" y="97.3" width="2.7" height="6.7" />
                    <rect className="bar-bad" x="280" y="103.6" width="2.7" height="0.4" />
                    <rect className="bar" x="284.7" y="96.2" width="2.7" height="7.8" />
                    <rect className="bar-bad" x="284.7" y="103.6" width="2.7" height="0.4" />
                    <rect className="bar" x="289.4" y="92.4" width="2.7" height="11.6" />
                    <rect className="bar-bad" x="289.4" y="103.4" width="2.7" height="0.6" />
                    <rect className="bar" x="294.1" y="95" width="2.7" height="9" />
                    <rect className="bar-bad" x="294.1" y="103.5" width="2.7" height="0.5" />
                    <rect className="bar" x="298.8" y="92.3" width="2.7" height="11.7" />
                    <rect className="bar-bad" x="298.8" y="103.4" width="2.7" height="0.6" />
                    <rect className="bar" x="303.5" y="95.7" width="2.7" height="8.3" />
                    <rect className="bar-bad" x="303.5" y="103.6" width="2.7" height="0.4" />
                    <rect className="bar" x="308.2" y="97.6" width="2.7" height="6.4" />
                    <rect className="bar-bad" x="308.2" y="103.7" width="2.7" height="0.3" />
                    <rect className="bar" x="312.9" y="94.6" width="2.7" height="9.4" />
                    <rect className="bar-bad" x="312.9" y="103.5" width="2.7" height="0.5" />
                    <rect className="bar" x="317.6" y="93.8" width="2.7" height="10.2" />
                    <rect className="bar-bad" x="317.6" y="103.5" width="2.7" height="0.5" />
                    <rect className="bar" x="322.3" y="96.8" width="2.7" height="7.2" />
                    <rect className="bar-bad" x="322.3" y="103.6" width="2.7" height="0.4" />
                    <text className="axis" x="44" y="122" textAnchor="middle">T+00:00</text>
                    <text className="axis" x="100.4" y="122" textAnchor="middle">T+02:00</text>
                    <text className="axis" x="156.8" y="122" textAnchor="middle">T+04:00</text>
                    <text className="axis" x="213.2" y="122" textAnchor="middle">T+06:00</text>
                    <text className="axis" x="269.6" y="122" textAnchor="middle">T+08:00</text>
                    <text className="axis" x="326" y="122" textAnchor="middle">T+10:00</text>
                    <rect x="100.4" y="6" width="14.1" height="98" style={{ fill: "var(--primary-subtle)", opacity: ".45", stroke: "var(--link)", strokeWidth: "1.5" }} />
                    <line className="now" x1="107" y1="4" x2="107" y2="104" style={{ strokeWidth: "2" }} />
                    <circle cx="107" cy="4" r="5" style={{ fill: "var(--text)" }} />
                  </svg>
                </>
              ) : null}
              <p className="t-xs muted">←→ 1초 · Shift+←→ 10초 · Space 재생·일시정지 · 시작·끝 시각을 숫자로도 고를 수 있습니다</p>
            </div>
          </section>
          <section className="card-flat col" style={{ gap: "8px", padding: "16px", textAlign: "center", alignItems: "center" }}>
            <i className="ic ic-tablet ic-24 muted" aria-hidden="true" />
            <p className="t-md fw-b">교차 필터와 봇 후보는 태블릿이나 데스크톱에서 봅니다</p>
            <p className="t-sm muted">휴대폰에서는 좌석 리플레이·타임라인·요약만 보입니다</p>
          </section>
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
    {v.isDeny ? (
      <>
        <main id="main" className="col" style={{ flex: "1", alignItems: "center", justifyContent: "center", gap: "10px", padding: "80px 20px", textAlign: "center" }}>
          <span className="state-icon is-danger" style={{ width: "56px", height: "56px" }}><i className="ic ic-lock" aria-hidden="true" /></span>
          <h1 className="t-xl">이 작업을 할 권한이 없습니다</h1>
          <p className="t-md muted">운영 연결 포렌식 리플레이는 개인정보 보호책임자가 가명정보 취급자로 지정한 commander만 엽니다</p>
          <a href={`${CONSOLE_ORIGIN}/dashboard`} className="link-more">
            관제 콘솔
            <i className="ic ic-chevron-right" aria-hidden="true" />
          </a>
        </main>
      </>
    ) : null}
    {v.stage1 ? (
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
