const fs = require('fs');
const path = require('path');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const qrcodeTerminal = require('qrcode-terminal');
const express = require('express');
const { exec } = require('child_process');

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

function computeTotals(messages){
  const events = [];
  const totals = {};
  const consumed = new Set();

  for (let i=0;i<messages.length;i++){
    const m = messages[i];
    if (consumed.has(m.id)) continue;
    if (m.type !== 'image') continue;
    if (m.cancelled) continue;
    let n = extractNumberFromText(m.text || m.caption);
    if (n === null) n = 1;
    let multiplier = 1;
    if (hasPlaneEmoji(m.text || m.caption)) multiplier *= 2;
    events.push({id:m.id, ts:m.ts, sender:m.sender, base:n, multiplier});
  }

  const consec = {};
  for (let i=0;i<events.length;i++){
    const e = events[i];
    consec[e.sender] = (consec[e.sender]||0) + 1;
    for (const s of Object.keys(consec)) if (s !== e.sender) consec[s] = 0;
    if (consec[e.sender] === 3){ e.multiplier *= 2; consec[e.sender] = 0; }
  }

  for (const e of events){ const count = e.base * e.multiplier; totals[e.sender] = (totals[e.sender]||0) + count; }
  return {events, totals};
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
    if (err) console.error('git push error:', err.message);
    else console.log('git commit/push done');
  });
}

// State
let lastQrDataUrl = null;
let lastQrString = null;
const pendingImages = new Map(); // sender -> {msgObj, created}

// Create client with local auth for persistence
const client = new Client({
  authStrategy: new LocalAuth({ clientId: 'pints-listener' }),
  puppeteer: {
    headless: true,
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage']
  }
});

client.on('qr', async (qr) => {
  lastQrString = qr;
  qrcodeTerminal.generate(qr, {small:true});
  try { lastQrDataUrl = await qrcode.toDataURL(qr); } catch(e){ lastQrDataUrl = null; }
  console.log('QR received — scan with WhatsApp');
});

client.on('ready', () => { console.log('WhatsApp client ready'); lastQrDataUrl = null; lastQrString = null; });

client.on('auth_failure', msg => { console.error('Auth failure', msg); });

// Helper to persist message and recompute totals
function persistIncomingAndRecompute(incomingList){
  const existing = safeRead(MESSAGES_PATH) || {messages:[]};
  const { merged, added } = dedupeAndMerge(existing.messages, incomingList);
  if (added > 0) console.log(`Added ${added} messages`);
  safeWrite(MESSAGES_PATH, {messages: merged});
  const { events, totals } = computeTotals(merged);
  const out = { updated_at: new Date().toISOString(), totals, events };
  safeWrite(PINTS_PATH, out);
  gitCommitPush('Update pints data [auto]', ['pints.json','messages.json']);
}

// Process image message
async function processImageMessage(message){
  const id = message.id && (message.id._serialized || message.id) || `msg-${Date.now()}`;
  const ts = message.timestamp || Date.now();
  const sender = (message.from || (message._data && message._data.author) || 'unknown');
  let caption = message.caption || message.body || '';

  let mediaSavedPath = null;
  try {
    if (message.hasMedia) {
      const media = await message.downloadMedia();
      if (media && media.data) {
        const ext = (media.mimetype && media.mimetype.split('/').pop()) || 'bin';
        const filename = `${id}.${ext}`;
        const outPath = path.join(MEDIA_DIR, filename);
        fs.writeFileSync(outPath, Buffer.from(media.data, 'base64'));
        mediaSavedPath = outPath;
      }
    }
  } catch(e){ console.warn('Failed to download media', e.message); }

  const msgObj = { id, ts, sender, type: 'image', caption, text: caption, media: mediaSavedPath, cancelled: false };

  const num = extractNumberFromText(caption);
  if (num !== null){ persistIncomingAndRecompute([msgObj]); return; }

  const waitMs = 15000; // 15s window
  pendingImages.set(sender, { msgObj, created: Date.now() });
  setTimeout(() => {
    const p = pendingImages.get(sender);
    if (p && p.msgObj.id === id){
      pendingImages.delete(sender);
      persistIncomingAndRecompute([msgObj]);
    }
  }, waitMs);
}

// Process text message (used to attach numbers or cancel previous image)
async function processTextMessage(message){
  const id = message.id && (message.id._serialized || message.id) || `msg-${Date.now()}`;
  const ts = message.timestamp || Date.now();
  const sender = (message.from || (message._data && message._data.author) || 'unknown');
  const body = message.body || '';

  if (/^cancel$/i.test(body.trim())){
    const existing = safeRead(MESSAGES_PATH) || {messages:[]};
    for (let i = existing.messages.length - 1; i >= 0; i--){
      const m = existing.messages[i];
      if (m.sender === sender && m.type === 'image' && !m.cancelled){ m.cancelled = true; persistIncomingAndRecompute([]); return; }
    }
  }

  const pending = pendingImages.get(sender);
  const n = extractNumberFromText(body.trim());
  if (pending && n !== null){
    pending.msgObj.text = String(n);
    pending.msgObj.caption = pending.msgObj.caption ? pending.msgObj.caption + ' ' + n : String(n);
    pendingImages.delete(sender);
    persistIncomingAndRecompute([pending.msgObj]);
    return;
  }

  const msgObj = { id, ts, sender, type: 'text', text: body };
  persistIncomingAndRecompute([msgObj]);
}

client.on('message', async (message) => {
  try{
    if (message.type === 'image' || message.hasMedia) {
      await processImageMessage(message);
    } else if (message.type === 'chat' || message.type === 'text' || message.body){
      await processTextMessage(message);
    } else {
      const id = message.id && (message.id._serialized || message.id) || `msg-${Date.now()}`;
      const m = { id, ts: message.timestamp || Date.now(), sender: message.from || 'unknown', type: message.type||'unknown', text: message.body || '' };
      persistIncomingAndRecompute([m]);
    }
  } catch(e){ console.error('message handling error', e && e.stack || e); }
});

// Express server to show status and QR for remote scanning if you expose it
const app = express();
app.get('/status', (req,res)=>{
  const p = safeRead(PINTS_PATH) || { updated_at: null, totals: {} };
  res.json(p);
});
app.get('/qr', async (req,res)=>{
  if (lastQrDataUrl) {
    const parts = lastQrDataUrl.split(',');
    const mime = parts[0].match(/data:(.*);base64/)[1];
    const b64 = parts[1];
    const buf = Buffer.from(b64, 'base64');
    res.set('Content-Type', mime);
    res.send(buf);
  } else if (lastQrString){
    const img = await qrcode.toDataURL(lastQrString).catch(()=>null);
    if (img) return res.type('png').send(Buffer.from(img.split(',')[1],'base64'));
    return res.status(404).send('QR not available');
  } else return res.status(404).send('QR not available');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, ()=> console.log(`Status server listening on ${PORT}`));

client.initialize();

process.on('SIGINT', () => { console.log('SIGINT'); client.destroy().then(()=>process.exit(0)); });
process.on('SIGTERM', () => { console.log('SIGTERM'); client.destroy().then(()=>process.exit(0)); });
