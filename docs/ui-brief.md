# Qué hace la extensión y qué se ve en pantalla

Informe para pasárselo a alguien que vaya a diseñar las vistas. Describe lo que
hay hoy, no lo que debería haber, y marca en cada sitio qué información existe ya
en el código y no se está enseñando.

## En una frase

Abres la página de un personaje en poe.ninja, pulsas un botón, y la extensión
pone un precio encima de cada objeto y te dice cuánto cuesta la build entera.

## El flujo, tal cual lo vive el usuario

1. Entra en `poe.ninja/poe1/builds/.../character/...`. Aparece un **botón
   flotante** abajo a la derecha.
2. Lo pulsa. Se abre un **panel lateral** y en menos de un segundo aparecen las
   insignias de precio de poe.ninja sobre los iconos, y el total.
3. Detrás, en segundo plano, arranca la **pasada de trade**: los objetos que
   poe.ninja no sabe tasar bien (raros, únicos corruptos, joyas) se buscan uno a
   uno en el mercado oficial. **Tarda entre 2 y 6 minutos.**
4. Según van llegando, cada insignia deja de parpadear y el total sube o baja.
5. Al terminar, todo firme. Pulsar el botón otra vez cierra el panel.

Lo importante de ese flujo para el diseño: **hay dos fases y la segunda es
larga**. La primera respuesta es instantánea y provisional; la buena tarda
minutos y llega a goteo.

## Vista 1 — El botón flotante

Círculo abajo a la derecha, sobre la página de poe.ninja. Tres estados:
reposo, cargando (girando) y hecho. Es lo único visible hasta que se pulsa.

## Vista 2 — El panel

Panel lateral que se desliza desde la derecha, sobre la página. De arriba abajo:

- **Cabecera**: nombre de la extensión y botón de cerrar.
- **Línea de estado**: una sola línea que va contando lo que pasa —
  `Pricing on trade… 12/25 — Grand Spectrum · waiting 23 s for GGG's rate limit`.
  Es donde el usuario pasa la mayor parte de esos minutos mirando.
- **Total**: el número grande. Etiquetado **"Minimum"**, porque muchos objetos se
  tasan a la baja a propósito.
- **Secciones por categoría** — equipo, joyas, gemas, frascos — cada una con su
  subtotal, ordenadas por dinero. Dentro, una fila por objeto: nombre, símbolo y
  precio. Los duplicados se agrupan ("×3").
- **Notas al pie**: cuántos objetos quedaron fuera del total y por qué.

Cada fila y cada insignia **es un enlace** que abre la búsqueda exacta de la que
salió ese número, en la web de trade.

## Vista 3 — Las insignias sobre los objetos

Encima de la esquina inferior derecha del icono de cada objeto, en la propia
página de poe.ninja. En las gemas, que son una lista de texto, van al lado del
nombre.

El color dice **cuánto fiarse**, no de dónde viene:

| | significado | ¿suma al total? |
| --- | --- | --- |
| ámbar sólido | número firme | sí |
| ámbar hueco | un suelo (`≥` o `±`) | sí, como mínimo |
| gris | `?`, o sin precio | no |
| *parpadeando* | aún en cola, provisional | — |

Y el símbolo dice **por qué**:

- `≈` tasado con todo lo que el objeto tiene
- `≥` tasado con menos modificadores de los que tiene, así que vale al menos eso
- `±` poe.ninja publica varias variantes y no sabemos cuál es esta
- `?` demasiados objetos parecidos, el número no significa nada

**Aquí está la mejora que se pidió.** Cada insignia tiene un `title` con la
explicación completa —
*"53 listing(s) matching 1 of the 6 modifier(s) searched for, cheapest median.
Replaces poe.ninja's published price. Priced on fewer mods than it has, so it is
worth at least this."* — y en las filas del panel **ese texto no aparece por
ningún lado**. La idea es un icono de información en cada fila que lo enseñe.

Las insignias, además, son `pointer-events: none` para no tapar el tooltip de
poe.ninja, así que el suyo solo sale en las que son enlace.

## Vista 4 — El popup de la barra

Lo que sale al pulsar el icono de la extensión. Es pequeño y solo tiene lo que se
toca a menudo:

- **Minimum roll**, un deslizador (0-100%, por defecto 80)
- **Which listings count**, un desplegable
- Botón a los ajustes completos, enlace para reportar un fallo, enlace de donar

## Vista 5 — La página de opciones

Página completa con todo: el deslizador y el desplegable de arriba, más el
interruptor de únicos corruptos y un botón para vaciar la caché de precios. Cada
ajuste lleva su explicación al lado.

## Información que ya existe y no se enseña

Todo esto está en el código y disponible, por si al diseñar aparece un hueco:

- **El motivo de cada precio** (el `title` de la insignia), hoy invisible en el
  panel. Es la mejora pedida.
- **Cuánto ha costado cada objeto**: búsquedas gastadas, repartidas entre la
  consulta ancha y la escalera, y el tiempo dividido entre "esperando el límite
  de GGG" y "esperando a GGG". Hoy solo sale llamando a `pncReport()` en la
  consola.
- **Cuántos listados** respaldan cada número, y su fiabilidad (`high`, `medium`,
  `low`, `thin`).
- **Qué modificadores** entraron en la búsqueda de cada objeto.
- **Si el usuario está logueado** en pathofexile.com: sin sesión el límite es la
  mitad y la pasada tarda el doble. Hoy se dice en una frase al final.

## Restricciones que el diseño tiene que respetar

- **Va encima de poe.ninja**, que es un sitio oscuro. El panel no puede tapar los
  objetos: el usuario necesita ver las insignias y el panel a la vez.
- **Nada de recursos externos.** Sin fuentes de Google, sin CDN, sin imágenes
  remotas: es una extensión y la política de seguridad lo prohíbe.
- **Los estilos van namespaced** con el prefijo `pnc-` para no chocar con los de
  poe.ninja, que son clases generadas (`_text_11d3e_1`) que cambian en cada
  despliegue.
- **La segunda fase tarda minutos** y llega a goteo. Cualquier diseño tiene que
  aguantar que el 60% de las filas estén provisionales durante varios minutos.
- Los precios se muestran en **chaos y divine**, y la conversión cambia cada día.

## Los números reales, para que el diseño tenga escala

De una build medida de verdad:

- **25 objetos** en el panel, de los cuales unos 10 van a trade
- **4 o 5 secciones**: equipo, joyas, frascos, gemas
- Los nombres más largos son del estilo *"Foulborn Romira's Banquet"* o
  *"Added Small Passive Skills also grant: Regenerate 0.15% of Life per Second"*
  en los tooltips
- Un total típico ronda las **50-150 divines**
- La pasada de trade: **2 a 6 minutos**, con un objeto parándose hasta 45 s
