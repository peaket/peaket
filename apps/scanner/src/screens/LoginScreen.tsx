// SCR-036 현장 스태프 로그인(기기 승인), 경로 /login. 그리고 기기 등록 /enroll(frontend §2.5 경로표).
// 시각 기준: 캔버스 보드 SCR-036-p·t·l과 흐름 보드 FLOW-staff-login. 정본: docs/design/d5 §8.1, d3 SCR-036.
// 셸은 '스캐너(상태 띠만)'라 아래 바가 없다. 아이디·비밀번호 없이 내 휴대폰으로 QR을 찍어 승인한다(RFC 8628).
// /enroll은 d5에 따로 화면이 없어 같은 화면의 '기기 등록'·'등록 시도 초과' 상태를 그린다(추천안).
import { CameraView } from "@peaket/ds/CameraView";
import { DeviceApprovalPanel } from "@peaket/ds/DeviceApprovalPanel";
import { ScannerShell, ScannerStatusStrip } from "@peaket/ds/ScannerShell";
import type { CSSProperties, ReactNode } from "react";
import type { ScannerLayout } from "../app/layout";
import { PreviewSwitcher, usePreviewState } from "../app/preview";
import { Link } from "../app/router";
import { approval, device, lead } from "../fixtures/scanner";
import { logout, stripStyle } from "../shared/shell";

export const LOGIN_STATES = [
  "승인 대기",
  "새 코드로 바뀜",
  "승인 거부됨",
  "승인 완료",
  "승인 완료(대리 승인)",
  "코드 발급 한도 초과",
  "미등록·폐기 기기",
  "기기 등록",
  "등록 시도 초과",
  "세션 끝",
] as const;
export const ENROLL_STATES = ["기기 등록", "등록 시도 초과"] as const;

type LoginState = (typeof LOGIN_STATES)[number];

const ENDED_REASONS = [
  "권한이 해제되었습니다",
  "이 기기가 폐기되었습니다",
  "다음 스태프가 로그인해 이전 세션이 끝났습니다",
  "같은 계정이 다른 스캐너에서 로그인해 이 기기의 세션이 끝났습니다",
  "휴대폰에서 이 스캐너 세션을 끝냈습니다",
  "계정이 탈퇴되어 로그아웃되었습니다",
];

export function LoginScreen({ enroll = false }: { enroll?: boolean }) {
  const states: readonly LoginState[] = enroll ? ENROLL_STATES : LOGIN_STATES;
  const { state: st, layout } = usePreviewState(states, enroll ? "기기 등록" : "승인 대기");

  const fresh = st === "새 코드로 바뀜" || st === "승인 거부됨";
  const old = st === "승인 대기" || st === "세션 끝";
  const v = {
    showCode: old || fresh,
    isNewCode: st === "새 코드로 바뀜",
    isRejected: st === "승인 거부됨",
    isEnded: st === "세션 끝",
    isApproved: st === "승인 완료",
    isProxy: st === "승인 완료(대리 승인)",
    isLimited: st === "코드 발급 한도 초과",
    isRevoked: st === "미등록·폐기 기기",
    isEnroll: st === "기기 등록",
    isEnrollLimit: st === "등록 시도 초과",
  };
  const enrollHead = v.isEnroll || v.isEnrollLimit;
  const certOk = !v.isRevoked && !enrollHead;

  const strip = (
    <ScannerStatusStrip
      user={v.isApproved || v.isProxy ? { name: lead.name, initial: lead.initial } : undefined}
      role={
        v.isApproved
          ? { label: lead.role, tone: "lead" }
          : v.isProxy
            ? { label: "현장 스태프 권한(대리)", tone: "proxy" }
            : undefined
      }
      extra={
        <>
          {enrollHead ? (
            <>
              <span className="who">
                <i className="ic ic-device ic-16" aria-hidden="true" />
                스캐너
              </span>
              <span className="badge badge-warning">
                <i className="ic ic-alert" aria-hidden="true" />
                등록되지 않은 기기
              </span>
            </>
          ) : (
            <>
              <span className="who">
                <i className="ic ic-device ic-16" aria-hidden="true" />
                기기 {device.name}
              </span>
              <span className="badge badge-outline">배정 파트너 {device.partner}</span>
            </>
          )}
          {certOk ? (
            <span className="badge badge-success">
              <i className="ic ic-shield" aria-hidden="true" />
              기기 키 등록됨
            </span>
          ) : null}
          {v.isRevoked ? (
            <span className="badge badge-danger">
              <i className="ic ic-ban" aria-hidden="true" />
              폐기된 기기
            </span>
          ) : null}
        </>
      }
    />
  );

  const t = layout === "t";
  const l = layout === "l";
  const full: CSSProperties | undefined = l ? { gridColumn: "1 / -1" } : undefined;
  const bannerText: CSSProperties | undefined = t ? { fontSize: 16, lineHeight: "22px" } : undefined;

  const body: ReactNode = (
    <>
      <h1 className={t ? "t-2xl" : l ? "t-lg" : "t-xl"} style={t ? { textAlign: "center" } : full}>
        현장 스태프 로그인
      </h1>

      {v.isEnded ? (
        <div className="banner banner-warning" role="alert" style={{ ...bannerText, ...full }}>
          <i className="ic ic-logout" aria-hidden="true" />
          <div className="banner-body">
            <span className="banner-title">근무 시간이 끝나 로그아웃되었습니다</span>
            남은 업로드 기록은 기기 인증으로 올라갑니다.
            <details open style={{ marginTop: 8 }}>
              <summary style={{ cursor: "pointer", fontWeight: 700 }}>다른 이유로 끝나는 경우</summary>
              <ul
                style={{
                  marginTop: 6,
                  paddingLeft: t ? 22 : 20,
                  listStyle: "disc",
                  ...(l ? { columnCount: 2, columnGap: 32 } : null),
                }}
              >
                {ENDED_REASONS.map((r) => (
                  <li key={r} style={{ padding: "2px 0" }}>
                    {r}
                  </li>
                ))}
              </ul>
            </details>
          </div>
        </div>
      ) : null}

      {v.isNewCode ? (
        <div className="banner banner-info" role="status" style={{ ...bannerText, ...full }}>
          <i className="ic ic-refresh" aria-hidden="true" />
          <div className="banner-body fw-b">확인 코드가 바뀌었습니다. 휴대폰에서 QR을 다시 찍어 주세요</div>
        </div>
      ) : null}

      {v.isRejected ? (
        <div className="banner banner-warning" role="alert" style={{ ...bannerText, ...full }}>
          <i className="ic ic-ban" aria-hidden="true" />
          <div className="banner-body fw-b">휴대폰에서 승인을 거부했습니다. 새 코드를 띄웠습니다</div>
        </div>
      ) : null}

      {v.showCode ? <WaitingBlock layout={layout} fresh={fresh} /> : null}
      {v.isApproved ? <ApprovedBlock layout={layout} proxy={false} /> : null}
      {v.isProxy ? <ApprovedBlock layout={layout} proxy /> : null}
      {v.isLimited ? <LimitedBlock layout={layout} /> : null}
      {v.isEnrollLimit ? (
        <StateCard layout={layout} tone="warning" icon="clock" title="잠시 뒤 다시 시도하세요" headingId="h-enl">
          <p className={t ? "t-lg fw-m" : "t-md"}>등록 시도가 많아 10분 동안 막았습니다</p>
        </StateCard>
      ) : null}
      {v.isRevoked ? (
        <StateCard
          layout={layout}
          tone="danger"
          icon="ban"
          title="운영자에게 기기 등록을 요청하세요"
          headingId="h-rev"
          wide
          padding={t ? "56px 40px" : l ? "28px 32px" : "36px 20px"}
        >
          <p className={t ? "t-lg fw-m" : "t-md"}>
            등록되지 않았거나 폐기된 기기에서는 로그인할 수 없습니다. 운영자에게 기기 이름 {device.name}을 알려 주세요.
          </p>
        </StateCard>
      ) : null}
      {v.isEnroll ? <EnrollBlock layout={layout} /> : null}
    </>
  );

  return (
    <>
      <ScannerShell
        strip={strip}
        stripLabel="스캐너 기기 정보"
        stripStyle={stripStyle(layout)}
        mainClassName={l ? undefined : "col"}
        mainStyle={
          t
            ? { padding: "32px 40px 40px", justifyContent: "center" }
            : l
              ? {
                  display: "grid",
                  gridTemplateColumns: "300px minmax(0,1fr)",
                  gap: "12px 24px",
                  padding: "14px 20px 20px",
                  alignContent: "start",
                  alignItems: "start",
                }
              : { padding: "16px 16px 24px", gap: 14 }
        }
      >
        {t ? (
          <div className="col" style={{ width: "100%", maxWidth: 600, margin: "0 auto", gap: 24 }}>
            {body}
          </div>
        ) : (
          body
        )}
      </ScannerShell>
      <PreviewSwitcher states={states} current={st} />
    </>
  );
}

function Steps({ layout }: { layout: ScannerLayout }) {
  const t = layout === "t";
  const items = [
    layout === "l" ? "내 휴대폰 카메라로 왼쪽 QR을 찍습니다" : "내 휴대폰 카메라로 아래 QR을 찍습니다",
    "휴대폰에 나온 확인 코드가 이 화면의 코드와 같은지 봅니다",
    "휴대폰에서 [로그인 승인]을 누르면 이 화면이 바로 넘어갑니다",
  ];
  return (
    <ol className="card-flat col" style={{ gap: layout === "l" ? 10 : 12, padding: t ? "16px 20px" : layout === "l" ? "12px 14px" : "14px 16px" }}>
      {items.map((text, i) => (
        <li key={text} className="row" style={{ gap: t ? 12 : 10, alignItems: t ? "center" : "flex-start" }}>
          <span
            className="step-num"
            aria-hidden="true"
            style={{
              width: t ? 32 : 28,
              height: t ? 32 : 28,
              fontSize: t ? 15 : 14,
              background: "var(--primary)",
              borderColor: "var(--primary)",
              color: "var(--text-on-primary)",
            }}
          >
            {i + 1}
          </span>
          <span className="t-md fw-m grow" style={t ? undefined : { paddingTop: 3 }}>
            {text}
          </span>
        </li>
      ))}
    </ol>
  );
}

function WaitingBlock({ layout, fresh }: { layout: ScannerLayout; fresh: boolean }) {
  const t = layout === "t";
  const l = layout === "l";
  const panel = (
    <DeviceApprovalPanel
      size={t ? "lg" : "md"}
      qrWidth={t ? 320 : l ? 188 : 196}
      qrSeed={fresh ? 73 : 41}
      qrLabel={`기기 승인 QR, 스캐너 ${device.name} 로그인용, 5분마다 바뀝니다`}
      code={fresh ? approval.nextCode : approval.code}
      deviceName={device.name}
      timer={fresh ? { text: "5:00", label: "확인 코드 남은 시간 5분" } : { text: "4:12", label: "확인 코드 남은 시간 4분 12초" }}
      timerNote="5분이 지나면 새 코드로 자동으로 바뀝니다"
    />
  );
  const lead = (
    <p className={t ? "t-lg fw-m" : "t-md"} style={t ? { textAlign: "center" } : undefined}>
      이 스캐너는 여러 사람이 함께 쓰는 기기라 아이디와 비밀번호를 넣지 않습니다. 내 휴대폰으로 승인해 로그인합니다.
    </p>
  );
  const prompt = (
    <p className={t ? "t-xl" : "t-lg"} style={l ? undefined : { textAlign: "center" }}>
      휴대폰으로 QR을 열어 확인 코드가 같은지 보고 승인하세요
    </p>
  );
  const progress = (
    <div className="progress progress-lg indet" role="progressbar" aria-label="승인 기다리는 중" aria-valuetext="승인 기다리는 중">
      <span />
    </div>
  );
  const status = (
    <p className={t ? "t-md fw-b" : "t-sm fw-b"} style={l ? undefined : { textAlign: "center" }} role="status">
      승인 기다리는 중 · 휴대폰에서 거부하면 새 코드를 띄웁니다
    </p>
  );
  const info = (
    <p
      className={t ? "t-md fw-m row" : "t-sm fw-m row"}
      style={{
        gap: t ? 8 : 6,
        alignItems: "flex-start",
        borderTop: "1px solid var(--border)",
        ...(t ? { justifyContent: "center", paddingTop: 16 } : l ? { paddingTop: 10 } : { marginTop: "auto", paddingTop: 12 }),
      }}
    >
      <i className={t ? "ic ic-info" : "ic ic-info ic-16"} aria-hidden="true" style={{ marginTop: t ? 1 : 2 }} />
      <span className={t ? undefined : "grow"}>
        휴대폰이 없으면 현장 책임자에게 대리 승인을 요청하세요 · 로그인은 입장 시작 3시간 전({approval.loginOpens})부터 됩니다
      </span>
    </p>
  );

  if (l) {
    return (
      <>
        {panel}
        <section className="col" style={{ gap: 10 }} aria-label="로그인 안내와 승인 상태">
          {lead}
          <Steps layout={layout} />
          {prompt}
          {progress}
          {status}
          {info}
        </section>
      </>
    );
  }
  return (
    <>
      {lead}
      <Steps layout={layout} />
      {panel}
      {prompt}
      <div className="col" style={{ gap: 8 }}>
        {progress}
        {status}
      </div>
      {info}
    </>
  );
}

function ApprovedBlock({ layout, proxy }: { layout: ScannerLayout; proxy: boolean }) {
  const t = layout === "t";
  const l = layout === "l";
  const headingId = proxy ? "h-px" : "h-ok";
  const outId = proxy ? "out-h2" : "out-h";
  const kvStyle: CSSProperties = t
    ? { fontSize: 18, lineHeight: "26px", gap: "12px 24px" }
    : l
      ? { fontSize: 15, lineHeight: "21px" }
      : { fontSize: 16, lineHeight: "22px" };
  // 가로 배치는 카드가 곧 왼쪽 칸의 구역이다(보드 -l: section.card)
  const CardTag = l ? "section" : "div";
  const card = (
    <CardTag
      className="card col"
      role="alert"
      aria-labelledby={l ? headingId : undefined}
      style={{ gap: t ? 16 : l ? 10 : 14, padding: t ? 28 : l ? 16 : 20, border: "2px solid var(--success)" }}
    >
      <div className="row" style={{ gap: t ? 16 : l ? 10 : 12 }}>
        <span className="state-icon is-success" style={t ? undefined : { width: l ? 44 : 56, height: l ? 44 : 56 }}>
          <i className="ic ic-check-circle" aria-hidden="true" />
        </span>
        <h2 className={t ? "t-2xl" : "t-xl"} id={headingId}>
          로그인했습니다
        </h2>
      </div>
      <p className={t ? "t-xl" : l ? "t-md fw-b" : "t-lg"}>
        {proxy
          ? `${lead.name}(${lead.role})의 대리 승인 · 일반 스태프 권한 · ${approval.shiftEnds}까지`
          : `${lead.name} · ${lead.role} · ${approval.shiftEnds}까지`}
      </p>
      {proxy ? (
        <dl className="kv" style={kvStyle}>
          <dt>계정</dt>
          <dd>
            {lead.name}({lead.role})
          </dd>
          <dt>권한</dt>
          <dd>일반 스태프(예외 통과·현장 관리 없음)</dd>
          <dt>승인 방식</dt>
          <dd>대리 승인</dd>
          <dt>기록</dt>
          <dd>이 스캐너의 스캔 기록은 {lead.name} 계정으로 남습니다</dd>
        </dl>
      ) : (
        <dl className="kv" style={kvStyle}>
          <dt>닉네임</dt>
          <dd>{lead.name}</dd>
          <dt>역할</dt>
          <dd>
            <span className={t ? "badge badge-solid badge-lg" : "badge badge-solid"}>{lead.role}</span>
          </dd>
          <dt>승인 방식</dt>
          <dd>본인 휴대폰 승인</dd>
          <dt>권한 유효</dt>
          <dd className="num">{approval.validRange}</dd>
        </dl>
      )}
    </CardTag>
  );
  const proxyNote = proxy ? (
    <p className={t ? "t-lg fw-m" : "t-md"}>
      휴대폰을 쓸 수 없는 스태프를 위해 현장 책임자가 대신 승인했습니다. 이 세션에서는 예외 통과·확인 스캔·현장 관리를 쓸 수 없습니다.
    </p>
  ) : null;
  const actions = (
    <>
      <Link className="btn btn-primary btn-xl btn-block" href="/setup">
        근무 준비로 가기
      </Link>
      <button className="btn btn-outline btn-lg btn-block" type="button" aria-describedby={outId} onClick={logout}>
        <i className="ic ic-logout" aria-hidden="true" />
        안전하게 로그아웃
      </button>
      <p className={t ? "t-md" : "t-sm"} id={outId}>
        온라인이면 업로드 대기를 먼저 올린 뒤 세션을 끝냅니다.
      </p>
    </>
  );
  if (l) {
    return (
      <>
        {card}
        <section className="col" style={{ gap: 12 }} aria-label="다음 할 일">
          {proxyNote}
          {actions}
        </section>
      </>
    );
  }
  return (
    <section className="col" style={{ gap: t ? 16 : 14 }} aria-labelledby={headingId}>
      {card}
      {proxyNote}
      {actions}
    </section>
  );
}

function StateCard({
  layout,
  tone,
  icon,
  title,
  headingId,
  wide = false,
  padding,
  children,
}: {
  layout: ScannerLayout;
  tone: "warning" | "danger";
  icon: string;
  title: string;
  headingId: string;
  wide?: boolean;
  padding?: string;
  children: ReactNode;
}) {
  const t = layout === "t";
  const l = layout === "l";
  return (
    <section
      className="card state"
      role="alert"
      aria-labelledby={headingId}
      style={{
        padding: padding ?? (t ? "48px 40px" : l ? "24px 20px" : "32px 20px"),
        ...(t || l ? { gap: t ? 16 : 12 } : null),
        ...(l && wide ? { gridColumn: "1 / -1" } : null),
      }}
    >
      <span className={`state-icon is-${tone}`}>
        <i className={`ic ic-${icon}`} aria-hidden="true" />
      </span>
      <h2 className={t ? "t-2xl" : "t-xl"} id={headingId}>
        {title}
      </h2>
      {children}
    </section>
  );
}

function LimitedBlock({ layout }: { layout: ScannerLayout }) {
  const t = layout === "t";
  const l = layout === "l";
  const retry = (
    <>
      <span className="timer is-warning" role="timer" aria-label="다시 받을 수 있을 때까지 12분 40초">
        <i className="ic ic-clock" aria-hidden="true" />
        12:40
      </span>
      <button className="btn btn-primary btn-xl btn-block" type="button" aria-disabled="true" aria-describedby="lim-why">
        새 확인 코드 받기
      </button>
      <p className={t ? "t-md fw-b" : "t-sm fw-b"} id="lim-why">
        12분 40초 뒤에 누를 수 있습니다
      </p>
    </>
  );
  const note = <p className={t ? "t-lg fw-m" : "t-md"}>확인 코드는 기기당 한 시간에 10번까지 받습니다.</p>;
  if (l) {
    return (
      <>
        <StateCard layout={layout} tone="warning" icon="clock" title="잠시 뒤 다시 시도하세요" headingId="h-lim">
          {note}
        </StateCard>
        <section className="col" style={{ gap: 12, alignItems: "center", paddingTop: 16 }} aria-label="새 확인 코드 받기">
          {retry}
        </section>
      </>
    );
  }
  return (
    <StateCard layout={layout} tone="warning" icon="clock" title="잠시 뒤 다시 시도하세요" headingId="h-lim">
      {note}
      {retry}
    </StateCard>
  );
}

function EnrollBlock({ layout }: { layout: ScannerLayout }) {
  const t = layout === "t";
  const l = layout === "l";
  const scan = (
    <div className="col" style={{ gap: t ? 8 : 6 }}>
      <span className="label">QR 찍기</span>
      <CameraView
        label="기기 등록 QR을 찍는 카메라 화면"
        asImage
        frameWidth={t ? 170 : 150}
        style={{ height: t ? 240 : 200, borderRadius: 12 }}
      />
    </div>
  );
  const field = (
    <div className="field">
      <label className="label" htmlFor="enr-code">
        등록 코드
      </label>
      <input
        className="input"
        id="enr-code"
        type="text"
        placeholder="XXXX-XXXX-XXXX"
        autoComplete="off"
        autoCapitalize="characters"
        spellCheck={false}
        aria-describedby="enr-h"
        style={{ height: 56, fontFamily: "var(--mono)", fontSize: 20, letterSpacing: ".04em" }}
      />
      <span className="hint" id="enr-h">
        대문자·하이픈·공백은 구분하지 않습니다
      </span>
    </div>
  );
  // 퍼블리싱 단계: 키 만들기·등록(POST /v1/scanner/device-enrollments)은 데이터 연결 단계에서 붙인다
  const submit = (
    <button className="btn btn-primary btn-xl btn-block" type="button">
      기기 등록
    </button>
  );
  return (
    <section
      className="card col"
      style={{ gap: t ? 20 : l ? 14 : 16, padding: t ? 28 : l ? "16px 20px" : 20, ...(l ? { gridColumn: "1 / -1" } : null) }}
      aria-labelledby="h-enr"
    >
      <div className="row" style={{ gap: t ? 16 : 12 }}>
        <span className="state-icon is-primary" style={t ? undefined : { width: l ? 44 : 48, height: l ? 44 : 48 }}>
          <i className="ic ic-device" aria-hidden="true" />
        </span>
        <h2 className={t ? "t-2xl" : "t-xl"} id="h-enr">
          기기 등록
        </h2>
      </div>
      <p className={t ? "t-lg fw-m" : "t-md fw-m"}>
        이 기기는 아직 등록되지 않았습니다. 운영자가 준 기기 등록 QR을 찍거나 등록 코드를 넣으세요
      </p>
      {t || l ? (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(2,minmax(0,1fr))", gap: 24, alignItems: "start" }}>
          {scan}
          <div className="col" style={{ gap: t ? 14 : 12 }}>
            <span className={t ? "t-md fw-b muted" : "t-sm fw-b muted"}>또는</span>
            {field}
            {submit}
          </div>
        </div>
      ) : (
        <>
          {scan}
          <div className="row" style={{ gap: 10 }}>
            <hr className="divider" style={{ flex: 1 }} />
            <span className="t-sm fw-b muted">또는</span>
            <hr className="divider" style={{ flex: 1 }} />
          </div>
          {field}
          {submit}
        </>
      )}
    </section>
  );
}
