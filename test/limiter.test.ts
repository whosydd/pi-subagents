import assert from "node:assert/strict";
import test from "node:test";
import { ConcurrencyLimiter } from "../extensions/lib/limiter.ts";

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("ConcurrencyLimiter queues work beyond the limit and resumes on release", async () => {
	const limiter = new ConcurrencyLimiter(2);
	await limiter.acquire();
	await limiter.acquire();
	assert.equal(limiter.running, 2);

	let started = false;
	const pending = limiter.acquire().then(() => {
		started = true;
	});
	await tick();
	assert.equal(started, false, "third acquire must wait for a free slot");

	limiter.release();
	await pending;
	assert.equal(started, true);
	assert.equal(limiter.running, 2);

	limiter.release();
	limiter.release();
	assert.equal(limiter.running, 0);
});

test("ConcurrencyLimiter never drops below zero", () => {
	const limiter = new ConcurrencyLimiter(1);
	limiter.release();
	assert.equal(limiter.running, 0);
});

test("ConcurrencyLimiter does not slip past its limit when a release meets a new acquire", async () => {
	const limiter = new ConcurrencyLimiter(2);
	await limiter.acquire();
	await limiter.acquire();
	const queued = limiter.acquire();
	const queuedToo = limiter.acquire();

	// The interleaving that breaks a naive semaphore: a slot is handed to a
	// waiter, and before that waiter resumes, a fresh caller arrives.
	limiter.release();
	let freshStarted = false;
	const fresh = limiter.acquire().then(() => {
		freshStarted = true;
	});

	await tick();
	assert.equal(freshStarted, false, "a fresh acquire must not take a slot that is already spoken for");

	// Let the queue drain; the cap must hold through every hand-off.
	limiter.release();
	limiter.release();
	await Promise.all([queued, queuedToo, fresh]);
	assert.ok(limiter.running <= 2, `running is ${limiter.running} for a limit of 2`);
});

test("ConcurrencyLimiter hands a released slot to the longest-waiting caller", async () => {
	const limiter = new ConcurrencyLimiter(1);
	const order: number[] = [];
	await limiter.acquire();

	const waiters = [1, 2, 3].map((id) => limiter.acquire().then(() => order.push(id)));
	await tick();
	limiter.release();
	await tick();
	limiter.release();
	await tick();
	limiter.release();
	await Promise.all(waiters);

	assert.deepEqual(order, [1, 2, 3], "waiters must be admitted in FIFO order");
	assert.equal(limiter.running, 1);
});

test("ConcurrencyLimiter rejects an acquire whose signal is already aborted", async () => {
	const limiter = new ConcurrencyLimiter(1);
	await limiter.acquire();
	const controller = new AbortController();
	controller.abort();

	await assert.rejects(limiter.acquire(controller.signal), /Aborted/);
	assert.equal(limiter.running, 1, "a rejected acquire must not hold a slot");
	limiter.release();
	assert.equal(limiter.running, 0);
});

test("ConcurrencyLimiter skips a waiter that aborted before its slot arrived", async () => {
	const limiter = new ConcurrencyLimiter(1);
	await limiter.acquire();

	const first = new AbortController();
	const cancelled = limiter.acquire(first.signal).then(
		() => undefined,
		(error: Error) => error,
	);
	let secondStarted = false;
	const second = limiter.acquire().then(() => {
		secondStarted = true;
	});
	await tick();

	first.abort();
	assert.match((await cancelled)?.message ?? "", /Aborted/);

	limiter.release();
	await second;
	assert.equal(secondStarted, true, "the freed slot goes to the next live waiter");
	assert.equal(limiter.running, 1);

	limiter.release();
	assert.equal(limiter.running, 0);
});

test("ConcurrencyLimiter ignores an abort that arrives after the slot was granted", async () => {
	const limiter = new ConcurrencyLimiter(1);
	const controller = new AbortController();
	await limiter.acquire(controller.signal);
	controller.abort();
	assert.equal(limiter.running, 1, "the granted slot is the caller's to release");
	limiter.release();
	assert.equal(limiter.running, 0);
});
