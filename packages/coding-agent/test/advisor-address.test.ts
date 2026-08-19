import { describe, expect, it } from "bun:test";
import {
	advisorDirectAddressInstruction,
	parseAdvisorAddress,
	primaryDeferralInstruction,
} from "../src/advisor/address";

describe("parseAdvisorAddress", () => {
	it("parses a leading @@<name>: prefix into name + trimmed question", () => {
		expect(parseAdvisorAddress("@@Phi: is the daemon up?")).toEqual({
			name: "Phi",
			question: "is the daemon up?",
		});
	});

	it("preserves the addressed token's case for the caller to resolve", () => {
		expect(parseAdvisorAddress("@@phi: hi")?.name).toBe("phi");
		expect(parseAdvisorAddress("@@PHI: hi")?.name).toBe("PHI");
	});

	it("tolerates leading whitespace and spacing around the colon", () => {
		expect(parseAdvisorAddress("  @@Phi : hello")).toEqual({ name: "Phi", question: "hello" });
		expect(parseAdvisorAddress("@@Phi:hello")).toEqual({ name: "Phi", question: "hello" });
	});

	it("captures a multiline body after the prefix", () => {
		expect(parseAdvisorAddress("@@Phi: line one\nline two")).toEqual({
			name: "Phi",
			question: "line one\nline two",
		});
	});

	it("allows slug-alphabet names (letters, digits, . _ -), starting with a letter", () => {
		expect(parseAdvisorAddress("@@security-reviewer: check this")?.name).toBe("security-reviewer");
		expect(parseAdvisorAddress("@@sonnet_4.5: q")?.name).toBe("sonnet_4.5");
	});

	it("does not match a single @ (reserved for OMP file/import mentions)", () => {
		expect(parseAdvisorAddress("@Phi: not an address")).toBeUndefined();
		expect(parseAdvisorAddress("@~/vault/personas/phi/README.md")).toBeUndefined();
	});

	it("requires the address to lead the message", () => {
		expect(parseAdvisorAddress("hey @@Phi: mid-sentence")).toBeUndefined();
	});

	it("rejects a name that does not start with a letter", () => {
		expect(parseAdvisorAddress("@@1phi: q")).toBeUndefined();
	});

	it("rejects an empty message body after the prefix", () => {
		expect(parseAdvisorAddress("@@Phi:")).toBeUndefined();
		expect(parseAdvisorAddress("@@Phi:   ")).toBeUndefined();
	});

	it("returns undefined for ordinary prompts", () => {
		expect(parseAdvisorAddress("just a normal message")).toBeUndefined();
		expect(parseAdvisorAddress("")).toBeUndefined();
	});
});

describe("address instruction builders", () => {
	it("templates the advisor's own name into the direct-address capability", () => {
		const instruction = advisorDirectAddressInstruction("Phi");
		expect(instruction).toContain("@@Phi:");
		expect(instruction).toContain("Direct address");
		expect(instruction).toContain("bias-to-silence");
	});

	it("names the addressee in the primary deferral directive and says do not answer", () => {
		const directive = primaryDeferralInstruction("Phi");
		expect(directive).toContain('"Phi"');
		expect(directive).toContain("@@Phi:");
		expect(directive).toMatch(/do not answer/i);
	});
});
