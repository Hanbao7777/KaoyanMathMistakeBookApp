import { ExternalLink, FolderOpen, Minus, Plus, RotateCcw, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { ImageUrlResult, QuestionImage } from '../../shared/types';
import { useToast } from './Toast';

interface GalleryItem {
  image: QuestionImage;
  info: ImageUrlResult | null;
}

interface ImageGalleryProps {
  images: QuestionImage[];
  emptyText: string;
}

export function ImageGallery({ images, emptyText }: ImageGalleryProps) {
  const showDebugInfo = Boolean((import.meta as ImportMeta & { env?: { DEV?: boolean } }).env?.DEV);
  const { toast } = useToast();
  const [items, setItems] = useState<GalleryItem[]>([]);
  const [preview, setPreview] = useState<GalleryItem | null>(null);
  const [failedIds, setFailedIds] = useState<Set<number>>(new Set());
  const [previewFailed, setPreviewFailed] = useState(false);
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const dragRef = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);

  useEffect(() => {
    let cancelled = false;
    setFailedIds(new Set());
    Promise.all(
      images.map(async (image) => ({
        image,
        info: await window.api.getImageUrl(image.file_path)
      }))
    )
      .then((next) => {
        if (!cancelled) setItems(next);
      })
      .catch(() => {
        if (!cancelled) setItems(images.map((image) => ({ image, info: null })));
      });
    return () => {
      cancelled = true;
    };
  }, [images]);

  function openPreview(item: GalleryItem) {
    setPreview(item);
    setPreviewFailed(false);
    setScale(1);
    setOffset({ x: 0, y: 0 });
  }

  function changeScale(next: number) {
    setScale(Math.min(5, Math.max(0.4, next)));
  }

  async function openOriginal(imagePath: string) {
    try {
      await window.api.openImage(imagePath);
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), 'error');
    }
  }

  async function revealOriginal(imagePath: string) {
    try {
      await window.api.revealImageInFolder(imagePath);
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), 'error');
    }
  }

  function renderDebug(item: GalleryItem) {
    if (!showDebugInfo) return null;
    return (
      <div className="image-debug">
        <span>数据库 image_path：{item.image.file_path}</span>
        {item.info?.resolvedPath ? <span>解析后路径：{item.info.resolvedPath}</span> : null}
      </div>
    );
  }

  function renderMissing(item: GalleryItem, message = '图片文件不存在，请检查导入路径') {
    return (
      <div className="image-missing">
        <strong>{message}</strong>
        {renderDebug(item)}
      </div>
    );
  }

  if (!images.length) return <div className="image-empty">{emptyText}</div>;

  return (
    <>
      <div className="image-grid large">
        {items.map((item) => {
          const isBroken = failedIds.has(item.image.id);
          if (!item.info?.exists) return <div key={item.image.id}>{renderMissing(item)}</div>;
          if (isBroken) return <div key={item.image.id}>{renderMissing(item, '图片加载失败，请检查文件是否存在')}</div>;

          return (
            <div className="image-card" key={item.image.id}>
              <button className="image-preview-button" type="button" onClick={() => openPreview(item)}>
                <img
                  src={item.info.url}
                  alt="错题原图"
                  onError={() => setFailedIds((current) => new Set(current).add(item.image.id))}
                />
              </button>
              {renderDebug(item)}
              <div className="thumbnail-actions">
                <button type="button" className="secondary-button" onClick={() => openOriginal(item.image.file_path)}>
                  <ExternalLink size={16} />
                  打开原图
                </button>
                <button type="button" className="secondary-button" onClick={() => revealOriginal(item.image.file_path)}>
                  <FolderOpen size={16} />
                  所在文件夹
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {preview?.info?.exists ? (
        <div className="image-modal" onClick={() => setPreview(null)}>
          <div className="image-modal-inner zoomable" onClick={(event) => event.stopPropagation()}>
            <div className="image-modal-actions">
              <button type="button" className="icon-button" title="缩小" onClick={() => changeScale(scale - 0.2)}>
                <Minus size={16} />
              </button>
              <button type="button" className="icon-button" title="放大" onClick={() => changeScale(scale + 0.2)}>
                <Plus size={16} />
              </button>
              <button
                type="button"
                className="icon-button"
                title="重置"
                onClick={() => {
                  setScale(1);
                  setOffset({ x: 0, y: 0 });
                }}
              >
                <RotateCcw size={16} />
              </button>
              <button type="button" className="secondary-button" onClick={() => openOriginal(preview.image.file_path)}>
                <ExternalLink size={16} />
                打开原图
              </button>
              <button type="button" className="secondary-button" onClick={() => revealOriginal(preview.image.file_path)}>
                <FolderOpen size={16} />
                所在文件夹
              </button>
              <button type="button" className="icon-button" onClick={() => setPreview(null)} title="关闭">
                <X size={18} />
              </button>
            </div>
            <div
              className="image-zoom-stage"
              onWheel={(event) => {
                event.preventDefault();
                changeScale(scale + (event.deltaY > 0 ? -0.15 : 0.15));
              }}
              onPointerDown={(event) => {
                dragRef.current = { x: event.clientX, y: event.clientY, ox: offset.x, oy: offset.y };
                event.currentTarget.setPointerCapture(event.pointerId);
              }}
              onPointerMove={(event) => {
                const drag = dragRef.current;
                if (!drag) return;
                setOffset({ x: drag.ox + event.clientX - drag.x, y: drag.oy + event.clientY - drag.y });
              }}
              onPointerUp={() => {
                dragRef.current = null;
              }}
            >
              {previewFailed ? (
                <div className="image-load-error">图片加载失败，请检查文件是否存在</div>
              ) : (
                <img
                  src={preview.info.url}
                  alt="错题原图大图预览"
                  draggable={false}
                  onError={() => setPreviewFailed(true)}
                  style={{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})` }}
                />
              )}
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
