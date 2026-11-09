import { normalizeCards, normalizeListName, parseDecklist, mergeDuplicates } from './card-data.js';
import { autocomplete, findCard, validateCards } from './scryfall.js';

const $ = id => document.getElementById(id);
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function setupListTools(api) {
  let draft = [];
  let creating = false;
  let adding = false;
  let addTarget = null;
  let previewedCard = null;
  let lookupVersion = 0;
  let autocompleteTimer;

  function lock(dialog, busy) {
    dialog.querySelectorAll('button,input,textarea,select').forEach(control => { control.disabled = busy; });
    dialog.setAttribute('aria-busy', String(busy));
  }
  function creationMode() { return $('creationMethod').value; }
  function showMethod() {
    ['scratch', 'paste', 'json'].forEach(method => { $('method-' + method).hidden = creationMode() !== method; });
    draft = [];
    $('creationPreview').replaceChildren();
    $('creationMessage').textContent = '';
    $('allowUnverified').checked = false;
    $('reviewOptions').hidden = creationMode() === 'scratch';
  }
  function openCreation(raw, suggestedName) {
    if (!api.canWrite()) return;
    $('creationForm').reset();
    $('creationMethod').value = raw ? 'json' : 'scratch';
    showMethod();
    $('newListName').value = suggestedName || '';
    $('createDialog').showModal();
    if (raw) importPreview(raw, suggestedName);
    $('newListName').focus();
  }
  function importPreview(raw, suggestedName) {
    draft = [];
    $('creationPreview').replaceChildren();
    try {
      const cards = normalizeCards(raw, { allowEmpty: true });
      draft = cards.map(card => ({ card, validation: 'pending', error: '', raw: card.name }));
      $('newListName').value = raw?.name || raw?.title || suggestedName || 'Imported cards';
      renderPreview();
      $('creationMessage').textContent = cards.length + ' entries imported. Review and validate before creating the list.';
    } catch (error) { $('creationMessage').textContent = error.message; }
  }
  function renderPreview() {
    $('creationPreview').innerHTML = draft.map((row, index) => {
      const fields = [['name','Card name'], ['qty','Quantity'], ['deck','Category'], ['note','Notes'], ['setCode','Set'], ['collectorNumber','Collector number']];
      return '<fieldset class="draft-card" data-index="' + index + '"><legend>Entry ' + (index + 1) +
        (row.line ? ' · source line ' + row.line : '') + '</legend>' +
        fields.map(([field, label]) => '<label>' + label + '<input data-field="' + field + '" type="' +
          (field === 'qty' ? 'number" min="1" max="999' : 'text') + '" value="' + escape(row.card[field] ?? '') + '"></label>').join('') +
        '<p class="validation-note">' + escape(row.error || (row.validation === 'valid' ? 'Recognized by Scryfall' : 'Not yet validated')) + '</p>' +
        '<button type="button" class="secondary" data-remove="' + index + '">Remove entry</button></fieldset>';
    }).join('');
  }
  $('createList').onclick = () => openCreation();
  $('creationMethod').onchange = showMethod;
  $('createFromJson').onclick = () => $('newListFile').click();
  $('newListFile').onchange = async event => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      if (file.size > 1024 * 1024) throw Error('JSON files must be smaller than 1 MB.');
      importPreview(JSON.parse(await file.text()), file.name.replace(/\.json$/i, ''));
    } catch (error) { $('creationMessage').textContent = error.message; }
    event.target.value = '';
  };
  $('parseDecklist').onclick = () => {
    try {
      const parsed = parseDecklist($('decklistText').value);
      draft = parsed.rows;
      renderPreview();
      $('creationMessage').textContent = draft.length + ' entries; ' + parsed.ignored.length + ' blank, comment, or heading lines skipped. Every other line is shown below.';
    } catch (error) { $('creationMessage').textContent = error.message; }
  };
  $('decklistText').oninput = () => {
    draft = [];
    $('creationPreview').replaceChildren();
    $('creationMessage').textContent = 'Text changed. Preview the decklist again.';
  };
  $('creationPreview').oninput = event => {
    const field = event.target.dataset.field;
    const row = draft[Number(event.target.closest('[data-index]')?.dataset.index)];
    if (!row || !field) return;
    row.card[field] = field === 'qty' ? Number(event.target.value) : event.target.value;
    row.validation = 'pending';
    row.error = '';
    if (['name', 'setCode', 'collectorNumber'].includes(field)) {
      row.card.colorIdentity = null;
      row.card.scryfallId = null;
    }
    event.target.closest('fieldset').querySelector('.validation-note').textContent = 'Changed — validate again.';
  };
  $('creationPreview').onclick = event => {
    const button = event.target.closest('[data-remove]');
    if (!button) return;
    draft.splice(Number(button.dataset.remove), 1);
    renderPreview();
  };
  $('validateDecklist').onclick = async () => {
    if (creating) return;
    try {
      if (!draft.length) throw Error('Preview a decklist or import JSON first.');
      // Structural errors must be corrected; acknowledgement is only for Scryfall recognition.
      const cards = normalizeCards(draft.map(row => row.card));
      if (draft.some(row => row.validation === 'pending' && row.error)) throw Error('Correct flagged parse errors before validating.');
      creating = true;
      lock($('createDialog'), true);
      draft = await validateCards(draft.map((row, index) => ({ ...row, card: cards[index] })), (done, total) => {
        $('creationMessage').textContent = 'Validated ' + done + ' / ' + total;
      });
      renderPreview();
      $('creationMessage').textContent = draft.filter(row => row.validation === 'valid').length + ' / ' + draft.length + ' entries recognized. Review any flagged entries.';
    } catch (error) { $('creationMessage').textContent = error.message; }
    finally { creating = false; lock($('createDialog'), false); }
  };
  $('creationForm').onsubmit = async event => {
    event.preventDefault();
    if (creating) return;
    try {
      const name = normalizeListName($('newListName').value);
      let cards = [];
      if (creationMode() !== 'scratch') {
        if (!draft.length) throw Error('Preview cards first, or choose Start from scratch for an empty list.');
        if (draft.some(row => row.validation === 'pending' && row.error)) throw Error('Correct flagged parse errors before saving.');
        cards = normalizeCards(draft.map(row => row.card));
        if (draft.some(row => row.validation !== 'valid') && !$('allowUnverified').checked) {
          throw Error('Validate the cards, correct flagged entries, or explicitly allow unverified names.');
        }
        if ($('mergeDuplicates').checked) cards = mergeDuplicates(cards);
      }
      creating = true;
      lock($('createDialog'), true);
      $('creationMessage').textContent = 'Creating list…';
      await api.create(name, cards);
      $('createDialog').close();
    } catch (error) { $('creationMessage').textContent = 'Could not create list: ' + error.message; }
    finally { creating = false; lock($('createDialog'), false); }
  };

  function showCardPreview(card, known) {
    $('singleCardPreview').textContent = card.qty + ' × ' + card.name + ' · ' + card.deck +
      (card.note ? ' · ' + card.note : '') + (known ? ' — recognized by Scryfall' : ' — unverified');
  }
  function singleInput() {
    return normalizeCards([{ name: $('cardName').value, qty: $('cardQuantity').value,
      deck: $('cardCategory').value, note: $('cardNotes').value }])[0];
  }
  $('addCard').onclick = () => {
    if (!api.canWrite() || !api.activeId()) return;
    addTarget = api.activeId();
    $('addCardForm').reset();
    $('singleCardPreview').textContent = '';
    $('cardMessage').textContent = '';
    $('cardSuggestions').replaceChildren();
    previewedCard = null;
    lookupVersion++;
    $('addCardDialog').showModal();
    $('cardName').focus();
  };
  $('addCardForm').oninput = event => {
    if (!['cardName', 'cardQuantity', 'cardCategory', 'cardNotes'].includes(event.target.id)) return;
    previewedCard = null;
    lookupVersion++;
    $('singleCardPreview').textContent = 'Preview the card before adding it.';
    if (event.target.id !== 'cardName') return;
    clearTimeout(autocompleteTimer);
    const version = lookupVersion;
    const name = $('cardName').value;
    autocompleteTimer = setTimeout(async () => {
      if (version !== lookupVersion || !$('addCardDialog').open) return;
      try {
        const suggestions = await autocomplete(name);
        if (version === lookupVersion) $('cardSuggestions').innerHTML = suggestions.slice(0, 12)
          .map(value => '<option value="' + escape(value) + '"></option>').join('');
      } catch (error) { if (version === lookupVersion) $('cardMessage').textContent = 'Autocomplete unavailable. Enter a name and use Preview card.'; }
    }, 400);
  };
  $('previewCard').onclick = async () => {
    if (adding) return;
    let card;
    try {
      card = singleInput();
      adding = true;
      lock($('addCardDialog'), true);
      $('cardMessage').textContent = 'Looking up card…';
      const found = await findCard(card.name);
      previewedCard = { ...card, name: found.name, colorIdentity: found.color_identity, scryfallId: null };
      showCardPreview(previewedCard, true);
      $('cardMessage').textContent = '';
    } catch (error) {
      previewedCard = card ? { ...card, unverified: true } : null;
      if (previewedCard) showCardPreview(previewedCard, false);
      $('cardMessage').textContent = error.message;
    } finally { adding = false; lock($('addCardDialog'), false); }
  };
  $('addCardForm').onsubmit = async event => {
    event.preventDefault();
    if (adding) return;
    try {
      if (!previewedCard) throw Error('Preview the card before adding it.');
      if (previewedCard.unverified && !$('allowUnverifiedCard').checked) throw Error('Confirm that you want to add this unverified card.');
      if (addTarget !== api.activeId()) throw Error('The selected list changed. Close and reopen Add Card.');
      adding = true;
      lock($('addCardDialog'), true);
      await api.add(addTarget, normalizeCards([previewedCard])[0], $('mergeExisting').checked);
      $('addCardDialog').close();
    } catch (error) { $('cardMessage').textContent = 'Could not add card: ' + error.message; }
    finally { adding = false; lock($('addCardDialog'), false); }
  };
  for (const id of ['createDialog', 'addCardDialog']) {
    $(id).addEventListener('cancel', event => { if (creating || adding) event.preventDefault(); });
    $(id).querySelector('[data-close]').onclick = () => { if (!creating && !adding) $(id).close(); };
  }
  return { openCreation, close() { lookupVersion++; clearTimeout(autocompleteTimer); $('createDialog').close(); $('addCardDialog').close(); } };
}
