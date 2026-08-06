# Cómo funcionan los modificadores en PoE, y qué implica para este código

Notas tomadas de la [wiki de PoE](https://www.poewiki.net/wiki/Modifier) y de lo
que hemos ido midiendo contra la API de trade. No es un resumen de la wiki: es la
parte que cambia decisiones aquí, con el enlace a dónde se decide.

Escrito el 2026-08-06, después de que `tools/query-test.mjs` enseñara que un
Watcher's Eye salía a 2 c porque no distinguíamos un modificador *fijo* de uno
*tirado*. Esa distinción es el 80% de este documento.

## Un modificador no es una línea de texto

Un ítem no tiene "seis mods". Tiene varias **listas** distintas, y GGG las manda
por separado — la misma forma que poe.ninja guarda en React y que lee
`src/page-bridge.js`:

| lista | qué es | quién puede cambiarla |
| --- | --- | --- |
| `implicitMods` | lo que trae la base, arriba del todo | Blessed, **Vaal (corrupción)**, Eldritch, sintetizado |
| `enchantMods` | encantamiento: ranura propia, **no** ocupa la del implícito | laboratorio, Instilling/Enkindling, anointment |
| `explicitMods` | los afijos, prefijos y sufijos | Chaos, Exalted, Essence, esencias, harvest… |
| `craftedMods` | de la mesa de crafteo | la mesa |
| `fracturedMods` | fracturado: fijo, no se puede reemplazar | Fracturing Orb / Synthesis |
| `mutatedMods` | la mutación Foulborn (Allflame) | el propio Allflame |

Esto **no es una taxonomía decorativa**: en la API de trade el mismo texto vive
bajo un prefijo distinto según la lista, y buscarlo bajo el prefijo equivocado
devuelve cero. Ya nos costó sangre dos veces, documentado en el README:

- `explicit.stat_1085167979` y `enchant.stat_1085167979` son búsquedas distintas.
  El "Adds 5 Passive Skills" de una cluster es `enchant.`, y como `explicit.` no
  existe.
- `fractured.stat_3556824919` no significa "tiene +12% de multi crítico" sino
  "lo tiene **y está fracturado**": 7 listados contra 2712.

Regla que aplica `src/lib/stats.js`: cada modificador se busca **donde está**.
Solo `fractured` y `crafted` se reescriben a su gemelo explícito, porque
describen *cómo llegó* el modificador y no *qué es*.

## Fijo contra tirado: la distinción que nos costó un precio

En un **raro**, todos los modificadores son tirados: por eso su valor es la
combinación concreta que le salió.

En un **único**, el pool está escrito en el ítem. La mayoría de sus modificadores
son idénticos en todas las copias, y unos pocos varían. La wiki lo llama
*generation type*; poe.ninja lo publica marcando los variables como `optional`, y
ese pool viaja en el índice de precios como `rollPool`.

Consecuencias, y son las dos direcciones del mismo error:

- **Un modificador fijo no estrecha una búsqueda por nombre.** Si buscas
  "Le Heup of All" el mercado te da Le Heups; añadir "+8 a todos los atributos"
  no quita ninguno, porque todos lo llevan. Solo puede romper la consulta si el
  texto no traduce igual en el listado.
- **Un modificador tirado es la identidad de esa copia.** Un Watcher's Eye tira
  2 o 3 de **87** modificadores posibles. Los tres primeros que enseña —escudo,
  vida, maná— los tiene toda copia; filtrar por ellos te devuelve el mercado
  entero y su precio suelo.

Dónde vive esto: `rolledMods()` en [stats.js](../src/lib/stats.js) filtra por el
pool cuando lo hay, y `runAppraisal()` en [background.js](../src/background.js)
solo escalona los modificadores que distinguen una copia de otra — la mutación,
los implícitos de corrupción y, **si hay pool**, los tirados. Sin ese "si hay
pool" el Watcher's Eye no tenía nada que escalonar y caía al suelo: 2 c contra
16.3 div.

## La corrupción añade un implícito, no lo cuenta

Un Vaal Orb puede **añadir o reemplazar** un implícito, y el Altar of Corruption
puede dejar **dos**. Eso es lo que mueve el precio de un único corrupto, no el
hecho de estar corrupto.

Contar implícitos no vale, y falla justo en el ítem que más importa: poe.ninja
publica un implícito para el Le Heup of All (el del Iron Ring) y una copia
corrupta también lleva uno — el de la corrupción. Uno no es más que uno. Hay que
comparar **los textos** contra el pool publicado, que es lo que hace
`corruptedImplicits()`.

Medido: una **doble** corrupción es dos implícitos que por separado son comunes y
juntos casi no existen. El Badge of the Brotherhood de la build de prueba da 0
listados con los dos, y 53 con uno solo. Por eso la escalera baja de la pareja a
cada implícito suelto y se queda con el más caro: la copia lleva los dos, así que
vale al menos lo que vale el caro por su cuenta.

## Local contra global

La wiki: un modificador es **local** si toca las propiedades del propio ítem
(daño físico, cadencia y crítico de un arma; armadura/evasión/escudo de una
armadura; **todos** los mods de una flask), y global si no.

Para nosotros importa por una razón práctica: un mod local ya está sumado en la
propiedad que enseña el ítem, así que se busca **por la propiedad y no por el
mod**. Un filtro `es` cubre lo que "+93 al escudo máximo" y "136% aumento de
escudo" gastaban en dos, y además encuentra ítems que llegan al mismo número por
otro camino. Eso es `GEAR_FIELDS` y `isCoveredByTotals()`.

Efecto medido y contraintuitivo: por eso **el equipo raro casi nunca falla la
consulta ancha**. Después de que las propiedades absorban lo local y el pseudo se
lleve las resistencias, a un casco de siete modificadores le quedan tres o cuatro
filtros. La "consulta ancha" del equipo no es ancha.

Ojo con las flasks: la wiki dice que **todos** sus modificadores son locales, y
nosotros las tasamos por sus mods como si fueran globales.

## Los pseudo modificadores no existen en el ítem

`pseudo.pseudo_total_elemental_resistance` no es un modificador: es una suma que
el sitio de trade calcula. La gente compra "+120 de resistencia total", no
"+43 fuego, +45 frío". Un mod híbrido ("+13% a fuego y caos") cuenta entero en
las dos mitades — y antes de que existiera el pseudo de caos se caía por en medio
y no contaba para nada.

La fuerza alimenta el pseudo de vida a media vida por punto, y como Awakened solo
lo construimos si el ítem lleva vida plana: un amuleto con fuerza y sin vida no
es un amuleto de vida.

## Enchant, anointment y las opciones

Un encantamiento tiene ranura propia. En trade muchos son **opciones** en vez de
valores: el id acaba en `|38918` y ese número *es* la elección. No admiten
mínimo — pedirlo devuelve cero, que es por lo que `buildComboQuery` no pone
`value` cuando el id lleva `|`.

**Los que sí llevan número tampoco admiten el deslizador.** La wiki: *"They are
always fixed values, so Blessed Orbs have no effect on them"*. Un encantamiento
no tiene rango, así que pedirle el 80% no es pedir una tirada peor del mismo
encantamiento: es pedir **otro distinto**. Una cluster con "Adds 5 Passive
Skills" se buscaba como "4 o más", y una joya de 4 pasivas es un ítem más barato
que se colaba en la comparación. Van con valor exacto. Medido: de 20 listados a
14, mismo precio, seis joyas que no eran comparables fuera.

**El anointment no se filtra nunca.** "Allocates Disciple of the Slaughter" en un
amuleto traduce perfectamente (`enchant.stat_2954116742|58921`) y aun así se deja
fuera a propósito, y el motivo es de mercado y no de modificador: lo aplica quien
se pone el amuleto, así que uno dropeado se vende **sin anointar**. Exigirlo tira
casi todos los listados comparables para insistir en un paso que hace el
comprador.

Ojo con el alcance: se excluye solo en la ranura de encantamiento. Forbidden
Flame y Forbidden Flesh llevan "Allocates X if you have the matching modifier
on…" como **explícito**, y ahí ese modificador *es* el ítem entero — excluirlo
tasaría una joya de Chieftain como una de Berserker.

## Cluster jewels

Son su propio mundo y aquí está el grueso del gasto de la extensión.

Una cluster lleva, en listas distintas: el número de pasivas que añade y el
encantamiento base (`enchantMods`), los notables que concede y los "Added Small
Passive Skills also grant: …" (`explicitMods`).

**Los sockets vienen con el tamaño, así que no se filtran.** Lo que puede llevar
cada tipo es fijo:

| tipo | nodos significativos | pasivas que añade |
| --- | --- | --- |
| Small | 1 notable | 2-3 |
| Medium | 1 socket + 2 notables | 4-6 |
| Large | 2 sockets + 3 notables | 8-12 |

O sea que "1 Added Passive Skill is a Jewel Socket" lo lleva toda Medium y
"2 Added Passive Skills are Jewel Sockets" toda Large: no estrecha nada y solo
gastaría una de las seis ranuras que necesitan los notables y el número de
pasivas. Excluido en `stats.js` — mismo principio que los explícitos fijos de un
único.

De paso quita un falso positivo: el singular que usa el juego cuando es uno,
"1 Added Passive Skill is a Jewel Socket", **no existe en la lista de trade**
(solo indexan el plural), así que el diagnóstico lo cantaba como fallo de
traducción igual que a un modificador que sí importa.

El número de pasivas (`Adds 5 Passive Skills`) **sí** varía dentro del tipo y es
lo que se compra, así que va con valor exacto (ver arriba).

Lo que se compra son **los notables y el número de pasivas**. Medido sobre una
Glyph Splinter real, con la misma joya y variando solo los filtros:

```
los seis filtros                    0 listados
sin los "also grant" pequeños     832
sin el enchant de opción            0
solo notables + nº de pasivas     832
```

Es decir: los dos "Added Small Passive Skills also grant: +8 a Destreza/Fuerza"
juntos no los tiene nadie, y son los que hacen fallar la consulta ancha de toda
cluster. Pero **quitarlos no es la respuesta**: la escalera acaba encontrando 19
listados conservando uno de los dos, y esos 19 valen 1376 c mientras que los 832
son basura de 1 c. La escalera está haciendo exactamente su trabajo.

## Las dos nomenclaturas de GGG, que no se juntan

Hay **dos** formas de nombrar un modificador y no hay puente público entre ellas:

| | ejemplo | quién la usa |
| --- | --- | --- |
| id interno | `PrecisionIncreasedAttackDamage` | el objeto de ítem de poe.ninja |
| stat de trade | `explicit.stat_2048747572` | `/api/trade/data/stats`, las búsquedas |

Y una tercera cosa, el nombre del stat: `attack_damage_+%_while_affected_by_precision`.

Por eso el emparejamiento es **por texto**: el índice de precios de poe.ninja
publica plantillas (`"(40-60)% increased Attack Damage while affected by
Precision"`, con `optional: true/false`) y trade publica textos con `#`. Unirlos
por el texto normalizado es el único puente que existe sin una tabla de terceros.

Lo que **sí** da el objeto de ítem, y no estamos leyendo, es el campo `mods` con
el id interno y los valores exactos por stat. Ahí el id dice de dónde viene el
modificador — `V2MinPowerChargesCorrupted` se identifica solo como corrupción —
que es la pregunta que hoy contestamos comparando textos. Ver la idea 0 en
[ideas.md](ideas.md), con la evidencia y por qué no está hecho todavía.

## Dónde mirar cuando algo salga raro

`node tools/query-test.mjs <nombre>` enseña, sin gastar una sola búsqueda de
GGG, qué modificadores llegaron a la consulta, cuáles se cayeron y por qué —
si no estaban en el pool, si no tienen id de stat, o si los recortó el tope.
Es la herramienta que encontró todo lo de arriba.
