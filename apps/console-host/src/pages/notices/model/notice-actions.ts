// 공지 화면의 요청 흐름(F-03-5, OPS-410): 템플릿 승인(재인증)·저장, 파트너 공지 발송, 홈 구성 게시·배너 이미지.
// 정본: docs/api/openapi.yaml createOpsNoticeTemplateApproval(ReauthToken·If-Match, commander, act APPROVAL),
// updateOpsNoticeTemplate(PATCH·If-Match), createOpsPartnerNotice(Idempotency-Key·202), putOpsHomeLayout(If-Match·reason),
// createOpsHomeLayoutBannerImage(multipart·X-Requested-With), docs/api/guidelines.md §7·§12,
// 계획 docs/review/plans/F-03-5.md §4. 생성 클라이언트로만 부른다(임의 fetch 없음).
import { ensureConsoleApi } from '@/shared/api';
import { ifMatchOf, homeLayoutInputOf, bannerFileIssue, type HomeLayoutView } from './home-layout';
import {
  missingLanguages,
  noticeAvailability,
  noticeProblem,
  partnerIssue,
  partnerNoticeBody,
  templateCreateBody,
  templateIssue,
  templateUpdateBody,
  type NoticeLayout,
  type NoticeRole,
  type NoticeTexts,
  type PartnerDraft,
} from './notices';

export type ActionResult<T = unknown> =
  | { kind: 'done'; value?: T }
  | { kind: 'problem'; status: number; type?: string; message: string }
  | { kind: 'blocked'; reason: string }
  | { kind: 'invalid'; message: string }
  | { kind: 'cancelled' }
  | { kind: 'busy' };

type TemplateLike = { templateId: string; title?: string; version: number; texts?: NoticeTexts };

export type NoticeActions = {
  approveTemplate(template: TemplateLike): Promise<ActionResult>;
  createTemplate(draft: { templateId: string; title: string; texts: NoticeTexts }): Promise<ActionResult>;
  updateTemplate(template: TemplateLike, draft: { templateId: string; title: string; texts: NoticeTexts }): Promise<ActionResult>;
  sendPartnerNotice(draft: PartnerDraft): Promise<ActionResult>;
  publishHomeLayout(view: HomeLayoutView, reason: string): Promise<ActionResult>;
  uploadBanner(file: File): Promise<ActionResult<{ imageId?: string; previewUrl?: string }>>;
};

const failure = <T = unknown,>(e: unknown): ActionResult<T> => {
  const p = (typeof e === 'object' && e !== null ? e : {}) as { status?: unknown; type?: unknown };
  const status = typeof p.status === 'number' ? p.status : 0;
  const type = typeof p.type === 'string' ? p.type : undefined;
  return { kind: 'problem', status, ...(type ? { type } : {}), message: noticeProblem({ status, ...(type ? { type } : {}) }) };
};

const isReauthRequired = (e: unknown) => {
  const p = (typeof e === 'object' && e !== null ? e : {}) as { status?: unknown; type?: unknown };
  return p.status === 403 && p.type === 'reauth-required';
};

const uuid = () => crypto.randomUUID();

export function createNoticeActions({ role, layout, reauth }: { role: NoticeRole; layout: NoticeLayout; reauth: (act: 'APPROVAL' | 'OPS_COMMAND') => Promise<string | null> }): NoticeActions {
  const inFlight = new Set<string>();
  const blocked = (action: Parameters<typeof noticeAvailability>[0]['action']): ActionResult | null => {
    const a = noticeAvailability({ role, layout, action });
    return a.allowed ? null : { kind: 'blocked', reason: a.reason ?? '이 작업을 할 수 없습니다' };
  };
  const once = async <T>(key: string, run: () => Promise<ActionResult<T>>): Promise<ActionResult<T>> => {
    if (inFlight.has(key)) return { kind: 'busy' };
    inFlight.add(key);
    try {
      if (!ensureConsoleApi()) return { kind: 'problem', status: 0, message: '관제 API 주소가 설정되지 않았습니다' };
      return await run();
    } catch (e) {
      return failure(e);
    } finally {
      inFlight.delete(key);
    }
  };
  const askReauth = async (): Promise<string | null> => {
    try {
      return await reauth('APPROVAL');
    } catch {
      return null;
    }
  };

  return {
    approveTemplate(template) {
      const stop = blocked('approve-template');
      if (stop) return Promise.resolve(stop);
      if (!template.texts || missingLanguages(template.texts).length) {
        return Promise.resolve({ kind: 'invalid', message: '네 언어 문구가 모두 있어야 승인할 수 있습니다' });
      }
      return once(`approve:${template.templateId}`, async () => {
        const first = await askReauth();
        if (!first) return { kind: 'cancelled' };
        const { createOpsNoticeTemplateApproval } = await import('@peaket/api-client/endpoints/ops');
        const headers = (token: string) => ({ 'If-Match': ifMatchOf(template.version), 'X-Reauth-Token': token });
        try {
          const r = await createOpsNoticeTemplateApproval(template.templateId, { headers: headers(first) });
          return { kind: 'done', value: r.data };
        } catch (e) {
          if (!isReauthRequired(e)) throw e;
          const second = await askReauth();
          if (!second) return { kind: 'cancelled' };
          const r = await createOpsNoticeTemplateApproval(template.templateId, { headers: headers(second) });
          return { kind: 'done', value: r.data };
        }
      });
    },

    createTemplate(draft) {
      const stop = blocked('create-template');
      if (stop) return Promise.resolve(stop);
      const body = templateCreateBody(draft);
      if (!body) return Promise.resolve({ kind: 'invalid', message: templateIssue(draft) ?? '템플릿 값을 확인해 주세요' });
      return once('create-template', async () => {
        const { createOpsNoticeTemplate } = await import('@peaket/api-client/endpoints/ops');
        const r = await createOpsNoticeTemplate(body, { headers: { 'Idempotency-Key': uuid() } });
        return { kind: 'done', value: r.data };
      });
    },

    updateTemplate(template, draft) {
      const stop = blocked('edit-template');
      if (stop) return Promise.resolve(stop);
      const body = templateUpdateBody(draft);
      if (!body) return Promise.resolve({ kind: 'invalid', message: templateIssue(draft) ?? '템플릿 값을 확인해 주세요' });
      return once(`update:${template.templateId}`, async () => {
        const { updateOpsNoticeTemplate } = await import('@peaket/api-client/endpoints/ops');
        const r = await updateOpsNoticeTemplate(template.templateId, body, { headers: { 'If-Match': ifMatchOf(template.version) } });
        return { kind: 'done', value: r.data };
      });
    },

    sendPartnerNotice(draft) {
      const stop = blocked('send-partner');
      if (stop) return Promise.resolve(stop);
      const body = partnerNoticeBody(draft);
      if (!body) return Promise.resolve({ kind: 'invalid', message: partnerIssue(draft) ?? '공지 값을 확인해 주세요' });
      return once('send-partner', async () => {
        const { createOpsPartnerNotice } = await import('@peaket/api-client/endpoints/ops');
        const r = await createOpsPartnerNotice(body, { headers: { 'Idempotency-Key': uuid() } });
        return { kind: 'done', value: r.data };
      });
    },

    publishHomeLayout(view, reason) {
      const stop = blocked('publish-home');
      if (stop) return Promise.resolve(stop);
      const body = homeLayoutInputOf(view, { reason });
      if (!body) return Promise.resolve({ kind: 'invalid', message: reason.trim() ? '저장할 수 없는 값이 있습니다. 표의 까닭을 확인해 주세요' : '게시 사유를 적어 주세요' });
      return once('publish-home', async () => {
        const { putOpsHomeLayout } = await import('@peaket/api-client/endpoints/ops');
        const r = await putOpsHomeLayout(body, { headers: { 'If-Match': ifMatchOf(view.version) } });
        return { kind: 'done', value: r.data };
      });
    },

    uploadBanner(file) {
      const stop = blocked('upload-banner');
      if (stop) return Promise.resolve(stop as ActionResult<{ imageId?: string; previewUrl?: string }>);
      const issue = bannerFileIssue(file);
      if (issue) return Promise.resolve({ kind: 'invalid', message: issue });
      return once<{ imageId?: string; previewUrl?: string }>('upload-banner', async () => {
        const { createOpsHomeLayoutBannerImage } = await import('@peaket/api-client/endpoints/ops');
        const r = await createOpsHomeLayoutBannerImage({ file }, { headers: { 'X-Requested-With': 'XMLHttpRequest' } });
        return { kind: 'done', value: r.data as unknown as { imageId?: string; previewUrl?: string } };
      });
    },
  };
}
