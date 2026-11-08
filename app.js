import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
const supabase = createClient('https://upscvtjtksacfnwknehi.supabase.co', 'sb_publishable_5i23AiICA5WL6NMHBo1U3g_EGNJ2Qw8');
const $ = id => document.getElementById(id);
const money = n => '$' + Number(n).toFixed(2);
const colorOrder = ['W','U','B','R','G'];
const colorNames = {W:'White',U:'Blue',B:'Black',R:'Red',G:'Green'};
let user = null, lists = [], activeId = null, items = [], cardRows = [], channel = null, hostedLists = [];
let generation = 0, syncing = false;
function message(m) { $('status').textContent = m; }
function syncMessage(m) { $('syncState').textContent = m; }
function html(v) { return String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function normalizeCards(input) {
  const entries = Array.isArray(input) ? input : input?.cards;
  if (!Array.isArray(entries) || !entries.length || entries.length > 500) throw Error('JSON must contain 1–500 cards in an array or cards property.');
  return entries.map((x,i) => {
    if (!x || !String(x.name || '').trim()) throw Error(`Card ${i+1} is missing its name.`);
    const qty = Number(x.qty ?? 1);
    if (!Number.isInteger(qty) || qty < 1 || qty > 999) throw Error(`Card ${i+1} has an invalid qty.`);
    const ident = x.colorIdentity ?? x.color_identity;
    let colorIdentity = null;
    if (Array.isArray(ident)) {
      const codes = ident.map(x=>String(x).toUpperCase());
      if (codes.some(c=>!colorOrder.includes(c))) throw Error(`Invalid color identity at card ${i+1}.`);
      colorIdentity = colorOrder.filter(c=>codes.includes(c));
    } else if (typeof ident === 'string' && /^[WUBRG,\s]*$/i.test(ident)) {
      const codes = ident.toUpperCase().match(/[WUBRG]/g) || [];
      colorIdentity = colorOrder.filter(c=>codes.includes(c));
    }
    return {name:String(x.name).trim().slice(0,250),deck:String(x.deck||'Unassigned').trim().slice(0,150),qty,
      note:String(x.note||'').slice(0,1500),colorIdentity};
  });
}
function activeList() { return lists.find(x=>x.id===activeId); }
function setAuthVisible(signedIn) { $('authPanel').hidden = signedIn; $('signedInPanel').hidden = !signedIn; $('app').hidden = !signedIn; }
async function loadLists(preferredId=activeId) {
  const {data,error}=await supabase.from('shopping_lists').select('id,name,created_by,created_at').order('created_at',{ascending:true});
  if(error) throw error;
  lists = data||[];
  activeId = lists.find(l=>l.id===preferredId)?.id || lists[0]?.id || null;
  $('activeList').innerHTML = lists.length ? lists.map(l=>`<option value="${html(l.id)}">${html(l.name)}</option>`).join('') : '<option value="">No shared lists yet</option>';
  $('activeList').value = activeId || '';
  $('removeList').hidden = !activeList() || activeList()?.created_by !== user?.id;
  await loadItems();
}
async function loadItems() {
  const requestedId=activeId;
  if(!requestedId){items=[];render();message('No shared lists yet. Upload a JSON list to create the first one.');return;}
  const {data,error}=await supabase.from('shopping_list_items').select('*').eq('list_id',requestedId).order('position',{ascending:true}).range(0,999);
  if(error)throw error;
  if(requestedId!==activeId)return;
  items = data||[];render();message(`${items.length} items loaded from ${activeList()?.name}. Changes sync across both accounts.`);
}
function colorLabel(row) { const cs=row.color_identity;return cs===null?'Unknown':!cs.length?'Colorless':cs.map(c=>colorNames[c]||c).join(' / '); }
function colorKey(row) { const a=row.color_identity;return a===null?'9-unknown':!a.length?'0-colorless':a.length===1?'1-'+colorOrder.indexOf(a[0]):'2-'+a.join(''); }
function render() {
 const cards=items.filter(x=>x.item_type==='card'), extras=items.filter(x=>x.item_type!=='card');
 const mode=$('sortOrder').value;
 cards.sort((a,b)=>{
   if(mode==='color'){const v=colorKey(a).localeCompare(colorKey(b));if(v)return v;}
   const deck=(a.deck||'').localeCompare(b.deck||'');if(deck)return deck;
   if(mode==='deck-color'){const v=colorKey(a).localeCompare(colorKey(b));if(v)return v;}
   return a.item_name.localeCompare(b.item_name);
 });
 $('listHeading').firstChild.textContent=(activeList()?.name||'Card checklist')+' — cards ';
 $('cardCount').textContent=`(${cards.length} cards)`;
 const tbody=$('cardRows');
 tbody.innerHTML=cards.length?cards.map(c=>{
  const url='https://scryfall.com/search?q='+encodeURIComponent('!"'+c.item_name+'"');
  return `<tr data-id="${html(c.id)}" data-search="${html((c.deck+' '+c.item_name+' '+(c.notes||'')).toLowerCase())}" class="${c.purchased?'checked':''}">
    <td><input class="check" type="checkbox" ${c.purchased?'checked':''} aria-label="Bought ${html(c.item_name)}"></td><td>${Number(c.quantity)}</td>
    <td>${html(c.deck||'Unassigned')}</td><td class="identity">${html(colorLabel(c))}</td>
    <td><a class="name" href="${html(url)}" target="_blank" rel="noopener">${html(c.item_name)}</a>${c.notes?`<small>${html(c.notes)}</small>`:''}</td>
    <td class="price"><span class="estimate">${c.estimated_price!=null?money(c.estimated_price):'—'}</span><small><a href="${html(url)}" target="_blank" rel="noopener">View printings</a></small></td>
    <td><input class="paid" type="number" min="0" step="0.01" value="${c.price_paid??''}" placeholder="—" aria-label="Price paid for ${html(c.item_name)}"></td>
   </tr>`;
 }).join(''):'<tr><td colspan="7" class="muted">This list has no cards.</td></tr>';
 $('otherSection').hidden = !extras.length;
 $('extraRows').innerHTML=extras.map(e=>`<div class="extra" data-id="${html(e.id)}"><label><input class="extra-check" type="checkbox" ${e.purchased?'checked':''}> ${html(e.item_name)}</label></div>`).join('');
 const query=$('search').value.toLowerCase().trim();
 tbody.querySelectorAll('tr[data-search]').forEach(r=>r.classList.toggle('hidden',!r.dataset.search.includes(query)));
 totals();
}
function totals(){const cards=items.filter(x=>x.item_type==='card');const checked=items.filter(x=>x.purchased).length;
 const priced=cards.filter(x=>x.estimated_price!=null);
 const remaining=priced.filter(x=>!x.purchased).reduce((n,x)=>n+Number(x.estimated_price)*x.quantity,0);
 $('progress').textContent=checked+' / '+items.length;
 $('priced').textContent=priced.length+' / '+cards.length;
 $('remaining').textContent=priced.length?money(remaining)+' (priced cards only)':'Not priced yet';
}
async function patchItem(id,changes){
 const prev=items.find(x=>x.id===id);if(!prev)return;
 const old={...prev};Object.assign(prev,changes);render();syncMessage('Saving…');
 const {data,error}=await supabase.from('shopping_list_items').update(changes).eq('id',id).select().single();
 if(error){Object.assign(prev,old);render();message('Save failed: '+error.message);syncMessage('Save failed');return;}
 if(data){const ix=items.findIndex(x=>x.id===id);if(ix>=0)items[ix]=data;render();}
 syncMessage('Live');
}
function realtime(){
 if(channel)supabase.removeChannel(channel);
 channel=supabase.channel('shopping-change-'+user.id)
 .on('postgres_changes',{event:'*',schema:'public',table:'shopping_list_items'},p=>{
  if(p.eventType==='DELETE'||p.new?.list_id===activeId||p.old?.list_id===activeId)loadItems().catch(e=>message('Sync error: '+e.message));
 })
 .on('postgres_changes',{event:'*',schema:'public',table:'shopping_lists'},()=>loadLists(activeId).catch(e=>message('List refresh failed: '+e.message)))
 .subscribe(s=>{if(s==='SUBSCRIBED')syncMessage('Live');else if(s==='CHANNEL_ERROR'||s==='TIMED_OUT')syncMessage('Sync disconnected — refresh to retry');});
}
async function handleSession(session){
 const next=session?.user||null;
 if(user?.id===next?.id)return;
 const epoch=++generation;user=next;
 if(channel){supabase.removeChannel(channel);channel=null;}
 if(!user){setAuthVisible(false);items=[];lists=[];return;}
 setAuthVisible(true);$('accountName').textContent=user.email||'Signed in';
 try{
  const {data,error}=await supabase.from('checklist_members').select('user_id').eq('user_id',user.id).maybeSingle();
  if(error)throw error;
  if(!data){$('app').hidden=true;$('authPanel').hidden=false;$('authError').textContent='Your account is confirmed but not approved. Ask the project owner to add your user ID to checklist_members.';$('syncState').textContent='Membership required';return;}
  if(epoch!==generation)return;
  await loadLists();realtime();
 }catch(e){message('Could not load lists: '+e.message);syncMessage('Error');}
}
$('authForm').addEventListener('submit',async e=>{e.preventDefault();$('authError').textContent='';$('signIn').disabled=true;
 const {error}=await supabase.auth.signInWithPassword({email:$('email').value.trim(),password:$('password').value});
 $('signIn').disabled=false;if(error)$('authError').textContent=error.message;
});
$('signOut').onclick=async()=>{const {error}=await supabase.auth.signOut();if(error)message(error.message);};
supabase.auth.onAuthStateChange((event,session)=>{if(['INITIAL_SESSION','SIGNED_IN','SIGNED_OUT'].includes(event))setTimeout(()=>handleSession(session),0);});
setAuthVisible(false);
$('activeList').addEventListener('change',async e=>{activeId=e.target.value||null;$('removeList').hidden=!activeList()||activeList()?.created_by!==user.id;await loadItems();});
$('cardRows').addEventListener('change',e=>{
 const r=e.target.closest('tr[data-id]');if(!r)return;
 if(e.target.matches('.check'))patchItem(r.dataset.id,{purchased:e.target.checked});
 else if(e.target.matches('.paid')){const raw=e.target.value;if(raw!==''&&(!Number.isFinite(Number(raw))||Number(raw)<0)){message('Price paid must be a nonnegative number.');render();return;}
 patchItem(r.dataset.id,{price_paid:raw===''?null:Number(raw)});}
});
$('extraRows').addEventListener('change',e=>{const r=e.target.closest('[data-id]');if(r)patchItem(r.dataset.id,{purchased:e.target.checked});});
$('sortOrder').onchange=render;
$('search').oninput=()=>{const q=$('search').value.toLowerCase().trim();document.querySelectorAll('tr[data-search]').forEach(r=>r.classList.toggle('hidden',!r.dataset.search.includes(q)));};
async function importList(raw,suggestedName){
 if(!user)throw Error('Sign in first.');
 const cards=normalizeCards(raw);
 const suggested=raw?.name||raw?.title||suggestedName||'Imported cards';
 const name=prompt('Name for this new shared list:',suggested);
 if(name===null)return;
 if(!name.trim()||name.trim().length>120)throw Error('List name must be 1–120 characters.');
 message(`Creating shared list “${name.trim()}” with ${cards.length} cards…`);
 const {data,error}=await supabase.rpc('create_shopping_list',{p_name:name.trim(),p_cards:cards.map(c=>({name:c.name,deck:c.deck,qty:c.qty,note:c.note,colorIdentity:c.colorIdentity}))});
 if(error)throw error;
 await loadLists(data);
 message(`Created “${name.trim()}” with ${cards.length} cards. Everyone can see it now.`);
}
$('createFromJson').onclick=()=>$('newListFile').click();
$('newListFile').onchange=async e=>{
 const file=e.target.files?.[0];if(!file)return;
 try {if(file.size>1024*1024)throw Error('JSON files must be smaller than 1 MB.');await importList(JSON.parse(await file.text()),file.name.replace(/\.json$/i,''));}
 catch(err){message('Could not create list: '+err.message);}finally{e.target.value='';}
};
$('removeList').onclick=async()=>{const list=activeList();if(!list||list.created_by!==user?.id)return;
 if(!confirm(`Permanently delete “${list.name}” and all its purchases? This affects everyone.`))return;
 const {error}=await supabase.from('shopping_lists').delete().eq('id',list.id);
 if(error)message('Delete failed: '+error.message);else await loadLists(null);
};
async function loadHostedLists(){
 try{const response=await fetch(new URL('card-lists.json',document.baseURI),{cache:'no-cache'});if(!response.ok)throw Error('HTTP '+response.status);
 const manifest=await response.json();const entries=Array.isArray(manifest)?manifest:manifest.lists;
 if(!Array.isArray(entries))throw Error('Invalid lists catalog.');const base=new URL('.',document.baseURI);
 hostedLists=entries.filter(x=>{if(!x||typeof x.name!=='string'||typeof x.file!=='string')return false;
 if(x.file.startsWith('/')||x.file.split('/').includes('..'))return false;const url=new URL(x.file,base);return url.origin===base.origin&&url.pathname.startsWith(base.pathname);});
 $('hostedListSelect').innerHTML='<option value="">Choose a hosted JSON list…</option>'+hostedLists.map((x,i)=>`<option value="${i}">${html(x.name)}</option>`).join('');
 }catch(e){$('hostedListSelect').innerHTML='<option value="">No hosted JSON lists found</option>';}
}
$('hostedListSelect').onchange=e=>$('loadHostedList').disabled=!e.target.value;
$('loadHostedList').onclick=async()=>{
 const index=Number($('hostedListSelect').value),entry=hostedLists[index];if(!entry)return;
 try{const response=await fetch(new URL(entry.file,new URL('.',document.baseURI)),{cache:'no-cache'});if(!response.ok)throw Error('HTTP '+response.status);
 await importList(await response.json(),entry.name);
 }catch(e){message('Could not import hosted list: '+e.message);}
};
function download(name,contents,type){const a=document.createElement('a'),blob=new Blob([contents],{type});a.href=URL.createObjectURL(blob);a.download=name;document.body.append(a);a.click();setTimeout(()=>{URL.revokeObjectURL(a.href);a.remove()},1000);}
$('save').onclick=()=>download((activeList()?.name||'MagicCon')+'-backup.json',JSON.stringify({name:activeList()?.name,items},null,2),'application/json');
$('export').onclick=()=>{const esc=x=>'"'+String(x??'').replace(/"/g,'""')+'"';const data=[['List','Deck','Qty','Item','Notes','Bought','Scryfall estimate each','Paid each']];
 items.forEach(x=>data.push([activeList()?.name,x.deck,x.quantity,x.item_name,x.notes,x.purchased,x.estimated_price,x.price_paid]));
 download((activeList()?.name||'MagicCon')+'.csv',data.map(r=>r.map(esc).join(',')).join('\r\n'),'text/csv');};
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function loadPrices(){
 if(syncing)return;syncing=true;$('load').disabled=true;
 const cards=items.filter(x=>x.item_type==='card');let found=0,fail=0;
 try{
  for(const c of cards){if(activeId!==c.list_id)break;if(c.estimated_price!=null&&Array.isArray(c.color_identity)){found++;continue;}
   message(`Checking Scryfall: ${found+fail+1}/${cards.length} (${found} priced)`);
   const note=(c.notes||'').toLowerCase(), foil=note.includes('foil'),etched=note.includes('etched');
   let query='!"'+c.item_name.replace(/"/g,'\\"')+'" game:paper';if(etched)query+=' finish:etched';else if(foil)query+=' finish:foil';if(note.includes('secret lair'))query+=' set:sld';
   let url='https://api.scryfall.com/cards/search?q='+encodeURIComponent(query)+'&unique=prints&order=usd&dir=asc';
   let min=Infinity,identity=null;
   try{let pages=0;while(url&&pages++<10){const response=await fetch(url,{headers:{Accept:'application/json'}});if(!response.ok)throw Error('HTTP '+response.status);
    const result=await response.json();for(const card of result.data||[]){if(!identity&&Array.isArray(card.color_identity))identity=colorOrder.filter(x=>card.color_identity.includes(x));
     const num=Number(card.prices?.[etched?'usd_etched':foil?'usd_foil':'usd']);if(num>0&&num<min)min=num;}
    url=result.has_more?result.next_page:null;await wait(150);
   }}catch(e){fail++;continue;}
   const changes={};if(Number.isFinite(min))changes.estimated_price=min;
   if(identity!==null)changes.color_identity=identity;
   if(Object.keys(changes).length){const {data,error}=await supabase.from('shopping_list_items').update(changes).eq('id',c.id).select().single();
      if(!error&&data){const i=items.findIndex(x=>x.id===c.id);if(i>=0)items[i]=data;if(Number.isFinite(min))found++;else fail++;}
      else fail++;
   }else fail++;
   render();await wait(150);
  }
  message(`Pricing finished: ${found} priced; ${fail} unavailable. Estimates are Scryfall indicative USD prices, not live TCGplayer listings.`);
 }finally{syncing=false;$('load').disabled=false;render();}
}
$('load').onclick=loadPrices;
loadHostedLists();
