// 좌석맵 에디터의 대화상자: 템플릿 고르기(CMP-078 gallery, 데스크톱 폭 960) → 템플릿 설정(setup) · 좌석 다시 채우기 확인.
// 상태 미리보기에서는 그 상태일 때 열린 채로 그린다. 휴대폰은 템플릿·편집을 하지 않으므로(d5 §3.9) 감싼 쪽에서 숨긴다.
import { TemplateGallery, TemplateSetup } from '@peaket/ds/TemplatePicker';
import { Modal } from '@/shared/ui/Modal';
import { TEMPLATE_CARDS, TEMPLATE_FAMILY_CHIPS } from '../model/templates';
import type { EditorView } from '../model/view';

export const MODAL = { pick: 'seatmap-tpl-pick', setup: 'seatmap-tpl-setup', refill: 'seatmap-refill' } as const;

export function SeatmapDialogs({ v }: { v: EditorView }) {
  const arena = TEMPLATE_CARDS[0]!;
  return (
    <>
      <Modal id={MODAL.pick} defaultOpen={v.dialog === 'pick'} labelledBy="tp-t" describedBy="tp-d" maxWidth={960} sheetOnMobile={false} className="px-5 py-[18px] gap-3">
        <TemplateGallery
          titleId="tp-t"
          descId="tp-d"
          templates={TEMPLATE_CARDS}
          families={TEMPLATE_FAMILY_CHIPS}
          closeAttrs={{ 'data-modal-close': '' }}
          cardAttrs={{ 'data-modal-close': '', 'data-modal-open': MODAL.setup }}
        />
      </Modal>
      <Modal id={MODAL.setup} defaultOpen={v.dialog === 'setup'} labelledBy="ts-t" describedBy="ts-d" maxWidth={960} sheetOnMobile={false} className="p-5 gap-3.5">
        <TemplateSetup
          titleId="ts-t"
          descId="ts-d"
          template={arena}
          targetSeats="2,400"
          distribution={[
            { label: '플로어 F1~F6 · 6구역', seats: '600', note: '구역마다 100' },
            { label: '2층 201~209 · 9구역', seats: '900', note: '구역마다 100' },
            { label: '3층 301~309 · 9구역', seats: '900', note: '구역마다 100' },
          ]}
          totalLabel="합계 · 24구역"
          total="2,400"
          variants="—"
          grades={['R석', 'S석', 'A석']}
          gradeDefaults={[
            { label: '플로어 F1~F6', value: 'R석' },
            { label: '2층 201~209', value: 'S석' },
            { label: '3층 301~309', value: 'A석' },
          ]}
          legend={[
            { label: '플로어 F1~F6', swatch: 'var(--heat-3)' },
            { label: '2층 201~209', swatch: 'var(--heat-2)' },
            { label: '3층 301~309', swatch: 'var(--heat-1)', outlined: true },
          ]}
          closeAttrs={{ 'data-modal-close': '' }}
          backAttrs={{ 'data-modal-close': '', 'data-modal-open': MODAL.pick }}
          startAttrs={{ 'data-modal-close': '' }}
        />
      </Modal>
      <Modal id={MODAL.refill} defaultOpen={v.dialog === 'refill'} role="alertdialog" labelledBy="rf-t" describedBy="rf-d" maxWidth={440} sheetOnMobile={false}>
        <h2 className="dialog-title" id="rf-t">
          이 구역의 좌석 420석을 지우고 새로 채웁니다
        </h2>
        <p className="t-sm muted" id="rf-d">
          A1구역 · 지금 420석 · 새로 채울 좌석 598석
        </p>
        <div className="dialog-actions">
          <button className="btn btn-outline" type="button" data-modal-close="" data-autofocus="">
            그대로 두기
          </button>
          <button className="btn btn-danger" type="button" data-modal-close="">
            <i className="ic ic-trash" aria-hidden="true" />
            지우고 채우기
          </button>
        </div>
      </Modal>
    </>
  );
}
