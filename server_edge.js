// server_edge.js — ops-edge-api
// L2 Guard + L3 Policy + SSE (/api/chat) + Lead capture (/api/lead) + optional pack proxy
// Providers: OSS(OpenAI-compatible), Grok (xAI), Gemini, OpenAI.
// ENV (all TEXT):

//   OSS_BASE_URL            e.g. "https://api.together.xyz/v1"
//   OSS_MODEL_ID            e.g. "meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo"
//   GROK_BASE_URL           "https://api.x.ai/v1"
//   GROK_MODEL_ID           e.g. "grok-2-latest"
//   GEMINI_BASE_URL         "https://generativelanguage.googleapis.com/v1beta"
//   GEMINI_MODEL_ID         e.g. "gemini-2.5-flash"
//   OPENAI_BASE_URL         "https://api.openai.com/v1"
//   OPENAI_MODEL_ID         e.g. "gpt-4o-mini"
//   LEADS_TTL_DAYS          e.g. "30" (omit for no TTL)
// -------------------- Constants --------------------
const MAX_BODY_BYTES = 64 * 1024;
const RL_PER_IP_PER_MIN = 20;
const WINDOW_MS = 60_000;

const PROVIDER_SOFT = 25_000;
const SESSION_HARD  = 35_000;

const POLICY_PATTERNS = [
  /ignore (?:all|the) (?:previous|prior|above) (?:instructions|rules)/i,
  /act as .* (?:system|developer)/i,
  /reveal (?:the )?system prompt/i,
  /olvida las instrucciones/i, /actúa como .* sistema/i,
  /\b(?:ssn|social security number)\b/i,
  /\b(?:credit card|card number|tarjeta de crédito|cvv)\b/i,
  /\b(?:password|contraseña|passcode|clave)\b/i,
];

// -------------------- In-memory counters --------------------
const sessionCounters = new Map(); // sid -> { session, per:{oss,grok,gemini,openai} }
const rateMap = new Map();         // ip -> { count, ts }

// -------------------- Small utils --------------------
const CORS = (origin, allow) =>
  (!allow || origin !== allow) ? {} : {
    "Access-Control-Allow-Origin": origin,
    "Vary": "Origin",
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Headers": "Content-Type, X-CSRF, X-Nonce, Authorization",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS"
  };

const ipOf = (req) =>
  req.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
  || req.headers.get("cf-connecting-ip")
  || req.headers.get("x-real-ip")
  || "0.0.0.0";

function rateLimit(ip){
  const now = Date.now();
  const rec = rateMap.get(ip) || { count:0, ts: now };
  if (now - rec.ts > WINDOW_MS){ rec.count = 0; rec.ts = now; }
  rec.count++; rateMap.set(ip, rec);
  return rec.count <= RL_PER_IP_PER_MIN;
}

function bad(status, msg, extra={}) {
  return new Response(JSON.stringify({ error: msg }), {
    status, headers: { "Content-Type":"application/json; charset=utf-8", ...extra }
  });
}

async function readJSON(req){
  const len = Number(req.headers.get("content-length")||0);
  if (len && len > MAX_BODY_BYTES) throw new Error("payload_too_large");
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) throw new Error("payload_too_large");
  try { return JSON.parse(text||"{}"); } catch { throw new Error("bad_json"); }
}

function violatesPolicy(s){
  const txt = String(s||"");
  for (const re of POLICY_PATTERNS) if (re.test(txt)) return true;
  if (/\b(?:\d[ -]?){13,19}\b/.test(txt)) return true;
  return false;
}

function tok(s){ return (String(s||"").toLowerCase().normalize("NFKC").match(/[a-z0-9áéíóúüñ]+/gi))||[]; }

async function loadPack(url){ const r = await fetch(url, { headers:{Accept:"application/json"}}); if(!r.ok) throw new Error("pack_unavailable"); return await r.json(); }

function topChunks(pack, query, lang){
  const terms = tok(query), hits=[];
  for (const d of (pack.docs||[])){
    if (lang && d.lang && d.lang!==lang) continue;
    for (const c of (d.chunks||[])){
      const t = tok(c.text);
      let s=0; for(const w of terms) if (t.includes(w)) s++;
      if (s>0) hits.push({ id:c.id, text:c.text, score:s });
    }
  }
  return hits.sort((a,b)=>b.score-a.score).slice(0,6);
}

function composeExtractive(strong, lang){
  if (!strong.length) return null;
  const parts = strong.slice(0,3).map(t => `${t.text.trim()} [#${t.id}]`);
  return parts.join(" ").trim();
}

function sseString(s, extraHeaders={}){
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    start(c){
      const n=64; for(let i=0;i<s.length;i+=n){ c.enqueue(enc.encode(`data: ${s.slice(i,i+n)}\n\n`)); }
      c.enqueue(enc.encode("data: [END]\n\n")); c.close();
    }
  });
  return new Response(stream, { status:200, headers:{
    "Content-Type":"text/event-stream; charset=utf-8",
    "Cache-Control":"no-cache, no-transform",
    ...extraHeaders
  }});
}

const approxTokens = (...pieces)=> Math.ceil(pieces.map(x=>String(x||"")).join("").length/4);
const getSID = (reqBody)=> String(reqBody?.csrf||"") || "anon";
function getCounters(sid){
  let v = sessionCounters.get(sid);
  if (!v){ v = { session:0, per:{oss:0,grok:0,gemini:0,openai:0} }; sessionCounters.set(sid, v); }
  return v;
}
function spendTokens(ctr, provider, used){
  const allowance = Math.max(0, SESSION_HARD - ctr.session);
  if (!allowance) return 0;
  const spend = Math.min(Math.max(0, Number(used)||0), allowance);
  ctr.per[provider] = (ctr.per[provider]||0) + spend;
  ctr.session += spend;
  return spend;
}

// -------------------- Providers --------------------
async function callOpenAICompat({ base, key, model, messages }){
  const url = `${base.replace(/\/+$/,'')}/chat/completions`;
  const r = await fetch(url, {
    method:"POST",
    headers:{ "Content-Type":"application/json", "Authorization":`Bearer ${key}` },
    body: JSON.stringify({ model, messages, temperature:0.2, stream:false })
  });
  if (!r.ok) throw new Error(`provider_http_${r.status}`);
  const j = await r.json();
  const text = j?.choices?.[0]?.message?.content || "";
  const used = (j?.usage?.total_tokens ?? approxTokens(JSON.stringify(messages), text));
  return { text, used };
}
const callGrok   = callOpenAICompat; // xAI is OpenAI-compatible
const callOpenAI = callOpenAICompat;

async function callGemini({ base, key, model, systemText, userText }){
  const url = `${base.replace(/\/+$/,'')}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`;
  const contents = [{ role:"user", parts:[{ text: `SYSTEM:\n${systemText}\n\nUSER:\n${userText}`}]}];
  const r = await fetch(url, { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify({ contents }) });
  if (!r.ok) throw new Error(`provider_http_${r.status}`);
  const j = await r.json();
  const parts = j?.candidates?.[0]?.content?.parts || [];
  const text = parts.map(p=>p.text||"").join("") || "";
  const used = approxTokens(systemText, userText, text);
  return { text, used };
}

async function runProviderChain({ env, userMsg, lang, strong, sid }){
  if (String(env?.ENABLE_PROVIDERS||"").toLowerCase()!=="true")
    return { text:null, used:0, provider:"none" };

  const chain = String(env?.PROVIDER_CHAIN || "oss,grok,gemini,openai")
    .split(",").map(s=>s.trim()).filter(Boolean);

  const sys = (lang==="es"
    ? "Responde SOLO con el contexto. Si falta info, dilo. Cita [#id]."
    : "Answer ONLY using the context. If info is missing, say so. Cite [#id].");
  const ctx = (strong||[]).map(t=>`[#${t.id}] ${t.text}`).join("\n");
  const systemText = `${sys}\n\nContext:\n${ctx}`;
  const messages = [{ role:"system", content: systemText }, { role:"user", content: userMsg }];

  const ctr = getCounters(sid);

  for (const p of chain){
    try{
      if (!(p in ctr.per)) ctr.per[p]=0;
      if (Math.max(0, SESSION_HARD - ctr.session) === 0) break;
      if (ctr.per[p] >= PROVIDER_SOFT) continue;

      if (p==="oss" && env?.OSS_BASE_URL && env?.OSS_API_KEY && env?.OSS_MODEL_ID){
        const { text, used } = await callOpenAICompat({ base: env.OSS_BASE_URL, key: env.OSS_API_KEY, model: env.OSS_MODEL_ID, messages });
        const spend = spendTokens(ctr, p, used);
        return { text, used: spend, provider:p };
      }
      if (p==="grok" && env?.GROK_BASE_URL && env?.GROK_API_KEY && env?.GROK_MODEL_ID){
        const { text, used } = await callGrok({ base: env.GROK_BASE_URL, key: env.GROK_API_KEY, model: env.GROK_MODEL_ID, messages });
        const spend = spendTokens(ctr, p, used);
        return { text, used: spend, provider:p };
      }
      if (p==="gemini" && env?.GEMINI_BASE_URL && env?.GEMINI_API_KEY && env?.GEMINI_MODEL_ID){
        const { text, used } = await callGemini({ base: env.GEMINI_BASE_URL, key: env.GEMINI_API_KEY, model: env.GEMINI_MODEL_ID, systemText, userText: userMsg });
        const spend = spendTokens(ctr, p, used);
        return { text, used: spend, provider:p };
      }
      if (p==="openai" && env?.OPENAI_BASE_URL && env?.OPENAI_API_KEY && env?.OPENAI_MODEL_ID){
        const { text, used } = await callOpenAI({ base: env.OPENAI_BASE_URL, key: env.OPENAI_API_KEY, model: env.OPENAI_MODEL_ID, messages });
        const spend = spendTokens(ctr, p, used);
        return { text, used: spend, provider:p };
      }
    } catch { /* try next */ }
  }
  return { text:null, used:0, provider:"none" };
}

// -------------------- Lead validation --------------------
const EMAIL_RE = /(?=.{3,120}$)[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;
function normName(s){ const v = String(s||"").replace(/[\s]+/g," ").trim(); return /^[\p{L}.' -]{2,60}$/u.test(v) ? v : ""; }
function normEmail(s){ const v = (String(s||"").match(EMAIL_RE)||[])[0]||""; return v || ""; }
function normPhone(s){ const d = String(s||"").replace(/[^\d]/g,""); return d.length>=9 ? d.slice(0,18) : ""; }
function scrub(str){ return String(str||"").slice(0, 4000); }
function anonIP(ip){ const m = (ip||"").split("."); return m.length===4 ? `${m[0]}.${m[1]}.x.x` : "x.x.x.x"; }
function randId(n=22){ const abc="abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-"; let s=""; for(let i=0;i<n;i++) s+=abc[(Math.random()*abc.length)|0]; return s; }

// -------------------- Handler --------------------
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const origin = req.headers.get("origin")||"";
    const allow = env?.FRONTEND_ORIGIN || "";

    if (req.method === "OPTIONS") return new Response(null, { headers: CORS(origin, allow) });
    if (url.pathname === "/healthz") return new Response("ok");
    if (url.pathname !== "/api/chat" && url.pathname !== "/api/lead")
      return new Response("Not found", { status:404 });

    const cors = CORS(origin, allow);
    if (allow && origin && origin !== allow) return bad(403,"origin_not_allowed",cors);
    if (req.method !== "POST") {
      if (url.pathname === "/api/chat")
        return new Response(JSON.stringify({ ok:true, hint:"POST JSON to /api/chat for SSE stream" }), { headers: { ...cors, "Content-Type":"application/json; charset=utf-8" }});
      if (url.pathname === "/api/lead")
        return new Response(JSON.stringify({ ok:true, hint:"POST JSON to /api/lead to store a lead" }), { headers: { ...cors, "Content-Type":"application/json; charset=utf-8" }});
    }

    if (!(req.headers.get("content-type")||"").includes("application/json"))
      return bad(415,"unsupported_media_type",cors);

    const ip = ipOf(req);
    if (!rateLimit(ip)) return bad(429,"rate_limited",cors);

    // -------------------- /api/lead --------------------
    if (url.pathname === "/api/lead") {
      let body;
      try { body = await readJSON(req); } catch(e){ return bad(e.message==="payload_too_large"?413:400, e.message, cors); }

      // CSRF & honeypot
      const csrfHdr = req.headers.get("x-csrf")||""; const csrfBody = String(body.csrf||"");
      if (!csrfHdr || !csrfBody || csrfHdr!==csrfBody) return bad(403,"csrf_failed",cors);
      if (String(body.hp||"").trim()!=="") return bad(400,"bot_detected",cors);

      const lead = body.lead || {};
      const lang = lead.lang==="es" ? "es" : "en";

      const name  = normName(lead.name);
      const email = normEmail(lead.email);
      const phone = normPhone(lead.phone);
      const interests = scrub(lead.interests);
      const details   = scrub(lead.details);
      if (!name)  return bad(400,"invalid_name",cors);
      if (!email) return bad(400,"invalid_email",cors);
      if (!phone) return bad(400,"invalid_phone",cors);

      const doc = {
        id: `lead_${Date.now()}_${randId(6)}`,
        ts: new Date().toISOString(),
        lang,
        name, email, phone, interests, details,
        transcript: Array.isArray(lead.transcript) ? lead.transcript.slice(-24) : [],
        ip: anonIP(ip),
        ua: (req.headers.get("user-agent")||"").slice(0,180)
      };

      // Persist to KV if bound
      try {
        if (env.LEADS_KV) {
          await env.LEADS_KV.put(doc.id, JSON.stringify(doc), { expirationTtl: 60 * 60 * 24 * 30 }); // 30d
        }
      } catch { /* best effort */ }

      // Optional webhook fan-out (e.g., to your CRM)
      try {
        const hook = (env.LEAD_WEBHOOK_URL||"").trim();
        if (hook) {
          await fetch(hook, {
            method:"POST",
            headers: { "Content-Type":"application/json" },
            body: JSON.stringify({ type:"lead.create", data: { ...doc, ip: undefined } })
          });
        }
      } catch { /* ignore webhook errors */ }

      return new Response(JSON.stringify({ ok:true, id: doc.id }), {
        status: 200, headers: { ...cors, "Content-Type":"application/json; charset=utf-8" }
      });
    }

    // -------------------- /api/chat (SSE) --------------------
    let body;
    try { body = await readJSON(req); } catch(e){ return bad(e.message==="payload_too_large"?413:400, e.message, cors); }

    if (String(body.hp||"").trim()!=="") return bad(400,"bot_detected",cors);
    const csrfHdr = req.headers.get("x-csrf")||""; const csrfBody = String(body.csrf||"");
    if (!csrfHdr || !csrfBody || csrfHdr!==csrfBody) return bad(403,"csrf_failed",cors);

    const userMsg = String(body.messages?.slice(-1)[0]?.content||"");
    const lang = (body.lang==="es"?"es":"en");
    if (violatesPolicy(userMsg)){
      const refuse = lang==="es" ? "No puedo ayudar con esa solicitud. Reformula por favor." : "I can’t help with that request. Please rephrase.";
      return sseString(refuse, { ...cors, "X-Provider":"policy", "X-Tokens-This-Call":"0", "X-Session-Total":"0" });
    }

    const bodyPackUrl = typeof body.packUrl === 'string' ? body.packUrl.trim() : '';
    let packUrl = (env?.PACK_URL && String(env.PACK_URL).trim()) || `${url.origin}/packs/site-pack.json`;
    if (bodyPackUrl) {
      try {
        const normalizedURL = new URL(bodyPackUrl, url.origin);
        if (normalizedURL.origin === url.origin) packUrl = normalizedURL.toString();
      } catch {}
    }

    let pack, packLoaded = true;
    try { pack = await loadPack(packUrl); } catch { packLoaded = false; pack = null; }
    const strong = pack ? topChunks(pack, userMsg, lang) : [];
    const extractive = composeExtractive(strong, lang);
    const coverageOK = strong.length >= 2;
    const sid = getSID(body);
    const ctr = getCounters(sid);

    const packHeader = { 'X-Pack-URL': packUrl };

    if (coverageOK && extractive){
      const used = approxTokens(userMsg, extractive);
      if (ctr.session + used <= SESSION_HARD) ctr.session += used;
      return sseString(extractive, {
        ...cors, ...packHeader,
        "X-Provider":"l5-server", "X-Tokens-This-Call":String(used),
        "X-Provider-Total":"0", "X-Session-Total":String(ctr.session),
        "X-Provider-Notice":"providers-not-used",
        "X-Pack-Status": packLoaded ? "ok" : "pack-unavailable"
      });
    }

    const { text, used, provider } = await runProviderChain({ env, userMsg, lang, strong, sid });
    if (!text){
      const fallback = lang==="es"
        ? (packLoaded ? "No tengo suficiente información local y los proveedores no están disponibles. [#none]"
                      : "El paquete de conocimiento no está disponible y tampoco hay proveedores activos. [#none]")
        : (packLoaded ? "I don’t have enough local info and providers are unavailable. [#none]"
                      : "The knowledge pack is unavailable and no providers are active. [#none]");
      const used0 = approxTokens(userMsg, fallback);
      return sseString(fallback, {
        ...cors, ...packHeader,
        "X-Provider":"none", "X-Tokens-This-Call":String(used0),
        "X-Provider-Total":"0", "X-Session-Total":String(ctr.session),
        "X-Pack-Status": packLoaded ? "ok" : "pack-unavailable"
      });
    }

    return sseString(text, {
      ...cors, ...packHeader,
      "X-Provider": provider,
      "X-Tokens-This-Call": String(used),
      "X-Provider-Total": String(getCounters(sid).per[provider]||0),
      "X-Session-Total": String(getCounters(sid).session),
      "X-Provider-Notice": (getCounters(sid).per[provider] >= PROVIDER_SOFT) ? "provider-soft-cap-reached" : "",
      "X-Pack-Status": packLoaded ? "ok" : "pack-unavailable"
    });
  }
};
