# Upstream attribution

The files `vendor/parse.ts`, `vendor/types.ts`, and `vendor/utils.ts` are copied unchanged from [langfuse/codex-observability-plugin](https://github.com/langfuse/codex-observability-plugin), plugin version **0.3.0**, commit **1db5c0f5ddce569afc112c6476e21d00cf9a482e**.

Source directory: [`plugins/tracing/src`](https://github.com/langfuse/codex-observability-plugin/tree/1db5c0f5ddce569afc112c6476e21d00cf9a482e/plugins/tracing/src). The synthetic parser fixtures in `test/fixtures/codex/` come from the same commit's test directory. The upstream MIT license and copyright notice are retained in [vendor/LICENSE](vendor/LICENSE).

Langfuse Helper owns `scripts/hook.mjs`, the CLI adapter and the shared target/delivery modules. The runtime bundle combines these with the upstream parser. It does not invoke the upstream SDK exporter, read Codex authentication/email, merge upstream environment overrides, or write upstream `.langfuse` sidecars.

Local behavior includes metadata-by-default capture, sanitized opt-in text without reasoning, deterministic observation IDs, project-scoped delivery ledgers, fixed task target/content bindings, and acknowledgement-based completion. Completed parent trees are snapshots; late child turns are not appended to an already accepted parent.
