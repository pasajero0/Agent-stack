// A small driver for tests/run/process-group.test.ts: installs the driver's signal handling (abortOnSignals) and
// runs one check. Run: node --experimental-transform-types --no-warnings --import ./ts-loader.mjs driver-hup.mjs
//   <cmd> <cwd> <with-signal|no-signal>
// with-signal passes the abort signal to runCheck, as the driver does; no-signal leaves only killLiveGroups.
import { runCheck } from "../../src/run/checks.ts";
import { abortOnSignals } from "../../src/run/engine/signals.ts";

const [cmd, cwd, mode] = process.argv.slice(2);
const s = abortOnSignals();
const r = await runCheck(cmd, cwd, 60_000, mode === "with-signal" ? s.signal : undefined);
s.dispose();
process.stdout.write(`${JSON.stringify(r)}\n`);
