# Pendiente y sugerencias

Ideas que salieron midiendo la noche del 2026-08-05, ordenadas por lo que
prometen. Cada una lleva **cómo comprobarla**, porque este proyecto ya se ha
tragado tres "optimizaciones" que se midieron como gratis y no lo eran, y ahora
hay herramientas para no repetirlo:

- `node tools/query-test.mjs` — qué pregunta una consulta. No gasta búsquedas.
- `node tools/background-test.mjs` — qué cuesta. Sí las gasta.
- `pncReport()` en la consola de la página — qué costó de verdad, en la build
  real, con el reparto entre espera y red.

El presupuesto es el techo de todo esto: **30 búsquedas por 300 s**, de las que
nos dejamos 20 usables. Cualquier idea se juzga en búsquedas por ítem.

---

## 0. poe.ninja manda los ids de GGG en un campo que no estábamos leyendo

**El hallazgo.** El objeto de ítem que guarda poe.ninja en React tiene un campo
`mods` que `page-bridge.js` no captura. No son ids de trade, son los **ids
internos de GGG** con sus stats y valores exactos:

```json
"implicit":[{"id":"V2MinPowerChargesCorrupted","stats":{"base_minimum_frenzy_charges":1}}]
"enchant": [{"id":"JewelExpansionPassiveNodes",
             "stats":{"local_jewel_expansion_passive_node_index":33,
                      "local_jewel_expansion_passive_node_count":5}}]
"explicit":[{"id":"AfflictionNotableGuerillaTactics",
             "stats":{"local_affliction_notable_guerilla_tactics":1}}]
```

**Lo que NO resuelve, y conviene decirlo primero:** estos ids no casan con
`/api/trade/data/stats`, que usa `explicit.stat_2048747572`. Son dos
nomenclaturas distintas de GGG y no hay endpoint público que las una, así que el
emparejamiento por texto se queda donde está.

**Lo que sí resuelve.** El id dice literalmente de dónde viene el modificador.
Comprobado sobre los once ítems corruptos de la build de prueba, sin excepción:

```
V2MaxPowerChargesCorrupted                       Heatshiver, Winterweave
V2SocketedDurationGemCorrupted, V2AllResistancesCorrupted   Architect's Hand
V2SocketedTrapOrMineGemCorrupted, V2GemLevelCorrupted       Dialla's
V2MinPowerChargesCorrupted, V2IncreasedAllAttributesCorrupted  Badge
```

Y los corruptos **sin** implícito añadido — Impossible Escape, Forbidden Flame,
Forbidden Flesh — llegan con la lista de implícitos vacía.

Eso es una respuesta directa a la pregunta que hoy contestamos comparando textos
contra el pool publicado de poe.ninja, que es el mecanismo detrás del peor bug
que ha tenido este proyecto (el Le Heup a 7 c en vez de 9 div).

**Por qué no está hecho ya.** Porque hoy no arregla nada medible: sobre este
fixture, la comparación por texto acierta en los once. Sería cambiar un mecanismo
que funciona por otro mejor **sin un caso que lo demuestre**, que es justo lo que
este documento existe para no hacer. El caso que lo demostraría es un único cuyo
pool de implícitos publicado esté presente pero equivocado; el pool *vacío* ya lo
cubre `corruptedImplicits` con un caso especial.

**Ojo con el orden.** Los ids **no** vienen alineados con los textos: el Badge
lista `["4% increased Attributes", "+1 to Minimum Frenzy Charges"]` y
`["V2MinPowerChargesCorrupted", "V2IncreasedAllAttributesCorrupted"]`, o sea al
revés. Así que no vale con emparejar por índice; o se empareja por el valor del
stat, o se usa en bloque ("si todos los implícitos están marcados Corrupted,
todos lo son"), que cubre los once casos observados.

**Cómo hacerlo.** `page-bridge.js` captura `modIds` por grupo, `collect-fixture`
emite el campo vacío (trade no lo da, y `check-wiring` compara las dos listas de
campos), `corruptedImplicits` prefiere la señal y cae al texto si no está. Volver
a capturar `worn.json` con el campo y comprobar con `query-test.mjs` que ningún
filtro cambia.

**Y de regalo:** `local_jewel_expansion_passive_node_count: 5` es el número de
pasivas de una cluster sin parsear texto, y `local_affliction_notable_*` nombra
el notable. Las dos cosas que se compran en una cluster, estructuradas.

## 1. ~~Los modificadores fijos de un único no deberían ir en la consulta~~ HECHO

Hecho en `a3a2c1c`. Se comprobó primero con búsquedas reales, y el resultado no
deja lugar a dudas: un Winterweave corrupto con seis filtros da 3 listados, y con
solo su implícito de corrupción da **los mismos 3**. Los cinco explícitos fijos no
estrechaban nada.

`content.js` pasa `variantCount` y por encima de una variante publicada se
conservan los explícitos, porque ahí *son* lo que distingue (Ralakesh's, medido
sin cambios en 1280 listados). Winterweave y Ralakesh's están en `worn.json`
justo por eso: son los dos ítems que deciden si la regla es correcta.

Ganancia: el Badge pasó de 4 búsquedas a 3, y el Winterweave de 7 filtros a 2
perdiendo el `≥` — porque ahora la búsqueda fija todo lo que varía.

## 2. Un modificador que es un inconveniente no debería gastar filtro

**La idea.** Desde que "reduced" traduce, "23% reduced Trap Throwing Speed" entra
en la consulta del Architect's Hand y "33% reduced Poison Duration on you" en la
de una joya. Medido: esa joya pasó de 1 búsqueda a 6 **para acabar en el mismo
subconjunto de cuatro filtros**. Nadie compra una joya por su penalización.

**Cuidado.** No todo "reduced" es un inconveniente: "reduced Poison Duration on
you" es un beneficio y "reduced Trap Throwing Speed" es una penalización, y la
palabra es la misma. Distinguirlos por texto es adivinar.

**Cómo comprobarlo.** Lo honesto no es una lista de palabras sino la misma regla
que ya usamos con las resistencias: si un modificador no distingue, que no ocupe
ranura. Empezar por medir cuántos ítems del fixture llevan uno y qué le pasa a la
cuenta de búsquedas al excluirlos — un `--exclude-drawbacks` en `query-test.mjs`
lo enseña gratis antes de gastar nada.

## 3. La escalera podría subir en vez de bajar, solo en las cluster

**La idea.** Sobre una Glyph Splinter real, con la misma joya y solo cambiando
filtros:

```
los seis filtros                    0 listados
sin los "also grant" pequeños     832
solo notables + nº de pasivas     832
```

Bajar desde seis cuesta 6 consultas. Subir desde los cuatro que sí aciertan
—añadiendo un "small passive" cada vez— cuesta 2 y llega al mismo sitio: la
escalera acabó ganando con uno de los dos puesto (19 listados, 1376 c).

**Por qué no está hecho.** Porque es exactamente la forma de la idea que ya se
revirtió una vez ("descending instead of permuting"), y una cluster no es la
prueba. En la pasada real **5 de 9 cluster acertaron la consulta ancha a la
primera**: para esas, subir sería empezar por una pregunta peor.

**Cómo comprobarlo.** Implementarlo detrás de una constante, correr
`background-test.mjs` sobre las 4 cluster del fixture y comparar precio *y*
búsquedas, ítem a ítem. Si el precio baja en alguna, se descarta.

## 4. ~~El anointment se está cayendo por el tope~~ RESUELTO AL REVÉS

Traduce bien (`enchant.stat_2954116742|58921`) y lo cortaba el tope, sí. Pero la
respuesta no era rescatarlo: **no hay que filtrar por el anointment nunca**. Lo
aplica quien se pone el amuleto, así que uno dropeado se vende sin anointar y
exigirlo tira casi todos los listados comparables. Excluido a propósito en
`stats.js`, solo en la ranura de encantamiento — Forbidden Flame y Flesh llevan
"Allocates X if you have the matching modifier on…" como explícito y ahí ese
modificador *es* el ítem.

## 5. ~~"1 Added Passive Skill is a Jewel Socket" no traduce~~ RESUELTO AL REVÉS

No hacía falta el alias: **ese modificador no debe filtrarse**. Los sockets
vienen con el tamaño de la cluster — una Medium siempre trae uno y una Large
siempre dos — así que lo lleva toda copia de la base y no estrecha nada, igual
que los explícitos fijos de un único.

Comprobado gratis con `query-test.mjs` antes y después: ninguna consulta cambia,
porque hoy no llegaba a ninguna (en las Large lo cortaba el tope, en las Medium
no traducía). Lo que sí cambia es el diagnóstico, que ya no lo canta como fallo
de traducción — y con eso el fixture entero se queda **sin un solo NO STAT ID**,
que es lo que hace que el próximo sí signifique algo.

## 6. Persistir la caché de consultas

`queryCache` vive en memoria del service worker, y MV3 lo mata a los 30 s de
inactividad. En la pasada real **se comió 23 de las 69 búsquedas** — dos joyas
idénticas construyen la misma consulta. Al morir el worker, ese ahorro se pierde
entre pasada y pasada.

La caché de tasaciones (2 h, en `chrome.storage`) ya cubre repetir una build
entera, así que esto solo gana en el caso de pasadas seguidas de builds
distintas que comparten ítems. Barato de hacer, ganancia pequeña y medible:
contar `answered from the query cache` en dos ejecuciones seguidas.

## 7. ~~El tercio reservado al jugador~~ BAJADO A UN SEXTO

Simulado con el propio `estimate()` de la extensión sobre las políticas reales,
para las 46 búsquedas que manda una pasada medida:

```
reserve   10s  60s  300s     46 búsquedas
1/3         3   10    20        10:13
1/6         4   12    25         6:24
1/12        4   13    27         6:13
ninguno     4   14    29         6:02
```

Casi cuatro minutos el primer escalón y veinte segundos todo lo demás. Un sexto
se lleva la ganancia entera y aún deja al jugador cinco búsquedas cada cinco
minutos. Regalar el cubo entero no compensa el riesgo de comerse un 429 propio.

**Lo que queda de aquí, y es otra cosa:** el cubo de *fetch* tiene un acantilado
en vez de una curva. Una pasada real hizo 42 fetches: contra 41 usables a 1/6
cuesta 5:01, contra 45 a 1/12 cuesta 0:31. Ajustar el reserve para caer justo por
debajo de un acantilado no es un arreglo, es una casualidad que la siguiente
build deshace. **El arreglo es hacer menos fetches** — la escalera hace uno por
cada combinación que devuelve listados, tres por cluster. Eso sí merece medirse.

Un selector en las opciones ("estoy jugando" / "solo tasando") sigue teniendo
sentido para quien no esté jugando, pero ya no es donde está el dinero.

## 8. El service worker puede morirse a media pasada

`RateLimiter` duerme hasta 30 s de golpe, y MV3 mata al worker tras 30 s sin
eventos. Un `setTimeout` pendiente **no** cuenta como actividad. No lo hemos
visto pasar —la pasada de 30 ítems terminó entera— pero si pasa, el
`sendMessage` en vuelo se cae y la pasada se corta a medias.

**Cómo comprobarlo.** Provocarlo: forzar una espera larga con el cubo agotado y
ver si el worker sobrevive. Si no, la respuesta conocida es un puerto abierto o
`chrome.alarms` para trocear la espera.

## 9. Las flasks

`background-test.mjs` las filtra diciendo que `content.js` no las tasa, y el
informe real enseña un Diamond Flask y un Cinderswallow tasados. Uno de los dos
miente. Además la wiki dice que **todos** los modificadores de una flask son
locales, y las estamos tratando como globales.

**Cómo comprobarlo.** Gratis con `query-test.mjs` sobre una flask.
