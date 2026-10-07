import { describe, expect, it } from "vitest";
import {
  CENTRE_Y,
  DESTINATION_X,
  ORIGIN_X,
  pathLengthEstimate,
  trackPath,
  VIEW_HEIGHT,
  VIEW_WIDTH,
} from "../src/components/switchyard/geometry";

describe("Switchyard Track Geometry", () => {
  it("maintains fixed canvas boundaries", () => {
    expect(VIEW_WIDTH).toBe(1000);
    expect(VIEW_HEIGHT).toBe(260);
    expect(CENTRE_Y).toBe(130);
    expect(ORIGIN_X).toBe(96);
    expect(DESTINATION_X).toBe(904);
  });

  it("generates 4 symmetric tracks starting and ending at the nodes", () => {
    const count = 4;
    for (let i = 0; i < count; i++) {
      const path = trackPath(i, count);
      // Path must start at origin (96, 130)
      expect(path.d.startsWith("M 96 130")).toBe(true);
      // Path must end at destination (904, 130)
      expect(path.d.endsWith("904 130")).toBe(true);
      // Midpoint X should be halfway between fanEnd and convergeStart
      expect(path.labelX).toBe((ORIGIN_X + DESTINATION_X) / 2);
    }
  });

  it("positions labels away from the center line to avoid collision", () => {
    const topTrack = trackPath(0, 4);
    const bottomTrack = trackPath(3, 4);

    expect(topTrack.labelAbove).toBe(true);
    expect(bottomTrack.labelAbove).toBe(false);
    expect(topTrack.labelY).toBeLessThan(CENTRE_Y);
    expect(bottomTrack.labelY).toBeGreaterThan(CENTRE_Y);
  });

  it("calculates positive path length estimate for draw-in animation", () => {
    const estimate = pathLengthEstimate();
    expect(estimate).toBeGreaterThan(DESTINATION_X - ORIGIN_X);
  });
});
