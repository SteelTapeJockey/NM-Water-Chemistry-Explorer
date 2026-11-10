(async function(){
'use strict';
/* ==================================================================== */
/* 1. Analytes and standards                                            */
/* ==================================================================== */
// eq: equivalent weight (mg per meq) for major ions, used for Piper / charge balance.
const ANALYTES = [
  {key:'arsenic',   sym:'As',    name:'Arsenic',     group:'Health-based', epa:{v:0.010,k:'MCL'},  nm:{v:0.010}},
  {key:'uranium',   sym:'U',     name:'Uranium',     group:'Health-based', epa:{v:0.030,k:'MCL'},  nm:{v:0.030}},
  {key:'nitrate',   sym:'NO₃',   name:'Nitrate',     group:'Health-based', epa:{v:10,k:'MCL, as N'}, nm:{v:10}},
  {key:'fluoride',  sym:'F',     name:'Fluoride',    group:'Health-based', epa:{v:4.0,k:'MCL'},    nm:{v:1.6}},
  {key:'tds',       sym:'TDS',   name:'Total dissolved solids', group:'Salinity', epa:{v:500,k:'SMCL'}, nm:{v:1000}},
  {key:'sulfate',   sym:'SO₄',   name:'Sulfate',     group:'Salinity',     epa:{v:250,k:'SMCL'},   nm:{v:600},  eq:48.03, ion:'an'},
  {key:'chloride',  sym:'Cl',    name:'Chloride',    group:'Salinity',     epa:{v:250,k:'SMCL'},   nm:{v:250},  eq:35.45, ion:'an'},
  {key:'calcium',   sym:'Ca',    name:'Calcium',     group:'Major ions', eq:20.04, ion:'cat'},
  {key:'magnesium', sym:'Mg',    name:'Magnesium',   group:'Major ions', eq:12.15, ion:'cat'},
  {key:'sodium',    sym:'Na',    name:'Sodium',      group:'Major ions', eq:22.99, ion:'cat'},
  {key:'potassium', sym:'K',     name:'Potassium',   group:'Major ions', eq:39.10, ion:'cat'},
  {key:'bicarbonate',sym:'HCO₃', name:'Bicarbonate', group:'Major ions', eq:61.02, ion:'an'},
  {key:'carbonate', sym:'CO₃',   name:'Carbonate',   group:'Major ions', eq:30.00, ion:'an'}
];
const AN = Object.fromEntries(ANALYTES.map(a=>[a.key,a]));
const UNIT = 'mg/L';
const STD_LABEL = {epa:'EPA drinking water', nm:'NM groundwater standard'};

/* ==================================================================== */
/* 2. API access (same pattern as the hydrograph explorer)             */
/* ==================================================================== */
// Built-in data: from data/*.js when the page is deployed as a folder, or from a JSON block in this file when it is a single file
function builtIn(id){ if(window.NMWQ_DATA && window.NMWQ_DATA[id]) return window.NMWQ_DATA[id]; const el = document.getElementById(id); return el ? JSON.parse(el.textContent) : null; }
const API_BASE = 'https://die-pygeoapi-95715287188.us-central1.run.app';
const API_PAGE = 10000;
const CACHE_KEY = 'wq-summaries-v1', CACHE_TTL = 24*3600*1000;
const sleep = ms => new Promise(r=>setTimeout(r, ms));
async function apiFetch(url, tries){
  tries = tries || 4; let lastErr;
  for(let a=0; a<tries; a++){
    try{
      const r = await fetch(url, a > 0 ? {cache:'no-store'} : undefined);
      if(r.status === 429 || r.status >= 500){ lastErr = new Error('HTTP '+r.status); await sleep(600*Math.pow(2,a)); continue; }
      if(!r.ok) throw new Error('HTTP '+r.status);
      return r;
    }catch(e){ lastErr = e; if(a < tries-1) await sleep(600*Math.pow(2,a)); }
  }
  throw lastErr || new Error('API unavailable');
}
async function apiJson(path, params){ const r = await apiFetch(API_BASE + path + '?' + new URLSearchParams(params)); return r.json(); }
async function apiPool(tasks, n, onDone){
  let next = 0, done = 0; const res = new Array(tasks.length);
  async function worker(){ while(next < tasks.length){ const k = next++; res[k] = await tasks[k](); done++; if(onDone) onDone(done, tasks.length); } }
  await Promise.all(Array.from({length:Math.min(n, tasks.length)}, worker));
  return res;
}
// Every feature of a collection. The service sometimes answers 200 with an empty first page while warming up.
async function apiFeatures(coll, params, onProgress, opts){
  opts = opts || {};
  const base = Object.assign({f:'json', limit:API_PAGE}, opts.geometry ? {} : {skipGeometry:'true'}, params || {});
  let p0 = null;
  for(let a=0; a<3; a++){
    p0 = await apiJson('/collections/'+coll+'/items', Object.assign({offset:0}, base));
    if(p0 && p0.features && p0.features.length) break;
    await sleep(1200*(a+1));
  }
  if(!p0 || !p0.features) throw new Error('No feature list from ' + coll);
  const feats = p0.features.slice();
  const total = p0.numberMatched != null ? p0.numberMatched : feats.length;
  if(onProgress) onProgress(feats.length, total);
  if(feats.length > 0 && feats.length < total){
    const step = feats.length, offs = [];
    for(let o=step; o<total; o+=step) offs.push(o);
    let got = feats.length;
    const pages = await apiPool(offs.map(o=>async()=>{
      const p = await apiJson('/collections/'+coll+'/items', Object.assign({}, base, {offset:o}));
      got += (p.features||[]).length; if(onProgress) onProgress(got, total); return p;
    }), 3);
    pages.forEach(p=>{ for(const f of (p.features||[])) feats.push(f); });
  }
  return feats;
}

/* ---- IndexedDB cache (best effort) ---- */
function idb(){ return new Promise((res,rej)=>{ try{ const r = indexedDB.open('nm-wq-explorer', 1); r.onupgradeneeded = ()=>r.result.createObjectStore('kv'); r.onsuccess = ()=>res(r.result); r.onerror = ()=>rej(r.error); }catch(e){ rej(e); } }); }
async function idbGet(k){ try{ const db = await idb(); return await new Promise((res)=>{ const t = db.transaction('kv').objectStore('kv').get(k); t.onsuccess = ()=>res(t.result); t.onerror = ()=>res(null); }); }catch(e){ return null; } }
async function idbSet(k, v){ try{ const db = await idb(); await new Promise((res)=>{ const t = db.transaction('kv','readwrite'); t.objectStore('kv').put(v, k); t.oncomplete = res; t.onerror = res; }); }catch(e){} }
async function idbDel(k){ try{ const db = await idb(); await new Promise((res)=>{ const t = db.transaction('kv','readwrite'); t.objectStore('kv').delete(k); t.oncomplete = res; t.onerror = res; }); }catch(e){} }

/* ==================================================================== */
/* 3. Boot: load all analyte summaries and join them per well           */
/* ==================================================================== */
const $ = id => document.getElementById(id);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const ls = {get(k){ try{ return localStorage.getItem(k); }catch(e){ return null; } }, set(k,v){ try{ localStorage.setItem(k,v); }catch(e){} }};

// theme first so the boot card matches
let theme = ls.get('wq-theme') || (window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
document.documentElement.setAttribute('data-theme', theme);

const bootUI = {
  set(msg, frac, detail){ $('boot-msg').textContent = msg; if(frac != null) $('boot-bar').style.width = Math.round(Math.min(1,frac)*100) + '%'; if(detail != null) $('boot-detail').textContent = detail; },
  list(st){ $('boot-list').innerHTML = ANALYTES.map(a=>`<span class="${st[a.key]||''}">${st[a.key]==='done'?'✓':st[a.key]==='fail'?'✕':'·'} ${a.name}</span>`).join(''); },
  done(){ $('boot').remove(); },
  fail(e){ $('boot-msg').textContent = 'Could not load the data'; $('boot-detail').textContent = String(e && e.message || e); $('boot-actions').innerHTML = '<button class="btn primary" onclick="location.reload()">Try again</button>'; }
};

const SUM_PROPS = 'source,id,name,usgs_site_id,well_depth,nrecords,min,max,mean,latest_value,latest_units,latest_date,earliest_date';
function toMg(v, units){ if(v == null || v === '' || isNaN(+v)) return null; v = +v; const u = String(units||'').toLowerCase(); if(/^(ug|µg|μg)\/l/.test(u)) v *= 0.001; return v; }

async function loadFromApi(){
  const st = {}; bootUI.list(st);
  const wells = new Map(); const failed = [];
  let doneCount = 0; const frac = {};
  const upd = ()=>{ const f = ANALYTES.reduce((s,a)=>s + (frac[a.key]||0), 0) / ANALYTES.length; bootUI.set('Loading well summaries…', 0.02 + 0.96*f, doneCount + ' of ' + ANALYTES.length + ' analytes'); };
  await apiPool(ANALYTES.map(a=>async()=>{
    st[a.key] = '';
    try{
      const feats = await apiFeatures('nm_' + a.key + '_summary', {properties:SUM_PROPS}, (g,t)=>{ frac[a.key] = t ? g/t : 1; upd(); }, {geometry:true});
      for(const f of feats){
        const p = f.properties || {}, c = f.geometry && f.geometry.coordinates; if(!c) continue;
        const k = p.source + ':' + p.id;
        let w = wells.get(k);
        if(!w){ w = {k, source:p.source, id:String(p.id), name:p.name || String(p.id), lng:+c[0], lat:+c[1], elev:c[2] != null ? +c[2] : null, depth:p.well_depth != null ? +p.well_depth : null, usgs:p.usgs_site_id || '', a:{}}; wells.set(k, w); }
        if(w.depth == null && p.well_depth != null) w.depth = +p.well_depth;
        if(!w.usgs && p.usgs_site_id) w.usgs = p.usgs_site_id;
        const u = p.latest_units;
        w.a[a.key] = {n:p.nrecords != null ? +p.nrecords : null, min:toMg(p.min,u), max:toMg(p.max,u), mean:toMg(p.mean,u), last:toMg(p.latest_value,u), d1:p.earliest_date || null, d2:p.latest_date || null};
      }
      st[a.key] = 'done';
    }catch(e){ console.warn(a.key, e); st[a.key] = 'fail'; failed.push(a.name); }
    frac[a.key] = 1; doneCount++; upd(); bootUI.list(st);
  }), 3);
  if(!wells.size) throw new Error('The API returned no wells' + (failed.length ? ' (failed: ' + failed.join(', ') + ')' : ''));
  return {wells:[...wells.values()], failed, t:Date.now()};
}

let DATA = null, fromCache = false;
try{
  bootUI.set('Checking saved copy…', 0.01);
  const cached = await idbGet(CACHE_KEY);
  if(cached && cached.wells && cached.wells.length && Date.now() - cached.t < CACHE_TTL && !(cached.failed||[]).length){ DATA = cached; fromCache = true; }
  if(!DATA){
    // saved before anything else touches the wells, so WQP additions never leak into the API copy
    try{ DATA = await loadFromApi(); await idbSet(CACHE_KEY, DATA); }
    catch(e){ if(cached && cached.wells){ DATA = cached; fromCache = 'stale'; } else throw e; }
  }
}catch(e){ console.error(e); bootUI.fail(e); return; }

const WELLS = DATA.wells;
// derived: major-ion meq, water type, charge balance
function derive(w){
  const g = k => w.a[k] && w.a[k].last != null ? w.a[k].last : null;
  const ca=g('calcium'), mg=g('magnesium'), na=g('sodium'), k_=g('potassium'), hco3=g('bicarbonate'), co3=g('carbonate'), cl=g('chloride'), so4=g('sulfate');
  w.fac = null; w.cbe = null; w.pip = null;
  if(ca!=null && mg!=null && na!=null && hco3!=null && cl!=null && so4!=null){
    const m = {ca:ca/20.04, mg:mg/12.15, nak:na/22.99 + (k_||0)/39.10, alk:hco3/61.02 + (co3||0)/30.00, cl:cl/35.45, so4:so4/48.03};
    const cat = m.ca + m.mg + m.nak, an = m.alk + m.cl + m.so4;
    if(cat > 0 && an > 0){
      w.cbe = (cat - an) / (cat + an) * 100;
      w.pip = {ca:100*m.ca/cat, mg:100*m.mg/cat, nak:100*m.nak/cat, alk:100*m.alk/an, cl:100*m.cl/an, so4:100*m.so4/an};
      const dc = w.pip.ca > 50 ? 'Ca' : w.pip.mg > 50 ? 'Mg' : w.pip.nak > 50 ? 'Na' : 'Mixed';
      const da = w.pip.alk > 50 ? 'HCO₃' : w.pip.so4 > 50 ? 'SO₄' : w.pip.cl > 50 ? 'Cl' : 'Mixed';
      w.fac = dc === 'Mixed' && da === 'Mixed' ? 'Mixed' : dc + '–' + da;
    }
  }
  let ly = null; for(const k in w.a){ const d = w.a[k].d2; if(d){ const y = +d.slice(0,4); if(ly == null || y > ly) ly = y; } }
  w.lastYr = ly;
}
WELLS.forEach(derive);
const SOURCES = [...new Set(WELLS.map(w=>w.source))].sort();
const SRC_COLORS = ['#0f6e63','#2f7fc1','#c9a227','#a26bc2','#7a9c3f','#c25d8f','#5a8f8c','#e08a3c','#6b7fd4','#c1652f','#8a7d5a','#3e8f5e'];
const srcColor = s => SRC_COLORS[SOURCES.indexOf(s) % SRC_COLORS.length];

/* ==================================================================== */
/* 4. State, values and classes                                         */
/* ==================================================================== */
const state = {
  analyte: ls.get('wq-analyte') && AN[ls.get('wq-analyte')] ? ls.get('wq-analyte') : 'arsenic',
  noAnalyte: true, wellsOn: ls.get('wq-wells') !== 'off',
  basis:'latest', std: ls.get('wq-std') === 'nm' ? 'nm' : 'epa', colorBy:'value',
  conc:{min:null,max:null}, exceed:'all',
  sources:new Set(SOURCES), depth:{min:null,max:null,req:false}, year:{from:null,to:null}, minN:1, cbeOnly:false, showMissing:false,
  area:null, drawing:false, drawPts:[], dtab:'summary', piperColor:'facies', wellSort:{k:'val', d:-1},
  dw:{gw:false, sw:false, off:false}, dwType:'all'
};
function val(w, key, basis){ const a = w.a[key || state.analyte]; if(!a) return null; const b = basis || state.basis; return b === 'max' ? a.max : b === 'mean' ? a.mean : a.last; }
function stdOf(key){ const a = AN[key || state.analyte], s = a && a[state.std]; return s ? s.v : null; }
function stdKind(key){ const a = AN[key], s = a && a[state.std]; return s ? (state.std === 'epa' ? s.k : 'NM std') : ''; }
function cssVar(n){ return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); }
function fmt(v, key){
  if(v == null || isNaN(v)) return '–';
  const a = Math.abs(v);
  if(a === 0) return '0';
  if(a >= 1000) return Math.round(v).toLocaleString();
  if(a >= 100) return v.toFixed(0);
  if(a >= 10) return v.toFixed(1);
  if(a >= 1) return v.toFixed(2);
  if(a >= 0.01) return v.toFixed(3);
  return v.toPrecision(2);
}
const isWqp = (w, key) => !!(w.a[key] && w.a[key].src === 'wqp');
const wqpTag = '<span class="tag-wqp" title="From the Water Quality Portal">wqp</span>';
// quantile breaks for analytes without a standard (computed once per analyte + basis)
const QCACHE = new Map();
function qBreaks(key, basis){
  const ck = key + '|' + basis; if(QCACHE.has(ck)) return QCACHE.get(ck);
  const vs = WELLS.map(w=>val(w,key,basis)).filter(v=>v != null && v > 0).sort((a,b)=>a-b);
  const q = p => vs.length ? vs[Math.min(vs.length-1, Math.floor(p*vs.length))] : 0;
  const br = [q(.2), q(.4), q(.6), q(.8)]; QCACHE.set(ck, br); return br;
}
const SEQ = ['#cfe6df','#93c8b8','#56a690','#2a8270','#0d5249'];
const SEQ_DARK = ['#1f3d36','#2d6658','#3f907b','#64b9a1','#a8e0cf'];
function seq(){ return theme === 'dark' ? SEQ_DARK : SEQ; }
// value class: returns [classIndex, color, label]
function valueClass(w){
  const v = val(w); if(v == null) return null;
  const s = stdOf();
  if(s != null){
    if(v > 2*s) return [3, cssVar('--c-over2'), '> 2× standard'];
    if(v > s) return [2, cssVar('--c-over'), 'Above standard'];
    if(v >= 0.5*s) return [1, cssVar('--c-mid'), '50–100% of standard'];
    return [0, cssVar('--c-low'), '< 50% of standard'];
  }
  const br = qBreaks(state.analyte, state.basis); let i = 0; while(i < 4 && v > br[i]) i++;
  return [i, seq()[i], null];
}
function valueLegend(){
  const s = stdOf();
  if(s != null) return [['< 50% of standard','--c-low'],['50–100% of standard','--c-mid'],['Above standard','--c-over'],['> 2× standard','--c-over2']].map((r,i)=>[i, cssVar(r[1]), r[0] + (i===0 ? ' (< ' + fmt(0.5*s) + ')' : i===2 ? ' (> ' + fmt(s) + ')' : '')]);
  const br = qBreaks(state.analyte, state.basis), c = seq();
  return [0,1,2,3,4].map(i=>[i, c[i], i===0 ? '≤ ' + fmt(br[0]) : i===4 ? '> ' + fmt(br[3]) : fmt(br[i-1]) + ' – ' + fmt(br[i])]);
}
const FACIES_COLORS = {'Ca–HCO₃':'#2f7fc1','Mg–HCO₃':'#5a9c8c','Na–HCO₃':'#7a9c3f','Mixed–HCO₃':'#6fa9de','Ca–SO₄':'#c9a227','Mg–SO₄':'#a8892a','Na–SO₄':'#e08a3c','Mixed–SO₄':'#d4b25a','Ca–Cl':'#a26bc2','Mg–Cl':'#8a5fa8','Na–Cl':'#c1652f','Mixed–Cl':'#c25d8f','Ca–Mixed':'#4f8fb8','Mg–Mixed':'#6b8f86','Na–Mixed':'#b07a4a','Mixed':'#8d968a'};
const FACIES_ORDER = Object.keys(FACIES_COLORS);
const facColor = f => FACIES_COLORS[f] || '#8d968a';

/* API indicator layers (loaded only when picked) */
const API_LAYERS = {
  mcl:{label:'MCL exceedances', coll:'nm_mcl_exceedance', props:'any_exceedance,exceedance_count', val:p=>p.any_exceedance==null ? null : (!p.any_exceedance ? 'no exceedance' : (p.exceedance_count>=3 ? '3+ exceedances' : p.exceedance_count + (p.exceedance_count===1 ? ' exceedance' : ' exceedances')))},
  tds:{label:'TDS class', coll:'nm_tds_summary', props:'tds_class', val:p=>p.tds_class},
  hard:{label:'Hardness class', coll:'nm_hardness', props:'hardness_class', val:p=>p.hardness_class},
  type:{label:'Water type (API)', coll:'nm_water_type', props:'water_type', val:p=>p.water_type},
  sar:{label:'Sodium adsorption ratio', coll:'nm_sar', props:'sar_class', val:p=>p.sar_class},
  wqi:{label:'Water quality index (CCME)', coll:'nm_wqi', props:'wqi_class', val:p=>p.wqi_class}
};
const API_CAT_COLORS = {'fresh':'#2f7fc1','brackish':'#c9a227','saline':'#c1652f','brine':'#6e1d1d','soft':'#2f7fc1','moderate':'#5a9c8c','moderately hard':'#5a9c8c','hard':'#c9a227','very hard':'#c1652f','low':'#2f7fc1','medium':'#c9a227','high':'#e08a3c','very high':'#c1652f','excellent':'#2f7fc1','good':'#5a9c8c','fair':'#c9a227','marginal':'#e08a3c','poor':'#c1652f','no exceedance':'#2f7fc1','1 exceedance':'#c9a227','2 exceedances':'#e08a3c','3+ exceedances':'#c1652f'};
const API_ORDER = ['fresh','brackish','saline','brine','soft','moderate','moderately hard','hard','very hard','low','medium','high','very high','excellent','good','fair','marginal','poor','no exceedance','1 exceedance','2 exceedances','3+ exceedances'];
const API_FALLBACK = ['#0f6e63','#2f7fc1','#c9a227','#a26bc2','#7a9c3f','#c25d8f','#5a8f8c','#e08a3c','#6b7fd4','#c1652f'];
const apiLayers = {};
async function loadApiLayer(id){
  if(apiLayers[id] && apiLayers[id].map) return apiLayers[id];
  if(apiLayers[id] && apiLayers[id].promise) return apiLayers[id].promise;
  const spec = API_LAYERS[id];
  const promise = (async()=>{
    const feats = await apiFeatures(spec.coll, {properties:'source,id,' + spec.props});
    const m = new Map(), counts = new Map();
    for(const f of feats){ const p = f.properties; const c = spec.val(p); if(c == null || c === '') continue; const cs = String(c); m.set(p.source + ':' + p.id, cs); counts.set(cs, (counts.get(cs)||0)+1); }
    const order = [...counts.keys()].sort((a,b)=>{ const ia = API_ORDER.indexOf(a.toLowerCase()), ib = API_ORDER.indexOf(b.toLowerCase()); if(ia>=0 && ib>=0) return ia-ib; if(ia>=0) return -1; if(ib>=0) return 1; return counts.get(b)-counts.get(a); });
    const colors = new Map(); let fb = 0; order.forEach(c=>colors.set(c, API_CAT_COLORS[c.toLowerCase()] || API_FALLBACK[fb++ % API_FALLBACK.length]));
    const res = {map:m, order, colors}; apiLayers[id] = res; return res;
  })();
  apiLayers[id] = {promise};
  try{ return await promise; }catch(e){ delete apiLayers[id]; throw e; }
}

/* color + draw order for a well under the current mode */
function styleOf(w){
  const none = cssVar('--c-none');
  if(!w.a[state.analyte] && ['value','nsamples','recency'].includes(state.colorBy)) return {c:none, z:-1};
  switch(state.colorBy){
    case 'value': { const c = valueClass(w); return c ? {c:c[1], z:c[0]} : {c:none, z:-1}; }
    case 'nsamples': { const n = w.a[state.analyte].n || 0; const i = n <= 1 ? 0 : n <= 3 ? 1 : n <= 10 ? 2 : n <= 30 ? 3 : 4; return {c:seq()[i], z:i}; }
    case 'recency': { const d = w.a[state.analyte].d2; const y = d ? +d.slice(0,4) : 0; const i = y >= 2020 ? 4 : y >= 2010 ? 3 : y >= 2000 ? 2 : y >= 1990 ? 1 : 0; return {c:seq()[i], z:i}; }
    case 'facies': return w.fac ? {c:facColor(w.fac), z:1} : {c:none, z:-1};
    case 'cbe': { if(w.cbe == null) return {c:none, z:-1}; const a = Math.abs(w.cbe); return a <= 5 ? {c:cssVar('--c-low'), z:0} : a <= 10 ? {c:cssVar('--c-mid'), z:1} : {c:cssVar('--c-over'), z:2}; }
    case 'source': return {c:srcColor(w.source), z:0};
    case 'depth': { if(w.depth == null) return {c:none, z:-1}; const d = w.depth; const i = d < 100 ? 0 : d < 300 ? 1 : d < 600 ? 2 : d < 1200 ? 3 : 4; return {c:seq()[i], z:0}; }
    default: if(state.colorBy.startsWith('api:')){ const L_ = apiLayers[state.colorBy.slice(4)]; if(!L_ || !L_.map) return {c:none, z:-1}; const c = L_.map.get(w.k); return c == null ? {c:none, z:-1} : {c:L_.colors.get(c), z:1}; }
  }
  return {c:none, z:0};
}

/* ==================================================================== */
/* 5. Filtering and area selection                                      */
/* ==================================================================== */
function passBase(w){
  if(!state.sources.has(w.source)) return false;
  const d = state.depth;
  if(d.req && w.depth == null) return false;
  if(d.min != null && (w.depth == null || w.depth < d.min)) return false;
  if(d.max != null && (w.depth == null || w.depth > d.max)) return false;
  if(state.cbeOnly && (w.cbe == null || Math.abs(w.cbe) > 10)) return false;
  return true;
}
function passAnalyte(w){
  const a = w.a[state.analyte]; if(!a) return false;
  const y = a.d2 ? +a.d2.slice(0,4) : null;
  if(state.year.from != null && (y == null || y < state.year.from)) return false;
  if(state.year.to != null && (y == null || y > state.year.to)) return false;
  if(state.minN > 1 && (a.n || 0) < state.minN) return false;
  const v = val(w);
  if(state.conc.min != null && (v == null || v < state.conc.min)) return false;
  if(state.conc.max != null && (v == null || v > state.conc.max)) return false;
  if(state.exceed !== 'all'){ const s = stdOf(); if(s == null || v == null) return false; if(state.exceed === 'over' ? !(v > s) : !(v <= s)) return false; }
  return true;
}
function isVisible(w){ if(!passBase(w)) return false; if(passAnalyte(w)) return true; return state.showMissing && !w.a[state.analyte]; }
function ringContains(ring, x, y){ let inside = false; for(let i=0, j=ring.length-1; i<ring.length; j=i++){ const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1]; if(((yi > y) !== (yj > y)) && (x < (xj-xi)*(y-yi)/(yj-yi) + xi)) inside = !inside; } return inside; }
function inArea(w){
  const A = state.area; if(!A) return true;
  if(w.lng < A.bb[0] || w.lng > A.bb[2] || w.lat < A.bb[1] || w.lat > A.bb[3]) return false;
  for(const poly of A.polys){ if(ringContains(poly[0], w.lng, w.lat)){ let hole = false; for(let h=1; h<poly.length; h++) if(ringContains(poly[h], w.lng, w.lat)){ hole = true; break; } if(!hole) return true; } }
  return false;
}
let VIS = [], SCOPE = [];
function recompute(){
  VIS = state.noAnalyte ? WELLS.filter(passBase) : WELLS.filter(isVisible);
  SCOPE = state.area ? VIS.filter(inArea) : VIS;
}

/* ==================================================================== */
/* 6. Map with canvas point layers (fast for ~50k wells)                */
/* ==================================================================== */
const map = L.map('map', {preferCanvas:true, zoomControl:true}).setView([34.4, -106.1], 7);
const BASEMAPS = {
  light: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}',
  dark: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}',
  topo: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}',
  imagery: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'
};
let baseKey = ls.get('wq-basemap') || 'topo', baseLayer = null;
function setBasemap(){
  if(baseLayer) map.removeLayer(baseLayer);
  const k = baseKey === 'light' && theme === 'dark' ? 'dark' : baseKey;
  baseLayer = L.tileLayer(BASEMAPS[k], {maxZoom:k === 'topo' || k === 'imagery' ? 19 : 16, attribution:'Esri and contributors · Data: NM Unified Water Data API, Water Quality Portal, NMED DWB'}).addTo(map);
}
$('basemap-select').value = baseKey; setBasemap();
$('basemap-select').addEventListener('change', e=>{ baseKey = e.target.value; ls.set('wq-basemap', baseKey); setBasemap(); });

const refPane = map.createPane('refPane'); refPane.style.zIndex = 420; refPane.style.pointerEvents = 'none';
const selPane = map.createPane('selPane'); selPane.style.zIndex = 430; selPane.style.pointerEvents = 'none';

// items: {w:{lat,lng}, c:color, z:order, sq?:diamond marker}
const PointLayer = L.Layer.extend({
  onAdd(m){
    this._m = m; this._c = L.DomUtil.create('canvas', 'wq-points'); this._c.style.position = 'absolute'; this._c.style.pointerEvents = 'none';
    m.getPanes().overlayPane.appendChild(this._c);
    m.on('moveend resize viewreset', this.redraw, this);
    m.on('move', this._onMove, this);
    m.on('zoomstart', ()=>{ this._c.style.visibility = 'hidden'; });
    m.on('zoomend', ()=>{ this._c.style.visibility = ''; this.redraw(); });
    this.redraw();
  },
  _onMove(){ if(this._raf) return; this._raf = requestAnimationFrame(()=>{ this._raf = null; this.redraw(); }); },
  setData(list){ this._list = list; this.redraw(); },
  redraw(){
    const m = this._m; if(!m) return;
    const size = m.getSize(), dpr = window.devicePixelRatio || 1, c = this._c;
    const tl = m.containerPointToLayerPoint([0,0]); L.DomUtil.setPosition(c, tl);
    if(c.width !== size.x*dpr || c.height !== size.y*dpr){ c.width = size.x*dpr; c.height = size.y*dpr; c.style.width = size.x + 'px'; c.style.height = size.y + 'px'; }
    const ctx = c.getContext('2d'); ctx.setTransform(dpr,0,0,dpr,0,0); ctx.clearRect(0,0,size.x,size.y);
    const list = this._list || []; const z = m.getZoom(); const r = z <= 6 ? 2.6 : z <= 8 ? 3.4 : z <= 10 ? 4.4 : 5.6;
    const xs = new Float32Array(list.length), ys = new Float32Array(list.length);
    const stroke = theme === 'dark' ? 'rgba(0,0,0,.55)' : 'rgba(255,255,255,.85)';
    ctx.lineWidth = r > 3 ? 1 : .6; ctx.strokeStyle = stroke;
    let lastC = null;
    const ringFill = theme === 'dark' ? 'rgba(16,22,15,.8)' : 'rgba(255,255,255,.85)';
    for(let i=0; i<list.length; i++){
      const it = list[i], p = m.latLngToContainerPoint([it.w.lat, it.w.lng]);
      xs[i] = p.x; ys[i] = p.y;
      if(p.x < -10 || p.y < -10 || p.x > size.x+10 || p.y > size.y+10) continue;
      if(it.ring){   // WQP sites: open rings colored by site type
        ctx.save(); if(it.dim) ctx.globalAlpha = .2;
        ctx.beginPath(); ctx.arc(p.x, p.y, r*.95, 0, 6.2832); ctx.fillStyle = ringFill; ctx.fill();
        ctx.lineWidth = Math.max(1.5, r*.5); ctx.strokeStyle = it.c; ctx.stroke(); ctx.restore(); lastC = null; continue;
      }
      if(it.c !== lastC){ ctx.fillStyle = it.c; lastC = it.c; }
      ctx.beginPath();
      if(it.tri){ const s = r*1.35; ctx.moveTo(p.x, p.y - s); ctx.lineTo(p.x + s*.95, p.y + s*.75); ctx.lineTo(p.x - s*.95, p.y + s*.75); ctx.closePath(); }
      else if(it.sq){ const s = r*1.25; ctx.moveTo(p.x, p.y - s); ctx.lineTo(p.x + s, p.y); ctx.lineTo(p.x, p.y + s); ctx.lineTo(p.x - s, p.y); ctx.closePath(); }
      else ctx.arc(p.x, p.y, it.z < 0 ? r*0.75 : r, 0, 6.2832);
      ctx.fill(); ctx.stroke();
    }
    this._xs = xs; this._ys = ys; this._r = r;
  },
  // all items within tolerance of a container point, nearest first
  hits(pt, tol){
    const list = this._list || [], xs = this._xs, ys = this._ys; if(!xs) return [];
    tol = tol || Math.max(7, this._r + 3); const out = [];
    for(let i=list.length-1; i>=0; i--){ if(list[i].dim) continue; const dx = xs[i]-pt.x, dy = ys[i]-pt.y, d = dx*dx + dy*dy; if(d <= tol*tol) out.push([d, list[i].w]); }
    out.sort((a,b)=>a[0]-b[0]); return out.map(o=>o[1]);
  }
});
const points = new PointLayer().addTo(map);
const wqpPoints = new PointLayer().addTo(map);  // Water Quality Portal sites, above the wells
const pubPoints = new PointLayer().addTo(map);  // public API layers (triangles)
const dwPoints = new PointLayer().addTo(map);   // public water system sources, on top
const wellsShown = () => !state.noAnalyte && state.wellsOn;
function redrawPoints(){
  if(!wellsShown()){ points.setData([]); return; }
  const items = VIS.map(w=>{ const s = styleOf(w); return {w, c:s.c, z:s.z}; });
  items.sort((a,b)=>a.z - b.z);  // worst class drawn last, on top
  points.setData(items);
}

// hover label
const tip = $('hover-tip');
map.on('mousemove', e=>{
  if(state.drawing){ tip.style.display = 'none'; return; }
  const ds = dwPoints.hits(e.containerPoint);
  if(ds.length){
    const s = ds[0];
    map.getContainer().style.cursor = 'pointer';
    tip.textContent = s.fac + ' · ' + s.sys + (ds.length > 1 ? ' · +' + (ds.length-1) + ' more' : '');
    tip.style.display = 'block'; tip.style.left = (e.containerPoint.x + 14) + 'px'; tip.style.top = (e.containerPoint.y - 10) + 'px';
    return;
  }
  const ps = pubPoints.hits(e.containerPoint);
  if(ps.length){
    const f = ps[0]; map.getContainer().style.cursor = 'pointer';
    tip.textContent = f.L.name + ' · ' + (f.t || 'feature ' + f.id) + (ps.length > 1 ? ' · +' + (ps.length-1) + ' more' : '');
    tip.style.display = 'block'; tip.style.left = (e.containerPoint.x + 14) + 'px'; tip.style.top = (e.containerPoint.y - 10) + 'px';
    return;
  }
  const qs = wqpPoints.hits(e.containerPoint);
  if(qs.length){
    const q = qs[0]; map.getContainer().style.cursor = 'pointer';
    tip.textContent = (q.n || q.id) + ' · ' + q.t + ' · ' + q.r.toLocaleString() + ' results' + (qs.length > 1 ? ' · +' + (qs.length-1) + ' more' : '');
    tip.style.display = 'block'; tip.style.left = (e.containerPoint.x + 14) + 'px'; tip.style.top = (e.containerPoint.y - 10) + 'px';
    return;
  }
  const h = points.hits(e.containerPoint);
  if(!h.length){ tip.style.display = 'none'; map.getContainer().style.cursor = ''; return; }
  const w = h[0], v = val(w), an = AN[state.analyte];
  map.getContainer().style.cursor = 'pointer';
  tip.innerHTML = esc(w.name) + ' · ' + (v != null ? an.sym + ' ' + fmt(v) + ' ' + UNIT : 'no ' + an.sym) + (h.length > 1 ? ' · +' + (h.length-1) + ' more' : '');
  tip.style.display = 'block'; tip.style.left = (e.containerPoint.x + 14) + 'px'; tip.style.top = (e.containerPoint.y - 10) + 'px';
});
map.on('mouseout', ()=>{ tip.style.display = 'none'; });

/* popup */
function popupHtml(w){
  const rows = ANALYTES.filter(a=>w.a[a.key]).map(a=>{
    const x = w.a[a.key], s = a[state.std] ? a[state.std].v : null, v = val(w, a.key);
    const over = s != null && v != null && v > s;
    return `<tr class="${a.key === state.analyte ? 'cur' : ''}"><td>${over ? '<span class="flag" style="background:var(--c-over)"></span>' : ''}${a.sym}${x.src === 'wqp' ? wqpTag : ''}</td><td class="v">${fmt(v)}</td><td class="v" style="color:var(--muted)">${x.n != null ? 'n=' + x.n : ''}</td><td class="v" style="color:var(--muted)">${x.d2 ? x.d2.slice(0,4) : ''}</td></tr>`;
  }).join('');
  const meta = [w.depth != null ? fmt(w.depth) + ' ft deep' : 'depth unknown', w.fac ? w.fac : null, w.cbe != null ? 'CBE ' + w.cbe.toFixed(1) + '%' : null].filter(Boolean).join(' · ');
  return `<div class="pop"><h6>${esc(w.name)}</h6><div class="sub">${esc(w.source)} · ${esc(w.id)}${w.wqpOrg ? ' · ' + esc(w.wqpOrg) : ''}<br>${meta}</div>
    <table><tr><td style="color:var(--muted);font-size:10.5px">${state.basis === 'latest' ? 'Latest' : state.basis === 'max' ? 'Maximum' : 'Mean'}, ${UNIT}</td><td></td><td></td><td class="v" style="color:var(--muted);font-size:10.5px">last</td></tr>${rows}</table>
    <div class="actions"><button class="btn small primary" data-act="well" data-k="${esc(w.k)}">Sample history</button><button class="btn small" data-act="zoom" data-k="${esc(w.k)}">Zoom</button></div></div>`;
}
function pickHtml(ws){
  return `<div class="pop"><h6>${ws.length} wells at this spot</h6><div class="sub">Often a nested piezometer site. Choose one:</div>` +
    ws.slice(0,25).map(w=>{ const v = val(w); return `<div class="pick"><span><b>${esc(w.name)}</b><br><small style="color:var(--muted)">${esc(w.source)} · ${w.depth != null ? fmt(w.depth) + ' ft' : 'depth ?'} · ${AN[state.analyte].sym} ${fmt(v)}</small></span><button class="btn small" data-act="pop" data-k="${esc(w.k)}">Open</button></div>`; }).join('') + '</div>';
}
const byKey = new Map(WELLS.map(w=>[w.k, w]));
let popup = null;
function openPopup(w){ popup = L.popup({maxWidth:340, autoPanPadding:[30,30]}).setLatLng([w.lat, w.lng]).setContent(popupHtml(w)).openOn(map); }
map.on('click', e=>{
  if(state.drawing){ addDrawPt(e.latlng); return; }
  const ds = dwPoints.hits(e.containerPoint);
  if(ds.length){ openDwPopup(ds[0], ds); return; }
  const ps = pubPoints.hits(e.containerPoint);
  if(ps.length){ openPubPopup(ps[0], ps, e.latlng); return; }
  const qs = wqpPoints.hits(e.containerPoint);
  if(qs.length){ openWqpPopup(qs[0], qs); return; }
  const h = points.hits(e.containerPoint); if(!h.length){ areaClick(e); return; }
  const same = h.filter(w=>Math.abs(w.lat - h[0].lat) < 1e-5 && Math.abs(w.lng - h[0].lng) < 1e-5);
  if(same.length > 1){ popup = L.popup({maxWidth:340}).setLatLng([h[0].lat, h[0].lng]).setContent(pickHtml(same)).openOn(map); }
  else openPopup(h[0]);
});
document.addEventListener('click', e=>{
  const b = e.target.closest('[data-act]'); if(!b) return;
  if(b.dataset.act === 'dw'){ const s = DW_BY_KEY.get(b.dataset.k); if(s) openDwPopup(s, [s]); return; }
  if(b.dataset.act === 'pub'){ const [lid, oid] = b.dataset.k.split('|'); const L_ = PUB_BY_ID.get(lid), f = L_ && L_.feats && L_.feats.find(x=>String(x.id) === oid); if(f) openPubPopup(f, [f]); return; }
  if(b.dataset.act === 'area'){ const [k, i] = b.dataset.k.split('|'), src = AREA_BY_KEY.get(k); if(src){ map.closePopup(); selectAreaFrom(src, +i); } return; }
  if(b.dataset.act === 'wqp'){ const q = wqp.byId && wqp.byId.get(b.dataset.k); if(q) openWqpPopup(q, [q]); return; }
  const w = byKey.get(b.dataset.k); if(!w) return;
  if(b.dataset.act === 'well') openWell(w);
  else if(b.dataset.act === 'zoom') map.setView([w.lat, w.lng], Math.max(map.getZoom(), 13));
  else if(b.dataset.act === 'pop') openPopup(w);
});

/* ==================================================================== */
/* 7. Area selection: draw, upload, county, HUC-8                       */
/* ==================================================================== */
let areaLayer = null, drawLayer = L.layerGroup().addTo(map);
function bboxOf(polys){ let b = [Infinity,Infinity,-Infinity,-Infinity]; for(const p of polys) for(const [x,y] of p[0]){ if(x<b[0]) b[0]=x; if(y<b[1]) b[1]=y; if(x>b[2]) b[2]=x; if(y>b[3]) b[3]=y; } return b; }
function geomPolys(g){ if(!g) return []; if(g.type === 'Polygon') return [g.coordinates]; if(g.type === 'MultiPolygon') return g.coordinates; if(g.type === 'GeometryCollection') return g.geometries.flatMap(geomPolys); return []; }
function setArea(name, polys, fit, verts){
  stopAreaEdit();
  if(areaLayer){ map.removeLayer(areaLayer); areaLayer = null; }
  if(!polys || !polys.length){ state.area = null; areaEditUI(); update(); return; }
  state.area = {name, polys, bb:bboxOf(polys), verts:verts || null};
  areaEditUI();
  areaLayer = L.geoJSON({type:'MultiPolygon', coordinates:polys}, {pane:'selPane', interactive:false, style:{color:cssVar('--accent'), weight:2.2, fillColor:cssVar('--accent'), fillOpacity:.06}}).addTo(map);
  if(fit !== false) map.fitBounds(areaLayer.getBounds(), {padding:[30,30]});
  update();
}
function startDraw(){ state.drawing = true; state.drawPts = []; drawLayer.clearLayers(); map.doubleClickZoom.disable(); $('draw-hint').classList.add('show'); $('draw-hint-text').textContent = 'Click to add points'; map.getContainer().style.cursor = 'crosshair'; }
function endDraw(){ state.drawing = false; drawLayer.clearLayers(); map.doubleClickZoom.enable(); $('draw-hint').classList.remove('show'); map.getContainer().style.cursor = ''; }
function addDrawPt(ll){ state.drawPts.push([ll.lat, ll.lng]); drawLayer.clearLayers(); const col = cssVar('--accent'); L.polyline(state.drawPts.concat(state.drawPts.length > 2 ? [state.drawPts[0]] : []), {color:col, weight:2, dashArray:'5,4'}).addTo(drawLayer); state.drawPts.forEach(p=>L.circleMarker(p, {radius:4, color:col, fillColor:'#fff', fillOpacity:1, weight:2}).addTo(drawLayer)); $('draw-hint-text').textContent = state.drawPts.length + ' points' + (state.drawPts.length < 3 ? ' · need 3+' : ''); }
function finishDraw(){ const pts = state.drawPts.slice(); endDraw(); if(pts.length < 3){ toast('A polygon needs at least 3 points.'); return; } const ring = pts.map(p=>[p[1], p[0]]); ring.push(ring[0]); clearPickers(); setArea('Drawn polygon', [[ring]], true, pts.map(p=>L.latLng(p[0], p[1]))); startAreaEdit(); toast('Drag the handles to reshape the area, or click a small dot to add a point.', 5000); }
/* reshaping a drawn polygon: drag vertices, click midpoints to add, double-click a vertex to remove */
let areaEditing = false, vtxMarkers = [], midMarkers = [], areaUpdT = null;
function areaEditUI(){
  const ok = !!(state.area && state.area.verts);
  $('btn-edit-area').hidden = !ok; $('btn-edit-area').textContent = areaEditing ? 'Done editing' : 'Edit shape';
  $('area-draw-hint').textContent = areaEditing ? 'Drag a handle to move it, click a small dot to add a point, double-click a handle to remove it. Esc or Done editing when finished.' : 'Click the map to add vertices; double-click or press Finish to close the shape. Esc cancels. A drawn shape can be reshaped afterwards.';
}
function syncAreaFromVerts(){
  const A = state.area; if(!A || !A.verts) return;
  const ring = A.verts.map(ll=>[ll.lng, ll.lat]); ring.push(ring[0]);
  A.polys = [[ring]]; A.bb = bboxOf(A.polys);
  if(areaLayer){ areaLayer.clearLayers(); areaLayer.addData({type:'MultiPolygon', coordinates:A.polys}); }
  clearTimeout(areaUpdT); areaUpdT = setTimeout(update, 120);
}
function placeMids(){ const v = state.area.verts, n = v.length; for(let i=0; i<n; i++){ const a = v[i], b = v[(i+1) % n]; if(midMarkers[i]) midMarkers[i].setLatLng([(a.lat + b.lat)/2, (a.lng + b.lng)/2]); } }
function buildAreaHandles(){
  clearAreaHandles(); const v = state.area.verts;
  vtxMarkers = v.map((ll, i)=>{
    const m = L.marker(ll, {icon:L.divIcon({className:'vtx', iconSize:[14,14], iconAnchor:[7,7]}), draggable:true, keyboard:false, zIndexOffset:1000}).addTo(map);
    m.on('drag', ()=>{ v[i] = m.getLatLng(); syncAreaFromVerts(); placeMids(); });
    m.on('dblclick', e=>{ L.DomEvent.stop(e); if(v.length <= 3){ toast('An area needs at least 3 points.'); return; } v.splice(i, 1); syncAreaFromVerts(); buildAreaHandles(); });
    m.bindTooltip('Drag to move · double-click to remove', {direction:'top', offset:[0,-8]});
    return m;
  });
  midMarkers = v.map((a, i)=>{
    const b = v[(i+1) % v.length];
    const m = L.marker([(a.lat + b.lat)/2, (a.lng + b.lng)/2], {icon:L.divIcon({className:'vtx-mid', iconSize:[9,9], iconAnchor:[4,4]}), keyboard:false, zIndexOffset:900}).addTo(map);
    m.on('click', e=>{ L.DomEvent.stop(e); v.splice(i + 1, 0, m.getLatLng()); syncAreaFromVerts(); buildAreaHandles(); });
    m.bindTooltip('Click to add a point here', {direction:'top', offset:[0,-6]});
    return m;
  });
}
function clearAreaHandles(){ vtxMarkers.concat(midMarkers).forEach(m=>map.removeLayer(m)); vtxMarkers = []; midMarkers = []; }
function startAreaEdit(){ if(!state.area || !state.area.verts) return; areaEditing = true; buildAreaHandles(); areaEditUI(); }
function stopAreaEdit(){ if(!areaEditing) return; areaEditing = false; clearAreaHandles(); areaEditUI(); }
map.on('dblclick', e=>{ if(state.drawing){ L.DomEvent.stop(e); if(state.drawPts.length > 3) state.drawPts.pop(); finishDraw(); } });
$('btn-draw').onclick = startDraw;
$('draw-finish').onclick = finishDraw;
$('draw-cancel').onclick = endDraw;
document.addEventListener('keydown', e=>{ if(e.key === 'Escape'){ if(state.drawing) endDraw(); else if(areaEditing) stopAreaEdit(); else { closeModal('well-modal'); closeModal('help-modal'); } } });
$('btn-clear-area').onclick = ()=>{ clearPickers(); setArea(null, null); };
$('btn-edit-area').onclick = ()=>{ if(areaEditing) stopAreaEdit(); else startAreaEdit(); };
function clearPickers(){ for(const id of ['county-select', 'huc-select', 'aq-select', 'study-select']) $(id).value = ''; }
$('btn-upload').onclick = ()=>$('file-input').click();
$('file-input').addEventListener('change', e=>{
  const f = e.target.files[0]; if(!f) return;
  const rd = new FileReader();
  rd.onload = ()=>{
    try{
      const gj = JSON.parse(rd.result);
      const feats = gj.type === 'FeatureCollection' ? gj.features : gj.type === 'Feature' ? [gj] : [{geometry:gj}];
      const polys = feats.flatMap(ft=>geomPolys(ft.geometry));
      if(!polys.length) throw new Error('no Polygon or MultiPolygon geometry found');
      const x = polys[0][0][0][0]; if(Math.abs(x) > 180) throw new Error('coordinates must be longitude/latitude (WGS84)');
      clearPickers(); setArea(f.name.replace(/\.(geo)?json$/i, ''), polys);
    }catch(err){ toast('Could not read that file: ' + err.message); }
    e.target.value = '';
  };
  rd.readAsText(f);
});
const COUNTY_URL = 'https://services3.arcgis.com/btGPJYeJkAc5Bpuh/ArcGIS/rest/services/Counties/FeatureServer/0/query?where=1%3D1&outFields=NAME,GEOID&outSR=4326&f=geojson&geometryPrecision=4';
const HUC8_URL = "https://hydrowfs.nationalmap.gov/arcgis/rest/services/wbd/MapServer/4/query?where=states+LIKE+'%25NM%25'&outFields=huc8,name,states&outSR=4326&f=geojson&geometryPrecision=4";
let counties = [], hucs = [];
const countiesLayer = L.layerGroup(), hucLayer = L.layerGroup();
fetch(COUNTY_URL).then(r=>r.json()).then(gj=>{
  counties = (gj.features||[]).sort((a,b)=>(a.properties.NAME||'').localeCompare(b.properties.NAME||''));
  counties.forEach(f=>L.geoJSON(f, {pane:'refPane', interactive:false, style:{color:'#7d8873', weight:1, fillOpacity:0, dashArray:'2,3'}}).addTo(countiesLayer));
  $('county-select').innerHTML = '<option value="">Choose a county…</option>' + counties.map((f,i)=>`<option value="${i}">${esc(f.properties.NAME)}</option>`).join('');
}).catch(()=>{ $('county-select').innerHTML = '<option value="">County service unreachable</option>'; });
fetch(HUC8_URL).then(r=>r.json()).then(gj=>{
  hucs = (gj.features||[]).sort((a,b)=>(a.properties.name||'').localeCompare(b.properties.name||''));
  hucs.forEach(f=>L.geoJSON(f, {pane:'refPane', interactive:false, style:{color:'#5a8f8c', weight:1, fillOpacity:0, dashArray:'2,3'}}).addTo(hucLayer));
  $('huc-select').innerHTML = '<option value="">Choose a watershed…</option>' + hucs.map((f,i)=>`<option value="${i}">${esc(f.properties.name)} (${esc(f.properties.huc8)})</option>`).join('');
}).catch(()=>{ $('huc-select').innerHTML = '<option value="">Watershed service unreachable</option>'; });
// Aquifers (embedded, simplified from nmaquifers.geojson; polygons with the same Aquifer name form one area)
const aqName = s => String(s || '').replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
let aquifers = [];
const aqLayer = L.layerGroup();
(()=>{
  try{
    const gj = builtIn('aquifer-data'), by = new Map();
    for(const f of gj.features){ const n = aqName(f.properties.Aquifer) || 'Unnamed aquifer'; if(!by.has(n)) by.set(n, {name:n, props:f.properties, polys:[]}); by.get(n).polys.push(...geomPolys(f.geometry)); }
    aquifers = [...by.values()].sort((a, b)=>a.name.localeCompare(b.name));
    aquifers.forEach((a, i)=>{ const hue = (i*137.5) % 360; L.geoJSON({type:'MultiPolygon', coordinates:a.polys}, {pane:'refPane', interactive:false, style:{color:`hsl(${hue},55%,38%)`, weight:1, fillColor:`hsl(${hue},55%,50%)`, fillOpacity:.07}}).addTo(aqLayer); });
    $('aq-select').innerHTML = '<option value="">Choose an aquifer…</option>' + aquifers.map((a, i)=>`<option value="${i}">${esc(a.name)}${a.props.Class1 ? ' (' + esc(a.props.Class1) + ')' : ''}</option>`).join('');
  }catch(e){ $('aq-select').innerHTML = '<option value="">Aquifer data unavailable</option>'; }
})();
// NMBGMR Aquifer Mapping Program study areas
const STUDY_URL = 'https://maps.nmt.edu/server/rest/services/Water/Water_Resources/MapServer/18/query?where=1%3D1&outFields=status,location,Web_Link,StartYear,EndYear&outSR=4326&f=geojson&geometryPrecision=4';
let studies = [];
const studyLayer = L.layerGroup();
fetch(STUDY_URL).then(r=>r.json()).then(gj=>{
  studies = (gj.features || []).filter(f=>f.geometry).sort((a, b)=>(a.properties.location || '').localeCompare(b.properties.location || ''));
  studies.forEach(f=>L.geoJSON(f, {pane:'refPane', interactive:false, style:{color:'#b5476b', weight:1.2, fillColor:'#b5476b', fillOpacity:.06, dashArray:'4,3'}}).addTo(studyLayer));
  $('study-select').innerHTML = '<option value="">Choose a study area…</option>' + studies.map((f, i)=>`<option value="${i}">${esc(f.properties.location || 'Study area ' + (i+1))}${f.properties.status ? ' · ' + esc(f.properties.status) : ''}</option>`).join('');
}).catch(()=>{ $('study-select').innerHTML = '<option value="">Study area service unreachable</option>'; });

// every source of selectable areas: picker, map layer and checkbox
const AREA_SRC = [
  {key:'county', label:'County', sel:'county-select', cb:'layer-counties', layer:countiesLayer, items:()=>counties, name:f=>f.properties.NAME + ' County', polys:f=>geomPolys(f.geometry)},
  {key:'huc', label:'Watershed (HUC-8)', sel:'huc-select', cb:'layer-huc', layer:hucLayer, items:()=>hucs, name:f=>f.properties.name + ' (HUC ' + f.properties.huc8 + ')', polys:f=>geomPolys(f.geometry)},
  {key:'aq', label:'Aquifer', sel:'aq-select', cb:'layer-aq', layer:aqLayer, items:()=>aquifers, name:a=>a.name + ' aquifer', polys:a=>a.polys, sub:a=>[a.props.Class1, a.props.Reg_Aquifer].filter(Boolean).join(' · ')},
  {key:'study', label:'Aquifer Mapping study area', sel:'study-select', cb:'layer-study', layer:studyLayer, items:()=>studies, name:f=>(f.properties.location || 'Study area') + ' (Aquifer Mapping study area)', polys:f=>geomPolys(f.geometry), sub:f=>[f.properties.status, [f.properties.StartYear, f.properties.EndYear].filter(Boolean).join('–')].filter(Boolean).join(' · '), link:f=>f.properties.Web_Link}
];
const AREA_BY_KEY = new Map(AREA_SRC.map(s=>[s.key, s]));
function selectAreaFrom(src, i){
  const it = src.items()[i]; if(!it) return;
  clearPickers(); $(src.sel).value = String(i);
  setArea(src.name(it), src.polys(it));
}
for(const src of AREA_SRC){
  $(src.sel).addEventListener('change', e=>{ const i = e.target.value; if(i === ''){ setArea(null, null); return; } selectAreaFrom(src, +i); });
  $(src.cb).addEventListener('change', e=>{ e.target.checked ? src.layer.addTo(map) : map.removeLayer(src.layer); });
}
// boundary polys containing a map point, for click-to-select
const polysBB = polys => { let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9; for(const p of polys) for(const c of p[0]){ if(c[0] < x0) x0 = c[0]; if(c[0] > x1) x1 = c[0]; if(c[1] < y0) y0 = c[1]; if(c[1] > y1) y1 = c[1]; } return [x0, y0, x1, y1]; };
function polysHit(polys, x, y){ for(const p of polys){ if(ringContains(p[0], x, y)){ let hole = false; for(let k=1; k<p.length; k++) if(ringContains(p[k], x, y)){ hole = true; break; } if(!hole) return true; } } return false; }
let pubPolyClickT = 0;
function areaClick(e){
  if(Date.now() - pubPolyClickT < 400) return false;   // a public-layer polygon already opened its popup
  const x = e.latlng.lng, y = e.latlng.lat, hits = [];
  for(const src of AREA_SRC){
    if(!map.hasLayer(src.layer)) continue;
    src.items().forEach((it, i)=>{ const P = src.polys(it); if(!it.__bb) it.__bb = polysBB(P); const b = it.__bb; if(x < b[0] || x > b[2] || y < b[1] || y > b[3]) return; if(polysHit(P, x, y)) hits.push([src, i, it]); });
  }
  if(!hits.length) return false;
  const rows = hits.map(([src, i, it])=>{ const sub = src.sub ? src.sub(it) : '', link = src.link ? src.link(it) : '';
    return `<div class="pick"><span><b>${esc(src.name(it))}</b><br><small style="color:var(--muted)">${esc(src.label)}${sub ? ' · ' + esc(sub) : ''}${link ? ` · <a href="${esc(link)}" target="_blank" rel="noopener">project page ↗</a>` : ''}</small></span><button class="btn small primary" data-act="area" data-k="${src.key}|${i}">Select</button></div>`; }).join('');
  popup = L.popup({maxWidth:360, minWidth:240, maxHeight:Math.max(220, Math.round(map.getSize().y*0.6))}).setLatLng(e.latlng).setContent(`<div class="pop"><h6>Select an area</h6><div class="sub">${hits.length} boundar${hits.length === 1 ? 'y' : 'ies'} here</div>${rows}</div>`).openOn(map);
  return true;
}

/* ==================================================================== */
/* 8. Sidebar controls                                                  */
/* ==================================================================== */
document.querySelectorAll('.tab-btn').forEach(b=>b.addEventListener('click', ()=>{
  const side = b.closest('aside');
  side.querySelectorAll('.tab-btn').forEach(x=>{ x.classList.toggle('active', x === b); x.setAttribute('aria-selected', x === b); });
  side.querySelectorAll('.tabpanel').forEach(p=>p.classList.toggle('active', p.id === 'tab-' + b.dataset.tab));
  if(b.dataset.tab === 'systems') dwEnsure();
  if(b.dataset.tab === 'wqp') wqpOpen();
}));
function renderAnalyteList(){
  // counts use wells passing the base filters (source, depth, CBE) within the area
  const base = WELLS.filter(w=>passBase(w) && inArea(w));
  let html = '', grp = '';
  for(const a of ANALYTES){
    if(a.group !== grp){ grp = a.group; html += `<div class="an-group">${esc(grp)}</div>`; }
    let n = 0, over = 0; const s = a[state.std] ? a[state.std].v : null;
    for(const w of base){ const v = val(w, a.key); if(v == null) continue; n++; if(s != null && v > s) over++; }
    const ex = s != null && n ? `<b>${(100*over/n).toFixed(over/n < .1 && over ? 1 : 0)}%</b> over` : (s == null ? 'no standard' : '');
    html += `<button class="an-row${a.key === state.analyte && !state.noAnalyte ? ' active' : ''}" data-an="${a.key}"><span class="sym">${a.sym}</span><span class="nm">${esc(a.name)}<small>${s != null ? fmt(s) + ' ' + UNIT + ' ' + esc(stdKind(a.key)) : '—'}</small></span><span class="ex">${n.toLocaleString()}<br>${ex}</span></button>`;
  }
  $('analyte-list').innerHTML = html;
}
$('analyte-list').addEventListener('click', e=>{ const b = e.target.closest('[data-an]'); if(!b) return; setAnalyte(b.dataset.an); });
function setAnalyte(k){
  state.analyte = k; ls.set('wq-analyte', k);
  state.noAnalyte = false;
  if(!state.wellsOn){ state.wellsOn = true; $('wells-on').checked = true; ls.set('wq-wells', 'on'); }
  state.conc = {min:null, max:null}; $('conc-min').value = ''; $('conc-max').value = '';
  if(!['value','nsamples','recency','source','depth','facies','cbe'].includes(state.colorBy) && !state.colorBy.startsWith('api:')) state.colorBy = 'value';
  update();
}
function segBind(id, attr, fn){ $(id).addEventListener('click', e=>{ const b = e.target.closest('button'); if(!b) return; $(id).querySelectorAll('button').forEach(x=>x.classList.toggle('active', x === b)); fn(b.dataset[attr]); }); }
segBind('basis-seg', 'basis', v=>{ state.basis = v; update(); });
segBind('exceed-seg', 'ex', v=>{ state.exceed = v; update(); });
segBind('piper-color-seg', 'pc', v=>{ state.piperColor = v; drawPiper(); });
$('std-select').value = state.std;
$('std-select').addEventListener('change', e=>{ state.std = e.target.value; ls.set('wq-std', state.std); update(); });
const numOrNull = v => v === '' || v == null || isNaN(+v) ? null : +v;
const debT = new Map(); const debounced = (fn, key) => { key = key || fn.toString(); clearTimeout(debT.get(key)); debT.set(key, setTimeout(fn, 250)); };
['conc-min','conc-max'].forEach(id=>$(id).addEventListener('input', ()=>debounced(()=>{ state.conc = {min:numOrNull($('conc-min').value), max:numOrNull($('conc-max').value)}; update(); })));
$('conc-clear').onclick = ()=>{ $('conc-min').value = ''; $('conc-max').value = ''; state.conc = {min:null,max:null}; update(); };
['depth-min','depth-max'].forEach(id=>$(id).addEventListener('input', ()=>debounced(()=>{ state.depth.min = numOrNull($('depth-min').value); state.depth.max = numOrNull($('depth-max').value); update(); })));
$('depth-require').addEventListener('change', e=>{ state.depth.req = e.target.checked; update(); });
$('depth-clear').onclick = ()=>{ $('depth-min').value = ''; $('depth-max').value = ''; $('depth-require').checked = false; state.depth = {min:null,max:null,req:false}; update(); };
['year-from','year-to'].forEach(id=>$(id).addEventListener('input', ()=>debounced(()=>{ state.year = {from:numOrNull($('year-from').value), to:numOrNull($('year-to').value)}; update(); })));
$('year-clear').onclick = ()=>{ $('year-from').value = ''; $('year-to').value = ''; state.year = {from:null,to:null}; update(); };
$('min-n').addEventListener('input', ()=>debounced(()=>{ state.minN = Math.max(1, numOrNull($('min-n').value) || 1); update(); }));
$('cbe-only').addEventListener('change', e=>{ state.cbeOnly = e.target.checked; update(); });
$('show-missing').addEventListener('change', e=>{ state.showMissing = e.target.checked; update(); });
function renderSources(){
  const cnt = new Map(); WELLS.forEach(w=>cnt.set(w.source, (cnt.get(w.source)||0)+1));
  $('src-list').innerHTML = SOURCES.map(s=>`<div class="row"><label><input type="checkbox" data-src="${esc(s)}" ${state.sources.has(s) ? 'checked' : ''}><span class="swatch" style="background:${srcColor(s)}"></span>${esc(s)}</label><span class="count">${(cnt.get(s)||0).toLocaleString()}</span></div>`).join('');
}
$('src-list').addEventListener('change', e=>{ const s = e.target.dataset.src; if(s == null) return; e.target.checked ? state.sources.add(s) : state.sources.delete(s); update(); });
$('src-all').onclick = ()=>{ const all = state.sources.size === SOURCES.length; state.sources = all ? new Set() : new Set(SOURCES); renderSources(); update(); };

/* legend */
$('colorby-select').addEventListener('change', async e=>{
  state.colorBy = e.target.value;
  if(state.colorBy.startsWith('api:')){
    const id = state.colorBy.slice(4); renderLegend(); toast('Loading ' + API_LAYERS[id].label + ' from the API…');
    try{ await loadApiLayer(id); toast('Loaded ' + API_LAYERS[id].label); }
    catch(err){ toast('Could not load that layer: ' + err.message); state.colorBy = 'value'; $('colorby-select').value = 'value'; }
  }
  redrawPoints(); renderLegend();
});
$('an-clear').onclick = ()=>{
  state.noAnalyte = true; ls.set('wq-analyte', 'none');
  state.conc = {min:null, max:null}; $('conc-min').value = ''; $('conc-max').value = '';
  if(!$('drawer').classList.contains('collapsed')) toggleDrawer();
  if(popup) map.closePopup(popup);
  update();
};
$('wells-on').checked = state.wellsOn;
$('wells-on').addEventListener('change', e=>{
  state.wellsOn = e.target.checked;   // ticking it also brings back the last analyte ls.set('wq-wells', state.wellsOn ? 'on' : 'off');
  if(state.wellsOn && state.noAnalyte){ state.noAnalyte = false; ls.set('wq-analyte', state.analyte); }
  update();
});
$('legend-collapse').onclick = ()=>{ const c = $('legend').classList.toggle('collapsed'); $('legend-collapse').textContent = c ? '▸' : '▾'; };
function lgRow(color, label, n, sq){ return `<div class="lg-row"><span class="swatch${sq ? ' sq' : ''}" style="background:${color}"></span><span class="k">${label}</span>${n != null ? `<span class="n">${n.toLocaleString()}</span>` : ''}</div>`; }
function renderLegend(){
  $('colorby-select').hidden = !wellsShown();
  if(!wellsShown()){
    $('legend-rows').innerHTML = '<div class="lg-note" style="margin-top:6px">' + (state.noAnalyte ? 'No analyte selected, so wells are hidden. Pick one in the Weaver API tab or tick Wells to show them again.' : 'Wells are hidden. Tick Wells to show them.') + '</div>';
    renderDwLegend(); return;
  }
  const a = AN[state.analyte], cb = state.colorBy, none = cssVar('--c-none');
  const counts = new Map(); let missing = 0;
  const keyOf = w => { const s = styleOf(w); return s.z < 0 ? null : s.c; };
  VIS.forEach(w=>{ const k = keyOf(w); if(k == null) missing++; else counts.set(k, (counts.get(k)||0)+1); });
  let rows = '', note = '';
  if(cb === 'value'){
    const s = stdOf();
    rows = valueLegend().map(r=>lgRow(r[1], r[2], counts.get(r[1])||0)).join('');
    note = `${a.name}, ${state.basis === 'latest' ? 'latest sample' : state.basis === 'max' ? 'maximum' : 'mean'} (${UNIT}). ` + (s != null ? `Standard: ${fmt(s)} ${UNIT} (${esc(STD_LABEL[state.std])}${state.std === 'epa' ? ' ' + esc(a.epa.k) : ''}).` : 'No drinking-water standard; classes are statewide quintiles.');
  } else if(cb === 'nsamples' || cb === 'recency' || cb === 'depth'){
    const labs = cb === 'nsamples' ? ['1 sample','2–3','4–10','11–30','> 30'] : cb === 'recency' ? ['before 1990','1990s','2000s','2010s','2020 or later'] : ['< 100 ft','100–300 ft','300–600 ft','600–1,200 ft','≥ 1,200 ft'];
    rows = labs.map((l,i)=>lgRow(seq()[i], l, counts.get(seq()[i])||0)).join('');
    note = cb === 'nsamples' ? `Samples on record for ${a.name.toLowerCase()}.` : cb === 'recency' ? `Year of the latest ${a.name.toLowerCase()} sample.` : 'Reported well depth.';
  } else if(cb === 'facies'){
    const fc = new Map(); VIS.forEach(w=>{ if(w.fac) fc.set(w.fac, (fc.get(w.fac)||0)+1); });
    rows = FACIES_ORDER.filter(f=>fc.has(f)).map(f=>lgRow(facColor(f), f, fc.get(f))).join('');
    note = 'Dominant cation–anion (> 50% of meq/L) from each well\'s latest major ions.';
  } else if(cb === 'cbe'){
    rows = [['--c-low','within ±5%'],['--c-mid','±5–10%'],['--c-over','beyond ±10%']].map(r=>lgRow(cssVar(r[0]), r[1], counts.get(cssVar(r[0]))||0)).join('');
    note = 'Charge balance error = (Σcations − Σanions) / (Σcations + Σanions).';
  } else if(cb === 'source'){
    const sc = new Map(); VIS.forEach(w=>sc.set(w.source, (sc.get(w.source)||0)+1));
    rows = SOURCES.filter(s=>sc.has(s)).map(s=>lgRow(srcColor(s), esc(s), sc.get(s))).join('');
  } else if(cb.startsWith('api:')){
    const id = cb.slice(4), L_ = apiLayers[id];
    if(!L_ || !L_.map) rows = '<div class="lg-row"><span class="k">Loading ' + esc(API_LAYERS[id].label) + '…</span></div>';
    else { const cc = new Map(); VIS.forEach(w=>{ const c = L_.map.get(w.k); if(c != null) cc.set(c, (cc.get(c)||0)+1); }); rows = L_.order.map(c=>lgRow(L_.colors.get(c), esc(c), cc.get(c)||0)).join(''); }
    note = 'Source: NM Unified Water Data API · ' + API_LAYERS[id].coll;
  }
  if(missing) rows += lgRow(none, cb === 'value' || cb === 'nsamples' || cb === 'recency' ? 'No ' + a.name.toLowerCase() + ' data' : 'No value', missing);
  $('legend-rows').innerHTML = rows + (note ? `<div class="lg-note">${note}</div>` : '');
  renderDwLegend();
}

/* ==================================================================== */
/* 9. Drawer: summary table, histogram, Piper, wells                    */
/* ==================================================================== */
document.querySelectorAll('#drawer-tabs button').forEach(b=>b.addEventListener('click', ()=>{
  state.dtab = b.dataset.dtab;
  document.querySelectorAll('#drawer-tabs button').forEach(x=>x.classList.toggle('active', x === b));
  document.querySelectorAll('.dpane').forEach(p=>p.classList.toggle('active', p.id === 'pane-' + state.dtab));
  if($('drawer').classList.contains('collapsed')) toggleDrawer();
  renderDrawer();
}));
function quant(sorted, p){ if(!sorted.length) return null; const i = (sorted.length-1)*p, lo = Math.floor(i), hi = Math.ceil(i); return sorted[lo] + (sorted[hi]-sorted[lo])*(i-lo); }
function renderSummary(){
  // rows: each analyte, over the wells in scope that have that analyte (year/n/conc limits apply to the selected analyte only)
  const base = WELLS.filter(w=>passBase(w) && inArea(w));
  const out = ANALYTES.map(a=>{
    const vs = []; for(const w of (a.key === state.analyte ? SCOPE : base)){ const v = val(w, a.key); if(v != null) vs.push(v); }
    vs.sort((x,y)=>x-y);
    const s = a[state.std] ? a[state.std].v : null, over = s != null ? vs.filter(v=>v > s).length : null;
    return {a, n:vs.length, med:quant(vs,.5), p90:quant(vs,.9), max:vs.length ? vs[vs.length-1] : null, s, over};
  });
  const maxPct = Math.max(1, ...out.map(r=>r.n && r.over != null ? 100*r.over/r.n : 0));
  $('sum-table').innerHTML = `<thead><tr><th>Analyte (${UNIT})</th><th>Wells</th><th>Median</th><th>90th pct</th><th>Max</th><th>Standard</th><th>Wells above</th></tr></thead><tbody>` +
    out.map(r=>{
      const pct = r.n && r.over != null ? 100*r.over/r.n : null;
      return `<tr class="click${r.a.key === state.analyte && !state.noAnalyte ? ' cur' : ''}" data-an="${r.a.key}"><td><span class="anm">${r.a.sym}</span> <span style="color:var(--muted);font-family:var(--font-ui)">${esc(r.a.name)}</span></td><td>${r.n.toLocaleString()}</td><td>${fmt(r.med)}</td><td>${fmt(r.p90)}</td><td>${fmt(r.max)}</td><td>${r.s != null ? fmt(r.s) : '–'}</td><td>${pct != null ? r.over.toLocaleString() + ' · ' + pct.toFixed(pct < 10 ? 1 : 0) + '%' + (r.over ? '<span class="bar" style="width:' + Math.max(2, 46*pct/maxPct) + 'px"></span>' : '<span class="bar" style="width:0"></span>') : '–'}</td></tr>`;
    }).join('') + '</tbody>';
  renderHist();
}
$('sum-table').addEventListener('click', e=>{ const r = e.target.closest('[data-an]'); if(r) setAnalyte(r.dataset.an); });
let histChart = null;
const bgPlugin = {id:'bg', beforeDraw(c){ const ctx = c.ctx; ctx.save(); ctx.globalCompositeOperation = 'destination-over'; ctx.fillStyle = cssVar('--surface-1'); ctx.fillRect(0,0,c.width,c.height); ctx.restore(); }};
function renderHist(){
  if(state.noAnalyte){ if(histChart){ histChart.destroy(); histChart = null; } $('hist-title').textContent = 'Distribution'; $('hist-sub').textContent = 'click an analyte row to choose one'; return; }
  const a = AN[state.analyte], s = stdOf();
  const vs = SCOPE.map(w=>val(w)).filter(v=>v != null);
  const zeros = vs.filter(v=>v <= 0).length, pos = vs.filter(v=>v > 0);
  $('hist-title').textContent = a.name;
  $('hist-sub').textContent = pos.length.toLocaleString() + ' wells > 0' + (zeros ? ' · ' + zeros.toLocaleString() + ' reported as 0' : '') + ' · log bins';
  if(histChart){ histChart.destroy(); histChart = null; }
  if(!pos.length) return;
  let lo = Math.floor(Math.log10(Math.min(...pos))*4)/4, hi = Math.ceil(Math.log10(Math.max(...pos))*4)/4;
  if(hi - lo < 1){ lo -= .5; hi += .5; }
  const w = Math.max(.1, Math.round((hi-lo)/24*20)/20) || .1;
  const nb = Math.max(1, Math.ceil((hi-lo)/w)); const bins = new Array(nb).fill(0);
  pos.forEach(v=>{ bins[Math.min(nb-1, Math.max(0, Math.floor((Math.log10(v)-lo)/w)))]++; });
  const centers = bins.map((_,i)=>Math.pow(10, lo + (i+.5)*w));
  const colors = centers.map(c=>{ if(s != null) return c > 2*s ? cssVar('--c-over2') : c > s ? cssVar('--c-over') : c >= .5*s ? cssVar('--c-mid') : cssVar('--c-low'); return cssVar('--accent'); });
  const ink = cssVar('--ink-2'), grid = cssVar('--border'), muted = cssVar('--muted');
  const stdLine = {id:'stdline', afterDatasetsDraw(c){
    if(s == null) return; const pos_ = (Math.log10(s) - lo)/w; if(pos_ < 0 || pos_ > nb) return;
    const x0 = c.scales.x.getPixelForValue(0), x1 = nb > 1 ? c.scales.x.getPixelForValue(1) : x0 + 20; const x = x0 + (pos_ - .5)*(x1 - x0);
    const ctx = c.ctx, ya = c.chartArea; ctx.save(); ctx.strokeStyle = cssVar('--ink-1'); ctx.setLineDash([5,4]); ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(x, ya.top); ctx.lineTo(x, ya.bottom); ctx.stroke();
    ctx.setLineDash([]); ctx.fillStyle = cssVar('--ink-1'); ctx.font = '600 11px ' + cssVar('--font-ui'); ctx.textAlign = x > (ya.left+ya.right)/2 ? 'right' : 'left'; ctx.fillText((state.std === 'epa' ? a.epa.k.split(',')[0] : 'NM std') + ' ' + fmt(s), x + (ctx.textAlign === 'left' ? 5 : -5), ya.top + 11); ctx.restore();
  }};
  histChart = new Chart($('hist-canvas'), {
    type:'bar',
    data:{labels:centers.map(c=>fmt(c)), datasets:[{data:bins, backgroundColor:colors, borderWidth:0, barPercentage:1, categoryPercentage:.96}]},
    options:{responsive:true, maintainAspectRatio:false, animation:false,
      plugins:{legend:{display:false}, tooltip:{callbacks:{title:it=>{ const i = it[0].dataIndex; return fmt(Math.pow(10, lo+i*w)) + ' – ' + fmt(Math.pow(10, lo+(i+1)*w)) + ' ' + UNIT; }, label:it=>it.raw.toLocaleString() + ' wells'}}},
      scales:{x:{ticks:{color:muted, maxRotation:0, autoSkip:true, maxTicksLimit:8, font:{family:cssVar('--font-mono'), size:10}}, grid:{display:false}, title:{display:true, text:a.sym + ' (' + UNIT + ', log scale)', color:ink, font:{size:11}}},
              y:{ticks:{color:muted, font:{family:cssVar('--font-mono'), size:10}}, grid:{color:grid}, title:{display:true, text:'Wells', color:ink, font:{size:11}}}}},
    plugins:[stdLine, bgPlugin]
  });
}

/* ---- Piper ---- */
const SQ3 = Math.sqrt(3);
function piperGeom(W, H){
  const m = 28, top = 18;
  const GR = 0.22;   // gap between the triangles as a fraction of the side
  const s = Math.max(60, Math.min((W - 2*m)/(2 + GR), (H - top - 36)/(SQ3 + GR*SQ3/2)));
  const g = GR*s, totalW = 2*s + g, ox = (W - totalW)/2, oy = H - 30;
  return {s, g, ox, oy};
}
function piperPts(G, p){ // p: {ca,mg,nak,alk,cl,so4} in % → canvas coords
  const {s, g, ox, oy} = G, k = s/100;
  const cx = k*(p.nak + p.mg/2), cy = k*p.mg*SQ3/2;
  const ax = s + g + k*(p.cl + p.so4/2), ay = k*p.so4*SQ3/2;
  const t = (ax - cx) + (ay - cy)/SQ3;
  const dx = cx + t/2, dy = cy + t*SQ3/2;
  return {c:[ox+cx, oy-cy], a:[ox+ax, oy-ay], d:[ox+dx, oy-dy]};
}
function drawPiper(){
  const cv = $('piper-canvas'), box = $('piper-box');
  const W = box.clientWidth, H = box.clientHeight; if(!W || !H) return;
  const dpr = window.devicePixelRatio || 1; cv.width = W*dpr; cv.height = H*dpr;
  const ctx = cv.getContext('2d'); ctx.setTransform(dpr,0,0,dpr,0,0);
  ctx.fillStyle = cssVar('--surface-1'); ctx.fillRect(0,0,W,H);
  const G = piperGeom(W, H), ink = cssVar('--ink-2'), grid = cssVar('--border'), font = cssVar('--font-ui');
  const P = (ca,mg,nak,alk,cl,so4)=>piperPts(G, {ca,mg,nak,alk,cl,so4});
  // grid lines
  ctx.lineWidth = 1; ctx.strokeStyle = grid; ctx.setLineDash([2,3]);
  const line = (a,b)=>{ ctx.beginPath(); ctx.moveTo(a[0],a[1]); ctx.lineTo(b[0],b[1]); ctx.stroke(); };
  for(let f=20; f<100; f+=20){
    // cation triangle: lines of constant Ca, Mg, Na+K
    line(P(f,0,100-f,0,0,0).c, P(f,100-f,0,0,0,0).c);
    line(P(0,f,100-f,0,0,0).c, P(100-f,f,0,0,0,0).c);
    line(P(100-f,0,f,0,0,0).c, P(0,100-f,f,0,0,0).c);
    // anion triangle
    line(P(0,0,0,f,100-f,0).a, P(0,0,0,f,0,100-f).a);
    line(P(0,0,0,0,100-f,f).a, P(0,0,0,100-f,0,f).a);
    line(P(0,0,0,100-f,f,0).a, P(0,0,0,0,f,100-f).a);
    // diamond: constant Na+K, constant HCO3
    line(P(100-f,0,f,100,0,0).d, P(100-f,0,f,0,100,0).d);
    line(P(100,0,0,f,100-f,0).d, P(0,0,100,f,100-f,0).d);
  }
  ctx.setLineDash([]); ctx.strokeStyle = ink; ctx.lineWidth = 1.2;
  const poly = pts=>{ ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]); pts.slice(1).forEach(p=>ctx.lineTo(p[0],p[1])); ctx.closePath(); ctx.stroke(); };
  poly([P(100,0,0,0,0,0).c, P(0,0,100,0,0,0).c, P(0,100,0,0,0,0).c]);
  poly([P(0,0,0,100,0,0).a, P(0,0,0,0,100,0).a, P(0,0,0,0,0,100).a]);
  poly([P(0,0,100,100,0,0).d, P(100,0,0,100,0,0).d, P(100,0,0,0,100,0).d, P(0,0,100,0,100,0).d]);
  // labels
  ctx.fillStyle = ink; ctx.font = '600 11px ' + font;
  const lab = (t, p, al, dx, dy)=>{ ctx.textAlign = al; ctx.fillText(t, p[0] + (dx||0), p[1] + (dy||0)); };
  lab('Ca²⁺', P(100,0,0,0,0,0).c, 'center', 0, 16); lab('Na⁺ + K⁺', P(0,0,100,0,0,0).c, 'right', 4, 16); lab('Mg²⁺', P(0,100,0,0,0,0).c, 'right', -6, 4);
  lab('HCO₃⁻ + CO₃²⁻', P(0,0,0,100,0,0).a, 'left', -4, 16); lab('Cl⁻', P(0,0,0,0,100,0).a, 'center', 0, 16); lab('SO₄²⁻', P(0,0,0,0,0,100).a, 'left', 6, 4);
  lab('SO₄ + Cl', P(100,0,0,50,50,0).d, 'right', -8, 0); lab('Ca + Mg', P(50,0,50,0,100,0).d, 'left', 8, 0);
  ctx.font = '10px ' + cssVar('--font-mono'); ctx.fillStyle = cssVar('--muted');
  lab('% meq/L', [G.ox + G.s + G.g/2, G.oy], 'center', 0, -4);
  // points
  const pts = SCOPE.filter(w=>w.pip);
  const colOf = state.piperColor === 'facies' ? (w=>facColor(w.fac)) : (w=>{ const c = valueClass(w); return c ? c[1] : cssVar('--c-none'); });
  const zOf = state.piperColor === 'facies' ? (()=>0) : (w=>{ const c = valueClass(w); return c ? c[0] : -1; });
  const order = pts.map(w=>[zOf(w), w]).sort((a,b)=>a[0]-b[0]).map(x=>x[1]);
  const r = order.length > 3000 ? 2 : order.length > 800 ? 2.6 : 3.4;
  ctx.globalAlpha = order.length > 3000 ? .55 : .8; ctx.lineWidth = .6; ctx.strokeStyle = theme === 'dark' ? 'rgba(0,0,0,.5)' : 'rgba(255,255,255,.8)';
  for(const w of order){
    const q = piperPts(G, w.pip); ctx.fillStyle = colOf(w);
    for(const p of [q.c, q.a, q.d]){ ctx.beginPath(); ctx.arc(p[0], p[1], r, 0, 6.2832); ctx.fill(); ctx.stroke(); }
  }
  ctx.globalAlpha = 1;
  // side info
  const total = SCOPE.length;
  $('piper-count').textContent = pts.length.toLocaleString() + ' of ' + total.toLocaleString() + ' wells';
  $('piper-note').textContent = 'Wells need latest Ca, Mg, Na, HCO₃, Cl and SO₄ to plot. K and CO₃ count as 0 when missing.' + (state.cbeOnly ? '' : ' Turn on the charge-balance filter to drop suspect analyses.');
  if(state.piperColor === 'facies'){
    const fc = new Map(); pts.forEach(w=>fc.set(w.fac, (fc.get(w.fac)||0)+1));
    $('piper-legend').innerHTML = '<h4 style="margin:0 0 6px;font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)">Water type</h4>' + FACIES_ORDER.filter(f=>fc.has(f)).map(f=>`<div class="row" style="margin-bottom:3px"><label style="font-size:11.5px"><span class="swatch" style="background:${facColor(f)}"></span>${f}</label><span class="count">${fc.get(f).toLocaleString()}</span></div>`).join('');
  } else {
    $('piper-legend').innerHTML = `<h4 style="margin:0 0 6px;font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)">${esc(AN[state.analyte].name)}</h4>` + valueLegend().map(r=>`<div class="row" style="margin-bottom:3px"><label style="font-size:11.5px"><span class="swatch" style="background:${r[1]}"></span>${r[2]}</label></div>`).join('');
  }
}

/* ---- Wells table ---- */
const WCOLS = [
  {k:'name', t:'Well', get:w=>w.name},
  {k:'source', t:'Source', get:w=>w.source},
  {k:'depth', t:'Depth ft', get:w=>w.depth},
  {k:'val', t:'Value', get:w=>val(w)},
  {k:'max', t:'Max', get:w=>val(w, null, 'max')},
  {k:'n', t:'Samples', get:w=>w.a[state.analyte] ? w.a[state.analyte].n : null},
  {k:'d2', t:'Latest', get:w=>w.a[state.analyte] ? w.a[state.analyte].d2 : null},
  {k:'fac', t:'Water type', get:w=>w.fac}
];
const WELL_ROWS = 400;
function renderWells(){
  const a = AN[state.analyte], s = stdOf(), sk = state.wellSort, col = WCOLS.find(c=>c.k === sk.k);
  const rows = SCOPE.slice().sort((x,y)=>{ const a_ = col.get(x), b_ = col.get(y); if(a_ == null && b_ == null) return 0; if(a_ == null) return 1; if(b_ == null) return -1; return (a_ < b_ ? -1 : a_ > b_ ? 1 : 0)*sk.d; });
  $('wells-count').textContent = SCOPE.length.toLocaleString() + ' wells' + (SCOPE.length > WELL_ROWS ? ' · showing the first ' + WELL_ROWS + ' by the sorted column; Export CSV includes all' : '');
  const lab = {val:(state.basis === 'latest' ? 'Latest' : state.basis === 'max' ? 'Max' : 'Mean') + ' ' + a.sym};
  $('wells-table').innerHTML = '<thead><tr>' + WCOLS.filter(c=>!(c.k === 'max' && state.basis === 'max')).map(c=>`<th class="sortable" data-sort="${c.k}">${esc(lab[c.k] || c.t)}${sk.k === c.k ? (sk.d < 0 ? ' ▾' : ' ▴') : ''}</th>`).join('') + '</tr></thead><tbody>' +
    rows.slice(0, WELL_ROWS).map(w=>{
      const v = val(w), over = s != null && v != null && v > s;
      return `<tr class="click" data-k="${esc(w.k)}"><td><span class="anm">${esc(w.name)}</span></td><td>${esc(w.source)}</td><td>${w.depth != null ? fmt(w.depth) : '–'}</td><td style="${over ? 'color:var(--c-over);font-weight:600' : ''}">${fmt(v)}${isWqp(w, state.analyte) ? wqpTag : ''}</td>${state.basis === 'max' ? '' : `<td>${fmt(val(w,null,'max'))}</td>`}<td>${w.a[state.analyte] && w.a[state.analyte].n != null ? w.a[state.analyte].n : '–'}</td><td>${w.a[state.analyte] && w.a[state.analyte].d2 || '–'}</td><td>${w.fac || '–'}</td></tr>`;
    }).join('') + '</tbody>';
}
$('wells-table').addEventListener('click', e=>{
  const th = e.target.closest('[data-sort]');
  if(th){ const k = th.dataset.sort; state.wellSort = {k, d:state.wellSort.k === k ? -state.wellSort.d : (['name','source','fac'].includes(k) ? 1 : -1)}; renderWells(); return; }
  const tr = e.target.closest('[data-k]'); if(!tr) return; const w = byKey.get(tr.dataset.k); if(!w) return;
  map.setView([w.lat, w.lng], Math.max(map.getZoom(), 12)); openWell(w);
});

function renderDrawer(){
  const a = AN[state.analyte];
  if(state.noAnalyte){
    $('drawer-title').textContent = 'No analyte selected';
    $('drawer-sub').textContent = (state.area ? state.area.name : 'Statewide') + ' · ' + SCOPE.length.toLocaleString() + ' wells · pick an analyte for its distribution';
    if($('drawer').classList.contains('collapsed')) return;
    if(state.dtab === 'summary') renderSummary(); else if(state.dtab === 'piper') drawPiper(); else renderWells();
    return;
  }
  $('drawer-title').textContent = a.name;
  $('drawer-sub').textContent = (state.area ? state.area.name : 'Statewide') + ' · ' + SCOPE.filter(w=>w.a[state.analyte]).length.toLocaleString() + ' wells with ' + a.name.toLowerCase() + (state.basis !== 'latest' ? ' · ' + state.basis + ' values' : '');
  if($('drawer').classList.contains('collapsed')) return;
  if(state.dtab === 'summary') renderSummary();
  else if(state.dtab === 'piper') drawPiper();
  else renderWells();
}

/* ==================================================================== */
/* 10. Single well: sample history                                      */
/* ==================================================================== */
const TS_CACHE = new Map();
let wmWell = null, wmKey = null, wmChart = null, wmRows = [];
function parseVal(raw, units, srcUnits){
  if(raw == null || raw === '') return null;
  if(typeof raw === 'number') return {v:toMg(raw, units), nd:false};
  const s = String(raw).replace(/&lt;/g,'<').trim(), n = Number(s);
  if(s !== '' && isFinite(n)) return {v:toMg(n, units), nd:false};
  const m = s.match(/^<\s*(?:MRL|MDL|RL|DL|PQL)?\s*([0-9]*\.?[0-9]+(?:e-?\d+)?)\s*([A-Za-zµμ\/]+)?/i);
  if(m){ let v = +m[1]; const u = (m[2] || srcUnits || units || '').toLowerCase(); if(/^(ug|µg|μg)\/l/.test(u)) v *= 0.001; return {v, nd:true}; }
  return null;
}
async function fetchSeries(w, key){
  const ck = w.k + '|' + key; if(TS_CACHE.has(ck)) return TS_CACHE.get(ck);
  const out = []; let offset = 0;
  for(;;){
    const j = await apiJson('/collections/nm_' + key + '_timeseries/items', {f:'json', limit:API_PAGE, offset, skipGeometry:'true', source:w.source, id:w.id});
    for(const f of (j.features||[])){ const p = f.properties; const pv = parseVal(p.parameter_value, p.parameter_units, p.source_parameter_units); const d = p.date_measured || (p.datetime || '').slice(0,10); if(!d) continue; out.push({d, raw:p.parameter_value, v:pv ? pv.v : null, nd:pv ? pv.nd : false, units:p.parameter_units, srcUnits:p.source_parameter_units, qual:p.qualifier, appr:p.approval_status_normalized}); }
    if(!j.features || j.features.length < API_PAGE) break; offset += API_PAGE;
  }
  out.sort((a,b)=>a.d < b.d ? -1 : a.d > b.d ? 1 : 0);
  TS_CACHE.set(ck, out); return out;
}
const decYr = d => { const y = +d.slice(0,4), m = +d.slice(5,7) || 1, dd = +d.slice(8,10) || 1; return y + ((m-1)*30.44 + dd - 1)/365.25; };
function openWell(w){
  wmWell = w; if(popup) map.closePopup(popup);
  $('wm-title').textContent = w.name;
  $('wm-sub').innerHTML = esc(w.source) + ' · ' + esc(w.id) + (w.wqpType ? ' · ' + esc(w.wqpType) : '') + (w.depth != null ? ' · ' + fmt(w.depth) + ' ft deep' : '') + (w.elev != null ? ' · land surface ' + Math.round(w.elev).toLocaleString() + ' ft' : '') + (w.usgs ? ` · <a href="https://waterdata.usgs.gov/monitoring-location/USGS-${encodeURIComponent(String(w.usgs).replace(/^USGS-/i,''))}/" target="_blank" rel="noopener" style="color:var(--accent)">USGS ${esc(String(w.usgs).replace(/^USGS-/i,''))}</a>` : '') + (Object.values(w.a).some(x=>x.src === 'wqp') ? ` · <a href="https://www.waterqualitydata.us/data/Result/search?siteid=${encodeURIComponent(w.source === WQP_SRC ? w.id : w.wqpId || w.id)}&mimeType=csv&zip=no" target="_blank" rel="noopener" style="color:var(--accent)">WQP results</a>` : '') + ` · ${w.lat.toFixed(5)}, ${w.lng.toFixed(5)}`;
  $('wm-chips').innerHTML = ANALYTES.map(a=>{
    const x = w.a[a.key], s = a[state.std] ? a[state.std].v : null;
    const over = x && s != null && x.max != null && x.max > s;
    return `<button class="achip" data-wa="${a.key}" ${x ? '' : 'disabled'}><span class="s">${over ? '<span class="flag" style="background:var(--c-over)"></span>' : ''}${a.sym}${x && x.src === 'wqp' ? wqpTag : ''}</span><span class="v">${x ? fmt(x.last) + (x.n ? ' · n' + x.n : '') : 'none'}</span></button>`;
  }).join('');
  $('well-modal').classList.remove('hidden');
  const k = w.a[state.analyte] ? state.analyte : (ANALYTES.find(a=>w.a[a.key]) || {}).key;
  if(k) showSeries(k);
}
$('wm-chips').addEventListener('click', e=>{ const b = e.target.closest('[data-wa]'); if(b && !b.disabled) showSeries(b.dataset.wa); });
async function showSeries(key){
  wmKey = key; const w = wmWell, a = AN[key];
  document.querySelectorAll('#wm-chips .achip').forEach(b=>b.classList.toggle('active', b.dataset.wa === key));
  $('wm-status').classList.remove('hidden'); $('wm-status').textContent = 'Loading ' + a.name.toLowerCase() + ' samples…';
  if(wmChart){ wmChart.destroy(); wmChart = null; }
  try{ wmRows = await fetchSeries(w, key); }
  catch(e){ $('wm-status').textContent = 'Could not load samples: ' + e.message; return; }
  if(wmWell !== w || wmKey !== key) return;
  renderSeries();
}
function renderSeries(){
  const w = wmWell, key = wmKey, a = AN[key], s = a[state.std] ? a[state.std].v : null;
  if(wmChart){ wmChart.destroy(); wmChart = null; }
  const rows = wmRows.filter(r=>r.v != null);
  const logy = $('wm-log').checked;
  const det = rows.filter(r=>!r.nd && (!logy || r.v > 0)).map(r=>({x:decYr(r.d), y:r.v, r}));
  const nd = rows.filter(r=>r.nd && (!logy || r.v > 0)).map(r=>({x:decYr(r.d), y:r.v, r}));
  const ndN = wmRows.filter(r=>r.nd).length;
  const srcNote = isWqp(w, key) ? 'Water Quality Portal (waterqualitydata.us), one value per sample date' : `<code>nm_${key}_timeseries</code>`;
  $('wm-foot').innerHTML = `${wmRows.length.toLocaleString()} ${a.name.toLowerCase()} samples` + (wmRows.length ? `, ${wmRows[0].d} to ${wmRows[wmRows.length-1].d}` : '') + (ndN ? ` · ${ndN} reported below the reporting limit (open triangles at the limit)` : '') + (s != null ? ` · ${STD_LABEL[state.std]}: ${fmt(s)} ${UNIT}` : ' · no drinking-water standard') + `. Source: ${srcNote}.`;
  if(!rows.length){ $('wm-status').classList.remove('hidden'); $('wm-status').textContent = 'No numeric samples returned for ' + a.name.toLowerCase() + ' at this well.'; return; }
  $('wm-status').classList.add('hidden');
  const xs = rows.map(r=>decYr(r.d)); let x0 = Math.min(...xs), x1 = Math.max(...xs); if(x1 - x0 < 1){ x0 -= 1; x1 += 1; }
  const ink = cssVar('--ink-2'), grid = cssVar('--border'), muted = cssVar('--muted'), acc = cssVar('--accent');
  const ds = [
    {label:'Measured', data:det, showLine:det.length > 1, borderColor:acc, backgroundColor:acc, pointRadius:det.length > 200 ? 2 : 3.5, borderWidth:1.4, tension:0},
    {label:'Below reporting limit', data:nd, showLine:false, pointStyle:'triangle', pointRadius:5, borderColor:muted, backgroundColor:'transparent', borderWidth:1.4}
  ];
  if(s != null && $('wm-std').checked) ds.push({label:STD_LABEL[state.std] + ' ' + fmt(s), data:[{x:x0, y:s},{x:x1, y:s}], showLine:true, pointRadius:0, borderColor:cssVar('--c-over'), borderDash:[6,4], borderWidth:1.6});
  wmChart = new Chart($('wm-canvas'), {
    type:'scatter', data:{datasets:ds},
    options:{responsive:true, maintainAspectRatio:false, animation:false,
      plugins:{legend:{labels:{color:ink, boxWidth:14, font:{size:11}}},
        tooltip:{callbacks:{label:it=>{ const r = it.raw.r; if(!r) return it.dataset.label; return r.d + ': ' + (r.nd ? '< ' + fmt(r.v) + ' (' + String(r.raw).replace(/&lt;/g,'<') + ')' : fmt(r.v) + ' ' + UNIT) + (r.qual ? ' · ' + r.qual : ''); }}}},
      scales:{x:{type:'linear', min:Math.floor(x0), max:Math.ceil(x1), ticks:{color:muted, callback:v=>Math.round(v) === v ? String(v) : '', font:{family:cssVar('--font-mono'), size:10}}, grid:{color:grid}},
              y:{type:logy ? 'logarithmic' : 'linear', beginAtZero:!logy, ticks:{color:muted, callback:v=>fmt(v), font:{family:cssVar('--font-mono'), size:10}}, grid:{color:grid}, title:{display:true, text:a.name + ' (' + UNIT + ')', color:ink}}}},
    plugins:[bgPlugin]
  });
}
$('wm-log').addEventListener('change', renderSeries);
$('wm-std').addEventListener('change', renderSeries);
function closeModal(id){ $(id).classList.add('hidden'); }
$('wm-close').onclick = ()=>closeModal('well-modal');
$('well-modal').addEventListener('click', e=>{ if(e.target.id === 'well-modal') closeModal('well-modal'); });
const TS_HEAD = ['source','id','name','analyte','date','value_mg_L','below_reporting_limit','reported_value','parameter_units','source_units','qualifier','approval_status'];
const tsRow = (w, key, r) => [w.source, w.id, w.name, key, r.d, r.v != null ? r.v : '', r.nd ? 'yes' : 'no', String(r.raw == null ? '' : r.raw).replace(/&lt;/g,'<'), r.units || '', r.srcUnits || '', r.qual || '', r.appr || ''];
$('wm-csv').onclick = ()=>{ if(!wmWell || !wmKey) return; downloadCsv(TS_HEAD, wmRows.map(r=>tsRow(wmWell, wmKey, r)), slug(wmWell.name) + '_' + wmKey + '.csv'); };
$('wm-csv-all').onclick = async ()=>{
  const w = wmWell; if(!w) return; const keys = ANALYTES.filter(a=>w.a[a.key]).map(a=>a.key);
  toast('Fetching ' + keys.length + ' sample histories…');
  try{ const all = await apiPool(keys.map(k=>()=>fetchSeries(w, k).then(rs=>rs.map(r=>tsRow(w, k, r)))), 4); downloadCsv(TS_HEAD, all.flat(), slug(w.name) + '_all_analytes.csv'); }
  catch(e){ toast('Download failed: ' + e.message); }
};
$('wm-png').onclick = ()=>{ if(wmChart) downloadUrl(wmChart.toBase64Image('image/png', 1), slug(wmWell.name) + '_' + wmKey + '.png'); };

/* ==================================================================== */
/* 11. Exports                                                          */
/* ==================================================================== */
const slug = s => String(s).replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '').toLowerCase() || 'export';
const csvCell = v => { v = v == null ? '' : String(v); return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g,'""') + '"' : v; };
function downloadBlob(blob, name){ const u = URL.createObjectURL(blob); downloadUrl(u, name); setTimeout(()=>URL.revokeObjectURL(u), 4000); }
function downloadUrl(u, name){ const a = document.createElement('a'); a.href = u; a.download = name; document.body.appendChild(a); a.click(); a.remove(); }
function downloadCsv(head, rows, name){ downloadBlob(new Blob([[head, ...rows].map(r=>r.map(csvCell).join(',')).join('\r\n')], {type:'text/csv'}), name); }
function wellRecord(w){
  const o = {source:w.source, id:w.id, name:w.name, latitude:w.lat, longitude:w.lng, well_depth_ft:w.depth, usgs_site_id:w.usgs, water_type:w.fac, charge_balance_pct:w.cbe != null ? +w.cbe.toFixed(2) : null, wqp_analytes:ANALYTES.filter(a=>isWqp(w, a.key)).map(a=>a.key).join(' ')};
  for(const a of ANALYTES){ const x = w.a[a.key], s = a[state.std] ? a[state.std].v : null; o[a.key+'_latest'] = x ? x.last : null; o[a.key+'_latest_date'] = x ? x.d2 : null; o[a.key+'_max'] = x ? x.max : null; o[a.key+'_mean'] = x ? x.mean : null; o[a.key+'_n'] = x ? x.n : null; if(s != null) o[a.key+'_exceeds_' + state.std] = x && x.max != null ? (val(w, a.key) > s ? 'yes' : 'no') : null; }
  return o;
}
function exportName(ext){ return 'nm_water_chemistry_' + slug(state.area ? state.area.name : 'statewide') + '.' + ext; }
$('btn-export-csv').onclick = ()=>{ if(!SCOPE.length){ toast('No wells in the current selection.'); return; } const recs = SCOPE.map(wellRecord), head = Object.keys(recs[0]); downloadCsv(head, recs.map(r=>head.map(h=>r[h])), exportName('csv')); toast('Exported ' + SCOPE.length.toLocaleString() + ' wells (exceedance flags use ' + state.basis + ' values)'); };
$('btn-export-geojson').onclick = ()=>{ if(!SCOPE.length){ toast('No wells in the current selection.'); return; } const fc = {type:'FeatureCollection', features:SCOPE.map(w=>({type:'Feature', geometry:{type:'Point', coordinates:[w.lng, w.lat]}, properties:wellRecord(w)}))}; downloadBlob(new Blob([JSON.stringify(fc)], {type:'application/geo+json'}), exportName('geojson')); };
$('btn-hist-png').onclick = ()=>{ if(histChart) downloadUrl(histChart.toBase64Image('image/png', 1), 'histogram_' + state.analyte + '_' + slug(state.area ? state.area.name : 'statewide') + '.png'); };
$('btn-piper-png').onclick = ()=>{ downloadUrl($('piper-canvas').toDataURL('image/png'), 'piper_' + slug(state.area ? state.area.name : 'statewide') + '.png'); };

/* ==================================================================== */
/* 12. Chrome: theme, help, drawer, sidebar resize, toast               */
/* ==================================================================== */
let toastT = null;
function toast(msg, ms){ const el = $('toast'); el.textContent = msg; el.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(()=>el.classList.remove('show'), ms || 2800); }
$('theme-toggle').onclick = ()=>{ theme = theme === 'dark' ? 'light' : 'dark'; document.documentElement.setAttribute('data-theme', theme); ls.set('wq-theme', theme); setBasemap(); if(areaLayer){ areaLayer.setStyle({color:cssVar('--accent'), fillColor:cssVar('--accent')}); } update(); dwRedraw(); if(!$('well-modal').classList.contains('hidden') && wmRows.length) renderSeries(); };
$('help-toggle').onclick = ()=>{
  if($('help-ccr-meta')) $('help-ccr-meta').textContent = CCR ? CCR.years.join(' and ') + ' reports for ' + Object.keys(CCR.s).length.toLocaleString() + ' systems, read ' + CCR.gen : 'none built into this copy';
  $('help-std').innerHTML = '<table><thead><tr><th>Analyte</th><th>EPA (mg/L)</th><th>NM groundwater (mg/L)</th></tr></thead><tbody>' + ANALYTES.filter(a=>a.epa).map(a=>`<tr><td>${esc(a.name)}</td><td class="n">${fmt(a.epa.v)} <span style="color:var(--muted)">${esc(a.epa.k)}</span></td><td class="n">${fmt(a.nm.v)}</td></tr>`).join('') + '</tbody></table><p style="color:var(--muted)">Calcium, magnesium, sodium, potassium, bicarbonate and carbonate have no drinking-water standard. Their map classes are statewide quintiles.</p>';
  $('help-modal').classList.remove('hidden');
};
$('help-close').onclick = ()=>closeModal('help-modal');
$('help-modal').addEventListener('click', e=>{ if(e.target.id === 'help-modal') closeModal('help-modal'); });
function toggleDrawer(){ const c = $('drawer').classList.toggle('collapsed'); $('drawer-toggle').textContent = c ? '▴' : '▾'; setTimeout(()=>{ map.invalidateSize(); if(!c) renderDrawer(); }, 30); }
$('drawer-toggle').onclick = toggleDrawer;
(function(){ // drawer + sidebar resize
  const dr = $('drawer'); let sy = 0, sh = 0, on = false;
  $('drawer-resize').addEventListener('pointerdown', e=>{ if(dr.classList.contains('collapsed')) return; on = true; sy = e.clientY; sh = dr.offsetHeight; e.target.setPointerCapture(e.pointerId); });
  $('drawer-resize').addEventListener('pointermove', e=>{ if(!on) return; dr.style.height = Math.max(160, Math.min(window.innerHeight - 160, sh + sy - e.clientY)) + 'px'; });
  $('drawer-resize').addEventListener('pointerup', ()=>{ if(!on) return; on = false; map.invalidateSize(); renderDrawer(); });
  // left and right drawers: drag the inner edge; widths are remembered
  function sideResize(panelId, handleId, dir, min, key){
    const sb = $(panelId), h = $(handleId); let sx = 0, sw = 0, on = false;
    const max = () => Math.max(min, Math.min(620, window.innerWidth - 420));
    const saved = +ls.get(key); if(saved) sb.style.width = Math.max(min, Math.min(max(), saved)) + 'px';
    h.addEventListener('pointerdown', e=>{ on = true; sx = e.clientX; sw = sb.offsetWidth; h.classList.add('on'); h.setPointerCapture(e.pointerId); });
    h.addEventListener('pointermove', e=>{ if(!on) return; sb.style.width = Math.max(min, Math.min(max(), sw + dir*(e.clientX - sx))) + 'px'; map.invalidateSize({pan:false}); });
    const end = ()=>{ if(!on) return; on = false; h.classList.remove('on'); ls.set(key, sb.offsetWidth); map.invalidateSize(); };
    h.addEventListener('pointerup', end); h.addEventListener('pointercancel', end);
    h.addEventListener('dblclick', ()=>{ sb.style.width = ''; ls.set(key, ''); map.invalidateSize(); });
  }
  sideResize('sidebar', 'sidebar-resize', 1, 260, 'wq-left-w');
  sideResize('rightbar', 'rightbar-resize', -1, 240, 'wq-right-w');
})();
let rT = null; window.addEventListener('resize', ()=>{ clearTimeout(rT); rT = setTimeout(()=>{ if(state.dtab === 'piper') drawPiper(); }, 120); });

/* ==================================================================== */
/* 13. Water Quality Portal: pull an area's results and merge them      */
/* ==================================================================== */
const WQP_BASE = 'https://www.waterqualitydata.us/data';
const WQP_STORE = 'wqp-pulls-v1', WQP_SRC = 'WQP (direct)';
const NM_BB = [-109.06, 31.33, -103.0, 37.0];
let WQP_PULLS = [], wqpBusy = false, wqpCancel = false;
// API wells that WQP may also carry: by WQP site ID ('WQP:<id>') or by USGS site number
const USGS_IDX = new Map();
for(const w of WELLS) if(w.usgs){ const u = 'USGS-' + String(w.usgs).replace(/^USGS-/i, ''); if(!USGS_IDX.has(u)) USGS_IDX.set(u, w); }

function wqpMerge(site){
  const st = site.st;
  let w = byKey.get('WQP:' + st.id) || byKey.get(WQP_SRC + ':' + st.id) || USGS_IDX.get(st.id), created = false;
  if(!w){
    created = true;
    w = {k:WQP_SRC + ':' + st.id, source:WQP_SRC, id:st.id, name:st.name || st.id, lng:st.lng, lat:st.lat, elev:st.elev, depth:st.depth, usgs:/^USGS-\d+$/.test(st.id) ? st.id.slice(5) : '', a:{}, wqpType:st.type, wqpOrg:st.org};
    WELLS.push(w); byKey.set(w.k, w);
    if(!SOURCES.includes(WQP_SRC)){ SOURCES.push(WQP_SRC); state.sources.add(WQP_SRC); }
  } else if(!w.wqpId && w.source !== WQP_SRC) w.wqpId = st.id;
  if(w.depth == null && st.depth != null) w.depth = st.depth;
  let added = 0;
  for(const key in site.a){
    if(!AN[key]) continue;
    const cur = w.a[key]; if(cur && cur.src !== 'wqp') continue;   // API values win
    const sm = WQPCore.summary(site.a[key]); if(!sm) continue;
    w.a[key] = sm; TS_CACHE.set(w.k + '|' + key, site.a[key]); added++;
  }
  if(added) derive(w);
  return {created, added};
}
function wqpApply(pull){
  let created = 0, filledWells = 0, records = 0;
  for(const s of pull.sites){ const r = wqpMerge(s); if(r.created) created++; else if(r.added) filledWells++; records += r.added; }
  return {created, filledWells, records};
}
// groundwater site types (WQP's resolved siteType codes) used for the 13-analyte merge
const WQP_GW_TYPES = ['Well', 'Spring', 'Subsurface', 'Aggregate groundwater use'];
function wqpTypes(){ if(!wqp.sites) return ['Well', 'Spring']; const on = new Set(wqp.sites.filter(q=>wqp.types.has(q.t)).map(q=>q.f)); return WQP_GW_TYPES.filter(t=>on.has(t)); }
function wqpUrl(kind, bb, opt){
  const p = new URLSearchParams();
  p.set('statecode', 'US:35');
  p.set('bBox', bb.map(x=>(+x).toFixed(4)).join(','));
  p.set('sampleMedia', 'Water');
  opt.types.forEach(t=>p.append('siteType', t));
  if(opt.chars !== false) WQPCore.NAMES.forEach(n=>p.append('characteristicName', n));
  if(kind === 'Result') p.set('sorted', 'no');
  if(opt.lo) p.set('startDateLo', WQPCore.mdy(opt.lo));
  if(opt.hi) p.set('startDateHi', WQPCore.mdy(opt.hi));
  p.set('mimeType', opt.mime || 'csv'); p.set('zip', 'no');
  if(opt.extra) for(const k in opt.extra) p.set(k, opt.extra[k]);
  return WQP_BASE + '/' + kind + '/search?' + p;
}
// text of a WQP response; err.big marks "too much data at once" (504 or timeout) so callers can split the date range
async function wqpFetch(url, ms){
  let last = null;
  for(let a=0; a<3; a++){
    let res;
    try{
      res = await Promise.race([
        fetch(url).then(async r=>({r, t: await r.text()})),
        sleep(ms || 150000).then(()=>{ const e = new Error('WQP took too long to answer'); e.big = true; throw e; })
      ]);
    }catch(e){ if(e.big) throw e; last = e; await sleep(1500*(a+1)); continue; }
    if(res.r.ok) return res.t;
    const plain = res.t.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);
    const err = new Error('WQP returned HTTP ' + res.r.status + (plain ? ': ' + plain : ''));
    if(res.r.status === 504 || res.r.status === 502){ err.big = true; throw err; }
    if(res.r.status < 500 && res.r.status !== 429) throw err;
    last = err; await sleep(2000*(a+1));
  }
  throw last || new Error('WQP unavailable');
}
async function wqpRange(bb, opt, lo, hi, onText, failed){
  if(wqpCancel) return;
  try{ await onText(await wqpFetch(wqpUrl('Result', bb, Object.assign({}, opt, {lo, hi})))); }
  catch(e){
    const days = (Date.parse(hi) - Date.parse(lo))/864e5;
    if(e.big && days > 45 && !wqpCancel){
      const mid = WQPCore.isoAdd(lo, Math.floor(days/2));
      await wqpRange(bb, opt, lo, mid, onText, failed);
      await wqpRange(bb, opt, WQPCore.isoAdd(mid, 1), hi, onText, failed);
    } else failed.push({lo, hi, msg:e.message});
  }
}
async function wqpSites(bb, opt){
  const all = WQPCore.stations(await wqpFetch(wqpUrl('Station', bb, opt)));
  const keep = new Map(); for(const [id, s] of all) if(inArea(s)) keep.set(id, s);
  return keep;
}
function wqpAreaBox(){ if(!state.area) return NM_BB; const b = state.area.bb; return [Math.max(b[0]-.001, NM_BB[0]-.5), Math.max(b[1]-.001, NM_BB[1]-.5), Math.min(b[2]+.001, NM_BB[2]+.5), Math.min(b[3]+.001, NM_BB[3]+.5)]; }
const wqpProg = (msg, err) => { const el = $('wqp-progress'); el.textContent = msg; el.classList.toggle('err', !!err); };
function wqpBtnLabel(){ $('btn-wqp-load').textContent = wqpBusy ? 'Stop' : 'Add WQP chemistry for ' + (state.area ? 'this area' : 'all of New Mexico'); }

async function wqpLoad(){
  if(wqpBusy){ wqpCancel = true; wqpProg('Stopping after the current request…'); return; }
  const types = wqpTypes(); if(!types.length){ toast('Check at least one groundwater site type: well, spring, subsurface or aggregate groundwater use.', 4200); return; }
  const name = state.area ? state.area.name : 'All of New Mexico', bb = wqpAreaBox();
  const from = $('wqp-from').value || null, to = $('wqp-to').value || null;
  if(from && to && from > to){ toast('The start date is after the end date.'); return; }
  const opt = {types};
  wqpBusy = true; wqpCancel = false; wqpBtnLabel();
  try{
    wqpProg('Finding WQP sites in ' + name + '…');
    const sites = await wqpSites(bb, opt);
    if(!sites.size){ wqpProg('WQP has no ' + types.join(' or ').toLowerCase() + ' sites with these analytes in ' + name + '.'); return; }
    const acc = new Map(), failed = [], chunks = WQPCore.chunks(from, to);
    let rows = 0, done = 0;
    const tick = ()=>wqpProg(sites.size.toLocaleString() + ' sites · ' + done + ' of ' + chunks.length + ' date ranges · ' + rows.toLocaleString() + ' results');
    tick();
    await apiPool(chunks.map(([lo, hi])=>async()=>{ await wqpRange(bb, opt, lo, hi, async t=>{ rows += WQPCore.addResults(t, sites, acc); tick(); }, failed); done++; tick(); }), 2);
    if(wqpCancel){ wqpProg('Stopped. Nothing from this pull was added.'); return; }
    const built = WQPCore.buildSites(sites, acc);
    if(!built.length){ wqpProg('No usable results for the 13 analytes at ' + sites.size.toLocaleString() + ' sites in ' + name + '.'); return; }
    const pull = {id:'p' + Date.now(), name, t:Date.now(), types, from, to, nSites:built.length, rows, failed:failed.length, sites:built};
    const r = wqpApply(pull);
    WQP_PULLS = WQP_PULLS.filter(p=>!(p.name === name && p.types.join() === types.join() && p.from === from && p.to === to));
    WQP_PULLS.push(pull);
    await idbSet(WQP_STORE, {pulls:WQP_PULLS});
    QCACHE.clear(); renderSources(); update(); renderWqpPulls();
    wqpProg(`Added ${r.created.toLocaleString()} new wells and filled ${r.filledWells.toLocaleString()} API wells (${r.records.toLocaleString()} analyte records) from ${rows.toLocaleString()} results.` + (failed.length ? ` ${failed.length} date range${failed.length > 1 ? 's' : ''} kept failing and ${failed.length > 1 ? 'were' : 'was'} skipped: ${failed.map(f=>f.lo + ' to ' + f.hi).join(', ')}.` : ''), failed.length > 0);
    toast('WQP data added for ' + name);
  }catch(e){ console.error(e); wqpProg('Could not load WQP data: ' + e.message, true); }
  finally{ wqpBusy = false; wqpCancel = false; wqpBtnLabel(); }
}
function renderWqpPulls(){
  if(!WQP_PULLS.length){ $('wqp-pulls').innerHTML = '<p class="hint" style="margin:0">Nothing yet. Results you add stay in this browser until you remove them.</p>'; return; }
  $('wqp-pulls').innerHTML = WQP_PULLS.map(p=>`<div class="pull"><div><b>${esc(p.name)}</b><small>${esc(p.types.join(' + '))} · ${p.nSites.toLocaleString()} sites · ${p.rows.toLocaleString()} results${p.from || p.to ? ' · ' + esc((p.from || 'start') + ' to ' + (p.to || 'today')) : ''}<br>pulled ${new Date(p.t).toLocaleDateString()}${p.failed ? ' · ' + p.failed + ' date ranges skipped' : ''}</small></div><button class="xbtn" data-pull="${esc(p.id)}" title="Remove this pull" aria-label="Remove this pull">✕</button></div>`).join('');
}
$('wqp-pulls').addEventListener('click', async e=>{
  const b = e.target.closest('[data-pull]'); if(!b) return;
  WQP_PULLS = WQP_PULLS.filter(p=>p.id !== b.dataset.pull);
  await idbSet(WQP_STORE, {pulls:WQP_PULLS}); location.reload();   // rebuilds the wells without that pull
});
$('wqp-clear-all').onclick = async ()=>{ if(!WQP_PULLS.length) return; await idbDel(WQP_STORE); location.reload(); };
$('btn-wqp-load').onclick = wqpLoad;
$('wqp-date-clear').onclick = ()=>{ $('wqp-from').value = ''; $('wqp-to').value = ''; };
/* ---- WQP site catalog: every NM monitoring location (WQP Station service, as in the WQP polygon downloader),
        with water-result counts by parameter group from WQP's summary service ---- */
const WQP_SITES_KEY = 'wqp-stations-v1';
// same colors as the WQP polygon downloader; other types are grey
const WQP_TYPE_COLORS = {'Stream':'#1f77b4', 'Lake, Reservoir, Impoundment':'#17becf', 'Spring':'#2ca02c', 'Well':'#8c564b', 'Wetland':'#00897b', 'Estuary':'#9467bd', 'Ocean':'#0b3d91', 'Glacier':'#5bc8e2', 'Subsurface':'#5d4037', 'Aggregate surface-water-use':'#3f51b5', 'Aggregate groundwater-use':'#607d8b', 'Atmosphere':'#ff7f0e', 'Facility':'#e377c2', 'Land':'#a3a825'};
const wqpColor = t => WQP_TYPE_COLORS[t] || '#999999';
const wqp = {sites:null, byId:null, promise:null, at:null, allTypes:[], types:null, exGroups:new Set(), show:false};   // the map starts empty; turned on when the WQP tab is opened
(()=>{ try{ const off = JSON.parse(ls.get('wq-wqp-types-off2') || '[]'); if(off.length) wqp.typesOff = new Set(off); }catch(e){} })();
$('wqp-show').checked = wqp.show;
let wqpOpened = false;
function wqpOpen(){ if(!wqpOpened && ls.get('wq-wqp-show') !== 'off'){ wqp.show = true; $('wqp-show').checked = true; } wqpOpened = true; wqpEnsure().catch(()=>{}); }
async function wqpEnsure(){
  if(wqp.sites) return wqp.sites;
  if(wqp.promise) return wqp.promise;
  $('wqp-status').textContent = 'Loading every WQP monitoring location in New Mexico (about 48,000). The first load takes 10–30 seconds; after that it is kept in this browser for a day.';
  wqp.promise = (async()=>{
    let d = await idbGet(WQP_SITES_KEY);
    if(!d || !d.sites || Date.now() - d.t > CACHE_TTL){
      const stU = WQP_BASE + '/Station/search?' + new URLSearchParams({statecode:'US:35', mimeType:'geojson', zip:'no'});
      const smU = WQP_BASE + '/summary/monitoringLocation/search?' + new URLSearchParams({statecode:'US:35', sampleMedia:'Water', dataProfile:'summaryMonitoringLocation', summaryYears:'all', mimeType:'geojson', zip:'no'});
      const [stT, smT] = await Promise.all([wqpFetch(stU, 300000), wqpFetch(smU, 240000).catch(()=>null)]);
      const sum = new Map(); if(smT) for(const f of (JSON.parse(smT).features || [])){ const p = f.properties || {}; sum.set(p.MonitoringLocationIdentifier, p); }
      const sites = [];
      for(const f of (JSON.parse(stT).features || [])){
        const p = f.properties || {}, c = f.geometry && f.geometry.coordinates;
        if(!c || !isFinite(+c[0]) || !isFinite(+c[1]) || !p.MonitoringLocationIdentifier) continue;
        const w = sum.get(p.MonitoringLocationIdentifier);   // water results by parameter group
        const t = p.MonitoringLocationTypeName || 'Unknown';
        sites.push({id:p.MonitoringLocationIdentifier, n:p.MonitoringLocationName || '', t, mt:t, f:String(p.ResolvedMonitoringLocationTypeName || '').trim(), lng:+c[0], lat:+c[1], org:p.OrganizationIdentifier || '', orgN:p.OrganizationFormalName || '', prov:p.ProviderName || '', county:p.CountyName || '', huc:p.HUCEightDigitCode || '', url:p.siteUrl || '', a:w ? +w.activityCount || 0 : 0, r:w ? +w.resultCount || 0 : 0, g:w ? w.characteristicGroupResultCount || {} : {}});
      }
      if(!sites.length) throw new Error('WQP returned no stations');
      d = {t:Date.now(), sites}; await idbSet(WQP_SITES_KEY, d);
    }
    wqp.sites = d.sites; wqp.at = d.t; wqp.byId = new Map(d.sites.map(q=>[q.id, q]));
    const cnt = new Map(); d.sites.forEach(q=>cnt.set(q.t, (cnt.get(q.t)||0) + 1));
    wqp.allTypes = [...cnt.keys()].sort((a,b)=>cnt.get(b) - cnt.get(a));
    wqp.types = new Set(wqp.allTypes.filter(t=>!(wqp.typesOff && wqp.typesOff.has(t))));
    wqpRender(); wqpRedraw();
    return wqp.sites;
  })().catch(e=>{ wqp.promise = null; $('wqp-status').textContent = 'Could not load the WQP site list: ' + e.message; throw e; });
  return wqp.promise;
}
const wqpSel = () => wqp.sites ? wqp.sites.filter(q=>wqp.types.has(q.t) && inArea(q)) : [];
function wqpGroupsOf(sel){ const m = new Map(); for(const q of sel) for(const g in q.g) m.set(g, (m.get(g)||0) + (+q.g[g] || 0)); return m; }
function wqpRedraw(){
  if(!wqp.sites || !wqp.show){ wqpPoints.setData([]); return; }
  const items = [];
  for(const q of wqp.sites) if(wqp.types.has(q.t)) items.push({w:q, c:wqpColor(q.t), ring:true, dim:!!state.area && !inArea(q)});
  items.sort((a,b)=>(b.dim ? 1 : 0) - (a.dim ? 1 : 0));
  wqpPoints.setData(items); renderWqpLegend();
}
function renderWqpLegend(){
  const el = $('legend-wqp'); if(!el) return;
  if(!wqp.sites || !wqp.show){ el.innerHTML = ''; return; }
  const sel = wqpSel(), cnt = new Map(); sel.forEach(q=>cnt.set(q.t, (cnt.get(q.t)||0) + 1));
  el.innerHTML = '<div class="lg-sep"></div><h5>WQP sites</h5>' + wqp.allTypes.filter(t=>wqp.types.has(t) && cnt.get(t)).map(t=>`<div class="lg-row"><span class="ring" style="border-color:${wqpColor(t)}"></span><span class="k">${esc(t)}</span><span class="n">${(cnt.get(t)||0).toLocaleString()}</span></div>`).join('') + (state.area ? '<div class="lg-note">Counts are inside ' + esc(state.area.name) + '; sites outside are faded.</div>' : '');
}
// estimated download size for the current selection (results, all years, minus unticked groups)
function wqpEstimate(sel){ let r = 0; for(const q of sel){ let n = q.r; for(const g of wqp.exGroups) n -= (+q.g[g] || 0); r += Math.max(0, n); } return r; }
const fmtMB = rows => { const mb = rows*350/1048576; return mb >= 1024 ? (mb/1024).toFixed(1) + ' GB' : mb >= 10 ? Math.round(mb) + ' MB' : mb.toFixed(1) + ' MB'; };
function wqpRender(){
  wqpBtnLabel();
  if(!wqp.sites){ return; }
  const sel = wqpSel(), name = state.area ? state.area.name : 'All of New Mexico';
  const res = sel.reduce((t,q)=>t + q.r, 0), act = sel.reduce((t,q)=>t + q.a, 0);
  $('wqp-sel-n').textContent = sel.length.toLocaleString() + ' WQP site' + (sel.length === 1 ? '' : 's');
  $('wqp-sel-lbl').textContent = name + ' · ' + res.toLocaleString() + ' water results · ' + act.toLocaleString() + ' sampling events, all years';
  $('wqp-status').textContent = wqp.sites.length.toLocaleString() + ' NM monitoring locations, as of ' + new Date(wqp.at).toLocaleDateString() + '. Pick the area in the right-hand drawer.';
  // site types, counted inside the area
  const inA = wqp.sites.filter(q=>inArea(q)), tc = new Map(); inA.forEach(q=>tc.set(q.t, (tc.get(q.t)||0) + 1));
  $('wqp-types').innerHTML = wqp.allTypes.slice().sort((a,b)=>(tc.get(b)||0) - (tc.get(a)||0)).map(t=>`<label class="wrow${tc.get(t) ? '' : ' zero'}"><input type="checkbox" data-wt="${esc(t)}" ${wqp.types.has(t) ? 'checked' : ''}><span class="ring" style="border-color:${wqpColor(t)}"></span><span class="k">${esc(t)}</span><span class="n">${(tc.get(t)||0).toLocaleString()}</span></label>`).join('');
  // parameter groups for the selected sites
  const gm = wqpGroupsOf(sel), gs = [...gm.entries()].sort((a,b)=>b[1] - a[1]);
  $('wqp-groups').innerHTML = gs.length ? gs.map(([g, n])=>`<label class="wrow"><input type="checkbox" data-wg="${esc(g)}" ${wqp.exGroups.has(g) ? '' : 'checked'}><span class="k" title="${esc(g)}">${esc(g)}</span><span class="n">${n.toLocaleString()}</span></label>`).join('') : '<p class="hint" style="margin:8px">No WQP water results for these sites.</p>';
  // download button
  if(!dlBusy){
    const est = wqpEstimate(sel), mode = sel.length <= WQP_GET_MAX ? 'get' : sel.length <= WQP_POST_MAX ? 'post' : 'area';
    $('wqp-dl').disabled = !sel.length || !est;
    $('wqp-dl').textContent = sel.length ? 'Download ' + (wqp.exGroups.size ? 'selected parameters' : 'all results') + ' for ' + sel.length.toLocaleString() + ' site' + (sel.length === 1 ? '' : 's') : 'No sites selected';
    $('wqp-dl-hint').textContent = !sel.length ? '' : 'About ' + est.toLocaleString() + ' results (≈' + fmtMB(est) + ') before any date limit. ' + (mode === 'get' ? 'WQP builds the file and your browser downloads it directly.' : mode === 'post' ? 'Fetched in batches of ' + WQP_POST_BATCH + ' sites (smaller batches if WQP is slow), then saved as one CSV.' : 'Queried by area and date range and ' + (('showSaveFilePicker' in window) ? 'written straight to a file you choose as it arrives.' : 'held in memory, then saved. Chrome or Edge can stream large downloads straight to disk instead.'));
  }
}
$('wqp-show').addEventListener('change', e=>{ wqp.show = e.target.checked; ls.set('wq-wqp-show', wqp.show ? 'on' : 'off'); if(wqp.show) wqpEnsure().then(wqpRedraw).catch(()=>{}); else wqpRedraw(); });
function wqpSaveTypes(){ ls.set('wq-wqp-types-off2', JSON.stringify(wqp.allTypes.filter(t=>!wqp.types.has(t)))); }
$('wqp-types').addEventListener('change', e=>{ const t = e.target.dataset.wt; if(t == null) return; e.target.checked ? wqp.types.add(t) : wqp.types.delete(t); wqpSaveTypes(); wqpRender(); wqpRedraw(); });
$('wqp-types-all').onclick = ()=>{ if(!wqp.sites) return; wqp.types = new Set(wqp.allTypes); wqpSaveTypes(); wqpRender(); wqpRedraw(); };
$('wqp-types-none').onclick = ()=>{ if(!wqp.sites) return; wqp.types = new Set(); wqpSaveTypes(); wqpRender(); wqpRedraw(); };
$('wqp-groups').addEventListener('change', e=>{ const g = e.target.dataset.wg; if(g == null) return; e.target.checked ? wqp.exGroups.delete(g) : wqp.exGroups.add(g); wqpRender(); });
$('wqp-groups-all').onclick = ()=>{ wqp.exGroups.clear(); wqpRender(); };
$('wqp-groups-none').onclick = ()=>{ wqpGroupsOf(wqpSel()).forEach((n, g)=>wqp.exGroups.add(g)); wqpRender(); };

function openWqpPopup(q, group){
  const gs = Object.entries(q.g).sort((a,b)=>b[1] - a[1]);
  const w = byKey.get('WQP:' + q.id) || byKey.get(WQP_SRC + ':' + q.id) || USGS_IDX.get(q.id);
  const csvUrl = WQP_BASE + '/Result/search?' + new URLSearchParams({siteid:q.id, sampleMedia:'Water', mimeType:'csv', zip:'no'});
  const browse = 'https://www.waterqualitydata.us/#siteid=' + encodeURIComponent(q.id) + '&mimeType=csv';
  const others = (group || []).filter(o=>o !== q).slice(0, 6);
  const html = `<div class="pop"><h6>${esc(q.n || q.id)}</h6><div class="sub">${esc(q.mt || q.t)} · ${esc(q.id)}<br>${esc(q.orgN || q.org)} (${esc(q.prov)})${q.county ? ' · ' + esc(q.county) : ''}${q.huc ? ' · HUC ' + esc(q.huc) : ''}</div>
    <table><tr><td class="k">Water results</td><td class="v">${q.r.toLocaleString()}</td></tr><tr><td class="k">Sampling events</td><td class="v">${q.a.toLocaleString()}</td></tr></table>
    <div class="poph">Results by parameter group</div><table>${gs.map(([g, n])=>`<tr><td>${esc(g)}</td><td class="v">${(+n).toLocaleString()}</td></tr>`).join('') || '<tr><td>none listed</td></tr>'}</table>
    ${others.length ? '<div class="poph">Also here</div>' + others.map(o=>`<div class="pick"><span>${esc(o.n || o.id)} <small style="color:var(--muted)">${esc(o.t)} · ${o.r.toLocaleString()} results</small></span><button class="btn small" data-act="wqp" data-k="${esc(o.id)}">Open</button></div>`).join('') : ''}
    <div class="actions"><a class="btn small primary" style="text-decoration:none" href="${esc(csvUrl)}" target="_blank" rel="noopener">Results CSV ↗</a><a class="btn small" style="text-decoration:none" href="${esc(browse)}" target="_blank" rel="noopener">Browse on WQP ↗</a>${q.url ? `<a class="btn small" style="text-decoration:none" href="${esc(q.url)}" target="_blank" rel="noopener">Site page ↗</a>` : ''}${w && Object.keys(w.a).length ? `<button class="btn small" data-act="well" data-k="${esc(w.k)}">Chemistry history</button>` : ''}</div></div>`;
  popup = L.popup({maxWidth:360, minWidth:280, autoPanPadding:[30,30]}).setLatLng([q.lat, q.lng]).setContent(html).openOn(map);
}

/* ---- downloading every result: same three strategies as the WQP polygon downloader ---- */
const WQP_GET_MAX = 150;      // up to here: one GET link, WQP builds the file and the browser downloads it
const WQP_POST_MAX = 1000;    // up to here: POST batches of site IDs; beyond: query by area + date range
const WQP_POST_BATCH = 25, WQP_MIN_BATCH = 4, WQP_MIN_DAYS = 14;
let dlBusy = false, dlCancel = false, dlConfirmAt = 0;
// at most 2 requests to WQP at once, 150 ms apart; retries 429 and brief 502–504 hiccups
const wqpHost = {active:0, queue:[], last:0};
function wqpPump(){ while(wqpHost.active < 2 && wqpHost.queue.length){ wqpHost.active++; wqpHost.queue.shift()(); } }
function wqpLimited(url, opts, ms){
  return new Promise((resolve, reject)=>{
    wqpHost.queue.push(()=>{
      const wait = Math.max(0, 150 - (Date.now() - wqpHost.last));
      setTimeout(async ()=>{
        wqpHost.last = Date.now();
        const done = (fn, v)=>{ wqpHost.active--; wqpPump(); fn(v); };
        try{
          let r;
          for(let a=0; ; a++){
            r = await Promise.race([fetch(url, opts), sleep(ms || 100000).then(()=>{ const e = new Error('WQP took too long to answer'); e.retryable = true; throw e; })]);
            if(r.status === 429 && a < 4){ const ra = +r.headers.get('Retry-After'); await sleep(ra ? ra*1000 : Math.min(8000, 700*Math.pow(2, a))); continue; }
            if([502,503,504].includes(r.status) && a < 2){ await sleep(Math.min(4000, 1000*Math.pow(2, a))); continue; }
            break;
          }
          const text = await r.text();
          if(!r.ok){ const plain = text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160); const e = new Error('WQP returned HTTP ' + r.status + (plain ? ': ' + plain : '')); e.retryable = [502,503,504].includes(r.status); throw e; }
          done(resolve, text);
        }catch(e){ done(reject, e); }
      }, wait);
    });
    wqpPump();
  });
}
function wqpResultParams(){
  const p = new URLSearchParams({sampleMedia:'Water', mimeType:'csv', zip:'no', sorted:'no'});
  const from = $('wqp-from').value, to = $('wqp-to').value;
  if(from) p.set('startDateLo', WQPCore.mdy(from)); if(to) p.set('startDateHi', WQPCore.mdy(to));
  if(wqp.exGroups.size) [...wqpGroupsOf(wqpSel()).keys()].filter(g=>!wqp.exGroups.has(g)).forEach(g=>p.append('characteristicType', g));
  return p;
}
// WQP ignores filters in the query string of a POST: they go in the JSON body (dates as strings, lists as arrays)
function wqpPostBody(ids){
  const p = wqpResultParams(), b = {siteid:ids, sampleMedia:['Water']};
  if(p.get('startDateLo')) b.startDateLo = p.get('startDateLo');
  if(p.get('startDateHi')) b.startDateHi = p.get('startDateHi');
  const ct = p.getAll('characteristicType'); if(ct.length) b.characteristicType = ct;
  return JSON.stringify(b);
}
const dlProg = (msg, err) => { const el = $('wqp-dl-progress'); el.textContent = msg; el.style.color = err ? 'var(--warn)' : ''; };
function dlName(n){ return 'wqp_results_' + slug(state.area ? state.area.name : 'new_mexico') + '_' + n + 'sites_' + new Date().toISOString().slice(0, 10) + '.csv'; }
// opens a file to stream into (Chrome/Edge), or collects in memory
async function openSink(name, estRows){
  if('showSaveFilePicker' in window){
    try{
      const h = await window.showSaveFilePicker({suggestedName:name, types:[{description:'CSV', accept:{'text/csv':['.csv']}}]});
      const wr = await h.createWritable(); let q = Promise.resolve();
      return {write:t=>{ q = q.then(()=>wr.write(t)); return q; }, close:async()=>{ await q; await wr.close(); }, streamed:true};
    }catch(e){ if(e.name === 'AbortError') return null; }
  }
  if(estRows > 1500000){ dlProg('This is about ' + estRows.toLocaleString() + ' results, too many to hold in memory in this browser. Use Chrome or Edge (they write straight to disk), narrow the area or date range, or untick parameter groups.', true); return null; }
  const parts = [];
  return {write:t=>{ parts.push(t); return Promise.resolve(); }, close:async()=>{ downloadBlob(new Blob(parts, {type:'text/csv'}), name); }, streamed:false};
}
async function wqpDownload(){
  if(dlBusy) return;
  if(wqpBusy){ toast('Wait for the chemistry pull to finish first.'); return; }
  await wqpEnsure();
  const sel = wqpSel(); if(!sel.length){ toast('No WQP sites in this selection.'); return; }
  const from = $('wqp-from').value, to = $('wqp-to').value;
  if(from && to && from > to){ toast('The start date is after the end date.'); return; }
  if(wqp.exGroups.size && ![...wqpGroupsOf(sel).keys()].some(g=>!wqp.exGroups.has(g))){ toast('Tick at least one parameter group.'); return; }
  const est = wqpEstimate(sel), ids = sel.map(q=>q.id);
  if(est > 750000 && Date.now() - dlConfirmAt > 10000){ dlConfirmAt = Date.now(); $('wqp-dl').textContent = 'About ' + est.toLocaleString() + ' results (≈' + fmtMB(est) + '). Click again to start'; return; }
  dlConfirmAt = 0;
  // 1. small: let WQP build the file
  if(ids.length <= WQP_GET_MAX){
    const p = wqpResultParams(); ids.forEach(id=>p.append('siteid', id));
    const a = document.createElement('a'); a.href = WQP_BASE + '/Result/search?' + p; a.target = '_blank'; a.rel = 'noopener'; document.body.appendChild(a); a.click(); a.remove();
    dlProg('Asked WQP for ' + ids.length + ' site' + (ids.length === 1 ? '' : 's') + '. The CSV downloads from WQP in a new tab; large ones can take a minute to start.');
    return;
  }
  dlBusy = true; dlCancel = false;
  $('wqp-dl').disabled = true; $('wqp-stop').hidden = false;
  const idSet = new Set(ids), name = dlName(ids.length);
  let sink = null, header = null, rows = 0;
  const failed = [];
  const take = async text=>{
    const rs = WQPCore.parseCsv(text); if(rs.length < 2) return;
    if(!header){ header = rs[0]; await sink.write(rs[0].map(csvCell).join(',') + '\r\n'); }
    const idIx = header.indexOf('MonitoringLocationIdentifier'); let out = '';
    for(let i=1; i<rs.length; i++){ const r = rs[i]; if(r.length < 2) continue; if(idIx >= 0 && !idSet.has(r[idIx])) continue; out += r.map(csvCell).join(',') + '\r\n'; rows++; }
    if(out) await sink.write(out);
  };
  try{
    sink = await openSink(name, est); if(!sink) return;
    if(ids.length <= WQP_POST_MAX){
      // 2. medium: POST site-ID batches, halving any batch WQP can't finish in time
      const base = WQP_BASE + '/Result/search?mimeType=csv&zip=no&sorted=no';
      let sitesDone = 0;
      const batch = async b=>{
        if(dlCancel) return;
        try{ await take(await wqpLimited(base, {method:'POST', headers:{'Content-Type':'application/json'}, body:wqpPostBody(b)}, 120000)); sitesDone += b.length; }
        catch(e){
          if(e.retryable && b.length > WQP_MIN_BATCH && !dlCancel){ const m = Math.ceil(b.length/2); await Promise.all([batch(b.slice(0, m)), batch(b.slice(m))]); return; }
          failed.push({what:b.length + ' sites (' + b[0] + '…)', msg:e.message}); sitesDone += b.length;
        }
        dlProg('Fetching… ' + Math.min(sitesDone, ids.length).toLocaleString() + ' of ' + ids.length.toLocaleString() + ' sites · ' + rows.toLocaleString() + ' rows');
      };
      const batches = []; for(let i=0; i<ids.length; i += WQP_POST_BATCH) batches.push(ids.slice(i, i + WQP_POST_BATCH));
      dlProg('Fetching ' + ids.length.toLocaleString() + ' sites in ' + batches.length + ' batches…');
      await Promise.all(batches.map(batch));
    } else {
      // 3. large: query by area + site types + date range, halving any range WQP can't finish, keep only selected sites
      const bb = wqpAreaBox(), fams = [...new Set(sel.map(q=>q.f))], types = fams.includes('') ? [] : fams;
      const lo0 = from || '1900-01-01', hi0 = to || (new Date().getUTCFullYear() + '-12-31');
      const chunks = []; for(let y = +lo0.slice(0,4); y <= +hi0.slice(0,4); y += 10){ const a = y === +lo0.slice(0,4) ? lo0 : y + '-01-01', b0 = Math.min(y + 9, +hi0.slice(0,4)), b = b0 === +hi0.slice(0,4) ? hi0 : b0 + '-12-31'; chunks.push([a, b]); }
      let done = 0;
      const range = async (lo, hi)=>{
        if(dlCancel) return;
        const p = wqpResultParams(); p.set('statecode', 'US:35'); p.set('bBox', bb.map(x=>(+x).toFixed(4)).join(',')); types.forEach(t=>p.append('siteType', t));
        p.set('startDateLo', WQPCore.mdy(lo)); p.set('startDateHi', WQPCore.mdy(hi));
        try{ await take(await wqpLimited(WQP_BASE + '/Result/search?' + p, undefined, 120000)); }
        catch(e){
          const days = Math.round((Date.parse(hi) - Date.parse(lo))/864e5);
          if(e.retryable && days > WQP_MIN_DAYS && !dlCancel){ const mid = WQPCore.isoAdd(lo, Math.floor(days/2)); await Promise.all([range(lo, mid), range(WQPCore.isoAdd(mid, 1), hi)]); return; }
          failed.push({what:lo + ' to ' + hi, msg:e.message});
        }
        dlProg((sink.streamed ? 'Streaming to your file… ' : 'Downloading… ') + rows.toLocaleString() + ' rows saved · ' + done + ' of ' + chunks.length + ' decades finished');
      };
      dlProg('Querying WQP by area and date range for ' + ids.length.toLocaleString() + ' sites…');
      await Promise.all(chunks.map(async ([a, b])=>{ await range(a, b); done++; }));
    }
    await sink.close();
    const tail = failed.length ? ' ' + failed.length + ' piece' + (failed.length > 1 ? 's' : '') + ' kept failing and ' + (failed.length > 1 ? 'are' : 'is') + ' missing: ' + failed.slice(0, 4).map(f=>f.what).join('; ') + (failed.length > 4 ? '; …' : '') + '. Try again later for those.' : '';
    dlProg((dlCancel ? 'Stopped early. Saved ' : 'Done. Saved ') + rows.toLocaleString() + ' rows' + (sink.streamed ? ' to your file.' : ' as ' + name + '.') + tail, failed.length > 0);
  }catch(e){
    console.error(e); dlProg('Download failed: ' + e.message + (rows ? ' (' + rows.toLocaleString() + ' rows were written first)' : ''), true);
    try{ if(sink) await sink.close(); }catch(_){}
  }finally{ dlBusy = false; dlCancel = false; $('wqp-stop').hidden = true; wqpRender(); }
}
$('wqp-dl').onclick = wqpDownload;
$('wqp-stop').onclick = ()=>{ dlCancel = true; dlProg('Stopping after the requests in flight finish, then saving…'); };

/* ==================================================================== */
/* 14. Public water system sources (NMED Drinking Water Bureau) + CCRs  */
/* ==================================================================== */
const DW_URL = 'https://mercator.env.nm.gov/server/rest/services/dwb/drinking_water_sources/FeatureServer';
const DW_LAYERS = {sw:{id:0, label:'Active surface-water source', color:'--dw-sw'}, gw:{id:1, label:'Active groundwater source', color:'--dw-gw'}, off:{id:2, label:'Inactive source', color:'--dw-off'}};
const DW_FIELDS = 'OBJECTID,NUMBER0,SYSTEM_NAME,D_PRIN_CITY_SVD_NM,D_PRIN_CNTY_SVD_NM,D_FED_PRIM_SRC_CD,D_POPULATION_COUNT,D_PWS_FED_TYPE_CD,OWNER_TYPE_CODE,FACILITY_NAME,FACILITY_TYPE,WATER_TYPE_CODE,AVAILABILITY_CODE,ST_ASGN_IDENT_CD,DEPTH_OF_WELL,DEPTH_OF_WELL_UOM,STATIC_WATER_LEVEL,STATIC_WATER_LEVEL_UOM,DATA_COLLECTION_DT,OFFICE,LAT,LON';
const DW_CACHE = 'dw-sources-v1';
const PWS_TYPE = {C:'Community', NTNC:'Non-transient non-community', NC:'Transient non-community'};
const FAC_TYPE = {WL:'Well', SP:'Spring', IN:'Intake', IG:'Infiltration gallery', CC:'Consecutive connection', RS:'Reservoir', TP:'Treatment plant', ST:'Storage', OT:'Other', DS:'Distribution system', CW:'Clear well', PF:'Pump facility', SS:'Sampling station'};
const AVAIL = {P:'Permanent', S:'Seasonal', E:'Emergency', I:'Interim', O:'Other'};
const OWNER = {L:'Local government', P:'Private', S:'State', F:'Federal', N:'Native American', M:'Public/private'};
const CCR_YEARS = (()=>{ const y = []; for(let v = 2025; v >= 2008; v--) y.push(v); return y; })();
let DW = null, dwPromise = null;
const DW_BY_KEY = new Map();

/* ---- CCR values parsed from the DWW reports (embedded as JSON) ---- */
const CCR = (()=>{ try{ const j = builtIn('ccr-data'); return j && j.s ? j : null; }catch(e){ return null; } })();
const CCR_DATA_YEARS = CCR ? CCR.years.map(String) : [];
const U2MG = {'ppm':1, 'mg/l':1, 'ppb':1e-3, 'ug/l':1e-3, 'µg/l':1e-3, 'ppt':1e-6, 'ng/l':1e-6};
// MCL / MRDL in mg/L unless a unit is given
const CCR_LIMITS = [
  [/^arsenic$/i,.010,'MCL'], [/^uranium$/i,.030,'MCL'], [/^fluoride$/i,4,'MCL'], [/^nitrate.?nitrite/i,10,'MCL'], [/^nitrate/i,10,'MCL'], [/^nitrite/i,1,'MCL'],
  [/^barium$/i,2,'MCL'], [/^antimony/i,.006,'MCL'], [/^beryllium/i,.004,'MCL'], [/^cadmium/i,.005,'MCL'], [/^chromium/i,.1,'MCL'], [/^cyanide/i,.2,'MCL'], [/^mercury/i,.002,'MCL'], [/^selenium/i,.05,'MCL'], [/^thallium/i,.002,'MCL'],
  [/^asbestos/i,7,'MCL','MFL'],
  [/trihalomethanes|tthm/i,.080,'MCL'], [/haloacetic|haa5/i,.060,'MCL'], [/^bromate/i,.010,'MCL'], [/^chlorite/i,1,'MCL'], [/^chlorine dioxide/i,.8,'MRDL'], [/^chlor(ine|amine)/i,4,'MRDL'],
  [/combined radium/i,5,'MCL','pCi/L'], [/gross alpha/i,15,'MCL','pCi/L'],   // no limit for beta/photon emitters: DWW labels gross-beta screening results mrem/yr
  [/^benzene$/i,.005,'MCL'], [/^trichloroethylene/i,.005,'MCL'], [/^tetrachloroethylene/i,.005,'MCL'], [/^xylenes/i,10,'MCL'], [/^toluene/i,1,'MCL'], [/^ethylbenzene/i,.7,'MCL'], [/^1,2-dichloropropane/i,.005,'MCL'], [/^dichloromethane|^methylene chloride/i,.005,'MCL'], [/^vinyl chloride/i,.002,'MCL'], [/^carbon tetrachloride/i,.005,'MCL'], [/^1,1,1-trichloroethane/i,.2,'MCL'], [/^1,2-dichloroethane/i,.005,'MCL'], [/^styrene/i,.1,'MCL'], [/chlorobenzene/i,.1,'MCL'],
  [/^ethylene dibromide/i,.00005,'MCL'], [/ethylhexyl\) ?phthalate/i,.006,'MCL'], [/ethylhexyl\) ?adipate/i,.4,'MCL'], [/^dalapon/i,.2,'MCL'], [/^hexachlorocyclopentadiene/i,.05,'MCL'], [/^atrazine/i,.003,'MCL'], [/^simazine/i,.004,'MCL'], [/dibromochloropropane/i,.0002,'MCL'], [/^picloram/i,.5,'MCL'], [/^2,4-d$/i,.07,'MCL'], [/^glyphosate/i,.7,'MCL'], [/^pentachlorophenol/i,.001,'MCL'], [/^oxamyl/i,.2,'MCL'], [/benzo\(a\)pyrene/i,.0002,'MCL']
];
const LC_LIMITS = {Lead:{v:.015, k:'action level'}, Copper:{v:1.3, k:'action level'}};
// typical sources, in the wording EPA's CCR rule suggests
const CCR_SOURCES = [
  [/^arsenic/i,'Erosion of natural deposits; runoff from orchards; glass and electronics wastes'], [/^uranium/i,'Erosion of natural deposits'], [/^fluoride/i,'Erosion of natural deposits; water additive that promotes strong teeth'],
  [/^nitrate|^nitrite/i,'Fertilizer runoff; leaching from septic tanks and sewage; erosion of natural deposits'], [/^barium/i,'Drilling wastes; metal refineries; erosion of natural deposits'], [/^selenium/i,'Petroleum and metal refineries; mines; erosion of natural deposits'],
  [/^chromium/i,'Steel and pulp mills; erosion of natural deposits'], [/^cyanide/i,'Steel, metal, plastic and fertilizer factories'], [/^antimony/i,'Petroleum refineries; fire retardants; ceramics; electronics; solder'], [/^beryllium/i,'Metal refineries and coal-burning factories; electrical, aerospace and defense industries'],
  [/^cadmium/i,'Corrosion of galvanized pipes; erosion of natural deposits; metal refineries'], [/^mercury/i,'Erosion of natural deposits; refineries and factories; landfill and cropland runoff'], [/^thallium/i,'Ore-processing sites; electronics, glass and drug factories'], [/^asbestos/i,'Decay of asbestos-cement water mains; erosion of natural deposits'],
  [/^chlor(ine|amine)/i,'Disinfectant added to control microbes'], [/trihalomethanes|haloacetic|^bromate|^chlorite/i,'By-product of drinking water disinfection'],
  [/combined radium|gross alpha/i,'Erosion of natural deposits'], [/beta\/photon/i,'Decay of natural and man-made deposits'],
  [/^xylenes|^toluene|^ethylbenzene|^benzene/i,'Petroleum and chemical factories; leaking fuel tanks'], [/^trichloroethylene/i,'Metal degreasing sites and other factories'], [/^tetrachloroethylene/i,'Factories and dry cleaners'], [/dichloropropane|dichloroethane|dichloromethane|methylene chloride/i,'Industrial chemical factories'],
  [/ethylhexyl/i,'Rubber and chemical factories'], [/^ethylene dibromide/i,'Petroleum refineries'], [/hexachlorocyclopentadiene/i,'Chemical factories'], [/^atrazine|^simazine/i,'Runoff from herbicide used on row crops'], [/^dalapon/i,'Runoff from herbicide used on rights of way'],
  [/^lead/i,'Corrosion of household plumbing; erosion of natural deposits'], [/^copper/i,'Corrosion of household plumbing; erosion of natural deposits']
];
const ccrSource = name => { for(const [re, t] of CCR_SOURCES) if(re.test(name)) return t; return ''; };
const ccrName = n => String(n).replace(/\s*\[measured as nitrogen\]/i, ' (as N)');
// limit expressed in the row's own units, or null
function limitIn(L_, unit){
  if(!L_) return null;
  if(L_.u === 'mg/L'){ const f = U2MG[String(unit || '').toLowerCase()]; return f ? L_.v/f : null; }
  return String(unit).toLowerCase() === L_.u.toLowerCase() ? L_.v : null;
}
function ccrRowHtml(name, lvl, unit, L_, sub){
  const lim = limitIn(L_, unit), ratio = typeof lvl === 'number' && lim ? lvl/lim : null, over = ratio != null && ratio > 1 + 1e-9;
  const col = ratio == null ? '' : ratio > 1 ? 'var(--c-over)' : ratio >= .5 ? 'var(--c-mid)' : 'var(--c-low)';
  return `<div class="crow${over ? ' over' : ''}"><div class="l1"><span class="cn">${esc(ccrName(name))}${over ? '<span class="tag">above ' + esc(L_.k) + '</span>' : ''}</span><span class="lv">${ccrVal(lvl, unit)}</span><span class="lim">${lim != null ? 'limit ' + ccrNum(lim) + ' <span title="' + esc(L_.k) + '">' + esc(L_.k === 'action level' ? 'AL' : L_.k) + '</span>' : 'no limit'}</span></div>` +
    (ratio != null ? `<div class="meter" title="${Math.round(ratio*100)}% of the limit"><i style="width:${Math.min(100, Math.max(2, ratio*100)).toFixed(1)}%;background:${col}"></i></div>` : '') +
    `<div class="l2">${sub}</div></div>`;
}
const sampled = d => /^\d{4}$/.test(String(d)) ? 'sampled in ' + d : 'sampled ' + d;
const CCR_AN = {arsenic:[/^arsenic$/i], uranium:[/^uranium$/i], fluoride:[/^fluoride$/i], nitrate:[/^nitrate(?!.?\s?nitrite)/i, /^nitrate.?\s?nitrite/i], sulfate:[/^sulfate$/i], chloride:[/^chloride$/i], sodium:[/^sodium$/i], tds:[/^total dissolved solids/i]};
function ccrLimit(name){ for(const [re, v, k, u] of CCR_LIMITS) if(re.test(name)) return {v, k, u:u || 'mg/L'}; return null; }
function ccrMg(v, unit){ const f = U2MG[String(unit || '').toLowerCase()]; return f == null || typeof v !== 'number' ? null : v*f; }
function ccrOver(name, v, unit){
  const L_ = ccrLimit(name); if(!L_ || typeof v !== 'number') return null;
  if(L_.u === 'mg/L'){ const m = ccrMg(v, unit); return m == null ? null : m > L_.v + 1e-12; }
  return String(unit).toLowerCase() === L_.u.toLowerCase() ? v > L_.v : null;
}
function lcOver(row){ const L_ = LC_LIMITS[row[0]]; const m = ccrMg(row[2], row[3]); return L_ && m != null ? m > L_.v + 1e-12 : null; }
function limitText(L_){ return L_.u === 'mg/L' ? fmt(L_.v) + ' mg/L ' + L_.k : fmt(L_.v) + ' ' + L_.u + ' ' + L_.k; }
const ccrRec = (pws, yr) => CCR && CCR.s[pws] ? (CCR.s[pws][yr] || null) : null;
const ccrHas = yr => CCR_DATA_YEARS.includes(String(yr));
// the CCR row for one of the explorer's analytes, with its value in mg/L
function ccrAnalyte(rec, key){
  if(!rec || !rec.c || !CCR_AN[key]) return null;
  for(const re of CCR_AN[key]){ const r = rec.c.find(c=>re.test(c[1])); if(r){ const mg = ccrMg(r[3], r[6]); if(mg != null) return {row:r, mg}; } }
  return null;
}
function ccrOverCount(rec){
  if(!rec) return 0; let n = 0;
  for(const r of (rec.c || [])) if(ccrOver(r[1], r[3], r[6])) n++;
  for(const r of (rec.lc || [])) if(lcOver(r)) n++;
  return n;
}
const ccrNum = v => typeof v === 'number' ? v.toLocaleString(undefined, {maximumSignificantDigits:4}) : esc(v);
const ccrVal = (v, unit) => ccrNum(v) + ' ' + esc(unit || '');
const CHIP_KEYS = [['arsenic','As'],['uranium','U'],['nitrate','NO₃'],['fluoride','F']];
function ccrChips(pws, yr, ptype){
  if(!CCR || !ccrHas(yr)) return '';
  if(!CCR.s[pws] || !(String(yr) in CCR.s[pws])) return '<div class="ccr"><span class="cchip none">' + (ptype && ptype !== 'C' ? 'values built in for community systems only' : 'no CCR values on file') + '</span></div>';
  const rec = ccrRec(pws, yr) || {}, out = [];
  for(const [k, sym] of CHIP_KEYS){ const a = ccrAnalyte(rec, k); if(a) out.push(`<span class="cchip${ccrOver(a.row[1], a.row[3], a.row[6]) ? ' over' : ''}" title="${esc(a.row[1])}, highest level detected">${sym} ${ccrVal(a.row[3], a.row[6])}</span>`); }
  const pb = (rec.lc || []).find(r=>r[0] === 'Lead'); if(pb) out.push(`<span class="cchip${lcOver(pb) ? ' over' : ''}" title="Lead, 90th percentile">Pb90 ${ccrVal(pb[2], pb[3])}</span>`);
  const others = (rec.c || []).filter(r=>!CHIP_KEYS.some(([k])=>CCR_AN[k].some(re=>re.test(r[1]))) && ccrOver(r[1], r[3], r[6]));
  for(const r of others) out.push(`<span class="cchip over" title="${esc(r[1])}, highest level detected">${esc(r[1].replace(/\s*\[.*?\]/g, '').replace(/\s*\([^)]*\)$/, ''))} ${ccrVal(r[3], r[6])}</span>`);
  if(rec.v && rec.v.length) out.push(`<span class="cchip viol" title="${esc(rec.v.map(v=>v[0]).join('; '))}">${rec.v.length} violation${rec.v.length > 1 ? 's' : ''}</span>`);
  if(!out.length) out.push(`<span class="cchip none">${(rec.c || []).length ? 'other contaminants only' : 'no detected contaminants listed'}</span>`);
  return '<div class="ccr">' + out.join('') + '</div>';
}
function ccrPopupHtml(s, yr){
  if(!CCR || !ccrHas(yr)) return `<p class="note">Values are built in for ${esc(CCR_DATA_YEARS.join(' and ') || 'no years')}. Open the PDF for ${esc(yr)}.</p>`;
  if(!CCR.s[s.pws] || !(String(yr) in CCR.s[s.pws])) return '<p class="note">' + (s.ptype !== 'C' ? 'Values are built in for community systems only, which must publish a CCR. Open the PDF to see whether one exists.' : 'No CCR values on file for this system and year.') + '</p>';
  const rec = ccrRec(s.pws, yr) || {};
  let h = '';
  if((rec.c && rec.c.length) || (rec.lc && rec.lc.length)) h += '<div class="ckey"><b>Level</b> is the number the system reports for the year. For some contaminants it is a running average across samples or sampling points. <b>Range</b> is the lowest to highest single sample. <b>Limit</b> is the EPA maximum contaminant level (MCL), disinfectant level (MRDL) or lead/copper action level (AL), in the same units; the bar shows the level as a share of it. Reports round the level, so it can sit just above the range. ppm = mg/L, ppb = µg/L.</div>';
  if(rec.c && rec.c.length){
    let g = -1;
    h += rec.c.map(r=>{
      const head = r[0] !== g ? (g = r[0], `<div class="cgrp">${esc(CCR.groups[r[0]] || '')}</div>`) : '';
      const hasR = typeof r[4] === 'number' && typeof r[5] === 'number', avg = hasR && typeof r[3] === 'number' && r[5] > r[3]*1.0001;
      const sub = [hasR ? `samples <b>${ccrNum(r[4])}–${ccrNum(r[5])} ${esc(r[6])}</b>` : '', esc(sampled(r[2])), avg ? 'level is an average; single samples ran higher' : '', /beta\/photon/i.test(r[1]) ? 'no limit shown: these look like gross-beta screening results, which are compared to 50 pCi/L rather than the 4 mrem/yr MCL' : '', esc(ccrSource(r[1]))].filter(Boolean).join(' · ');
      return head + ccrRowHtml(r[1], r[3], r[6], ccrLimit(r[1]), sub);
    }).join('');
  } else h += '<p class="note">The report lists no detected regulated contaminants.</p>';
  if(rec.lc && rec.lc.length) h += '<div class="cgrp">Lead and copper at household taps</div>' + rec.lc.map(r=>{
    const L_ = LC_LIMITS[r[0]] ? {v:LC_LIMITS[r[0]].v, k:'action level', u:'mg/L'} : null;
    return ccrRowHtml(r[0], r[2], r[3], L_, ['90th percentile: 9 of 10 taps sampled were at or below this', esc(sampled(r[1])), esc(ccrSource(r[0]))].join(' · '));
  }).join('');
  if(rec.col) h += `<p class="note"><b>Coliform bacteria:</b> highest monthly result ${rec.col[0] != null ? fmt(rec.col[0]) : '–'} (positive samples, or percent of samples, depending on system size); ${rec.col[1] != null ? rec.col[1] : '–'} E. coli or fecal-positive sample${rec.col[1] === 1 ? '' : 's'}; ${rec.col[2] === 'Y' ? '<b style="color:var(--c-over)">violation</b>' : 'no violation'}. Coliforms are mostly harmless indicators that the system checks for contamination pathways.</p>`;
  if(rec.v && rec.v.length) h += `<p class="note"><b style="color:var(--warn)">${rec.v.length} violation${rec.v.length > 1 ? 's' : ''} listed in the report</b> (many are monitoring, reporting or notice violations rather than water above a limit): ` + rec.v.slice(0, 6).map(v=>esc(v[0].toLowerCase()) + ' (' + esc(v[1]) + (v[2] ? '–' + esc(v[2]) : '') + ')').join('; ') + (rec.v.length > 6 ? '; and ' + (rec.v.length - 6) + ' more' : '') + '.</p>';
  // side by side with wells
  const keys = Object.keys(CCR_AN).filter(k=>ccrAnalyte(rec, k));
  if(keys.length){
    const ws = wellsWithin(s, 5280);
    h += '<div class="poph">CCR value beside wells within 1 mile</div><table class="ccrt"><tr><td class="v" style="text-align:left;color:var(--muted)">mg/L</td><td class="v" style="color:var(--muted)">CCR</td><td class="v" style="color:var(--muted)">wells: median · max (n)</td></tr>' + keys.map(k=>{
      const a = ccrAnalyte(rec, k), vs = ws.map(w=>w.a[k] && w.a[k].last).filter(v=>v != null).sort((x,y)=>x-y);
      const sd = stdOf(k), over = sd != null && a.mg > sd;
      return `<tr><td class="n">${AN[k].sym}</td><td class="v" style="${over ? 'color:var(--c-over);font-weight:600' : ''}">${fmt(a.mg)}</td><td class="v">${vs.length ? fmt(quant(vs, .5)) + ' · ' + fmt(vs[vs.length-1]) + ' (' + vs.length + ')' : '–'}</td></tr>`;
    }).join('') + '</table><p class="note">Well values are each well\'s latest sample, any year. CCR values are the system\'s highest level detected for ' + esc(yr) + '.</p>';
  }
  return h;
}
function wellsWithin(s, maxFt){
  const kx = 364000*Math.cos(s.lat*Math.PI/180), ky = 364000, out = [];
  for(const w of WELLS){ const dx = (w.lng - s.lng)*kx; if(Math.abs(dx) > maxFt) continue; const dy = (w.lat - s.lat)*ky; if(Math.abs(dy) > maxFt) continue; if(Math.hypot(dx, dy) <= maxFt) out.push(w); }
  return out;
}
// color of a source when coloring by its system's CCR result for the selected analyte
function ccrClass(mg){
  if(mg == null) return null;
  const s = stdOf();
  if(s != null){ if(mg > 2*s) return [3, cssVar('--c-over2')]; if(mg > s) return [2, cssVar('--c-over')]; if(mg >= .5*s) return [1, cssVar('--c-mid')]; return [0, cssVar('--c-low')]; }
  const br = qBreaks(state.analyte, 'latest'); let i = 0; while(i < 4 && mg > br[i]) i++; return [i, seq()[i]];
}
const dwColorOn = () => $('dw-color-ccr').checked && !state.noAnalyte && ccrHas(ccrYear()) && !!CCR_AN[state.analyte];
// Drinking Water Watch system pages need DWW's internal system number (read from DWW's system list, Oct 2026)
const DWW_IDS = (()=>{ try{ return builtIn('dww-ids') || {}; }catch(e){ return {}; } })();
const dwwUrl = pws => DWW_IDS[pws] ? 'https://dww.water.env.nm.gov/JSP/WaterSystemDetail.jsp?tinwsys_is_number=' + DWW_IDS[pws] + '&tinwsys_st_code=NM&wsnumber=' + encodeURIComponent(pws + '   ') + '&DWWState=NM' : 'https://dww.water.env.nm.gov/JSP/SearchDispatch?number=' + encodeURIComponent(pws) + '&name=&county=All&WaterSystemType=All&SourceWaterType=All&PointOfContactType=None&SampleType=null&stateclassificationcode=All&action=Search+For+Water+Systems';
const ccrUrl = (pws, yr) => 'https://dww.water.env.nm.gov/JSP/CCRReportDispatch?number=' + encodeURIComponent(pws) + '&ryear=' + encodeURIComponent(yr) + '&rptType=PDF&report=Generate+Report';
const ccrYear = () => $('ccr-year').value || String(CCR_YEARS[0]);

async function dwFetchLayer(id){
  const out = [];
  for(let off=0; off<20000; off+=2000){
    const p = new URLSearchParams({where:'1=1', outFields:DW_FIELDS, outSR:'4326', returnGeometry:'true', orderByFields:'OBJECTID', resultOffset:String(off), resultRecordCount:'2000', f:'json'});
    const r = await apiFetch(DW_URL + '/' + id + '/query?' + p, 3);
    const j = await r.json(); if(j.error) throw new Error(j.error.message || 'NMED service error');
    const fs = j.features || []; out.push(...fs);
    if(fs.length < 2000 && !j.exceededTransferLimit) break;
  }
  return out;
}
function dwRecord(layer, f){
  const a = f.attributes || {}, g = f.geometry || {};
  const lat = g.y != null ? +g.y : +a.LAT, lng = g.x != null ? +g.x : +a.LON;
  if(!isFinite(lat) || !isFinite(lng) || (!lat && !lng)) return null;
  const ft = (v, u) => v == null || !isFinite(+v) ? null : (/^m/i.test(u || '') ? +v*3.28084 : +v);
  return {k:'dw:' + layer + ':' + a.OBJECTID, layer, lat, lng, pws:a.NUMBER0 || '', sys:a.SYSTEM_NAME || 'Unnamed system', city:a.D_PRIN_CITY_SVD_NM || '', county:a.D_PRIN_CNTY_SVD_NM || '', prim:a.D_FED_PRIM_SRC_CD || '', pop:a.D_POPULATION_COUNT != null ? +a.D_POPULATION_COUNT : null, ptype:a.D_PWS_FED_TYPE_CD || '', owner:a.OWNER_TYPE_CODE || '', fac:a.FACILITY_NAME || 'Source', ftype:a.FACILITY_TYPE || '', wtype:a.WATER_TYPE_CODE || '', avail:a.AVAILABILITY_CODE || '', stid:a.ST_ASGN_IDENT_CD || '', depth:ft(a.DEPTH_OF_WELL, a.DEPTH_OF_WELL_UOM), swl:ft(a.STATIC_WATER_LEVEL, a.STATIC_WATER_LEVEL_UOM), date:a.DATA_COLLECTION_DT ? new Date(a.DATA_COLLECTION_DT).toISOString().slice(0,10) : '', office:a.OFFICE || ''};
}
function dwEnsure(){
  if(DW) return Promise.resolve(DW);
  if(dwPromise) return dwPromise;
  $('dw-status').textContent = 'Loading sources from NMED…';
  dwPromise = (async()=>{
    let d = await idbGet(DW_CACHE);
    if(!d || !d.t || Date.now() - d.t > CACHE_TTL){
      const res = {t:Date.now()};
      for(const key of Object.keys(DW_LAYERS)) res[key] = (await dwFetchLayer(DW_LAYERS[key].id)).map(f=>dwRecord(key, f)).filter(Boolean);
      d = res; await idbSet(DW_CACHE, d);
    }
    DW = d;
    for(const key of Object.keys(DW_LAYERS)) for(const s of DW[key]) DW_BY_KEY.set(s.k, s);
    $('dw-status').textContent = 'NMED Drinking Water Bureau · as of ' + new Date(DW.t).toLocaleDateString();
    for(const key of Object.keys(DW_LAYERS)) $('dw-n-' + key).textContent = DW[key].length.toLocaleString();
    dwRedraw(); renderSystems();
    return DW;
  })().catch(e=>{ dwPromise = null; $('dw-status').textContent = 'Could not reach the NMED service: ' + e.message; throw e; });
  return dwPromise;
}
function dwRedraw(){
  if(!DW){ dwPoints.setData([]); renderDwLegend(); return; }
  const items = [];
  const byCcr = dwColorOn(), yr = ccrYear(), none = cssVar('--c-none');
  for(const key of ['off','sw','gw']) if(state.dw[key]){
    const c = cssVar(DW_LAYERS[key].color);
    for(const s of DW[key]){
      if(byCcr && key !== 'off'){ const a = ccrAnalyte(ccrRec(s.pws, yr), state.analyte), k = ccrClass(a ? a.mg : null); items.push({w:s, c:k ? k[1] : none, z:k ? k[0] : -1, sq:true}); }
      else items.push({w:s, c, z:0, sq:true});
    }
  }
  items.sort((a,b)=>a.z - b.z);
  dwPoints.setData(items); renderDwLegend();
}
function renderDwLegend(){
  const on = Object.keys(DW_LAYERS).filter(k=>state.dw[k]);
  if(!on.length || !DW){ $('legend-dw').innerHTML = ''; return; }
  let html = '<div class="lg-sep"></div><h5>Public water sources</h5>';
  if(dwColorOn()){
    const yr = ccrYear(), cnt = new Map(); let none = 0;
    for(const k of on) if(k !== 'off') for(const s of DW[k]){ if(!inArea(s)) continue; const a = ccrAnalyte(ccrRec(s.pws, yr), state.analyte), c = ccrClass(a ? a.mg : null); if(c) cnt.set(c[0], (cnt.get(c[0])||0) + 1); else none++; }
    const sd = stdOf(), labs = sd != null ? ['< 50% of standard','50–100% of standard','Above standard','> 2× standard'] : valueLegend().map(r=>r[2]);
    const cols = sd != null ? ['--c-low','--c-mid','--c-over','--c-over2'].map(cssVar) : seq();
    html += labs.map((l,i)=>lgRow(cols[i], l, cnt.get(i)||0, true)).join('') + lgRow(cssVar('--c-none'), esc(AN[state.analyte].name) + ' not listed (not detected, or no report)', none, true);
    if(state.dw.off) html += lgRow(cssVar('--dw-off'), 'Inactive sources', DW.off.filter(inArea).length, true);
    html += '<div class="lg-note">Each active source takes its system\'s CCR ' + esc(yr) + ' highest level for ' + esc(AN[state.analyte].name.toLowerCase()) + '.' + (state.area ? ' Counts are inside ' + esc(state.area.name) + '.' : '') + '</div>';
  } else {
    html += on.map(k=>lgRow(cssVar(DW_LAYERS[k].color), DW_LAYERS[k].label + 's', DW[k].filter(inArea).length, true)).join('') + (state.area ? '<div class="lg-note">Counts are inside ' + esc(state.area.name) + '.</div>' : '');
  }
  $('legend-dw').innerHTML = html;
}
['gw','sw','off'].forEach(k=>$('dw-' + k).addEventListener('change', async e=>{
  state.dw[k] = e.target.checked;
  try{ await dwEnsure(); }catch(err){ toast('Could not load drinking water sources: ' + err.message, 4000); e.target.checked = false; state.dw[k] = false; }
  dwRedraw();
}));
$('ccr-year').innerHTML = CCR_YEARS.map(y=>`<option value="${y}">${y}${ccrHas(y) ? ' · values built in' : ' · PDF link only'}</option>`).join('');
$('ccr-hint').textContent = CCR ? 'Values from ' + CCR_DATA_YEARS.join(' and ') + ' reports for community systems are built in (read ' + CCR.gen + '). Other years and systems link to the PDF only.' : 'CCR links open the Drinking Water Watch report (PDF) for that system and year.';
$('ccr-year').addEventListener('change', ()=>{ renderSystems(); dwRedraw(); if(popup && popup.isOpen() && popup._dw) openDwPopup(popup._dw, [popup._dw]); });
$('dw-color-ccr').addEventListener('change', async e=>{
  if(e.target.checked){
    if(state.noAnalyte) toast('Pick an analyte in the Weaver API tab first.', 3600);
    else if(!CCR_AN[state.analyte]) toast('CCRs don\'t report ' + AN[state.analyte].name.toLowerCase() + '. Pick arsenic, uranium, nitrate or fluoride.', 4000);
    else if(!ccrHas(ccrYear())) toast('Pick a year with values built in.', 3600);
    if(!state.dw.gw && !state.dw.sw){ state.dw.gw = true; $('dw-gw').checked = true; state.dw.sw = true; $('dw-sw').checked = true; }
    try{ await dwEnsure(); }catch(err){}
  }
  dwRedraw();
});
$('ccr-over-only').addEventListener('change', renderSystems);
segBind('dw-type-seg', 'pt', v=>{ state.dwType = v; renderSystems(); });
let dwSearchT = 0;
$('dw-search').addEventListener('input', ()=>{ clearTimeout(dwSearchT); dwSearchT = setTimeout(()=>{ dwEnsure().then(renderSystems).catch(()=>{}); renderSystems(); }, 200); });

// sources grouped into systems, inside the current area
function systemsInArea(all){
  if(!DW) return [];
  const m = new Map();
  for(const key of ['gw','sw']) for(const s of DW[key]){
    if(!all && !inArea(s)) continue;
    let y = m.get(s.pws);
    if(!y){ y = {pws:s.pws, sys:s.sys, ptype:s.ptype, pop:s.pop, city:s.city, county:s.county, prim:s.prim, gw:0, sw:0, srcs:[]}; m.set(s.pws, y); }
    y[key]++; y.srcs.push(s); if(s.pop != null && (y.pop == null || s.pop > y.pop)) y.pop = s.pop;
  }
  return [...m.values()].sort((a,b)=>(b.pop||0) - (a.pop||0) || a.sys.localeCompare(b.sys));
}
const SYS_ROWS = 150;
function renderSystems(){
  if(!DW){ $('dw-sum-n').textContent = '–'; $('dw-sum-lbl').textContent = 'Open this tab or turn on a layer to load the sources.'; $('dw-list').innerHTML = ''; return; }
  const q = $('dw-search').value.trim().toLowerCase(), qs = q.split(/\s+/).filter(Boolean);
  $('dw-search-hint').hidden = !q;
  const all = systemsInArea(), yr0 = ccrYear(), overOnly = $('ccr-over-only').checked && ccrHas(yr0);
  const hay = y => (y.sys + ' ' + y.pws + ' ' + (y.city || '') + ' ' + (y.county || '')).toLowerCase();
  const list = (q ? systemsInArea(true).filter(y=>qs.every(t=>hay(y).includes(t))) : all).filter(y=>(state.dwType === 'all' || y.ptype === state.dwType) && (!overOnly || ccrOverCount(ccrRec(y.pws, yr0)) > 0));
  const pop = all.reduce((t,y)=>t + (y.ptype === 'C' ? (y.pop||0) : 0), 0), srcs = all.reduce((t,y)=>t + y.gw + y.sw, 0);
  $('dw-sum-n').textContent = all.length.toLocaleString() + ' active systems';
  const nOver = ccrHas(yr0) ? all.filter(y=>ccrOverCount(ccrRec(y.pws, yr0)) > 0).length : null;
  $('dw-sum-lbl').textContent = (state.area ? state.area.name : 'Statewide') + ' · ' + srcs.toLocaleString() + ' active sources · community systems serve ' + pop.toLocaleString() + ' people' + (nOver != null ? ' · ' + nOver.toLocaleString() + ' with a CCR ' + yr0 + ' value above a limit' : '');
  const yr = ccrYear();
  $('dw-list').innerHTML = list.length ? list.slice(0, SYS_ROWS).map(y=>`<div class="sys"><button class="nm" data-sys="${esc(y.pws)}" title="Zoom to this system's sources">${esc(y.sys)}</button><span style="white-space:nowrap"><a href="${esc(dwwUrl(y.pws))}" target="_blank" rel="noopener" title="System page on Drinking Water Watch">DWW ↗</a> · <a href="${ccrUrl(y.pws, yr)}" target="_blank" rel="noopener" title="Consumer Confidence Report, ${yr} (PDF)">CCR ${yr} ↗</a></span><small>${esc(y.pws)} · ${esc(PWS_TYPE[y.ptype] || y.ptype || 'type ?')}${y.pop != null ? ' · ' + y.pop.toLocaleString() + ' people' : ''} · ${[y.gw ? y.gw + ' GW' : '', y.sw ? y.sw + ' SW' : ''].filter(Boolean).join(' + ')} source${y.gw + y.sw === 1 ? '' : 's'}${y.city ? ' · ' + esc(y.city) : ''}</small>${ccrChips(y.pws, yr, y.ptype)}</div>`).join('') + (list.length > SYS_ROWS ? `<p class="hint">Showing the ${SYS_ROWS} largest of ${list.length.toLocaleString()}. Export CSV lists them all.</p>` : '') : '<p class="hint">' + (overOnly ? 'No systems here report a value above a limit for ' + yr + '.' : 'No active systems of this type here.') + '</p>';
}
$('dw-list').addEventListener('click', e=>{
  const b = e.target.closest('[data-sys]'); if(!b) return;
  const y = systemsInArea(true).find(s=>s.pws === b.dataset.sys); if(!y) return;
  if(!state.dw.gw && y.gw){ state.dw.gw = true; $('dw-gw').checked = true; }
  if(!state.dw.sw && y.sw){ state.dw.sw = true; $('dw-sw').checked = true; }
  dwRedraw();
  if(y.srcs.length === 1){ map.setView([y.srcs[0].lat, y.srcs[0].lng], Math.max(map.getZoom(), 13)); openDwPopup(y.srcs[0], y.srcs); }
  else map.fitBounds(L.latLngBounds(y.srcs.map(s=>[s.lat, s.lng])), {padding:[60,60], maxZoom:14});
});
$('dw-export').onclick = async ()=>{
  try{ await dwEnsure(); }catch(e){ toast('Could not load the sources.'); return; }
  const rows = []; const yr = ccrYear();
  for(const key of Object.keys(DW_LAYERS)) for(const s of DW[key]) if(inArea(s)) rows.push([s.pws, s.sys, PWS_TYPE[s.ptype] || s.ptype, s.pop, s.city, s.county, DW_LAYERS[key].label, s.fac, FAC_TYPE[s.ftype] || s.ftype, s.wtype, AVAIL[s.avail] || s.avail, s.stid, s.depth != null ? Math.round(s.depth) : '', s.swl != null ? Math.round(s.swl) : '', s.date, s.lat, s.lng, ccrUrl(s.pws, yr)]);
  if(!rows.length){ toast('No sources in this area.'); return; }
  downloadCsv(['pws_id','system_name','system_type','population','city','county','status','facility_name','facility_type','water_type','availability','state_source_id','well_depth_ft','static_water_level_ft','data_collection_date','latitude','longitude','ccr_' + yr + '_url'], rows, 'nm_drinking_water_sources_' + slug(state.area ? state.area.name : 'statewide') + '.csv');
};
$('ccr-export').onclick = async ()=>{
  const yr = ccrYear();
  if(!ccrHas(yr)){ toast('Values are built in for ' + CCR_DATA_YEARS.join(' and ') + ' only.', 3600); return; }
  try{ await dwEnsure(); }catch(e){ toast('Could not load the systems list.'); return; }
  const rows = [];
  for(const y of systemsInArea()){
    if(state.dwType !== 'all' && y.ptype !== state.dwType) continue;
    const rec = ccrRec(y.pws, yr); if(!rec) continue;
    const base = [y.pws, y.sys, PWS_TYPE[y.ptype] || y.ptype, y.pop, y.city, y.county, yr];
    for(const r of (rec.c || [])){ const L_ = ccrLimit(r[1]), o = ccrOver(r[1], r[3], r[6]); rows.push(base.concat([CCR.groups[r[0]] || '', r[1], r[2], r[3], r[4], r[5], r[6], L_ ? L_.v : '', L_ ? L_.u : '', L_ ? L_.k : '', o == null ? '' : o ? 'yes' : 'no'])); }
    for(const r of (rec.lc || [])){ const L_ = LC_LIMITS[r[0]], o = lcOver(r); rows.push(base.concat(['Lead and copper (90th percentile)', r[0], r[1], r[2], '', '', r[3], L_ ? L_.v : '', 'mg/L', L_ ? L_.k : '', o == null ? '' : o ? 'yes' : 'no'])); }
    for(const v of (rec.v || [])) rows.push(base.concat(['Violation', v[0], v[1], '', '', '', '', '', '', '', v[2] ? 'ended ' + v[2] : '']));
  }
  if(!rows.length){ toast('No CCR values for systems in this area.'); return; }
  downloadCsv(['pws_id','system_name','system_type','population','city','county','ccr_year','group','contaminant','collection_date','highest_level','range_low','range_high','units','limit','limit_units','limit_type','above_limit'], rows, 'nm_ccr_' + yr + '_' + slug(state.area ? state.area.name : 'statewide') + '.csv');
};
// chemistry wells near a source (any data source, ignoring the map filters)
function nearWells(s, maxFt){
  const kx = 364000*Math.cos(s.lat*Math.PI/180), ky = 364000, out = [];   // feet per degree
  for(const w of WELLS){ const dx = (w.lng - s.lng)*kx; if(Math.abs(dx) > maxFt) continue; const dy = (w.lat - s.lat)*ky; if(Math.abs(dy) > maxFt) continue; const d = Math.hypot(dx, dy); if(d <= maxFt) out.push([d, w]); }
  return out.sort((a,b)=>a[0]-b[0]).slice(0, 5);
}
function openDwPopup(s, group){
  const yr = ccrYear(), near = nearWells(s, 1000), an = AN[state.analyte];
  const row = (k, v) => v == null || v === '' ? '' : `<tr><td class="k">${k}</td><td class="v">${v}</td></tr>`;
  const others = (group || []).filter(o=>o !== s).slice(0, 6);
  const html = `<div class="pop"><h6>${esc(s.fac)}</h6><div class="sub">${esc(DW_LAYERS[s.layer].label)} · ${esc(FAC_TYPE[s.ftype] || s.ftype || 'source')}${s.avail ? ' · ' + esc(AVAIL[s.avail] || s.avail) : ''}</div>
    <table>${row('System', esc(s.sys))}${row('PWS ID', esc(s.pws))}${row('Type', esc(PWS_TYPE[s.ptype] || s.ptype))}${row('Population', s.pop != null ? s.pop.toLocaleString() : '')}${row('Owner', esc(OWNER[s.owner] || s.owner))}${row('Serves', esc([s.city, s.county ? s.county + ' Co.' : ''].filter(Boolean).join(', ')))}${row('Well depth', s.depth != null ? fmt(s.depth) + ' ft' : '')}${row('Static water level', s.swl != null ? fmt(s.swl) + ' ft' : '')}${row('Source ID', esc(s.stid))}${row('Recorded', esc(s.date))}</table>
    ${others.length ? `<div class="poph">Also here</div>` + others.map(o=>`<div class="pick"><span>${esc(o.fac)} <small style="color:var(--muted)">${esc(o.sys)}</small></span><button class="btn small" data-act="dw" data-k="${esc(o.k)}">Open</button></div>`).join('') : ''}
    <div class="poph">CCR ${esc(yr)}: detected contaminants</div>${ccrPopupHtml(s, yr)}
    <div class="poph">Chemistry wells within 1,000 ft</div>
    ${near.length ? near.map(([d, w])=>{ const v = val(w); return `<div class="pick"><span>${esc(w.name)} <small style="color:var(--muted)">${esc(w.source)} · ${Math.round(d).toLocaleString()} ft · ${an.sym} ${fmt(v)}${isWqp(w, state.analyte) ? wqpTag : ''}</small></span><button class="btn small" data-act="well" data-k="${esc(w.k)}">History</button></div>`; }).join('') : '<p class="hint" style="margin:0">None in the API, or in WQP pulls you have added.</p>'}
    <div class="actions"><a class="btn small primary" style="text-decoration:none;flex:1" href="${esc(dwwUrl(s.pws))}" target="_blank" rel="noopener">Drinking Water Watch page ↗</a><a class="btn small" style="text-decoration:none;flex:1" href="${ccrUrl(s.pws, yr)}" target="_blank" rel="noopener">CCR ${yr} (PDF) ↗</a></div></div>`;
  popup = L.popup({maxWidth:400, minWidth:320, autoPanPadding:[30,30]}).setLatLng([s.lat, s.lng]).setContent(html).openOn(map);
  popup._dw = s;
}

/* ==================================================================== */
/* 14b. Public API layers: point and polygon layers from agency ArcGIS services */
/* ==================================================================== */
// To add a layer: one entry with its ArcGIS REST layer URL. title = field shown in hover and popup heading;
// color = marker color; for polygons, by = field to color by and colors = value -> color.
const NMED = 'https://mercator.env.nm.gov/server/rest/services/';
const OSE = 'https://gis.ose.nm.gov/server_s/rest/services/';
const EMNRD = 'https://gis.emnrd.nm.gov/arcgis/rest/services/';   // no CORS headers: read with JSONP (callback=) and Esri JSON
const PUB_JSONP = /^https:\/\/gis\.emnrd\.nm\.gov\//i;
// areaOnly: large layers load only inside the selected area's bounding box; other = color for values not in colors
const PUB_LAYERS = [
  {id:'ose-pods', agency:'NM Office of the State Engineer', group:'Water rights (NMWRRS)', name:'All points of diversion (WATERS database)', url:OSE + 'PODS/GIS_WATERS_PODs/MapServer/1', title:'pod_file', by:'pod_status', colors:{'ACT':'#27ae60', 'PEN':'#f1c40f', 'INC':'#e67e22', 'PLG':'#2d3436', 'CAP':'#8e44ad', 'UNK':'#b2bec3'}, labels:{'ACT':'Active', 'PEN':'Pending', 'INC':'Incomplete', 'PLG':'Plugged', 'CAP':'Capped', 'UNK':'Unknown'}, other:'#74b9ff', areaOnly:true, key:'pod_rec_nbr', related:[{label:'Water right records', url:OSE + 'PODS/GIS_WATERS_PODs/MapServer/0', fk:'pod_rec_nbr', kind:'wr'}, {label:'Scanned well logs', url:OSE + 'PODS/W2W_Well_PODs/MapServer/4', fk:'pod_rec_nbr', kind:'log'}],
    hide:/^(pod_basin|pod_nbr|pod_suffix|ref|tws|rng|sec|qtr_\w+|blk|zone_?|x|y|lat_(deg|min|sec)|lon_(deg|min|sec)|utm_\w+|easting|northing|datum|xy_\w+|lat_lon_\w+|cfs_\w+|cs_code|wrats_s_id|pod_rec_nbr|sum_rec_nbr|sf_header|sub_file|basin|nbr|suffix|in_state|dump_date|loc_error|replaced|restrict_?|subdiv_location|surface_code|tract_nbr|map_nbr|surv_map|addr1|addr2|zip|contact_\w+|sys_date|pump_serial|sched_date|pcw_rcv_date|other_loc|well_tag|pod_name|percent_shallow)$/i,
    alias:{pod_file:'POD', db_file:'Water right file', legal:'Legal description', landgrant:'Land grant', county:'County', license_nbr:'Driller license', start_date:'Drilling started', finish_date:'Drilling finished', plug_date:'Plugged', elevation:'Elevation (ft)', depth_well:'Well depth (ft)', grnd_wtr_src:'Groundwater source (S shallow, A artesian)', depth_water:'Depth to water at completion (ft)', log_file_date:'Well log filed', use_of_well:'Use of well', pump_type:'Pump type', discharge:'Discharge (gpm)', aquifer:'Aquifer', subdiv_name:'Subdivision', estimate_yield:'Estimated yield (gpm)', pod_status:'POD status', casing_size:'Casing size (in)', ditch_name:'Ditch', pod_sub_basin:'POD sub-basin', static_level:'Static water level (ft)', sub_basin:'Sub-basin', status:'Water right status', use:'Water right use', total_div:'Water right diversion (ac-ft/yr)', own_lname:'Owner last name', own_fname:'Owner first name', city:'Owner city', state:'Owner state', nmwrrs_wrsum_url:'NMWRRS water right summary', wr_count:'Water rights', metered:'Metered'},
    color:'#27ae60', blurb:'About 281,000 wells and surface diversions from OSE\'s WATERS database, with every linked water right record and all scanned well logs. Loads for the selected area'},
  {id:'ose-wells', agency:'NM Office of the State Engineer', group:'Water rights (NMWRRS)', name:'Groundwater wells (points of diversion)', url:OSE + 'PODS/W2W_Well_PODs/MapServer/0', title:'POD', by:'Use', colors:{'DOM':'#2e86de', 'DOL':'#54a0ff', 'STK':'#a3cb38', 'IRR':'#10ac84', 'MUN':'#8e44ad', 'MON':'#7f8c8d', 'IND':'#e17055', 'COM':'#fdcb6e'}, labels:{'DOM':'Domestic', 'DOL':'Domestic & livestock', 'STK':'Livestock', 'IRR':'Irrigation', 'MUN':'Municipal', 'MON':'Monitoring', 'IND':'Industrial', 'COM':'Commercial'}, other:'#b2bec3', areaOnly:true, key:'RecNo', related:[{label:'Water right records', url:OSE + 'PODS/GIS_WATERS_PODs/MapServer/0', fk:'pod_rec_nbr', kind:'wr'}, {label:'Scanned well logs', url:OSE + 'PODS/W2W_Well_PODs/MapServer/4', fk:'pod_rec_nbr', kind:'log'}], hide:/^(x_m|y_m|total_pod_div_cfd|updatedfields|updateremarks|recno|plss_located|source|perf|swl|scanned_welllog_link)$/i, alias:{pod:'POD number', use:'Use', total_pod_div_afy:'Diversion at this POD (ac-ft/yr)', welldepth_ft:'Well depth (ft)', perf_top_fbgs:'Top of perforations (ft bgs)', perf_bot_fbgs:'Bottom of perforations (ft bgs)', dtw_initial_ft:'Depth to water at completion (ft)', subbasin:'OSE basin', county:'County', podstatus:'POD status', finishdate:'Completion date', finishyear:'Completion year', logfiledate:'Well log filed', estimatedyield_gpm:'Estimated yield (gpm)', metered:'Metered', wr_count:'Water rights', waterrightfiles:'Water right file(s)', waterrightstatus:'Water right status', owners:'Owner(s)', wrdiversions_afy:'Water right diversion (ac-ft/yr)', pod_count_for_each_wr:'PODs per water right', nmwrrs_podsum_url:'NMWRRS POD summary', scanned_welllog_count:'Scanned well logs', scanned_welllog_link:'Scanned well log'}, color:'#2e86de', blurb:'About 263,000 wells: use, well depth, depth to water, perforations, owner, well-log and NMWRRS links. Loads for the selected area'},
  {id:'ose-swpod', agency:'NM Office of the State Engineer', group:'Water rights (NMWRRS)', name:'Surface water points of diversion', url:OSE + 'Hosted/W2W_Surface_PODs/FeatureServer/1', title:'pod', by:'use', colors:{'IRR':'#10ac84', 'STK':'#a3cb38', 'MUN':'#8e44ad', 'DOM':'#2e86de', 'COM':'#fdcb6e'}, labels:{'IRR':'Irrigation', 'STK':'Livestock', 'MUN':'Municipal', 'DOM':'Domestic', 'COM':'Commercial'}, other:'#b2bec3', hide:/^(x_m|y_m|total_pod_div_cfd|updatedfields|updateremarks|recno|plss_located|source|perf|swl|scanned_welllog_link)$/i, alias:{pod:'POD number', use:'Use', total_pod_div_afy:'Diversion at this POD (ac-ft/yr)', welldepth_ft:'Well depth (ft)', perf_top_fbgs:'Top of perforations (ft bgs)', perf_bot_fbgs:'Bottom of perforations (ft bgs)', dtw_initial_ft:'Depth to water at completion (ft)', subbasin:'OSE basin', county:'County', podstatus:'POD status', finishdate:'Completion date', finishyear:'Completion year', logfiledate:'Well log filed', estimatedyield_gpm:'Estimated yield (gpm)', metered:'Metered', wr_count:'Water rights', waterrightfiles:'Water right file(s)', waterrightstatus:'Water right status', owners:'Owner(s)', wrdiversions_afy:'Water right diversion (ac-ft/yr)', pod_count_for_each_wr:'PODs per water right', nmwrrs_podsum_url:'NMWRRS POD summary', scanned_welllog_count:'Scanned well logs', scanned_welllog_link:'Scanned well log'}, color:'#00a8a8', blurb:'Diversion use, permitted amount, water right status'},
  {id:'ose-hydro', agency:'NM Office of the State Engineer', group:'Water rights (NMWRRS)', name:'Hydrographic survey boundaries', url:OSE + 'HydroSurvey/Hydrographic_Survey_Index/MapServer/0', title:'surveys', geom:'polygon', color:'#0984e3', blurb:'Adjudication survey areas, year completed, survey sheets'},
  {id:'ose-dist', agency:'NM Office of the State Engineer', group:'Administrative', name:'OSE district boundaries', url:OSE + 'Administrative/OSE_District_Boundary/MapServer/0', title:'name', geom:'polygon', color:'#636e72', blurb:'Water Rights Division districts (7)'},
  {id:'nmed-gwdp', agency:'NM Environment Department', group:'Ground Water Quality Bureau', name:'Ground Water Discharge Permits', url:NMED + 'gwqb/ground_water_discharge_permits/FeatureServer/0', title:'FACILITY_NAME', color:'#b5476b', blurb:'Waste type, permitted discharge, depth to water'},
  {id:'nmed-dairy', agency:'NM Environment Department', group:'Ground Water Quality Bureau', name:'Dairies', url:NMED + 'gwqb/dairies/FeatureServer/0', title:'FACILITY_NAME', color:'#8a6d3b', blurb:'Permitted discharge, depth to water'},
  {id:'nmed-scp', agency:'NM Environment Department', group:'Ground Water Quality Bureau', name:'State Cleanup Program sites', url:NMED + 'gwqb/scp/FeatureServer/0', title:'NAME', color:'#c0392b', blurb:'Contaminants of concern, media impacted, depth to water'},
  {id:'nmed-vrp', agency:'NM Environment Department', group:'Ground Water Quality Bureau', name:'Voluntary Remediation Program', url:NMED + 'gwqb/voluntary_remediation_program/FeatureServer/0', title:'SITE_NAME', color:'#16a085', blurb:'Contamination type, program status'},
  {id:'nmed-bf', agency:'NM Environment Department', group:'Ground Water Quality Bureau', name:'Brownfields', url:NMED + 'gwqb/brownfields/FeatureServer/0', title:'PROPERTY_NAME', color:'#6c7a89', blurb:'Nature of contamination, project history'},
  {id:'nmed-aum', agency:'NM Environment Department', group:'Ground Water Quality Bureau', name:'Abandoned uranium mines', url:NMED + 'gwqb/aum/FeatureServer/0', title:'NAME', color:'#d4a017', blurb:'Mining method, production years, reclamation'},
  {id:'nmed-aumill', agency:'NM Environment Department', group:'Ground Water Quality Bureau', name:'Abandoned uranium mills', url:NMED + 'gwqb/aum/FeatureServer/1', title:'MINE_NAME', color:'#9c6b00', blurb:'Mill process, capacity, history'},
  {id:'nmed-aqsens', agency:'NM Environment Department', group:'Ground Water Quality Bureau', name:'Aquifer sensitivity', url:NMED + 'gwqb/aquifer_sensitivity/FeatureServer/0', title:'SENSITIVITY', geom:'polygon', by:'SENSITIVITY', colors:{'Less':'#4f9d69', 'Mod':'#e3b23c', 'High':'#c0392b'}, labels:{'Mod':'Moderate'}, color:'#e3b23c', blurb:'Relative vulnerability of groundwater to contamination (Less, Moderate, High)'},
  {id:'nmed-lust', agency:'NM Environment Department', group:'Petroleum Storage Tank Bureau', name:'Leaking petroleum storage tank sites', url:NMED + 'pstb/leaking_petroleum_storage_tank_sites/FeatureServer/0', title:'RELEASE_NAME', color:'#e67e22', blurb:'Release status, nearby wells, aquifer quality'},
  {id:'nmed-septic', agency:'NM Environment Department', group:'Environmental Health Bureau', name:'Liquid waste (septic) permits', url:NMED + 'ehb/onsite_wastewater_compliance/FeatureServer/0', title:'PROCESSINGNUMBER', color:'#8e6fbf', blurb:'About 60,000 permits; the first load takes up to a minute'},
  {id:'ocd-wells', agency:'NM Energy, Minerals and Natural Resources Department', group:'Oil Conservation Division', name:'Oil and gas wells', url:EMNRD + 'OCDView/Wells_Public/MapServer/0', title:'name', by:'type', colors:{'Oil':'#2d3436', 'Gas':'#d63031', 'Injection':'#0984e3', 'Salt Water Disposal':'#6c5ce7', 'CO2':'#fdcb6e', 'Water':'#00cec9'}, other:'#b2bec3', areaOnly:true, hide:/^(projection|symbology(_code)?|sub_type_code|type_code|status_code|district_code|county_code|point4269|geography4269|location_[xy]|globalid_1|objectid_1|shape_st(ar|le))$/i, color:'#2d3436', blurb:'About 142,000 wells: type, status, operator, depth, spud and plug dates, well file links. Loads for the selected area'},
  {id:'ocd-inj', agency:'NM Energy, Minerals and Natural Resources Department', group:'Oil Conservation Division', name:'Injection and disposal well volumes', url:EMNRD + 'OCDView/Well_Injection/MapServer/0', title:'name', by:'type', colors:{'Injection':'#0984e3', 'Salt Water Disposal':'#6c5ce7'}, other:'#b2bec3', hide:/^(projection|symbology(_code)?|sub_type_code|type_code|status_code|district_code|county_code|point4269|geography4269|location_[xy]|globalid_1|objectid_1|shape_st(ar|le))$/i, color:'#6c5ce7', blurb:'Lifetime and last-year injected volumes, first and last injection'},
  {id:'ocd-inc', agency:'NM Energy, Minerals and Natural Resources Department', group:'Oil Conservation Division', name:'Spills and releases (incidents)', url:EMNRD + 'OCDView/Incidents_Public/MapServer/0', title:'name', by:'type', colors:{'Produced Water Release':'#e17055', 'Oil Release':'#2d3436', 'Natural Gas Release':'#fdcb6e', 'Release Other':'#a29bfe'}, other:'#b2bec3', hide:/^(projection|symbology(_code)?|sub_type_code|type_code|status_code|district_code|county_code|point4269|geography4269|location_[xy]|globalid_1|objectid_1|shape_st(ar|le))$/i, alias:{bfire:'Fire', bwater:'Water affected', bdanger:'Danger', bdamage:'Damage', binjury:'Injury', min_year:'Year', materials_summary:'Materials (type, volume released/recovered/lost, units)'}, color:'#e17055', blurb:'About 29,000 incidents: material and volume, severity, whether water was affected, remediation status'},
  {id:'ocd-fac', agency:'NM Energy, Minerals and Natural Resources Department', group:'Oil Conservation Division', name:'Oil and gas facilities', url:EMNRD + 'OCDView/Facilities_Public/MapServer/0', title:'name', hide:/^(projection|symbology(_code)?|sub_type_code|type_code|status_code|district_code|county_code|point4269|geography4269|location_[xy]|globalid_1|objectid_1|shape_st(ar|le))$/i, color:'#636e72', blurb:'Tank batteries, pits, recycling and waste facilities; ground water depth, impact and quality'},
  {id:'ocd-brine', agency:'NM Energy, Minerals and Natural Resources Department', group:'Oil Conservation Division', name:'Brine wells', url:EMNRD + 'OCDView/Brine_Wells/MapServer/0', title:'wellname', hide:/^(projection|symbology(_code)?|sub_type_code|type_code|status_code|district_code|county_code|point4269|geography4269|location_[xy]|globalid_1|objectid_1|shape_st(ar|le))$/i, color:'#00b894', blurb:'Solution-mining brine wells and permits'},
  {id:'ocd-karst', agency:'NM Energy, Minerals and Natural Resources Department', group:'Oil Conservation Division', name:'Karst occurrence potential', url:EMNRD + 'OCDView/Permian_Basin_Karst_Areas/MapServer/1', title:'Potential', geom:'polygon', by:'Potential', colors:{'Low':'#4f9d69', 'Medium':'#e3b23c', 'High':'#c0392b'}, hide:/^(projection|symbology(_code)?|sub_type_code|type_code|status_code|district_code|county_code|point4269|geography4269|location_[xy]|globalid_1|objectid_1|shape_st(ar|le))$/i, color:'#e3b23c', blurb:'Permian Basin (BLM karst potential)'},
  {id:'ocd-ckra', agency:'NM Energy, Minerals and Natural Resources Department', group:'Oil Conservation Division', name:'Critical karst resource area', url:EMNRD + 'OCDView/Permian_Basin_Karst_Areas/MapServer/0', title:'Id', geom:'polygon', hide:/^(projection|symbology(_code)?|sub_type_code|type_code|status_code|district_code|county_code|point4269|geography4269|location_[xy]|globalid_1|objectid_1|shape_st(ar|le))$/i, color:'#8e44ad', blurb:'Permian Basin'},
  {id:'mmd-mines', agency:'NM Energy, Minerals and Natural Resources Department', group:'Mining and Minerals Division', name:'Registered mines', url:EMNRD + 'MMDView/Registered_Mines/MapServer/0', title:'Name', hide:/^(projection|symbology(_code)?|sub_type_code|type_code|status_code|district_code|county_code|point4269|geography4269|location_[xy]|globalid_1|objectid_1|shape_st(ar|le))$/i, color:'#a0522d', blurb:'Status, commodities, mine type, MSHA ID'},
  {id:'mmd-marp', agency:'NM Energy, Minerals and Natural Resources Department', group:'Mining and Minerals Division', name:'Mining Act permits (MARP)', url:EMNRD + 'MMDView/MARP_Permits_SQL/MapServer/0', title:'PermitName', hide:/^(projection|symbology(_code)?|sub_type_code|type_code|status_code|district_code|county_code|point4269|geography4269|location_[xy]|globalid_1|objectid_1|shape_st(ar|le))$/i, color:'#cd853f', blurb:'Permit type and status, operator, commodities, permitted acres'},
  {id:'mmd-umines', agency:'NM Energy, Minerals and Natural Resources Department', group:'Mining and Minerals Division', name:'Legacy uranium mines', url:EMNRD + 'MMDEdit/Legacy_Uranium_Mines_masterlist_update/MapServer/0', title:'Name', hide:/^(projection|symbology(_code)?|sub_type_code|type_code|status_code|district_code|county_code|point4269|geography4269|location_[xy]|globalid_1|objectid_1|shape_st(ar|le))$/i, color:'#d4a017', blurb:'Mining methods, production years, workings depth, land status'},
  {id:'mmd-coal', agency:'NM Energy, Minerals and Natural Resources Department', group:'Mining and Minerals Division', name:'Coal mine permit boundaries', url:EMNRD + 'MMDEdit/NM_Coal_Mine_Resources/MapServer/1', title:'MineName', geom:'polygon', hide:/^(projection|symbology(_code)?|sub_type_code|type_code|status_code|district_code|county_code|point4269|geography4269|location_[xy]|globalid_1|objectid_1|shape_st(ar|le))$/i, color:'#2d3436', blurb:'Permittee, mine type, status (2015)'},
  {id:'mmd-metal', agency:'NM Energy, Minerals and Natural Resources Department', group:'Mining and Minerals Division', name:'Metal mining districts', url:EMNRD + 'MMDOffline/NM_Mining_Districts/MapServer/1', title:'DISTRICT', geom:'polygon', hide:/^(projection|symbology(_code)?|sub_type_code|type_code|status_code|district_code|county_code|point4269|geography4269|location_[xy]|globalid_1|objectid_1|shape_st(ar|le))$/i, color:'#b8860b', blurb:'174 districts'},
  {id:'mmd-udist', agency:'NM Energy, Minerals and Natural Resources Department', group:'Mining and Minerals Division', name:'Uranium mining districts', url:EMNRD + 'MMDOffline/NM_Mining_Districts/MapServer/2', title:'DISTRICT_1', geom:'polygon', hide:/^(projection|symbology(_code)?|sub_type_code|type_code|status_code|district_code|county_code|point4269|geography4269|location_[xy]|globalid_1|objectid_1|shape_st(ar|le))$/i, color:'#d4a017', blurb:'36 districts'},
  {id:'sfd-burnsev', agency:'NM Energy, Minerals and Natural Resources Department', group:'Forestry Division', name:'Wildfire burn severity 2010–2022', url:EMNRD + 'SFDView/Burn_Severity_for_Wildfires_from_2010_to_2022/MapServer', tiles:EMNRD + 'SFDView/Burn_Severity_for_Wildfires_from_2010_to_2022/MapServer/tile/{z}/{y}/{x}', minZoom:7, maxNativeZoom:15, geom:'polygon', colors:{'u':'#267300', 'l':'#55ff00', 'm':'#ffff00', 'h':'#ff0000'}, labels:{'u':'Unchanged', 'l':'Low severity', 'm':'Moderate severity', 'h':'High severity'}, color:'#ff0000', blurb:'MTBS 2010–2021, BARC and CBI 2022. Map image; appears at zoom 7 and closer'},
  {id:'sfd-fires', agency:'NM Energy, Minerals and Natural Resources Department', group:'Forestry Division', name:'Fire perimeters (through 2026)', url:EMNRD + 'SFDView/Fire_History_as_of_2024/MapServer/0', title:'FIRENAME', geom:'polygon', alias:{firename:'Fire', fireyear:'Year', totalacres_1:'Acres', total_acres:'Total acres', landcover_1:'Land cover'}, hide:/^(totalacres_1)$/i, color:'#d35400', blurb:'All mapped fires: name, year, acres, land cover, elevation, slope. Covers fires after 2022 that the severity map does not'}
];
const PUB_BY_ID = new Map(PUB_LAYERS.map(L_=>[L_.id, L_]));
const PUB_CACHE = 'pub-layer-v1:';
const pubOn = new Set();   // the map starts empty: layers load only when turned on
const pubSaveOn = () => ls.set('wq-pub-on', JSON.stringify([...pubOn]));
let jsonpN = 0;
function jsonpOnce(url, ms){
  return new Promise((res, rej)=>{
    const cb = '__pubcb' + (++jsonpN), s = document.createElement('script');
    const done = () => { delete window[cb]; s.remove(); clearTimeout(t); };
    const t = setTimeout(()=>{ done(); rej(new Error('timed out')); }, ms || 90000);
    window[cb] = j => { done(); res(j); };
    s.onerror = () => { done(); rej(new Error('request failed')); };
    s.src = url + (url.includes('?') ? '&' : '?') + 'callback=' + cb;
    document.head.appendChild(s);
  });
}
async function pubJson(url){
  let j;
  if(PUB_JSONP.test(url)){
    let err; for(let a=0; a<3; a++){ try{ j = await jsonpOnce(url); err = null; break; }catch(e){ err = e; await sleep(800*(a+1)); } }
    if(err) throw err;
  } else { const r = await apiFetch(url, 3); j = await r.json(); }
  if(j && j.error) throw new Error(j.error.message || 'service error'); return j;
}
// Esri JSON geometry -> GeoJSON (points and polygons; clockwise rings are outer rings)
function esriToGeo(g){
  if(!g) return null;
  if(g.x != null) return {type:'Point', coordinates:[g.x, g.y]};
  if(g.rings){
    const polys = [];
    for(const r of g.rings){ let a = 0; for(let i=0, n=r.length; i<n; i++){ const p = r[i], q = r[(i+1)%n]; a += p[0]*q[1] - q[0]*p[1]; } if(a <= 0 || !polys.length) polys.push([r]); else polys[polys.length-1].push(r); }
    return {type:'MultiPolygon', coordinates:polys};
  }
  return null;
}
// geometry for every feature (only the ID and title fields; the full record loads on click)
async function pubLoad(L_){
  if(L_.feats) return L_.feats;
  if(L_.promise) return L_.promise;
  if(L_.tiles){ L_.feats = []; L_.total = 0; pubRedraw(); pubRender(); return L_.feats; }   // cached map image: nothing to query
  const bbk = L_.areaOnly ? pubBbKey() : '';
  if(L_.areaOnly && !bbk){ L_.status = 'select an area to load'; pubRender(); return []; }
  L_.status = 'loading…'; pubRender();
  L_.promise = (async()=>{
    const ck = PUB_CACHE + L_.id + (bbk ? ':' + bbk : '');
    const geo = bbk ? {geometry:bbk, geometryType:'esriGeometryEnvelope', inSR:'4326', spatialRel:'esriSpatialRelIntersects'} : {};
    let d = await idbGet(ck);
    if(!d || Date.now() - d.t > CACHE_TTL){
      const meta = await pubJson(L_.url + '?f=json');
      const oidF = (meta.fields || []).find(f=>f.type === 'esriFieldTypeOID'), oid = (oidF && oidF.name) || meta.objectIdField || 'OBJECTID';
      const fields = [oid, L_.title, L_.by].filter((v,i,a)=>v && a.indexOf(v) === i).join(',');
      const page = meta.maxRecordCount || 1000;
      const total = (await pubJson(L_.url + '/query?' + new URLSearchParams({where:'1=1', returnCountOnly:'true', ...geo, f:'json'}))).count || 0;
      const offs = []; for(let o=0; o<total; o += page) offs.push(o);
      let got = 0;
      const pages = await apiPool(offs.map(o=>async()=>{
        const jp = PUB_JSONP.test(L_.url);
        const j = await pubJson(L_.url + '/query?' + new URLSearchParams({where:'1=1', ...geo, outFields:fields, outSR:'4326', orderByFields:oid, resultOffset:o, resultRecordCount:page, geometryPrecision:L_.geom === 'polygon' ? 5 : 6, f:jp ? 'json' : 'geojson'}));
        if(jp) j.features = (j.features || []).map(f=>({properties:f.attributes || {}, geometry:esriToGeo(f.geometry)}));
        got += (j.features || []).length; L_.status = 'loading ' + Math.round(100*got/Math.max(1,total)) + '%'; pubRender();
        return j.features || [];
      }), 3);
      const feats = [];
      for(const f of pages.flat()){
        const p = f.properties || {}, g = f.geometry;
        const rec = {id:p[oid] != null ? p[oid] : f.id, t:p[L_.title] != null ? String(p[L_.title]) : '', v:L_.by ? p[L_.by] : null};
        if(L_.geom === 'polygon'){ if(!g) continue; rec.g = g; }
        else{
          const x = g && g.coordinates ? +g.coordinates[0] : NaN, y = g && g.coordinates ? +g.coordinates[1] : NaN;
          if(!isFinite(x) || !isFinite(y)) continue;
          rec.lng = x; rec.lat = y;
        }
        feats.push(rec);
      }
      d = {t:Date.now(), feats, oid, total, aliases:Object.fromEntries((meta.fields || []).map(f=>[f.name, {a:f.alias || f.name, t:f.type}]))};
      await idbSet(ck, d);
    }
    if(L_.areaOnly && pubBbKey() !== bbk){ L_.promise = null; L_.status = ''; return pubLoad(L_); }   // area changed while loading
    L_.bbkey = bbk;
    L_.feats = d.feats; L_.oid = d.oid; L_.total = d.total; L_.fields = d.aliases; L_.status = '';
    for(const f of L_.feats) f.L = L_;
    pubRedraw(); pubRender();
    return L_.feats;
  })().catch(e=>{ L_.promise = null; L_.status = 'could not load: ' + e.message; pubRender(); throw e; });
  return L_.promise;
}
function pubBbKey(){ const A = state.area; return A ? A.bb.map(v=>(+v).toFixed(4)).join(',') : ''; }
function pubColor(L_, v){ return L_.colors ? (L_.colors[v] || L_.other || L_.color) : L_.color; }
// reload area-only layers when the area changes
function pubAreaSync(){
  for(const L_ of PUB_LAYERS){
    if(!L_.areaOnly || !pubOn.has(L_.id)) continue;
    const k = pubBbKey();
    if(L_.feats && L_.bbkey === k) continue;
    if(L_.promise && !L_.feats) continue;   // a load in progress re-checks the area when it finishes
    L_.feats = null; L_.promise = null; L_.bbkey = null;
    pubLoad(L_).catch(()=>{});
  }
  pubRedraw();
}
const pubPolyLayers = new Map();
const pubPane = map.createPane('pubPolyPane'); pubPane.style.zIndex = 410;
function pubRedraw(){
  const items = [];
  for(const L_ of PUB_LAYERS){
    if(!pubOn.has(L_.id) || !L_.feats) continue;
    if(L_.tiles){
      if(!pubPolyLayers.has(L_.id)) pubPolyLayers.set(L_.id, L.tileLayer(L_.tiles, {pane:'pubPolyPane', opacity:.75, minZoom:L_.minZoom || 0, maxNativeZoom:L_.maxNativeZoom || 18, maxZoom:20, attribution:'EMNRD Forestry Division'}));
      const lyr = pubPolyLayers.get(L_.id); if(!map.hasLayer(lyr)) lyr.addTo(map);
      continue;
    }
    if(L_.geom === 'polygon'){
      if(!pubPolyLayers.has(L_.id)){
        const byId = new Map(L_.feats.map(f=>[f.id, f]));
        const lyr = L.geoJSON({type:'FeatureCollection', features:L_.feats.map(f=>({type:'Feature', geometry:f.g, properties:{id:f.id}}))}, {pane:'pubPolyPane', style:ft=>{ const f = byId.get(ft.properties.id); const c = pubColor(L_, f && f.v); return {color:c, weight:.8, fillColor:c, fillOpacity:.22}; },
          onEachFeature:(ft, l)=>l.on('click', ev=>{ if(state.drawing) return; pubPolyClickT = Date.now(); const f = byId.get(ft.properties.id); const cp = ev.containerPoint; if(f && !pubPoints.hits(cp).length && !points.hits(cp).length && !wqpPoints.hits(cp).length && !dwPoints.hits(cp).length) openPubPopup(f, [f], ev.latlng); })});
        pubPolyLayers.set(L_.id, lyr);
      }
      const lyr = pubPolyLayers.get(L_.id); if(!map.hasLayer(lyr)) lyr.addTo(map);
    } else for(const f of L_.feats) items.push({w:f, c:pubColor(L_, f.v), z:0, tri:true});
  }
  for(const [id, lyr] of pubPolyLayers) if(!pubOn.has(id) && map.hasLayer(lyr)) map.removeLayer(lyr);
  pubPoints.setData(items); renderPubLegend();
}
function pubCount(L_){ if(!L_.feats || L_.tiles) return null; if(!state.area || L_.geom === 'polygon') return L_.feats.length; let n = 0; for(const f of L_.feats) if(inArea(f)) n++; return n; }
function pubSwatch(L_){ return L_.geom === 'polygon' ? `<span class="polysw" style="border-color:${L_.color};background:${L_.color}55"></span>` : `<span class="tri" style="border-bottom-color:${L_.color}"></span>`; }
function pubRender(){
  let h = '', ag = '', gr = '';
  for(const L_ of PUB_LAYERS){
    if(L_.agency !== ag){ ag = L_.agency; gr = ''; h += `<h4 class="pub-agency" style="margin-top:${h ? 14 : 0}px">${esc(ag)}</h4>`; }
    if(L_.group && L_.group !== gr){ gr = L_.group; h += `<div class="pub-group">${esc(gr)}</div>`; }
    const n = pubCount(L_), on = pubOn.has(L_.id);
    const cnt = L_.status ? L_.status : n == null ? '' : (state.area && L_.geom !== 'polygon' ? n.toLocaleString() + ' here' : n.toLocaleString());
    h += `<label class="prow"><input type="checkbox" data-pub="${esc(L_.id)}" ${on ? 'checked' : ''}>${pubSwatch(L_)}<span class="k">${esc(L_.name)}<small>${esc(L_.blurb || '')} · <a href="${esc(L_.url)}" target="_blank" rel="noopener">service ↗</a></small></span><span class="n${/could not/.test(L_.status || '') ? ' err' : ''}">${esc(cnt)}</span></label>`;
  }
  $('pub-list').innerHTML = h;
}
function renderPubLegend(){
  const on = PUB_LAYERS.filter(L_=>pubOn.has(L_.id) && L_.feats);
  if(!on.length){ $('legend-pub').innerHTML = ''; return; }
  let h = '<div class="lg-sep"></div><h5>Public API layers</h5>';
  for(const L_ of on){
    if(L_.colors){
      const sw = c => L_.geom === 'polygon' ? `<span class="polysw" style="border-color:${c};background:${c}55"></span>` : `<span class="tri" style="border-bottom-color:${c}"></span>`;
      const n = L_.geom === 'polygon' ? null : pubCount(L_);
      h += `<div class="lg-row"><span class="k" style="font-weight:600">${esc(L_.name)}</span><span class="n">${n == null ? '' : n.toLocaleString()}</span></div>` + Object.entries(L_.colors).map(([v, c])=>`<div class="lg-row">${sw(c)}<span class="k">${esc((L_.labels && L_.labels[v]) || v)}</span></div>`).join('') + (L_.other ? `<div class="lg-row">${sw(L_.other)}<span class="k">Other</span></div>` : '');
    }
    else { const n = pubCount(L_); h += `<div class="lg-row">${pubSwatch(L_)}<span class="k">${esc(L_.name)}</span><span class="n">${n == null ? '' : n.toLocaleString()}</span></div>`; }
  }
  $('legend-pub').innerHTML = h;
}
$('pub-list').addEventListener('change', e=>{
  const id = e.target.dataset.pub; if(!id) return;
  const L_ = PUB_BY_ID.get(id);
  if(e.target.checked){ pubOn.add(id); pubLoad(L_).catch(()=>{}); } else pubOn.delete(id);
  pubSaveOn(); pubRedraw(); pubRender();
});
const pubVal = (L_, k, v) => {
  const t = L_.fields && L_.fields[k] && L_.fields[k].t;
  if(t === 'esriFieldTypeDate' && v != null && isFinite(+v)) return new Date(+v).toLocaleDateString();
  const s = String(v);
  if(/^https?:\/\//i.test(s.trim())) return `<a href="${esc(s.trim().replace(/ /g, '%20'))}" target="_blank" rel="noopener">link ↗</a>`;
  return esc(s);
};
const PUB_SKIP = /^(objectid(_1)?|globalid|shape(__area|__length)?|shape\.st(area|length)\(\)|fid|runtime)$/i;
// related tables (water right records, scanned well logs) joined on L_.key -> rel.fk
const WR_STATUS = {PMT:'Permit', LIC:'License', DCL:'Declaration', ADJ:'Adjudicated', EXP:'Expired', CLS:'Closed', CAN:'Cancelled', APP:'Application', OMS:'Offset', NOI:'Notice of intent', UWL:'Underground water law'};
async function pubRelated(L_, a){
  if(!L_.related || !L_.key || a[L_.key] == null) return '';
  const https = u => String(u || '').trim().replace(/^http:\/\//i, 'https://').replace(/ /g, '%20');
  const parts = await Promise.all(L_.related.map(async R=>{
    try{
      const j = await pubJson(R.url + '/query?' + new URLSearchParams({where:R.fk + '=' + Number(a[L_.key]), outFields:'*', returnGeometry:'false', resultRecordCount:'100', f:'json'}));
      const rs = (j.features || []).map(x=>x.attributes);
      if(!rs.length) return `<div class="poph">${esc(R.label)}</div><p class="note">None on file.</p>`;
      let items;
      if(R.kind === 'wr'){
        const seen = new Set();
        items = rs.filter(r=>{ const k = r.db_file + '|' + r.status + '|' + r.use; if(seen.has(k)) return false; seen.add(k); return true; })
          .map(r=>`<div class="pick"><span><b>${esc(r.db_file || [r.basin, r.nbr, r.suffix].filter(Boolean).join('-'))}</b> <small style="color:var(--muted)">${esc(WR_STATUS[r.status] || r.status || '')}${r.use ? ' · ' + esc(r.use) : ''}${r.total_div != null ? ' · ' + esc(r.total_div) + ' ac-ft/yr' : ''}${r.chng_repl ? ' · ' + (r.chng_repl === 'C' ? 'changed' : r.chng_repl === 'R' ? 'replaced' : esc(r.chng_repl)) : ''}</small></span>${r.nmwrrs_wrsum_url ? `<a class="btn small" style="text-decoration:none" href="${esc(https(r.nmwrrs_wrsum_url))}" target="_blank" rel="noopener">NMWRRS ↗</a>` : ''}</div>`);
      } else {
        rs.sort((x, y)=>new Date(x.LogFileDate) - new Date(y.LogFileDate));
        items = rs.map(r=>`<div class="pick"><span>${esc(r.LogFileDate || 'undated')}</span>${r.Scanned_WellLog_Link ? `<a class="btn small" style="text-decoration:none" href="${esc(https(r.Scanned_WellLog_Link))}" target="_blank" rel="noopener">Well log ↗</a>` : ''}</div>`);
      }
      return `<div class="poph">${esc(R.label)} (${items.length})</div>` + items.join('');
    }catch(e){ return `<div class="poph">${esc(R.label)}</div><p class="note">Could not load: ${esc(e.message)}</p>`; }
  }));
  return parts.join('');
}
async function openPubPopup(f, group, at){
  const L_ = f.L, ll = at || (f.g ? L.geoJSON(f.g).getBounds().getCenter() : L.latLng(f.lat, f.lng));
  const others = (group || []).filter(o=>o !== f).slice(0, 6);
  const head = `<div class="pop"><h6>${esc(f.t || L_.name)}</h6><div class="sub">${esc(L_.name)} · ${esc(L_.group || L_.agency)}</div>`;
  popup = L.popup({maxWidth:400, minWidth:280, maxHeight:Math.max(260, Math.round(map.getSize().y*0.7)), autoPanPadding:[30,30]}).setLatLng(ll).setContent(head + '<p class="note">Loading the record…</p></div>').openOn(map);
  const mine = popup;
  try{
    const j = await pubJson(L_.url + '/query?' + new URLSearchParams({objectIds:String(f.id), outFields:'*', returnGeometry:'false', f:'json'}));
    const a = (j.features && j.features[0] && j.features[0].attributes) || {};
    const lab = k => (L_.alias && L_.alias[k.toLowerCase()]) || (L_.fields && L_.fields[k] && L_.fields[k].a) || k;
    const val = (k, v) => (/^b[A-Z]/.test(k) && (v === 0 || v === 1)) ? (v ? 'Yes' : 'No') : (L_.by && k === L_.by && L_.labels && L_.labels[v]) ? esc(v + ' (' + L_.labels[v] + ')') : pubVal(L_, k, v);
    const rows = Object.entries(a).filter(([k, v])=>v != null && String(v).trim() !== '' && !PUB_SKIP.test(k) && !(L_.hide && L_.hide.test(k))).map(([k, v])=>`<tr><td class="k">${esc(lab(k))}</td><td class="v" style="white-space:normal;text-align:right">${val(k, v)}</td></tr>`).join('');
    const rel = await pubRelated(L_, a);
    const more = others.length ? '<div class="poph">Also here</div>' + others.map(o=>`<div class="pick"><span>${esc(o.t || 'feature ' + o.id)} <small style="color:var(--muted)">${esc(o.L.name)}</small></span><button class="btn small" data-act="pub" data-k="${esc(o.L.id + '|' + o.id)}">Open</button></div>`).join('') : '';
    if(popup === mine) mine.setContent(head + `<table>${rows || '<tr><td>No attributes</td></tr>'}</table>${rel}${more}<div class="actions"><a class="btn small" style="text-decoration:none" href="${esc(L_.url)}" target="_blank" rel="noopener">Layer service ↗</a></div></div>`);
  }catch(e){ if(popup === mine) mine.setContent(head + '<p class="note" style="color:var(--warn)">Could not load the record: ' + esc(e.message) + '</p></div>'); }
}
pubRender();

/* ==================================================================== */
/* 14c. Export samples: chosen parameters, every source, one workbook   */
/* ==================================================================== */
// weaver: API time-series key; wqp: WQP characteristic names; ccr: CCR contaminant names; std: EPA drinking water limit in mg/L
const XP_PARAMS = [
  {k:'arsenic', label:'Arsenic', weaver:'arsenic', wqp:['Arsenic'], ccr:/^arsenic$/i, std:[0.010, 'MCL']},
  {k:'uranium', label:'Uranium', weaver:'uranium', wqp:['Uranium'], ccr:/^uranium$/i, std:[0.030, 'MCL']},
  {k:'copper', label:'Copper', wqp:['Copper'], ccr:/^copper$/i, std:[1.3, 'Action level']},
  {k:'lead', label:'Lead', wqp:['Lead'], ccr:/^lead$/i, std:[0.015, 'Action level']},
  {k:'nitrate', label:'Nitrate', weaver:'nitrate', wqp:['Nitrate', 'Inorganic nitrogen (nitrate and nitrite)', 'Nitrate + Nitrite'], ccr:/^nitrate/i, std:[10, 'MCL (as N)']},
  {k:'fluoride', label:'Fluoride', weaver:'fluoride', wqp:['Fluoride'], ccr:/^fluoride$/i, std:[4.0, 'MCL']},
  {k:'tds', label:'Total dissolved solids', weaver:'tds', wqp:['Total dissolved solids'], ccr:/dissolved solids/i, std:[500, 'Secondary MCL']},
  {k:'sulfate', label:'Sulfate', weaver:'sulfate', wqp:['Sulfate'], ccr:/^sulfate$/i, std:[250, 'Secondary MCL']},
  {k:'chloride', label:'Chloride', weaver:'chloride', wqp:['Chloride'], ccr:/^chloride$/i, std:[250, 'Secondary MCL']},
  {k:'calcium', label:'Calcium', weaver:'calcium', wqp:['Calcium']},
  {k:'magnesium', label:'Magnesium', weaver:'magnesium', wqp:['Magnesium']},
  {k:'sodium', label:'Sodium', weaver:'sodium', wqp:['Sodium'], ccr:/^sodium$/i},
  {k:'potassium', label:'Potassium', weaver:'potassium', wqp:['Potassium']},
  {k:'bicarbonate', label:'Bicarbonate', weaver:'bicarbonate', wqp:['Bicarbonate']},
  {k:'carbonate', label:'Carbonate', weaver:'carbonate', wqp:['Carbonate']},
  {k:'barium', label:'Barium', wqp:['Barium'], ccr:/^barium$/i, std:[2, 'MCL']},
  {k:'chromium', label:'Chromium', wqp:['Chromium'], ccr:/^chromium$/i, std:[0.1, 'MCL']},
  {k:'selenium', label:'Selenium', wqp:['Selenium'], ccr:/^selenium$/i, std:[0.05, 'MCL']},
  {k:'cadmium', label:'Cadmium', wqp:['Cadmium'], ccr:/^cadmium$/i, std:[0.005, 'MCL']},
  {k:'mercury', label:'Mercury', wqp:['Mercury'], ccr:/^mercury/i, std:[0.002, 'MCL']},
  {k:'antimony', label:'Antimony', wqp:['Antimony'], ccr:/^antimony$/i, std:[0.006, 'MCL']},
  {k:'beryllium', label:'Beryllium', wqp:['Beryllium'], ccr:/^beryllium$/i, std:[0.004, 'MCL']},
  {k:'thallium', label:'Thallium', wqp:['Thallium'], ccr:/^thallium$/i, std:[0.002, 'MCL']},
  {k:'nickel', label:'Nickel', wqp:['Nickel'], ccr:/^nickel$/i},
  {k:'manganese', label:'Manganese', wqp:['Manganese'], ccr:/^manganese$/i, std:[0.05, 'Secondary MCL']},
  {k:'iron', label:'Iron', wqp:['Iron'], ccr:/^iron$/i, std:[0.3, 'Secondary MCL']},
  {k:'zinc', label:'Zinc', wqp:['Zinc'], ccr:/^zinc$/i, std:[5, 'Secondary MCL']},
  {k:'radium', label:'Radium (226, 228, combined)', wqp:['Radium-226', 'Radium-228', 'Radium'], ccr:/radium/i},
  {k:'alpha', label:'Gross alpha', wqp:['Gross alpha radioactivity, (excluding radon and uranium)', 'Gross alpha radioactivity, including radon and uranium'], ccr:/gross alpha/i}
];
const XP_BY = new Map(XP_PARAMS.map(p=>[p.k, p]));
const XP_COLS = ['parameter', 'record_type', 'activity_type', 'source', 'provider', 'organization', 'site_id', 'site_name', 'site_type', 'water_source', 'latitude', 'longitude', 'county', 'huc8', 'huc8_name', 'aquifer', 'reported_aquifer', 'well_depth_ft',
  'pws_id', 'system_name', 'pws_source_name', 'pws_match', 'sample_date', 'sample_year', 'sample_time', 'result_as_reported', 'censored', 'value', 'unit', 'value_mg_L', 'conversion_note', 'detection_limit', 'detection_limit_unit', 'fraction', 'speciation',
  'standard_mg_L', 'standard_type', 'exceeds_standard', 'also_reported_by', 'ccr_year', 'ccr_range_low', 'ccr_range_high', 'method', 'result_status', 'qualifier', 'sample_id', 'sample_media', 'source_parameter_name', 'link'];
const XP_COL_HELP = {
  parameter:'Parameter chosen for the export', record_type:'sample = one laboratory result; CCR rows are report summaries', source:'Where the row came from: Weaver API, Water Quality Portal, or an NMED Consumer Confidence Report',
  provider:'Original data provider inside that source (for the Weaver API: ST/DWB = NMED Drinking Water Bureau, NMBGMR, BOR-RISE, WQP)', organization:'Collecting organization', site_id:'Site identifier in the source', site_name:'Site name',
  site_type:'Site type as the source reports it', water_source:'Groundwater, Surface water or Other, worked out from the site type', latitude:'WGS84', longitude:'WGS84', county:'County containing the site', huc8:'HUC-8 watershed code', huc8_name:'HUC-8 watershed name',
  aquifer:'Aquifer polygon(s) containing the site, from the NMBGMR aquifer map built into the explorer; a location match, not a completion', reported_aquifer:'Aquifer name the source reports for the well (WQP only)', well_depth_ft:'Well depth in feet where the source has it',
  pws_id:'Public water system ID', system_name:'Public water system name', pws_source_name:'Name of the system source (well, spring, intake). For Weaver API drinking-water sites this is the NMED source at the same location (within 5 m)', pws_match:'How the Weaver API drinking-water site was matched to an NMED source, or why it was not',
  sample_date:'YYYY-MM-DD. Blank when a CCR gives only a year', sample_year:'Year of the sample', sample_time:'Time where reported', result_as_reported:'The result exactly as the source gives it',
  censored:'< = below the reporting or detection limit; > = above the quantification range', value:'Numeric result. For censored results this is the limit', unit:'Unit of value',
  value_mg_L:'Value in mg/L when the unit can be converted (nitrate is as N). Blank for units that cannot be converted', conversion_note:'What was done to get value_mg_L when it was more than a unit change',
  detection_limit:'Reporting or detection limit', detection_limit_unit:'Unit of the limit', fraction:'Dissolved, Total and so on. "Not reported" when the source does not say', speciation:'Chemical form the result is expressed as (as N, as NO3)',
  standard_mg_L:'EPA drinking water limit used for comparison', standard_type:'MCL, action level or secondary MCL', exceeds_standard:'yes / no; "not determined" when a censored limit is above the standard',
  also_reported_by:'Duplicate copies of this result that were removed (source, site and sample ID); see the Removed duplicates sheet', activity_type:'WQP activity type (Sample-Routine, Quality Control Sample-Field Replicate and so on)', removed_because:'Why this row was removed', kept_record:'The row that was kept instead (source | site | sample ID)', ccr_year:'CCR report year', ccr_range_low:'Low end of the range in the CCR', ccr_range_high:'High end of the range in the CCR',
  method:'Analytical method', result_status:'Status or approval', qualifier:'Qualifier codes', sample_id:'Sample or activity ID in the source', sample_media:'Sample medium', source_parameter_name:'Parameter name in the source', link:'Site or report page'};
const xpDecode = s => { const t = document.createElement('textarea'); t.innerHTML = String(s == null ? '' : s); return t.value; };
const xpFirstNum = s => { const m = String(s == null ? '' : s).replace(/,/g, '').match(/-?\d*\.?\d+(?:[eE][-+]?\d+)?/); return m ? +m[0] : null; };
const XP_TO_MG = {'mg/l':1, 'ppm':1, 'ug/l':1e-3, 'µg/l':1e-3, 'μg/l':1e-3, 'mcg/l':1e-3, 'ppb':1e-3, 'ng/l':1e-6, 'ppt':1e-6, 'g/l':1000};
const XP_SOLID = /\/\s?k?g\b|\bug\/g|\bmg\/g|%|\bdry\b|\bwet\b/i;
const sig = (v, n) => v == null || !isFinite(v) ? null : +(+v).toPrecision(n || 6);
function xpIsoDate(s){
  s = String(s == null ? '' : s).trim(); let m;
  if((m = s.match(/^(\d{4})-(\d{2})-(\d{2})/))) return [m[1] + '-' + m[2] + '-' + m[3], +m[1]];
  if((m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/))) return [m[3] + '-' + m[1].padStart(2, '0') + '-' + m[2].padStart(2, '0'), +m[3]];
  if((m = s.match(/^(\d{4})$/))) return ['', +m[1]];
  return [s, null];
}
// fills the derived columns of one row: date, censoring, mg/L, standard comparison
function xpFinish(o, p){
  const d = xpIsoDate(o.sample_date); o.sample_date = d[0]; o.sample_year = d[1];
  const raw = String(o.result_as_reported == null ? '' : o.result_as_reported).trim();
  if(!o.censored){ if(/^</.test(raw) || /\b(nd|not detected|non-?detect|below|less than)\b/i.test(raw)) o.censored = '<'; else if(/^>/.test(raw) || /above (the )?(quant|oper)/i.test(raw)) o.censored = '>'; }
  if(o.value == null) o.value = xpFirstNum(raw);
  if(o.censored === '<'){
    if(o.detection_limit == null || o.detection_limit === '') o.detection_limit = o.value; else o.detection_limit = xpFirstNum(o.detection_limit);
    if(!o.detection_limit_unit) o.detection_limit_unit = o.unit;
    if(o.value == null && o.detection_limit != null){ o.value = o.detection_limit; o.unit = o.detection_limit_unit || o.unit; }
  } else if(o.detection_limit != null && o.detection_limit !== '') o.detection_limit = xpFirstNum(o.detection_limit);
  if(!o.fraction) o.fraction = 'Not reported';
  const u = String(o.unit || '').trim(), ul = u.toLowerCase().replace(/\s*as\s*[a-z0-9]+.*$/, '').replace(/^([mun\u00b5\u03bc])g\s+n\/l.*$/, '$1g/l').replace(/\s+(n|no3|caco3)$/, '').trim();
  if(!o.speciation){ const sm = u.match(/as\s*(NO3|N|CaCO3|PO4|P|SO4|HCO3)\b/i) || u.match(/^[mu]g\s+(N)\/l/i); if(sm) o.speciation = 'as ' + sm[1]; }
  if(o.value != null){
    let f = XP_TO_MG[ul], note = '';
    if(f == null && p.k === 'uranium' && /^pci\/l$/i.test(ul)){ f = 1/0.67/1000; note = 'pCi/L converted to mass at 0.67 pCi per µg (EPA)'; }
    if(f != null){
      let v = o.value * f;
      if(p.k === 'nitrate' && /no3/i.test((o.speciation || '') + ' ' + u)){ v *= 0.2259; note = 'as NO3 converted to as N (x 0.2259)'; }
      o.value_mg_L = sig(v); o.conversion_note = note;
    }
  }
  if(p.std){
    o.standard_mg_L = p.std[0]; o.standard_type = p.std[1];
    if(o.value_mg_L != null) o.exceeds_standard = o.censored === '<' ? (o.value_mg_L > p.std[0] ? 'not determined (limit above standard)' : 'no') : (o.value_mg_L > p.std[0] ? 'yes' : 'no');
  }
  return o;
}
// county, watershed and aquifer for a point (cached per location)
const xpLocCache = new Map();
function xpLocate(lat, lng){
  const key = (+lat).toFixed(5) + ',' + (+lng).toFixed(5); let r = xpLocCache.get(key); if(r) return r;
  const hit = (items, polysOf) => items.filter(it=>{ const P = polysOf(it); if(!it.__bb) it.__bb = polysBB(P); const b = it.__bb; return !(lng < b[0] || lng > b[2] || lat < b[1] || lat > b[3]) && polysHit(P, lng, lat); });
  const c = hit(counties, f=>geomPolys(f.geometry))[0], h = hit(hucs, f=>geomPolys(f.geometry))[0], a = hit(aquifers, x=>x.polys);
  r = {county:c ? c.properties.NAME : '', huc8:h ? h.properties.huc8 : '', huc8_name:h ? h.properties.name : '', aquifer:a.map(x=>x.name).join('; ')};
  xpLocCache.set(key, r); return r;
}
// NMED drinking-water source(s) at the sample site. Weaver API DWB sites carry the NMED source coordinates, so a true match
// sits at the same point (checked: 4,557 of 7,596 sites are within 0.5 m). Accept up to XP_DW_MATCH_M; if sources of more than
// one system sit there, leave it unmatched rather than guess.
const XP_DW_MATCH_M = 5;
let xpDwGrid = null;
function xpNearDw(lat, lng){
  if(!DW) return null;
  if(!xpDwGrid){ xpDwGrid = new Map(); for(const key of Object.keys(DW_LAYERS)) for(const s of (DW[key] || [])){ const k = Math.round(s.lat*2000) + ',' + Math.round(s.lng*2000); if(!xpDwGrid.has(k)) xpDwGrid.set(k, []); xpDwGrid.get(k).push(s); } }
  const gy = Math.round(lat*2000), gx = Math.round(lng*2000), hits = [];
  for(let i=-1; i<=1; i++) for(let j=-1; j<=1; j++) for(const s of (xpDwGrid.get((gy+i) + ',' + (gx+j)) || [])){ const d = Math.hypot((s.lat - lat)*111000, (s.lng - lng)*111000*Math.cos(lat*Math.PI/180)); if(d <= XP_DW_MATCH_M) hits.push([d, s]); }
  if(!hits.length) return null;
  const systems = new Set(hits.map(x=>x[1].pws)); if(systems.size > 1) return {ambiguous:[...systems]};
  hits.sort((x, y)=>x[0] - y[0]);
  const s = hits[0][1], facs = [...new Set(hits.map(x=>x[1].fac))];
  return {s, fac:facs.join(' / '), d:hits[0][0]};
}
const xpWaterSource = t => /well|spring|subsurface|aquifer|ground/i.test(t || '') ? 'Groundwater' : /stream|river|lake|reservoir|impound|canal|ditch|estuary|wetland|pond|surface|intake|ocean/i.test(t || '') ? 'Surface water' : (t ? 'Other' : '');
const XP_FTYPE = {WL:'well', SP:'spring', IN:'intake', IG:'infiltration gallery', RS:'reservoir', OT:'other', NP:'non-piped', CC:'consecutive connection', TP:'treatment plant', ST:'storage'};
const XP_WTYPE = {GW:'Groundwater', SW:'Surface water', GU:'Groundwater under the influence of surface water'};

async function xpWeaver(p, out, say){
  const params = state.area ? {bbox:state.area.bb.join(',')} : {};
  const feats = await apiFeatures('nm_' + p.weaver + '_timeseries', params, (n, t)=>say(p.label + ' · Weaver API: ' + n.toLocaleString() + ' of ' + t.toLocaleString() + ' samples'), {geometry:true});
  let n = 0;
  for(const f of feats){
    const a = f.properties || {}, c = f.geometry && f.geometry.coordinates; if(!c) continue;
    const lat = c[1], lng = c[0]; if(!inArea({lat, lng})) continue;
    const w = byKey.get(a.source + ':' + a.id) || {};
    const o = {parameter:p.label, record_type:'sample', source:'Weaver API', provider:a.source, site_id:a.source + ':' + a.id, site_name:w.name, water_source:'Groundwater', latitude:lat, longitude:lng, well_depth_ft:w.depth,
      sample_date:a.date_measured, sample_time:a.time_measured, source_parameter_name:a.source_parameter_name || a.parameter_name, result_as_reported:xpDecode(a.parameter_value), unit:a.parameter_units,
      result_status:a.approval_status || (a.approval_status_normalized === 'unknown' ? '' : a.approval_status_normalized), qualifier:a.qualifier, sample_id:a.feature_id, sample_media:'Water'};
    if(/DWB/i.test(a.source || '')){
      o.organization = 'NMED Drinking Water Bureau';
      const m = xpNearDw(lat, lng), s = m && m.s;
      if(m && m.ambiguous) o.pws_match = 'not matched: sources of ' + m.ambiguous.join(', ') + ' share this location';
      else if(!m) o.pws_match = 'not matched: no NMED source within ' + XP_DW_MATCH_M + ' m';
      if(s){ o.pws_id = s.pws; o.system_name = s.sys; o.pws_source_name = m.fac; o.site_name = s.sys + ' · ' + m.fac; o.pws_match = m.d < 2 ? 'same location as the NMED source' : 'NMED source ' + m.d.toFixed(1) + ' m away'; o.site_type = 'Public water system source' + (s.ftype ? ' (' + (XP_FTYPE[s.ftype] || s.ftype) + ')' : ''); o.water_source = XP_WTYPE[s.wtype] || o.water_source; if(o.well_depth_ft == null && s.depth != null) o.well_depth_ft = +s.depth.toFixed(1); }
      else o.site_type = 'Public water system source';
    }
    out.push(xpFinish(o, p)); n++;
  }
  return n;
}
async function xpWqp(p, out, say){
  const q = new URLSearchParams();
  if(state.area) q.set('bBox', state.area.bb.map(v=>(+v).toFixed(4)).join(',')); else q.set('statecode', 'US:35');
  for(const c of p.wqp) q.append('characteristicName', c);
  if($('xp-wqp-water').checked) q.set('sampleMedia', 'Water');
  if($('xp-wqp-gw').checked){ q.append('siteType', 'Well'); q.append('siteType', 'Spring'); }
  q.set('mimeType', 'csv'); q.set('zip', 'no');
  const table = async kind => { const t = await (await apiFetch(WQP_BASE + '/' + kind + '/search?' + q, 3)).text(); const rows = WQPCore.parseCsv(t); const ix = rows.length ? Object.fromEntries(rows[0].map((h, i)=>[h, i])) : {}; return {rows, g:(r, k)=>ix[k] == null ? '' : (r[ix[k]] || '')}; };
  say(p.label + ' · Water Quality Portal: sites…');
  const S = await table('Station'), sites = new Map();
  for(let i=1; i<S.rows.length; i++){
    const r = S.rows[i], id = S.g(r, 'MonitoringLocationIdentifier'), lat = +S.g(r, 'LatitudeMeasure'), lng = +S.g(r, 'LongitudeMeasure'); if(!id || !isFinite(lat) || !isFinite(lng) || (!lat && !lng)) continue;
    let dep = xpFirstNum(S.g(r, 'WellDepthMeasure/MeasureValue')); if(dep != null && /^m/i.test(S.g(r, 'WellDepthMeasure/MeasureUnitCode'))) dep *= 3.28084;
    sites.set(id, {lat, lng, n:S.g(r, 'MonitoringLocationName'), t:S.g(r, 'MonitoringLocationTypeName'), dep:dep == null ? null : +dep.toFixed(1), aq:S.g(r, 'AquiferName'), org:S.g(r, 'OrganizationFormalName'),
      url:'https://www.waterqualitydata.us/provider/' + [S.g(r, 'ProviderName'), S.g(r, 'OrganizationIdentifier'), id].map(encodeURIComponent).join('/') + '/', inA:inArea({lat, lng})});
  }
  say(p.label + ' · Water Quality Portal: results for ' + sites.size.toLocaleString() + ' sites (large statewide pulls can take a minute or two)…');
  const R = await table('Result'), g = R.g; let n = 0;
  for(let i=1; i<R.rows.length; i++){
    const r = R.rows[i]; if(r.length < 5) continue;
    const sid = g(r, 'MonitoringLocationIdentifier'), st = sites.get(sid); if(!st || !st.inA) continue;
    const raw = g(r, 'ResultMeasureValue'), cond = g(r, 'ResultDetectionConditionText');
    out.push(xpFinish({parameter:p.label, record_type:'sample', source:'Water Quality Portal', provider:g(r, 'ProviderName'), organization:g(r, 'OrganizationFormalName') || st.org || g(r, 'OrganizationIdentifier'), site_id:sid, site_name:st.n, site_type:st.t, water_source:xpWaterSource(st.t),
      latitude:st.lat, longitude:st.lng, well_depth_ft:st.dep, reported_aquifer:st.aq, sample_date:g(r, 'ActivityStartDate'), sample_time:g(r, 'ActivityStartTime/Time'), source_parameter_name:g(r, 'CharacteristicName'),
      result_as_reported:raw || cond, censored:/not detected|below|less than|not present/i.test(cond) ? '<' : /above/i.test(cond) ? '>' : '', value:xpFirstNum(raw), unit:g(r, 'ResultMeasure/MeasureUnitCode'),
      fraction:g(r, 'ResultSampleFractionText'), speciation:g(r, 'MethodSpeciationName') || g(r, 'MethodSpecificationName'), detection_limit:g(r, 'DetectionQuantitationLimitMeasure/MeasureValue'), detection_limit_unit:g(r, 'DetectionQuantitationLimitMeasure/MeasureUnitCode'),
      method:g(r, 'ResultAnalyticalMethod/MethodName') || g(r, 'ResultAnalyticalMethod/MethodIdentifier'), result_status:g(r, 'ResultStatusIdentifier'), qualifier:g(r, 'MeasureQualifierCode'),
      sample_id:g(r, 'ActivityIdentifier'), sample_media:g(r, 'ActivityMediaName'), activity_type:g(r, 'ActivityTypeCode'), link:st.url}, p));
    n++;
  }
  return n;
}
// Lead and copper 90th percentiles for every monitoring period, from Drinking Water Watch (built in)
const PBCU = (()=>{ try{ const j = builtIn('pbcu-data'); return j && j.s ? j : null; }catch(e){ return null; } })();
function xpCcr(p, out){
  if(!DW) return 0;
  const sys = new Map();
  for(const key of ['gw', 'sw']) for(const s of DW[key]){
    let y = sys.get(s.pws); if(!y){ y = {s, n:0, lat:0, lng:0, inA:false}; sys.set(s.pws, y); }
    y.n++; y.lat += s.lat; y.lng += s.lng; if(inArea(s)) y.inA = true;
  }
  let n = 0;
  if(PBCU && /^(lead|copper)$/.test(p.k)){
    const code = p.k === 'lead' ? 'PB' : 'CU';
    for(const [pws, rs] of Object.entries(PBCU.s)){
      const y = sys.get(pws); if(!y || !y.inA) continue;
      for(const r of rs){ if(r[0] !== code) continue;
        const [, begin, end, ns, p90, unit, last, nAL] = r;
        out.push(xpFinish({parameter:p.label, record_type:'DWW lead and copper 90th percentile', source:'NMED Drinking Water Watch', provider:'NMED Drinking Water Bureau', organization:'NMED Drinking Water Bureau', site_id:pws, site_name:y.s.sys,
          site_type:'Public water system (centroid of active sources)', water_source:XP_WTYPE[y.s.prim] || '', latitude:+(y.lat/y.n).toFixed(6), longitude:+(y.lng/y.n).toFixed(6), pws_id:pws, system_name:y.s.sys, sample_media:'Water',
          sample_date:last || end, source_parameter_name:(p.k === 'lead' ? 'PB90' : 'CU90') + ' - ' + p.label.toLowerCase() + ' 90th percentile', result_as_reported:p90, unit,
          qualifier:'monitoring period ' + begin + ' to ' + end + '; ' + (ns != null ? ns + ' tap samples' : 'sample count not given') + (nAL != null ? '; ' + nAL + ' over the action level' : ''),
          link:dwwUrl(pws)}, p)); n++; }
    }
  }
  if(!CCR) return n;
  for(const [pws, byYr] of Object.entries(CCR.s)){
    const y = sys.get(pws); if(!y || !y.inA) continue;
    const base = {parameter:p.label, source:'NMED Consumer Confidence Report', provider:'NMED Drinking Water Bureau', organization:'NMED Drinking Water Bureau', site_id:pws, site_name:y.s.sys, site_type:'Public water system (centroid of active sources)',
      water_source:XP_WTYPE[y.s.prim] || '', latitude:+(y.lat/y.n).toFixed(6), longitude:+(y.lng/y.n).toFixed(6), pws_id:pws, system_name:y.s.sys, sample_media:'Water'};
    for(const [yr, rec] of Object.entries(byYr)){
      const link = ccrUrl(pws, yr);
      for(const c of (rec.c || [])){ if(!p.ccr.test(c[1])) continue;
        out.push(xpFinish(Object.assign({}, base, {record_type:'CCR highest level detected', sample_date:c[2], source_parameter_name:c[1], result_as_reported:c[3], unit:c[6], ccr_year:+yr, ccr_range_low:c[4], ccr_range_high:c[5], link}), p)); n++; }
      for(const c of (rec.lc || [])){ if(!p.ccr.test(c[0]) || (PBCU && PBCU.s[pws])) continue;   // DWW history covers these
        out.push(xpFinish(Object.assign({}, base, {record_type:'CCR lead and copper 90th percentile', sample_date:c[1], source_parameter_name:c[0] + ' (90th percentile)', result_as_reported:c[2], unit:c[3], ccr_year:+yr, link}), p)); n++; }
    }
  }
  return n;
}
/* ---- duplicate removal ----
   Checked against a statewide arsenic, uranium and copper pull:
   1. WQP quality-control blanks and spikes are not environmental samples. Field replicates are kept (activity type tells them apart).
   2. A repeated record inside one source: same site, date, time, value, fraction, method and parameter name
      (NPS and other STORET submissions often carry the same result twice under two activity IDs).
   3. Weaver API rows whose provider is WQP are copies of Water Quality Portal results (all 4,578 match a WQP site;
      4,551 have the same value). Dropped when the WQP result for that site and date is in the export.
   4. The same result in two different sources: same parameter, date, value (3 significant figures) and censoring,
      at sites no more than XP_DUP_M apart. Different sites inside one source are never merged.
   Kept row priority: Water Quality Portal, then NMBGMR, BOR, NMED DWB, then Weaver copies of WQP. Fields the kept row
   lacks (well depth, water system, fraction, method, detection limit) are filled from the removed copy. */
const XP_DUP_M = 5;
const xpFam = r => r.source === 'Weaver API' ? 'Weaver:' + r.provider : r.source;
const XP_RANK = f => f === 'Water Quality Portal' ? 0 : f === 'Weaver:NMBGMR' ? 1 : /BOR/.test(f) ? 2 : /DWB/.test(f) ? 3 : f === 'Weaver:WQP' ? 9 : 5;
const xpV3 = r => r.value_mg_L == null ? 'nv' : (+r.value_mg_L).toPrecision(3);
const xpRef = r => [r.source + (r.source === 'Weaver API' ? ' (' + r.provider + ')' : ''), r.site_id, r.sample_id].filter(Boolean).join(' | ');
const XP_FILL = ['well_depth_ft', 'pws_id', 'system_name', 'pws_source_name', 'pws_match', 'reported_aquifer', 'method', 'detection_limit', 'detection_limit_unit', 'site_type'];
function xpRemoveDuplicates(rows){
  const removed = [], gone = new Set(), removedKeep = new Map();
  const drop = (r, why, keep, code) => {
    if(gone.has(r)) return; gone.add(r); r.__why = code;
    if(keep){
      keep.also_reported_by = [keep.also_reported_by, xpRef(r)].filter(Boolean).join('; ');
      for(const c of XP_FILL) if((keep[c] == null || keep[c] === '') && r[c] != null && r[c] !== '') keep[c] = r[c];
      if(keep.fraction === 'Not reported' && r.fraction && r.fraction !== 'Not reported') keep.fraction = r.fraction;
    }
    if(keep) removedKeep.set(r, keep);
    removed.push(Object.assign({}, r, {removed_because:why, kept_record:keep ? xpRef(keep) : '', __why:code}));
  };
  // 1. quality-control activities
  for(const r of rows) if(/quality control/i.test(r.activity_type || '') && !/replicate/i.test(r.activity_type || '')) drop(r, 'Quality-control activity (' + r.activity_type + '), not an environmental sample', null, 'Quality-control activity (blank or spike), not an environmental sample');
  // 2. repeated records inside one source
  const seen = new Map();
  for(const r of rows){
    if(gone.has(r)) continue;
    const k = [xpFam(r), r.parameter, r.site_id, r.sample_date, r.sample_time || '', r.activity_type || '', xpV3(r), r.censored || '', r.fraction || '', r.method || '', r.source_parameter_name || '', r.unit || ''].join('|');
    const k0 = seen.get(k); if(k0) drop(r, 'Repeated record in ' + xpFam(r) + ': same site, date, time, value, fraction and method', k0, 'Same record repeated inside one source'); else seen.set(k, r);
  }
  // 3. Weaver API copies of WQP results
  const wqp = new Map();
  for(const r of rows) if(r.source === 'Water Quality Portal'){ const k = r.parameter + '|' + r.site_id + '|' + r.sample_date; if(!wqp.has(k)) wqp.set(k, []); wqp.get(k).push(r); }
  for(const r of rows){
    if(gone.has(r) || xpFam(r) !== 'Weaver:WQP') continue;
    const c = wqp.get(r.parameter + '|' + String(r.site_id).replace(/^WQP:/, '') + '|' + r.sample_date); if(!c) continue;
    const same = c.find(x=>x.value_mg_L != null && r.value_mg_L != null && Math.abs(x.value_mg_L - r.value_mg_L) <= 0.02*Math.max(x.value_mg_L, r.value_mg_L))
      || ((r.censored === '<' || r.value_mg_L == null) && c.find(x=>x.censored === '<'));
    if(!same) continue;
    let keep = same; while(keep && gone.has(keep)) keep = removedKeep.get(keep);   // the WQP row may itself be a repeat; point to the row that was kept
    if(keep) drop(r, 'Weaver API copy of a Water Quality Portal result (same site and date)', keep, 'Weaver API copy of a Water Quality Portal result');
    else drop(r, 'Weaver API copy of a Water Quality Portal ' + (same.__why || 'record') + ' that was removed', null, 'Weaver API copy of a Water Quality Portal result');
  }
  // 4. the same result in two sources at nearly the same place
  const idx = new Map();
  for(const r of rows){ if(gone.has(r) || !r.sample_date || r.value_mg_L == null) continue; const k = [r.parameter, r.sample_date, xpV3(r), r.censored || ''].join('|'); if(!idx.has(k)) idx.set(k, []); idx.get(k).push(r); }
  for(const g of idx.values()){
    if(g.length < 2) continue;
    g.sort((a, b)=>XP_RANK(xpFam(a)) - XP_RANK(xpFam(b)));
    for(let i=0; i<g.length; i++){
      const a = g[i]; if(gone.has(a)) continue;
      for(let j=i+1; j<g.length; j++){
        const b = g[j]; if(gone.has(b) || xpFam(a) === xpFam(b)) continue;
        const d = Math.hypot((a.latitude - b.latitude)*111000, (a.longitude - b.longitude)*111000*Math.cos(a.latitude*Math.PI/180));
        if(d <= XP_DUP_M) drop(b, 'Same result in ' + xpFam(a) + ': same date and value, sites ' + d.toFixed(0) + ' m apart', a, 'Same result in two sources (same date and value, sites up to ' + XP_DUP_M + ' m apart)');
      }
    }
  }
  return {kept:rows.filter(r=>!gone.has(r)), removed};
}
const xpMedian = v => { if(!v.length) return null; const s = v.slice().sort((a, b)=>a - b), h = s.length >> 1; return s.length % 2 ? s[h] : (s[h-1] + s[h]) / 2; };
function xpStats(rows){
  const v = rows.filter(r=>r.value_mg_L != null).map(r=>r.value_mg_L), d = rows.map(r=>r.sample_date).filter(Boolean).sort();
  return {n:rows.length, sites:new Set(rows.map(r=>r.source + '|' + r.site_id)).size, cens:rows.filter(r=>r.censored === '<').length, first:d[0] || '', last:d[d.length-1] || '',
    min:v.length ? sig(Math.min(...v.slice(0, 1e5)), 4) : null, med:sig(xpMedian(v), 4), max:v.length ? sig(v.reduce((a, b)=>a > b ? a : b, -Infinity), 4) : null, over:rows.filter(r=>r.exceeds_standard === 'yes').length, std:rows[0] && rows[0].standard_mg_L};
}
function xpGroup(rows, keyFn){ const m = new Map(); for(const r of rows){ const k = keyFn(r); let a = m.get(k); if(!a){ a = []; m.set(k, a); } a.push(r); } return m; }
function xpSummarySheet(samples){
  const out = [], H = ['rows', 'sites', 'censored (<)', 'first date', 'last date', 'min mg/L', 'median mg/L', 'max mg/L', 'standard mg/L', 'results over standard'];
  const line = s => [s.n, s.sites, s.cens, s.first, s.last, s.min, s.med, s.max, s.std, s.std != null ? s.over : null];
  const block = (title, col, keyFn) => {
    out.push([title]); out.push(['parameter', col, ...H]);
    const g = xpGroup(samples, r=>r.parameter + '\u0001' + (keyFn(r) || '(none)'));
    for(const k of [...g.keys()].sort()){ const [a, b] = k.split('\u0001'); out.push([a, b, ...line(xpStats(g.get(k)))]); }
    out.push([]);
  };
  out.push(['Statistics use value_mg_L. Censored results count at their limit. CCR report values and non-water units are on their own sheets and are not included here.']); out.push([]);
  block('By source', 'source', r=>r.source + (r.source === 'Weaver API' && r.provider ? ' · ' + r.provider : ''));
  block('By water source', 'water source', r=>r.water_source);
  block('By county', 'county', r=>r.county);
  block('By aquifer (location match)', 'aquifer', r=>r.aquifer);
  return out;
}
const XP_SITE_COLS = ['parameter', 'source', 'provider', 'site_id', 'site_name', 'site_type', 'water_source', 'latitude', 'longitude', 'county', 'huc8', 'huc8_name', 'aquifer', 'well_depth_ft', 'pws_id', 'system_name',
  'results', 'censored', 'first_date', 'last_date', 'min_mg_L', 'median_mg_L', 'max_mg_L', 'latest_mg_L', 'standard_mg_L', 'results_over_standard', 'link'];
function xpSiteSheet(samples){
  const g = xpGroup(samples, r=>r.parameter + '|' + r.source + '|' + r.site_id), out = [XP_SITE_COLS];
  for(const rows of g.values()){
    const r = rows[0], s = xpStats(rows), dated = rows.filter(x=>x.sample_date && x.value_mg_L != null).sort((a, b)=>a.sample_date < b.sample_date ? -1 : 1), last = dated[dated.length-1];
    const o = Object.assign({}, r, {results:s.n, censored:s.cens, first_date:s.first, last_date:s.last, min_mg_L:s.min, median_mg_L:s.med, max_mg_L:s.max, latest_mg_L:last ? last.value_mg_L : null, results_over_standard:s.std != null ? s.over : null});
    out.push(XP_SITE_COLS.map(c=>o[c] == null ? '' : o[c]));
  }
  return out;
}

/* ---- minimal .xlsx writer (inline strings, deflate when the browser supports it) ---- */
const XLSX_CRC = (()=>{ const t = new Uint32Array(256); for(let n=0; n<256; n++){ let c = n; for(let k=0; k<8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(u8){ let c = 0xFFFFFFFF; for(let i=0; i<u8.length; i++) c = XLSX_CRC[(c ^ u8[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
async function zipBlob(files){
  const enc = new TextEncoder(), parts = [], central = []; let off = 0;
  for(const f of files){
    const name = enc.encode(f.name), data = f.data, crc = crc32(data); let body = data, method = 0;
    if(typeof CompressionStream !== 'undefined'){ try{ body = new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer()); method = 8; }catch(e){ body = data; method = 0; } }
    const lh = new DataView(new ArrayBuffer(30)); lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(8, method, true); lh.setUint16(10, 0, true); lh.setUint16(12, 0x21, true);
    lh.setUint32(14, crc, true); lh.setUint32(18, body.length, true); lh.setUint32(22, data.length, true); lh.setUint16(26, name.length, true);
    parts.push(lh.buffer, name, body);
    const ch = new DataView(new ArrayBuffer(46)); ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(10, method, true); ch.setUint16(14, 0x21, true);
    ch.setUint32(16, crc, true); ch.setUint32(20, body.length, true); ch.setUint32(24, data.length, true); ch.setUint16(28, name.length, true); ch.setUint32(42, off, true);
    central.push(ch.buffer, name); off += 30 + name.length + body.length;
  }
  const csize = central.reduce((t, b)=>t + (b.byteLength), 0), e = new DataView(new ArrayBuffer(22));
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true); e.setUint32(12, csize, true); e.setUint32(16, off, true);
  return new Blob([...parts, ...central, e.buffer], {type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});
}
const xlsxCol = i => { let s = ''; for(i++; i>0; i = Math.floor((i-1)/26)) s = String.fromCharCode(65 + (i-1) % 26) + s; return s; };
const xlsxEsc = s => String(s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// sheet: {name, rows:[[...]], header:true (bold first row, frozen, filter), widths:[...]}
function xlsxSheetXml(sh){
  const rows = sh.rows, nc = rows.reduce((m, r)=>Math.max(m, r.length), 0), buf = [];
  buf.push('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">');
  buf.push('<sheetViews><sheetView workbookViewId="0">' + (sh.header ? '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>' : '') + '</sheetView></sheetViews>');
  buf.push('<cols>' + Array.from({length:Math.max(nc, 1)}, (_, i)=>`<col min="${i+1}" max="${i+1}" width="${(sh.widths && sh.widths[i]) || 16}" customWidth="1"/>`).join('') + '</cols><sheetData>');
  let chunk = [];
  for(let i=0; i<rows.length; i++){
    const r = rows[i], n = i + 1, bold = (sh.header && i === 0) || (sh.boldRows && sh.boldRows.has(i)); let s = '<row r="' + n + '">';
    for(let j=0; j<r.length; j++){
      const v = r[j]; if(v == null || v === '') continue;
      const ref = xlsxCol(j) + n, st = bold ? ' s="1"' : '';
      s += typeof v === 'number' && isFinite(v) ? `<c r="${ref}"${st}><v>${v}</v></c>` : `<c r="${ref}"${st} t="inlineStr"><is><t xml:space="preserve">${xlsxEsc(v)}</t></is></c>`;
    }
    chunk.push(s + '</row>');
    if(chunk.length >= 5000){ buf.push(chunk.join('')); chunk = []; }
  }
  buf.push(chunk.join('') + '</sheetData>');
  if(sh.header && rows.length > 1 && nc) buf.push(`<autoFilter ref="A1:${xlsxCol(nc-1)}${rows.length}"/>`);
  buf.push('</worksheet>');
  return new TextEncoder().encode(buf.join(''));
}
async function xlsxBlob(sheets){
  const enc = new TextEncoder(), X = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  const files = [
    {name:'[Content_Types].xml', data:enc.encode(X + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' + sheets.map((s, i)=>`<Override PartName="/xl/worksheets/sheet${i+1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') + '</Types>')},
    {name:'_rels/.rels', data:enc.encode(X + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>')},
    {name:'xl/workbook.xml', data:enc.encode(X + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' + sheets.map((s, i)=>`<sheet name="${xlsxEsc(s.name).replace(/"/g, '&quot;')}" sheetId="${i+1}" r:id="rId${i+1}"/>`).join('') + '</sheets></workbook>')},
    {name:'xl/_rels/workbook.xml.rels', data:enc.encode(X + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + sheets.map((s, i)=>`<Relationship Id="rId${i+1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i+1}.xml"/>`).join('') + `<Relationship Id="rId${sheets.length+1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`)},
    {name:'xl/styles.xml', data:enc.encode(X + '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>')}
  ];
  sheets.forEach((s, i)=>files.push({name:`xl/worksheets/sheet${i+1}.xml`, data:xlsxSheetXml(s)}));
  return zipBlob(files);
}

/* ---- the Export samples tab ---- */
$('xp-params').innerHTML = XP_PARAMS.map(p=>`<label class="xp-p"><input type="checkbox" value="${p.k}"><span>${esc(p.label)}</span><small>${[p.weaver ? 'Weaver' : '', 'WQP', p.ccr ? 'CCR' : ''].filter(Boolean).join(' · ')}</small></label>`).join('');
const xpChosen = () => [...document.querySelectorAll('#xp-params input:checked')].map(i=>XP_BY.get(i.value));
function xpAvail(){
  const ps = xpChosen();
  $('xp-avail').textContent = ps.length ? ps.length + ' selected: ' + ps.map(p=>p.label).join(', ') + (ps.some(p=>!p.weaver) ? '. The Weaver API has no data for ' + ps.filter(p=>!p.weaver).map(p=>p.label.toLowerCase()).join(', ') + '.' : '') : 'Tick one or more parameters.';
  $('xp-go').disabled = xpBusy || !ps.length;
  $('xp-area').textContent = state.area ? state.area.name : 'Statewide (no area selected). Pick an area in the Area tab to limit the export; statewide pulls of major ions are very large.';
}
let xpBusy = false;
$('xp-params').addEventListener('change', xpAvail);
$('xp-none').onclick = ()=>{ document.querySelectorAll('#xp-params input').forEach(i=>{ i.checked = false; }); xpAvail(); };
document.querySelector('#rightbar .tab-btn[data-tab="export"]').addEventListener('click', xpAvail);
xpAvail();

$('xp-go').onclick = async ()=>{
  if(xpBusy) return;
  const ps = xpChosen(); if(!ps.length) return;
  const useW = $('xp-weaver').checked, useQ = $('xp-wqp').checked, useC = $('xp-ccr').checked;
  if(!useW && !useQ && !useC){ toast('Pick at least one source.'); return; }
  xpBusy = true; $('xp-go').disabled = true;
  const say = t => { $('xp-status').textContent = t; };
  const all = [], log = [];
  try{
    if((useW || useC) && !DW){ say('Loading public water system sources from NMED…'); try{ await dwEnsure(); }catch(e){ log.push(['NMED source list', 'failed: ' + e.message + ' (system names and CCR rows are missing)']); } }
    for(const p of ps){
      const jobs = [['Weaver API', useW && p.weaver, ()=>xpWeaver(p, all, say)], ['Water Quality Portal', useQ, ()=>xpWqp(p, all, say)], ['Consumer Confidence Reports', useC && p.ccr, async ()=>xpCcr(p, all)]];
      for(const [name, on, fn] of jobs){
        if(!on){ if((name === 'Weaver API' && useW) || (name !== 'Water Quality Portal' && useC && name !== 'Weaver API')) log.push([p.label + ' · ' + name, 'no data for this parameter']); continue; }
        try{ const n = await fn(); log.push([p.label + ' · ' + name, n]); }catch(e){ log.push([p.label + ' · ' + name, 'failed: ' + e.message]); }
      }
    }
    say('Adding county, watershed and aquifer…');
    await new Promise(r=>setTimeout(r, 30));
    for(const r of all){ const L_ = xpLocate(r.latitude, r.longitude); r.county = L_.county; r.huc8 = L_.huc8; r.huc8_name = L_.huc8_name; r.aquifer = L_.aquifer; }
    say('Removing duplicates…'); await new Promise(r=>setTimeout(r, 30));
    const ccr = all.filter(r=>r.record_type !== 'sample'), solid = all.filter(r=>r.record_type === 'sample' && XP_SOLID.test(r.unit || ''));
    const dd = xpRemoveDuplicates(all.filter(r=>r.record_type === 'sample' && !XP_SOLID.test(r.unit || ''))), samples = dd.kept, removed = dd.removed, nDup = removed.length;
    const whyCount = {}; for(const r of removed) whyCount[r.__why] = (whyCount[r.__why] || 0) + 1;
    const byDate = (a, b)=>a.parameter.localeCompare(b.parameter) || a.source.localeCompare(b.source) || String(a.site_id).localeCompare(String(b.site_id)) || String(a.sample_date || a.sample_year || '').localeCompare(String(b.sample_date || b.sample_year || ''));
    samples.sort(byDate); ccr.sort(byDate); solid.sort(byDate);
    const toRows = rs => [XP_COLS, ...rs.map(o=>XP_COLS.map(c=>o[c] == null ? '' : o[c]))];
    const area = state.area ? state.area.name.replace(/[^\w]+/g, '_').replace(/^_|_$/g, '') : 'NM_statewide';
    const stem = (ps.length === 1 ? ps[0].k : ps.length <= 3 ? ps.map(p=>p.k).join('_') : ps.length + '_parameters') + '_samples_' + area + '_' + new Date().toISOString().slice(0, 10);
    const counts = `${samples.length.toLocaleString()} samples · ${ccr.length.toLocaleString()} PWS summary rows` + (solid.length ? ` · ${solid.length.toLocaleString()} non-water results` : '') + (nDup ? ` · ${nDup.toLocaleString()} duplicates removed` : '');
    const failed = log.filter(l=>/^failed/.test(String(l[1])));
    if(!all.length){ say('Nothing to save. ' + log.map(l=>l[0] + ': ' + l[1]).join(' · ')); }
    else if($('xp-format').value === 'csv' || samples.length > 1000000){
      downloadCsv(XP_COLS, [...samples, ...ccr, ...solid].map(o=>XP_COLS.map(c=>o[c] == null ? '' : o[c])), stem + '.csv');
      say('Saved ' + stem + '.csv · ' + counts + (failed.length ? ' · FAILED: ' + failed.map(l=>l[0]).join(', ') : ''));
    } else {
      say('Building the workbook…'); await new Promise(r=>setTimeout(r, 30));
      const readme = [['Groundwater Chemistry Explorer: sample export'], [],
        ['Made', new Date().toLocaleString()], ['Area', state.area ? state.area.name : 'New Mexico, statewide'], ['Parameters', ps.map(p=>p.label).join(', ')],
        ['Water Quality Portal options', [$('xp-wqp-water').checked ? 'water samples only' : 'all sample media', $('xp-wqp-gw').checked ? 'wells and springs only' : 'all site types'].join('; ')], [],
        ['What was pulled'], ['parameter · source', 'rows'], ...log, [],
        ['Sheets'],
        ['Summary', 'Counts, date range, median and maximum by source, water source, county and aquifer'],
        ['Site summary', 'One row per site and parameter: number of results, first and last date, minimum, median, maximum, latest, results over the standard'],
        ['Samples', 'One row per laboratory result'],
        ['PWS summaries', 'Public water system summaries, not individual samples. Lead and copper: the 90th percentile of tap samples for every monitoring period on record in Drinking Water Watch, with the number of samples and how many were over the action level. Other parameters: the highest level detected and its range from 2024 and 2025 Consumer Confidence Reports (community systems)'],
        ['Other matrices', 'Results reported per mass (mg/kg and similar): sediment, tissue and other non-water samples'],
        ['Removed duplicates', 'Rows taken out of Samples, with removed_because and kept_record'], [],
        ['Things to know'],
        ['Sources', 'Weaver API = NM Unified Water Data API (mostly NMED Drinking Water Bureau samples, plus NMBGMR, BOR and others). Water Quality Portal = USGS and EPA results. CCR = NMED Drinking Water Watch reports.'],
        ['Public water systems', 'Weaver API drinking-water sites are matched to an NMED source only when the source is at the same location (within ' + XP_DW_MATCH_M + ' m; nearly all are within 2 m, the rounding between the two services) and belongs to a single system. pws_match says how each site was matched or why it was not.'],
        ['Censored results', 'censored "<" means below the limit; value then holds the limit. Some WQP results have no value and no limit; those have a blank value.'],
        ['Units', 'value and unit are as reported. value_mg_L converts mg/L, µg/L, ppm, ppb and ng/L. Uranium in pCi/L is converted at 0.67 pCi per µg. Nitrate as NO3 is converted to as N.'],
        ['Fraction', 'Dissolved and total results are both included. The Weaver API and CCRs do not report a fraction.'],
        ['Standards', 'EPA drinking water limits. Lead and copper use the action level; TDS, sulfate, chloride, iron, manganese and zinc use the secondary limit. Results from streams and other non-drinking water are compared too, for reference only.'],
        ['Duplicates', 'Removed, and listed on the Removed duplicates sheet with the reason and the row kept instead. Rules, in order: (1) WQP quality-control blanks and spikes (field replicates are kept and labeled in activity_type); (2) the same record repeated inside one source (same site, date, time, value, fraction and method); (3) Weaver API copies of WQP results when the WQP result is in the export; (4) the same parameter, date, value and censoring in two different sources at sites no more than ' + XP_DUP_M + ' m apart. Different sites inside one source are never merged. The kept row is the Water Quality Portal one when there is one, then NMBGMR, BOR, NMED DWB. also_reported_by on the kept row lists the removed copies, and missing fields are filled from them.'],
        ['Duplicates removed', nDup], ...Object.entries(whyCount).map(([k, v])=>['  ' + k, v]),
        ['Aquifer', 'From the site location inside NMBGMR aquifer polygons. Overlapping aquifers are all listed; it does not say which one a well is completed in.'],
        ['Not included', 'Individual lead and copper tap samples. They measure household plumbing rather than the water source, so the export uses their 90th percentile per monitoring period instead.'], [],
        ['Columns'], ...XP_COLS.map(c=>[c, XP_COL_HELP[c] || ''])];
      const bold = new Set([0]); readme.forEach((r, i)=>{ if(r.length === 1 && i) bold.add(i); });
      const summ = xpSummarySheet(samples), sb = new Set(); summ.forEach((r, i)=>{ if(r.length === 1 || r[0] === 'parameter') sb.add(i); });
      const w = XP_COLS.map(c=>/site_name|system_name|organization|aquifer|method|link|result_as_reported|conversion_note|exceeds/.test(c) ? 30 : /^(source|record_type|site_type|site_id|sample_id|source_parameter_name|pws_source_name|huc8_name)$/.test(c) ? 24 : 14);
      const sheets = [{name:'Read me', rows:readme, widths:[30, 110], boldRows:bold}, {name:'Summary', rows:summ, widths:[24, 44, 10, 10, 12, 12, 12, 12, 12, 12, 14, 20], boldRows:sb},
        {name:'Site summary', rows:xpSiteSheet(samples), header:true, widths:XP_SITE_COLS.map(c=>/name|aquifer|link/.test(c) ? 30 : 15)}, {name:'Samples', rows:toRows(samples), header:true, widths:w}, {name:'PWS summaries', rows:toRows(ccr), header:true, widths:w}];
      if(solid.length) sheets.push({name:'Other matrices', rows:toRows(solid), header:true, widths:w});
      if(removed.length){ const RC = ['removed_because', 'kept_record', ...XP_COLS.filter(c=>c !== 'also_reported_by')]; removed.sort(byDate); sheets.push({name:'Removed duplicates', rows:[RC, ...removed.map(o=>RC.map(c=>o[c] == null ? '' : o[c]))], header:true, widths:RC.map((c, i)=>i < 2 ? 50 : 16)}); }
      downloadBlob(await xlsxBlob(sheets), stem + '.xlsx');
      say('Saved ' + stem + '.xlsx · ' + counts + (failed.length ? ' · FAILED: ' + failed.map(l=>l[0]).join(', ') : ''));
    }
  }catch(e){ say('Export failed: ' + e.message); }
  xpBusy = false; xpAvail();
};
for(const id of [...pubOn]){ const L_ = PUB_BY_ID.get(id); if(L_) pubLoad(L_).catch(()=>{}); else pubOn.delete(id); }

/* ==================================================================== */
/* 15. Update cycle                                                     */
/* ==================================================================== */
function update(){
  recompute();
  const a = AN[state.analyte], s = stdOf();
  $('conc-unit').textContent = '(' + a.sym + ', ' + UNIT + ')';
  $('std-hint').textContent = s != null ? a.name + ': ' + fmt(s) + ' ' + UNIT + (state.std === 'epa' ? ' (' + a.epa.k + ')' : ' (NM groundwater standard)') : a.name + ' has no drinking-water standard. The map uses statewide quintiles.';
  document.querySelectorAll('#exceed-seg button').forEach(b=>{ b.disabled = s == null && b.dataset.ex !== 'all'; });
  if(s == null && state.exceed !== 'all'){ state.exceed = 'all'; document.querySelectorAll('#exceed-seg button').forEach(b=>b.classList.toggle('active', b.dataset.ex === 'all')); recompute(); }
  $('wells-on').checked = wellsShown();
  $('count-pill').innerHTML = wellsShown() ? '<b>' + VIS.length.toLocaleString() + '</b> wells shown' : 'wells hidden';
  $('area-n').textContent = SCOPE.length.toLocaleString() + ' wells';
  $('area-name').textContent = state.area ? state.area.name : 'Statewide (no area selected)';
  wqpRender(); wqpRedraw();
  wqpBtnLabel();
  if(pubOn.size){ pubAreaSync(); pubRender(); renderPubLegend(); }
  try{ xpAvail(); }catch(e){}
  renderAnalyteList(); redrawPoints(); if(DW && $('dw-color-ccr').checked) dwRedraw(); renderLegend(); renderDrawer(); renderSystems();
  $('dw-color-lbl').textContent = state.noAnalyte ? 'Color sources by their system\'s CCR result (pick an analyte first)' : 'Color sources by their system\'s CCR ' + AN[state.analyte].name.toLowerCase();
}

// restore saved WQP pulls before the first draw
try{
  const stored = await idbGet(WQP_STORE);
  if(stored && Array.isArray(stored.pulls)){ WQP_PULLS = stored.pulls; for(const p of WQP_PULLS) wqpApply(p); }
}catch(e){ console.warn('Saved WQP pulls could not be restored', e); }
renderWqpPulls();

// live pill
const lp = $('live-pill');
const when = new Date(DATA.t).toLocaleString([], {month:'short', day:'numeric', hour:'numeric', minute:'2-digit'});
const wqpNote = WQP_PULLS.length ? ' + WQP' : '';
if(fromCache === 'stale'){ lp.className = 'pill live off'; lp.innerHTML = 'API unreachable · saved copy' + wqpNote; lp.title = 'Could not reach the API, so the copy saved in this browser on ' + when + ' is shown. Click to retry.'; }
else if((DATA.failed||[]).length){ lp.className = 'pill live off'; lp.innerHTML = 'Missing: ' + esc(DATA.failed.join(', ')); lp.title = 'These analytes failed to load. Click to retry.'; }
else { lp.className = 'pill live ok'; lp.innerHTML = 'API data · <b>' + esc(when) + '</b>' + wqpNote; lp.title = (fromCache ? 'Saved copy from ' : 'Downloaded ') + when + ' · ' + WELLS.length.toLocaleString() + ' wells across ' + ANALYTES.length + ' analytes' + (WQP_PULLS.length ? ', including ' + WQP_PULLS.length + ' WQP pull' + (WQP_PULLS.length > 1 ? 's' : '') : '') + '. Click to re-download from the API.'; }
lp.addEventListener('click', async ()=>{ await idbDel(CACHE_KEY); location.reload(); });

renderSources();
$('colorby-select').value = state.colorBy;
update();
bootUI.done();
setTimeout(()=>map.invalidateSize(), 50);
window.WQ = {state, WELLS, ANALYTES, update, setAnalyte, setArea, openWell, wqpLoad, dwEnsure, openSource:k=>{ const s = DW_BY_KEY.get(k); if(s) openDwPopup(s, [s]); }, sources:()=>DW, wqpSite:id=>{ const q = wqp.byId && wqp.byId.get(id); if(q) openWqpPopup(q, [q]); return !!q; }};   // hook for embedding in other tools
})().catch(e=>{ console.error(e); const m = document.getElementById('boot-msg'); if(m){ m.textContent = 'Could not start'; document.getElementById('boot-detail').textContent = String(e && e.message || e); } });
