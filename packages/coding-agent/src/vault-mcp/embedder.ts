/**
 * Local embedding provider for the vault MCP bridge (contract C3, SPEC §7.1).
 *
 * The semantic/read path is powered by Smart Connections embeddings that the
 * Obsidian plugin computes and stores locally under `.smart-env/` (no cloud).
 * To answer a free-text `search_notes` query we must embed the *query* with the
 * SAME model that produced those stored vectors, then rank by cosine similarity.
 *
 * The default {@link TransformersEmbedder} runs `TaylorAI/bge-micro-v2` (Smart
 * Connections' default, 384-dim) fully on-device via `@huggingface/transformers`
 * (Transformers.js on onnxruntime) — the model is fetched once from the HF hub
 * and then cached under `~/.cache/huggingface`; no vault content or query ever
 * leaves the machine to a cloud inference service.
 *
 * The {@link Embedder} seam is injectable so tests (and alternate deployments)
 * can supply a deterministic embedder without loading a model.
 */

/** An on-device text embedder. Implementations MUST NOT make cloud calls. */
export interface Embedder {
	/** HF model key, e.g. `TaylorAI/bge-micro-v2`. */
	readonly modelKey: string;
	/** Vector dimensionality produced by {@link embed}. */
	readonly dimensions: number;
	/** Embed a single text into a dense vector. */
	embed(text: string): Promise<number[]>;
}

/** Smart Connections' default embedding model (matches its stored vectors). */
export const DEFAULT_EMBED_MODEL = "TaylorAI/bge-micro-v2";

/** Known model → dimensionality, mirroring Smart Connections' bundled set. */
const KNOWN_MODEL_DIMS: Readonly<Record<string, number>> = {
	"TaylorAI/bge-micro-v2": 384,
	"sentence-transformers/all-MiniLM-L6-v2": 384,
	"BAAI/bge-small-en-v1.5": 384,
	"BAAI/bge-base-en-v1.5": 768,
	"BAAI/bge-large-en-v1.5": 1024,
};

/** Resolve the vector dimension for a known model key (default 384). */
export function modelDimensions(modelKey: string): number {
	return KNOWN_MODEL_DIMS[modelKey] ?? 384;
}

/** Model context window is ~512 tokens; cap embed input conservatively. */
const MAX_EMBED_CHARS = 1500;

type FeatureExtractionPipeline = (
	text: string,
	options: { pooling: "mean"; normalize: boolean },
) => Promise<{ data: Float32Array | number[] }>;

/** Options for {@link TransformersEmbedder}. */
export interface TransformersEmbedderOptions {
	/**
	 * Local-only mode: never fetch from the HF hub. The model must already be
	 * cached (prefetched once, e.g. by WS7a setup) or `embed` fails with a clear
	 * error. Defaults to `true` when `OMP_VAULT_EMBED_OFFLINE` is set.
	 */
	offline?: boolean;
	/** Model cache directory; defaults to `OMP_VAULT_EMBED_CACHE` or transformers.js's default (~/.cache/huggingface). */
	cacheDir?: string;
}

/**
 * On-device embedder backed by Transformers.js (`@huggingface/transformers`, an
 * optional dependency). The pipeline is created lazily on first `embed`.
 *
 * Cold-cache note: on the very first run for a given model, Transformers.js
 * downloads the model weights (~25-50 MB) once from the HF hub, then serves
 * every subsequent call fully offline from the local cache — identical to how
 * Smart Connections itself bootstraps. No vault content or query is ever sent to
 * a cloud inference service. Set `offline` (or `OMP_VAULT_EMBED_OFFLINE`) to
 * forbid the download entirely and require a pre-populated cache.
 */
export class TransformersEmbedder implements Embedder {
	readonly modelKey: string;
	readonly dimensions: number;
	private readonly offline: boolean;
	private readonly cacheDir?: string;
	private pipeline: FeatureExtractionPipeline | null = null;
	private loading: Promise<void> | null = null;

	constructor(modelKey: string = DEFAULT_EMBED_MODEL, options: TransformersEmbedderOptions = {}) {
		this.modelKey = modelKey;
		this.dimensions = modelDimensions(modelKey);
		this.offline = options.offline ?? process.env.OMP_VAULT_EMBED_OFFLINE !== undefined;
		this.cacheDir = options.cacheDir ?? process.env.OMP_VAULT_EMBED_CACHE;
	}

	private async ensurePipeline(): Promise<void> {
		if (this.pipeline) return;
		if (!this.loading) {
			this.loading = (async () => {
				let mod: { pipeline: (...args: unknown[]) => Promise<unknown> };
				try {
					// Dynamic import: `@huggingface/transformers` is an OPTIONAL dependency and may
					// be absent; a static import would break loading the module everywhere it is not
					// installed. Mirrors the lazy `await import("@oh-my-pi/pi-mnemopi")` pattern in
					// src/mnemopi/state.ts.
					mod = (await import("@huggingface/transformers")) as unknown as typeof mod;
				} catch (cause) {
					throw new Error(
						"Semantic search needs the optional '@huggingface/transformers' dependency (Transformers.js). " +
							`Install it to enable on-device query embedding. Cause: ${String(cause)}`,
					);
				}
				const transformers = mod as typeof mod & {
					env?: { allowRemoteModels?: boolean; allowLocalModels?: boolean; cacheDir?: string };
				};
				if (transformers.env) {
					// Local-only when offline: forbid any HF-hub fetch so a controlled prefetch
					// (WS7a) is the only network the embedder ever performs.
					if (this.offline) transformers.env.allowRemoteModels = false;
					if (this.cacheDir) transformers.env.cacheDir = this.cacheDir;
				}
				this.pipeline = (await mod.pipeline("feature-extraction", this.modelKey, {
					dtype: "fp32",
				})) as unknown as FeatureExtractionPipeline;
			})();
		}
		await this.loading;
	}

	async embed(text: string): Promise<number[]> {
		const input = text.slice(0, MAX_EMBED_CHARS).trim();
		if (input.length === 0) throw new Error("Cannot embed empty text");
		await this.ensurePipeline();
		if (!this.pipeline) throw new Error("Embedder pipeline unavailable");
		const result = await this.pipeline(input, { pooling: "mean", normalize: true });
		return Array.from(result.data);
	}
}

/** Cosine similarity of two equal-length vectors (0 when either is degenerate). */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
	const len = Math.min(a.length, b.length);
	if (len === 0) return 0;
	let dot = 0;
	let normA = 0;
	let normB = 0;
	for (let i = 0; i < len; i++) {
		const x = a[i] ?? 0;
		const y = b[i] ?? 0;
		dot += x * y;
		normA += x * x;
		normB += y * y;
	}
	if (normA === 0 || normB === 0) return 0;
	return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
