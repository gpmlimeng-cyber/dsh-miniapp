# dsh-miniapp

MiniApps para DeepSeek Harness: herramientas web de un solo archivo, autónomas y generadas por IA, que publicas una vez y reutilizas siempre.

Una mini-app es **un único archivo HTML autocontenido** (CSS y JavaScript en línea, bibliotecas de terceros vía CDN). El agente la escribe, tú pulsas «Publicar» una vez y, a partir de ahí, es una herramienta que puedes abrir en cualquier parte de DSH.

Portado de la función «MiniApps» de [NomiFun Desktop](https://github.com/nomifun/nomifun-desktop) (v3 unified conversations). Es un **port**, no una reimplementación: el ciclo de producto es el mismo y la implementación sigue los contratos de plugins de DSH.

## Compatibility

| Surface | Status |
|---|---|
| Harness | DeepSeek Harness `0.1.2-rc.1` |
| Node | `^22.19.0 \|\| >=24.0.0` |
| Platforms | Todas (ESM puro; sin código nativo ni red al cargar) |
| Client half | Web UI (`dsh web`), incluido DSH Desktop |

## What it does

Registra diez herramientas visibles para el modelo y un panel en el cliente:

- **Herramientas** — `miniapp_create`, `miniapp_list`, `miniapp_get`, `miniapp_iterate`, `miniapp_read_source`, `miniapp_write_source`, `miniapp_publish`, `miniapp_delete`, `miniapp_validate`, `miniapp_import`.
- **Panel** — biblioteca y ejecutor a pantalla completa, abierto desde el icono del extremo derecho de la fila de ajustes de la barra lateral.
- **Modo del composer** — en una sesión vacía, un chip `小程序` y un panel de plantillas (12 plantillas en 5 categorías de intención, cada una con vista previa real en sandbox). Elegir una plantilla escribe una frase editable en el cuadro de texto; `直接创建` construye una a partir del propio cuerpo de la plantilla, sin pasar por el modelo.
- **Cinco sitios para ejecutar una app** — el panel a pantalla completa, una pestaña del navegador, una pestaña de la sesión actual (junto a `对话` / `轨迹`), un cajón a la derecha y una ventana flotante anclada arriba a la derecha del área de conversación. Todos reutilizan el mismo ejecutor en sandbox.

El almacenamiento tiene dos capas físicamente separadas: la copia de trabajo que edita el agente y la instantánea publicada que sirve el ejecutor. Los cambios no salen en vivo hasta que publicas.

Efecto visible para el modelo: cada llamada y cada resultado quedan registrados, así que todo el flujo puede reconstruirse desde el log de la sesión. El documento publicado se sirve desde una URL de capacidad en `/plugins/dsh-miniapp/serve/{id}`, dentro de un iframe en sandbox (sin `allow-same-origin`).

## Install

```sh
cd dsh-miniapp
pnpm pack
dsh plugin --profile web add ./dsh-miniapp-0.2.0.tgz
```

Reinicia DSH después de instalar: los cambios de la capa bundle surten efecto al reiniciar. El icono de MiniApps aparece entonces en el extremo derecho de la fila de ajustes de la barra lateral.

Desinstalar:

```sh
dsh plugin --profile web remove dsh-miniapp
```

## Configuration

| Key | Type | Default | Description |
|---|---|---|---|
| `dataDir` | string | `{DSH_HOME}/miniapp` | Dónde viven el índice, las copias de trabajo y las instantáneas publicadas |
| `showSidebarEntry` | boolean | `true` | Si se inyecta la entrada de la barra lateral |
| `watchdogMs` | number | `6000` | Margen antes de que el ejecutor declare que el iframe se ha bloqueado |

La configuración la valida el esquema Schemastery `Config` de `lib/index.js`; no hay ningún parámetro ajustable codificado a fuego. Para sobrescribir una clave en `cordis.patch.yml`:

```yaml
- id: dsh-miniapp
  config:
    watchdogMs: 10000
```

## Development

```sh
pnpm test                       # 105 pruebas: almacenamiento, rutas del host, contratos del cliente
pnpm pack                       # genera el tarball instalable
```

La verificación es por capas: lógica central, integración con el host y contrato del cliente (todas con `node --test`), más una ejecución en un proceso real contra un perfil desechable. La arquitectura, los contratos de DSH que este plugin tuvo que sortear y el registro completo de verificación están en [`docs/design.zh-CN.md`](docs/design.zh-CN.md).

## License

[MIT](LICENSE) © 2026 gpmlimeng-cyber. El diseño del producto proviene de [nomifun-desktop](https://github.com/nomifun/nomifun-desktop), con licencia Apache-2.0.
