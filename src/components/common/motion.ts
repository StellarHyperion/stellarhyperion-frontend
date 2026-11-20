"use client";

import { useEffect, useState } from "react";

const QUERY = "(prefers-reduced-motion: reduce)";

/**
 * Live view of the visitor's reduced-motion preference.
 *
 * CSS already collapses durations, but a transition or an opening dialog can be created in the
 * same frame the preference changes. Reading the preference here lets components mark themselves
 * so the static state, not an animation frame, is what the visitor sees.
 */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const media = window.matchMedia(QUERY);
    const update = () => setReduced(media.matches);
    update();
    media.addEventListener("change", update);
    return () => {
      media.removeEventListener("change", update);
    };
  }, []);
  return reduced;
}
