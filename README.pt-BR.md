# Matrix Code

<p align="center">
  <a href="README.md">English</a> |
  <a href="README.pt-PT.md">Português (Portugal)</a> |
  <a href="README.pt-BR.md">Português (Brasil)</a>
</p>

O Matrix Code é uma aplicação completa de programação no terminal baseada no OpenCode. Ele preserva a TUI madura, providers, IDs de modelos, arquivos de configuração, comandos, agentes, skills e MCP, adicionando branding Matrix, idiomas EN/pt-PT/pt-BR, Matrix Voice e um preset opcional para OmniRoute.

Esta v1 é focada no terminal e não cria uma nova GUI desktop.

## Instalação no Windows x64

Baixe os arquivos em [GitHub Releases](https://github.com/MatrixChill/Matrix-Code/releases/latest). Os binários, runtime de voz e modelo ficam nas Releases, não no Git.

### Versão instalada

1. Baixe e extraia `Matrix-Code-Windows-x64.zip`.
2. Execute no PowerShell:

   ```powershell
   powershell -ExecutionPolicy Bypass -File .\install.ps1
   ```

3. Abra um novo terminal e execute `matrix`.

O instalador copia a aplicação para `%LOCALAPPDATA%\Matrix Code`, adiciona a pasta ao `PATH` do usuário e não instala credenciais.

### Versão portable

1. Baixe e extraia `Matrix-Code-Windows-x64-Portable.zip` em uma pasta normal ou pen drive.
2. Execute `matrix.cmd`.

Configuração, sessões, estado e cache ficam dentro de `.matrix` na pasta extraída. Executável, helper de voz e modelo são encontrados por caminhos relativos. Bun, Node.js e Python globais não são necessários.

`opencode.cmd` mantém a entrada compatível. Variáveis `OPENCODE_*`, `opencode.json`, `.opencode`, IDs de providers/modelos e slash commands continuam funcionando.

## Primeira execução e providers

Na primeira execução, o diálogo de providers funciona como o **Matrix Code AI Setup**. Comece com um provider e adicione outros depois com `/connect`:

- **OmniRoute**, gateway recomendado para Matrix Free Coding e fallback automático;
- Qwen/Alibaba e Qoder/iFlow;
- Kimi coding/reasoning;
- níveis grátis de NVIDIA NIM, Cerebras e Groq;
- Cloudflare Workers AI;
- modelos `:free` do OpenRouter;
- DeepSeek ou qualquer provider compatível com OpenCode.

OAuth, autorização por dispositivo, chaves, cotas e termos pertencem ao serviço externo. Não é necessário conectar todos.

## OmniRoute e Matrix Free Coding

O Matrix Code usa a implementação OpenAI-compatible já existente. O endpoint OmniRoute é configurável; para uma instância local, o padrão é `http://localhost:20128/v1`. Se o endpoint estiver indisponível no setup, a configuração é salva e uma mensagem clara orienta iniciar o gateway ou conferir o endereço.

O modelo **Matrix Free Coding** aponta para `auto/coding`. Saúde dos providers, cotas, tentativas, circuit breaker e fallback pertencem ao OmniRoute; o Matrix Code não duplica essa lógica. `Matrix Auto` (`auto`) e `Matrix Fast` (`auto/fast`) também ficam disponíveis, além da seleção manual normal.

Um pool curado pode priorizar Qwen/Qoder, Kimi, DeepSeek, NVIDIA NIM, Cerebras, Groq, Cloudflare Workers AI e modelos grátis do OpenRouter. Disponibilidade depende do provider e da região. Ofertas “free” ou “unlimited” ainda podem ter limites, fair use, cotas e termos mutáveis; o Matrix Code não promete tokens infinitos.

O template `distribution/windows/templates/opencode.omniroute.jsonc` não contém segredos.

## Credenciais e segurança portable

Os arquivos públicos têm zero credenciais privadas. Nunca publique `.matrix`, `auth.json`, arquivos privados de ambiente ou um ZIP personalizado.

O `/connect` normal usa o armazenamento de credenciais existente do OpenCode. No portable, ele fica em `.matrix`; trate o pen drive como sensível.

Para uso pessoal sem salvar a chave OmniRoute, execute:

```powershell
powershell -ExecutionPolicy Bypass -File .\matrix-personal.ps1
```

A chave é solicitada como entrada segura, fica apenas na memória do processo e é removida ao terminar. Somente o template sem segredo é gravado. Em uso corporativo ou não interativo, prefira um endpoint OmniRoute autenticado e um gerenciador de segredos do sistema.

## Matrix Voice e idiomas

Pressione `F8` para começar a gravar e `F8` novamente para parar e transcrever. O texto entra no prompt e **não é enviado automaticamente**. Edite se necessário e pressione Enter para enviar.

As Releases Windows incluem helper PyInstaller, runtime Python, dependências nativas de áudio e modelo faster-whisper local. Python é necessário apenas no build, não para o usuário final.

Pressione `F9` para alternar entre inglês, português de Portugal e português do Brasil.

## Build para desenvolvedores

```powershell
bun install
bun run --cwd packages/opencode build --single
python -m pip install -r script/voice/requirements-build.txt
powershell -ExecutionPolicy Bypass -File .\script\build-windows-distribution.ps1
```

Os ZIPs e checksums SHA-256 ficam em `packages/opencode/dist/matrix-release`. O workflow `matrix-windows-release` gera os mesmos artefatos e os anexa às GitHub Releases.

## Compatibilidade e atribuição

O Matrix Code é baseado no [OpenCode](https://github.com/anomalyco/opencode), preserva sua licença MIT e compatibilidade interna. O arquivo [LICENSE](LICENSE) acompanha as distribuições. O branding Matrix Code não implica propriedade sobre o OpenCode nem sobre providers externos.
