'use client';
// CMP-069 MediaUploader. 공연 포스터·상세 이미지를 올리고 순서를 바꾼다(d2 §2, d5 §6.4, docs/planning/04 SCR-021).
// 변형: single(포스터 한 장) · multiple(포스터 + 상세). 상태: idle · uploading(progressbar) · done · error(기준별 문구).
// 순서는 CMP-050처럼 장마다 [위로]·[아래로] 버튼으로 바꾸고 끌어 놓기 라이브러리는 두지 않는다(기술 검토 낮음-098).
// 첫 이미지가 포스터다(순서를 바꾸면 '포스터' 배지가 맨 위 줄로 옮겨 간다). 대체 텍스트는 필수다(WCAG 1.1.1).
// 두 쓰임: (가) 퍼블리싱 화면은 items를 처음 값으로만 읽고 순서를 부품 안에서 바꾼다(파일을 고르면 안내만 알린다).
// (나) 실제 위저드(ADR-0257 결정 4)는 onPick을 넘겨 제어형으로 쓴다. 그때는 items가 정본이고 고르기·대체 텍스트·옮기기·빼기를 바깥에 알린다.
//     제어형에서는 오류 줄에도 대체 텍스트 칸이 남고(복원한 줄의 글을 보이게), 아직 올리지 않은 줄(ready)은 배지가 없다.
// 화면 검사는 안내용이고 서버가 다시 검사한다.
import { useEffect, useId, useRef, useState, type DragEvent, type ReactNode } from "react";

export type MediaStatus = "done" | "uploading" | "error" | "ready";

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
  /** 대체 텍스트 칸의 오류(제어형) */
  altError?: string;
  /** 파일이 없는 줄(임시저장에서 되돌린 줄). 제어형에서 그 줄만 채우는 [파일 고르기]를 둔다(장수 상한에 막히지 않는다) */
  refill?: boolean;
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
  /** 제어형: 고른 파일(끌어 놓기 포함). 이것을 넘기면 items가 정본이다 */
  onPick?: (files: File[]) => void;
  onAltChange?: (id: string, alt: string) => void;
  onMove?: (id: string, dir: "up" | "down") => void;
  onRemove?: (id: string) => void;
  /** 제어형: 그 줄의 [파일 고르기]로 고른 파일 한 장 */
  onRefill?: (id: string, file: File) => void;
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
  onPick,
  onAltChange,
  onMove,
  onRemove,
  onRefill,
}: MediaUploaderProps) {
  const uid = useId();
  const controlled = onPick !== undefined;
  const [own, setOwn] = useState<MediaItem[]>(() => [...items]);
  const order = controlled ? items : own;
  const [moved, setMoved] = useState<{ id: string; dir: "up" | "down" } | null>(null);
  const [message, setMessage] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const refillRef = useRef<HTMLInputElement>(null);
  /** [파일 고르기]를 누른 줄 */
  const refillFor = useRef<string | null>(null);
  const listRef = useRef<HTMLOListElement>(null);
  const hintId = `${uid}-hint`;

  /** 옮긴 직후 한 번만 초점을 옮긴다(제어형은 바깥이 items를 새로 만들 때마다 효과가 다시 돌아, 지우지 않으면 다른 칸을 칠 때 초점이 버튼으로 끌려간다) */
  const focusPending = useRef(false);

  useEffect(() => {
    if (!moved || !focusPending.current) return;
    focusPending.current = false;
    const btn = listRef.current?.querySelector<HTMLButtonElement>(`[data-media="${moved.id}-${moved.dir}"]`);
    if (btn && !btn.disabled) btn.focus();
    else listRef.current?.querySelector<HTMLButtonElement>(`[data-media="${moved.id}-${moved.dir === "up" ? "down" : "up"}"]`)?.focus();
  }, [moved, order]);

  function move(index: number, dir: "up" | "down") {
    const to = dir === "up" ? index - 1 : index + 1;
    if (to < 0 || to >= order.length) return;
    const item = order[index]!;
    if (controlled) onMove?.(item.id, dir);
    else {
      const next = [...order];
      next.splice(index, 1);
      next.splice(to, 0, item);
      setOwn(next);
    }
    focusPending.current = true;
    setMoved({ id: item.id, dir });
    setMessage(`${item.fileName}을(를) ${to + 1}번째로 옮겼습니다${to === 0 ? ". 이제 포스터입니다" : ""}`);
  }

  function remove(index: number) {
    const item = order[index]!;
    if (controlled) onRemove?.(item.id);
    else setOwn(order.filter((_, i) => i !== index));
    setMessage(`${item.fileName}을(를) 뺐습니다`);
  }

  function pick(files: File[]) {
    onPick?.(files);
    setMessage(`이미지 ${files.length}장을 골랐습니다`);
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
        {...(controlled
          ? {
              onDragOver: (e: DragEvent<HTMLDivElement>) => {
                if (disabled || full) return;
                e.preventDefault();
              },
              onDrop: (e: DragEvent<HTMLDivElement>) => {
                e.preventDefault();
                if (disabled || full) return;
                const files = [...e.dataTransfer.files];
                if (files.length > 0) pick(files);
              },
            }
          : {})}
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
            const files = [...(e.currentTarget.files ?? [])];
            if (controlled) {
              if (files.length > 0) pick(files);
            } else if (files.length > 0) setMessage(`이미지 ${files.length}장을 골랐습니다. 퍼블리싱 화면이라 실제로 올리지 않습니다`);
            e.currentTarget.value = "";
          }}
        />
        {controlled ? (
          <input
            ref={refillRef}
            className="sr-only"
            type="file"
            accept={accept}
            tabIndex={-1}
            aria-hidden="true"
            onChange={(e) => {
              const file = e.currentTarget.files?.[0];
              const id = refillFor.current;
              refillFor.current = null;
              if (file && id) {
                onRefill?.(id, file);
                setMessage(`${file.name}을(를) 골랐습니다`);
              }
              e.currentTarget.value = "";
            }}
          />
        ) : null}
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
                  {m.status === "error" && (
                    <span className="error-msg" id={errId} role="alert">
                      <i className="ic ic-alert-circle" aria-hidden="true" />
                      {m.error}
                    </span>
                  )}
                  {controlled ? (
                    <div className="field" style={{ gap: 4 }}>
                      <label className="label" htmlFor={altId}>
                        대체 텍스트 <span className="opt">(필수)</span>
                      </label>
                      <input
                        className={m.altError ? "input input-sm is-error" : "input input-sm"}
                        id={altId}
                        type="text"
                        maxLength={300}
                        value={m.alt ?? ""}
                        placeholder="이미지에 담긴 내용을 글로 적어 주세요"
                        disabled={disabled}
                        aria-invalid={m.altError ? true : undefined}
                        aria-describedby={m.altError ? `${altId}-e` : undefined}
                        onChange={(e) => onAltChange?.(m.id, e.target.value)}
                      />
                      {m.altError ? (
                        <span className="error-msg" id={`${altId}-e`}>
                          <i className="ic ic-alert-circle" aria-hidden="true" />
                          {m.altError}
                        </span>
                      ) : null}
                    </div>
                  ) : m.status === "error" ? null : (
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
                    {controlled && m.refill ? (
                      <button
                        className="btn btn-outline btn-sm"
                        type="button"
                        aria-label={`${i + 1}번째 이미지 파일 고르기`}
                        disabled={disabled}
                        onClick={() => {
                          refillFor.current = m.id;
                          refillRef.current?.click();
                        }}
                      >
                        <i className="ic ic-image" aria-hidden="true" />
                        파일 고르기
                      </button>
                    ) : null}
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
