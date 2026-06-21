// Paste this entire script into WhatsApp Web Developer Console (Ctrl+Shift+I -> Console) while viewing the chat you want to extract.
// It will produce a file named chat_pints.json containing raw messages, events, and totals according to the project's rules.

(async function extractChatDataEnhanced() {
  // helper: convert blob to dataURL
  const blobToDataURL = (blob) => new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = rej;
    r.readAsDataURL(blob);
  });

  // helper: try to fetch an image src and return dataURL (or src if fail)
  async function fetchImageAsDataURL(src) {
    try {
      if (!src) return null;
      if (src.startsWith('data:')) return src;
      const resp = await fetch(src, { credentials: 'include' });
      if (!resp.ok) return src;
      const blob = await resp.blob();
      return await blobToDataURL(blob);
    } catch (e) {
      return src; // fallback to original src
    }
  }

  const emojiRegex = /[\u{1F300}-\u{1FAFF}\u{2700}-\u{27BF}\u{2600}-\u{26FF}]/u;

  // select message nodes
  const nodes = Array.from(document.querySelectorAll('div.copyable-text'));
  const messages = [];

  for (const node of nodes) {
    try {
      const pre = node.getAttribute('data-pre-plain-text') || '';
      let timestamp = '';
      let sender = '';
      if (pre) {
        const m = pre.match(/\[(.*?)\]\s*(.*?):/);
        if (m) { timestamp = m[1].trim(); sender = m[2].trim(); }
      }

      const textParts = Array.from(node.querySelectorAll('span.selectable-text, div.selectable-text'))
        .map(el => el.textContent || '')
        .filter(Boolean);

      const imgs = Array.from(node.querySelectorAll('img'))
        .filter(img => {
          const cls = img.className || '';
          if (cls && cls.toString().toLowerCase().includes('emoji')) return false;
          const alt = img.getAttribute('alt') || '';
          if (alt && alt.length <= 2 && emojiRegex.test(alt)) return false;
          const w = img.naturalWidth || img.width || 0;
          const h = img.naturalHeight || img.height || 0;
          if (w && h && Math.max(w,h) < 24) return false;
          return true;
        });

      const bgDiv = Array.from(node.querySelectorAll('div[role="img"]')).filter(d => {
        const bg = window.getComputedStyle(d).backgroundImage || '';
        return bg && bg !== 'none' && bg.includes('url(');
      });

      const reactionEls = Array.from(node.querySelectorAll('*')).filter(el => {
        const txt = (el.textContent || '').trim();
        const title = (el.getAttribute && (el.getAttribute('title') || el.getAttribute('aria-label'))) || '';
        if (emojiRegex.test(txt) && txt.length <= 4) return true;
        if (emojiRegex.test(title)) return true;
        return false;
      });

      const messageText = textParts.join(' ').trim();

      let quotedText = '';
      try {
        const quoted = node.querySelector('div[aria-label="Quoted message"], div._2xZsA');
        if (quoted) {
          const qs = quoted.querySelector('span.selectable-text, div.selectable-text');
          quotedText = qs ? (qs.textContent || '') : (quoted.textContent || '');
        }
      } catch (e) { quotedText = ''; }

      const media = [];
      for (const img of imgs) {
        const src = img.src || img.getAttribute('data-src') || img.getAttribute('data-pre-plain-text') || null;
        const dataUrl = await fetchImageAsDataURL(src);
        media.push({ src, dataUrl });
      }
      for (const d of bgDiv) {
        const bg = window.getComputedStyle(d).backgroundImage || '';
        const m = bg.match(/url\(["']?(.*?)["']?\)/);
        if (m && m[1]) {
          const src = m[1];
          const dataUrl = await fetchImageAsDataURL(src);
          media.push({ src, dataUrl });
        }
      }

      const reactions = Array.from(new Set(reactionEls.map(el => {
        const t = (el.getAttribute && (el.getAttribute('title') || el.getAttribute('aria-label'))) || el.textContent || '';
        const matches = Array.from(t.matchAll(/\p{Extended_Pictographic}/gu)).map(mm => mm[0]);
        if (matches.length) return matches.join('');
        const s = t.trim();
        return s && s.length <= 4 ? s : '';
      }).filter(Boolean)));

      messages.push({
        id: node.getAttribute('data-id') || node.getAttribute('data-pre-plain-text') || Math.random().toString(36).slice(2),
        ts: timestamp,
        sender,
        text: messageText,
        quoted: quotedText,
        type: media.length ? 'image' : 'text',
        media,
        reactions
      });

    } catch (e) {
      console.warn('message parse error', e);
    }
  }

  function extractNumberFromText(s) {
    if (!s) return null;
    const m = s.match(/(\d+)/);
    return m ? parseInt(m[1], 10) : null;
  }
  function hasCancelReaction(reactions) {
    if (!reactions || !reactions.length) return false;
    return reactions.some(r => r.includes('❌') || r.includes('✖') || r.toLowerCase().includes('cancel'));
  }
  function hasPlaneEmoji(text, reactions) {
    if (text && /✈|\u2708/.test(text)) return true;
    if (!reactions) return false;
    return reactions.some(r => /✈|\u2708/.test(r));
  }

  const chronological = messages;
  const events = [];
  for (let i = 0; i < chronological.length; i++) {
    const m = chronological[i];
    if (m.type !== 'image') continue;
    if (hasCancelReaction(m.reactions)) continue;
    let n = extractNumberFromText(m.text) || null;
    if (n === null && chronological[i + 1] && chronological[i + 1].sender === m.sender && chronological[i + 1].type === 'text') {
      const maybe = extractNumberFromText(chronological[i + 1].text || '');
      if (maybe !== null) { n = maybe; }
    }
    if (n === null) n = 1;
    let multiplier = 1;
    if (hasPlaneEmoji(m.text, m.reactions)) multiplier *= 2;
    events.push({ id: m.id, ts: m.ts, sender: m.sender, base: n, multiplier, raw: m });
  }

  const consec = {};
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    consec[e.sender] = (consec[e.sender] || 0) + 1;
    for (const s of Object.keys(consec)) if (s !== e.sender) consec[s] = 0;
    if (consec[e.sender] === 3) { e.multiplier *= 2; consec[e.sender] = 0; }
  }

  const totals = {};
  for (const e of events) {
    const count = e.base * e.multiplier;
    totals[e.sender] = (totals[e.sender] || 0) + count;
  }

  const out = { extracted_at: new Date().toISOString(), messages, events, totals };

  function downloadJSON(filename, obj) {
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
  }

  console.log('Pints totals:', totals);
  downloadJSON('chat_pints.json', out);
  return out;
})();
