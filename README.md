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
  texto plano.
- Sube la foto del plato (un frame del video) a la receta, también por API.

Ver el detalle completo en [`skill/SKILL.md`](skill/SKILL.md).

## Requisitos

- Un agente con acceso a shell local (Claude Code, o similar) y a un
  navegador con contexto de ejecución de JS (para el loader de Cookidoo).
- Herramientas locales instaladas: [`yt-dlp`](https://github.com/yt-dlp/yt-dlp), [`ffmpeg`](https://ffmpeg.org/), [`whisper`](https://github.com/openai/whisper).
- Una cuenta de Cookidoo activa (family o personal), logueada en el
  navegador que use el agente.

## Cómo usarlo

1. Cloná este repo.
2. Apuntá tu agente (Claude Code, Cowork, etc.) a la carpeta `skill/`, o
   copiá `skill/SKILL.md` y `skill/cookidoo-api-loader.js` a donde tu agente
   lea sus skills.
3. Pasale el link de un reel y pedile que lo cargue en tu Cookidoo. El agente
   sigue el flujo documentado en `SKILL.md`.

## Disclaimer

Este proyecto usa una integración **no oficial** contra la API real de
Cookidoo, obtenida por ingeniería inversa observando el tráfico del editor
web. **No está afiliado, respaldado ni auspiciado por Vorwerk ni Thermomix.**
Cookidoo puede cambiar su API en cualquier momento y romper este loader sin
aviso. Usalo bajo tu propia responsabilidad, con tu propia cuenta, y nunca
compartas ni hardcodees credenciales — el script solo reutiliza la cookie de
sesión de una pestaña ya logueada.

Publicado bajo licencia MIT, sin garantía de ningún tipo — ver [`LICENSE`](LICENSE).
