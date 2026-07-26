import { Cursor } from "../types/Cursor.js";

export function decodeCursor(cursor_str: string): Cursor {
    return JSON.parse(Buffer.from(cursor_str, 'base64').toString('utf-8')); 
}

export function encodeCursor(cursor: Cursor): string {
    return Buffer.from(JSON.stringify(cursor), 'utf-8').toString('base64');
}