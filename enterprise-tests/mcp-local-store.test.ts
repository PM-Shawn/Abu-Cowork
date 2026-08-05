// Enterprise tests are opt-in and require the private sibling repository.
// Keeping the runner inside the public Vite root lets private modules resolve
// the same host dependencies and aliases as a production enterprise build.
import '@enterprise-modules/core/mcp/local-store.test';
