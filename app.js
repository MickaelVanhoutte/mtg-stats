"use strict";

/* =================== CONFIG =================== */
// Cloudflare Worker URL for shared cloud sync. Leave '' for local-only mode.
const CLOUD_URL = 'https://mythic-ledger.mika-ledger.workers.dev';
const API = CLOUD_URL.replace(/\/+$/,'');

/* =================== SESSION =================== */
let AUTH = localStorage.getItem('mtg_session') || '';
let CURRENT_USER = null;                                   // { id, handle, displayName, groupIds }
let CURRENT_GROUP = localStorage.getItem('mtg_group') || 'default';

async function api(path, opts={}){
  const headers = { 'content-type':'application/json' };
  if(AUTH) headers['authorization'] = 'Bearer ' + AUTH;
  const r = await fetch(API + path, {
    method: opts.method || 'GET',
    headers: { ...headers, ...(opts.headers||{}) },
    body: opts.body!=null ? JSON.stringify(opts.body) : undefined,
    cache: 'no-store',
  });
  let data = null; try { data = await r.json(); } catch(e){}
  if(!r.ok) throw new Error((data && data.error) || ('HTTP '+r.status));
  return data;
}

/* =================== STORE =================== */
let GAMES = [];
function gamesKey(){ return 'mtg_games:' + (CURRENT_GROUP||'default'); }
function uid(){ return 'g_' + Math.random().toString(36).slice(2,10) + Date.now().toString(36).slice(-4); }
function load(){
  try { GAMES = JSON.parse(localStorage.getItem(gamesKey())) || []; } catch(e){ GAMES = []; }
  if(!GAMES.length && (CURRENT_GROUP||'default')==='default'){       // migrate legacy single-ledger cache
    try { const legacy = JSON.parse(localStorage.getItem('mtg_games')); if(Array.isArray(legacy)&&legacy.length){ GAMES = legacy; save(); } } catch(e){}
  }
}
function save(){ localStorage.setItem(gamesKey(), JSON.stringify(GAMES)); }

function toast(msg, isErr){
  const t = document.getElementById('toast');
  t.textContent = msg; t.className = 'toast show' + (isErr?' err':'');
  clearTimeout(t._t); t._t = setTimeout(()=> t.className = 'toast', 2600);
}

/* =================== NORMALIZE / IMPORT =================== */
// Accept array of games, or { games:[...] }, and coerce loose shapes.
function normalizeImport(raw){
  let arr = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.games) ? raw.games : null);
  if (!arr) throw new Error("Expected an array of games or an object with a 'games' array.");
  return arr.map(g => {
    const players = (g.players||g.seats||[]).map(p => ({
      name: String(p.name||p.player||p.playerName||'Unknown').trim(),
      deck: String(p.deck||p.deckName||p.commander||'—').trim(),
      colors: String(p.colors||'').toUpperCase().replace(/[^WUBRG]/g,''),
      won: !!(p.won ?? p.win ?? p.winner ?? p.isWinner),
      started: typeof p.started==='boolean' ? p.started : undefined,
      diedFirst: typeof p.diedFirst==='boolean' ? p.diedFirst : undefined,
      kills: typeof p.kills==='number' ? p.kills : undefined,
      deckId: p.deckId || undefined
    })).filter(p=>p.name);
    const pc = Number(g.playerCount || g.pod || players.length) || players.length;
    return {
      id: g.id || uid(),
      date: (g.date || g.playedAt || g.createdAt || '').slice(0,10) || todayStr(),
      playerCount: pc,
      players,
      enriched: !!g.enriched
    };
  }).filter(g => g.players.length);
}

// Dedup on id only. Every game gets a stable id (cloud mt_*, uid() on manual/
// import, sample_*), so id-only is safe. gameKey-based dedup was too coarse —
// back-to-back games with the same date+seating+decks (a normal Commander
// rematch night) produced identical keys and got silently dropped.
function mergeGames(incoming){
  const byId = new Map(GAMES.map(g=>[g.id,g]));
  let added = 0;
  incoming.forEach(g => {
    if (!g.id) return;
    const prev = byId.get(g.id);
    if (!prev) { GAMES.push(g); byId.set(g.id, g); added++; }
    else if (g.enriched && !prev.enriched) {           // upgrade stale local copy with enriched cloud data
      Object.assign(prev, g);
    }
  });
  save();
  return added;
}

/* =================== CLOUD =================== */
async function pullCloud(silent){
  if(!API){ if(!silent) toast('No cloud configured — set CLOUD_URL in the file.', true); return; }
  try {
    const path = AUTH ? '/games?group=' + encodeURIComponent(CURRENT_GROUP) : '/ledger';
    const data = await api(path);
    const added = mergeGames(normalizeImport(data));
    renderAll();
    if(!silent) toast(added ? `Cloud: ${added} new game${added>1?'s':''}.` : 'Cloud: already up to date.');
  } catch(e){ if(!silent) toast('Cloud pull failed: '+e.message, true); }
}

// push finished game record(s) to the current group's ledger
async function pushCloud(records){
  if(!AUTH){ return; }
  await api('/games?group=' + encodeURIComponent(CURRENT_GROUP), { method:'POST', body:{ games: records } });
}

/* =================== FILTERS =================== */
const F = { pc: 'all', player: '', from: '', to: '' };

function filtered(){
  return GAMES.filter(g => {
    if (F.pc !== 'all' && String(g.playerCount) !== F.pc) return false;
    if (F.from && g.date < F.from) return false;
    if (F.to && g.date > F.to) return false;
    if (F.player && !g.players.some(p=>p.name===F.player)) return false;
    return true;
  });
}

/* =================== HELPERS =================== */
function todayStr(){ const d=new Date(); return d.toISOString().slice(0,10); }
function pct(n,d){ return d? Math.round(n/d*1000)/10 : 0; }
function esc(s){ return String(s).replace(/[&<>"]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
function pctTag(pc){ const c = pc<=2?'2':pc===3?'3':'4'; const lbl = pc===2?'1v1':pc+'p'; return `<span class="pcount-tag pcount-${c}">${lbl}</span>`; }

// bucket a game's playerCount into 2 / 3 / 4 / other
function podKey(pc){ return (pc===2||pc===3||pc===4) ? String(pc) : 'other'; }

// pod-size win-rate chips from a {2:{g,w},3:{g,w},4:{g,w}} map
function podChips(pods){
  const order = [['2','1v1'],['3','3p'],['4','4p']];
  return `<span class="podchips">` + order.map(([k,lbl])=>{
    const b = pods[k];
    if(!b || !b.g) return `<span class="podchip pc${k} off">${lbl} –</span>`;
    return `<span class="podchip pc${k}">${lbl} ${pct(b.w,b.g)}%</span>`;
  }).join('') + `</span>`;
}

// chronological win/loss series -> { streak (signed), pips (html) }
function streakForm(series){
  const arr = series.slice().sort((a,b)=>a.date.localeCompare(b.date));
  let streak = 0;
  if(arr.length){
    const last = !!arr[arr.length-1].won;
    for(let i=arr.length-1; i>=0; i--){
      if(!!arr[i].won === last) streak++; else break;
    }
    if(!last) streak = -streak;
  }
  const pips = arr.slice(-5).map(x=>`<span class="pip ${x.won?'w':'l'}"></span>`).join('');
  return { streak, pips };
}
function streakBadge(s){
  if(!s) return `<span class="streak none">–</span>`;
  return `<span class="streak ${s>0?'win':'loss'}">${s>0?'+':''}${s}</span>`;
}
function formCell(sf){
  return `<span class="form">${streakBadge(sf.streak)}<span class="pips">${sf.pips}</span></span>`;
}

// deck name -> WUBRG color string, learned from the data
const DECK_COLORS = {};
function learnDeckColors(){
  GAMES.forEach(g=>g.players.forEach(p=>{ if(p.colors) DECK_COLORS[resolveDeck(p.deck)]=p.colors; }));
}

/* =================== DECK REGISTRY / ALIASES =================== */
// Group decks (imported/manual) let us unify free-text historical deck names
// with a canonical imported deck via aliases, and attach commander art.
let GROUP_DECKS = [];
const DECK_ALIAS = {};        // lower(name|alias) -> canonical deck name
const DECK_IMAGE = {};        // canonical deck name -> commander art URL
function indexDecks(){
  for(const k in DECK_ALIAS) delete DECK_ALIAS[k];
  GROUP_DECKS.forEach(d=>{
    const canon = d.name;
    DECK_ALIAS[canon.toLowerCase()] = canon;
    (d.aliases||[]).forEach(a=> DECK_ALIAS[String(a).toLowerCase()] = canon);
    if(d.colors) DECK_COLORS[canon] = d.colors;
    if(d.commanderImage) DECK_IMAGE[canon] = d.commanderImage;
  });
}
function resolveDeck(name){ return DECK_ALIAS[String(name||'').toLowerCase()] || name; }
async function fetchGroupDecks(){
  if(!AUTH){ GROUP_DECKS = []; indexDecks(); return; }
  try { const r = await api('/groups/'+encodeURIComponent(CURRENT_GROUP)+'/decks'); GROUP_DECKS = r.decks||[]; }
  catch(e){ GROUP_DECKS = []; }
  indexDecks();
}
const PIP = { W:'var(--w)', U:'var(--u)', B:'var(--b)', R:'var(--r)', G:'var(--g)' };
function manaDot(deck){
  const cols = DECK_COLORS[deck];
  if(cols){ // real WUBRG identity -> pip cluster
    return '<span class="mana" style="display:inline-flex;gap:2px">'+[...cols].map(c=>
      `<span class="mana-dot" style="background:${PIP[c]||'#999'}"></span>`).join('')+'</span>';
  }
  // fallback: hash deck name to a stable WUBRG-ish color
  const palette = ['var(--w)','var(--u)','var(--b)','var(--r)','var(--g)','var(--accent)'];
  let h=0; for(const ch of deck) h=(h*31+ch.charCodeAt(0))>>>0;
  return `<span class="mana"><span class="mana-dot" style="background:${palette[h%palette.length]}"></span></span>`;
}

/* =================== RIBBON =================== */
function renderRibbon(){
  const f = filtered();
  const decks = new Set(), players = new Set();
  f.forEach(g=>g.players.forEach(p=>{ decks.add(p.deck); players.add(p.name); }));
  const cells = [
    [f.length, 'Games'],
    [players.size, 'Players'],
    [decks.size, 'Decks'],
    [GAMES.length, 'Total logged'],
  ];
  document.getElementById('ribbon').innerHTML = cells.map(c=>
    `<div class="cell"><div class="num">${c[0]}</div><div class="lbl">${c[1]}</div></div>`).join('');
  const tg = document.getElementById('totalGames'); if(tg) tg.textContent = GAMES.length;
}

/* =================== DECKS VIEW =================== */
let deckSort = { col:'wr', dir:-1 };
function renderDecks(){
  const f = filtered();
  const m = {}; // deck|player -> stats
  f.forEach(g=>g.players.forEach(p=>{
    const rd = resolveDeck(p.deck);
    const k = rd+' '+p.name;
    const e = (m[k] = m[k] || { deck:rd, name:p.name, games:0, wins:0, pods:{}, series:[] });
    e.games++; if(p.won) e.wins++;
    const pk = podKey(g.playerCount);
    const b = e.pods[pk] = e.pods[pk] || {g:0,w:0}; b.g++; if(p.won) b.w++;
    e.series.push({ date:g.date, won:p.won?1:0 });
  }));
  let rows = Object.values(m).map(r=>{
    const sf = streakForm(r.series);
    return {...r, wr: pct(r.wins,r.games), streak: sf.streak, sf };
  });
  rows.sort((a,b)=>{
    const c = deckSort.col, av=a[c], bv=b[c];
    if (typeof av==='string') return deckSort.dir * av.localeCompare(bv);
    return deckSort.dir * (av-bv);
  });
  const el = document.getElementById('decksView');
  if(!rows.length){ el.innerHTML = emptyState(); return; }
  const arrow = c => deckSort.col===c ? `<span class="arrow">${deckSort.dir<0?'▾':'▴'}</span>`:'';

  const table = `<div class="tbl-wrap"><table>
    <thead><tr>
      <th class="sortable" data-sort="deck">Deck ${arrow('deck')}</th>
      <th class="sortable" data-sort="name">Pilot ${arrow('name')}</th>
      <th class="sortable num" data-sort="games">Games ${arrow('games')}</th>
      <th class="sortable num" data-sort="wr">Win % ${arrow('wr')}</th>
      <th>By pod</th>
      <th class="sortable" data-sort="streak">Form ${arrow('streak')}</th>
    </tr></thead>
    <tbody>${rows.map(r=>`<tr>
      <td><div class="deck-cell">${manaDot(r.deck)}<span>${esc(r.deck)}</span></div></td>
      <td>${esc(r.name)}</td>
      <td class="num-cell">${r.games}</td>
      <td><span class="wr-badge ${wrClass(r.wr)}">${r.wr}%</span></td>
      <td>${podChips(r.pods)}</td>
      <td>${formCell(r.sf)}</td>
    </tr>`).join('')}</tbody>
  </table></div>`;

  const sortBtn = (c,lbl)=>`<button class="sortpill ${deckSort.col===c?'on':''}" data-sort="${c}">${lbl}${deckSort.col===c?` ${deckSort.dir<0?'▾':'▴'}`:''}</button>`;
  const sortbar = `<div class="sortbar"><span class="sortbar-lbl">Sort</span>${
    sortBtn('wr','Win %')}${sortBtn('games','Games')}${sortBtn('deck','Deck')}${sortBtn('name','Pilot')}${sortBtn('streak','Form')}</div>`;

  const cards = `<div class="rows">${rows.map(r=>`<div class="row-card">
    <div class="rc-head">
      <span class="rc-title">${manaDot(r.deck)}${esc(r.deck)}</span>
      <span class="wr-badge ${wrClass(r.wr)}">${r.wr}%</span>
    </div>
    <div class="rc-sub">${esc(r.name)} · ${r.wins}/${r.games} won</div>
    <div class="rc-row">${podChips(r.pods)}</div>
    <div class="rc-row">${formCell(r.sf)}</div>
  </div>`).join('')}</div>`;

  el.innerHTML = table + sortbar + cards;
  const doSort = c=>{
    if(deckSort.col===c) deckSort.dir*=-1; else { deckSort.col=c; deckSort.dir = (c==='deck'||c==='name')?1:-1; }
    renderDecks();
  };
  el.querySelectorAll('th.sortable').forEach(th=>th.onclick=()=>doSort(th.dataset.sort));
  el.querySelectorAll('.sortbar [data-sort]').forEach(b=>b.onclick=()=>doSort(b.dataset.sort));
}
function wrClass(wr){ return wr>=50 ? 'hi' : wr>=33 ? 'mid' : 'lo'; }

/* =================== PLAYERS VIEW =================== */
function renderPlayers(){
  const f = filtered();
  const m = {};
  f.forEach(g=>g.players.forEach(p=>{
    const e = (m[p.name]=m[p.name]||{name:p.name,games:0,wins:0,decks:new Set(),pods:{},series:[],posGames:0,starts:0,dies:0,kills:0});
    e.games++; if(p.won)e.wins++; e.decks.add(resolveDeck(p.deck));
    if(g.enriched){ e.posGames++; if(p.started) e.starts++; if(p.diedFirst) e.dies++; e.kills += p.kills||0; }
    const pk = podKey(g.playerCount);
    const b = e.pods[pk] = e.pods[pk] || {g:0,w:0}; b.g++; if(p.won) b.w++;
    e.series.push({ date:g.date, won:p.won?1:0 });
  }));
  let rows = Object.values(m).map(r=>{
    const sf = streakForm(r.series);
    const hasPos = r.posGames>0;
    return {...r, wr:pct(r.wins,r.games), nd:r.decks.size, sf, hasPos,
      startPct: hasPos?pct(r.starts,r.posGames):null, diePct: hasPos?pct(r.dies,r.posGames):null,
      avgKills: hasPos?Math.round(r.kills/r.posGames*10)/10:null };
  }).sort((a,b)=>b.wr-a.wr);
  const fmtPos = v => v==null ? '–' : v+'%';
  const fmtKills = v => v==null ? '–' : v.toFixed(1);
  const el = document.getElementById('playersView');
  if(!rows.length){ el.innerHTML = emptyState(); return; }

  const table = `<div class="tbl-wrap"><table>
    <thead><tr>
      <th>Player</th><th class="num">Games</th><th class="num">Win %</th>
      <th class="num">Starts 1st</th><th class="num">Dies 1st</th><th class="num">Kills/g</th>
      <th>By pod</th><th>Form</th><th class="num">Decks</th>
    </tr></thead>
    <tbody>${rows.map(r=>`<tr>
      <td class="strong">${esc(r.name)}</td>
      <td class="num-cell">${r.games}</td>
      <td><span class="wr-badge ${wrClass(r.wr)}">${r.wr}%</span></td>
      <td class="num-cell">${fmtPos(r.startPct)}</td>
      <td class="num-cell">${fmtPos(r.diePct)}</td>
      <td class="num-cell">${fmtKills(r.avgKills)}</td>
      <td>${podChips(r.pods)}</td>
      <td>${formCell(r.sf)}</td>
      <td class="num-cell">${r.nd}</td>
    </tr>`).join('')}</tbody></table></div>`;

  const cards = `<div class="rows">${rows.map(r=>`<div class="row-card">
    <div class="rc-head">
      <span class="rc-title">${esc(r.name)}</span>
      <span class="wr-badge ${wrClass(r.wr)}">${r.wr}%</span>
    </div>
    <div class="rc-sub">${r.wins}/${r.games} won · ${r.nd} deck${r.nd>1?'s':''}</div>
    <div class="rc-row">${podChips(r.pods)}</div>
    <div class="rc-row"><span class="posstat">Starts 1st <b>${fmtPos(r.startPct)}</b></span><span class="posstat">Dies 1st <b>${fmtPos(r.diePct)}</b></span><span class="posstat">Kills/g <b>${fmtKills(r.avgKills)}</b></span></div>
    <div class="rc-row">${formCell(r.sf)}</div>
  </div>`).join('')}</div>`;

  el.innerHTML = table + cards;
}

/* =================== TRENDS (Chart.js) =================== */
let chart = null;
function renderTrends(){
  const win = Number(document.getElementById('windowSize').value)||10;
  const f = filtered().slice().sort((a,b)=>a.date.localeCompare(b.date));
  const series = {}; // deck -> [{date, won}]
  f.forEach(g=>g.players.forEach(p=>{
    (series[p.deck]=series[p.deck]||[]).push({date:g.date, won:p.won?1:0});
  }));
  const labels = [...new Set(f.map(g=>g.date))].sort();
  const palette = ['#5aa9e6','#5fb573','#e0644f','#9b8cc0','#e0a64f','#56c7c0','#d96fa8','#8fa4f0'];
  const datasets = [];
  let ci = 0;
  Object.entries(series).forEach(([deck, arr])=>{
    if(arr.length < win) return;
    arr.sort((a,b)=>a.date.localeCompare(b.date));
    const pts = [];
    for(let i=0;i<arr.length;i++){
      const s = Math.max(0, i-win+1);
      const slice = arr.slice(s, i+1);
      const wr = slice.reduce((t,x)=>t+x.won,0)/slice.length*100;
      pts.push({ x: arr[i].date, y: Math.round(wr*10)/10 });
    }
    const col = palette[ci++ % palette.length];
    datasets.push({ label: deck, data: pts, borderColor: col, backgroundColor: col,
      tension:.35, borderWidth:2, pointRadius:2, pointHoverRadius:5, fill:false });
  });
  const ctx = document.getElementById('trendChart');
  if(chart) chart.destroy();
  if(!datasets.length){
    document.querySelector('[data-pane=trends] canvas').style.display='none';
    if(!document.getElementById('trendEmpty')){
      const d=document.createElement('div'); d.id='trendEmpty'; d.innerHTML=emptyState('Not enough games per deck for this window. Lower the window or log more games.');
      ctx.parentElement.appendChild(d);
    }
    return;
  }
  const te = document.getElementById('trendEmpty'); if(te) te.remove();
  ctx.style.display='';
  // widen canvas so points don't cram; container scrolls horizontally
  const scrollEl = document.getElementById('chartScroll');
  const innerEl = document.getElementById('chartInner');
  innerEl.style.width = Math.max(scrollEl.clientWidth, labels.length*34) + 'px';
  Chart.defaults.font.family = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";
  Chart.defaults.color = '#9aa1ac';
  chart = new Chart(ctx, {
    type:'line',
    data:{ datasets },
    options:{
      responsive:true, maintainAspectRatio:false, interaction:{mode:'nearest',intersect:false},
      scales:{
        x:{ type:'category', labels, grid:{color:'rgba(255,255,255,.05)'}, ticks:{maxRotation:0, autoSkip:true, maxTicksLimit:8} },
        y:{ min:0, max:100, grid:{color:'rgba(255,255,255,.05)'}, ticks:{callback:v=>v+'%'} }
      },
      plugins:{ legend:{ position:'bottom', labels:{boxWidth:12, padding:14, font:{size:11}} },
        tooltip:{ callbacks:{ label:c=>` ${c.dataset.label}: ${c.parsed.y}%` } } }
    }
  });
  // jump to the most recent games
  requestAnimationFrame(()=>{ scrollEl.scrollLeft = scrollEl.scrollWidth; });
}

/* =================== HEAD TO HEAD =================== */
function renderH2H(){
  const f = filtered();
  const names = [...new Set(f.flatMap(g=>g.players.map(p=>p.name)))].sort();
  const el = document.getElementById('h2hView');
  if(names.length<2){ el.innerHTML = emptyState('Need at least two players sharing games.'); return; }
  const stat = {};
  names.forEach(a=>{ stat[a]={}; names.forEach(b=>stat[a][b]={g:0,w:0}); });
  f.forEach(g=>{
    const ps = g.players;
    for(const A of ps) for(const B of ps){
      if(A.name===B.name) continue;
      const s = stat[A.name][B.name]; s.g++; if(A.won) s.w++;
    }
  });
  const cellColor = wr => {
    if(wr==null) return '';
    const t = wr/100;
    // grey (low) -> green (high)
    return `background:rgba(63,185,80,${.05 + t*.28})`;
  };
  el.innerHTML = `<div class="tbl-wrap always"><table class="h2h">
    <thead><tr><th>vs →</th>${names.map(n=>`<th>${esc(n)}</th>`).join('')}</tr></thead>
    <tbody>${names.map(a=>`<tr><td>${esc(a)}</td>${names.map(b=>{
      if(a===b) return `<td class="diag">—</td>`;
      const s = stat[a][b];
      if(!s.g) return `<td class="muted">·</td>`;
      const wr = pct(s.w,s.g);
      return `<td style="${cellColor(wr)}"><span class="cell-wr">${wr}%</span><span class="cell-sub">${s.w}/${s.g}</span></td>`;
    }).join('')}</tr>`).join('')}</tbody></table></div>
    <div class="hint">Read across a row: that player's win % in games shared with each opponent.</div>`;
}

/* =================== GAME LOG =================== */
let logPage = 0;
const PAGE = 12;
function renderLog(){
  const f = filtered().slice().sort((a,b)=>b.date.localeCompare(a.date));
  const el = document.getElementById('logView');
  if(!f.length){ el.innerHTML = emptyState(); return; }
  const pages = Math.ceil(f.length/PAGE);
  logPage = Math.min(logPage, pages-1);
  const slice = f.slice(logPage*PAGE, logPage*PAGE+PAGE);

  const seatList = g => g.players.map(p=>
    `<div class="seat">${p.won?'<span class="crown">★</span>':''}<strong>${esc(p.name)}</strong><span class="seat-deck">${esc(p.deck)}</span></div>`).join('');

  const table = `<div class="tbl-wrap"><table>
    <thead><tr><th>Date</th><th>Pod</th><th>Players &amp; Decks</th><th>Winner</th></tr></thead>
    <tbody>${slice.map(g=>{
      const winners = g.players.filter(p=>p.won).map(p=>p.name).join(', ') || '—';
      return `<tr>
        <td class="num-cell">${esc(g.date)}</td>
        <td>${pctTag(g.playerCount)}</td>
        <td>${seatList(g)}</td>
        <td class="winner-name">${esc(winners)}</td>
      </tr>`;
    }).join('')}</tbody></table></div>`;

  const cards = `<div class="rows">${slice.map(g=>{
    return `<div class="row-card">
      <div class="rc-head">
        <span class="rc-title">${esc(g.date)} ${pctTag(g.playerCount)}</span>
      </div>
      <div class="rc-seats">${seatList(g)}</div>
    </div>`;
  }).join('')}</div>`;

  el.innerHTML = table + cards + `<div class="pager">
      <button class="btn" ${logPage===0?'disabled':''} data-page="prev">‹ Prev</button>
      <span>Page ${logPage+1} / ${pages} · ${f.length} games</span>
      <button class="btn" ${logPage>=pages-1?'disabled':''} data-page="next">Next ›</button>
    </div>`;

  el.querySelectorAll('[data-page]').forEach(b=>b.onclick=()=>{
    logPage += b.dataset.page==='next'?1:-1; renderLog();
  });
}

function emptyState(msg){
  return `<div class="empty"><div class="big">⚔</div>${msg||'No games match these filters yet. Log a game above or sync from the cloud.'}</div>`;
}

/* =================== PLAYER DROPDOWN =================== */
function refreshPlayerDropdown(){
  const sel = document.getElementById('playerFilter');
  const names = [...new Set(GAMES.flatMap(g=>g.players.map(p=>p.name)))].sort();
  const cur = F.player;
  sel.innerHTML = '<option value="">All players</option>' + names.map(n=>`<option ${n===cur?'selected':''}>${esc(n)}</option>`).join('');
}

/* =================== RENDER ALL =================== */
const activeTab = ()=>document.querySelector('.tab.on').dataset.tab;
function renderActivePane(){
  switch(activeTab()){
    case 'decks': renderDecks(); break;
    case 'players': renderPlayers(); break;
    case 'trends': renderTrends(); break;
    case 'h2h': renderH2H(); break;
    case 'log': renderLog(); break;
    case 'collection': renderCollection(); break;
    case 'group': renderGroup(); break;
  }
}
function renderAll(){
  indexDecks(); learnDeckColors(); renderRibbon(); refreshPlayerDropdown(); renderActivePane();
}

/* =================== EVENTS =================== */
function bindStatic(){
  // collapsibles
  document.querySelectorAll('[data-toggle]').forEach(h=>h.onclick=()=>h.closest('.panel').classList.toggle('open'));
  // mobile filter toggle
  const fb = document.getElementById('filterbar');
  const ft = document.getElementById('filterToggle');
  if(ft) ft.onclick=()=> fb.classList.toggle('open');
  // tabs
  document.querySelectorAll('.tab').forEach(t=>t.onclick=()=>{
    document.querySelectorAll('.tab').forEach(x=>x.classList.remove('on'));
    document.querySelectorAll('.tabpane').forEach(x=>x.classList.remove('on'));
    t.classList.add('on');
    document.querySelector(`[data-pane=${t.dataset.tab}]`).classList.add('on');
    renderActivePane();
  });
  // filters
  document.querySelectorAll('#pcFilter button').forEach(b=>b.onclick=()=>{
    document.querySelectorAll('#pcFilter button').forEach(x=>x.classList.remove('on'));
    b.classList.add('on'); F.pc=b.dataset.pc; logPage=0; renderAll();
  });
  document.getElementById('playerFilter').onchange=e=>{ F.player=e.target.value; logPage=0; renderAll(); };
  document.getElementById('dateFrom').onchange=e=>{ F.from=e.target.value; logPage=0; renderAll(); };
  document.getElementById('dateTo').onchange=e=>{ F.to=e.target.value; logPage=0; renderAll(); };
  document.getElementById('clearFilters').onclick=()=>{
    F.pc='all'; F.player=''; F.from=''; F.to='';
    document.querySelectorAll('#pcFilter button').forEach((x,i)=>x.classList.toggle('on',i===0));
    document.getElementById('playerFilter').value='';
    document.getElementById('dateFrom').value=''; document.getElementById('dateTo').value='';
    logPage=0; renderAll();
  };
  document.getElementById('windowSize').onchange=renderTrends;
}

/* =================== SCREEN SHELL =================== */
function setScreen(name){
  document.querySelectorAll('.screen').forEach(s=>s.classList.remove('on'));
  const el = document.getElementById('screen-'+name);
  if(el) el.classList.add('on');
  document.body.classList.toggle('playing', name==='play');
}

function renderUserChip(){
  const c = document.getElementById('userChip'); if(!c) return;
  if(!CURRENT_USER){ c.innerHTML=''; return; }
  const gname = (GROUP_INFO && GROUP_INFO.name) || 'group';
  c.innerHTML = `<span class="uc-name">${esc(CURRENT_USER.displayName||CURRENT_USER.handle)}</span>
    <span class="uc-group">${esc(gname)}</span>`;
  c.onclick = ()=>{ const t=document.querySelector('.tab[data-tab=group]'); if(t) t.click(); };
}

let GROUP_INFO = null;
async function enterApp(){
  if(!(CURRENT_USER.groupIds||[]).includes(CURRENT_GROUP)) CURRENT_GROUP = (CURRENT_USER.groupIds||[])[0] || 'default';
  localStorage.setItem('mtg_group', CURRENT_GROUP);
  load(); renderAll(); setScreen('app');
  renderUserChip();
  try { const g = await api('/groups/'+encodeURIComponent(CURRENT_GROUP)); GROUP_INFO = g.group; renderUserChip(); } catch(e){}
  await fetchGroupDecks(); renderAll();
  pullCloud(true);
}

async function doLogout(){
  try { await api('/auth/logout', { method:'POST' }); } catch(e){}
  AUTH=''; CURRENT_USER=null; localStorage.removeItem('mtg_session');
  setScreen('login');
}

/* =================== AUTH UI =================== */
function bindAuthUI(){
  document.querySelectorAll('#authTabs button').forEach(b=>b.onclick=()=>{
    document.querySelectorAll('#authTabs button').forEach(x=>x.classList.remove('on'));
    b.classList.add('on');
    const reg = b.dataset.auth==='register';
    document.getElementById('loginForm').hidden = reg;
    document.getElementById('registerForm').hidden = !reg;
  });

  document.getElementById('loginForm').onsubmit = async e=>{
    e.preventDefault();
    const f = e.target;
    try {
      const r = await api('/auth/login', { method:'POST', body:{ handle:f.handle.value.trim(), pin:f.pin.value } });
      AUTH = r.token; CURRENT_USER = r.user; localStorage.setItem('mtg_session', AUTH);
      enterApp();
    } catch(err){ toast(err.message, true); }
  };

  document.getElementById('registerForm').onsubmit = async e=>{
    e.preventDefault();
    const f = e.target;
    try {
      const r = await api('/auth/register', { method:'POST',
        body:{ handle:f.handle.value.trim(), displayName:f.displayName.value.trim(), pin:f.pin.value } });
      AUTH = r.token; CURRENT_USER = r.user; localStorage.setItem('mtg_session', AUTH);
      enterApp();
    } catch(err){ toast(err.message, true); }
  };

  document.getElementById('joinBtn').onclick = async ()=>{
    const code = document.getElementById('joinCode').value.trim();
    if(!code) return;
    if(!AUTH){ toast('Log in first, then join.', true); return; }
    try {
      const r = await api('/groups/join', { method:'POST', body:{ code } });
      CURRENT_GROUP = r.group.id; localStorage.setItem('mtg_group', CURRENT_GROUP);
      CURRENT_USER.groupIds = [...new Set([...(CURRENT_USER.groupIds||[]), r.group.id])];
      toast('Joined '+r.group.name); enterApp();
    } catch(err){ toast(err.message, true); }
  };
}

/* =================== BOOT =================== */
async function boot(){
  bindStatic(); bindAuthUI();
  document.getElementById('newGameBtn').onclick = ()=> startNewGame();
  if(AUTH){
    try { const me = await api('/auth/me'); CURRENT_USER = me.user; await enterApp(); }
    catch(e){ AUTH=''; localStorage.removeItem('mtg_session'); setScreen('login'); }
  } else {
    setScreen('login');
  }
  maybeResumeGame();
}
boot();

/* ======================================================================
   ===========================  MODAL  ==================================
   ====================================================================== */
function modal(html){
  const bd = document.getElementById('modalBackdrop');
  const m = document.getElementById('modal');
  m.innerHTML = html; bd.hidden = false;
  bd.onclick = e=>{ if(e.target===bd) closeModal(); };
  return m;
}
function closeModal(){ document.getElementById('modalBackdrop').hidden = true; }

function manaDotColors(colors){
  if(!colors) return '<span class="mana"><span class="mana-dot" style="background:#888"></span></span>';
  return '<span class="mana" style="display:inline-flex;gap:2px">'+[...colors].map(c=>
    `<span class="mana-dot" style="background:${PIP[c]||'#999'}"></span>`).join('')+'</span>';
}

/* ======================================================================
   ===========================  GROUP  ==================================
   ====================================================================== */
const GROUP_NAMES = { 'default':'The Playgroup' };
async function renderGroup(){
  const el = document.getElementById('groupView');
  el.innerHTML = '<div class="empty">Loading…</div>';
  let g;
  try { const r = await api('/groups/'+encodeURIComponent(CURRENT_GROUP)); g = r.group; GROUP_INFO = g; GROUP_NAMES[g.id]=g.name; renderUserChip(); }
  catch(e){ el.innerHTML = emptyState('Could not load group.'); return; }

  const members = (g.members||[]).map(m=>`<div class="row-card">
    <div class="rc-head"><span class="rc-title">${esc(m.displayName||m.handle||m.userId)}</span>
      <span class="role ${esc(m.role||'')}">${esc(m.role||'')}</span></div>
    <div class="rc-sub">@${esc(m.handle||'—')}</div></div>`).join('');

  const otherGroups = (CURRENT_USER.groupIds||[]).filter(id=>id!==CURRENT_GROUP);
  const switcher = otherGroups.length ? `<div class="group-switch">
    <span class="rc-sub">Switch:</span>${otherGroups.map(id=>
      `<button class="chip" data-grp="${esc(id)}">${esc(GROUP_NAMES[id]||id)}</button>`).join('')}</div>` : '';

  el.innerHTML = `
    <div class="group-head">
      <div><div class="group-name">${esc(g.name)}</div><div class="rc-sub">${(g.members||[]).length} member(s)</div></div>
      <div class="row-actions">
        <button class="primary" id="inviteBtn">Invite</button>
        <button class="ghost" id="newGroupBtn">New group</button>
        <button class="danger" id="logoutBtn">Log out</button>
      </div>
    </div>
    ${switcher}
    <div class="rows">${members}</div>`;

  el.querySelector('#inviteBtn').onclick = doInvite;
  el.querySelector('#logoutBtn').onclick = doLogout;
  el.querySelector('#newGroupBtn').onclick = doNewGroup;
  el.querySelectorAll('[data-grp]').forEach(b=>b.onclick=()=>{
    CURRENT_GROUP = b.dataset.grp; localStorage.setItem('mtg_group', CURRENT_GROUP); enterApp();
  });
}

async function doInvite(){
  try {
    const r = await api('/groups/'+encodeURIComponent(CURRENT_GROUP)+'/invite', { method:'POST' });
    modal(`<h3>Invite code</h3><div class="invite-code">${esc(r.code)}</div>
      <p class="rc-sub">Share this code — a friend enters it on the login screen. Expires in 7 days.</p>
      <div class="row-actions"><button class="primary" id="copyInvite">Copy</button>
        <button class="ghost" id="closeM">Close</button></div>`);
    document.getElementById('copyInvite').onclick = ()=>{ try{navigator.clipboard.writeText(r.code);}catch(e){} toast('Copied'); };
    document.getElementById('closeM').onclick = closeModal;
  } catch(e){ toast(e.message, true); }
}

async function doNewGroup(){
  const name = prompt('New group name?'); if(!name) return;
  try {
    const r = await api('/groups', { method:'POST', body:{ name } });
    CURRENT_USER.groupIds = [...(CURRENT_USER.groupIds||[]), r.group.id];
    GROUP_NAMES[r.group.id] = r.group.name;
    CURRENT_GROUP = r.group.id; localStorage.setItem('mtg_group', CURRENT_GROUP);
    toast('Group created'); enterApp();
  } catch(e){ toast(e.message, true); }
}

/* ======================================================================
   ========================  COLLECTION (DECKS)  ========================
   ====================================================================== */
function distinctHistoricalDecks(){
  const have = new Set(Object.keys(DECK_ALIAS));
  const names = new Set();
  GAMES.forEach(g=>g.players.forEach(p=>{
    if(p.deck && p.deck!=='—' && !have.has(p.deck.toLowerCase())) names.add(p.deck);
  }));
  return [...names].sort();
}

function renderCollection(){
  const el = document.getElementById('collectionView');
  const importBox = `
    <div class="import-box">
      <input id="deckUrl" placeholder="Paste an Archidekt or Moxfield deck URL…">
      <button class="primary" id="importBtn">Import</button>
    </div>
    <div class="import-or">or <button class="link" id="manualBtn">add manually</button></div>`;
  const list = GROUP_DECKS.length
    ? `<div class="deck-grid">${GROUP_DECKS.map(deckCard).join('')}</div>`
    : emptyState('No decks yet. Import from Archidekt/Moxfield or add manually.');
  el.innerHTML = importBox + list;
  el.querySelector('#importBtn').onclick = doImport;
  el.querySelector('#manualBtn').onclick = ()=>deckForm();
  el.querySelectorAll('[data-del]').forEach(b=>b.onclick=()=>delDeck(b.dataset.del));
  el.querySelectorAll('[data-attach]').forEach(b=>b.onclick=()=>attachUI(GROUP_DECKS.find(d=>d.id===b.dataset.attach)));
}

function deckCard(d){
  const bg = d.commanderImage ? `style="background-image:url('${esc(d.commanderImage)}')"` : '';
  return `<div class="deck-card ${d.commanderImage?'':'noart'}" ${bg}><div class="deck-card-overlay">
    <div class="deck-card-top">${manaDotColors(d.colors)}
      <button class="icon del" data-del="${esc(d.id)}" title="Delete">✕</button></div>
    <div class="deck-card-name">${esc(d.name)}</div>
    <div class="deck-card-sub">${esc(d.commander||'')}</div>
    ${d.aliases&&d.aliases.length?`<div class="deck-card-alias">↔ ${d.aliases.map(esc).join(', ')}</div>`:''}
    <button class="link attach" data-attach="${esc(d.id)}">attach history…</button>
  </div></div>`;
}

async function doImport(){
  const url = (document.getElementById('deckUrl').value||'').trim();
  if(!url){ toast('Paste a deck URL first.', true); return; }
  const which = /moxfield/i.test(url) ? 'moxfield' : 'archidekt';
  toast('Importing…');
  try {
    const r = await api('/import/'+which+'?url='+encodeURIComponent(url));
    previewImport(r.deck);
  } catch(e){ toast('Import failed: '+e.message, true); }
}

function previewImport(deck){
  const existing = distinctHistoricalDecks();
  const opts = existing.length
    ? existing.map(n=>`<label class="chk"><input type="checkbox" value="${esc(n)}"> ${esc(n)}</label>`).join('')
    : '<div class="rc-sub">No unlinked historical deck names to attach.</div>';
  const bg = deck.commanderImage ? `style="background-image:url('${esc(deck.commanderImage)}')"` : '';
  modal(`<h3>Import deck</h3>
    <div class="deck-card preview ${deck.commanderImage?'':'noart'}" ${bg}><div class="deck-card-overlay">
      <div class="deck-card-top">${manaDotColors(deck.colors)}</div>
      <div class="deck-card-name">${esc(deck.name)}</div>
      <div class="deck-card-sub">${esc(deck.commander||'')}</div></div></div>
    <div class="attach-block"><div class="attach-title">Attach to existing deck history (optional)</div>
      <div class="chk-list">${opts}</div></div>
    <div class="row-actions"><button class="primary" id="saveDeck">Save deck</button>
      <button class="ghost" id="closeM">Cancel</button></div>`);
  document.getElementById('closeM').onclick = closeModal;
  document.getElementById('saveDeck').onclick = async ()=>{
    const aliases = [...document.querySelectorAll('.chk-list input:checked')].map(c=>c.value);
    try {
      await api('/decks', { method:'POST', body:{ groupId:CURRENT_GROUP, name:deck.name, commander:deck.commander,
        colors:deck.colors, commanderImage:deck.commanderImage, source:deck.source, sourceUrl:deck.sourceUrl,
        sourceId:deck.sourceId, aliases } });
      closeModal(); toast('Deck saved'); await fetchGroupDecks(); renderAll();
    } catch(e){ toast(e.message, true); }
  };
}

function attachUI(d){
  if(!d) return;
  const cur = new Set((d.aliases||[]).map(x=>x.toLowerCase()));
  const names = [...new Set([...(d.aliases||[]), ...distinctHistoricalDecks()])].sort();
  const opts = names.length
    ? names.map(n=>`<label class="chk"><input type="checkbox" value="${esc(n)}" ${cur.has(n.toLowerCase())?'checked':''}> ${esc(n)}</label>`).join('')
    : '<div class="rc-sub">No historical deck names found.</div>';
  modal(`<h3>Attach history → ${esc(d.name)}</h3>
    <p class="rc-sub">Ticked names merge their past games into this deck's stats.</p>
    <div class="chk-list">${opts}</div>
    <div class="row-actions"><button class="primary" id="saveAtt">Save</button>
      <button class="ghost" id="closeM">Cancel</button></div>`);
  document.getElementById('closeM').onclick = closeModal;
  document.getElementById('saveAtt').onclick = async ()=>{
    const aliases = [...document.querySelectorAll('.chk-list input:checked')].map(c=>c.value);
    try { await api('/decks/'+encodeURIComponent(d.id), { method:'POST', body:{ aliases } });
      closeModal(); toast('Updated'); await fetchGroupDecks(); renderAll();
    } catch(e){ toast(e.message, true); }
  };
}

function deckForm(){
  modal(`<h3>Add deck</h3>
    <label>Name</label><input id="dfName" placeholder="Deck / commander name">
    <label>Commander</label><input id="dfCmd" placeholder="optional">
    <label>Colors (WUBRG)</label><input id="dfColors" maxlength="5" placeholder="e.g. UBR">
    <div class="row-actions"><button class="primary" id="dfSave">Save</button>
      <button class="ghost" id="closeM">Cancel</button></div>`);
  document.getElementById('closeM').onclick = closeModal;
  document.getElementById('dfSave').onclick = async ()=>{
    const name = document.getElementById('dfName').value.trim();
    if(!name){ toast('Name required', true); return; }
    try {
      await api('/decks', { method:'POST', body:{ groupId:CURRENT_GROUP, name,
        commander:document.getElementById('dfCmd').value.trim(),
        colors:document.getElementById('dfColors').value, source:'manual' } });
      closeModal(); toast('Deck saved'); await fetchGroupDecks(); renderAll();
    } catch(e){ toast(e.message, true); }
  };
}

async function delDeck(id){
  if(!confirm('Delete this deck? (history stays in the ledger)')) return;
  try { await api('/decks/'+encodeURIComponent(id), { method:'DELETE' });
    toast('Deleted'); await fetchGroupDecks(); renderAll();
  } catch(e){ toast(e.message, true); }
}

/* ======================================================================
   =========================  GAME MODE  ================================
   ====================================================================== */
let LIVE = null;
function saveLive(){ if(LIVE) localStorage.setItem('mtg_live_game', JSON.stringify(LIVE)); else localStorage.removeItem('mtg_live_game'); }
function loadLive(){ try { return JSON.parse(localStorage.getItem('mtg_live_game')); } catch(e){ return null; } }

function maybeResumeGame(){
  const l = loadLive();
  if(l && l.status==='playing'){
    modal(`<h3>Resume game?</h3><p class="rc-sub">A ${l.seatCount}-player game is in progress.</p>
      <div class="row-actions"><button class="primary" id="resumeYes">Resume</button>
        <button class="ghost" id="resumeNo">Discard</button></div>`);
    document.getElementById('resumeYes').onclick = ()=>{ closeModal(); LIVE=l; setScreen('play'); renderGame(); };
    document.getElementById('resumeNo').onclick = ()=>{ closeModal(); LIVE=null; saveLive(); };
  }
}

function memberNames(){ return (GROUP_INFO && GROUP_INFO.members || []).map(m=>m.displayName||m.handle).filter(Boolean); }

// transient setup config
let SETUP = null;
function startNewGame(){
  if(!AUTH){ toast('Log in first.', true); return; }
  SETUP = { seatCount:4, type:'commander', startLife:40,
    seats: Array.from({length:4}, ()=>({ name:'', deckId:'' })) };
  setScreen('play'); renderSetup();
}

function renderSetup(){
  const root = document.getElementById('gameRoot');
  const names = memberNames();
  const dl = `<datalist id="memberList">${names.map(n=>`<option value="${esc(n)}">`).join('')}</datalist>`;
  const deckOpts = `<option value="">— no deck —</option>` +
    GROUP_DECKS.map(d=>`<option value="${esc(d.id)}">${esc(d.name)}</option>`).join('') +
    `<option value="__import">＋ import on the fly…</option>`;

  const seatCards = SETUP.seats.map((s,i)=>`
    <div class="setup-seat">
      <div class="setup-seat-h">Seat ${i+1}</div>
      <input list="memberList" class="su-name" data-i="${i}" placeholder="player name" value="${esc(s.name)}">
      <select class="su-deck" data-i="${i}">${deckOpts.replace(`value="${esc(s.deckId)}"`, `value="${esc(s.deckId)}" selected`)}</select>
    </div>`).join('');

  root.innerHTML = `${dl}
    <div class="setup">
      <div class="setup-bar">
        <button class="ghost" id="suQuit">‹ Cancel</button>
        <div class="setup-title">New Game</div>
        <span></span>
      </div>

      <div class="setup-row">
        <label>Format</label>
        <div class="segbtns" id="suType">
          <button data-t="commander" class="${SETUP.type==='commander'?'on':''}">Commander · 40</button>
          <button data-t="custom" class="${SETUP.type==='custom'?'on':''}">Custom</button>
        </div>
        <input id="suLife" type="number" class="su-life" value="${SETUP.startLife}" ${SETUP.type==='commander'?'disabled':''}>
      </div>

      <div class="setup-row">
        <label>Players</label>
        <div class="segbtns" id="suCount">
          ${[2,3,4].map(n=>`<button data-n="${n}" class="${SETUP.seatCount===n?'on':''}">${n}</button>`).join('')}
        </div>
      </div>

      <div class="setup-seats sc-${SETUP.seatCount}">${seatCards}</div>

      <button class="primary big start" id="suStart">Roll first player & start ▶</button>
    </div>`;

  root.querySelector('#suQuit').onclick = ()=> exitGame();
  root.querySelectorAll('#suType button').forEach(b=>b.onclick=()=>{
    SETUP.type = b.dataset.t; SETUP.startLife = SETUP.type==='commander'?40:(SETUP.startLife||20); renderSetup();
  });
  root.querySelector('#suLife').oninput = e=>{ SETUP.startLife = Number(e.target.value)||20; };
  root.querySelectorAll('#suCount button').forEach(b=>b.onclick=()=>{
    const n = Number(b.dataset.n); SETUP.seatCount = n;
    while(SETUP.seats.length<n) SETUP.seats.push({name:'',deckId:''});
    SETUP.seats = SETUP.seats.slice(0,n); renderSetup();
  });
  root.querySelectorAll('.su-name').forEach(inp=>inp.oninput=e=>{ SETUP.seats[+e.target.dataset.i].name = e.target.value; });
  root.querySelectorAll('.su-deck').forEach(sel=>sel.onchange=e=>{
    const i = +e.target.dataset.i;
    if(e.target.value==='__import'){ e.target.value=SETUP.seats[i].deckId||''; const t=document.querySelector('.tab[data-tab=collection]'); toast('Import via the Collection tab, then come back.'); return; }
    SETUP.seats[i].deckId = e.target.value;
  });
  root.querySelector('#suStart').onclick = beginGame;
}

function beginGame(){
  const seats = SETUP.seats.slice(0, SETUP.seatCount).map((s,i)=>{
    const d = GROUP_DECKS.find(x=>x.id===s.deckId);
    return { seatIndex:i, name:(s.name||'').trim() || ('Seat '+(i+1)),
      deckId:s.deckId||undefined, deck: d?d.name:'—', colors: d?d.colors:'', commanderImage: d?d.commanderImage:'',
      life: SETUP.startLife, alive:true, started:false, diedFirst:false, killsBy:[] };
  });
  LIVE = { gameId: uid(), groupId: CURRENT_GROUP, type:SETUP.type, startLife:SETUP.startLife,
    seatCount:SETUP.seatCount, seats, firstPlayerSeat:null, firstDeathDone:false,
    status:'playing', startedAt: new Date().toISOString() };
  saveLive(); renderGame(); rollFirst();
}

function renderGame(){
  const root = document.getElementById('gameRoot');
  root.innerHTML = `
    <div class="seat-grid seat-grid--${LIVE.seatCount}">
      ${LIVE.seats.map((s,i)=>seatTile(s,i)).join('')}
    </div>
    <button class="hub" id="hubBtn">☰</button>`;
  bindSeats();
  root.querySelector('#hubBtn').onclick = hubMenu;
}

// rotation per seat to match table seating
function seatRot(i, count){
  if(count===2) return i===0 ? 'rot180' : '';
  if(count===3) return i<2 ? 'rot180' : '';
  if(count===4) return i<2 ? 'rot180' : '';
  return '';
}
function seatTile(s, i){
  const bg = s.commanderImage ? `style="background-image:url('${esc(s.commanderImage)}')"` : '';
  return `<div class="seat ${seatRot(i,LIVE.seatCount)} ${s.alive?'':'dead'} ${LIVE.firstPlayerSeat===i?'is-first':''} ${s.commanderImage?'':'noart'}"
      data-seat="${i}" ${bg}>
    <div class="seat-tint"></div>
    <div class="seat-inner">
      <div class="seat-head">${manaDotColors(s.colors)}<span class="seat-name">${esc(s.name)}</span>
        ${s.started?'<span class="seat-badge">1st</span>':''}</div>
      <div class="seat-life-wrap">
        <button class="life-zone minus" data-d="-1" data-seat="${i}" aria-label="minus"></button>
        <div class="seat-life" id="life-${i}">${s.life}</div>
        <button class="life-zone plus" data-d="1" data-seat="${i}" aria-label="plus"></button>
      </div>
      <div class="seat-foot">
        <span class="seat-deck">${esc(s.deck||'')}</span>
        ${s.alive?`<button class="kill-self" data-dead="${i}">dead</button>`:''}
      </div>
    </div>
    ${s.alive?'':'<div class="defeated">DEFEATED</div>'}
    <div class="first-flash">1ST</div>
  </div>`;
}

function bindSeats(){
  const root = document.getElementById('gameRoot');
  root.querySelectorAll('.life-zone').forEach(z=>{
    const seat = +z.dataset.seat, d = +z.dataset.d;
    let timer=null, holding=false;
    const tap = ()=> changeLife(seat, d, false);
    z.onclick = ()=>{ if(!holding) tap(); holding=false; };
    z.addEventListener('pointerdown', ()=>{ holding=false; timer=setTimeout(function rep(){ holding=true; changeLife(seat, d*5, true); timer=setTimeout(rep,400); },450); });
    const stop = ()=>{ clearTimeout(timer); };
    z.addEventListener('pointerup', stop); z.addEventListener('pointerleave', stop); z.addEventListener('pointercancel', stop);
  });
  root.querySelectorAll('[data-dead]').forEach(b=>b.onclick=()=>declareDead(+b.dataset.dead));
}

function changeLife(i, delta, big){
  const s = LIVE.seats[i]; if(!s.alive) return;
  s.life += delta; saveLive();
  const el = document.getElementById('life-'+i);
  if(el){ el.textContent = s.life; el.parentElement.parentElement.classList.remove('flash-up','flash-down');
    void el.offsetWidth; el.parentElement.parentElement.classList.add(delta>0?'flash-up':'flash-down');
    floatDelta(el.parentElement, delta); }
  if(s.life<=0) declareDead(i);
}

function floatDelta(wrap, delta){
  const d = document.createElement('span'); d.className='delta '+(delta>0?'up':'down');
  d.textContent = (delta>0?'+':'')+delta; wrap.appendChild(d);
  setTimeout(()=>d.remove(), 900);
}

function declareDead(i){
  const s = LIVE.seats[i]; if(!s.alive) return;
  s.alive = false;
  if(!LIVE.firstDeathDone){ s.diedFirst = true; LIVE.firstDeathDone = true; }
  saveLive(); renderGame();
  killPicker(i);
}

function killPicker(victim){
  const living = LIVE.seats.map((s,idx)=>({s,idx})).filter(x=>x.s.alive);
  const opts = living.map(x=>`<button class="kill-opt" data-k="${x.idx}">
    ${x.s.commanderImage?`<span class="ko-art" style="background-image:url('${esc(x.s.commanderImage)}')"></span>`:'<span class="ko-art noart"></span>'}
    <span>${esc(x.s.name)}</span></button>`).join('');
  modal(`<h3>Who killed ${esc(LIVE.seats[victim].name)}?</h3>
    <div class="kill-opts">${opts}
      <button class="kill-opt other" data-k="table">Table / self</button></div>`);
  document.querySelectorAll('.kill-opt').forEach(b=>b.onclick=()=>{
    if(b.dataset.k!=='table'){ const k=+b.dataset.k; LIVE.seats[k].killsBy.push(victim); }
    saveLive(); closeModal(); checkEnd();
  });
}

function checkEnd(){
  const living = LIVE.seats.filter(s=>s.alive);
  if(living.length<=1){ endGame(living[0]); }
}

function endGame(winnerSeat){
  LIVE.status='finished';
  LIVE.seats.forEach(s=> s.won = winnerSeat && s.seatIndex===winnerSeat.seatIndex);
  saveLive();
  const root = document.getElementById('gameRoot');
  const w = winnerSeat;
  root.innerHTML = `<div class="victory">
    <div class="victory-glow"></div>
    <div class="victory-card ${w&&w.commanderImage?'':'noart'}" ${w&&w.commanderImage?`style="background-image:url('${esc(w.commanderImage)}')"`:''}>
      <div class="victory-tint"></div>
      <div class="victory-body">
        <div class="victory-label">VICTORY</div>
        <div class="victory-name">${esc(w?w.name:'Draw')}</div>
        <div class="victory-deck">${esc(w?w.deck:'')}</div>
      </div>
    </div>
    <button class="primary big" id="finalizeBtn">Save result ▶</button>
    <button class="ghost" id="discardBtn">Discard</button>
  </div>`;
  root.querySelector('#finalizeBtn').onclick = finalizeGame;
  root.querySelector('#discardBtn').onclick = ()=>{ LIVE=null; saveLive(); exitGame(); };
}

async function finalizeGame(){
  const record = {
    id: LIVE.gameId, date: todayStr(), playerCount: LIVE.seatCount, enriched: true,
    players: LIVE.seats.map(s=>({
      name: s.name, deck: s.deck, colors: s.colors, won: !!s.won,
      started: !!s.started, diedFirst: !!s.diedFirst, kills: s.killsBy.length,
      deckId: s.deckId
    }))
  };
  mergeGames([record]);
  try { await pushCloud([record]); toast('Game saved'); }
  catch(e){ toast('Saved locally; cloud failed: '+e.message, true); }
  LIVE=null; saveLive(); exitGame(); renderAll();
}

function rollFirst(){
  const tiles = [...document.querySelectorAll('.seat')];
  if(!tiles.length) return;
  const n = LIVE.seatCount;
  const target = Math.floor(Math.random()*n);
  let step=0; const total = n*3 + target + 1;
  (function tick(){
    tiles.forEach(t=>t.classList.remove('roll-on'));
    const cur = step % n;
    if(tiles[cur]) tiles[cur].classList.add('roll-on');
    step++;
    if(step<=total){ setTimeout(tick, 90 + Math.pow(step/total,3)*260); }
    else {
      tiles.forEach(t=>t.classList.remove('roll-on'));
      LIVE.firstPlayerSeat = target; LIVE.seats[target].started = true; saveLive();
      renderGame();
      const ft = document.querySelector(`.seat[data-seat="${target}"]`);
      if(ft){ ft.classList.add('first-reveal'); setTimeout(()=>ft.classList.remove('first-reveal'),1400); }
    }
  })();
}

function hubMenu(){
  modal(`<h3>Game</h3>
    <div class="hub-menu">
      <button class="primary" id="hmEnd">End now (pick winner)</button>
      <button class="ghost" id="hmReset">Reset life</button>
      <button class="danger" id="hmQuit">Quit without saving</button>
      <button class="ghost" id="closeM">Close</button>
    </div>`);
  document.getElementById('closeM').onclick = closeModal;
  document.getElementById('hmReset').onclick = ()=>{ LIVE.seats.forEach(s=>{ s.life=LIVE.startLife; s.alive=true; s.diedFirst=false; s.killsBy=[]; }); LIVE.firstDeathDone=false; saveLive(); closeModal(); renderGame(); };
  document.getElementById('hmQuit').onclick = ()=>{ closeModal(); LIVE=null; saveLive(); exitGame(); };
  document.getElementById('hmEnd').onclick = ()=>{
    closeModal();
    const opts = LIVE.seats.map((s,idx)=>`<button class="kill-opt" data-w="${idx}">
      ${s.commanderImage?`<span class="ko-art" style="background-image:url('${esc(s.commanderImage)}')"></span>`:'<span class="ko-art noart"></span>'}
      <span>${esc(s.name)}</span></button>`).join('');
    modal(`<h3>Who won?</h3><div class="kill-opts">${opts}</div>`);
    document.querySelectorAll('[data-w]').forEach(b=>b.onclick=()=>{ closeModal(); endGame(LIVE.seats[+b.dataset.w]); });
  };
}

function exitGame(){ SETUP=null; setScreen('app'); renderUserChip(); }
