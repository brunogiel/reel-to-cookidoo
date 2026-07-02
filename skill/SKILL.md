---
name: reel-to-cookidoo
description: >
  Toma una receta de un reel/video (Instagram/TikTok/YouTube) y la carga en
  Cookidoo (Thermomix) a fidelidad completa: nombre, tiempos, porciones,
  ingredientes y pasos con chips TM6 (tiempo/temperatura/velocidad) e
  ingredientes linkeados. Extracción 100% local (yt-dlp + ffmpeg + whisper +
  vision), sin subir el video a ningún servicio de nube. Usar cuando alguien
  mande un link de un reel de comida y pida "cargá esto en Cookidoo",
  "pasá esta receta a mi Thermomix", "sacale la receta a este video".
---

# reel-to-cookidoo

Pipeline: **reel/video → receta sintetizada → receta cargada en Cookidoo**.

```
FUENTE (video) → [extraer] → [reinterpretar a TM6] → [cargar a Cookidoo por API]
```

No es un producto oficial de Vorwerk/Thermomix. Es una integración no oficial,
reverse-engineered contra la API real de Cookidoo (ver disclaimer en el
[README](../README.md)). Usala con tu propia cuenta de Cookidoo.

## Regla 0 — token-eficiencia
El sink de tokens típico es leer los frames del video de a uno y pelear con el
editor web de Cookidoo. Por eso:
- **Frames: NO leas todos.** Extraé a `fps=1` y leé ~6-8 frames estratégicos en
  **una sola** tool call (varios `Read` en paralelo): 1-2 del plato terminado +
  los frames donde cambia el overlay de ingredientes en pantalla. Parás apenas
  tenés todos los labels.
- **No re-leas** archivos que acabás de escribir.
- **Cookidoo: batcheá** todas las llamadas de una vez (ver Destino ⭐ abajo).
  Nunca una acción por call.
- Si la receta ya está escrita en algún lado (nota, doc, mensaje), **saltá toda
  la extracción de video** y construí directo desde ese texto.

## Extraer desde video (saltear si la receta ya existe escrita)
Herramientas locales: `yt-dlp`, `ffmpeg`, `whisper`, vision (`Read` sobre `.jpg`).

1. **Bajar** (carpeta temporal): `yt-dlp --write-info-json --write-description -o "reel.%(ext)s" "<url>"`. Leer `reel.info.json`: `uploader`, `description`, `duration`, `webpage_url`.
   - **Fallback si yt-dlp falla en Instagram** (`empty media response`, típico cuando IG pide auth y no hay cookie de sesión disponible): con una pestaña logueada en instagram.com, se puede resolver el `mediaId` desde el shortcode y pegar un fetch a `/api/v1/media/{mediaId}/info/` con el header `x-ig-app-id`, tomar `video_versions[0].url` y navegar a esa URL para exponerla como URL del tab (las URLs de fbcdn viajan firmadas, no necesitan cookie) → descargarla con `curl`. El caption sale del mismo media info (`caption.text`).
2. **¿El caption trae la receta completa?** Si sí, usalo. Si es un gancho tipo "comment X for the recipe", la receta no está ahí → vas a frames.
3. **Audio:** `ffmpeg -i reel.mp4 -vn -ar 16000 -ac 1 reel.wav` + `whisper reel.wav --model base --language <en/es> --output_format txt --fp16 False`. Si el reel es solo música de fondo, Whisper puede alucinar texto ("Thank you", "♪") — descartalo y dependé del texto en pantalla.
4. **Frames:** `ffmpeg -i reel.mp4 -vf "fps=1" frames/f%02d.jpg`. Leé ~6-8 estratégicos (ver Regla 0). Los reels suelen labelar cada ingrediente cuando lo agregan a cámara; anotá cada label nuevo + lo que se ve sin label (ajo, jengibre, etc.).
5. **Sintetizar:** orden de pasos + lista de ingredientes. Si no hay cantidades (típico en reels), estimalas para el rinde y **marcalas explícitamente como "a ojo"**. Si sabés que quien va a comer tiene alguna alergia o restricción declarada, chequeá que la receta no la incluya.

## Reinterpretar a TM6 (paso previo a cargar en Cookidoo)
La receta sintetizada del paso anterior es el **método neutro** (hornalla/sartén).
Cookidoo no es eso traducido literal: es una receta **Thermomix de verdad**, y
reinterpretarla es un paso de diseño aparte, antes de armar el payload de carga.
No mapees pasos de hornalla a chips de máquina de forma mecánica. Decidí, paso
por paso:
- **¿Va en el vaso o fuera de máquina?** Lo que las cuchillas harían mal va SIN
  máquina y se dice explícito: **pasta larga/ancha cocida** (tagliatelle,
  pappardelle, spaghetti), emplatado, dorar/sellar carne grande. Mezclar pasta
  = a mano o en sartén, nunca chip de velocidad.
- **Reordená al flujo del vaso:** picar → sofreír → emulsionar → sumar
  líquidos, todo en el mismo vaso cuando se puede (no "volcar en un bowl
  aparte" si eso es método de hornalla del video original).
- **Asigná seteos TM6 reales y seguros:** tiempo (seg) + temperatura +
  velocidad por paso, respetando que **velocidad alta (>4-5) no va con
  temperatura activada**; un sofrito típico ronda ~120°C/Varoma a velocidad
  cuchara (1); picar es un golpe corto a velocidad 5-7 sin temperatura;
  emulsionar salsas va a velocidad media sin temperatura.

Esta reinterpretación es la que se pasa al loader de Cookidoo. El gate de
verificación (abajo) la chequea, no la reemplaza.

## Destino ⭐ — Cargar en Cookidoo por API (token-eficiente)
Carga la receta **a fidelidad completa**: nombre, tiempos, porciones,
ingredientes, pasos con **chips TM6** (tiempo/temp/velocidad) e **ingredientes
linkeados** (el server de Cookidoo los auto-detecta contra la lista de
ingredientes) y el tip. Esto reemplaza cargar todo a mano en el editor web
(mucho más lento) por ~6 llamadas `fetch`.

- **Loader:** `cookidoo-api-loader.js` (en esta carpeta). La auth es la cookie
  de sesión httpOnly de tu propia sesión logueada en Cookidoo — **no hay que
  extraer ni guardar ningún token**. Corré el script **en el contexto de una
  pestaña logueada en el dominio de Cookidoo** (herramienta tipo Chrome DevTools
  MCP / consola del navegador), con una pestaña limpia (no la del editor, que
  puede frezear el renderer al correr JS pesado).
- **Dominio / locale:** `cookidoo.international` (`en`) y `cookidoo.es`
  (`es-ES`) **no comparten cookies entre sí** (y en general cada TLD local de
  Cookidoo es su propio dominio de sesión). Fijate en qué dominio estás
  logueado antes de correr el loader.
- **Cómo:** pegá el archivo entero en el contexto de la página → `await cookidooLoad(recipe, { locale: 'es-ES' })` (ajustá el locale al dominio en el que estás logueado) → devuelve `{id, url}`. Para borrar: `await cookidooDelete(id, 'es-ES')`. El schema de `recipe` y el wire format están documentados en el header del `.js`.
- **Gotchas conocidos de la API** (documentados en el header del loader):
  el chip TTS con `direction: 'reverse'` puede devolver 400 en algunos
  dominios (mencionalo en la prosa del paso en vez de forzarlo); el campo
  `hints` (tip) a veces no persiste vía PATCH — verificalo en la UI y pegalo a
  mano si falta.
- **Foto:** el "Upload image" de Cookidoo pasa por un widget de subida en un
  iframe cross-origin (Cloudinary), no automatizado por este loader. El
  fallback es: recortar un frame cuadrado del plato terminado del video
  original y subirlo a mano en el editor (1 click).
- Si el loader falla (cambió la API, sesión caída, etc.), caé al fallback por
  navegador de abajo.

## Fallback — Cookidoo por navegador (más lento, usar solo si falla la API)
Cookidoo es la plataforma oficial de Thermomix (`cookidoo.international` u
otro dominio local). Logueate con tu propia cuenta (family account o
personal) — este skill nunca debe manejar ni pedir tus credenciales.

- Ruta: Menú → **My Recipes → Created Recipes** → botón **"+"** → **Create
  recipe** → título → Create → editor.
- Setear: prep/total time, **serving size**, dispositivo (TM6 u otro).
- Cargar primero todos los ingredientes (card Ingredients), después los pasos.
- **Linkear ingredientes en cada paso** (así se arma una receta Cookidoo de
  verdad, no solo texto plano): cada paso en edición tiene el ícono de
  "Ingredients" (balanza) → tab **Insert from ingredients list** → clickear
  cada ingrediente que ese paso usa para embeberlo como chip linkeado. Eso
  hace que el paso referencie la cantidad real, escale con las porciones y
  alimente la lista de compras automática.
- **Seteo TM6 estructurado:** en un paso en edición, ícono de "Cooking
  settings" → Add setting (min/seg, temperatura, velocidad, toggle
  reverse/normal) → confirmar inserta un chip. La Thermomix no permite
  velocidad alta (>6) con temperatura activada.
- Los campos del editor suelen ser `contenteditable`, no inputs estándar —
  herramientas de automatización de formularios pueden no funcionar; hay que
  clickear y tipear directo. Si automatizás esto, verificá con screenshots
  cada pocos pasos, el tipeo rápido encadenado a veces pierde texto.
- La foto se sube igual que en el flujo por API: a mano, 1 click.

## Gate de verificación (recomendado antes de dar la receta por lista)
Antes de cerrar, conviene una segunda pasada crítica (podés hacerla vos mismo
o con un segundo agente/modelo) que compare la receta final contra la fuente:

- **Fidelidad:** ¿los ingredientes y pasos coinciden con la fuente? ¿No se
  inventó ni se omitió nada? Marcá las interpretaciones que hiciste (ej.
  "aceite de sabor" → sésamo, "salsa picante" → pasta de chiles).
- **Seguridad/coherencia TM6:** ningún seteo de **velocidad alta (>4-5) con
  temperatura activada**; **nada de pasta larga/ancha cocida** (tagliatelle,
  pappardelle, spaghetti) en el vaso con las cuchillas girando — eso se
  enreda o se rompe, va sin máquina; tiempos y temperaturas plausibles para
  cada acción; el sofrito ronda ~120°C/Varoma a velocidad cuchara.
- **Carga sin errores:** los chips TM6 y los ingredientes linkeados
  renderizaron de verdad en la UI de Cookidoo (verificalo ahí, un 200 de la
  API no lo garantiza).

## Output esperado
Receta cocinable (pasos en orden, sin ingredientes huérfanos), cantidades
estimadas marcadas como tales, cargada en Cookidoo con `{id, url}` de vuelta.

## Success metrics
- Cocinable y completa (capturó los labels en pantalla del video, no solo el caption).
- Token-eficiente: no se leyeron todos los frames, no hubo re-lecturas innecesarias, Cookidoo se cargó en batch.
- 0 nube/API de terceros para la extracción del video.
- Sin errores TM6 (nada de pasta larga en el vaso con cuchillas, ni velocidad alta + temperatura) ni infidelidades duras contra la fuente.
