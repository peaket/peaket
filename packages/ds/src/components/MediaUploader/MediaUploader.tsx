'use client';
// CMP-069 MediaUploader. 공연 포스터·상세 이미지를 올리고 순서를 바꾼다(d2 §2, d5 §6.4, docs/planning/04 SCR-021).
// 변형: single(포스터 한 장) · multiple(포스터 + 상세). 상태: idle · uploading(progressbar) · done · error(기준별 문구).
// 순서는 CMP-050처럼 장마다 [위로]·[아래로] 버튼으로 바꾸고 끌어 놓기 라이브러리는 두지 않는다(기술 검토 낮음-098).
// 첫 이미지가 포스터다(순서를 바꾸면 '포스터' 배지가 맨 위 줄로 옮겨 간다). 대체 텍스트는 필수다(WCAG 1.1.1).
// 퍼블리싱 단계: 실제로 올리지 않는다. 파일을 고르면 안내만 알린다. 화면 검사는 안내용이고 서버가 다시 검사한다.
import { useEffect, useId, useRef, useState, type ReactNode } from "react";

export type MediaStatus = "done" | "uploading" | "error";

export interface MediaItem {
  id: string;
  fileName: string;
  status: MediaStatus;
  /** 올리는 중 진행률(0~100) */
  progress?: number;
  /** 대체 텍스트 초깃값 */
  alt?: string;
  /** 기준 위반 문구(status 'error') */
  error?: string;
  /** 작은 미리보기(없으면 뼈대 상자) */
  preview?: ReactNode;
}

export interface MediaUploaderProps {
  items: readonly MediaItem[];
  /** 영역 위 도움말(형식·크기·해상도 기준) */
  hint?: ReactNode;
  variant?: "single" | "multiple";
  /** 상세 이미지 최대 장수(포스터 제외) */
  maxDetail?: number;
  /** 잠긴 화면 */
  disabled?: boolean;
  /** 받는 형식(input accept) */
  accept?: string;
}

const DEFAULT_HINT =
  "여러 장을 한 번에 고를 수 있고 첫 이미지가 포스터입니다. JPEG·PNG·WebP, 한 장 10MB까지입니다. 포스터는 가로 800px·세로 1,000px 이상의 세로형, 상세 이미지는 가로 800px 이상이고 10장까지입니다. 올리기 전에 검사하고 서버에서 다시 검사합니다.";

export function MediaUploader({
  items,
  hint = DEFAULT_HINT,
  variant = "multiple",
  maxDetail = 10,
  disabled = false,
  accept = "image/jpeg,image/png,image/webp",
}: MediaUploaderProps) {
  const uid = useId();
  const [order, setOrder] = useState<MediaItem[]>(() => [...items]);
  const [moved, setMoved] = useState<{ id: string; dir: "up" | "down" } | null>(null);
  const [message, setMessage] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLOListElement>(null);
  const hintId = `${uid}-hint`;

  useEffect(() => {
    if (!moved) return;
    const btn = listRef.current?.querySelector<HTMLButtonElement>(`[data-media="${moved.id}-${moved.dir}"]`);
    if (btn && !btn.disabled) btn.focus();
    else listRef.current?.querySelector<HTMLButtonElement>(`[data-media="${moved.id}-${moved.dir === "up" ? "down" : "up"}"]`)?.focus();
  }, [moved, order]);

  function move(index: number, dir: "up" | "down") {
    const to = dir === "up" ? index - 1 : index + 1;
    if (to < 0 || to >= order.length) return;
    const next = [...order];
    const [item] = next.splice(index, 1);
    next.splice(to, 0, item!);
    setOrder(next);
    setMoved({ id: item!.id, dir });
    setMessage(`${item!.fileName}을(를) ${to + 1}번째로 옮겼습니다${to === 0 ? ". 이제 포스터입니다" : ""}`);
  }

  function remove(index: number) {
    const item = order[index]!;
    setOrder(order.filter((_, i) => i !== index));
    setMessage(`${item.fileName}을(를) 뺐습니다`);
  }

  const count = order.length;
  const full = variant === "single" ? count >= 1 : count >= maxDetail + 1;

  return (
    <div className="col" style={{ gap: 14 }}>
      <div
        className="row"
        style={{
          gap: 12,
          padding: "12px 14px",
          border: "1.5px dashed var(--border-input)",
          borderRadius: "var(--r-lg)",
          background: "var(--surface-muted)",
        }}
      >
        <i className="ic ic-upload ic-24 muted" aria-hidden="true" />
        <div className="col grow" style={{ gap: 2 }}>
          <span className="t-sm fw-b">이미지를 여기에 끌어 놓으세요</span>
          <span className="t-xs muted">끌어 놓기가 어렵다면 파일 선택 버튼을 씁니다</span>
        </div>
        <input
          ref={fileRef}
          className="sr-only"
          type="file"
          accept={accept}
          multiple={variant === "multiple"}
          tabIndex={-1}
          aria-hidden="true"
          onChange={(e) => {
            const n = e.currentTarget.files?.length ?? 0;
            if (n > 0) setMessage(`이미지 ${n}장을 골랐습니다. 퍼블리싱 화면이라 실제로 올리지 않습니다`);
            e.currentTarget.value = "";
          }}
        />
        <button
          className="btn btn-outline btn-sm"
          type="button"
          aria-describedby={hintId}
          disabled={disabled || full}
          onClick={() => fileRef.current?.click()}
        >
          <i className="ic ic-image" aria-hidden="true" />
          파일 선택
        </button>
      </div>
      <p className="hint" id={hintId}>
        {hint}
      </p>
      {count > 0 && (
        <ol ref={listRef} className="col" style={{ gap: 10 }} aria-label="올린 이미지 순서">
          {order.map((m, i) => {
            const isPoster = i === 0;
            const altId = `${uid}-alt-${m.id}`;
            const errId = `${uid}-err-${m.id}`;
            const isMoved = moved?.id === m.id;
            return (
              <li
                key={m.id}
                className="row"
                style={{
                  gap: 12,
                  alignItems: "flex-start",
                  padding: 12,
                  border: `1px solid ${m.status === "error" ? "var(--danger)" : isMoved ? "var(--border-primary)" : "var(--border)"}`,
                  borderRadius: "var(--r-lg)",
                }}
              >
                {m.preview ?? <span className="skel" style={{ width: 52, height: 69, flex: "none" }} aria-hidden="true" />}
                <div className="col grow" style={{ gap: 8, minWidth: 0 }}>
                  <div className="row" style={{ gap: 6 }}>
                    <span className={isPoster ? "badge badge-primary" : "badge"}>{isPoster ? "포스터" : "상세"}</span>
                    <span className="t-sm fw-b ellipsis grow">{m.fileName}</span>
                    {m.status === "done" && (
                      <span className="badge badge-success">
                        <i className="ic ic-check" aria-hidden="true" />
                        올림 완료
                      </span>
                    )}
                    {m.status === "uploading" && <span className="t-xs muted num">올리는 중 {m.progress ?? 0}%</span>}
                    {m.status === "error" && (
                      <span className="badge badge-danger">
                        <i className="ic ic-alert-circle" aria-hidden="true" />
                        올리지 못함
                      </span>
                    )}
                  </div>
                  {m.status === "uploading" && (
                    <div
                      className="progress"
                      role="progressbar"
                      aria-label={`${m.fileName} 올리는 중`}
                      aria-valuenow={m.progress ?? 0}
                      aria-valuemin={0}
                      aria-valuemax={100}
                    >
                      <span style={{ width: `${m.progress ?? 0}%` }} />
                    </div>
                  )}
                  {m.status === "error" ? (
                    <span className="error-msg" id={errId} role="alert">
                      <i className="ic ic-alert-circle" aria-hidden="true" />
                      {m.error}
                    </span>
                  ) : (
                    <div className="field" style={{ gap: 4 }}>
                      <label className="label" htmlFor={altId}>
                        대체 텍스트 <span className="opt">(필수)</span>
                      </label>
                      <input
                        className="input input-sm"
                        id={altId}
                        type="text"
                        maxLength={300}
                        defaultValue={m.alt ?? ""}
                        placeholder="이미지에 담긴 내용을 글로 적어 주세요"
                        disabled={disabled}
                      />
                    </div>
                  )}
                  <div className="row" style={{ gap: 2 }}>
                    <button
                      className="btn btn-ghost btn-sm"
                      type="button"
                      aria-label={`${m.fileName} 위로 이동`}
                      data-media={`${m.id}-up`}
                      disabled={disabled || i === 0 || m.status === "error"}
                      onClick={() => move(i, "up")}
                    >
                      <i className="ic ic-chevron-up" aria-hidden="true" />
                      위로
                    </button>
                    <button
                      className="btn btn-ghost btn-sm"
                      type="button"
                      aria-label={`${m.fileName} 아래로 이동`}
                      data-media={`${m.id}-down`}
                      disabled={disabled || i === count - 1 || m.status === "error"}
                      onClick={() => move(i, "down")}
                    >
                      <i className="ic ic-chevron-down" aria-hidden="true" />
                      아래로
                    </button>
                    <button
                      className="btn btn-ghost btn-sm"
                      type="button"
                      aria-label={m.status === "uploading" ? `${m.fileName} 올리기를 멈추고 빼기` : `${m.fileName} 빼기`}
                      style={{ marginLeft: "auto" }}
                      disabled={disabled}
                      onClick={() => remove(i)}
                    >
                      빼기
                    </button>
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      )}
      <span className="sr-only" role="status">
        {message}
      </span>
    </div>
  );
}
