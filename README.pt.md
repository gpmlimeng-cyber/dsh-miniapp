# dsh-miniapp

MiniApps para o DeepSeek Harness — ferramentas web de arquivo único, autocontidas e geradas por IA, que você publica uma vez e reutiliza sempre.

Um mini-app é **um único arquivo HTML autocontido** (CSS e JavaScript embutidos, bibliotecas de terceiros via CDN). O agente escreve, você clica em «Publicar» uma vez e, a partir daí, é uma ferramenta que você pode abrir em qualquer lugar do DSH.

Portado do recurso «MiniApps» do [NomiFun Desktop](https://github.com/nomifun/nomifun-desktop) (v3 unified conversations). É um **port**, não uma reimplementação: o ciclo de produto é o mesmo e a implementação segue os contratos de plugin do DSH.

## Compatibility

| Surface | Status |
|---|---|
| Harness | DeepSeek Harness `0.1.2-rc.1` |
| Node | `^22.19.0 \|\| >=24.0.0` |
| Platforms | Todas (ESM puro; sem código nativo e sem rede ao carregar) |
| Client half | Web UI (`dsh web`), incluindo o DSH Desktop |

## What it does

Registra dez ferramentas visíveis ao modelo e um painel no cliente:

- **Ferramentas** — `miniapp_create`, `miniapp_list`, `miniapp_get`, `miniapp_iterate`, `miniapp_read_source`, `miniapp_write_source`, `miniapp_publish`, `miniapp_delete`, `miniapp_validate`, `miniapp_import`.
- **Painel** — biblioteca e executor em tela cheia, aberto pelo ícone na extremidade direita da linha de ajustes da barra lateral.
- **Modo do composer** — em uma sessão em branco, um chip `小程序` e um painel de modelos (12 modelos em 5 categorias de intenção, cada um com pré-visualização real em sandbox). Escolher um modelo escreve uma frase editável na caixa de entrada; `直接创建` cria um a partir do próprio corpo do modelo, sem passar pelo modelo de IA.
- **Cinco lugares para executar um app** — o painel em tela cheia, uma aba do navegador, uma aba da sessão atual (ao lado de `对话` / `轨迹`), uma gaveta à direita e uma janela flutuante ancorada no canto superior direito da área de conversa. Todos reutilizam o mesmo executor em sandbox.

O armazenamento tem duas camadas fisicamente separadas: a cópia de trabalho que o agente edita e o snapshot publicado que o executor serve. As alterações não entram no ar até você publicar.

Efeito visível ao modelo: cada chamada e cada resultado ficam registrados, então todo o fluxo pode ser reconstruído a partir do log da sessão. O documento publicado é servido por uma URL de capacidade em `/plugins/dsh-miniapp/serve/{id}`, dentro de um iframe em sandbox (sem `allow-same-origin`).

## Install

```sh
cd dsh-miniapp
pnpm pack
dsh plugin --profile web add ./dsh-miniapp-0.3.0.tgz
```

Reinicie o DSH depois de instalar — mudanças na camada bundle só valem após reiniciar. O ícone de MiniApps aparece então na extremidade direita da linha de ajustes da barra lateral.

Desinstalar:

```sh
dsh plugin --profile web remove dsh-miniapp
```

## Configuration

| Key | Type | Default | Description |
|---|---|---|---|
| `dataDir` | string | `{DSH_HOME}/miniapp` | Onde ficam o índice, as cópias de trabalho e os snapshots publicados |

A configuração é validada pelo schema Schemastery `Config` em `lib/index.js`; nenhum parâmetro ajustável está fixado no código. Para sobrescrever uma chave em `cordis.patch.yml`:

```yaml
- id: dsh-miniapp
  config:
```

## Development

```sh
pnpm test                       # 122 testes: armazenamento, rotas do host, contratos do cliente
pnpm pack                       # gera o tarball instalável
```

A verificação é em camadas — lógica central, integração com o host e contrato do cliente (todas com `node --test`), mais uma execução em processo real contra um perfil descartável. A arquitetura, os contratos do DSH que este plugin precisou contornar e o registro completo de verificação estão em [`docs/design.zh-CN.md`](docs/design.zh-CN.md).

## License

[MIT](LICENSE) © 2026 gpmlimeng-cyber. O design do produto vem do [nomifun-desktop](https://github.com/nomifun/nomifun-desktop), licenciado sob Apache-2.0.
