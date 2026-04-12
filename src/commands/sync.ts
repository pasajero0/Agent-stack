import { detectCommand } from "./detect.js";
import { generateCommand } from "./generate.js";

export async function syncCommand(): Promise<void> {
  await detectCommand();
  console.log();
  await generateCommand({});
}
