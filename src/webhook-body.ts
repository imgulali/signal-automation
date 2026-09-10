export function encodeWebhookBody(body: string, contentType: string): string {
  const mediaType = contentType.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== "application/x-www-form-urlencoded") return body;

  const fields: unknown = JSON.parse(body);
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) {
    throw new Error(
      "Form body must be a JSON object with text, number, or boolean values.",
    );
  }
  const form = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    if (!["string", "number", "boolean"].includes(typeof value)) {
      throw new Error(
        "Form body must use text, number, or boolean values; nested objects and arrays are not supported.",
      );
    }
    form.append(key, String(value));
  }
  return form.toString();
}
