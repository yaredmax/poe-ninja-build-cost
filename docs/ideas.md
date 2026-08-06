# Pendiente y sugerencias

Ideas que salieron midiendo la noche del 2026-08-05, ordenadas por lo que
prometen. Cada una lleva **cómo comprobarla**, porque este proyecto ya se ha
tragado tres "optimizaciones" que se midieron como gratis y no lo eran, y ahora
hay herramientas para no repetirlo:

- `node tools/query-test.mjs` — qué pregunta una consulta. No gasta búsquedas.
- `node tools/background-test.mjs` — qué cuesta. Sí las gasta.
- `pncReport()` en la consola de la página — qué costó de verdad, en la build
  real, con el reparto entre espera y red.

El presupuesto es el techo de todo esto, y **depende de quién llame**: la regla
`ip` da 30 búsquedas por 300 s y una sesión iniciada suma la regla `account`, que
sube el mismo cubo a 60. De ahí nos dejamos un sexto. Cualquier idea se juzga en
búsquedas por ítem, no en segundos.

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

**Qué son exactamente.** Comprobado: `/api/trade/data/stats` tiene 17.947
entradas y **ninguna** con esa forma — todas son `explicit.stat_2048747572` o
`pseudo.pseudo_total_cold_resistance`. Estos otros son los nombres del **fichero
de datos del juego**: `V2MinPowerChargesCorrupted` es un id de `Mods.dat` y
`base_minimum_frenzy_charges` un stat de `Stats.dat`. Dos nomenclaturas de GGG
sin puente público entre ellas, así que el emparejamiento por texto para *buscar*
se queda donde está.

**Y una advertencia que hay que verificar antes de fiarse.** El objeto de ítem
viene de poe.ninja, y la API pública de GGG (personaje, stash) no devuelve ids de
mod: solo texto. O sea que **poe.ninja los está resolviendo**, probablemente
contra un volcado tipo RePoE. Si los resuelve por texto, fiarse de ellos es mover
nuestro problema de emparejamiento al suyo — mejor que el nuestro, seguramente,
pero no es una fuente primaria. Antes de construir nada encima, confirmar de
dónde salen.

**Lo que NO resuelve, y lo dije mal en su momento:** no distingue un modificador
*fijo* de uno *tirado*. En un Watcher's Eye conviven `MaximumLifeUnique__9`
(fijo) y `PrecisionIncreasedAttackDamage` (tirado) y nada en la forma del id los
separa. O sea que **esto no habría evitado el fallo del Grand Spectrum**, que fue
exactamente ese problema.

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

## 1. ~~Los modificadores fijos de un único no deberían ir en la consulta~~ REVERTIDO

Hecho en `a3a2c1c` y **deshecho en `0670f5d`**, y la historia vale más que la
idea. La regla se comprobó con búsquedas reales sobre un Winterweave corrupto —
seis filtros y un filtro daban los mismos 3 listados — y llevaba `variantCount`
como guarda para los únicos que sí se distinguen por sus explícitos.

Un Grand Spectrum corrupto se coló por debajo: poe.ninja **no publica variantes**
para esa joya (`variantCount: 0`, y encima da mal la base), así que la guarda no
saltó y se tiró "+1 to Minimum Power Charges per Grand Spectrum", que es toda la
diferencia entre una y otra. Salió a 1297 c en vez de 35.5 div.

**La lección no es sobre la guarda.** Un ítem no es una medición, "sin pool
publicado" no significa "lo lleva toda copia", y no hay ningún campo en los datos
de economía que diga cuál de las dos cosas es. Los ids internos de la idea 0
**tampoco** lo dicen — lo comprobé después y me había precipitado al sugerirlo.
Quien retome esto necesita una fuente que separe fijo de tirado, y ahora mismo la
única que tenemos es el pool `optional` de poe.ninja, que para el Grand Spectrum
no existe.

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

Simulado con el propio `estimate()` de la extensión, para las 46 búsquedas que
manda una pasada medida. **Con las dos políticas**, porque resultó que no hay
una: GGG aplica sus reglas por llamante y una sesión iniciada suma la regla
`account` a la de `ip`.

```
46 búsquedas      1/3     1/6    1/12       0
  solo ip        10:13   6:24    6:13    6:02
  ip + account    5:13   3:27    3:21    3:09
```

La forma es la misma en las dos: el escalón de 1/3 a 1/6 se lleva la ganancia
(un 37% y un 34%) y lo de después son segundos. O sea que la decisión era
correcta aunque la tomé con la política equivocada delante.

Y de paso: **logueado se va al doble de velocidad.** La extensión lo detecta y lo
dice al terminar la pasada, porque si no nada en pantalla explica por qué la
misma build tarda el doble para una persona que para otra.

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

## 9. ~~Una cluster corrupta puede irse sin precio~~ HECHO

La Gale Splinter gastaba 7 búsquedas y 160 segundos para acabar en
`"no listing found with any subset of its mods"`. Dos causas encadenadas.

El presupuesto de la escalera (`MAX_COMBO_QUERIES = 6`) cubre **exactamente un
nivel** para un ítem de 6 mods: seis subconjuntos de tamaño cinco y se acabó. Un
ítem cuyo mercado solo existe dos niveles más abajo lo gasta todo y vuelve sin
nada.

Y la corrupción estaba en todos los subconjuntos, porque `mods` la pone la
primera y ningún peldaño la suelta.

**El arreglo no fue permutar mejor sino no permutar.** Idea del usuario: cuando
la ancha falla y el ítem está corrupto, preguntar lo mismo sin los mods de
corrupción y con `corrupted` fuera del todo (el "any" de trade). Se conservan
todos los mods que la joya tiró y solo se relaja "y estaba corrupta así".

```
antes (permutando)        8 búsquedas   1.7 div    4 listados   3 filtros
después (relajando)       2 búsquedas   8.7 div   11 listados   5 filtros
```

**No se aplica a únicos**, y ese límite importa: ahí el implícito de corrupción
es la razón de ir a trade, así que relajarlo pide el único normal y aterriza en
el suelo que este camino existe para batir.

Queda el último recurso que se metió antes (media docena de mods de la joya, una
búsqueda) para los **no corruptos** que agotan la escalera. Ese caso no está
medido todavía.

## 10. Las flasks — a medias

**Hecho:** el encantamiento de Enkindling ya entra en la búsqueda (`FLASK_FIELDS`),
que llevó una Diamond Flask rara de 20 c sobre 358 listados a 186 c sobre 82. El
trigger de Instilling se deja fuera a propósito, porque lo pone el comprador.
Y `background-test.mjs` ya las ve: las excluía con un comentario que decía que
no se tasaban, y sí se tasan.

**Sin resolver, y son dos cosas distintas:**

La wiki dice que **todos** los modificadores de una flask son locales, y las
tratamos como globales. No sabemos qué efecto tiene eso; ninguna medición lo ha
tocado.

Y las flasks raras salían con 300-1900 listados —`low`, o sea basura por
definición nuestra— y aun así `reliable: true`, sumando al total. La regla de
"construida con sus propios mods, luego es precisa" se pensó para el extremo de
*pocos* resultados y se aplica también al de *muchos*. Con el encantamiento
dentro ya no se da en los datos que tenemos, así que no se ha tocado — pero la
regla sigue diciendo que mil listados son fiables.
