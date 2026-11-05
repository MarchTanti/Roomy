'use client';

/**
 * The products of a search, the pictures made from them, and the comparison
 * the model asked for.
 *
 * A card is a product the user can act on: press it and the room photo comes
 * back with that piece of furniture in it. Everything on the card comes from
 * the catalogue row — the price and the dimensions are what the database says
 * they are.
 *
 * A picture is a *version* of one product in one room. The strip under it
 * holds every version so far, oldest first; the user picks the one they like
 * and types what to change ("ย้ายไปทางขวา", "ทำให้เล็กลง"), which becomes the
 * next version.
 *
 * Split out of `chat-client.tsx` because it is a list of things with their own
 * state (which one is generating, which version is on screen, what has been
 * typed) and folding it into the chat component would bury the chat.
 */

import { useState } from 'react';

import { Lightbox } from './lightbox';

export interface ProductCardView {
  id: string;
  name_th: string;
  name_en: string;
  category: string;
  style_tags: string[];
  color: string | null;
  material: string | null;
  price_thb: number;
  width_cm: number;
  depth_cm: number;
  height_cm: number;
  image_url: string;
  in_stock: boolean;
  /** Where the product can be seen, when the catalogue knows. */
  source_url?: string | null;
}

export interface GeneratedImageView {
  id: string;
  url: string;
  /** The product this picture places. */
  productId: string;
  productName: string;
  /** 'fits' | 'tight' | 'does_not_fit', when the space was measured. */
  verdict: string | null;
  /** 1 for the first version of this product, 2 for the next, and so on. */
  version: number;
  /** The change the user asked for, when this version was an iteration. */
  instruction: string | null;
  /**
   * The request this picture was made for, in the user's own words.
   *
   * It is the sentence they typed in the chat that asked for this piece, and
   * it is what the picture follows. Kept with the picture so that a later
   * version of the same piece is made for the same request.
   */
  placement: string | null;
}

export interface ComparisonProduct {
  id: string;
  name_th: string;
  name_en: string;
  price_thb: number;
  width_cm: number;
  depth_cm: number;
  height_cm: number;
  image_url: string;
  in_stock: boolean;
  verdict: string | null;
  reasons: string[];
}

export interface ComparisonView {
  products: ComparisonProduct[];
  space: { width_cm: number; depth_cm: number; height_cm: number | null } | null;
  cheapest_id: string | null;
  best_fit_id: string | null;
}

const VERDICTS: Record<string, { label: string; tone: string }> = {
  fits: { label: 'วางได้', tone: 'text-ok bg-ok-soft' },
  tight: { label: 'พอดีเป๊ะ', tone: 'text-warn bg-warn-soft' },
  does_not_fit: { label: 'วางไม่พอดี', tone: 'text-bad bg-bad-soft' },
};

function baht(value: number): string {
  return `${value.toLocaleString('th-TH')} บาท`;
}

/**
 * Saves the picture to the user's machine.
 *
 * The picture may live on the storage host, so a plain `download` attribute is
 * ignored by the browser for a cross-origin URL. Fetching it first and handing
 * over a blob works either way — and if the fetch is refused, the picture
 * opens in a new tab instead of failing silently.
 */
async function downloadImage(url: string, filename: string): Promise<void> {
  try {
    const res = await fetch(url);
    const blob = await res.blob();
    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = objectUrl;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(objectUrl);
  } catch {
    window.open(url, '_blank', 'noopener');
  }
}

export function ProductCards({
  products,
  images,
  comparison,
  placement,
  onGenerate,
  onIterate,
  generatingId,
  quotaLeft,
  error,
  disabled = false,
}: {
  products: ProductCardView[];
  images: GeneratedImageView[];
  comparison: ComparisonView | null;
  /**
   * The request the pieces in this group are placed for, in the user's words.
   *
   * It is the sentence the user typed in the chat that asked for these
   * pieces. Without one there is nothing to place — a picture made for a
   * request nobody wrote would be the app's guess — so the button stays shut
   * and says why.
   */
  placement: string | null;
  onGenerate: (product: ProductCardView) => void;
  /** Ask for another version of the piece in `image`, with this change. */
  onIterate: (image: GeneratedImageView, instruction: string) => void;
  /** The id of the product currently being generated, if any. */
  generatingId: string | null;
  /** Images left in this session, or null while the server has not said. */
  quotaLeft: number | null;
  error: string | null;
  disabled?: boolean;
}) {
  // Which version of which piece is on screen. Null → the newest one.
  const [selected, setSelected] = useState<Record<string, string>>({});
  // The change the user is typing, per piece.
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  // The picture opened full size.
  const [zoomed, setZoomed] = useState<GeneratedImageView | null>(null);

  const outOfQuota = quotaLeft === 0;
  const busy = generatingId !== null;

  // The versions of each product, oldest first.
  const chains = new Map<string, GeneratedImageView[]>();
  for (const image of images) {
    const chain = chains.get(image.productId) ?? [];
    chain.push(image);
    chains.set(image.productId, chain);
  }
  for (const chain of chains.values()) chain.sort((a, b) => a.version - b.version);

  return (
    <div className="space-y-4">
      {products.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-2">
          {products.map((product) => (
            <ProductCard
              key={product.id}
              product={product}
              busy={busy}
              generating={generatingId === product.id}
              outOfQuota={outOfQuota}
              disabled={disabled}
              placement={placement}
              onGenerate={onGenerate}
            />
          ))}
        </div>
      )}

      {[...chains.entries()].map(([productId, versions]) => {
        const activeId = selected[productId] ?? versions[versions.length - 1].id;
        const active = versions.find((v) => v.id === activeId) ?? versions[versions.length - 1];
        const draft = drafts[productId] ?? '';

        return (
          <section key={productId} className="card overflow-hidden p-3">
            <figure>
              <div className="relative">
                <img
                  src={active.url}
                  alt={`รูปจำลองของ ${active.productName}`}
                  className="w-full rounded-lg border border-line"
                />
                <button
                  type="button"
                  onClick={() => setZoomed(active)}
                  className="absolute right-2 bottom-2 rounded-full bg-black/60 px-3 py-1.5 text-xs text-white backdrop-blur-sm hover:bg-black/75"
                >
                  ขยายรูป
                </button>
              </div>
              <figcaption className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-soft">
                <span className="font-medium text-ink">{active.productName}</span>
                <span className="rounded bg-sunken px-1.5 py-0.5 text-[11px]">เวอร์ชัน {active.version}</span>
                {active.verdict && (
                  <span
                    className={`rounded px-1.5 py-0.5 text-[11px] ${
                      VERDICTS[active.verdict]?.tone ?? 'text-ink-faint bg-sunken'
                    }`}
                  >
                    {VERDICTS[active.verdict]?.label ?? active.verdict}
                  </span>
                )}
                <span className="rounded bg-sunken px-1.5 py-0.5 text-[11px] text-ink-faint">
                  ภาพจำลอง
                </span>
                {active.placement && (
                  <span className="w-full text-[11px] text-ink-faint">
                    วางตามคำขอ “{active.placement}”
                  </span>
                )}
                {active.instruction && (
                  <span className="w-full text-[11px] text-ink-faint">แก้ไว้ว่า “{active.instruction}”</span>
                )}
              </figcaption>
            </figure>

            {/* Every version of this piece, so the user can go back to one. */}
            {versions.length > 1 && (
              <div className="mt-3 flex gap-2 overflow-x-auto pb-1">
                {versions.map((version) => (
                  <button
                    key={version.id}
                    type="button"
                    onClick={() => setSelected((prev) => ({ ...prev, [productId]: version.id }))}
                    className={`shrink-0 rounded-lg border-2 text-left ${
                      version.id === active.id
                        ? 'border-brand'
                        : 'border-transparent opacity-60 hover:opacity-100'
                    }`}
                    title={`เวอร์ชัน ${version.version}`}
                  >
                    <img
                      src={version.url}
                      alt={`เวอร์ชัน ${version.version}`}
                      className="h-16 w-24 rounded-md object-cover"
                    />
                    <span className="block px-1 pb-0.5 text-[10px] text-ink-faint">v{version.version}</span>
                  </button>
                ))}
              </div>
            )}

            <div className="mt-3 flex flex-col gap-2 sm:flex-row">
              <input
                value={draft}
                onChange={(e) => setDrafts((prev) => ({ ...prev, [productId]: e.target.value }))}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && draft.trim() && !busy && !outOfQuota) {
                    e.preventDefault();
                    onIterate(active, draft.trim());
                    setDrafts((prev) => ({ ...prev, [productId]: '' }));
                  }
                }}
                placeholder="อยากปรับอะไร เช่น ย้ายไปทางขวา / ทำให้เล็กลง"
                disabled={busy || outOfQuota}
                className="min-w-0 flex-1 rounded-lg border border-line bg-sunken px-3 py-2 text-sm outline-none placeholder:text-ink-faint focus:border-brand disabled:opacity-50"
              />
              <button
                type="button"
                onClick={() => {
                  onIterate(active, draft.trim());
                  setDrafts((prev) => ({ ...prev, [productId]: '' }));
                }}
                disabled={busy || outOfQuota || draft.trim().length === 0}
                title={outOfQuota ? 'โควตารูปของเซสชันนี้หมดแล้ว' : undefined}
                className="btn-quiet shrink-0 px-4 py-2 text-sm disabled:cursor-not-allowed"
              >
                {busy ? 'กำลังวาด…' : 'วางใหม่'}
              </button>
              <button
                type="button"
                onClick={() => void downloadImage(active.url, `roomyai-${active.productName}.png`)}
                className="btn-quiet shrink-0 px-4 py-2 text-sm"
                title="บันทึกรูปลงเครื่อง"
              >
                บันทึกรูป
              </button>
            </div>
            {outOfQuota && (
              <p className="mt-2 text-xs text-warn">
                โควตารูปของเซสชันนี้หมดแล้ว — เริ่มเซสชันใหม่เพื่อวาดเพิ่มได้
              </p>
            )}
          </section>
        );
      })}

      {comparison && comparison.products.length > 0 && <ComparisonTable comparison={comparison} />}

      {error && <p className="text-sm leading-snug text-bad">{error}</p>}

      {zoomed && (
        <Lightbox src={zoomed.url} alt={`รูปจำลองของ ${zoomed.productName}`} onClose={() => setZoomed(null)} />
      )}
    </div>
  );
}

function ProductCard({
  product,
  busy,
  generating,
  outOfQuota,
  disabled,
  placement,
  onGenerate,
}: {
  product: ProductCardView;
  busy: boolean;
  generating: boolean;
  outOfQuota: boolean;
  disabled: boolean;
  /** The request this piece would be placed for, when there is one. */
  placement: string | null;
  onGenerate: (product: ProductCardView) => void;
}) {
  const meta = [product.color, product.material].filter(Boolean).join(' · ');
  // No request, no picture: the button stays shut and says what is missing.
  const noPrompt = !placement;

  return (
    <figure className="card flex flex-col overflow-hidden">
      {/* The picture comes first: what the piece looks like is the reason the
          user is looking at the card at all. */}
      {product.image_url && (
        <img
          src={product.image_url}
          alt={product.name_th}
          className="aspect-[4/3] w-full border-b border-line bg-tint object-contain"
        />
      )}

      <div className="flex flex-1 flex-col p-4">
        <figcaption className="text-sm leading-snug font-medium">{product.name_th}</figcaption>
        <p className="mt-0.5 truncate text-xs text-ink-faint">{product.name_en}</p>
        <p className="mt-1.5 text-base font-semibold text-brand tabular-nums">
          {baht(product.price_thb)}
        </p>

        <p className="mt-2 text-xs text-ink-soft tabular-nums">
          กว้าง {product.width_cm} × ลึก {product.depth_cm} × สูง {product.height_cm} ซม.
        </p>
        {meta && <p className="mt-1 text-xs text-ink-faint">{meta}</p>}

        <div className="mt-2 flex flex-wrap items-center gap-2">
          {!product.in_stock && (
            <span className="rounded-full bg-warn-soft px-2 py-0.5 text-[11px] text-warn">
              หมดสต็อก
            </span>
          )}
          {product.source_url && (
            <a
              href={product.source_url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-ink-faint underline underline-offset-2 hover:text-ink-soft"
            >
              ดูสินค้า
            </a>
          )}
        </div>

        <button
          type="button"
          onClick={() => onGenerate(product)}
          disabled={disabled || busy || outOfQuota || noPrompt}
          title={
            outOfQuota
              ? 'โควตารูปของเซสชันนี้หมดแล้ว'
              : noPrompt
                ? 'พิมพ์บอกว่าอยากได้ห้องแบบไหนก่อน แล้วผมจะวางให้ดู'
                : undefined
          }
          className="btn-primary mt-3 w-full px-3 py-2 text-sm disabled:cursor-not-allowed"
        >
          {generating
            ? 'กำลังวาดรูป…'
            : outOfQuota
              ? 'โควตารูปหมดแล้ว'
              : noPrompt
                ? 'ยังไม่มีคำขอ'
                : 'วางในห้องให้ดู'}
        </button>
        {noPrompt && (
          <p className="mt-1.5 text-[11px] leading-snug text-ink-faint">
            พิมพ์บอกว่าอยากได้ห้องแบบไหนก่อน แล้วกดวางในห้องให้ดูได้
          </p>
        )}
      </div>
    </figure>
  );
}

/** The numbers of the comparison, side by side. */
function ComparisonTable({ comparison }: { comparison: ComparisonView }) {
  return (
    <section className="card space-y-3 p-4">
      <h3 className="text-xs font-semibold tracking-wide text-ink-faint uppercase">เทียบกัน</h3>
      {comparison.space && (
        <p className="text-xs text-ink-soft">
          พื้นที่ที่วัดไว้ {comparison.space.width_cm} × {comparison.space.depth_cm} ซม.
        </p>
      )}
      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs">
          <thead>
            <tr className="border-b border-line">
              <th className="py-2 pr-3 font-medium text-ink-soft">สินค้า</th>
              <th className="py-2 pr-3 font-medium text-ink-soft">ราคา</th>
              <th className="py-2 pr-3 font-medium text-ink-soft">ก.×ล.×ส. (ซม.)</th>
              <th className="py-2 font-medium text-ink-soft">วางได้ไหม</th>
            </tr>
          </thead>
          <tbody>
            {comparison.products.map((product) => (
              <tr key={product.id} className="border-b border-line-soft last:border-0">
                <td className="py-2.5 pr-3">
                  <div className="flex items-center gap-2">
                    {product.image_url && (
                      <img
                        src={product.image_url}
                        alt=""
                        className="h-8 w-8 shrink-0 rounded border border-line bg-sunken object-cover"
                      />
                    )}
                    <span className="font-medium">{product.name_th}</span>
                  </div>
                  <div className="mt-1 flex flex-wrap gap-1 text-[11px]">
                    {product.id === comparison.cheapest_id && (
                      <span className="rounded bg-sunken px-1.5 py-0.5 text-ink-soft">ราคาถูกสุด</span>
                    )}
                    {product.id === comparison.best_fit_id && (
                      <span className="rounded bg-ok-soft px-1.5 py-0.5 text-ok">วางได้ดีที่สุด</span>
                    )}
                    {!product.in_stock && (
                      <span className="rounded bg-warn-soft px-1.5 py-0.5 text-warn">หมดสต็อก</span>
                    )}
                  </div>
                </td>
                <td className="py-2.5 pr-3 whitespace-nowrap tabular-nums">{baht(product.price_thb)}</td>
                <td className="py-2.5 pr-3 whitespace-nowrap tabular-nums">
                  {product.width_cm}×{product.depth_cm}×{product.height_cm}
                </td>
                <td className="py-2.5 whitespace-nowrap">
                  {product.verdict ? (
                    <span
                      className={`rounded px-1.5 py-0.5 text-[11px] ${
                        VERDICTS[product.verdict]?.tone ?? 'bg-sunken text-ink-faint'
                      }`}
                    >
                      {VERDICTS[product.verdict]?.label ?? product.verdict}
                    </span>
                  ) : (
                    <span className="text-ink-faint">ยังไม่ได้วัดพื้นที่</span>
                  )}
                  {product.reasons.length > 0 && (
                    <span className="mt-0.5 block text-[11px] leading-snug text-ink-faint">
                      {product.reasons[0]}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
