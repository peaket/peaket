// SCR-052 현장 관리(현장 책임자), 경로 /manage. 시각 기준: 캔버스 보드 SCR-052-p·t·l. 정본: docs/design/d5 §8.5, d3 SCR-052.
// 탭 [기기] [이상 표시] [부스] [내 예외 통과](CMP-030). 탭은 이 화면 안에서 바로 바꾼다(방향키로 옮긴다).
// - 처음 탭은 ?state=의 상태에서, 상태가 없으면 d5 경로의 ?tab=(devices·flags·booth·mine)에서 고른다.
// - 휴대폰 세로 보드에는 '내 예외 통과' 패널이 없어 태블릿·가로 보드의 표를 같은 내용으로 옮겼다.
// - 가로 보드는 '이상 표시'·'내 예외 통과'만 그렸다. 가로의 기기·부스 탭은 태블릿의 카드 2열을 쓴다(추천안).
import { CameraView } from "@peaket/ds/CameraView";
import { ScannerShell } from "@peaket/ds/ScannerShell";
import { useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import type { ScannerLayout } from "../app/layout";
import { PreviewSwitcher, usePreviewState } from "../app/preview";
import { Link } from "../app/router";
import { device, fleet, myOverrides, placement, sync, zoneFlags } from "../fixtures/scanner";
import { bottomStyle, ManageLink, Strip, stripStyle } from "../shared/shell";

export const MANAGE_STATES = ["이상 표시", "기기 탭", "부스 탭", "내 예외 통과", "오프라인", "빈 화면"] as const;
type ManageState = (typeof MANAGE_STATES)[number];
type Tab = "devices" | "flags" | "booth" | "mine";

const TABS: { key: Tab; id: string; label: string }[] = [
  { key: "devices", id: "tab-dev", label: "기기" },
  { key: "flags", id: "tab-flag", label: "이상 표시" },
  { key: "booth", id: "tab-booth", label: "부스" },
  { key: "mine", id: "tab-mine", label: "내 예외 통과" },
];

function tabFromState(st: ManageState): Tab {
  if (st === "기기 탭" || st === "오프라인") return "devices";
  if (st === "부스 탭") return "booth";
  if (st === "내 예외 통과") return "mine";
  return "flags";
}

export function ManageScreen() {
  const { state, layout, search } = usePreviewState(MANAGE_STATES, "이상 표시");
  const params = new URLSearchParams(search);
  const tabParam = params.get("tab");
  const initialTab: Tab =
    !params.has("state") && (tabParam === "devices" || tabParam === "flags" || tabParam === "booth" || tabParam === "mine")
      ? tabParam
      : tabFromState(state);
  return (
    <>
      <ManageBody key={`${state}-${initialTab}`} st={state} layout={layout} initialTab={initialTab} />
      <PreviewSwitcher states={MANAGE_STATES} current={state} />
    </>
  );
}

function ManageBody({ st, layout, initialTab }: { st: ManageState; layout: ScannerLayout; initialTab: Tab }) {
  const [tab, setTab] = useState<Tab>(initialTab);
  const tabRefs = useRef<Record<Tab, HTMLButtonElement | null>>({ devices: null, flags: null, booth: null, mine: null });
  const t = layout === "t";
  const l = layout === "l";
  const off = st === "오프라인";
  const empty = st === "빈 화면";

  const onTabKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    const i = TABS.findIndex((x) => x.key === tab);
    let next = -1;
    if (event.key === "ArrowRight") next = (i + 1) % TABS.length;
    else if (event.key === "ArrowLeft") next = (i - 1 + TABS.length) % TABS.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = TABS.length - 1;
    if (next < 0) return;
    event.preventDefault();
    const key = TABS[next]!.key;
    setTab(key);
    tabRefs.current[key]?.focus();
  };

  const current = TABS.find((x) => x.key === tab)!;
  const tabs = (
    // 폭 320에서 마지막 탭이 잘리지 않게 탭 줄만 가로로 넘긴다(키트 20b .tabs-scroll)
    <div className="tabs tabs-scroll" role="tablist" aria-label="현장 관리 메뉴">
      {TABS.map((x) => {
        const selected = x.key === tab;
        return (
          <button
            key={x.key}
            ref={(el) => {
              tabRefs.current[x.key] = el;
            }}
            className={selected ? "tab is-active" : "tab"}
            role="tab"
            type="button"
            id={x.id}
            aria-selected={selected}
            aria-controls="mg-panel"
            tabIndex={selected ? 0 : -1}
            onClick={() => setTab(x.key)}
            onKeyDown={onTabKey}
            style={layout === "p" ? { padding: "0 8px" } : undefined}
          >
            {x.label}
            {x.key === "flags" && !empty ? <span className="badge badge-warning">2</span> : null}
          </button>
        );
      })}
    </div>
  );

  let panel: ReactNode;
  if (tab === "flags") panel = empty ? <EmptyFlags layout={layout} /> : <FlagsPanel layout={layout} />;
  else if (tab === "devices") panel = <DevicesPanel layout={layout} off={off} />;
  else if (tab === "booth") panel = <BoothPanel layout={layout} off={off} />;
  else panel = <MinePanel layout={layout} />;

  return (
    <ScannerShell
      strip={<Strip online={!off} queue={sync.queue} />}
      stripStyle={stripStyle(layout)}
      bottom={
        <>
          <Link className="btn btn-outline" href="/scan" style={{ height: 44 }}>
            <i className="ic ic-arrow-left" aria-hidden="true" />
            스캔으로 돌아가기
          </Link>
          <ManageLink current />
        </>
      }
      bottomStyle={bottomStyle(layout)}
      mainClassName="col"
      mainStyle={t ? { padding: "20px 24px 24px", gap: 16 } : l ? { padding: "12px 20px 16px", gap: 12 } : { padding: "12px 16px 16px", gap: 10 }}
    >
      {l ? (
        <div className="row between wrap" style={{ alignItems: "flex-end" }}>
          <h1 className="t-xl">현장 관리</h1>
          {tabs}
        </div>
      ) : (
        <>
          <h1 className={t ? "t-2xl" : "t-xl"}>현장 관리</h1>
          {tabs}
        </>
      )}
      <div
        className="col"
        role="tabpanel"
        id="mg-panel"
        aria-labelledby={current.id}
        style={{ gap: t ? 16 : 8, ...(layout === "p" ? { paddingTop: 2 } : null), ...(l ? { flex: 1 } : null) }}
      >
        {panel}
      </div>
    </ScannerShell>
  );
}

function ResultButtons({ seat, grid }: { seat: string; grid: boolean }) {
  const labels = ["정상 확인", "부정 의심", "판단 불가"];
  return (
    <div
      className={grid ? undefined : "row"}
      style={grid ? { display: "grid", gridTemplateColumns: "repeat(3,minmax(0,1fr))", gap: 6 } : { gap: 6 }}
      role="group"
      aria-label={`${seat} 확인 결과 기록`}
    >
      {labels.map((x) => (
        <button
          key={x}
          className={grid ? "btn btn-secondary btn-lg" : "btn btn-secondary btn-lg grow"}
          type="button"
          style={{ padding: "0 6px", whiteSpace: "normal" }}
          aria-label={`${seat} ${x}`}
        >
          {x}
        </button>
      ))}
    </div>
  );
}

function ConfirmScanButton({ seat }: { seat: string }) {
  // [확인 스캔하기]도 현장 주요 버튼이라 56px(btn-field)이다(캔버스 메모 cf052)
  return (
    <button className="btn btn-outline btn-field btn-block" type="button" aria-label={`${seat} 확인 스캔하기`}>
      <i className="ic ic-scan" aria-hidden="true" />
      확인 스캔하기
    </button>
  );
}

const GUIDE = "좌석에서 확인 스캔을 하고 월렛 화면의 닉네임을 본 뒤 결과를 기록합니다. 퇴장 조치는 파트너의 현장 규정을 따릅니다.";
const SUMMARY = `${placement.zone} · 처리 전 2건 · 처리함 1건`;

function FlagsPanel({ layout }: { layout: ScannerLayout }) {
  const t = layout === "t";
  const [selected, setSelected] = useState<string>(zoneFlags[0].id);
  if (layout === "l") {
    const sel = zoneFlags.find((f) => f.id === selected) ?? zoneFlags[0];
    return (
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)", gap: 16, flex: 1 }}>
        <section className="col" style={{ gap: 8 }} aria-labelledby="h-list">
          <h2 className="t-md fw-b" id="h-list">
            {SUMMARY}
          </h2>
          <ul className="col" style={{ gap: 8 }}>
            {zoneFlags.map((f) => {
              const on = f.id === sel.id;
              return (
                <li key={f.id}>
                  <button
                    type="button"
                    className="card row"
                    aria-current={on ? "true" : undefined}
                    onClick={() => setSelected(f.id)}
                    style={{
                      width: "100%",
                      textAlign: "left",
                      gap: 10,
                      padding: "10px 14px",
                      minHeight: 64,
                      color: "inherit",
                      cursor: "pointer",
                      ...(on ? { border: "2px solid var(--border-primary)" } : null),
                    }}
                  >
                    <span className="col grow" style={{ gap: 2 }}>
                      <span className="t-md fw-b">{f.seat}</span>
                      <span className="t-sm">
                        {f.kind} · {f.at}
                        {f.done ? ` · ${f.done.at} 처리함` : ""}
                      </span>
                    </span>
                    <FlagBadge done={f.done} />
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
        <section
          className="card col"
          style={{ padding: "14px 16px", gap: 8, ...(sel.done ? null : { border: "2px solid var(--warning)" }) }}
          aria-labelledby="h-sel"
        >
          <div className="row between">
            <h2 className="t-xl" id="h-sel">
              {sel.seat}
            </h2>
            <FlagBadge done={sel.done} />
          </div>
          <FlagMeta kind={sel.kind} at={sel.at} doneAt={sel.done?.at} />
          {sel.done ? null : (
            <>
              <ConfirmScanButton seat={sel.seat} />
              <ResultButtons seat={sel.seat} grid={false} />
            </>
          )}
          <p className="t-sm">{GUIDE}</p>
        </section>
      </div>
    );
  }
  return (
    <div className="col" style={{ gap: t ? 16 : 8 }}>
      <p className={t ? "t-md fw-b" : "t-sm fw-b"}>{SUMMARY}</p>
      <ul className={t ? undefined : "col"} style={t ? { display: "grid", gridTemplateColumns: "repeat(2,minmax(0,1fr))", gap: 16 } : { gap: 10 }}>
        {zoneFlags.map((f) => (
          <li
            key={f.id}
            className="card col"
            style={{
              padding: t ? 16 : "12px 14px",
              gap: f.done ? (t ? 8 : 6) : t ? 10 : 8,
              ...(f.done ? null : { border: "2px solid var(--warning)" }),
            }}
          >
            <div className="row between" style={t ? { gap: 8 } : undefined}>
              <span className="t-lg">{f.seat}</span>
              <FlagBadge done={f.done} />
            </div>
            <FlagMeta kind={f.kind} at={f.at} doneAt={f.done?.at} />
            {f.done ? null : (
              <>
                <ConfirmScanButton seat={f.seat} />
                <ResultButtons seat={f.seat} grid={t} />
              </>
            )}
          </li>
        ))}
      </ul>
      <p className={t ? "t-md" : "t-sm"}>{GUIDE}</p>
    </div>
  );
}

function FlagBadge({ done }: { done: { result: string; at: string } | null }) {
  return done ? (
    <span className="badge badge-success">
      <i className="ic ic-check" aria-hidden="true" />
      {done.result}
    </span>
  ) : (
    <span className="badge badge-warning">처리 전</span>
  );
}

function FlagMeta({ kind, at, doneAt }: { kind: string; at: string; doneAt?: string }) {
  return (
    <p className="row wrap t-md" style={{ gap: "4px 12px" }}>
      <span className="fw-b">{kind}</span>
      <span className="row" style={{ gap: 4 }}>
        <i className="ic ic-clock ic-16" aria-hidden="true" />
        {at}
      </span>
      {doneAt ? <span>{doneAt} 처리함</span> : null}
    </p>
  );
}

function EmptyFlags({ layout }: { layout: ScannerLayout }) {
  const t = layout === "t";
  return (
    <section className="card state" style={t ? { padding: "56px 40px", gap: 16 } : { padding: "40px 20px" }} aria-labelledby="h-em">
      <span className="state-icon is-success">
        <i className="ic ic-check-circle" aria-hidden="true" />
      </span>
      <h2 className={t ? "t-2xl" : "t-xl"} id="h-em">
        이상 표시가 없습니다
      </h2>
      <p className={t ? "t-lg fw-m" : "t-md"}>서버가 이 구역에 이상 표시를 만들면 이 목록에 보입니다.</p>
      <Link
        className={t ? "btn btn-outline btn-lg" : "btn btn-outline btn-lg btn-block"}
        href="/scan"
        style={t ? { minWidth: 320, maxWidth: "100%" } : undefined}
      >
        스캔 화면으로 돌아가기
      </Link>
    </section>
  );
}

function OfflineBanner() {
  return (
    <div className="banner banner-offline" role="status" id="off-why">
      <i className="ic ic-wifi-off" aria-hidden="true" />
      <div className="banner-body fw-b">오프라인: 배치 변경·부스 허용은 연결된 뒤에 됩니다</div>
    </div>
  );
}

function DevicesPanel({ layout, off }: { layout: ScannerLayout; off: boolean }) {
  const wide = layout !== "p";
  const selectGroup: CSSProperties = { padding: "0 8px" };
  const placementCard = (
    <section className="card col" style={wide ? { padding: 20, gap: 12 } : { padding: "12px 14px", gap: 8 }} aria-labelledby="h-pl">
      <h3 className={wide ? "t-lg" : "t-md fw-b"} id="h-pl">
        배치 바꾸기
      </h3>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3,minmax(0,1fr))", gap: 6 }}>
        <div className="field">
          <label className="label" htmlFor="pl-dev">
            기기
          </label>
          <div className="input-group" style={selectGroup}>
            <select id="pl-dev" defaultValue="동문-04">
              {["동문-04", "동문-01", "동문-02", "동문-03"].map((d) => (
                <option key={d}>{d}</option>
              ))}
            </select>
            <i className="ic ic-chevron-down ic-16" aria-hidden="true" />
          </div>
        </div>
        <div className="field">
          <label className="label" htmlFor="pl-zone">
            구역
          </label>
          <div className="input-group" style={selectGroup}>
            <select id="pl-zone" defaultValue="동문">
              <option>동문</option>
              <option>서문</option>
            </select>
            <i className="ic ic-chevron-down ic-16" aria-hidden="true" />
          </div>
        </div>
        <div className="field">
          <label className="label" htmlFor="pl-mode">
            모드
          </label>
          <div className="input-group" style={selectGroup}>
            <select id="pl-mode" defaultValue="입장" aria-describedby="pl-mode-h">
              <option>입장</option>
              <option disabled>퇴장</option>
            </select>
            <i className="ic ic-chevron-down ic-16" aria-hidden="true" />
          </div>
        </div>
      </div>
      <p className="hint fw-b" id="pl-mode-h" style={{ color: "var(--text)" }}>
        재입장 불허 회차에서는 퇴장 모드를 쓸 수 없습니다
      </p>
      {off ? (
        <button
          className="btn btn-primary btn-lg btn-block"
          type="button"
          aria-disabled="true"
          aria-describedby="off-why"
          style={wide ? { padding: "0 12px" } : undefined}
        >
          동문-04를 동문 · 입장으로 배치합니다
        </button>
      ) : (
        <div className="col" style={{ gap: 8 }}>
          <button className="btn btn-primary btn-lg btn-block" type="button" style={wide ? { padding: "0 12px" } : undefined}>
            동문-04를 동문 · 입장으로 배치합니다
          </button>
          <p className="t-sm">배치는 연결된 상태에서만 바꿀 수 있습니다.</p>
        </div>
      )}
    </section>
  );
  const checkCard = (
    <section className="card col" style={wide ? { padding: 20, gap: 4 } : { padding: "12px 14px", gap: 2 }} aria-labelledby="h-ck">
      <h3 className={wide ? "t-lg" : "t-md fw-b"} id="h-ck" style={wide ? { marginBottom: 6 } : undefined}>
        준비 점검(입장 30분 전)
      </h3>
      {[
        { label: "모든 기기 준비", checked: false },
        { label: "예비 기기", checked: true },
        { label: "부스 회선", checked: false },
      ].map((c) => (
        <label key={c.label} className="check-row" style={{ minHeight: 44, alignItems: "center" }}>
          <input className="cb" type="checkbox" defaultChecked={c.checked} />
          {c.label}
        </label>
      ))}
    </section>
  );
  return (
    <>
      {off ? <OfflineBanner /> : null}
      <div className="row between" style={{ gap: 8 }}>
        <h2 className="t-lg">이 회차 기기</h2>
        <span className="t-sm fw-b">{off ? "18:41에 마지막으로 받은 목록" : device.partner}</span>
      </div>
      <div className="table-wrap table-scroll" style={{ opacity: off ? 0.55 : 1 }}>
        <table className={wide ? "table" : "table dense"}>
          <caption className="sr-only">이 회차 이 파트너 기기의 준비 상태, 마지막 동기화, 업로드 대기, 배치</caption>
          <thead>
            {wide ? (
              <tr>
                <th scope="col">기기</th>
                <th scope="col">준비 상태</th>
                <th scope="col">마지막 동기화</th>
                <th scope="col" className="r">
                  업로드 대기
                </th>
                <th scope="col">배치</th>
              </tr>
            ) : (
              <tr>
                <th scope="col">기기</th>
                <th scope="col">준비 · 동기화</th>
                <th scope="col" className="r">
                  대기
                </th>
                <th scope="col">배치</th>
              </tr>
            )}
          </thead>
          <tbody>
            {fleet.map((d) => {
              const ready = d.ready ? <span className="badge badge-success">준비</span> : <span className="badge">준비 전</span>;
              const placed = d.placement ?? <span className="badge badge-warning">배치 없음</span>;
              return wide ? (
                <tr key={d.name}>
                  <td className="fw-b">
                    {d.name}
                    {d.self ? (
                      <>
                        {" "}
                        <span className="badge">이 기기</span>
                      </>
                    ) : null}
                  </td>
                  <td>{ready}</td>
                  <td>{d.synced}</td>
                  <td className="r">{d.queue}</td>
                  <td>{placed}</td>
                </tr>
              ) : (
                <tr key={d.name}>
                  <td className="fw-b">
                    {d.name}
                    {d.self ? (
                      <>
                        <br />
                        <span className="t-xs">이 기기</span>
                      </>
                    ) : null}
                  </td>
                  <td>
                    {ready} {d.synced}
                  </td>
                  <td className="r">{d.queue}</td>
                  <td>{placed}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {wide ? (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(2,minmax(0,1fr))", gap: 16 }}>
          {placementCard}
          {checkCard}
        </div>
      ) : (
        <>
          {placementCard}
          {checkCard}
        </>
      )}
    </>
  );
}

function BoothPanel({ layout, off }: { layout: ScannerLayout; off: boolean }) {
  const wide = layout !== "p";
  const viewfinder = (
    <CameraView
      label="카메라 뷰파인더(부스 코드)"
      frameWidth={wide ? 170 : 160}
      style={{ height: wide ? 280 : 250, alignContent: "center", rowGap: wide ? 10 : 8, borderRadius: 12 }}
    >
      <p className="t-md fw-b" style={wide ? { textAlign: "center", padding: "0 12px" } : undefined}>
        부스 코드 QR을 네모 안에 맞춰 주세요
      </p>
    </CameraView>
  );
  const intro = <p className="t-sm">관객 휴대폰 화면의 부스 코드 QR을 찍으면 그 티켓의 새 키 등록을 10분 동안 허용합니다.</p>;
  const done = (
    <div className="banner banner-success" role="status">
      <i className="ic ic-check-circle" aria-hidden="true" />
      <div className="banner-body">
        <span className="banner-title">부스 허용 완료: 10분 안에 관객 휴대폰에서 등록하세요</span>R구역 3열 9번 · 18:44 허용 · 18:54까지
      </div>
    </div>
  );
  const recent = (
    <ul className="col">
      <li className="li" style={{ alignItems: "flex-start", minHeight: 48, padding: wide ? "10px 0" : "8px 0", ...(wide ? { borderBottom: 0 } : null) }}>
        <span className="badge badge-warning">만료</span>
        <span className="col grow" style={{ gap: 2 }}>
          <span className="t-sm fw-b">부스 코드가 만료되었습니다. 관객에게 다시 요청하게 하세요</span>
          <span className="t-xs">18:39</span>
        </span>
      </li>
    </ul>
  );
  if (wide) {
    return (
      <>
        {off ? <OfflineBanner /> : null}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(2,minmax(0,1fr))", gap: 16, alignItems: "start" }}>
          <section className="card col" style={{ padding: 20, gap: 12 }} aria-labelledby="h-bo">
            <h2 className="t-lg" id="h-bo">
              부스 코드 찍기
            </h2>
            {intro}
            {viewfinder}
          </section>
          <section className="col" style={{ gap: 16 }} aria-labelledby="h-bo-r">
            <h2 className="sr-only" id="h-bo-r">
              부스 처리 결과
            </h2>
            {off ? null : done}
            <div className="card col" style={{ padding: 20, gap: 4 }}>
              <h3 className="t-md fw-b">최근 부스 처리</h3>
              {recent}
            </div>
          </section>
        </div>
      </>
    );
  }
  return (
    <>
      {off ? <OfflineBanner /> : null}
      <h2 className="t-lg">부스 코드 찍기</h2>
      {intro}
      {viewfinder}
      {off ? null : done}
      <h3 className="t-md fw-b">최근 부스 처리</h3>
      {recent}
    </>
  );
}

function MinePanel({ layout }: { layout: ScannerLayout }) {
  const t = layout === "t";
  return (
    <section className="col" style={{ gap: t ? 12 : 8 }} aria-labelledby="h-mine">
      <div className="row between" style={{ gap: 8 }}>
        <h2 className="t-lg" id="h-mine">
          내가 한 예외 통과
        </h2>
        <span className="t-sm fw-b">오늘 {myOverrides.length}건</span>
      </div>
      <div className="table-wrap table-scroll">
        <table className={layout === "p" ? "table dense" : "table"}>
          <caption className="sr-only">내가 한 예외 통과: 시각, 좌석, 사유, 사후 검토</caption>
          <thead>
            <tr>
              <th scope="col">시각</th>
              <th scope="col">좌석</th>
              <th scope="col">사유</th>
              <th scope="col">사후 검토</th>
            </tr>
          </thead>
          <tbody>
            {myOverrides.map((o) => (
              <tr key={o.at}>
                <td className="num">{o.at}</td>
                <td className="fw-b">{o.seat}</td>
                <td>{o.reason}</td>
                <td>
                  <span className={o.review === "정상" ? "badge badge-success" : o.review === "부적정" ? "badge badge-danger" : "badge"}>{o.review}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="t-sm">
        모든 예외 통과는 사후 검토(CS 처리함)에 오르고, 검토 결과는 이 표에 검토 대기·정상·부적정으로 보입니다. 메모에는 개인정보를 적지 않습니다.
      </p>
    </section>
  );
}
