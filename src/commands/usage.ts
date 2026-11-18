import chalk from "chalk";
import { collectUsage, type UsageReport } from "../usage/collect.js";
import { harnessInventory, neverActed, type Inventory } from "../usage/inventory.js";
import { listLogFiles, projectLogDir } from "../usage/logs.js";
import { saveSnapshot } from "../usage/snapshot.js";
import { toolVersion } from "../claude/harness.js";
import { banner, log } from "../utils/logger.js";

export async function usageCommand(
  options: { days?: string; logs?: string; json?: boolean; save?: boolean } = {}
): Promise<void> {
  const projectDir = process.cwd();
  const logDir = options.logs ?? projectLogDir(projectDir);
  const days = options.days ? Number(options.days) : null;
  if (days !== null && !(Number.isFinite(days) && days > 0)) {
    log.error(`--days must be a positive number, got "${options.days}".`);
    process.exit(1);
  }

  const files = listLogFiles(logDir);
  const report = await collectUsage(files, days ? Date.now() - days * 86_400_000 : null);
  const unused = neverActed(harnessInventory(projectDir), report);

  // Saved before printing; in --json mode the path goes to stderr so stdout stays valid JSON.
  const saved =
    options.save && files.length > 0
      ? saveSnapshot(projectDir, {
          savedAt: new Date().toISOString(),
          toolVersion: toolVersion(),
          days,
          files: files.length,
          report,
          neverActed: unused,
        })
      : null;
  if (saved && options.json) console.error(`Saved ${saved}`);

  if (options.json) {
    console.log(JSON.stringify({ logDir, files: files.length, report, neverActed: unused }, null, 2));
    return;
  }

  banner();
  if (files.length === 0) {
    log.warn(`No session logs in ${logDir}.`);
    log.dim("  Claude Code deletes logs after cleanupPeriodDays (30 by default). Use --logs <dir> for a copy.");
    return;
  }
  printReport(report, unused, logDir);
  if (saved) log.success(`Saved ${saved}`);
}

function printReport(r: UsageReport, unused: Inventory, logDir: string) {
  const span = r.first && r.last ? ` (${r.first.slice(0, 10)} … ${r.last.slice(0, 10)})` : "";
  console.log(`Sessions: ${r.mainSessions} main, ${r.subagentRuns} subagent runs${span}`);
  log.dim(`  ${logDir}`);
  if (r.skippedFiles) log.warn(`${r.skippedFiles} log file(s) could not be read and were skipped.`);

  section("Hooks that blocked", r.hookBlocks);
  section("Context added by hooks", r.hookContext);
  section("Stop hooks — runs", r.stopRuns);
  if (Object.keys(r.stopRuns).length) log.dim(`  stops with any hook output: ${r.stopsActed} (plugins included)`);
  section("Subagents", r.agents);
  section("Skills", r.skills);
  section("Commands", r.commands);
  section(".claude/bin", r.bin);

  console.log();
  console.log(chalk.bold("Tokens") + chalk.dim("  cache write / output / cache read"));
  for (const t of r.tokens) {
    console.log(
      `  ${t.agent.padEnd(18)} ${shortModel(t.model).padEnd(8)} ` +
        `${m(t.cacheWrite)} / ${m(t.output)} / ${chalk.dim(m(t.cacheRead))}`
    );
  }

  console.log();
  console.log(chalk.bold("Never acted") + chalk.dim("  installed, no event in these logs"));
  for (const [kind, list] of Object.entries(unused) as [string, string[]][]) {
    if (list.length) console.log(`  ${kind.padEnd(9)} ${list.join(", ")}`);
  }
  log.dim("  Read from Claude Code's internal log format, which can change between versions.");
}

function section(title: string, counts: Record<string, number>) {
  const rows = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  console.log();
  console.log(chalk.bold(title));
  if (!rows.length) return console.log(chalk.dim("  —"));
  for (const [k, n] of rows) console.log(`  ${k.padEnd(24)} ${n}`);
}

const m = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));

/** `claude-opus-5-5` → `opus`. */
const shortModel = (model: string) => /(opus|sonnet|haiku|fable)/.exec(model)?.[1] ?? model;
