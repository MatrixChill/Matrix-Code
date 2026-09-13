# Atualizar o Matrix Code

Este guia descreve uma atualização segura do Matrix Code no Windows. Ele se baseia nos caminhos usados pelo código e pelo launcher atual, não em caminhos presumidos.

## Regra principal

**NUNCA APAGAR DADOS DO UTILIZADOR DURANTE UMA ATUALIZAÇÃO AUTOMÁTICA.**

Uma atualização normal não deve exigir apagar sessões, redefinir providers, copiar API keys manualmente, definir `OMNIROUTE_API_KEY` no PowerShell ou reinstalar tudo do zero. Qualquer migração excepcional deve ser descrita nas notas da release antes da atualização.

## Onde o Windows Portable guarda dados

O `matrix.ps1` define as raízes XDG dentro de `<Portable>\.matrix`. O código acrescenta o namespace de compatibilidade `opencode` a essas raízes.

| Dados | Caminho real no Portable | Preservar? |
| --- | --- | --- |
| Sessões, mensagens e histórico | `.matrix\data\opencode\opencode.db` (ou DB com sufixo do canal em builds não estáveis) | Sempre |
| Storage legado/migrações | `.matrix\data\opencode\storage\` | Sempre |
| Credenciais de providers | `.matrix\data\opencode\auth.json` | Sempre |
| Credenciais MCP | `.matrix\data\opencode\mcp-auth.json` | Sempre |
| Configuração principal e providers | `.matrix\config\opencode\opencode.jsonc`, `opencode.json` ou `config.json` | Sempre |
| Configuração da TUI | `.matrix\config\opencode\tui.json` | Sempre |
| Preferências da TUI | `.matrix\state\opencode\kv.json` | Sempre |
| Banco e providers do OmniRoute bundled | `.matrix\config\omniroute\storage.sqlite` e arquivos adjacentes | Sempre |
| Credenciais locais protegidas por DPAPI | `.matrix\state\matrix-api.cred`, `omniroute-api.cred` e `omniroute-storage.cred` | Sempre; copie apenas com o mesmo utilizador Windows |
| Cache reconstruível | `.matrix\cache\opencode\` | Opcional |
| PID transitório | `.matrix\matrix-api.pid` e `.matrix\omniroute.pid` | Não é dado do utilizador; só deve existir durante execução |

Projetos podem também conter `opencode.json`, `opencode.jsonc`, `tui.json` e a pasta `.opencode`. Esses arquivos pertencem ao projeto e ficam fora do Portable; uma atualização do aplicativo não deve alterá-los.

Na edição instalada, sem as variáveis definidas pelo launcher Portable, as raízes padrão usadas no Windows são `%USERPROFILE%\.local\share\opencode`, `%USERPROFILE%\.config\opencode`, `%USERPROFILE%\.local\state\opencode` e `%USERPROFILE%\.cache\opencode`. Um OmniRoute externo pode usar `%USERPROFILE%\.omniroute`; o launcher apenas o reutiliza e nunca deve substituí-lo ou encerrá-lo.

## Atualização manual recomendada

1. Feche completamente o Matrix Code e aguarde o encerramento dos processos que ele iniciou.
2. Não apague `.matrix`, configurações ou dados do utilizador.
3. Renomeie a pasta atual, por exemplo, de `Matrix-Code-Windows-x64-Portable` para `Matrix-Code-Windows-x64-Portable-OLD`.
4. Baixe a nova release e confira o SHA-256 publicado em `SHA256SUMS.txt`.
5. Extraia a nova versão para `Matrix-Code-Windows-x64-Portable`.
6. Com o Matrix Code fechado, copie a pasta `.matrix` inteira de `Matrix-Code-Windows-x64-Portable-OLD` para a nova pasta. Não copie `matrix.exe`, launchers, `matrix-voice`, `omniroute` ou `templates` antigos por cima da nova versão.
7. Abra `matrix.cmd` na pasta nova. O launcher reutiliza as credenciais protegidas sem exigir variável manual.
8. Confirme as sessões anteriores, providers, configurações, preferências, OmniRoute e as opções Matrix Coding.
9. Remova a pasta `-OLD` somente depois dessa validação e de um backup adequado.

Os arquivos DPAPI são vinculados ao utilizador Windows que os criou. Para mover o Portable para outro computador ou outra conta Windows, reconecte os providers nessa conta; não tente converter, imprimir ou copiar manualmente os segredos.

## O que pode ser substituído

Os arquivos da aplicação podem ser substituídos por uma release verificada: `matrix.exe`, `matrix.ps1`, `matrix.cmd`, `matrix-personal.ps1`, `templates\`, `matrix-voice\` e `omniroute\`. A pasta `.matrix` nunca faz parte do ZIP público e nunca deve ser substituída por arquivos da release.

## Base para um futuro updater

A infraestrutura existente já anuncia versões e oferece ações de atualização, mas o fluxo genérico não deve substituir uma instalação Portable sem uma política explícita de dados. Um updater seguro do Matrix Code deve:

1. consultar apenas uma release Matrix Code confiável;
2. baixar para uma pasta temporária;
3. verificar o SHA-256 publicado antes de extrair;
4. validar a estrutura mínima e a versão do pacote;
5. fechar os processos que a instância atual iniciou, identificados por PID e linha de comando;
6. trocar somente arquivos da aplicação, mantendo `.matrix` intacta;
7. conservar a versão anterior até o primeiro arranque validado;
8. restaurar a versão anterior se a troca ou o arranque falhar;
9. apresentar “Atualizar agora”, “Ver novidades” e “Depois” sem executar uma substituição silenciosa.

Não se deve implementar esse fluxo como uma cópia recursiva improvisada sobre uma aplicação em execução. Até existir um updater transacional específico para o Portable, use o procedimento manual acima.
