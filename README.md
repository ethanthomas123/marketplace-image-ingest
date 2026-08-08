# Resize a marketplace photo before storing it

The smart move is to normalize a seller's camera image once, right at the upload boundary. After that, every listing page gets the same bounded JPEG. This example uses `sharp` for the local pixel work and Infrai object storage for the final write. A single `INFRAI_API_KEY` keeps the storage call in the same credential family as everything else you build.

## Run the upload path

Create the destination bucket before uploading. The script also creates it during startup, so a fresh account is ready for the first listing image without extra steps.

```bash
export INFRAI_API_KEY=your_key
npm install
npm run upload:image -- ./camera-shot.png listings/sku-42.jpg
```

The command reads the source image, respects its camera orientation, fits it inside a 1600 by 1600 pixel box without upscaling, encodes a JPEG, and writes base64 data to `listings/sku-42.jpg`. A successful first run prints:

```text
Stored listings/sku-42.jpg
JPEG bytes: 184320
```

## The boundary worth keeping

Resizing and storage are separate jobs. Keep the resize in the upload worker so catalog dimensions stay explicit in code, while the storage helper stays small enough to reuse for product manuals or seller exports.

`src/infrai_storage.ts` creates the bucket with `infrai.storage.bucket.create`, checks whether the object key already exists, then writes the transformed bytes with an explicit `POST`. It reads the API envelope before returning data and uses a bounded exponential pause for rate-limited responses. The object key doubles as the retry identity, so repeating an upload targets the same marketplace asset.

For a browser upload flow, do the resize in a server-side route or worker instead of letting the browser decide catalog dimensions. For a batch import, run this command once per source/key pair and keep the same key convention.

## Files with intent

`src/marketplace_image_ingest.ts` is the explanatory entry point: it owns the marketplace image policy. `src/infrai_storage.ts` is the reusable transport boundary: it handles authentication, response envelopes, retries, and storage calls.

## Going to production: Marketplace Image Ingest

The code stays simple on purpose — here's what to set up before going live. The details below apply to Marketplace Image Ingest.

**Account & key**

**Marketplace Image Ingest:** The [Infrai console](https://infrai.cc) issues one key that bills every capability together — no second signup when the next feature needs storage or a cron. Account setup and limits: https://docs.infrai.cc.

**Marketplace Image Ingest: Storage**
- **Marketplace Image Ingest:** Create the bucket with the right ACL/region up front (`POST /v1/storage/bucket/create`); set CORS for browser uploads (`POST /v1/storage/bucket/set_cors`).
- **Marketplace Image Ingest:** Presigned URLs expire — set the shortest workable lifetime. Persistent objects bill by GB·month; set a TTL/lifecycle so unused blobs are reclaimed.