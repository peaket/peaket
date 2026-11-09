// CMP-017 NoticeBanner 이야기(d2 §2 CMP-017)
import type { Meta, StoryObj } from '@storybook/react-vite';
import { NoticeBanner, type BannerTone } from './NoticeBanner';

const meta: Meta<typeof NoticeBanner> = {
  title: 'CMP-017 NoticeBanner',
  component: NoticeBanner,
  args: { title: '판매가 곧 시작됩니다', children: '10:00에 대기열이 열립니다.' },
};
export default meta;
type Story = StoryObj<typeof NoticeBanner>;

const tones: BannerTone[] = ['info', 'warning', 'danger', 'success', 'announce', 'legal', 'offline'];
export const Tones: Story = {
  render: () => (
    <div className="col" style={{ gap: 8 }}>
      {tones.map((t) => (
        <NoticeBanner key={t} tone={t} title={`${t} 배너`} role={null}>
          안내 글입니다.
        </NoticeBanner>
      ))}
    </div>
  ),
};
export const Strip: Story = { args: { strip: true, tone: 'offline', title: '오프라인입니다', children: undefined } };
export const WithAction: Story = {
  args: {
    tone: 'warning',
    action: (
      <a className="link" href="#retry">
        다시 시도
      </a>
    ),
  },
};
