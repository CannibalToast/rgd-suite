import { Worker } from 'worker_threads';
import type { ParityResult } from './parityChecker';

interface WorkItem {
    id: number;
    rgdPath: string;
    luaPath: string;
    resolve: (r: ParityResult) => void;
    reject: (e: Error) => void;
}

export class ParityWorkerPool {
    private readonly workers: Worker[] = [];
    private readonly idle: Worker[] = [];
    private readonly queue: WorkItem[] = [];
    private readonly pending = new Map<number, WorkItem>();
    private readonly workerJob = new Map<Worker, number>();
    private nextId = 0;
    private disposed = false;

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
        w.on('message', (msg: { id: number; result?: ParityResult; error?: string }) => {
            const item = this.pending.get(msg.id);
            if (!item) return;
            this.pending.delete(msg.id);
            this.workerJob.delete(w);
            this.idle.push(w);
            this.drain();
            if (msg.error) item.reject(new Error(msg.error));
            else           item.resolve(msg.result!);
        });
        w.on('error', (err) => {
            console.error('[ParityWorkerPool] worker error:', err.message);
            const jobId = this.workerJob.get(w);
            this.workerJob.delete(w);
            if (jobId !== undefined) {
                const item = this.pending.get(jobId);
                if (item) { this.pending.delete(jobId); item.reject(err); }
            }
            const idx = this.workers.indexOf(w);
            if (idx !== -1) this.workers.splice(idx, 1);
            if (!this.disposed) { this.spawnWorker(); }
            this.drain();
        });
        this.workers.push(w);
        this.idle.push(w);
    }

    check(rgdPath: string, luaPath: string): Promise<ParityResult> {
        return new Promise((resolve, reject) => {
            if (this.disposed) { reject(new Error('Pool disposed')); return; }
            this.queue.push({ id: this.nextId++, rgdPath, luaPath, resolve, reject });
            this.drain();
        });
    }

    // Drain queued items without waiting — workers call this on completion.
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
            const w    = this.idle.pop()!;
            const item = this.queue.shift()!;
            this.pending.set(item.id, item);
            this.workerJob.set(w, item.id);
            w.postMessage({ id: item.id, rgdPath: item.rgdPath, luaPath: item.luaPath });
        }
    }
}
