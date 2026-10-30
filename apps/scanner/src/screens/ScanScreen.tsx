// SCR-034 티켓 스캔 및 판정, 경로 /scan. 시각 기준: 캔버스 보드 SCR-034-p·t·l. 정본: docs/design/d5 §8.3, d3 SCR-034.
// - 휴대폰 세로: 모드 띠 + 뷰파인더 + 책임자 도구, 판정 결과는 화면 아래 절반을 덮는다(CMP-041, 화면 절반 이상).
// - 태블릿: 뷰파인더와 판정을 위아래로 크게 두고(판정 600px), 최근 판정 표를 아래에 둔다(d5 §3.4).
// - 휴대폰 가로: 왼쪽 뷰파인더·도구, 오른쪽 400px 칸을 판정이 채운다.
// - 카메라 뷰는 자리 표시(CMP-042)다. 실제 카메라·디코딩·판정 Worker·소리·진동은 wbs 5.x에서 붙인다.
// 보드 상태 9개 뒤에 d5 판정 표의 거부 사유 8가지·판정 오류와 '예외 통과'(d5 모달 와이어프레임)를 상태로 더했다.
import { CameraView } from "@peaket/ds/CameraView";
import { ScannerShell } from "@peaket/ds/ScannerShell";
import { ScanResult, type ScanTone } from "@peaket/ds/ScanResult";
import { useCallback, useState, type CSSProperties, type ReactNode } from "react";
import type { ScannerLayout } from "../app/layout";
import { PreviewSwitcher, usePreviewState } from "../app/preview";
import { placement, recentScans, sync } from "../fixtures/scanner";
import { bottomStyle, ManageLink, Strip, stripStyle } from "../shared/shell";
import { OverrideDialog, OverrideInline } from "./OverrideForm";

const REJECT_REASONS = {
  "거부 · 유효하지 않은 QR": "유효하지 않은 QR입니다",
  "거부 · 다른 회차": "이 회차 티켓이 아니거나 발권되지 않은 티켓입니다",
  "거부 · 취소·무효": "취소되었거나 무효가 된 티켓입니다",
  "거부 · 옛 QR": "양도·취소·재발급된 티켓의 옛 QR입니다",
  "거부 · 키 미반영": "키가 아직 반영되지 않았습니다. 부스나 책임자에게 안내하세요",
  "거부 · 위조 의심": "위조가 의심됩니다",
  "거부 · 시각 초과": "유효시간이 지난 QR입니다",
  "거부 · 다른 게이트": "다른 게이트 티켓입니다(서문)",
} as const;
type RejectState = keyof typeof REJECT_REASONS;

export const SCAN_STATES = [
  "통과",
  "거부",
  "확인 필요",
  "확인 스캔",
  "오프라인",
  "카메라 권한 대기",
  "카메라 고장(스태프)",
  "카메라 고장(책임자)",
  "퇴장 모드",
  "예외 통과",
  "거부 · 유효하지 않은 QR",
  "거부 · 다른 회차",
  "거부 · 취소·무효",
  "거부 · 옛 QR",
  "거부 · 키 미반영",
  "거부 · 위조 의심",
  "거부 · 시각 초과",
  "거부 · 다른 게이트",
  "판정 오류",
] as const satisfies readonly string[];
type ScanState = (typeof SCAN_STATES)[number];

const SEAT = "R구역 12열 8번";
/** 좌석을 알 수 없는 거부(디코딩 실패·목록에 없는 티켓)는 좌석 줄을 두지 않는다(추천안) */
const NO_SEAT: ReadonlySet<string> = new Set(["거부 · 유효하지 않은 QR", "거부 · 다른 회차", "판정 오류"]);

interface Verdict {
  tone: ScanTone;
  verdict: string;
  reason?: string;
  note?: string;
  verify?: boolean;
  seat?: string;
  icon?: string;
}

function verdictFor(st: ScanState): Verdict | null {
  if (st === "통과" || st === "오프라인") return { tone: "pass", verdict: "통과", seat: SEAT };
  if (st === "거부") return { tone: "reject", verdict: "거부", reason: "이미 입장한 티켓입니다(19:02, 동문)", seat: SEAT };
  if (st === "확인 필요")
    return { tone: "check", verdict: "확인 필요", reason: "퇴장 기록 없음", note: "현장 책임자 확인 전에는 들여보내지 마세요", seat: SEAT };
  if (st === "퇴장 모드") return { tone: "check", verdict: "확인 필요", reason: "입장 기록 없음", seat: SEAT };
  if (st === "확인 스캔") return { tone: "verify", verdict: "통과", verify: true, seat: "R구역 12열 7번" };
  // d5 '판정 중 오류 → 통과시키지 않는다 · 다시 찍어 주세요'. 색·아이콘은 황색·다시(추천안)
  if (st === "판정 오류") return { tone: "check", verdict: "다시 찍어 주세요", icon: "refresh" };
  if (st in REJECT_REASONS) {
    const reason = REJECT_REASONS[st as RejectState];
    return { tone: "reject", verdict: "거부", reason, seat: NO_SEAT.has(st) ? undefined : SEAT };
  }
  return null; // 카메라 상태·예외 통과
}

export function ScanScreen() {
  const { state, layout } = usePreviewState(SCAN_STATES, "통과");
  // 상태가 바뀌면 화면 안의 켜고 끄는 값(확인 스캔 대기, 대화상자)을 처음으로 돌린다
  return (
    <>
      <ScanBody key={state} st={state} layout={layout} />
      <PreviewSwitcher states={SCAN_STATES} current={state} />
    </>
  );
}

function ScanBody({ st, layout }: { st: ScanState; layout: ScannerLayout }) {
  const [verifyOn, setVerifyOn] = useState(st === "확인 스캔");
  const [dialogOpen, setDialogOpen] = useState(st === "예외 통과");
  const closeDialog = useCallback(() => setDialogOpen(false), []);

  const t = layout === "t";
  const l = layout === "l";
  const isStaff = st === "카메라 고장(스태프)";
  const camLead = st === "카메라 고장(책임자)";
  const perm = st === "카메라 권한 대기";
  const cam = isStaff || camLead || perm;
  const off = st === "오프라인";
  const out = st === "퇴장 모드";
  const result = verdictFor(st);

  const strip = <Strip asStaff={isStaff} online={!off} mode={out ? "out" : "in"} queue={off ? sync.queue : 0} />;

  const modeBar = (
    <div
      className={cx(out ? "mode-out" : "mode-in", "row")}
      style={{
        justifyContent: "center",
        gap: t ? 10 : 8,
        height: t ? 56 : l ? 44 : 48,
        fontSize: t ? 24 : 20,
        lineHeight: t ? "32px" : "27px",
        fontWeight: 800,
        flex: "none",
      }}
    >
      <i className={cx("ic", out ? "ic-arrow-left" : "ic-arrow-right", t ? "ic-28" : "ic-24")} aria-hidden="true" />
      {out ? "퇴장 모드" : "입장 모드"}
      <span style={t ? { fontSize: 18, lineHeight: "24px", fontWeight: 700 } : { fontSize: 16, fontWeight: 700 }}>· {placement.zone}</span>
    </div>
  );

  const offlineBanner = off ? (
    <div className="banner banner-offline banner-strip" role="status" style={t ? { padding: "10px 24px" } : undefined}>
      <i className="ic ic-wifi-off" aria-hidden="true" />
      <div className="banner-body">
        <span className="fw-b">오프라인 · 마지막 변경분 3분 전</span>
        <br />
        판정은 이 기기의 목록으로 계속합니다.
      </div>
    </div>
  ) : null;

  const caption = verifyOn ? (
    <p className={t ? "t-md fw-b" : "t-sm fw-b"} style={{ textAlign: "center", padding: t ? "0 24px" : "0 16px" }}>
      확인 스캔: 다음 한 번만 판정하고 입장 기록을 남기지 않습니다. 찍으면 입장 판정으로 돌아갑니다
    </p>
  ) : (
    <p className={t ? "t-lg" : "t-md fw-b"}>QR을 네모 안에 맞춰 주세요</p>
  );

  const vfStyle: CSSProperties = t
    ? { height: 220, flex: "none", alignContent: "center", rowGap: 10 }
    : l
      ? { flex: 1, alignContent: "center", rowGap: 8 }
      : { flex: 1, placeItems: "start center", alignContent: "start", rowGap: 10, paddingTop: off ? 6 : 30 };
  const viewfinder = (
    <CameraView label="카메라 뷰파인더" frameWidth={t ? 150 : l ? 138 : off ? 120 : 140} style={vfStyle}>
      {caption}
    </CameraView>
  );

  // 휴대폰 폭(320~360)에서 '확인 스캔 대기(한 번)'이 버튼 밖으로 넘치지 않게 두 줄을 허용한다(높이 56은 그대로)
  const fieldWrap: CSSProperties | undefined = t ? undefined : { whiteSpace: "normal", padding: "0 12px", lineHeight: "20px" };
  const tools = (
    <div
      role="group"
      aria-label="현장 책임자 도구"
      className={t ? undefined : "row"}
      style={
        t
          ? {
              display: "grid",
              gridTemplateColumns: "repeat(2,minmax(0,1fr))",
              gap: 16,
              padding: "12px 24px",
              background: "var(--surface)",
              borderTop: "1px solid var(--border)",
            }
          : {
              gap: 16,
              padding: l ? "6px 12px" : 12,
              background: "var(--surface)",
              flex: "none",
              ...(l ? { borderTop: "1px solid var(--border)" } : null),
            }
      }
    >
      <button
        className={cx("btn btn-secondary btn-field", t ? "btn-block" : "grow")}
        type="button"
        aria-haspopup="dialog"
        onClick={() => setDialogOpen(true)}
        style={fieldWrap}
      >
        <i className="ic ic-hand" aria-hidden="true" />
        예외 통과
      </button>
      <button
        className={cx("btn btn-field", verifyOn ? "btn-primary" : "btn-outline", t ? "btn-block" : "grow")}
        type="button"
        aria-pressed={verifyOn}
        onClick={() => setVerifyOn((v) => !v)}
        style={fieldWrap}
      >
        <i className="ic ic-scan" aria-hidden="true" />
        {verifyOn ? "확인 스캔 대기(한 번)" : "확인 스캔"}
      </button>
    </div>
  );

  const camCardWrap = (node: ReactNode) =>
    t ? (
      // 보드 -t는 이 칸을 보드 높이에 맞춰 그렸다(897·966px). 페이지에서는 남은 높이를 채운다
      <div className="col" style={{ flex: 1, minHeight: 480, padding: 24 }}>
        {node}
      </div>
    ) : (
      node
    );
  const camCardStyle: CSSProperties = t
    ? { flex: 1, justifyContent: "center", padding: "48px 40px", gap: 16 }
    : { margin: 16, padding: "32px 20px" };

  const permCard = perm
    ? camCardWrap(
        <section className="card state" role="status" style={camCardStyle} aria-labelledby="h-perm">
          <span className="state-icon is-primary">
            <i className="ic ic-scan" aria-hidden="true" />
          </span>
          <h2 className={t ? "t-2xl" : "t-xl"} id="h-perm">
            카메라 권한을 허용해 주세요
          </h2>
          <p className={t ? "t-lg fw-m" : "t-md"}>티켓 QR을 찍으려면 카메라가 필요합니다. 기기에 뜬 권한 요청에서 허용을 누르세요.</p>
        </section>,
      )
    : null;

  const staffCard = isStaff
    ? camCardWrap(
        <section className="card state" role="alert" style={camCardStyle} aria-labelledby="h-cam">
          <span className="state-icon is-danger">
            <i className="ic ic-alert" aria-hidden="true" />
          </span>
          <h2 className={t ? "t-2xl" : "t-xl"} id="h-cam">
            예비 기기로 바꾸거나 현장 책임자를 부르세요
          </h2>
          <p className={t ? "t-lg fw-m" : "t-md"}>이 기기의 카메라를 쓸 수 없어 티켓을 판정할 수 없습니다.</p>
          <button
            className={t ? "btn btn-outline btn-lg" : "btn btn-outline btn-lg btn-block"}
            type="button"
            style={t ? { minWidth: 320, maxWidth: "100%" } : undefined}
          >
            <i className="ic ic-refresh" aria-hidden="true" />
            카메라 다시 켜기
          </button>
        </section>,
      )
    : null;

  const leadForm = camLead ? <OverrideInline layout={layout} /> : null;

  const resultEl = (style: CSSProperties) =>
    result ? (
      <ScanResult
        tone={result.tone}
        verdict={result.verdict}
        reason={result.reason}
        note={result.note}
        verify={result.verify}
        seat={result.seat}
        icon={result.icon}
        next="2초 뒤 다음 스캔"
        size={t ? "lg" : "md"}
        layout={l ? "inline" : "stack"}
        style={style}
      />
    ) : null;

  const dialog = dialogOpen ? <OverrideDialog layout={layout} onClose={closeDialog} /> : null;

  if (l) {
    // 가로: 아래 바(현장 관리)가 오른쪽 칸 아래에 있다(보드 -l)
    return (
      <>
        <ScannerShell
          strip={strip}
          mainStyle={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 400px" }}
        >
          <div className="col" style={{ minWidth: 0 }}>
            <h1 className="sr-only">티켓 스캔 및 판정</h1>
            {modeBar}
            {offlineBanner}
            {cam ? null : viewfinder}
            {permCard}
            {staffCard}
            {leadForm}
            {cam ? null : tools}
          </div>
          <div className="col" style={{ position: "relative", minWidth: 0, borderLeft: "1px solid var(--border)" }}>
            {isStaff ? null : (
              <nav className="ss-bottom" aria-label="스캐너 메뉴" style={{ marginTop: "auto", padding: "6px 12px", justifyContent: "flex-end" }}>
                <ManageLink />
              </nav>
            )}
            {resultEl({ position: "absolute", inset: 0, zIndex: 5 })}
          </div>
        </ScannerShell>
        {dialog}
      </>
    );
  }

  if (t) {
    return (
      <>
        <ScannerShell
          strip={strip}
          stripStyle={stripStyle(layout)}
          bottom={isStaff ? undefined : <ManageLink />}
          bottomStyle={bottomStyle(layout)}
          mainClassName="col"
        >
          <h1 className="sr-only">티켓 스캔 및 판정</h1>
          {modeBar}
          {offlineBanner}
          {cam ? null : viewfinder}
          {cam ? null : resultEl({ minHeight: off ? 540 : 600, flex: "none" })}
          {permCard}
          {staffCard}
          {leadForm}
          {cam ? null : tools}
          <RecentScans />
        </ScannerShell>
        {dialog}
      </>
    );
  }

  return (
    <>
      <ScannerShell strip={strip} bottom={isStaff ? undefined : <ManageLink />} mainClassName="col">
        <h1 className="sr-only">티켓 스캔 및 판정</h1>
        {modeBar}
        {offlineBanner}
        {cam ? null : viewfinder}
        {cam ? null : tools}
        {permCard}
        {staffCard}
        {leadForm}
        {/* 판정 오버레이: 셸(.ss, position:relative) 아래 절반을 덮는다(보드 -p: 780 중 390) */}
        {resultEl({ position: "absolute", left: 0, right: 0, bottom: 0, height: "50%", zIndex: 5 })}
      </ScannerShell>
      {dialog}
    </>
  );
}

function RecentScans() {
  return (
    <section
      className="col"
      style={{ gap: 10, padding: "16px 24px 20px", background: "var(--surface)", borderTop: "1px solid var(--border)" }}
      aria-labelledby="h-recent"
    >
      <div className="row between">
        <h2 className="t-lg" id="h-recent">
          최근 판정
        </h2>
        <span className="t-sm fw-b">이 기기 · 최근 {recentScans.length}건</span>
      </div>
      <div className="table-wrap table-scroll">
        <table className="table dense">
          <caption className="sr-only">이 기기의 최근 판정 {recentScans.length}건: 시각, 판정, 좌석, 사유</caption>
          <thead>
            <tr>
              <th scope="col">시각</th>
              <th scope="col">판정</th>
              <th scope="col">좌석</th>
              <th scope="col">사유</th>
            </tr>
          </thead>
          <tbody>
            {recentScans.map((r) => (
              <tr key={r.at}>
                <td className="mono">{r.at}</td>
                <td>
                  {r.verdict === "pass" ? (
                    <span className="badge badge-success">
                      <i className="ic ic-check-circle" aria-hidden="true" />
                      통과
                    </span>
                  ) : (
                    <span className="badge badge-danger">
                      <i className="ic ic-x-circle" aria-hidden="true" />
                      거부
                    </span>
                  )}
                </td>
                <td className="fw-b">{r.seat}</td>
                <td className={r.reason ? undefined : "muted"}>{r.reason ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}
