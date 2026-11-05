// CMP-015 QueuePanel 이야기(d2 CMP-015, ADR-0220). 대기열 기본 화면의 네 상태(waiting·soon·paused·stale)를 대기실 셸과 같은 틀(.q-queue·.q-frame)
// 안에 그린다. 패널 배치 규칙은 대기실 화면 규칙(queue-room-screens.css)이라 이 이야기가 함께 싣는다.
// 셸과 같은 그림인지는 tools/web-checks/visual/queue-panel.spec.mjs가 이 이야기의 마크업을 셸 화면의 패널 자리에 넣어 견준다(Storybook은 Tailwind·SEED 바탕이 더 실려
// 이야기 그림 자체는 셸과 픽셀이 같지 않다). 모델 값은 셸 FE-T40 틀의 고정 값(visual/queue-room-states.mjs)과 같게 둔다.
import type { Meta, StoryObj } from '@storybook/react-vite';
import '../../styles/queue-room-screens.css';
import { QueuePanel } from './QueuePanel';

const meta: Meta<typeof QueuePanel> = {
  title: 'CMP-015 QueuePanel',
  component: QueuePanel,
  parameters: { layout: 'fullscreen' },
  render: (args) => (
    <main className="page-main q-main q-queue">
      <div className="col q-frame q-queue-frame">
        <QueuePanel {...args} />
      </div>
    </main>
  ),
};
export default meta;
type Story = StoryObj<typeof QueuePanel>;

export const Waiting: Story = { args: { model: { state: 'waiting', ahead: 3214, progress: 62, etaText: '약 2분' } } };
export const Soon: Story = { args: { model: { state: 'soon', soonSeconds: 5 } } };
export const Paused: Story = { args: { model: { state: 'paused', ahead: 3214, progress: 62, etaText: null } } };
export const Stale: Story = { args: { model: { state: 'stale', ahead: 3214, progress: 62, etaText: '약 2분' } } };
