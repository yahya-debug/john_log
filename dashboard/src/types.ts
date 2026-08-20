export type Level = 'debug' | 'info' | 'warn' | 'error';

export type LogEntry = {
    id: string;
    timestamp: string;
    level: Level;
    service: string;
    message: string;
    attributes: Record<string, string>;
};

export type TailEntry = Omit<LogEntry, 'id'>;

export type LogsResponse = {
    logs: LogEntry[];
    next_cursor: string | null;
};

export type AggregateBucket = {
    start: string;
    group: 'service' | 'level' | null;
    count: number;
};

export type AggregateResponse = {
    buckets: AggregateBucket[];
};

export type PartitionStat = {
    name: string;
    bound: string | null;
    rows_estimate: number;
    size_bytes: number;
};

export type Stats = {
    totals: {
        rows: number;
        by_level: Record<Level, number>;
        by_service: Record<string, number>;
    };
    partitions: PartitionStat[];
    time_range: {
        oldest: string | null;
        newest: string | null;
    };
    ingestion_rate: {
        last_1m: number;
        last_5m: number;
        per_second_1m: number;
    };
    retention_config: {
        retention_days: number;
        partition_lookahead_days: number;
        retention_cron: string;
    };
    database_size_bytes: number;
}

export type RejectedEntry = {
    index: number;
    reason: string;
}

// 200/400 response for ingestion. 429 is not included in this shape
export type IngestResponse = {
    accepted: number;
    rejected: RejectedEntry[];
}

export type DeadLetterRow = {
    id: string;
    failedAt: string;
    reason: string;
    entries: TailEntry[];
}

// body of POST admin/dead-letter/replay
export type ReplayResponse = {
    replayed: number;
    stillFailed: number;
}

const tabIdentifiersArr = ['stats', 'ingest', 'aggregate', 'logs', 'tail', 'dead'] as const;
export type TabIdentifiers = typeof tabIdentifiersArr[number];

export type LABELS = Record<TabIdentifiers, string>;