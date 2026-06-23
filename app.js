// ---- Bar chart race (smooth) ----
// Builds a per-event running-total timeline from data.events, then animates
// the leaderboard with smooth interpolation between event frames using
// requestAnimationFrame, so bars glide rather than snap.
 
const RACE_COLORS = [
  '#4e79a7', '#f28e2b', '#e15759', '#76b7b2', '#59a14f',
  '#edc948', '#b07aa1', '#ff9da7', '#9c755f', '#bab0ac', '#86bcb6'
];
 
const RACE_MS_PER_STEP = 600; // how long each event-to-event transition takes
 
let raceState = null;
 
function buildRaceFrames(events) {
  const sorted = [...events].sort((a, b) => a.ts - b.ts);
 
  const totals = {};
  const colorFor = {};
  let colorIdx = 0;
 
  // Frame 0 is the "empty" starting state, so the very first event
  // animates in from zero rather than appearing instantly.
  const frames = [{ ts: sorted.length ? sorted[0].ts : 0, totals: {} }];
 
  for (const ev of sorted) {
    const amount = typeof ev.count === 'number' ? ev.count : 1;
    totals[ev.sender] = (totals[ev.sender] || 0) + amount;
    if (!(ev.sender in colorFor)) {
      colorFor[ev.sender] = RACE_COLORS[colorIdx % RACE_COLORS.length];
      colorIdx++;
    }
    frames.push({ ts: ev.ts, totals: { ...totals } });
  }
 
  return { frames, colorFor };
}
 
// Linearly interpolate between two {name: value} total snapshots.
function interpolateTotals(a, b, t) {
  const names = new Set([...Object.keys(a), ...Object.keys(b)]);
  const out = {};
  for (const name of names) {
    const av = a[name] || 0;
    const bv = b[name] || 0;
    out[name] = av + (bv - av) * t;
  }
  return out;
}
 
function setupRace(data) {
  const canvas = document.getElementById('race-canvas');
  const scrub = document.getElementById('race-scrub');
  const playBtn = document.getElementById('race-play');
  const dateLabel = document.getElementById('race-date');
  if (!canvas || !data.events || data.events.length === 0) return;
 
  const { frames, colorFor } = buildRaceFrames(data.events);
  const ctx = canvas.getContext('2d');
 
  const prevIndex = raceState ? raceState.index : 0; // start at the beginning on first load
  const wasPlaying = raceState ? raceState.playing : false;
  if (raceState && raceState.rafId) cancelAnimationFrame(raceState.rafId);
 
  raceState = {
    frames,
    colorFor,
    index: Math.min(prevIndex, frames.length - 1), // index of the frame we're animating FROM
    progress: 0,        // 0..1 progress toward frames[index + 1]
    playing: false,
    rafId: null,
    lastTick: null
  };
 
  scrub.max = String(frames.length - 1);
  scrub.value = String(raceState.index);
 
  function currentDisplayTotals() {
    const a = frames[raceState.index];
    const b = frames[Math.min(raceState.index + 1, frames.length - 1)];
    return interpolateTotals(a.totals, b.totals, raceState.progress);
  }
 
  function draw() {
    const totals = currentDisplayTotals();
    const entries = Object.entries(totals).sort((a, b) => b[1] - a[1]);
    const maxVal = entries.length ? Math.max(entries[0][1], 1) : 1;
 
    const w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);
 
    const rowH = h / Math.max(entries.length, 1);
    const labelW = 160;
    const barAreaW = w - labelW - 50;
 
    ctx.font = '13px system-ui, sans-serif';
    ctx.textBaseline = 'middle';
 
    entries.forEach(([name, value], idx) => {
      const y = idx * rowH;
      const barH = rowH * 0.7;
      const barW = Math.max((value / maxVal) * barAreaW, 2);
 
      ctx.fillStyle = colorFor[name] || '#888';
      ctx.fillRect(labelW, y + (rowH - barH) / 2, barW, barH);
 
      ctx.fillStyle = '#222';
      ctx.textAlign = 'right';
      ctx.fillText(name, labelW - 8, y + rowH / 2);
 
      ctx.textAlign = 'left';
      ctx.fillText(value.toFixed(1), labelW + barW + 6, y + rowH / 2);
    });
 
    const frame = frames[raceState.index];
    const d = new Date(frame.ts * 1000);
    dateLabel.textContent = d.toLocaleString();
  }
 
  function tick(now) {
    if (!raceState.playing) return;
    if (raceState.lastTick === null) raceState.lastTick = now;
    const dt = now - raceState.lastTick;
    raceState.lastTick = now;
 
    raceState.progress += dt / RACE_MS_PER_STEP;
 
    while (raceState.progress >= 1 && raceState.index < frames.length - 1) {
      raceState.progress -= 1;
      raceState.index += 1;
    }
 
    if (raceState.index >= frames.length - 1) {
      raceState.progress = 0;
      pause();
      scrub.value = String(raceState.index);
      draw();
      return;
    }
 
    scrub.value = String(raceState.index);
    draw();
    raceState.rafId = requestAnimationFrame(tick);
  }
 
  function play() {
    if (raceState.playing) return;
    if (raceState.index >= frames.length - 1) {
      raceState.index = 0;
      raceState.progress = 0;
    }
    raceState.playing = true;
    raceState.lastTick = null;
    playBtn.textContent = 'Pause';
    raceState.rafId = requestAnimationFrame(tick);
  }
 
  function pause() {
    raceState.playing = false;
    playBtn.textContent = 'Play';
    if (raceState.rafId) cancelAnimationFrame(raceState.rafId);
    raceState.rafId = null;
  }
 
  function goTo(i) {
    pause();
    raceState.index = Math.max(0, Math.min(i, frames.length - 1));
    raceState.progress = 0;
    scrub.value = String(raceState.index);
    draw();
  }
 
  playBtn.onclick = () => (raceState.playing ? pause() : play());
  scrub.oninput = (e) => goTo(Number(e.target.value));
 
  draw();
  if (wasPlaying) play();
}

async function load() {
  try {
    const r = await fetch(`pints.json?t=${Date.now()}`, {cache: 'no-store'});
    if (!r.ok) throw new Error('No data');
    const data = await r.json();
    const totalPints = Object.values(data.totals || {}).reduce((a,b)=>a+b, 0);
    document.getElementById('total-pints').textContent = totalPints;
    const table = document.querySelector('#totals tbody');
    table.innerHTML = '';
    const rows = Object.entries(data.totals || {}).sort((a,b)=>b[1]-a[1]);
    for (const [name,count] of rows) {
      const tr = document.createElement('tr');
      console.log(name, count, data.hatties?.[name] || 0);
      tr.innerHTML = `<td>${escapeHtml(name)}</td><td>${count}</td><td>${data.hatties?.[name] || 0}</td><td>${data.away_goals?.[name] || 0}</td>`;
      console.log(tr.innerHTML);
      table.appendChild(tr);
    }
    document.getElementById('last-updated').textContent = 'Last updated: ' + (data.updated_at || 'unknown');

    setupRace(data); // <-- add this line

  } catch (e) {
    document.getElementById('last-updated').textContent = 'No pints data yet.';
  }
}
function escapeHtml(s){return String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]))}
load();
setInterval(load, 30_000);