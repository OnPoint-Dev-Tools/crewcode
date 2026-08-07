from __future__ import annotations

import argparse
import asyncio
import gc
import hmac
import io
import os
import tempfile
import threading
from pathlib import Path
from typing import Any

import numpy as np
import soundfile as sf
import uvicorn
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import Response
from pydantic import BaseModel, Field

PARAKEET_MODEL = "nvidia/parakeet-tdt-0.6b-v2"
DEFAULT_VOICE = "am_michael"
MAX_AUDIO_BYTES = 32 * 1024 * 1024
MAX_TEXT_CHARS = 4_000
MIN_SPEECH_SPEED = 0.5
MAX_SPEECH_SPEED = 2.0
IDLE_RECYCLE_EXIT_CODE = 75


class SpeechRequest(BaseModel):
    text: str = Field(min_length=1, max_length=MAX_TEXT_CHARS)
    voice: str = Field(default=DEFAULT_VOICE, pattern=r"^[a-z]{2}_[a-z0-9_]+$")
    speed: float = Field(default=1.0, ge=MIN_SPEECH_SPEED, le=MAX_SPEECH_SPEED)


class ModelRuntime:
    def __init__(self) -> None:
        self.lock = threading.RLock()
        self.parakeet: Any | None = None
        self.kokoro: Any | None = None
        self.parakeet_timer: threading.Timer | None = None
        self.kokoro_timer: threading.Timer | None = None
        self.parakeet_idle_seconds = max(
            60, int(os.getenv("CREWCODE_VOICE_PARAKEET_IDLE_SECONDS", "900"))
        )
        self.kokoro_idle_seconds = max(
            60, int(os.getenv("CREWCODE_VOICE_KOKORO_IDLE_SECONDS", "300"))
        )
        self.configured_device = os.getenv("CREWCODE_VOICE_DEVICE", "auto").lower()
        if self.configured_device not in {"auto", "gpu", "cpu"}:
            raise RuntimeError(f"Unsupported local voice device: {self.configured_device}")
        self.resolved_device: str | None = None

    def status(self) -> dict[str, Any]:
        with self.lock:
            return {
                "parakeet_loaded": self.parakeet is not None,
                "kokoro_loaded": self.kokoro is not None,
                "configured_device": self.configured_device,
                "resolved_device": self.resolved_device,
                "cuda_reserved_bytes": self._cuda_reserved_bytes(),
            }

    def warmup(self) -> None:
        with self.lock:
            self._parakeet()
            self._kokoro()
            self._schedule_parakeet_unload()
            self._schedule_kokoro_unload()

    def warmup_transcription(self) -> None:
        with self.lock:
            self._parakeet()
            self._schedule_parakeet_unload()

    def warmup_speech(self) -> None:
        with self.lock:
            self._kokoro()
            self._schedule_kokoro_unload()

    def transcribe(self, audio: bytes) -> str:
        with self.lock:
            model = self._parakeet()
            with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as handle:
                handle.write(audio)
                path = Path(handle.name)
            try:
                result = model.transcribe([str(path)])
                first = result[0]
                return str(getattr(first, "text", first)).strip()
            finally:
                path.unlink(missing_ok=True)
                self._schedule_parakeet_unload()

    def synthesize(self, text: str, voice: str, speed: float = 1.0) -> bytes:
        with self.lock:
            pipeline = self._kokoro()
            segments: list[np.ndarray[Any, Any]] = []
            for _graphemes, _phonemes, audio in pipeline(text, voice=voice, speed=speed):
                segments.append(np.asarray(audio, dtype=np.float32))
            if not segments:
                raise RuntimeError("Kokoro returned no audio.")
            output = io.BytesIO()
            sf.write(output, np.concatenate(segments), 24_000, format="WAV", subtype="PCM_16")
            self._schedule_kokoro_unload()
            return output.getvalue()

    def _parakeet(self) -> Any:
        if self.parakeet is None:
            import nemo.collections.asr as nemo_asr

            device = self._device()
            self.parakeet = nemo_asr.models.ASRModel.from_pretrained(
                PARAKEET_MODEL, map_location=device
            )
            self.parakeet.to(device)
            self.parakeet.eval()
        return self.parakeet

    def _kokoro(self) -> Any:
        if self.kokoro is None:
            from kokoro import KPipeline

            self.kokoro = KPipeline(lang_code="a", device=self._device())
        return self.kokoro

    def _device(self) -> str:
        if self.resolved_device is not None:
            return self.resolved_device
        import torch

        if self.configured_device == "gpu":
            if not torch.cuda.is_available():
                raise RuntimeError("GPU was selected, but CUDA is not available. Choose Automatic or CPU.")
            self.resolved_device = "cuda"
        elif self.configured_device == "cpu":
            self.resolved_device = "cpu"
        else:
            self.resolved_device = "cuda" if torch.cuda.is_available() else "cpu"
        return self.resolved_device

    def _schedule_parakeet_unload(self) -> None:
        if self.parakeet_timer is not None:
            self.parakeet_timer.cancel()
        self.parakeet_timer = threading.Timer(
            self.parakeet_idle_seconds, self.unload_parakeet
        )
        self.parakeet_timer.daemon = True
        self.parakeet_timer.start()

    def _schedule_kokoro_unload(self) -> None:
        if self.kokoro_timer is not None:
            self.kokoro_timer.cancel()
        self.kokoro_timer = threading.Timer(self.kokoro_idle_seconds, self.unload_kokoro)
        self.kokoro_timer.daemon = True
        self.kokoro_timer.start()

    def unload_parakeet(self) -> None:
        with self.lock:
            self.parakeet = None
            self.parakeet_timer = None
            self._release_accelerator_memory()

    def unload_kokoro(self) -> None:
        with self.lock:
            self.kokoro = None
            self.kokoro_timer = None
            self._release_accelerator_memory()

    def _release_accelerator_memory(self) -> None:
        gc.collect()
        try:
            import torch

            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        except ImportError:
            return
        # A process recycle is the only reliable fallback when PyTorch or a
        # native extension still owns CUDA allocations after both models drop.
        if self.parakeet is None and self.kokoro is None and self._cuda_reserved_bytes() > 64 * 1024 * 1024:
            os._exit(IDLE_RECYCLE_EXIT_CODE)

    def _cuda_reserved_bytes(self) -> int:
        if self.resolved_device != "cuda":
            return 0
        try:
            import torch

            return int(torch.cuda.memory_reserved()) if torch.cuda.is_available() else 0
        except ImportError:
            return 0


runtime = ModelRuntime()
app = FastAPI(title="CrewCode Local Voice", docs_url=None, redoc_url=None, openapi_url=None)


@app.middleware("http")
async def authenticate(request: Request, call_next: Any) -> Response:
    expected = os.getenv("CREWCODE_VOICE_TOKEN", "")
    supplied = request.headers.get("authorization", "")
    if not expected or not hmac.compare_digest(supplied, f"Bearer {expected}"):
        return Response(status_code=401)
    return await call_next(request)


@app.get("/v1/health")
async def health() -> dict[str, bool]:
    return {"ok": True}


@app.get("/v1/status")
async def status() -> dict[str, Any]:
    return {"ok": True, **runtime.status()}


@app.post("/v1/warmup")
async def warmup() -> dict[str, Any]:
    try:
        await asyncio.to_thread(runtime.warmup)
    except Exception as error:
        raise HTTPException(status_code=500, detail=f"Model warmup failed: {error}") from error
    return {"ok": True, **runtime.status()}


@app.post("/v1/warmup/transcription")
async def warmup_transcription() -> dict[str, Any]:
    try:
        await asyncio.to_thread(runtime.warmup_transcription)
    except Exception as error:
        raise HTTPException(status_code=500, detail=f"Parakeet warmup failed: {error}") from error
    return {"ok": True, **runtime.status()}


@app.post("/v1/warmup/speech")
async def warmup_speech() -> dict[str, Any]:
    try:
        await asyncio.to_thread(runtime.warmup_speech)
    except Exception as error:
        raise HTTPException(status_code=500, detail=f"Kokoro warmup failed: {error}") from error
    return {"ok": True, **runtime.status()}


@app.post("/v1/transcriptions")
async def transcriptions(request: Request) -> dict[str, str]:
    if request.headers.get("content-type", "").split(";")[0] != "audio/wav":
        raise HTTPException(status_code=415, detail="Expected audio/wav.")
    audio = await request.body()
    if not audio or len(audio) > MAX_AUDIO_BYTES:
        raise HTTPException(status_code=413, detail="Audio must be between 1 byte and 32 MB.")
    try:
        text = await asyncio.to_thread(runtime.transcribe, audio)
    except Exception as error:
        raise HTTPException(status_code=500, detail=f"Parakeet failed: {error}") from error
    return {"text": text}


@app.post("/v1/speech")
async def speech(payload: SpeechRequest) -> Response:
    try:
        audio = await asyncio.to_thread(
            runtime.synthesize, payload.text.strip(), payload.voice, payload.speed
        )
    except Exception as error:
        raise HTTPException(status_code=500, detail=f"Kokoro failed: {error}") from error
    return Response(content=audio, media_type="audio/wav")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=17_841)
    args = parser.parse_args()
    if args.host not in {"127.0.0.1", "::1", "localhost"}:
        raise SystemExit("CrewCode local voice may only bind to a loopback address.")
    if not os.getenv("CREWCODE_VOICE_TOKEN"):
        raise SystemExit("CREWCODE_VOICE_TOKEN is required.")
    uvicorn.run(app, host=args.host, port=args.port, access_log=False)


if __name__ == "__main__":
    main()
