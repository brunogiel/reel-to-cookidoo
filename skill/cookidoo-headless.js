#!/usr/bin/env node
// ============================================================================
// Cookidoo Headless Loader
// ----------------------------------------------------------------------------
// Versión SIN NAVEGADOR de cookidoo-api-loader.js: hace el login CIAM
// (usuario+contraseña → cookies de sesión) por HTTP directo, replicando el
// flujo OAuth2/PKCE que sigue el editor web, y después reusa el mismo wire
// format reverse-engineered (chips TM6 + ingredientes linkeados) para crear
// o borrar recetas. Cero dependencias npm — solo Node ≥18 (fetch global).
//
// CÓMO SE CORRE
//   1. Copiar `.env.example` a ~/.config/cookidoo/env (chmod 600) y completar:
//        COOKIDOO_EMAIL=...
//        COOKIDOO_PASSWORD=...
//        COOKIDOO_DOMAIN=international   # o "es"
//      (también lee un `.env` en esta carpeta, gitignored, si no existe el otro)
//   2. Listar:  node cookidoo-headless.js list          (correrlo antes de cargar: evita duplicados)
//      Crear:   node cookidoo-headless.js create recipe.json
//      Foto:    node cookidoo-headless.js image <id> foto.jpg
//      Público: node cookidoo-headless.js public <id>   (comparte la receta, devuelve la URL)
//      Borrar:  node cookidoo-headless.js delete <id>
//      (recipe.json = mismo schema que cookidoo-api-loader.js, ver ese header;
//       ejemplo completo en ejemplos/pure-coliflor-miso.json)
//
// La contraseña NUNCA se pasa por chat ni se tipea a mano en un form: vive
// solo en el archivo de entorno y la lee este script del disco.
//
// AUTH — replica el flujo CIAM de cookidoo-api (miaucl/cookidoo-api, Python):
//   1. GET  {origin}/profile/{language}/login?redirectAfterLogin=...  (sigue
//      redirects, junta cookies de cada hop)
//   2. Extraer `requestId` del HTML de la página de login CIAM
//   3. POST credenciales a ciam.prod.cookidoo.vorwerk-digital.com/login-srv/login
//   4. Verificar que quedaron seteadas las cookies `_oauth2_proxy` +
//      `v-authenticated` → esa es la sesión, misma que usa el flujo por
//      navegador (cookidoo-api-loader.js), solo que conseguida sin abrir un browser.
//
// WIRE FORMAT de creación/edición: ver cookidoo-api-loader.js (idéntico,
// portado 1:1 acá con URLs absolutas + header Cookie explícito en vez de
// `credentials:'include'` de una pestaña).
// ============================================================================

const fs = require('fs');
const path = require('path');
const os = require('os');

const DOMAINS = {
  international: { origin: 'https://cookidoo.international', language: 'en' },
  es: { origin: 'https://cookidoo.es', language: 'es-ES' },
};

const CIAM_LOGIN_URL = 'https://ciam.prod.cookidoo.vorwerk-digital.com/login-srv/login';

// ---------------------------------------------------------------------------
// .env parser mínimo (sin dependencias) — solo si las env vars no vinieron ya
// seteadas por el entorno que invoca el script.
// ---------------------------------------------------------------------------
function loadDotEnv() {
  // Credenciales fuera del repo: ~/.config/cookidoo/env (perms 600), primero.
  // Fallback: un .env en esta carpeta (gitignored).
  const candidates = [
    path.join(os.homedir(), '.config', 'cookidoo', 'env'),
    path.join(__dirname, '.env'),
  ];
  const envPath = candidates.find(p => fs.existsSync(p));
  if (!envPath) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const key = m[1];
    let val = m[2];
    if (/^".*"$/.test(val) || /^'.*'$/.test(val)) val = val.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

// ---------------------------------------------------------------------------
// Cookie jar mínimo, por hostname (alcanza para los ~2 hosts del flujo CIAM)
// ---------------------------------------------------------------------------
function newJar() { return new Map(); }

function jarStore(jar, hostname, name, value) {
  if (!jar.has(hostname)) jar.set(hostname, new Map());
  jar.get(hostname).set(name, value);
}

function updateJarFromResponse(jar, url, resp) {
  const setCookies = typeof resp.headers.getSetCookie === 'function'
    ? resp.headers.getSetCookie()
    : (resp.headers.raw ? resp.headers.raw()['set-cookie'] || [] : []);
  for (const raw of setCookies) {
    const [pair, ...attrs] = raw.split(';');
    const eq = pair.indexOf('=');
    if (eq < 0) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    const domainAttr = attrs.map((a) => a.trim()).find((a) => /^domain=/i.test(a));
    const hostname = domainAttr ? domainAttr.split('=')[1].replace(/^\./, '') : new URL(url).hostname;
    jarStore(jar, hostname, name, value);
  }
}

function cookieHeaderFor(jar, url) {
  const host = new URL(url).hostname;
  const parts = [];
  for (const [domain, cookies] of jar) {
    if (host === domain || host.endsWith(`.${domain}`)) {
      for (const [name, value] of cookies) parts.push(`${name}=${value}`);
    }
  }
  return parts.join('; ');
}

function allCookieNames(jar) {
  const names = new Set();
  for (const cookies of jar.values()) for (const name of cookies.keys()) names.add(name);
  return names;
}

// Fetch que seguí redirects a mano (para no perder cookies en el camino) y
// mantiene el jar actualizado en cada hop.
async function fetchWithJar(jar, url, options = {}, hop = 0) {
  if (hop > 10) throw new Error('Demasiados redirects siguiendo el login de Cookidoo.');
  const headers = { ...(options.headers || {}) };
  const cookieHeader = cookieHeaderFor(jar, url);
  if (cookieHeader) headers.cookie = cookieHeader;

  const resp = await fetch(url, { ...options, headers, redirect: 'manual' });
  updateJarFromResponse(jar, url, resp);

  if ([301, 302, 303, 307, 308].includes(resp.status)) {
    const location = resp.headers.get('location');
    await resp.text().catch(() => {});
    if (!location) return resp;
    const nextUrl = new URL(location, url).toString();
    const keepMethodAndBody = [307, 308].includes(resp.status);
    const nextOptions = keepMethodAndBody
      ? options
      : { method: 'GET' };
    return fetchWithJar(jar, nextUrl, nextOptions, hop + 1);
  }
  return resp;
}

// ---------------------------------------------------------------------------
// Login CIAM headless
// ---------------------------------------------------------------------------
async function cookidooLogin(jar, { origin, language, email, password }) {
  const loginUrl = new URL(`${origin}/profile/${language}/login`);
  loginUrl.searchParams.set('redirectAfterLogin', `/foundation/${language}/for-you`);

  let resp = await fetchWithJar(jar, loginUrl.toString(), { method: 'GET' });
  const html = await resp.text();

  const m = html.match(/<input[^>]*name=["']requestId["'][^>]*value=["']([^"']+)["']/)
    || html.match(/<input[^>]*value=["']([0-9a-f-]{36})["'][^>]*name=["']requestId["']/);
  if (!m) {
    throw new Error('No pude extraer requestId de la página de login CIAM (¿cambió el flujo? probar el fallback por navegador).');
  }
  const requestId = m[1];

  const body = new URLSearchParams({ requestId, username: email, password });
  await fetchWithJar(jar, CIAM_LOGIN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  const names = allCookieNames(jar);
  if (!names.has('_oauth2_proxy') || !names.has('v-authenticated')) {
    throw new Error('Login falló: no quedaron seteadas las cookies de sesión (revisar COOKIDOO_EMAIL/COOKIDOO_PASSWORD en .env).');
  }
}

// ---------------------------------------------------------------------------
// Loader — mismo wire format que cookidoo-api-loader.js, con URLs absolutas
// y Cookie header explícito en vez de credentials:'include' de una pestaña.
// ---------------------------------------------------------------------------
function apiBase(origin, language) { return `${origin}/created-recipes/${language}`; }

async function jreq(jar, method, url, body) {
  const resp = await fetchWithJar(jar, url, {
    method,
    headers: { 'content-type': 'application/json; charset=UTF-8', accept: 'application/json' },
    body: body != null ? JSON.stringify(body) : undefined,
  });
  const t = await resp.text();
  let j; try { j = JSON.parse(t); } catch (_) { j = t; }
  if (resp.status >= 300) throw new Error(`${method} ${url} -> ${resp.status}: ${(j && j.message) || t}`.slice(0, 300));
  return j;
}

function ttsLabel(s) {
  const parts = [];
  const t = s.time;
  if (t != null) {
    if (t < 60) parts.push(`${t} sec`);
    else if (t % 60 === 0) parts.push(`${t / 60} min`);
    else parts.push(`${Math.floor(t / 60)} min ${t % 60} sec`);
  }
  if (s.temperature) {
    const v = s.temperature.value != null ? s.temperature.value : s.temperature;
    parts.push(/varoma/i.test(String(v)) ? 'Varoma' : `${v}°C`);
  }
  // Giro inverso: el editor mete el ícono \uE003 entre temp y velocidad ("10 sec/\uE003/speed 1").
  // Vel cuchara = speed 'soft' → se imprime con el ícono \uE002. Sacado del bundle pl-customer-recipes (30-09-2026).
  if (s.reverse) parts.push('\uE003');
  if (s.speed != null) parts.push(`speed ${String(s.speed) === 'soft' ? '\uE002' : s.speed}`);
  return parts.join('/');
}

function ttsData(s) {
  const d = {};
  if (s.speed != null) d.speed = String(s.speed);
  if (s.time != null) d.time = Number(s.time);
  if (s.temperature) {
    const v = s.temperature.value != null ? s.temperature.value : s.temperature;
    // Varoma: la API solo acepta 'varoma' en minúscula ('Varoma' → 400), con unit 'C' (30-09-2026).
    d.temperature = /varoma/i.test(String(v)) ? { value: 'varoma', unit: 'C' } : { value: String(v), unit: s.temperature.unit || 'C' };
  }
  if (s.reverse) d.direction = 'CCW'; // valores válidos: 'CW' (default, se omite) | 'CCW'. 'reverse' → 400.
  return d;
}

async function ingredientAnnotations(jar, origin, language, id, recipe, ings, proseList) {
  const annRecipe = {
    recipeId: id, name: recipe.name, image: null, isImageOwnedByUser: false,
    tools: recipe.tools || ['TM6'], yield: recipe.yield || { value: 4, unitText: 'portion' },
    prepTime: null, cookTime: null, totalTime: null,
    ingredients: ings, instructions: proseList.map((t) => ({ type: 'STEP', text: t })),
    hints: '', workStatus: 'PRIVATE', recipeMetadata: { requiresAnnotationsCheck: false },
  };
  const ann = await jreq(jar, 'POST', `${apiBase(origin, language)}/annotate/steps`, {
    recipe: annRecipe, options: { stepIndexes: proseList.map((_, i) => i) },
  });
  return (ann.recipeContent.instructions || []).map((tokenArr) => {
    let text = ''; const anns = [];
    for (const tk of tokenArr) {
      const off = text.length, seg = tk.text || '';
      text += seg;
      if (tk.type === 'INGREDIENT') {
        anns.push({
          type: 'INGREDIENT',
          data: { description: (tk.settings && tk.settings.description) || seg },
          position: { offset: off, length: seg.length },
        });
      }
    }
    return { text, anns };
  });
}

async function cookidooLoad(jar, origin, language, recipe, opts = {}) {
  const base0 = apiBase(origin, language);
  let id = recipe.recipeId;
  if (!id) { const c = await jreq(jar, 'POST', base0, { recipeName: recipe.name || 'Sin nombre' }); id = c.recipeId; }
  const base = `${base0}/${id}`;

  await jreq(jar, 'PATCH', base, { name: recipe.name });
  if (recipe.yield) await jreq(jar, 'PATCH', base, { yield: recipe.yield });
  if (recipe.tools) await jreq(jar, 'PATCH', base, { tools: recipe.tools });
  const times = {};
  ['prepTime', 'cookTime', 'totalTime'].forEach((k) => { if (recipe[k] != null) times[k] = recipe[k]; });
  if (Object.keys(times).length) await jreq(jar, 'PATCH', base, times);
  if (recipe.hints != null) await jreq(jar, 'PATCH', base, { hints: recipe.hints });

  const ings = (recipe.ingredients || []).map((i) => (typeof i === 'string' ? { type: 'INGREDIENT', text: i } : i));
  await jreq(jar, 'PATCH', base, { ingredients: ings });

  const steps = (recipe.steps || []).map((s) => (typeof s === 'string' ? { prose: s } : s));
  const proseList = steps.map((s) => s.prose);
  let ingAnns = [];
  if (opts.linkIngredients !== false && proseList.length) {
    try { ingAnns = await ingredientAnnotations(jar, origin, language, id, recipe, ings, proseList); }
    catch (e) { console.warn('annotate falló, sigo sin linkear ingredientes:', e.message); }
  }
  const instructions = steps.map((s, i) => {
    let text = (ingAnns[i] && ingAnns[i].text) || s.prose || '';
    const anns = (ingAnns[i] && ingAnns[i].anns) ? ingAnns[i].anns.slice() : [];
    if (s.settings) {
      const label = ttsLabel(s.settings);
      if (label) {
        if (text.length && !/\s$/.test(text)) text += ' ';
        const off = text.length;
        text += label;
        anns.push({ type: 'TTS', data: ttsData(s.settings), position: { offset: off, length: label.length } });
      }
    }
    return { type: 'STEP', text, annotations: anns };
  });
  await jreq(jar, 'PATCH', base, { instructions });

  return { id, url: `${origin}/created-recipes/${language}/${id}` };
}

async function cookidooDelete(jar, origin, language, id) {
  const resp = await fetchWithJar(jar, `${apiBase(origin, language)}/${id}`, {
    method: 'DELETE',
    headers: { accept: 'application/json' },
  });
  return resp.status; // 204 ok, 410 si ya estaba borrada
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// FOTO (resuelto 30-09-2026): el widget de Cloudinary del editor es solo UI.
// Flujo real: (1) POST {origin}/created-recipes/{lang}/image/signature con
// {timestamp, source:'uw'} -> {signature}  (el server agrega el upload_preset solo);
// (2) POST multipart a https://api-eu.cloudinary.com/v1_1/vorwerk-users-gc/image/upload
// con file + api_key + timestamp + source + upload_preset + signature -> {public_id, format};
// (3) PATCH la receta con {image:`${public_id}.${format}`, isImageOwnedByUser:true}.
// api_key, cloud y preset salen de los atributos de <core-upload-modal> en /edit.
// ---------------------------------------------------------------------------
const CLD = { apiKey: '993585863591145', cloud: 'vorwerk-users-gc', preset: 'prod-customer-recipe-signed', host: 'https://api-eu.cloudinary.com' };

async function cookidooUploadImage(jar, origin, language, id, file) {
  const ts = Math.floor(Date.now() / 1000);
  const { signature } = await jreq(jar, 'POST', `${origin}/created-recipes/${language}/image/signature`, { timestamp: ts, source: 'uw' });
  const fd = new FormData();
  const type = /\.png$/i.test(file) ? 'image/png' : 'image/jpeg';
  fd.append('file', new Blob([fs.readFileSync(file)], { type }), path.basename(file));
  fd.append('api_key', CLD.apiKey); fd.append('timestamp', String(ts)); fd.append('source', 'uw');
  fd.append('upload_preset', CLD.preset); fd.append('signature', signature);
  const r = await fetch(`${CLD.host}/v1_1/${CLD.cloud}/image/upload`, { method: 'POST', body: fd });
  const u = JSON.parse(await r.text());
  if (!u.public_id) throw new Error(`Cloudinary ${r.status}: ${(u.error && u.error.message) || 'sin public_id'}`);
  const j = await jreq(jar, 'PATCH', `${origin}/created-recipes/${language}/${id}`, { image: `${u.public_id}.${u.format}`, isImageOwnedByUser: true });
  return { id, image: (j.recipeContent || {}).image };
}

async function main() {
  loadDotEnv();
  const email = process.env.COOKIDOO_EMAIL;
  const password = process.env.COOKIDOO_PASSWORD;
  const domainKey = process.env.COOKIDOO_DOMAIN || 'international';
  const domain = DOMAINS[domainKey];

  if (!email || !password) {
    console.error('Faltan COOKIDOO_EMAIL / COOKIDOO_PASSWORD (completar .env, ver .env.example).');
    process.exit(1);
  }
  if (!domain) {
    console.error(`COOKIDOO_DOMAIN inválido: "${domainKey}". Usar "international" o "es".`);
    process.exit(1);
  }

  const [, , cmd, arg] = process.argv;
  const jar = newJar();
  await cookidooLogin(jar, { origin: domain.origin, language: domain.language, email, password });

  if (cmd === 'create') {
    if (!arg) { console.error('Uso: node cookidoo-headless.js create <recipe.json>'); process.exit(1); }
    const recipe = JSON.parse(fs.readFileSync(arg, 'utf8'));
    const result = await cookidooLoad(jar, domain.origin, domain.language, recipe);
    console.log(JSON.stringify(result));
  } else if (cmd === 'image') {
    const file = process.argv[4];
    if (!arg || !file) { console.error('Uso: node cookidoo-headless.js image <id> <foto.jpg>'); process.exit(1); }
    console.log(JSON.stringify(await cookidooUploadImage(jar, domain.origin, domain.language, arg, file)));
  } else if (cmd === 'list') {
    // Lista las recetas creadas (id + nombre) leyendo la página «Created Recipes».
    const resp = await fetchWithJar(jar, `${apiBase(domain.origin, domain.language)}`, { headers: { accept: 'text/html' } });
    const html = await resp.text();
    const seen = new Map();
    const re = /\/created-recipes\/[a-zA-Z-]+\/([0-9A-Z]{26})[^>]*>([\s\S]{0,400}?)<\/a>/g;
    let m;
    while ((m = re.exec(html))) {
      const name = m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      if (!seen.has(m[1]) || (!seen.get(m[1]) && name)) seen.set(m[1], name);
    }
    if (!seen.size) { console.error(`Sin recetas en el HTML (status ${resp.status}, ${html.length} bytes).`); process.exit(1); }
    for (const id of seen.keys()) {
      let name = '', status = '';
      try {
        const r = await jreq(jar, 'GET', `${apiBase(domain.origin, domain.language)}/${id}`);
        name = (r.recipeContent && r.recipeContent.name) || r.name || ''; status = r.workStatus || '';
      } catch (e) { name = `(no se pudo leer: ${e.message || e})`; }
      console.log(`${id}\t${status}\t${name}`);
    }
  } else if (cmd === 'public') {
    // Comparte la receta (workStatus PUBLIC) e imprime su URL pública (sirve para un QR).
    // Es publicar: correrlo solo si el usuario lo pidió.
    if (!arg) { console.error('Uso: node cookidoo-headless.js public <id>'); process.exit(1); }
    const url = `${apiBase(domain.origin, domain.language)}/${arg}`;
    await jreq(jar, 'PATCH', url, { workStatus: 'PUBLIC' });
    const r = await jreq(jar, 'GET', url);
    const publicUrl = `${domain.origin}/created-recipes/public/recipes/es/${arg}`;
    const check = await fetch(publicUrl);
    console.log(JSON.stringify({ id: arg, workStatus: r.workStatus, publicUrl, httpPublico: check.status }));
  } else if (cmd === 'delete') {
    if (!arg) { console.error('Uso: node cookidoo-headless.js delete <id>'); process.exit(1); }
    const status = await cookidooDelete(jar, domain.origin, domain.language, arg);
    console.log(JSON.stringify({ id: arg, status }));
  } else {
    console.error('Uso: node cookidoo-headless.js create <recipe.json> | image <id> <foto.jpg> | list | public <id> | delete <id>');
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch((e) => { console.error(e.message || e); process.exit(1); });
}

module.exports = { newJar, cookidooLogin, fetchWithJar, DOMAINS, loadDotEnv, ttsLabel, ttsData };
