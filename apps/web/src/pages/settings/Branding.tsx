import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { useCan } from "../../lib/auth";
import { Card, PageHeader } from "../../components/ui";
import {
  useBranding,
  BRANDING_DEFAULTS,
  PRODUCT_NAME,
  DEFAULT_LOGO_URL,
  type Branding as BrandingSettings,
} from "../../lib/branding";

const COLOR_FIELDS: { key: keyof BrandingSettings; label: string }[] = [
  { key: "primary", label: "Primary" },
  { key: "secondary", label: "Secondary" },
  { key: "accent", label: "Accent" },
  { key: "background", label: "Sidebar / background" },
];

// Mirrors LOGO_MAX_BYTES in apps/api/src/routes/data.ts (the server-side
// enforcement) — this is just the friendlier client-side rejection so a
// too-big file doesn't round-trip to the API to find out. Checked against the
// *source* file, not the base64 string, so it's comfortably under that cap.
const LOGO_MAX_FILE_BYTES = 2_000_000;

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read file"));
    reader.readAsDataURL(file);
  });
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Failed to load image"));
    img.src = src;
  });
}

function toHex(n: number): string {
  return Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  switch (max) {
    case r:
      h = (g - b) / d + (g < b ? 6 : 0);
      break;
    case g:
      h = (b - r) / d + 2;
      break;
    default:
      h = (r - g) / d + 4;
  }
  return [h * 60, s, l];
}

/**
 * Quantizes the sampled pixels of an uploaded logo into a handful of
 * representative colours, ignoring near-white/near-black/transparent pixels
 * (background/outline noise, not "the brand colour"), then ranks by
 * saturation so a vivid shield-blue wins over a duller shadow tone.
 *
 * Deliberately client-side/canvas-only — no server round trip, no new
 * dependency. Only works on same-origin image data (a data: URI from a
 * just-uploaded file), which is exactly the "manually uploaded logo" case
 * this feature targets; a canvas fed a cross-origin URL throws on
 * getImageData ("tainted canvas") and that's surfaced as an error rather than
 * silently guessed at.
 */
function extractPalette(dataUrl: string, count: number): Promise<string[]> {
  return loadImage(dataUrl).then((img) => {
    const size = 96;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas unavailable");
    ctx.drawImage(img, 0, 0, size, size);
    const { data } = ctx.getImageData(0, 0, size, size);

    const buckets = new Map<string, { n: number; r: number; g: number; b: number }>();
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i]!;
      const g = data[i + 1]!;
      const b = data[i + 2]!;
      const a = data[i + 3]!;
      if (a < 128) continue;
      const [, s, l] = rgbToHsl(r, g, b);
      if (l > 0.92 || l < 0.08 || s < 0.12) continue; // skip white/black/grey
      // Coarse buckets so near-identical shades (anti-aliased edges,
      // gradients) collapse into one representative colour.
      const key = `${Math.round(r / 20)}-${Math.round(g / 20)}-${Math.round(b / 20)}`;
      const bucket = buckets.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
      bucket.n++;
      bucket.r += r;
      bucket.g += g;
      bucket.b += b;
      buckets.set(key, bucket);
    }

    const clusters = [...buckets.values()]
      .map((b) => ({ r: b.r / b.n, g: b.g / b.n, b: b.b / b.n, n: b.n }))
      .sort((a, b) => b.n * (0.4 + rgbToHsl(b.r, b.g, b.b)[1]) - a.n * (0.4 + rgbToHsl(a.r, a.g, a.b)[1]));

    // Greedily pick clusters that are visually distinct from ones already
    // picked, so "primary/secondary/accent" isn't the same blue three times.
    const picked: typeof clusters = [];
    for (const c of clusters) {
      const [h] = rgbToHsl(c.r, c.g, c.b);
      if (picked.some((p) => Math.abs(rgbToHsl(p.r, p.g, p.b)[0] - h) < 20)) continue;
      picked.push(c);
      if (picked.length === count) break;
    }
    // Not enough distinct hues in the logo — pad with the top clusters
    // regardless of closeness rather than leaving fields unfilled.
    for (const c of clusters) {
      if (picked.length === count) break;
      if (!picked.includes(c)) picked.push(c);
    }

    if (picked.length === 0) throw new Error("No colours found in this image");
    return picked.map((c) => `#${toHex(c.r)}${toHex(c.g)}${toHex(c.b)}`);
  });
}

/**
 * True when `dataUrl` is byte-for-byte the same image as the built-in default
 * logo. Pixel-extraction on the shipped shield logo tends to pull out three
 * near-identical blues (it has no third hue to offer an "accent" from) — so
 * rather than surface that, matching against the actual default logo just
 * hands back the curated default palette it was designed alongside.
 */
async function isDefaultLogo(dataUrl: string): Promise<boolean> {
  try {
    const [a, b] = await Promise.all([
      fetch(dataUrl).then((r) => r.arrayBuffer()),
      fetch(DEFAULT_LOGO_URL).then((r) => r.arrayBuffer()),
    ]);
    if (a.byteLength !== b.byteLength) return false;
    const ua = new Uint8Array(a);
    const ub = new Uint8Array(b);
    for (let i = 0; i < ua.length; i++) if (ua[i] !== ub[i]) return false;
    return true;
  } catch {
    return false;
  }
}

/** A dark, low-saturation shade of `hex`, for the sidebar/background field. */
function darkVariant(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  const [h, s] = rgbToHsl(r, g, b);
  const l = 0.07;
  const sat = Math.min(s, 0.45);
  // HSL -> RGB, inlined rather than pulled in as a dependency for one call.
  const c = (1 - Math.abs(2 * l - 1)) * sat;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r1: number, g1: number, b1: number;
  if (h < 60) [r1, g1, b1] = [c, x, 0];
  else if (h < 120) [r1, g1, b1] = [x, c, 0];
  else if (h < 180) [r1, g1, b1] = [0, c, x];
  else if (h < 240) [r1, g1, b1] = [0, x, c];
  else if (h < 300) [r1, g1, b1] = [x, 0, c];
  else [r1, g1, b1] = [c, 0, x];
  return `#${toHex((r1 + m) * 255)}${toHex((g1 + m) * 255)}${toHex((b1 + m) * 255)}`;
}

export function Branding() {
  const qc = useQueryClient();
  const canWrite = useCan("settings:write");
  const [form, setForm] = useState<BrandingSettings>(BRANDING_DEFAULTS);
  const [saved, setSaved] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [logoError, setLogoError] = useState<string | null>(null);
  const [matchError, setMatchError] = useState<string | null>(null);
  const [matching, setMatching] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { data, isLoading } = useBranding();

  useEffect(() => {
    if (data) setForm({ ...BRANDING_DEFAULTS, ...data });
  }, [data]);

  const mutation = useMutation({
    // Product name isn't part of the editable form (see lib/branding.ts) but
    // the stored setting still carries one — the API stamps it to the locked
    // value regardless of what's sent, this just avoids overwriting a
    // pre-existing stored key with `undefined`.
    mutationFn: (b: BrandingSettings) =>
      api.put("/api/settings/branding", { ...b, productName: PRODUCT_NAME }),
    onSuccess: () => {
      setSaved(true);
      qc.invalidateQueries({ queryKey: ["settings", "branding"] });
      setTimeout(() => setSaved(false), 2000);
    },
  });

  const update = (key: keyof BrandingSettings, value: string) => {
    setForm((f) => ({ ...f, [key]: value }));
  };

  async function handleLogoFile(file: File) {
    setLogoError(null);
    setMatchError(null);
    if (!file.type.startsWith("image/")) {
      setLogoError("Please choose an image file.");
      return;
    }
    if (file.size > LOGO_MAX_FILE_BYTES) {
      setLogoError(
        `That file is ${(file.size / 1_000_000).toFixed(1)}MB — please use one under ${LOGO_MAX_FILE_BYTES / 1_000_000}MB.`,
      );
      return;
    }
    try {
      const dataUrl = await readFileAsDataUrl(file);
      update("logoUrl", dataUrl);
    } catch {
      setLogoError("Couldn't read that file — please try again.");
    }
  }

  async function handleMatchColors() {
    if (!form.logoUrl) return;
    setMatching(true);
    setMatchError(null);
    try {
      if (await isDefaultLogo(form.logoUrl)) {
        setForm((f) => ({
          ...f,
          primary: BRANDING_DEFAULTS.primary,
          secondary: BRANDING_DEFAULTS.secondary,
          accent: BRANDING_DEFAULTS.accent,
          background: BRANDING_DEFAULTS.background,
        }));
        return;
      }
      const [primary, secondary, accent] = await extractPalette(form.logoUrl, 3);
      setForm((f) => ({
        ...f,
        primary: primary ?? f.primary,
        secondary: secondary ?? f.secondary,
        accent: accent ?? f.accent,
        background: darkVariant(primary ?? f.primary),
      }));
    } catch {
      setMatchError(
        form.logoUrl.startsWith("data:")
          ? "Couldn't find usable colours in this logo — try a different image."
          : "Colour matching only works on an uploaded file, not a hosted URL (browser security blocks reading pixels across origins).",
      );
    } finally {
      setMatching(false);
    }
  }

  return (
    <div>
      <PageHeader
        title="Branding"
        subtitle="White-label the console for your MSP. Ported from the prototype."
        actions={
          <button
            onClick={() => mutation.mutate(form)}
            disabled={!canWrite || mutation.isPending}
            title={!canWrite ? "Your role doesn't include settings write access." : undefined}
            className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            {mutation.isPending ? "Saving…" : saved ? "Saved ✓" : "Save"}
          </button>
        }
      />

      {!canWrite && (
        <div className="mb-5 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
          Your role doesn't include settings write access.
        </div>
      )}

      {isLoading ? (
        <Card>
          <p className="text-sm text-slate-500">Loading…</p>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
          <Card>
            <h3 className="mb-4 text-sm font-semibold text-slate-700">
              Identity
            </h3>
            <div className="mb-4">
              <span className="mb-1 block text-sm font-medium text-slate-600">
                Product name
              </span>
              <div className="flex items-center gap-2 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-500">
                <span className="font-medium text-slate-700">{PRODUCT_NAME}</span>
                <span className="ml-auto text-xs text-slate-400">Fixed</span>
              </div>
              <span className="mt-1 block text-xs text-slate-400">
                Product naming isn't customizable — this is enforced server-side too.
              </span>
            </div>

            <div className="mb-1 flex items-center justify-between">
              <span className="block text-sm font-medium text-slate-600">Logo</span>
              <button
                type="button"
                onClick={() => {
                  update("logoUrl", "");
                  setLogoError(null);
                  setMatchError(null);
                }}
                disabled={!form.logoUrl}
                className="rounded-md border border-slate-200 px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Reset to default
              </button>
            </div>
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setIsDragging(true);
              }}
              onDragLeave={() => setIsDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setIsDragging(false);
                const file = e.dataTransfer.files[0];
                if (file) void handleLogoFile(file);
              }}
              className={[
                "flex flex-col items-center gap-3 rounded-lg border-2 border-dashed px-4 py-6 text-center transition-colors",
                isDragging ? "border-indigo-400 bg-indigo-50" : "border-slate-200 bg-slate-50",
              ].join(" ")}
            >
              <img
                src={form.logoUrl || DEFAULT_LOGO_URL}
                alt="Logo preview"
                className="h-14 w-14 rounded-lg border border-slate-200 bg-white object-contain p-1"
              />
              <div className="text-xs text-slate-500">
                Drag an image here, or
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="ml-1 font-medium text-indigo-600 hover:text-indigo-700"
                >
                  browse for a file
                </button>
              </div>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void handleLogoFile(file);
                  e.target.value = "";
                }}
              />
            </div>
            {logoError && <p className="mt-2 text-xs text-red-600">{logoError}</p>}

            <label className="mt-3 block">
              <span className="mb-1 block text-xs font-medium text-slate-500">
                …or use a hosted URL instead
              </span>
              <input
                value={form.logoUrl && !form.logoUrl.startsWith("data:") ? form.logoUrl : ""}
                onChange={(e) => update("logoUrl", e.target.value)}
                placeholder="https://…/logo.svg"
                className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
              />
            </label>
          </Card>

          <Card>
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-slate-700">Colours</h3>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() =>
                    setForm((f) => ({
                      ...f,
                      primary: BRANDING_DEFAULTS.primary,
                      secondary: BRANDING_DEFAULTS.secondary,
                      accent: BRANDING_DEFAULTS.accent,
                      background: BRANDING_DEFAULTS.background,
                    }))
                  }
                  className="rounded-md border border-slate-200 px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50"
                >
                  Reset to default
                </button>
                <button
                  type="button"
                  onClick={handleMatchColors}
                  disabled={!form.logoUrl || matching}
                  title={!form.logoUrl ? "Upload a logo first" : undefined}
                  className="rounded-md border border-indigo-200 bg-indigo-50 px-2.5 py-1 text-xs font-medium text-indigo-700 hover:bg-indigo-100 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {matching ? "Matching…" : "Match colours to logo"}
                </button>
              </div>
            </div>
            {matchError && <p className="mb-3 text-xs text-red-600">{matchError}</p>}
            <div className="space-y-3">
              {COLOR_FIELDS.map(({ key, label }) => (
                <div key={key} className="flex items-center justify-between">
                  <span className="text-sm text-slate-600">{label}</span>
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      value={form[key] as string}
                      onChange={(e) => update(key, e.target.value)}
                      className="w-24 rounded-md border border-slate-300 px-2 py-1 text-sm font-mono"
                    />
                    <input
                      type="color"
                      value={form[key] as string}
                      onChange={(e) => update(key, e.target.value)}
                      className="h-9 w-12 cursor-pointer rounded border border-slate-300"
                    />
                  </div>
                </div>
              ))}
            </div>
          </Card>

          <Card className="lg:col-span-2">
            <h3 className="mb-4 text-sm font-semibold text-slate-700">
              Preview
            </h3>
            <div className="flex overflow-hidden rounded-lg border border-slate-200">
              <div
                className="flex w-48 flex-col gap-2 p-4 text-white"
                style={{ background: form.background }}
              >
                <img
                  src={form.logoUrl || DEFAULT_LOGO_URL}
                  alt=""
                  className="h-8 w-8 rounded-lg object-contain"
                />
                <span className="text-sm font-semibold">{PRODUCT_NAME}</span>
              </div>
              <div className="flex-1 bg-slate-50 p-5">
                <div className="flex gap-2">
                  <span
                    className="rounded-md px-3 py-1.5 text-sm font-medium text-white"
                    style={{ background: form.primary }}
                  >
                    Primary
                  </span>
                  <span
                    className="rounded-md px-3 py-1.5 text-sm font-medium text-white"
                    style={{ background: form.secondary }}
                  >
                    Secondary
                  </span>
                  <span
                    className="rounded-md px-3 py-1.5 text-sm font-medium text-white"
                    style={{ background: form.accent }}
                  >
                    Accent
                  </span>
                </div>
              </div>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}
