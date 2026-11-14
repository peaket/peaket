// SCR-033 근무 준비, 경로 /setup. 시각 기준: 캔버스 보드 SCR-033-p·t·l. 정본: docs/design/d5 §8.2, d3 SCR-033.
// 배치(읽기 전용) → 목록 받기 → 시계 오차·업로드 대기 → 준비 완료면 [스캔 시작](56px 이상, d5 §3.4).
// 가로 보드는 '준비 완료'·'앱 판이 낮음'만 그렸다. 나머지 상태의 가로 배치는 같은 두 칸 격자에 세로 보드의 내용을 옮겼다(추천안).
import { ScannerShell } from "@peaket/ds/ScannerShell";
import type { CSSProperties, ReactNode } from "react";
import { formatClockOffset } from "../api/live";
import { PreviewSwitcher, usePreviewState } from "../app/preview";
import { Link, navigate } from "../app/router";
import { useScannerLive } from "../app/useScannerLive";
import { device, placement, prep } from "../fixtures/scanner";
import { bottomStyle, ManageLink, Strip, stripStyle } from "../shared/shell";

export const SETUP_STATES = [
  "준비 중",
  "준비 완료",
  "배치 없음",
  "목록 받기 제한",
  "목록 받기 거부",
  "앱 판이 낮음",
  "미등록·폐기 기기",
] as const;

export function SetupScreen() {
  const { state: previewState, layout, search } = usePreviewState(SETUP_STATES, "준비 중");
  const live = useScannerLive(search);
  const liveShift = live.mode === "live" ? live.shift : undefined;
  const st = liveShift ? live.setupState : previewState;
  const t = layout === "t";
  const l = layout === "l";
  const liveError = live.mode === "error" ? live.error : undefined;
  const deviceName = liveShift?.device.name ?? device.name;
  const placementZone = liveShift?.placement.gateZone ?? placement.zone;
  const placementMode = liveShift?.placement.mode ?? "IN";
  const listSeq = liveShift ? String(liveShift.packageSeq) : prep.listSeq;
  const clockOffset = liveShift ? formatClockOffset(liveShift.package.clockOffsetMs) : prep.clockOffset;
  const pendingUploads = liveShift?.package.pendingUploads ?? 0;
  const progress = liveShift ? (live.setupState === "준비 완료" ? 100 : 82) : prep.progress;

  const revoked = st === "미등록·폐기 기기";
  const noPl = st === "배치 없음";
  const old = st === "앱 판이 낮음";
  const ready = st === "준비 완료";
  const preparing = st === "준비 중";
  const limited = st === "목록 받기 제한";
  const denied = st === "목록 받기 거부";
  const listBlocked = limited || denied;
  const hasPlacement = !noPl && !revoked;
  const listDone = ready || old;
  const notReady = !ready && !revoked;

  const strip = (
    <Strip
      queue={0}
      hidePlacement={!hasPlacement}
      badges={
        noPl ? (
          <span className="badge badge-warning">
            <i className="ic ic-alert" aria-hidden="true" />
            배치 없음
          </span>
        ) : null
      }
    />
  );

  const head = (
    <div className="col" style={{ gap: t ? 8 : l ? 4 : 6 }}>
      <h1 className={t ? "t-2xl" : "t-xl"}>근무 준비</h1>
      <p className={t ? "row wrap t-lg" : "row wrap t-md"} style={{ gap: t ? "8px 10px" : "6px 8px" }}>
        <span className={t ? undefined : "fw-b"}>기기 {deviceName}</span>
        {revoked ? (
          <span className={t ? "badge badge-lg badge-danger" : "badge badge-danger"}>
            <i className="ic ic-ban" aria-hidden="true" />
            폐기된 기기
          </span>
        ) : (
          <>
            <span className={t ? "badge badge-lg badge-success" : "badge badge-success"}>
              <i className="ic ic-shield" aria-hidden="true" />
              기기 키 등록됨
            </span>
            <span className={t ? "badge badge-lg badge-success" : "badge badge-success"}>
              <i className="ic ic-sun" aria-hidden="true" />
              화면 꺼짐 방지 켜짐
            </span>
          </>
        )}
      </p>
    </div>
  );

  const cardPad: CSSProperties = t ? { padding: 20, gap: 10 } : l ? { padding: "14px 16px", gap: 6 } : { padding: 16, gap: 8 };

  const placementCard = (
    <section className="card col" style={cardPad} aria-labelledby="h-pl">
      <div className="row between" style={t ? { gap: 8 } : undefined}>
        <h2 className="t-lg" id="h-pl">
          이 기기의 배치
        </h2>
        <span className="badge badge-outline">
          <i className="ic ic-lock" aria-hidden="true" />
          {l ? "읽기 전용 · 책임자·파트너가 정함" : "읽기 전용"}
        </span>
      </div>
      {hasPlacement ? (
        <div className="col" style={{ gap: t ? 10 : l ? 6 : 8 }}>
          <p className="t-md fw-b">{liveShift ? `회차 ${liveShift.eventId.slice(0, 8)}` : placement.event}</p>
          <div className="row wrap" style={{ gap: 8 }}>
            <span className="badge badge-lg badge-outline">{placementZone}</span>
            <span className={placementMode === "OUT" ? "badge badge-lg mode-out" : "badge badge-lg mode-in"}>
              <i className={placementMode === "OUT" ? "ic ic-arrow-left" : "ic ic-arrow-right"} aria-hidden="true" />
              {placementMode === "OUT" ? "퇴장 모드" : "입장 모드"}
            </span>
          </div>
          {l ? null : <p className="t-sm">현장 책임자·파트너가 정합니다.</p>}
        </div>
      ) : null}
      {noPl ? (
        <div className="col" style={{ gap: t ? 10 : 8 }}>
          <div className="banner banner-warning" role="alert">
            <i className="ic ic-alert" aria-hidden="true" />
            <div className="banner-body">
              <span className="banner-title">현장 책임자에게 기기 배치를 요청하세요</span>
              배치(게이트 구역·입장 또는 퇴장)를 받기 전에는 스캔을 시작할 수 없습니다.
            </div>
          </div>
          <button className="btn btn-outline btn-lg btn-block" type="button" onClick={live.reload}>
            <i className="ic ic-refresh" aria-hidden="true" />
            배치 다시 확인하기
          </button>
        </div>
      ) : null}
    </section>
  );

  const pctClass = t ? "t-lg num" : "t-md fw-b num";
  const listCard = (
    <section className="card col" style={cardPad} aria-labelledby="h-dl">
      <div className="row between" style={t ? { gap: 8 } : undefined}>
        <h2 className="t-lg" id="h-dl">
          목록 받기
        </h2>
        {preparing ? <span className="badge badge-primary">받는 중</span> : null}
        {listDone ? (
          <span className="badge badge-success">
            <i className="ic ic-check" aria-hidden="true" />
            완료
          </span>
        ) : null}
        {limited ? <span className="badge badge-warning">멈춤</span> : null}
        {denied ? <span className="badge badge-danger">거부</span> : null}
        {noPl ? <span className="badge">대기</span> : null}
      </div>
      {!listBlocked && !(l && listDone) ? <p className="t-sm">입장 시작 전에 목록을 내려받으세요.</p> : null}
      {preparing ? (
        <div className="row" style={{ gap: 10 }}>
          <div className="progress progress-lg grow" role="progressbar" aria-label="목록 받기" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100}>
            <span style={{ width: `${progress}%` }} />
          </div>
          <span className={pctClass}>{progress}%</span>
        </div>
      ) : null}
      {listDone ? (
        <div className="row" style={{ gap: 10 }}>
          <div className="progress progress-lg progress-success grow" role="progressbar" aria-label="목록 받기" aria-valuenow={100} aria-valuemin={0} aria-valuemax={100}>
            <span style={{ width: "100%" }} />
          </div>
          <span className={pctClass}>100%</span>
        </div>
      ) : null}
      {noPl ? <p className="t-sm fw-b">배치를 받은 뒤에 목록을 받습니다.</p> : null}
      {denied ? (
        <div className="col" style={{ gap: 10 }}>
          <div className="banner banner-danger" role="alert">
            <i className="ic ic-ban" aria-hidden="true" />
            <div className="banner-body">
              <span className="banner-title">이 회차 목록을 받을 수 없습니다</span>
              다시 로그인하거나 책임자에게 알리세요.
            </div>
          </div>
          <Link className="btn btn-outline btn-lg btn-block" href="/login">
            <i className="ic ic-logout" aria-hidden="true" />
            다시 로그인하기
          </Link>
        </div>
      ) : null}
      {limited ? (
        <div className="col" style={{ gap: 10 }}>
          <div className="banner banner-warning" role="alert">
            <i className="ic ic-clock" aria-hidden="true" />
            <div className="banner-body">
              <span className="banner-title">잠시 뒤 다시 받으세요</span>
              목록은 기기당 1분에 3번까지 받습니다.
            </div>
          </div>
          <button className="btn btn-outline btn-lg btn-block" type="button" aria-disabled="true" aria-describedby="dl-why">
            <i className="ic ic-download" aria-hidden="true" />
            목록 다시 받기
          </button>
          <p className="t-sm fw-b" id="dl-why">
            40초 뒤에 누를 수 있습니다
          </p>
        </div>
      ) : null}
    </section>
  );

  const statStyle: CSSProperties | undefined = t ? undefined : { padding: "10px 12px", gap: 4 };
  const valueStyle = (muted: boolean): CSSProperties | undefined => {
    const base: CSSProperties = t ? {} : { fontSize: 22, lineHeight: "28px" };
    return muted ? { ...base, color: "var(--text-muted)" } : t ? undefined : base;
  };
  const stat = (label: string, value: string, meta: string, muted = false) => (
    <div className="stat" style={statStyle}>
      <span className="stat-label">{label}</span>
      <span className="stat-value" style={valueStyle(muted)}>
        {value}
      </span>
      <span className="stat-meta">{meta}</span>
    </div>
  );
  const stats = (
    <section aria-label="준비 상태 수치" style={{ display: "grid", gridTemplateColumns: "repeat(3,minmax(0,1fr))", gap: t ? 16 : 8 }}>
      {listDone ? stat("목록 일련번호", listSeq, "받음") : stat("목록 일련번호", "—", "받기 전", true)}
      {hasPlacement ? stat("시계 오차", clockOffset, "보정됨") : stat("시계 오차", "—", "재기 전", true)}
      {stat("업로드 대기", `${pendingUploads}건`, pendingUploads === 0 ? "비어 있음" : "연결되면 올립니다")}
    </section>
  );

  const newVersion = preparing ? (
    <div className="banner banner-info">
      <i className="ic ic-download" aria-hidden="true" />
      {t ? (
        <>
          <div className="banner-body">
            <span className="banner-title">새 앱 버전이 있습니다</span>근무 준비 때 새 버전을 적용합니다.
          </div>
          <button className="btn btn-outline" type="button" style={{ height: 44, alignSelf: "center" }}>
            새 버전 적용하기
          </button>
        </>
      ) : (
        <div className="banner-body">
          <span className="banner-title">새 앱 버전이 있습니다</span>근무 준비 때 새 버전을 적용합니다.
          <div style={{ marginTop: 6 }}>
            <button className="btn btn-outline btn-sm" type="button" style={{ height: 44 }}>
              새 버전 적용하기
            </button>
          </div>
        </div>
      )}
    </div>
  ) : null;

  const oldBanner = old ? (
    <div className="banner banner-warning" role="alert">
      <i className="ic ic-alert" aria-hidden="true" />
      <div className="banner-body">
        <span className="banner-title">이 앱 판으로는 근무를 시작할 수 없습니다. 새 버전을 적용해 주세요</span>이 기기 앱 {prep.appVersion} · 근무에
        필요한 판 {prep.minAppVersion} 이상
        {t ? null : (
          <div style={{ marginTop: 6 }}>
            <button className="btn btn-primary btn-sm" type="button" style={{ minHeight: 44 }}>
              <i className="ic ic-download" aria-hidden="true" />새 버전 적용
            </button>
          </div>
        )}
      </div>
      {t ? (
        <button className="btn btn-primary btn-lg" type="button" style={{ alignSelf: "center" }}>
          <i className="ic ic-download" aria-hidden="true" />새 버전 적용
        </button>
      ) : null}
    </div>
  ) : null;

  const whyClass = t ? "t-md fw-b" : "t-sm fw-b";
  const reasons: { id: string; text: string; live?: boolean; on: boolean }[] = [
    { id: "start-why-1", text: "목록을 다 받으면 스캔을 시작할 수 있습니다", live: true, on: preparing },
    { id: "start-why-2", text: "기기 배치가 없어 스캔을 시작할 수 없습니다", on: noPl },
    { id: "start-why-3", text: "목록을 받은 뒤에 스캔을 시작할 수 있습니다", on: listBlocked },
    { id: "start-why-4", text: "새 버전을 적용한 뒤에 스캔을 시작할 수 있습니다", on: old },
  ];
  const shown = reasons.filter((r) => r.on);
  const startScan = () => {
    if (!liveShift) {
      navigate("/scan");
      return;
    }
    void live
      .reportReadiness()
      .then(() => navigate("/scan"))
      .catch(() => navigate("/scan"));
  };
  const startArea: ReactNode = ready ? (
    <div className="col" style={{ gap: t ? 12 : 10, marginTop: "auto" }}>
      <div className="banner banner-success" role="status">
        <i className="ic ic-check-circle" aria-hidden="true" />
        <div className="banner-body fw-b">
          준비 완료: 목록 {listSeq}, 시계 오차 {clockOffset}, 업로드 대기 {pendingUploads}건
        </div>
      </div>
      <button className="btn btn-primary btn-xl btn-block" type="button" onClick={startScan}>
        <i className="ic ic-scan" aria-hidden="true" />
        스캔 시작
      </button>
    </div>
  ) : notReady ? (
    <div className="col" style={{ gap: t ? 12 : 10, marginTop: "auto" }}>
      {shown.map((r) => (
        <p key={r.id} className={whyClass} id={r.id} role={r.live ? "status" : undefined}>
          {r.text}
        </p>
      ))}
      <button
        className="btn btn-primary btn-xl btn-block"
        type="button"
        aria-disabled="true"
        aria-describedby={shown.map((r) => r.id).join(" ") || undefined}
      >
        <i className="ic ic-scan" aria-hidden="true" />
        스캔 시작
      </button>
    </div>
  ) : null;

  const revokedCard = revoked ? (
    <section
      className="card state"
      role="alert"
      style={t ? { padding: "56px 40px", gap: 16 } : { padding: "36px 20px", ...(l ? { gridColumn: "1 / -1" } : null) }}
      aria-labelledby="h-rev"
    >
      <span className="state-icon is-danger">
        <i className="ic ic-ban" aria-hidden="true" />
      </span>
      <h2 className={t ? "t-2xl" : "t-xl"} id="h-rev">
        운영자에게 기기 등록을 요청하세요
      </h2>
      <p className={t ? "t-lg fw-m" : "t-md"}>기기 키가 없거나 폐기된 기기입니다. 이 기기로는 근무를 준비할 수 없습니다.</p>
      <Link
        className={t ? "btn btn-outline btn-lg" : "btn btn-outline btn-lg btn-block"}
        href="/login"
        style={t ? { minWidth: 360, maxWidth: "100%" } : undefined}
      >
        로그인 화면으로 돌아가기
      </Link>
    </section>
  ) : null;

  let main: ReactNode;
  if (l) {
    main = (
      <>
        <div className="col" style={{ gap: 10 }}>
          {head}
        {liveError ? (
          <div className="banner banner-danger" role="alert">
            <i className="ic ic-ban" aria-hidden="true" />
            <div className="banner-body">
              <span className="banner-title">실제 스캐너 API에 연결하지 못했습니다</span>
              {liveError}
            </div>
          </div>
        ) : null}
          {revoked ? null : placementCard}
          {revoked ? null : listCard}
        </div>
        <div className="col" style={{ gap: 10 }}>
          {revoked ? null : stats}
          {newVersion}
          {oldBanner}
          {startArea}
        </div>
        {revokedCard}
      </>
    );
  } else if (t) {
    main = (
      <>
        {head}
        {liveError ? (
          <div className="banner banner-danger" role="alert">
            <i className="ic ic-ban" aria-hidden="true" />
            <div className="banner-body">
              <span className="banner-title">실제 스캐너 API에 연결하지 못했습니다</span>
              {liveError}
            </div>
          </div>
        ) : null}
        {revoked ? null : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(2,minmax(0,1fr))", gap: 16 }}>
            {placementCard}
            {listCard}
          </div>
        )}
        {revoked ? null : stats}
        {newVersion}
        {oldBanner}
        {revokedCard}
        {startArea}
      </>
    );
  } else {
    main = (
      <>
        {head}
        {liveError ? (
          <div className="banner banner-danger" role="alert">
            <i className="ic ic-ban" aria-hidden="true" />
            <div className="banner-body">
              <span className="banner-title">실제 스캐너 API에 연결하지 못했습니다</span>
              {liveError}
            </div>
          </div>
        ) : null}
        {revoked ? null : placementCard}
        {revoked ? null : listCard}
        {revoked ? null : stats}
        {newVersion}
        {oldBanner}
        {startArea}
        {revokedCard}
      </>
    );
  }

  return (
    <>
      <ScannerShell
        strip={strip}
        stripStyle={stripStyle(layout)}
        bottom={<ManageLink />}
        bottomStyle={bottomStyle(layout)}
        mainClassName={l ? undefined : "col"}
        mainStyle={
          l
            ? { display: "grid", gridTemplateColumns: "minmax(0,1.1fr) minmax(0,1fr)", gap: 20, padding: "16px 20px" }
            : t
              ? { padding: 24, gap: 20 }
              : { padding: 16, gap: 12 }
        }
      >
        {main}
      </ScannerShell>
      <PreviewSwitcher states={SETUP_STATES} current={st} />
    </>
  );
}
