/**
 * Safely extract a message from an unknown error value.
 */
export function getErrorMessage(e: unknown): string {
    if (e instanceof Error) {
        return e.message;
    }
    if (typeof e === "string") {
        return e;
    }
    return String(e);
}
