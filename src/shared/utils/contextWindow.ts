export function inferCodexContextWindow(modelName: string | null): number | null {
	if (!modelName) return null;
	const normalized = modelName.toLowerCase();

	if (normalized.includes('codex-mini')) {
		return 200_000;
	}

	if (normalized.includes('codex')) {
		return 400_000;
	}

	return null;
}
