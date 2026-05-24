import { WorkerPool } from "./workerPool";
import type { ValidationFix, ValidationIssue } from "./validators";

export interface ValidationWorkerResult {
  filePath: string;
  issues: ValidationIssue[];
  fixes: ValidationFix[];
}

/**
 * Worker pool for batch validation. Each job validates one file and returns the
 * issues/fixes that the extension host aggregates into the output channel.
 */
export class ValidationWorkerPool extends WorkerPool<ValidationWorkerResult> {
  constructor(
    size: number,
    scriptPath: string,
    distPath: string,
    dictPaths: string[],
  ) {
    super(size, scriptPath, { distPath, dictPaths });
  }

  validate(filePath: string, attribBase: string | null): Promise<ValidationWorkerResult> {
    return this.schedule({ filePath, attribBase });
  }

  protected extractResult(msg: Record<string, unknown>): ValidationWorkerResult {
    return msg.result as ValidationWorkerResult;
  }
}
