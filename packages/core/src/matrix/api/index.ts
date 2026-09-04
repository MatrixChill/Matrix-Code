// Local OpenAI-compatible Matrix API (first secure iteration).
//
// Exposes Matrix-owned logical models over loopback-only HTTP with Bearer
// authentication and recursion-safe execution. See each module for details:
//   config.ts     settings from the environment, fail-closed validation
//   recursion.ts  origin + hop guards against OmniRoute/Matrix loops
//   models.ts     the Matrix models exposed through /v1/models
//   schema.ts     OpenAI-compatible wire shapes and structured errors
//   executor.ts   chat execution over an explicit direct upstream
//   server.ts     the HTTP server (routes, auth, status)

export * as MatrixApiConfig from "./config"
export * as MatrixApiExecutor from "./executor"
export * as MatrixApiModels from "./models"
export * as MatrixApiRecursion from "./recursion"
export * as MatrixApiSchema from "./schema"
export * as MatrixApiServer from "./server"