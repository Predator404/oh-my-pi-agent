import { describe, expect, test } from "bun:test";
import {
	type BrokerToWorker,
	createMemoryLinkPair,
	encodeFrame,
	FrameParser,
	type WorkerToBroker,
} from "../worker-transport";

describe("frame codec", () => {
	test("round-trips a header with no payload", () => {
		const parser = new FrameParser();
		const frames = parser.push(encodeFrame({ type: "lifecycle", state: "ready" }));
		expect(frames).toHaveLength(1);
		expect(frames[0].header).toEqual({ type: "lifecycle", state: "ready" });
		expect(frames[0].payload.length).toBe(0);
	});

	test("round-trips a header with an opaque payload", () => {
		const parser = new FrameParser();
		const payload = Buffer.from("snapshot-bytes");
		const [frame] = parser.push(encodeFrame({ type: "event" }, payload));
		expect(frame.header).toEqual({ type: "event" });
		expect(frame.payload.toString()).toBe("snapshot-bytes");
	});

	test("reassembles a frame split across chunks", () => {
		const parser = new FrameParser();
		const whole = encodeFrame({ type: "auth", token: "t" });
		const first = parser.push(whole.subarray(0, 5));
		const second = parser.push(whole.subarray(5));
		expect(first).toHaveLength(0);
		expect(second).toHaveLength(1);
		expect(second[0].header).toMatchObject({ type: "auth", token: "t" });
	});

	test("yields multiple frames from one chunk", () => {
		const parser = new FrameParser();
		const buf = Buffer.concat([encodeFrame({ n: 1 }), encodeFrame({ n: 2 }), encodeFrame({ n: 3 })]);
		const frames = parser.push(buf);
		expect(frames.map(f => f.header)).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
	});

	test("rejects an oversized declared length", () => {
		const bogus = Buffer.alloc(8);
		bogus.writeUInt32BE(0xffffffff, 0);
		bogus.writeUInt32BE(0, 4);
		expect(() => new FrameParser().push(bogus)).toThrow(/size cap/);
	});
});

describe("memory link pair", () => {
	test("delivers worker→broker and broker→worker messages through the codec", async () => {
		const { broker, worker } = createMemoryLinkPair();
		const brokerInbox: WorkerToBroker[] = [];
		const workerInbox: BrokerToWorker[] = [];
		broker.onMessage(message => brokerInbox.push(message));
		worker.onMessage(message => workerInbox.push(message));

		worker.send({
			type: "auth",
			token: "tok",
			generation: "g1",
			activeSessionId: "s1",
			entityName: "phi",
			cwd: "/tmp",
		});
		broker.send({ type: "auth_ok", generation: "g1" });
		await Promise.resolve();
		await Promise.resolve();

		expect(brokerInbox).toEqual([
			{ type: "auth", token: "tok", generation: "g1", activeSessionId: "s1", entityName: "phi", cwd: "/tmp" },
		]);
		expect(workerInbox).toEqual([{ type: "auth_ok", generation: "g1" }]);
	});
});
