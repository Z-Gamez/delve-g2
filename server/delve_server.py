"""Delve server: speech-to-text and the AI Dungeon Master for Delve on Even G2.

Runs on your PC; the glasses app reaches it over Tailscale (MagicDNS name) or
the LAN (delve.local). Two jobs, nothing else:

  /stt, /api/stt   Whisper (faster-whisper) on the G2 mic's PCM, with Silero
                   voice detection deciding when you've stopped talking.
  /api/chat        One plain Ollama chat call -- no tools, no system prompt of
                   ours -- with an optional JSON-schema `format`, which is how
                   the Dungeon Master gets structured rulings out of a small
                   local model.

Deliberately standalone: it shares no code or process with any other bridge,
so either can change without breaking the other.

    python delve_server.py [--config config.json]
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import re
import socket
import sys
import time
from pathlib import Path

import numpy as np
from aiohttp import ClientSession, ClientTimeout, WSMsgType, web

import vad

log = logging.getLogger("delve")

HERE = Path(__file__).resolve().parent
SAMPLE_RATE = 16000
PARTIAL_INTERVAL_SECONDS = 1.2
VAD_INTERVAL_SECONDS = 0.2
VERSION = "1.0.0"

DEFAULTS = {
    # Everything by default. Pin your tailnet IP here to listen only there.
    "host": "0.0.0.0",
    "port": 8790,
    # Publish delve.local so a phone on the same Wi-Fi needs no address.
    "mdns": True,
    "ollama_url": "http://127.0.0.1:11434",
    "ollama_model": "qwen3:4b",
    "whisper_model": "small.en",
    "whisper_device": "auto",
    # Downloaded on first run. Point at an existing faster-whisper cache to reuse it.
    "whisper_models_dir": str(HERE / "models"),
    "language": "en",
    # Blips shorter than this decode into hallucinated words; ignore them.
    "min_utterance_seconds": 0.4,
    # This much quiet after speaking ends the utterance.
    "end_silence_seconds": 1.0,
}

CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
}


def load_config(path: Path) -> dict:
    cfg = dict(DEFAULTS)
    if path.exists():
        cfg.update(json.loads(path.read_text(encoding="utf-8")))
    return cfg


# --------------------------------------------------------------------------
# Whisper
# --------------------------------------------------------------------------


def register_cuda_dlls() -> list[str]:
    """Puts pip-installed CUDA libraries (site-packages/nvidia/*/bin) on PATH.

    CTranslate2 finds cuBLAS with a plain LoadLibrary, which reads PATH and
    ignores os.add_dll_directory -- without this, "cublas64_12.dll is not found"
    and a silent fall back to CPU. Must run before ctranslate2 is imported.
    """
    import site

    roots = [Path(p) / "nvidia" for p in site.getsitepackages()]
    roots.append(Path(sys.prefix) / "Lib" / "site-packages" / "nvidia")
    added: list[str] = []
    for root in roots:
        if not root.is_dir():
            continue
        for bin_dir in sorted(root.glob("*/bin")):
            if str(bin_dir) in added:
                continue
            added.append(str(bin_dir))
            if hasattr(os, "add_dll_directory"):
                try:
                    os.add_dll_directory(str(bin_dir))
                except OSError:
                    pass
    if added:
        os.environ["PATH"] = os.pathsep.join(added) + os.pathsep + os.environ.get("PATH", "")
    return added


class Transcriber:
    def __init__(self, cfg: dict) -> None:
        self.cfg = cfg
        self.model = None
        self._lock = asyncio.Lock()

    def load(self) -> None:
        register_cuda_dlls()
        from faster_whisper import WhisperModel

        device = self.cfg["whisper_device"]
        attempts = []
        if device in ("auto", "cuda"):
            attempts.append(("cuda", "float16"))
        if device in ("auto", "cpu"):
            attempts.append(("cpu", "int8"))
        for dev, compute in attempts:
            try:
                log.info("Loading Whisper %s on %s (%s)...", self.cfg["whisper_model"], dev, compute)
                model = WhisperModel(self.cfg["whisper_model"], device=dev, compute_type=compute, download_root=self.cfg["whisper_models_dir"])
                # Decode once now, so a broken CUDA install fails at startup rather
                # than on the first thing the player says.
                list(model.transcribe(np.zeros(SAMPLE_RATE, dtype=np.float32))[0])
                self.model = model
                log.info("Whisper ready on %s.", dev)
                return
            except Exception as exc:
                log.warning("Could not use %s: %s", dev, exc)
        raise RuntimeError("No usable device for the Whisper model.")

    def _transcribe_sync(self, pcm: bytes) -> str:
        audio = np.frombuffer(pcm, dtype=np.int16).astype(np.float32) / 32768.0
        segments, _info = self.model.transcribe(audio, language=self.cfg["language"])
        return "".join(seg.text for seg in segments).strip()

    async def transcribe(self, pcm: bytes) -> str:
        if self.model is None:
            raise RuntimeError("Whisper model is not loaded")
        if len(pcm) / 2 / SAMPLE_RATE < self.cfg["min_utterance_seconds"]:
            return ""
        # One decode at a time: they'd contend for the same model and GPU.
        async with self._lock:
            return await asyncio.to_thread(self._transcribe_sync, pcm)


# --------------------------------------------------------------------------
# HTTP
# --------------------------------------------------------------------------


@web.middleware
async def cors_middleware(request: web.Request, handler):
    """The packed app runs from its own origin, so every call is cross-origin.
    Open to any origin: the server holds no credentials and the set of origins
    an Even Hub app presents can't be listed ahead of time."""
    if request.method == "OPTIONS":
        resp: web.StreamResponse = web.Response(status=204)
    else:
        resp = await handler(request)
    resp.headers.update(CORS_HEADERS)
    return resp


async def handle_health(request: web.Request) -> web.Response:
    app = request.app
    cfg = app["cfg"]
    ollama_ok = False
    try:
        async with app["http"].get(f"{cfg['ollama_url']}/api/tags", timeout=ClientTimeout(total=4)) as resp:
            ollama_ok = resp.status == 200
    except Exception:
        pass
    return web.json_response(
        {
            "server": "delve",
            "version": VERSION,
            "whisper": app["stt"].model is not None,
            "whisper_model": cfg["whisper_model"],
            "ollama": ollama_ok,
            "features": ["stt", "auto_send", "chat"],
        }
    )


async def handle_models(request: web.Request) -> web.Response:
    cfg = request.app["cfg"]
    try:
        async with request.app["http"].get(f"{cfg['ollama_url']}/api/tags") as resp:
            body = await resp.json()
    except Exception as exc:
        raise web.HTTPBadGateway(text=f"Ollama unreachable at {cfg['ollama_url']}: {exc}")
    installed = body.get("models", [])
    return web.json_response(
        {
            "models": [m["name"] for m in installed],
            "default": cfg["ollama_model"],
            "details": {m["name"]: {"size_gb": round(m.get("size", 0) / 1e9, 1)} for m in installed},
        }
    )


async def handle_chat(request: web.Request) -> web.Response:
    """One non-streamed chat completion, passed through to Ollama.

    Body: {messages, model?, format?, think?, options?{temperature, num_predict,
    top_p, seed}}. Thinking is off unless asked for; if a model refuses the flag
    the call is retried without it. Some models (qwen3's thinking builds) ignore
    think:false and reason into the reply -- the client handles that by always
    sending a JSON-schema format, which leaves no room for it.
    """
    body = await request.json()
    messages = body.get("messages") or []
    if not isinstance(messages, list) or not messages:
        raise web.HTTPBadRequest(text="messages is required")
    cfg = request.app["cfg"]
    options = {k: v for k, v in (body.get("options") or {}).items() if k in ("temperature", "num_predict", "top_p", "seed")}
    payload = {
        "model": body.get("model") or cfg["ollama_model"],
        "messages": [{"role": str(m.get("role", "user")), "content": str(m.get("content", ""))} for m in messages],
        "stream": False,
        "think": bool(body.get("think", False)),
        "options": options,
    }
    if body.get("format"):
        payload["format"] = body["format"]

    async def call(p: dict) -> tuple[int, dict | str]:
        async with request.app["http"].post(f"{cfg['ollama_url']}/api/chat", json=p) as resp:
            if resp.status != 200:
                return resp.status, (await resp.text())[:300]
            return 200, await resp.json()

    started = time.monotonic()
    status, data = await call(payload)
    if status != 200 and "think" in str(data).lower():
        payload.pop("think", None)
        status, data = await call(payload)
    if status != 200:
        raise web.HTTPBadGateway(text=f"Ollama HTTP {status}: {data}")
    content = (data.get("message") or {}).get("content", "")
    content = re.sub(r"<think>.*?</think>", "", content, flags=re.S).strip()
    log.info("chat: %s, %.1fs, %d chars", payload["model"], time.monotonic() - started, len(content))
    return web.json_response({"content": content, "model": data.get("model", payload["model"])})


async def handle_stt_http(request: web.Request) -> web.Response:
    """Transcribes posted PCM (s16le 16 kHz mono). The WebSocket is better, but
    this always works. With ?partial=1&auto=1 it also says whether the speaker
    has finished, since an HTTP client can't hear silence itself."""
    pcm = await request.read()
    seconds = len(pcm) / 2 / SAMPLE_RATE
    partial = request.query.get("partial") == "1"
    # Whisper decodes silence into "You" or "Thank you."; no voice, no decode.
    had_speech, trailing = await asyncio.to_thread(vad.analyze, pcm)
    try:
        text = await request.app["stt"].transcribe(pcm) if had_speech else ""
    except Exception as exc:
        log.exception("transcription failed")
        raise web.HTTPInternalServerError(text=str(exc))
    if not partial:
        log.info("STT over HTTP: %.1fs -> %r", seconds, text)
    body = {"text": text, "seconds": round(seconds, 2)}
    if partial and request.query.get("auto") == "1":
        body["ended"] = had_speech and trailing >= request.app["cfg"]["end_silence_seconds"]
        body["no_speech"] = not had_speech and seconds >= 8.0
    return web.json_response(body)


async def handle_stt(request: web.Request) -> web.WebSocketResponse:
    """Streams PCM in while the player talks.

    Binary frames: raw PCM s16le 16 kHz mono. Text frames (JSON):
      {"type":"start","auto_stop":true}  begin an utterance
      {"type":"stop"}                     end it now and transcribe
    Replies: listening, partial{text}, auto_stop{reason}, transcribing, final{text}, error.
    """
    ws = web.WebSocketResponse(heartbeat=30, max_msg_size=8 * 1024 * 1024)
    await ws.prepare(request)
    stt: Transcriber = request.app["stt"]
    cfg = request.app["cfg"]
    loop = asyncio.get_running_loop()
    log.info("STT client connected")

    chunks: list[bytes] = []
    active = False
    auto_stop = False
    endpointer: vad.Endpointer | None = None
    since_vad = 0.0
    last_partial = 0.0
    partial_task: asyncio.Task | None = None

    async def emit_partial(snapshot: bytes) -> None:
        try:
            text = await stt.transcribe(snapshot)
            if text and not ws.closed:
                await ws.send_json({"type": "partial", "text": text})
        except Exception:
            log.debug("partial failed", exc_info=True)

    async def finish(reason: str | None = None) -> None:
        nonlocal chunks, active, endpointer
        active = False
        heard = endpointer is not None and endpointer.had_speech
        endpointer = None
        if partial_task and not partial_task.done():
            # A partial landing after the final would overwrite it.
            partial_task.cancel()
        pcm = b"".join(chunks)
        chunks = []
        seconds = len(pcm) / 2 / SAMPLE_RATE
        if reason:
            await ws.send_json({"type": "auto_stop", "reason": reason})
        await ws.send_json({"type": "transcribing", "seconds": round(seconds, 2)})
        try:
            if not heard and reason != "no_speech":
                heard, _ = await asyncio.to_thread(vad.analyze, pcm)
            text = await stt.transcribe(pcm) if heard else ""
            log.info("STT: %.1fs%s -> %r", seconds, f" ({reason})" if reason else "", text)
            await ws.send_json({"type": "final", "text": text, "seconds": round(seconds, 2)})
        except Exception as exc:
            log.exception("transcription failed")
            await ws.send_json({"type": "error", "error": str(exc)})

    async for msg in ws:
        if msg.type is WSMsgType.BINARY:
            if not active:
                # Audio still arriving after an auto-stop, before the app closed
                # the mic; keeping it would start the next utterance with it.
                continue
            chunks.append(msg.data)
            if endpointer is not None:
                endpointer.feed(msg.data)
                since_vad += len(msg.data) / 2 / SAMPLE_RATE
                if since_vad >= VAD_INTERVAL_SECONDS:
                    since_vad = 0.0
                    verdict = endpointer.check()  # ~2 ms; inline keeps the buffer single-threaded
                    if auto_stop and verdict != "continue":
                        await finish(verdict)
                        continue
            if endpointer is None or not endpointer.had_speech:
                continue
            now = loop.time()
            if now - last_partial >= PARTIAL_INTERVAL_SECONDS and (partial_task is None or partial_task.done()):
                last_partial = now
                partial_task = asyncio.create_task(emit_partial(b"".join(chunks)))
            continue
        if msg.type is not WSMsgType.TEXT:
            continue
        try:
            control = json.loads(msg.data)
        except json.JSONDecodeError:
            continue
        kind = control.get("type")
        if kind == "start":
            chunks = []
            active = True
            since_vad = 0.0
            auto_stop = bool(control.get("auto_stop"))
            endpointer = vad.Endpointer(end_silence=cfg["end_silence_seconds"])
            last_partial = loop.time()
            await ws.send_json({"type": "listening", "auto_stop": auto_stop})
        elif kind == "stop" and active:
            await finish()

    log.info("STT client disconnected")
    return ws


async def handle_index(request: web.Request) -> web.Response:
    return web.Response(text=f"Delve server {VERSION}. Point the Delve app's Settings at this address.\n")


# --------------------------------------------------------------------------
# Startup
# --------------------------------------------------------------------------


async def resolve_ollama_url(app: web.Application) -> None:
    """Ollama binds exactly one address; find the one it's on."""
    cfg = app["cfg"]
    for url in dict.fromkeys([cfg["ollama_url"], "http://127.0.0.1:11434", *cfg.get("ollama_fallback_urls", [])]):
        try:
            async with app["http"].get(f"{url}/api/tags", timeout=ClientTimeout(total=4)) as resp:
                if resp.status == 200:
                    if url != cfg["ollama_url"]:
                        log.warning("Ollama not at %s; using %s", cfg["ollama_url"], url)
                    cfg["ollama_url"] = url
                    return
        except Exception:
            continue
    log.error("Ollama did not answer; the Dungeon Master will be offline until it does.")


def start_mdns(cfg: dict):
    """Publishes delve.local (best effort: needs zeroconf and multicast)."""
    if not cfg.get("mdns", True):
        return None
    try:
        from zeroconf import ServiceInfo, Zeroconf
    except ImportError:
        log.info("zeroconf not installed; skipping delve.local")
        return None
    try:
        host = str(cfg.get("host", "")).strip()
        if host in ("", "0.0.0.0", "127.0.0.1", "localhost"):
            probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            probe.connect(("8.8.8.8", 80))
            local_ip = probe.getsockname()[0]
            probe.close()
        else:
            # Advertise the address actually bound, or delve.local would point
            # at a port nothing listens on.
            local_ip = host
        zc = Zeroconf()
        info = ServiceInfo(
            "_http._tcp.local.",
            "Delve Server._http._tcp.local.",
            addresses=[socket.inet_aton(local_ip)],
            port=int(cfg["port"]),
            properties={"path": "/"},
            server="delve.local.",
        )
        zc.register_service(info)
        log.info("Advertising delve.local -> %s:%s", local_ip, cfg["port"])
        return zc, info
    except Exception as exc:
        log.warning("Could not advertise over mDNS: %s", exc)
        return None


async def on_startup(app: web.Application) -> None:
    app["http"] = ClientSession(timeout=ClientTimeout(total=None, sock_connect=10))
    app["mdns"] = await asyncio.to_thread(start_mdns, app["cfg"])
    await resolve_ollama_url(app)
    await asyncio.to_thread(app["stt"].load)
    await asyncio.to_thread(vad.scorer)


async def on_cleanup(app: web.Application) -> None:
    await app["http"].close()
    if app.get("mdns"):
        zc, info = app["mdns"]
        await asyncio.to_thread(zc.unregister_service, info)
        await asyncio.to_thread(zc.close)


def build_app(cfg: dict) -> web.Application:
    app = web.Application(client_max_size=16 * 1024 * 1024, middlewares=[cors_middleware])
    app["cfg"] = cfg
    app["stt"] = Transcriber(cfg)
    app.router.add_get("/", handle_index)
    app.router.add_get("/api/health", handle_health)
    app.router.add_get("/api/models", handle_models)
    app.router.add_post("/api/chat", handle_chat)
    app.router.add_post("/api/stt", handle_stt_http)
    app.router.add_get("/stt", handle_stt)
    app.on_startup.append(on_startup)
    app.on_cleanup.append(on_cleanup)
    return app


def wait_for_address(host: str, timeout: float = 180.0) -> bool:
    """At logon this can start before Tailscale's interface is up; wait for it."""
    if host in ("0.0.0.0", "127.0.0.1", "localhost", ""):
        return True
    deadline = time.monotonic() + timeout
    warned = False
    while time.monotonic() < deadline:
        probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            probe.bind((host, 0))
            return True
        except OSError:
            if not warned:
                log.info("Waiting for %s (is Tailscale up?)...", host)
                warned = True
            time.sleep(3)
        finally:
            probe.close()
    log.error("Address %s never became available", host)
    return False


def main() -> int:
    parser = argparse.ArgumentParser(description="Delve server: speech + AI Dungeon Master")
    parser.add_argument("--config", default=str(HERE / "config.json"))
    parser.add_argument("--host")
    parser.add_argument("--port", type=int)
    parser.add_argument("--log-file", help="append logs here (needed under pythonw)")
    args = parser.parse_args()
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        **({"filename": args.log_file, "filemode": "a"} if args.log_file else {}),
    )
    cfg = load_config(Path(args.config))
    if args.host:
        cfg["host"] = args.host
    if args.port:
        cfg["port"] = args.port
    if not wait_for_address(cfg["host"]):
        return 1
    log.info("Delve server %s on http://%s:%s", VERSION, cfg["host"], cfg["port"])
    web.run_app(build_app(cfg), host=cfg["host"], port=cfg["port"], print=None)
    return 0


if __name__ == "__main__":
    sys.exit(main())
