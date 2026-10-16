import { useLayoutEffect, useRef, type ReactNode } from "react";

export function ScrollList({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  const ref = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const el = ref.current!;
    const edges = () => {
      const rect = el.getBoundingClientRect();
      const rows = [...el.querySelectorAll<HTMLElement>(".nav-item")].map((row) => row.getBoundingClientRect());
      el.dataset.fadeTop = String(rows.some((row) => row.top < rect.top - 1 && row.bottom > rect.top + 1));
      el.dataset.fadeBottom = String(rows.some((row) => row.top < rect.bottom - 1 && row.bottom > rect.bottom + 1));
    };
    const measure = () => {
      const row = el.querySelector<HTMLElement>(".nav-item");
      if (row && el.parentElement) {
        const gap = parseFloat(getComputedStyle(el).rowGap) || 0;
        const heading = el.parentElement.querySelector(".rail-section-toggle")!.getBoundingClientRect().height;
        const available = el.parentElement.clientHeight - heading;
        const height = row.getBoundingClientRect().height;
        const slots = Math.max(1, Math.floor((available + gap + 0.1) / (height + gap)));
        el.style.height = `${slots * (height + gap) - gap}px`;
      }
      edges();
    };
    const observer = new ResizeObserver(measure);
    observer.observe(el.parentElement!); observer.observe(el);
    if (el.firstElementChild) observer.observe(el.firstElementChild);
    el.addEventListener("scroll", edges, { passive: true }); measure();
    return () => { observer.disconnect(); el.removeEventListener("scroll", edges); };
  }, [children]);
  return <nav id={id} aria-label={label} ref={ref} className="scroll-list">{children}</nav>;
}
