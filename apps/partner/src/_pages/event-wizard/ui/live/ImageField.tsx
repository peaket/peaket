'use client';
// 1단계 포스터·상세 이미지(CMP-069 MediaUploader 제어형, d5 §6.4, ADR-0257 결정 4).
// 고른 파일은 탭 메모리에만 있고([공연 등록]이 성공한 뒤 포스터부터 한 장씩 올린다), 임시저장에는 대체 텍스트·순서만 들어간다.
// 임시저장에서 되돌렸는데 파일이 없는 줄은 "이미지는 다시 골라 주세요"로 알리고, 그 줄의 [파일 고르기]로 한 장씩 채운다
// (어느 대체 텍스트가 어느 그림인지 사람이 정한다. 여러 장을 한꺼번에 고르면 새 줄로 붙는다, BAT-145 리뷰).
import { MediaUploader, type MediaItem } from '@peaket/ds/MediaUploader';
import { IMAGE_MAX, IMAGE_TEXT, altIssue, moveImage, placePicked, type ImageDraft } from '../../model/images';
import { FieldMessage } from './fields';
import { pickedIssue, type PickedImage } from './image-files';

const HINT =
  '여러 장을 한 번에 고를 수 있고 첫 이미지가 포스터입니다. JPEG·PNG·WebP, 한 장 10MB까지입니다. 포스터는 가로 800px·세로 1,000px 이상의 세로형, 상세 이미지는 가로 800px 이상이고 10장까지입니다. 이미지는 공연을 등록한 뒤 한 장씩 올립니다.';

export interface ImageFieldProps {
  images: readonly ImageDraft[];
  files: ReadonlyMap<string, PickedImage>;
  onImages: (next: ImageDraft[]) => void;
  attach: (pairs: readonly [string, File][]) => void;
  drop: (key: string) => void;
  /** 오류 요약에서 온 이미지 오류(있으면 줄마다 대체 텍스트 오류도 보인다) */
  error: string | undefined;
  disabled?: boolean;
  /** 고른 파일이 11장을 넘어 놓지 못했다 */
  onOverflow: (n: number) => void;
  overflow: number;
}

export function ImageField({ images, files, onImages, attach, drop, error, disabled, onOverflow, overflow }: ImageFieldProps) {
  const missing = images.filter((x) => !files.has(x.key)).length;
  const items: MediaItem[] = images.map((img, i) => {
    const f = files.get(img.key);
    const issue = f ? pickedIssue(f, i) : IMAGE_TEXT.repick;
    const altError = error ? (altIssue(img.alt) ?? undefined) : undefined;
    const item: MediaItem = { id: img.key, fileName: f ? f.file.name : '고른 파일 없음', status: issue ? 'error' : 'ready', alt: img.alt };
    if (!f) item.refill = true;
    if (issue) item.error = issue;
    if (altError) item.altError = altError;
    if (f) item.preview = <img src={f.preview} alt="" width={52} height={69} style={{ width: 52, height: 69, objectFit: 'cover', flex: 'none', borderRadius: 'var(--r-sm)' }} />;
    return item;
  });

  function pick(picked: File[]) {
    const r = placePicked(images, picked.length, () => crypto.randomUUID());
    onImages(r.list);
    attach(r.assigned.map((key, i) => [key, picked[i]!] as [string, File]));
    onOverflow(r.overflow);
  }

  return (
    <div className="field" id="w-images" tabIndex={-1} style={{ outline: 'none' }}>
      <span className="label" id="w-images-l">
        포스터·상세 이미지 <span className="opt">(포스터는 판매 승인 요청에 필요합니다)</span>
      </span>
      {missing > 0 ? (
        <div className="banner banner-warning" role="status">
          <i className="ic ic-alert" aria-hidden="true" />
          <div className="banner-body">이미지는 다시 골라 주세요. 이 브라우저에는 대체 텍스트와 순서만 임시저장합니다({missing}장). 줄마다 [파일 고르기]로 그 대체 텍스트에 맞는 그림을 고릅니다</div>
        </div>
      ) : null}
      <MediaUploader
        items={items}
        hint={HINT}
        maxDetail={IMAGE_MAX - 1}
        disabled={disabled}
        onPick={pick}
        onAltChange={(key, alt) => onImages(images.map((x) => (x.key === key ? { ...x, alt } : x)))}
        onMove={(key, dir) => onImages(moveImage(images, key, dir))}
        onRemove={(key) => {
          onImages(images.filter((x) => x.key !== key));
          drop(key);
        }}
        onRefill={(key, file) => attach([[key, file]])}
      />
      {overflow > 0 ? (
        <span className="error-msg" role="alert">
          <i className="ic ic-alert-circle" aria-hidden="true" />
          {IMAGE_TEXT.count}
        </span>
      ) : null}
      <FieldMessage id="w-images" error={error} />
    </div>
  );
}
