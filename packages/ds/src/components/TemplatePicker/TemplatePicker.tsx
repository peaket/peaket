// CMP-078 TemplatePicker — 좌석맵 에디터 시작(start)·템플릿 고르기(gallery)·템플릿 설정(setup) (d2 §2 CMP-078, d5 §6.5, ADR-0066).
// 템플릿은 흔한 공연장 모양을 본뜬 출발점이고 실제 공연장 배치도가 아니다. 대화상자 틀(겹침·초점 가두기)은 앱이 두르고,
// 이 부품은 대화상자 안의 머리(제목·두 단계 표시·닫기)와 본문을 그린다. 여닫기 단추에는 앱이 넘긴 속성(data-*)을 그대로 붙인다.
import type { ReactNode } from "react";
import { TEMPLATE_SETUP_PREVIEWS, TEMPLATE_THUMBS } from "./thumbs";
import { TemplateFamilyFilter } from "./TemplateFamilyFilter";

export interface TemplateCardData {
  code: string;
  name: string;
  family: string;
  /** 기본 좌석(약) */
  defaultCapacity: number;
  floors: number;
  zones: number;
  /** 구성 한 줄 */
  composition: string;
}

type Attrs = Record<string, string>;

/* ---------- start: "어떻게 시작할까요?" ---------- */

export interface TemplateStartProps {
  /** 각 카드 단추에 붙일 속성 */
  attrs?: { template?: Attrs; blank?: Attrs; import?: Attrs };
  /** 태블릿 간격(카드 사이 12) */
  compact?: boolean;
}

export function TemplateStart({ attrs, compact = false }: TemplateStartProps) {
  const card = (
    key: "template" | "blank" | "import",
    icon: string,
    title: string,
    desc: string,
    primary = false,
  ) => (
    <button
      key={key}
      className="card col"
      type="button"
      style={{ padding: 20, gap: 10, alignItems: "flex-start", textAlign: "left", cursor: "pointer", color: "var(--text)" }}
      {...attrs?.[key]}
    >
      {primary ? (
        <span className="row between" style={{ width: "100%" }}>
          <span className="state-icon is-primary" style={{ width: 48, height: 48 }}>
            <i className={`ic ${icon}`} aria-hidden="true" />
          </span>
          <span className="badge badge-primary">권장</span>
        </span>
      ) : (
        <span className="state-icon" style={{ width: 48, height: 48 }}>
          <i className={`ic ${icon}`} aria-hidden="true" />
        </span>
      )}
      <span className="t-lg">{title}</span>
      <span className="t-sm muted">{desc}</span>
    </button>
  );
  return (
    <section className="card col" style={{ padding: compact ? 24 : "28px 32px 32px", gap: compact ? 18 : 20 }} aria-labelledby="h-tpl-start">
      <h2 className="t-xl" id="h-tpl-start">
        어떻게 시작할까요?
      </h2>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3,minmax(0,1fr))", gap: compact ? 12 : 16 }}>
        {card("template", "ic-layers", "템플릿으로 시작", "흔한 공연장 모양 10가지 중에서 고르고 고칩니다", true)}
        {card("blank", "ic-polygon", "빈 캔버스에서 그리기", "무대와 구역을 처음부터 그립니다")}
        {card("import", "ic-upload", "파일 가져오기", "SVG·JSON·CSV 좌석맵 파일을 불러옵니다")}
      </div>
    </section>
  );
}

/* ---------- 대화상자 머리: 제목 · 템플릿 단계(1 고르기 → 2 설정) · 닫기 ---------- */

export function TemplateDialogHeader({ step, titleId, closeAttrs }: { step: 1 | 2; titleId: string; closeAttrs?: Attrs }) {
  const title = step === 1 ? "템플릿 고르기" : "템플릿 설정";
  return (
    <div className="row wrap" style={{ gap: "8px 16px" }}>
      <h2 className="dialog-title" id={titleId}>
        {title}
      </h2>
      <nav className="stepper" aria-label="템플릿 단계">
        {step === 1 ? (
          <span className="step is-current" aria-current="step">
            <span className="step-num">1</span>템플릿 고르기
          </span>
        ) : (
          <span className="step is-done">
            <span className="step-num">
              <i className="ic ic-check" aria-hidden="true" />
            </span>
            템플릿 고르기
          </span>
        )}
        <span className={step === 2 ? "step-line is-done" : "step-line"} style={{ flex: "0 0 28px" }} />
        <span className={step === 2 ? "step is-current" : "step"} aria-current={step === 2 ? "step" : undefined}>
          <span className="step-num">2</span>템플릿 설정
        </span>
      </nav>
      <span className="grow" />
      <button className="icon-btn icon-btn-sm" type="button" aria-label={`${title} 닫기`} {...closeAttrs}>
        <i className="ic ic-close" aria-hidden="true" />
      </button>
    </div>
  );
}

/* ---------- gallery: 템플릿 10종 고르기 ---------- */

export interface TemplateGalleryProps {
  titleId: string;
  descId: string;
  templates: readonly TemplateCardData[];
  /** 거르기 칩('전체' 포함) */
  families: readonly string[];
  /** 카드의 [미리보기] 단추에 붙일 속성(설정 단계로 넘어가기) */
  cardAttrs?: Attrs;
  closeAttrs?: Attrs;
}

export function TemplateGallery({ titleId, descId, templates, families, cardAttrs, closeAttrs }: TemplateGalleryProps) {
  return (
    <>
      <TemplateDialogHeader step={1} titleId={titleId} closeAttrs={closeAttrs} />
      <div className="banner banner-info" id={descId}>
        <i className="ic ic-info" aria-hidden="true" />
        <div className="banner-body">
          템플릿은 흔한 공연장 모양을 본뜬 출발점이고 실제 공연장의 배치도가 아닙니다. 공연장에서 받은 좌석 배치도와 같게 고친 뒤 판매 승인을
          요청하세요.
        </div>
      </div>
      <TemplateFamilyFilter
        families={families}
        cards={templates.map((t) => ({
          family: t.family,
          node: <TemplateCard key={t.code} t={t} attrs={cardAttrs} />,
        }))}
      />
      <div className="row between wrap" style={{ gap: 8 }}>
        <p className="t-xs muted">스탠딩(정리번호 입장) 구역은 아직 지원하지 않아 플로어는 지정석으로 만듭니다(ADR-0051).</p>
        <button className="btn btn-outline btn-sm" type="button" {...closeAttrs}>
          닫기
        </button>
      </div>
    </>
  );
}

function TemplateCard({ t, attrs }: { t: TemplateCardData; attrs?: Attrs }) {
  return (
    <li className="card col" style={{ padding: 8, gap: 4 }}>
      <div className="card-flat" style={{ padding: 4 }} aria-hidden="true">
        <svg viewBox="0 0 160 80" style={{ width: "100%" }} focusable="false">
          {TEMPLATE_THUMBS[t.code]}
        </svg>
      </div>
      <h3 className="t-sm fw-b">{t.name}</h3>
      <p className="t-xs muted num">
        기본 좌석 약 {t.defaultCapacity.toLocaleString("ko-KR")}석 · {t.floors}개 층 · 구역 {t.zones}개
      </p>
      <p className="t-xs">{t.composition}</p>
      <button className="btn btn-outline btn-sm" type="button" aria-label={`${t.name} 미리보기`} style={{ marginTop: "auto" }} {...attrs}>
        미리보기
      </button>
    </li>
  );
}

/* ---------- setup: 목표 좌석 수 · 구역별 좌석 수 · 고를 수 있는 것 · 등급 기본값 ---------- */

export interface TemplateSetupProps {
  titleId: string;
  descId: string;
  template: TemplateCardData;
  targetSeats: string;
  /** 구역 묶음별 좌석 수 */
  distribution: readonly { label: string; seats: string; note?: string }[];
  totalLabel: string;
  total: string;
  /** 고를 수 있는 것(없으면 '없음') */
  variants?: string;
  /** 등급 기본값: 구역 묶음마다 처음 고른 등급 */
  gradeDefaults: readonly { label: string; value: string }[];
  grades: readonly string[];
  /** 큰 미리보기 범례 */
  legend: readonly { label: string; swatch: string; outlined?: boolean }[];
  /** 큰 미리보기 그림(없으면 템플릿 코드의 기본 그림) */
  preview?: ReactNode;
  backAttrs?: Attrs;
  startAttrs?: Attrs;
  closeAttrs?: Attrs;
  /** 태블릿: 두 열 1:1 */
  compact?: boolean;
}

export function TemplateSetup({
  titleId,
  descId,
  template,
  targetSeats,
  distribution,
  totalLabel,
  total,
  variants,
  gradeDefaults,
  grades,
  legend,
  preview,
  backAttrs,
  startAttrs,
  closeAttrs,
  compact = false,
}: TemplateSetupProps) {
  const art = preview ?? TEMPLATE_SETUP_PREVIEWS[template.code];
  return (
    <>
      <TemplateDialogHeader step={2} titleId={titleId} closeAttrs={closeAttrs} />
      <p className="t-sm muted" id={descId}>
        <strong style={{ color: "var(--text)" }}>{template.name}</strong> · 기본 좌석 약 {template.defaultCapacity.toLocaleString("ko-KR")}석 ·{" "}
        {template.floors}개 층 · 구역 {template.zones}개
      </p>
      <div
        className="grid grid-cols-1 md:grid-cols-2 lg:[grid-template-columns:minmax(0,1.15fr)_minmax(0,1fr)]"
        style={{ gap: compact ? 16 : 20, alignItems: "start" }}
      >
        <div className="card-flat col" style={{ padding: 12, gap: 10 }}>
          <div aria-hidden="true">
            {art ? (
              <svg viewBox="0 20 640 380" style={{ width: "100%" }} focusable="false">
                {art}
              </svg>
            ) : (
              <svg viewBox="0 0 160 80" style={{ width: "100%" }} focusable="false">
                {TEMPLATE_THUMBS[template.code]}
              </svg>
            )}
          </div>
          <div className="legend">
            {legend.map((l) => (
              <span key={l.label} className="legend-item">
                <span
                  aria-hidden="true"
                  style={{
                    display: "inline-block",
                    width: 14,
                    height: 10,
                    borderRadius: 2,
                    background: l.swatch,
                    boxShadow: l.outlined ? "inset 0 0 0 1px var(--border)" : undefined,
                  }}
                />
                {l.label}
              </span>
            ))}
          </div>
        </div>
        <div className="col" style={{ gap: 14 }}>
          <div className="field" style={{ gap: 4 }}>
            <label className="label" htmlFor={`${titleId}-target`}>
              목표 좌석 수
            </label>
            <div className="input-group input-group-sm" style={{ maxWidth: 200 }}>
              <input id={`${titleId}-target`} type="text" inputMode="numeric" defaultValue={targetSeats} aria-describedby={`${titleId}-target-h`} />
              <span className="t-xs muted">석</span>
            </div>
            <span className="hint" id={`${titleId}-target-h`}>
              템플릿 기본 약 {template.defaultCapacity.toLocaleString("ko-KR")}석 · 구역 비율대로 나눕니다
            </span>
          </div>
          <div className="col" style={{ gap: 6 }}>
            <span className="label" id={`${titleId}-dist`}>
              구역별 좌석 수
            </span>
            <div className="table-wrap">
              <table className="table dense" aria-labelledby={`${titleId}-dist`}>
                <thead>
                  <tr>
                    <th scope="col">구역</th>
                    <th scope="col" className="r">
                      좌석 수
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {distribution.map((r) => (
                    <tr key={r.label}>
                      <td>{r.label}</td>
                      <td className="r">
                        {r.seats} {r.note ? <span className="muted">({r.note})</span> : null}
                      </td>
                    </tr>
                  ))}
                  <tr>
                    <td className="fw-b">{totalLabel}</td>
                    <td className="r fw-b">{total}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
          <div className="col" style={{ gap: 4 }}>
            <span className="label">고를 수 있는 것</span>
            <p className="t-sm muted">{variants && variants !== "—" ? variants : "없음"}</p>
          </div>
          <fieldset className="col" style={{ gap: 8 }}>
            <legend className="label" style={{ marginBottom: 8 }}>
              등급 기본값
            </legend>
            {gradeDefaults.map((g, i) => (
              <div key={g.label} className="row between" style={{ gap: 8 }}>
                <label className="t-sm" htmlFor={`${titleId}-g${i}`}>
                  {g.label}
                </label>
                <div className="input-group input-group-sm" style={{ width: 120 }}>
                  <select id={`${titleId}-g${i}`} defaultValue={g.value}>
                    {grades.map((o) => (
                      <option key={o}>{o}</option>
                    ))}
                  </select>
                  <i className="ic ic-chevron-down" aria-hidden="true" />
                </div>
              </div>
            ))}
          </fieldset>
        </div>
      </div>
      <div className="dialog-actions">
        <button className="btn btn-outline" type="button" {...backAttrs}>
          <i className="ic ic-arrow-left" aria-hidden="true" />
          다른 템플릿 고르기
        </button>
        <button className="btn btn-primary" type="button" {...startAttrs}>
          이 템플릿으로 시작
        </button>
      </div>
    </>
  );
}
