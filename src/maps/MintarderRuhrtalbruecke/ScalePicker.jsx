import { Fragment, useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { TRACK_COLOR_SCALES } from './trackColorScales';

const GROUP_LABELS = {
  legacy: 'Velocity ramps',
  brewer: 'ColorBrewer diverging',
};

const gradientFor = (colors) => `linear-gradient(to right, ${colors.join(', ')})`;

/**
 * Popup gradient picker for a track's colour scale.
 *
 * The trigger shows the selected gradient and label; the popup (portalled to
 * `document.body` so the map's overflow clipping cannot cut it off) lists every
 * scale as a gradient bar. The popup is positioned from the trigger rect,
 * flips above when there is more room there, and closes on selection, Escape,
 * outside pointerdown, scroll or resize.
 *
 * @param {Object} props
 * @param {string} props.value - Selected scale id.
 * @param {(scaleId: string) => void} props.onChange
 */
export default function ScalePicker({ value, onChange }) {
  const selected = TRACK_COLOR_SCALES.find((def) => def.id === value)
    ?? TRACK_COLOR_SCALES[0];
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const triggerRef = useRef(null);
  const popupRef = useRef(null);
  const popupId = useId();

  const close = useCallback(() => {
    setOpen(false);
    setPlacement(null);
  }, []);

  const openPopup = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const viewportW = window.innerWidth;
    const viewportH = window.innerHeight;
    const width = Math.min(Math.max(rect.width, 240), 320, viewportW - 16);
    const left = Math.min(
      Math.max(8, rect.left),
      Math.max(8, viewportW - width - 8),
    );
    const spaceBelow = viewportH - rect.bottom - 8;
    const spaceAbove = rect.top - 8;
    const openAbove = spaceBelow < 180 && spaceAbove > spaceBelow;
    const space = openAbove ? spaceAbove : spaceBelow;
    const maxHeight = Math.max(96, Math.min(viewportH * 0.6, 360, space - 4));
    setPlacement({
      left,
      width,
      maxHeight,
      ...(openAbove
        ? { bottom: viewportH - rect.top + 4 }
        : { top: rect.bottom + 4 }),
    });
    const index = TRACK_COLOR_SCALES.findIndex((def) => def.id === value);
    setActiveIndex(index >= 0 ? index : 0);
    setOpen(true);
  }, [value]);

  const select = useCallback((scaleId) => {
    onChange(scaleId);
    close();
    triggerRef.current?.focus();
  }, [onChange, close]);

  // Focus the popup so its keyboard handler and screen-reader context apply.
  useEffect(() => {
    if (!open) return undefined;
    popupRef.current?.focus();
    return undefined;
  }, [open]);

  // Dismiss on outside pointerdown and on any scroll/resize that would detach
  // the fixed-position popup from its trigger.
  useEffect(() => {
    if (!open) return undefined;
    const handlePointerDown = (event) => {
      if (popupRef.current?.contains(event.target)) return;
      if (triggerRef.current?.contains(event.target)) return;
      close();
    };
    // Page scroll/resize detaches the fixed popup; scrolling the popup's own
    // list must not close it.
    const handleScroll = (event) => {
      if (popupRef.current?.contains(event.target)) return;
      close();
    };
    const handleResize = () => close();
    document.addEventListener('pointerdown', handlePointerDown, true);
    window.addEventListener('scroll', handleScroll, { capture: true, passive: true });
    window.addEventListener('resize', handleResize);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true);
      window.removeEventListener('scroll', handleScroll, true);
      window.removeEventListener('resize', handleResize);
    };
  }, [open, close]);

  useEffect(() => {
    if (!open) return undefined;
    const handleKeyDown = (event) => {
      if (event.key === 'Tab') {
        // Let focus move on, but do not keep a detached popup open.
        close();
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
        triggerRef.current?.focus();
        return;
      }
      if (
        event.key === 'ArrowDown'
        || event.key === 'ArrowUp'
        || event.key === 'Home'
        || event.key === 'End'
      ) {
        event.preventDefault();
        setActiveIndex((index) => {
          if (event.key === 'Home') return 0;
          if (event.key === 'End') return TRACK_COLOR_SCALES.length - 1;
          const delta = event.key === 'ArrowDown' ? 1 : -1;
          return (index + delta + TRACK_COLOR_SCALES.length)
            % TRACK_COLOR_SCALES.length;
        });
        return;
      }
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        const def = TRACK_COLOR_SCALES[activeIndex];
        if (def) select(def.id);
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [open, activeIndex, select, close]);

  const popup = open && placement ? createPortal(
    <div
      id={popupId}
      ref={popupRef}
      role="listbox"
      tabIndex={-1}
      aria-label="Color scale"
      style={{
        position: 'fixed',
        left: placement.left,
        width: placement.width,
        maxHeight: placement.maxHeight,
        overflowY: 'auto',
        zIndex: 100,
        padding: 4,
        borderRadius: 6,
        border: '1px solid #ccc',
        background: '#fff',
        boxShadow: '0 4px 16px rgba(0, 0, 0, 0.2)',
        fontFamily: 'system-ui, sans-serif',
        fontSize: 11,
        color: '#333',
        outline: 'none',
        ...(placement.top != null ? { top: placement.top } : {}),
        ...(placement.bottom != null ? { bottom: placement.bottom } : {}),
      }}
    >
      {TRACK_COLOR_SCALES.map((def, index) => (
        <Fragment key={def.id}>
          {index === 0 || TRACK_COLOR_SCALES[index - 1].group !== def.group ? (
            <div
              aria-hidden="true"
              style={{
                padding: '4px 6px 2px',
                color: '#777',
                fontSize: 10,
                letterSpacing: 0.4,
                textTransform: 'uppercase',
              }}
            >
              {GROUP_LABELS[def.group]}
            </div>
          ) : null}
          <div
            role="option"
            aria-selected={def.id === value}
            onMouseEnter={() => setActiveIndex(index)}
            onClick={() => select(def.id)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '4px 6px',
              borderRadius: 4,
              cursor: 'pointer',
              background: index === activeIndex ? '#e6f0ff' : 'transparent',
              border: `1px solid ${def.id === value ? '#0066cc' : 'transparent'}`,
            }}
          >
            <span
              aria-hidden="true"
              style={{
                flexShrink: 0,
                width: 72,
                height: 12,
                borderRadius: 2,
                border: '1px solid #ccc',
                background: gradientFor(def.colors),
              }}
            />
            <span style={{ flex: 1, minWidth: 0 }}>{def.label}</span>
            {def.id === value ? (
              <span aria-hidden="true" style={{ color: '#0066cc' }}>✓</span>
            ) : null}
          </div>
        </Fragment>
      ))}
    </div>,
    document.body,
  ) : null;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? popupId : undefined}
        aria-label={`Color scale: ${selected.label}`}
        onClick={() => (open ? close() : openPopup())}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          width: '100%',
          minWidth: 0,
          padding: '3px 6px',
          border: '1px solid #bbb',
          borderRadius: 4,
          background: '#fff',
          color: '#333',
          cursor: 'pointer',
          fontFamily: 'inherit',
          fontSize: 11,
          textAlign: 'left',
        }}
      >
        <span
          aria-hidden="true"
          style={{
            flexShrink: 0,
            width: 40,
            height: 10,
            borderRadius: 2,
            border: '1px solid #ccc',
            background: gradientFor(selected.colors),
          }}
        />
        <span
          style={{
            flex: 1,
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {selected.label}
        </span>
        <span aria-hidden="true" style={{ flexShrink: 0, color: '#777' }}>▾</span>
      </button>
      {popup}
    </>
  );
}
