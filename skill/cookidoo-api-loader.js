// ============================================================================
// Cookidoo API Loader
// ----------------------------------------------------------------------------
// Crea recetas propias en Cookidoo (Thermomix) A FIDELIDAD COMPLETA por API:
// nombre, tiempos, porciones, herramienta, ingredientes, pasos con CHIPS TM6
// (cr-tts) + INGREDIENTES LINKEADOS (cr-ingredient) y tip. Reemplaza cargar
// todo a mano en el editor web (mucho más lento) por ~6 llamadas fetch.
//
// Integración NO OFICIAL, reverse-engineered contra la API real de Cookidoo.
// No afiliada a Vorwerk/Thermomix. Puede romperse si cambian su API. Usala
// con tu propia cuenta de Cookidoo — este script nunca pide ni maneja tus
// credenciales, solo reutiliza la cookie de sesión de una pestaña ya logueada.
//
// CÓMO SE CORRE  (clave: auth = cookie de sesión httpOnly del propio dominio)
//   1. Tener una pestaña logueada en cookidoo.international (en) o cookidoo.es
//      (es-ES), o el dominio local que corresponda a tu cuenta.
//      Las cookies NO se comparten entre dominios. Usá una pestaña limpia,
//      no la del editor.
//   2. Pegá este archivo entero en el contexto de esa página (herramienta de
//      automatización de navegador con acceso a la consola/JS del tab).
//      Las llamadas usan `credentials:'include'` => viajan con la cookie
//      sola, no hay que extraer ningún token.
//   3. Llamá  await cookidooLoad(recipe, { locale: 'es-ES' })  según el
//      dominio del tab. Devuelve { id, url }.
//
// SCHEMA DE ENTRADA (recipe)
//   {
//     name: 'Hummus express',
//     yield: { value: 4, unitText: 'portion' },     // opcional (default 4 portion)
//     tools: ['TM6'],                                // opcional (default ['TM6'])
//     prepTime: 300, cookTime: 0, totalTime: 300,    // SEGUNDOS (number) o null
//     ingredients: [ '1 lata de garbanzos (240 g)', '2 cdas de tahini', ... ],
//     hints: 'Si queda espeso, sumá agua fría.',     // el "tip" (string), opcional
//     steps: [
//       // Cada paso: prosa + (opcional) settings TM6 estructurados.
//       { prose: 'Poné el ajo en el vaso y picá.', settings: { time: 5, speed: 7 } },
//       { prose: 'Triturá los garbanzos.',          settings: { time: 30, speed: 6 } },
//       { prose: 'Calentá para servir tibio.',
//         settings: { time: 120, temperature: { value: 50, unit: 'C' }, speed: 2 } },
//       'Un paso sin máquina (string suelto, sin chip).'
//     ]
//   }
//
//   settings TM6:  { time(seg, number), speed(number|string), temperature?{value,unit:'C'|'Varoma'}, reverse?:true }
//
// QUÉ HACE EL LOADER
//   - Crea la receta (POST) y la rellena con PATCH PARCIALES (un campo por vez,
//     igual que el editor real).
//   - TTS (chips TM6): DETERMINISTA. Construye el label canónico ("5 sec/speed 7",
//     "2 min/50°C/speed 2") y la annotation con offset/length exactos. No depende
//     del NLP de /annotate (que solo parsea español natural, no el label inglés).
//   - INGREDIENTES LINKEADOS: usa POST /annotate/steps para que el server
//     auto-detecte y matchee las menciones contra la lista de ingredientes
//     (matcheo fuzzy en español; cubre la mayoría, no siempre el 100%).
//
// WIRE FORMAT (reverse-engineered, ground-truth capturado del editor)
//   Ingredientes:  PATCH {ingredients:[{type:'INGREDIENT', text:'...'}]}
//   Pasos:         PATCH {instructions:[{type:'STEP', text:'<plano+labels>',
//                          annotations:[{type, data, position:{offset,length}}]}]}
//     · TTS data:        {speed:'5', time:5, temperature?:{value:'100',unit:'C'}, direction?:'CCW'}  (giro inverso = 'CCW' + ícono \uE003 en el label)
//       (time en SEGUNDOS; speed string; temperature objeto; el label va inline en `text`)
//     · INGREDIENT data: {description:'<texto EXACTO de un ingrediente de la lista>'}
//     · position: offset/length apuntan al span del label/mención dentro de `text`.
//   Nombre/tip/etc: PATCH parciales {name}, {hints}, {yield}, {tools}, {prepTime,cookTime,totalTime}.
//   El PATCH base SANITIZA html (cr-tts/cr-ingredient como <tags> => 400 "unsafe html"):
//     por eso los chips van como `annotations` posicionales, NO como html en `text`.
//   Borrar:        DELETE /created-recipes/en/{id}   (204)
//
// FOTO (no automatizado): el "Upload image" es un Cloudinary Upload Widget en
//   iframe cross-origin; sube a Cloudinary y luego linkea con PATCH
//   {image:'prod/img/customer-recipe/{public_id}.jpg', isImageOwnedByUser:true}.
//   Requiere capturar el signed-upload de Cloudinary con un archivo real, no
//   está cubierto por este loader. Fallback: subir la foto a mano (1 click)
//   en el editor web después de correr este script.
// ============================================================================

(function () {
  const ORIGIN = 'https://cookidoo.international';
  const API = (loc) => `${ORIGIN}/created-recipes/${loc}`;

  // pristine fetch (evita interceptores ruidosos si los hubiera en la página)
  function pristineFetch() {
    try {
      const ifr = document.createElement('iframe');
      ifr.style.display = 'none';
      document.body.appendChild(ifr);
      const f = ifr.contentWindow.fetch.bind(window);
      ifr.remove();
      return f;
    } catch (_) { return window.fetch.bind(window); }
  }
  const pf = pristineFetch();

  async function jreq(method, url, body) {
    const r = await pf(url, {
      method, credentials: 'include',
      headers: { 'content-type': 'application/json; charset=UTF-8', accept: 'application/json' },
      body: body != null ? JSON.stringify(body) : undefined,
    });
    const t = await r.text();
    let j; try { j = JSON.parse(t); } catch (_) { j = t; }
    if (r.status >= 300) throw new Error(`${method} ${r.status}: ${(j && j.message) || t}`.slice(0, 300));
    return j;
  }
  const jpatch = (url, body) => jreq('PATCH', url, body);
  const jpost = (url, body) => jreq('POST', url, body);

  // --- label canónico del chip TM6 a partir de settings estructurados ---
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
    // Vel cuchara = speed 'soft' → se imprime con el ícono \uE002. Sacado del bundle del editor
    // (pl-customer-recipes-*.js: getAnnotationText = time/temp/direction/speed unidos por '/').
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
      d.temperature = { value: String(v), unit: s.temperature.unit || 'C' };
    }
    if (s.reverse) d.direction = 'CCW'; // valores válidos: 'CW' (default, se omite) | 'CCW'. 'reverse'/'ccw' → 400.
    return d;
  }

  // --- annotate: server auto-linkea menciones de ingredientes sobre la prosa ---
  async function ingredientAnnotations(loc, id, recipe, ings, proseList) {
    const annRecipe = {
      recipeId: id, name: recipe.name, image: null, isImageOwnedByUser: false,
      tools: recipe.tools || ['TM6'], yield: recipe.yield || { value: 4, unitText: 'portion' },
      prepTime: null, cookTime: null, totalTime: null,
      ingredients: ings, instructions: proseList.map((t) => ({ type: 'STEP', text: t })),
      hints: '', workStatus: 'PRIVATE', recipeMetadata: { requiresAnnotationsCheck: false },
    };
    const ann = await jpost(`${API(loc)}/annotate/steps`, {
      recipe: annRecipe, options: { stepIndexes: proseList.map((_, i) => i) },
    });
    return (ann.recipeContent.instructions || []).map((tokenArr) => {
      let text = '', anns = [];
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

  // --- MAIN ---
  async function cookidooLoad(recipe, opts = {}) {
    const loc = opts.locale || 'en';
    let id = recipe.recipeId;
    if (!id) { const c = await jpost(API(loc), { recipeName: recipe.name || 'Sin nombre' }); id = c.recipeId; }
    const base = `${API(loc)}/${id}`;

    await jpatch(base, { name: recipe.name });
    if (recipe.yield) await jpatch(base, { yield: recipe.yield });
    if (recipe.tools) await jpatch(base, { tools: recipe.tools });
    const times = {};
    ['prepTime', 'cookTime', 'totalTime'].forEach((k) => { if (recipe[k] != null) times[k] = recipe[k]; });
    if (Object.keys(times).length) await jpatch(base, times);
    if (recipe.hints != null) await jpatch(base, { hints: recipe.hints });

    const ings = (recipe.ingredients || []).map((i) => (typeof i === 'string' ? { type: 'INGREDIENT', text: i } : i));
    await jpatch(base, { ingredients: ings });

    const steps = (recipe.steps || []).map((s) => (typeof s === 'string' ? { prose: s } : s));
    const proseList = steps.map((s) => s.prose);
    let ingAnns = [];
    if (opts.linkIngredients !== false && proseList.length) {
      try { ingAnns = await ingredientAnnotations(loc, id, recipe, ings, proseList); }
      catch (e) { console.warn('annotate falló, sigo sin linkear ingredientes:', e.message); }
    }
    const instructions = steps.map((s, i) => {
      let text = (ingAnns[i] && ingAnns[i].text) || s.prose || '';
      let anns = (ingAnns[i] && ingAnns[i].anns) ? ingAnns[i].anns.slice() : [];
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
    await jpatch(base, { instructions });

    return { id, url: `${ORIGIN}/created-recipes/${loc}/${id}` };
  }

  async function cookidooDelete(id, loc = 'en') {
    const r = await pf(`${API(loc)}/${id}`, { method: 'DELETE', credentials: 'include', headers: { accept: 'application/json' } });
    return r.status; // 204 ok, 410 si ya estaba borrada
  }

  window.cookidooLoad = cookidooLoad;
  window.cookidooDelete = cookidooDelete;
  return 'cookidoo-api-loader listo: window.cookidooLoad(recipe), window.cookidooDelete(id)';
})();
