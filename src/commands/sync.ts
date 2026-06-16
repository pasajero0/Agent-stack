import { existsSync } from "node:fs";
import { join } from "node:path";
import { detectCommand } from "./detect.js";
import { generateCommand } from "./generate.js";
import { updateCommand } from "./update.js";

export async function syncCommand(): Promise<void> {
  await detectCommand();
  console.log();
  if (existsSync(join(process.cwd(), ".claude"))) {
    await updateCommand();
  } else {
    await generateCommand();
  }
}
