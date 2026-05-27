# NFS-e mTLS Proxy

Micro-serviço Node que recebe XML assinado + certificado PEM e faz o POST com
**mTLS** na SEFIN Nacional. Existe porque Cloudflare Workers não suportam
anexar certificado de cliente em `fetch`, então o app principal (Lovable) não
consegue transmitir direto da produção.

## Endpoints

- `GET  /health` → `{ ok: true }`
- `POST /transmitir` (header `x-proxy-token: <TOKEN>`)
  - body: `{ xmlSigned, certPem, keyPem, ambiente: "homologacao"|"producao" }`
  - resposta: `{ ok, status, body, chave, numero_nfse, codigo_verificacao }`
- `POST /consultar` (header `x-proxy-token: <TOKEN>`)
  - body: `{ chave, certPem, keyPem, ambiente }`
  - resposta: `{ ok, status, numero_nfse, codigo_verificacao, xml, body }`

## Variáveis de ambiente

- `MTLS_PROXY_TOKEN` (obrigatório) — token compartilhado com o app Lovable
- `PORT` (opcional, default 3000)

## Deploy em 5 minutos — Render (free)

1. Crie um repositório no GitHub só com o conteúdo desta pasta (`external-mtls-proxy/`).
2. Acesse https://render.com → **New +** → **Web Service** → conecte o repo.
3. Configurações:
   - **Runtime:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `node server.js`
   - **Instance Type:** Free
4. Em **Environment**, adicione:
   - `MTLS_PROXY_TOKEN` = (gere um valor longo aleatório, ex.: `openssl rand -hex 32`)
5. **Create Web Service**. Em ~2 min você terá uma URL tipo
   `https://nfse-mtls-proxy.onrender.com`.
6. No Lovable, configure 2 secrets:
   - `MTLS_PROXY_URL` = a URL do Render (sem barra no fim)
   - `MTLS_PROXY_TOKEN` = o mesmo token do passo 4

> ⚠️ O free tier do Render dorme após 15 min sem requisições. A primeira chamada
> demora ~30s pra acordar. Para uso em produção, suba pro plano Starter ($7/mês)
> ou Fly.io.

## Deploy alternativo — Fly.io

```bash
flyctl launch          # responda "no" para Postgres/Redis
flyctl secrets set MTLS_PROXY_TOKEN=$(openssl rand -hex 32)
flyctl deploy
```

## Teste rápido

```bash
curl https://<sua-url>/health
# → {"ok":true}
```

## Segurança

- O certificado (PEM cert + key) é enviado em cada chamada e **não é armazenado**
  no servidor.
- Use HTTPS sempre (Render/Fly já entregam isso).
- O `MTLS_PROXY_TOKEN` é a única defesa — gere algo longo e mantenha em segredo.