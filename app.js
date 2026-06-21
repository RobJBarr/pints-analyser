async function load() {
  try {
    console.log('About to load pints.json');
    const r = await fetch(`pints.json?t=${Date.now()}`, {cache: 'no-store'});
    if (!r.ok) throw new Error('No data');
    console.log('Loaded pints.json');
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
  } catch (e) {
    document.getElementById('last-updated').textContent = 'No pints data yet.';
  }
}
function escapeHtml(s){return String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]))}
load();
setInterval(load, 30_000);