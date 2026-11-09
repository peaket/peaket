// CMP-030 Tabs 이야기(d2 §2 CMP-030)
import type { Meta, StoryObj } from '@storybook/react-vite';
import { SegmentedControl, Tabs } from './Tabs';
import { TabNav } from './TabNav';

const items = [
  { value: 'info', label: '공연 정보' },
  { value: 'cast', label: '출연진' },
  { value: 'review', label: '관람 후기', badge: 12 },
  { value: 'notice', label: '유의 사항', disabled: true },
];
const meta: Meta<typeof Tabs> = {
  title: 'CMP-030 Tabs',
  component: Tabs,
  args: { items, defaultValue: 'info', label: '공연 상세', children: (v: string) => <p className="t-md">{v} 내용</p> },
};
export default meta;
type Story = StoryObj<typeof Tabs>;

export const Default: Story = {};
export const Small: Story = { args: { size: 'sm' } };
export const Segmented: Story = {
  render: () => (
    <SegmentedControl
      label="보기 방식"
      items={[
        { value: 'map', label: '좌석맵' },
        { value: 'list', label: '목록' },
      ]}
      defaultValue="map"
    />
  ),
};
export const Nav: Story = {
  render: () => (
    <TabNav
      items={[
        { href: '#info', label: '공연 정보' },
        { href: '#cast', label: '출연진' },
      ]}
      current="#info"
    />
  ),
};
