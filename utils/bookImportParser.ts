import JSZip from 'jszip';
import * as mammoth from 'mammoth';
import * as pdfjsLib from 'pdfjs-dist';
import { Chapter, ReaderContentBlock } from '../types';
import { deleteImageByRef, saveImageBlob } from './imageStorage';
import { reconstructPdfPageWithMath, type PdfTextItem } from './pdfMathReconstruction';

type SupportedImportFormat = 'txt' | 'word' | 'epub' | 'pdf' | 'mobi';

export interface ParsedBookImportResult {
  format: SupportedImportFormat;
  title: string;
  author: string;
  coverUrl: string;
  fullText: string;
  chapters: Chapter[];
  generatedImageRefs: string[];
}

const WORD_SUFFIXES = new Set(['docx', 'docm', 'dotx', 'dotm']);
const EPUB_SUFFIXES = new Set(['epub']);
const PDF_SUFFIXES = new Set(['pdf']);
const MOBI_SUFFIXES = new Set(['mobi']);
const TXT_SUFFIXES = new Set(['txt']);
const SUPPORTED_SUFFIXES = [...TXT_SUFFIXES, ...WORD_SUFFIXES, ...PDF_SUFFIXES, ...EPUB_SUFFIXES, ...MOBI_SUFFIXES];

export const BOOK_IMPORT_ACCEPT = SUPPORTED_SUFFIXES.map((suffix) => `.${suffix}`).join(',');
export const SUPPORTED_BOOK_IMPORT_SUFFIXES = [...SUPPORTED_SUFFIXES];

const UTF8_DECODER = new TextDecoder('utf-8');
const TXT_FALLBACK_ENCODINGS = ['utf-8', 'utf-16le', 'utf-16be', 'gb18030', 'gbk'] as const;
const BLOCK_TAGS = new Set([
  'article',
  'aside',
  'blockquote',
  'dd',
  'div',
  'dl',
  'dt',
  'figcaption',
  'figure',
  'footer',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'li',
  'main',
  'nav',
  'ol',
  'p',
  'pre',
  'section',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'tr',
  'ul',
]);

let pdfWorkerConfigured = false;

interface ImportParseContext {
  generatedImageRefs: string[];
}

interface EpubManifestItem {
  id: string;
  href: string;
  mediaType: string;
  properties: string[];
  fullPath: string;
}

interface EpubTocEntry {
  title: string;
  fullPath: string;
  fragmentId: string;
}

interface EpubTokenizedDocument {
  title: string;
  tokens: HtmlToken[];
  anchorIndexMap: Map<string, number>;
}

interface MobiSpineItem {
  id: string;
  text: string;
}

interface MobiTocItem {
  label: string;
  href: string;
  children?: MobiTocItem[];
}

interface MobiResolvedHref {
  id: string;
  selector: string;
}

interface MobiMetadata {
  title?: string;
  author?: string[] | string;
}

interface MobiProcessedChapter {
  html: string;
}

interface MobiParserInstance {
  getSpine(): MobiSpineItem[];
  getToc(): MobiTocItem[];
  loadChapter(id: string): MobiProcessedChapter | undefined;
  resolveHref(href: string): MobiResolvedHref | undefined;
  getCoverImage(): string;
  getMetadata(): MobiMetadata;
  destroy(): void;
}

interface HtmlTokenText {
  type: 'text';
  text: string;
}

interface HtmlTokenBreak {
  type: 'break';
}

interface HtmlTokenImage {
  type: 'image';
  src: string;
  alt?: string;
  title?: string;
  width?: number;
  height?: number;
}

interface HtmlTokenAnchor {
  type: 'anchor';
  id: string;
}

type HtmlToken = HtmlTokenText | HtmlTokenBreak | HtmlTokenImage | HtmlTokenAnchor;

const trimFileExt = (name: string) => {
  const trimmed = name.trim();
  return trimmed.replace(/\.[^./\\]+$/, '').trim() || 'Untitled';
};

const getFileSuffix = (name: string) => {
  const match = name.toLowerCase().match(/\.([a-z0-9]+)$/);
  return match?.[1] || '';
};

const compactWhitespace = (value: string) => value.replace(/[ \t\u00A0]+/g, ' ').trim();
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const parsePositiveImageDimension = (value: string | null) => {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return undefined;
  if (normalized.includes('%') || normalized.includes('em') || normalized.includes('rem') || normalized === 'auto') {
    return undefined;
  }
  const numeric = Number.parseFloat(normalized.replace(/px$/i, ''));
  if (!Number.isFinite(numeric) || numeric <= 0) return undefined;
  return Math.round(numeric);
};

const parseImageDimensionFromStyle = (styleValue: string | null, kind: 'width' | 'height') => {
  if (!styleValue) return undefined;
  const pattern = kind === 'width' ? /(?:^|;)\s*width\s*:\s*([^;]+)/i : /(?:^|;)\s*height\s*:\s*([^;]+)/i;
  const matched = styleValue.match(pattern);
  return parsePositiveImageDimension(matched?.[1] || null);
};
const LATIN_APOSTROPHE_NORMALIZE_REGEX = /([A-Za-z0-9])[\u2018\u2019\u02BC]([A-Za-z0-9])/g;
const LATIN_OPEN_QUOTE_NORMALIZE_REGEX = /(^|[\s([{<])[\u201C\u201D]([A-Za-z0-9])/g;
const LATIN_CLOSE_QUOTE_NORMALIZE_REGEX = /([A-Za-z0-9])[\u201C\u201D](?=($|[\s)\]}>.,!?;:]))/g;
const LATIN_CLOSE_QUOTE_AFTER_PUNCT_REGEX = /([A-Za-z0-9][A-Za-z0-9'"-]*[.,!?;:])[\u201C\u201D](?=($|[\s)\]}>]))/g;
const LATIN_FULLWIDTH_SPACE_NORMALIZE_REGEX = /([A-Za-z0-9])[\u3000\u00A0]+([A-Za-z0-9])/g;

const normalizeLatinTypographyArtifacts = (raw: string) =>
  raw
    .replace(/\uFF02/g, '"')
    .replace(/\uFF07/g, "'")
    .replace(LATIN_APOSTROPHE_NORMALIZE_REGEX, "$1'$2")
    .replace(LATIN_OPEN_QUOTE_NORMALIZE_REGEX, '$1"$2')
    .replace(LATIN_CLOSE_QUOTE_NORMALIZE_REGEX, '$1"')
    .replace(LATIN_CLOSE_QUOTE_AFTER_PUNCT_REGEX, '$1"')
    .replace(LATIN_FULLWIDTH_SPACE_NORMALIZE_REGEX, '$1 $2');

const normalizeTextBlock = (raw: string) => {
  const normalized = normalizeLatinTypographyArtifacts(raw)
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\u00A0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n');
  return normalized.trim();
};

const extractTextFromHtml = (html: string) => {
  if (!html) return '';
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return normalizeTextBlock(doc.body?.textContent || doc.documentElement?.textContent || '');
};

const decodeTextBuffer = (buffer: ArrayBuffer, encoding: string) => {
  try {
    return new TextDecoder(encoding).decode(buffer);
  } catch {
    return null;
  }
};

const scoreDecodedTextQuality = (text: string) => {
  let replacementCount = 0;
  let nullCount = 0;
  let controlCount = 0;

  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code === 0xfffd) replacementCount += 1;
    if (code === 0x0000) {
      nullCount += 1;
      continue;
    }
    if ((code >= 0x0001 && code <= 0x0008) || (code >= 0x000b && code <= 0x000c) || (code >= 0x000e && code <= 0x001f) || code === 0x007f) {
      controlCount += 1;
    }
  }

  return replacementCount * 1000 + nullCount * 200 + controlCount * 10;
};

const detectBomEncoding = (bytes: Uint8Array) => {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return 'utf-8';
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return 'utf-16le';
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return 'utf-16be';
  }
  return '';
};

const decodeTxtBufferWithFallback = (buffer: ArrayBuffer) => {
  const bytes = new Uint8Array(buffer);
  const bomEncoding = detectBomEncoding(bytes);

  if (bomEncoding) {
    return decodeTextBuffer(buffer, bomEncoding) ?? UTF8_DECODER.decode(buffer);
  }

  let bestText: string | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  const attemptedEncodings = new Set<string>();

  for (const encoding of TXT_FALLBACK_ENCODINGS) {
    if (attemptedEncodings.has(encoding)) continue;
    attemptedEncodings.add(encoding);

    const decoded = decodeTextBuffer(buffer, encoding);
    if (decoded === null) continue;

    const score = scoreDecodedTextQuality(decoded);
    if (score < bestScore) {
      bestScore = score;
      bestText = decoded;
    }
  }

  return bestText ?? UTF8_DECODER.decode(buffer);
};

const mergeAdjacentTextBlocks = (blocks: ReaderContentBlock[]) => {
  const merged: ReaderContentBlock[] = [];
  blocks.forEach((block) => {
    if (block.type !== 'text') {
      merged.push(block);
      return;
    }
    const text = normalizeTextBlock(block.text);
    if (!text) return;
    const last = merged[merged.length - 1];
    if (last && last.type === 'text') {
      last.text = normalizeTextBlock(`${last.text}\n${text}`);
      return;
    }
    merged.push({ type: 'text', text });
  });
  return merged;
};

const buildChapterFromBlocks = (title: string, blocks: ReaderContentBlock[]): Chapter => {
  const normalizedBlocks = mergeAdjacentTextBlocks(blocks);
  const content = normalizeTextBlock(
    normalizedBlocks
      .filter((block): block is Extract<ReaderContentBlock, { type: 'text' }> => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
  );
  return {
    title: compactWhitespace(title) || '全文',
    content,
    ...(normalizedBlocks.length > 0 ? { blocks: normalizedBlocks } : {}),
  };
};

const buildFallbackSingleChapter = (title: string, fullText: string): Chapter[] => [
  {
    title: compactWhitespace(title) || '全文',
    content: fullText,
    blocks: fullText ? [{ type: 'text', text: fullText }] : [],
  },
];

const readXmlDocument = (xmlText: string) => {
  const parser = new DOMParser();
  return parser.parseFromString(xmlText, 'application/xml');
};

const findXmlTextByLocalName = (doc: Document, localName: string) => {
  const nodes = Array.from(doc.getElementsByTagName('*'));
  const matched = nodes.find((node) => {
    if (!node.localName || node.localName.toLowerCase() !== localName.toLowerCase()) return false;
    return Boolean(node.textContent && node.textContent.trim());
  });
  return matched?.textContent?.trim() || '';
};

const findFirstHeadingText = (doc: Document) => {
  const heading = doc.querySelector('h1, h2, h3');
  return compactWhitespace(heading?.textContent || '');
};

const normalizeZipPath = (value: string) => value.replace(/\\/g, '/').replace(/^\//, '').replace(/^\.\//, '');

const resolveZipRelativePath = (baseFilePath: string, targetPath: string) => {
  const sanitizedTarget = targetPath.split('#')[0].split('?')[0].trim();
  if (!sanitizedTarget) return '';
  if (/^[a-z]+:/i.test(sanitizedTarget)) return sanitizedTarget;
  const base = normalizeZipPath(baseFilePath);
  const baseDir = base.includes('/') ? base.slice(0, base.lastIndexOf('/') + 1) : '';
  try {
    const resolved = new URL(sanitizedTarget, `https://reader.local/${baseDir}`).pathname.replace(/^\//, '');
    return normalizeZipPath(decodeURIComponent(resolved));
  } catch {
    return normalizeZipPath(`${baseDir}${sanitizedTarget}`);
  }
};

const isHtmlLikeMediaType = (mediaType: string) => /xhtml|html/i.test(mediaType);

const safeDecodeUriComponent = (value: string) => {
  if (!value) return '';
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

const normalizeAnchorId = (value: string) => safeDecodeUriComponent(value).trim();

const resolveEpubHrefTarget = (baseFilePath: string, href: string) => {
  const trimmedHref = href.trim();
  if (!trimmedHref) return null;
  if (/^[a-z]+:/i.test(trimmedHref)) return null;

  const [pathWithQuery = '', fragmentPart = ''] = trimmedHref.split('#', 2);
  const path = pathWithQuery.split('?')[0].trim();
  const fullPath = path ? resolveZipRelativePath(baseFilePath, path) : normalizeZipPath(baseFilePath);
  if (!fullPath || /^[a-z]+:/i.test(fullPath)) return null;

  return {
    fullPath,
    fragmentId: normalizeAnchorId(fragmentPart),
  };
};

const dedupeEpubTocEntries = (entries: EpubTocEntry[]) => {
  const deduped: EpubTocEntry[] = [];
  const seenTargets = new Set<string>();
  entries.forEach((entry) => {
    const targetKey = `${entry.fullPath}#${entry.fragmentId}`;
    if (seenTargets.has(targetKey)) return;
    seenTargets.add(targetKey);
    deduped.push(entry);
  });
  return deduped;
};

const parseEpubNavTocEntries = async (zip: JSZip, navFilePath: string) => {
  const navEntry = zip.file(navFilePath);
  if (!navEntry) return [] as EpubTocEntry[];

  const navText = await navEntry.async('string');
  const navDoc = new DOMParser().parseFromString(navText, 'text/html');
  const navNodes = Array.from(navDoc.querySelectorAll('nav'));
  const tocNav =
    navNodes.find((node) => {
      const epubType = (node.getAttribute('epub:type') || '').toLowerCase();
      const type = (node.getAttribute('type') || '').toLowerCase();
      const role = (node.getAttribute('role') || '').toLowerCase();
      return epubType.includes('toc') || type.includes('toc') || role.includes('doc-toc');
    }) ||
    navNodes[0] ||
    navDoc.body;

  if (!tocNav) return [] as EpubTocEntry[];

  return Array.from(tocNav.querySelectorAll('a[href]'))
    .map((anchor) => {
      const href = anchor.getAttribute('href') || '';
      const target = resolveEpubHrefTarget(navFilePath, href);
      if (!target) return null;
      const title = compactWhitespace(anchor.textContent || '');
      if (!title) return null;
      return {
        title,
        fullPath: target.fullPath,
        fragmentId: target.fragmentId,
      } satisfies EpubTocEntry;
    })
    .filter((entry): entry is EpubTocEntry => Boolean(entry));
};

const parseEpubNcxTocEntries = async (zip: JSZip, ncxFilePath: string) => {
  const ncxEntry = zip.file(ncxFilePath);
  if (!ncxEntry) return [] as EpubTocEntry[];

  const ncxText = await ncxEntry.async('string');
  const ncxDoc = readXmlDocument(ncxText);
  const navPoints = Array.from(ncxDoc.getElementsByTagName('*')).filter(
    (node) => (node.localName || '').toLowerCase() === 'navpoint'
  );

  return navPoints
    .map((navPoint) => {
      const titleNode = Array.from(navPoint.getElementsByTagName('*')).find(
        (node) => (node.localName || '').toLowerCase() === 'text'
      );
      const contentNode = Array.from(navPoint.getElementsByTagName('*')).find(
        (node) => (node.localName || '').toLowerCase() === 'content'
      );
      const src = contentNode?.getAttribute('src') || '';
      const target = resolveEpubHrefTarget(ncxFilePath, src);
      if (!target) return null;
      const title = compactWhitespace(titleNode?.textContent || '');
      if (!title) return null;
      return {
        title,
        fullPath: target.fullPath,
        fragmentId: target.fragmentId,
      } satisfies EpubTocEntry;
    })
    .filter((entry): entry is EpubTocEntry => Boolean(entry));
};

const loadEpubTocEntries = async (params: {
  zip: JSZip;
  manifest: Map<string, EpubManifestItem>;
  opfDoc: Document;
}) => {
  const { zip, manifest, opfDoc } = params;
  const manifestItems = Array.from(manifest.values());
  const navItem = manifestItems.find((item) => item.properties.includes('nav') && isHtmlLikeMediaType(item.mediaType));

  const spineNode = Array.from(opfDoc.getElementsByTagName('*')).find((node) => node.localName === 'spine');
  const spineTocId = (spineNode?.getAttribute('toc') || '').trim();
  const ncxItem =
    (spineTocId ? manifest.get(spineTocId) : undefined) ||
    manifestItems.find((item) => /application\/x-dtbncx\+xml/i.test(item.mediaType));

  const navEntries = navItem ? await parseEpubNavTocEntries(zip, navItem.fullPath) : [];
  if (navEntries.length > 0) {
    return dedupeEpubTocEntries(navEntries);
  }

  const ncxEntries = ncxItem ? await parseEpubNcxTocEntries(zip, ncxItem.fullPath) : [];
  return dedupeEpubTocEntries(ncxEntries);
};

const collectHtmlTokens = (node: Node, tokens: HtmlToken[]) => {
  if (node.nodeType === Node.TEXT_NODE) {
    const text = (node.textContent || '').replace(/\s+/g, ' ');
    if (text) tokens.push({ type: 'text', text });
    return;
  }

  if (node.nodeType !== Node.ELEMENT_NODE) return;
  const element = node as HTMLElement;
  const tagName = element.tagName.toLowerCase();
  const anchorIds = [element.getAttribute('id'), element.getAttribute('name')]
    .map((value) => (value || '').trim())
    .filter(Boolean);
  if (anchorIds.length > 0) {
    const seen = new Set<string>();
    anchorIds.forEach((anchorId) => {
      if (seen.has(anchorId)) return;
      seen.add(anchorId);
      tokens.push({ type: 'anchor', id: anchorId });
    });
  }

  if (tagName === 'script' || tagName === 'style' || tagName === 'noscript') return;
  if (tagName === 'img' || tagName === 'image') {
    const src =
      element.getAttribute('src') ||
      element.getAttribute('data-src') ||
      element.getAttribute('data-original') ||
      element.getAttribute('href') ||
      element.getAttribute('xlink:href') ||
      '';
    if (src.trim()) {
      const width =
        parsePositiveImageDimension(element.getAttribute('width')) ||
        parseImageDimensionFromStyle(element.getAttribute('style'), 'width');
      const height =
        parsePositiveImageDimension(element.getAttribute('height')) ||
        parseImageDimensionFromStyle(element.getAttribute('style'), 'height');
      tokens.push({
        type: 'image',
        src: src.trim(),
        alt: element.getAttribute('alt') || undefined,
        title: element.getAttribute('title') || undefined,
        ...(width ? { width } : {}),
        ...(height ? { height } : {}),
      });
    }
    return;
  }
  if (tagName === 'br') {
    tokens.push({ type: 'break' });
    return;
  }

  const isBlock = BLOCK_TAGS.has(tagName);
  if (isBlock) tokens.push({ type: 'break' });
  Array.from(element.childNodes).forEach((child) => collectHtmlTokens(child, tokens));
  if (isBlock) tokens.push({ type: 'break' });
};

const isCanvasLike = (value: unknown): value is HTMLCanvasElement =>
  typeof HTMLCanvasElement !== 'undefined' && value instanceof HTMLCanvasElement;

const isImageLike = (value: unknown): value is HTMLImageElement =>
  typeof HTMLImageElement !== 'undefined' && value instanceof HTMLImageElement;

const isImageBitmapLike = (value: unknown): value is ImageBitmap =>
  typeof ImageBitmap !== 'undefined' && value instanceof ImageBitmap;

const canvasToBlob = async (canvas: HTMLCanvasElement, type = 'image/png', quality?: number) => {
  return new Promise<Blob | null>((resolve) => {
    canvas.toBlob((blob) => resolve(blob), type, quality);
  });
};

const collectImageRef = async (blob: Blob, context: ImportParseContext) => {
  const imageRef = await saveImageBlob(blob);
  context.generatedImageRefs.push(imageRef);
  return imageRef;
};

const materializeHtmlTokens = async (
  tokens: HtmlToken[],
  resolveImage: (token: HtmlTokenImage) => Promise<string | null>
) => {
  const blocks: ReaderContentBlock[] = [];
  let textBuffer = '';

  const flushText = () => {
    const text = normalizeTextBlock(textBuffer);
    textBuffer = '';
    if (!text) return;
    blocks.push({ type: 'text', text });
  };

  for (const token of tokens) {
    if (token.type === 'text') {
      textBuffer += token.text;
      continue;
    }
    if (token.type === 'break') {
      textBuffer += '\n';
      continue;
    }
    if (token.type === 'anchor') {
      continue;
    }

    flushText();
    const imageRef = await resolveImage(token);
    if (!imageRef) continue;
    blocks.push({
      type: 'image',
      imageRef,
      alt: token.alt,
      title: token.title,
      ...(typeof token.width === 'number' && token.width > 0 ? { width: token.width } : {}),
      ...(typeof token.height === 'number' && token.height > 0 ? { height: token.height } : {}),
    });
  }

  flushText();
  return mergeAdjacentTextBlocks(blocks);
};

const deleteGeneratedImages = async (imageRefs: string[]) => {
  if (imageRefs.length === 0) return;
  await Promise.all(imageRefs.map((imageRef) => deleteImageByRef(imageRef).catch(() => undefined)));
};

const ensurePdfWorker = () => {
  if (pdfWorkerConfigured) return;
  (pdfjsLib as unknown as { GlobalWorkerOptions: { workerSrc: string } }).GlobalWorkerOptions.workerSrc = new URL(
    'pdfjs-dist/build/pdf.worker.min.mjs',
    import.meta.url
  ).toString();
  pdfWorkerConfigured = true;
};

const parseTxtFile = async (file: File) => {
  const buffer = await file.arrayBuffer();
  const fullText = normalizeTextBlock(decodeTxtBufferWithFallback(buffer));
  const title = trimFileExt(file.name);
  return {
    format: 'txt' as const,
    title,
    author: '佚名',
    coverUrl: '',
    fullText,
    chapters: buildFallbackSingleChapter('全文', fullText),
  };
};

const parseWordMetadata = async (zip: JSZip) => {
  const coreEntry = zip.file('docProps/core.xml');
  if (!coreEntry) {
    return { title: '', author: '' };
  }
  const xml = await coreEntry.async('string');
  const doc = readXmlDocument(xml);
  return {
    title: findXmlTextByLocalName(doc, 'title'),
    author: findXmlTextByLocalName(doc, 'creator'),
  };
};

const resolveDataImageToken = async (token: HtmlTokenImage, context: ImportParseContext) => {
  const src = token.src.trim();
  if (!src || !src.startsWith('data:image/')) return null;
  const response = await fetch(src);
  if (!response.ok) return null;
  const blob = await response.blob();
  return collectImageRef(blob, context);
};

const parseWordFile = async (file: File, context: ImportParseContext) => {
  const arrayBuffer = await file.arrayBuffer();
  const zip = await JSZip.loadAsync(arrayBuffer);
  const metadata = await parseWordMetadata(zip);
  const thumbnailEntry =
    zip.file(/^docProps\/thumbnail\.(png|jpe?g|webp|bmp)$/i)?.[0] ||
    zip.file(/^docProps\/thumb\.(png|jpe?g|webp|bmp)$/i)?.[0];
  let coverUrl = '';
  if (thumbnailEntry) {
    const blob = await thumbnailEntry.async('blob');
    coverUrl = await collectImageRef(blob, context);
  }

  const htmlResult = await mammoth.convertToHtml({ arrayBuffer });
  const htmlDoc = new DOMParser().parseFromString(htmlResult.value || '', 'text/html');
  const rawTextResult = await mammoth.extractRawText({ arrayBuffer });
  const fallbackText = normalizeTextBlock(rawTextResult.value || '');

  const chapters: Chapter[] = [];
  let chapterTitle = '';
  let chapterIndex = 1;
  let chapterTokens: HtmlToken[] = [];

  const flushChapter = async () => {
    const blocks = await materializeHtmlTokens(chapterTokens, (token) => resolveDataImageToken(token, context));
    chapterTokens = [];
    if (blocks.length === 0) return;
    const chapter = buildChapterFromBlocks(chapterTitle || `第 ${chapterIndex} 章`, blocks);
    if (!chapter.content && (!chapter.blocks || chapter.blocks.length === 0)) return;
    chapters.push(chapter);
    chapterIndex += 1;
  };

  for (const node of Array.from(htmlDoc.body.childNodes)) {
    if (node.nodeType === Node.ELEMENT_NODE) {
      const tagName = (node as HTMLElement).tagName.toLowerCase();
      if (/^h[1-6]$/.test(tagName)) {
        await flushChapter();
        chapterTitle = compactWhitespace(node.textContent || '') || `第 ${chapterIndex} 章`;
        continue;
      }
    }
    collectHtmlTokens(node, chapterTokens);
  }

  await flushChapter();

  const fullText = normalizeTextBlock(
    chapters.length > 0
      ? chapters.map((chapter) => chapter.content).filter(Boolean).join('\n\n')
      : fallbackText
  );

  const resolvedTitle = metadata.title || findFirstHeadingText(htmlDoc) || trimFileExt(file.name);
  const resolvedAuthor = metadata.author || '佚名';
  return {
    format: 'word' as const,
    title: compactWhitespace(resolvedTitle) || trimFileExt(file.name),
    author: compactWhitespace(resolvedAuthor) || '佚名',
    coverUrl,
    fullText,
    chapters: chapters.length > 0 ? chapters : buildFallbackSingleChapter('全文', fullText),
  };
};

const getEpubPackagePath = async (zip: JSZip) => {
  const containerEntry = zip.file('META-INF/container.xml');
  if (!containerEntry) return '';
  const containerText = await containerEntry.async('string');
  const containerDoc = readXmlDocument(containerText);
  const rootfile = Array.from(containerDoc.getElementsByTagName('*')).find((node) => node.localName === 'rootfile');
  const fullPath = rootfile?.getAttribute('full-path') || '';
  return normalizeZipPath(fullPath);
};

const parseEpubFile = async (file: File, context: ImportParseContext) => {
  const arrayBuffer = await file.arrayBuffer();
  const zip = await JSZip.loadAsync(arrayBuffer);
  const packagePath = await getEpubPackagePath(zip);
  if (!packagePath) {
    throw new Error('EPUB package metadata not found.');
  }
  const opfEntry = zip.file(packagePath);
  if (!opfEntry) {
    throw new Error('EPUB package file is missing.');
  }

  const opfText = await opfEntry.async('string');
  const opfDoc = readXmlDocument(opfText);
  const opfDir = packagePath.includes('/') ? packagePath.slice(0, packagePath.lastIndexOf('/') + 1) : '';

  const manifest = new Map<string, EpubManifestItem>();

  Array.from(opfDoc.getElementsByTagName('*'))
    .filter((node) => node.localName === 'item')
    .forEach((node) => {
      const id = node.getAttribute('id') || '';
      const href = node.getAttribute('href') || '';
      const mediaType = node.getAttribute('media-type') || '';
      const properties = (node.getAttribute('properties') || '')
        .split(/\s+/)
        .map((item) => item.trim())
        .filter(Boolean);
      if (!id || !href) return;
      manifest.set(id, {
        id,
        href,
        mediaType,
        properties,
        fullPath: normalizeZipPath(resolveZipRelativePath(`${opfDir}index.opf`, href)),
      });
    });

  const coverIdFromMeta = Array.from(opfDoc.getElementsByTagName('*'))
    .filter((node) => node.localName === 'meta')
    .find((node) => (node.getAttribute('name') || '').toLowerCase() === 'cover')
    ?.getAttribute('content') || '';
  const coverItem =
    Array.from(manifest.values()).find((item) => item.properties.includes('cover-image')) ||
    (coverIdFromMeta ? manifest.get(coverIdFromMeta) : undefined);
  let coverUrl = '';
  if (coverItem) {
    const coverEntry = zip.file(coverItem.fullPath);
    if (coverEntry) {
      const blob = await coverEntry.async('blob');
      coverUrl = await collectImageRef(blob, context);
    }
  }

  const spineIds = Array.from(opfDoc.getElementsByTagName('*'))
    .filter((node) => node.localName === 'itemref')
    .map((node) => (node.getAttribute('idref') || '').trim())
    .filter(Boolean);

  const resolveEpubImageToken = async (token: HtmlTokenImage, baseFilePath: string) => {
    const src = token.src.trim();
    if (!src) return null;
    if (src.startsWith('data:image/')) {
      const response = await fetch(src);
      if (!response.ok) return null;
      const blob = await response.blob();
      return collectImageRef(blob, context);
    }
    if (/^[a-z]+:/i.test(src)) return null;
    const resolvedPath = resolveZipRelativePath(baseFilePath, src);
    const imageEntry = zip.file(resolvedPath);
    if (!imageEntry) return null;
    const blob = await imageEntry.async('blob');
    return collectImageRef(blob, context);
  };

  const tocEntries = await loadEpubTocEntries({ zip, manifest, opfDoc });
  const spineManifestItems = spineIds
    .map((id) => manifest.get(id))
    .filter((item): item is EpubManifestItem => Boolean(item) && isHtmlLikeMediaType(item.mediaType));
  const spineManifestByPath = new Map<string, EpubManifestItem>();
  spineManifestItems.forEach((item) => {
    if (!spineManifestByPath.has(item.fullPath)) {
      spineManifestByPath.set(item.fullPath, item);
    }
  });

  const tocEntriesInSpine = tocEntries.filter((entry) => spineManifestByPath.has(entry.fullPath));
  const spineIndexByPath = new Map<string, number>();
  spineManifestItems.forEach((item, index) => {
    if (!spineIndexByPath.has(item.fullPath)) {
      spineIndexByPath.set(item.fullPath, index);
    }
  });
  const tokenizedDocumentCache = new Map<string, EpubTokenizedDocument | null>();
  const getTokenizedDocument = async (manifestItem: EpubManifestItem) => {
    if (tokenizedDocumentCache.has(manifestItem.fullPath)) {
      return tokenizedDocumentCache.get(manifestItem.fullPath) || null;
    }

    const chapterEntry = zip.file(manifestItem.fullPath);
    if (!chapterEntry) {
      tokenizedDocumentCache.set(manifestItem.fullPath, null);
      return null;
    }

    const htmlText = await chapterEntry.async('string');
    const doc = new DOMParser().parseFromString(htmlText, 'text/html');
    const tokens: HtmlToken[] = [];
    Array.from(doc.body.childNodes).forEach((node) => collectHtmlTokens(node, tokens));
    const anchorIndexMap = new Map<string, number>();
    tokens.forEach((token, tokenIndex) => {
      if (token.type !== 'anchor') return;
      const anchorId = normalizeAnchorId(token.id);
      if (!anchorId || anchorIndexMap.has(anchorId)) return;
      anchorIndexMap.set(anchorId, tokenIndex);
    });
    const tokenized: EpubTokenizedDocument = {
      title: findFirstHeadingText(doc) || compactWhitespace(doc.querySelector('title')?.textContent || ''),
      tokens,
      anchorIndexMap,
    };
    tokenizedDocumentCache.set(manifestItem.fullPath, tokenized);
    return tokenized;
  };

  const chapters: Chapter[] = [];

  if (tocEntriesInSpine.length > 0) {
    for (let index = 0; index < tocEntriesInSpine.length; index += 1) {
      const tocEntry = tocEntriesInSpine[index];
      const startSpineIndex = spineIndexByPath.get(tocEntry.fullPath);
      if (typeof startSpineIndex !== 'number') continue;

      const startManifestItem = spineManifestItems[startSpineIndex];
      if (!startManifestItem) continue;
      const startDoc = await getTokenizedDocument(startManifestItem);
      if (!startDoc) continue;

      let startTokenIndex = 0;
      if (tocEntry.fragmentId) {
        const mappedStart = startDoc.anchorIndexMap.get(tocEntry.fragmentId);
        if (typeof mappedStart === 'number') {
          startTokenIndex = mappedStart;
        }
      }

      const nextTocEntry = tocEntriesInSpine[index + 1];
      let endSpineIndex = spineManifestItems.length;
      let endTokenIndex = 0;

      if (nextTocEntry) {
        const mappedEndSpineIndex = spineIndexByPath.get(nextTocEntry.fullPath);
        if (typeof mappedEndSpineIndex === 'number') {
          if (mappedEndSpineIndex < startSpineIndex) continue;
          endSpineIndex = mappedEndSpineIndex;

          if (nextTocEntry.fragmentId) {
            const endManifestItem = spineManifestItems[mappedEndSpineIndex];
            const endDoc = endManifestItem ? await getTokenizedDocument(endManifestItem) : null;
            const mappedEnd = endDoc?.anchorIndexMap.get(nextTocEntry.fragmentId);
            if (typeof mappedEnd === 'number' && mappedEnd >= 0) {
              endTokenIndex = mappedEnd;
            }
          }
        }
      }

      const blocks: ReaderContentBlock[] = [];
      if (endSpineIndex === startSpineIndex) {
        const sameFileEnd = endTokenIndex > startTokenIndex ? endTokenIndex : startDoc.tokens.length;
        if (sameFileEnd > startTokenIndex) {
          const chapterTokens = startDoc.tokens.slice(startTokenIndex, sameFileEnd);
          const chapterBlocks = await materializeHtmlTokens(chapterTokens, (token) =>
            resolveEpubImageToken(token, startManifestItem.fullPath)
          );
          if (chapterBlocks.length > 0) {
            blocks.push(...chapterBlocks);
          }
        }
      } else {
        const shouldIncludeEndPartial = endSpineIndex < spineManifestItems.length && endTokenIndex > 0;
        const finalSpineIndex = shouldIncludeEndPartial ? endSpineIndex : Math.min(endSpineIndex, spineManifestItems.length) - 1;

        for (let spineIndex = startSpineIndex; spineIndex <= finalSpineIndex; spineIndex += 1) {
          const manifestItem = spineManifestItems[spineIndex];
          if (!manifestItem) continue;
          const tokenized = spineIndex === startSpineIndex ? startDoc : await getTokenizedDocument(manifestItem);
          if (!tokenized) continue;

          const segmentStart = spineIndex === startSpineIndex ? startTokenIndex : 0;
          const segmentEnd =
            spineIndex === endSpineIndex && shouldIncludeEndPartial
              ? clamp(endTokenIndex, 0, tokenized.tokens.length)
              : tokenized.tokens.length;
          if (segmentEnd <= segmentStart) continue;

          const segmentTokens = tokenized.tokens.slice(segmentStart, segmentEnd);
          if (segmentTokens.length === 0) continue;
          const segmentBlocks = await materializeHtmlTokens(segmentTokens, (token) =>
            resolveEpubImageToken(token, manifestItem.fullPath)
          );
          if (segmentBlocks.length > 0) {
            blocks.push(...segmentBlocks);
          }
        }
      }

      if (blocks.length === 0) continue;
      const chapterTitle = tocEntry.title || startDoc.title || `Chapter ${chapters.length + 1}`;
      const chapter = buildChapterFromBlocks(chapterTitle, blocks);
      if (!chapter.content && (!chapter.blocks || chapter.blocks.length === 0)) continue;
      chapters.push(chapter);
    }
  }

  if (chapters.length === 0) {
    for (let index = 0; index < spineManifestItems.length; index += 1) {
      const manifestItem = spineManifestItems[index];
      const tokenized = await getTokenizedDocument(manifestItem);
      if (!tokenized) continue;
      const blocks = await materializeHtmlTokens(tokenized.tokens, (token) =>
        resolveEpubImageToken(token, manifestItem.fullPath)
      );
      const chapterTitle = tokenized.title || `Chapter ${index + 1}`;
      const chapter = buildChapterFromBlocks(chapterTitle, blocks);
      if (!chapter.content && (!chapter.blocks || chapter.blocks.length === 0)) continue;
      chapters.push(chapter);
    }
  }

  const fullText = normalizeTextBlock(chapters.map((chapter) => chapter.content).filter(Boolean).join('\n\n'));
  const title = findXmlTextByLocalName(opfDoc, 'title') || trimFileExt(file.name);
  const author = findXmlTextByLocalName(opfDoc, 'creator') || '作者名';
  return {
    format: 'epub' as const,
    title: compactWhitespace(title) || trimFileExt(file.name),
    author: compactWhitespace(author) || '作者名',
    coverUrl,
    fullText,
    chapters: chapters.length > 0 ? chapters : buildFallbackSingleChapter('全文', fullText),
  };
};

const flattenMobiTocItems = (items: MobiTocItem[]) => {
  const flattened: MobiTocItem[] = [];
  const queue = [...items];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) continue;
    flattened.push(current);
    if (Array.isArray(current.children) && current.children.length > 0) {
      queue.push(...current.children);
    }
  }
  return flattened;
};

const resolveBlobOrDataImageToken = async (token: HtmlTokenImage, context: ImportParseContext) => {
  const src = token.src.trim();
  if (!src) return null;
  if (/^https?:/i.test(src)) return null;
  const response = await fetch(src).catch(() => null);
  if (!response || !response.ok) return null;
  const blob = await response.blob();
  if (!blob || blob.size <= 0) return null;
  return collectImageRef(blob, context);
};

const MOBI_MAX_UINT32 = 0xffffffff;

const readMobiAscii = (bytes: Uint8Array, offset: number, length: number) => {
  if (offset < 0 || length <= 0 || offset + length > bytes.length) return '';
  let result = '';
  for (let index = offset; index < offset + length; index += 1) {
    result += String.fromCharCode(bytes[index]);
  }
  return result;
};

const detectImageMimeTypeFromBytes = (bytes: Uint8Array) => {
  if (bytes.length < 4) return '';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return 'image/png';
  }
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return 'image/gif';
  if (bytes[0] === 0x42 && bytes[1] === 0x4d) return 'image/bmp';
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'image/webp';
  }
  return '';
};

const extractMobiCoverBlobFromRawFile = async (file: File): Promise<Blob | null> => {
  const arrayBuffer = await file.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);
  const view = new DataView(arrayBuffer);
  if (bytes.length < 86) return null;

  const numRecords = view.getUint16(76, false);
  if (!numRecords) return null;

  const recordOffsets: number[] = [];
  for (let index = 0; index < numRecords; index += 1) {
    const offset = 78 + index * 8;
    if (offset + 4 > bytes.length) break;
    recordOffsets.push(view.getUint32(offset, false));
  }
  if (recordOffsets.length < 2) return null;

  const firstRecordStart = recordOffsets[0];
  const firstRecordEnd = recordOffsets[1];
  if (firstRecordStart < 0 || firstRecordEnd <= firstRecordStart || firstRecordEnd > bytes.length) return null;

  const firstRecord = bytes.subarray(firstRecordStart, firstRecordEnd);
  if (readMobiAscii(firstRecord, 16, 4) !== 'MOBI') return null;

  const readFirstRecordUint32 = (offset: number) => {
    if (offset + 4 > firstRecord.length) return MOBI_MAX_UINT32;
    return (
      (firstRecord[offset] << 24) |
      (firstRecord[offset + 1] << 16) |
      (firstRecord[offset + 2] << 8) |
      firstRecord[offset + 3]
    ) >>> 0;
  };

  const resourceStart = readFirstRecordUint32(108);
  if (resourceStart === MOBI_MAX_UINT32 || resourceStart >= recordOffsets.length) return null;

  const mobiHeaderLength = readFirstRecordUint32(20);
  const exthFlag = readFirstRecordUint32(128);
  let coverOffset = MOBI_MAX_UINT32;
  let thumbnailOffset = MOBI_MAX_UINT32;

  if ((exthFlag & 64) !== 0) {
    const exthStart = 16 + mobiHeaderLength;
    if (exthStart + 12 <= firstRecord.length && readMobiAscii(firstRecord, exthStart, 4) === 'EXTH') {
      const exthLength =
        ((firstRecord[exthStart + 4] << 24) |
          (firstRecord[exthStart + 5] << 16) |
          (firstRecord[exthStart + 6] << 8) |
          firstRecord[exthStart + 7]) >>> 0;
      const exthCount =
        ((firstRecord[exthStart + 8] << 24) |
          (firstRecord[exthStart + 9] << 16) |
          (firstRecord[exthStart + 10] << 8) |
          firstRecord[exthStart + 11]) >>> 0;

      let cursor = exthStart + 12;
      const exthEnd = Math.min(firstRecord.length, exthStart + exthLength);
      for (let index = 0; index < exthCount && cursor + 8 <= exthEnd; index += 1) {
        const recordType =
          ((firstRecord[cursor] << 24) |
            (firstRecord[cursor + 1] << 16) |
            (firstRecord[cursor + 2] << 8) |
            firstRecord[cursor + 3]) >>> 0;
        const recordLength =
          ((firstRecord[cursor + 4] << 24) |
            (firstRecord[cursor + 5] << 16) |
            (firstRecord[cursor + 6] << 8) |
            firstRecord[cursor + 7]) >>> 0;
        if (recordLength < 8) break;

        if ((recordType === 201 || recordType === 202) && cursor + 12 <= exthEnd) {
          const value =
            ((firstRecord[cursor + 8] << 24) |
              (firstRecord[cursor + 9] << 16) |
              (firstRecord[cursor + 10] << 8) |
              firstRecord[cursor + 11]) >>> 0;
          if (recordType === 201) coverOffset = value;
          if (recordType === 202) thumbnailOffset = value;
        }

        cursor += recordLength;
      }
    }
  }

  const candidateResourceOffsets: number[] = [];
  const pushCandidateOffset = (offset: number) => {
    if (!Number.isFinite(offset) || offset < 0 || offset === MOBI_MAX_UINT32) return;
    if (candidateResourceOffsets.includes(offset)) return;
    candidateResourceOffsets.push(offset);
  };
  pushCandidateOffset(coverOffset);
  pushCandidateOffset(thumbnailOffset);
  for (let index = 0; index < 24; index += 1) {
    pushCandidateOffset(index);
  }

  const getRecordSlice = (recordIndex: number) => {
    if (recordIndex < 0 || recordIndex >= recordOffsets.length) return null;
    const start = recordOffsets[recordIndex];
    const end = recordIndex + 1 < recordOffsets.length ? recordOffsets[recordIndex + 1] : bytes.length;
    if (start < 0 || end <= start || end > bytes.length) return null;
    return bytes.subarray(start, end);
  };

  for (const resourceOffset of candidateResourceOffsets) {
    const recordIndex = resourceStart + resourceOffset;
    const recordData = getRecordSlice(recordIndex);
    if (!recordData || recordData.length < 4) continue;

    const mimeType = detectImageMimeTypeFromBytes(recordData);
    if (!mimeType) continue;
    return new Blob([recordData], { type: mimeType });
  }

  return null;
};

const MOBI_DEFAULT_CHAPTER_TITLE_REGEX = /^chapter\s+\d+$/i;
const MOBI_TOC_HEADER_REGEX = /^(table\s+of\s+contents|contents|目录|目\s*录)$/i;
const MOBI_TOC_CONTENT_REGEX = /table\s+of\s+contents|目\s*录|目录/i;

const stripMobiTrailingPageNumber = (line: string) => line.replace(/\s*[·•\-–—]?\s*\d{1,5}\s*$/, '').trim();

const isMobiPlaceholderTitle = (title: string) => {
  const normalized = compactWhitespace(title || '');
  return !normalized || MOBI_DEFAULT_CHAPTER_TITLE_REGEX.test(normalized) || MOBI_TOC_HEADER_REGEX.test(normalized);
};

const inferMobiChapterTitleFromContent = (content: string) => {
  const lines = normalizeTextBlock(content)
    .split('\n')
    .map((line) => stripMobiTrailingPageNumber(compactWhitespace(line)))
    .filter(Boolean);

  for (const line of lines) {
    const normalized = line.replace(/^chapter\s+\d+\s*[:：.\-]?\s*/i, '').trim();
    if (!normalized) continue;
    if (/^\d+$/.test(normalized)) continue;
    if (MOBI_TOC_CONTENT_REGEX.test(normalized)) continue;
    if (normalized.length > 36) continue;
    return normalized;
  }

  return '';
};

const extractMobiTocTitlesFromContent = (content: string) => {
  const normalizedContent = normalizeTextBlock(content);
  if (!normalizedContent) return [] as string[];

  const lines = normalizedContent
    .split('\n')
    .map((line) => compactWhitespace(line))
    .filter(Boolean);

  const titles: string[] = [];
  let sawTocHeader = false;
  lines.forEach((rawLine) => {
    const noPageLine = stripMobiTrailingPageNumber(rawLine);
    if (!noPageLine) return;

    if (MOBI_TOC_CONTENT_REGEX.test(noPageLine)) {
      sawTocHeader = true;
      return;
    }
    if (!sawTocHeader) return;

    const normalized = noPageLine.replace(/^chapter\s+\d+\s*[:：.\-]?\s*/i, '').trim();
    if (!normalized) return;
    if (/^\d+$/.test(normalized)) return;
    if (/^[-=._\s]+$/.test(normalized)) return;
    if (normalized.length > 42) return;
    if (MOBI_TOC_CONTENT_REGEX.test(normalized)) return;
    if (titles.includes(normalized)) return;
    titles.push(normalized);
  });

  return titles;
};

const looksLikeMobiTocChapter = (chapter: Chapter, tocTitles: string[]) => {
  if (tocTitles.length < 5) return false;
  const lines = normalizeTextBlock(chapter.content)
    .split('\n')
    .map((line) => compactWhitespace(line))
    .filter(Boolean);
  if (lines.length < 8) return false;
  const shortLineCount = lines.filter((line) => stripMobiTrailingPageNumber(line).length <= 24).length;
  return shortLineCount / lines.length >= 0.6;
};

const findFirstImageRefInChapters = (chapters: Chapter[]) => {
  for (const chapter of chapters) {
    const blocks = chapter.blocks || [];
    for (const block of blocks) {
      if (block.type !== 'image') continue;
      if (block.imageRef) return block.imageRef;
    }
  }
  return '';
};

const postProcessMobiChapters = (chapters: Chapter[]) => {
  const normalizedChapters = chapters.map((chapter) => ({ ...chapter }));

  normalizedChapters.forEach((chapter) => {
    if (!isMobiPlaceholderTitle(chapter.title)) return;
    const inferredTitle = inferMobiChapterTitleFromContent(chapter.content || '');
    if (inferredTitle) {
      chapter.title = inferredTitle;
    }
  });

  const tocIndex = normalizedChapters.findIndex((chapter) => {
    if (!MOBI_TOC_CONTENT_REGEX.test(chapter.content || '')) return false;
    return extractMobiTocTitlesFromContent(chapter.content || '').length >= 3;
  });

  if (tocIndex < 0) return normalizedChapters;

  const tocChapter = normalizedChapters[tocIndex];
  const tocTitles = extractMobiTocTitlesFromContent(tocChapter.content || '');
  if (tocTitles.length > 0) {
    const targetIndexes = normalizedChapters
      .map((chapter, index) => ({ chapter, index }))
      .filter(({ index }) => index !== tocIndex)
      .filter(({ chapter }) => isMobiPlaceholderTitle(chapter.title))
      .map(({ index }) => index);

    const assignCount = Math.min(targetIndexes.length, tocTitles.length);
    for (let index = 0; index < assignCount; index += 1) {
      normalizedChapters[targetIndexes[index]].title = tocTitles[index];
    }
  }

  if (isMobiPlaceholderTitle(tocChapter.title)) {
    tocChapter.title = '目录';
  }

  if (looksLikeMobiTocChapter(tocChapter, tocTitles)) {
    normalizedChapters.splice(tocIndex, 1);
  }

  return normalizedChapters;
};

const parseMobiFile = async (file: File, context: ImportParseContext) => {
  const mobiModule = await import('@lingo-reader/mobi-parser');
  const mobi = (await mobiModule.initMobiFile(file)) as MobiParserInstance;

  try {
    const metadata = mobi.getMetadata();
    const metadataTitle = compactWhitespace(typeof metadata?.title === 'string' ? metadata.title : '');
    const metadataAuthor = Array.isArray(metadata?.author)
      ? metadata.author.map((authorName) => compactWhitespace(authorName || '')).filter(Boolean).join(' / ')
      : compactWhitespace(typeof metadata?.author === 'string' ? metadata.author : '');

    let coverUrl = '';
    const coverImageSource = mobi.getCoverImage();
    if (coverImageSource && !/^https?:/i.test(coverImageSource)) {
      const coverResponse = await fetch(coverImageSource).catch(() => null);
      if (coverResponse?.ok) {
        const coverBlob = await coverResponse.blob();
        if (coverBlob && coverBlob.size > 0) {
          coverUrl = await collectImageRef(coverBlob, context);
        }
      }
    }
    if (!coverUrl) {
      const rawCoverBlob = await extractMobiCoverBlobFromRawFile(file).catch(() => null);
      if (rawCoverBlob && rawCoverBlob.size > 0) {
        coverUrl = await collectImageRef(rawCoverBlob, context);
      }
    }

    const titleByChapterId = new Map<string, string>();
    const rawTocItems = mobi.getToc();
    const tocItems = Array.isArray(rawTocItems) ? rawTocItems : [];
    flattenMobiTocItems(tocItems).forEach((item) => {
      const label = compactWhitespace(item.label || '');
      if (!label || !item.href) return;
      const resolved = mobi.resolveHref(item.href);
      if (!resolved?.id || titleByChapterId.has(resolved.id)) return;
      titleByChapterId.set(resolved.id, label);
    });

    const rawSpineItems = mobi.getSpine();
    const spineItems = Array.isArray(rawSpineItems) ? rawSpineItems : [];
    const chapters: Chapter[] = [];

    for (let index = 0; index < spineItems.length; index += 1) {
      const spineItem = spineItems[index];
      if (!spineItem?.id) continue;

      const loadedChapter = mobi.loadChapter(spineItem.id);
      const chapterHtml = loadedChapter?.html || spineItem.text || '';
      if (!chapterHtml.trim()) continue;

      const chapterDoc = new DOMParser().parseFromString(chapterHtml, 'text/html');
      const chapterTokens: HtmlToken[] = [];
      const nodes = chapterDoc.body ? Array.from(chapterDoc.body.childNodes) : Array.from(chapterDoc.childNodes);
      nodes.forEach((node) => collectHtmlTokens(node, chapterTokens));

      const chapterBlocks = await materializeHtmlTokens(chapterTokens, (token) => resolveBlobOrDataImageToken(token, context));
      const fallbackChapterText = normalizeTextBlock(
        chapterDoc.body?.textContent || chapterDoc.documentElement?.textContent || ''
      );
      const chapterTitle =
        titleByChapterId.get(spineItem.id) ||
        findFirstHeadingText(chapterDoc) ||
        compactWhitespace(chapterDoc.querySelector('title')?.textContent || '') ||
        `Chapter ${chapters.length + 1}`;

      const chapter =
        chapterBlocks.length > 0
          ? buildChapterFromBlocks(chapterTitle, chapterBlocks)
          : buildChapterFromBlocks(
              chapterTitle,
              fallbackChapterText ? [{ type: 'text', text: fallbackChapterText }] : []
            );
      if (!chapter.content && (!chapter.blocks || chapter.blocks.length === 0)) continue;
      chapters.push(chapter);
    }

    const fallbackFullText = normalizeTextBlock(
      spineItems
        .map((spineItem) => extractTextFromHtml(spineItem.text || ''))
        .filter(Boolean)
        .join('\n\n')
    );
    const normalizedChapters = postProcessMobiChapters(chapters);
    if (!coverUrl) {
      const fallbackCoverRef = findFirstImageRefInChapters(normalizedChapters);
      if (fallbackCoverRef) {
        coverUrl = fallbackCoverRef;
      }
    }

    const chapterText = normalizeTextBlock(normalizedChapters.map((chapter) => chapter.content).filter(Boolean).join('\n\n'));
    const fullText = chapterText || fallbackFullText;

    return {
      format: 'mobi' as const,
      title: metadataTitle || trimFileExt(file.name),
      author: metadataAuthor || '佚名',
      coverUrl,
      fullText,
      chapters: normalizedChapters.length > 0 ? normalizedChapters : buildFallbackSingleChapter('全文', fullText),
    };
  } finally {
    mobi.destroy();
  }
};

const renderPdfPageToBlob = async (page: any, maxWidth: number) => {
  const viewport = page.getViewport({ scale: 1 });
  const safeMaxWidth = Math.max(80, Math.round(maxWidth));
  const scale = Math.min(1, safeMaxWidth / Math.max(viewport.width || 1, 1));
  const drawViewport = page.getViewport({ scale: Math.max(scale, 0.25) });
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.floor(drawViewport.width));
  canvas.height = Math.max(1, Math.floor(drawViewport.height));
  const context = canvas.getContext('2d', { alpha: false });
  if (!context) return null;
  await page.render({ canvasContext: context, viewport: drawViewport }).promise;
  return canvasToBlob(canvas, 'image/jpeg', 0.82);
};

const resolvePdfRgbaImageBlob = async (source: { width: number; height: number; data: Uint8ClampedArray }) => {
  if (!source.width || !source.height || !source.data) return null;
  const canvas = document.createElement('canvas');
  canvas.width = source.width;
  canvas.height = source.height;
  const context = canvas.getContext('2d');
  if (!context) return null;
  const imageData = context.createImageData(source.width, source.height);
  imageData.data.set(source.data);
  context.putImageData(imageData, 0, 0);
  return canvasToBlob(canvas, 'image/png');
};

const resolvePdfDrawableImageBlob = async (source: HTMLImageElement | ImageBitmap | HTMLCanvasElement) => {
  const width = isCanvasLike(source)
    ? source.width
    : isImageLike(source)
    ? source.naturalWidth || source.width
    : source.width;
  const height = isCanvasLike(source)
    ? source.height
    : isImageLike(source)
    ? source.naturalHeight || source.height
    : source.height;
  if (!width || !height) return null;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) return null;
  context.drawImage(source as CanvasImageSource, 0, 0, width, height);
  return canvasToBlob(canvas, 'image/png');
};

const resolvePdfImageObjectBlob = async (source: any): Promise<Blob | null> => {
  if (!source) return null;
  if (
    typeof source.width === 'number' &&
    typeof source.height === 'number' &&
    source.data instanceof Uint8ClampedArray
  ) {
    return resolvePdfRgbaImageBlob(source);
  }
  if (source.bitmap && (isImageBitmapLike(source.bitmap) || isCanvasLike(source.bitmap))) {
    return resolvePdfDrawableImageBlob(source.bitmap);
  }
  if (isCanvasLike(source) || isImageLike(source) || isImageBitmapLike(source)) {
    return resolvePdfDrawableImageBlob(source);
  }
  return null;
};

const resolvePdfImageObjectSize = (source: any): { width: number; height: number } | null => {
  if (!source) return null;
  if (
    typeof source.width === 'number' &&
    typeof source.height === 'number' &&
    source.width > 0 &&
    source.height > 0
  ) {
    return { width: Math.round(source.width), height: Math.round(source.height) };
  }
  const drawable =
    source.bitmap && (isImageBitmapLike(source.bitmap) || isCanvasLike(source.bitmap))
      ? source.bitmap
      : source;
  if (isCanvasLike(drawable)) {
    if (drawable.width > 0 && drawable.height > 0) {
      return { width: Math.round(drawable.width), height: Math.round(drawable.height) };
    }
    return null;
  }
  if (isImageLike(drawable)) {
    const width = drawable.naturalWidth || drawable.width;
    const height = drawable.naturalHeight || drawable.height;
    if (width > 0 && height > 0) {
      return { width: Math.round(width), height: Math.round(height) };
    }
    return null;
  }
  if (isImageBitmapLike(drawable)) {
    if (drawable.width > 0 && drawable.height > 0) {
      return { width: Math.round(drawable.width), height: Math.round(drawable.height) };
    }
    return null;
  }
  return null;
};

const extractPdfPageImageRefs = async (
  page: any,
  context: ImportParseContext
): Promise<Array<{ imageRef: string; width?: number; height?: number }>> => {
  const imageRefs: Array<{ imageRef: string; width?: number; height?: number }> = [];
  const operatorList = await page.getOperatorList().catch(() => null);
  const OPS = (pdfjsLib as any).OPS || {};
  if (!operatorList || !Array.isArray(operatorList.fnArray) || !Array.isArray(operatorList.argsArray)) {
    return imageRefs;
  }

  const seenObjectNames = new Set<string>();
  for (let index = 0; index < operatorList.fnArray.length; index += 1) {
    const fn = operatorList.fnArray[index];
    const args = operatorList.argsArray[index] || [];
    let imageBlob: Blob | null = null;
    let imageSize: { width: number; height: number } | null = null;

    if (fn === OPS.paintInlineImageXObject) {
      imageBlob = await resolvePdfImageObjectBlob(args[0]).catch(() => null);
      imageSize = resolvePdfImageObjectSize(args[0]);
    } else if (fn === OPS.paintImageXObject || fn === OPS.paintJpegXObject) {
      const imageName = typeof args[0] === 'string' ? args[0] : '';
      if (!imageName || seenObjectNames.has(imageName)) continue;
      seenObjectNames.add(imageName);
      const source = typeof page.objs?.get === 'function' ? page.objs.get(imageName) : null;
      imageBlob = await resolvePdfImageObjectBlob(source).catch(() => null);
      imageSize = resolvePdfImageObjectSize(source);
    }

    if (!imageBlob) continue;
    const imageRef = await collectImageRef(imageBlob, context);
    imageRefs.push({
      imageRef,
      ...(imageSize?.width ? { width: imageSize.width } : {}),
      ...(imageSize?.height ? { height: imageSize.height } : {}),
    });
  }

  return imageRefs;
};

const parsePdfFile = async (file: File, context: ImportParseContext) => {
  ensurePdfWorker();
  const data = new Uint8Array(await file.arrayBuffer());
  const loadingTask = pdfjsLib.getDocument({ data, useSystemFonts: true });
  const pdfDocument: any = await loadingTask.promise;

  let title = trimFileExt(file.name);
  let author = '佚名';
  const metadata = await pdfDocument.getMetadata().catch(() => null);
  if (metadata?.info) {
    const info = metadata.info as Record<string, unknown>;
    if (typeof info.Title === 'string' && compactWhitespace(info.Title)) {
      title = compactWhitespace(info.Title);
    }
    if (typeof info.Author === 'string' && compactWhitespace(info.Author)) {
      author = compactWhitespace(info.Author);
    }
  }

  let coverUrl = '';
  const chapterBlocks: ReaderContentBlock[] = [];
  for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber += 1) {
    const page = await pdfDocument.getPage(pageNumber);
    if (pageNumber === 1) {
      const coverBlob = await renderPdfPageToBlob(page, 480);
      if (coverBlob) {
        coverUrl = await collectImageRef(coverBlob, context);
      }
    }

    const textContent = await page.getTextContent().catch(() => null);
    const pageText = normalizeTextBlock(
      textContent && Array.isArray(textContent.items)
        ? reconstructPdfPageWithMath(textContent.items as PdfTextItem[])
        : ''
    );
    if (pageText) {
      chapterBlocks.push({
        type: 'text',
        text: pageText,
      });
    }

    const pageImageRefs = await extractPdfPageImageRefs(page, context);
    pageImageRefs.forEach((imageItem) => {
      chapterBlocks.push({
        type: 'image',
        imageRef: imageItem.imageRef,
        alt: `PDF page ${pageNumber} image`,
        title: `PDF page ${pageNumber} image`,
        ...(imageItem.width ? { width: imageItem.width } : {}),
        ...(imageItem.height ? { height: imageItem.height } : {}),
      });
    });

    if (!pageText && pageImageRefs.length === 0) {
      const fallbackBlob = await renderPdfPageToBlob(page, 780);
      if (fallbackBlob) {
        const imageRef = await collectImageRef(fallbackBlob, context);
        chapterBlocks.push({
          type: 'image',
          imageRef,
          alt: `PDF page ${pageNumber}`,
          title: `PDF page ${pageNumber}`,
        });
      }
    }
  }

  await loadingTask.destroy();
  const chapter = buildChapterFromBlocks('全文', chapterBlocks);
  const fullText = chapter.content;
  return {
    format: 'pdf' as const,
    title,
    author,
    coverUrl,
    fullText,
    chapters: [chapter],
  };
};

const detectFormat = (file: File): SupportedImportFormat => {
  const suffix = getFileSuffix(file.name);
  if (TXT_SUFFIXES.has(suffix)) return 'txt';
  if (WORD_SUFFIXES.has(suffix)) return 'word';
  if (EPUB_SUFFIXES.has(suffix)) return 'epub';
  if (PDF_SUFFIXES.has(suffix)) return 'pdf';
  if (MOBI_SUFFIXES.has(suffix)) return 'mobi';
  throw new Error(`Unsupported file format: .${suffix || 'unknown'}`);
};

export const isSupportedBookImportFile = (fileName: string) => {
  const suffix = getFileSuffix(fileName);
  return SUPPORTED_SUFFIXES.includes(suffix);
};

export const parseImportedBookFile = async (file: File): Promise<ParsedBookImportResult> => {
  const context: ImportParseContext = {
    generatedImageRefs: [],
  };

  try {
    const format = detectFormat(file);
    const parsed =
      format === 'txt'
        ? await parseTxtFile(file)
        : format === 'word'
        ? await parseWordFile(file, context)
        : format === 'epub'
        ? await parseEpubFile(file, context)
        : format === 'pdf'
        ? await parsePdfFile(file, context)
        : await parseMobiFile(file, context);

    const normalizedFullText = normalizeTextBlock(parsed.fullText || '');
    const normalizedChapters =
      parsed.chapters.length > 0
        ? parsed.chapters
            .map((chapter) => buildChapterFromBlocks(chapter.title, chapter.blocks || [{ type: 'text', text: chapter.content }]))
            .filter((chapter) => chapter.content || (chapter.blocks && chapter.blocks.length > 0))
        : buildFallbackSingleChapter('全文', normalizedFullText);

    return {
      ...parsed,
      title: compactWhitespace(parsed.title) || trimFileExt(file.name),
      author: compactWhitespace(parsed.author) || '佚名',
      fullText: normalizedFullText,
      chapters: normalizedChapters,
      generatedImageRefs: [...context.generatedImageRefs],
    };
  } catch (error) {
    await deleteGeneratedImages(context.generatedImageRefs);
    throw error;
  }
};

