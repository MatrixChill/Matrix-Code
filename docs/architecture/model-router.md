# Matrix Model Router

> **Status: FOUNDATION (design only).**

## 1. Problem

Choosing a raw model is confusing. Providers have different names, capabilities and costs.
Matrix should let the user choose a **profile** and then pick the **model** that best
matches the profile, the session's needs and the provider's current health.

## 2. Profiles (user-facing)

Profiles map a user intent to a model or routing policy:

| Profile | Intent | Routing |
|---|---|---|
| `Matrix Smart` | daily balanced use | high reasoning + reliability |
| `Matrix Coding Max` | deep coding | best coding quality, large context |
| `Matrix Reliable` | correctness first | highest tool-call reliability |
| `Matrix Fast` | low latency | fastest model |
| `Matrix Vision` | image analysis | model with vision capability |
| `Matrix Free` | no-cost usage | free tier / quota-aware |
| `Matrix Local` | offline / local AI | local models only |

## 3. Model metadata

Each candidate model carries metadata used by the router:

```ts
interface ModelMetadata {
  id: string
  provider: string
  profile: ReadonlyArray<Profile>     // which profiles accept this model
  codingQuality: 0..1
  reasoning: 0..1
  speed: 0..1
  toolCallReliability: 0..1
  vision: boolean
  contextSize: number
  cost: "free" | "low" | "medium" | "high"
  health: "healthy" | "degraded" | "down"   // dynamic
  latencyMs?: number                         // dynamic (rolling average)
}
```

Static fields come from a model catalog. `health` and `latencyMs` are updated at runtime by
the router and the reliability layer.

## 4. Routing flow

```
user picks profile
        |
        v
Model Router: candidates = catalog.filter(profile, vision?, local-only?, free-only?)
        |
        v
rank by (health, then profile weights, then latency)
        |
        v
select primary model
        |
        v
run via provider (OmniRoute / Zen / OpenAI / Anthropic / Google / OpenRouter / local)
```

Provider support to plan for: OmniRoute, OpenCode Zen, OpenAI, Anthropic, Google,
OpenRouter, OpenAI-compatible providers, local models, free models, paid models.

## 5. Fallback & Reliability

Real failures observed: slow models, model stuck in Thinking, `504 Upstream idle timeout`,
provider offline, `Cannot connect to API`.

### 5.1 Design

```
request (model A)
   |
   +-- success  --> done
   |
   +-- 429/500/502/503/504 / network timeout / provider offline / idle timeout
        |
        v
   short retry (bounded)
        |
        +-- still failing --> mark model A  degraded/down (health--)
        |
        v
   fallback: select model B (per profile, excluding A)
        |
        v
   continue the SAME session
```

### 5.2 Rules

- **Bounded retry**: small, capped retries (e.g. 1–2 for transient codes). Never loop
  forever.
- **Circuit breaker**: track consecutive failures per model; open the circuit after a
  threshold, try again after a cooldown.
- **Sticky fallback**: record the fallback so the session continues without thrashing.
- **Marks**: after repeated failure, `health = "degraded"` then `"down"`, influencing
  future profile routing.

### 5.3 Codes to handle

`429` `500` `502` `503` `504` · network timeout · provider offline · idle timeout

## 6. Interfaces / contracts (non-destructive)

The router is designed as a future module. This phase only fixes the contracts, not full
implementation:

- A `ModelCatalog` source (static metadata + dynamic health).
- A `ProfileRegistry` mapping profile → selection policy.
- A `Router.select(profile, context): SelectedModel` entry point.
- A `Reliability` layer that feeds `health`/`latency` back to the catalog.

See `roadmap.md` for the phased build order.
