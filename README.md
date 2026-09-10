# dsh-miniapp

MiniApps for DeepSeek Harness — AI-generated, self-contained single-file web tools that you publish once and reuse forever.

A mini-app is **one self-contained HTML file** (CSS and JavaScript inline, third-party libraries via CDN). The agent writes it, you press Publish once, and from then on it is a tool you can open anywhere in DSH.

Ported from [NomiFun Desktop](https://github.com/nomifun/nomifun-desktop)'s "MiniApps" feature (v3 unified conversations). This is a port, not a reimplementation: the product loop is the same, the implementation follows DSH's plugin contracts.

## Compatibility

| Surface | Status |
|---|---|
| Harness | DeepSeek Harness `0.1.2-rc.1` |
| Node | `^22.19.0 \|\| >=24.0.0` |
| Platforms | All (plain ESM; no native code, no network at load time) |
| Client half | Web UI (`dsh web`), including DSH Desktop |

## What it does

Registers ten model-visible tools and one client-side panel:

- **Tools** — `miniapp_create`, `miniapp_list`, `miniapp_get`, `miniapp_iterate`, `miniapp_read_source`, `miniapp_write_source`, `miniapp_publish`, `miniapp_delete`, `miniapp_validate`, `miniapp_import`.
- **Panel** — a full-screen library and runner, opened from the icon at the right end of the sidebar settings row.
- **Composer mode** — on a blank session, a `小程序` chip and a template panel (12 templates in 5 intent categories, each with a live sandboxed preview). Picking a template writes an editable sentence into the composer; `直接创建` builds one from the template's own body without the model.
- **Five places to run an app** — the full-screen panel, a browser tab, a tab in the current session (beside `对话` / `轨迹`), a right-hand drawer, and a floating window pinned to the top-right of the conversation area. All of them reuse the same sandboxed runner.

Storage is two layers, physically separated: a working copy the agent edits, and a published snapshot the runner serves. Editing does not go live until you publish.

Model-visible effect: every tool call and result is recorded, so the whole flow can be reconstructed from the session log. The published document is served from a capability URL at `/plugins/dsh-miniapp/serve/{id}` and sandboxed in an iframe (no `allow-same-origin`).

## Install

```sh
cd dsh-miniapp
pnpm pack
dsh plugin --profile web add ./dsh-miniapp-0.3.0.tgz
```

Restart DSH after installing — bundle-layer changes take effect on restart. The MiniApp icon then appears at the right end of the sidebar settings row.

Uninstall:

```sh
dsh plugin --profile web remove dsh-miniapp
```

## Configuration

| Key | Type | Default | Description |
|---|---|---|---|
| `dataDir` | string | `{DSH_HOME}/miniapp` | Where the index, working copies and published snapshots live |


```yaml
- id: dsh-miniapp
  config:
```

## Development

```sh
pnpm test                       # 122 tests: storage, host routes, client contracts
pnpm pack                       # build the installable tarball
```

Verification is layered — core logic, host integration, client contract (all `node --test`), plus a real-process run against a throwaway profile. See [`docs/design.zh-CN.md`](docs/design.zh-CN.md) for the architecture, the DSH contracts this plugin had to work around, and the full verification log.

## License

[MIT](LICENSE) © 2026 gpmlimeng-cyber. Feature design from Apache-2.0 licensed [nomifun-desktop](https://github.com/nomifun/nomifun-desktop).
