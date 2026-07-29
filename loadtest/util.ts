export function percentile(sorted: number[], p: number): number {
    if (sorted.length === 0) return 0;
    const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
    return sorted[idx];
}

export function summarize(label: string, latenciesMs: number[], errors: number, total: number): void {
    const sorted = [...latenciesMs].sort((a, b) => a - b);
    const max = sorted[sorted.length - 1] ?? 0;
    console.log(
        `${label}: ${total} requests, ${errors} errors, `
        + `p50=${percentile(sorted, 50).toFixed(1)}ms p95=${percentile(sorted, 95).toFixed(1)}ms `
        + `p99=${percentile(sorted, 99).toFixed(1)}ms max=${max.toFixed(1)}ms`
    );
}

export function pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(Math.random() * arr.length)];
}
