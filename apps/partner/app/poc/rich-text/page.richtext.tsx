// 서식 글 편집기 PoC(FE-T41, BUILD_ORDER HOT-322). PoC 빌드(PEAKET_POC=rich-text)에서만 경로가 된다(next.config.ts pageExtensions 'richtext.tsx').
// SEED CSS PoC 빌드(poc.tsx)와 확장자를 나눠 서로의 빌드에 섞이지 않는다.
// 묶음 B CSP와 Trusted Types 보고 모드는 proxy.ts가 이 경로에만 단다.
import { RichTextPoc } from '@/features/rich-text/RichTextPoc';

export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  return <RichTextPoc editor={sp.editor === 'tiptap' ? 'tiptap' : 'lexical'} />;
}
