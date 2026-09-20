// Shared between the renderer's manifest parser, the Electron plugin hosts and
// the marketplace check script, so every surface reports a bad package field
// with the same error shape.
export class PluginManifestError extends Error {
    constructor(message, field, reason) {
        super(message);
        this.name = 'PluginManifestError';
        this.field = field;
        this.reason = reason;
    }
}
