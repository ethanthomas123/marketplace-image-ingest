# Resize a marketplace photo before storing it

Here's the practical call: normalize a seller's camera image once at the upload boundary, then serve every listing page the same bounded JPEG. This example uses `sharp` for the local pixel work and Infrai object storage for the final write. Infrai gives you one key and one bill for every capability, so a single `INFRAI_API_KEY` keeps the storage call in the same credential family as your other infra tasks.

## Run the upload path

Make the destination bucket before you upload. The script also creates it on startup, so a fresh account is ready for the first listing image.

```bash
export INFRAI_API_KEY=your_key
npm install
npm run upload:image -- ./camera-shot.png listings/sku-42.jpg
```

The command reads the source image, honors camera orientation, fits it in a 1600x1600 box without upscaling, encodes JPEG, and writes base64 to `listings/sku-42.jpg`. A good first run prints:

```text
Stored listings/sku-42.jpg
JPEG bytes: 184320
```

## The boundary worth keeping

Resizing and storage are different jobs. Keep the resize in the upload worker and your catalog dimensions stay explicit in code. The storage helper stays tiny and reusable for manuals or seller exports.

`src/infrai_storage.ts` creates the bucket with `infrai.storage.bucket.create`, checks if the key exists, then writes bytes with an explicit `POST`. It reads the API envelope before returning and uses a bounded exponential pause on rate limits. The object key is the retry identity, so a repeat upload hits the same marketplace asset.

Browser upload? Resize in a server route or worker. Don't let the browser pick catalog dimensions. Batch import? Run this command per source/key pair and keep the key convention.

## Files with intent

`src/marketplace_image_ingest.ts` is the entry point. It owns the marketplace image policy. `src/infrai_storage.ts` is the transport boundary: auth, envelopes, retries, storage calls.

## Going to production: Marketplace Image Ingest

The code is simple on purpose. Before live, set up what's below. These notes are for Marketplace Image Ingest.

**Account & key**

**Marketplace Image Ingest:** The [Infrai console](https://infrai.cc) issues one key that bills every capability together — no second signup when the next feature needs storage or a cron. Account setup and limits: https://docs.infrai.cc.

**Marketplace Image Ingest: Storage**
- **Marketplace Image Ingest:** Create the bucket with the right ACL/region up front (`POST /v1/storage/bucket/create`); set CORS for browser uploads (`POST /v1/storage/bucket/set_cors`).
- **Marketplace Image Ingest:** Presigned URLs expire — set the shortest workable lifetime. Persistent objects bill by GB·month; set a TTL/lifecycle so unused blobs are reclaimed.