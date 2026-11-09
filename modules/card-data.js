// Shared validation for scratch, pasted lists, JSON, and single-card additions.
export const COLOR_ORDER = ['W', 'U', 'B', 'R', 'G'];

export function normalizeCards(input, { allowEmpty = false } = {}) {
  const entries = Array.isArray(input) ? input : input?.cards;
  if (!Array.isArray(entries) || entries.length > 500 || (!allowEmpty && !entries.length)) {
    throw Error('Provide ' + (allowEmpty ? '0' : '1') + '–500 cards.');
  }
  return entries.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw Error('Invalid card ' + (index + 1));
    const name = String(entry.name || '').trim();
    const deck = String(entry.deck || 'Unassigned').trim() || 'Unassigned';
    const note = String(entry.note || '');
    const qty = Number(entry.qty ?? 1);
    if (!name || name.length > 250 || deck.length > 150 || note.length > 1500) {
      throw Error('Card ' + (index + 1) + ': name, category, or notes are missing or too long.');
    }
    if (!Number.isInteger(qty) || qty < 1 || qty > 999) throw Error('Card ' + (index + 1) + ': quantity must be 1–999.');
    let identity = entry.colorIdentity ?? entry.color_identity ?? null;
    if (typeof identity === 'string' && /^[WUBRG,\s]*$/i.test(identity)) identity = identity.toUpperCase().match(/[WUBRG]/g) || [];
    if (identity !== null && (!Array.isArray(identity) || identity.some(c => !COLOR_ORDER.includes(c)))) {
      throw Error('Card ' + (index + 1) + ': invalid color identity.');
    }
    const setCode = String(entry.setCode ?? entry.set_code ?? '').trim().toLowerCase();
    const collectorNumber = String(entry.collectorNumber ?? entry.collector_number ?? '').trim();
    const scryfallId = entry.scryfallId ?? entry.scryfall_id ?? null;
    if (setCode && !/^[a-z0-9]{2,10}$/.test(setCode)) throw Error('Invalid set code at card ' + (index + 1));
    if (collectorNumber.length > 30 || (collectorNumber && !setCode)) throw Error('Collector number requires a set code (card ' + (index + 1) + ').');
    if (scryfallId && !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(scryfallId)) throw Error('Invalid Scryfall ID.');
    return { name, deck, qty, note, colorIdentity: identity === null ? null : COLOR_ORDER.filter(c => identity.includes(c)), setCode, collectorNumber, scryfallId };
  });
}

export function normalizeListName(value) {
  const name = String(value || '').trim();
  if (!name || name.length > 120) throw Error('List name must be 1–120 characters.');
  return name;
}

export function parseDecklist(text) {
  const rows = [];
  const ignored = [];
  let deck = 'Unassigned';
  const heading = /^(commander|companions?|deck|mainboard|sideboard|maybeboard|considering|cards?|creatures?|lands?|artifacts?|enchantments?|instants?|sorceries|planeswalkers?|battles?)(?:\s*\(\d+\))?:?$/i;
  String(text).split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim();
    if (!line || /^(#|\/\/)/.test(line)) { ignored.push({ line: index + 1, raw }); return; }
    if (heading.test(line)) { deck = line.replace(/\s*\(\d+\)|:$/g, ''); ignored.push({ line: index + 1, raw }); return; }
    let name = line, qty = 1, error = '';
    const quantity = line.match(/^(\d+)\s*x?\s+(.+)$/i);
    if (quantity) { qty = Number(quantity[1]); name = quantity[2]; }
    else if (/^[\d+\-]/.test(line)) error = 'Malformed quantity. Correct this entry or explicitly remove it.';
    let note = '';
    if (/\s+\*F\*$/i.test(name)) { note = 'Foil preferred'; name = name.replace(/\s+\*F\*$/i, ''); }
    const printing = name.match(/^(.+?)\s+\(([a-z0-9]{2,10})\)(?:\s+([^\s]+))?$/i);
    const card = { name: printing ? printing[1].trim() : name.trim(), qty, deck, note,
      setCode: printing ? printing[2].toLowerCase() : '', collectorNumber: printing?.[3] || '', colorIdentity: null };
    try { normalizeCards([card]); } catch (e) { error = e.message; }
    rows.push({ card, error, line: index + 1, raw, validation: 'pending' });
  });
  if (rows.length > 500) throw Error('Decklists can contain at most 500 entries.');
  return { rows, ignored };
}

export function mergeDuplicates(cards) {
  const merged = new Map();
  for (const card of normalizeCards(cards, { allowEmpty: true })) {
    // Different categories, notes, or requested printings remain separate entries.
    const key = JSON.stringify([card.name.toLowerCase(), card.deck.toLowerCase(), card.note, card.setCode, card.collectorNumber]);
    const existing = merged.get(key);
    if (existing) {
      existing.qty += card.qty;
      if (existing.qty > 999) throw Error('Merged quantity exceeds 999 for ' + card.name);
    } else merged.set(key, { ...card });
  }
  return [...merged.values()];
}
