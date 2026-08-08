export const DEFAULT_LIMIT = 100;
export const MAX_LIMIT = 1000;
const bucket_size = ['1m', '5m', '1h', '1d'];
export const BUCKET_INTERVALS = {
    '1m': '1 minute',
    '5m': '5 minutes',
    '1h': '1 hour',
    '1d': '1 day',
};
export function isBucketSize(size) {
    return typeof size === 'string' && bucket_size.includes(size);
}
