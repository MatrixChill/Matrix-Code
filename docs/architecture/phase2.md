# Phase 2 — Model Router, Sessions and Integrations

Fase 2 concretizou, de forma segura e incremental, as primeiras funcionalidades
reais de Matrix Code sobre a fundação da Fase 1.

## Onde fica cada coisa

| Bloco | Código | Pacote |
| --- | --- | --- |
| Config Matrix (`matrix`) | `src/config/matrix.ts` | `@opencode-ai/core` |
| Perfis (ids/etiquetas) | `src/matrix/profile.ts` | `@opencode-ai/core` |
| Catálogo central de modelos | `src/matrix/catalog.ts` | `@opencode-ai/core` |
| Router (seleção/health/cooldown) | `src/matrix/router.ts` | `@opencode-ai/core` |
| Classificação de erros recuperáveis | `src/matrix/reliable.ts` | `@opencode-ai/core` |
| Presence Discord (IPC próprio) | `src/matrix/presence/` | `@opencode-ai/opencode` |
| Local Session (armazenamento JSON) | `src/matrix/session/local.ts` | `@opencode-ai/opencode` |
| `/matrix-status` + `/matrix-models` | `packages/tui/src/component/dialog-matrix-*` | TUI |
| Launcher OmniRoute instalado | `distribution/windows/matrix-installed.cmd` | distribuição |

## Fronteira core / integração

- **Core** – só o que é puro e reutilizável: perfil, catálogo, seleção, cooldown
  e classificação de erro. Nenhum I/O, nenhum efeito obrigatório.
- **opencode host** – integrações opcionais (Presence, Local Session) com o
  ciclo de vida do processo.
- **TUI** – visões de leitura (`/matrix-status`, `/matrix-models`).
- **Distribuição** – launcher de auto-start do OmniRoute no caminho instalado.

## O que foi reutilizado (não duplicado)

- O **retry de baixo nível** (429/5xx/504/timeout) **já existia** no core
  (`session/retry.ts`) e na própria rota `auto/coding` do OmniRoute (failover de
  provider). O Matrix Router **não reimplementa** esse retry; ele fornece a
  camada de **perfil → fallback** sobre o que já existe: degrada health, aplica
  cooldown e seleciona o próximo candidato quando um erro recuperável persiste.
- O **auto-start** do OmniRoute reutiliza exatamente a lógica comprovada do
  `matrix.cmd` portátil, agora no caminho instalado.
- **Vision** é uma capacidade declarada no catálogo (`vision`), não um duplicado
  de lógica.

Nada aqui toca o projector/session core do V2. A Local Session é um registro
paralelo de metadata; nunca muta dados de projeto.
