import { Level } from "./log.js";

export interface QueryParams {
    service?: string;
    level?: Level;
    since?: string | Date;
    until?: string | Date;
    q?: string;
    attr?: Record<string, string>;
}

export interface LogQueryPar extends QueryParams {
    limit?: number;
    cursor?: string;
}

const bucket_size = ['1m', '5m', '1h', '1d'] as const;
export type BucketSize = typeof bucket_size[number];

export interface AggQueryPar extends QueryParams {
    since: string | Date;
    until: string | Date;
    bucket: BucketSize;
    group_by?: 'service'|'level';
}

export const BUCKET_INTERVALS: Record<string, string> = {
  '1m': '1 minute',
  '5m': '5 minutes',
  '1h': '1 hour',
  '1d': '1 day',
};

export function isBucketSize(size: string): size is BucketSize {
    return typeof size === 'string' && bucket_size.includes(size as any);
}
