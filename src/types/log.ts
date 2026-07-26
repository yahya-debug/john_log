const levels = ["debug", "info", "warn", "error"] as const;
export const premitives = ['string', 'number', 'boolean'];
export type Level = typeof levels[number];

export type Log = {
    timestamp: string | Date;
    level: Level;
    service: string;
    message: string;
    attributes?: Record<string, string | number | boolean>;
};

export type ValidatedLog = Omit<Log, "attributes"> & {
    attributes?: Record<string, string>;
}

export type RejectedLog = {
    index: number;
    reason: string;
}

export function isLevel(claimed: unknown): claimed is Level {
    return typeof claimed === 'string' && levels.includes(claimed as any);
}