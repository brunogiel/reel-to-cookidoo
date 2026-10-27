#!/usr/bin/env node
// Linkea ingredientes en los pasos de una receta ya creada en Cookidoo, POR POSICIÓN (determinista).
// Reemplaza a POST /annotate/steps (matcheo fuzzy del server), que en las pruebas linkeó 5 de 15
// menciones y una mal.
// Uso:  node cookidoo-relink.js <id> recipe.json
// recipe.json = el mismo del create, más `links`: un array por paso, con pares [mención, clave]:
//   "links": [ [["arroz","arroz de grano"]], [["arroz","arroz"],["agua","agua"]], ... ]
//   · mención = palabra tal cual aparece en el texto del paso (se busca en orden, palabra entera)
//   · clave   = substring que identifica el ingrediente en `ingredients`
// Los pasos se reescriben con sus annotations de ingrediente. También sirve con
// pasos con chip TM6 ({prose, settings}): reconstruye el texto y el chip igual que cookidooLoad
// (prosa + ' ' + label), así el chip no se pierde.
// Ejemplo completo con `links`: ejemplos/pure-coliflor-miso.json (18 links + 3 chips).
const M = require('./cookidoo-headless.js');
const fs = require('fs');
const [, , id, file] = process.argv;
const R = JSON.parse(fs.readFileSync(file, 'utf8'));
const ing = k => { const x = R.ingredients.find(i => i.includes(k)); if (!x) throw new Error('sin ingrediente para ' + k); return x; };
(async () => {
  M.loadDotEnv();
  const d = M.DOMAINS[process.env.COOKIDOO_DOMAIN || 'international'];
  const jar = M.newJar();
  await M.cookidooLogin(jar, { origin: d.origin, language: d.language, email: process.env.COOKIDOO_EMAIL, password: process.env.COOKIDOO_PASSWORD });
  const instructions = R.steps.map((st, i) => {
    const s = typeof st === 'string' ? { prose: st } : st;
    let t = s.prose;
    const anns = []; let from = 0;
    for (const [w, k] of (R.links[i] || [])) {
      const m = t.slice(from).match(new RegExp('(^|[^\\wáéíóúñ])' + w + '(?![\\wáéíóúñ])'));
      if (!m) throw new Error(`no aparece "${w}" en el paso ${i + 1}`);
      const off = from + m.index + m[1].length;
      anns.push({ type: 'INGREDIENT', data: { description: ing(k) }, position: { offset: off, length: w.length } });
      from = off + w.length;
    }
    if (s.settings) {
      const l = M.ttsLabel(s.settings);
      t += ' ';
      anns.push({ type: 'TTS', data: M.ttsData(s.settings), position: { offset: t.length, length: l.length } });
      t += l;
    }
    return { type: 'STEP', text: t, annotations: anns };
  });
  const r = await M.fetchWithJar(jar, `${d.origin}/created-recipes/${d.language}/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json; charset=UTF-8', accept: 'application/json' }, body: JSON.stringify({ instructions }) });
  console.log(JSON.stringify({ id, status: r.status, linked: instructions.reduce((n, s) => n + s.annotations.length, 0) }));
})().catch(e => { console.error(e.message); process.exit(1); });
