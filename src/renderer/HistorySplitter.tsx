import { useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';

const STORAGE_KEY = 'svn-workspace.history-width';
const MIN_HISTORY_WIDTH = 220;
const MIN_DETAIL_WIDTH = 600;

function savedWidth(): number | null {
  try {
    const value = Number(localStorage.getItem(STORAGE_KEY));
    return Number.isFinite(value) && value >= MIN_HISTORY_WIDTH ? value : null;
  } catch {
    return null;
  }
}

function clampWidth(value: number, available: number): number {
  return Math.round(Math.max(MIN_HISTORY_WIDTH, Math.min(value, Math.max(MIN_HISTORY_WIDTH, available - MIN_DETAIL_WIDTH))));
}

/** Keep resizing state local so pointer movement does not re-render the SVN views. */
export function ResizableWorkspace({ children, className = '' }: { children: ReactNode; className?: string }) {
  const container = useRef<HTMLElement>(null);
  const [initialWidth] = useState(savedWidth);
  const preferredWidth = useRef<number | null>(initialWidth);
  const drag = useRef<{ id: number; startX: number; startWidth: number } | null>(null);
  const [available, setAvailable] = useState(0);
  const [width, setWidth] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);

  useLayoutEffect(() => {
    const element = container.current;
    if (!element) return;
    const measure = () => {
      const size = element.getBoundingClientRect().width;
      setAvailable(size);
      setWidth(clampWidth(preferredWidth.current ?? size * 0.28, size));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const updateWidth = (next: number) => {
    const size = container.current?.getBoundingClientRect().width ?? available;
    const clamped = clampWidth(next, size);
    preferredWidth.current = clamped;
    setWidth(clamped);
    return clamped;
  };

  const persist = () => {
    if (preferredWidth.current === null) return;
    try { localStorage.setItem(STORAGE_KEY, String(preferredWidth.current)); } catch { /* Resizing still works if storage is unavailable. */ }
  };

  const startDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (!event.isPrimary || event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.focus();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { id: event.pointerId, startX: event.clientX, startWidth: width ?? available * 0.28 };
    setDragging(true);
  };

  const moveDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.id !== event.pointerId) return;
    updateWidth(drag.current.startWidth + event.clientX - drag.current.startX);
  };

  const endDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.id !== event.pointerId) return;
    drag.current = null;
    setDragging(false);
    persist();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const current = width ?? available * 0.28;
    const step = event.shiftKey ? 40 : 10;
    const next = event.key === 'ArrowLeft' ? current - step
      : event.key === 'ArrowRight' ? current + step
      : event.key === 'Home' ? MIN_HISTORY_WIDTH
      : event.key === 'End' ? available - MIN_DETAIL_WIDTH : null;
    if (next === null) return;
    event.preventDefault();
    updateWidth(next);
    persist();
  };

  return <main ref={container} className={`workspace ${className} ${dragging ? 'is-resizing' : ''}`.trim()} style={width === null ? undefined : { gridTemplateColumns: `${width}px minmax(0, 1fr)` }}>
    {children}
    <div
      className="history-splitter"
      role="separator"
      aria-label="커밋 목록 너비 조절"
      aria-orientation="vertical"
      aria-valuemin={MIN_HISTORY_WIDTH}
      aria-valuemax={Math.max(MIN_HISTORY_WIDTH, Math.round(available - MIN_DETAIL_WIDTH))}
      aria-valuenow={width ?? MIN_HISTORY_WIDTH}
      aria-valuetext={`${width ?? MIN_HISTORY_WIDTH}픽셀`}
      title="드래그하여 커밋 목록 너비 조절 · 방향키로 조절"
      tabIndex={0}
      style={{ left: width ?? '28%' }}
      onPointerDown={startDrag}
      onPointerMove={moveDrag}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onLostPointerCapture={endDrag}
      onKeyDown={onKeyDown}
    />
  </main>;
}
