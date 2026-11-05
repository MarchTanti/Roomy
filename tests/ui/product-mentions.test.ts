import { describe, expect, it } from 'vitest';

import { findMentionedProducts, nameTerms, type ProductImageRef } from '@/app/chat/product-mentions';

/**
 * Finding the products an answer names.
 *
 * The picture of a recommended piece is attached to the sentence that
 * recommends it, so the matching has to be right in both directions: the
 * named piece must be found, and the piece that merely shares a category word
 * must not be.
 */

function product(overrides: Partial<ProductImageRef> & { id: string }): ProductImageRef {
  return {
    name_th: '',
    name_en: '',
    image_url: `/product-images/${overrides.id}.svg`,
    price_thb: 0,
    ...overrides,
  };
}

const KATJA = product({
  id: 'ikea-sofa-katja-3',
  name_th: 'โซฟาคัทจ้า 3 ที่นั่ง',
  name_en: 'KATJA 3-seat sofa',
});
const LINNES = product({
  id: 'ikea-sofa-liness-3',
  name_th: 'โซฟาลินเนส 3 ที่นั่ง',
  name_en: 'LINNES 3-seat sofa',
});
const LAMP = product({
  id: 'ikea-lamp-nordic-floor',
  name_th: 'โคมตั้งพื้นนอร์ดิก',
  name_en: 'NORDIC floor lamp',
});

describe('nameTerms', () => {
  it('drops the words that only name a category or a size', () => {
    expect(nameTerms('KATJA 3-seat sofa')).toEqual(['KATJA']);
    expect(nameTerms('โซฟาคัทจ้า 3 ที่นั่ง')).toEqual(['โซฟาคัทจ้า']);
  });

  it('drops words too short to mean anything', () => {
    expect(nameTerms('Malm 3')).toEqual(['Malm']);
  });
});

describe('findMentionedProducts', () => {
  it('finds a product the answer names', () => {
    const text = 'ถ้าเป็นห้องนั่งเล่น ผมแนะนำ **KATJA 3-seat sofa** ครับ';
    expect(findMentionedProducts(text, [KATJA, LINNES]).map((p) => p.id)).toEqual([KATJA.id]);
  });

  it('finds a product named in Thai', () => {
    const text = 'ตัวนี้คือ โซฟาคัทจ้า 3 ที่นั่ง ราคาถูกกว่า';
    expect(findMentionedProducts(text, [KATJA, LINNES]).map((p) => p.id)).toEqual([KATJA.id]);
  });

  it('does not attach a picture to a product nobody mentioned', () => {
    const text = 'ผมแนะนำ KATJA 3-seat sofa ครับ';
    expect(findMentionedProducts(text, [LINNES, LAMP])).toEqual([]);
  });

  it('does not match on the category word alone', () => {
    // Both are sofas, so "sofa" on its own must not pick either of them.
    const text = 'อันนี้เป็นโซฟาที่เข้ากับห้อง';
    expect(findMentionedProducts(text, [KATJA, LINNES])).toEqual([]);
  });

  it('finds several products when the answer names several', () => {
    const text = 'เทียบ KATJA กับ NORDIC ให้ดู ต่างกันตรงโทนสี';
    expect(findMentionedProducts(text, [KATJA, LINNES, LAMP]).map((p) => p.id)).toEqual([
      KATJA.id,
      LAMP.id,
    ]);
  });

  it('ignores the case of the English name', () => {
    expect(findMentionedProducts('ชิ้นที่แนะนำคือ katja', [KATJA]).map((p) => p.id)).toEqual([KATJA.id]);
  });

  it('does not guess when one word belongs to several products', () => {
    // Four pieces are called HEMNES in the catalogue. Saying "HEMNES" alone
    // says which of them no, so no picture goes on the page.
    const hemnesSofa = product({ id: 'sofa', name_th: 'โซฟาเฮมเนส 3 ที่นั่ง', name_en: 'HEMNES 3-seat sofa' });
    const hemnesShelf = product({ id: 'shelf', name_th: 'ชั้นวางเฮมเนส', name_en: 'HEMNES shelf unit' });
    const hemnesDesk = product({ id: 'desk', name_th: 'โต๊ะทำงานเฮมเนส', name_en: 'HEMNES desk' });

    expect(findMentionedProducts('ผมแนะนำ HEMNES ครับ', [hemnesSofa, hemnesShelf, hemnesDesk])).toEqual([]);
  });

  it('picks the one product when the whole name is written', () => {
    const hemnesSofa = product({ id: 'sofa', name_th: 'โซฟาเฮมเนส 3 ที่นั่ง', name_en: 'HEMNES 3-seat sofa' });
    const hemnesDesk = product({ id: 'desk', name_th: 'โต๊ะทำงานเฮมเนส', name_en: 'HEMNES desk' });

    const found = findMentionedProducts('ตัวนี้ HEMNES desk ครับ', [hemnesSofa, hemnesDesk]);
    expect(found.map((p) => p.id)).toEqual(['desk']);
  });

  it('returns nothing when there are no products', () => {
    expect(findMentionedProducts('KATJA', [])).toEqual([]);
  });
});
