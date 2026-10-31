// ============================================================
//  XAVECO — assistente de conversa no WhatsApp
//  Lê print/áudio/texto → 3 respostas + termômetro (+ áudio com a voz do Patrick)
//  3 usos grátis → assinatura via Pix (Asaas), liberação automática
// ============================================================
const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

// ---------- configuração (variáveis de ambiente no Render) ----------
const E = process.env;
const CFG = {
  port: E.PORT || 3000,
  // WhatsApp (API oficial da Meta)
  waToken: E.WHATSAPP_TOKEN || "",
  waPhoneId: E.WHATSAPP_PHONE_NUMBER_ID || "",
  waVerify: E.WHATSAPP_VERIFY_TOKEN || "xaveco-verifica",
  appSecret: E.META_APP_SECRET || "",
  graph: `https://graph.facebook.com/${E.GRAPH_VERSION || "v23.0"}`,
  // IA
  openaiKey: E.OPENAI_API_KEY || "",
  models: (E.OPENAI_MODEL || "gpt-5.4-mini,gpt-5-mini,gpt-4o-mini").split(",").map(s => s.trim()).filter(Boolean),
  transcribeModels: (E.OPENAI_TRANSCRIBE_MODEL || "gpt-4o-mini-transcribe,whisper-1").split(",").map(s => s.trim()).filter(Boolean),
  // Voz (opcional)
  elevenKey: E.ELEVENLABS_API_KEY || "",
  elevenVoice: E.ELEVENLABS_VOICE_ID || "",
  // Pagamento
  asaasKey: E.ASAAS_API_KEY || "",
  asaasUrl: E.ASAAS_URL || "https://api.asaas.com/v3", // sandbox: https://api-sandbox.asaas.com/v3
  asaasWebhookToken: E.ASAAS_WEBHOOK_TOKEN || "",
  // Regras do negócio
  gratis: Number(E.USOS_GRATIS || 3),
  limiteDiario: Number(E.LIMITE_DIARIO_ASSINANTE || 120), // mensagens/dia do assinante
  conversaGratis: Number(E.MENSAGENS_GRATIS || 25),     // mensagens de papo no grátis
  planos: {
    semana: { nome: "1 semana", valor: Number(E.PRECO_SEMANA || 9.9), dias: 7 },
    mes: { nome: "1 mês", valor: Number(E.PRECO_MES || 24.9), dias: 30 },
  },
  // Tela de teste (/teste?k=SENHA). Sem senha = desligada.
  testeSenha: E.TESTE_SENHA || "",
  dbUrl: E.DATABASE_URL || "",
};

const brl = v => Number(v).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const hojeSP = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" }); // AAAA-MM-DD
const dataBR = ms => new Date(ms).toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit" });
const log = (...a) => console.log(new Date().toISOString(), ...a);

// ============================================================
//  BANCO (Postgres no Render; sem DATABASE_URL usa memória — só p/ teste)
// ============================================================
const mem = { users: new Map(), pays: new Map() };
let pool = null;
async function dbInit() {
  if (!CFG.dbUrl) { log("⚠️  Sem DATABASE_URL — dados ficam só na memória (ok p/ teste)"); return; }
  const { Pool } = require("pg");
  pool = new Pool({ connectionString: CFG.dbUrl, ssl: /localhost|127\.0\.0\.1/.test(CFG.dbUrl) ? false : { rejectUnauthorized: false } });
  await pool.query(`create table if not exists xv_users (phone text primary key, data jsonb not null, updated_at timestamptz default now());
                    create table if not exists xv_payments (id text primary key, phone text, plano text, status text, created_at timestamptz default now());`);
  log("Banco conectado");
}
function novoUser(phone) {
  return { phone, estado: "novo", maior: false, gratisUsados: 0, ate: 0, diaData: "", diaUsos: 0, voz: true,
           asaasCliente: "", planoPendente: "", hist: [], turnos: 0, nome: "" };
}
async function getUser(phone) {
  if (!pool) return mem.users.get(phone) || novoUser(phone);
  const r = await pool.query("select data from xv_users where phone=$1", [phone]);
  return r.rows[0] ? { ...novoUser(phone), ...r.rows[0].data } : novoUser(phone);
}
async function saveUser(u) {
  u.hist = (u.hist || []).filter(h => h && typeof h === "object").slice(-16); // últimas trocas (texto, sem imagens)
  if (!pool) return void mem.users.set(u.phone, u);
  await pool.query(`insert into xv_users(phone,data,updated_at) values($1,$2,now())
                    on conflict(phone) do update set data=$2, updated_at=now()`, [u.phone, u]);
}
async function savePay(id, phone, plano, status) {
  if (!pool) return void mem.pays.set(id, { id, phone, plano, status });
  await pool.query(`insert into xv_payments(id,phone,plano,status) values($1,$2,$3,$4)
                    on conflict(id) do update set status=$4`, [id, phone, plano, status]);
}
async function getPay(id) {
  if (!pool) return mem.pays.get(id) || null;
  const r = await pool.query("select * from xv_payments where id=$1", [id]);
  return r.rows[0] || null;
}

// ============================================================
//  WHATSAPP — enviar / baixar mídia  (prefixo "teste:" vai pro simulador)
// ============================================================
const simCaixa = new Map(); // phone -> [mensagens enviadas pelo bot]
async function wa(payload) {
  if (payload.to.startsWith("teste:")) {
    const arr = simCaixa.get(payload.to) || []; arr.push(payload); simCaixa.set(payload.to, arr); return;
  }
  const r = await fetch(`${CFG.graph}/${CFG.waPhoneId}/messages`, {
    method: "POST", headers: { Authorization: `Bearer ${CFG.waToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", recipient_type: "individual", ...payload }),
  });
  if (!r.ok) log("Erro WhatsApp", r.status, await r.text());
}
const enviarTexto = (to, body) => wa({ to, type: "text", text: { body, preview_url: false } });
const enviarBotoes = (to, body, botoes) => wa({ to, type: "interactive", interactive: { type: "button", body: { text: body },
  action: { buttons: botoes.slice(0, 3).map(b => ({ type: "reply", reply: { id: b.id, title: b.titulo.slice(0, 20) } })) } } });
async function marcarLidoDigitando(msgId) {
  if (!msgId || msgId.startsWith("teste")) return;
  await fetch(`${CFG.graph}/${CFG.waPhoneId}/messages`, {
    method: "POST", headers: { Authorization: `Bearer ${CFG.waToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", status: "read", message_id: msgId, typing_indicator: { type: "text" } }),
  }).catch(() => {});
}
async function baixarMidia(mediaId) {
  const meta = await (await fetch(`${CFG.graph}/${mediaId}`, { headers: { Authorization: `Bearer ${CFG.waToken}` } })).json();
  const bin = await fetch(meta.url, { headers: { Authorization: `Bearer ${CFG.waToken}` } });
  return { buf: Buffer.from(await bin.arrayBuffer()), mime: meta.mime_type || "application/octet-stream" };
}
async function enviarAudio(to, mp3) {
  if (to.startsWith("teste:")) return wa({ to, type: "audio", audio: { _sim: "data:audio/mpeg;base64," + mp3.toString("base64") } });
  const fd = new FormData();
  fd.append("messaging_product", "whatsapp");
  fd.append("type", "audio/mpeg");
  fd.append("file", new Blob([mp3], { type: "audio/mpeg" }), "xaveco.mp3");
  const up = await (await fetch(`${CFG.graph}/${CFG.waPhoneId}/media`, { method: "POST", headers: { Authorization: `Bearer ${CFG.waToken}` }, body: fd })).json();
  if (up.id) await wa({ to, type: "audio", audio: { id: up.id } });
  else log("Erro upload áudio", up);
}

// ============================================================
//  IA
// ============================================================
const PERSONA = `Você é o XAVECO — a IA do Patrick (criador de conteúdo de São Paulo), treinada no jeito dele de falar. Você conversa no WhatsApp com quem quer ajuda pra mandar a mensagem certa pra alguém que está a fim.

COMO VOCÊ CONVERSA (o mais humano possível):
- É uma conversa de WhatsApp entre amigos, não um atendimento. Gíria leve de SP ("mano", "tá ligado", "fechou", "pô"), humor, confiança. Nada de "Claro! Aqui está", nada de lista, nada de tópico, nada de textão.
- Responda em 1 a 3 balões curtos (cada um com 1–2 frases), como alguém digitando de verdade. Às vezes 1 balão basta.
- Primeiro ENTENDA a situação: quem é a pessoa, de onde se conhecem, o que já rolou, o que ele quer (puxar assunto, chamar pra sair, reverter um vácuo...). Faça UMA pergunta por vez, só o que precisar. Se já der pra ajudar, ajuda — não interrogue à toa.
- Quando fizer sentido, peça o print ("me manda o print da conversa que eu vejo o clima"). Print de perfil/story também serve pra puxar assunto.
- Quando tiver contexto suficiente (ou receber um print), entregue A mensagem certa no campo "xaveco" — UMA mensagem, pronta pra copiar, com cara de WhatsApp real (minúsculas, natural, no máximo 1 emoji). Nos balões, explique rapidinho o porquê, como amigo ("ela deixou a deixa do rolê, aproveita", "não manda textão, deixa ela responder"). Comente o clima/interesse de forma natural se tiver print ("ela tá dando abertura, dá pra ir").
- Se ele pedir outra versão (mais ousada, mais leve, mais engraçada), mande outra no "xaveco".
- Lembre do que já foi conversado e continue a história (ex.: "e aí, ela respondeu?").
- Se perguntarem se é robô/IA ou se é o Patrick mesmo: diga com leveza que é a IA do Patrick, treinada no jeito dele. Nunca afirme ser humano.
- Se perguntarem como funciona/preço: ${"{"}PRODUTO${"}"}

REGRAS (inegociáveis):
- Nada de conteúdo sexual explícito, nudes ou vulgaridade. Ousado = confiante, nunca apelativo.
- Respeito: se a outra pessoa disse não, pediu pra parar, bloqueou ou claramente não quer, NÃO ajude a insistir — fale com carinho pra respeitar e seguir a vida.
- Nada de manipulação, mentira, chantagem emocional, ciúme forçado ou humilhação.
- Qualquer sinal de menor de idade na história → não ajude com xaveco.
- Não repita dados pessoais (telefone, endereço, sobrenome) que aparecerem em prints.`;

const FORMATO = `Responda SOMENTE um JSON válido:
{
  "baloes": ["balão 1", "balão 2"],          // 1 a 3 mensagens curtas suas, na ordem
  "xaveco": null ou "a mensagem pronta pra ele copiar e mandar",
  "audio": null ou "o que você falaria num áudio de até 15 segundos (máx. ~35 palavras), no lugar dos balões",
  "resumo_print": null ou "1 frase descrevendo o que tinha no print (pra você lembrar depois)"
}
- Use "audio" quando a pessoa tiver mandado ÁUDIO (aí responda falando, natural, sem emoji). O áudio substitui os balões; se tiver xaveco, ele continua indo em texto separado pra copiar.
- Se entregar um xaveco, o último balão (ou o fim do áudio) deve introduzir ele naturalmente ("manda essa aqui 👇").`;

function promptSistema(u, extra) {
  const s = CFG.planos.semana, m = CFG.planos.mes;
  const produto = `o Xaveco ajuda a destravar conversa: a pessoa conta a situação por texto ou áudio, manda print se quiser, e recebe a mensagem certa. Tem ${CFG.gratis} xavecos grátis; depois é ${brl(s.valor)} a semana ou ${brl(m.valor)} o mês, no Pix (manda "assinar").`;
  const status = assinante(u) ? "Quem está falando com você é ASSINANTE (ilimitado)." : `Quem está falando com você está no grátis: já recebeu ${u.gratisUsados} de ${CFG.gratis} xavecos.`;
  return PERSONA.replace("{PRODUTO}", produto) + "\n\n" + FORMATO + `\n\n${status}${u.nome ? ` O nome dessa pessoa no WhatsApp é ${u.nome}.` : ""}${extra ? "\n" + extra : ""}`;
}
async function openai(messages, json = true) {
  let ultimo;
  for (const model of CFG.models) {
    const body = { model, messages };
    if (json) body.response_format = { type: "json_object" };
    if (/^(gpt-5|o\d)/.test(model)) body.reasoning_effort = "low";
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST", headers: { Authorization: `Bearer ${CFG.openaiKey}`, "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({}));
    if (r.ok) return j.choices[0].message.content;
    ultimo = new Error(`${model}: ${r.status} ${j.error && j.error.message}`); log(ultimo.message);
    if (r.status === 401 || r.status === 429) break;
  }
  throw ultimo;
}
async function transcrever(buf, mime) {
  for (const model of CFG.transcribeModels) {
    const fd = new FormData();
    fd.append("model", model); fd.append("language", "pt");
    const ext = mime.includes("ogg") ? "ogg" : mime.includes("mpeg") ? "mp3" : mime.includes("webm") ? "webm" : mime.includes("wav") ? "wav" : "m4a";
    fd.append("file", new Blob([buf], { type: mime.split(";")[0] }), "audio." + ext);
    const r = await fetch("https://api.openai.com/v1/audio/transcriptions", { method: "POST", headers: { Authorization: `Bearer ${CFG.openaiKey}` }, body: fd });
    const j = await r.json().catch(() => ({}));
    if (r.ok) return j.text || "";
    log("Transcrição falhou", model, r.status, j.error && j.error.message);
  }
  return "";
}
async function conversar(u, { texto, imagem, veioDeAudio }) {
  const hist = (u.hist || []).filter(h => h && typeof h === "object").map(h => ({ role: h.r === "u" ? "user" : "assistant", content: h.t }));
  const atual = [];
  if (imagem) atual.push({ type: "image_url", image_url: { url: `data:${imagem.mime};base64,${imagem.buf.toString("base64")}` } });
  atual.push({ type: "text", text: (imagem ? "[mandou um print]" : veioDeAudio ? "[mandou um ÁUDIO, transcrição]: " : "") + (texto ? (imagem ? " " : "") + texto : "") || "[mensagem vazia]" });
  const raw = await openai([{ role: "system", content: promptSistema(u, veioDeAudio ? "A ÚLTIMA mensagem veio em áudio: responda no campo audio." : "") }, ...hist, { role: "user", content: atual }]);
  let r; try { r = JSON.parse(raw); } catch { r = { baloes: [String(raw || "").slice(0, 300) || "Opa, me conta de novo? 😅"] }; }
  r.baloes = (Array.isArray(r.baloes) ? r.baloes : [r.baloes]).filter(x => typeof x === "string" && x.trim()).slice(0, 3);
  if (typeof r.xaveco !== "string" || !r.xaveco.trim()) r.xaveco = null;
  if (typeof r.audio !== "string" || !r.audio.trim()) r.audio = null;
  if (!r.baloes.length && !r.audio) r.baloes = [r.xaveco ? "manda essa aqui 👇" : "Me conta melhor a situação? 👀"];
  return r;
}
async function vozDoPatrick(texto) {
  if (!CFG.elevenKey || !CFG.elevenVoice || !texto) return null;
  const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${CFG.elevenVoice}?output_format=mp3_44100_64`, {
    method: "POST", headers: { "xi-api-key": CFG.elevenKey, "Content-Type": "application/json", Accept: "audio/mpeg" },
    body: JSON.stringify({ text: texto.slice(0, 260), model_id: E.ELEVENLABS_MODEL || "eleven_multilingual_v2" }),
  });
  if (!r.ok) { log("ElevenLabs", r.status, await r.text()); return null; }
  return Buffer.from(await r.arrayBuffer());
}

// ============================================================
//  ASAAS (Pix)
// ============================================================
async function asaas(method, p, body) {
  const r = await fetch(CFG.asaasUrl + p, { method, headers: { access_token: CFG.asaasKey, "Content-Type": "application/json", "User-Agent": "xaveco" },
    body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Asaas ${p}: ${r.status} ${JSON.stringify(j.errors || j)}`);
  return j;
}
function cpfValido(c) {
  c = String(c).replace(/\D/g, "");
  if (c.length !== 11 || /^(\d)\1+$/.test(c)) return false;
  const dv = n => { let s = 0; for (let i = 0; i < n; i++) s += +c[i] * (n + 1 - i); const r = (s * 10) % 11; return r === 10 ? 0 : r; };
  return dv(9) === +c[9] && dv(10) === +c[10];
}
async function gerarPix(u, plano) {
  const p = CFG.planos[plano];
  const pay = await asaas("POST", "/payments", { customer: u.asaasCliente, billingType: "PIX", value: p.valor, dueDate: hojeSP(),
    description: `Xaveco ilimitado — ${p.nome}`, externalReference: `${u.phone}|${plano}` });
  await savePay(pay.id, u.phone, plano, "PENDING");
  const qr = await asaas("GET", `/payments/${pay.id}/pixQrCode`);
  return qr.payload;
}

// ============================================================
//  FLUXO DA CONVERSA
// ============================================================
const assinante = u => u.ate > Date.now();
const MENU = `Tô aqui pra te ajudar a destravar a conversa 😏
Me conta a situação (escrito ou áudio), manda o print da conversa ou do perfil, e eu te falo a mensagem certa.

Comandos: *assinar* · *status* · *voz off* / *voz on*`;
const espera = (to, txt) => to.startsWith("teste:") ? Promise.resolve() : new Promise(r => setTimeout(r, Math.min(700 + String(txt).length * 30, 3500)));

async function aoReceber(phone, msg) {
  const u = await getUser(phone);
  if (msg._nome && !u.nome) u.nome = String(msg._nome).split(" ")[0].slice(0, 30);
  const tipo = msg.type;
  const textoBruto = tipo === "text" ? (msg.text?.body || "").trim()
    : tipo === "interactive" ? (msg.interactive?.button_reply?.id || msg.interactive?.list_reply?.id || "") : "";
  const t = textoBruto.toLowerCase();

  // 1) Primeiro contato → verificação de idade
  if (!u.maior) {
    if (t === "idade_sim") { u.maior = true; u.estado = "pronto"; await saveUser(u);
      await enviarTexto(phone, `Fechou${u.nome ? ", " + u.nome : ""}! 🤝`); await espera(phone, "xx");
      return enviarTexto(phone, "Aqui é o Xaveco, a IA do Patrick 😏 Me conta: qual é a situação? Pode mandar áudio, print, o que for."); }
    if (t === "idade_nao") { u.estado = "menor"; await saveUser(u);
      return enviarTexto(phone, "Valeu pela sinceridade! 🙏 O Xaveco é só pra maiores de 18. Volta aqui quando fizer 18 que a gente se fala."); }
    if (u.estado === "menor") return enviarTexto(phone, "O Xaveco é só pra maiores de 18 🙏");
    u.estado = "idade"; await saveUser(u);
    return enviarBotoes(phone, "E aí! 👋 Antes de começar: você tem 18 anos ou mais?", [{ id: "idade_sim", titulo: "Tenho 18+" }, { id: "idade_nao", titulo: "Sou menor" }]);
  }

  // 2) Comandos
  if (/^(menu|ajuda|help|comandos)\W*$/.test(t)) return enviarTexto(phone, MENU);
  if (t === "voz off" || t === "voz on") { u.voz = t === "voz on"; await saveUser(u); return enviarTexto(phone, u.voz ? "🎙️ Fechou, quando você mandar áudio eu respondo em áudio." : "🔇 Beleza, respondo só escrito."); }
  if (t === "status") {
    return enviarTexto(phone, assinante(u) ? `✅ Xaveco ilimitado até *${dataBR(u.ate)}*.`
      : `Você usou ${Math.min(u.gratisUsados, CFG.gratis)} de ${CFG.gratis} xavecos grátis. Manda *assinar* pra liberar ilimitado.`);
  }
  if (t === "assinar" || t === "plano" || t === "pagar") return oferecerPlanos(u);
  if (t === "plano_semana" || t === "plano_mes") {
    u.planoPendente = t.replace("plano_", "");
    if (!u.asaasCliente) { u.estado = "cpf"; await saveUser(u);
      return enviarTexto(phone, "Boa! 🔥 Pra gerar o Pix, o banco pede seu *CPF* (só números). Ele vai direto pro sistema de pagamento, eu não guardo."); }
    await saveUser(u); return mandarPix(u);
  }
  if (u.estado === "cpf" && tipo === "text" && /^[\d.\-\s]{11,14}$/.test(t)) {
    const cpf = t.replace(/\D/g, "");
    if (!cpfValido(cpf)) return enviarTexto(phone, "Esse CPF não bateu 🤔 Manda de novo, só os 11 números. (Ou *cancelar*)");
    try {
      const c = await asaas("POST", "/customers", { name: msg._nome || "Cliente Xaveco", cpfCnpj: cpf, mobilePhone: phone.replace(/^55/, ""), notificationDisabled: true });
      u.asaasCliente = c.id; u.estado = "pronto"; await saveUser(u);
      return mandarPix(u);
    } catch (e) { log(e.message); return enviarTexto(phone, "Deu ruim pra gerar o pagamento agora 😕 Tenta de novo em alguns minutos mandando *assinar*."); }
  }
  if (t === "cancelar") { u.estado = "pronto"; await saveUser(u); return enviarTexto(phone, "Beleza, cancelado 👊 Bora voltar pro xaveco?"); }

  // 3) Conversa (texto, áudio ou print)
  const suportado = tipo === "text" || tipo === "image" || tipo === "audio" || (tipo === "document" && /image/.test(msg.document?.mime_type || ""));
  if (!suportado) return enviarTexto(phone, "Esse tipo de mensagem eu não consigo ver 😅 Manda escrito, áudio ou print.");
  if (u.estado === "cpf") { u.estado = "pronto"; } // mudou de assunto no meio do pagamento

  // cota
  if (!assinante(u) && (u.gratisUsados >= CFG.gratis || (u.turnos || 0) >= CFG.conversaGratis)) return oferecerPlanos(u, true);
  if (assinante(u)) {
    if (u.diaData !== hojeSP()) { u.diaData = hojeSP(); u.diaUsos = 0; }
    if (u.diaUsos >= CFG.limiteDiario) return enviarTexto(phone, "Hoje já foi muito papo 😅 Seu limite do dia acabou, amanhã a gente continua!");
  }

  await marcarLidoDigitando(msg.id);
  let r, texto = "", veioDeAudio = false, imagem = null;
  try {
    texto = tipo === "text" ? textoBruto : (msg.image?.caption || msg.document?.caption || "");
    if (tipo === "image" || tipo === "document") imagem = msg._imagem || await baixarMidia((msg.image || msg.document).id);
    if (tipo === "audio") {
      const a = msg._audio || await baixarMidia(msg.audio.id);
      texto = msg._transcricao || await transcrever(a.buf, a.mime);
      veioDeAudio = true;
      if (!texto) return enviarTexto(phone, "Não consegui ouvir o áudio 😕 Manda de novo ou escreve.");
    }
    r = await conversar(u, { texto, imagem, veioDeAudio });
  } catch (e) { log("Erro IA", e.message); return enviarTexto(phone, "Opa, deu uma travada aqui 😅 Manda de novo em 1 minutinho."); }

  // memória da conversa (sem guardar a imagem)
  u.hist.push({ r: "u", t: imagem ? `[mandou um print${r.resumo_print ? ": " + r.resumo_print : ""}]${texto ? " " + texto : ""}` : (veioDeAudio ? "[áudio] " : "") + texto });
  u.hist.push({ r: "a", t: (r.audio || r.baloes.join("\n")) + (r.xaveco ? `\n[sugeri a mensagem: "${r.xaveco}"]` : "") });
  u.turnos = (u.turnos || 0) + 1;
  if (assinante(u)) u.diaUsos++; else if (r.xaveco) u.gratisUsados++;
  await saveUser(u);

  // resposta: áudio (se veio áudio) ou balões de texto, com "digitando…" entre eles
  let foiAudio = false;
  if (veioDeAudio && u.voz) {
    const mp3 = await vozDoPatrick(r.audio || r.baloes.join(" ")).catch(() => null);
    if (mp3) { await enviarAudio(phone, mp3); foiAudio = true; }
  }
  if (!foiAudio) {
    const baloes = r.baloes.length ? r.baloes : [r.audio];
    for (let i = 0; i < baloes.length; i++) {
      if (i > 0) { await marcarLidoDigitando(msg.id); await espera(phone, baloes[i]); }
      await enviarTexto(phone, baloes[i]);
    }
  }
  if (r.xaveco) { await espera(phone, r.xaveco); await enviarTexto(phone, r.xaveco); }

  if (r.xaveco && !assinante(u)) {
    const rest = CFG.gratis - u.gratisUsados;
    if (rest === 0) { await espera(phone, "xxxxxxxxxxxx"); await enviarTexto(phone, "Ó, esse foi seu último xaveco grátis 😮‍💨 Se curtiu, manda *assinar* que eu libero ilimitado 🔓"); }
  }
}

async function oferecerPlanos(u, acabou = false) {
  const s = CFG.planos.semana, m = CFG.planos.mes;
  return enviarBotoes(u.phone, `${acabou ? "Pô, seus xavecos grátis acabaram 😮‍💨 Bora continuar?\n\n" : ""}🔓 *Xaveco ilimitado*\nPrint, perfil, áudio, termômetro — quantas vezes quiser.\n\n• ${s.nome}: *${brl(s.valor)}*\n• ${m.nome}: *${brl(m.valor)}* (melhor custo)\n\nPagamento no Pix, liberação na hora.`,
    [{ id: "plano_semana", titulo: `Semana ${brl(s.valor)}` }, { id: "plano_mes", titulo: `Mês ${brl(m.valor)}` }]);
}
async function mandarPix(u) {
  try {
    const code = await gerarPix(u, u.planoPendente || "mes");
    await enviarTexto(u.phone, `💸 *Pix do Xaveco — ${CFG.planos[u.planoPendente || "mes"].nome} (${brl(CFG.planos[u.planoPendente || "mes"].valor)})*\n\nCopia o código abaixo e cola no app do seu banco em *Pix Copia e Cola*. Assim que cair, eu libero automaticamente ✅`);
    await enviarTexto(u.phone, code);
  } catch (e) { log(e.message); await enviarTexto(u.phone, "Deu ruim pra gerar o Pix agora 😕 Tenta de novo em alguns minutos mandando *assinar*."); }
}

// pagamento confirmado (webhook Asaas)
async function pagamentoConfirmado(payment) {
  const ja = await getPay(payment.id);
  if (ja && ja.status === "PAID") return;
  const [phone, plano] = String(payment.externalReference || "").split("|");
  if (!phone || !CFG.planos[plano]) return log("Pagamento sem referência", payment.id);
  await savePay(payment.id, phone, plano, "PAID");
  const u = await getUser(phone);
  u.ate = Math.max(Date.now(), u.ate || 0) + CFG.planos[plano].dias * 864e5;
  u.planoPendente = ""; u.estado = "pronto";
  await saveUser(u);
  log("Pago", phone, plano);
  await enviarTexto(phone, `Pagamento confirmado! ✅🔥\n\nXaveco *ilimitado* liberado até *${dataBR(u.ate)}*. Manda o próximo print 👇`);
}

// ============================================================
//  SERVIDOR HTTP
// ============================================================
const vistos = new Set(); // evita responder 2x quando a Meta reenvia
function lerCorpo(req, limite = 25e6) {
  return new Promise((ok, erro) => { const ch = []; let n = 0;
    req.on("data", d => { n += d.length; if (n > limite) { erro(new Error("grande demais")); req.destroy(); } else ch.push(d); });
    req.on("end", () => ok(Buffer.concat(ch))); req.on("error", erro); });
}
const json = (res, code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  try {
    // --- Verificação do webhook da Meta
    if (req.method === "GET" && url.pathname === "/webhook") {
      if (url.searchParams.get("hub.mode") === "subscribe" && url.searchParams.get("hub.verify_token") === CFG.waVerify) { res.writeHead(200); return res.end(url.searchParams.get("hub.challenge")); }
      res.writeHead(403); return res.end();
    }
    // --- Mensagens do WhatsApp
    if (req.method === "POST" && url.pathname === "/webhook") {
      const raw = await lerCorpo(req);
      if (CFG.appSecret) {
        const sig = "sha256=" + crypto.createHmac("sha256", CFG.appSecret).update(raw).digest("hex");
        const got = req.headers["x-hub-signature-256"] || "";
        if (sig.length !== got.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(got))) { res.writeHead(401); return res.end(); }
      }
      res.writeHead(200); res.end("ok"); // responde rápido; processa depois
      const body = JSON.parse(raw.toString() || "{}");
      for (const entry of body.entry || []) for (const ch of entry.changes || []) {
        const v = ch.value || {};
        const nome = v.contacts?.[0]?.profile?.name;
        for (const m of v.messages || []) {
          if (vistos.has(m.id)) continue; vistos.add(m.id); if (vistos.size > 5000) vistos.clear();
          m._nome = nome;
          aoReceber(m.from, m).catch(e => log("Erro fluxo", e));
        }
      }
      return;
    }
    // --- Webhook do Asaas
    if (req.method === "POST" && url.pathname === "/asaas") {
      if (CFG.asaasWebhookToken && req.headers["asaas-access-token"] !== CFG.asaasWebhookToken) { res.writeHead(401); return res.end(); }
      const body = JSON.parse((await lerCorpo(req)).toString() || "{}");
      json(res, 200, { ok: true });
      if (["PAYMENT_RECEIVED", "PAYMENT_CONFIRMED"].includes(body.event) && body.payment) pagamentoConfirmado(body.payment).catch(e => log("Erro pagamento", e));
      return;
    }
    if (url.pathname === "/health") { res.writeHead(200); return res.end("ok"); }

    // --- Tela de teste (simula o WhatsApp sem precisar do número)
    if (url.pathname.startsWith("/teste")) {
      if (!CFG.testeSenha || url.searchParams.get("k") !== CFG.testeSenha) { res.writeHead(404); return res.end(); }
      if (req.method === "GET" && url.pathname === "/teste") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        return res.end(fs.readFileSync(path.join(__dirname, "teste.html")));
      }
      if (req.method === "POST" && url.pathname === "/teste/msg") {
        const b = JSON.parse((await lerCorpo(req)).toString() || "{}");
        const phone = "teste:" + String(b.id || "1").replace(/\W/g, "").slice(0, 20);
        const m = { id: "teste" + Date.now(), type: b.type || "text", _nome: "Teste" };
        if (m.type === "text") m.text = { body: b.text || "" };
        if (m.type === "interactive") m.interactive = { button_reply: { id: b.text } };
        if (m.type === "image") { const [h, d] = String(b.data).split(","); m.image = { caption: b.text || "" }; m._imagem = { mime: h.slice(5).split(";")[0], buf: Buffer.from(d, "base64") }; }
        if (m.type === "audio") { const [h, d] = String(b.data).split(","); m.audio = {}; m._audio = { mime: h.slice(5).split(";")[0], buf: Buffer.from(d, "base64") }; }
        simCaixa.set(phone, []);
        await aoReceber(phone, m);
        return json(res, 200, { respostas: simCaixa.get(phone) || [] });
      }
      if (req.method === "POST" && url.pathname === "/teste/pagar") { // simula o Pix caindo
        const b = JSON.parse((await lerCorpo(req)).toString() || "{}");
        const phone = "teste:" + String(b.id || "1").replace(/\W/g, "").slice(0, 20);
        const u = await getUser(phone);
        simCaixa.set(phone, []);
        await pagamentoConfirmado({ id: "sim" + Date.now(), externalReference: `${phone}|${u.planoPendente || "mes"}` });
        return json(res, 200, { respostas: simCaixa.get(phone) || [] });
      }
      if (req.method === "POST" && url.pathname === "/teste/reset") {
        const b = JSON.parse((await lerCorpo(req)).toString() || "{}");
        const phone = "teste:" + String(b.id || "1").replace(/\W/g, "").slice(0, 20);
        await saveUser(novoUser(phone)); return json(res, 200, { ok: true });
      }
    }
    if (url.pathname === "/") { res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" }); return res.end("Xaveco no ar 🔥"); }
    res.writeHead(404); res.end();
  } catch (e) { log("Erro HTTP", e); if (!res.headersSent) json(res, 500, { erro: "falha" }); }
}).listen(CFG.port, async () => {
  await dbInit().catch(e => log("Erro banco", e.message));
  log(`Xaveco no ar na porta ${CFG.port} | IA: ${CFG.openaiKey ? "ok" : "FALTA OPENAI_API_KEY"} | WhatsApp: ${CFG.waToken && CFG.waPhoneId ? "ok" : "falta configurar"} | Asaas: ${CFG.asaasKey ? "ok" : "falta"} | Voz: ${CFG.elevenKey && CFG.elevenVoice ? "ok" : "desligada"}`);
});
