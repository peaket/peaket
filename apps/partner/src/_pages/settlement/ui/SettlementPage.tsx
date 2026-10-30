// SCR-027 정산 리포트·명단(/events/[id]/settlement). 보드 SCR-027-m·t·d를 한 페이지 반응형으로 합쳤다(d5 §6.10, §3.9).
// 하위 탭 넷(정산서 · 판매 요약 · 예매자 명단 · 다운로드 이력)은 한 페이지 안의 탭이다. ?state=가 처음 고른 탭과 그 탭의 모양을 정하고,
// 다른 탭은 각자의 기본 모양으로 그린다. 예매자 명단·다운로드 이력은 파트너 관리자만 본다(실무자는 잠금 카드).
import { requireProduction } from '@/entities/production';
import { routes } from '@/shared/config/routes';
import { SETTLEMENT_MEMBER_STATES, SETTLEMENT_STATES, type SettlementState } from '@/shared/config/states/scr027';
import { readPreview, type RouteProps } from '@/shared/lib/preview';
import { PreviewStateSwitcher } from '@/shared/ui/PreviewStateSwitcher';
import { EventContextHeader } from '@/widgets/event-context';
import { FALLBACK_ROUNDS } from '../model/settlement';
import { SubTabs, type SubTab } from './client';
import { LogTab, RosterTab, type LogVariant, type RosterVariant } from './RosterTab';
import { SettleTab, type SettleVariant } from './SettleTab';
import { SummaryTab } from './SummaryTab';

const SETTLE: readonly SettlementState[] = ['정산', 'KYC 예고', '이의 제기 대화상자', '이의 기간 끝', '재통지(조정)', '재통지(기각)'];
const SUMMARY: readonly SettlementState[] = ['판매 요약', '판매 요약 확정 전'];
const ROSTER: readonly SettlementState[] = ['예매자 명단', '다운로드 대화상자', '사유 없음 오류', '내려받는 중', '명단 실무자 보기', '보유 기간 끝'];

function tabOf(s: SettlementState): SubTab {
  if (SETTLE.includes(s)) return 'settle';
  if (SUMMARY.includes(s)) return 'summary';
  if (ROSTER.includes(s)) return 'roster';
  return 'log';
}

export default async function SettlementPage({ params, searchParams }: RouteProps<{ id: string }>) {
  const { id } = await params;
  const pv = readPreview(await searchParams, SETTLEMENT_STATES, '정산');
  const production = requireProduction(id);
  const s = pv.state;
  const tab = tabOf(s);
  const isMember = pv.isMember || SETTLEMENT_MEMBER_STATES.includes(s);
  const rounds = production.rounds.length > 0 ? production.rounds.map((r) => r.startsAt) : FALLBACK_ROUNDS;

  const settleV: SettleVariant = tab === 'settle' ? (s as SettleVariant) : '정산';
  const rosterV: RosterVariant = isMember ? '실무자' : tab === 'roster' ? (s as RosterVariant) : '예매자 명단';
  const logV: LogVariant = isMember ? '실무자' : s === '다운로드 이력 없음' ? '다운로드 이력 없음' : '다운로드 이력';

  return (
    <>
      <EventContextHeader production={production} current="settlement" />

      <section className="col" style={{ gap: 16 }} aria-labelledby="sr-h">
        <h2 className="t-lg" id="sr-h">
          정산 리포트·명단
        </h2>
        <SubTabs
          initial={tab}
          panels={{
            settle: <SettleTab v={settleV} isMember={isMember} rounds={rounds} />,
            summary: <SummaryTab pending={s === '판매 요약 확정 전'} rounds={rounds} eventId={id} />,
            roster: <RosterTab v={rosterV} rounds={rounds} />,
            log: <LogTab v={logV} productionName={production.name} />,
          }}
        />
      </section>

      <PreviewStateSwitcher path={routes.eventTab(id, 'settlement')} states={SETTLEMENT_STATES} current={s} keep={pv.keep} />
    </>
  );
}
