const fs = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { fixture, databaseTests, ids, root } = require('./database.cjs');
const delay = ms => new Promise(r=>setTimeout(r,ms));
async function until(fn, label) { for(let i=0;i<160;i++){if(await fn())return;await delay(25)} throw Error('Timed out: '+label); }

// The Supabase-shaped adapter uses real local PostgreSQL queries and RLS.
// Authentication and Realtime transport are simulated; never contact the live project.
function adapter(f) {
  const subscriptions=[];
  const control={failNext:false};
  const quote = name => {if(!/^[a-z_]+$/.test(name)) throw Error('Bad identifier');return '"'+name+'"'};
  const emit = (table,kind,row) => setTimeout(()=>subscriptions.forEach(sub=>{
    for(const h of sub.handlers) if(h.filter.table===table) h.callback({eventType:kind,new:kind==='DELETE'?{}:row,old:kind==='DELETE'?row:{}});
  }),0);
  function client(userId) {
    let authCallback;
    const client={
      auth:{onAuthStateChange(callback){authCallback=callback;setTimeout(()=>callback('INITIAL_SESSION',userId?{user:{id:userId,email:'private@example.test'}}:null),0);},
        async signOut(){userId=null;authCallback('SIGNED_OUT',null);return {error:null}},
        async signInWithPassword(){return {error:null}},async resetPasswordForEmail(){return {error:null}},async updateUser(){return {error:null}}},
      from(table){
        let action='SELECT',values=null,filters=[],sort=null,returning='*',single=false;
        const builder={
          select(columns='*'){returning=columns;return builder},
          update(changes){action='UPDATE';values=changes;return builder},
          delete(){action='DELETE';return builder},
          upsert(changes){action='UPSERT';values=changes;return builder},
          eq(key,value){filters.push([key,value]);return builder},
          order(key){sort=key;return builder},range(){return builder},
          single(){single=true;return builder},maybeSingle(){single=true;return builder},
          then(resolve,reject){return (async()=>{
            try {
              if(control.failNext && action!=='SELECT'){control.failNext=false;throw Error('Simulated database failure')}
              const params=[]; const param=value=>{params.push(value);return '$'+params.length};
              const columns=returning==='*'?'*':returning.split(',').map(quote).join(',');
              let sql;
              if(action==='UPDATE') sql='UPDATE '+quote(table)+' SET '+Object.entries(values).map(([k,v])=>quote(k)+'='+param(v)).join(',');
              else if(action==='DELETE') sql='DELETE FROM '+quote(table);
              else if(action==='UPSERT') sql='INSERT INTO '+quote(table)+'('+Object.keys(values).map(quote).join(',')+') VALUES('+Object.values(values).map(param).join(',')+') ON CONFLICT(user_id) DO UPDATE SET display_name=excluded.display_name';
              else sql='SELECT '+columns+' FROM '+quote(table);
              if(filters.length) sql+=' WHERE '+filters.map(([k,v])=>quote(k)+'='+param(v)).join(' AND ');
              if(action==='SELECT'&&sort) sql+=' ORDER BY '+quote(sort);
              if(action!=='SELECT') sql+=' RETURNING '+columns;
              const result=await f.asUser(userId,sql,params);
              if(action!=='SELECT') emit(table,action==='UPSERT'?'UPDATE':action,result.rows[0]||{});
              return {data:single?result.rows[0]||null:result.rows,error:null};
            }catch(error){return {data:null,error:{message:error.message}}}
          })().then(resolve,reject)}
        };return builder;
      },
      async rpc(name,args){
        try {
          if(control.failNext){control.failNext=false;throw Error('Simulated database failure')}
          let result;
          if(name==='create_shopping_list') result=await f.asUser(userId,'SELECT create_shopping_list($1,$2) id',[args.p_name,JSON.stringify(args.p_cards)]);
          else result=await f.asUser(userId,'SELECT add_shopping_list_item($1,$2,$3) id',[args.p_list_id,JSON.stringify(args.p_card),args.p_merge]);
          emit(name==='create_shopping_list'?'shopping_lists':'shopping_list_items','INSERT',{list_id:args.p_list_id});
          return {data:result.rows[0].id,error:null};
        }catch(error){return {data:null,error:{message:error.message}}}
      },
      channel(){const sub={handlers:[],on(type,filter,callback){sub.handlers.push({filter,callback});return sub},subscribe(callback){subscriptions.push(sub);callback('SUBSCRIBED');return sub}};return sub},
      removeChannel(sub){const i=subscriptions.indexOf(sub);if(i>=0)subscriptions.splice(i,1)}
    };return client;
  }
  return {client,control};
}
const known=[
  {name:'Sol Ring',color_identity:[],set:'cmm',collector_number:'410',id:'10000000-0000-4000-8000-000000000001'},
  {name:'Demonic Tutor',color_identity:['B'],set:'cmm',collector_number:'150',id:'10000000-0000-4000-8000-000000000002'},
  {name:'Blood Artist',color_identity:['B'],set:'cmm',collector_number:'145',id:'10000000-0000-4000-8000-000000000003'}
];
async function startPage(f,backend,userId) {
  const source=await fs.readFile(path.join(root,'index.html'),'utf8');
  const dom=new JSDOM(source,{url:'https://wishclaw.test/',runScripts:'outside-only',pretendToBeVisual:true});
  const w=dom.window;
  w.HTMLDialogElement.prototype.showModal=function(){this.setAttribute('open','')};
  w.HTMLDialogElement.prototype.close=function(){this.removeAttribute('open')};
  w.confirm=()=>true;
  w.AbortController=AbortController;
  w.URL.createObjectURL=()=> 'blob:test';w.URL.revokeObjectURL=()=>{};
  w.fetch=async(url,options={})=>{
    url=String(url);
    if(url.startsWith('https://api.scryfall.com/')) {
      if(url.includes('autocomplete')) return {ok:true,json:async()=>({data:known.map(c=>c.name)})};
      if(url.includes('named?')) {const name=new URL(url).searchParams.get('exact');const card=known.find(c=>c.name.toLowerCase()===name.toLowerCase());return {ok:!!card,status:card?200:404,json:async()=>card}}
      if(url.endsWith('collection'))return {ok:true,json:async()=>({data:known})};
      return {ok:true,json:async()=>({data:known.map(c=>({...c,prices:{usd:'1.00'}})),has_more:false})};
    }
    const relative=new URL(url,w.location.href).pathname.slice(1);
    try{return {ok:true,json:async()=>JSON.parse(await fs.readFile(path.join(root,relative),'utf8'))}}catch{return {ok:false,status:404}}
  };
  const context=dom.getInternalVMContext();
  const modules=new Map();
  const fake=backend.client(userId);
  async function load(file){
    if(modules.has(file)) return modules.get(file);
    const module=new vm.SourceTextModule(await fs.readFile(file,'utf8'),{context,identifier:file});
    modules.set(file,module);
    await module.link(async(specifier,ref)=>{
      if(specifier.startsWith('https://')) return new vm.SyntheticModule(['createClient'],function(){this.setExport('createClient',()=>fake)},{context});
      return load(path.resolve(path.dirname(ref.identifier),specifier));
    });return module;
  }
  const main=await load(path.join(root,'app.js'));await main.evaluate();
  const get=id=>w.document.getElementById(id);
  const fill=(id,value)=>{get(id).value=value;get(id).dispatchEvent(new w.Event('input',{bubbles:true}))};
  const change=(id,value)=>{get(id).value=value;get(id).dispatchEvent(new w.Event('change',{bubbles:true}))};
  const submit=id=>get(id).dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));
  return {dom,w,get,fill,change,submit,modules};
}
async function main(){
  const f=await fixture();
  const pages=[];
  try {
    await databaseTests(f);
    const backend=adapter(f);
    const alice=await startPage(f,backend,ids.alice);pages.push(alice);
    const bob=await startPage(f,backend,ids.bob);pages.push(bob);
    const outsider=await startPage(f,backend,ids.outsider);pages.push(outsider);
    await until(()=>alice.get('syncState').textContent==='Live'&&bob.get('syncState').textContent==='Live','approved sessions');
    await until(()=>outsider.get('authError').textContent.includes('not approved'),'unapproved member');
    assert.equal(outsider.get('app').hidden,true);
    assert.match(alice.get('cardRows').textContent,/legacy acquisition/);
    const parser=alice.modules.get(path.join(root,'modules/card-data.js')).namespace;
    const parsed=parser.parseDecklist('Commander\n1 Sol Ring\n\nDeck\n1x Demonic Tutor\n2 Blood Artist\n1 Sol Ring (CMM) 396\n0 Invalid\n-2 Nope\nUnknown Heading');
    assert.equal(parsed.rows.length,7);assert.equal(parsed.rows[3].card.setCode,'cmm');assert.equal(parsed.rows[3].card.collectorNumber,'396');
    assert.ok(parsed.rows[4].error);assert.ok(parsed.rows[5].error);assert.equal(parsed.rows[6].card.name,'Unknown Heading');
    assert.throws(()=>parser.normalizeCards([{name:'Sol Ring',qty:1.5}]));
    assert.throws(()=>parser.normalizeCards([{name:'Sol Ring',colorIdentity:{}}]));
    assert.throws(()=>parser.mergeDuplicates([{name:'Sol Ring',qty:999},{name:'Sol Ring',qty:1}]));
    assert.equal(parser.mergeDuplicates([{name:'Sol Ring',qty:1},{name:'Sol Ring',qty:2}])[0].qty,3);
    assert.equal(parser.mergeDuplicates([{name:'Sol Ring',note:'A'},{name:'Sol Ring',note:'B'}]).length,2);
    console.log('PASS: parsing headings, malformed entries, printing metadata, structural validation and duplicate rules');

    alice.get('createList').click();alice.fill('newListName','Frontend empty');alice.submit('creationForm');
    await until(()=>!alice.get('createDialog').open&&alice.get('activeList').selectedOptions[0]?.textContent==='Frontend empty','empty list creation');
    assert.match(alice.get('cardRows').textContent,/no cards/);
    const emptyId=alice.get('activeList').value;
    await until(()=>[...bob.get('activeList').options].some(x=>x.value===emptyId),'list broadcast');bob.change('activeList',emptyId);
    await until(()=>bob.get('addCard').disabled===false,'second active list');

    alice.get('addCard').click();alice.fill('cardName','Sol Ring');alice.fill('cardQuantity','2');alice.fill('cardCategory','Main');alice.get('previewCard').click();
    await until(()=>alice.get('singleCardPreview').textContent.includes('recognized by Scryfall'),'single preview');
    alice.get('mergeExisting').click(); // changing duplicate policy must not invalidate preview
    alice.submit('addCardForm');
    await until(()=>!alice.get('addCardDialog').open&&alice.get('cardRows').textContent.includes('Sol Ring'),'card add');
    await until(()=>bob.get('cardRows').textContent.includes('Sol Ring'),'item broadcast');
    assert.equal(alice.get('cardRows').querySelectorAll('tr[data-id]').length,1);
    alice.get('addCard').click();alice.fill('cardName','Sol Ring');alice.fill('cardQuantity','2');alice.fill('cardCategory','Main');alice.get('previewCard').click();
    await until(()=>alice.get('singleCardPreview').textContent.includes('recognized by Scryfall'),'duplicate preview');
    backend.control.failNext=true;alice.submit('addCardForm');
    await until(()=>alice.get('cardMessage').textContent.includes('Could not add card'),'failed add');
    assert.equal(alice.get('addCardDialog').open,true);
    alice.submit('addCardForm');await until(()=>!alice.get('addCardDialog').open,'merged add');
    assert.equal(alice.get('cardRows').querySelectorAll('tr[data-id]').length,1);
    assert.equal(alice.get('cardRows').querySelector('tr[data-id]').children[1].textContent,'4');
    alice.get('cardRows').querySelector('.check').click();
    await until(()=>alice.get('cardRows').textContent.includes('marked by Alice')&&bob.get('cardRows').textContent.includes('marked by Alice'),'Alice attribution broadcast');
    bob.get('cardRows').querySelector('.check').click();
    await until(()=>!alice.get('cardRows').textContent.includes('Acquired')&&!bob.get('cardRows').textContent.includes('Acquired'),'uncheck broadcast');
    bob.get('cardRows').querySelector('.check').click();
    await until(()=>alice.get('cardRows').textContent.includes('marked by Bob'),'Bob attribution');
    alice.fill('displayName','Alice New');alice.submit('profileForm');
    await until(()=>alice.get('profileStatus').textContent.includes('saved'),'profile save');

    backend.control.failNext=true;alice.get('cardRows').querySelector('.delete-item').click();
    await until(()=>alice.get('status').textContent.includes('Remove failed'),'failed delete');
    assert.equal(alice.get('cardRows').querySelectorAll('tr[data-id]').length,1);
    alice.get('cardRows').querySelector('.delete-item').click();
    await until(()=>!alice.get('cardRows').querySelector('tr[data-id]')&&!bob.get('cardRows').querySelector('tr[data-id]'),'delete broadcast');
    console.log('PASS: empty creation, preview/add/remove, failed delete, two-user purchase/unpurchase and profile workflows (DOM + local PostgreSQL; simulated Realtime transport)');

    alice.get('createList').click();alice.fill('newListName','Pasted list');alice.change('creationMethod','paste');
    alice.fill('decklistText','Deck\n1 Sol Ring\n2 Sol Ring\n1 Unrecognized Card');alice.get('parseDecklist').click();alice.get('validateDecklist').click();
    await until(()=>alice.get('creationMessage').textContent.includes('entries recognized'),'deck validation');
    assert.match(alice.get('creationPreview').textContent,/Unrecognized/);
    alice.submit('creationForm');await delay(20);assert.equal(alice.get('createDialog').open,true);
    const correction=alice.get('creationPreview').querySelector('[data-index="2"] [data-field="name"]');correction.value='Demonic Tutor';correction.dispatchEvent(new alice.w.Event('input',{bubbles:true}));
    alice.get('validateDecklist').click();await until(()=>alice.get('creationMessage').textContent.startsWith('3 / 3'),'correction validation');
    alice.submit('creationForm');await until(()=>!alice.get('createDialog').open,'pasted save');
    assert.equal(alice.get('cardRows').querySelectorAll('tr[data-id]').length,2);
    const solRow=[...alice.get('cardRows').querySelectorAll('tr[data-id]')].find(row=>row.textContent.includes('Sol Ring'));
    assert.equal(solRow.children[1].textContent,'3');
    alice.change('sortOrder','color');alice.fill('search','Sol Ring');
    assert.equal(alice.get('cardRows').querySelectorAll('tr[data-id]:not(.hidden)').length,1);
    alice.fill('search','');

    alice.get('createList').click();alice.change('creationMethod','json');
    Object.defineProperty(alice.get('newListFile'),'files',{configurable:true,value:[{size:200,name:'test.json',text:async()=>JSON.stringify({name:'JSON imported',cards:[{name:'Blood Artist',qty:2,deck:'Elas',note:'Foil preferred',colorIdentity:['B']}]})}]});
    alice.get('newListFile').dispatchEvent(new alice.w.Event('change',{bubbles:true}));
    await until(()=>alice.get('creationPreview').querySelectorAll('fieldset').length===1,'JSON preview');
    alice.get('allowUnverified').checked=true;alice.submit('creationForm');await until(()=>!alice.get('createDialog').open,'JSON save');
    assert.match(alice.get('cardRows').textContent,/Blood Artist/);
    // Existing hosted template goes through the same review dialog, with no prompt-based upload.
    await until(()=>alice.get('hostedListSelect').options.length>1,'hosted catalog');alice.change('hostedListSelect','0');alice.get('loadHostedList').click();
    await until(()=>alice.get('createDialog').open,'hosted preview');assert.ok(alice.get('creationPreview').querySelectorAll('fieldset').length>1);
    alice.get('createDialog').querySelector('[data-close]').click();
    // Failed create leaves the review open and does not falsely add a list.
    const count=alice.get('activeList').options.length;
    alice.get('createList').click();alice.fill('newListName','Should not exist');backend.control.failNext=true;alice.submit('creationForm');
    await until(()=>alice.get('creationMessage').textContent.includes('Could not create'),'create failure');assert.equal(alice.get('activeList').options.length,count);
    alice.get('createDialog').querySelector('[data-close]').click();
    console.log('PASS: pasted corrections, preview merging, JSON import, hosted templates, searching/sorting and failed creation');
    const legacy=(await f.asUser(ids.alice,'SELECT * FROM shopping_list_items WHERE id=$1',[f.legacy.id])).rows[0];
    assert.equal(legacy.purchased,true);assert.equal(legacy.estimated_price,'12.34');assert.equal(legacy.purchased_by,null);
    for(const file of ['app.js','modules/card-data.js','modules/list-tools.js','modules/scryfall.js','modules/list-repository.js']) new vm.SourceTextModule(await fs.readFile(path.join(root,file),'utf8'));
    const html=await fs.readFile(path.join(root,'index.html'),'utf8');
    const idList=[...html.matchAll(/\bid="([^"]+)"/g)].map(m=>m[1]);assert.equal(idList.length,new Set(idList).size,'duplicate IDs');
    for(const file of ['app.js','modules/list-tools.js']) {
      const source=await fs.readFile(path.join(root,file),'utf8');
      for(const match of source.matchAll(/\$\('([^']+)'\)/g)) assert.ok(idList.includes(match[1]),'Missing element '+match[1]);
    }
    console.log('PASS: ES-module syntax, all literal element references, unique IDs, and legacy data after workflows');
    console.log('NOT VERIFIED: real browser layout/keyboard behavior, live Scryfall, Supabase HTTP/Auth/Realtime delivery. See ACCEPTANCE.md.');
  }finally{pages.forEach(p=>p.dom.window.close());await f.db.close()}
}
main().catch(error=>{console.error(error);process.exitCode=1});
