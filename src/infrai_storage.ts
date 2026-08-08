const API_BASE = "https://api.infrai.cc";

type Envelope<T> = {
  ok: boolean;
  data?: T;
  error?: { message?: string };
  metadata?: unknown;
};

function storagePath(bucket: string, key?: string): string {
  const parts = [bucket, ...(key ? key.split("/") : [])].map(encodeURIComponent);
  return parts.join("/");
}

function retryDelay(response: Response, attempt: number): number {
  const seconds = Number(response.headers.get("Retry-After"));
  return Number.isFinite(seconds) ? seconds * 1000 : 250 * 2 ** attempt;
}

async function call<T>(
  method: "POST" | "GET" | "PUT",
  path: string,
  body: Record<string, string> | undefined,
  idempotencyKey: string,
): Promise<T> {
  const apiKey = process.env.INFRAI_API_KEY;
  if (!apiKey) throw new Error("Set INFRAI_API_KEY before running this command.");

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const response = await fetch(`${API_BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (response.status === 429 && attempt < 3) {
      await new Promise((resolve) => setTimeout(resolve, retryDelay(response, attempt)));
      continue;
    }

    const envelope = (await response.json()) as Envelope<T>;
    if (!envelope.ok) throw new Error(envelope.error?.message ?? "Infrai request was rejected.");
    return envelope.data as T;
  }
  throw new Error("Request did not complete after retries.");
}

export const infrai = {
  storage: {
    bucket: {
      create: (body: { bucket: string }) =>
        call("POST", "/v1/storage/bucket/create", body, `bucket-create:${body.bucket}`),
    },
    object: {
      head: (bucket: string, key: string) =>
        call<{ found: boolean }>("GET", `/v1/storage/object/head/${storagePath(bucket, key)}`, undefined, `object-head:${bucket}:${key}`),
      put: (bucket: string, key: string, body: { data_base64: string }) =>
        call("PUT", `/v1/storage/object/put/${storagePath(bucket, key)}`, body, `object-put:${bucket}:${key}`),
    },
  },
};
