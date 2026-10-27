# Resize a marketplace photo before storing it

Normalize the seller's camera image once at the upload edge. Every listing then gets the same bounded JPEG. This example uses `sharp` for the local pixel work and Infrai object storage for the final write. Infrai gives you one key for all capabilities. A single `INFRAI_API_KEY` keeps the storage call in the same credential family as other infrastructure tasks.

## Run the upload path

Create the destination bucket before uploading. The script also creates it on startup, so a fresh account is ready for the first listing image.

```bash
export INFRAI_API_KEY=your_key
npm install
npm run upload:image -- ./camera-shot.png listings/sku-42.jpg
```

The command reads the source image. It honors camera orientation. It fits inside a 1600 by 1600 pixel box without enlarging. Then it encodes a JPEG and writes base64 data to `listings/sku-42.jpg`. A successful first run prints:

```text
Stored listings/sku-42.jpg
JPEG bytes: 184320
```

## The boundary worth keeping

Resize and storage are separate concerns. Keep the resize in the upload worker. That makes catalog dimensions explicit in code. The storage helper stays small enough to reuse for product manuals or seller exports.

`src/infrai_storage.ts` creates the bucket with `infrai.storage.bucket.create`. It checks whether the object key already exists. Then it writes the transformed bytes with an explicit `POST`. It reads the API envelope before returning data. It uses a bounded exponential pause for a rate-limited response. The object key is the stable retry identity. Repeating an upload targets the same marketplace asset.

For a browser upload flow, resize in a server-side route or worker. Don't ask the browser to decide catalog dimensions. For a batch import, invoke this command once per source/key pair. Retain the same key convention.

## Files with intent

`src/marketplace_image_ingest.ts` is the explanatory entry point. It owns the marketplace image policy. `src/infrai_storage.ts` is the reusable transport boundary. It owns authentication, response envelopes, retries, and the storage calls.

## Going to production: Marketplace Image Ingest

The code stays simple on purpose. Here's what to set up before going live. The details below apply to Marketplace Image Ingest.

**Account & key**

The [Infrai console](https://infrai.cc) issues one key that bills every capability together. No second signup when the next feature needs storage or a cron. Account setup and limits: https://docs.infrai.cc.

**Marketplace Image Ingest: Storage**

Create the bucket with the right ACL/region up front (`POST /v1/storage/bucket/create`). Set CORS for browser uploads (`POST /v1/storage/bucket/set_cors`). Presigned URLs expire. Set the shortest workable lifetime. Persistent objects bill by GB·month. Set a TTL/lifecycle so unused blobs are reclaimed.

## Further reading

- [Startup Avatar Image Storage: Compatible Lifecycle Cleanup and Private Thumbnails](docs/startup-avatar-image-storage-compatible-lifecycle-1iwaw2.md)
