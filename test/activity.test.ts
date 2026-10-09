import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	ACTIVITY_COMPLETED_TTL_MS,
	ACTIVITY_TICK_MS,
	AgentActivityWidget,
	SubagentActivityView,
	activityRows,
	renderActivityRows,
	type ActivityRow,
	type ActivityWidget,
} from "../extensions/lib/activity.ts";
import { EMPTY_USAGE, type AgentRecord } from "../extensions/lib/types.ts";

/** Styles carry no colour here: assertions read the text, not the escape codes. */
const identityTheme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

function record(id: string, overrides: Partial<AgentRecord> = {}): AgentRecord {
	return {
		id,
		type: "general",
		description: id,
		prompt: "do the thing",
		status: "running",
		startedAt: 0,
		turns: 0,
		usage: { ...EMPTY_USAGE },
		...overrides,
	};
}

test("activityRows shows running runs and finished ones inside their TTL", () => {
	const records = [
		record("running", { startedAt: 1_000 }),
		record("fresh", { status: "completed", completedAt: 5_000, turns: 3 }),
		record("stale", { status: "completed", completedAt: 1_000 }),
	];
	const rows = activityRows(records, 5_000, ACTIVITY_COMPLETED_TTL_MS);

	assert.deepEqual(
		rows.map((row) => row.id),
		["running", "fresh"],
		"the stale row is past its TTL",
	);
	assert.equal(rows[0].elapsedMs, 4_000, "a running row ticks with the clock");
	assert.equal(rows[1].elapsedMs, 5_000, "a finished row freezes its elapsed time");
});

test("activityRows keeps a row exactly at the TTL boundary", () => {
	const records = [record("edge", { status: "completed", completedAt: 2_000 })];
	assert.equal(activityRows(records, 2_000 + ACTIVITY_COMPLETED_TTL_MS, ACTIVITY_COMPLETED_TTL_MS).length, 1);
	assert.equal(activityRows(records, 2_000 + ACTIVITY_COMPLETED_TTL_MS + 1, ACTIVITY_COMPLETED_TTL_MS).length, 0);
});

test("activityRows ignores a finished run that never recorded its end", () => {
	// completedAt anchors the TTL. Without it there is nothing to show.
	assert.deepEqual(activityRows([record("odd", { status: "completed" })], 10_000, ACTIVITY_COMPLETED_TTL_MS), []);
});

test("renderActivityRows heads the list with the running count", () => {
	const rows: ActivityRow[] = [
		{ id: "a", state: "running", type: "explore", description: "Map the widget API", turns: 3, elapsedMs: 12_000 },
		{ id: "b", state: "running", type: "general", description: "Write the renderer", turns: 1, elapsedMs: 4_000 },
	];
	const lines = renderActivityRows(rows, 0, identityTheme, 80);

	assert.equal(lines[0], "", "a blank line separates the panel from the transcript");
	assert.equal(lines[1], " ✻ 2 subagents running");
	assert.match(lines[2], /^ {3}⠋ explore · Map the widget API · 3 turns · 12\.0s$/);
	assert.match(lines[3], /^ {3}⠋ general · Write the renderer · 1 turn · 4\.0s$/);
	assert.equal(lines[4], "", "a blank line separates the panel from the editor");
});

test("renderActivityRows singularises one agent and drops the header once nothing runs", () => {
	const running = renderActivityRows(
		[{ id: "a", state: "running", type: "explore", description: "Map", turns: 0, elapsedMs: 500 }],
		0,
		identityTheme,
		80,
	);
	assert.equal(running[0], "");
	assert.equal(running[1], " ✻ 1 subagent running");

	const finished = renderActivityRows(
		[
			{ id: "a", state: "completed", type: "explore", description: "Done", turns: 2, elapsedMs: 9_000 },
			{ id: "b", state: "failed", type: "general", description: "Broken", turns: 1, elapsedMs: 900 },
			{ id: "c", state: "aborted", type: "explore", description: "Stopped", turns: 0, elapsedMs: 300 },
		],
		0,
		identityTheme,
		80,
	);
	assert.equal(finished.length, 5, "no header while only finished rows remain, just the padding");
	assert.match(finished[1], /✓ explore · Done · 2 turns · 9\.0s/);
	assert.match(finished[2], /✗ general · Broken/);
	assert.match(finished[3], /✗ explore · Stopped/);
});

test("renderActivityRows returns nothing for no rows and truncates to the width", () => {
	assert.deepEqual(renderActivityRows([], 0, identityTheme, 80), []);

	const lines = renderActivityRows(
		[{ id: "a", state: "running", type: "explore", description: "x".repeat(200), turns: 1, elapsedMs: 1_000 }],
		0,
		identityTheme,
		20,
	);
	assert.equal(lines.length, 4, "blank line, header, row, blank line");
	for (const line of lines) assert.ok(visibleWidth(line) <= 20, `line wider than the terminal: ${line}`);
	assert.ok(!lines[2].includes("x".repeat(10)), "the tail is cut, not wrapped");
});

test("AgentActivityWidget renders the live rows for the frame it was asked for", () => {
	let frame = 0;
	const widget = new AgentActivityWidget({
		getRows: () => [{ id: "a", state: "running", type: "explore", description: "Map", turns: 1, elapsedMs: 2_000 }],
		getFrame: () => frame,
		getTheme: () => identityTheme,
	});

	assert.match(widget.render(80)[2], /⠋/);
	frame = 1;
	assert.match(widget.render(80)[2], /⠙/);
});

interface Host {
	records: AgentRecord[];
	component: ActivityWidget | undefined;
	mounts: number;
	unmounts: number;
	tuiRenders: number;
}

function createHost(records: AgentRecord[] = []): Host {
	return { records, component: undefined, mounts: 0, unmounts: 0, tuiRenders: 0 };
}

function createView(host: Host, now: () => number): SubagentActivityView {
	return new SubagentActivityView({
		getRecords: () => host.records,
		mount: (factory) => {
			host.mounts += 1;
			host.component = factory({ requestRender: () => (host.tuiRenders += 1) });
		},
		unmount: () => {
			host.unmounts += 1;
			host.component = undefined;
		},
		getTheme: () => identityTheme,
		now,
	});
}

test("SubagentActivityView mounts while a run is visible and unmounts when idle", () => {
	const host = createHost();
	let now = 0;
	const view = createView(host, () => now);

	view.refresh();
	assert.equal(host.mounts, 0, "nothing to show, nothing mounted");

	host.records.push(record("a"));
	view.refresh();
	assert.equal(host.mounts, 1);
	assert.equal(host.tuiRenders, 1, "the fresh mount asks for a frame");
	assert.ok(host.component);
	assert.match(host.component.render(80)[2], /⠋/, "the spinner starts at frame 0");

	now = ACTIVITY_TICK_MS;
	view.refresh();
	assert.equal(host.mounts, 1, "a later refresh reuses the mounted widget");
	assert.equal(host.tuiRenders, 2);

	const finished = host.records[0];
	finished.status = "completed";
	finished.completedAt = now;
	view.refresh();
	assert.equal(host.unmounts, 0, "the ✓ row keeps its TTL");

	now += ACTIVITY_COMPLETED_TTL_MS + 1;
	view.refresh();
	assert.equal(host.unmounts, 1);
	view.dispose();
});

test("the frame timer renders updates and hides the panel once the TTL expires", (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const host = createHost([record("a")]);
	let now = 0;
	const view = createView(host, () => now);
	view.refresh();
	assert.equal(host.mounts, 1);

	const rendersAfterMount = host.tuiRenders;
	now = ACTIVITY_TICK_MS;
	t.mock.timers.tick(ACTIVITY_TICK_MS);
	assert.equal(host.tuiRenders, rendersAfterMount + 1, "a tick asks for a frame");

	host.records[0].status = "completed";
	host.records[0].completedAt = now;
	now += ACTIVITY_COMPLETED_TTL_MS - 1;
	t.mock.timers.tick(ACTIVITY_COMPLETED_TTL_MS - 1);
	assert.equal(host.unmounts, 0, "still inside the TTL");

	now += 2;
	t.mock.timers.tick(2);
	assert.equal(host.unmounts, 1, "the panel clears itself when the last row expires");
	view.dispose();
});

test("dispose removes the panel, stops the timer and stays idempotent", (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const host = createHost([record("a")]);
	let now = 0;
	const view = createView(host, () => now);
	view.refresh();

	view.dispose();
	assert.equal(host.unmounts, 1);

	const renders = host.tuiRenders;
	now += ACTIVITY_TICK_MS * 4;
	t.mock.timers.tick(ACTIVITY_TICK_MS * 4);
	assert.equal(host.tuiRenders, renders, "no frames after dispose");

	view.dispose();
	assert.equal(host.unmounts, 1, "a second dispose is a no-op");
});
