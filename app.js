import { setupListTools } from './modules/list-tools.js';
import { listRepository } from './modules/list-repository.js';
// Supabase client and application state
import {
  createClient
} from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
const supabase = createClient('https://upscvtjtksacfnwknehi.supabase.co',
  'sb_publishable_5i23AiICA5WL6NMHBo1U3g_EGNJ2Qw8');
const $ = id => document.getElementById(id);
const money = n => '$' + Number(n).toFixed(2);
const colorOrder = ['W', 'U', 'B', 'R', 'G'];
const colorNames = {
  W: 'White',
  U: 'Blue',
  B: 'Black',
  R: 'Red',
  G: 'Green'
};
let user = null,
  lists = [],
  activeId = null,
  items = [],
  cardRows = [],
  channel = null,
  hostedLists = [];
let generation = 0,
  syncing = false;
let recoveryMode = false;

// Authentication display helpers
function showAuthView(view) {
  for (const name of ['login', 'requestReset', 'recovery']) $(name + 'View').hidden = name !== view;
  $('authError').textContent = '';
  $('authNotice').textContent = '';
  $('authPanel').hidden = false;
  $('signedInPanel').hidden = true;
  $('app').hidden = true;
}

function authError(error) {
  $('authError').textContent = error?.message || String(error);
}

function recoveryRedirectUrl() {
  // The same hosted page receives the recovery session. Must be allowlisted in Supabase.
  return window.location.origin + window.location.pathname;
}

function message(m) {
  $('status').textContent = m;
}

function syncMessage(m) {
  $('syncState').textContent = m;
}

function html(v) {
  return String(v ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  } [c]));
}

const repository = listRepository(supabase);
let approved = false;
let profiles = new Map();
const pendingItems = new Set();
let itemRequest = 0;
let listRequest = 0;

// Shared lists and item loading
function activeList() {
  return lists.find(x => x.id === activeId);
}

function setAuthVisible(signedIn) {
  $('authPanel').hidden = signedIn;
  $('signedInPanel').hidden = !signedIn;
  $('app').hidden = !signedIn;
}
async function loadLists(preferredId = activeId) {
  const request = ++listRequest;
  const epoch = generation;
  const {
    data,
    error
  } = await supabase.from('shopping_lists').select('id,name,created_by,created_at').order(
    'created_at', {
      ascending: true
    });
  if (error) throw error;
  if (request !== listRequest || epoch !== generation) return;
  lists = data || [];
  activeId = lists.find(l => l.id === preferredId)?.id || lists[0]?.id || null;
  $('activeList').innerHTML = lists.length ? lists.map(l =>
      `<option value="${html(l.id)}">${html(l.name)}</option>`).join('') :
    '<option value="">No shared lists yet</option>';
  $('activeList').value = activeId || '';
  $('removeList').hidden = !activeList() || activeList()?.created_by !== user?.id;
  await loadItems();
}
async function loadItems() {
  const requestedId = activeId;
  const requestId = ++itemRequest;
  const sessionGeneration = generation;
  if (!requestedId) {
    items = [];
    render();
    message('No shared lists yet. Use + Create List to begin.');
    return;
  }
  const {
    data,
    error
  } = await supabase.from('shopping_list_items').select('*').eq('list_id', requestedId).order(
    'position', {
      ascending: true
    }).range(0, 999);
  if (error) throw error;
  if (requestedId !== activeId || requestId !== itemRequest || sessionGeneration !== generation) return;
  items = data || [];
  render();
  message(
    `${items.length} items loaded from ${activeList()?.name}. Changes sync across both accounts.`
    );
}

// Card rendering, sorting, and totals
function colorLabel(row) {
  const cs = row.color_identity;
  return cs === null ? 'Unknown' : !cs.length ? 'Colorless' : cs.map(c => colorNames[c] || c).join(
    ' / ');
}

function colorKey(row) {
  const a = row.color_identity;
  return a === null ? '9-unknown' : !a.length ? '0-colorless' : a.length === 1 ? '1-' + colorOrder
    .indexOf(a[0]) : '2-' + a.join('');
}

function render() {
  $('addCard').disabled = !approved || !activeId;
  const cards = items.filter(x => x.item_type === 'card'),
    extras = items.filter(x => x.item_type !== 'card');
  const mode = $('sortOrder').value;


  cards.sort((a, b) => { //sorts cards
    const nameDifference = a.item_name.localeCompare(b.item_name);

    const deckDifference = (a.deck || '').localeCompare(b.deck || '');

    const colorDifference = colorKey(a).localeCompare(colorKey(b));

    switch (mode) {
      case 'alpha':
        return nameDifference;
      case 'color':
        // Color identity → Card name
        return colorDifference || nameDifference;

      case 'deck-color':
        // Color identity → Deck → Card name
        return colorDifference || deckDifference || nameDifference;

      case 'deck':
        // Deck → Card name
        return deckDifference || nameDifference;

      case 'price-asc':
      case 'price-desc': {
        const priceA = a.estimated_price == null
          ? null
          : Number(a.estimated_price);

        const priceB = b.estimated_price == null
          ? null
          : Number(b.estimated_price);

        // Unpriced cards always appear last.
        if (priceA === null && priceB !== null) return 1;
        if (priceB === null && priceA !== null) return -1;

        if (priceA !== null && priceB !== null) {
          const difference = mode === 'price-asc'
            ? priceA - priceB
            : priceB - priceA;

          if (difference !== 0) return difference;
        }

        // Alphabetical tie-breaker.
        return nameDifference;
      }

      default:
        return nameDifference;
    }
  });


  $('listHeading').firstChild.textContent = (activeList()?.name || 'Card checklist') + ' — cards ';
  
  $('cardCount').textContent = `(${cards.length} cards)`;
  
  const tbody = $('cardRows');
    
  tbody.innerHTML = cards.length
    ? cards.map(card => {
        const url = 'https://scryfall.com/search?q=' + encodeURIComponent(`!"${card.item_name}"`);
        const purchased = card.purchased ? 'checked' : '';
        const pending = pendingItems.has(card.id) ? 'disabled' : '';
        const searchText = `${card.deck} ${card.item_name} ${card.notes || ''}`.toLowerCase();

        const notes = card.notes ? `<small>${html(card.notes)}</small>` : '';
        const printing = card.set_code
          ? `<small>Requested printing: ${html(card.set_code.toUpperCase())} ${html(card.collector_number || '')}</small>`
          : '';

        return `
          <tr data-id="${html(card.id)}" data-search="${html(searchText)}" class="${purchased}">
            <td><input class="check" type="checkbox" ${purchased} ${pending} aria-label="Bought ${html(card.item_name)}"></td>
            <td>${Number(card.quantity)}</td>
            <td><a class="name" href="${html(url)}" target="_blank" rel="noopener">${html(card.item_name)}</a>${notes}${printing}${acquisition(card)}</td>
            <td>${html(card.deck || 'Unassigned')}</td>
            <td class="identity">${html(colorLabel(card))}</td>
            <td class="price"><span class="estimate">${card.estimated_price != null ? money(card.estimated_price) : '—'}</span><small><a href="${html(url)}" target="_blank" rel="noopener">View printings</a></small></td>
            <td><button type="button" class="danger delete-item" ${pending} aria-label="Remove ${html(card.item_name)}">Remove</button></td>
          </tr>
        `;
      }).join('') : '<tr><td colspan="7" class="muted">This list has no cards.</td></tr>';


  $('otherSection').hidden = !extras.length;
  
  $('extraRows').innerHTML = extras.map(e =>
    `<div class="extra" data-id="${html(e.id)}"><label><input class="extra-check" type="checkbox" ${e.purchased?'checked':''} ${pendingItems.has(e.id)?'disabled':''}> ${html(e.item_name)}</label>${acquisition(e)}</div>`
    ).join('');
  
  const query = $('search').value.toLowerCase().trim();
  
  tbody.querySelectorAll('tr[data-search]').forEach(r => r.classList.toggle('hidden', !r.dataset.search.includes(query)));
  
  totals();
}

function totals() {
  const cards = items.filter(x => x.item_type === 'card');
  const checked = items.filter(x => x.purchased).length;
  const priced = cards.filter(x => x.estimated_price != null);
  const remaining = priced.filter(x => !x.purchased).reduce((n, x) => n + Number(x
    .estimated_price) * x.quantity, 0);
  $('progress').textContent = checked + ' / ' + items.length;
  $('priced').textContent = priced.length + ' / ' + cards.length;
  $('remaining').textContent = priced.length ? money(remaining) + ' (priced cards only)' :
    'Not priced yet';
}

// Item updates and live synchronization
function acquisition(item) {
  if (!item.purchased) return '';
  const name = item.purchased_by ? (profiles.get(item.purchased_by) || 'Checklist member') : null;
  const label = name ? 'Acquired — marked by ' + name : item.purchased_at
    ? 'Acquired — purchaser no longer available' : 'Acquired — legacy acquisition (purchaser unknown)';
  return '<small class="acquisition">' + html(label) +
    (item.purchased_at ? ' · <time datetime="' + html(item.purchased_at) + '">' + html(new Date(item.purchased_at).toLocaleString()) + '</time>' : '') + '</small>';
}

async function loadProfiles() {
  const epoch = generation;

  const { data, error } = await supabase
    .from('wishclaw_profiles')
    .select('user_id,display_name');

  if (error) {
    throw error;
  }

  if (epoch !== generation) {
    return;
  }

  profiles = new Map(
    (data || []).map(profile => [
      profile.user_id,
      profile.display_name
    ])
  );

  const currentDisplayName = profiles.get(user?.id) || '';

  $('displayName').value = currentDisplayName;

  // Only show setup for users without a display name.
  $('displayNameSetup').hidden =
    currentDisplayName.trim().length > 0;

  render();
}

async function patchItem(id, changes) {
  if (!approved || pendingItems.has(id)) return;
  const epoch = generation;
  const listId = activeId;
  pendingItems.add(id);
  render();
  syncMessage('Saving…');
  try {
    const { data, error } = await supabase.from('shopping_list_items').update(changes)
      .eq('id', id).eq('list_id', listId).select().single();
    if (error) throw error;
    if (epoch !== generation) return;
    if (activeId === listId) {
      const index = items.findIndex(item => item.id === id);
      if (index >= 0) items[index] = data;
    }
    syncMessage('Live');
  } catch (error) {
    if (epoch === generation) {
      message('Save failed: ' + error.message);
      syncMessage('Save failed');
    }
  } finally {
    pendingItems.delete(id);
    if (epoch === generation) render();
  }
}

function realtime() {
  if (channel) supabase.removeChannel(channel);
  channel = supabase.channel('shopping-change-' + user.id)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'wishclaw_profiles' },
      () => loadProfiles().catch(error => message('Profile refresh failed: ' + error.message)))
    .on('postgres_changes', {
      event: '*',
      schema: 'public',
      table: 'shopping_list_items'
    }, p => {
      if (p.eventType === 'DELETE' || p.new?.list_id === activeId || p.old?.list_id === activeId)
        loadItems().catch(e => message('Sync error: ' + e.message));
    })
    .on('postgres_changes', {
      event: '*',
      schema: 'public',
      table: 'shopping_lists'
    }, () => loadLists(activeId).catch(e => message('List refresh failed: ' + e.message)))
    .subscribe(s => {
      if (s === 'SUBSCRIBED') syncMessage('Live');
      else if (s === 'CHANNEL_ERROR' || s === 'TIMED_OUT') syncMessage(
        'Sync disconnected — refresh to retry');
    });
}

// Account sessions and authentication events
async function handleSession(session) {
  if (recoveryMode) return;
  const next = session?.user || null;
  if (user?.id === next?.id) return;
  const epoch = ++generation;
  user = next;
  approved = false;
  profiles.clear();
  $('displayNameSetup').hidden = true;
  listTools.close();
  if (channel) {
    supabase.removeChannel(channel);
    channel = null;
  }
  if (!user) {
    setAuthVisible(false);
    items = [];
    lists = [];
    activeId = null;
    pendingItems.clear();
    return;
  }
  setAuthVisible(true);
  $('app').hidden = true;
  $('accountName').textContent = user.email || 'Signed in';
  try {
    const {
      data,
      error
    } = await supabase.from('checklist_members').select('user_id').eq('user_id', user.id)
      .maybeSingle();
    if (error) throw error;
    if (!data) {
      $('app').hidden = true;
      $('authPanel').hidden = false;
      $('authError').textContent =
        'Your account is confirmed but not approved. Ask the project owner to add your user ID to checklist_members.';
      $('syncState').textContent = 'Membership required';
      return;
    }
    if (epoch !== generation) return;
    approved = true;
    await loadLists();
    if (epoch !== generation) return;
    $('app').hidden = false;
    await loadProfiles().catch(error => message('Display names unavailable: ' + error.message + '. Apply the list-management migration.'));
    if (epoch === generation && approved) realtime();
  } catch (e) {
    message('Could not load lists: ' + e.message);
    syncMessage('Error');
  }
}
$('authForm').addEventListener('submit', async e => {
  e.preventDefault();
  $('authError').textContent = '';
  $('authNotice').textContent = '';
  $('signIn').disabled = true;
  try {
    const {
      error
    } = await supabase.auth.signInWithPassword({
      email: $('email').value.trim(),
      password: $('password').value
    });
    if (error) throw error;
  } catch (error) {
    authError(error);
  } finally {
    $('signIn').disabled = false;
  }
});
$('showReset').onclick = () => {
  showAuthView('requestReset');
  $('resetEmail').value = $('email').value.trim();
};
$('backToLogin').onclick = () => showAuthView('login');
$('requestResetForm').addEventListener('submit', async e => {
  e.preventDefault();
  $('authError').textContent = '';
  $('authNotice').textContent = '';
  $('sendReset').disabled = true;
  try {
    const {
      error
    } = await supabase.auth.resetPasswordForEmail($('resetEmail').value.trim(), {
      redirectTo: recoveryRedirectUrl()
    });
    if (error) throw error;
    $('authNotice').textContent =
      'If that email belongs to an account, a password link has been sent. Open the link on this website to set your password. Check spam if needed.';
  } catch (error) {
    authError(error);
  } finally {
    $('sendReset').disabled = false;
  }
});
$('newPasswordForm').addEventListener('submit', async e => {
  e.preventDefault();
  $('authError').textContent = '';
  $('authNotice').textContent = '';
  const password = $('newPassword').value;
  if (password !== $('confirmPassword').value) {
    authError('Passwords do not match.');
    return;
  }
  if (password.length < 8) {
    authError('Use at least eight characters.');
    return;
  }
  $('updatePassword').disabled = true;
  try {
    const {
      error
    } = await supabase.auth.updateUser({
      password
    });
    if (error) throw error;
    // Explicitly sign out; next login uses the newly chosen password.
    recoveryMode = false;
    const signOutResult = await supabase.auth.signOut();
    $('newPassword').value = '';
    $('confirmPassword').value = '';
    showAuthView('login');
    $('authNotice').textContent = signOutResult.error ?
      'Password saved. You can now sign in using your new password. (' + signOutResult.error
      .message + ')' :
      'Password saved! Sign in with your email and new password.';
  } catch (error) {
    authError(error);
  } finally {
    $('updatePassword').disabled = false;
  }
});
$('signOut').onclick = async () => {
  const {
    error
  } = await supabase.auth.signOut();
  if (error) message(error.message);
};
supabase.auth.onAuthStateChange((event, session) => {
  if (event === 'PASSWORD_RECOVERY') {
    recoveryMode = true;
    generation++;
    user = null;
    approved = false;
    listTools.close();
    if (channel) {
      supabase.removeChannel(channel);
      channel = null;
    }
    showAuthView('recovery');
    return;
  }
  if (['INITIAL_SESSION', 'SIGNED_IN', 'SIGNED_OUT'].includes(event)) {
    setTimeout(() => {
      if (!recoveryMode) handleSession(session);
    }, 0);
  }
});
setAuthVisible(false);
// If a recovery link returns with an error, display its reason rather than a blank login.
const urlParams = new URLSearchParams(window.location.hash.replace(/^#/, '') || window.location
  .search.replace(/^\?/, ''));
if (urlParams.has('error_description')) {
  showAuthView('login');
  authError(decodeURIComponent(urlParams.get('error_description')));
}

// Checklist controls
$('activeList').addEventListener('change', async e => {
  ++listRequest;
  activeId = e.target.value || null;
  $('removeList').hidden = !activeList() || activeList()?.created_by !== user.id;
  await loadItems().catch(error => message('Could not load list: ' + error.message));
});
$('cardRows').addEventListener('change', e => {
  const r = e.target.closest('tr[data-id]');
  if (!r) return;
  if (e.target.matches('.check')) patchItem(r.dataset.id, {
    purchased: e.target.checked
  });

});
$('extraRows').addEventListener('change', e => {
  const r = e.target.closest('[data-id]');
  if (r) patchItem(r.dataset.id, {
    purchased: e.target.checked
  });
});
$('sortOrder').onchange = render;
$('search').oninput = () => {
  const q = $('search').value.toLowerCase().trim();
  document.querySelectorAll('tr[data-search]').forEach(r => r.classList.toggle('hidden', !r
    .dataset.search.includes(q)));
};

$('cardRows').addEventListener('click', async event => {
  const button = event.target.closest('.delete-item');
  const row = button?.closest('tr[data-id]');
  if (!row || !approved || pendingItems.has(row.dataset.id)) return;
  const item = items.find(value => value.id === row.dataset.id);
  if (!item || !confirm('Remove “' + item.item_name + '” from this shared list? This affects everyone.')) return;
  const epoch = generation;
  pendingItems.add(item.id);
  render();
  try {
    await repository.remove(item.list_id, item.id);
    if (epoch !== generation) return;
    items = items.filter(value => value.id !== item.id);
    message('Card removed.');
  } catch (error) { if (epoch === generation) message('Remove failed: ' + error.message); }
  finally { pendingItems.delete(item.id); if (epoch === generation) render(); }
});

$('profileForm').onsubmit = async event => {
  event.preventDefault();
  if (!approved) return;
  const epoch = generation;
  $('saveProfile').disabled = true;
  try {
    const profile = await repository.saveProfile(user.id, $('displayName').value);
    if (epoch !== generation) return;
    profiles.set(profile.user_id, profile.display_name);
    $('displayNameSetup').hidden = true;
    $('profileStatus').textContent = 'Display name saved.';
    render();
  } catch (error) { $('profileStatus').textContent = 'Could not save display name: ' + error.message; }
  finally { $('saveProfile').disabled = false; }
};

// Import uploaded JSON and manage shared lists
async function importList(raw, suggestedName) {
  if (!approved) throw Error('Sign in with an approved account first.');
  listTools.openCreation(raw, raw?.name || raw?.title || suggestedName);
}
$('removeList').onclick = async () => {
  const list = activeList();
  if (!list || list.created_by !== user?.id) return;
  if (!confirm(
      `Permanently delete “${list.name}” and all its purchases? This affects everyone.`))
return;
  const {
    error
  } = await supabase.from('shopping_lists').delete().eq('id', list.id);
  if (error) message('Delete failed: ' + error.message);
  else await loadLists(null);
};

// Hosted JSON list catalog
async function loadHostedLists() {
  try {
    const response = await fetch(new URL('card-lists.json', document.baseURI), {
      cache: 'no-cache'
    });
    if (!response.ok) throw Error('HTTP ' + response.status);
    const manifest = await response.json();
    const entries = Array.isArray(manifest) ? manifest : manifest.lists;
    if (!Array.isArray(entries)) throw Error('Invalid lists catalog.');
    const base = new URL('.', document.baseURI);
    hostedLists = entries.filter(x => {
      if (!x || typeof x.name !== 'string' || typeof x.file !== 'string') return false;
      if (x.file.startsWith('/') || x.file.split('/').includes('..')) return false;
      const url = new URL(x.file, base);
      return url.origin === base.origin && url.pathname.startsWith(base.pathname);
    });
    $('hostedListSelect').innerHTML = '<option value="">Choose a hosted JSON list…</option>' +
      hostedLists.map((x, i) => `<option value="${i}">${html(x.name)}</option>`).join('');
  } catch (e) {
    $('hostedListSelect').innerHTML = '<option value="">No hosted JSON lists found</option>';
  }
}
$('hostedListSelect').onchange = e => $('loadHostedList').disabled = !e.target.value;
$('loadHostedList').onclick = async () => {
  const index = Number($('hostedListSelect').value),
    entry = hostedLists[index];
  if (!entry) return;
  try {
    const response = await fetch(new URL(entry.file, new URL('.', document.baseURI)), {
      cache: 'no-cache'
    });
    if (!response.ok) throw Error('HTTP ' + response.status);
    await importList(await response.json(), entry.name);
  } catch (e) {
    message('Could not import hosted list: ' + e.message);
  }
};

// JSON and CSV exports
function download(name, contents, type) {
  const a = document.createElement('a'),
    blob = new Blob([contents], {
      type
    });
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove()
  }, 1000);
}
$('save').onclick = () => download((activeList()?.name || 'MagicCon') + '-backup.json', JSON
  .stringify({
    name: activeList()?.name,
    items
  }, null, 2), 'application/json');
$('export').onclick = () => {
  const esc = x => '"' + String(x ?? '').replace(/"/g, '""') + '"';
  const data = [
    ['List', 'Deck', 'Qty', 'Item', 'Notes', 'Bought', 'Scryfall estimate each', 'Paid each']
  ];
  items.forEach(x => data.push([activeList()?.name, x.deck, x.quantity, x.item_name, x.notes, x
    .purchased, x.estimated_price, x.price_paid
  ]));
  download((activeList()?.name || 'MagicCon') + '.csv', data.map(r => r.map(esc).join(',')).join(
    '\r\n'), 'text/csv');
};

// Scryfall pricing

const SCRYFALL_BATCH_SIZE = 8;
const SCRYFALL_REQUEST_DELAY = 700;

const wait = ms =>
  new Promise(resolve => setTimeout(resolve, ms));

function batchItems(array, size) {
  const batches = [];

  for (let i = 0; i < array.length; i += size) {
    batches.push(array.slice(i, i + size));
  }

  return batches;
}


async function loadPrices() {
  if (syncing) return;

  syncing = true;
  $('load').disabled = true;

  const listId = activeId;
  const cards = items.filter(item =>
    item.item_type === 'card' &&
    (
      item.estimated_price == null ||
      !Array.isArray(item.color_identity)
    )
  );

  // Group by printing preference to preserve foil,
  // etched, and Secret Lair restrictions.
  const groups = new Map();

  for (const card of cards) {
    const notes = (card.notes || '').toLowerCase();


    const finish = notes.includes('confetti')
      ? 'confetti'
      : notes.includes('etched')
        ? 'etched'
        : notes.includes('foil')
          ? 'foil'
          : 'nonfoil';

    const secretLair =
      notes.includes('secret lair') ||
      notes.includes('sld');

    const groupKey = `${finish}:${secretLair}`;

    if (!groups.has(groupKey)) {
      groups.set(groupKey, {
        finish,
        secretLair,
        cards: []
      });
    }

    groups.get(groupKey).cards.push(card);
  }

  const batches = [];

  for (const group of groups.values()) {
    // Deduplicate names within each preference group.
    const names = [...new Set(
      group.cards.map(card => card.item_name)
    )];

    for (const batch of batchItems(names, SCRYFALL_BATCH_SIZE)) {
      batches.push({ ...group, names: batch });
    }
  }

  let updated = 0;
  let unavailable = 0;
  let requests = 0;
  let rateLimited = false;

  try {
    for (let i = 0; i < batches.length; i++) {
      if (activeId !== listId) break;

      const batch = batches[i];
      const escapeName = name =>
        name.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

      const query =
        '(' +
        batch.names.map(name => `!"${escapeName(name)}"`).join(' OR ') +
        ') game:paper' +
        (batch.secretLair ? ' set:sld' : '') +
        (batch.finish === 'foil' ? ' finish:foil' : '') +
        (batch.finish === 'confetti' ? ' is:confetti' : '') +
        (batch.finish === 'etched' ? ' finish:etched' : '');

      let url = 'https://api.scryfall.com/cards/search?' +
        new URLSearchParams({
          q: query,
          unique: 'prints',
          order: 'usd',
          dir: 'asc'
        });

      const results = new Map();

      message(
        `Checking Scryfall batch ${i + 1}/${batches.length}...`
      );

      // Follow every page to avoid missing lower prices
      // for foil or etched printings.
      while (url) {
        if (requests > 0) {
          await wait(SCRYFALL_REQUEST_DELAY);
        }

        requests++;

        const response = await fetch(url, {
          headers: {
            Accept: 'application/json'
          }
        });

        if (response.status === 429) {
          rateLimited = true;
          break;
        }

        if (!response.ok) {
          throw new Error(
            `Scryfall returned HTTP ${response.status}`
          );
        }

        const data = await response.json();

        for (const printing of data.data || []) {
          const name = printing.name;

          if (!batch.names.includes(name)) continue;

          const priceField = {
            nonfoil: 'usd',
            confetti: 'usd_foil',
            foil: 'usd_foil',
            etched: 'usd_etched'
          }[batch.finish];

          const rawPrice = printing.prices?.[priceField];

          const price = rawPrice == null
            ? null
            : Number(rawPrice);

          const current = results.get(name) || {
            price: null,
            colorIdentity: null
          };

          if (
            price != null &&
            Number.isFinite(price) &&
            price > 0 &&
            (current.price == null || price < current.price)
          ) {
            current.price = price;
          }

          if (Array.isArray(printing.color_identity)) {
            current.colorIdentity = colorOrder.filter(color =>
              printing.color_identity.includes(color)
            );
          }

          results.set(name, current);
        }

        url = data.has_more ? data.next_page : null;
      }

      // Do not save incomplete batch results after a 429.
      if (rateLimited) break;

      const matchedCards = batch.cards.filter(card =>
        batch.names.includes(card.item_name)
      );

      for (const card of matchedCards) {
        if (activeId !== listId) break;

        const result = results.get(card.item_name);

        if (!result) {
          unavailable++;
          continue;
        }

        const changes = {};

        if (result.price != null) {
          changes.estimated_price = result.price;
        }

        if (result.colorIdentity != null) {
          changes.color_identity = result.colorIdentity;
        }

        if (!Object.keys(changes).length) {
          unavailable++;
          continue;
        }

        const { data, error } = await supabase
          .from('shopping_list_items')
          .update(changes)
          .eq('id', card.id)
          .eq('list_id', listId)
          .select()
          .single();

        if (error) {
          unavailable++;
          continue;
        }

        const index = items.findIndex(item => item.id === card.id);

        if (index >= 0 && activeId === listId) {
          items[index] = data;
        }

        updated++;
      }

      render();
    }

    if (rateLimited) {
      message(
        'Scryfall rate limit reached. Stopped requests. ' +
        'Saved completed batches remain available.'
      );
    } else {
      message(
        `Pricing finished: ${updated} updated, ` +
        `${unavailable} unavailable.`
      );
    }
  } catch (error) {
    message('Scryfall pricing stopped: ' + error.message);
  } finally {
    syncing = false;
    $('load').disabled = false;
    render();
  }
}

const listTools = setupListTools({
  canWrite: () => approved && Boolean(user),
  activeId: () => activeId,
  async create(name, cards) {
    if (!approved) throw Error('Approved membership required.');
    const epoch = generation;
    const id = await repository.create(name, cards);
    if (epoch !== generation) return;
    activeId = id;
    try {
      await loadLists(id);
      message('Created “' + name + '”. Everyone can see it now.');
    } catch (error) { message('List created, but refresh failed. Reload the page: ' + error.message); }
  },
  async add(listId, card, merge) {
    if (!approved) throw Error('Approved membership required.');
    const epoch = generation;
    await repository.add(listId, card, merge);
    if (epoch !== generation) return;
    try {
      if (activeId === listId) await loadItems();
      message('Card added to the shared list.');
    } catch (error) { message('Card added, but refresh failed. Reload the page: ' + error.message); }
  }
});

// Startup
$('load').onclick = loadPrices;
loadHostedLists();
