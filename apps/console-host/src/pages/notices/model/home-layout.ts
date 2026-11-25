// 홈 구성(SCR-068 [홈 구성]) 보기·상태·검사·저장 본문(F-03-5, OPS-410).
// 정본: docs/design/d5-screen-blueprint.md §7.16(배너 10·테마 5·테마당 공연 20 [가정], 상태 게시 중·예정·끝남·노출 안 됨),
// docs/features/control-tower.md §14 C-T29(판매 승인 전 422, 판이 다르면 412), ADR-0063·ADR-0199 결정 5(제목 40·부제 80),
// docs/api/openapi.yaml HomeLayout·HomeLayoutInput(updatedBy·updatedAt 읽기 전용). 값은 정본에서 가져온다.
import type { HomeLayout, HomeLayoutInput } from '@peaket/api-client/model';

export type HomeStatus = '게시 중' | '예정' | '끝남' | '노출 안 됨';

export type BannerView = {
  bannerId?: string;
  productionId: string;
  imageId: string;
  alt: string;
  title?: string;
  subtitle?: string;
  displayFrom: string;
  displayUntil: string;
  status: HomeStatus;
  reason?: string;
};

export type ThemeView = {
  themeId?: string;
  name: string;
  productionIds: string[];
  displayFrom: string;
  displayUntil: string;
  status: HomeStatus;
  reason?: string;
};

export type HomeLayoutView = {
  version: number;
  updatedBy?: string;
  updatedAt?: string;
  banners: BannerView[];
  themes: ThemeView[];
};

export type HomeContext = {
  nowMs: number;
  approvedProductionIds: readonly string[];
  cancelledProductionIds?: readonly string[];
};

export const BANNER_MAX = 10;
export const THEME_MAX = 5;
export const THEME_PRODUCTIONS_MAX = 20;
export const ALT_MAX = 300;
export const TITLE_MAX = 40;
export const SUBTITLE_MAX = 80;
export const THEME_NAME_MAX = 30;

const at = (iso: string) => Date.parse(iso);

function statusOf(productionIds: readonly string[], { nowMs, approvedProductionIds, cancelledProductionIds = [] }: HomeContext, from: string, until: string): { status: HomeStatus; reason?: string } {
  if (productionIds.some((id) => cancelledProductionIds.includes(id))) return { status: '노출 안 됨', reason: '회차가 모두 취소됨' };
  if (productionIds.some((id) => !approvedProductionIds.includes(id))) return { status: '노출 안 됨', reason: '판매 승인된 공연이 아님' };
  const fromMs = at(from);
  const untilMs = at(until);
  if (Number.isFinite(untilMs) && nowMs >= untilMs) return { status: '끝남' };
  if (Number.isFinite(fromMs) && nowMs < fromMs) return { status: '예정' };
  return { status: '게시 중' };
}

export function homeLayoutView(raw: HomeLayout, ctx: HomeContext): HomeLayoutView {
  return {
    version: raw.version,
    ...(raw.updatedBy ? { updatedBy: raw.updatedBy } : {}),
    ...(raw.updatedAt ? { updatedAt: raw.updatedAt } : {}),
    banners: raw.banners.map((b) => {
      const { status, reason } = statusOf([b.productionId], ctx, b.displayFrom, b.displayUntil);
      return {
        ...(b.bannerId ? { bannerId: b.bannerId } : {}),
        productionId: b.productionId,
        imageId: b.imageId,
        alt: b.alt,
        ...(b.title ? { title: b.title } : {}),
        ...(b.subtitle ? { subtitle: b.subtitle } : {}),
        displayFrom: b.displayFrom,
        displayUntil: b.displayUntil,
        status,
        ...(reason ? { reason } : {}),
      };
    }),
    themes: raw.themes.map((t) => {
      const { status, reason } = statusOf(t.productionIds, ctx, t.displayFrom, t.displayUntil);
      return {
        ...(t.themeId ? { themeId: t.themeId } : {}),
        name: t.name,
        productionIds: [...t.productionIds],
        displayFrom: t.displayFrom,
        displayUntil: t.displayUntil,
        status,
        ...(reason ? { reason } : {}),
      };
    }),
  };
}

/** 저장된 배너의 표시용 상태는 검사에 쓰지 않는다(이미 숨은 배너를 저장할 수 있어야 한다). 새 값 검사만 한다 */
export function bannerIssue(banner: BannerView, ctx: HomeContext): string | null {
  const cancelled = (ctx.cancelledProductionIds ?? []).includes(banner.productionId);
  if (!cancelled && !ctx.approvedProductionIds.includes(banner.productionId)) return '판매 승인된 공연만 배너에 넣을 수 있습니다';
  if (!banner.imageId.trim()) return '배너 이미지를 먼저 올려 주세요';
  if (!banner.alt.trim() || banner.alt.length > ALT_MAX) return `대체 텍스트는 1~${ALT_MAX}자로 적어 주세요`;
  if (!banner.title?.trim() || banner.title.length > TITLE_MAX) return `배너 제목은 1~${TITLE_MAX}자로 적어 주세요`;
  if (!banner.subtitle?.trim() || banner.subtitle.length > SUBTITLE_MAX) return `배너 부제는 1~${SUBTITLE_MAX}자로 적어 주세요`;
  if (!(at(banner.displayUntil) > at(banner.displayFrom))) return '노출 기간의 끝은 시작 뒤여야 합니다';
  return null;
}

export function themeIssue(theme: ThemeView, ctx: HomeContext): string | null {
  if (!theme.name.trim() || theme.name.length > THEME_NAME_MAX) return `테마 이름은 1~${THEME_NAME_MAX}자로 적어 주세요`;
  if (theme.productionIds.length === 0 || theme.productionIds.length > THEME_PRODUCTIONS_MAX) return `테마에는 공연을 1~${THEME_PRODUCTIONS_MAX}개 넣습니다`;
  const cancelled = ctx.cancelledProductionIds ?? [];
  if (theme.productionIds.some((id) => !ctx.approvedProductionIds.includes(id) && !cancelled.includes(id))) return '판매 승인된 공연만 테마에 넣을 수 있습니다';
  if (!(at(theme.displayUntil) > at(theme.displayFrom))) return '노출 끝은 시작 뒤여야 합니다';
  return null;
}

/** 게시를 막는 까닭 전부(개수 상한 포함). 화면은 첫 줄을 보이고 나머지는 접어 둔다 */
export function homeLayoutIssues(view: HomeLayoutView, ctx?: HomeContext): string[] {
  const out: string[] = [];
  if (view.banners.length > BANNER_MAX) out.push(`배너는 ${BANNER_MAX}장까지입니다`);
  if (view.themes.length > THEME_MAX) out.push(`테마는 ${THEME_MAX}개까지입니다`);
  // ctx 없이 부르면 저장된 상태의 승인 여부를 다시 보지 않는다(개수·길이만 본다)
  if (ctx) {
    for (const b of view.banners) {
      const issue = bannerIssue(b, ctx);
      if (issue) out.push(issue);
    }
    for (const t of view.themes) {
      const issue = themeIssue(t, ctx);
      if (issue) out.push(issue);
    }
  }
  return [...new Set(out)];
}

function bannerOf(b: BannerView): HomeLayoutInput['banners'][number] {
  return {
    ...(b.bannerId ? { bannerId: b.bannerId } : {}),
    productionId: b.productionId,
    imageId: b.imageId,
    alt: b.alt,
    title: b.title!,
    subtitle: b.subtitle!,
    displayFrom: b.displayFrom,
    displayUntil: b.displayUntil,
  };
}

function themeOf(t: ThemeView): HomeLayoutInput['themes'][number] {
  return {
    ...(t.themeId ? { themeId: t.themeId } : {}),
    name: t.name,
    productionIds: [...t.productionIds],
    displayFrom: t.displayFrom,
    displayUntil: t.displayUntil,
  };
}

/** PUT /v1/ops/home-layout 본문. 화면용 status·reason과 서버 칸 updatedBy·updatedAt을 빼고, 검사에 걸리면 null */
export function homeLayoutInputOf(view: HomeLayoutView, { reason }: { reason: string }): HomeLayoutInput | null {
  if (view.banners.length > BANNER_MAX || view.themes.length > THEME_MAX) return null;
  if (!reason.trim()) return null;
  if (view.banners.some((b) => b.status === '노출 안 됨' && b.reason === '판매 승인된 공연이 아님')) return null;
  if (view.themes.some((t) => t.status === '노출 안 됨' && t.reason === '판매 승인된 공연이 아님')) return null;
  if (view.banners.some((b) => !(at(b.displayUntil) > at(b.displayFrom)))) return null;
  if (view.themes.some((t) => !(at(t.displayUntil) > at(t.displayFrom)))) return null;
  if (view.banners.some((b) => !b.title?.trim() || !b.subtitle?.trim() || !b.alt.trim() || !b.imageId.trim())) return null;
  if (view.themes.some((t) => !t.name.trim() || t.productionIds.length === 0 || t.productionIds.length > THEME_PRODUCTIONS_MAX)) return null;
  return {
    version: view.version,
    banners: view.banners.map(bannerOf),
    themes: view.themes.map(themeOf),
    reason: reason.trim(),
  };
}

export function ifMatchOf(version: number): string {
  return String(version);
}

/** 배너 파일 검사(openapi banner-images: JPEG·PNG·WebP, 한 장 10MB, ADR-0062 결정 38). 서버가 다시 검사한다 */
export const BANNER_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export const BANNER_MAX_BYTES = 10 * 1024 * 1024;

export function bannerFileIssue(file: { type: string; size: number }): string | null {
  if (!BANNER_TYPES.includes(file.type as (typeof BANNER_TYPES)[number])) return '이미지 형식을 확인해 주세요. JPEG·PNG·WebP만 올릴 수 있습니다';
  if (file.size > BANNER_MAX_BYTES) return '이미지 용량은 10MB까지입니다';
  return null;
}
