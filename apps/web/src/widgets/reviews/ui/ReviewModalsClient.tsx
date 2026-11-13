'use client';
// SCR-016 후기 모달들(보드 SCR-016-m·t·d, d5 §5.16, d3 SCR-016 행). 공연 상세 위에서 열리고, 한 번에 창 하나만 보인다.
// - 후기 전체 모달(사진 보기는 같은 창 안에서 바뀐다) → [신고]는 같은 자리를 신고 모달로, [신고 보내기]는 신고 모달 자리를 확인 모달로 바꾼다.
// - 후기 쓰기 모달(이미 쓴 회차·내 후기 [수정]은 '후기 고치기'), 자격 없음·로그인 안내·신고 로그인 안내는 작은 대화상자(휴대폰은 아래 시트).
// - 휴대폰은 전체 화면 창, 태블릿·데스크톱은 가운데 대화상자(ds ReportDialog의 ModalFrame).
// - 주소: 창을 바꾸면 history.pushState로 ?reviews=all·?report=·?review=new 등을 남기고(뒤로 가기로 돌아간다), 닫으면 router.replace로 지운다.
// - 초점: 처음 연 버튼을 기억했다가 모두 닫으면 돌려주고, 신고·사진 보기에서 목록으로 돌아오면 누른 버튼으로 돌린다.
// - 입력(신고 내용·후기 글)은 화면에만 두고 브라우저 저장소에 남기지 않는다.
// - 목록·요약·쓰기·고치기·지우기·신고는 core-svc 후기 API에 연결한다. 사진 올리기는 DS가 파일을 넘기지 않아 다음 배치다(본문만 보낸다).
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ImageUploader, type ImageUploaderItem } from '@peaket/ds/ImageUploader';
import { FormErrorSummary } from '@peaket/ds/FormErrorSummary';
import { Rating } from '@peaket/ds/Rating';
import {
  EMPTY_REPORT_DRAFT,
  ModalFrame,
  ReportConfirmDialog,
  ReportDialog,
  SCALPING_REPORT_CENTER_URL,
  validateReport,
  type ReportAlert,
  type ReportDraft,
  type ReportFieldError,
  type ReportTarget,
} from '@peaket/ds/ReportDialog';
import { Select } from '@peaket/ds/Select';
import { TextArea } from '@peaket/ds/TextArea';
import { WebShellModal, webModalButtonClass } from '@peaket/ds/WebShell';
import { ApiError } from '@peaket/api-client';
import {
  BANNED_PHRASES,
  MY_MASKED_EMAIL,
  REVIEW_SORT_LABEL,
  mapReview,
  mapReviewPage,
  mapReviewSummary,
  reviewSortParam,
  reviewTargetOf,
  sortReviewItems,
  type Review,
  type ReviewItem,
  type ReviewSort,
} from '@/entities/review';
import { ensureBrowserApi, withFanRefresh } from '@/shared/api';
import type { Scr016State } from '@/shared/config/screens.discovery';
import { cx } from '@/shared/lib/cx';
import { useToast } from '@/shared/ui/toast';
import { ReviewModerationActions } from './ReviewModerationActions';
import { closedSearch, resolveReviewModal, reviewModalSearch, type ReviewModalInit, type ReviewModalKind } from '../model/view';

export interface ReviewModalsClientProps {
  init: ReviewModalInit;
  /** '/events/evt-lumen-1025' */
  path: string;
  theme?: string;
  guest: boolean;
  /** 공연명(쓰기 모달 머리) */
  title: string;
  /** 이 공연에서 후기를 쓸 수 있는 회차(둘 이상이면 고르기) */
  rounds: readonly { value: string; label: string }[];
  /** 지금 회차 ID(후기 API의 경로 값) */
  currentRound: string;
  loginHref: string;
  /** 관제 운영자 조치를 함께 보일지(운영자 화면에서만 참) */
  moderator?: boolean;
}

interface View {
  kind: ReviewModalKind;
  reviewId: string;
  photo: number;
  from: 'list' | 'detail';
}

type WriteMode = 'new' | 'edit';

interface WritePreset {
  mode: WriteMode;
  rating: number;
  text: string;
  photos: readonly ImageUploaderItem[];
  /** 미리보기 '입력 오류'·'금칙어 오류'처럼 처음부터 검사 결과를 보인다 */
  validate: boolean;
  /** 미리보기 '이미 씀' 배너 */
  already: boolean;
}

const WRITE_TEXT = '무대 연출과 음향이 좋았습니다. 입장 줄이 길었지만 안내가 잘 되어 있어 금방 들어갔습니다.';
const PHOTO_READY: readonly ImageUploaderItem[] = [
  { id: 'rw-p1', status: 'ready', caption: '[예시] 공연장 입구 안내판' },
  { id: 'rw-p2', status: 'ready', caption: '' },
];

function writePresetFor(preview: Scr016State | null, editing?: Review): WritePreset {
  if (editing) return { mode: 'edit', rating: editing.stars, text: editing.body, photos: [], validate: false, already: false };
  switch (preview) {
    case '후기 쓰기(사진)':
      return { mode: 'new', rating: 4, text: WRITE_TEXT, photos: [...PHOTO_READY, { id: 'rw-p3', status: 'uploading', progress: 64 }], validate: false, already: false };
    case '사진 확인 중':
      return { mode: 'new', rating: 4, text: WRITE_TEXT, photos: [...PHOTO_READY, { id: 'rw-p3', status: 'scanning' }], validate: false, already: false };
    case '사진 오류':
      return {
        mode: 'new',
        rating: 4,
        text: WRITE_TEXT,
        photos: [...PHOTO_READY, { id: 'rw-p3', status: 'error', error: '한 장에 10MB까지 올릴 수 있습니다' }],
        validate: false,
        already: false,
      };
    case '입력 오류':
      return { mode: 'new', rating: 0, text: '좋았어요', photos: [], validate: true, already: false };
    case '금칙어 오류':
      return { mode: 'new', rating: 4, text: '매크로 대행으로 좋은 자리 구해 드립니다', photos: [], validate: true, already: false };
    case '이미 씀':
      // 실제 '이미 씀'은 자격 확인이 myReviewId를 받아 고치기로 연다. 미리보기에서는 빈 고치기 모양만 보인다.
      return { mode: 'edit', rating: 5, text: '', photos: [], validate: false, already: true };
    default:
      return { mode: 'new', rating: 0, text: '', photos: [], validate: false, already: false };
  }
}

function reportPresetFor(preview: Scr016State | null): { draft: ReportDraft; errors: ReportFieldError[]; alert: ReportAlert | null } {
  switch (preview) {
    case '신고 · 권리 침해':
      return { draft: { ...EMPTY_REPORT_DRAFT, reason: 'RIGHTS', rightsHolder: 'yes' }, errors: [], alert: null };
    case '신고 · 불법 촬영물':
      return { draft: { ...EMPTY_REPORT_DRAFT, reason: 'ILLEGAL_FILMING' }, errors: [], alert: null };
    case '신고 입력 오류':
      return { draft: EMPTY_REPORT_DRAFT, errors: ['reason'], alert: null };
    case '신고 전송 실패':
      return { draft: { ...EMPTY_REPORT_DRAFT, reason: 'SCALPING' }, errors: [], alert: 'failed' };
    case '신고 한도':
      return { draft: { ...EMPTY_REPORT_DRAFT, reason: 'SCALPING' }, errors: [], alert: 'limited' };
    case '신고 대상 없음':
      return { draft: { ...EMPTY_REPORT_DRAFT, reason: 'SCALPING' }, errors: [], alert: 'gone' };
    case '신고':
    case '신고기관 바로가기':
    case '복사 실패':
    case '신고 확인':
    case '신고 보내는 중':
      return { draft: { ...EMPTY_REPORT_DRAFT, reason: 'SCALPING' }, errors: [], alert: null };
    default:
      return { draft: EMPTY_REPORT_DRAFT, errors: [], alert: null };
  }
}

interface LocalToast {
  id: number;
  icon: string;
  text: string;
  mono?: string;
}

type ListState =
  | { kind: 'loading' }
  | { kind: 'ready'; items: ReviewItem[]; nextCursor: string | null }
  | { kind: 'error'; message: string }
  | { kind: 'off' }
  | { kind: 'login' };

interface SummaryState {
  average: number | null;
  count: number;
  loading: boolean;
}

interface WriteResult {
  ok: boolean;
  errors?: WriteErrors;
}

/** API 오류를 화면 문구로. 서버 title은 보이지 않는다(docs/frontend.md §4.1) */
function listProblem(e: unknown): ListState {
  if (e instanceof ApiError) {
    if (e.status === 503) return { kind: 'off' };
    if (e.status === 401) return { kind: 'login' };
    if (e.status === 404) return { kind: 'error', message: '후기를 볼 수 있는 공연을 찾지 못했습니다.' };
    return { kind: 'error', message: '후기 목록을 불러오지 못했습니다. 잠시 뒤 다시 시도해 주세요.' };
  }
  return { kind: 'error', message: '후기 목록을 불러오지 못했습니다. 잠시 뒤 다시 시도해 주세요.' };
}

/** 휴대폰 목록 카드의 [신고]·[수정] 줄은 왼쪽 여백을 버튼 안 여백만큼 당긴다(보드 margin-left:-12px). 데스크톱은 오른쪽 열 */
const ACTION_ROW = '-ml-3 lg:ml-0';

export function ReviewModalsClient({ init, path, theme, guest, title, rounds, currentRound, loginHref, moderator = false }: ReviewModalsClientProps) {
  const router = useRouter();
  const shellToast = useToast();
  const preview = init.preview;
  const eventId = currentRound;
  const [open, setOpen] = useState(true);
  const [view, setView] = useState<View>({ kind: init.kind, reviewId: init.reviewId, photo: init.photo, from: init.from });

  const reportPreset = useMemo(() => reportPresetFor(preview), [preview]);
  const [draft, setDraft] = useState<ReportDraft>(reportPreset.draft);
  const [reportErrors, setReportErrors] = useState<ReportFieldError[]>(reportPreset.errors);
  const [errorKey, setErrorKey] = useState(0);
  const [alert, setAlert] = useState<ReportAlert | null>(reportPreset.alert);
  const [busy, setBusy] = useState(false);
  const [list, setList] = useState<ListState>({ kind: 'loading' });
  const [summary, setSummary] = useState<SummaryState>({ average: null, count: 0, loading: true });
  const [reloadKey, setReloadKey] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [reported, setReported] = useState<ReadonlySet<string>>(() => new Set(preview === '신고 접수 완료' ? [init.reviewId] : []));
  const [removed, setRemoved] = useState<ReadonlySet<string>>(() => new Set());
  const [askDelete, setAskDelete] = useState<string | null>(null);
  const [sort, setSort] = useState<ReviewSort>('latest');
  const [editing, setEditing] = useState<Review | undefined>(undefined);
  const [writeFrom, setWriteFrom] = useState<'list' | 'detail'>('detail');
  const [writeKey, setWriteKey] = useState(0);
  const [writeCheck, setWriteCheck] = useState<'checking' | 'ready' | 'noRight' | 'login'>(init.kind === 'write' ? 'checking' : 'ready');
  const [toast, setToast] = useState<LocalToast | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const opener = useRef<HTMLElement | null>(null);
  const focusNext = useRef<string | null>(null);

  const postUrl = useCallback(
    (id: string) => `${typeof window === 'undefined' ? '' : window.location.origin}${path}?reviews=all&review=${encodeURIComponent(id)}`,
    [path],
  );

  const showLocalToast = useCallback((t: Omit<LocalToast, 'id'>, persistent = false) => {
    clearTimeout(toastTimer.current);
    setToast({ ...t, id: Date.now() });
    if (!persistent) toastTimer.current = setTimeout(() => setToast(null), 5000);
  }, []);

  const items = useMemo(() => (list.kind === 'ready' ? list.items.filter((r) => !removed.has(r.id)) : []), [list, removed]);
  const targetItem = items.find((r): r is Review => r.kind === 'review' && r.id === view.reviewId);
  const target: ReportTarget = targetItem ? reviewTargetOf(targetItem) : { author: '', watched: '', postId: view.reviewId, excerpt: '' };

  // 목록·요약은 실제 core-svc API에서 받는다. 게스트도 읽을 수 있고, 401이면 로그인 안내로 바꾼다.
  useEffect(() => {
    let live = true;
    setList({ kind: 'loading' });
    setSummary((s) => ({ ...s, loading: true }));
    void (async () => {
      try {
        const [{ listEventReviews, getEventReviewSummary }] = await Promise.all([import('@peaket/api-client/endpoints/reviews')]);
        if (!ensureBrowserApi()) {
          if (live) setList({ kind: 'error', message: '후기 API 주소가 설정되지 않았습니다.' });
          return;
        }
        const [page, sum] = await Promise.all([
          withFanRefresh(() => listEventReviews(eventId, { sort: reviewSortParam(sort), limit: 10 })),
          withFanRefresh(() => getEventReviewSummary(eventId)),
        ]);
        if (!live) return;
        setList({ kind: 'ready', ...mapReviewPage(page.data) });
        setSummary({ ...mapReviewSummary(sum.data), loading: false });
      } catch (e) {
        if (!live) return;
        setList(listProblem(e));
        setSummary((s) => ({ ...s, loading: false }));
      }
    })();
    return () => {
      live = false;
    };
  }, [eventId, sort, reloadKey]);

  // 서버가 이미 신고한 후기라고 하면 [신고함]으로 그린다
  useEffect(() => {
    if (list.kind !== 'ready') return;
    const ids = list.items.filter((r): r is Review => r.kind === 'review' && r.reportedByMe === true).map((r) => r.id);
    if (ids.length) setReported((prev) => new Set([...prev, ...ids]));
  }, [list]);

  // 주소로 연 신고 대상이 목록에 없으면 '지워졌거나 가려진 후기' 안내를 보인다
  useEffect(() => {
    if (view.kind === 'report' && list.kind === 'ready' && !targetItem) setAlert('gone');
  }, [view.kind, list, targetItem]);

  // 처음 연 버튼을 기억한다(모두 닫으면 돌려준다). 미리보기 상태의 토스트는 보드처럼 떠 있게 둔다
  useEffect(() => {
    const active = document.activeElement;
    opener.current = active instanceof HTMLElement && active !== document.body ? active : null;
    if (preview === '신고 접수 완료') showLocalToast({ icon: 'ic-check', text: '신고를 접수했습니다. 검토 결과는 알림으로 알려 드립니다.' }, true);
    if (preview === '신고기관 바로가기') showLocalToast({ icon: 'ic-check', text: '게시물 주소를 복사했습니다. 신고서에 붙여 넣어 주세요' }, true);
    if (preview === '복사 실패') showLocalToast({ icon: 'ic-alert', text: '신고서에 이 주소를 적어 주세요: ', mono: postUrl(init.reviewId) }, true);
    return () => {
      clearTimeout(toastTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 쓰기 모달은 열기 전에 자격을 확인한다. 이미 쓴 회차면 그 후기를 받아 고치기로 바꾼다.
  useEffect(() => {
    if (view.kind !== 'write') return;
    if (guest) {
      setView((v) => ({ ...v, kind: 'login' }));
      return;
    }
    let live = true;
    setWriteCheck('checking');
    void (async () => {
      try {
        const [{ getEventReviewEligibility, getReview }] = await Promise.all([import('@peaket/api-client/endpoints/reviews')]);
        if (!ensureBrowserApi()) {
          if (live) setWriteCheck('noRight');
          return;
        }
        const r = await withFanRefresh(() => getEventReviewEligibility(eventId));
        if (!live) return;
        if (r.data.eligible) {
          setWriteCheck('ready');
          return;
        }
        if (r.data.reason === 'ALREADY_WRITTEN' && r.data.myReviewId) {
          const mine = await withFanRefresh(() => getReview(r.data.myReviewId!));
          const mapped = mapReview(mine.data);
          if (live && mapped?.kind === 'review' && !mapped.restricted) {
            setEditing(mapped);
            setWriteKey((k) => k + 1);
            setWriteCheck('ready');
            return;
          }
        }
        if (live) setWriteCheck('noRight');
      } catch (e) {
        if (!live) return;
        setWriteCheck(e instanceof ApiError && e.status === 401 ? 'login' : 'noRight');
      }
    })();
    return () => {
      live = false;
    };
  }, [view.kind, eventId, guest]);

  // 뒤로·앞으로 가기: 주소에서 다시 정한다
  useEffect(() => {
    const onPop = () => {
      const next = resolveReviewModal(new URLSearchParams(window.location.search), guest);
      if (!next) {
        setOpen(false);
        return;
      }
      setOpen(true);
      setView({ kind: next.kind, reviewId: next.reviewId, photo: next.photo, from: next.from });
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [guest]);

  // 창을 바꾼 뒤 돌아갈 버튼으로 초점(창 틀이 제목으로 옮긴 다음에 돈다)
  useEffect(() => {
    const id = focusNext.current;
    if (!id) return;
    focusNext.current = null;
    document.getElementById(id)?.focus({ preventScroll: false });
  }, [view]);

  const go = (next: View, focusId?: string) => {
    focusNext.current = focusId ?? null;
    setView(next);
    const search = reviewModalSearch(next, theme);
    if (`${window.location.pathname}${window.location.search}` !== `${path}${search}`) window.history.pushState(null, '', `${path}${search}`);
  };

  const closeAll = (after?: { text: string; icon?: string }) => {
    setOpen(false);
    router.replace(`${path}${closedSearch(theme)}`, { scroll: false });
    const el = opener.current;
    requestAnimationFrame(() => {
      if (el && document.contains(el)) el.focus({ preventScroll: true });
    });
    if (after) shellToast(after.text, after.icon);
  };

  const backToList = (focusId?: string) => go({ ...view, kind: 'list', from: 'list' }, focusId);

  const loadMore = async () => {
    if (list.kind !== 'ready' || !list.nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const [{ listEventReviews }] = await Promise.all([import('@peaket/api-client/endpoints/reviews')]);
      const page = mapReviewPage((await withFanRefresh(() => listEventReviews(eventId, { sort: reviewSortParam(sort), cursor: list.nextCursor!, limit: 10 }))).data);
      setList({ kind: 'ready', items: [...list.items, ...page.items], nextCursor: page.nextCursor });
    } catch {
      showLocalToast({ icon: 'ic-alert', text: '후기를 더 불러오지 못했습니다. 잠시 뒤 다시 시도해 주세요.' });
    } finally {
      setLoadingMore(false);
    }
  };

  const deleteReview = async (id: string) => {
    try {
      const [{ deleteReview }] = await Promise.all([import('@peaket/api-client/endpoints/reviews')]);
      await withFanRefresh(() => deleteReview(id));
      setRemoved((prev) => new Set(prev).add(id));
      setAskDelete(null);
      showLocalToast({ icon: 'ic-check', text: '후기를 지웠습니다' });
      setReloadKey((k) => k + 1);
    } catch (e) {
      setAskDelete(null);
      showLocalToast({ icon: 'ic-alert', text: e instanceof ApiError && e.status === 403 ? '내 후기만 지울 수 있습니다' : '후기를 지우지 못했습니다. 잠시 뒤 다시 시도해 주세요.' });
    }
  };

  const submitWrite = async (rating: number, body: string): Promise<WriteResult> => {
    try {
      const [{ createEventReview, updateReview }] = await Promise.all([import('@peaket/api-client/endpoints/reviews')]);
      if (editing) {
        await withFanRefresh(() => updateReview(editing.id, { rating, body }));
      } else {
        await withFanRefresh(() =>
          createEventReview(eventId, { rating, body }, { headers: { 'Idempotency-Key': crypto.randomUUID() } }),
        );
      }
      setReloadKey((k) => k + 1);
      const text = editing ? '후기를 고쳤습니다' : '후기를 등록했습니다';
      if (writeFrom === 'list') {
        setEditing(undefined);
        backToList();
        showLocalToast({ icon: 'ic-check', text });
      } else {
        closeAll({ text, icon: 'ic-check' });
      }
      return { ok: true };
    } catch (e) {
      if (e instanceof ApiError) {
        if (e.status === 401) {
          setView((v) => ({ ...v, kind: 'login' }));
          return { ok: false };
        }
        if (e.status === 403) {
          setView((v) => ({ ...v, kind: 'noRight' }));
          return { ok: false };
        }
        if (e.status === 409) return { ok: false, errors: { server: '이 회차의 후기를 이미 썼습니다. 목록에서 고쳐 주세요.' } };
        if (e.status === 422) return { ok: false, errors: { server: '입력 내용을 확인해 주세요.' } };
        if (e.status === 503) return { ok: false, errors: { server: '지금은 후기를 쓸 수 없습니다.' } };
      }
      return { ok: false, errors: { server: '후기를 보내지 못했습니다. 잠시 뒤 다시 시도해 주세요.' } };
    }
  };

  const openReport = (id: string) => {
    if (guest) {
      go({ ...view, kind: 'reportLogin', reviewId: id, from: 'list' });
      return;
    }
    setDraft(EMPTY_REPORT_DRAFT);
    setReportErrors([]);
    setAlert(list.kind === 'ready' && !items.some((r) => r.id === id) ? 'gone' : null);
    go({ ...view, kind: 'report', reviewId: id, from: 'list' });
  };

  const changeDraft = (next: ReportDraft) => {
    setDraft(next);
    // 이미 보인 오류는 고치면 바로 지운다(새 오류는 다시 보낼 때 보인다)
    setReportErrors((prev) => (prev.length ? validateReport(next).filter((e) => prev.includes(e)) : prev));
  };

  const submitReport = () => {
    const errs = validateReport(draft);
    if (errs.length) {
      setReportErrors(errs);
      setErrorKey((k) => k + 1);
      return;
    }
    setReportErrors([]);
    setView({ ...view, kind: 'confirm' });
  };

  const confirmReport = async () => {
    if (busy || !draft.reason) return;
    setBusy(true);
    try {
      const [{ createReviewReport }] = await Promise.all([import('@peaket/api-client/endpoints/reviews')]);
      await withFanRefresh(() =>
        createReviewReport(view.reviewId, {
          category: draft.reason!,
          ...(draft.detail.trim() ? { detail: draft.detail.trim() } : {}),
          ...(draft.reason === 'RIGHTS' ? { rightsHolder: draft.rightsHolder === 'yes' } : {}),
          ...(draft.reason === 'RIGHTS' && draft.rightsHolder === 'yes' && draft.notify ? { notifyChannel: draft.notify } : {}),
        }),
      );
      setReported((prev) => new Set(prev).add(view.reviewId));
      setDraft(EMPTY_REPORT_DRAFT);
      const done = '신고를 접수했습니다. 검토 결과는 알림으로 알려 드립니다.';
      if (view.from === 'list') {
        backToList(`rv-rp-${view.reviewId}`);
        showLocalToast({ icon: 'ic-check', text: done });
      } else {
        closeAll({ text: done, icon: 'ic-check' });
      }
    } catch (e) {
      if (e instanceof ApiError) {
        if (e.status === 429) {
          setAlert('limited');
          setView((v) => ({ ...v, kind: 'report' }));
        } else if (e.status === 404) {
          setAlert('gone');
          setView((v) => ({ ...v, kind: 'report' }));
        } else if (e.status === 409) {
          setReported((prev) => new Set(prev).add(view.reviewId));
          setAlert(null);
          showLocalToast({ icon: 'ic-check', text: '이미 신고한 후기입니다' });
          backToList(`rv-rp-${view.reviewId}`);
        } else {
          setAlert('failed');
          setView((v) => ({ ...v, kind: 'report' }));
        }
      } else {
        setAlert('failed');
        setView((v) => ({ ...v, kind: 'report' }));
      }
    } finally {
      setBusy(false);
    }
  };

  const onOutbound = () => {
    const url = postUrl(view.reviewId);
    const fail = () => showLocalToast({ icon: 'ic-alert', text: '신고서에 이 주소를 적어 주세요: ', mono: url });
    if (!navigator.clipboard) {
      fail();
      return;
    }
    navigator.clipboard.writeText(url).then(
      () => showLocalToast({ icon: 'ic-check', text: '게시물 주소를 복사했습니다. 신고서에 붙여 넣어 주세요' }),
      fail,
    );
  };

  const emptyList = preview === '빈 화면' || (list.kind === 'ready' && items.length === 0);
  const loadingList = preview === '목록 불러오는 중' || list.kind === 'loading';
  const errorList = list.kind === 'error' ? list.message : null;
  const offList = list.kind === 'off';
  const loginList = list.kind === 'login';
  const shownItems = sort === 'latest' ? items : sortReviewItems(items, sort);

  if (!open) return null;

  return (
    <>
      {view.kind === 'list' || view.kind === 'photo' ? (
        <ModalFrame
          open
          onClose={() => closeAll()}
          title="후기"
          closeLabel="후기 닫기"
          layout="list"
          maxWidth={640}
          maxWidthLg={720}
          height={820}
          heightLg={640}
          restoreFocus={false}
          header={view.kind === 'list' && !loadingList && items.length > 0 ? <ListHeader sort={sort} onSort={setSort} average={summary.average} count={summary.count} loading={summary.loading} /> : undefined}
        >
          {view.kind === 'photo' ? (
            <PhotoView
              review={targetItem}
              index={view.photo}
              onIndex={(n) => {
                setView({ ...view, photo: n });
                window.history.replaceState(null, '', `${path}${reviewModalSearch({ ...view, photo: n }, theme)}`);
              }}
              onBack={() => backToList(`rv-ph-${view.reviewId}-${view.photo}`)}
            />
          ) : offList ? (
            <div className="state py-16 md:py-24" role="status">
              <span className="state-icon"><i className="ic ic-eye-off" aria-hidden="true" /></span>
              <p className="t-lg">지금은 후기를 볼 수 없습니다</p>
            </div>
          ) : loginList ? (
            <div className="state py-16 md:py-24" role="status">
              <p className="t-lg">로그인하면 후기를 볼 수 있습니다</p>
              <a className="btn btn-primary btn-lg" href={loginHref}>로그인</a>
            </div>
          ) : errorList ? (
            <div className="state py-16 md:py-24" role="alert">
              <p className="t-lg">{errorList}</p>
              <button className="btn btn-secondary btn-lg" type="button" onClick={() => setReloadKey((k) => k + 1)}>다시 불러오기</button>
            </div>
          ) : loadingList ? (
            <ul className="col" style={{ gap: 12 }} aria-busy="true" aria-label="후기 목록">
              <li className="sr-only">후기를 불러오는 중</li>
              {[0, 1, 2].map((k) => (
                <li key={k} className="card col" style={{ padding: 16, gap: 8 }} aria-hidden="true">
                  <span className="skel" style={{ height: 16, width: 180 }} />
                  <span className="skel" style={{ height: 16, width: 120 }} />
                  <span className="skel" style={{ height: 40, width: '100%' }} />
                </li>
              ))}
            </ul>
          ) : shownItems.length === 0 ? (
            <div className="state py-16 md:py-24">
              <span className="state-icon">
                <i className="ic ic-star" aria-hidden="true" />
              </span>
              <p className="t-lg">아직 후기가 없습니다</p>
            </div>
          ) : (
            <>
              <ul className="col" style={{ gap: 12 }} aria-label="후기 목록">
                {shownItems.map((it) => (
                  <li key={it.id}>
                    <ReviewCard
                      item={it}
                      reported={reported.has(it.id) || (it.kind === 'review' && it.reportedByMe === true)}
                      askDelete={askDelete === it.id}
                      onPhoto={(n) => go({ ...view, kind: 'photo', reviewId: it.id, photo: n }, 'rv-photo-view')}
                      onReport={() => openReport(it.id)}
                      onEdit={() => {
                        if (it.kind !== 'review') return;
                        setEditing(it);
                        setWriteFrom('list');
                        setWriteKey((k) => k + 1);
                        focusNext.current = null;
                        setView({ ...view, kind: 'write' });
                      }}
                      onAskDelete={(ask) => setAskDelete(ask ? it.id : null)}
                      onDelete={() => void deleteReview(it.id)}
                      moderator={moderator}
                      onModerated={(text) => {
                        showLocalToast({ icon: 'ic-check', text });
                        setReloadKey((k) => k + 1);
                      }}
                    />
                  </li>
                ))}
              </ul>
              {list.kind === 'ready' && list.nextCursor ? (
                <button className="btn btn-secondary btn-lg btn-block md:w-auto md:min-w-[240px] md:self-center" type="button" onClick={() => void loadMore()} disabled={loadingMore} aria-busy={loadingMore}>
                  {loadingMore ? '불러오는 중…' : '더 보기'}
                </button>
              ) : null}
            </>
          )}
        </ModalFrame>
      ) : null}

      <ReportDialog
        open={view.kind === 'report'}
        onClose={() => (view.from === 'list' ? backToList(`rv-rp-${view.reviewId}`) : closeAll())}
        target={target}
        draft={draft}
        onDraftChange={changeDraft}
        errors={reportErrors}
        focusError={reportErrors.length > 0}
        errorKey={errorKey}
        alert={alert}
        maskedEmail={MY_MASKED_EMAIL}
        onOutbound={onOutbound}
        onSubmit={submitReport}
        restoreFocus={false}
      />

      <ReportConfirmDialog
        open={view.kind === 'confirm'}
        onBack={() => {
          setView({ ...view, kind: 'report' });
        }}
        onConfirm={confirmReport}
        busy={busy}
        target={target}
        draft={draft}
        restoreFocus={false}
      />

      {view.kind === 'write' && writeCheck === 'checking' ? (
        <ModalFrame open onClose={() => closeAll()} title="후기 쓰기" closeLabel="후기 쓰기 닫기" layout="form" maxWidth={560} maxWidthLg={600} restoreFocus={false}>
          <p className="t-sm muted" role="status" aria-busy="true">후기를 쓸 수 있는지 확인하는 중입니다…</p>
        </ModalFrame>
      ) : view.kind === 'write' && writeCheck === 'ready' ? (
        <WriteModal
          key={writeKey}
          preset={writePresetFor(editing ? null : preview, editing)}
          title={title}
          rounds={rounds}
          currentRound={currentRound}
          onClose={() => {
            if (writeFrom === 'list') {
              setEditing(undefined);
              backToList(editing ? `rv-ed-${editing.id}` : undefined);
            } else closeAll();
          }}
          onSubmit={submitWrite}
        />
      ) : null}

      <WebShellModal
        open={view.kind === 'noRight' || (view.kind === 'write' && writeCheck === 'noRight')}
        onClose={() => closeAll()}
        title="공연이 끝난 뒤 이 회차를 예매하신 분만 후기를 쓸 수 있습니다"
        icon={<i className="ic ic-edit" aria-hidden="true" />}
        actions={
          <button className={webModalButtonClass('primary')} type="button" onClick={() => closeAll()}>
            닫기
          </button>
        }
      />
      <WebShellModal
        open={view.kind === 'login' || view.kind === 'reportLogin' || (view.kind === 'write' && writeCheck === 'login')}
        onClose={() => closeAll()}
        title={view.kind === 'login' || (view.kind === 'write' && writeCheck === 'login') ? '로그인하면 후기를 쓸 수 있습니다' : '로그인하면 신고할 수 있습니다'}
        icon={<i className="ic ic-user" aria-hidden="true" />}
        iconTone="primary"
        actions={
          <>
            <a className={webModalButtonClass('primary')} href={loginHref}>
              로그인
            </a>
            <button className={webModalButtonClass('ghost')} type="button" onClick={() => closeAll()}>
              닫기
            </button>
          </>
        }
      />
      {/* 기능 꺼짐(운영 명령 9): 모달 대신 안내만 보인다(추천안: d5는 섹션 자리 문구만 정해, 주소로 모달을 열면 같은 문구의 대화상자로 둔다) */}
      <WebShellModal
        open={view.kind === 'off'}
        onClose={() => closeAll()}
        title="지금은 후기를 볼 수 없습니다"
        icon={<i className="ic ic-eye-off" aria-hidden="true" />}
        actions={
          <button className={webModalButtonClass('primary')} type="button" onClick={() => closeAll()}>
            닫기
          </button>
        }
      />

      <div className="pointer-events-none fixed inset-x-0 bottom-6 z-[101] flex justify-center px-4" role="status" aria-live="polite">
        {toast ? (
          <div key={toast.id} className="toast items-start" style={{ maxWidth: 560 }}>
            <i className={`ic ${toast.icon}`} aria-hidden="true" style={{ marginTop: 1 }} />
            <span>
              {toast.text}
              {toast.mono ? <span className="mono break-all">{toast.mono}</span> : null}
            </span>
          </div>
        ) : null}
      </div>
    </>
  );
}

/** 전체 모달 머리: 평균 별점·후기 수·정렬, 신고 안내(POL-024 나목, 정부 신고기관 바로가기) */
function ListHeader({ sort, onSort, average, count, loading }: { sort: ReviewSort; onSort: (s: ReviewSort) => void; average: number | null; count: number; loading: boolean }) {
  return (
    <>
      <div className="row between" style={{ gap: 8 }}>
        <div className="row" style={{ gap: 8 }}>
          {loading ? (
            <span className="skel" style={{ width: 150, height: 20 }} aria-hidden="true" />
          ) : average !== null ? (
            <>
              <span className="row" style={{ gap: 1, color: 'var(--primary)' }} aria-hidden="true">
                {[1, 2, 3, 4, 5].map((k) => (
                  <i key={k} className="ic ic-star-fill ic-16" />
                ))}
              </span>
              <strong className="t-lg num" aria-hidden="true">{average.toFixed(1)}</strong>
              <span className="t-sm muted" aria-hidden="true">{count.toLocaleString('ko-KR')}개</span>
              <span className="sr-only">평균 별점 5점 만점에 {average.toFixed(1)}점, 후기 {count.toLocaleString('ko-KR')}개</span>
            </>
          ) : (
            <span className="t-sm muted">아직 후기가 없습니다</span>
          )}
        </div>
        <div className="input-group input-group-sm" style={{ width: 'auto', padding: '0 8px 0 10px' }}>
          <select aria-label="정렬" value={sort} onChange={(e) => onSort(e.target.value as ReviewSort)}>
            {(Object.keys(REVIEW_SORT_LABEL) as ReviewSort[]).map((k) => (
              <option key={k} value={k}>
                {REVIEW_SORT_LABEL[k]}
              </option>
            ))}
          </select>
          <i className="ic ic-chevron-down ic-16" aria-hidden="true" />
        </div>
      </div>
      <p className="t-xs muted">
        후기마다 있는 [신고]를 누르면 피켓 운영팀에 신고할 수 있습니다. 암표나 매크로 프로그램은 정부 신고기관(한국콘텐츠진흥원)의 온라인
        암표신고센터에도 신고할 수 있습니다.{' '}
        <a className="link" href={SCALPING_REPORT_CENTER_URL} target="_blank" rel="noopener noreferrer" aria-label="온라인 암표신고센터, 새 창">
          온라인 암표신고센터
          <i className="ic ic-external ic-14" aria-hidden="true" />
        </a>
      </p>
    </>
  );
}

function StarsLine({ n }: { n: number }) {
  return (
    <div className="row" style={{ gap: 6 }}>
      <span className="row" style={{ gap: 1 }} aria-hidden="true">
        {[1, 2, 3, 4, 5].map((k) => (
          <i key={k} className={`ic ${k <= n ? 'ic-star-fill' : 'ic-star'} ic-16`} style={{ color: k <= n ? 'var(--primary)' : 'var(--text-disabled)' }} />
        ))}
      </span>
      <span className="t-xs fw-b">5점 만점에 {n}점</span>
    </div>
  );
}

/** CMP-073 ReviewCard full·mine. 휴대폰·태블릿은 세로 카드, 데스크톱은 본문 왼쪽 · 버튼 오른쪽 */
function ReviewCard({
  item,
  reported,
  askDelete,
  onPhoto,
  onReport,
  onEdit,
  onAskDelete,
  onDelete,
  moderator,
  onModerated,
}: {
  item: ReviewItem;
  reported: boolean;
  askDelete: boolean;
  onPhoto: (n: number) => void;
  onReport: () => void;
  onEdit: () => void;
  onAskDelete: (ask: boolean) => void;
  onDelete: () => void;
  moderator?: boolean;
  onModerated?: (text: string) => void;
}) {
  if (item.kind === 'notice') {
    return (
      <article className="card-flat col" style={{ padding: 16, gap: 4 }} aria-label={item.label}>
        <p className="t-sm muted row" style={{ gap: 6, alignItems: 'flex-start' }}>
          <i className="ic ic-eye-off ic-16" aria-hidden="true" style={{ marginTop: 2 }} />
          <span>{item.text}</span>
        </p>
      </article>
    );
  }
  const r = item;
  const doneId = `rv-done-${r.id}`;
  const actions = r.mine ? (
    askDelete ? (
      <div className="col" style={{ gap: 8 }} role="group" aria-labelledby={`rv-del-${r.id}`}>
        <p className="t-sm fw-b" id={`rv-del-${r.id}`}>
          이 후기를 지울까요? 지운 후기는 되살릴 수 없습니다
        </p>
        <div className="row" style={{ gap: 8 }}>
          {/* eslint-disable-next-line jsx-a11y/no-autofocus -- [삭제]가 사라지므로 초점을 확인 버튼으로 옮긴다 */}
          <button className="btn btn-danger btn-sm" type="button" onClick={onDelete} autoFocus>
            <i className="ic ic-alert" aria-hidden="true" />
            지우기
          </button>
          <button className="btn btn-ghost btn-sm" type="button" onClick={() => onAskDelete(false)}>
            그대로 두기
          </button>
        </div>
      </div>
    ) : (
      <div className={cx('row', ACTION_ROW)} style={{ gap: 4 }}>
        <button className="btn btn-ghost btn-sm" type="button" id={`rv-ed-${r.id}`} aria-label={`게시물 ${r.id} 수정`} aria-haspopup="dialog" onClick={onEdit}>
          <i className="ic ic-edit" aria-hidden="true" />
          수정
        </button>
        <button className="btn btn-ghost btn-sm" type="button" aria-label={`게시물 ${r.id} 삭제`} onClick={() => onAskDelete(true)}>
          <i className="ic ic-trash" aria-hidden="true" />
          삭제
        </button>
      </div>
    )
  ) : reported ? (
    <div className={cx('row wrap lg:flex-col lg:items-end', ACTION_ROW)} style={{ gap: '4px 8px' }}>
      <button
        className="btn btn-ghost btn-sm"
        type="button"
        id={`rv-rp-${r.id}`}
        aria-disabled="true"
        aria-label={`${r.author}의 후기 신고함, 게시물 ${r.id}`}
        aria-describedby={doneId}
      >
        <i className="ic ic-flag" aria-hidden="true" />
        신고함
      </button>
      <span className="t-xs muted" id={doneId}>
        이미 신고한 후기입니다
      </span>
    </div>
  ) : (
    <button
      className={cx('btn btn-ghost btn-sm self-start', ACTION_ROW)}
      type="button"
      id={`rv-rp-${r.id}`}
      aria-haspopup="dialog"
      aria-label={`${r.author}의 후기 신고, 게시물 ${r.id}`}
      onClick={onReport}
    >
      <i className="ic ic-flag" aria-hidden="true" />
      신고
    </button>
  );

  return (
    <article className="card col gap-2 p-4 lg:flex-row lg:items-start lg:gap-4 lg:px-[18px]">
      <div className="col grow gap-2 lg:gap-1.5">
        <div className="row wrap" style={{ gap: '4px 8px' }}>
          <strong className="t-sm fw-b">{r.author}</strong>
          {r.mine ? <span className="badge badge-outline">내 후기</span> : null}
          {r.restricted ? <span className="badge badge-warning">노출 제한</span> : null}
          <span className="t-xs muted">{r.watched}</span>
          <span className="t-xs muted num">{r.written}</span>
        </div>
        {r.restricted ? (
          <p className="t-sm muted">운영정책에 따라 노출이 제한되었습니다</p>
        ) : (
          <>
            <StarsLine n={r.stars} />
            <p className="t-sm">{r.body}</p>
          </>
        )}
        {r.photos.length > 0 ? (
          <ul className="row lg:mt-0.5" style={{ gap: 8 }} aria-label={`${r.author}의 후기 사진 ${r.photos.length}장`}>
            {r.photos.map((photo, k) => (
              <li key={k}>
                <button
                  className="center"
                  type="button"
                  id={`rv-ph-${r.id}-${k + 1}`}
                  aria-label={`${r.author}의 후기 사진 ${k + 1}/${r.photos.length} 크게 보기`}
                  onClick={() => onPhoto(k + 1)}
                  style={{
                    width: 72,
                    height: 72,
                    padding: 0,
                    border: 0,
                    borderRadius: 'var(--r-md)',
                    background: 'var(--fill-weak)',
                    color: 'var(--text-muted)',
                    cursor: 'pointer',
                    overflow: 'hidden',
                  }}
                >
                  {photo.thumbnailUrl ? (
                    <img src={photo.thumbnailUrl} alt="" width={72} height={72} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                  ) : (
                    <i className="ic ic-image ic-24" aria-hidden="true" />
                  )}
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      <div className="col flex-none lg:items-end">
        {actions}
        {moderator ? <ReviewModerationActions reviewId={r.id} onDone={(text) => onModerated?.(text)} /> : null}
      </div>
    </article>
  );
}

/** 사진 보기: 같은 모달 안에서 큰 사진 · ‹ › · 'n/전체' · 사진 설명 · [목록으로] */
function PhotoView({ review, index, onIndex, onBack }: { review: Review | undefined; index: number; onIndex: (n: number) => void; onBack: () => void }) {
  if (!review || review.photos.length === 0) {
    return (
      <div className="state py-16">
        <p className="t-md">이미 지워졌거나 가려진 후기입니다</p>
        <button className="btn btn-secondary btn-lg" type="button" onClick={onBack}>
          목록으로
        </button>
      </div>
    );
  }
  const total = review.photos.length;
  const n = Math.min(Math.max(index, 1), total);
  const photo = review.photos[n - 1];
  const caption = photo?.caption ?? '';
  const name = caption || `후기 사진 ${n}/${total}`;
  const src = photo?.url ?? photo?.thumbnailUrl;
  const atStart = n <= 1;
  const atEnd = n >= total;
  const disabled = { color: 'var(--text-disabled)', cursor: 'not-allowed' } as const;
  return (
    <section className="col outline-none" id="rv-photo-view" tabIndex={-1} aria-label={`${review.author}의 후기 사진 보기`} style={{ gap: 12 }}>
      <div className="row wrap" style={{ gap: '4px 8px' }}>
        <strong className="t-sm fw-b">{review.author}</strong>
        <span className="t-xs muted">{review.watched}</span>
        <span className="t-xs muted num">{review.written}</span>
      </div>
      <figure className="col" style={{ gap: 12 }}>
        <div
          className="center aspect-square w-full md:aspect-auto md:h-[440px] lg:h-[300px]"
          role="img"
          aria-label={name}
          style={{ borderRadius: 'var(--r-lg)', background: 'var(--fill-weak)', color: 'var(--text-muted)' }}
        >
          {src ? <img src={src} alt={name} style={{ width: '100%', height: '100%', objectFit: 'contain' }} /> : (
            <>
              <i className="ic ic-image ic-48 md:hidden" aria-hidden="true" />
              <i className="ic ic-image ic-64 hidden md:inline-block" aria-hidden="true" />
            </>
          )}
        </div>
        <div className="row between" style={{ gap: 8 }}>
          <button
            className="icon-btn icon-btn-outline"
            type="button"
            aria-label="이전 사진"
            aria-disabled={atStart || undefined}
            aria-describedby="rv-pv-count"
            style={atStart ? disabled : undefined}
            onClick={() => !atStart && onIndex(n - 1)}
          >
            <i className="ic ic-chevron-left" aria-hidden="true" />
          </button>
          <span className="t-md fw-b num" id="rv-pv-count" aria-live="polite">
            {n}/{total}
          </span>
          <button
            className="icon-btn icon-btn-outline"
            type="button"
            aria-label="다음 사진"
            aria-disabled={atEnd || undefined}
            aria-describedby="rv-pv-count"
            style={atEnd ? disabled : undefined}
            onClick={() => !atEnd && onIndex(n + 1)}
          >
            <i className="ic ic-chevron-right" aria-hidden="true" />
          </button>
        </div>
        {caption ? <figcaption className="t-sm">{caption}</figcaption> : null}
      </figure>
      <button className="btn btn-secondary btn-lg btn-block md:w-auto md:min-w-[240px] md:self-center" type="button" onClick={onBack}>
        목록으로
      </button>
    </section>
  );
}

const LEGAL_POST_NOTICE =
  '매크로 등 공정한 구입 과정을 우회하거나 방해하는 프로그램의 유통, 부정구매, 부정판매(암표 판매)와 관련된 게시물은 사전 통보 없이 노출이 제한될 수 있습니다.';
const PHOTO_HINT =
  '예매번호·이름 같은 개인정보가 보이는 사진, 다른 사람이 알아볼 수 있는 얼굴 사진, 촬영이 허용되지 않은 공연 중 사진은 올리지 마세요. 사진의 촬영 위치 같은 정보는 지우고 올립니다.';
const TEXT_MIN = 10;
const TEXT_MAX = 1000;

interface WriteErrors {
  rating?: string;
  text?: string;
  banned?: string;
  server?: string;
}

function checkWrite(rating: number, text: string): WriteErrors {
  const e: WriteErrors = {};
  if (rating < 1) e.rating = '별점을 골라 주세요';
  const normalized = text.normalize('NFC').trim();
  const hit = BANNED_PHRASES.find((w) => normalized.includes(w));
  if (hit) e.banned = `이 표현은 쓸 수 없습니다: ${hit}`;
  else if (Array.from(normalized).length < TEXT_MIN) e.text = `${TEXT_MIN}자 이상 써 주세요`;
  return e;
}

/** 후기 쓰기·고치기 모달(CMP-019 form): 노출 제한 법정 고지 → 관람 회차 → 별점 → 본문 → 사진 → [등록] */
function WriteModal({
  preset,
  title,
  rounds,
  currentRound,
  onClose,
  onSubmit,
}: {
  preset: WritePreset;
  title: string;
  rounds: readonly { value: string; label: string }[];
  currentRound: string;
  onClose: () => void;
  onSubmit: (rating: number, body: string) => Promise<WriteResult>;
}) {
  const [rating, setRating] = useState(preset.rating);
  const [text, setText] = useState(preset.text);
  const [errors, setErrors] = useState<WriteErrors>(() => (preset.validate ? checkWrite(preset.rating, preset.text) : {}));
  const [submitCount, setSubmitCount] = useState(preset.validate ? 1 : 0);
  const [submitting, setSubmitting] = useState(false);
  const edit = preset.mode === 'edit';
  const summary = [
    errors.rating ? { fieldId: 'rw-rating', message: errors.rating } : null,
    errors.text ? { fieldId: 'rw-text', message: errors.text } : null,
  ].filter((x): x is { fieldId: string; message: string } => x !== null);

  const submit = async () => {
    const e = checkWrite(rating, text);
    setErrors(e);
    setSubmitCount((c) => c + 1);
    if (e.rating || e.text || e.banned) return;
    setSubmitting(true);
    try {
      const result = await onSubmit(rating, text);
      if (!result.ok) setErrors(result.errors ?? { server: '후기를 보내지 못했습니다. 잠시 뒤 다시 시도해 주세요.' });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <ModalFrame
      open
      onClose={onClose}
      title={edit ? '후기 고치기' : '후기 쓰기'}
      closeLabel={edit ? '후기 고치기 닫기' : '후기 쓰기 닫기'}
      layout="form"
      maxWidth={560}
      maxWidthLg={600}
      restoreFocus={false}
      header={<p className="t-sm muted">{title}</p>}
    >
      <form
        className="col gap-5 md:gap-4"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        {preset.already ? (
          <div className="banner banner-info" role="status">
            <i className="ic ic-info" aria-hidden="true" />
            <div className="banner-body">이 회차에는 이미 후기를 쓰셨습니다. 쓴 후기를 고칠 수 있습니다</div>
          </div>
        ) : null}
        {summary.length > 0 ? (
          <FormErrorSummary key={submitCount} title={`등록하기 전에 ${summary.length}곳을 고쳐 주세요`} errors={summary} focusFirst={submitCount > 0} />
        ) : null}
        {errors.server ? (
          <div className="banner banner-danger" role="alert">
            <i className="ic ic-alert" aria-hidden="true" />
            <div className="banner-body">{errors.server}</div>
          </div>
        ) : null}
        <div className="banner banner-legal">
          <i className="ic ic-scale" aria-hidden="true" />
          <div className="banner-body">
            <span className="legal-tag">법정 고지</span>
            {LEGAL_POST_NOTICE}
          </div>
        </div>
        <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-2 lg:gap-4">
          {rounds.length > 1 ? (
            <Select id="rw-round" label="관람 회차" requiredMark options={rounds} defaultValue={currentRound} />
          ) : null}
          <div id="rw-rating">
            <Rating
              name="rw-rating-v"
              value={rating}
              onValueChange={(v) => {
                setRating(v);
                if (errors.rating) setErrors((e) => ({ ...e, rating: undefined }));
              }}
              error={errors.rating}
            />
          </div>
        </div>
        <TextArea
          id="rw-text"
          label="후기"
          requiredMark
          hint="10~1,000자. 이모지를 쓸 수 있습니다"
          maxLength={TEXT_MAX}
          value={text}
          onChange={(e) => setText(e.target.value)}
          error={errors.banned ?? errors.text}
        />
        <ImageUploader id="rw-ph" hint={PHOTO_HINT} max={3} defaultItems={preset.photos} />
        <div className="flex flex-col-reverse gap-2 md:flex-row md:flex-wrap md:items-center md:justify-end">
          <button className="btn btn-ghost hidden md:inline-flex" type="button" onClick={onClose}>
            닫기
          </button>
          <button className="btn btn-primary btn-lg btn-block md:w-auto md:min-w-[160px]" type="submit" disabled={submitting} aria-busy={submitting}>
            {submitting ? '보내는 중…' : edit ? '고치기' : '등록'}
          </button>
        </div>
      </form>
    </ModalFrame>
  );
}
