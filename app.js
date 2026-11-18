(() => {
  "use strict";

  const DB_NAME = "riftbound-deck-advisor-local";
  const DB_VERSION = 1;
  const RIFTHUNT_BULK_CARDS = "https://api.rifthunt.com/bulk/cards";
  const RIFTHUNT_REFRESH_KEY = "riftbound-deck-advisor-rifthunt-last-fetch";
  const $ = (selector) => document.querySelector(selector);
  const ui = {
    cardCount: $("#card-count"), deckCount: $("#deck-count"), collectionCount: $("#collection-count"),
    legend: $("#legend-select"), deck: $("#deck-select"), popularity: $("#popularity-body"),
    popularityTitle: $("#popularity-title"), popularityIntro: $("#popularity-intro"), sample: $("#sample-size"),
    gapCount: $("#gap-count"), deckIntro: $("#deck-intro"), deckResults: $("#deck-results"),
    dialog: $("#import-dialog"), status: $("#import-status"), importButton: $("#import-submit")
  };
  let db;
  let state = { cards: [], decks: [], collection: [] };
  let lookup = { byId: new Map(), byName: new Map() };

  function openDb() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        for (const store of ["cards", "decks", "collection"]) {
          if (!database.objectStoreNames.contains(store)) database.createObjectStore(store, { keyPath: "key" });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("No se pudo abrir el almacenamiento local."));
    });
  }

  function readStore(name) {
    return new Promise((resolve, reject) => {
      const request = db.transaction(name, "readonly").objectStore(name).getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
  }

  function replaceStore(name, rows) {
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(name, "readwrite");
      const store = transaction.objectStore(name);
      store.clear();
      for (const row of rows) store.put(row);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error || new Error("La importación se canceló."));
    });
  }

  function firstValue(object, names, fallback = "") {
    for (const name of names) {
      const value = object && object[name];
      if (value !== undefined && value !== null && value !== "") return value;
    }
    return fallback;
  }

  function asArray(value) {
    if (Array.isArray(value)) return value;
    if (typeof value === "string") return value.split(/[|;,]/).map((item) => item.trim()).filter(Boolean);
    if (value && typeof value === "object") return Object.values(value);
    return [];
  }

  function norm(value) {
    return String(value ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
  }

  function identityFor(card) {
    return String(firstValue(card, ["oracle_id", "oracleId", "oracleID", "identity", "oracleKey"], norm(firstValue(card, ["name", "cleanName", "card_name"], ""))));
  }

  function normalizeCard(raw, index) {
    const id = String(firstValue(raw, ["printing_id", "printingId", "id", "card_id", "cardId", "riftbound_id", "riftboundId"], `card-${index + 1}`));
    const name = String(firstValue(raw, ["oracle_name", "oracleName", "cleanName", "name", "card_name", "cardName"], id));
    const aliases = [id, raw.riftbound_id, raw.riftboundId, raw.publicCode, raw.public_code, raw.code, raw.oracle_name, raw.oracleName, raw.name, raw.cleanName].filter((value) => value !== undefined && value !== null && String(value).trim()).map(String);
    const card = {
      key: id,
      id,
      aliases: [...new Set(aliases)],
      identity: identityFor({ ...raw, name }),
      name,
      type: String(firstValue(raw, ["type", "card_type", "cardType"], "")),
      domains: asArray(firstValue(raw, ["domains", "domain", "domain_ids", "domainIds"], [])).map((item) => String(item).trim()),
      energy: numericOrNull(firstValue(raw, ["energy", "energy_cost", "energyCost"], null)),
      power: numericOrNull(firstValue(raw, ["power", "rune_cost", "runeCost"], null)),
      might: numericOrNull(firstValue(raw, ["might", "combat_stat", "combatStat"], null)),
      keywords: asArray(firstValue(raw, ["keywords", "keyword"], [])).map(String),
      tags: asArray(firstValue(raw, ["tags", "tag"], [])).map(String),
      text: String(firstValue(raw, ["rules_text", "rulesText", "text", "ability_text", "abilityText", "effect"], "")),
      legalities: firstValue(raw, ["legalities", "legality"], null)
    };
    return card;
  }

  function numericOrNull(value) {
    if (value === null || value === undefined || value === "") return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function unwrapJson(value, keys) {
    if (Array.isArray(value)) return value;
    for (const key of keys) if (Array.isArray(value?.[key])) return value[key];
    if (Array.isArray(value?.data)) return value.data;
    throw new Error(`No encuentro una lista de datos. Se esperaba un array o una propiedad ${keys.join(" / ")}.`);
  }

  function buildLookup(cards) {
    const byId = new Map();
    const byName = new Map();
    for (const card of cards) {
      for (const alias of [...(card.aliases || []), card.id, card.key]) byId.set(norm(alias), card);
      byName.set(norm(card.name), card);
      byName.set(norm(card.name.replace(/\s*\([^)]*\)\s*$/, "")), card);
      for (const alias of card.aliases || []) if (!/^[a-z]{3}-\d{3}-\d{3}$/i.test(alias)) byName.set(norm(alias), card);
    }
    return { byId, byName };
  }

  function resolveCard(value) {
    if (value && typeof value === "object") {
      const ref = firstValue(value, ["card_id", "cardId", "printing_id", "printingId", "oracle_id", "oracleId", "riftbound_id", "riftboundId", "variant_number", "variantNumber", "publicCode", "public_code", "id", "name", "card", "card_name", "cardName"], "");
      return resolveCard(ref);
    }
    const text = String(value ?? "");
    return lookup.byId.get(norm(text)) || lookup.byName.get(norm(text)) || null;
  }

  function parseDeck(raw, index) {
    const sourceCards = firstValue(raw, ["cards", "main_deck", "mainDeck", "main", "deck"], []);
    const rows = [];
    const entries = Array.isArray(sourceCards) ? sourceCards : (sourceCards && typeof sourceCards === "object" ? Object.entries(sourceCards).map(([card_id, quantity]) => ({ card_id, quantity })) : []);
    for (const entry of entries) {
      const card = resolveCard(entry);
      const quantity = Math.max(1, Number(firstValue(entry, ["quantity", "count", "copies", "qty"], 1)) || 1);
      const fallbackId = typeof entry === "string" ? entry : String(firstValue(entry, ["card_id", "cardId", "printing_id", "id", "name", "card_name"], ""));
      rows.push({ identity: card?.identity || norm(fallbackId), cardKey: card?.key || "", name: card?.name || fallbackId || "Carta sin identificar", quantity });
    }
    const id = String(firstValue(raw, ["id", "deck_id", "deckId", "code", "url"], `deck-${index + 1}`));
    const legend = String(firstValue(raw, ["legend", "legend_name", "legendName", "champion_legend", "championLegend"], "Sin leyenda"));
    return {
      key: `${id}-${index}`,
      id,
      name: String(firstValue(raw, ["name", "deck_name", "deckName", "title"], `${legend} · Lista ${index + 1}`)),
      legend,
      champion: String(firstValue(raw, ["champion", "chosen_champion", "chosenChampion"], "")),
      date: String(firstValue(raw, ["date", "event_date", "eventDate", "created_at", "createdAt"], "")),
      event: String(firstValue(raw, ["event", "tournament", "event_name", "eventName"], "")),
      placement: numericOrNull(firstValue(raw, ["placement", "rank", "place", "result"], null)),
      source: String(firstValue(raw, ["source", "source_name", "sourceName"], "")),
      url: String(firstValue(raw, ["url", "source_url", "sourceUrl"], "")),
      cards: rows
    };
  }

  function parseCsv(text) {
    const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter((line) => line.trim());
    if (lines.length < 2) throw new Error("El CSV de colección no contiene filas de datos.");
    const parseLine = (line, delimiter) => {
      const values = [];
      let value = "";
      let quoted = false;
      for (let i = 0; i < line.length; i++) {
        const char = line[i];
        if (char === '"' && line[i + 1] === '"' && quoted) { value += '"'; i++; }
        else if (char === '"') quoted = !quoted;
        else if (char === delimiter && !quoted) { values.push(value.trim()); value = ""; }
        else value += char;
      }
      values.push(value.trim());
      return values;
    };
    const firstLine = lines[0];
    const delimiters = [",", ";", "\t"];
    let quoted = false;
    const counts = new Map(delimiters.map((delimiter) => [delimiter, 0]));
    for (let i = 0; i < firstLine.length; i++) {
      const char = firstLine[i];
      if (char === '"' && firstLine[i + 1] === '"' && quoted) i++;
      else if (char === '"') quoted = !quoted;
      else if (!quoted && counts.has(char)) counts.set(char, counts.get(char) + 1);
    }
    const delimiter = delimiters.sort((a, b) => counts.get(b) - counts.get(a))[0];
    const headers = parseLine(firstLine, delimiter).map((header) => norm(header).replace(/\s+/g, "_"));
    return lines.slice(1).map((line) => {
      const values = parseLine(line, delimiter);
      return Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""]));
    });
  }

  function getCollectionIdentity(row) {
    const code = firstValue(row, ["oracle_id", "oracleid", "oracle_key", "card_id", "cardid", "printing_id", "printingid", "riftbound_id", "riftboundid", "variant_number", "variantnumber", "card_number", "cardnumber", "card_code", "code", "id"], "");
    const cardByCode = code ? resolveCard(code) : null;
    if (cardByCode) return cardByCode.identity;
    const name = firstValue(row, ["card", "name", "card_name", "cardname"], "");
    const cardByName = name ? resolveCard(name) : null;
    return cardByName?.identity || norm(code || name);
  }

  function normalizeCollection(rows) {
    const counts = new Map();
    for (const row of rows) {
      const identity = getCollectionIdentity(row);
      if (!identity) continue;
      const quantity = Math.max(0, Number(firstValue(row, ["quantity", "count", "copies", "qty", "owned"], 0)) || 0);
      const existing = counts.get(identity) || { key: identity, identity, name: String(firstValue(row, ["name", "card_name", "cardname"], resolveCard(identity)?.name || identity)), quantity: 0 };
      existing.quantity += quantity;
      counts.set(identity, existing);
    }
    return [...counts.values()];
  }

  function collectionMap() {
    return new Map(state.collection.map((row) => [row.identity, row.quantity]));
  }

  function deckMap(deck) {
    const result = new Map();
    for (const row of deck?.cards || []) result.set(row.identity, (result.get(row.identity) || 0) + row.quantity);
    return result;
  }

  function cardForIdentity(identity) {
    for (const card of state.cards) if (card.identity === identity) return card;
    return null;
  }

  function cardName(identity) {
    return cardForIdentity(identity)?.name || state.decks.flatMap((deck) => deck.cards).find((row) => row.identity === identity)?.name || identity;
  }

  function displayCost(card) {
    if (!card) return "—";
    const parts = [];
    if (card.energy !== null) parts.push(`${card.energy}E`);
    if (card.power !== null) parts.push(`${card.power}P`);
    return parts.join(" · ") || "—";
  }

  function roles(card) {
    const text = norm([card?.text, ...(card?.keywords || []), ...(card?.tags || [])].join(" "));
    const definitions = [
      ["robo de cartas", /draw|roba|robar|rob[a-z]* cartas|card advantage|buscar en tu mazo|search your deck/],
      ["interacción", /kill|destroy|slay|remov|elimina|destruye|matar|devuelve.*mano|return.*hand|exhaust|agot[a-z]*|stun|atont/],
      ["combate", /might|power|ready|prepara|ataque|attack|combate|combat|buff|aumenta.*poder|increase.*power/],
      ["movilidad", /move|mueve|mover|movement|reposition|reubica/],
      ["fichas", /token|ficha|summon|invoca|create.*unit|crea.*unidad/],
      ["recursos", /rune|runa|energy|energia|recycle|recicla|resource|recurso/],
      ["protección", /shield|ward|protect|proteg|prevent|previene|heal|cura/]
    ];
    return definitions.filter(([, pattern]) => pattern.test(text)).map(([role]) => role);
  }

  function featureSet(card) {
    const parts = [...(card?.keywords || []), ...(card?.tags || []), ...roles(card)];
    return new Set(parts.map(norm).filter(Boolean));
  }

  function overlap(a, b) {
    if (!a.size && !b.size) return 0.5;
    const intersection = [...a].filter((value) => b.has(value)).length;
    const union = new Set([...a, ...b]).size;
    return union ? intersection / union : 0;
  }

  function costMatch(source, candidate) {
    const scores = [];
    for (const key of ["energy", "power"]) {
      if (source[key] !== null && candidate[key] !== null) scores.push(Math.max(0, 1 - Math.abs(source[key] - candidate[key]) / 4));
    }
    return scores.length ? scores.reduce((sum, score) => sum + score, 0) / scores.length : 0.5;
  }

  function domainMatch(source, candidate, deckDomainSet) {
    const candidateDomains = new Set(candidate.domains.map(norm).filter((domain) => domain && domain !== "colorless"));
    const allowed = deckDomainSet.size ? deckDomainSet : new Set(source.domains.map(norm).filter((domain) => domain && domain !== "colorless"));
    if (!candidateDomains.size) return 0.65;
    if (!allowed.size) return 0.5;
    const illegal = [...candidateDomains].some((domain) => !allowed.has(domain));
    const shared = [...candidateDomains].filter((domain) => allowed.has(domain)).length;
    return illegal ? Math.max(0, 0.2 * shared / candidateDomains.size) : 0.75 + 0.25 * shared / candidateDomains.size;
  }

  function getDeckDomains(deck) {
    const domains = new Set();
    for (const row of deck.cards) {
      const card = state.cards.find((candidate) => candidate.identity === row.identity);
      for (const domain of card?.domains || []) {
        const cleaned = norm(domain);
        if (cleaned && cleaned !== "colorless") domains.add(cleaned);
      }
    }
    return domains;
  }

  function scoreCandidate(source, candidate, deck, ownedQuantity, baseCounts) {
    const deckFeatures = new Set();
    for (const row of deck.cards) {
      const card = cardForIdentity(row.identity);
      for (const feature of featureSet(card)) deckFeatures.add(feature);
    }
    const sourceFeatures = featureSet(source);
    const candidateFeatures = featureSet(candidate);
    const roleScore = roles(source).length || roles(candidate).length ? overlap(sourceFeatures, candidateFeatures) : 0.45;
    const costScore = costMatch(source, candidate);
    const domainScore = domainMatch(source, candidate, getDeckDomains(deck));
    const synergyScore = overlap(deckFeatures, candidateFeatures);
    const score = 0.32 * roleScore + 0.24 * costScore + 0.24 * domainScore + 0.20 * synergyScore;
    const reasons = [];
    const matchedRoles = roles(source).filter((role) => roles(candidate).includes(role));
    if (matchedRoles.length) reasons.push(`Función coincidente: ${matchedRoles.slice(0, 2).join(", ")}`);
    if (source.energy !== null && candidate.energy !== null && Math.abs(source.energy - candidate.energy) <= 1) reasons.push(`Energía cercana (${source.energy}E → ${candidate.energy}E)`);
    if (source.power !== null && candidate.power !== null && Math.abs(source.power - candidate.power) <= 1) reasons.push(`Coste de runas cercano (${source.power}P → ${candidate.power}P)`);
    const sharedDomains = candidate.domains.filter((domain) => getDeckDomains(deck).has(norm(domain)));
    if (sharedDomains.length) reasons.push(`Dominio compatible: ${sharedDomains.join(", ")}`);
    const sharedFeatures = [...candidateFeatures].filter((feature) => deckFeatures.has(feature) && !roles(candidate).includes(feature));
    if (sharedFeatures.length) reasons.push(`Comparte etiqueta/keyword: ${sharedFeatures.slice(0, 2).join(", ")}`);
    if (!reasons.length) reasons.push("Coincidencia estructural de tipo y dominios; conviene revisar el efecto");
    const baseQuantity = baseCounts.get(candidate.identity) || 0;
    const available = Math.max(0, ownedQuantity - baseQuantity);
    return { card: candidate, score, reasons, available };
  }

  function sortedDecks(decks) {
    return [...decks].sort((a, b) => {
      if (a.placement !== null && b.placement !== null && a.placement !== b.placement) return a.placement - b.placement;
      if (a.date && b.date && a.date !== b.date) return b.date.localeCompare(a.date);
      if (a.date) return -1;
      if (b.date) return 1;
      return a.name.localeCompare(b.name);
    });
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
  }

  function refreshLookup() { lookup = buildLookup(state.cards); }

  function updateCounts() {
    ui.cardCount.textContent = state.cards.length.toLocaleString("es-ES");
    ui.deckCount.textContent = state.decks.length.toLocaleString("es-ES");
    ui.collectionCount.textContent = state.collection.reduce((sum, row) => sum + row.quantity, 0).toLocaleString("es-ES");
  }

  function renderLegendSelect() {
    const legends = [...new Set(state.decks.map((deck) => deck.legend).filter((legend) => legend && legend !== "Sin leyenda"))].sort((a, b) => a.localeCompare(b));
    const previous = ui.legend.value;
    ui.legend.innerHTML = legends.length ? `<option value="">Selecciona una leyenda</option>${legends.map((legend) => `<option value="${escapeHtml(legend)}">${escapeHtml(legend)}</option>`).join("")}` : `<option value="">Carga listas para empezar</option>`;
    ui.legend.disabled = !legends.length;
    if (legends.includes(previous)) ui.legend.value = previous;
  }

  function renderDeckSelect() {
    const legend = ui.legend.value;
    const decks = sortedDecks(state.decks.filter((deck) => deck.legend === legend));
    const previous = ui.deck.value;
    ui.deck.innerHTML = decks.length ? `<option value="">Selecciona una lista</option>${decks.map((deck) => {
      const label = [deck.placement ? `#${deck.placement}` : "", deck.name, deck.event, deck.date].filter(Boolean).join(" · ");
      return `<option value="${escapeHtml(deck.key)}">${escapeHtml(label)}</option>`;
    }).join("")}` : `<option value="">No hay listas para esta leyenda</option>`;
    ui.deck.disabled = !decks.length;
    if (decks.some((deck) => deck.key === previous)) ui.deck.value = previous;
    else if (decks.length) ui.deck.value = decks[0].key;
    renderPopularity(legend);
    renderSelectedDeck();
  }

  function renderPopularity(legend) {
    const decks = state.decks.filter((deck) => deck.legend === legend);
    ui.popularityTitle.textContent = legend ? `Cartas más usadas · ${legend}` : "Cartas más usadas por leyenda";
    ui.sample.textContent = decks.length ? `${decks.length} ${decks.length === 1 ? "lista" : "listas"}` : "Sin muestra";
    ui.popularityIntro.textContent = decks.length
      ? `Frecuencia dentro de ${decks.length} listas importadas para ${legend}. El dato depende de la muestra y sus fechas.`
      : "Importa listas para ver qué cartas aparecen con más frecuencia. La frecuencia describe tu muestra importada; no es una predicción de rendimiento.";
    if (!decks.length) {
      ui.popularity.innerHTML = `<tr class="empty-row"><td colspan="4">Aún no hay listas para esta leyenda.</td></tr>`;
      return;
    }
    const stats = new Map();
    for (const deck of decks) {
      const seen = new Set();
      for (const row of deck.cards) {
        const stat = stats.get(row.identity) || { identity: row.identity, appearances: 0, copies: 0 };
        stat.copies += row.quantity;
        if (!seen.has(row.identity)) { stat.appearances++; seen.add(row.identity); }
        stats.set(row.identity, stat);
      }
    }
    const rows = [...stats.values()].sort((a, b) => b.appearances - a.appearances || (b.copies / decks.length) - (a.copies / decks.length) || cardName(a.identity).localeCompare(cardName(b.identity))).slice(0, 12);
    const owned = collectionMap();
    ui.popularity.innerHTML = rows.map((row) => {
      const percentage = Math.round((row.appearances / decks.length) * 100);
      const avg = (row.copies / decks.length).toFixed(1).replace(".", ",");
      return `<tr><td><b>${escapeHtml(cardName(row.identity))}</b><small>${escapeHtml(displayCost(cardForIdentity(row.identity)))}</small></td><td><div class="frequency"><span><i style="width:${percentage}%"></i></span><b>${percentage}%</b></div></td><td>${avg}</td><td>${owned.get(row.identity) || 0}</td></tr>`;
    }).join("");
  }

  function renderSelectedDeck() {
    const deck = state.decks.find((item) => item.key === ui.deck.value);
    if (!deck) {
      ui.gapCount.textContent = "Sin lista";
      ui.deckIntro.textContent = "Selecciona una lista base. Para sugerir una alternativa, la app busca cartas disponibles en tu colección y compara tipo, función, coste, dominio y sinergias detectables.";
      ui.deckResults.innerHTML = `<div class="empty-state"><div class="empty-icon">↗</div><b>Elige una lista de referencia</b><span>La app marcará las cartas que no tienes y sugerirá alternativas disponibles en tu colección.</span></div>`;
      return;
    }
    const owned = collectionMap();
    const baseCounts = deckMap(deck);
    const gaps = deck.cards.map((row) => ({ ...row, card: cardForIdentity(row.identity), missing: Math.max(0, row.quantity - (owned.get(row.identity) || 0)) })).filter((row) => row.missing > 0);
    const totalMissing = gaps.reduce((sum, row) => sum + row.missing, 0);
    ui.gapCount.textContent = totalMissing ? `${totalMissing} ${totalMissing === 1 ? "copia pendiente" : "copias pendientes"}` : "Completable con tu colección";
    ui.gapCount.classList.toggle("sample-success", totalMissing === 0);
    ui.deckIntro.textContent = `${deck.name}${deck.event ? ` · ${deck.event}` : ""}${deck.date ? ` · ${deck.date}` : ""}. Se comparan las cartas que te faltan con el resto de tu colección.`;
    if (!gaps.length) {
      ui.deckResults.innerHTML = `<div class="success-state"><div class="success-icon">✓</div><div><b>Tienes las copias necesarias de esta lista.</b><span>Este cálculo solo compara cantidades; revisa la lista completa y la legalidad del formato antes de jugar.</span></div></div>`;
      return;
    }
    const cardsByIdentity = new Map();
    for (const card of state.cards) if (!cardsByIdentity.has(card.identity)) cardsByIdentity.set(card.identity, card);
    const gapHtml = gaps.map((gap) => {
      const source = gap.card || { identity: gap.identity, name: gap.name, type: "", domains: [], energy: null, power: null, keywords: [], tags: [], text: "" };
      const candidates = [...cardsByIdentity.values()]
        .filter((candidate) => candidate.identity !== gap.identity && (!source.type || norm(candidate.type) === norm(source.type)))
        .map((candidate) => scoreCandidate(source, candidate, deck, owned.get(candidate.identity) || 0, baseCounts))
        .filter((candidate) => candidate.available > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 3);
      const sourceType = source.type || "tipo no identificado";
      const alternatives = candidates.length ? candidates.map((candidate) => {
        const canCover = Math.min(gap.missing, candidate.available);
        const score = Math.round(candidate.score * 100);
        return `<div class="candidate"><div class="candidate-main"><div><b>${escapeHtml(candidate.card.name)}</b><span>${escapeHtml(candidate.card.type || sourceType)} · ${escapeHtml(displayCost(candidate.card))} · ${canCover}/${gap.missing} copias faltantes</span></div><strong>${score}<small>%</small></strong></div><div class="candidate-reasons">${candidate.reasons.map((reason) => `<span>${escapeHtml(reason)}</span>`).join("")}</div></div>`;
      }).join("") : `<div class="no-candidate">No encuentro otra carta ${escapeHtml(sourceType)} disponible en tu colección. Puedes ampliar la colección o ajustar los filtros de importación.</div>`;
      return `<article class="gap-card"><div class="gap-head"><div><div class="gap-name">${escapeHtml(source.name)}</div><div class="gap-meta">${escapeHtml(source.type || "Tipo desconocido")} · ${escapeHtml(displayCost(source))} · ${escapeHtml(source.domains.join(" / ") || "dominio no indicado")}</div></div><span class="missing-pill">Te faltan ${gap.missing}</span></div><div class="candidate-list">${alternatives}</div></article>`;
    }).join("");
    ui.deckResults.innerHTML = gapHtml;
  }

  async function refresh() {
    state.cards = await readStore("cards");
    state.decks = await readStore("decks");
    state.collection = await readStore("collection");
    refreshLookup();
    updateCounts();
    renderLegendSelect();
    if (ui.legend.value) renderDeckSelect();
    else {
      ui.deck.innerHTML = `<option value="">Elige una leyenda</option>`;
      ui.deck.disabled = true;
      renderPopularity("");
      renderSelectedDeck();
    }
  }

  async function readJsonFile(input) {
    const text = await input.text();
    return JSON.parse(text);
  }

  function setFileLabel(input, labelId) {
    input.addEventListener("change", () => {
      $(labelId).textContent = input.files?.[0]?.name || "Seleccionar archivo";
    });
  }

  function localDateTime(value) {
    const date = value ? new Date(value) : new Date();
    return Number.isNaN(date.getTime()) ? "fecha no indicada" : date.toLocaleString("es-ES", { dateStyle: "medium", timeStyle: "short" });
  }

  async function fetchCardsOnline() {
    const button = $("#fetch-cards-online");
    if (!button) return;
    const previousLabel = button.textContent;
    button.disabled = true;
    button.textContent = "Consultando…";
    ui.status.textContent = "Descargando el catálogo público de RiftHunt…";
    ui.status.classList.remove("error-text");
    try {
      const previousFetch = Number(localStorage.getItem(RIFTHUNT_REFRESH_KEY) || 0);
      const elapsed = Date.now() - previousFetch;
      if (previousFetch && elapsed < 24 * 60 * 60 * 1000) {
        ui.status.textContent = `Ya se descargó hace menos de 24 horas (${localDateTime(previousFetch)}). Se respeta la frecuencia recomendada por RiftHunt.`;
        return;
      }
      const response = await fetch(RIFTHUNT_BULK_CARDS, { method: "GET", headers: { Accept: "application/json" } });
      if (!response.ok) throw new Error(`RiftHunt respondió ${response.status}.`);
      const payload = await response.json();
      const rawCards = unwrapJson(payload, ["cards", "data"]);
      if (!rawCards.length) throw new Error("La respuesta no contiene cartas.");
      const cards = rawCards.map(normalizeCard);
      await replaceStore("cards", cards);
      localStorage.setItem(RIFTHUNT_REFRESH_KEY, String(Date.now()));
      await refresh();
      const fetchedAt = payload.fetched ? ` · datos de ${localDateTime(payload.fetched)}` : "";
      ui.status.textContent = `Catálogo actualizado desde RiftHunt: ${cards.length.toLocaleString("es-ES")} impresiones${fetchedAt}.`;
    } catch (error) {
      ui.status.textContent = `No se pudo descargar el catálogo. Comprueba la conexión y vuelve a intentarlo. ${error.message || ""}`.trim();
      ui.status.classList.add("error-text");
    } finally {
      button.disabled = false;
      button.textContent = previousLabel;
    }
  }

  async function fetchTopDeckOnline() {
    const button = $("#fetch-topdeck-decks");
    if (!button) return;
    if (!state.cards.length) {
      ui.status.textContent = "Actualiza primero el catálogo de RiftHunt para poder asociar los nombres de las listas a sus cartas.";
      ui.status.classList.add("error-text");
      return;
    }
    const previousLabel = button.textContent;
    button.disabled = true;
    button.textContent = "Buscando…";
    ui.status.textContent = "Consultando las listas públicas de TopDeck.gg…";
    ui.status.classList.remove("error-text");
    try {
      const response = await fetch("/api/topdeck/decks", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          format: $("#topdeck-format").value,
          days: Number($("#topdeck-days").value),
          minimumPlayers: Number($("#topdeck-minimum").value)
        })
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || `El servidor respondió ${response.status}.`);
      const imported = (payload.decks || []).map((deck, index) => parseDeck(deck, index));
      if (!imported.length) {
        ui.status.textContent = "TopDeck no encontró listas públicas con esos filtros. Prueba otro periodo o formato.";
        return;
      }
      const decksById = new Map(state.decks.map((deck) => [deck.id, deck]));
      for (const deck of imported) decksById.set(deck.id, deck);
      await replaceStore("decks", [...decksById.values()]);
      await refresh();
      ui.status.textContent = `Añadidas o actualizadas ${imported.length} listas públicas de TopDeck.gg. Total guardado: ${state.decks.length}.`;
    } catch (error) {
      ui.status.textContent = error.message || "No se pudieron importar las listas de TopDeck.gg.";
      ui.status.classList.add("error-text");
    } finally {
      button.disabled = false;
      button.textContent = previousLabel;
    }
  }

  async function importSelected() {
    ui.importButton.disabled = true;
    ui.status.textContent = "Importando…";
    ui.status.classList.remove("error-text");
    try {
      const cardsInput = $("#cards-file");
      const decksInput = $("#decks-file");
      const collectionInput = $("#collection-file");
      let cardsChanged = false;
      let backupImported = false;
      if (cardsInput.files?.[0]) {
        const cardFile = await readJsonFile(cardsInput.files[0]);
        const isBackup = Array.isArray(cardFile?.cards) && Array.isArray(cardFile?.decks) && Array.isArray(cardFile?.collection) && Boolean(cardFile?.exported_at);
        const raw = unwrapJson(cardFile, ["cards", "data"]);
        const cards = raw.map(normalizeCard);
        await replaceStore("cards", cards);
        cardsChanged = true;
        if (isBackup && !decksInput.files?.[0] && !collectionInput.files?.[0]) {
          refreshLookup();
          await replaceStore("decks", cardFile.decks.map(parseDeck));
          await replaceStore("collection", cardFile.collection.map((row) => ({ key: row.key || row.identity, identity: row.identity || row.key, name: row.name || row.identity || row.key, quantity: Number(row.quantity) || 0 })));
          backupImported = true;
        }
      }
      state.cards = await readStore("cards");
      refreshLookup();
      if (decksInput.files?.[0]) {
        if (!state.cards.length) throw new Error("Importa antes un catálogo de cartas para identificar los códigos de las listas.");
        const raw = unwrapJson(await readJsonFile(decksInput.files[0]), ["decks", "lists", "data"]);
        const decks = raw.map(parseDeck);
        await replaceStore("decks", decks);
      }
      if (collectionInput.files?.[0]) {
        if (!state.cards.length) throw new Error("Importa antes un catálogo de cartas para asociar la colección a sus cartas.");
        const rows = parseCsv(await collectionInput.files[0].text());
        await replaceStore("collection", normalizeCollection(rows));
      }
      await refresh();
      const changed = backupImported ? ["copia de seguridad completa"] : [cardsChanged ? "catálogo" : "", decksInput.files?.[0] ? "listas" : "", collectionInput.files?.[0] ? "colección" : ""].filter(Boolean);
      ui.status.textContent = changed.length ? `Importado: ${changed.join(", ")}.` : "No has seleccionado archivos.";
      cardsInput.value = ""; decksInput.value = ""; collectionInput.value = "";
      $("#cards-file-name").textContent = "Seleccionar JSON";
      $("#decks-file-name").textContent = "Seleccionar JSON";
      $("#collection-file-name").textContent = "Seleccionar CSV";
    } catch (error) {
      ui.status.textContent = error.message || "No se pudo importar el archivo.";
      ui.status.classList.add("error-text");
    } finally {
      ui.importButton.disabled = false;
    }
  }

  function download(name, content, type) {
    const url = URL.createObjectURL(new Blob([content], { type }));
    const anchor = document.createElement("a");
    anchor.href = url; anchor.download = name; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function exportData() {
    const snapshot = { exported_at: new Date().toISOString(), cards: state.cards, decks: state.decks, collection: state.collection };
    download("riftbound-deck-advisor-backup.json", JSON.stringify(snapshot, null, 2), "application/json");
  }

  async function clearData() {
    if (!window.confirm("¿Borrar del navegador el catálogo, las listas y tu colección? Esta acción no se puede deshacer.")) return;
    await Promise.all([replaceStore("cards", []), replaceStore("decks", []), replaceStore("collection", [])]);
    await refresh();
  }

  function openDialog() {
    if (typeof ui.dialog.showModal === "function") ui.dialog.showModal();
    else ui.dialog.setAttribute("open", "");
  }

  function wireUi() {
    for (const selector of ["#open-import", "#open-import-side", "#open-import-empty"]) $(selector).addEventListener("click", openDialog);
    $("#show-format").addEventListener("click", () => { openDialog(); $("#format-details").open = true; });
    ui.legend.addEventListener("change", renderDeckSelect);
    ui.deck.addEventListener("change", renderSelectedDeck);
    ui.importButton.addEventListener("click", importSelected);
    $("#fetch-cards-online").addEventListener("click", fetchCardsOnline);
    $("#fetch-topdeck-decks").addEventListener("click", fetchTopDeckOnline);
    $("#export-data").addEventListener("click", exportData);
    $("#clear-data").addEventListener("click", clearData);
    setFileLabel($("#cards-file"), "#cards-file-name");
    setFileLabel($("#decks-file"), "#decks-file-name");
    setFileLabel($("#collection-file"), "#collection-file-name");
    ui.dialog.addEventListener("click", (event) => { if (event.target === ui.dialog) ui.dialog.close(); });
  }

  async function init() {
    wireUi();
    try {
      db = await openDb();
      await refresh();
    } catch (error) {
      ui.status.textContent = error.message;
      ui.status.classList.add("error-text");
      openDialog();
    }
  }

  init();
})();
