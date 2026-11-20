import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { RunError } from "./errors.js";

/** `null` means no input is available: the caller records the gate and exits 3. */
export interface Prompter {
  ask(prompt: string): Promise<string | null>;
  /** Answers not read yet; only `--answer` input counts them (AC-70). */
  left?(): string[];
  /** Releases the input. Safe to call more than once. */
  close(): void;
}

export function filePrompter(path: string): Prompter {
  let lines: string[];
  try {
    const text = readFileSync(path, "utf8");
    lines = text === "" ? [] : text.split(/\r?\n/);
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  } catch {
    throw new RunError(`AGENT_STACK_GATE_INPUT is set but cannot be read: ${path}`, 1);
  }
  let next = 0;
  return {
    async ask() {
      return next < lines.length ? (lines[next++] ?? null) : null;
    },
    close() {},
  };
}

/** `--answer` lines, in order; they are never mixed with the terminal (AC-70). */
export function answersPrompter(answers: readonly string[]): Prompter {
  let next = 0;
  return {
    async ask() {
      return next < answers.length ? (answers[next++] ?? null) : null;
    },
    left() {
      return answers.slice(next);
    },
    close() {},
  };
}

export function terminalPrompter(input: NodeJS.ReadableStream, output: NodeJS.WritableStream): Prompter {
  const rl = createInterface({ input, terminal: false });
  const buffered: string[] = [];
  let waiting: ((line: string | null) => void) | null = null;
  let closed = false;

  rl.on("line", (line) => {
    if (waiting) {
      const resolve = waiting;
      waiting = null;
      resolve(line);
    } else {
      buffered.push(line);
    }
  });
  rl.on("close", () => {
    closed = true;
    if (waiting) {
      const resolve = waiting;
      waiting = null;
      resolve(null);
    }
  });

  return {
    ask(prompt) {
      output.write(prompt);
      const queued = buffered.shift();
      if (queued !== undefined) return Promise.resolve(queued);
      if (closed) return Promise.resolve(null);
      return new Promise((resolve) => {
        waiting = resolve;
      });
    },
    close() {
      rl.close();
    },
  };
}

export const nonePrompter: Prompter = {
  async ask() {
    return null;
  },
  close() {},
};

export function selectPrompter(
  env: Record<string, string | undefined>,
  isTTY: boolean,
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout
): Prompter {
  const file = env["AGENT_STACK_GATE_INPUT"];
  if (file) return filePrompter(file);
  if (isTTY) return terminalPrompter(input, output);
  return nonePrompter;
}
