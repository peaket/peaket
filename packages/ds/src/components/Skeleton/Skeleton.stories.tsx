// CMP-044 Skeleton 이야기(d2 §2 CMP-044)
import type { Meta, StoryObj } from '@storybook/react-vite';
import { Skeleton, SkeletonGroup } from './Skeleton';

const meta: Meta<typeof Skeleton> = { title: 'CMP-044 Skeleton', component: Skeleton };
export default meta;
type Story = StoryObj<typeof Skeleton>;

export const Card: Story = {
  render: () => (
    <SkeletonGroup className="col" style={{ gap: 8, maxWidth: 320 }}>
      <Skeleton variant="block" height={160} radius="var(--r-lg)" />
      <Skeleton variant="title" width="70%" />
      <Skeleton variant="text" width="40%" />
      <Skeleton variant="circle" width={40} />
    </SkeletonGroup>
  ),
};
