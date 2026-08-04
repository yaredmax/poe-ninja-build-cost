import { buildPriceIndex, fetchLeagues } from './lib/economy.js';
import {
  buildRareQuery,
  fetchPrices,
  FIABLE,
  attemptPlan,
  isBetter,
  reliability,
  runQuery,
  webUrl,
} from './lib/trade.js';
import {
  loadStatIndex,
  significantMods,
  totalElementalResistance,
  totalLife,
} from './lib/stats.js';

/**
 * poe.ninja pide un User-Agent descriptivo que identifique la app y un contacto.
 * `fetch` no deja tocar la cabecera User-Agent, así que la reescribimos con
 * declarativeNetRequest.
 *
 * La condición `tabIds: [-1]` limita la regla a peticiones sin pestaña asociada,
 * o sea sólo las que lanza este service worker. Así no tocamos las peticiones
 * que hace la propia web cuando el usuario navega por poe.ninja.
 * `tabIds` sólo existe en reglas de sesión, no en las estáticas del manifiesto.
 */
// Sólo ASCII: una cabecera HTTP con acentos es inválida y el servidor la
// rechaza (poe.ninja y Cloudflare devuelven 403).
const UA = `PoENinjaChecker/${chrome.runtime.getManifest().version} (personal build pricing extension; +https://github.com/local/poe-ninja-checker)`;
const UA_RULE_IDS = [1, 2];

// GGG pide lo mismo que poe.ninja: un User-Agent que identifique la app.
const UA_TARGETS = [
  'https://poe.ninja/poe1/api/economy/',
  'https://www.pathofexile.com/api/trade/',
];

async function installUserAgentRule() {
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: UA_RULE_IDS,
    addRules: UA_TARGETS.map((urlFilter, i) => ({
      id: UA_RULE_IDS[i],
      priority: 1,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [{ header: 'User-Agent', operation: 'set', value: UA }],
      },
      condition: {
        urlFilter,
        tabIds: [-1], // chrome.tabs.TAB_ID_NONE
      },
    })),
  });
}

chrome.runtime.onInstalled.addListener(installUserAgentRule);
chrome.runtime.onStartup.addListener(installUserAgentRule);

/**
 * El slug de la URL de poe.ninja ("allflame", "allflamehc") no es el id de liga
 * de la API ("Allflame", "Hardcore Allflame"), así que generamos el slug de
 * cada liga y comparamos.
 */
function slugForLeague(id) {
  const hardcore = /^Hardcore (.+)$/.exec(id);
  if (hardcore) return `${hardcore[1].toLowerCase().replace(/\s+/g, '')}hc`;
  return id.toLowerCase().replace(/\s+/g, '');
}

/**
 * Liga a usar. Acepta el slug de la URL o un id ya resuelto; si no reconoce
 * ninguno de los dos, cae en la liga temporal actual.
 */
async function resolveLeague(slug, id) {
  const leagues = await fetchLeagues();
  if (id && leagues.some((l) => l.id === id)) return id;
  if (slug) {
    const match = leagues.find((l) => slugForLeague(l.id) === slug.toLowerCase());
    if (match) return match.id;
  }
  return leagues[0]?.id ?? 'Standard';
}

const handlers = {
  async ping() {
    return { ok: true };
  },

  async leagues() {
    return { leagues: await fetchLeagues() };
  },

  async prices({ leagueSlug }) {
    await installUserAgentRule(); // las reglas de sesión se pierden al dormir el SW
    const resolved = await resolveLeague(leagueSlug);
    const { index, icons, failed, chaosPerDivine } = await buildPriceIndex(resolved);
    return { league: resolved, index, icons, failed, chaosPerDivine };
  },

  /**
   * Tasa un raro buscando ítems parecidos en trade. Una petición de búsqueda y
   * otra de fetch por ítem; el espaciado lo impone `runQuery`.
   */
  async appraise({ item, league, chaosPerDivine }) {
    await installUserAgentRule();
    const resolved = await resolveLeague(null, league);
    const index = await loadStatIndex();

    const helpers = { significantMods, totalElementalResistance, totalLife };
    const MODS_INICIALES = 2;
    let body = buildRareQuery(item, index, helpers, MODS_INICIALES);
    if (!body) return { omitido: 'no reconocimos ningún mod que filtrar' };

    let { id, result, total } = await runQuery(body, resolved);

    // Ajustamos el número de filtros hasta dar con una búsqueda fiable, con un
    // tope de dos intentos extra. Sólo nos quedamos con un intento si mejora:
    // gastar otra petición para empeorar la estimación no tiene sentido.
    let ajustada = false;
    let anchura = body.query.stats[0].filters.length;
    for (const n of attemptPlan(total, MODS_INICIALES)) {
      if (FIABLE.has(reliability(total))) break;
      const otro = buildRareQuery(item, index, helpers, n);
      if (!otro || otro.query.stats[0].filters.length === anchura) continue;
      anchura = otro.query.stats[0].filters.length;
      const intento = await runQuery(otro, resolved);
      if (isBetter(intento.total, total)) {
        ajustada = true;
        body = otro;
        ({ id, result, total } = intento);
      }
    }

    const prices = total ? await fetchPrices(id, result, chaosPerDivine) : [];
    const fiabilidad = reliability(total);

    return {
      url: webUrl(resolved, id),
      total,
      // Mediana de los diez más baratos: el más barato de todos casi siempre es
      // un precio de broma o un ítem mal listado.
      chaos: prices.length ? prices[Math.floor(prices.length / 2)] : null,
      fiabilidad,
      fiable: FIABLE.has(fiabilidad),
      ajustada,
      filtros: body.query.stats[0].filters.map((f) => f.id),
    };
  },

  async clearCache() {
    await chrome.storage.local.clear();
    return { ok: true };
  },
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const handler = handlers[msg?.type];
  if (!handler) {
    sendResponse({ error: `Mensaje desconocido: ${msg?.type}` });
    return false;
  }
  handler(msg)
    .then((data) => sendResponse(data))
    .catch((err) => sendResponse({ error: String(err?.message || err) }));
  return true; // respuesta asíncrona
});
