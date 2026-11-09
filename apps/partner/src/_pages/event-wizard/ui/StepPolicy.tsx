// 4단계 판매 정책(보드 s4)과 고치는 화면의 판매 정책 구역(보드 e4: 온세일 중 잠김). lg 7+5열, 태블릿 1열.
// 정렬 방식 이름은 회차의 정렬 설정 두 값(lobbyShuffle·openBatch)으로 저장한다(ADR-0118). 선착순을 고르면 POL-004 경고를 보인다.
import Link from 'next/link';
import { routes } from '@/shared/config/routes';
import { edit, FIFO_WARNING, queueModes } from '../model/fixtures';
import { ChoiceCards } from './parts/ChoiceCards';
import { LimitStepper } from './parts/LimitStepper';
import { AutoExtra, PREVIEW_TITLE, SEAT_CHOICES } from './parts/policy-choices';

export function StepPolicy({ eventId, locked, limit }: { eventId: string; locked: boolean; limit?: { value: number; published?: number } }) {
  const p = locked ? 'e' : 'n';
  return (
    <div className="grid items-start gap-5 lg:grid-cols-12">
      <section className="card pad-lg col lg:col-span-7" style={{ gap: locked ? 14 : 16 }} aria-labelledby={`h-${p}-ord`}>
        <div className="section-title">
          <h2 id={`h-${p}-ord`}>대기열 정렬 방식</h2>
          {locked ? (
            <span className="badge">
              <i className="ic ic-lock" aria-hidden="true" />
              잠김
            </span>
          ) : null}
        </div>
        <ChoiceCards
          name={`${p}-ord`}
          legend="정렬 방식"
          required={!locked}
          choices={queueModes.map((m) => ({ value: m.value, title: m.label, desc: m.desc, flags: m.flags, preview: m.preview }))}
          defaultValue={locked ? 'FIFO' : 'HYBRID'}
          badgeFor={locked ? { value: 'FIFO', text: '지금 방식', tone: 'outline' } : { value: 'HYBRID', text: '기본', tone: 'primary' }}
          lockedBy={locked ? 'e-ord-lock' : undefined}
          warnFor={{ value: 'FIFO', text: FIFO_WARNING }}
          previewTitle={PREVIEW_TITLE}
          hint={
            locked ? (
              <p className="row t-sm fw-m" id="e-ord-lock" style={{ gap: 6 }}>
                <i className="ic ic-lock ic-16" aria-hidden="true" />
                온세일 중에는 바꿀 수 없습니다
              </p>
            ) : (
              <p className="hint">고른 방식은 회차의 정렬 설정 두 값(로비 셔플·오픈 직후 묶음)으로 저장합니다. 둘 다 끈 조합은 고를 수 없습니다</p>
            )
          }
        />
      </section>

      <div className="col gap-5 lg:col-span-5">
        <section className="card pad-lg col" style={{ gap: locked ? 14 : 16 }} aria-labelledby={`h-${p}-asg`}>
          <div className="section-title">
            <h2 id={`h-${p}-asg`}>좌석 배정과 구매 한도</h2>
          </div>
          <ChoiceCards
            name={`${p}-asg`}
            legend="좌석 배정 방식"
            required={!locked}
            choices={SEAT_CHOICES}
            defaultValue={locked ? 'AUTO' : 'PICK'}
            padding="12px 14px"
            badgeFor={locked ? { value: 'AUTO', text: '지금 방식', tone: 'outline' } : { value: 'PICK', text: '기본', tone: 'primary' }}
            lockedBy={locked ? 'e-asg-lock' : undefined}
            extraFor={{ value: 'AUTO', node: <AutoExtra disabled={locked} /> }}
            hint={
              locked ? (
                <>
                  <p className="row t-sm fw-m" id="e-asg-lock" style={{ gap: 6 }}>
                    <i className="ic ic-lock ic-16" aria-hidden="true" />
                    온세일 중에는 바꿀 수 없습니다
                  </p>
                  <div className="banner banner-info">
                    <i className="ic ic-eye" aria-hidden="true" />
                    <div className="banner-body">
                      <span className="banner-title">배정 기준 고지 미리보기</span>
                      좌석은 등급 안에서 자동으로 배정됩니다
                      <br />
                      선호 기준: 무대 중앙 인접 순
                    </div>
                  </div>
                </>
              ) : null
            }
          />
          <div className="field">
            <span className="label" id={`${p}-limit-l`}>
              1인 한도
            </span>
            <LimitStepper
              labelId={`${p}-limit-l`}
              defaultValue={limit?.value ?? 4}
              after={limit?.published !== undefined ? <span className="badge badge-outline">공개 중 {limit.published}매</span> : null}
            />
            <span className="hint">{locked ? '바꾸면 다시 판매 승인을 받습니다' : '한 공연에서 한 사람이 살 수 있는 매수입니다(POL-011)'}</span>
          </div>
        </section>

        <section className="card pad-lg col" style={{ gap: 12 }} aria-labelledby={`h-${p}-rule`}>
          <div className="section-title">
            <h2 id={`h-${p}-rule`}>판매 정책 규칙과 공연 규모</h2>
          </div>
          {!locked ? <p className="t-sm">팬클럽 선예매처럼 자격·기간에 따라 달라지는 조건은 판매 정책 규칙으로 정합니다.</p> : null}
          <Link className="link-more" href={routes.eventTab(eventId, 'policy')} style={{ alignSelf: 'flex-start' }}>
            판매 정책 규칙 열기
            <i className="ic ic-chevron-right" aria-hidden="true" />
          </Link>
          {!locked ? <div className="divider" /> : null}
          <div className="row" style={{ gap: 8 }}>
            <span className="t-sm fw-b">공연 규모</span>
            <span className={locked ? 'badge badge-outline' : 'badge'}>{locked ? '[판매 승인 때 확정한 규모]' : '대형'}</span>
          </div>
          {!locked ? <p className="hint">판매 승인 때 운영자가 확정합니다. 대형이면 그때 다른 대형 공연과 30분 간격을 검사합니다</p> : null}
        </section>
      </div>
    </div>
  );
}

/** 고치는 화면 e4의 1인 한도: 재승인 대기·변경 반려면 요청한 4매와 '공개 중 2매' 배지 */
export function editLimit(revising: boolean) {
  return revising ? { value: edit.limitRequested, published: edit.limitPublished } : { value: edit.limitPublished };
}
