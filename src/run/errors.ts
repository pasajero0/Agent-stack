/** A refusal or error the driver reports to the user; `exitCode` is the process exit code. */
export class RunError extends Error {
  constructor(
    message: string,
    public readonly exitCode: 1 | 3 = 1
  ) {
    super(message);
    this.name = "RunError";
  }
}
