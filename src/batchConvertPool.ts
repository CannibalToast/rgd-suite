import { Worker } from 'worker_threads';

export type BatchOp = 'toLua' | 'toRgd';

interface WorkItem {
    id: number;
    op: BatchOp;
    inputPath: string;
    outputPath: string;
    attribBase: string | null;
    resolve: () => void;
    reject: (e: Error) => void;
}

/**
 * Mirror of ParityWorkerPool for batch conversion (rgd↔lua). Spawns a fixed
 * pool of workers that load the dictionary once at boot, then services queued
 * conversion requests FIFO.
 */
export class BatchConvertWorkerPool {
    private readonly workers: Worker[] = [];
    private readonly idle: Worker[] = [];
    private readonly queue: WorkItem[] = [];
    private readonly pending = new Map<number, WorkItem>();
    private readonly workerJob = new Map<Worker, number>();
    private nextId = 0;
    private disposed = false;
    private consecutiveInitFailures = 0;

    constructor(
        private readonly size: number,
        private readonly scriptPath: string,
        private readonly distPath: string,
        private readonly dictPaths: string[]
    ) { }

    start(): void {
        for (let i = 0; i < this.size; i++) this.spawnWorker();
    }

    private spawnWorker(): void {
        const w = new Worker(this.scriptPath, {
            workerData: { distPath: this.distPath, dictPaths: this.dictPaths }
        });
        w.on('message', (msg: { id: number; ok?: boolean; error?: string }) => {
            const item = this.pending.get(msg.id);
            if (!item) return;
            this.pending.delete(msg.id);
            this.workerJob.delete(w);
            this.idle.push(w);
            // The worker successfully handled a job — reset the init-failure
            // counter so transient errors later don't trip the circuit breaker.
            this.consecutiveInitFailures = 0;
            this.drain();
            if (msg.error) item.reject(new Error(msg.error));
            else item.resolve();
        });
        w.on('error', (err) => {
            console.error('[BatchConvertWorkerPool] worker error:', err.message);
            const jobId = this.workerJob.get(w);
            this.workerJob.delete(w);
            if (jobId !== undefined) {
                const item = this.pending.get(jobId);
                if (item) { this.pending.delete(jobId); item.reject(err); }
            } else {
                // Worker died without ever completing a job — likely an init
                // failure (e.g. dictionary load). Track to break infinite respawns.
                this.consecutiveInitFailures++;
            }
            const idx = this.workers.indexOf(w);
            if (idx !== -1) this.workers.splice(idx, 1);
            // Also remove from idle list if present, otherwise drain() could
            // pop this dead worker and call postMessage on it.
            const idleIdx = this.idle.indexOf(w);
            if (idleIdx !== -1) this.idle.splice(idleIdx, 1);
            if (!this.disposed && this.consecutiveInitFailures <= this.size * 3) {
                this.spawnWorker();
            } else if (this.consecutiveInitFailures > this.size * 3) {
                // Circuit breaker: fail all queued + pending and mark disposed so
                // callers fall back to their in-process path.
                console.error('[BatchConvertWorkerPool] too many worker init failures, disposing pool');
                this.disposed = true;
                const drained = this.queue.splice(0);
                for (const item of drained) item.reject(new Error('Worker pool init failed'));
                for (const [, item] of this.pending) item.reject(new Error('Worker pool init failed'));
                this.pending.clear();
            }
            this.drain();
        });
        this.workers.push(w);
        this.idle.push(w);
    }

    convert(op: BatchOp, inputPath: string, outputPath: string, attribBase: string | null): Promise<void> {
        return new Promise((resolve, reject) => {
            if (this.disposed) { reject(new Error('Pool disposed')); return; }
            this.queue.push({ id: this.nextId++, op, inputPath, outputPath, attribBase, resolve, reject });
            this.drain();
        });
    }

    cancel(): void {
        const drained = this.queue.splice(0);
        for (const item of drained) item.reject(new Error('Cancelled'));
    }

    dispose(): void {
        this.disposed = true;
        this.cancel();
        for (const [, item] of this.pending) item.reject(new Error('Pool disposed'));
        this.pending.clear();
        this.workerJob.clear();
        for (const w of this.workers) w.terminate();
        this.workers.length = 0;
        this.idle.length = 0;
    }

    private drain(): void {
        while (this.idle.length > 0 && this.queue.length > 0) {
            const w = this.idle.pop()!;
            const item = this.queue.shift()!;
            this.pending.set(item.id, item);
            this.workerJob.set(w, item.id);
            w.postMessage({
                id: item.id,
                op: item.op,
                inputPath: item.inputPath,
                outputPath: item.outputPath,
                attribBase: item.attribBase,
            });
        }
    }
}
