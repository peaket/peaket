'use client';
// 위저드가 고른 이미지 파일을 탭 메모리에만 들고 있는 상태(ADR-0257 결정 4). 임시저장(브라우저 저장소)에는 넣지 않는다.
// 고르면 파일 앞부분으로 형식·10MB·움직이는 이미지를 보고, 앞부분의 크기로 화소 상한을 본 뒤 브라우저가 디코딩해 해상도를 읽는다.
// 미리보기는 blob: 주소(묶음 B CSP img-src가 받는다)이고 줄을 빼거나 화면을 떠나면 돌려준다.
import { useCallback, useEffect, useRef, useState } from 'react';
import { fileIssue, headerSize, IMAGE_TEXT, imageKind, sizeIssue, type ImageFileState } from '../../model/images';

/** 앞부분으로 읽는 크기(JPEG의 큰 EXIF 뒤 SOF까지 닿게) */
const HEAD_BYTES = 256 * 1024;

export interface PickedImage {
  file: File;
  preview: string;
  /** 형식·크기 검사(아직 보는 중이면 undefined) */
  fileIssue?: string | null;
  /** 디코딩한 크기. 읽지 못했으면 'unreadable', 화소 상한을 넘어 디코딩하지 않았으면 'too-many' */
  size?: { width: number; height: number } | 'unreadable' | 'too-many';
}

async function inspect(file: File): Promise<Pick<PickedImage, 'fileIssue' | 'size'>> {
  const head = new Uint8Array(await file.slice(0, HEAD_BYTES).arrayBuffer());
  const issue = fileIssue({ head, type: file.type, name: file.name, size: file.size });
  if (issue) return { fileIssue: issue };
  const declared = headerSize(head);
  if (declared && sizeIssue('DETAIL', declared.width, declared.height) === IMAGE_TEXT.pixels) return { fileIssue: null, size: 'too-many' };
  try {
    const bmp = await createImageBitmap(file);
    const size = { width: bmp.width, height: bmp.height };
    bmp.close();
    return { fileIssue: null, size };
  } catch {
    return { fileIssue: null, size: 'unreadable' };
  }
}

/** 줄 차례(첫 줄이 포스터)를 알고 본 화면 검사 결과. 아직 보는 중이면 undefined */
export function pickedIssue(p: PickedImage, index: number): string | null | undefined {
  if (p.fileIssue) return p.fileIssue;
  if (p.fileIssue === undefined || p.size === undefined) return undefined;
  if (p.size === 'unreadable') return IMAGE_TEXT.unreadable;
  if (p.size === 'too-many') return IMAGE_TEXT.pixels;
  return sizeIssue(imageKind(index), p.size.width, p.size.height);
}

export function fileState(files: ReadonlyMap<string, PickedImage>, keys: readonly string[]): (key: string) => ImageFileState {
  return (key) => {
    const p = files.get(key);
    return p ? { hasFile: true, issue: pickedIssue(p, keys.indexOf(key)) } : { hasFile: false };
  };
}

export function useImageFiles() {
  const [files, setFiles] = useState<ReadonlyMap<string, PickedImage>>(() => new Map());
  const live = useRef(files);
  live.current = files;

  /** 검사 결과를 단다. 그사이 그 줄의 파일이 바뀌었으면 버린다 */
  const patch = useCallback((key: string, file: File, p: Partial<PickedImage>) => {
    setFiles((m) => {
      const cur = m.get(key);
      if (!cur || cur.file !== file) return m;
      const next = new Map(m);
      next.set(key, { ...cur, ...p });
      return next;
    });
  }, []);

  /** 줄 키마다 파일을 단다(그 줄의 옛 파일은 놓는다) */
  const attach = useCallback(
    (pairs: readonly [string, File][]) => {
      for (const [key] of pairs) {
        const old = live.current.get(key);
        if (old) URL.revokeObjectURL(old.preview);
      }
      const made = pairs.map(([key, file]) => [key, { file, preview: URL.createObjectURL(file) }] as const);
      setFiles((m) => {
        const next = new Map(m);
        for (const [key, p] of made) next.set(key, p);
        return next;
      });
      for (const [key, file] of pairs) void inspect(file).then((r) => patch(key, file, r));
    },
    [patch],
  );

  const drop = useCallback((key: string) => {
    const old = live.current.get(key);
    if (!old) return;
    URL.revokeObjectURL(old.preview);
    setFiles((m) => {
      const next = new Map(m);
      next.delete(key);
      return next;
    });
  }, []);

  const clear = useCallback(() => {
    for (const p of live.current.values()) URL.revokeObjectURL(p.preview);
    setFiles(new Map());
  }, []);

  useEffect(() => () => {
    for (const p of live.current.values()) URL.revokeObjectURL(p.preview);
  }, []);

  return { files, attach, drop, clear };
}
