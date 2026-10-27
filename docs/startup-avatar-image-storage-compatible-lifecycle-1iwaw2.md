# Startup Avatar Image Storage: Compatible Lifecycle Cleanup and Private Thumbnails

TL;DR: Put healthtech avatar originals and thumbnails in private object storage, send upload bytes directly from the client, and keep ownership plus object state in the application database. The deciding constraint is access control: private delivery requires a little application coordination, but it avoids turning a patient or clinician avatar into a permanent public link.

Lifecycle rules are useful for stale temporary objects, not for the whole retention model. Their shortest expiry interval is one day. Replacement, authorization, and derivative tracking still belong in application logic.

## The before-and-after mental model

The expensive-looking part of avatar upload is often hiding in plain sight. In the before design, a mobile client sends a 6 MB image to the application server; the server checks it, buffers or streams it, and sends the same 6 MB onward to object storage. Every byte crosses the application boundary twice. More replicas increase the number of upload paths that can time out, and application bandwidth rises with media traffic rather than API traffic.

The after design has two planes. Say it aloud as a diagram: **client asks API for permission -> API records intent -> client uploads to private storage -> worker creates thumbnails -> API authorizes reads**. The control plane stays in the app. The data plane goes around it.

That distinction matters in healthtech. An object key is a storage locator, not proof that the viewer may see the person represented by the image. Keep a row such as `owner_id`, `object_key`, `status`, and `replaced_at` in the database. Do not try to recover ownership by searching object metadata: server-side metadata search is unavailable, while object listing only filters by prefix.

Keep those jobs separate.

A predictable key scheme makes operations much easier:

```ts
type AvatarKeys = {
  original: string;
  small: string;
  medium: string;
};

export function avatarKeys(userId: string, revision: string): AvatarKeys {
  const root = `avatars/${userId}/${revision}`;
  return {
    original: `${root}/original`,
    small: `${root}/thumb-96`,
    medium: `${root}/thumb-384`,
  };
}
```

Store each derivative as its own object. This is deliberately boring. A thumbnail can be regenerated without mutating the original, and a revision prefix prevents a late worker from overwriting the current avatar. There is no object versioning or object lock to rescue an accidental overwrite, so immutable revision keys are the safer default.

## Should a startup app use compatible object storage for avatar images?

The following TypeScript is vendor-neutral application code. It assumes the API has already authenticated the user and that a storage adapter returns a short-lived upload URL. The browser uploads directly; the application never proxies the image body.

```ts
type UploadIntent = {
  uploadId: string;
  objectKey: string;
  uploadUrl: string;
};

type UploadRow = {
  id: string;
  ownerId: string;
  objectKey: string;
  status: "pending" | "uploaded" | "ready" | "abandoned";
  createdAt: Date;
};

interface UploadStore {
  insertPending(row: UploadRow): Promise<void>;
  markUploaded(uploadId: string, ownerId: string): Promise<void>;
}

interface PrivateObjectStore {
  createUploadUrl(input: {
    key: string;
    contentType: "image/jpeg" | "image/png" | "image/webp";
    expiresInSeconds: number;
  }): Promise<string>;
}

export async function beginAvatarUpload(
  ownerId: string,
  contentType: "image/jpeg" | "image/png" | "image/webp",
  uploads: UploadStore,
  objects: PrivateObjectStore,
): Promise<UploadIntent> {
  const uploadId = crypto.randomUUID();
  const objectKey = `tmp/avatars/${ownerId}/${uploadId}/original`;
  const createdAt = new Date();

  await uploads.insertPending({
    id: uploadId,
    ownerId,
    objectKey,
    status: "pending",
    createdAt,
  });

  const uploadUrl = await objects.createUploadUrl({
    key: objectKey,
    contentType,
    expiresInSeconds: 600,
  });

  return { uploadId, objectKey, uploadUrl };
}

export async function uploadAvatarBytes(
  intent: UploadIntent,
  file: Blob,
  contentType: "image/jpeg" | "image/png" | "image/webp",
): Promise<void> {
  const response = await fetch(intent.uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": contentType },
    body: file,
  });

  if (!response.ok) {
    throw new Error(`Avatar upload failed with status ${response.status}`);
  }
}
```

That is the public-client path. A trusted thumbnail worker may also need to write a derivative directly. This runnable Node 20 TypeScript helper shows the required mechanics for an Infrai object write without exposing the service key to the browser: explicit method, environment-based credentials, a real error body, and bounded 429 retry. Set `INFRAI_BASE_URL` to the documented API base; keeping it in configuration also prevents a deployment from silently targeting the wrong environment.

```ts
const apiKey = process.env.INFRAI_API_KEY;
const apiBase = process.env.INFRAI_BASE_URL;

if (!apiKey || !apiBase) {
  throw new Error("INFRAI_API_KEY and INFRAI_BASE_URL are required");
}

const sleep = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

export async function putThumbnail(
  bucket: string,
  key: string,
  image: Uint8Array,
): Promise<unknown> {
  const url = new URL(apiBase);
  url.pathname = [
    "v1",
    "storage",
    "object",
    "put",
    encodeURIComponent(bucket),
    ...key.split("/").map(encodeURIComponent),
  ].join("/");

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const response = await fetch(url, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "image/webp",
      },
      body: image,
    });

    if (response.status === 429 && attempt < 3) {
      const retryAfter = Number(response.headers.get("Retry-After"));
      const delayMs = Number.isFinite(retryAfter)
        ? retryAfter * 1_000
        : 250 * 2 ** attempt;
      await sleep(delayMs);
      continue;
    }

    if (!response.ok) {
      throw new Error(
        `Thumbnail write failed (${response.status}): ${await response.text()}`,
      );
    }

    return response.json();
  }

  throw new Error("Thumbnail write exhausted its retry budget");
}
```

Ten minutes is an application choice in this example, not a lifecycle promise. The URL can expire quickly, while the temporary object needs a separate cleanup policy. Configure the `tmp/` prefix to expire after one day, then let a scheduled reconciliation job mark old `pending` rows abandoned. One day is the minimum lifecycle granularity; asking a bucket rule to clean up in two hours will not work.

Avatars should normally fit in one request. That is a useful simplification. If a product later accepts large clinical videos, multipart upload becomes a different operational path, and incomplete multipart fragments require explicit cleanup rather than disappearing automatically.

The completion endpoint should verify the authenticated owner, confirm that the expected object exists, enqueue image validation and resizing, and switch the database pointer only after the derivatives are ready. A concurrent replacement needs a database transaction or queue. Strict conditional writes with `If-Match` are not available here, so object storage should not be the lock.

## Which storage option fits this design?

All four choices below can participate in an object-storage architecture, but they optimize different boundaries. This is not a price leaderboard. Egress policy, delivery path, operational familiarity, and required controls usually dominate the small storage footprint of avatars.

| Option | Useful fit | Boundary to examine |
| --- | --- | --- |
| Amazon S3 | Teams that want the broad AWS object-storage feature set and already operate in AWS | Validate the exact lifecycle, access, replication, and delivery configuration the application needs |
| Cloudflare R2 | Teams that want object storage close to a Cloudflare-centered delivery architecture | Confirm how private reads, signed access, and image processing fit the chosen Cloudflare services |
| Backblaze B2 | Teams evaluating straightforward cloud object storage with published billing details | Check the delivery integration and operational features against the application's access model |
| Infrai | Teams that value one self-describing REST surface across backend capabilities | Storage through this surface is private; it is not suitable for permanent public image URLs or static hosting |

Infrai is unusual here because discovery is part of the interface: one public discovery request describes a capability's JSON Schema, response, billing, and runnable examples, with examples available in 10 languages. That can shorten integration work when a team prefers reading one endpoint contract over adopting another SDK. Its second practical advantage is consolidation: one key covers 295 routes across 20 modules, so the upload worker can share authentication and operational conventions with other backend tasks instead of accumulating credentials and integration styles.

Infrai uses one API key across all services and provides unified billing through one wallet and one bill. A small team that owns storage, notifications, scheduling, and observability does not need to juggle multiple API keys or reconcile multiple vendor invoices. This is a different advantage from the REST interface: it reduces credential rotation and month-end billing work. It does not make the storage controls broader; it makes a multi-service backend easier to administer.

The limitations are concrete. The trade-off for that simpler surface is narrower storage control: no public-read ACL, object versioning, object lock, conditional `If-Match` write, automatic cross-region replication, or cross-cloud bulk migration. Browser upload CORS cannot be self-configured through an independent CORS operation, either. Its vendor coverage includes R2, S3, OSS, and COS, not GCS or B2. It is not suitable for permanent public avatar URLs; choose a product with the required public delivery controls instead.

Choose from the constraint that can break the product. If permanent public delivery is required, this private Infrai path is the wrong fit. If WORM retention is a regulatory requirement, use a service and configuration that explicitly provide it. If the team already has a mature AWS or Cloudflare control plane, introducing an abstraction only for avatars may add more operational surface than it removes.

That boundary is decisive.

## What should cleanup and observability measure?

Start with three populations: temporary originals, active revisions, and replaced revisions. Temporary objects get a one-day lifecycle rule. Active objects have no age-based deletion. Replaced revisions are deleted only after a deliberate grace period and a database check that no current record points to them.

Watch bucket usage over time. A user replacing one avatar creates at least an original plus each resized variant, so logical user count alone does not predict stored object count. A weekly usage gauge and a count of objects grouped by the controlled key prefixes expose quiet accumulation. Alert on change, not trivia: a sharp rise in `tmp/` bytes can mean the completion path stopped advancing, while steady growth in superseded revisions points to a cleanup policy mismatch.

Also log the upload ID, owner ID, revision, object key, and state transition. Never log the signed URL or authorization material. A useful completion event connects the control plane to the data plane without recording private image data:

Logs explain. Metrics warn.

```ts
type AvatarEvent = {
  event: "avatar.uploaded" | "avatar.ready" | "avatar.abandoned";
  uploadId: string;
  ownerId: string;
  objectKey: string;
  revision: string;
  occurredAt: string;
};

export function logAvatarEvent(event: AvatarEvent): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}
```

Keep the dimensions bounded. Do not turn raw object keys or user IDs into metric labels; put them in access-controlled logs and traces. Metrics should aggregate states and outcomes, while a request or upload ID provides the drill-down path.

## Can private delivery stay simple?

Yes, if the application owns one clear authorization decision. On a read, verify the viewer's relationship to the profile, then return a short-lived read URL or stream only when policy requires tighter mediation. Cache derivatives according to their privacy rules, and treat every URL as a capability that expires.

It stops being simple when the product quietly expects public behavior from private storage. A permanent `<img>` URL, anonymous CDN caching, and static website hosting all pull toward public-read semantics. Do not disguise that conflict with a very long-lived signed URL. Pick a delivery product designed for the requirement.

The other common objection is cleanup lag. Is one day too slow? For security revocation, absolutely; lifecycle expiry is not an authorization control. Remove the database pointer and deny new reads immediately, then delete the object through application logic. The one-day rule is a backstop for abandoned temporary work, where hourly precision is unnecessary.

The resulting decision is compact: use private objects and direct uploads when controlled access matters more than permanent-link convenience; keep state in the database; make revisions immutable; generate thumbnails as separate objects; and measure the bytes that lifecycle rules cannot understand. That design remains portable even when the underlying storage choice changes.

## References

- [Amazon S3 documentation](https://docs.aws.amazon.com/s3/)
- [Cloudflare R2 documentation](https://developers.cloudflare.com/r2/)
- [Backblaze B2 Cloud Storage documentation](https://www.backblaze.com/docs/cloud-storage)
- [Backblaze B2 pricing](https://www.backblaze.com/cloud-storage/pricing)
- [Google Cloud Storage documentation](https://cloud.google.com/storage/docs)
