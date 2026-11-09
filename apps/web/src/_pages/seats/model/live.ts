// SCR-010 좌석 화면을 실제 좌석맵에 잇는 규칙(BUILD_ORDER HOT-350 ①, ADR-0224, docs/frontend.md §4.2.2·§5.2). 화면 없이 시험한다.

/** 입장 확정 응답을 대기실이 탭 저장소에 둔 값(apps/web/queue-room live/store.ts `Admission`) */
export interface StoredAdmission {
  admissionToken: string;
  serverEcdhPublicKey?: Record<string, string>;
  seatmapLayoutPath?: string;
  purchaseSessionExpiresAt?: string;
  receivedAt?: number;
}

export const admissionKey = (eventId: string): string => `peaket.admission.${eventId}`;

/** 입장 저장값. 없거나 모양이 틀리면 null(저장소를 못 읽는 브라우저 포함) */
export function readAdmission(eventId: string, storage: Pick<Storage, 'getItem'>): StoredAdmission | null {
  try {
    const v: unknown = JSON.parse(storage.getItem(admissionKey(eventId)) ?? 'null');
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
    const t = (v as { admissionToken?: unknown }).admissionToken;
    return typeof t === 'string' && t.length > 0 ? (v as StoredAdmission) : null;
  } catch {
    return null;
  }
}

/** 예매 시간이 끝났을 때 입장 저장값을 지운다. 남겨 두면 대기실이 만료 전 값을 보고 좌석 화면으로 되돌려 보낸다 */
export function clearAdmission(eventId: string, storage: Pick<Storage, 'removeItem'>): void {
  try {
    storage.removeItem(admissionKey(eventId));
  } catch {
    /* 저장소를 못 쓰면 지울 것도 없다 */
  }
}

const U32_MAX = 4_294_967_295;

/** 입장 확정 응답의 좌석맵 경로가 이 회차의 같은 출처 경로면 그대로, 아니면 null(다른 출처·다른 회차·틀린 판 번호로 요청하지 않는다) */
export function seatmapLayoutUrl(eventId: string, path: string | undefined): string | null {
  if (!path) return null;
  const prefix = `/v1/events/${encodeURIComponent(eventId)}/seatmap-layouts/`;
  if (!path.startsWith(prefix)) return null;
  const m = /^([1-9]\d{0,9})\.json$/.exec(path.slice(prefix.length));
  return m && Number(m[1]) <= U32_MAX ? path : null;
}

/** 스냅샷 주소. 서버가 준 값이 아니라 설정한 API 출처로 만든다 */
export const snapshotUrl = (apiOrigin: string, eventId: string): string => `${apiOrigin}/v1/events/${encodeURIComponent(eventId)}/seatmap-snapshot`;

/** 좌석맵 메시지 검사 범위(@peaket/seatmap protocol). 넘겨서 지도를 잃지 않게 자른다 */
const MAX_TIERS = 16;
const MAX_TIER_NAME = 32;

/** 회차 가격표의 등급 ID를 가격이 높은 차례로(좌석맵의 구역 색, createSeatMap tierRank). 비었으면 undefined(파일 차례를 쓴다) */
export function tierRank(tiers: ReadonlyArray<{ tierId: string; price: number }>): string[] | undefined {
  if (tiers.length === 0) return undefined;
  return [...tiers]
    .sort((a, b) => b.price - a.price)
    .slice(0, MAX_TIERS)
    .map((t) => t.tierId);
}

/** 등급 ID → 화면 글자(좌석맵의 구역 글자, createSeatMap tierNames). 비었으면 undefined */
export function tierNames(tiers: ReadonlyArray<{ tierId: string; name: string }>): Record<string, string> | undefined {
  return tiers.length === 0 ? undefined : Object.fromEntries(tiers.slice(0, MAX_TIERS).map((t) => [t.tierId, t.name.slice(0, MAX_TIER_NAME)]));
}

export type SeatsPhase = 'loading' | 'ready' | 'ended' | 'invalid' | 'failed';

/**
 * 좌석맵 오류 → 다음 동작(§4.1 '401'·§4.4.2, ADR-0224 결정 5).
 * 스냅샷의 이름 없는 401은 팬 쿠키 만료일 수 있어 한 번 갱신하고 다시 받는다(입장 토큰 거절도 같은 모양이라 다시 받아도 401이면 끝이다).
 * 이름 있는 401과 403은 구매 세션이 끝난 것이다. Retry-After가 있는 503·429는 그만큼 뒤에 스스로 다시 받는다
 */
export function errorPhase(e: { source?: 'layout' | 'snapshot'; status?: number; problem?: string; retryAfter?: number }): 'ended' | 'refresh' | 'retry' | 'failed' {
  if (e.source !== 'snapshot') return 'failed';
  if (e.status === 403) return 'ended';
  if (e.status === 401) return !e.problem || e.problem === 'about:blank' ? 'refresh' : 'ended';
  return (e.status === 503 || e.status === 429) && e.retryAfter !== undefined ? 'retry' : 'failed';
}

export type GestureCommand = { type: 'pan'; dx: number; dy: number } | { type: 'zoomBy'; factor: number; x: number; y: number } | { type: 'tap'; x: number; y: number };

/** 이만큼 움직이면 누르기가 아니라 끌기다 [가정] */
const TAP_SLOP_PX = 8;

/** 포인터 사건 → 끌기·핀치·누르기 명령. 좌표는 캔버스 기준 CSS px */
export function createGesture() {
  const points = new Map<number, { x: number; y: number }>();
  /** 이번 몸짓(처음 누른 때부터 다 뗄 때까지)이 끌기·핀치가 됐는가 */
  let moved = false;
  let start = { x: 0, y: 0 };

  const pair = () => {
    const [a, b] = [...points.values()] as [{ x: number; y: number }, { x: number; y: number }];
    return { dist: Math.hypot(a.x - b.x, a.y - b.y), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
  };

  return {
    down(id: number, x: number, y: number): void {
      if (points.size === 0) {
        moved = false;
        start = { x, y };
      } else {
        moved = true;
      }
      points.set(id, { x, y });
    },
    move(id: number, x: number, y: number): GestureCommand[] {
      const p = points.get(id);
      if (!p) return [];
      if (points.size === 2) {
        const before = pair();
        p.x = x;
        p.y = y;
        const after = pair();
        if (before.dist === 0 || after.dist === 0) return [];
        return [
          { type: 'pan', dx: after.cx - before.cx, dy: after.cy - before.cy },
          { type: 'zoomBy', factor: after.dist / before.dist, x: after.cx, y: after.cy },
        ];
      }
      if (points.size > 2) {
        p.x = x;
        p.y = y;
        return [];
      }
      if (!moved && Math.hypot(x - start.x, y - start.y) < TAP_SLOP_PX) return [];
      moved = true;
      const dx = x - p.x;
      const dy = y - p.y;
      p.x = x;
      p.y = y;
      return dx === 0 && dy === 0 ? [] : [{ type: 'pan', dx, dy }];
    },
    up(id: number, x: number, y: number): GestureCommand[] {
      if (!points.delete(id)) return [];
      return !moved && points.size === 0 ? [{ type: 'tap', x, y }] : [];
    },
    cancel(id: number): void {
      points.delete(id);
      moved = true;
    },
  };
}

/** 예매 흐름이 새 좌석을 고를 수 있는 상태인가(booking-machine이 새 좌석의 TOGGLE을 받는 상태, ADR-0236) */
export function canPick(value: unknown): boolean {
  return value === 'selecting' || value === 'paused';
}

/** 마우스 올림 위치를 Worker에 보낸다: 누르지 않은 마우스·펜이고 고를 수 있는 동안만. 그렇지 않게 되면 한 번만 지운다(ADR-0236) */
export function createHoverTracker(send: (m: { kind: 'move' | 'leave'; x: number; y: number }) => void, pickable: () => boolean) {
  let tracked = false;
  const stop = (): void => {
    if (!tracked) return;
    tracked = false;
    send({ kind: 'leave', x: 0, y: 0 });
  };
  return {
    move(x: number, y: number, e: { pointerType: string; buttons: number }): void {
      if (e.pointerType !== 'touch' && e.buttons === 0 && pickable()) {
        tracked = true;
        send({ kind: 'move', x, y });
      } else stop();
    },
    stop,
  };
}

/** 줄 단위 휠 한 칸의 픽셀(Firefox deltaMode 1) */
const LINE_PX = 16;

/** 휠 → 확대 배율. 아래로 축소, 위로 확대, 한 번에 2배까지 */
export function wheelFactor(deltaY: number, deltaMode: number): number {
  const px = deltaMode === 1 ? deltaY * LINE_PX : deltaY;
  return Math.min(2, Math.max(0.5, Math.exp(-px * 0.002)));
}
