'use client';
// CMP-070 서식 글 편집기 후보 Tiptap(FE-T41 PoC). 허용 서식(문단·줄바꿈·굵게·목록·제목 2·3)만 켜고 나머지 확장은 끈다.
// 기본으로 <style>을 넣는 것은 끈다(injectCSS: false, CSP style-src nonce, docs/frontend.md FE-T41). 저장은 getJSON()을 구조 문서로 바꾼다(doc.ts fromTiptap).
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { fromTiptap, type PeaketDoc } from './doc';
import { precleanPastedHtml } from './paste';

export default function TiptapEditor({ onSave }: { onSave: (doc: PeaketDoc) => void }) {
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [2, 3] },
        blockquote: false,
        code: false,
        codeBlock: false,
        horizontalRule: false,
        italic: false,
        strike: false,
        link: false,
        underline: false,
      }),
    ],
    injectCSS: false,
    immediatelyRender: false,
    // 붙여넣은 HTML은 ProseMirror가 해석하기 전에 걷어 낸다(paste.ts). 해석 자체(DOMParser)는 ProseMirror 안이라 Trusted Types 정책을 넘길 수 없다
    editorProps: {
      transformPastedHTML: precleanPastedHtml,
      attributes: { class: 'input', role: 'textbox', 'aria-multiline': 'true', 'aria-label': '공연 설명', 'data-testid': 'editor', style: 'min-height:160px' },
    },
  });
  return (
    <div className="col" style={{ gap: 8 }}>
      <div className="row wrap" role="toolbar" aria-label="서식" style={{ gap: 6 }}>
        <button className="btn btn-outline btn-sm" type="button" onClick={() => editor?.chain().focus().toggleBold().run()}>
          굵게
        </button>
        <button className="btn btn-outline btn-sm" type="button" onClick={() => editor?.chain().focus().toggleHeading({ level: 2 }).run()}>
          제목
        </button>
        <button className="btn btn-outline btn-sm" type="button" onClick={() => editor?.chain().focus().setParagraph().run()}>
          문단
        </button>
        <button className="btn btn-outline btn-sm" type="button" onClick={() => editor?.chain().focus().toggleBulletList().run()}>
          글머리 목록
        </button>
        <button className="btn btn-outline btn-sm" type="button" onClick={() => editor?.chain().focus().toggleOrderedList().run()}>
          번호 목록
        </button>
        <button className="btn btn-primary btn-sm" type="button" data-testid="save" onClick={() => editor && onSave(fromTiptap(editor.getJSON()))}>
          저장
        </button>
      </div>
      <EditorContent editor={editor} />
    </div>
  );
}
