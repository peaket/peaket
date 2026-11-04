// CMP-002 Link 이야기(d2 §2 CMP-002)
import type { Meta, StoryObj } from '@storybook/react-vite';
import { Link } from './Link';

const meta: Meta<typeof Link> = { title: 'CMP-002 Link', component: Link, args: { href: '#detail', children: '공연 상세 보기' } };
export default meta;
type Story = StoryObj<typeof Link>;

export const Inline: Story = {
  render: (a) => (
    <p className="t-md">
      예매 전에 <Link {...a} /> 안내를 읽어 주세요.
    </p>
  ),
};
export const More: Story = { args: { variant: 'more', children: '전체 보기' } };
export const External: Story = { args: { external: true, newTab: true, href: 'https://example.com', children: '결제사 안내' } };
export const Tile: Story = { args: { variant: 'tile', icon: 'ticket', children: '콘서트' } };
