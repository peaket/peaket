'use client';
// 소비자 웹 머리의 통합 검색창(소비자 웹의 유일한 검색 입력, d5 §3.1·§5.3, ADR-0063·0094). 캔버스 보드 SCR-003-m·t·d의
// <form role="search"> .input-group(ic-search + input role="combobox" + 지우기) + 아래 .menu 자동완성 창 마크업을 그대로 낸다.
// - layout 'desktop': lg 머리 가운데 검색창(창은 입력 바로 아래, 보드 SCR-003-d).
//   layout 'bar': 휴대폰·태블릿에서 머리 자체가 검색창으로 바뀐 모양(보드 SCR-003-m·t). 창은 머리(position:relative) 기준으로
//   휴대폰은 머리 바로 아래 꽉 찬 폭, 태블릿(md)은 좌우 16px 띄운 둥근 창이다.
// - 창의 모양: 입력 전 초점이면 최근 검색어(하나씩·전체 지우기, '이 기기에만 저장됩니다'), 입력하면 후보와 맨 아래 '전체 결과 보기',
//   후보가 없으면 "맞는 공연·아티스트·공연장이 없습니다", 불러오는 중이면 뼈대 세 줄. 상태 미리보기는 popup으로 연 채 그린다.
// - ARIA combobox: aria-expanded·aria-controls·aria-activedescendant·aria-autocomplete="list", 창은 listbox, 후보는 option.
//   ↑↓ 이동 · Enter 고르기(고른 줄이 없으면 검색 화면으로) · Esc 창 닫기. 한글 조합 중(isComposing·keyCode 229)에는 키를 처리하지 않는다.
// - 일치 표시: 맞은 부분만 굵게. 후보가 highlight를 주면 그 범위, 맞는 곳이 없으면 이름 전체를 굵게 한다(d5 §5.3).
// - 후보: 동기 함수(getSuggestions, 이야기·퍼블리싱)나 비동기 출처(loadSuggestions, 자동완성 API)를 받는다. 비동기 출처는 입력이 바뀐 뒤
//   300ms [가정] 기다렸다 부르고 이전 요청은 취소한다. 기다리는 동안 뼈대를 보이고, 실패하면 창을 띄우지 않는다(Enter는 결과 화면으로, d5 §5.3).
//   출처가 null을 주면(요청 최소 길이 미만) 창을 띄우지 않는다.
// - 최근 검색어는 앱이 저장한다(onRecentChange로 알리고, recent가 바뀌면 따라간다). queryFromUrl이면 주소의 q를 입력에 채운다(검색 화면).
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { cx } from "../../lib/cx";
import { useOutsidePress } from "./focus-trap";
import { searchPopupMode } from "./search-mode";

export type WebSearchSuggestionKind = "production" | "artist" | "venue";

export interface WebSearchSuggestion {
  id: string;
  label: string;
  kind: WebSearchSuggestionKind;
  href: string;
  /** 이름 아래 보조 글(공연의 다음 오픈 일시 '10/14(수) 20:00 오픈' 등) */
  meta?: string;
  /** 작은 포스터 등(장식, aria-hidden으로 넣는다) */
  thumbnail?: ReactNode;
  /** 굵게 보일 [시작, 끝). 없으면 검색어와 맞는 부분, null이거나 맞는 곳이 없으면 이름 전체 */
  highlight?: readonly [number, number] | null;
  /** 굵게 보일 범위 여럿(서버가 준 위치). 주면 highlight보다 앞서고, 빈 목록이면 이름 전체 */
  highlights?: readonly (readonly [number, number])[];
}

/** 자동완성 창 모양(보드 SCR-003 상태): 닫힘 · 최근 검색어 · 후보 · 후보 없음 · 불러오는 중 */
export type WebSearchPopup = "closed" | "recent" | "suggest" | "none" | "loading";

/** 앱이 같은 화면 안에서 주소를 바꿨을 때 보내는 사건 이름(popstate가 없는 앱 이동). queryFromUrl이면 이 사건에도 주소의 q를 다시 읽는다 */
export const SEARCH_QUERY_SYNC_EVENT = "peaket:search-query-sync";

const kindText: Record<WebSearchSuggestionKind, string> = { production: "공연", artist: "아티스트", venue: "공연장" };
const kindIcon: Record<WebSearchSuggestionKind, string> = { production: "ic-ticket", artist: "ic-user", venue: "ic-genre-venue" };

export interface WebSearchBoxProps {
  /** 검색 화면 주소(폼 GET action). 검색어는 q */
  action: string;
  /** 'desktop': lg 머리 검색창 · 'bar': 휴대폰·태블릿 검색 모드 머리 */
  layout?: "desktop" | "bar";
  /** 처음 검색어 */
  defaultValue?: string;
  /** 처음 창 모양(상태 미리보기). 'closed'가 아니면 연 채로 그리고, 사용자가 글을 고치면 후보를 다시 찾는다 */
  popup?: WebSearchPopup;
  /** popup 'suggest'일 때 보일 후보(보드 값). 없으면 검색어로 찾은 후보 */
  popupSuggestions?: readonly WebSearchSuggestion[];
  /** 처음 고른 줄(0부터, 상태 미리보기) */
  defaultActiveIndex?: number;
  /** 고를 후보 전체. getSuggestions가 없으면 이름에 검색어가 든 것을 고른다 */
  suggestions?: readonly WebSearchSuggestion[];
  /** 검색어 → 후보(별칭·초성 등 앱 규칙). 주면 suggestions 대신 쓴다 */
  getSuggestions?: (query: string) => readonly WebSearchSuggestion[];
  /** 검색어 → 후보를 비동기로(자동완성 API). 주면 getSuggestions·suggestions 대신 쓴다. null이면 창을 띄우지 않는다 */
  loadSuggestions?: (query: string, signal: AbortSignal) => Promise<readonly WebSearchSuggestion[] | null>;
  /** 기다리지 않고 바로 답할 수 있으면 그 답(후보·null 창 없음), 요청해야 하면 undefined. 뼈대가 깜빡이지 않게 한다 */
  peekSuggestions?: (query: string) => readonly WebSearchSuggestion[] | null | undefined;
  /** 비동기 출처를 부르기 전에 기다리는 시간(ms, 기본 300 [가정]) */
  debounceMs?: number;
  /** 최근 검색어가 바뀌었을 때(앱이 저장한다) */
  onRecentChange?: (recent: string[]) => void;
  /** 주소의 q를 입력에 채운다(처음과 뒤로·앞으로 갈 때, 검색 화면) */
  queryFromUrl?: boolean;
  /** 최근 검색어(처음 값) */
  recent?: readonly string[];
  /** 후보를 골랐을 때·검색할 때 이동. 없으면 브라우저 이동 */
  onNavigate?: (href: string) => void;
  /** 그리자마자 입력에 초점(검색 아이콘을 눌러 머리를 바꿨을 때) */
  autoFocus?: boolean;
  /** 한 번에 보일 후보 수(기본 8) */
  limit?: number;
}

function Marked({ s, q }: { s: WebSearchSuggestion; q: string }) {
  if (s.highlights) {
    if (s.highlights.length === 0) return <strong>{s.label}</strong>;
    const parts: ReactNode[] = [];
    let at = 0;
    [...s.highlights].sort((x, y) => x[0] - y[0]).forEach(([a0, b0], i) => {
      const a = Math.max(a0, at);
      const b = Math.min(b0, s.label.length);
      if (b <= a) return;
      if (a > at) parts.push(s.label.slice(at, a));
      parts.push(<strong key={i}>{s.label.slice(a, b)}</strong>);
      at = b;
    });
    if (at < s.label.length) parts.push(s.label.slice(at));
    return <>{parts}</>;
  }
  let range: readonly [number, number] | null = null;
  if (s.highlight !== undefined) range = s.highlight;
  else if (q) {
    const at = s.label.toLowerCase().indexOf(q.toLowerCase());
    if (at >= 0) range = [at, at + q.length];
  }
  if (!range) return <strong>{s.label}</strong>;
  const [a, b] = range;
  return (
    <>
      {s.label.slice(0, a)}
      <strong>{s.label.slice(a, b)}</strong>
      {s.label.slice(b)}
    </>
  );
}

type Row = { kind: "recent"; text: string } | { kind: "suggestion"; s: WebSearchSuggestion } | { kind: "all" };

export function WebSearchBox({
  action,
  layout = "desktop",
  defaultValue = "",
  popup = "closed",
  popupSuggestions,
  defaultActiveIndex = -1,
  suggestions = [],
  getSuggestions,
  loadSuggestions,
  peekSuggestions,
  debounceMs = 300,
  onRecentChange,
  queryFromUrl = false,
  recent: recentProp = [],
  onNavigate,
  autoFocus = false,
  limit = 8,
}: WebSearchBoxProps) {
  const base = useId();
  const listId = `${base}-list`;
  const recentHeadId = `${base}-rs`;
  const formRef = useRef<HTMLFormElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(defaultValue);
  const [preview, setPreview] = useState<WebSearchPopup | null>(popup === "closed" ? null : popup);
  const [open, setOpen] = useState(popup !== "closed");
  const [active, setActive] = useState(popup === "closed" ? -1 : defaultActiveIndex);
  const [recent, setRecentState] = useState<string[]>([...recentProp]);
  const bar = layout === "bar";
  /** 비동기 출처의 마지막 답(어느 검색어의 것인지 함께) */
  const [remote, setRemote] = useState<{ q: string; status: "loading" | "ready" | "error" | "off"; items: readonly WebSearchSuggestion[] } | null>(null);
  const recentKey = recentProp.join("\n");
  // 앱이 저장소에서 읽은 최근 검색어가 늦게 오면 따라간다
  useEffect(() => {
    setRecentState(recentKey ? recentKey.split("\n") : []);
  }, [recentKey]);
  function setRecent(next: (r: string[]) => string[]) {
    const v = next(recent);
    setRecentState(v);
    onRecentChange?.(v);
  }
  // 검색 화면: 주소의 q를 입력에 채운다(처음과 뒤로·앞으로 갈 때)
  useEffect(() => {
    if (!queryFromUrl) return;
    const read = () => setValue(new URLSearchParams(window.location.search).get("q") ?? "");
    read();
    window.addEventListener("popstate", read);
    window.addEventListener(SEARCH_QUERY_SYNC_EVENT, read);
    return () => {
      window.removeEventListener("popstate", read);
      window.removeEventListener(SEARCH_QUERY_SYNC_EVENT, read);
    };
  }, [queryFromUrl]);

  useEffect(() => {
    if (!autoFocus) return;
    inputRef.current?.focus();
    // 머리를 검색 모드로 바꾼 바로 그때가 '입력 전 초점'이다(창 바깥 문서에 초점이 없으면 focus 이벤트가 늦을 수 있어 직접 연다)
    setOpen(true);
  }, [autoFocus]);
  useOutsidePress([formRef], open, () => {
    setOpen(false);
    setActive(-1);
  });

  const q = value.trim();
  // 비동기 출처: 기다렸다 부르고, 입력이 바뀌면 이전 요청을 취소한다
  // 출처 함수는 ref에 담는다(그릴 때마다 새 함수를 넘겨도 효과가 되풀이되지 않게)
  const remoteRef = useRef(remote);
  remoteRef.current = remote;
  const loadRef = useRef(loadSuggestions);
  const peekRef = useRef(peekSuggestions);
  loadRef.current = loadSuggestions;
  peekRef.current = peekSuggestions;
  const async = Boolean(loadSuggestions);
  useEffect(() => {
    const load = loadRef.current;
    if (!load || preview || !q) {
      setRemote(null);
      return;
    }
    // 창을 열기 전(주소의 q를 채운 직후 등)에는 부르지 않는다. 초점·입력으로 창이 열리면 부른다
    if (!open) return;
    // 바로 답할 수 있으면(최소 길이 미만·받은 후보 안에서 거르기) 기다리지 않는다
    const quick = peekRef.current?.(q);
    if (quick !== undefined) {
      setRemote({ q, status: quick === null ? "off" : "ready", items: (quick ?? []).slice(0, limit) });
      return;
    }
    // 같은 검색어의 답이 이미 있으면(창을 다시 연 때) 다시 부르지 않는다. 지금 값은 ref로 본다(갱신 함수는 늦게 돌 수 있다)
    const r = remoteRef.current;
    if (r && r.q === q && r.status === "ready") return;
    if (!(r && r.q === q)) setRemote({ q, status: "loading", items: [] });
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      load(q, ctrl.signal).then(
        (items) => {
          if (!ctrl.signal.aborted) setRemote({ q, status: items === null ? "off" : "ready", items: (items ?? []).slice(0, limit) });
        },
        () => {
          if (!ctrl.signal.aborted) setRemote({ q, status: "error", items: [] });
        },
      );
    }, debounceMs);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [q, open, preview, async, debounceMs, limit]);
  // 바로 답할 수 있으면(최소 길이 미만·받은 후보 안에서 거르기) 그리는 중에 쓴다(효과를 기다리면 뼈대가 한 번 깜빡인다)
  const quick = useMemo(
    () => (async && open && q && !preview ? peekSuggestions?.(q) : undefined),
    [async, open, q, preview, peekSuggestions],
  );
  const answer = quick !== undefined ? { q, status: quick === null ? ("off" as const) : ("ready" as const), items: (quick ?? []).slice(0, limit) } : remote;
  const live = useMemo(() => {
    if (!q) return [];
    if (loadSuggestions) return answer && answer.q === q ? answer.items : [];
    const found = getSuggestions ? getSuggestions(q) : suggestions.filter((s) => s.label.toLowerCase().includes(q.toLowerCase()));
    return found.slice(0, limit);
  }, [q, getSuggestions, suggestions, limit, loadSuggestions, answer]);
  const mode: WebSearchPopup = searchPopupMode({
    preview,
    q,
    recentCount: recent.length,
    async,
    remote: answer ? { q: answer.q, status: answer.status, count: answer.items.length } : null,
    syncCount: live.length,
  });
  const shown = preview === "suggest" && popupSuggestions ? popupSuggestions : live;
  const rows: Row[] =
    mode === "recent"
      ? recent.map((text) => ({ kind: "recent" as const, text }))
      : mode === "suggest"
        ? [...shown.map((s) => ({ kind: "suggestion" as const, s })), { kind: "all" as const }]
        : mode === "none"
          ? [{ kind: "all" as const }]
          : [];
  const expanded = open && mode !== "closed";
  const optionId = (i: number) => `${base}-opt-${i}`;

  function go(href: string) {
    setOpen(false);
    setActive(-1);
    if (onNavigate) onNavigate(href);
    else window.location.assign(href);
  }
  function submit(text: string) {
    const t = text.trim();
    if (!t) return;
    setRecent((r) => [t, ...r.filter((x) => x !== t)].slice(0, 10));
    go(`${action}?q=${encodeURIComponent(t)}`);
  }
  function choose(i: number) {
    const row = rows[i];
    if (!row || row.kind === "all") return submit(value);
    if (row.kind === "recent") return submit(row.text);
    go(row.s.href);
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      if (rows.length) setActive((i) => (i + 1) % rows.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setOpen(true);
      if (rows.length) setActive((i) => (i <= 0 ? rows.length - 1 : i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (expanded && active >= 0 && rows[active]) choose(active);
      else submit(value);
    } else if (e.key === "Escape") {
      if (expanded) {
        e.preventDefault();
        setOpen(false);
        setActive(-1);
      } else if (value) {
        setValue("");
      }
    }
  }

  // 창 위치·모양: 데스크톱은 입력 아래(top 46), 휴대폰은 머리 바로 아래 꽉 찬 폭(위 모서리 없이 아래 선만), 태블릿은 좌우 16 띄운 둥근 창
  const menu = bar
    ? "menu absolute inset-x-0 top-14 z-20 gap-0.5 p-2 max-md:rounded-none max-md:border-x-0 max-md:border-t-0 md:inset-x-4 md:top-[52px]"
    : "menu absolute inset-x-0 top-[46px] z-20 gap-0.5";
  // 줄 높이: 휴대폰·태블릿은 누르기 쉬운 44·48, 데스크톱은 키트 기본(40)
  const tall = bar ? "min-h-11" : "";
  const allRow = bar ? "min-h-12 max-md:rounded-none md:rounded-[0_0_6px_6px]" : "rounded-[0_0_6px_6px]";
  const kbdHint = (
    <p className={cx("row t-xs muted", bar && "hidden md:flex")} style={{ gap: 6, padding: "8px 10px 4px", borderTop: "1px solid var(--border)" }}>
      <span className="kbd">↑</span>
      <span className="kbd">↓</span>로 고르고 <span className="kbd">Enter</span>로 검색합니다
    </p>
  );

  return (
    <form
      ref={formRef}
      className={bar ? "grow" : "relative"}
      style={bar ? undefined : { flex: 1, maxWidth: 520, marginLeft: 12 }}
      role="search"
      aria-label="공연 검색"
      action={action}
      method="get"
      onSubmit={(e) => {
        e.preventDefault();
        submit(value);
      }}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
          setOpen(false);
          setActive(-1);
        }
      }}
    >
      <div className={cx("input-group input-group-sm", expanded && "is-focus")}>
        <i className="ic ic-search" aria-hidden="true" />
        <input
          ref={inputRef}
          type="search"
          name="q"
          enterKeyHint="search"
          maxLength={50}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={expanded}
          aria-controls={listId}
          aria-activedescendant={expanded && active >= 0 && rows[active] ? optionId(active) : undefined}
          aria-label="공연, 아티스트, 공연장 검색"
          placeholder="공연, 아티스트, 공연장 검색"
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setPreview(null);
            setOpen(true);
            setActive(-1);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
        />
        {value ? (
          <button
            className="icon-btn icon-btn-sm"
            type="button"
            aria-label="검색어 지우기"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              setValue("");
              setPreview(null);
              setActive(-1);
              inputRef.current?.focus();
            }}
          >
            <i className="ic ic-close" aria-hidden="true" />
          </button>
        ) : null}
      </div>

      {/* 닫힌 창: 보드처럼 빈 listbox만 숨겨 둔다(aria-controls가 가리킬 곳) */}
      {!expanded ? <ul id={listId} role="listbox" aria-label="자동완성" hidden /> : null}

      {expanded && mode === "recent" ? (
        <div className={cx(menu, bar && "pb-2.5")} onMouseDown={(e) => e.preventDefault()}>
          <div className="row between" style={{ padding: "6px 10px 4px" }}>
            <span className="eyebrow" id={recentHeadId}>
              최근 검색어
            </span>
            <span className="t-xs muted">이 기기에만 저장됩니다</span>
          </div>
          <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start">
            <ul id={listId} role="listbox" aria-labelledby={recentHeadId} className="col">
              {recent.map((text, i) => (
                <li
                  key={text}
                  id={optionId(i)}
                  role="option"
                  aria-selected={active === i}
                  className={cx("menu-item", tall, active === i && "is-active")}
                  onClick={() => submit(text)}
                >
                  <i className="ic ic-history ic-16 muted" aria-hidden="true" />
                  {text}
                </li>
              ))}
            </ul>
            <ul className="col" aria-label="최근 검색어 하나씩 지우기">
              {recent.map((text) => (
                <li key={text}>
                  <button
                    className="icon-btn"
                    type="button"
                    aria-label={`최근 검색어 ${text} 지우기`}
                    style={bar ? undefined : { width: 40, height: 40 }}
                    onClick={() => {
                      setRecent((r) => r.filter((x) => x !== text));
                      setActive(-1);
                    }}
                  >
                    <i className="ic ic-close" aria-hidden="true" style={{ width: 16, height: 16 }} />
                  </button>
                </li>
              ))}
            </ul>
          </div>
          <div className="row" style={{ justifyContent: "flex-end", borderTop: "1px solid var(--border)", padding: bar ? "6px 6px 0" : "6px 6px 2px", marginTop: 4 }}>
            <button
              className={cx("btn btn-text btn-sm", tall)}
              type="button"
              onClick={() => {
                setRecent(() => []);
                setActive(-1);
                inputRef.current?.focus();
              }}
            >
              최근 검색어 전체 지우기
            </button>
          </div>
        </div>
      ) : null}

      {expanded && mode === "loading" ? (
        <div className={menu} onMouseDown={(e) => e.preventDefault()}>
          <ul id={listId} role="listbox" aria-label="자동완성" aria-busy="true" />
          <ul className="col" style={{ gap: 2 }} aria-hidden="true">
            {[72, 56, 64].map((w, i) => (
              <li key={w} className="menu-item" style={{ minHeight: 56, gap: 10 }}>
                <span className="skel" style={{ width: 30, height: 40, flex: "none" }} />
                <span className="col grow" style={{ gap: 6 }}>
                  <span className="skel" style={{ height: 14, width: `${w}%` }} />
                  <span className="skel" style={{ height: 12, width: `${[44, 30, 40][i]}%` }} />
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {expanded && (mode === "suggest" || mode === "none") ? (
        <div className={menu} onMouseDown={(e) => e.preventDefault()}>
          {mode === "none" ? (
            <p className="row t-sm muted" style={{ gap: 8, padding: "12px 10px" }}>
              <i className="ic ic-info ic-16" aria-hidden="true" />
              맞는 공연·아티스트·공연장이 없습니다
            </p>
          ) : null}
          <ul id={listId} role="listbox" aria-label="자동완성" className="col" style={{ gap: 2 }}>
            {rows.map((row, i) =>
              row.kind === "suggestion" ? (
                <li
                  key={row.s.id}
                  id={optionId(i)}
                  role="option"
                  aria-selected={active === i}
                  className={cx("menu-item", row.s.meta ? "min-h-14" : tall, active === i && "is-active")}
                  style={{ gap: 10 }}
                  onClick={() => choose(i)}
                >
                  <i className={cx("ic ic-16 muted", kindIcon[row.s.kind])} aria-hidden="true" />
                  {row.s.thumbnail}
                  <span className="col grow" style={{ gap: 2, minWidth: 0 }}>
                    <span className="ellipsis">
                      <Marked s={row.s} q={q} />
                    </span>
                    {row.s.meta ? <span className="t-xs muted num">{row.s.meta}</span> : null}
                  </span>
                  <span className="t-xs muted">{kindText[row.s.kind]}</span>
                </li>
              ) : row.kind === "all" ? (
                <li
                  key="all"
                  id={optionId(i)}
                  role="option"
                  aria-selected={active === i}
                  className={cx("menu-item", allRow, active === i && "is-active")}
                  style={{ gap: 10, borderTop: "1px solid var(--border)", marginTop: mode === "suggest" ? 4 : 0 }}
                  onClick={() => choose(i)}
                >
                  <i className="ic ic-search ic-16" aria-hidden="true" />
                  <span className="grow fw-b">&apos;{q}&apos; 전체 결과 보기</span>
                  <i className="ic ic-chevron-right ic-16" aria-hidden="true" />
                </li>
              ) : null,
            )}
          </ul>
          {mode === "suggest" ? kbdHint : null}
        </div>
      ) : null}
      {/* 늘 있는 알림 영역 하나(조건 덩어리 안에 두면 바뀔 때마다 새로 생겨 화면 낭독기가 읽지 않는다). 불러오는 중은 알리지 않는다 */}
      <p className="sr-only" role="status" aria-live="polite">
        {expanded && mode === "suggest" ? `검색어 후보 ${shown.length}개` : expanded && mode === "none" ? "맞는 공연·아티스트·공연장이 없습니다" : ""}
      </p>
    </form>
  );
}
