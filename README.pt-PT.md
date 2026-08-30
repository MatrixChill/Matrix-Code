# Matrix Code

<p align="center">
  <a href="README.md">English</a> |
  <a href="README.pt-PT.md">Português (Portugal)</a> |
  <a href="README.pt-BR.md">Português (Brasil)</a>
</p>

O Matrix Code é uma aplicação completa de programação no terminal baseada no OpenCode. Preserva a TUI madura, fornecedores, IDs de modelos, ficheiros de configuração, comandos, agentes, skills e MCP, acrescentando branding Matrix, idiomas EN/pt-PT/pt-BR, Matrix Voice e um preset opcional para OmniRoute.

Esta v1 concentra-se no terminal e não cria uma nova GUI desktop.

## Instalação no Windows x64

Descarregue os ficheiros em [GitHub Releases](https://github.com/MatrixChill/Matrix-Code/releases/latest). Os binários, runtime de voz e modelo ficam nas Releases, não no Git.

### Versão instalada

1. Descarregue e extraia `Matrix-Code-Windows-x64.zip`.
2. Execute no PowerShell:

   ```powershell
   powershell -ExecutionPolicy Bypass -File .\install.ps1
   ```

3. Abra um novo terminal e execute `matrix`.

O instalador copia a aplicação para `%LOCALAPPDATA%\Matrix Code`, acrescenta a pasta ao `PATH` do utilizador e não instala credenciais.

### Versão portable

1. Descarregue e extraia `Matrix-Code-Windows-x64-Portable.zip` para uma pasta normal ou pen drive.
2. Execute `matrix.cmd`.

Configuração, sessões, estado e cache ficam em `.matrix` na pasta extraída. O executável, helper de voz e modelo são encontrados por caminhos relativos. Não é necessário ter Bun, Node.js ou Python instalados globalmente.

`opencode.cmd` mantém a entrada compatível. Variáveis `OPENCODE_*`, `opencode.json`, `.opencode`, IDs de fornecedores/modelos e slash commands continuam a funcionar.

## Primeira execução e fornecedores

Na primeira execução, o diálogo de fornecedores funciona como o **Matrix Code AI Setup**. Comece com um fornecedor e adicione outros depois com `/connect`:

- **OmniRoute**, gateway recomendado para Matrix Free Coding e fallback automático;
- Qwen/Alibaba e Qoder/iFlow;
- Kimi coding/reasoning;
- níveis gratuitos de NVIDIA NIM, Cerebras e Groq;
- Cloudflare Workers AI;
- modelos `:free` do OpenRouter;
- DeepSeek ou qualquer fornecedor compatível com OpenCode.

OAuth, autorização por dispositivo, chaves, quotas e termos pertencem ao serviço externo. Não é necessário ligar todos.

## OmniRoute e Matrix Free Coding

O Matrix Code utiliza a implementação OpenAI-compatible existente. O endpoint OmniRoute é configurável; para uma instância local, o valor predefinido é `http://localhost:20128/v1`. Se o endpoint estiver indisponível durante o setup, a configuração é guardada e uma mensagem clara indica que deve iniciar o gateway ou verificar o endereço.

O modelo **Matrix Free Coding** aponta para `auto/coding`. Saúde dos fornecedores, quotas, novas tentativas, circuit breaker e fallback pertencem ao OmniRoute; o Matrix Code não duplica essa lógica. `Matrix Auto` (`auto`) e `Matrix Fast` (`auto/fast`) também ficam disponíveis, para além da seleção manual normal.

Um pool curado pode priorizar Qwen/Qoder, Kimi, DeepSeek, NVIDIA NIM, Cerebras, Groq, Cloudflare Workers AI e modelos gratuitos do OpenRouter. A disponibilidade depende do fornecedor e da região. Ofertas “free” ou “unlimited” podem ter limites, fair use, quotas e termos mutáveis; o Matrix Code não promete tokens infinitos.

O template `distribution/windows/templates/opencode.omniroute.jsonc` não contém segredos.

## Credenciais e segurança portable

Os ficheiros públicos têm zero credenciais privadas. Nunca publique `.matrix`, `auth.json`, ficheiros privados de ambiente ou um ZIP personalizado.

O `/connect` normal utiliza o armazenamento de credenciais existente do OpenCode. No portable, fica em `.matrix`; trate a pen drive como sensível.

Para utilização pessoal sem guardar a chave OmniRoute, execute:

```powershell
powershell -ExecutionPolicy Bypass -File .\matrix-personal.ps1
```

A chave é pedida como entrada segura, permanece apenas na memória do processo e é removida no fim. Apenas o template sem segredos é gravado. Para utilização empresarial ou não interativa, prefira um endpoint OmniRoute autenticado e um gestor de segredos do sistema.

## Matrix Voice e idiomas

Prima `F8` para começar a gravar e `F8` novamente para parar e transcrever. O texto entra no prompt e **não é enviado automaticamente**. Edite-o se necessário e prima Enter para enviar.

As Releases Windows incluem helper PyInstaller, runtime Python, dependências nativas de áudio e modelo faster-whisper local. Python é necessário apenas durante o build, não para o utilizador final.

Prima `F9` para alternar entre inglês, português de Portugal e português do Brasil.

## Build para developers

```powershell
bun install
bun run --cwd packages/opencode build --single
python -m pip install -r script/voice/requirements-build.txt
powershell -ExecutionPolicy Bypass -File .\script\build-windows-distribution.ps1
```

Os ZIPs e checksums SHA-256 ficam em `packages/opencode/dist/matrix-release`. O workflow `matrix-windows-release` gera os mesmos artefactos e anexa-os às GitHub Releases.

## Compatibilidade e atribuição

O Matrix Code baseia-se no [OpenCode](https://github.com/anomalyco/opencode), preserva a licença MIT e a compatibilidade interna. O ficheiro [LICENSE](LICENSE) acompanha as distribuições. O branding Matrix Code não implica propriedade sobre o OpenCode ou fornecedores externos.
