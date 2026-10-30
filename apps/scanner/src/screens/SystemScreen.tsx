// SCR-059 시스템 안내(스캐너 셸 변형). 경로 /error(500·404·429)와 없는 주소(404). 시각 기준: 캔버스 보드 SCR-059-scanner·-scanner-t.
// 정본: docs/design/d5 §5.33(CMP-045 page 틀). 문구는 일반 안내만 쓰고 스택·토큰을 보이지 않는다(ASVS 16.5.1).
// 가로 보드는 없어 휴대폰 세로 카드를 가운데 520px 폭으로 둔다(추천안).
import { ScannerShell } from "@peaket/ds/ScannerShell";
import type { CSSProperties } from "react";
import { PreviewSwitcher, usePreviewState } from "../app/preview";
import { Link, navigate, useLocation } from "../app/router";
import { sync } from "../fixtures/scanner";
import { bottomStyle, ManageLink, Strip, stripStyle } from "../shared/shell";

export const SYSTEM_STATES = ["500", "404", "429"] as const;

export function SystemScreen({ notFound = false }: { notFound?: boolean }) {
  const { state: st, layout } = usePreviewState(SYSTEM_STATES, notFound ? "404" : "500");
  const { pathname, search } = useLocation();
  const t = layout === "t";
  const p = layout === "p";
  const card: CSSProperties = t
    ? { width: "100%", maxWidth: 520, padding: "48px 40px", gap: 20 }
    : { padding: "36px 20px", gap: 16, ...(p ? null : { width: "100%", maxWidth: 520 }) };
  const h1 = t ? "t-2xl" : "t-xl";

  return (
    <>
      <ScannerShell
        strip={<Strip queue={sync.queue} />}
        stripStyle={stripStyle(layout)}
        bottom={<ManageLink />}
        bottomStyle={bottomStyle(layout)}
        mainClassName="col"
        mainStyle={
          t
            ? { padding: "48px 24px", justifyContent: "center", alignItems: "center" }
            : p
              ? { padding: "24px 16px", justifyContent: "center" }
              : { padding: "16px", justifyContent: "center", alignItems: "center" }
        }
      >
        {st === "500" ? (
          <section className="card state" role="alert" style={card} aria-labelledby="h-500">
            <span className="state-icon is-danger">
              <i className="ic ic-alert-circle" aria-hidden="true" />
            </span>
            <h1 className={h1} id="h-500">
              일시적인 오류입니다. 잠시 후 다시 시도해 주세요
            </h1>
            {/* 퍼블리싱 단계: 같은 주소를 다시 그린다. 실패한 요청을 다시 보내는 일은 데이터 연결 단계에서 붙인다 */}
            <button className="btn btn-primary btn-xl btn-block" type="button" onClick={() => navigate(pathname + search, { replace: true })}>
              <i className="ic ic-refresh" aria-hidden="true" />
              다시 시도
            </button>
            <Link className="btn btn-outline btn-lg btn-block" href="/scan">
              스캔 화면으로 돌아가기
            </Link>
          </section>
        ) : null}
        {st === "404" ? (
          <section className="card state" style={card} aria-labelledby="h-404">
            <span className="state-icon">
              <i className="ic ic-help" aria-hidden="true" />
            </span>
            <h1 className={h1} id="h-404">
              주소를 찾을 수 없습니다
            </h1>
            <Link className="btn btn-primary btn-xl btn-block" href="/scan">
              스캔 화면으로 가기
            </Link>
          </section>
        ) : null}
        {st === "429" ? (
          <section className="card state" style={card} aria-labelledby="h-429">
            <span className="state-icon is-warning">
              <i className="ic ic-clock" aria-hidden="true" />
            </span>
            <h1 className={h1} id="h-429">
              요청이 많아 잠시 기다려야 합니다.
            </h1>
            <p className={t ? "t-xl" : "t-lg"}>18초 뒤 자동으로 다시 시도합니다</p>
            <span className="timer is-warning" role="timer" aria-label="자동으로 다시 시도할 때까지 18초">
              <i className="ic ic-clock" aria-hidden="true" />
              18초
            </span>
            <Link className="btn btn-outline btn-lg btn-block" href="/scan">
              스캔 화면으로 돌아가기
            </Link>
          </section>
        ) : null}
      </ScannerShell>
      <PreviewSwitcher states={SYSTEM_STATES} current={st} />
    </>
  );
}
