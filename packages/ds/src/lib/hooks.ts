// 상호작용 부품이 함께 쓰는 훅. 이 파일을 가져오는 부품은 모두 'use client'다.
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

/** 제어(value)·비제어(defaultValue)를 함께 받는 상태 */
export function useControllable<T>(
  value: T | undefined,
  defaultValue: T,
  onChange?: (next: T) => void,
): [T, (next: T) => void] {
  const [inner, setInner] = useState<T>(defaultValue);
  const controlled = value !== undefined;
  const current = controlled ? (value as T) : inner;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const set = useCallback(
    (next: T) => {
      if (!controlled) setInner(next);
      onChangeRef.current?.(next);
    },
    [controlled],
  );
  return [current, set];
}

function subscribeReducedMotion(callback: () => void) {
  if (typeof window === "undefined" || !window.matchMedia) return () => {};
  const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
  mq.addEventListener("change", callback);
  return () => mq.removeEventListener("change", callback);
}

/** 움직임 줄이기 설정(prefers-reduced-motion: reduce)이 켜졌는지. 서버에서는 false */
export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribeReducedMotion,
    () => typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches,
    () => false,
  );
}

/** 미디어 쿼리가 맞는지. 서버와 첫 그리기에서는 serverValue(기본 false) */
export function useMediaQuery(query: string, serverValue = false): boolean {
  return useSyncExternalStore(
    (callback) => {
      if (typeof window === "undefined" || !window.matchMedia) return () => {};
      const mq = window.matchMedia(query);
      mq.addEventListener("change", callback);
      return () => mq.removeEventListener("change", callback);
    },
    () => (typeof window !== "undefined" && window.matchMedia ? window.matchMedia(query).matches : serverValue),
    () => serverValue,
  );
}

/** 값이 바뀐 뒤에만 실행되는 효과(첫 그리기는 건너뛴다) */
export function useUpdateEffect(effect: () => void | (() => void), deps: unknown[]) {
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    return effect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
