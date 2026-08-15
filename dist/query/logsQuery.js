import { DEFAULT_LIMIT, MAX_LIMIT } from "../types/QueryParams.js";
import { decodeCursor, encodeCursor } from "./cursor.js";
import { combineConditions, commandCondition, sql } from "./filters.js";
import { queryLogs } from "../db/logs.js";
export async function runQuery(query) {
    const conditions = commandCondition(query);
    if (query.cursor) {
        const { timestamp, id } = decodeCursor(query.cursor);
        const cursorTimestamp = new Date(timestamp).toISOString(); // see filters.ts's since/until for why not a raw Date
        // keyset pagination: strictly "after" the last row of the previous page, in the
        // same (timestamp DESC, id DESC) order queryLogs sorts by.
        conditions.push(sql `(timestamp < ${cursorTimestamp} OR (timestamp = ${cursorTimestamp} AND id < ${id}))`);
    }
    const limit = Math.min(query.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
    const rows = await queryLogs(combineConditions(conditions), limit);
    const last_log = rows[rows.length - 1];
    // check if we are not in the last log (should be defined && trivialy the length of rows should be == limit)
    const next_cursor = rows.length === limit && last_log ? encodeCursor({ timestamp: last_log.timestamp, id: last_log.id }) : null;
    return {
        logs: rows,
        next_cursor
    };
}
