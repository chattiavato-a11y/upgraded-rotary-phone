// server_edge.js — ops-edge-api
// L2 Guard + L3 Policy + SSE (/api/chat) + Lead capture (/api/lead) + optional pack proxy
// Providers: OSS(OpenAI-compatible), Grok (xAI), Gemini, OpenAI.
// ENV (all TEXT):
//   FRONTEND_ORIGIN         (optional CORS lock; if unset, same-origin only)
//   PACK_URL                https://<your-pack-host>/packs/site-pack.json
//   ENABLE_PROVIDERS        "true" to allow provider calls (default "false")
//   PROVIDER_CHAIN          "oss,grok,gemini,openai" (subset/order allowed)
//   -- OSS (OpenAI-compatible: Together, OpenRouter, vLLM, llama.cpp, etc.):
//   OSS_BASE_URL            e.g. "https://api.together.xyz/v1"
//   OSS_MODEL_ID            e.g. "meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo"
//   OSS_API_KEY             "sk-..."
//   -- Grok (xAI):
//   GROK_BASE_URL           "https://api.x.ai/v1"
//   GROK_MODEL_ID           e.g. "grok-2-latest"
//   GROK_API_KEY            "xai-..."
//   -- Gemini (Google AI for Devs):
//   GEMINI_BASE_URL         "https://generativelanguage.googleapis.com/v1beta"
//   GEMINI_MODEL_ID         e.g. "gemini-2.5-flash"
//   GEMINI_API_KEY          "..."
//   -- OpenAI:
//   OPENAI_BASE_URL         "https://api.openai.com/v1"
//   OPENAI_MODEL_ID         e.g. "gpt-4o-mini"
//   OPENAI_API_KEY          "sk-..."
//   -- Leads storage (optional but recommended):
//   LEADS_TTL_DAYS          e.g. "30" (omit for no TTL)
// Bindings (Dashboard or wrangler):
//   [[kv_namespaces]] binding = "LEADS_KV"  (optional KV for leads)

const MAX_BODY_BYTES = 64 * 1024;
const RL_PER_IP_PER_MIN = 20;
const WINDOW_MS = 60_000;

const PROVIDER_SOFT = 25_000;  // per-provider soft cap
const SESSION_HARD  = 35_000;  // session hard cap

// Basic prompt/policy filters
const POLICY_PATTERNS = [
  /ignore (?:all|the) (?:previous|prior|above) (?:instructions|rules)/i,
  /act as .* (?:system|developer)/i,
  /reveal (?:the )?system prompt/i,
  /\b(?:ssn|social security number)\b/i,
  /\b(?:credit card|card number|tarjeta de crédito|cvv)\b/i,
  /\b(?:password|contraseña|passcode|clave)\b/i,
];

const sessionCounters = new Map(); // sid -> { session, per:{oss,grok,gemini,openai} }
const rateMap = new Map();         // ip  -> { count, ts }

// ---------- small utils ----------
const enc = (s) => new TextEncoder().encode(s);
const isJSON = (h) => (h||"").includes("application/json");
const clamp = (s, n) => String(s||"").slice(0, n);
const digits = (s) => String(s||"").replace(/[^\d]/g,'');
const EMAIL_RE = /(?=.{3,120}$)[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;

function ipOf(req){
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
      || req.headers.get("cf-connecting-ip")
      || req.headers.get("x-real-ip")
      || "0.0.0.0";
}
function rateLimit(ip){
  const now = Date.now();
  const rec = rateMap.get(ip) || { count:0, ts: now };
  if (now - rec.ts > WINDOW_MS){ rec.count = 0; rec.ts = now; }
  rec.count++; rateMap.set(ip, rec);
  return rec.count <= RL_PER_IP_PER_MIN;
}
function corsHeaders(origin, allow){
  if (!allow) return {};               // same-origin only
  if (origin !== allow) return {};     // strict allowlist
  return {
    "Access-Control-Allow-Origin": origin,
    "Vary": "Origin",
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Headers": "Content-Type, X-CSRF",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  };
}
function bad(status, msg, extra={}){
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
  if (/\b(?:\d[ -]?){13,19}\b/.test(txt)) return true; // card-ish
  return false;
}
function sseString(s, extraHeaders={}){
  const stream = new ReadableStream({
    start(c){
      const n=64;
      for (let i=0;i<s.length;i+=n) c.enqueue(enc(`data: ${s.slice(i,i+n)}\n\n`));
      c.enqueue(enc("data: [END]\n\n")); c.close();
    }
  });
  return new Response(stream, { status:200, headers:{
    "Content-Type":"text/event-stream; charset=utf-8",
    "Cache-Control":"no-cache, no-transform",
    ...extraHeaders
  }});
}
function approxTokens(...pieces){ return Math.ceil(pieces.map(x=>String(x||"")).join("").length/4); }
function getSID(reqBody){ return String(reqBody?.csrf||"") || "anon"; }
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
function tok(s){ return (String(s||"").toLowerCase().normalize("NFKC").match(/[a-z0-9áéíóúüñ]+/gi))||[]; }
function topChunks(pack, query, lang){
  const terms = tok(query), hits=[];
  for (const d of (pack?.docs||[])){
    if (lang && d.lang && d.lang!==lang) continue;
    for (const c of (d.chunks||[])){
      const t = tok(c.text);
      let s=0; for (const w of terms) if (t.includes(w)) s++;
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
async function loadPack(url){
  const r = await fetch(url, { headers:{Accept:"application/json"}});
  if (!r.ok) throw new Error("pack_unavailable");
  return await r.json();
}

// ---------- Providers ----------
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
const callGrok   = callOpenAICompat; // xAI exposes OpenAI-compatible endpoint
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

// ---------- Main handler ----------
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const origin = req.headers.get("origin")||"";
    const allow = (env?.FRONTEND_ORIGIN||"").trim() || ""; // empty => same-origin only
    const cors = corsHeaders(origin, allow);

    // CORS preflight
    if (req.method === "OPTIONS"){
      return new Response(null, { headers: { ...cors } });
    }

    // Health & index
    if (url.pathname === "/healthz") return new Response("ok");
    if (url.pathname === "/"){
      return new Response(JSON.stringify({
        ok:true, worker:"ops-edge-api",
        routes:["/packs/site-pack.json","/api/chat","/api/lead"],
        pack_url_configured: !!env.PACK_URL,
        providers_enabled: String(env.ENABLE_PROVIDERS||"false").toLowerCase()==="true",
        provider_chain: env.PROVIDER_CHAIN || "oss,grok,gemini,openai",
        cors_locked_to: allow || "(same-origin)"
      }), { headers:{ "Content-Type":"application/json; charset=utf-8", ...cors }});
    }

    // Optional pack proxy for convenience (proxies to env.PACK_URL)
    if (url.pathname === "/packs/site-pack.json" && req.method === "GET"){
      if (!env.PACK_URL) return bad(500,"pack_unconfigured",cors);
      const r = await fetch(env.PACK_URL, { headers:{ "Accept":"application/json" }});
      const t = await r.text();
      if (!r.ok) return bad(502,"pack_fetch_failed",cors);
      try { if (t) JSON.parse(t); } catch { return bad(500,"pack_bad_json",cors); }
      return new Response(t || "{}", { headers:{ "Content-Type":"application/json; charset=utf-8", "Cache-Control":"no-store", ...cors }});
    }

    // ---------- Lead capture ----------
    if (url.pathname === "/api/lead"){
      if (req.method !== "POST") return bad(405,"method_not_allowed",{...cors,"Allow":"POST, OPTIONS"});
      if (!isJSON(req.headers.get("content-type"))) return bad(415,"unsupported_media_type",cors);

      const ip = ipOf(req);
      if (!rateLimit(ip)) return bad(429,"rate_limited",cors);

      let body;
      try { body = await readJSON(req); }
      catch(e){ return bad(e.message==="payload_too_large"?413:400, e.message, cors); }

      if (String(body.hp||"").trim()!=="") return bad(400,"bot_detected",cors);
      const csrfHdr  = req.headers.get("x-csrf")||"";
      const csrfBody = String(body.csrf||"");
      if (!csrfHdr || !csrfBody || csrfHdr!==csrfBody) return bad(403,"csrf_failed",cors);

      const L = body.lead || {};
      const name  = clamp(L.name, 120).trim();
      const email = (String(L.email||"").match(EMAIL_RE)||[])[0] || "";
      const phone = (()=>{ const d = digits(L.phone||""); return d.length>=9? d.slice(0,18) : ""; })();
      const lang  = (L.lang==="es"?"es":"en");
      const interests = clamp(L.interests, 280).trim();
      const details   = clamp(L.details, 4000).trim();
      const transcript = Array.isArray(L.transcript) ? L.transcript.slice(-24) : [];

      // id = base36 timestamp + 6 random URL-safe
      const rid = (()=> {
        const abc = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
        let s=""; for(let i=0;i<6;i++) s+=abc[(Math.random()*abc.length)|0];
        return `${Date.now().toString(36)}-${s}`;
      })();

      const record = {
        id: rid,
        ts: new Date().toISOString(),
        lang, name, email, phone, interests, details, transcript,
        ip, ua: req.headers.get("user-agent")||""
      };

      try{
        if (env.LEADS_KV){
          const ttlDays = Number(env.LEADS_TTL_DAYS||"0")|0;
          const putOpts = ttlDays>0 ? { expirationTtl: ttlDays*24*60*60 } : {};
          await env.LEADS_KV.put(`lead:${rid}`, JSON.stringify(record), putOpts);
        }
      } catch { /* non-fatal */ }

      return new Response(JSON.stringify({ ok:true, id: rid }), {
        headers:{ "Content-Type":"application/json; charset=utf-8", ...cors }
      });
    }

    // ---------- Chat SSE ----------
    if (url.pathname === "/api/chat"){
      if (req.method !== "POST") return bad(405,"method_not_allowed",{...cors,"Allow":"POST, OPTIONS"});
      if (!isJSON(req.headers.get("content-type"))) return bad(415,"unsupported_media_type",cors);

      const ip = ipOf(req);
      if (!rateLimit(ip)) return bad(429,"rate_limited",cors);

      let body;
      try { body = await readJSON(req); }
      catch(e){ return bad(e.message==="payload_too_large"?413:400, e.message, cors); }

      if (String(body.hp||"").trim()!=="") return bad(400,"bot_detected",cors);
      const csrfHdr  = req.headers.get("x-csrf")||"";
      const csrfBody = String(body.csrf||"");
      if (!csrfHdr || !csrfBody || csrfHdr!==csrfBody) return bad(403,"csrf_failed",cors);

      const userMsg = String(body.messages?.slice(-1)[0]?.content||"");
      const lang = (body.lang==="es"?"es":"en");
      if (violatesPolicy(userMsg)){
        const refuse = lang==="es" ? "No puedo ayudar con esa solicitud. Reformula por favor." : "I can’t help with that request. Please rephrase.";
        return sseString(refuse, { ...cors, "X-Provider":"policy", "X-Tokens-This-Call":"0", "X-Session-Total":"0" });
      }

      // Pack URL (client may hint; we keep origin-safe)
      const bodyPackUrl = typeof body.packUrl === 'string' ? body.packUrl.trim() : '';
      let packUrl = (env?.PACK_URL && String(env.PACK_URL).trim()) || `${url.origin}/packs/site-pack.json`;
      if (bodyPackUrl){
        try {
          const normalized = new URL(bodyPackUrl, url.origin);
          if (normalized.origin === url.origin) packUrl = normalized.toString();
        } catch { /* ignore bad client value */ }
      }

      // Try L5 extractive from pack first
      let pack, packLoaded = true;
      try { pack = await loadPack(packUrl); } catch { packLoaded=false; pack=null; }
      const strong = pack ? topChunks(pack, userMsg, lang) : [];
      const extractive = composeExtractive(strong, lang);
      const coverageOK = strong.length >= 2;

      const sid = getSID(body);
      const ctr = getCounters(sid);
      const packHeader = { 'X-Pack-URL': packUrl, 'X-Pack-Status': packLoaded ? 'ok' : 'pack-unavailable' };

      if (coverageOK && extractive){
        const used = approxTokens(userMsg, extractive);
        if (ctr.session + used <= SESSION_HARD) ctr.session += used;
        return sseString(extractive, {
          ...cors, ...packHeader,
          "X-Provider":"l5-server", "X-Tokens-This-Call":String(used),
          "X-Provider-Total":"0", "X-Session-Total":String(ctr.session),
          "X-Provider-Notice":"providers-not-used"
        });
      }

      // Provider chain
      const { text, used, provider } = await runProviderChain({ env, userMsg, lang, strong, sid });
      if (!text){
        const fallback = lang==="es"
          ? (packLoaded
            ? "No tengo suficiente información local y los proveedores no están disponibles. [#none]"
            : "El paquete de conocimiento no está disponible y tampoco hay proveedores activos. [#none]")
          : (packLoaded
            ? "I don’t have enough local info and providers are unavailable. [#none]"
            : "The knowledge pack is unavailable and no providers are active. [#none]");
        const used0 = approxTokens(userMsg, fallback);
        return sseString(fallback, {
          ...cors, ...packHeader,
          "X-Provider":"none", "X-Tokens-This-Call":String(used0),
          "X-Provider-Total":"0", "X-Session-Total":String(ctr.session)
        });
      }

      return sseString(text, {
        ...cors, ...packHeader,
        "X-Provider": provider,
        "X-Tokens-This-Call": String(used),
        "X-Provider-Total": String(getCounters(sid).per[provider]||0),
        "X-Session-Total": String(getCounters(sid).session),
        "X-Provider-Notice": (getCounters(sid).per[provider] >= PROVIDER_SOFT) ? "provider-soft-cap-reached" : ""
      });
    }

    // 404
    return bad(404,"not_found",cors);
  }
};
