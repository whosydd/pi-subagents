/**
 * Live activity widget: a compact panel above the editor that lists what the
 * sub-agents are doing right now.
 *
 * The view is a controller, not a renderer. It owns the frame timer and the
 * widget's mount state. The mounted component reads the current rows on every
 * render. A run that turns from spinner to ✓ therefore needs no bookkeeping
 * from its caller. The caller only calls `refresh()` when a run starts, when a
 * turn completes, or when a run ends.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { formatDuration } from "./registry.ts";
import type { AgentRecord } from "./types.ts";

/** Braille spinner, one frame per tick. */
export const ACTIVITY_SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

/** How long a finished run keeps its ✓/✗ row before the panel drops it. */
export const ACTIVITY_COMPLETED_TTL_MS = 3_000;

/** Frame interval: fast enough to read as motion, slow enough to stay ambient. */
export const ACTIVITY_TICK_MS = 250;

/** One space of header indent, with rows nested two further. */
const HEADER_INDENT = 1;
const ROW_INDENT = 3;

/** One line's worth of state for a single run. */
export interface ActivityRow {
	id: string;
	state: AgentRecord["status"];
	type: string;
	description: string;
	turns: number;
	elapsedMs: number;
}

function toRow(record: AgentRecord, elapsedMs: number): ActivityRow {
	return {
		id: record.id,
		state: record.status,
		type: record.type,
		description: record.description,
		turns: record.turns,
		elapsedMs,
	};
}

/**
 * The rows the panel shows: every running record, plus each finished record
 * until its TTL expires. Order follows the registry (oldest start first), so a
 * row never jumps when a neighbouring run finishes.
 */
export function activityRows(
	records: readonly AgentRecord[],
	now: number,
	completedTtlMs: number = ACTIVITY_COMPLETED_TTL_MS,
): ActivityRow[] {
	const rows: ActivityRow[] = [];
	for (const record of records) {
		if (record.status === "running") {
			rows.push(toRow(record, now - record.startedAt));
			continue;
		}
		const completedAt = record.completedAt;
		// A run that finishes mid-tick has no completedAt yet. Treat it as running
		// until the record gets one.
		if (completedAt === undefined || now - completedAt > completedTtlMs) continue;
		rows.push(toRow(record, completedAt - record.startedAt));
	}
	return rows;
}

function markerFor(theme: Theme, state: ActivityRow["state"], frame: number): string {
	if (state === "running") return theme.fg("accent", ACTIVITY_SPINNER_FRAMES[frame % ACTIVITY_SPINNER_FRAMES.length]);
	if (state === "completed") return theme.fg("success", "✓");
	if (state === "aborted") return theme.fg("warning", "✗");
	return theme.fg("error", "✗");
}

/**
 * The widget's text. It opens and closes with a blank line, so the panel does
 * not touch the transcript above it or the editor below it. Each content line
 * is truncated to the available width, so a long description loses its tail
 * instead of wrapping the panel.
 */
export function renderActivityRows(rows: readonly ActivityRow[], frame: number, theme: Theme, width: number): string[] {
	if (rows.length === 0) return [];
	const lines: string[] = [];
	const running = rows.filter((row) => row.state === "running").length;
	if (running > 0) {
		const label = `${running} subagent${running === 1 ? "" : "s"} running`;
		lines.push(truncateToWidth(`${" ".repeat(HEADER_INDENT)}${theme.fg("accent", "✻")} ${theme.bold(label)}`, width));
	}
	for (const row of rows) {
		const meta = `${row.turns} turn${row.turns === 1 ? "" : "s"} · ${formatDuration(row.elapsedMs)}`;
		const line =
			`${" ".repeat(ROW_INDENT)}${markerFor(theme, row.state, frame)} ${theme.bold(row.type)}` +
			theme.fg("muted", " · ") +
			row.description +
			theme.fg("muted", ` · ${meta}`);
		lines.push(truncateToWidth(line, width));
	}
	return ["", ...lines, ""];
}

/** The slice of pi's TUI the view needs: a render request after each frame. */
export interface ActivityTui {
	requestRender(): void;
}

/** The component shape `ctx.ui.setWidget` accepts. */
export interface ActivityWidget {
	render(width: number): string[];
	invalidate(): void;
}

export interface AgentActivityWidgetOptions {
	/** Rows for the frame about to be rendered. */
	getRows(): ActivityRow[];
	/** Spinner frame index. The view owns the clock, so the widget stays pure. */
	getFrame(): number;
	/** The widget reads the theme at render time, so a theme switch lands on the
	 * next frame. */
	getTheme(): Theme;
}

/**
 * The mounted panel. It caches nothing: every render reads the live rows. The
 * view can therefore leave it mounted across spawns and let its timer drive
 * updates.
 */
export class AgentActivityWidget implements ActivityWidget {
	private readonly options: AgentActivityWidgetOptions;

	constructor(options: AgentActivityWidgetOptions) {
		this.options = options;
	}

	render(width: number): string[] {
		return renderActivityRows(this.options.getRows(), this.options.getFrame(), this.options.getTheme(), width);
	}

	invalidate(): void {
		// Stateless: every render reads the live rows and the current theme.
	}
}

export interface ActivityViewOptions {
	/** Records to project, in display order. */
	getRecords(): readonly AgentRecord[];
	/** Mount the widget. pi calls the factory once and disposes on replace/clear. */
	mount(factory: (tui: ActivityTui) => ActivityWidget): void;
	/** Remove the widget. */
	unmount(): void;
	/** Theme for the frame being rendered. */
	getTheme(): Theme;
	tickMs?: number;
	completedTtlMs?: number;
	/** Injectable clock, for tests. */
	now?(): number;
}

/**
 * Owns the frame timer and the widget's lifecycle: mounted while there is
 * something to show, unmounted once the last ✓ row has expired.
 */
export class SubagentActivityView {
	private readonly options: ActivityViewOptions;
	private readonly tickMs: number;
	private readonly completedTtlMs: number;
	private readonly clock: () => number;
	private timer: ReturnType<typeof setInterval> | undefined;
	private tui: ActivityTui | undefined;
	private mounted = false;
	private disposed = false;

	constructor(options: ActivityViewOptions) {
		this.options = options;
		this.tickMs = options.tickMs ?? ACTIVITY_TICK_MS;
		this.completedTtlMs = options.completedTtlMs ?? ACTIVITY_COMPLETED_TTL_MS;
		this.clock = options.now ?? Date.now;
	}

	/** Recompute the panel now. Call this on spawn, on a turn change, and on a run end. */
	refresh(): void {
		if (this.disposed) return;
		if (this.currentRows().length === 0) {
			this.hide();
			return;
		}
		if (!this.mounted) this.show();
		this.start();
		this.tui?.requestRender();
	}

	/** Stop the timer and remove the widget. The session is going away. */
	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.hide();
	}

	private currentRows(): ActivityRow[] {
		return activityRows(this.options.getRecords(), this.clock(), this.completedTtlMs);
	}

	private currentFrame(): number {
		return Math.floor(this.clock() / this.tickMs);
	}

	private show(): void {
		this.options.mount((tui) => {
			this.tui = tui;
			return new AgentActivityWidget({
				getRows: () => this.currentRows(),
				getFrame: () => this.currentFrame(),
				getTheme: this.options.getTheme,
			});
		});
		this.mounted = true;
	}

	private hide(): void {
		this.stop();
		if (!this.mounted) return;
		this.mounted = false;
		this.tui = undefined;
		this.options.unmount();
	}

	private start(): void {
		if (this.timer) return;
		this.timer = setInterval(() => this.tick(), this.tickMs);
		// A widget must not keep a headless process alive.
		this.timer.unref?.();
	}

	private stop(): void {
		if (!this.timer) return;
		clearInterval(this.timer);
		this.timer = undefined;
	}

	private tick(): void {
		if (this.disposed) return;
		if (this.currentRows().length === 0) {
			this.hide();
			return;
		}
		this.tui?.requestRender();
	}
}
