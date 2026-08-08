export function decodeCursor(cursor_str) {
    return JSON.parse(Buffer.from(cursor_str, 'base64').toString('utf-8'));
}
export function encodeCursor(cursor) {
    return Buffer.from(JSON.stringify(cursor), 'utf-8').toString('base64');
}
