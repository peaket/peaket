// SCR-035 동기화 상태와 이상 표시, 경로 /sync. 시각 기준: 캔버스 보드 SCR-035-p·t·l. 정본: docs/design/d5 §8.4, d3 SCR-035.
// 업로드 대기·마지막 변경분·반영한 서버 변경 일련번호(StatTile) → 이 기기 관련 이상 표시 표 → [지금 동기화](56px 이상).
// 가로 보드는 '정상'만 그렸다. 가로의 '변경분 지연'·'업로드 실패'는 세로 보드의 경고 모양을 작은 타일에 옮겼다(추천안).
import { ScannerShell } from "@peaket/ds/ScannerShell";
import type { CSSProperties, ReactNode } from "react";
import { formatAge } from "../api/live";
import { PreviewSwitcher, usePreviewState } from "../app/preview";
import { Link } from "../app/router";
import { useScannerLive } from "../app/useScannerLive";
import { deviceFlags, prep, sync } from "../fixtures/scanner";
import { bottomStyle, ManageLink, Strip, stripStyle } from "../shared/shell";

export const SYNC_STATES = ["정상", "변경분 지연", "업로드 실패"] as const;

export function SyncScreen() {
  const { state: previewState, layout, search } = usePreviewState(SYNC_STATES, "정상");
  const live = useScannerLive(search);
  const liveSync = live.mode === "live" ? live.sync : undefined;
  const liveShift = live.mode === "live" ? live.shift : undefined;
  const st = liveSync ? liveSync.state : previewState;
  const t = layout === "t";
  const l = layout === "l";
  const fail = st === "업로드 실패";
  const late = st === "변경분 지연" || fail;
  const queue = liveSync?.queue ?? sync.queue;
  const serverSeq = liveSync ? `#${liveSync.lastSeq}` : sync.serverSeq;
  const listSeq = liveShift ? `#${liveShift.packageSeq}` : prep.listSeq;
  const lastUpload = liveSync?.lastUploadAtMs !== undefined ? formatAge(Date.now() - liveSync.lastUploadAtMs) : sync.lastUpload;
  const feedAge = liveSync ? liveSync.freshness.label : late ? "3분 전" : "1분 전";
  const feedMeta = liveSync ? (liveSync.lastSyncAtMs ? `${formatAge(Date.now() - liveSync.lastSyncAtMs)} 수신` : "받은 적 없음") : late ? "18:41 수신 · 판정은 이 기기의 목록으로 계속합니다" : "18:44 수신 · 화면이 켜진 동안 60초마다 받습니다";
  const flagRows = live.mode === "live" ? live.flags.map((f) => ({ seat: f.seatLabel || f.ticketId.slice(0, 8), kind: f.kind, at: formatAge(Date.now() - Date.parse(f.createdAt)) })) : deviceFlags;

  const strip = <Strip online={!fail} queue={queue} queueCurrent />;

  const title = (
    <div className="row" style={{ gap: 4, marginLeft: -10 }}>
      <Link className="icon-btn" href="/scan" aria-label="스캔 화면으로 돌아가기">
        <i className="ic ic-arrow-left" aria-hidden="true" />
      </Link>
      <h1 className={t ? "t-2xl" : "t-xl"} id={l ? "h-st" : undefined}>
        동기화 상태
      </h1>
    </div>
  );

  const tilePad: CSSProperties = t ? { padding: "16px 18px" } : l ? { padding: "8px 12px", gap: 2 } : { padding: "12px 14px" };
  const smallValue: CSSProperties | undefined = l ? { fontSize: 22, lineHeight: "26px" } : undefined;

  const uploadTile = (
    <div className={fail ? "stat is-breached" : "stat"} style={tilePad}>
      <span className="stat-label">업로드 대기</span>
      <span className="stat-value" style={smallValue}>
        {queue}건
      </span>
      {fail ? (
        <p className={t ? "row t-md fw-b" : "row t-sm fw-b"} id="up-fail" role="alert" style={{ gap: 6, alignItems: "flex-start", color: "var(--danger)" }}>
          <i className="ic ic-alert-circle ic-16" aria-hidden="true" style={t ? { marginTop: 3 } : undefined} />
          업로드 대기 {queue}건 · 연결되면 바로 다시 보냅니다
        </p>
      ) : null}
      <span className="stat-meta">마지막 업로드 {lastUpload}</span>
    </div>
  );

  const feedTile = (
    <div className={late ? "stat is-burning" : "stat"} style={tilePad}>
      <span className="stat-label">마지막 변경분 수신</span>
      {late ? (
        <>
          <div className="row wrap" style={{ gap: "4px 8px" }}>
            <span className="stat-value" style={smallValue}>
              {feedAge}
            </span>
            <span className="badge badge-warning">
              <i className="ic ic-alert" aria-hidden="true" />
              {liveSync?.freshness.resync ? "재동기화 필요" : "변경분 2분 넘게 못 받음"}
            </span>
          </div>
          <span className="stat-meta">{feedMeta} · 판정은 이 기기의 목록으로 계속합니다</span>
        </>
      ) : (
        <>
          <span className="stat-value" style={smallValue}>
            {feedAge}
          </span>
          <span className="stat-meta">{feedMeta} · 화면이 켜진 동안 60초마다 받습니다</span>
        </>
      )}
    </div>
  );

  const seqTile = t ? (
    <div className="stat" style={{ gridColumn: "1 / -1", flexDirection: "row", flexWrap: "wrap", alignItems: "baseline", gap: "4px 16px", padding: "16px 18px" }}>
      <span className="stat-label" style={{ width: "100%" }}>
        반영한 서버 변경 일련번호
      </span>
      <span className="stat-value mono">{serverSeq}</span>
      <span className="stat-meta">목록 {listSeq} 이후 변경분까지 반영했습니다</span>
    </div>
  ) : (
    <div className="stat" style={tilePad}>
      <span className="stat-label">반영한 서버 변경 일련번호</span>
      <span className="stat-value mono" style={l ? smallValue : { fontSize: 26 }}>
        {serverSeq}
      </span>
      <span className="stat-meta">목록 {listSeq} 이후 변경분까지 반영했습니다</span>
    </div>
  );

  const flags = (
    <section className="col" style={{ gap: t ? 10 : 8 }} aria-labelledby="h-fl">
      <div className="row between">
        <h2 className="t-lg" id="h-fl">
          이 기기 관련 이상 표시
        </h2>
        <span className={t ? "badge badge-lg badge-warning" : "badge badge-warning"}>{flagRows.length}건</span>
      </div>
      <div className="table-wrap table-scroll">
        <table className={t ? "table" : "table dense"}>
          <caption className="sr-only">이 기기 관련 이상 표시 {flagRows.length}건: 좌석, 종류, 시각</caption>
          <thead>
            <tr>
              <th scope="col">좌석</th>
              <th scope="col">종류</th>
              <th scope="col" className="r">
                시각
              </th>
            </tr>
          </thead>
          <tbody>
            {flagRows.map((f) => (
              <tr key={f.seat}>
                <td className="fw-b">{f.seat}</td>
                <td>{f.kind}</td>
                <td className="r">{f.at}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );

  // 퍼블리싱 단계: 업로드·변경분 받기는 데이터 연결 단계에서 붙인다
  const syncButton = (
    <button
      className="btn btn-primary btn-xl btn-block"
      type="button"
      onClick={() => void live.syncNow()}
      aria-disabled={fail ? true : undefined}
      aria-describedby={fail ? "up-fail" : undefined}
      style={l ? { marginTop: "auto" } : undefined}
    >
      <i className="ic ic-refresh" aria-hidden="true" />
      지금 동기화
    </button>
  );
  const info = (
    <p className={l ? "row t-sm fw-m" : "row t-md fw-m"} style={{ gap: 8, alignItems: "flex-start" }}>
      <i className={l ? "ic ic-info ic-16" : "ic ic-info"} aria-hidden="true" />
      로그아웃하거나 권한이 해제되어도 남은 기록은 기기 인증으로 올라갑니다
    </p>
  );

  let main: ReactNode;
  if (l) {
    main = (
      <>
        <section className="col" style={{ gap: 8 }} aria-labelledby="h-st">
          {title}
          {uploadTile}
          {feedTile}
          {seqTile}
        </section>
        <div className="col" style={{ gap: 10 }}>
          {flags}
          {syncButton}
          {info}
        </div>
      </>
    );
  } else {
    main = (
      <>
        {title}
        <section className="col" style={t ? undefined : { gap: 10 }} aria-labelledby="h-st">
          <h2 className="sr-only" id="h-st">
            동기화 수치
          </h2>
          {t ? (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(2,minmax(0,1fr))", gap: 16 }}>
              {uploadTile}
              {feedTile}
              {seqTile}
            </div>
          ) : (
            <>
              {uploadTile}
              {feedTile}
              {seqTile}
            </>
          )}
        </section>
        {flags}
        <div className="col" style={{ gap: t ? 12 : 10, marginTop: "auto" }}>
          {syncButton}
          {info}
        </div>
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
            ? { display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)", gap: 20, padding: "12px 20px" }
            : t
              ? { padding: "20px 24px 24px", gap: 20 }
              : { padding: "12px 16px 16px", gap: 12 }
        }
      >
        {main}
      </ScannerShell>
      <PreviewSwitcher states={SYNC_STATES} current={st} />
    </>
  );
}
