# Guía de uso: integraciones (Telegram, Trello, GitHub)

Guía práctica del fork. Para el *por qué* de cada decisión de diseño está
[integrations.md](./integrations.md); esto es el *cómo*.

---

## Índice

1. [Instalación](#1-instalación)
2. [Puesta en marcha por proyecto](#2-puesta-en-marcha-por-proyecto)
3. [GitHub](#3-github)
4. [Trello](#4-trello)
5. [Telegram](#5-telegram)
6. [El watcher](#6-el-watcher)
7. [Referencia de comandos](#7-referencia-de-comandos)
8. [Referencia de configuración](#8-referencia-de-configuración)
9. [Variables de entorno](#9-variables-de-entorno)
10. [Un día de trabajo](#10-un-día-de-trabajo)
11. [Problemas frecuentes](#11-problemas-frecuentes)

---

## 1. Instalación

Desde el repo del fork (`c:\Users\HP\Desktop\aplications\personal\openspec`):

```bash
pnpm install          # solo la primera vez
pnpm build            # compila a dist/
npm link              # deja el comando `openspec` global
```

`npm link` crea un symlink al working copy: cada `pnpm build` se refleja al
instante en el comando global, sin reinstalar. Es lo que querés mientras
desarrollás el fork.

Si preferís una copia congelada, independiente del estado del repo:

```bash
npm install -g .      # hay que reinstalar en cada cambio
```

Verificar:

```bash
openspec --version
openspec github --help
```

Para desinstalar: `npm unlink -g @fission-ai/openspec`.

### Actualizar después de tocar código

```bash
pnpm build            # con npm link, no hace falta nada más
```

---

## 2. Puesta en marcha por proyecto

Las integraciones se configuran **por proyecto**, en
`openspec/integrations.yaml`. Ese archivo **se commitea**; las credenciales
nunca van ahí.

```bash
cd tu-proyecto
openspec init                        # si el proyecto todavía no tiene openspec/
openspec integrations list           # qué hay registrado y qué está prendido
```

Prender lo que vayas a usar:

```bash
openspec integrations enable github
openspec integrations enable trello
openspec integrations enable telegram
```

Cargar credenciales (van al config global del usuario, fuera del repo):

```bash
openspec integrations secret set githubToken      <token>
openspec integrations secret set trelloKey        <key>
openspec integrations secret set trelloToken      <token>
openspec integrations secret set telegramBotToken <token>
openspec integrations secret list                 # enmascarado
```

Chequear que todo esté sano:

```bash
openspec integrations status         # una línea por integración, con el fix
```

---

## 3. GitHub

El ciclo de vida del change **es** el ciclo de git flow:

| Evento | Qué pasa |
|---|---|
| `change.created` | crea `feature/<change-id>` desde develop y hace checkout |
| `task.checked` | un commit por pase del watcher, en esa rama |
| `change.archived` | commitea el archivado, pushea, abre el PR contra develop |

### 3.1 Credenciales

1. https://github.com/settings/tokens → token clásico con scope **`repo`**
   (o fine-grained con **Contents** y **Pull requests** en write).
2. `openspec integrations secret set githubToken <token>`

### 3.2 Declarar las ramas

```bash
openspec github link
```

Lee el repo del remote `origin`, detecta la rama principal y busca la de
desarrollo entre `develop`, `development` y `dev`. Escribe todo en
`openspec/integrations.yaml` y deja la integración prendida:

```
Linked domm1828/OpenSpec.
  main         → main
  develop      → develop
  feature      → feature/<change-id>
```

**No adivina.** Si el repo no tiene rama de desarrollo te lo dice y para, en vez
de caer a la rama principal — ese fallback convertiría silenciosamente un
proyecto git flow en trunk-based y apuntaría todos los PR a la rama de release.

```bash
openspec github link --create-develop        # la crea desde main
openspec github link --develop integration   # o usá el nombre que tengas
openspec github link --repo owner/nombre     # si no se puede leer del remote
openspec github link --main master           # si la principal no es la default
```

### 3.3 Trabajar

Con el watcher andando no hace falta hacer nada: creás el change y la rama
aparece. Cuando el watcher se niega (y se va a negar, a propósito), la salida
manual es:

```bash
openspec github start add-auth               # crea y hace checkout de la rama
openspec github start add-auth --from main   # desde otra base
```

Adelantar el PR antes de archivar:

```bash
openspec github pr add-auth --dry-run        # probá esto primero
openspec github pr add-auth
openspec github pr add-auth --draft
```

Diagnóstico:

```bash
openspec github status
openspec github status --json
```

### 3.4 Lo que se niega a hacer

Esto corre solo, en el mismo working tree que está editando tu agente. Cada
guarda es una forma concreta de romperte el repo, y todas terminan en un aviso
con el comando que lo arregla — nunca en una escritura, y nunca abortando el
pase del watcher.

| Situación | Qué pasa |
|---|---|
| No es repo git, o no tiene commits | nada, con el fix |
| Hay un rebase / merge / cherry-pick en curso | nada — commitear ahí reescribe lo que no es |
| Árbol sucio, al crear la rama | no crea rama: el checkout se llevaría ese trabajo a un change que no tiene nada que ver |
| HEAD no está en develop, al crear la rama | no crea rama: seguro estás en otra cosa, y sacarte de ahí es la sorpresa que hace que uno apague la integración |
| HEAD no está en la rama del change, al commitear | **no commitea.** Con dos changes activos, esta es la diferencia entre un PR que lleva su propio trabajo y uno que lleva el ajeno |
| No hay nada que commitear | no commitea, jamás `--allow-empty` |
| El change desapareció pero no está en `archive/` | no abre PR: fue borrado, no terminado |
| Ya hay un PR para esa rama | lo actualiza, no lo duplica |
| Un commit falla | las tareas quedan pendientes y el próximo pase reintenta con el mismo mensaje |

`.openspec-integrations/` queda afuera de todo commit automático,
independientemente de tu `.gitignore` — es estado local de máquina, y una
baseline commiteada a una rama es un conflicto esperando pasar. El directorio
además se auto-ignora.

### 3.5 Un commit por pase, no por tarea

Un agente que tilda tres checkboxes en una sola edición produce tres eventos
`task.checked` sobre un único working tree. Un commit por evento pondría todo el
diff en el primero y dejaría dos atrás describiendo trabajo que no contienen.
Entonces la unidad es el pase: una tarea va como asunto, varias van como conteo
más la lista en el cuerpo.

### 3.6 Apagar tramos sueltos

```yaml
github:
  autoBranch: true          # rama en change.created
  autoCommit: true          # commit en task.checked
  openPrOnArchive: true     # PR en change.archived
  commitScope: all          # all | openspec-only
  pushOnCommit: false       # pushear cada commit, no solo al abrir el PR
  draftPr: false
```

Cada etapa se apaga por separado porque querer las ramas y los commits
automáticos pero abrir los PR a mano es una postura perfectamente razonable.
`commitScope: openspec-only` va más lejos: OpenSpec commitea el rastro de papel
del change y vos escribís los commits de código.

### 3.7 Lo que no hace

Nada vuelve de GitHub hacia OpenSpec: reviews, merges y comentarios no escriben
en `tasks.md`. Mergear el PR y borrar la rama también son tuyos.

---

## 4. Trello

Una change es un card, sus tareas son ítems de un checklist, y el card se mueve
entre listas según el progreso.

### 4.1 Credenciales

1. https://trello.com/power-ups/admin → creá un Power-Up (hoy es la única forma
   de sacar una API key) → pestaña **API Key** → *Generate a new API Key*.
2. Token de usuario, con tu key puesta:
   `https://trello.com/1/authorize?expiration=never&scope=read,write&response_type=token&key=<KEY>`

```bash
openspec integrations secret set trelloKey   <key>
openspec integrations secret set trelloToken <token>
```

### 4.2 Vincular el board

```bash
openspec trello link <boardId>                  # el id está en la URL del board
openspec trello link <boardId> --create-lists   # crea las listas si faltan
openspec trello link <boardId> --json
```

Matchea las listas por nombre (`To Do`/`Backlog` → proposed, `Doing`/`In
Progress` → in_progress, `Review`/`Done` → review). Lo que no matchea queda sin
mapear en vez de adivinado — editá el YAML. El `listMap` guarda **ids**, así que
después del link podés renombrar las listas como quieras.

### 4.3 Sincronizar

```bash
openspec trello sync --dry-run           # siempre esto primero
openspec trello sync                     # dos vías
openspec trello sync --direction=push    # tasks.md → Trello
openspec trello sync --direction=pull    # Trello → tasks.md
openspec trello sync --change add-auth   # un solo change
openspec trello sync --json
openspec trello status
```

⚠️ Los flags de dirección significan que un lado manda: `--direction=pull`
**revierte** un tilde local que Trello no tenga, y `--direction=push` revierte
uno remoto. Saltean la detección de conflictos por completo.

### 4.4 Con GitHub prendido

El card **es el mismo de siempre**: cuando se crea la rama y cuando se abre el
PR, Trello le cuelga un comentario y el link del PR como attachment. Lo busca por
nombre, así que funciona aunque el archivado ya haya olvidado el id del card y
aunque el card esté cerrado.

---

## 5. Telegram

### 5.1 Poner el bot a andar

```bash
# 1. Hablá con @BotFather, /newbot, copiá el token
openspec integrations secret set telegramBotToken <token>
openspec integrations enable telegram
openspec telegram pair          # imprime un código de un solo uso
openspec telegram serve         # arranca el bot (y el watcher)
# en el chat con el bot:  /link <código>
```

### 5.2 Administrar

```bash
openspec telegram chats             # quién está vinculado
openspec telegram chats --json
openspec telegram unpair <chatId>
openspec telegram test              # verifica el token y manda un mensaje
openspec telegram serve --interval 2000
```

### 5.3 Comandos del bot

| Comando | Hace |
|---|---|
| `/changes` | lista los changes activos con progreso |
| `/change <id>` | goal, resumen, progreso |
| `/tasks <id>` | lista numerada de tareas |
| `/check <id> <n>` | tilda la tarea n |
| `/uncheck <id> <n>` | destilda la tarea n |
| `/new <nombre> — <goal>` | crea el scaffold de un change |
| `/archive <id>` | archiva, con confirmación inline |
| `/status` | resumen del proyecto en una línea |
| `/link <código>` | vincula el chat |

Los ids se pueden abreviar a cualquier prefijo no ambiguo.

**Seguridad:** la allowlist falla cerrada (sin ids configurados y sin pairings,
nadie está autorizado); a un chat no autorizado no se le contesta nada; los
códigos de pairing son de un solo uso, expiran en 10 minutos y se comparan en
tiempo constante.

Con GitHub prendido, un tilde hecho desde el bot termina en un commit — que es lo
que `telegram.autoCommit` prometía y nunca implementó.

---

## 6. El watcher

Es el corazón de todo: relee `openspec/` cada 5s y difea contra un snapshot. Sin
él no pasa nada automático, porque tu agente edita Markdown directo y ningún
comando llega a correr — `opsx:apply` es **read-only**, solo imprime
instrucciones, así que el tilde nunca pasa por el CLI.

```bash
openspec integrations watch --prime       # baseline, sin notificar nada
openspec integrations watch               # todas las integraciones prendidas
openspec integrations watch --interval 2000
openspec telegram serve                   # bot + watcher en un solo proceso
```

**Corré `--prime` una vez** al adoptar el watcher en un proyecto que ya tiene
changes. Si no, el primer pase ve cada change existente como nuevo y dispara un
`change.created` por cada uno.

### 6.1 Sin dejar nada corriendo: `integrations sync`

Es exactamente un pase del watcher, y sale:

```bash
openspec integrations sync           # imprime lo que se movió
openspec integrations sync --quiet   # calla salvo que algo falle
openspec integrations sync --json
```

No arranca el bot de Telegram (eso colgaría un comando que tiene que terminar) y
no falla cuando no hay integraciones prendidas — está pensado para colgarlo de un
hook que se dispara en cada edición, y un proyecto con todo apagado no debería
pintarse de rojo en cada guardado.

### 6.2 Colgarlo de un hook de Claude Code

Así el tilde llega a Trello y a GitHub **en el momento**, sin proceso de fondo.
En `.claude/settings.json` del proyecto:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Edit|Write|MultiEdit",
        "hooks": [
          {
            "type": "command",
            "command": "grep -qiE 'openspec[\\\\/]+changes' && openspec integrations sync --quiet 2>/dev/null || true",
            "async": true,
            "timeout": 60,
            "statusMessage": "Syncing OpenSpec integrations"
          }
        ]
      }
    ]
  }
}
```

Tres detalles que importan:

- El `grep` lee el JSON que Claude Code manda por stdin y filtra por la ruta, así
  que el hook solo corre cuando se tocó algo bajo `openspec/changes/`. La clase
  de caracteres `[\\/]` cubre las dos formas de separador, porque en Windows la
  ruta llega con backslashes escapados.
- **`async: true`** lo tira al fondo: la edición del agente no espera al sync.
- El `|| true` final es obligatorio. Sin él, `grep` sale 1 cuando la ruta no
  matchea y Claude Code lo lee como un hook que falló, en cada edición.

Después de crear o editar ese archivo, abrí `/hooks` una vez (o reiniciá la
sesión) para que Claude Code lo cargue. Si `.claude/` no existía cuando arrancó
la sesión, el watcher de settings no lo estaba mirando.

Para verlo funcionar: `/hooks` lista lo que está activo, y la UI solo muestra
"Ran N hooks" cuando uno falla o tarda — el éxito silencioso es invisible a
propósito.

Eventos: `change.created`, `change.updated`, `change.archived`,
`change.validated`, `task.checked`, `task.unchecked`, `spec.updated`, más
`vcs.branch.created`, `vcs.commit.created` y `vcs.pr.opened` que los anuncia el
adapter de GitHub.

---

## 7. Referencia de comandos

### 7.1 `openspec integrations`

| Comando | Flags | Hace |
|---|---|---|
| `integrations list` | `--json` | qué hay registrado y qué está prendido |
| `integrations enable <id>` | | prende `github`, `trello` o `telegram` |
| `integrations disable <id>` | | lo apaga |
| `integrations status` | `--json` | health check de todo lo prendido, con el fix de cada problema |
| `integrations secret set <name> <value>` | | guarda una credencial fuera del repo |
| `integrations secret list` | `--json` | qué credenciales hay (enmascaradas) |
| `integrations sync` | `--json`, `--quiet` | un solo pase y sale, para hooks y scripts |
| `integrations watch` | `--interval <ms>`, `--prime` | mira `openspec/` y despacha a todo lo prendido |

Nombres de secretos: `githubToken`, `trelloKey`, `trelloToken`,
`telegramBotToken`.

### 7.2 `openspec github`

| Comando | Flags | Hace |
|---|---|---|
| `github link` | `--repo <owner/name>`, `--main <branch>`, `--develop <branch>`, `--create-develop`, `--json` | declara las ramas de git flow y las escribe en el YAML |
| `github start <changeId>` | `--from <branch>`, `--json` | crea y hace checkout de la rama del change |
| `github pr <changeId>` | `--draft`, `--dry-run`, `--json` | abre o refresca el PR |
| `github status` | `--json` | conexión, repo y ramas |

### 7.3 `openspec trello`

| Comando | Flags | Hace |
|---|---|---|
| `trello link <boardId>` | `--create-lists`, `--json` | descubre las listas y escribe `listMap` |
| `trello sync` | `--direction <both\|push\|pull>`, `--dry-run`, `--change <id>`, `--json` | reconcilia `tasks.md` con el board |
| `trello status` | `--json` | conexión y mapeo |

### 7.4 `openspec telegram`

| Comando | Flags | Hace |
|---|---|---|
| `telegram pair` | `--json` | código de un solo uso para vincular un chat |
| `telegram chats` | `--json` | chats vinculados |
| `telegram unpair <chatId>` | | revoca un chat |
| `telegram test` | | verifica el token y notifica a los chats |
| `telegram serve` | `--interval <ms>` | bot con long polling + watcher |

### 7.5 Comandos de OpenSpec que vas a usar alrededor

| Comando | Hace |
|---|---|
| `openspec init [path]` | inicializa OpenSpec en el proyecto |
| `openspec list` | lista changes (`--specs` para specs) |
| `openspec new` | crea items nuevos |
| `openspec change` | administra propuestas de change |
| `openspec status` | estado de completitud de los artefactos de un change |
| `openspec validate [item]` | valida changes y specs |
| `openspec show [item]` | muestra un change o spec |
| `openspec view` | dashboard interactivo |
| `openspec archive [change]` | archiva un change y actualiza las specs |
| `openspec spec` | administra y consulta specs |
| `openspec context` | contexto de trabajo del root resuelto |
| `openspec doctor` | salud de las relaciones del root |
| `openspec workset` | vistas de trabajo personales (locales) |
| `openspec store` | repos OpenSpec independientes registrados en la máquina |
| `openspec schema` / `openspec schemas` | schemas de workflow |
| `openspec templates` | rutas de templates resueltas |
| `openspec instructions` | instrucciones enriquecidas para artefactos |
| `openspec config` | configuración global |
| `openspec completion` | completions del shell |
| `openspec update` | actualiza los archivos de instrucciones |
| `openspec feedback <mensaje>` | manda feedback |

Ayuda de cualquier cosa: `openspec help <comando>` o `openspec <comando> --help`.

---

## 8. Referencia de configuración

`openspec/integrations.yaml` — **se commitea**, nunca lleva credenciales:

```yaml
telegram:
  enabled: true
  allowedChatIds: [123456789]        # vacío + sin pairings = nadie
  notifyOn:                          # default: created, archived, task.checked
    - change.created
    - change.archived
    - task.checked
    - vcs.pr.opened                  # también se puede notificar los de git
  autoCommit: false

trello:
  enabled: true
  boardId: "abc123"
  listMap:
    proposed: "list-id"
    in_progress: "list-id"
    review: "list-id"
    archived: "list-id"
  checklistName: Tasks
  cardPlacement: once                # once | always
  onArchive: move                    # move | close | nothing
  conflictPolicy: manual             # manual | local-wins | remote-wins
  pollIntervalSec: 60

github:
  enabled: true
  owner: domm1828                    # lo escribe `openspec github link`
  repo: OpenSpec
  gitflow:
    main: main                       # rama principal
    develop: develop                 # base y destino de todos los PR
    featurePrefix: feature/
  autoBranch: true
  autoCommit: true
  commitScope: all                   # all | openspec-only
  pushOnCommit: false
  openPrOnArchive: true
  draftPr: false
  remote: origin
  apiBaseUrl: https://api.github.com # cambiar para GitHub Enterprise
```

### Dónde vive cada cosa

| Qué | Dónde | ¿En git? |
|---|---|---|
| Configuración | `openspec/integrations.yaml` | **sí** — commiteala |
| Credenciales | variables de entorno, o el config global del usuario | **nunca** |
| Estado de sync (card ids, baselines, ramas, PRs) | `.openspec-integrations/` | no — se auto-ignora |

---

## 9. Variables de entorno

Tienen precedencia sobre lo guardado, que es lo que querés en CI:

| Variable | Para |
|---|---|
| `OPENSPEC_GITHUB_TOKEN` | token de GitHub |
| `OPENSPEC_TRELLO_KEY` | API key de Trello |
| `OPENSPEC_TRELLO_TOKEN` | token de usuario de Trello |
| `OPENSPEC_TELEGRAM_BOT_TOKEN` | token del bot |
| `OPENSPEC_NO_COMPLETIONS=1` | silencia el tip de completions al instalar |
| `NODE_EXTRA_CA_CERTS` | **en esta máquina**, apuntar al root de Norton o npm/pnpm fallan con `UNABLE_TO_VERIFY_LEAF_SIGNATURE` |

---

## 10. Un día de trabajo

Setup, una sola vez por proyecto:

```bash
openspec init
openspec integrations secret set githubToken <token>
openspec github link --create-develop
openspec trello link <boardId>            # opcional
openspec integrations status              # todo en verde antes de seguir
openspec integrations watch --prime
```

Después, elegí uno de los dos:

```bash
openspec integrations watch      # una terminal aparte, andando todo el tiempo
```

...o el hook de la sección 6.2, que no deja nada corriendo y sincroniza en el
momento exacto en que el agente tilda.

Y a laburar:

1. Creás el change (`openspec new`, o el agente lo scaffoldea) →
   **aparece `feature/<change-id>` y quedás parado ahí.**
2. Escribís código, el agente tilda tareas en `tasks.md` (por ejemplo con
   `opsx:apply`) →
   **commit por pase**, y el card de Trello se mueve solo.
3. `openspec archive <change-id>` →
   **commit del archivado, push, y PR contra develop**, con el link colgado del
   mismo card de Trello.
4. Revisás y mergeás el PR a mano. Eso no lo toca nadie.

---

## 11. Problemas frecuentes

**`Missing credentials`** — `openspec integrations status` nombra cada secreto
que falta y el comando exacto que lo carga.

**GitHub no commiteó nada** — el log dice qué guarda lo frenó. Las dos comunes
son árbol sucio al crear la rama, y HEAD parado en una rama distinta a la del
change. `openspec github start <change-id>` resuelve las dos.

**`GitHub refused the pull request … no commits between`** — la rama feature no
tiene nada que develop no tenga. Casi siempre es que el trabajo se commiteó en
develop antes de que existiera la rama.

**No hay rama de desarrollo** — `openspec github link --create-develop`, o
`--develop <rama>` si la tuya se llama distinto.

**`No Trello list mapped for "proposed"`** — `openspec trello link <boardId>`, o
completá `listMap` a mano.

**El bot me ignora** — el chat no está autorizado. `openspec telegram chats`
muestra quién sí; `openspec telegram pair` te agrega.

**Conflictos en cada sync de Trello** — los dos lados divergieron sin baseline.
Resolvé a mano una vez y sincronizá, o fijá `conflictPolicy` si un lado siempre
tiene que ganar.

**`⚠ skipped local edit: line changed since the last sync`** — el archivo se
movió abajo del sync. No se escribió nada. Volvé a correrlo.

**npm/pnpm fallan con certificados** — `NODE_EXTRA_CA_CERTS` no está seteado.
Ver la tabla de la sección 9.
