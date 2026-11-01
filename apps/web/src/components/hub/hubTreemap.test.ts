import { describe, expect, it } from "vite-plus/test";

import { squarifyTreemap, type TreemapCell, type TreemapRect } from "./hubTreemap";

const rect: TreemapRect = { x: 10, y: 20, width: 600, height: 400 };
const EPSILON = 1e-6;

const area = (cell: TreemapRect) => cell.width * cell.height;

function overlaps(a: TreemapCell, b: TreemapCell) {
  return (
    a.x < b.x + b.width - EPSILON &&
    b.x < a.x + a.width - EPSILON &&
    a.y < b.y + b.height - EPSILON &&
    b.y < a.y + a.height - EPSILON
  );
}

const weights = [13, 8, 8, 5, 3, 2, 2, 1, 1, 0.5, 0.25];
const items = weights.map((weight, index) => ({ id: `p${index}`, weight }));

describe("squarifyTreemap", () => {
  it("gives each cell an area proportional to its weight", () => {
    const cells = squarifyTreemap(items, rect);
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    expect(cells).toHaveLength(items.length);
    for (const item of items) {
      const cell = cells.find((entry) => entry.id === item.id)!;
      expect(area(cell)).toBeCloseTo((item.weight / total) * area(rect), 6);
    }
  });

  it("keeps every cell inside the bounds and tiles them exactly", () => {
    const cells = squarifyTreemap(items, rect);
    for (const cell of cells) {
      expect(cell.width).toBeGreaterThan(0);
      expect(cell.height).toBeGreaterThan(0);
      expect(cell.x).toBeGreaterThanOrEqual(rect.x - EPSILON);
      expect(cell.y).toBeGreaterThanOrEqual(rect.y - EPSILON);
      expect(cell.x + cell.width).toBeLessThanOrEqual(rect.x + rect.width + EPSILON);
      expect(cell.y + cell.height).toBeLessThanOrEqual(rect.y + rect.height + EPSILON);
    }
    const covered = cells.reduce((sum, cell) => sum + area(cell), 0);
    expect(covered).toBeCloseTo(area(rect), 6);
  });

  it("never overlaps two cells", () => {
    const cells = squarifyTreemap(items, { x: 0, y: 0, width: 390, height: 900 });
    for (let i = 0; i < cells.length; i += 1) {
      for (let j = i + 1; j < cells.length; j += 1) {
        expect(overlaps(cells[i]!, cells[j]!)).toBe(false);
      }
    }
  });

  it("keeps equal weights close to square", () => {
    const cells = squarifyTreemap(
      Array.from({ length: 16 }, (_, index) => ({ id: `${index}`, weight: 1 })),
      { x: 0, y: 0, width: 400, height: 400 },
    );
    for (const cell of cells) {
      const ratio = Math.max(cell.width / cell.height, cell.height / cell.width);
      expect(ratio).toBeLessThan(2);
    }
  });

  it("handles no items, one item, and non-positive weights", () => {
    expect(squarifyTreemap([], rect)).toEqual([]);
    expect(squarifyTreemap([{ id: "a", weight: 0 }], rect)).toEqual([]);
    expect(squarifyTreemap([{ id: "a", weight: 5 }], rect)).toEqual([{ id: "a", ...rect }]);
    const cells = squarifyTreemap(
      [
        { id: "a", weight: 2 },
        { id: "b", weight: -1 },
        { id: "c", weight: Number.NaN },
      ],
      rect,
    );
    expect(cells.map((cell) => cell.id)).toEqual(["a"]);
  });

  it("returns nothing for an empty rectangle", () => {
    expect(squarifyTreemap(items, { x: 0, y: 0, width: 0, height: 100 })).toEqual([]);
  });
});
