# AI analysis

Serpent’s AI analysis connects to a cloud AI service that you provide by default, and can also connect to a **local model running on this machine or inside WSL**. The cloud route needs a provider account, an API key, and a vision-capable model; the local route needs none of those.

## Configure AI

On Windows open `Main menu → Settings → AI`; on macOS open `Settings → AI` from the system menu.

![AI configuration](../assets/ui/AI-config.png)

### Connect a provider

- `API format`: choose the provider interface, such as `DashScope Multimodal (native)`, `OpenAI Chat Completions`, `OpenAI Responses`, `Anthropic Messages`, `Gemini Native`, or `Local model (WSL / OpenAI-compatible)`. With a relay, follow the relay’s interface instructions.
- `Base URL`: usually leave it empty. For a relay or self-hosted gateway, enter the address supplied by that service. DashScope native uses an `/api/v1` root.
- `API Key`: paste the provider key. The eye icon shows it temporarily; after saving, the full key is not displayed. Enter a new key to replace it.
- `Model`: enter the provider’s vision model name. With a valid key, the picker can load models; if that fails, enter the name manually.
- `Language`: choose one language—Chinese, English, Japanese, or Korean—for descriptions and tags.
- Click `Test connection`, then `Save` after it succeeds.

Never put an API key in a script, plugin, screenshot, issue report, or MCP configuration.

### Use a local model (including WSL)

With `Local model (WSL / OpenAI-compatible)` selected, analysis requests go to an inference server you started yourself. Nothing reaches a cloud provider and no API key is needed.

1. Start a runtime that exposes an **OpenAI-compatible API** and is **vision-capable**, in WSL or on Windows:
   - Ollama: `ollama serve`, then `ollama pull qwen2.5vl:7b`
   - LM Studio: open Local Server
   - llama.cpp: `llama-server -m <model.gguf> --mmproj <vision-projector.gguf> --host 0.0.0.0` (port 8080 by default, change it with `--port`)
   - vLLM: `vllm serve Qwen/Qwen2.5-VL-7B-Instruct`
2. Selecting `Local model (WSL / OpenAI-compatible)` probes the stock ports once and fills `Base URL` when exactly one server answers. You can also click a preset (`Ollama` / `LM Studio` / `llama.cpp` / `vLLM`), or click `Detect local / WSL servers` to re-probe and pick from the results.
3. Confirm `Model` accepts images. When the runtime declares capabilities itself (llama.cpp and newer Ollama return `capabilities` in the model list) Serpent uses that; only when the server says nothing does it fall back to judging the model name and warning “may not accept images”.
4. Leave `API Key` empty, click `Test connection`, then `Save` once it succeeds. `Test connection` tests what is currently on screen — you do not have to save first.

**WSL reachability**

- WSL2 forwards Windows `127.0.0.1` to services inside the distribution that listen on `0.0.0.0`, so `http://127.0.0.1:<port>/v1` normally works out of the box (WSL mirrored networking behaves the same way).
- A server bound only to the distribution’s own `127.0.0.1` is not forwarded. Bind it to `0.0.0.0` instead, for example `OLLAMA_HOST=0.0.0.0 ollama serve`, or add `--host 0.0.0.0` to llama.cpp.
- If you cannot rebind it, use `Detect local / WSL servers`: Serpent reads the distribution address from `wsl hostname -I`, probes it, and lets you click the result to fill it in. That address changes after a WSL restart, so prefer `127.0.0.1` when it works.
- A detected server is named after what it calls *itself* (`llama.cpp`, `vLLM`, `Ollama`), not after the port preset; when nothing identifies it, it is shown as “OpenAI-compatible server”. The preset buttons (e.g. `vLLM (8000)`) are only “fill in this port” shortcuts and do not promise what listens there.
- WSL is only queried on Windows; on macOS and Linux detection still probes local loopback ports.
- A non-standard port is not probed automatically — type the base URL by hand (for example `http://127.0.0.1:8000/v1`).

**Local model notes**

- Analysis always sends an image (a video contact sheet or a 3D four-view sheet), so a text-only model cannot complete it.
- Local runtimes normally do not check the key, so `API Key` may stay empty. If the runtime sits behind an authenticating reverse proxy, enter that credential as usual.
- Local throughput depends on your GPU and model size. Lower `Concurrent analysis limit` under advanced settings (for example 1–2) to avoid running out of VRAM.
- OpenAI `json_schema` structured output is unevenly supported locally; Serpent automatically falls back to a more portable response format. If a model’s output stays unreliable, try a larger vision model or adjust `Custom description prompt`.

### AI write toggles

- `Description`: describe visual content, style, and mood.
- `Tags`: generate keywords for type, style, subject, and visual characteristics.
- `AI rating`: generate a 1–5 reference score.
- `Force existing tags`: choose only from tags already in the library.

AI content is stored separately from manual content; manual descriptions, tags, and ratings are not overwritten.

#### How descriptions are written

AI output is **cataloguing**, not content moderation. Every provider's prompt carries the same rules:

- **Describe factually**: name the subjects, scenes, actions, objects, text, and visual characteristics actually present — describe what the image shows.
- **Do not blur sensitive subject matter**: material involving privacy, adult content, violence, medical imagery, documents, or personal information is described just as plainly; the model must not substitute vague stand-ins such as “private content” or “sensitive image”, and must not omit, euphemise, or refuse.
- **Stay neutral**: state facts only — no moral or compliance judgements, no disclaimers, content warnings, or speculation beyond the image.
- **Rate the image, not the subject**: `AI rating` follows the `Rating rubric` and is not raised or lowered because the subject matter is sensitive.

A sensitive asset therefore gets a specific AI description. That output is written to your own library only.

### Advanced settings

- `Concurrent analysis limit`: default 16, range 1–32; lower it if the provider rate-limits requests.
- `Maximum image edge`: default 2048 px, range 512–4096; images are reduced when needed and never enlarged.
- `Maximum tags`: default 8, range 1–32.
- `Chinese description limit`: default 100 characters, range 20–500.
- `English description limit`: default 60 words, range 10–200.
- `Output style`: `Normal`, `Concise`, or `Rigorous`.
- `Rating rubric`: define what scores from 1 to 5 mean.
- `Custom description prompt`: add description guidance such as “focus on composition and lighting”.
- `Custom tag prompt`: define the tag vocabulary. Never put a key or secret in a prompt.

### Automatic analysis

Accept the disclaimer and enable `Automatically run AI analysis on new assets` to analyze new images, videos, and 3D models in the background; it is off by default and turning it off does not remove existing AI content.

## Supported assets

- Images and camera RAW: a resized image is sent.
- Video: a timestamped contact sheet is sent, not the original video.
- 3D models: a four-view image is sent.
- Audio, text, and unsupported formats: not analyzed by AI.

## Manual analysis and results

Choose `AI analysis` from an asset context menu or use the batch action for a multi-selection. `Analyze unanalyzed assets` skips assets that already have results; use normal `AI analysis` to re-analyze one.

![Start AI analysis from the asset context menu](../assets/ui/AI-analyze-menu.png)

Results appear in the AI section of the asset Inspector. A successful re-analysis replaces the current AI result and does not keep history; clearing AI content does not remove manual content or tag entities.

## Jobs and failures

Open `Window → Background jobs` to see queued, running, paused, failed, and completed AI jobs. You can pause, resume, cancel, or retry failed items. Network, rate-limit, and timeout failures are usually retryable; configuration, permission, quota, and unsupported-format problems must be fixed first.

If a video contact sheet or thumbnail is not ready, retry media generation from Background jobs before retrying AI. Failure messages include a short reason.

## Privacy and cost

Serpent does not upload an entire library, and does not provide AI search. Only explicitly submitted, supported assets are sent to the selected provider; check its privacy terms and pricing before enabling AI.

AI descriptions record what is actually in the image, including sensitive or private details; those results stay in your local library.

With a local model, that content only reaches your own inference server. Check the model’s licence and your local resource usage.
