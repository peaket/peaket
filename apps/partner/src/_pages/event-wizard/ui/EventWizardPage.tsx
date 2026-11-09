// SCR-021 공연 등록 위저드(/events/new · /events/[id]/edit · /events/[id]/sale-review). 보드 SCR-021-m·t·d·xl을 한 페이지 반응형으로 합쳤다(d5 §6.4, §3.9).
// 휴대폰: 판매 승인 상태와 단계별 입력 내용을 읽기만 한다(입력·임시저장·승인 요청은 안내 카드) / 태블릿: 1열, 지금 단계 이름만 / lg: 12열 / xl: 보드 -xl의 세 칸.
// 새 공연은 '공연 관리 › 새 공연 등록' 머리, 기존 공연은 공연 문맥 머리(등록 정보 탭). 하단 막대는 화면 아래에 붙는다.
import { previewHref } from '@peaket/ds/Preview';
import { PRIMARY_PRODUCTION_ID, requireProduction } from '@/entities/production';
import { routes } from '@/shared/config/routes';
import {
  EDIT_WIZARD_STATES,
  NEW_WIZARD_STATES,
  SALE_REVIEW_STATES,
  type WizardState,
} from '@/shared/config/states/scr021';
import { readParam, readPreview, type SearchParams } from '@/shared/lib/preview';
import { Modal } from '@/shared/ui/Modal';
import { PreviewStateSwitcher } from '@/shared/ui/PreviewStateSwitcher';
import { EventContextHeader } from '@/widgets/event-context';
import { edit } from '../model/fixtures';
import { resolveView, STEP_STATE, type WizardMode, type WizardStep } from '../model/view';
import { EditRounds } from './EditRounds';
import { LiveWizard } from './live/LiveWizard';
import { MobileSummary } from './MobileSummary';
import { CopyLinkBanner } from './parts/CopyLinkBanner';
import { StepBasic } from './StepBasic';
import { editLimit, StepPolicy } from './StepPolicy';
import { StepRounds } from './StepRounds';
import { StepSeatmap } from './StepSeatmap';
import { StepSeller } from './StepSeller';
import { ActionBar, EventBanners, NewHeader, reviewBadges, WizardStepper } from './WizardChrome';

export interface EventWizardPageProps {
  /** 없으면 새 공연(/events/new) */
  eventId?: string;
  /** 'sale-review'는 5단계(/events/[id]/sale-review) */
  mode: WizardMode;
  path: string;
  searchParams: SearchParams;
}

const STATES_BY_MODE = { new: NEW_WIZARD_STATES, edit: EDIT_WIZARD_STATES, 'sale-review': SALE_REVIEW_STATES } as const;
const FALLBACK: Record<WizardMode, WizardState> = {
  new: '1단계 기본 정보',
  edit: '오픈 뒤 수정 · 판매 정책',
  'sale-review': '5단계 판매자 정보·승인 요청',
};

export function EventWizardPage({ eventId, mode, path, searchParams }: EventWizardPageProps) {
  // 새 공연은 ?state=가 없으면 실제 위저드다(ADR-0245 결정 7). 상태를 고르면 지금까지의 퍼블리싱 화면을 그린다
  if (mode === 'new' && readParam(searchParams, 'state') === undefined) {
    return (
      <>
        <NewHeader />
        <div className="md:hidden">
          <CopyLinkBanner title="공연 등록과 수정은 태블릿이나 데스크톱에서 합니다" body="임시저장과 등록도 큰 화면에서 합니다. 링크를 복사해 큰 화면에서 열어 주세요" />
        </div>
        <LiveWizard />
      </>
    );
  }
  const states: readonly WizardState[] = STATES_BY_MODE[mode];
  const pv = readPreview(searchParams, states, FALLBACK[mode]);
  const view = resolveView(mode, pv.state);
  const production = eventId ? requireProduction(eventId) : null;
  // 새 공연은 초안을 처음 저장할 때 ID를 받는다. 목업에서는 좌석맵·판매 정책 바로가기를 LUMEN 공연으로 잇는다
  const linkId = eventId ?? PRIMARY_PRODUCTION_ID;
  const keepQuery = new URLSearchParams(Object.entries(pv.keep).filter((e): e is [string, string] => e[1] !== undefined)).toString() || undefined;

  let prevHref: string | undefined;
  let nextHref: string | undefined;
  if (view.body.kind === 'step' && mode === 'new') {
    const n = view.body.step;
    if (n > 1) prevHref = previewHref(path, STEP_STATE[(n - 1) as WizardStep], pv.keep);
    if (n < 5) nextHref = previewHref(path, STEP_STATE[(n + 1) as WizardStep], pv.keep);
  } else if (mode === 'sale-review' && eventId) {
    prevHref = routes.eventTab(eventId, 'edit');
  }

  const revising = view.review === 'reReq' || view.review === 'reRej';
  const doneUpTo = view.context === 'new' && view.body.kind === 'step' ? view.body.step - 1 : 5;

  return (
    <>
      {view.context === 'new' || !production ? (
        <NewHeader keepQuery={keepQuery} />
      ) : (
        <EventContextHeader production={production} current="edit" badges={reviewBadges(production, view.review)} keep={keepQuery} />
      )}
      {view.context === 'event' ? <EventBanners review={view.review} isMember={pv.isMember} /> : null}

      <MobileSummary review={view.review} eventId={linkId} doneUpTo={doneUpTo} />

      <div className="col max-md:hidden" style={{ gap: 20 }}>
        <WizardStepper view={view} />
        {view.body.kind === 'e4' ? (
          <StepPolicy eventId={linkId} locked limit={editLimit(revising)} />
        ) : view.body.kind === 'e2' ? (
          <EditRounds />
        ) : view.body.step === 1 ? (
          <StepBasic imageError={view.imageError} />
        ) : view.body.step === 2 ? (
          <StepRounds openError={view.openError} />
        ) : view.body.step === 3 ? (
          <StepSeatmap eventId={linkId} />
        ) : view.body.step === 4 ? (
          <StepPolicy eventId={linkId} locked={false} />
        ) : (
          <StepSeller eventId={linkId} holderMismatch={view.holderMismatch} wheelchairMissing={view.wheelchairMissing} rejected={view.review === 'rejected'} />
        )}
      </div>

      <ActionBar view={view} isMember={pv.isMember} prevHref={prevHref} nextHref={nextHref} />

      {view.showChangeDialog ? (
        <Modal id="wizard-change" defaultOpen role="alertdialog" labelledBy="chg-t" describedBy="chg-d" maxWidth={480}>
          <div className="row" style={{ gap: 12 }}>
            <span className="state-icon is-warning" style={{ width: 44, height: 44 }}>
              <i className="ic ic-alert" aria-hidden="true" />
            </span>
            <h2 className="dialog-title" id="chg-t">
              판매 승인을 다시 받습니다
            </h2>
          </div>
          <p className="t-sm" id="chg-d">
            다시 판매 승인을 받아야 하고, 오픈 전이면 오픈 예약이 멈춥니다. 공개 중인 내용과 판매는 승인될 때까지 그대로입니다
          </p>
          <dl className="kv">
            <dt>바꾼 항목</dt>
            <dd>{edit.changed}</dd>
          </dl>
          <div className="dialog-actions max-md:flex-col-reverse max-md:[&>*]:w-full">
            <button className="btn btn-outline" type="button" data-modal-close>
              더 고치기
            </button>
            <button className="btn btn-primary" type="button" data-autofocus aria-disabled={pv.isMember || undefined}>
              변경을 저장하고 판매 승인 요청
            </button>
          </div>
        </Modal>
      ) : null}

      <PreviewStateSwitcher path={path} states={states} current={pv.state} keep={pv.keep} />
    </>
  );
}
