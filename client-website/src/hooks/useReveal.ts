'use client';

import { useEffect, useRef, type RefObject } from 'react';

/**
 * Mounts an IntersectionObserver on the returned ref. Any descendant
 * element with class `.reveal` gets `.visible` added when it scrolls
 * into view (threshold 0.15 + 40px bottom margin so the trigger fires
 * just before the element fully enters the viewport).
 *
 * Used to drive the fade-up-on-scroll choreography spec'd in the
 * landing-page design (matches Eversay's pattern, ported simplified).
 *
 * @returns ref — attach to the wrapping container of revealable items.
 */
export function useReveal<T extends HTMLElement = HTMLDivElement>(): RefObject<T> {
  const ref = useRef<T>(null);

  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            entry.target.classList.add('visible');
            observer.unobserve(entry.target);
          }
        }
      },
      { threshold: 0.15, rootMargin: '0px 0px -40px 0px' },
    );
    const items = root.querySelectorAll('.reveal');
    items.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, []);

  return ref;
}
