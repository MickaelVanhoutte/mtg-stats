"use strict";

/* =================== CONFIG =================== */
// Cloudflare Worker URL for shared cloud sync. Leave '' for local-only mode.
const CLOUD_URL = 'https://mythic-ledger.mika-ledger.workers.dev';

/* =================== STORE =================== */
const KEY = "mtg_games";
let GAMES = [];

function uid(){ return 'g_' + Math.random().toString(36).slice(2,10) + Date.now().toString(36).slice(-4); }
function load(){ try { GAMES = JSON.parse(localStorage.getItem(KEY)) || []; } catch(e){ GAMES = []; } }
function save(){ localStorage.setItem(KEY, JSON.stringify(GAMES)); }

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
      won: !!(p.won ?? p.win ?? p.winner ?? p.isWinner)
    })).filter(p=>p.name);
    const pc = Number(g.playerCount || g.pod || players.length) || players.length;
    return {
      id: g.id || uid(),
      date: (g.date || g.playedAt || g.createdAt || '').slice(0,10) || todayStr(),
      playerCount: pc,
      players
    };
  }).filter(g => g.players.length);
}

// Dedup on id only. Every game gets a stable id (cloud mt_*, uid() on manual/
// import, sample_*), so id-only is safe. gameKey-based dedup was too coarse —
// back-to-back games with the same date+seating+decks (a normal Commander
// rematch night) produced identical keys and got silently dropped.
function mergeGames(incoming){
  const seenId = new Set(GAMES.map(g=>g.id));
  let added = 0;
  incoming.forEach(g => {
    if (!g.id || seenId.has(g.id)) return;
    GAMES.push(g); seenId.add(g.id); added++;
  });
  save();
  return added;
}

/* =================== CLOUD =================== */
async function pullCloud(silent){
  if(!CLOUD_URL){ if(!silent) toast('No cloud configured — set CLOUD_URL in the file.', true); return; }
  try {
    const r = await fetch(CLOUD_URL.replace(/\/+$/,'') + '/ledger', { cache:'no-store' });
    if(!r.ok) throw new Error('HTTP '+r.status);
    const data = await r.json();
    const added = mergeGames(normalizeImport(data));
    renderAll();
    if(!silent) toast(added ? `Cloud: ${added} new game${added>1?'s':''}.` : 'Cloud: already up to date.');
  } catch(e){ if(!silent) toast('Cloud pull failed: '+e.message, true); }
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
  GAMES.forEach(g=>g.players.forEach(p=>{ if(p.colors) DECK_COLORS[p.deck]=p.colors; }));
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
    const k = p.deck+' '+p.name;
    const e = (m[k] = m[k] || { deck:p.deck, name:p.name, games:0, wins:0, pods:{}, series:[] });
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
    const e = (m[p.name]=m[p.name]||{name:p.name,games:0,wins:0,decks:new Set(),pods:{},series:[]});
    e.games++; if(p.won)e.wins++; e.decks.add(p.deck);
    const pk = podKey(g.playerCount);
    const b = e.pods[pk] = e.pods[pk] || {g:0,w:0}; b.g++; if(p.won) b.w++;
    e.series.push({ date:g.date, won:p.won?1:0 });
  }));
  let rows = Object.values(m).map(r=>{
    const sf = streakForm(r.series);
    return {...r, wr:pct(r.wins,r.games), nd:r.decks.size, sf };
  }).sort((a,b)=>b.wr-a.wr);
  const el = document.getElementById('playersView');
  if(!rows.length){ el.innerHTML = emptyState(); return; }

  const table = `<div class="tbl-wrap"><table>
    <thead><tr>
      <th>Player</th><th class="num">Games</th><th class="num">Win %</th>
      <th>By pod</th><th>Form</th><th class="num">Decks</th>
    </tr></thead>
    <tbody>${rows.map(r=>`<tr>
      <td class="strong">${esc(r.name)}</td>
      <td class="num-cell">${r.games}</td>
      <td><span class="wr-badge ${wrClass(r.wr)}">${r.wr}%</span></td>
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
    <thead><tr><th>Date</th><th>Pod</th><th>Players &amp; Decks</th><th>Winner</th><th></th></tr></thead>
    <tbody>${slice.map(g=>{
      const winners = g.players.filter(p=>p.won).map(p=>p.name).join(', ') || '—';
      return `<tr>
        <td class="num-cell">${esc(g.date)}</td>
        <td>${pctTag(g.playerCount)}</td>
        <td>${seatList(g)}</td>
        <td class="winner-name">${esc(winners)}</td>
        <td><button class="icon danger" data-del="${g.id}" title="Delete">✕</button></td>
      </tr>`;
    }).join('')}</tbody></table></div>`;

  const cards = `<div class="rows">${slice.map(g=>{
    return `<div class="row-card">
      <div class="rc-head">
        <span class="rc-title">${esc(g.date)} ${pctTag(g.playerCount)}</span>
        <button class="icon danger" data-del="${g.id}" title="Delete">✕</button>
      </div>
      <div class="rc-seats">${seatList(g)}</div>
    </div>`;
  }).join('')}</div>`;

  el.innerHTML = table + cards + `<div class="pager">
      <button class="btn" ${logPage===0?'disabled':''} data-page="prev">‹ Prev</button>
      <span>Page ${logPage+1} / ${pages} · ${f.length} games</span>
      <button class="btn" ${logPage>=pages-1?'disabled':''} data-page="next">Next ›</button>
    </div>`;

  el.querySelectorAll('[data-del]').forEach(b=>b.onclick=()=>{
    if(!confirm('Delete this game?')) return;
    GAMES = GAMES.filter(g=>g.id!==b.dataset.del); save(); renderAll();
    toast('Game removed.');
  });
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
  }
}
function renderAll(){
  learnDeckColors(); renderRibbon(); refreshPlayerDropdown(); renderActivePane();
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

/* =================== BOOT =================== */
load(); bindStatic(); renderAll();
if(CLOUD_URL) pullCloud(true);   // silently refresh from shared ledger on open
