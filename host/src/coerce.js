// Models sometimes send JSON-encoded strings or quoted numbers and booleans. Values are converted
// only to the type the schema asks for; anything that does not convert cleanly is left as sent.
export function coerceArgs(schema, args) {
  const value = parseJson(args, isObject);
  if (!isObject(value)) return value;
  const out = { ...value };
  for (const [key, prop] of Object.entries(schema.properties ?? {})) {
    if (key in out) out[key] = coerceValue(prop, out[key]);
  }
  return out;
}

function coerceValue(prop, value) {
  const types = [].concat(prop?.type ?? []);
  if (typeof value === "string" && types.includes("string")) return value;
  if (types.includes("array")) {
    const parsed = parseJson(value, Array.isArray);
    return Array.isArray(parsed) && prop.items ? parsed.map((item) => coerceValue(prop.items, item)) : parsed;
  }
  if (types.includes("object")) {
    const parsed = parseJson(value, isObject);
    return isObject(parsed) && prop.properties ? coerceArgs(prop, parsed) : parsed;
  }
  if (types.includes("boolean") && (value === "true" || value === "false")) return value === "true";
  if ((types.includes("number") || types.includes("integer")) && typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return value;
}

function parseJson(value, accept) {
  if (typeof value !== "string") return value;
  try {
    const parsed = JSON.parse(value);
    return accept(parsed) ? parsed : value;
  } catch {
    return value;
  }
}

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
