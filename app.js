// ---- Bar chart race ----
// Builds a per-event running-total timeline from data.events, then animates
// the leaderboard bars growing/reordering over time. Self-contained: only
// touches #race-canvas, #race-play, #race-scrub, #race-date.
 
const RACE_COLORS = [
  '#4e79a7', '#f28e2b', '#e15759', '#76b7b2', '#59a14f',
  '#edc948', '#b07aa1', '#ff9da7', '#9c755f', '#bab0ac', '#86bcb6'
];
 
let raceState = null; // holds frames + animation handles, rebuilt each time data refreshes
 
function buildRaceFrames(events) {
  // Sort defensively by timestamp in case events arrive out of order.
  const sorted = [...events].sort((a, b) => a.ts - b.ts);
 
  const totals = {};
  const colorFor = {};
  let colorIdx = 0;
 
  const frames = sorted.map(ev => {
    const amount = typeof ev.count === 'number' ? ev.count : 1;
    totals[ev.sender] = (totals[ev.sender] || 0) + amount;
    if (!(ev.sender in colorFor)) {
      colorFor[ev.sender] = RACE_COLORS[colorIdx % RACE_COLORS.length];
      colorIdx++;
    }
    // Snapshot totals so each frame is independent of later mutation.
    return { ts: ev.ts, totals: { ...totals } };
  });
 
  return { frames, colorFor };
}
 
function setupRace(data) {
  console.log('setupRace called', data.events && data.events.length);
  const canvas = document.getElementById('race-canvas');
  const scrub = document.getElementById('race-scrub');
  const playBtn = document.getElementById('race-play');
  const dateLabel = document.getElementById('race-date');
  if (!canvas || !data.events || data.events.length === 0) return;
 
  const { frames, colorFor } = buildRaceFrames(data.events);
  const ctx = canvas.getContext('2d');
 
  // Preserve playhead position across data refreshes where possible.
  const prevIndex = raceState ? raceState.index : frames.length - 1;
  const wasPlaying = raceState ? raceState.playing : false;
  if (raceState && raceState.timer) clearInterval(raceState.timer);
 
  raceState = {
    frames,
    colorFor,
    index: Math.min(prevIndex, frames.length - 1),
    playing: false,
    timer: null
  };
 
  scrub.max = String(frames.length - 1);
  scrub.value = String(raceState.index);
 
  function drawFrame(i) {
    const frame = frames[i];
    if (!frame) return;
 
    const entries = Object.entries(frame.totals).sort((a, b) => b[1] - a[1]);
    const maxVal = entries.length ? entries[0][1] : 1;
 
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
      ctx.fillText(String(value), labelW + barW + 6, y + rowH / 2);
    });
 
    const d = new Date(frame.ts * 1000);
    dateLabel.textContent = d.toLocaleString();
  }
 
  function goTo(i) {
    raceState.index = Math.max(0, Math.min(i, frames.length - 1));
    scrub.value = String(raceState.index);
    drawFrame(raceState.index);
  }
 
  function play() {
    if (raceState.playing) return;
    raceState.playing = true;
    playBtn.textContent = 'Pause';
    raceState.timer = setInterval(() => {
      if (raceState.index >= frames.length - 1) {
        pause();
        return;
      }
      goTo(raceState.index + 1);
    }, 120); // ms per event step
  }
 
  function pause() {
    raceState.playing = false;
    playBtn.textContent = 'Play';
    if (raceState.timer) clearInterval(raceState.timer);
    raceState.timer = null;
  }
 
  playBtn.onclick = () => (raceState.playing ? pause() : play());
  scrub.oninput = (e) => {
    pause();
    goTo(Number(e.target.value));
  };
 
  drawFrame(raceState.index);
  if (wasPlaying) play();
}
 



async function load() {
  try {
    const r = await fetch(`pints.json?t=${Date.now()}`, {cache: 'no-store'});
    if (!r.ok) throw new Error('No data');
    const data = await r.json();
    const table = document.querySelector('#totals tbody');
    table.innerHTML = '';
    const rows = Object.entries(data.totals || {}).sort((a,b)=>b[1]-a[1]);
    for (const [name,count] of rows) {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${escapeHtml(name)}</td><td>${count}</td>`;
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