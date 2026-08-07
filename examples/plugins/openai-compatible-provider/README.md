# OpenAI compatible provider template

Use this when a local, hosted, or company gateway exposes the OpenAI `/v1/chat/completions` request/response shape.

## Try the local server

```bash
node server.mjs
```

Then copy/approve the plugin and select `OpenAI Compatible Agent` in CrewCode.

## Manifest notes

- `runtime: "openai-compatible"`
- `endpoint` can be a base URL like `http://localhost:4000/v1`; CrewCode appends `/chat/completions`.
- `apiKeyEnv` is optional. If set and the environment variable exists, CrewCode sends `Authorization: Bearer ...`.
