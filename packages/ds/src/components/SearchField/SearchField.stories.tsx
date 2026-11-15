// CMP-004 SearchField 이야기: 한글 조합 중 키 처리(docs/features/search.md §3.4, SR-T10). BAT-165 웨이브 7 시험 담당이 둔 시험 받침(고르기·검색 수를 보인다)
import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { SearchField } from './SearchField';

const meta: Meta<typeof SearchField> = { title: 'CMP-004 SearchField', component: SearchField, args: { id: 'story-search' } };
export default meta;
type Story = StoryObj<typeof SearchField>;

/** 후보 창을 연 채 첫 후보를 고른 상태. 고르기·검색 수를 아래에 보인다(SR-T10 동작 검사) */
export const ImeGuard: Story = { render: () => <ImeGuardDemo /> };

function ImeGuardDemo() {
  const [selects, setSelects] = useState(0);
  const [submits, setSubmits] = useState(0);
  return (
    <div className="col" style={{ gap: 8, maxWidth: 420, minHeight: 320 }}>
      <SearchField
        id="ime-guard"
        defaultValue="루멘"
        open
        defaultActiveIndex={0}
        suggestions={[
          { id: 'p1', label: '루멘 콘서트 2026 서울', kind: 'production', match: '루멘' },
          { id: 'a1', label: '루멘', kind: 'artist', match: '루멘' },
        ]}
        onSelect={() => setSelects((n) => n + 1)}
        onSubmit={() => setSubmits((n) => n + 1)}
      />
      <p>
        고르기 <output data-testid="selects">{selects}</output> · 검색 <output data-testid="submits">{submits}</output>
      </p>
    </div>
  );
}
