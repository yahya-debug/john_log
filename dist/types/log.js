const levels = ["debug", "info", "warn", "error"];
export const premitives = ['string', 'number', 'boolean'];
export function isLevel(claimed) {
    return typeof claimed === 'string' && levels.includes(claimed);
}
