# PoE Ninja Checker

Extensión de Chrome (Manifest V3) que, en una página de personaje de
[poe.ninja](https://poe.ninja/poe1/builds), pone el precio al lado de cada ítem
reconocido y calcula un coste mínimo de la build.

## Instalación

1. `chrome://extensions` → activa **Modo de desarrollador**.
2. **Cargar descomprimida** → selecciona esta carpeta.
3. Abre cualquier build: `https://poe.ninja/poe1/builds/.../character/...`
4. Panel arriba a la derecha → **Calcular precio**.

## Cómo obtiene los datos

**Ítems del personaje: leyendo el DOM ya renderizado.** No se llama a la API de
builds de poe.ninja. Su [documentación](https://poe.ninja/docs/api) es explícita:

> The builds / profiles API, and every other non-economy endpoint (character,
> Path of Building, authentication), are internal. They are undocumented,
> unsupported, and not available for third-party use.

Leer lo que la página ya ha pintado no genera ni una petición extra contra esos
endpoints, y respeta a quien oculta su perfil: si la web no lo muestra, la
extensión tampoco lo ve.

**Precios: la API de economía documentada**, que sí es de uso público:

```
GET https://poe.ninja/poe1/api/economy/leagues
GET https://poe.ninja/poe1/api/economy/stash/current/item/overview?league={liga}&type={tipo}
```

Se piden 13 categorías (únicos, gemas, cluster jewels…), con concurrencia
máxima de 3 y caché local de 10 minutos — los datos de PoE1 se refrescan cada
~15 min, así que pedir más a menudo no aporta nada. El `User-Agent` descriptivo
que pide la doc se inyecta con `declarativeNetRequest`, limitado a las
peticiones del service worker (`tabIds: [-1]`) para no tocar las de la web.

## Qué NO puede hacer

Esto es una estimación con un suelo, no una tasación:

- **Los raros crafteados quedan fuera.** No existe "el precio" de unas botas con
  vida y resistencias: ese ítem concreto no está a la venta en ningún sitio.
- **Ítems marcados `≥`** (Watcher's Eye, Sublime Vision, Impossible Escape,
  jewels temporales…): poe.ninja publica un solo precio para todos, que es el
  del más barato. El real puede ser 100 veces mayor. Se detectan contando
  modificadores `optional` (un único normal tiene 0; un Watcher's Eye, 87), más
  una lista manual para los que varían por algo que no es un mod.
- **Ítems marcados `±`**: poe.ninja publica varias variantes (nivel/calidad de
  gema, links, corrupción) y desde el DOM no sabemos cuál lleva el personaje.
  Se muestra la más vendida.

Por eso el total se etiqueta **Mínimo**.

## Cómo reconoce los ítems

No se usan selectores CSS de poe.ninja: son clases generadas por Astro
(`_text_11d3e_1`) que cambian en cada despliegue. Se usan dos vías:

1. **Por texto**, contra los ~2.400 nombres del índice de precios. Las joyas
   aparecen como nombre + base ("Watcher's Eye Prismatic Jewel"), así que se
   prueba también quitando el sufijo de base.
2. **Por icono**, para el equipo: no lleva nombre en el DOM, sólo un `<img>` de
   poecdn, y la API de economía devuelve esa misma URL. Se compara el nombre del
   fichero de arte. Joyas y gemas quedan fuera de esta vía porque su arte es el
   de la *base*: un cluster jewel raro y el único "The Light of Meaning"
   comparten `AfflictionJewel.png`.

Las gemas se afinan por nivel/calidad leyendo el "3 / 20" que la página pone
junto al nombre, así que se cotiza la línea correcta y no la más vendida.

Tres detalles que costaron sangre y están cubiertos por los tests:

- El escaneo se acota al `<article>`. El pie de página lleva el diálogo de
  cookies con cientos de vendors, y algunos ("Impact", "Momentum", "Signal")
  coinciden con nombres reales de ítems.
- Los jewels Forbidden se publican con el nombre del *pasivo* que otorgan, así
  que indexarlos por nombre hacía que la lista de ascendencia del personaje
  ("Deathmarked", "Mistwalker") cotizara como si fuera un jewel.
- El bloque de DPS repite los nombres de las skills ("Blade Blast 2.2/s"), lo
  que duplicaba cada gema y además leía "2" como nivel.

## Estado

Verificado de punta a punta contra
`poe1/builds/allflame/character/pathofky-0288/Ky_BladeBUSTIN`: 40 ítems
reconocidos, mínimo 44,7 div. El equipo de esa build es todo raro, así que lo
que se cotiza son joyas y gemas — Empower 4 (13 div) y Enlighten 4 (18 div) son
el grueso.

```bash
node tools/smoke-test.mjs   # capa de precios contra la API real
```

```bash
node tools/match-test.mjs   # matching contra textos e iconos reales de una build
```

Si algún día deja de reconocer nada, en la consola de la página:

```js
pncDiagnostico()
```

vuelca los textos e iconos candidatos para ver qué ha cambiado.

## Vía principal: `src/page-bridge.js`

poe.ninja guarda en la memoria de React el JSON completo de cada ítem, con el
mismo esquema que la API oficial de GGG: `explicitMods`, `craftedMods`,
`sockets`, `ilvl`, `corrupted`, `properties`. En la build de prueba salen 61
ítems, todos con su slot (`inventoryId`) y un elemento DOM donde anclar.

Eso sustituye al escaneo por texto e icono, que es un apaño comparado: en esa
misma build el escaneo por icono se perdió un Headhunter, un Skin of the Lords
y un Ming's Heart, o sea la mayor parte del valor.

Hace falta un fichero aparte porque un content script normal vive en un realm
aislado y no ve las propiedades `__reactFiber$…`. Sigue sin haber ninguna
petición extra contra poe.ninja: es lo que la página ya tiene cargado.

Es frágil por definición (internals de React minificado), así que el escaneo por
texto/icono se queda como respaldo automático: si el puente no devuelve nada,
`content.js` cae a la vía antigua y lo dice en el panel.

Con el puente, la build de prueba pasó de **44,7 div a 135,9 div** — el escaneo
por icono se perdía el Headhunter (60 div) y el Wine of the Prophet (32 div).

```bash
node tools/price-test.mjs   # precios de los 61 ítems reales de una build
```

## Botones de trade (retirados)

Hubo un botón ⇗ por ítem que abría la búsqueda en la web de trade. Se quitó de
la interfaz porque se comportaba de forma rara.

`buildQuery()` y `search()` siguen en `src/lib/trade.js`, marcadas como no
conectadas: están probadas y volver a enchufarlas es sólo volver a llamarlas.
El flujo era `POST /api/trade/search/{liga}` → `id` → abrir
`pathofexile.com/trade/search/{liga}/{id}` con `chrome.tabs.create` desde el
service worker (desde el content script, el `await` rompe la cadena del gesto
del usuario y Chrome lo bloquea como popup).

## Dónde se pinta el precio

En equipo, joyas y flasks el badge va superpuesto en la esquina inferior derecha
del icono, con `pointer-events: none` para no tapar el tooltip del ítem de
poe.ninja. Las gemas son una lista de texto, así que ahí va al lado del nombre.
Lo decide `colocarBadge()` en función de la categoría y de si encuentra un
contenedor con tamaño de icono.

## Límites reales de la API de trade

Medidos contra `POST /api/trade/search/Allflame` (devuelve `id`, y con él se
abre `pathofexile.com/trade/search/{liga}/{id}`):

```
X-Rate-Limit-Ip: 5:10:60, 15:60:300, 30:300:1800, 600:21600:3600
```

5 peticiones por 10 s (baneo 60 s), 15 por minuto (baneo 5 min), 30 cada 5 min
(baneo 30 min), 600 cada 6 h. Cualquier cosa que tase raros automáticamente
tiene que ir por cola con ~4 s entre ítems y cachear resultados.

Los botones de Trade sólo hacen falta donde poe.ninja no pone el suyo: la web ya
lo trae en las joyas, pero no en gemas ni en el resto del equipo.

## Tasación de raros

Un raro no tiene precio de mercado: ese ítem concreto no está en venta en ningún
sitio. Lo que se puede hacer es buscar **ítems parecidos** y quedarse con lo que
piden por ellos. Por eso salen marcados `≈` y el aviso dice lo que dice.

Cómo se construye la búsqueda:

1. Cada texto de mod se traduce a su `stat id` con `/api/trade/data/stats`
   (`src/lib/stats.js`). Cobertura medida: **56 de 57** mods de la build de
   prueba.
2. Se agregan los pseudo-mods que de verdad usa la gente: vida total y
   resistencia elemental total, sumando las combinadas y las de "todas".
3. Se añaden hasta dos mods más de una lista de prioridad (supresión, movimiento,
   multi de crítico, niveles de gema…). Con cinco filtros los siete raros daban
   cero resultados.
4. Se busca por **categoría**, no por base exacta: de "Focused Amulet" hay un
   listado en toda la liga, así que cualquier filtro extra da cero.
5. Se lee la mediana de las ofertas más baratas. El listado más barato de una
   búsqueda ancha es siempre basura de 1 c.

### Fiabilidad, y por qué se descarta la mitad

El número de resultados dice cuánto fiarse. Doscientos cascos "con vida y
resistencias" a 1 c no es el precio del casco: es que los filtros no acotaron
nada. Uno solo tampoco vale, puede ser un precio inventado.

| resultados | fiabilidad | ¿suma al total? |
| --- | --- | --- |
| 0 | ninguna | no |
| 1–2 | escasa | no |
| 3–40 | alta | sí |
| 41–120 | media | sí |
| >120 | baja | no |

Si el primer intento se queda a cero o se pasa de ciento veinte, se reintenta
con un filtro menos o uno más, hasta dos veces, y sólo se acepta si mejora.

**En la build de prueba salen fiables 3 de 7.** Es poco, y es el resultado
honesto: los otros cuatro se muestran con su estimación en ámbar, fuera del
total, y con el enlace a la búsqueda para mirarlo a mano. Una cifra segura de sí
misma y equivocada sería peor que no dar ninguna.

```bash
node tools/rare-test.mjs   # tasa los 7 raros reales contra la API de trade
```

### Coste en peticiones

Una búsqueda más un fetch por ítem, más hasta dos búsquedas de ajuste. El
espaciado es de 5 s (`MIN_GAP_MS`), que deja 12 búsquedas por minuto contra el
límite de 15. Las joyas no se tasan: una cluster jewel vale por sus notables, y
eso no se filtra con los mods que leemos.

## Siguiente paso posible

API de trade oficial (`https://www.pathofexile.com/api/trade`) para los casos
que la economía no cubre. Funciona sin autenticación, pero tiene límites de
petición agresivos (cabeceras `X-Rate-Limit-*`) cuyo incumplimiento acarrea
bloqueo temporal de IP, así que necesita cola y backoff propios.

## Ficheros

| Fichero | Qué hace |
| --- | --- |
| `manifest.json` | MV3: permisos, content script, service worker |
| `src/background.js` | Service worker: mensajes, User-Agent, caché |
| `src/lib/economy.js` | API de economía, índice de precios, detección de precio-suelo |
| `src/lib/trade.js` | Queries de trade, tasación de raros, fiabilidad |
| `src/lib/stats.js` | Texto de mod → `stat id`, pseudo-mods |
| `src/page-bridge.js` | Extrae el JSON de los ítems del mundo MAIN |
| `src/content.js` | Panel, escaneo del DOM, badges, resumen |
| `src/content.css` | Estilos del panel y los badges |
| `tools/smoke-test.mjs` | Prueba la capa de precios fuera de Chrome |
| `tools/match-test.mjs` | Prueba el matching contra una build real capturada |
| `tools/fixtures/` | Textos e iconos reales de una página de personaje |
