export type TreemapRect = {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};

export type TreemapItem<Id extends string = string> = {
  readonly id: Id;
  readonly weight: number;
};

export type TreemapCell<Id extends string = string> = TreemapRect & { readonly id: Id };

type Scaled<Id extends string> = { readonly id: Id; readonly area: number };

/** Worst aspect ratio of a row laid along a side of length `side` (Bruls et al.). */
function worstRatio<Id extends string>(row: ReadonlyArray<Scaled<Id>>, side: number): number {
  let sum = 0;
  let max = 0;
  let min = Number.POSITIVE_INFINITY;
  for (const item of row) {
    sum += item.area;
    max = Math.max(max, item.area);
    min = Math.min(min, item.area);
  }
  const side2 = side * side;
  const sum2 = sum * sum;
  return Math.max((side2 * max) / sum2, sum2 / (side2 * min));
}

/**
 * Squarified treemap. Each cell's area is proportional to its weight, cells tile
 * `rect` exactly, and aspect ratios stay close to square. Items with a
 * non-positive weight are omitted. Output follows descending weight.
 */
export function squarifyTreemap<Id extends string>(
  items: ReadonlyArray<TreemapItem<Id>>,
  rect: TreemapRect,
): TreemapCell<Id>[] {
  const positive = items
    .filter((item) => Number.isFinite(item.weight) && item.weight > 0)
    .toSorted((a, b) => b.weight - a.weight);
  const total = positive.reduce((sum, item) => sum + item.weight, 0);
  if (positive.length === 0 || rect.width <= 0 || rect.height <= 0) return [];
  const scale = (rect.width * rect.height) / total;
  const queue: Scaled<Id>[] = positive.map((item) => ({ id: item.id, area: item.weight * scale }));

  const cells: TreemapCell<Id>[] = [];
  let free = rect;
  let index = 0;
  while (index < queue.length) {
    const side = Math.min(free.width, free.height);
    const row: Scaled<Id>[] = [queue[index]!];
    index += 1;
    while (index < queue.length) {
      const next = queue[index]!;
      if (worstRatio([...row, next], side) > worstRatio(row, side)) break;
      row.push(next);
      index += 1;
    }
    const isLast = index >= queue.length;
    const rowArea = row.reduce((sum, item) => sum + item.area, 0);
    if (free.width >= free.height) {
      // Column on the left edge; the last row takes the remainder to absorb rounding.
      const columnWidth = isLast ? free.width : rowArea / free.height;
      let y = free.y;
      row.forEach((item, position) => {
        const height =
          position === row.length - 1 ? free.y + free.height - y : item.area / columnWidth;
        cells.push({ id: item.id, x: free.x, y, width: columnWidth, height });
        y += height;
      });
      free = {
        x: free.x + columnWidth,
        y: free.y,
        width: free.width - columnWidth,
        height: free.height,
      };
    } else {
      const rowHeight = isLast ? free.height : rowArea / free.width;
      let x = free.x;
      row.forEach((item, position) => {
        const width = position === row.length - 1 ? free.x + free.width - x : item.area / rowHeight;
        cells.push({ id: item.id, x, y: free.y, width, height: rowHeight });
        x += width;
      });
      free = {
        x: free.x,
        y: free.y + rowHeight,
        width: free.width,
        height: free.height - rowHeight,
      };
    }
  }
  return cells;
}
