// One queue shares pacing between autocomplete, card previews and deck validation.
let tail = Promise.resolve();
let nextRequestAt = 0;
const cache = new Map();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function request(path, options = {}) {
  const task = tail.then(async () => {
    await delay(Math.max(0, nextRequestAt - Date.now()));
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetch('https://api.scryfall.com/' + path, {
        ...options, headers: { Accept: 'application/json', ...(options.headers || {}) }, signal: controller.signal
      });
      if (response.status === 429) {
        nextRequestAt = Date.now() + 30000;
        throw Error('Scryfall is rate limiting requests. Wait at least 30 seconds before trying again.');
      }
      if (!response.ok) throw Error(response.status === 404 ? 'Card not recognized by Scryfall.' : 'Scryfall HTTP ' + response.status);
      return await response.json();
    } finally {
      clearTimeout(timeout);
      nextRequestAt = Math.max(nextRequestAt, Date.now() + 600);
    }
  });
  tail = task.catch(() => {});
  return task;
}
export async function autocomplete(query) {
  if (query.trim().length < 2) return [];
  return (await request('cards/autocomplete?q=' + encodeURIComponent(query))).data || [];
}
export async function findCard(name) {
  const key = name.trim().toLowerCase();
  if (!cache.has(key)) cache.set(key, await request('cards/named?exact=' + encodeURIComponent(name.trim())));
  return cache.get(key);
}


export async function findPrinting(name, setCode, collectorNumber) {
  const set = setCode.trim().toLowerCase();
  const number = collectorNumber.trim();

  if (!set || !number) {
    throw Error('Enter both a set code and collector number.');
  }

  const found = await request(
    `cards/${encodeURIComponent(set)}/${encodeURIComponent(number)}`
  );

  const matchesName = [
    found.name,
    ...(found.card_faces || []).map(face => face.name)
  ].some(value => value.toLowerCase() === name.trim().toLowerCase());

  if (!matchesName) {
    throw Error('That printing belongs to a different card.');
  }

  if (found.digital || !found.games?.includes('paper')) {
    throw Error('That printing is not available in paper.');
  }

  return found;
}


const sameName = (card, name) => [card.name, ...(card.card_faces || []).map(face => face.name)]
  .some(value => value.toLowerCase() === name.toLowerCase());

export async function validateCards(rows, progress = () => {}) {
  const output = rows.map(row => ({ ...row, card: { ...row.card } }));
  for (let offset = 0; offset < output.length; offset += 75) {
    const batch = output.slice(offset, offset + 75);
    try {
      const identifiers = batch.map(({ card }) => card.setCode && card.collectorNumber
        ? { set: card.setCode, collector_number: card.collectorNumber }
        : { name: card.name, ...(card.setCode ? { set: card.setCode } : {}) });
      const result = await request('cards/collection', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifiers })
      });
      for (const row of batch) {
        const match = (result.data || []).find(card => sameName(card, row.card.name) &&
          (!row.card.setCode || card.set === row.card.setCode) &&
          (!row.card.collectorNumber || card.collector_number === row.card.collectorNumber));
        row.validation = match ? 'valid' : 'invalid';
        row.error = match ? '' : 'Unrecognized name or printing. Correct it, remove it, or explicitly allow unverified entries.';
        if (match) row.card = { ...row.card, name: match.name, colorIdentity: match.color_identity,
          scryfallId: row.card.setCode ? match.id : null };
      }
    } catch (error) {
      for (const row of output.slice(offset)) { row.validation = 'unverified'; row.error = error.message; }
      progress(output.length, output.length);
      return output;
    }
    progress(Math.min(offset + 75, output.length), output.length);
  }
  return output;
}
