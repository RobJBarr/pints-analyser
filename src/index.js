const fs = require('fs');
const path = require('path');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const qrcodeTerminal = require('qrcode-terminal');
const express = require('express');
const { exec } = require('child_process');

// Logging utility with timestamps
function log(msg) { console.log(`[${new Date().toISOString()}] ${msg}`); }
function logError(msg) { console.error(`[${new Date().toISOString()}] ERROR: ${msg}`); }
function logWarn(msg) { console.warn(`[${new Date().toISOString()}] WARN: ${msg}`); }

const ROOT = process.cwd();
const MESSAGES_PATH = path.join(ROOT, 'messages.json');
const PINTS_PATH = path.join(ROOT, 'pints.json');
const MEDIA_DIR = path.join(ROOT, 'media');
if (!fs.existsSync(MEDIA_DIR)) fs.mkdirSync(MEDIA_DIR, { recursive: true });

function safeRead(p){ try { return JSON.parse(fs.readFileSync(p,'utf8')); } catch(e){ return {messages:[]}; } }
function safeWrite(p,obj){ fs.writeFileSync(p,JSON.stringify(obj,null,2),'utf8'); }

// Utilities
function extractNumberFromText(s){ if (!s) return null; const m = s.match(/(\d+)/); return m? parseInt(m[1],10):null; }
function hasPlaneEmoji(text){ if(!text) return false; return /✈|\u2708/.test(text); }
function markHattricks(events) {
  let streakSender = null;
  let streakCount = 0;

  return events.map(event => {
    const sender = event.sender;

    if (sender === streakSender) {
      streakCount++;
    } else {
      streakSender = sender;
      streakCount = 1;
    }

    if (streakCount === 3) {
      streakCount = 0;       // reset so the next hattrick needs 3 fresh consecutive events
      streakSender = null;   // force a restart even if the same sender keeps posting
      return { ...event, hattrick: true };
    }

    return { ...event, hattrick: false };
  });
}
function computeTotals(messages){
  log(`[COMPUTE] Starting to compute totals from ${messages.length} messages`);
  // Simple count: just tally image messages per sender (no multipliers, no rules)
  const totals = {};
  const away_goals = {};
  let events = [];
  const hatties = {};
  let imageCount = 0;
  for (let i=0;i<messages.length;i++){
    const m = messages[i];
    if (m.type !== 'image') continue;
    if (m.is_gif) continue; 
    if (m.cancelled) continue;
    
    // Resolve sender ID to name using cache, fallback to ID
    const senderId = m.sender || 'unknown';
    const senderName = contactNameCache[senderId] || senderId;
    if (m.away_goal) {console.log("AWAY GOAL", m, senderName);}
    events.push({ id: m.id, ts: m.ts, sender: senderName, count: 1, reactions: m.reactions, message: m.text, away_goal: m.away_goal});
  }
  log(`[COMPUTE] Found ${events.length} image events, now checking for hattricks and away goals`);
  events = markHattricks(events);
  for (const event of events) {
    const senderName = event.sender;
    imageCount++;
    totals[senderName] = (totals[senderName]||0) + 1;
    if (event.hattrick) {
      imageCount++;
      event.count += 1; // count the hattrick bonus
      hatties[senderName] = (hatties[senderName]||0) + 1;
      totals[senderName] = (totals[senderName]||0) + 1;
    }
    if (event.away_goal) {
      event.count += 1; // count the away goal bonus
      imageCount++;
      away_goals[senderName] = (away_goals[senderName]||0) + 1;
      totals[senderName] = (totals[senderName]||0) + 1;
    }
  }

  log(`[COMPUTE] Found ${imageCount} submissions from ${Object.keys(totals).length} senders, including ${Object.values(hatties).reduce((a,b)=>a+b, 0)} hattricks, and ${Object.values(away_goals).reduce((a,b)=>a+b, 0)} away goals`);
  for (const [sender, count] of Object.entries(totals)) {
    log(`[COMPUTE]   ${sender}: ${count} images, hattricks: ${hatties[sender] || 0}, away goals: ${away_goals[sender] || 0}`);
  }

  return {events, totals, hatties, away_goals};
}

function dedupeAndMerge(existingMessages, incoming){
  const map = new Map();
  for (const m of existingMessages) map.set(m.id, m);
  let added = 0;
  for (const m of incoming){ if (!map.has(m.id)) { map.set(m.id, m); added++; } }
  const arr = Array.from(map.values()).sort((a,b)=>{ const ta = a.ts?Number(a.ts):0; const tb = b.ts?Number(b.ts):0; return ta - tb; });
  return {merged: arr, added};
}

// Git commit helper (assumes SSH or credentials already set up)
function gitCommitPush(message, files){
  const filesArg = (files && files.length)? files.join(' '): 'pints.json messages.json';
  const cmd = `git add ${filesArg} && (git diff --staged --quiet || (git commit -m "${message}" && git push))`;
  exec(cmd, { cwd: ROOT }, (err, stdout, stderr) => {
    if (err) logError('git push error:', err.message);
    else log('git commit/push done');
  });
}

// State
let lastQrDataUrl = null;
let lastQrString = null;
let contactNameCache = {}; // ID -> name mapping

// Create client with local auth for persistence
const CLIENT_ID = process.env.CLIENT_ID || 'pints-listener';
const client = new Client({
  authStrategy: new LocalAuth({ clientId: CLIENT_ID }),
  puppeteer: {
    headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage']
  }
});

client.on('qr', async (qr) => {
  log('[CLIENT] QR code received');
  lastQrString = qr;
  log('[CLIENT] Displaying QR Code:');
  qrcodeTerminal.generate(qr, {small:true});
  try { lastQrDataUrl = await qrcode.toDataURL(qr); log('[CLIENT] QR Data URL generated'); } catch(e){ lastQrDataUrl = null; logError('[CLIENT] Failed to generate QR data URL'); }
  log('[CLIENT] Scan the QR code with WhatsApp to authenticate');
});

client.on('ready', async () => {
  log('[CLIENT] ✓ WhatsApp client ready and authenticated');

  lastQrDataUrl = null;
  lastQrString = null;
  // Optional auto-scan on ready if environment variable set
  try {
    const auto = String(process.env.SCAN_PREFIX_ON_READY || '').toLowerCase();
    const scanSelf = String(process.env.SCAN_SELF || '').toLowerCase();
    log(`[CLIENT] Performing initial scan`);
    const prefix = process.env.SCAN_PREFIX || '1500 PINTS';
    log(`[CLIENT] Auto-scan starting (prefix='${prefix}')`);
    try {
      log(`[CLIENT] Fetching all chats...`);
      const chats = await client.getChats();
      log(`[CLIENT] Got ${chats.length} chats, filtering by prefix...`);
      const matches = chats.filter(c => ((c.name || c.formattedTitle || '')).startsWith(prefix));
      if (matches.length === 0) {
        logWarn('[CLIENT] Auto-scan: no matching chats found');
      } else {
        log(`[CLIENT] Found ${matches.length} matching chats`);
        // choose most-recently active match if available
        let best = matches[0];
        for (const c of matches) {
          const a = c.lastMessage && c.lastMessage.timestamp ? Number(c.lastMessage.timestamp) : 0;
          const b = best.lastMessage && best.lastMessage.timestamp ? Number(best.lastMessage.timestamp) : 0;
          if (a > b) best = c;
        }
        log(`[CLIENT] Selected chat: ${best.name || best.formattedTitle || best.id}`);
        const msgs = await fetchAllMessagesFromChat(best);
        await persistFullAndRecompute(msgs);
        log(`[CLIENT] ✓ Auto-scan completed for ${best.name || best.formattedTitle || best.id}`);
      }
    } catch (e) { console.log(e); logError('Error during auto-scan', e && e.stack || e);  }
  } catch (e) { logError('Error while processing auto-scan setting', e && e.stack || e); }
});

client.on('auth_failure', msg => { logError('Auth failure', msg); });

// Fetch entire chat history and normalize messages
async function fetchAllMessagesFromChat(chat){
  log(`[FETCH] Starting fetch from chat: ${chat.name || chat.formattedTitle || chat.id}`);
  const batch = 200;
  let batchCount = 0;
  let all = []
  try{
   all = await chat.fetchMessages({ limit: 1000000 });
  //  all.map(m => {
  //   const id = m.id && (m.id._serialized || m.id) || `msg-${m.timestamp || Date.now()}`;
  //   const ts = m.timestamp || Date.now();
  //   // Use author if available (group chats), fallback to from
  //   const sender = m.author || m.from || 'unknown';
  //   const type = (m.hasMedia || m.type === 'image') ? 'image' : (m.type || 'text');
  //   const text = m.caption || m.body || '';
  //   const reactions = m.getReactions() || [];
  //   const cancelled = false;
  //   return { id, ts, sender, type, text, reactions, cancelled, chatId: (chat.id && chat.id._serialized) || chat.id || null, chatName: chat.name || chat.formattedTitle || null };
  //  });
  //  while (true){
  //    const options = lastId ? { limit: batch, before: lastId } : { limit: batch };
  //    log(`[FETCH] Fetching batch ${++batchCount} (${batch} messages)`);
  //    // fetchMessages returns newest-first
  //    const msgs = await chat.fetchMessages(options);
  //    if (!msgs || msgs.length === 0) {
  //      log(`[FETCH] Batch ${batchCount} returned 0 messages, done fetching`);
  //      break;
  //    }
  //    all = all.concat(msgs);
  //    log(`[FETCH] Batch ${batchCount}: got ${msgs.length} messages (total: ${all.length})`);
  //    if (msgs.length < batch) {
  //      log(`[FETCH] Batch ${batchCount} has less than ${batch} messages, reached end`);
  //      break;
  //    }
  //    const oldest = msgs[msgs.length - 1];
  //    lastId = oldest.id && (oldest.id._serialized || oldest.id) || null;
  //  }
  } catch(e){ logError(`[FETCH] Error fetching messages: ${e && e.stack || e}`); }
   
   // Collect unique sender IDs and fetch contact info
   const senderIds = new Set();
   for (const m of all) {
    const senderId = m.author || m.from || null;
    if (senderId && typeof senderId === 'string') senderIds.add(senderId);
   }
   log(`[FETCH] Found ${senderIds.size} unique senders, fetching contact info...`);
   
   // Fetch contact names for all senders
   let contactsResolved = 0;
   for (const senderId of senderIds) {
    try {
      const contact = await client.getContactById(senderId);
      if (contact && contact.name) {
        contactNameCache[senderId] = contact.name;
        log(`[FETCH] Cached contact: ${senderId} -> ${contact.name}`);
        contactsResolved++;
      }
    } catch (e) {
      logWarn(`[FETCH] Could not fetch contact for ${senderId}: ${e.message}`);
    }
   }
   log(`[FETCH] Resolved ${contactsResolved}/${senderIds.size} contact names`);
   
   // normalize and include chat metadata
   log(`[FETCH] Normalizing ${all.length} messages...`);
   const normalized = await Promise.all(all.map(async m => {
    
    const id = m.id && (m.id._serialized || m.id) || `msg-${m.timestamp || Date.now()}`;
    const ts = m.timestamp || Date.now();
    // Use author if available (group chats), fallback to from
    const sender = m.author || m.from || 'unknown';
    const type = (m.type === "video" || m.type === 'image') ? 'image' : (m.type || 'text');
    const text = m.caption || m.body || '';
    const reactions = await m.getReactions() || [];
    
    const cancelled = reactions.some(item => item.aggregateEmoji === "🚫" || item.aggregateEmoji === "❌");
    const away_goal = reactions.some(item => item.aggregateEmoji === '✈' || item.aggregateEmoji === '\u2708');
    if (text == "20"){
      console.log("20", m, reactions, cancelled, away_goal);
    }
    const is_gif = m.isGif;
    return { id, ts, sender, type, text, cancelled, away_goal, is_gif, chatId: (chat.id && chat.id._serialized) || chat.id || null, chatName: chat.name || chat.formattedTitle || null };
   }));
   log(`[FETCH] Complete: ${normalized.length} messages normalized`);
   return normalized;
}

async function persistFullAndRecompute(messages){
  // messages should be chronological (oldest first)
  log(`[PERSIST] Writing ${messages.length} messages to messages.json`);
  safeWrite(MESSAGES_PATH, { messages });
  log(`[PERSIST] Computing totals...`);
  const { events, totals, hatties, away_goals} = computeTotals(messages);
  const out = { updated_at: new Date().toISOString(), totals, events, hatties, away_goals};
  log(`[PERSIST] Writing pints.json with ${Object.keys(totals).length} totals and ${events.length} events`);
  safeWrite(PINTS_PATH, out);
  log(`[PERSIST] Committing to git...`);
  gitCommitPush('Update pints data [auto]', ['pints.json']);
  log(`[PERSIST] Complete`);
}

// Helper: build list of candidate self IDs from client.info and env
function buildSelfIdCandidates() {
  const ids = new Set();
  try {
    if (process.env.DEV_SELF_CHAT_ID) ids.add(process.env.DEV_SELF_CHAT_ID);
    if (client && client.info) {
      for (const k of Object.keys(client.info)) {
        const v = client.info[k];
        if (!v) continue;
        if (typeof v === 'string') ids.add(v);
        if (typeof v === 'object') {
          if (v._serialized) ids.add(String(v._serialized));
          if (v.id) ids.add(String(v.id));
          if (v.user) ids.add(String(v.user));
        }
      }
    }
  } catch (e) { /* ignore */ }
  return Array.from(ids).filter(Boolean);
}

// On any message, if it belongs to a chat starting with configured prefix or is the user's self-chat (dev option), fetch the full chat and recompute
client.on('message_create', async (message) => {
  try{
    const chat = await message.getChat();
    const prefix = process.env.SCAN_PREFIX || '1500 PINTS';
    const title = (chat.name || chat.formattedTitle || '').toString();

    const scanSelfEnabled = String(process.env.SCAN_SELF || process.env.DEV_SCAN_SELF || '').toLowerCase() === '1' || String(process.env.SCAN_SELF || process.env.DEV_SCAN_SELF || '').toLowerCase() === 'true';
    let isSelfChat = false;
    if (scanSelfEnabled) {
      const candidates = buildSelfIdCandidates();
      try {
        const chatId = (chat.id && (chat.id._serialized || chat.id)) || '';
        const chatIdNoDomain = chatId.split && chatId.split('@')[0];
        for (const c of candidates) {
          if (!c) continue;
          if (String(chatId).includes(String(c)) || (chatIdNoDomain && String(c).includes(chatIdNoDomain)) || String(c).includes(chatIdNoDomain)) { isSelfChat = true; break; }
          // also match by title if user sets DEV_SELF_CHAT_TITLE
          if (process.env.DEV_SELF_CHAT_TITLE && ((chat.name || chat.formattedTitle || '') === process.env.DEV_SELF_CHAT_TITLE)) { isSelfChat = true; break; }
        }
      } catch (e) { /* ignore */ }
    }

    if ((title && title.toLowerCase().startsWith(String(prefix).toLowerCase())) || isSelfChat) {
      log(`Message received in matched chat '${title || (chat.id && chat.id._serialized) || 'unknown'}' — full rescan`);
      const all = await fetchAllMessagesFromChat(chat);
      await persistFullAndRecompute(all);
    } else {
      // ignore messages from other chats
    }
  } catch(e){ logError('message handling error', e && e.stack || e); }
});

const app = express();

// HTTP endpoints to trigger scans manually
app.get('/scanAll', async (req, res) => {
  try {
    const chats = await client.getChats();
    const combined = [];
    for (const chat of chats) {
      chat.name
      const msgs = await fetchAllMessagesFromChat(chat);
      combined.push(...msgs);
    }
    // sort combined chronologically
    combined.sort((a,b)=> (Number(a.ts)||0) - (Number(b.ts)||0));
    await persistFullAndRecompute(combined);
    res.json({ status: 'ok', scanned: chats.length });
  } catch (e) {
    logError('scanAll error', e && e.stack || e);
    res.status(500).json({ error: String(e) });
  }
});

app.get('/scan', async (req, res) => {
  const title = req.query.title;
  if (!title) return res.status(400).json({ error: 'missing title query param' });
  try {
    const chats = await client.getChats();
    const found = chats.find(c => c.name === title || c.formattedTitle === title || String(c.id) === title);
    if (!found) return res.status(404).json({ error: 'chat not found' });
    const msgs = await fetchAllMessagesFromChat(found);
    await persistFullAndRecompute(msgs);
    res.json({ status: 'ok', scanned: found.name || found.formattedTitle || String(found.id) });
  } catch (e) {
    logError('scan error', e && e.stack || e);
    res.status(500).json({ error: String(e) });
  }
});

// Scan a chat by prefix match (useful when chat name changes but starts with a known prefix)
app.get('/scanPrefix', async (req, res) => {
  log(`[API] /scanPrefix request received (prefix=${req.query.prefix || '1500 PINTS'})`);
  if (!client || !client.info) {
    logWarn('[API] Client not ready');
    return res.status(503).json({ error: 'WhatsApp client not ready' });
  }
  const prefix = req.query.prefix || '1500 PINTS';
  try {
    log(`[API] Fetching chats...`);
    const chats = await client.getChats();
    log(`[API] Got ${chats.length} chats, filtering for prefix '${prefix}'`);
    const matches = chats.filter(c => ((c.name || c.formattedTitle || '')).startsWith(prefix));
    log(`[API] Found ${matches.length} matching chats`);
    if (!matches || matches.length === 0) {
      logWarn('[API] No chats matching prefix');
      return res.status(404).json({ error: 'no chats matching prefix' });
    }
    // select the most recently active matching chat when multiple present
    let best = matches[0];
    for (const c of matches) {
      const a = c.lastMessage && c.lastMessage.timestamp ? Number(c.lastMessage.timestamp) : 0;
      const b = best.lastMessage && best.lastMessage.timestamp ? Number(best.lastMessage.timestamp) : 0;
      if (a > b) best = c;
    }
    log(`[API] Selected chat: ${best.name || best.formattedTitle || String(best.id)}`);
    log(`[API] Fetching all messages from chat...`);
    const msgs = await fetchAllMessagesFromChat(best);
    log(`[API] Got ${msgs.length} messages, computing totals...`);
    await persistFullAndRecompute(msgs);
    log(`[API] Scan complete, responding with results`);
    res.json({ status: 'ok', scanned: best.name || best.formattedTitle || String(best.id) });
  } catch (e) {
    logError(`[API] scanPrefix error: ${e && e.stack || e}`);
    res.status(500).json({ error: String(e) });
  }
});

// Express server to show status and QR for remote scanning if you expose it
app.get('/status', (req,res)=>{
  log(`[API] /status request received`);
  const p = safeRead(PINTS_PATH) || { updated_at: null, totals: {} };
  res.json(p);
});
app.get('/qr', async (req,res)=>{
  log(`[API] /qr request received`);
  if (lastQrDataUrl) {
    const parts = lastQrDataUrl.split(',');
    const mime = parts[0].match(/data:(.*);base64/)[1];
    const b64 = parts[1];
    const buf = Buffer.from(b64, 'base64');
    res.set('Content-Type', mime);
    log(`[API] Returning QR code (${buf.length} bytes)`);
    res.send(buf);
  } else if (lastQrString){
    const img = await qrcode.toDataURL(lastQrString).catch(()=>null);
    if (img) {
      log(`[API] Generating QR code from string`);
      return res.type('png').send(Buffer.from(img.split(',')[1],'base64'));
    }
    logWarn(`[API] QR not available`);
    return res.status(404).send('QR not available');
  } else return res.status(404).send('QR not available');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, ()=> log(`[STARTUP] Express server listening on port ${PORT}`));

log('[STARTUP] Initializing WhatsApp client...');
try {
  client.initialize().catch(e => {
    const msg = String(e && e.message || e);
    if (msg.includes("auth timeout") || msg.includes("onQRChangedEvent") || msg.includes("already exists")) {
      logWarn(`[STARTUP] Auth timeout or QR binding issue: ${msg}. Continuing...`);
    } else {
      logError(`[STARTUP] Failed to initialize client: ${e && e.stack || e}`);
      process.exit(1);
    }
  });
} catch (e) {
  const msg = String(e && e.message || e);
  if (msg.includes("onQRChangedEvent") || msg.includes("already exists")) {
    logWarn(`[STARTUP] QR binding already exists. Continuing...`);
  } else {
    logError('Failed to initialize client:', e && e.stack || e);
    process.exit(1);
  }
}

process.on('SIGINT', () => { log('SIGINT'); client.destroy().then(()=>process.exit(0)); });
process.on('SIGTERM', () => { log('SIGTERM'); client.destroy().then(()=>process.exit(0)); });
