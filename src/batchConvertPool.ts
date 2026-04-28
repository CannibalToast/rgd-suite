import { WorkerPool } from './workerPool';

export type BatchOp = 'toLua' | 'toRgd';

/**
 * Worker pool for batch rgd↔lua conversions. Thin wrapper around the generic
 * WorkerPool — each job resolves to void on success or rejects with the worker
 * error string.
 */
export class BatchConvertWorkerPool extends WorkerPool<void> {
    constructor(
        size: number,
        scriptPath: string,
        distPath: string,
        dictPaths: string[]
    ) {
        super(size, scriptPath, { distPath, dictPaths });
    }

    convert(op: BatchOp, inputPath: string, outputPath: string, attribBase: string | null): Promise<void> {
        return this.schedule({ op, inputPath, outputPath, attribBase });
    }

    protected extractResult(_msg: Record<string, unknown>): void {
        return;
    }
}
