/**
 * Adapted from Prime Agent (https://github.com/PrimeIntellect-ai/prime-agent), MIT.
 * Copyright (c) 2025 Mario Zechner; Copyright (c) 2026 Prime Intellect.
 * Ported into Oh My Pi for the persistent multi-entity agent daemon subsystem.
 * See the repository NOTICE file for attribution.
 *
 * ---
 *
 * Schedule parsing for the daemon scheduler (SPEC §8.4, CONTRACTS.md C5).
 *
 * Self-contained port of Prime `core/cron-jobs.ts` schedule grammar: one-shot
 * literals (`in 30s`, `at <ISO>`), recurring intervals (`every 5m`), five-field
 * cron expressions, and `@hourly`/`@daily`/`@weekly`/`@monthly` aliases. No cron
 * npm dependency — the field parser and next-run search are hand-rolled so the
 * daemon carries no extra runtime deps.
 */

import type { AgentSchedule } from "./artifacts";
import type { AgentDeliveryMode } from "./control-protocol";

const ONE_SECOND_MS = 1000;
const ONE_MINUTE_MS = 60_000;

/** Default heartbeat cadence when a caller supplies no schedule. */
export const DEFAULT_HEARTBEAT_SCHEDULE = "every 5m";
/** Default busy-time delivery for heartbeats: interrupt the current turn. */
export const DEFAULT_HEARTBEAT_DELIVERY_MODE: AgentDeliveryMode = "steer";

/**
 * Parse a free-form schedule expression into a persisted {@link AgentSchedule}
 * plus the first run instant relative to `now`. Throws on malformed input.
 */
export function parseAgentCronSchedule(input: string, now = new Date()): { schedule: AgentSchedule; nextRunAt: Date } {
	const text = stripMatchingQuotes(input.trim());
	if (!text) {
		throw new Error("Schedule cannot be empty");
	}

	const inMatch = /^in\s+(\d+)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)$/i.exec(text);
	if (inMatch) {
		const amount = Number.parseInt(inMatch[1]!, 10);
		const unit = inMatch[2]!.toLowerCase();
		const multiplier = unit.startsWith("m")
			? ONE_MINUTE_MS
			: unit.startsWith("h")
				? 60 * ONE_MINUTE_MS
				: 24 * 60 * ONE_MINUTE_MS;
		return {
			schedule: { kind: "once", expression: text },
			nextRunAt: new Date(now.getTime() + amount * multiplier),
		};
	}

	const everyMatch =
		/^(?:every|each)\s+(\d+)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours)$/i.exec(
			text,
		);
	if (everyMatch) {
		const amount = Number.parseInt(everyMatch[1]!, 10);
		const unit = everyMatch[2]!.toLowerCase();
		const multiplier = unit.startsWith("s")
			? ONE_SECOND_MS
			: unit.startsWith("m")
				? ONE_MINUTE_MS
				: 60 * ONE_MINUTE_MS;
		const intervalMs = amount * multiplier;
		if (intervalMs < 10 * ONE_SECOND_MS) {
			throw new Error("Recurring interval must be at least 10 seconds");
		}
		return {
			schedule: { kind: "interval", expression: text, intervalMs },
			nextRunAt: new Date(now.getTime() + intervalMs),
		};
	}

	if (text.toLowerCase().startsWith("at ")) {
		const when = new Date(text.slice(3).trim());
		if (!Number.isFinite(when.getTime())) {
			throw new Error("Invalid one-shot schedule. Use: at <ISO date>");
		}
		if (when.getTime() <= now.getTime()) {
			throw new Error("One-shot schedule must be in the future");
		}
		return { schedule: { kind: "once", expression: text }, nextRunAt: when };
	}

	const expression = normalizeCronAlias(text);
	const nextRunAt = nextCronRunAfter(expression, now);
	return { schedule: { kind: "cron", expression }, nextRunAt };
}

/**
 * Compute the next run instant strictly after `after` for a recurring schedule.
 * Returns undefined for a one-shot schedule (it never re-arms).
 */
export function nextRunAtForSchedule(schedule: AgentSchedule, after: Date): Date | undefined {
	if (schedule.kind === "once") {
		return undefined;
	}
	if (schedule.kind === "interval") {
		if (!schedule.intervalMs || schedule.intervalMs <= 0) {
			throw new Error(`Invalid interval schedule: ${schedule.expression}`);
		}
		return new Date(after.getTime() + schedule.intervalMs);
	}
	return nextCronRunAfter(schedule.expression, after);
}

/**
 * Normalize a heartbeat schedule expression, defaulting to
 * {@link DEFAULT_HEARTBEAT_SCHEDULE} and coercing a bare duration
 * (`5m`) into an `every 5m` interval literal.
 */
export function normalizeHeartbeatSchedule(input: string | undefined): string {
	const text = input?.trim();
	if (!text) {
		return DEFAULT_HEARTBEAT_SCHEDULE;
	}
	if (/^\d+\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours)$/i.test(text)) {
		return `every ${text}`;
	}
	return text;
}

// --- cron field parser (five-field: minute hour day month weekday) ---------

interface CronFields {
	minute: Set<number>;
	hour: Set<number>;
	dayOfMonth: Set<number>;
	month: Set<number>;
	dayOfWeek: Set<number>;
}

function nextCronRunAfter(expression: string, after: Date): Date {
	const fields = parseCronExpression(expression);
	const candidate = new Date(after.getTime());
	candidate.setSeconds(0, 0);
	candidate.setMinutes(candidate.getMinutes() + 1);

	const deadline = candidate.getTime() + 366 * 24 * 60 * ONE_MINUTE_MS;
	while (candidate.getTime() <= deadline) {
		if (matchesCronFields(candidate, fields)) {
			return candidate;
		}
		candidate.setMinutes(candidate.getMinutes() + 1);
	}
	throw new Error(`Cron schedule did not match within one year: ${expression}`);
}

function parseCronExpression(expression: string): CronFields {
	const parts = expression.trim().split(/\s+/);
	if (parts.length !== 5) {
		throw new Error(
			"Unsupported schedule. Use 'in 10m', 'at <ISO date>', @hourly, or five fields: minute hour day month weekday",
		);
	}
	return {
		minute: parseCronField(parts[0]!, 0, 59),
		hour: parseCronField(parts[1]!, 0, 23),
		dayOfMonth: parseCronField(parts[2]!, 1, 31),
		month: parseCronField(parts[3]!, 1, 12),
		dayOfWeek: parseCronField(parts[4]!, 0, 7),
	};
}

function parseCronField(field: string, min: number, max: number): Set<number> {
	const values = new Set<number>();
	for (const part of field.split(",")) {
		if (!part) {
			throw new Error(`Invalid cron field: ${field}`);
		}
		const [rangeText, stepText] = part.split("/");
		const step = stepText === undefined ? 1 : parseCronNumber(stepText, 1, max);
		let start: number;
		let end: number;
		if (rangeText === "*") {
			start = min;
			end = max;
		} else if (rangeText?.includes("-")) {
			const [startText, endText] = rangeText.split("-");
			start = parseCronNumber(startText, min, max);
			end = parseCronNumber(endText, min, max);
			if (start > end) {
				throw new Error(`Invalid cron range: ${rangeText}`);
			}
		} else {
			start = parseCronNumber(rangeText, min, max);
			end = start;
		}
		for (let value = start; value <= end; value += step) {
			values.add(value);
		}
	}
	return values;
}

function parseCronNumber(value: string | undefined, min: number, max: number): number {
	if (!value || !/^\d+$/.test(value)) {
		throw new Error(`Invalid cron number: ${value ?? ""}`);
	}
	const parsed = Number.parseInt(value, 10);
	if (parsed < min || parsed > max) {
		throw new Error(`Cron number out of range: ${value}`);
	}
	return parsed;
}

function matchesCronFields(date: Date, fields: CronFields): boolean {
	const day = date.getDay();
	const dayMatches = fields.dayOfWeek.has(day) || (day === 0 && fields.dayOfWeek.has(7));
	return (
		fields.minute.has(date.getMinutes()) &&
		fields.hour.has(date.getHours()) &&
		fields.dayOfMonth.has(date.getDate()) &&
		fields.month.has(date.getMonth() + 1) &&
		dayMatches
	);
}

function normalizeCronAlias(text: string): string {
	switch (text) {
		case "@hourly":
			return "0 * * * *";
		case "@daily":
			return "0 0 * * *";
		case "@weekly":
			return "0 0 * * 0";
		case "@monthly":
			return "0 0 1 * *";
		default:
			return text;
	}
}

function stripMatchingQuotes(value: string): string {
	if (
		value.length >= 2 &&
		((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
	) {
		return value.slice(1, -1);
	}
	return value;
}
