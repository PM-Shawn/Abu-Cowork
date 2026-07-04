// Stub module for @modelcontextprotocol/sdk (requires Node.js, not available in test env)
export {};

// Stub validator so code that does `new CfWorkerJsonSchemaValidator()` during the
// (normally mocked-out) SDK load path doesn't hit `new undefined()`. Accepts all
// input — tests don't exercise real schema validation.
export class CfWorkerJsonSchemaValidator {
  getValidator() {
    return (input: unknown) => ({ valid: true as const, data: input, errorMessage: undefined });
  }
}
