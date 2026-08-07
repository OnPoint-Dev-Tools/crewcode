# CrewCode local voice service

This optional native sidecar runs Parakeet TDT 0.6B v2 transcription and
Kokoro-82M speech outside Electron. CrewCode starts it on `127.0.0.1:17841`
with a random bearer token that exists only in the main process.

Python 3.11 and an NVIDIA-supported PyTorch environment are recommended for
Parakeet. Kokoro also needs `espeak-ng` and the system `libsndfile` package.
Install those with the platform package manager, then install the service into
a dedicated virtual environment:

```bash
python3.11 -m venv .venv
.venv/bin/python -m pip install --upgrade pip
.venv/bin/python -m pip install .
```

On Windows, select `.venv\Scripts\python.exe` in CrewCode. On macOS/Linux,
select `.venv/bin/python`.

Under **Settings → Voice**, choose **Local**, paste the executable's absolute
path into the **Local voice** field, leave `am_michael` selected, and click
**start & check**. A relative path is not reliable because CrewCode may start
with a different working directory.

Models download from their upstream registries on first use. They load lazily
and unload after 15 idle minutes. The service rejects non-loopback binding,
requires authentication on every endpoint, caps audio/text payloads, and does
not expose API documentation.

CrewCode's **start & check** action calls the authenticated warmup endpoint and
does not report ready until both Parakeet and Kokoro are loaded. Initial warmup
may also download Kokoro's English spaCy data.
