// 공지 관리 화면(SCR-068)의 역할·탭·검사·오류 글(F-03-5, OPS-410).
// 정본: docs/design/d5-screen-blueprint.md §7.16(템플릿 네 언어 120자·파트너 공지 제목 40·본문 500·채널, viewer 홈 구성 읽기만),
// docs/features/control-tower.md §12(휴대폰은 보기·이미 요청된 승인만), docs/api/openapi.yaml NoticeTemplateCreate·PartnerNoticeCreate,
// 계획 docs/review/plans/F-03-5.md §4. 값은 정본에서 가져오고 화면이 다시 해석하지 않는다.
import { PHONE_SCOPE_TEXT } from '@/shared/lib/layout';
import type { NoticeTemplateCreate, NoticeTemplateUpdate, PartnerNoticeCreate } from '@peaket/api-client/model';

export type NoticeRole = 'viewer' | 'operator' | 'commander';
export type NoticeTab = 'templates' | 'partner' | 'home';
export type NoticeAction = 'edit-template' | 'create-template' | 'approve-template' | 'send-partner' | 'publish-home' | 'upload-banner';
export type NoticeLayout = 'desktop' | 'tablet' | 'phone';

export const NOTICE_TAB_LABEL: Record<NoticeTab, string> = {
  templates: '대기실 공지 템플릿',
  partner: '파트너 긴급 공지',
  home: '홈 구성',
};

/** 역할이 볼 수 있는 탭(d5 §7.16: viewer는 홈 구성 보기만, CS 두 역할은 메뉴에 없다) */
export function noticeTabs(role: NoticeRole): NoticeTab[] {
  return role === 'viewer' ? ['home'] : ['templates', 'partner', 'home'];
}

/** 화면 막힘. 권한은 서버가 막고 이 판정은 편의다(ASVS 8.1.1) */
export function noticeAvailability({ role, layout, action }: { role: NoticeRole; layout: NoticeLayout; action: NoticeAction }): { allowed: boolean; reason?: string } {
  if (layout === 'phone') return { allowed: false, reason: PHONE_SCOPE_TEXT };
  if (role === 'viewer') return { allowed: false, reason: '이 작업을 할 권한이 없습니다' };
  if (action === 'approve-template' && role !== 'commander') return { allowed: false, reason: '템플릿 승인은 commander만 할 수 있습니다' };
  return { allowed: true };
}

export type NoticeTexts = { ko: string; en: string; ja: string; zh: string };
export const NOTICE_LANGS = ['ko', 'en', 'ja', 'zh'] as const;
export const TEXT_MAX = 120;
export const TEMPLATE_ID = /^[a-z][a-z0-9-]{2,39}$/;

export function missingLanguages(texts: Partial<NoticeTexts>): (keyof NoticeTexts)[] {
  return NOTICE_LANGS.filter((lang) => typeof texts[lang] !== 'string' || (texts[lang] ?? '').trim() === '');
}

/** 템플릿 초안 검사. 처음 걸린 까닭 하나를 돌려준다(화면은 그 까닭을 보인다) */
export function templateIssue(draft: { templateId: string; title: string; texts: NoticeTexts }): string | null {
  if (!TEMPLATE_ID.test(draft.templateId)) return '템플릿 id는 영문 소문자로 시작하고 소문자·숫자·하이픈 3~40자입니다';
  if (draft.title.trim() === '' || draft.title.length > 60) return '제목은 1~60자로 적어 주세요';
  const missing = missingLanguages(draft.texts);
  if (missing.length) return `언어별 문구가 빠졌습니다: ${missing.join('·')}`;
  const long = NOTICE_LANGS.find((lang) => draft.texts[lang].length > TEXT_MAX);
  if (long) return `${long} 문구는 ${TEXT_MAX}자까지입니다`;
  return null;
}

export function templateCreateBody(draft: { templateId: string; title: string; texts: NoticeTexts }): NoticeTemplateCreate | null {
  if (templateIssue(draft)) return null;
  return { templateId: draft.templateId, title: draft.title.trim(), texts: { ...draft.texts } };
}

export function templateUpdateBody(draft: { title: string; texts: NoticeTexts }): NoticeTemplateUpdate | null {
  if (draft.title.trim() === '' || draft.title.length > 60) return null;
  const missing = missingLanguages(draft.texts);
  if (missing.length) return null;
  if (NOTICE_LANGS.some((lang) => draft.texts[lang].length > TEXT_MAX)) return null;
  return { title: draft.title.trim(), texts: { ...draft.texts } };
}

export type PartnerPhase = 'OCCURRED' | 'ONGOING' | 'RESOLVED';
export type PartnerChannel = 'CONSOLE_POPUP' | 'EMAIL';
export type PartnerDraft = {
  targetKind: 'ALL' | 'EVENT';
  eventId?: string;
  phase: PartnerPhase;
  title: string;
  body: string;
  channels: PartnerChannel[];
};

export const PARTNER_PHASE_PREFIX: Record<PartnerPhase, string> = { OCCURRED: '[발생]', ONGOING: '[진행]', RESOLVED: '[해결]' };
export const PARTNER_TITLE_MAX = 40;
export const PARTNER_BODY_MAX = 500;

export function partnerTitleWithPhase(phase: PartnerPhase, title: string): string {
  return `${PARTNER_PHASE_PREFIX[phase]} ${title}`.trim();
}

export function partnerIssue(draft: PartnerDraft): string | null {
  if (draft.targetKind === 'EVENT' && !draft.eventId?.trim()) return '회차의 파트너에게 보내려면 회차 ID가 필요합니다';
  if (draft.title.trim() === '' || draft.title.length > PARTNER_TITLE_MAX) return `제목은 1~${PARTNER_TITLE_MAX}자로 적어 주세요`;
  if (draft.body.trim() === '' || draft.body.length > PARTNER_BODY_MAX) return `본문은 1~${PARTNER_BODY_MAX}자로 적어 주세요`;
  if (draft.channels.length === 0) return '보낼 채널을 하나 이상 고르세요';
  return null;
}

export function partnerNoticeBody(draft: PartnerDraft): PartnerNoticeCreate | null {
  if (partnerIssue(draft)) return null;
  return {
    targetKind: draft.targetKind,
    ...(draft.targetKind === 'EVENT' ? { eventId: draft.eventId!.trim() } : {}),
    phase: draft.phase,
    title: draft.title.trim(),
    body: draft.body.trim(),
    channels: [...draft.channels],
  };
}

/** 서버 오류를 우리 글로 바꾼다(frontend §4.1: title·detail은 그대로 보이지 않는다) */
export function noticeProblem({ status, type }: { status: number; type?: string | undefined }): string {
  if (status === 403 && type === 'reauth-required') return '다시 로그인한 확인이 만료되었거나 이미 쓰였습니다. 다시 인증해 주세요';
  if (status === 412 || status === 409) return '다른 운영자가 먼저 저장했습니다. 새로 읽은 뒤 다시 게시해 주세요';
  if (status === 428) return '먼저 구성을 읽어야 저장할 수 있습니다';
  if (status === 403) return '이 작업을 할 권한이 없습니다';
  if (status === 404) return '찾을 수 없습니다. 새로 읽은 뒤 다시 시도해 주세요';
  if (status === 413) return '이미지 용량이 너무 큽니다. 10MB 이하 파일을 골라 주세요';
  if (status === 415) return '이미지 형식을 확인해 주세요. JPEG·PNG·WebP만 올릴 수 있습니다';
  if (status === 422) return '판매 승인·기간·이미지·문구를 확인해 주세요';
  if (status === 500 || status === 503) return '일시적인 오류입니다. 잠시 후 다시 시도해 주세요';
  return '요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요';
}
