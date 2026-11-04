// CMP-018 Toast 이야기(d2 §2 CMP-018). 정적 모양과, Toaster로 띄우는 동작
import type { Meta, StoryObj } from '@storybook/react-vite';
import { Toast } from './Toast';
import { Toaster } from './Toaster';
import { toast } from './store';

const meta: Meta<typeof Toast> = { title: 'CMP-018 Toast', component: Toast, args: { children: '찜 목록에 담았습니다' } };
export default meta;
type Story = StoryObj<typeof Toast>;

export const Success: Story = {};
export const Info: Story = { args: { tone: 'info', children: '대기 순서가 바뀌었습니다' } };
export const Failure: Story = { args: { tone: 'error', children: '저장하지 못했습니다. 다시 시도해 주세요' } };
export const WithAction: Story = {
  args: {
    action: (
      // 보드의 토스트 행동 링크: link-more에 반전 글자색(apps/web 장바구니 토스트와 같다)
      <a className="link-more" href="#wish" style={{ color: 'var(--on-inverse)' }}>
        찜 목록 보기
        <i className="ic ic-chevron-right" aria-hidden="true" />
      </a>
    ),
  },
};
/** 버튼을 누르면 Toaster가 띄우고 5초 뒤 사라진다(알림 영역 role=status) */
export const Live: Story = {
  render: () => (
    <div>
      <button type="button" className="btn btn-primary" onClick={() => toast('찜 목록에 담았습니다')}>
        찜하기
      </button>
      <Toaster />
    </div>
  ),
};
