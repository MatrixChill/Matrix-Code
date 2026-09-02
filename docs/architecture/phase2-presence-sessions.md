# Discord Rich Presence e Local Sessions (Phase 2)

## Discord Rich Presence (opcional)

Implementado como adapter isolado **sem dependência externa** (`node:net`) que
fala o protocolo RPC local do Discord (named pipe no Windows, unix socket em
Linux/macOS). Desligado por padrão; falha em silêncio quando o Discord não está
em execução.

### Ativação

```jsonc
// opencode.jsonc (ou opencode.json)
{
  "matrix": {
    "defaultProfile": "reliable",
    "discordPresence": {
      "enabled": true,
      "showProjectName": false,
      "showModelProfile": true,
      "showElapsedTime": true,
      "showRepositoryButton": false
    }
  }
}
```

Privacy-first: nunca envia paths locais, prompts, tokens/API keys, nomes de
arquivos privados nem secrets. O botão de repositório só aparece se
`showRepositoryButton` estiver ligado **e** o projeto não for privado.

### Estados

`IDLE · LISTENING · THINKING · CODING · TESTING · BUILDING · REVIEWING · ERROR · DONE`

### Código

- `src/matrix/presence/discord-ipc.ts` – cliente de socket IPC + framing + activity.
- `src/matrix/presence/presence.ts` – gerenciador opcional (debounce + silent fail).
- Teste: `test/matrix-presence.test.ts`.

### Limitação conhecida (única parte bloqueada)

O **ponto de entrada do host** (run/serve) ainda não emite os eventos de mudança
de estado da sessão para `MatrixPresence.update()`. O adapter e o gerenciador
estão funcionais e testados; conectar o fluxo de eventos ao ciclo de vida do run
é o passo restante e exige tocar o entrypoint do host com cuidado (fora do
escopo seguro desta entrega).

## Local Session (armazenamento paralelo de metadata)

Armazenamento JSON simples por sessão, independente do projector core. Escrita
nunca muta dados de projeto.

- Campos: id, createdAt, updatedAt, activeProfile, currentProvider/currentModel,
  status, retries, fallbacks, usage (tokens quando o provider fornecer), model
  history e metadata de recovery.
- Token tracking: `known` só vira `true` com figura real; nunca inventa números.
- Model history: registra `timestamp/profile/provider/model/reason`
  (`initial · manual-change · fallback-504 · provider-offline · circuit-breaker`).
- Recovery: tool calls interrompidas são marcadas `incomplete`; destrutivas
  exigem confirmação antes de repetir.

### Código

- `src/matrix/session/local.ts` – store + helpers (`recordModelChange`,
  `recordTokenUsage`, `setStatus`, `markInterruptedToolCall`,
  `clearInterruptedToolCall`).
- Teste: `test/matrix-session.test.ts`.
