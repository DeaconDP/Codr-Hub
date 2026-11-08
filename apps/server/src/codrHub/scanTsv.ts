/**
 * The workshop inventory TSV that every machine's disk scan writes: one row per project folder.
 * Plain TypeScript with no imports so `scripts/codr-hub-scan.ts` can run it with bare Node.
 *
 * @module codrHub/scanTsv
 */

const SCAN_TSV_HEADER = [
  "machine",
  "nickname",
  "category",
  "lane",
  "name",
  "vcs",
  "path",
  "remote",
  "branch",
  "ahead_behind",
  "dirty",
  "last_activity",
  "size_gb",
  "flag",
  "scanned",
] as const;

export interface ScanRow {
  readonly machine: string;
  readonly nickname: string;
  /** Private / Public / Other / Archive */
  readonly category: string;
  /** Engine or platform lane: VRChat / Unity / Unreal / Web / Apple / Python / Bot / Tool / Other */
  readonly lane: string;
  readonly name: string;
  /** github / edgar / git-local / perforce / none */
  readonly vcs: string;
  readonly path: string;
  readonly remote: string | null;
  readonly branch: string | null;
  readonly ahead: number | null;
  readonly behind: number | null;
  readonly dirty: number | null;
  /** YYYY-MM-DD */
  readonly lastActivity: string | null;
  readonly sizeGb: number | null;
  readonly flags: ReadonlyArray<string>;
  /** YYYY-MM-DD */
  readonly scanned: string;
}

export interface ParsedScan {
  readonly rows: ReadonlyArray<ScanRow>;
  /** Line-numbered problems; those lines are left out of `rows`. */
  readonly errors: ReadonlyArray<string>;
}

const text = (value: string | undefined) => {
  const trimmed = (value ?? "").trim();
  return trimmed === "" ? null : trimmed;
};

const int = (value: string | undefined) => {
  const raw = text(value);
  return raw !== null && /^-?\d+$/.test(raw) ? Number(raw) : null;
};

const num = (value: string | undefined) => {
  const raw = text(value);
  if (raw === null) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
};

/** `+2/-0` → ahead 2, behind 0. */
const aheadBehind = (value: string | undefined) => {
  const match = /^\+?(\d+)\s*\/\s*-?(\d+)$/.exec(text(value) ?? "");
  return match ? { ahead: Number(match[1]), behind: Number(match[2]) } : null;
};

/** Reads columns by header name, so column order and extra columns don't matter. */
export function parseScanTsv(input: string): ParsedScan {
  const lines = input.replace(/^﻿/, "").split(/\r?\n/);
  const header = (lines[0] ?? "").split("\t").map((cell) => cell.trim().toLowerCase());
  const missing = ["name", "path", "nickname"].filter((column) => !header.includes(column));
  if (missing.length > 0) {
    return {
      rows: [],
      errors: [`Not a workshop scan: the header has no ${missing.join(", ")} column.`],
    };
  }
  const column = (cells: ReadonlyArray<string>, name: string) => {
    const index = header.indexOf(name);
    return index === -1 ? undefined : cells[index];
  };
  const rows: ScanRow[] = [];
  const errors: string[] = [];
  lines.slice(1).forEach((line, index) => {
    if (line.trim() === "") return;
    const cells = line.split("\t");
    const name = text(column(cells, "name"));
    const path = text(column(cells, "path"));
    const nickname = text(column(cells, "nickname"));
    if (name === null || path === null || nickname === null) {
      errors.push(`Line ${index + 2}: needs a name, path and nickname.`);
      return;
    }
    const ab = aheadBehind(column(cells, "ahead_behind"));
    rows.push({
      machine: text(column(cells, "machine")) ?? nickname,
      nickname,
      category: text(column(cells, "category")) ?? "Other",
      lane: text(column(cells, "lane")) ?? "Other",
      name,
      vcs: text(column(cells, "vcs")) ?? "none",
      path,
      remote: text(column(cells, "remote")),
      branch: text(column(cells, "branch")),
      ahead: ab?.ahead ?? null,
      behind: ab?.behind ?? null,
      dirty: int(column(cells, "dirty")),
      lastActivity: text(column(cells, "last_activity")),
      sizeGb: num(column(cells, "size_gb")),
      flags: (text(column(cells, "flag")) ?? "")
        .split(",")
        .map((flag) => flag.trim())
        .filter((flag) => flag !== ""),
      scanned: text(column(cells, "scanned")) ?? "",
    });
  });
  return { rows, errors };
}

const cell = (value: string | number | null) =>
  value === null ? "" : String(value).replace(/[\t\r\n]+/g, " ");

export function formatScanTsv(rows: ReadonlyArray<ScanRow>): string {
  const lines = rows.map((row) =>
    [
      row.machine,
      row.nickname,
      row.category,
      row.lane,
      row.name,
      row.vcs,
      row.path,
      row.remote,
      row.branch,
      row.ahead === null || row.behind === null ? null : `+${row.ahead}/-${row.behind}`,
      row.dirty,
      row.lastActivity,
      row.sizeGb === null ? null : row.sizeGb.toFixed(1),
      row.flags.join(","),
      row.scanned,
    ]
      .map(cell)
      .join("\t"),
  );
  return `${[SCAN_TSV_HEADER.join("\t"), ...lines].join("\n")}\n`;
}
