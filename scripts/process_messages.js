/*
 Processor for WhatsApp webhook payloads delivered via repository_dispatch.
 It reads the event payload from GITHUB_EVENT_PATH, appends new message(s) to messages.json,
 then recalculates pints totals according to rules:
  - Each pint is an image post; the number is in the image message text or immediately after (a separate message containing a number).
  - If a user posts 3 pints in a row, the 3rd (last) counts double.
  - Any message with a cancel reaction (❌ or ✖️) is ignored.
  - Any picture message containing a plane emoji (✈️ / \u2708) counts double.

 The script writes updated messages.json and pints.json (aggregated totals + events) so GitHub Pages can serve pints.json.
*/

const fs = require('fs');
const path = require('path');

const ROOT = process.cwd();
const MESSAGES_PATH = path.join(ROOT, 'messages.json');
const PINTS_PATH = path.join(ROOT, 'pints.json');

function safeRead(p){try{return JSON.parse(fs.readFileSync(p,'utf8'))}catch(e){return null}}
function safeWrite(p,obj){fs.writeFileSync(p,JSON.stringify(obj,null,2),'utf8')}

function normalizeIncoming(raw){
  // try various shapes: client_payload may contain "messages" array, or the payload itself may be a message
  let payload = raw.client_payload || raw;
  let arr = payload.messages || payload.message ? (payload.messages || [payload.message]) : (Array.isArray(payload)?payload:[]);
  // Some relays may pass the whole webhook body under payload.whatsapp or payload.entry
  if (!arr.length && payload.entry) {
    // try to extract messages in Meta webhook style
    try {
      const entry = Array.isArray(payload.entry)?payload.entry[0]:payload.entry;
      const changes = entry && entry.changes && entry.changes[0];
      const val = changes && changes.value;
      if (val && val.messages) arr = val.messages;
    } catch(e){}
  }
  return arr.map(m=>{
    // Normalize common fields used below
    const id = m.id || m.message_id || (m.timestamp?`${m.timestamp}-${m.from||m.author||m.sender}`:Math.random().toString(36).slice(2));
    const ts = m.timestamp || m.t || null;
    const sender = m.from || m.author || (m.sender && (m.sender.name || m.sender.id)) || (m.from && m.from.split(':').pop()) || 'unknown';
    const type = m.type || (m.message && m.message.type) || (m.text? 'text' : (m.image? 'image' : 'unknown'));
    const text = (m.text && (m.text.body || m.text)) || m.caption || (m.body) || '';
    const image = m.image || (m.type==='image' && m) || null;
    const reactions = m.reactions || m.message && m.message.reactions || [];
    return {id, ts, sender, type, text: String(text||''), image, reactions};
  });
}

function extractNumberFromText(s){
  if (!s) return null;
  const m = s.match(/(\d+)/);
  return m? parseInt(m[1],10) : null;
}

function hasCancelReaction(reactions){
  if(!reactions) return false;
  // reactions might be array of objects or strings
  const arr = Array.isArray(reactions)?reactions:[];
  for (const r of arr){
    const v = (typeof r === 'string')? r : (r.emoji || r.reaction || r.type || '');
    if (!v) continue;
    if (v.includes('❌') || v.includes('✖') || v.includes('x') ) return true;
  }
  return false;
}

function hasPlaneEmoji(text, reactions){
  if (hasEmoji(text,'✈') || hasEmoji(text,'\u2708') ) return true;
  if (!reactions) return false;
  return reactions.some(r=>{ const v = typeof r==='string'?r:(r.emoji||r.reaction||''); return /✈|\u2708/.test(v); });
}
function hasEmoji(text,emoji){ return typeof text==='string' && text.indexOf(emoji)!==-1 }

function computeTotals(messages){
  // messages must be chronological
  const events = [];
  const totals = {};
  // mark consumed messages (when the "number" is in a following text message)
  const consumed = new Set();

  for (let i=0;i<messages.length;i++){
    const m = messages[i];
    if (consumed.has(m.id)) continue;
    // Only image posts count as pint events (per spec)
    if (m.type !== 'image') continue;
    // ignore cancelled
    if (hasCancelReaction(m.reactions)) continue;
    // base number: try text in image message, otherwise immediate next message by same sender if it's a plain number
    let n = extractNumberFromText(m.text);
    let usedNext = false;
    if (n === null) {
      const nxt = messages[i+1];
      if (nxt && nxt.sender === m.sender && nxt.type === 'text'){
        const maybe = extractNumberFromText(nxt.text.trim());
        if (maybe !== null){ n = maybe; consumed.add(nxt.id); usedNext = true; }
      }
    }
    if (n === null) n = 1; // default to 1 pint if no number found

    // modifiers
    let multiplier = 1;
    if (hasPlaneEmoji(m.text, m.reactions)) multiplier *= 2;

    events.push({id:m.id, ts:m.ts, sender:m.sender, base:n, multiplier, usedNext});
  }

  // apply 3-in-a-row rule: if a user has 3 consecutive pint events, the 3rd counts double
  // iterate events in chronological order
  const byIdx = events;
  const consec = {}; // sender => running consecutive count
  for (let i=0;i<byIdx.length;i++){
    const e = byIdx[i];
    consec[e.sender] = (consec[e.sender]||0) + 1;
    // reset others
    for (const s of Object.keys(consec)) if (s!==e.sender) consec[s]=0;
    if (consec[e.sender] === 3) {
      e.multiplier *= 2; // last pint counts double
      consec[e.sender] = 0; // reset after applying
    }
  }

  // aggregate totals
  for (const e of events){
    const count = e.base * e.multiplier;
    totals[e.sender] = (totals[e.sender]||0) + count;
  }

  return {events, totals};
}

function dedupeAndMerge(existingMessages, incoming){
  const map = new Map();
  for (const m of existingMessages) map.set(m.id, m);
  let added = 0;
  for (const m of incoming){
    if (!map.has(m.id)) { map.set(m.id, m); added++; }
  }
  // sort by ts (string/numeric) if available
  const arr = Array.from(map.values()).sort((a,b)=>{
    const ta = a.ts?Number(a.ts):0; const tb = b.ts?Number(b.ts):0; return ta - tb;
  });
  return {merged: arr, added};
}

function main(){
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) { console.error('GITHUB_EVENT_PATH not set'); process.exit(1); }
  const raw = JSON.parse(fs.readFileSync(eventPath,'utf8')) || {};
  const incoming = normalizeIncoming(raw);
  if (!incoming.length) { console.log('No messages in payload.'); process.exit(0); }

  const existing = safeRead(MESSAGES_PATH) || {messages:[]};
  const {merged, added} = dedupeAndMerge(existing.messages, incoming);
  if (added===0) { console.log('No new messages to add.'); }
  // persist messages
  safeWrite(MESSAGES_PATH, {messages: merged});

  // compute totals
  const {events, totals} = computeTotals(merged);

  const out = { updated_at: new Date().toISOString(), totals, events };
  safeWrite(PINTS_PATH, out);
  console.log(`Processed payload: incoming=${incoming.length} added=${added} totals=${Object.keys(totals).length}`);
}

main();
