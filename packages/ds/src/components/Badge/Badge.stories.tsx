// CMP-040 Badge 이야기(d2 §2 CMP-040 DeadlineBadge의 모양)
import type { Meta, StoryObj } from '@storybook/react-vite';
import { Badge, type BadgeTone } from './Badge';

const meta: Meta<typeof Badge> = { title: 'CMP-040 Badge', component: Badge, args: { children: '마감 임박' } };
export default meta;
type Story = StoryObj<typeof Badge>;

const tones: BadgeTone[] = ['neutral', 'primary', 'success', 'warning', 'danger', 'solid', 'inverse', 'outline'];
export const Tones: Story = {
  render: () => (
    <div className="row wrap" style={{ gap: 8 }}>
      {tones.map((t) => (
        <Badge key={t} tone={t}>
          {t}
        </Badge>
      ))}
    </div>
  ),
};
export const Large: Story = { args: { size: 'lg', tone: 'danger', icon: 'clock' } };
