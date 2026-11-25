// SCR-068 연결 화면: 대기실 공지 템플릿·파트너 긴급 공지·홈 구성을 실제 계약 API로 읽고 쓴다(F-03-5, OPS-410).
// 역할은 서버(GET /v1/ops/auth/sessions/me)에서 읽는다. viewer는 홈 구성 보기만, 휴대폰은 세 탭 모두 보기만 한다.
// 서버(ops-svc)의 home-layout·notice-templates·partner-notices 모듈은 동결이라 아직 없다. 화면은 계약대로 부르고,
// 시험은 REST 경계를 대역으로 바꾼다(계획 '감독에게' 3). 재인증은 템플릿 승인(APPROVAL)에만 쓴다.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { ReauthDialog } from '@/features/admin-reauth/ReauthDialog';
import { ensureConsoleApi, opsApiAvailable } from '@/shared/api';
import { useGridColumns, useLayout } from '@/shared/lib/layout';
import { PhoneScopeCard } from '@/shared/ui/PhoneScopeCard';
import { homeLayoutView, type HomeLayoutView } from '../model/home-layout';
import { createNoticeActions } from '../model/notice-actions';
import {
  missingLanguages,
  noticeProblem,
  noticeTabs,
  type NoticeRole,
  type NoticeTab,
  type NoticeTexts,
  type PartnerDraft,
} from '../model/notices';
import { NoticeTabs } from './connected/NoticeTabs';
import { TemplateTable, type TemplateRow } from './connected/TemplateTable';
import { TemplateEditor, type TemplateDraft } from './connected/TemplateEditor';
import { PartnerNoticePanel, type PartnerRow } from './connected/PartnerNoticePanel';
import { HomeLayoutPanel } from './connected/HomeLayoutPanel';

type Load = { kind: 'loading' } | { kind: 'ready' } | { kind: 'error'; message: string } | { kind: 'config' };

const EMPTY_TEXTS: NoticeTexts = { ko: '', en: '', ja: '', zh: '' };
const NEW_TEMPLATE: TemplateDraft = { templateId: '', title: '', texts: EMPTY_TEXTS };
const NEW_PARTNER: PartnerDraft = { targetKind: 'ALL', phase: 'ONGOING', title: '', body: '', channels: ['CONSOLE_POPUP'] };

function roleTab(role: NoticeRole, asked: string | null): NoticeTab {
  const tabs = noticeTabs(role);
  return asked === 'templates' || asked === 'partner' || asked === 'home' ? (tabs.includes(asked) ? asked : tabs[0]!) : tabs[0]!;
}

export function ConnectedPage() {
  const layout = useLayout();
  const columns = useGridColumns();
  const [params, setParams] = useSearchParams();
  const [role, setRole] = useState<NoticeRole | null>(null);
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [ready, setReady] = useState(false);
  const tab = roleTab(role ?? 'viewer', params.get('tab'));
  const [templates, setTemplates] = useState<TemplateRow[]>([]);
  const [templateDraft, setTemplateDraft] = useState<TemplateDraft | null>(null);
  const [partnerHistory, setPartnerHistory] = useState<PartnerRow[]>([]);
  const [partnerDraft, setPartnerDraft] = useState<PartnerDraft>(NEW_PARTNER);
  const [homeView, setHomeView] = useState<HomeLayoutView | null>(null);
  const [homeReason, setHomeReason] = useState('');
  const [homeProblem, setHomeProblem] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reauthOpen, setReauthOpen] = useState(false);
  const reauthResolve = useRef<((token: string | null) => void) | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const approvedRef = useRef<string[]>([]);

  const notify = useCallback((text: string) => {
    clearTimeout(toastTimer.current);
    setToast(text);
    toastTimer.current = setTimeout(() => setToast(null), 5000);
  }, []);

  // 역할은 서버 세션에서. 읽지 못하면 viewer로 본다(서버가 권한을 막는다)
  useEffect(() => {
    if (!ensureConsoleApi()) {
      setLoad({ kind: 'config' });
      return;
    }
    let alive = true;
    void (async () => {
      try {
        const { getMyOpsAuthSession } = await import('@peaket/api-client/endpoints/ops');
        const r = await getMyOpsAuthSession();
        const got = (r.data as { role?: string }).role;
        if (alive) setRole(got === 'commander' || got === 'operator' ? got : 'viewer');
      } catch {
        if (alive) setRole('viewer');
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const askReauth = useCallback(
    () =>
      new Promise<string | null>((resolve) => {
        reauthResolve.current = resolve;
        setReauthOpen(true);
      }),
    [],
  );

  const actions = useMemo(() => (role ? createNoticeActions({ role, layout, reauth: askReauth }) : null), [role, layout, askReauth]);

  const loadHome = useCallback(async () => {
    const ops = await import('@peaket/api-client/endpoints/ops');
    const [layoutRes, saleRes] = await Promise.all([ops.getOpsHomeLayout(), ops.listOpsSaleReviews({ status: ['APPROVED'], limit: 100 })]);
    const approved = ((saleRes.data as { items?: { productionId: string }[] }).items ?? []).map((i) => i.productionId);
    approvedRef.current = approved;
    setHomeView(homeLayoutView(layoutRes.data, { nowMs: Date.now(), approvedProductionIds: approved }));
  }, []);

  const loadTab = useCallback(
    async (which: NoticeTab) => {
      if (which === 'templates') {
        const { listOpsNoticeTemplates } = await import('@peaket/api-client/endpoints/ops');
        const r = await listOpsNoticeTemplates({ limit: 100 });
        setTemplates((r.data as { items?: TemplateRow[] }).items ?? []);
      } else if (which === 'partner') {
        const { listOpsPartnerNotices } = await import('@peaket/api-client/endpoints/ops');
        const r = await listOpsPartnerNotices({ limit: 100 });
        setPartnerHistory(((r.data as { items?: PartnerRow[] }).items ?? []) as PartnerRow[]);
      } else {
        await loadHome();
      }
    },
    [loadHome],
  );

  useEffect(() => {
    if (!role) return;
    let alive = true;
    setLoad({ kind: 'loading' });
    setReady(false);
    void (async () => {
      try {
        await loadTab(tab);
        if (alive) {
          setLoad({ kind: 'ready' });
          setReady(true);
        }
      } catch (e) {
        const p = (typeof e === 'object' && e !== null ? e : {}) as { status?: number; type?: string };
        if (alive) setLoad({ kind: 'error', message: noticeProblem({ status: p.status ?? 0, ...(p.type ? { type: p.type } : {}) }) });
      }
    })();
    return () => {
      alive = false;
    };
  }, [role, tab, loadTab]);

  const changeTab = (next: NoticeTab) => {
    const sp = new URLSearchParams(params);
    sp.set('tab', next);
    setParams(sp, { replace: true });
    setError(null);
    setTemplateDraft(null);
  };

  const reloadTemplates = async () => {
    const { listOpsNoticeTemplates } = await import('@peaket/api-client/endpoints/ops');
    const r = await listOpsNoticeTemplates({ limit: 100 });
    setTemplates((r.data as { items?: TemplateRow[] }).items ?? []);
  };
  const reloadPartner = async () => {
    const { listOpsPartnerNotices } = await import('@peaket/api-client/endpoints/ops');
    const r = await listOpsPartnerNotices({ limit: 100 });
    setPartnerHistory(((r.data as { items?: PartnerRow[] }).items ?? []) as PartnerRow[]);
  };

  const saveTemplate = async () => {
    if (!actions || !templateDraft) return;
    setBusy(true);
    setError(null);
    const existing = templates.find((t) => t.templateId === templateDraft.templateId);
    const out = existing ? await actions.updateTemplate({ ...existing, version: existing.version ?? 1 }, templateDraft) : await actions.createTemplate(templateDraft);
    setBusy(false);
    if (out.kind === 'done') {
      setTemplateDraft(null);
      notify('저장했습니다. commander가 승인하면 운영 명령 7에서 고를 수 있습니다.');
      await reloadTemplates();
    } else if (out.kind === 'problem') {
      setError(out.message);
      if (out.status === 412) await reloadTemplates();
    } else if (out.kind === 'invalid' || out.kind === 'blocked') {
      setError('message' in out ? out.message : out.reason);
    }
  };

  const approveTemplate = async (row: TemplateRow) => {
    if (!actions) return;
    setBusy(true);
    setError(null);
    const out = await actions.approveTemplate({ ...row, version: row.version ?? 1 });
    setBusy(false);
    if (out.kind === 'done') {
      notify('승인했습니다. 이제 운영 명령 7에서 고를 수 있습니다.');
      await reloadTemplates();
    } else if (out.kind === 'problem') {
      setError(out.message);
      if (out.status === 412) await reloadTemplates();
    } else if (out.kind === 'invalid' || out.kind === 'blocked') {
      setError('message' in out ? out.message : out.reason);
    }
  };

  const sendPartner = async () => {
    if (!actions) return;
    setBusy(true);
    setError(null);
    const out = await actions.sendPartnerNotice(partnerDraft);
    setBusy(false);
    if (out.kind === 'done') {
      setPartnerDraft(NEW_PARTNER);
      notify('파트너 긴급 공지를 보냈습니다.');
      await reloadPartner();
    } else if (out.kind === 'problem') {
      setError(out.message);
    } else if (out.kind === 'invalid' || out.kind === 'blocked') {
      setError('message' in out ? out.message : out.reason);
    }
  };

  const publishHome = async () => {
    if (!actions || !homeView) return;
    setBusy(true);
    setHomeProblem(null);
    const out = await actions.publishHomeLayout(homeView, homeReason);
    setBusy(false);
    if (out.kind === 'done') {
      setHomeReason('');
      notify('홈에 게시했습니다. 1분 안에 반영됩니다 [가정].');
      const next = out.value as Parameters<typeof homeLayoutView>[0];
      if (next) setHomeView(homeLayoutView(next, { nowMs: Date.now(), approvedProductionIds: approvedRef.current }));
    } else if (out.kind === 'problem') {
      setHomeProblem(out.message);
      if (out.status === 412) {
        try {
          await loadHome();
        } catch {
          // 새로 읽기도 실패하면 화면은 지금 값을 그대로 둔다
        }
      }
    } else if (out.kind === 'invalid') {
      setHomeProblem(out.message);
    }
  };

  const uploadBanner = async (index: number, file: File) => {
    if (!actions || !homeView) return;
    setBusy(true);
    const out = await actions.uploadBanner(file);
    setBusy(false);
    if (out.kind === 'done') {
      const imageId = out.value?.imageId ?? '';
      setHomeView({ ...homeView, banners: homeView.banners.map((b, i) => (i === index ? { ...b, imageId } : b)) });
      notify('배너 이미지를 올렸습니다.');
    } else if (out.kind === 'problem' || out.kind === 'invalid') {
      setHomeProblem(out.message);
    }
  };

  if (load.kind === 'config' || !opsApiAvailable()) {
    return (
      <section className="widget" role="alert">
        <div className="widget-body t-sm">관제 API 주소가 설정되지 않아 공지 화면을 부를 수 없습니다. 빌드의 PEAKET_OPS_API_ORIGIN을 확인해 주세요.</div>
      </section>
    );
  }

  const tabs = role ? noticeTabs(role) : (['home'] as NoticeTab[]);
  const phone = layout === 'phone';

  return (
    <div className="col" style={{ gap: 16 }}>
      <div className="page-head">
        <div className="col" style={{ gap: 4 }}>
          <h1>공지 관리</h1>
          <p className="t-sm muted">
            대기실 공지는 승인된 템플릿만 운영 명령 7로 띄웁니다. 파트너 긴급 공지는 파트너 콘솔 팝업과 이메일로 보냅니다.
          </p>
        </div>
      </div>
      <NoticeTabs tabs={tabs} active={tab} onChange={changeTab} />
      {error ? (
        <p className="hint" role="alert">
          {error}
        </p>
      ) : null}
      {toast ? (
        <div className="banner banner-info" role="status">
          {toast}
        </div>
      ) : null}
      {load.kind === 'loading' && !ready ? <p className="muted">불러오는 중…</p> : null}
      {load.kind === 'error' ? (
        <div className="banner banner-warning" role="alert">
          {load.message}
        </div>
      ) : null}

      {tab === 'templates' ? (
        <div className="col" style={{ gap: 16 }} role="tabpanel" id="np-templates" aria-labelledby="nt-templates">
          {phone ? <PhoneScopeCard title="템플릿 작성·승인" /> : null}
          <div className="grid-12" style={{ rowGap: 16, alignItems: 'start' }}>
            <div className="span-7">
              <TemplateTable
                role={phone ? 'viewer' : (role ?? 'viewer')}
                items={templates}
                onEdit={(row) => setTemplateDraft({ templateId: row.templateId, title: row.title, texts: { ...EMPTY_TEXTS, ...row.texts } })}
                onNew={() => setTemplateDraft({ ...NEW_TEMPLATE, texts: { ...EMPTY_TEXTS } })}
                onApprove={(row) => void approveTemplate(row)}
                busy={busy}
              />
            </div>
            <div className="span-5">
              {templateDraft && !phone ? (
                <TemplateEditor
                  role={role ?? 'viewer'}
                  layout={layout}
                  draft={templateDraft}
                  onChange={setTemplateDraft}
                  onSave={() => void saveTemplate()}
                  onClose={() => setTemplateDraft(null)}
                  busy={busy}
                />
              ) : null}
            </div>
          </div>
          {templateDraft && !phone && missingLanguages(templateDraft.texts).length ? (
            <p className="hint">네 언어(ko·en·ja·zh)가 모두 있어야 commander가 승인할 수 있습니다.</p>
          ) : null}
        </div>
      ) : null}

      {tab === 'partner' ? (
        <div role="tabpanel" id="np-partner" aria-labelledby="nt-partner">
          <PartnerNoticePanel
            role={role ?? 'viewer'}
            layout={layout}
            draft={partnerDraft}
            onChange={setPartnerDraft}
            onSend={() => void sendPartner()}
            history={partnerHistory}
            busy={busy}
            error={error}
          />
        </div>
      ) : null}

      {tab === 'home' ? (
        <div role="tabpanel" id="np-home" aria-labelledby="nt-home">
          {homeView ? (
            <HomeLayoutPanel
              role={role ?? 'viewer'}
              layout={layout}
              columns={columns}
              view={homeView}
              reason={homeReason}
              onChange={setHomeView}
              onReason={setHomeReason}
              onPublish={() => void publishHome()}
              onUpload={(index, file) => void uploadBanner(index, file)}
              onReload={() => void loadHome()}
              busy={busy}
              problem={homeProblem}
            />
          ) : (
            <p className="muted">홈 구성을 불러오는 중…</p>
          )}
        </div>
      ) : null}

      <ReauthDialog
        open={reauthOpen}
        act="APPROVAL"
        title="템플릿을 승인합니다"
        description="승인하면 운영 명령 7에서 이 템플릿을 고를 수 있습니다. 비밀번호와 인증 앱의 6자리 코드를 넣고, 이어서 뜨는 패스키 창에서 확인해 주세요."
        onDone={(token) => {
          reauthResolve.current?.(token);
          reauthResolve.current = null;
          setReauthOpen(false);
        }}
        onClose={() => {
          reauthResolve.current?.(null);
          reauthResolve.current = null;
          setReauthOpen(false);
        }}
      />
    </div>
  );
}
