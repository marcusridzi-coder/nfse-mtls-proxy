import express from "express";
import { Agent, fetch as undiciFetch } from "undici";
import { gzipSync, gunzipSync } from "node:zlib";

const app = express();
app.use(express.json({ limit: "10mb" }));

const TOKEN = process.env.MTLS_PROXY_TOKEN;
if (!TOKEN) {
  console.error("MTLS_PROXY_TOKEN não definido. Configure no host.");
  process.exit(1);
}

const ENDPOINTS = {
  homologacao: "https://sefin.producaorestrita.nfse.gov.br/SefinNacional/nfse",
  producao: "https://sefin.nfse.gov.br/SefinNacional/nfse",
};

function auth(req, res, next) {
  if (req.headers["x-proxy-token"] !== TOKEN) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

app.get("/health", (_req, res) => res.json({ ok: true }));

/**
 * POST /transmitir
 * Body: { xmlSigned, certPem, keyPem, ambiente: "homologacao"|"producao" }
 * Resp: { ok, status, body, chave?, numero_nfse?, codigo_verificacao? }
 */
app.post("/transmitir", auth, async (req, res) => {
  try {
    const { xmlSigned, certPem, keyPem, ambiente } = req.body || {};
    if (!xmlSigned || !certPem || !keyPem || !ambiente) {
      return res.status(400).json({ error: "Campos obrigatórios: xmlSigned, certPem, keyPem, ambiente" });
    }
    const url = ENDPOINTS[ambiente];
    if (!url) return res.status(400).json({ error: "ambiente inválido" });

    const dispatcher = new Agent({ connect: { cert: certPem, key: keyPem } });
    const dpsXmlGZipB64 = gzipSync(Buffer.from(xmlSigned, "utf-8")).toString("base64");

    const resp = await undiciFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ dpsXmlGZipB64 }),
      dispatcher,
    });
    const status = resp.status;
    const body = await resp.text();
    const ok = status >= 200 && status < 300;

    let chave = null;
    try { chave = JSON.parse(body)?.chaveAcesso ?? null; } catch {}

    let numero_nfse = null;
    let codigo_verificacao = null;
    if (ok && chave) {
      for (let i = 0; i < 4; i++) {
        await new Promise((r) => setTimeout(r, i === 0 ? 800 : 1500));
        try {
          const r = await undiciFetch(`${url}/${chave}`, {
            method: "GET",
            headers: { Accept: "application/json" },
            dispatcher,
          });
          if (r.status === 200) {
            const txt = await r.text();
            let xmlStr = txt;
            try {
              const j = JSON.parse(txt);
              const gz = j?.nfseXmlGZipB64 ?? j?.xmlGZipB64 ?? j?.nfseProcXmlGZipB64;
              if (gz) xmlStr = gunzipSync(Buffer.from(gz, "base64")).toString("utf-8");
              else xmlStr = j?.xml ?? j?.nfseXml ?? txt;
            } catch {}
            const mNum = xmlStr.match(/<nNFSe>([^<]+)<\/nNFSe>/i);
            const mCod = xmlStr.match(/<CodVerif>([^<]+)<\/CodVerif>/i) ?? xmlStr.match(/<codVerif>([^<]+)<\/codVerif>/i);
            if (mNum) numero_nfse = mNum[1].trim();
            if (mCod) codigo_verificacao = mCod[1].trim();
            if (numero_nfse) break;
          }
        } catch {}
      }
    }

    res.json({ ok, status, body, chave, numero_nfse, codigo_verificacao });
  } catch (err) {
    res.status(500).json({ error: String(err?.message ?? err) });
  }
});

/**
 * POST /consultar
 * Body: { chave, certPem, keyPem, ambiente }
 * Resp: { ok, status, numero_nfse?, codigo_verificacao?, xml?, body }
 */
app.post("/consultar", auth, async (req, res) => {
  try {
    const { chave, certPem, keyPem, ambiente } = req.body || {};
    if (!chave || !certPem || !keyPem || !ambiente) {
      return res.status(400).json({ error: "Campos obrigatórios: chave, certPem, keyPem, ambiente" });
    }
    const url = ENDPOINTS[ambiente];
    if (!url) return res.status(400).json({ error: "ambiente inválido" });

    const dispatcher = new Agent({ connect: { cert: certPem, key: keyPem } });
    let lastStatus = 0;
    let lastBody = "";
    let numero_nfse = null;
    let codigo_verificacao = null;
    let xmlOut = null;

    for (let i = 0; i < 5; i++) {
      if (i > 0) await new Promise((r) => setTimeout(r, 1500));
      const r = await undiciFetch(`${url}/${chave}`, {
        method: "GET",
        headers: { Accept: "application/json" },
        dispatcher,
      });
      lastStatus = r.status;
      lastBody = await r.text();
      if (r.status === 200) {
        let xmlStr = lastBody;
        let j = null;
        try { j = JSON.parse(lastBody); } catch {}
        if (j) {
          const gz = j.nfseXmlGZipB64 ?? j.xmlGZipB64 ?? j.nfseProcXmlGZipB64;
          if (gz) xmlStr = gunzipSync(Buffer.from(gz, "base64")).toString("utf-8");
          else xmlStr = j.xml ?? j.nfseXml ?? JSON.stringify(j);
          numero_nfse = numero_nfse ?? j.nNFSe ?? j.numero ?? j.numeroNfse ?? null;
          codigo_verificacao = codigo_verificacao ?? j.codVerif ?? j.codigoVerificacao ?? null;
        }
        const mNum = xmlStr.match(/<nNFSe>([^<]+)<\/nNFSe>/i) ?? xmlStr.match(/<numero>([^<]+)<\/numero>/i);
        const mCod = xmlStr.match(/<CodVerif>([^<]+)<\/CodVerif>/i)
          ?? xmlStr.match(/<codVerif>([^<]+)<\/codVerif>/i)
          ?? xmlStr.match(/<codigoVerificacao>([^<]+)<\/codigoVerificacao>/i);
        if (!numero_nfse && mNum) numero_nfse = mNum[1].trim();
        if (!codigo_verificacao && mCod) codigo_verificacao = mCod[1].trim();
        if (xmlStr && xmlStr.length > 200 && /<NFSe|<InfNFSe/i.test(xmlStr)) xmlOut = xmlStr;
        if (numero_nfse) break;
      }
    }

    res.json({ ok: !!numero_nfse, status: lastStatus, numero_nfse, codigo_verificacao, xml: xmlOut, body: lastBody.slice(0, 4000) });
  } catch (err) {
    res.status(500).json({ error: String(err?.message ?? err) });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`mTLS proxy ouvindo em :${port}`));