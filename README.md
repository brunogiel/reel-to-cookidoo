# reel-to-cookidoo

Un skill para agentes tipo [Claude Code](https://claude.com/claude-code) que
toma la receta de un reel/video de comida (Instagram, TikTok, YouTube) y la
carga en [Cookidoo](https://cookidoo.thermomix.com/) (la plataforma de
recetas de Thermomix) a fidelidad completa: nombre, tiempos, porciones,
ingredientes y pasos con sus chips de tiempo/temperatura/velocidad, e
ingredientes linkeados dentro del texto de cada paso.

Todo el paso de extracción del video corre **local**: `yt-dlp` + `ffmpeg` +
`whisper` para bajar el video, sacar el audio y transcribirlo, y lectura de
frames (vision) para capturar los ingredientes que aparecen solo en overlays
de texto en pantalla. Nada del video se sube a un servicio de nube de
terceros para procesarlo.

## Qué hace

```
reel/video → extraer receta → reinterpretar como receta Thermomix real → cargar en Cookidoo
```

- Baja el video y su transcripción/caption.
- Si la receta no está en el caption, lee los frames donde cambian los
  overlays de ingredientes.
- Reinterpreta el método (hornalla/sartén) como una receta Thermomix de
  verdad: qué va en el vaso vs fuera de máquina, y seteos TM6 seguros
  (tiempo/temperatura/velocidad).
- Carga la receta en tu cuenta de Cookidoo por su API (no oficial,
  reverse-engineered), con chips TM6 e ingredientes linkeados — no solo
  texto plano. Corre desde la terminal, sin navegador abierto.
- Linkea cada ingrediente a su mención exacta en los pasos, por posición:
  el auto-linkeo de Cookidoo saltea menciones y linkea mal.
- Sube la foto del plato (un frame del video) a la receta, también por API.
- Lista lo que ya tenés cargado (para no duplicar) y, si lo pedís, comparte
  la receta en público.

Ver el detalle completo en [`skill/SKILL.md`](skill/SKILL.md).

## Requisitos

- Un agente con acceso a shell local (Claude Code, o similar).
- Herramientas locales instaladas: [`yt-dlp`](https://github.com/yt-dlp/yt-dlp), [`ffmpeg`](https://ffmpeg.org/), [`whisper`](https://github.com/openai/whisper) y Node ≥18.
- Una cuenta de Cookidoo activa (family o personal).
- Opcional: un navegador con contexto de ejecución de JS, para el loader en
  pestaña (fallback si el login headless falla).

## Cómo usarlo

1. Cloná este repo.
2. Copiá `skill/.env.example` a `~/.config/cookidoo/env`, completalo con tu
   mail y contraseña de Cookidoo, y dejalo con `chmod 600`. Queda fuera del
   repo; el agente no la ve, el script la lee del disco.
3. Apuntá tu agente (Claude Code, Cowork, etc.) a la carpeta `skill/`, o
   copiala entera a donde tu agente lea sus skills.
4. Pasale el link de un reel y pedile que lo cargue en tu Cookidoo. El agente
   sigue el flujo documentado en `SKILL.md`.

Para probar la carga sin video, usá la receta de ejemplo:

```bash
cd skill
node cookidoo-headless.js create ejemplos/pure-coliflor-miso.json
node cookidoo-relink.js <id> ejemplos/pure-coliflor-miso.json
```

## Disclaimer

Este proyecto usa una integración **no oficial** contra la API real de
Cookidoo, obtenida por ingeniería inversa observando el tráfico del editor
web. **No está afiliado, respaldado ni auspiciado por Vorwerk ni Thermomix.**
Cookidoo puede cambiar su API en cualquier momento y romper este loader sin
aviso. Usalo bajo tu propia responsabilidad, con tu propia cuenta, y nunca
compartas ni hardcodees credenciales: el loader headless las lee de un
archivo local fuera del repo, y el loader en pestaña solo reutiliza la cookie
de sesión de una pestaña ya logueada.

Publicado bajo licencia MIT, sin garantía de ningún tipo — ver [`LICENSE`](LICENSE).
