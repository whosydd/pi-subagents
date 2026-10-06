/**
 * Minimal counting semaphore with abort support. Sub-agent spawns are
 * expensive (context window, tokens, provider rate limits), so the extension
 * caps how many run at once and queues the rest instead of refusing them.
 */

interface Waiter {
	resolve(): void;
	reject(error: Error): void;
	signal?: AbortSignal;
	onAbort?: () => void;
	cancelled?: boolean;
}

const WAIT_ABORTED = "Aborted while waiting for a free slot";

export class ConcurrencyLimiter {
	private active = 0;
	private readonly limit: number;
	private readonly waiters: Waiter[] = [];

	// Written as an explicit field: Node's strip-only TypeScript loader rejects
	// constructor parameter properties.
	constructor(limit: number) {
		this.limit = limit;
	}

	/**
	 * Resolves once a slot is free, or rejects when `signal` aborts while
	 * waiting. The caller must call {@link release} only after a resolve.
	 */
	async acquire(signal?: AbortSignal): Promise<void> {
		if (signal?.aborted) throw new Error(WAIT_ABORTED);
		if (this.active < this.limit) {
			this.active += 1;
			return;
		}
		await new Promise<void>((resolve, reject) => {
			const waiter: Waiter = { resolve, reject };
			if (signal?.aborted) {
				reject(new Error(WAIT_ABORTED));
				return;
			}
			if (signal) {
				waiter.signal = signal;
				waiter.onAbort = () => {
					waiter.cancelled = true;
					reject(new Error(WAIT_ABORTED));
				};
				signal.addEventListener("abort", waiter.onAbort, { once: true });
			}
			this.waiters.push(waiter);
		});
	}

	release(): void {
		if (this.active > 0) this.active -= 1;
		while (true) {
			const next = this.waiters.shift();
			if (!next) return;
			if (next.cancelled) continue;
			if (next.signal && next.onAbort) next.signal.removeEventListener("abort", next.onAbort);
			// Hand the slot over synchronously. Releasing it and letting the waiter
			// claim it in a later microtask would leave a window in which a fresh
			// acquire() sees `active < limit` and takes it too, so the cap could be
			// exceeded by one.
			this.active += 1;
			next.resolve();
			return;
		}
	}

	/** Slots currently held. */
	get running(): number {
		return this.active;
	}
}
