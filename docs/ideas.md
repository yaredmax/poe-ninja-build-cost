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

## 7. El tercio reservado al jugador podría ser una opción

`USER_RESERVE = 1/3` convierte 30 búsquedas por ventana en 20, o sea **un 50%
más de reloj**. Existe por una buena razón: sin él, una pasada te bloquea tus
propias búsquedas en la web de trade. Pero si estás tasando una build y no
jugando, no hay a quién reservarle nada.

Un selector en las opciones ("estoy jugando" / "solo tasando") es honesto y
convierte 6:27 en algo más cerca de 4:20. No cambia ni un precio.

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
