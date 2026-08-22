/**
 * Cross-process entity identity: an entity-backed agent's display glyph
 * (`icon`) and theme-color token (`color`) must survive the collab wire so a
 * remote `oma entity attach` roster renders the same glyph + tint the local
 * Agent Hub shows in-process.
 *
 * Two halves, exercised over the real CollabHost/CollabGuestLink stack on the
 * in-memory relay:
 *   1. host side — the local AgentRegistry entity ref maps its icon/color into
 *      the wire `AgentSnapshot` broadcast in the welcome frame.
 *   2. guest side — the mirrored `AgentRef` receives icon/color, and
 *      `entityGlyph` renders it byte-for-byte like an in-process ref, including
 *      the ascii-preset fallback (glyph dropped, tint token retained).
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { generateRoomKey, importRoomKey } from "@oh-my-pi/pi-coding-agent/collab/crypto";
import { CollabGuestLink } from "@oh-my-pi/pi-coding-agent/collab/guest";
import { CollabHost } from "@oh-my-pi/pi-coding-agent/collab/host";
import {
	type AgentSnapshot,
	COLLAB_PROTO,
	type CollabFrame,
	formatCollabLink,
	parseCollabLink,
} from "@oh-my-pi/pi-coding-agent/collab/protocol";
import { CollabSocket } from "@oh-my-pi/pi-coding-agent/collab/relay-client";
import { entityGlyph } from "@oh-my-pi/pi-coding-agent/modes/components/agent-hub-renderer";
import {
	getRunningSubagentBadgeRegistry,
	countRunningSubagentBadgeAgents,
} from "@oh-my-pi/pi-coding-agent/modes/running-subagent-badge";
import { initTheme, setSymbolPreset, theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentRegistry, type AgentRef, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { installInMemoryRelay, uninstallInMemoryRelay } from "./helpers/in-memory-relay";

const ENTITY_ICON = "✦";
const ENTITY_COLOR = "accent";

/** Minimal InteractiveModeContext double: only the members CollabHost touches. */
function makeHostContext(): InteractiveModeContext {
	return {
		settings: { get: () => "" },
		sessionManager: {
			getSessionId: () => "sess-1",
			getCwd: () => "/tmp",
			snapshotForReplication: () => ({
				header: { type: "session", id: "sess-1", timestamp: new Date().toISOString(), cwd: "/tmp" },
				entries: [],
			}),
			onEntryAppended: undefined,
		},
		session: {
			isStreaming: false,
			queuedMessageCount: 0,
			sessionName: "test",
			model: undefined,
			thinkingLevel: undefined,
			subscribe: () => () => {},
			emitNotice: () => {},
			promptCustomMessage: () => Promise.resolve(),
			abort: () => Promise.resolve(),
		},
		eventBus: undefined,
		statusLine: {
			setCollabStatus: () => {},
			invalidate: () => {},
			getCachedContextBreakdown: () => ({ usedTokens: 0, contextWindow: 0 }),
		},
		ui: { requestRender: () => {} },
		showStatus: () => {},
		collabHost: undefined,
	} as unknown as InteractiveModeContext;
}

/** Minimal InteractiveModeContext double: only the members CollabGuestLink touches during join/apply. */
function makeGuestContext(): InteractiveModeContext {
	let statusLineCount = 0;
	const ctx = {
		collabGuest: undefined as CollabGuestLink | undefined,
		settings: { get: () => "" },
		sessionManager: {
			getSessionFile: () => null,
			getSessionName: () => "local session",
			getCwd: () => "/local",
		},
		session: {
			messages: [],
			switchSession: () => Promise.resolve(),
			newSession: () => Promise.resolve(),
			agent: {
				state: { model: undefined },
				setModel: () => {},
				setThinkingLevel: () => {},
				setDisableReasoning: () => {},
			},
		},
		statusContainer: { clear: () => {} },
		pendingMessagesContainer: { clear: () => {} },
		compactionQueuedMessages: [],
		streamingComponent: undefined,
		streamingMessage: undefined,
		transcriptMessageComponents: new WeakMap(),
		pendingTools: new Map(),
		loadingAnimation: undefined,
		statusLine: {
			setSubagentCount: (count: number) => {
				statusLineCount = count;
			},
			get subagentCount() {
				return statusLineCount;
			},
			setCollabStatus: () => {},
			invalidate: () => {},
			resetActiveTime: () => {},
			markActivityStart: () => {},
			markActivityEnd: () => {},
		},
		ui: { requestRender: () => {} },
		chatContainer: { clear: () => {} },
		resetObserverRegistry: () => {},
		renderInitialMessages: () => {},
		reloadTodos: () => Promise.resolve(),
		showStatus: () => {},
		showError: () => {},
		updateEditorTopBorder: () => {},
		updateEditorBorderColor: () => {},
		eventController: { handleEvent: () => Promise.resolve() },
		syncRunningSubagentBadge: () => {
			const registry = getRunningSubagentBadgeRegistry(ctx.collabGuest);
			ctx.statusLine.setSubagentCount(countRunningSubagentBadgeAgents(registry));
		},
	} as unknown as InteractiveModeContext;
	return ctx;
}

function makeState(): Extract<CollabFrame, { t: "welcome" }>["state"] {
	return {
		isStreaming: false,
		queuedMessageCount: 0,
		sessionName: "host session",
		cwd: "/tmp",
		participants: [{ name: "Host", role: "host" }],
	};
}

/** Raw guest speaking the wire protocol directly; drops debounced broadcasts and yields directed frames. */
const FILTERED_FRAME_TYPES: Record<string, true> = {
	state: true,
	agents: true,
	entry: true,
	event: true,
	bus: true,
	"snapshot-chunk": true,
};

async function joinAsGuest(link: string, name: string): Promise<{ socket: CollabSocket; nextFrame(): Promise<CollabFrame> }> {
	const parsed = parseCollabLink(link);
	if ("error" in parsed) throw new Error(parsed.error);
	const writeToken = parsed.writeToken ? Buffer.from(parsed.writeToken).toString("base64url") : undefined;
	const key = await importRoomKey(parsed.key);
	const socket = new CollabSocket({ wsUrl: parsed.wsUrl, role: "guest", key });
	const queue: CollabFrame[] = [];
	const waiters: ((frame: CollabFrame) => void)[] = [];
	socket.onFrame = frame => {
		if (FILTERED_FRAME_TYPES[frame.t]) return;
		const waiter = waiters.shift();
		if (waiter) waiter(frame);
		else queue.push(frame);
	};
	socket.onOpen = () => socket.send({ t: "hello", proto: COLLAB_PROTO, name, writeToken });
	socket.connect();
	const nextFrame = (): Promise<CollabFrame> => {
		const queued = queue.shift();
		if (queued) return Promise.resolve(queued);
		const { promise, resolve } = Promise.withResolvers<CollabFrame>();
		waiters.push(resolve);
		return promise;
	};
	return { socket, nextFrame };
}

const cleanups: (() => void)[] = [];
let host: CollabHost | undefined;

beforeEach(() => {
	AgentRegistry.resetGlobalForTests();
	installInMemoryRelay();
});

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
	if (host) {
		await host.stop("test done").catch(() => {});
		host = undefined;
	}
	uninstallInMemoryRelay();
	AgentRegistry.resetGlobalForTests();
});

describe("collab entity icon/color replication", () => {
	it("maps a local entity ref's icon+color into the wire AgentSnapshot broadcast to guests", async () => {
		const registry = AgentRegistry.global();
		registry.register({ id: MAIN_AGENT_ID, displayName: "Main", kind: "main", session: null });
		registry.register({
			id: "Sage",
			displayName: "Sage",
			icon: ENTITY_ICON,
			color: ENTITY_COLOR,
			kind: "sub",
			parentId: MAIN_AGENT_ID,
			session: null,
			sessionFile: "/tmp/Sage.jsonl",
			status: "running",
		});

		host = new CollabHost(makeHostContext());
		await host.start("ws://localhost:8787");

		const guest = await joinAsGuest(host.link, "writer");
		cleanups.push(() => guest.socket.close());
		const welcome = await guest.nextFrame();
		if (welcome.t !== "welcome") throw new Error(`expected welcome, got ${welcome.t}`);

		const snap = welcome.agents.find((a: AgentSnapshot) => a.id === "Sage");
		expect(snap).toBeDefined();
		expect(snap?.icon).toBe(ENTITY_ICON);
		expect(snap?.color).toBe(ENTITY_COLOR);
	});

	it("mirrors icon+color onto the guest-side AgentRef and renders exactly like in-process", async () => {
		await initTheme();
		// Pin a non-ascii preset so the glyph is present for the primary assertion.
		await setSymbolPreset("unicode");

		const writeSpy = spyOn(Bun, "write").mockResolvedValue(0);
		const roomId = "entity-room-1";
		const roomKey = generateRoomKey();
		const cryptoKey = await importRoomKey(roomKey);
		const link = formatCollabLink("ws://localhost:8788", roomId, roomKey);
		const hostSocket = new CollabSocket({ wsUrl: `ws://localhost:8788/r/${roomId}`, role: "host", key: cryptoKey });
		const hostOpen = Promise.withResolvers<void>();
		const agents: AgentSnapshot[] = [
			{
				id: MAIN_AGENT_ID,
				displayName: "Main",
				kind: "main",
				status: "running",
				hasSessionFile: true,
				createdAt: 1000,
				lastActivity: 2000,
			},
			{
				id: "Sage",
				displayName: "Sage",
				icon: ENTITY_ICON,
				color: ENTITY_COLOR,
				kind: "sub",
				parentId: MAIN_AGENT_ID,
				status: "running",
				hasSessionFile: true,
				createdAt: 1001,
				lastActivity: 2001,
			},
		];
		hostSocket.onOpen = () => hostOpen.resolve();
		hostSocket.onFrame = frame => {
			if (frame.t !== "hello") return;
			hostSocket.send({
				t: "welcome",
				proto: COLLAB_PROTO,
				header: { type: "session", id: "remote-session", timestamp: "2026-06-26T00:00:00Z", cwd: "/tmp" },
				state: makeState(),
				agents,
				entryCount: 0,
			});
		};
		hostSocket.connect();
		await hostOpen.promise;

		const ctx = makeGuestContext();
		const guest = new CollabGuestLink(ctx);
		cleanups.push(() => hostSocket.close());

		try {
			await guest.join(link);

			const mirrored = guest.agentRegistry.get("Sage");
			expect(mirrored).toBeDefined();
			expect(mirrored?.icon).toBe(ENTITY_ICON);
			expect(mirrored?.color).toBe(ENTITY_COLOR);

			// Renders byte-for-byte like an equivalent in-process ref.
			const local = new AgentRegistry();
			const inProcess = local.register({
				id: "Sage",
				displayName: "Sage",
				icon: ENTITY_ICON,
				color: ENTITY_COLOR,
				kind: "sub",
				parentId: MAIN_AGENT_ID,
				session: null,
				status: "running",
			});
			const rendered = entityGlyph(mirrored as AgentRef);
			expect(rendered).toBe(entityGlyph(inProcess));
			expect(rendered).toBe(theme.fg(ENTITY_COLOR, ENTITY_ICON));
			expect(rendered).not.toBe(ENTITY_ICON); // carries the color tint, not a bare glyph

			// ascii preset: the glyph is dropped, but the color token stays on the ref (the tint source).
			await setSymbolPreset("ascii");
			expect(entityGlyph(mirrored as AgentRef)).toBe("");
			expect(mirrored?.color).toBe(ENTITY_COLOR);
		} finally {
			await setSymbolPreset("unicode");
			await guest.leave("test cleanup").catch(() => {});
			writeSpy.mockRestore();
		}
	});
});

/** Join a guest to a raw host socket that answers `hello` with `welcome` carrying `agents`.
 * `nextApply()` resolves on the next snapshot-apply (the guest calls `syncRunningSubagentBadge`
 * immediately after every `#applyAgentSnapshots`), so tests await the real signal, not a timer. */
async function joinGuestWithAgents(
	port: number,
	roomId: string,
	agents: AgentSnapshot[],
): Promise<{ guest: CollabGuestLink; hostSocket: CollabSocket; nextApply: () => Promise<void> }> {
	const roomKey = generateRoomKey();
	const cryptoKey = await importRoomKey(roomKey);
	const link = formatCollabLink(`ws://localhost:${port}`, roomId, roomKey);
	const hostSocket = new CollabSocket({ wsUrl: `ws://localhost:${port}/r/${roomId}`, role: "host", key: cryptoKey });
	const hostOpen = Promise.withResolvers<void>();
	hostSocket.onOpen = () => hostOpen.resolve();
	hostSocket.onFrame = frame => {
		if (frame.t !== "hello") return;
		hostSocket.send({
			t: "welcome",
			proto: COLLAB_PROTO,
			header: { type: "session", id: "remote-session", timestamp: "2026-06-26T00:00:00Z", cwd: "/tmp" },
			state: makeState(),
			agents,
			entryCount: 0,
		});
	};
	hostSocket.connect();
	await hostOpen.promise;

	const ctx = makeGuestContext();
	const applyWaiters: Array<() => void> = [];
	const origSync = ctx.syncRunningSubagentBadge.bind(ctx);
	ctx.syncRunningSubagentBadge = () => {
		origSync();
		for (const w of applyWaiters.splice(0)) w();
	};
	const nextApply = (): Promise<void> => {
		const { promise, resolve } = Promise.withResolvers<void>();
		applyWaiters.push(resolve);
		return promise;
	};

	const guest = new CollabGuestLink(ctx);
	cleanups.push(() => hostSocket.close());
	await guest.join(link);
	return { guest, hostSocket, nextApply };
}

describe("collab entity icon/color adversarial", () => {
	beforeEach(async () => {
		await initTheme();
		await setSymbolPreset("unicode");
	});
	afterEach(async () => {
		await setSymbolPreset("unicode");
	});

	it("renders an invalid color token untinted (bare glyph), without throwing", () => {
		const local = new AgentRegistry();
		const ref = local.register({
			id: "Bad",
			displayName: "Bad",
			icon: ENTITY_ICON,
			color: "not-a-real-color",
			kind: "sub",
			parentId: MAIN_AGENT_ID,
			session: null,
			status: "running",
		});
		let out = "";
		expect(() => {
			out = entityGlyph(ref);
		}).not.toThrow();
		// Invalid token is silently ignored: glyph survives, but carries no tint.
		expect(out).toBe(ENTITY_ICON);
		expect(out).not.toBe(theme.fg(ENTITY_COLOR, ENTITY_ICON));
	});

	it("renders plain (empty glyph) for a ref with no icon/color and never crashes", () => {
		const local = new AgentRegistry();
		const ref = local.register({
			id: "Plain",
			displayName: "Plain",
			kind: "sub",
			parentId: MAIN_AGENT_ID,
			session: null,
			status: "running",
		});
		expect(ref.icon).toBeUndefined();
		expect(ref.color).toBeUndefined();
		expect(entityGlyph(ref)).toBe("");
	});

	it("leaves the non-entity welcome-frame consumer (plain main ref) untinted", async () => {
		const writeSpy = spyOn(Bun, "write").mockResolvedValue(0);
		try {
			const { guest } = await joinGuestWithAgents(8790, "adv-welcome", [
				{
					id: MAIN_AGENT_ID,
					displayName: "Main",
					kind: "main",
					status: "running",
					hasSessionFile: true,
					createdAt: 1000,
					lastActivity: 2000,
				},
			]);
			const main = guest.agentRegistry.get(MAIN_AGENT_ID);
			expect(main).toBeDefined();
			expect(main?.icon).toBeUndefined();
			expect(main?.color).toBeUndefined();
			expect(entityGlyph(main as AgentRef)).toBe("");
			await guest.leave("test cleanup").catch(() => {});
		} finally {
			writeSpy.mockRestore();
		}
	});

	it("patches icon/color on an existing mirrored ref when the host resnapshots (not just first register)", async () => {
		const writeSpy = spyOn(Bun, "write").mockResolvedValue(0);
		try {
			const { guest, hostSocket, nextApply } = await joinGuestWithAgents(8791, "adv-resnap", [
				{
					id: "Sage",
					displayName: "Sage",
					icon: ENTITY_ICON,
					color: ENTITY_COLOR,
					kind: "sub",
					parentId: MAIN_AGENT_ID,
					status: "running",
					hasSessionFile: true,
					createdAt: 1001,
					lastActivity: 2001,
				},
			]);
			const first = guest.agentRegistry.get("Sage");
			expect(first?.icon).toBe(ENTITY_ICON);
			expect(first?.color).toBe(ENTITY_COLOR);

			// Resnapshot with changed glyph + tint: the existing ref (same object) must be patched.
			const patchedApplied = nextApply();
			hostSocket.send({
				t: "agents",
				agents: [
					{
						id: "Sage",
						displayName: "Sage",
						icon: "★",
						color: "error",
						kind: "sub",
						parentId: MAIN_AGENT_ID,
						status: "running",
						hasSessionFile: true,
						createdAt: 1001,
						lastActivity: 2002,
					},
				],
			});
			await patchedApplied;
			const patched = guest.agentRegistry.get("Sage");
			expect(patched).toBe(first); // same ref object, mutated in place
			expect(patched?.icon).toBe("★");
			expect(patched?.color).toBe("error");

			// Resnapshot that drops icon/color: the ref must clear, not retain stale identity.
			const clearedApplied = nextApply();
			hostSocket.send({
				t: "agents",
				agents: [
					{
						id: "Sage",
						displayName: "Sage",
						kind: "sub",
						parentId: MAIN_AGENT_ID,
						status: "running",
						hasSessionFile: true,
						createdAt: 1001,
						lastActivity: 2003,
					},
				],
			});
			await clearedApplied;
			expect(guest.agentRegistry.get("Sage")?.icon).toBeUndefined();
			expect(guest.agentRegistry.get("Sage")?.color).toBeUndefined();
			expect(entityGlyph(guest.agentRegistry.get("Sage") as AgentRef)).toBe("");

			await guest.leave("test cleanup").catch(() => {});
		} finally {
			writeSpy.mockRestore();
		}
	});
});
