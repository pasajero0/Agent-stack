import { execa } from "execa";

export async function commandExists(cmd: string): Promise<boolean> {
  try {
    await execa("which", [cmd]);
    return true;
  } catch {
    return false;
  }
}

export async function run(
  cmd: string,
  args: string[],
  options?: { cwd?: string; env?: Record<string, string> }
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const result = await execa(cmd, args, {
    cwd: options?.cwd,
    env: options?.env,
    reject: false,
  });
  return {
    stdout: result.stdout as string,
    stderr: result.stderr as string,
    exitCode: result.exitCode ?? 1,
  };
}

export async function runSilent(
  cmd: string,
  args: string[]
): Promise<{ stdout: string; exitCode: number }> {
  const result = await execa(cmd, args, { reject: false });
  return { stdout: result.stdout as string, exitCode: result.exitCode ?? 1 };
}
