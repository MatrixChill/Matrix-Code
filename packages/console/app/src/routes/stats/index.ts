import type { APIEvent } from "@solidjs/start/server"
import { Resource } from "@opencode-ai/console-resource"

async function handler(evt: APIEvent) {
  const req = evt.request.clone()
  const url = new URL(req.url)
  const host = Resource.App.stage === "production" ? "stats.opencode.ai" : "stats.dev.opencode.ai"
  const targetUrl = `https://${host}${url.pathname}${url.search}`

  return fetch(targetUrl, {
    method: req.method,
    headers: req.headers,
    body: req.body,
  })
}

export const GET = handler
export const POST = handler
export const PUT = handler
export const DELETE = handler
export const OPTIONS = handler
export const PATCH = handler
