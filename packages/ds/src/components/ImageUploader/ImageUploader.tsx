'use client';
// CMP-076 ImageUploader(d2 §2 CMP-076 행, 보드 SCR-016 후기 쓰기의 '사진' 칸 모양). 팬 후기 사진 등 몇 장의 사진을 고르고,
// 장마다 미리보기·지우기·사진 설명(선택)을 둔다. 공연 포스터·상세 이미지(CMP-069 MediaUploader)와 달리 사진 설명은 선택이다.
// - 퍼블리싱 단계라 실제로 올리지 않는다. 고른 파일은 화면에서만 형식·크기를 검사하고 미리보기 주소(object URL)를 만든다.
//   서버 검사(매직 바이트·디코딩·악성 코드·재인코딩·메타데이터 지우기)는 데이터를 잇는 단계에서 붙인다.
// - 상태: idle(타일 "사진 추가 0/3") · uploading(썸네일 위 진행 막대) · scanning("확인하는 중") · ready · error(썸네일 자리 role="alert") · full(추가 타일 비활성)
//   미리보기 상태는 defaultItems로 넣는다(예: { status: 'uploading', progress: 64 }).
import { useEffect, useId, useRef, useState, type ReactNode } from "react";

export type ImageUploaderItemStatus = "ready" | "uploading" | "scanning" | "error";

export interface ImageUploaderItem {
  id: string;
  status: ImageUploaderItemStatus;
  /** uploading일 때 0~100 */
  progress?: number;
  /** 사진 설명(대체 텍스트) */
  caption?: string;
  /** error일 때 보이는 문구 */
  error?: string;
  /** 실패를 다시 시도할 수 있으면 true([ 다시 시도 ]) */
  retryable?: boolean;
  /** 미리보기 그림 주소(없으면 그림 자리 아이콘) */
  previewUrl?: string;
}

export interface ImageUploaderProps {
  /** 입력 id의 바탕 */
  id?: string;
  /** 칸 이름(legend). 기본 '사진' */
  legend?: ReactNode;
  /** legend 옆 작은 글. 기본 '(선택, 최대 {max}장)' */
  legendNote?: ReactNode;
  /** 칸 머리 안내 글(aria-describedby로 잇는다) */
  hint?: ReactNode;
  /** 최대 장수. 기본 3 */
  max?: number;
  /** 받는 형식(input accept). 기본 JPEG·PNG·WebP */
  accept?: string;
  /** 한 장 최대 바이트. 기본 10MB */
  maxBytes?: number;
  /** 사진 설명 최대 글자. 기본 100 */
  captionMax?: number;
  /** 사진 설명이 비었을 때 읽는 이름의 앞말. 기본 '사진' → "사진 1/3" */
  itemLabel?: string;
  /** 처음 목록(상태 미리보기) */
  defaultItems?: readonly ImageUploaderItem[];
  onChange?: (items: readonly ImageUploaderItem[]) => void;
  disabled?: boolean;
}

const DEFAULT_ACCEPT = "image/jpeg,image/png,image/webp";
const TILE = 72;

function checkFile(file: File, accept: string, maxBytes: number): string | null {
  const types = accept.split(",").map((t) => t.trim());
  if (!types.includes(file.type)) return "JPEG, PNG, WebP 이미지만 올릴 수 있습니다";
  if (file.size > maxBytes) return `한 장에 ${Math.round(maxBytes / (1024 * 1024))}MB까지 올릴 수 있습니다`;
  return null;
}

export function ImageUploader({
  id,
  legend = "사진",
  legendNote,
  hint,
  max = 3,
  accept = DEFAULT_ACCEPT,
  maxBytes = 10 * 1024 * 1024,
  captionMax = 100,
  itemLabel = "사진",
  defaultItems = [],
  onChange,
  disabled = false,
}: ImageUploaderProps) {
  const auto = useId();
  const base = id ?? `iu${auto.replace(/:/g, "")}`;
  const [items, setItems] = useState<readonly ImageUploaderItem[]>(defaultItems);
  const [notice, setNotice] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const urls = useRef<string[]>([]);

  useEffect(() => () => urls.current.forEach((u) => URL.revokeObjectURL(u)), []);

  const update = (next: readonly ImageUploaderItem[]) => {
    setItems(next);
    onChange?.(next);
  };

  const full = items.length >= max;
  const hintId = hint ? `${base}-hint` : undefined;
  const maxId = `${base}-max`;
  const describedBy = [full ? maxId : null, hintId].filter(Boolean).join(" ") || undefined;
  const addDisabled = disabled || full;

  function onPick(files: FileList | null) {
    if (!files || files.length === 0) return;
    const room = max - items.length;
    const picked = Array.from(files).slice(0, Math.max(0, room));
    const added: ImageUploaderItem[] = picked.map((file, i) => {
      const err = checkFile(file, accept, maxBytes);
      let previewUrl: string | undefined;
      if (!err) {
        previewUrl = URL.createObjectURL(file);
        urls.current.push(previewUrl);
      }
      return { id: `${base}-${Date.now()}-${i}`, status: err ? "error" : "ready", error: err ?? undefined, previewUrl };
    });
    update([...items, ...added]);
    setNotice(files.length > picked.length ? `${itemLabel}은 ${max}장까지 올릴 수 있습니다` : `${itemLabel} ${added.length}장을 더했습니다`);
    if (inputRef.current) inputRef.current.value = "";
  }

  function remove(index: number) {
    const target = items[index];
    if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl);
    update(items.filter((_, i) => i !== index));
    setNotice(`${itemLabel} ${index + 1}을 지웠습니다`);
  }

  function setCaption(index: number, caption: string) {
    update(items.map((it, i) => (i === index ? { ...it, caption } : it)));
  }

  return (
    <fieldset className="col" style={{ gap: 12 }} aria-describedby={hintId}>
      <legend className="label" style={{ marginBottom: 6 }}>
        {legend} <span className="opt">{legendNote ?? `(선택, 최대 ${max}장)`}</span>
      </legend>
      {hint ? (
        <p className="hint" id={hintId}>
          {hint}
        </p>
      ) : null}

      <div className="row" style={{ gap: 12 }}>
        <label
          className="col center"
          htmlFor={`${base}-file`}
          style={{
            flex: "none",
            width: TILE,
            height: TILE,
            gap: 2,
            border: `1px dashed ${addDisabled ? "var(--border)" : "var(--border-input)"}`,
            borderRadius: "var(--r-md)",
            background: addDisabled ? "var(--surface-disabled)" : "var(--surface)",
            color: addDisabled ? "var(--text-disabled)" : "var(--text)",
            cursor: addDisabled ? "not-allowed" : "pointer",
          }}
        >
          <span className="row" style={{ gap: 0 }} aria-hidden="true">
            <i className="ic ic-plus ic-14" aria-hidden="true" />
            <i className="ic ic-image ic-16" aria-hidden="true" />
          </span>
          <span className="t-xs fw-b">{itemLabel} 추가</span>
          <span className={addDisabled ? "t-xs num" : "t-xs muted num"}>
            {items.length}/{max}
          </span>
        </label>
        <input
          ref={inputRef}
          className="sr-only"
          type="file"
          id={`${base}-file`}
          accept={accept}
          multiple={max > 1}
          disabled={addDisabled}
          aria-describedby={describedBy}
          onChange={(e) => onPick(e.currentTarget.files)}
        />
        {full ? (
          <p className="hint grow" id={maxId}>
            {itemLabel}은 {max}장까지 올릴 수 있습니다
          </p>
        ) : null}
      </div>

      {items.length > 0 ? (
        <ul className="col" style={{ gap: 12 }} aria-label={`올린 ${itemLabel}`}>
          {items.map((it, i) => {
            const n = i + 1;
            const name = it.caption?.trim() ? it.caption.trim() : `${itemLabel} ${n}/${max}`;
            return (
              <li key={it.id} className="row" style={{ gap: 12, alignItems: it.status === "ready" ? "flex-start" : "center" }}>
                <div
                  style={{
                    position: "relative",
                    flex: "none",
                    width: TILE,
                    height: TILE,
                    borderRadius: "var(--r-md)",
                    overflow: it.status === "uploading" || it.status === "scanning" ? "hidden" : undefined,
                  }}
                >
                  {it.previewUrl && it.status !== "error" ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={it.previewUrl}
                      alt={it.status === "ready" ? name : ""}
                      width={TILE}
                      height={TILE}
                      style={{ width: TILE, height: TILE, objectFit: "cover", borderRadius: "var(--r-md)" }}
                    />
                  ) : (
                    <span
                      className="center"
                      role={it.status === "ready" ? "img" : undefined}
                      aria-label={it.status === "ready" ? name : undefined}
                      aria-hidden={it.status === "ready" ? undefined : true}
                      style={{
                        width: TILE,
                        height: TILE,
                        borderRadius: "var(--r-md)",
                        background: it.status === "error" ? "var(--danger-subtle)" : "var(--fill-weak)",
                        color: it.status === "error" ? "var(--danger)" : "var(--text-muted)",
                        boxShadow: it.status === "error" ? "inset 0 0 0 1px var(--danger)" : undefined,
                      }}
                    >
                      <i className="ic ic-image ic-24" aria-hidden="true" />
                    </span>
                  )}
                  {it.status === "uploading" ? (
                    <div
                      className="progress"
                      role="progressbar"
                      aria-label={`${itemLabel} ${n} 올리기`}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={it.progress ?? 0}
                      aria-valuetext={`올리는 중 ${it.progress ?? 0}%`}
                      style={{ position: "absolute", left: 8, right: 8, bottom: 8, width: "auto", height: 6, background: "var(--surface)" }}
                    >
                      <span style={{ width: `${it.progress ?? 0}%` }} />
                    </div>
                  ) : null}
                  {it.status === "ready" || it.status === "error" ? (
                    <button
                      className="icon-btn icon-btn-sm"
                      type="button"
                      aria-label={`${itemLabel} ${n} 지우기`}
                      disabled={disabled}
                      onClick={() => remove(i)}
                      style={{
                        position: "absolute",
                        top: -8,
                        right: -8,
                        borderRadius: "50%",
                        background: "var(--inverse)",
                        color: "var(--on-inverse)",
                        boxShadow: "var(--shadow-sm)",
                      }}
                    >
                      <i className="ic ic-close" aria-hidden="true" />
                    </button>
                  ) : null}
                </div>

                {it.status === "ready" ? (
                  <div className="field grow">
                    <label className="label" htmlFor={`${base}-alt-${n}`} style={{ fontSize: 13, lineHeight: "18px" }}>
                      <span className="sr-only">
                        {itemLabel} {n}{" "}
                      </span>
                      {itemLabel} 설명 <span className="opt">(선택, {captionMax}자)</span>
                    </label>
                    <input
                      className="input input-sm"
                      type="text"
                      id={`${base}-alt-${n}`}
                      maxLength={captionMax}
                      value={it.caption ?? ""}
                      disabled={disabled}
                      onChange={(e) => setCaption(i, e.currentTarget.value)}
                    />
                  </div>
                ) : null}
                {it.status === "uploading" ? (
                  <p className="t-sm muted num grow" aria-hidden="true">
                    올리는 중 {it.progress ?? 0}%
                  </p>
                ) : null}
                {it.status === "scanning" ? (
                  <p className="t-sm muted row grow" role="status" style={{ gap: 8 }}>
                    <span className="spinner" aria-hidden="true" />
                    확인하는 중
                  </p>
                ) : null}
                {it.status === "error" ? (
                  <div className="col grow" style={{ gap: 6, alignItems: "flex-start" }}>
                    <p className="error-msg" role="alert" style={{ paddingTop: 6 }}>
                      <i className="ic ic-alert-circle" aria-hidden="true" />
                      {it.error ?? "올리지 못했습니다"}
                    </p>
                    {it.retryable ? (
                      <button
                        className="btn btn-outline btn-sm"
                        type="button"
                        onClick={() => update(items.map((x, k) => (k === i ? { ...x, status: "ready", error: undefined } : x)))}
                      >
                        <i className="ic ic-refresh" aria-hidden="true" />
                        다시 시도
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      <span className="sr-only" role="status" aria-live="polite">
        {notice}
      </span>
    </fieldset>
  );
}
