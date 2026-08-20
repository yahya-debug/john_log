import type { AggregateResponse, DeadLetterRow, IngestResponse, Level, LogsResponse, ReplayResponse, Stats } from "./types";

export type LogsQuery = {
    service?: string;
    level?: Level;
    since?: string;
    until?: string;
    q?: string;
    attr?: Record<string, string>;
    limit?: number;
    cursor?: string;
}
export type AggregateQuery = Omit<LogsQuery, 'limit' | 'cursor'> & {
    since: string;
    until: string;
    bucket: '1m' | '5m' | '1h' | '1d';
    group_by?: 'service' | 'level';
}

export function buildQuery(params: Record<string, string | number | undefined>, attr?: Record<string, unknown>): string {
    let url: string = '?';

    for (const param in params)
        if (params[param] != undefined || (param as string).trim() == '')
            url += `${param}=${params[param]}`;

    if (attr)
        for (const key in attr)
            url += `attr.${key}=${attr[key]}`

    return url == '?' ? '':url;
}

export async function getJSON<T>(url: string): Promise<T> {
    const json = await fetch(url);
    const data = await json.json();

    if (data.error)
        throw new Error(data.error);

    return data;
}

export async function postJSON<T>(url: string, header?: any, body?: any): Promise<{status: number; response: T}> {
    const json = await fetch(url, {
        method: 'POST',
        headers: header,
        body: body,
    });

    const response = await json.json();

    if (response.error)
        throw new Error(response.error)

    return {status: json.status, response: (response as T)};
}

export async function getLogs(query: LogsQuery): Promise<LogsResponse> {
    let params = {
        service: query.service,
        level: query.level,
        since: query.since,
        until: query.until,
        q: query.q,
        limit: query.limit,
        cursor: query.cursor
    };
    const attr = query.attr;

    const url = '/logs/' + buildQuery(params, attr);

    return await getJSON<LogsResponse>(url);
}

export async function postLogs(logs: unknown[]): Promise<{
    status: number;
    body: IngestResponse | {error: string};
}> {
    const response = await postJSON<any>('/logs/',
        {
            'Content-Type': 'application/json'
        }, JSON.stringify({ logs })
    );

    return {
        status: response.status,
        body: response.response,
    }
}

export async function getAggregate(query: AggregateQuery): Promise<AggregateResponse> {
    let params = {
        service: query.service,
        level: query.level,
        since: query.since,
        until: query.until,
        bucket: query.bucket,
        q: query.q,

    }

    const url = '/logs/aggregate/' + buildQuery(params);
    return await getJSON<AggregateResponse>(url);
}


export async function getStats(): Promise<Stats> {
    return await getJSON<Stats>('/admin/stats');
}

export function tailURL(filters: {service?: string, level?: Level}): string {
    return '/admin/logs/tail/' + buildQuery(filters);
}

export async function getDeadLetters(): Promise<DeadLetterRow[]> {
    return await getJSON<DeadLetterRow[]>('/admin/dead-letter');
}

export async function replayDeadLetter(): Promise<ReplayResponse> {
    return (await postJSON<ReplayResponse>('/admin/dead-letter/replay')).response;
}

