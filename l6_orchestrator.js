// l6_orchestrator.js
// Lead-first conversation flow + local retrieval (L5) + optional escalation (WebLLM → /api/chat)
// Globals expected from index.html script order:
//   Shield (shield.js), ChattiaLog (log_store.js), SpeechController (speech.js),
//   L5Local (l5_local_llm.js), L5WebLLM (l5_webllm.js)
// No ESM imports; safe for <script defer> in the page.

(function (global){
  "use strict";

  // -------------------- Config & DOM --------------------
  const CFG = global.__CHATTIA_CONFIG__ || {};
  const API_URL  = CFG.apiURL  || "/api/chat";
  const PACK_URL = CFG.packURL || "/packs/site-pack.json";

  const Q  = (s)=>document.querySelector(s);
  const els = {
    form:   Q("#chatForm"),
    chat:   Q("#chat"),
    inp:    Q("#input"),
    send:   Q("#send"),
    status: Q("#status"),
    warn:   Q("#warn"),
    themeBtn: Q("#themeBtn"),
    langSel:  Q("#langSel"),
    micBtn:   Q("#micBtn"),
    ttsBtn:   Q("#ttsBtn"),
    // insights (optional)
    insBtn:   Q("#insightsBtn"),
    clrBtn:   Q("#clearLogsBtn"),
    insPanel: Q("#insightsPanel"),
    insText:  Q("#insightsText") || (Q("#insightsPanel")?.querySelector("pre"))
  };

  // Honeypot + CSRF
  const hpEl = Shield.attachHoneypot(els.form);
  const csrf = Shield.csrfToken();

  // Speech
  const speech = new SpeechController({
    inputEl: els.inp,
    statusEl: els.status,
    warnEl: els.warn,
    micBtn: els.micBtn,
    ttsBtn: els.ttsBtn,
    state: { lang:"en", ttsEnabled:false },
    onFinalTranscript(txt){ try{ els.inp.value = txt; els.inp.focus(); }catch{} }
  });

  // -------------------- Helpers --------------------
  const log = (kind,msg,meta)=>{ try{ global.ChattiaLog?.add?.({kind,msg,meta}); }catch{} };
  const setStatus = (s)=>{ if (els.status) els.status.textContent = s || ""; };
  const setWarn   = (s)=>{ if (els.warn)   els.warn.textContent   = s || ""; };

  function addMsg(role, text){
    const div = document.createElement("div");
    div.className = "msg " + (role === "user" ? "me" : "ai");
    div.textContent = String(text || "");
    els.chat.appendChild(div);
    els.chat.scrollTop = els.chat.scrollHeight;
    return div;
  }

  function sanitizeUser(raw){
    const r = Shield.scanAndSanitize(raw, { maxLen: 2000, threshold: 12 });
    if (!r.ok){
      setWarn(`Blocked input.`);
      log("guard","blocked_client",{ reasons: r.reasons });
      return null;
    }
    setWarn("");
    return r.sanitized;
  }

  // Pack helpers
  async function loadPack(){
    if (global.__PACK__) return global.__PACK__;
    const res = await fetch(PACK_URL, { headers:{ "Accept":"application/json" }, cache:"no-store" });
    if (!res.ok) throw new Error("pack_load_failed");
    global.__PACK__ = await res.json();
    return global.__PACK__;
  }
  function tok(s){ return (String(s||"").toLowerCase().normalize("NFKC").match(/[a-z0-9áéíóúüñ]+/gi)) || []; }
  function strongFromPack(pack, query, lang){
    const terms = tok(query);
    const out = [];
    for (const d of (pack?.docs||[])){
      if (lang && d.lang && d.lang!==lang) continue;
      for (const c of (d.chunks||[])){
        const tt = tok(c.text);
        let score = 0; for (const w of terms) if (tt.includes(w)) score++;
        if (score>0) out.push({ id:c.id, text:c.text, score });
      }
    }
    return out.sort((a,b)=>b.score-a.score).slice(0,4);
  }

  function groundedSystem({ lang, strong }){
    const ctx = (strong||[]).map(t=>`[#${t.id}] ${t.text}`).join('\n');
    const policy = (lang==='es')
      ? 'Responde SOLO con el contexto. Si falta info, dilo. Cita [#id].'
      : 'Answer ONLY using the context. If info is missing, say so. Cite [#id].';
    const style = (lang==='es') ? 'Sé conciso y claro.' : 'Be concise and clear.';
    return `${policy}\n${style}\n\nContext:\n${ctx}`;
  }

  // -------------------- Knowledge answer (L5 → WebLLM → L7) --------------------
  async function answerWithKnowledge(query, lang){
    // 1) L5 Local extractive
    try{
      setStatus(lang==='es'?'Pensando localmente…':'Thinking locally…');
      const extractive = await global.L5Local?.draft?.({ query, lang, bm25Min: 0.6, coverageNeeded: 2 });
      if (extractive){
        const ai = addMsg("assistant", extractive);
        try { speech.narrateAssistant(ai.textContent, lang); } catch {}
        log("l6","l5_answer_ok",{ chars: extractive.length, pack: PACK_URL });
        setStatus(lang==='es'?'Listo.':'Ready.');
        return true;
      }
    } catch(e){
      log("l6","l5_error",{ err:String(e?.message||e) });
    }

    // 2) Optional WebLLM (local GPU)
    if (global.L5WebLLM?.supported?.()){
      try{
        setStatus(lang==='es'?'Cargando modelo en dispositivo…':'Loading on-device model…');

        // Best-effort context
        let sys = "You are a concise assistant.";
        try {
          const pack = await loadPack();
          const strong = strongFromPack(pack, query, lang);
          sys = groundedSystem({ lang, strong });
        } catch {}

        const aiEl = addMsg("assistant", "");
        const text = await global.L5WebLLM.generate?.({
          system: sys,
          messages: [{ role:"user", content: query }],
          temperature: 0.2,
          maxTokens: 220,
          onDelta: (t)=>{ aiEl.textContent += t; els.chat.scrollTop = els.chat.scrollHeight; }
        });
        if (text && text.trim()){
          try { speech.narrateAssistant(text, lang); } catch {}
          log("l6","webllm_answer_ok",{ chars: text.length });
          setStatus(lang==='es'?'Listo.':'Ready.');
          return true;
        }
      } catch(e){
        log("l6","webllm_error",{ err:String(e?.message||e) });
      }
    }

    // 3) Escalate to server (SSE)
    try{
      setStatus(lang==='es'?'Conectando al servidor…':'Connecting to server…');
      const res = await fetch(API_URL, {
        method:"POST",
        headers:{ "Content-Type":"application/json", "X-CSRF": csrf },
        body: JSON.stringify({
          messages: [{ role:"user", content: query }],
          lang, csrf, hp: hpEl?.value || "", packUrl: PACK_URL
        })
      });
      if (!res.ok || !res.body){
        setWarn(lang==='es'?'Servidor no disponible.':'Server unavailable.');
        log("l7","server_bad",{ status: res.status });
        setStatus(lang==='es'?'Sin conexión.':'Offline.');
        return false;
      }
      setStatus(lang==='es'?'Transmitiendo…':'Streaming…');
      const aiEl = addMsg("assistant","");
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let full = "";
      while(true){
        const {value, done} = await reader.read();
        if (done) break;
        const chunk = dec.decode(value, {stream:true});
        for (const line of chunk.split('\n')){
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6);
          if (data === '[END]') continue;
          full += data; aiEl.textContent = full;
          els.chat.scrollTop = els.chat.scrollHeight;
        }
      }
      if (full.trim()){
        try { speech.narrateAssistant(full, lang); } catch {}
        setStatus(lang==='es'?'Listo.':'Ready.');
        return true;
      }
    } catch(e){
      log("l7","server_fetch_error",{ err:String(e?.message||e) });
      setWarn(lang==='es'?'No se pudo contactar al servidor.':'Could not reach server.');
      setStatus(lang==='es'?'Sin conexión.':'Offline.');
    }
    return false;
  }

  // -------------------- Lead FSM --------------------
  const EMAIL_RE = /(?=.{3,120}$)[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;
  const isYes  = (s)=>/^\s*(y|yes|si|sí|claro|ok)\b/i.test(s||"");
  const isNo   = (s)=>/^\s*(n|no|not now|nope)\b/i.test(s||"");
  const isIDK  = (s)=>/\b(i\s*don'?t\s*know|idk|no\s*se|no\s*sé|not\s*sure)\b/i.test(s||"");

  const lead = {
    step: "init",
    lang: "en",
    name: "",
    email: "",
    phone: "",
    interests: "",
    details: "",
    transcript: [] // last 24 turns
  };

  function pushTranscript(role, text){
    lead.transcript.push({ role, text, ts: Date.now() });
    if (lead.transcript.length > 24) lead.transcript = lead.transcript.slice(-24);
  }

  function prompt(text){
    const el = addMsg("assistant", text);
    try { speech.narrateAssistant(text, lead.lang); } catch {}
    log("lead","bot", { step: lead.step });
    return el;
  }

  function normPhone(s){
    const d = String(s||"").replace(/[^\d]/g, "");
    if (d.length < 9) return "";
    return d.slice(0,18);
  }

  function greet(){
    lead.step = "ask_name";
    const t = (lead.lang==='es')
      ? "Hola, soy Chattia. Gracias por considerar nuestros servicios. Estoy aquí para guiarte. ¿Me indicas tu nombre, por favor?"
      : "Hi, I’m Chattia. Thanks for considering our services. I’m here to guide you. May I have your name, please?";
    prompt(t);
  }

  function askEmail(){
    lead.step = "ask_email";
    const t = (lead.lang==='es')
      ? `Gracias, ${lead.name}. ¿Cuál es tu correo electrónico?`
      : `Thank you, ${lead.name}. What’s your email address?`;
    prompt(t);
  }

  function askPhone(){
    lead.step = "ask_phone";
    const t = (lead.lang==='es')
      ? "¿Y tu número de teléfono (con código de país si aplica)?"
      : "And your phone number (with country code if applicable)?";
    prompt(t);
  }

  function askInterest(){
    lead.step = "ask_interest";
    const t = (lead.lang==='es')
      ? "¿Viste alguna solución que se ajuste a lo que buscas? Si no, ¿qué necesitamos para darte la mejor solución?"
      : "Did you find any of our solutions that match what you’re looking for? If not, what would help us provide the best solution?";
    prompt(t);
  }

  async function explainServicesBrief(){
    // Try to ground from the pack
    try{
      const extract = await global.L5Local?.draft?.({
        query: lead.lang==='es' ? "pilares de servicio" : "service pillars",
        lang: lead.lang, bm25Min: 0.4, coverageNeeded: 1
      });
      if (extract){
        prompt(
          (lead.lang==='es'
            ? "Entendido. Te explico brevemente nuestros servicios:\n\n"
            : "Understood. Here’s a quick overview of our services:\n\n"
          ) + extract
        );
        return;
      }
    } catch {}
    // Fallback
    prompt(
      lead.lang==='es'
        ? "Entendido. Ofrecemos Operaciones de Negocio, Contact Center, Soporte TI y Profesionales On-Demand."
        : "Understood. We offer Business Operations, Contact Center, IT Support, and Professionals On-Demand."
    );
  }

  function askDetails(){
    lead.step = "collect_details";
    const t = (lead.lang==='es')
      ? "¿Hay detalles o restricciones que debamos considerar (presupuesto, plazo, tamaño de equipo)?"
      : "Any details or constraints we should consider (budget, timeline, team size)?";
    prompt(t);
  }

  function confirmSummary(){
    lead.step = "confirm";
    const sum = (lead.lang==='es')
      ? `Resumen:\n• Nombre: ${lead.name}\n• Email: ${lead.email}\n• Teléfono: ${lead.phone}\n• Interés: ${lead.interests || "—"}\n• Detalles: ${lead.details || "—"}\n\n¿Lo envío a nuestro equipo?`
      : `Summary:\n• Name: ${lead.name}\n• Email: ${lead.email}\n• Phone: ${lead.phone}\n• Interest: ${lead.interests || "—"}\n• Details: ${lead.details || "—"}\n\nShall I send this to our team?`;
    prompt(sum);
  }

  async function submitLead(){
    lead.step = "submit";
    setStatus(lead.lang==='es'?'Enviando…':'Submitting…');
    try{
      const body = {
        csrf,
        hp: hpEl?.value || "",
        lead: {
          lang: lead.lang,
          name: lead.name,
          email: lead.email,
          phone: lead.phone,
          interests: lead.interests,
          details: lead.details,
          transcript: lead.transcript
        }
      };
      const res = await fetch("/api/lead", {
        method: "POST",
        headers: { "Content-Type":"application/json", "X-CSRF": csrf },
        body: JSON.stringify(body)
      });
      const j = await res.json().catch(()=>({}));
      if (!res.ok || !j?.ok){
        throw new Error(String(j?.error||`http_${res.status}`));
      }
      lead.step = "done";
      prompt(lead.lang==='es'
        ? "¡Gracias! He enviado tu información. Nuestro equipo te contactará pronto."
        : "Thank you! I’ve sent your info. Our team will reach out shortly.");
      log("lead","submitted",{ id: j.id||null });
      setStatus(lead.lang==='es'?'Listo.':'Ready.');
    } catch(e){
      lead.step = "confirm";
      setWarn(lead.lang==='es'
        ? "No pude enviar el formulario. Intenta de nuevo más tarde."
        : "I couldn’t submit the form. Please try again later.");
      log("lead","submit_error",{ err:String(e?.message||e) });
      setStatus(lead.lang==='es'?'Error.':'Error.');
    }
  }

  // -------------------- UI wiring --------------------
  if (els.themeBtn){
    els.themeBtn.addEventListener("click", ()=>{
      const cur = document.documentElement.dataset.theme || "dark";
      const next = cur==="dark" ? "light" : "dark";
      document.documentElement.dataset.theme = next;
      els.themeBtn.textContent = next[0].toUpperCase()+next.slice(1);
      log("ui","theme_toggle",{ theme: next });
    });
  }
  if (els.langSel){
    els.langSel.addEventListener("change", e=>{
      lead.lang = String(e.target.value || "en");
      try { speech.setLang(lead.lang); } catch {}
      log("ui","lang_change",{ lang: lead.lang });
    });
    // seed lang from selector initial value
    lead.lang = String(els.langSel.value || "en");
    try { speech.setLang(lead.lang); } catch {}
  }

  async function handleSend(){
    const raw = (els.inp.value||"").trim();
    if (!raw) return;

    speech.cancelSpeech();

    const clean = sanitizeUser(raw);
    if (clean == null) return;

    addMsg("user", clean);
    pushTranscript("user", clean);
    els.inp.value = "";

    // Lead-first FSM
    switch(lead.step){
      case "init":
        greet();
        return;

      case "ask_name": {
        const name = clean.replace(/[\s]+/g," ").trim();
        if (!/^[\p{L}.' -]{2,60}$/u.test(name)){
          prompt(lead.lang==='es' ? "¿Podrías compartir tu nombre (2–60 caracteres)?" : "Could you share your name (2–60 characters)?");
          return;
        }
        lead.name = name;
        askEmail();
        return;
      }

      case "ask_email": {
        const email = (clean.match(EMAIL_RE)||[])[0] || "";
        if (!email){
          prompt(lead.lang==='es' ? "¿Un email válido por favor (ej. nombre@dominio.com)?" : "A valid email please (e.g., name@example.com)?");
          return;
        }
        lead.email = email;
        askPhone();
        return;
      }

      case "ask_phone": {
        const phone = normPhone(clean);
        if (!phone){
          prompt(lead.lang==='es' ? "¿Me pasas un número válido? (al menos 9 dígitos)" : "Please share a valid number (at least 9 digits).");
          return;
        }
        lead.phone = phone;
        askInterest();
        return;
      }

      case "ask_interest": {
        if (isIDK(clean)){
          await explainServicesBrief();
          prompt(lead.lang==='es'
            ? "¿Qué área te interesa más (Operaciones, Contact Center, Soporte TI, Profesionales On-Demand)?"
            : "Which area interests you most (Business Ops, Contact Center, IT Support, Professionals On-Demand)?");
          lead.step = "ask_interest"; // remain until we get a concrete interest
          return;
        }
        // store user’s wording as interests
        lead.interests = clean.slice(0, 280);
        askDetails();
        return;
      }

      case "collect_details": {
        lead.details = clean.slice(0, 4000);
        confirmSummary();
        return;
      }

      case "confirm": {
        if (isYes(clean)){
          await submitLead();
          return;
        }
        if (isNo(clean)){
          // Simple edit path: ask which field to change
          prompt(lead.lang==='es'
            ? "¿Qué deseas corregir? Escribe por ejemplo: email: nuevo@correo.com"
            : "What would you like to correct? For example: email: new@example.com");
          lead.step = "edit_field";
          return;
        }
        // If they ask a question, try to answer, then re-confirm
        if (/[?？]$/.test(clean) || /\b(what|how|when|price|cost|qué|cómo|cuándo|precio|costo)\b/i.test(clean)){
          await answerWithKnowledge(clean, lead.lang);
          confirmSummary();
          return;
        }
        // default: re-ask
        prompt(lead.lang==='es' ? "¿Deseas que lo envíe? (sí/no)" : "Would you like me to send it? (yes/no)");
        return;
      }

      case "edit_field": {
        // very small parser: field: value
        const m = clean.match(/^\s*(name|nombre|email|correo|phone|tel[eé]fono|interest|inter[eé]s|details|detalles)\s*:\s*(.+)$/i);
        if (!m){
          prompt(lead.lang==='es'
            ? "Indica el campo a corregir como: email: nuevo@correo.com"
            : "Specify the field like: email: new@example.com");
          return;
        }
        const key = m[1].toLowerCase();
        const val = m[2].trim();

        if (/^name|nombre$/.test(key)){
          if (/^[\p{L}.' -]{2,60}$/u.test(val)) lead.name = val;
          else { prompt(lead.lang==='es'?"Nombre no válido. Intenta de nuevo.":"Invalid name. Try again."); return; }
        } else if (/^email|correo$/.test(key)){
          if ((val.match(EMAIL_RE)||[])[0]) lead.email = val;
          else { prompt(lead.lang==='es'?"Email no válido.":"Invalid email."); return; }
        } else if (/^phone|tel[eé]fono$/.test(key)){
          const p = normPhone(val); if (p) lead.phone = p; else { prompt(lead.lang==='es'?"Teléfono no válido.":"Invalid phone."); return; }
        } else if (/^interest|inter[eé]s$/.test(key)){
          lead.interests = val.slice(0,280);
        } else if (/^details|detalles$/.test(key)){
          lead.details = val.slice(0,4000);
        }

        confirmSummary();
        return;
      }

      case "submit":
      case "done":
      default: {
        // Post-lead chat: answer questions with knowledge ladder
        await answerWithKnowledge(clean, lead.lang);
        return;
      }
    }
  }

  // Bind send
  els.send?.addEventListener("click", handleSend);
  els.inp?.addEventListener("keydown", (e)=>{
    if (e.key === "Enter" && !e.shiftKey){ e.preventDefault(); handleSend(); }
  });

  // Insights wiring (optional)
  async function renderInsights(){
    if (!els.insPanel || !els.insText || !global.ChattiaLog) return;
    const items = await global.ChattiaLog.dump?.() || [];
    const lines = items.slice(-200).map(e=>{
      const ts = e.ts || new Date().toISOString();
      return `[${ts}] (${e.kind}) ${e.msg}${e.meta ? " " + (()=>{try{return JSON.stringify(e.meta);}catch{return""}})() : ""}`;
    });
    els.insText.textContent = [
      `Session: ${(global.ChattiaLog?.sessionId)||"n/a"}`,
      `Events: ${items.length}`,
      ""
    ].concat(lines).join("\n");
  }
  if (els.insBtn && els.insPanel){
    els.insBtn.addEventListener("click", async ()=>{
      const hidden = !els.insPanel.style.display || els.insPanel.style.display === "none";
      if (hidden){ els.insPanel.style.display = "block"; els.insBtn.setAttribute("aria-expanded","true"); await renderInsights(); }
      else       { els.insPanel.style.display = "none";  els.insBtn.setAttribute("aria-expanded","false"); }
    });
  }
  if (els.clrBtn && els.insPanel){
    els.clrBtn.addEventListener("click", async ()=>{
      try { await global.ChattiaLog?.clear?.(); } catch {}
      if (els.insText) els.insText.textContent = "Logs cleared.";
    });
  }

  // Boot greeting
  (function boot(){
    log("boot","l6_ready",{ api: API_URL, pack: PACK_URL });
    setStatus(lead.lang==='es'?'Listo.':'Ready.');
    // Start lead flow immediately
    greet();
  })();

})(window);
