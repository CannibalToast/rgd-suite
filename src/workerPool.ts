import { Worker } from 'worker_threads';
import type { ParityResult } from './parityChecker';

interface InternalItem<TResult> {
    id: number;
    payload: Record<string, unknown>;
    resolve: (value: TResult) => void;
    reject: (e: Error) => void;
}

/**
 * Generic fixed-size worker pool that loads a script once, services queued
 * requests FIFO, and respawns workers on transient failures with a circuit
 * breaker on repeated init failures.
 *
 * Subclasses only need to specify the public payload and result types.
 */
export abstract class WorkerPool<TResult> {
    private readonly workers: Worker[] = [];
    private readonly idle: Worker[] = [];
    private readonly queue: InternalItem<TResult>[] = [];
    private readonly pending = new Map<number, InternalItem<TResult>>();
    private readonly workerJob = new Map<Worker, number>();
    private nextId = 0;
    private disposed = false;
    private consecutiveInitFailures = 0;

    constructor(
        private readonly size: number,
        private readonly scriptPath: string,
        private readonly workerData: unknown
    ) { }

    start(): void {
        for (let i = 0; i < this.size; i++) this.spawnWorker();
    }

    private spawnWorker(): void {
        const w = new Worker(this.scriptPath, { workerData: this.workerData });
        w.on('message', (msg: { id: number; error?: string } & Record<string, unknown>) => {
            const item = this.pending.get(msg.id);
            if (!item) return;
            this.pending.delete(msg.id);
            this.workerJob.delete(w);
            this.idle.push(w);
            this.consecutiveInitFailures = 0;
            this.drain();
            if (msg.error) item.reject(new Error(msg.error));
            else item.resolve(this.extractResult(msg));
        });
        w.on('error', (err: Error) => {
            console.error(`[${this.constructor.name}] worker error:`, err.message);
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
            // Remove from idle list too — otherwise drain() could pop a dead
            // worker and call postMessage on it.
            const idleIdx = this.idle.indexOf(w);
            if (idleIdx !== -1) this.idle.splice(idleIdx, 1);
            if (!this.disposed && this.consecutiveInitFailures <= this.size * 3) {
                this.spawnWorker();
            } else if (this.consecutiveInitFailures > this.size * 3) {
                console.error(`[${this.constructor.name}] too many worker init failures, disposing pool`);
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

    /** Queue a unit of work. Returns a Promise that resolves with TResult. */
    protected schedule(payload: Record<string, unknown>): Promise<TResult> {
        return new Promise((resolve, reject) => {
            if (this.disposed) { reject(new Error('Pool disposed')); return; }
            const id = this.nextId++;
            const item: InternalItem<TResult> = { id, payload, resolve, reject };
            this.queue.push(item);
            this.drain();
        });
    }

    /** Cancel all queued (but not in-flight) work. */
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

    /** Extract the result from a successful worker message. */
    protected abstract extractResult(msg: Record<string, unknown>): TResult;

    private drain(): void {
        while (this.idle.length > 0 && this.queue.length > 0) {
            const w = this.idle.pop()!;
            const item = this.queue.shift()!;
            this.pending.set(item.id, item);
            this.workerJob.set(w, item.id);
            w.postMessage({ id: item.id, ...item.payload });
        }
    }
}

/**
 * Worker pool for parity checks. Thin wrapper around the generic WorkerPool.
 */
export class ParityWorkerPool extends WorkerPool<ParityResult> {
    constructor(
        size: number,
        scriptPath: string,
        distPath: string,
        dictPaths: string[]
    ) {
        super(size, scriptPath, { distPath, dictPaths });
    }

    check(rgdPath: string, luaPath: string): Promise<ParityResult> {
        return this.schedule({ rgdPath, luaPath });
    }

    protected extractResult(msg: Record<string, unknown>): ParityResult {
        return msg.result as ParityResult;
    }
}
