import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export interface ProjectContext {
  isExistingProject: boolean;
  hasPackageJson: boolean;
  hasSrcDir: boolean;
  hasGitRepo: boolean;
  projectName?: string;
  scenario: "existing" | "empty";
}

export async function detectProject(dir: string): Promise<ProjectContext> {
  const hasPackageJson = existsSync(join(dir, "package.json"));
  const hasSrcDir = existsSync(join(dir, "src"));
  const hasGitRepo = existsSync(join(dir, ".git"));

  const isExistingProject = hasPackageJson || hasSrcDir || hasGitRepo;

  let projectName: string | undefined;
  if (hasPackageJson) {
    try {
      const raw = await readFile(join(dir, "package.json"), "utf-8");
      const pkg = JSON.parse(raw);
      projectName = pkg.name;
    } catch {
      // ignore parse errors
    }
  }

  return {
    isExistingProject,
    hasPackageJson,
    hasSrcDir,
    hasGitRepo,
    projectName,
    scenario: isExistingProject ? "existing" : "empty",
  };
}
