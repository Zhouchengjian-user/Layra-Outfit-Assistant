"use client";

/* Dynamic wardrobe image URLs cannot use a fixed Next Image loader. */
/* eslint-disable @next/next/no-img-element */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type SyntheticEvent,
} from "react";

type WardrobeCarouselItem = {
  id: string;
  name: string;
  imageUrl: string;
};

type WardrobeCarouselProps = {
  items: WardrobeCarouselItem[];
  onAdd: () => void;
  onImageError: (event: SyntheticEvent<HTMLImageElement>) => void;
};

type CarouselPosition = {
  first: number;
  visible: number;
  atStart: boolean;
  atEnd: boolean;
};

const initialPosition: CarouselPosition = { first: 0, visible: 3, atStart: true, atEnd: false };

function ArrowIcon() {
  return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5 12h14M14 7l5 5-5 5" /></svg>;
}

export function WardrobeCarousel({ items, onAdd, onImageError }: WardrobeCarouselProps) {
  const rootRef = useRef<HTMLElement>(null);
  const railRef = useRef<HTMLDivElement>(null);
  const hoveredRef = useRef(false);
  const pauseUntilRef = useRef(0);
  const dragRef = useRef({ active: false, pointerId: -1, x: 0, left: 0 });
  const [position, setPosition] = useState(initialPosition);

  const readPosition = useCallback(() => {
    const rail = railRef.current;
    const firstCard = rail?.querySelector<HTMLElement>(".reference-closet-item");
    if (!rail || !firstCard) return;

    const styles = window.getComputedStyle(rail);
    const gap = Number.parseFloat(styles.columnGap || styles.gap || "0") || 0;
    const step = firstCard.getBoundingClientRect().width + gap;
    const visible = Math.max(1, Math.round((rail.clientWidth + gap) / step));
    const first = Math.max(0, Math.min(items.length - 1, Math.round(rail.scrollLeft / step)));
    const maxScroll = Math.max(0, rail.scrollWidth - rail.clientWidth);
    const next = {
      first,
      visible,
      atStart: rail.scrollLeft <= 2,
      atEnd: rail.scrollLeft >= maxScroll - 2,
    };
    setPosition(current => current.first === next.first
      && current.visible === next.visible
      && current.atStart === next.atStart
      && current.atEnd === next.atEnd ? current : next);
  }, [items.length]);

  const scrollByItem = useCallback((direction: -1 | 1, pauseAfter = true) => {
    const rail = railRef.current;
    const firstCard = rail?.querySelector<HTMLElement>(".reference-closet-item");
    if (!rail || !firstCard) return;
    const styles = window.getComputedStyle(rail);
    const gap = Number.parseFloat(styles.columnGap || styles.gap || "0") || 0;
    const distance = direction * (firstCard.getBoundingClientRect().width + gap);
    if (!pauseAfter) {
      rail.scrollBy({ left: distance, behavior: "smooth" });
      return;
    }
    const previousBehavior = rail.style.scrollBehavior;
    rail.style.scrollBehavior = "auto";
    rail.scrollLeft = Math.max(0, Math.min(rail.scrollWidth - rail.clientWidth, rail.scrollLeft + distance));
    readPosition();
    window.setTimeout(() => { rail.style.scrollBehavior = previousBehavior; }, 0);
    if (pauseAfter) pauseUntilRef.current = Date.now() + 6000;
  }, [readPosition]);

  useEffect(() => {
    const rail = railRef.current;
    if (!rail) return;
    rail.scrollTo({ left: 0, behavior: "auto" });
    readPosition();
    const observer = new ResizeObserver(readPosition);
    observer.observe(rail);
    return () => observer.disconnect();
  }, [items.length, readPosition]);

  useEffect(() => {
    if (items.length <= position.visible || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const interval = window.setInterval(() => {
      const rail = railRef.current;
      if (!rail || hoveredRef.current || Date.now() < pauseUntilRef.current || rootRef.current?.contains(document.activeElement)) return;
      if (rail.scrollLeft >= rail.scrollWidth - rail.clientWidth - 2) {
        rail.scrollTo({ left: 0, behavior: "smooth" });
      } else {
        scrollByItem(1, false);
      }
    }, 4200);
    return () => window.clearInterval(interval);
  }, [items.length, position.visible, scrollByItem]);

  const stopDragging = (event: PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current.active) return;
    dragRef.current.active = false;
    event.currentTarget.classList.remove("is-dragging");
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    pauseUntilRef.current = Date.now() + 6000;
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    scrollByItem(event.key === "ArrowLeft" ? -1 : 1);
  };

  const lastVisible = Math.min(items.length, position.first + position.visible);

  return <section
    ref={rootRef}
    className="reference-upload-card clothes has-image reference-wardrobe-carousel"
    aria-labelledby="home-wardrobe-title"
    onMouseEnter={() => { hoveredRef.current = true; }}
    onMouseLeave={() => { hoveredRef.current = false; }}
  >
    <div className="reference-upload-label">
      <b id="home-wardrobe-title">我的衣柜</b>
      <small>{items.length} 件可搭配</small>
    </div>

    <div className="reference-closet-stage">
      <button
        type="button"
        className="reference-closet-arrow previous"
        aria-label="查看上一件衣物"
        disabled={position.atStart}
        onClick={() => scrollByItem(-1)}
      ><ArrowIcon /></button>

      <div
        ref={railRef}
        className="reference-clothes-preview"
        role="region"
        aria-label="衣柜衣物，可左右滑动"
        tabIndex={0}
        onScroll={readPosition}
        onKeyDown={handleKeyDown}
        onPointerDown={event => {
          pauseUntilRef.current = Date.now() + 6000;
          if (event.pointerType !== "mouse" || event.button !== 0) return;
          dragRef.current = { active: true, pointerId: event.pointerId, x: event.clientX, left: event.currentTarget.scrollLeft };
          event.currentTarget.setPointerCapture(event.pointerId);
          event.currentTarget.classList.add("is-dragging");
        }}
        onPointerMove={event => {
          if (!dragRef.current.active || dragRef.current.pointerId !== event.pointerId) return;
          event.preventDefault();
          event.currentTarget.scrollLeft = dragRef.current.left - (event.clientX - dragRef.current.x);
        }}
        onPointerUp={stopDragging}
        onPointerCancel={stopDragging}
      >
        {items.map(item => <figure className="reference-closet-item" key={item.id}>
          <img src={item.imageUrl} alt={item.name} draggable={false} onError={onImageError} />
          <figcaption>{item.name}</figcaption>
        </figure>)}
      </div>

      <button
        type="button"
        className="reference-closet-arrow next"
        aria-label="查看下一件衣物"
        disabled={position.atEnd}
        onClick={() => scrollByItem(1)}
      ><ArrowIcon /></button>
    </div>

    <div className="reference-closet-footer">
      <span>{position.first + 1}–{lastVisible} / {items.length}</span>
      <span className="reference-closet-swipe-hint">左右滑动查看</span>
      <button type="button" onClick={onAdd}>＋ 添加衣物</button>
    </div>
  </section>;
}
