import {
  runScanAll,
  type ScanAllLine,
  type ScanAllPlan,
} from "@t3tools/client-runtime/codrHub/scanAllMachines";
import { scanImportSummary } from "@t3tools/client-runtime/codrHub/scanAttention";
import type { EnvironmentId, HubImportResult } from "@t3tools/contracts";
import { useId, useState } from "react";

import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { useHubAction } from "./useHubAction";

type Source = "file" | "path" | "scan" | "all";
const FROM_FILE = "";

/**
 * Import a workshop scan TSV: an uploaded file, a file on the machine, a fresh scan of it, or a
 * fresh scan of every connected machine.
 */
export function HubScanImportDialog(props: {
  readonly environmentId: EnvironmentId;
  /** The machine the selected environment runs on. */
  readonly nodeName: string;
  readonly knownNodes: ReadonlyArray<string>;
  readonly scanAllPlan: ScanAllPlan;
  /** Preselects the machine the rows belong to, such as a machine card's "Import scan…". */
  readonly initialMachine?: string | undefined;
  readonly onClose: () => void;
}) {
  const formId = useId();
  const [source, setSource] = useState<Source>("file");
  const [text, setText] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [path, setPath] = useState("");
  const [machine, setMachine] = useState(props.initialMachine ?? FROM_FILE);
  const [result, setResult] = useState<HubImportResult | null>(null);
  const [allLines, setAllLines] = useState<ReadonlyArray<ScanAllLine> | null>(null);
  const [allBusy, setAllBusy] = useState(false);
  const importScan = useAtomCommand(serverEnvironment.hubImport, { reportFailure: false });
  const action = useHubAction(
    serverEnvironment.hubImport,
    props.environmentId,
    "Could not import the scan",
  );

  const busy = action.busy || allBusy;
  const ready =
    source === "file"
      ? text !== null
      : source === "path"
        ? path.trim() !== ""
        : source === "all"
          ? props.scanAllPlan.targets.length > 0
          : true;
  const scanAll = async (dryRun: boolean) => {
    setAllBusy(true);
    setAllLines(null);
    const lines = await runScanAll(props.scanAllPlan, ({ environmentId }) =>
      importScan({ environmentId, input: { source: "scan", scanThisMachine: true, dryRun } }),
    );
    setAllBusy(false);
    setAllLines(lines);
  };
  const run = async (dryRun: boolean) => {
    if (source === "all") return scanAll(dryRun);
    const from =
      source === "file"
        ? { text: text ?? "" }
        : source === "path"
          ? { path: path.trim() }
          : { scanThisMachine: true };
    const next = await action.run({
      source: "scan",
      ...from,
      ...(machine === FROM_FILE ? {} : { nodeName: machine }),
      dryRun,
    });
    if (next) setResult(next);
  };

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : props.onClose())}>
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Import scan</DialogTitle>
          <DialogDescription>
            Adds every project folder a disk scan found. Projects already in the Hub only get empty
            fields and this machine's checkout filled in.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-4">
            <ToggleGroup
              aria-label="Scan source"
              variant="segmented"
              value={[source]}
              onValueChange={(next) => {
                const value = next[0];
                if (value === "file" || value === "path" || value === "scan" || value === "all") {
                  setSource(value);
                  setResult(null);
                  setAllLines(null);
                }
              }}
            >
              <Toggle value="file">File</Toggle>
              <Toggle value="path">Path on {props.nodeName}</Toggle>
              <Toggle value="scan">Scan {props.nodeName}</Toggle>
              <Toggle value="all">All machines</Toggle>
            </ToggleGroup>
            {source === "file" ? (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={`${formId}-file`}>Scan file (.tsv)</Label>
                <Input
                  id={`${formId}-file`}
                  type="file"
                  accept=".tsv,.txt,text/tab-separated-values"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    setResult(null);
                    if (!file) {
                      setText(null);
                      setFileName(null);
                      return;
                    }
                    setFileName(file.name);
                    void file.text().then(setText);
                  }}
                />
                {fileName ? (
                  <span className="text-xs text-muted-foreground">{fileName}</span>
                ) : null}
              </div>
            ) : source === "path" ? (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={`${formId}-path`}>Path to the .tsv on {props.nodeName}</Label>
                <Input
                  id={`${formId}-path`}
                  value={path}
                  placeholder="/Users/me/Desktop/Workshop/_Admin/Inventory/MACBOOKPRO-2026-11-06.tsv"
                  onChange={(event) => {
                    setPath(event.target.value);
                    setResult(null);
                  }}
                />
              </div>
            ) : source === "all" ? (
              <div className="flex flex-col gap-1.5 text-sm text-muted-foreground">
                <p>
                  {props.scanAllPlan.targets.length === 0
                    ? "No connected machine runs Codr-Hub."
                    : `Scans the disks of every connected machine at once (${props.scanAllPlan.targets
                        .map((target) => target.nodeName)
                        .join(
                          ", ",
                        )}) with each one's scan settings, then imports the results. This can take several minutes.`}
                </p>
                <p>Each machine needs an up-to-date Codr-Hub.</p>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                Scans {props.nodeName}'s Workshop folder and any folders in its scan settings, then
                imports the result. Large folders can take a few minutes.
              </p>
            )}
            {source === "all" ? null : (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={`${formId}-machine`}>Machine</Label>
                <Select
                  value={machine}
                  onValueChange={(next) => {
                    setMachine(typeof next === "string" ? next : FROM_FILE);
                    setResult(null);
                  }}
                >
                  <SelectTrigger id={`${formId}-machine`}>
                    <SelectValue>
                      {machine === FROM_FILE
                        ? source === "scan"
                          ? props.nodeName
                          : "From the file's nickname column"
                        : machine}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    <SelectItem value={FROM_FILE}>
                      {source === "scan" ? props.nodeName : "From the file's nickname column"}
                    </SelectItem>
                    {props.knownNodes.map((node) => (
                      <SelectItem key={node} value={node}>
                        {node}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </div>
            )}
            {allLines ? (
              <ul role="status" className="flex flex-col gap-2 text-sm">
                {allLines.map((line) => (
                  <li key={line.nodeName}>
                    <span className="font-medium text-foreground">{line.nodeName}: </span>
                    <span className={line.ok ? "text-foreground" : "text-muted-foreground"}>
                      {line.text}
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
            {result ? (
              <div role="status" className="flex flex-col gap-2 text-sm">
                <p className="text-foreground">{scanImportSummary(result)}</p>
                {(result.ambiguous?.length ?? 0) > 0 ? (
                  <ul className="flex max-h-48 list-disc flex-col gap-1 overflow-y-auto ps-5 text-muted-foreground">
                    {result.ambiguous!.map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : null}
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button size="sm" variant="ghost" onClick={props.onClose}>
            {(result && !result.dryRun) || allLines ? "Done" : "Cancel"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!ready || busy}
            onClick={() => void run(true)}
          >
            Preview
          </Button>
          <Button
            size="sm"
            disabled={!ready || busy}
            aria-busy={busy}
            onClick={() => void run(false)}
          >
            {busy ? "Working…" : source === "all" ? "Scan all machines" : "Import"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
