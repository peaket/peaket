// CMP-004 WebSearchBox 이야기: 머리 검색창의 한글 조합 중 키 처리(docs/features/search.md §3.4, SR-T10). BAT-165 웨이브 7 시험 담당이 둔 시험 받침(이동 수를 보인다)
import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { WebSearchBox } from './WebSearchBox';

const meta: Meta<typeof WebSearchBox> = { title: 'CMP-004 WebSearchBox', component: WebSearchBox, args: { action: '/search' } };
export default meta;
type Story = StoryObj<typeof WebSearchBox>;

/** 검색어를 넣은 머리 검색창. Enter가 검색 화면으로 이동한 수와 마지막 주소를 아래에 보인다(SR-T10 동작 검사) */
export const ImeGuard: Story = { render: () => <ImeGuardDemo /> };

function ImeGuardDemo() {
  const [count, setCount] = useState(0);
  const [last, setLast] = useState('');
  return (
    <div className="col" style={{ gap: 8, maxWidth: 560, minHeight: 320 }}>
      <WebSearchBox
        action="/search"
        layout="bar"
        defaultValue="루멘"
        onNavigate={(href) => {
          setCount((n) => n + 1);
          setLast(href);
        }}
      />
      <p>
        이동 <output data-testid="navigations">{count}</output> · <output data-testid="last-href">{last}</output>
      </p>
    </div>
  );
}
