// 미리보기: 맨 바깥에 키트 루트 class="pk"(다크는 "pk dark")를 붙이고, 도구 막대의 테마로 라이트·다크를 고른다.
// 이야기 주소에 &globals=theme:dark를 붙이면 다크로 연다(FE-T40이 쓴다).
import './preview.css';
import type { Decorator, Preview } from '@storybook/react-vite';
import { useEffect } from 'react';

const withKitRoot: Decorator = (Story, ctx) => {
  const dark = ctx.globals.theme === 'dark';
  useEffect(() => {
    // Storybook이 body에 단 클래스(sb-show-main 등)는 두고 키트 루트 클래스만 붙인다
    document.body.classList.add('pk');
    document.body.classList.toggle('dark', dark);
    document.documentElement.dataset.seedColorMode = dark ? 'dark-only' : 'light-only';
    document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
  }, [dark]);
  return <Story />;
};

const preview: Preview = {
  decorators: [withKitRoot],
  globalTypes: {
    theme: {
      description: '키트 테마',
      toolbar: { title: '테마', items: [{ value: 'light', title: '라이트' }, { value: 'dark', title: '다크' }], dynamicTitle: true },
    },
  },
  initialGlobals: { theme: 'light' },
  parameters: {
    layout: 'padded',
    // 접근성 검사(addon-a11y): 위반은 오류로 본다. WCAG 2.2 AA 규칙과 대상 크기 규칙을 켠다(FE-T18, docs/frontend.md §5.13)
    a11y: { test: 'error', options: { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] } } },
  },
};

export default preview;
