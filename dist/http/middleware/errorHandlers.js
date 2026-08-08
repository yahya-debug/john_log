export function malformedJSON(err, req, res, next) {
    if (err instanceof SyntaxError && err.status == 400 && 'body' in err) {
        console.error(`Malformed JSON rejected`);
        return res.status(400).json({
            status: 'error',
            error: "Malformed JSON",
            message: "The request body failed to be parsed"
        });
    }
    next(err);
}
export function errorCatcher(err, req, res, next) {
    try {
        next(err);
    }
    catch (error) {
        res.status(400).json({ msg: error.message });
    }
}
