'use client';

/**
 * The markdown renderer.
 *
 * It walks the tree the parser produced and builds React elements. There is no
 * `dangerouslySetInnerHTML` anywhere in this file — every character the model
 * wrote ends up as a text node, so a product description that contains markup
 * is shown, not executed.
 *
 * It also knows about the products. When the answer names a piece of furniture
 * that came back from the catalogue, the picture of that piece is put next to
 * the words — because "โซฟาลินเนส" on its own says nothing about what the sofa
 * looks like, and a recommendation the user cannot picture is a
 * recommendation they cannot want.
 */

import { useMemo } from 'react';

import { isSafeHref, parseInline, parseMarkdown, type Block, type Inline, type ListItem } from './markdown';
import { findMentionedProducts, type ProductImageRef } from './product-mentions';

export type { ProductImageRef };

/** What the renderer needs to know about the products of this answer. */
interface RenderContext {
  products: ProductImageRef[];
}

/** The plain text of a run of inline nodes. */
function plainText(nodes: Inline[]): string {
  return nodes
    .map((node) => {
      switch (node.kind) {
        case 'text':
        case 'code':
          return node.text;
        case 'strong':
        case 'em':
        case 'link':
          return plainText(node.children);
      }
    })
    .join('');
}

export function Markdown({
  text,
  className = '',
  products = [],
}: {
  text: string;
  className?: string;
  products?: ProductImageRef[];
}) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  const context = useMemo<RenderContext>(() => ({ products }), [products]);
  if (blocks.length === 0) return null;

  return <div className={className}>{blocks.map((block, index) => renderBlock(block, index, context))}</div>;
}

function renderBlock(block: Block, key: React.Key, context: RenderContext): React.ReactNode {
  switch (block.kind) {
    case 'heading': {
      const sizes = ['text-lg', 'text-base', 'text-sm'];
      return (
        <p
          key={key}
          className={`mt-4 mb-1 font-display font-semibold first:mt-0 ${sizes[block.level - 1]}`}
        >
          {renderInlines(block.children)}
        </p>
      );
    }
    case 'paragraph': {
      const named = findMentionedProducts(plainText(block.children), context.products);
      return (
        <div key={key}>
          <p className="whitespace-pre-wrap">{renderInlines(block.children)}</p>
          <ProductFigures products={named} />
        </div>
      );
    }
    case 'rule':
      return <hr key={key} className="my-3 border-line" />;
    case 'list':
      return renderList(block.items, block.ordered, key, context);
  }
}

function renderList(
  items: ListItem[],
  ordered: boolean,
  key: React.Key,
  context: RenderContext,
): React.ReactNode {
  const Tag = ordered ? 'ol' : 'ul';
  return (
    <Tag key={key} className={`space-y-1.5 ${ordered ? 'list-decimal' : 'list-disc'} pl-5 marker:text-ink-faint`}>
      {items.map((item, index) => {
        const named = findMentionedProducts(plainText(item.children), context.products);
        return (
          <li key={index}>
            <span className="whitespace-pre-wrap">{renderInlines(item.children)}</span>
            <ProductFigures products={named} />
            {item.sub.length > 0 && (
              <div className="mt-1.5">
                {renderList(item.sub, false, `${String(key)}-${index}`, context)}
              </div>
            )}
          </li>
        );
      })}
    </Tag>
  );
}

/**
 * The picture of each product the text named.
 *
 * Small on purpose: this is a reminder of what the piece looks like, sitting
 * in the sentence that recommends it. The card further down is where the user
 * acts on it.
 */
function ProductFigures({ products }: { products: ProductImageRef[] }) {
  if (products.length === 0) return null;

  return (
    <div className="mt-2 flex flex-wrap gap-2">
      {products.map((product) => (
        <figure
          key={product.id}
          className="flex items-center gap-2.5 rounded-2xl border border-line bg-tint/70 py-1.5 pr-3.5 pl-1.5"
        >
          <img
            src={product.image_url}
            alt={product.name_th}
            className="size-11 shrink-0 rounded-xl bg-white object-contain"
          />
          <figcaption className="text-xs leading-tight">
            <span className="block font-medium text-ink">{product.name_th}</span>
            <span className="text-ink-soft tabular-nums">
              {product.price_thb.toLocaleString('th-TH')} บาท
            </span>
          </figcaption>
        </figure>
      ))}
    </div>
  );
}

function renderInlines(nodes: Inline[]): React.ReactNode {
  return nodes.map((node, index) => renderInline(node, index));
}

function renderInline(node: Inline, key: number): React.ReactNode {
  switch (node.kind) {
    case 'text':
      // A newline inside a paragraph is a line the model wanted on its own
      // line, so it becomes a break rather than a space.
      return (
        <span key={key}>
          {node.text.split('\n').map((line, index) => (
            <span key={index}>
              {index > 0 && <br />}
              {line}
            </span>
          ))}
        </span>
      );
    case 'strong':
      return (
        <strong key={key} className="font-semibold text-ink">
          {renderInlines(node.children)}
        </strong>
      );
    case 'em':
      return <em key={key}>{renderInlines(node.children)}</em>;
    case 'code':
      return (
        <code key={key} className="rounded bg-sunken px-1 py-0.5 font-mono text-[0.85em]">
          {node.text}
        </code>
      );
    case 'link': {
      if (!isSafeHref(node.href)) {
        // Not a link we are willing to make clickable — show the label only.
        return <span key={key}>{renderInlines(node.children)}</span>;
      }
      const external = /^https?:/i.test(node.href.trim());
      return (
        <a
          key={key}
          href={node.href}
          {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
          className="text-brand underline underline-offset-2 hover:opacity-80"
        >
          {renderInlines(node.children)}
        </a>
      );
    }
  }
}

export { parseInline, parseMarkdown };
