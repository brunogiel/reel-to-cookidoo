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

## Para quién es esto
Para cualquiera con Thermomix (TM6 u otro modelo con Cookidoo) que quiera
convertir un reel de comida en una receta cargada de verdad en su Cookidoo
— con seteos de máquina y ingredientes linkeados — en vez de copiarla a mano
al editor web.

## Parámetros
- **`url`** (obligatorio): link al reel/video de origen (Instagram, TikTok o
  YouTube). Si la receta ya está escrita en algún lado (no hace falta bajar
  video), pasar el texto directo y saltar la sección de extracción.
- **`locale`** (opcional, default `en`): dominio de Cookidoo en el que estás
  logueado (`en` para `cookidoo.international`, `es-ES` para `cookidoo.es`,
  etc.). Determina con qué locale se llama al loader.

## Regla 0 — token-eficiencia
El sink de tokens típico es leer los frames del video de a uno y pelear con el
editor web de Cookidoo. Por eso:
- **Frames: NO leas todos.** Extraé a `fps=1` y leé ~6-8 frames estratégicos en
  **una sola** tool call (varios `Read` en paralelo): 1-2 del plato terminado +
  los frames donde cambia el overlay de ingredientes en pantalla. Parás apenas
  tenés todos los labels.
- **No re-leas** archivos que acabás de escribir.
- **Cookidoo: por API, nunca por el editor web** (ver Destino ⭐ abajo). El
  navegador es el último fallback.
- Si la receta ya está escrita en algún lado (nota, doc, mensaje), **saltá toda
  la extracción de video** y construí directo desde ese texto.

## Extraer desde video (saltear si la receta ya existe escrita)
Herramientas locales: `yt-dlp`, `ffmpeg`, `whisper`, vision (`Read` sobre `.jpg`).

1. **[DET] Bajar** (carpeta temporal): `yt-dlp --write-info-json --write-description -o "reel.%(ext)s" "<url>"`. Leer `reel.info.json`: `uploader`, `description`, `duration`, `webpage_url`.
   - **Fallback si yt-dlp falla en Instagram** (`empty media response`, típico cuando IG pide auth y no hay cookie de sesión disponible): con una pestaña logueada en instagram.com, se puede resolver el `mediaId` desde el shortcode y pegar un fetch a `/api/v1/media/{mediaId}/info/` con el header `x-ig-app-id`, tomar `video_versions[0].url` y navegar a esa URL para exponerla como URL del tab (las URLs de fbcdn viajan firmadas, no necesitan cookie) → descargarla con `curl`. El caption sale del mismo media info (`caption.text`).
2. **[LATENT] ¿El caption trae la receta completa?** Si sí, usalo. Si es un gancho tipo "comment X for the recipe", la receta no está ahí → vas a frames.
3. **[DET] Audio:** `ffmpeg -i reel.mp4 -vn -ar 16000 -ac 1 reel.wav` + `whisper reel.wav --model base --language <en/es> --output_format txt --fp16 False`. Si el reel es solo música de fondo, Whisper puede alucinar texto ("Thank you", "♪") — descartalo y dependé del texto en pantalla.
4. **[DET] Frames:** `ffmpeg -i reel.mp4 -vf "fps=1" frames/f%02d.jpg`. Leé ~6-8 estratégicos (ver Regla 0). Los reels suelen labelar cada ingrediente cuando lo agregan a cámara; anotá cada label nuevo + lo que se ve sin label (ajo, jengibre, etc.).
5. **[LATENT] Sintetizar:** orden de pasos + lista de ingredientes. Si no hay cantidades (típico en reels), estimalas para el rinde y **marcalas explícitamente como "a ojo"**. Si sabés que quien va a comer tiene alguna alergia o restricción declarada, chequeá que la receta no la incluya.

## Reinterpretar a TM6 (paso previo a cargar en Cookidoo) [LATENT]
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

### La máquina va donde suma
El TM6 no es obligatorio. Paso por paso, una sola pregunta: *¿el TM6 lo hace
mejor, más rápido o más prolijo que la mano, la olla o la sartén?*
- **Sí** → va al vaso, con su seteo real.
- **No, o lo hace peor** → fuera de máquina, **y se dice explícito en la
  receta**, con el porqué en una línea.

Casos ya resueltos:
- **Desmenuzar pollo: el TM6 gana.** Mariposa puesta, vel 4, tandas chicas,
  unos segundos. Sin mariposa no se hace. Deshuesar es a mano antes: un hueso
  a vel 4 rompe la mariposa.
- **Picar cebolla: gana**, en tandas de 100-200 g.
- **Dorar y sellar: pierde.** A Varoma la cebolla se suda, no carameliza. Va a
  la sartén. Lo mismo para tostar frutos secos o especias enteras.
- **Pasta larga o ancha ya cocida: nunca al vaso** con las cuchillas girando.
- **Mezclados largos de mucha masa** (2-3 kg): no entran en el vaso, van a mano.
- **Integrar mucha carne con su salsa** (~2 kg): no entra en el vaso de 2,2 L.
  Se mezcla en la cacerola a fuego bajo. El vaso sí sirve para licuar y
  reducir la salsa sola.
- **Licuar líquido caliente a vel 10:** con el cubilete puesto y subiendo la
  velocidad de a poco, máximo ~2 L (si no, en dos tandas). Arrancar directo a
  vel 10 con caliente es riesgo de salpicadura.

Una receta puede salir sin un solo seteo de TM6 y estar perfecta. Lo que no
puede es meter la máquina donde arruina el plato.

Esta reinterpretación es la que se pasa al loader de Cookidoo. El gate de
verificación (abajo) la chequea, no la reemplaza.

## Destino ⭐ — Cargar en Cookidoo por API, sin navegador
Carga la receta **a fidelidad completa**: nombre, tiempos, porciones,
ingredientes, pasos con **chips TM6** (tiempo/temp/velocidad), **ingredientes
linkeados** y el tip. No necesita ninguna pestaña abierta: el script hace el
login por HTTP y después ~6 llamadas a la API.

- **Loader:** `cookidoo-headless.js` (en esta carpeta). Node ≥18, cero
  dependencias. Replica el login CIAM que hace el editor web (usuario +
  contraseña → cookies de sesión) y reusa el mismo wire format que
  `cookidoo-api-loader.js`.
- **Credenciales:** copiá `.env.example` a `~/.config/cookidoo/env`
  (`chmod 600`) y completalo. El agente nunca ve ni tipea tu contraseña: el
  script la lee del disco. No la pegues en el chat.
- **Antes de cargar, listá lo que ya hay:** `node cookidoo-headless.js list`
  (id · estado · nombre). Si la receta ya existe, no la dupliques.
- **Crear:** `node cookidoo-headless.js create recipe.json` → `{id, url}`. El
  schema de `recipe.json` está en el header de `cookidoo-api-loader.js`, y hay
  un ejemplo completo en [`ejemplos/pure-coliflor-miso.json`](ejemplos/pure-coliflor-miso.json).
- **Linkear los ingredientes por posición (correrlo siempre después del
  create):** `node cookidoo-relink.js <id> recipe.json`. El auto-linkeo del
  server (`POST /annotate/steps`) es un matcheo fuzzy que falla seguido: en
  las pruebas linkeó 5 de 15 menciones, y una mal. El relink usa el campo
  `links` del JSON (un array por paso, con pares `[mención, clave]`) y deja
  cada mención atada a su ingrediente exacto, sin perder los chips TM6. El
  ejemplo trae los `links` armados.
- **Foto:** recortá un frame cuadrado del plato terminado y subilo con
  `node cookidoo-headless.js image <id> foto.jpg`. Pide una firma a Cookidoo,
  sube el archivo firmado a su Cloudinary y lo linkea a la receta. Si falla
  (Cookidoo rotó la `api_key` o el preset), subila a mano en el editor.
- **Compartir en público** (solo si el usuario lo pide, porque publica):
  `node cookidoo-headless.js public <id>`. Pone la receta en `PUBLIC`, relee
  el estado y chequea que la URL pública dé 200. Sirve para armar un QR.
- **Borrar:** `node cookidoo-headless.js delete <id>` (204).
- **Gotchas del wire format** (valen para los dos loaders, detalle en el
  header del `.js`):
  - **Giro inverso:** `reverse: true` en los `settings` del paso. En el wire
    format el chip lleva `direction: 'CCW'` (`'reverse'` o `'ccw'` → 400) y el
    label lleva el ícono `\uE003`: `10 sec/\uE003/speed 1`. La velocidad
    cuchara es speed `'soft'` y se imprime como `speed \uE002`.
  - **Varoma:** `temperature: { value: 'varoma' }`. Va en minúscula: `'Varoma'`
    → 400 y deja la receta a medio crear (borrala y volvé a correr).
  - **`hints`** (el tip) a veces no persiste vía PATCH: verificalo en la UI y
    pegalo a mano si falta.
- Si el login headless falla (Cookidoo cambió el flujo CIAM), caé al
  fallback A.

## Fallback A — loader en una pestaña logueada
Mismo resultado, pero corre dentro del navegador en vez de hacer el login.

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
- Los gotchas de giro inverso, Varoma y `hints` son los mismos de arriba.
- **Foto:** recortá un frame cuadrado del plato terminado del video original
  y subilo con `await cookidooUploadImage(id, imagen, 'es-ES')`, donde
  `imagen` es un `File`/`Blob` o una URL / `data:` URL. Pide una firma a
  Cookidoo, sube el archivo firmado a su Cloudinary y lo linkea a la receta.
  Si falla (Cookidoo rotó la `api_key` o el preset), subila a mano en el
  editor (1 click).
- Si este loader también falla, caé al fallback por navegador de abajo.

## Fallback B — Cookidoo por navegador (el más lento, usar solo si fallan los dos loaders)
Cookidoo es la plataforma oficial de Thermomix (`cookidoo.international` u
otro dominio local). Logueate con tu propia cuenta (family account o
personal). El agente no tipea tu contraseña: el login lo hacés vos.

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
- La foto se sube a mano con el botón "Upload image" del editor (1 click).

## Gate de verificación (recomendado antes de dar la receta por lista) [LATENT]
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

## Archivos / cuentas que toca
| Qué | Acción |
|---|---|
| Video + audio + frames descargados | Lecto-escritura solo en una carpeta temporal local (scratch) — no persiste nada al terminar |
| Tu cuenta de Cookidoo | Único write real y persistente: crea (o actualiza) una receta vía su API. `delete <id>` la borra si hace falta. `public <id>` la publica: solo con tu OK |
| `~/.config/cookidoo/env` | Solo lectura: de ahí salen tus credenciales para el login headless |
| Cualquier otro archivo/servicio tuyo | No toca nada — el skill no lee ni escribe notas, sheets, ni bases de datos propias |

## Output esperado
Receta cocinable (pasos en orden, sin ingredientes huérfanos), cantidades
estimadas marcadas como tales, cargada en Cookidoo con `{id, url}` de vuelta.

## Success metrics
- Cocinable y completa (capturó los labels en pantalla del video, no solo el caption).
- Token-eficiente: no se leyeron todos los frames, no hubo re-lecturas innecesarias, Cookidoo se cargó en batch.
- 0 nube/API de terceros para la extracción del video.
- Sin errores TM6 (nada de pasta larga en el vaso con cuchillas, ni velocidad alta + temperatura) ni infidelidades duras contra la fuente.
