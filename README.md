# Pi Autoplan

Give each task only as much planning as it needs.

**Manifest package:** **@borges360/pi-autoplan** · **version:** **0.1.2**
**Status:** development release. Registry publication is not verified; the package name in package.json is not proof that npm install from the registry is available. Registry validation is a separate CT59 step.
## English

### What it does

Pi Autoplan chooses none, micro, or full planning. Full plans are bounded task DAGs with acceptance criteria. A plan revision requires recorded material evidence; invalid updates preserve the last valid plan. The current Pi model can create plans through the autoplan_update tool.

The extension owns its state namespace and uses files by default. SQLite and Pi Durable are opt-in storage backends. It does not require a sibling extension, a remote classifier, or a database driver for the default file backend.

### Compatibility and package status

- Node.js **>=22.19** is the manifest requirement.
- The package declares **@earendil-works/pi-coding-agent** as a peer dependency. The real host smoke is verified on Pi **1.4.0**; this statement records that tested version, not a broader compatibility range.
- The optional Pi Durable adapter targets **@earendil-works/pi-durable** **1.2.0**.
- The npm package version in the manifest is **0.1.2**. Registry availability and installation by package name have not been verified; no publication is claimed.

### Install and develop

If you have access to the repository, use the current Git source path:

~~~sh
pi install git:github.com/Borges360/pi-autoplan
~~~

This is a Git installation instruction, not an npm registry installation command. The registry route remains unverified until the CT59 release check.

From a local source checkout with the locked development dependencies installed:

~~~sh
npm test
npm run build
pi -e ./src/extension.ts
node dist/cli.js doctor
~~~

Prepare development dependencies from package-lock.json using your configured npm environment. This is a development setup step, separate from installing a published package. Pi can load the source entry point directly; the package also contains compiled output.

### Use

Run **/plan** to open the interactive menu; **/autoplan** remains a compatibility alias. The menu groups actions under **Plan**, **History**, and **Settings**. Escape returns from an action group; Escape at the category list closes the menu. **/plan status** returns structured headless status.

Choose **Plan mode** in the Plan group, or run **/plan plan-mode**, to toggle a session-only proposal mode. Entering it requires a selected model and a discovery style. The first choice, **Ask essential questions**, is the default. Plan mode adds proposal-only instructions, blocks model tool calls, and refuses stored-plan create/replan commands. It clears when a new Pi session starts. In Settings → **Shift+Tab setup**, choose a free thinking-level shortcut, review the previous and proposed bindings and the restore behavior, then confirm to save. Restart Pi to apply it. Until then, Shift+Tab remains Pi's built-in thinking-level shortcut. The restore action changes the file only while the thinking binding still matches the value saved by Autoplan.

Domain actions are **status**, **show**, **create plan.json**, **validate plan.json**, **replan [plan.json]**, **history**, and **explain**. Shared actions are **auto**, **off**, **observe**, **config**, **doctor**, **storage status**, and **storage migrate files|sqlite|durable**.

The CLI uses the same command surface:

~~~sh
node dist/cli.js status
node dist/cli.js doctor
~~~

The config mode panel shows the current mode and descriptions. Use the arrow keys to choose, Enter to save, and Escape to return to Settings. Advanced settings live in the user configuration file.

### Configuration and state

User settings are stored at **~/.pi/agent/state/pi-autoplan/config.json**. **PI_ECOSYSTEM_STATE_ROOT** changes the parent state directory for testing or deployment.

Project state is stored under **~/.pi/agent/state/pi-autoplan/projects/{sha256-of-canonical-repository-root}/**. The project config **.pi/pi-autoplan.json** is read only after Pi trusts the project. Precedence is command override, trusted project config, user config, then built-in defaults. Project config cannot raise immutable security controls, budgets, or write permissions.

The default mode is **auto**, the storage backend is **files**, and write access is disabled. See [configuration](CONFIGURATION.md) for the complete schema and defaults.

### Language

This README is available in English and Brazilian Portuguese. The interactive menu supports English and pt-BR; CLI output remains English. In Settings → Language, preview a locale and press Ctrl+S to save it for the trusted project in `.pi/pi-autoplan.locale.json`. Untrusted projects and invalid locale files safely fall back to English. The npm registry artifact has not been verified; this describes the current local source.

### Privacy and security

Pi extensions run with the operating system privileges of the user and are not an OS sandbox. The default file backend does not execute commands. The extension redacts common secrets at output boundaries, but no heuristic recognizes every arbitrary secret. Do not put secrets in objectives, plan definitions, or artifacts. Binary blobs preserve their original bytes; sanitize sensitive content before storing one.

Project configuration is read only after Pi project trust. Project-owned limits cannot raise user ceilings or enable disabled integrations. See [security](SECURITY.md) for the full boundary.

### Troubleshooting and limits

Start with:

~~~sh
node dist/cli.js doctor
node dist/cli.js status
~~~

Use [architecture](ARCHITECTURE.md), [migration](MIGRATION.md), and [compatibility](COMPATIBILITY.md) for backend and recovery details. Local tests establish only the behaviors they exercise; they do not establish SWE-bench or Terminal-Bench quality, inference-cost savings, or publication. See [acceptance status](ACCEPTANCE.md) and [benchmark limits](benchmarks/README.md).

### License

The software is MIT licensed; see [LICENSE](LICENSE). The bundled INTEIRO mark is separately available under MIT; see its [asset notice](docs/assets/INTEIRO-MARK-LICENSE.txt).

## Português (Brasil)

### O que faz

O Pi Autoplan escolhe entre planejamento none, micro ou full. Planos completos são DAGs limitados de tarefas com critérios de aceite. Uma revisão do plano exige evidência material registrada; atualizações inválidas preservam o último plano válido. O modelo atual do Pi pode criar planos pela ferramenta autoplan_update.

A extensão mantém seu próprio namespace de estado e usa arquivos por padrão. SQLite e Pi Durable são backends opcionais. O backend padrão não exige extensão irmã, classificador remoto ou driver de banco de dados.

### Compatibilidade e distribuição

- O requisito do manifest é Node.js **>=22.19**.
- O pacote declara **@earendil-works/pi-coding-agent** como peer dependency. O smoke no host real foi verificado no Pi **1.4.0**; isso registra a versão testada, não uma faixa maior de compatibilidade.
- O adaptador opcional Pi Durable é voltado para **@earendil-works/pi-durable** **1.2.0**.
- A versão npm no manifest é **0.1.2**. A disponibilidade e a instalação pela registry não foram verificadas; não afirmamos que houve publicação.

### Instalar e desenvolver

Se você tem acesso ao repositório, use o caminho Git atualmente documentado:

~~~sh
pi install git:github.com/Borges360/pi-autoplan
~~~

Esse comando instala pelo Git, não pela registry npm. A rota da registry continua sem verificação até o gate CT59.

Em um checkout local da fonte com as dependências de desenvolvimento travadas já instaladas:

~~~sh
npm test
npm run build
pi -e ./src/extension.ts
node dist/cli.js doctor
~~~

Prepare as dependências de desenvolvimento a partir de package-lock.json usando seu ambiente npm. Essa etapa de desenvolvimento é separada da instalação de um pacote publicado. O Pi pode carregar diretamente a entrada da fonte; o pacote também inclui a saída compilada.

### Uso

Execute **/plan** para abrir o menu interativo; **/autoplan** continua como alias de compatibilidade. As ações ficam nos grupos **Plan**, **History** e **Settings**. Esc retorna do grupo de ações; Esc na lista de categorias fecha o menu. **/plan status** retorna o estado estruturado para uso headless.

Escolha **Modo Plan** no grupo Plan ou execute **/plan plan-mode** para alternar o modo de proposta, válido apenas na sessão. Para entrar, é necessário ter um modelo selecionado e escolher como descobrir o trabalho. **Pergunte o essencial** é a opção inicial. O modo Plan acrescenta instruções de proposta, bloqueia chamadas de ferramentas do modelo e recusa comandos para criar/revisar planos armazenados. Ele é desativado quando uma nova sessão Pi começa. Em Configurações → **Configurar Shift+Tab**, escolha um atalho livre para o nível de raciocínio, revise os vínculos anterior e proposto e a forma de restauração, e confirme para salvar. Reinicie o Pi para aplicar. Até lá, Shift+Tab continua sendo o atalho nativo do Pi para alternar o nível de raciocínio. A restauração só altera o arquivo enquanto o vínculo de raciocínio continuar igual ao valor salvo pelo Autoplan.

As ações de domínio são **status**, **show**, **create plan.json**, **validate plan.json**, **replan [plan.json]**, **history** e **explain**. As ações compartilhadas são **auto**, **off**, **observe**, **config**, **doctor**, **storage status** e **storage migrate files|sqlite|durable**.

A CLI usa a mesma superfície de comandos:

~~~sh
node dist/cli.js status
node dist/cli.js doctor
~~~

O painel do modo config mostra o modo atual e a descrição das opções. Use as setas para escolher, Enter para salvar e Esc para voltar a Settings. Ajustes avançados ficam no arquivo de configuração do usuário.

### Configuração e estado

As preferências do usuário ficam em **~/.pi/agent/state/pi-autoplan/config.json**. **PI_ECOSYSTEM_STATE_ROOT** altera o diretório pai do estado para testes ou implantação.

O estado do projeto fica em **~/.pi/agent/state/pi-autoplan/projects/{sha256-da-raiz-canônica-do-repositório}/**. O arquivo **.pi/pi-autoplan.json** só é lido depois que o Pi confia no projeto. A precedência é override do comando, configuração do projeto confiável, configuração do usuário e defaults internos. A configuração do projeto não pode elevar controles imutáveis de segurança, limites de custo/orçamento ou permissões de escrita.

O modo padrão é **auto**, o backend é **files** e o acesso de escrita fica desabilitado. Consulte [configuração](CONFIGURATION.md) para o schema e todos os defaults.

### Idioma

Este README está em inglês e português brasileiro. O menu interativo oferece inglês e pt-BR; a saída da CLI continua em inglês. Em Settings → Language (Idioma), pré-visualize um idioma e pressione Ctrl+S para salvá-lo no projeto confiável em `.pi/pi-autoplan.locale.json`. Projetos não confiáveis e arquivos de idioma inválidos usam inglês como fallback seguro. O conteúdo do pacote publicado no npm não foi verificado; esta descrição corresponde ao código-fonte local.

### Privacidade e segurança

Extensões Pi usam as permissões do sistema operacional do usuário; não são um sandbox de sistema. O backend padrão de arquivos não executa comandos. A extensão remove padrões comuns de segredos nas fronteiras de saída, mas nenhuma heurística reconhece todos os segredos possíveis. Não coloque segredos em objetivos, definições de plano ou artefatos. Blobs binários preservam os bytes originais; sanitize conteúdo sensível antes de armazená-los.

A configuração do projeto só é lida após o Pi confiar no projeto. Limites do projeto não podem elevar os limites do usuário nem ativar integrações desabilitadas. Consulte [segurança](SECURITY.md) para conhecer toda a fronteira.

### Diagnóstico e limites

Comece por:

~~~sh
node dist/cli.js doctor
node dist/cli.js status
~~~

Consulte [arquitetura](ARCHITECTURE.md), [migração](MIGRATION.md) e [compatibilidade](COMPATIBILITY.md) para detalhes de backend e recuperação. Testes locais comprovam apenas os comportamentos exercitados; não comprovam qualidade SWE-bench ou Terminal-Bench, economia de inferência nem publicação. Veja [aceite](ACCEPTANCE.md) e [limites dos benchmarks](benchmarks/README.md).

### Licença

O software usa MIT; consulte [LICENSE](LICENSE). A marca INTEIRO incluída tem licença MIT separada; consulte o [aviso do asset](docs/assets/INTEIRO-MARK-LICENSE.txt).
