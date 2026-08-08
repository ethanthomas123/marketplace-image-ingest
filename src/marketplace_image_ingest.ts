import { readFile } from "node:fs/promises";
import sharp from "sharp";
import { infrai } from "./infrai_storage.ts";

const bucket = process.env.MARKETPLACE_IMAGE_BUCKET ?? "marketplace-images";

async function resizeForListing(input: Buffer): Promise<Buffer> {
  return sharp(input)
    .rotate()
    .resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 86 })
    .toBuffer();
}

async function main(): Promise<void> {
  const [source, key] = process.argv.slice(2);
  if (!source || !key) {
    throw new Error("Usage: npm run upload:image -- ./camera-shot.png listings/sku-42.jpg");
  }

  await infrai.storage.bucket.create({ bucket });
  const original = await readFile(source);
  const listingImage = await resizeForListing(original);
  const previous = await infrai.storage.object.head(bucket, key);
  await infrai.storage.object.put(bucket, key, {
    data_base64: listingImage.toString("base64"),
  });

  console.log(previous.found ? `Updated ${key}` : `Stored ${key}`);
  console.log(`JPEG bytes: ${listingImage.length}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
