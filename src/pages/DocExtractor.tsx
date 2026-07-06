import { useMemo, useRef, useState, useEffect, useCallback } from "react";
import mammoth from "mammoth";
import {
  Upload,
  FileText,
  Download,
  Copy,
  Loader2,
  Image as ImageIcon,
  Type,
  Languages,
  Globe,
  Trash2,
  Package,
  ClipboardPaste,
  Sparkles,
  FolderOpen,
  Save,
} from "lucide-react";
import { useT, useI18n, localeOptions, type DictKey } from "@/i18n";
import {
  translateText,
  getCachedTranslation,
  saveTranslation,
  clearTranslationCache,
  type TargetLang,
} from "@/lib/translate";

/**
 * 文档结构定义
 * - block：文档中的一个基本单元（段落、图片、表格）
 * - section：按章节切分的一组 blocks
 */
type Block =
  | { kind: "text"; zh: string; en: string; raw: string }
  | { kind: "image"; src: string; alt: string }
  | { kind: "table"; html: string };

type Section = {
  id: string;
  /** 章节编号，如 "1.1"、"2" */
  number: string;
  /** 章节标题（中文） */
  titleZh: string;
  /** 章节标题（英文） */
  titleEn: string;
  blocks: Block[];
};

type ExtractResult = {
  fileName: string;
  totalParagraphs: number;
  totalImages: number;
  totalTables: number;
  sections: Section[];
  /** 未归属到任何章节的开头内容 */
  preface: Block[];
};

/** 判断字符是否 CJK */
function isCJK(ch: string): boolean {
  const code = ch.charCodeAt(0);
  return (
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0xf900 && code <= 0xfaff)
  );
}

/**
 * 把一段中英混排文本拆成中文和英文两部分。
 * 策略：逐字符扫描，把 CJK 字符（含相邻的中文标点/数字）归到 zh，其余归到 en。
 * 然后再对两侧做 trim + 去掉多余空白。
 */
function splitZhEn(text: string): { zh: string; en: string } {
  if (!text) return { zh: "", en: "" };
  // 若整体没有 CJK，直接当作英文
  const hasCJK = Array.from(text).some(isCJK);
  if (!hasCJK) return { zh: "", en: text.trim() };

  let zh = "";
  let en = "";
  let mode: "zh" | "en" | null = null;
  const flushGap = " ";

  for (const ch of text) {
    if (isCJK(ch)) {
      if (mode === "en" && en && !en.endsWith(flushGap)) en += flushGap;
      zh += ch;
      mode = "zh";
    } else if (/[\u3000-\u303F\uFF00-\uFFEF]/.test(ch)) {
      // 中文标点靠近 zh
      (mode === "en" ? (en += ch) : (zh += ch));
    } else if (/[A-Za-z]/.test(ch)) {
      if (mode === "zh" && zh && !zh.endsWith(" ")) zh += " ";
      en += ch;
      mode = "en";
    } else {
      // 数字、空格、标点 —— 附加到当前模式
      if (mode === "zh") zh += ch;
      else if (mode === "en") en += ch;
      else zh += ch;
    }
  }

  return {
    zh: zh.replace(/\s+/g, " ").trim(),
    en: en.replace(/\s+/g, " ").trim(),
  };
}

/**
 * 尝试识别章节编号。匹配开头形如：
 *   1  /  1.  /  1.1  /  1.1.1  /  第一章  /  Chapter 1
 */
function matchSectionNumber(text: string): string | null {
  const m1 = text.match(/^\s*(\d+(?:\.\d+){0,3})[\s.、:：]/);
  if (m1) return m1[1];
  const m2 = text.match(/^\s*第[一二三四五六七八九十百]+[章节]/);
  if (m2) return m2[0].trim();
  const m3 = text.match(/^\s*Chapter\s+\d+/i);
  if (m3) return m3[0].trim();
  return null;
}

/**
 * 把 mammoth 输出的 HTML 解析成结构化的 Section 列表。
 * 遇到 <h1>/<h2>/<h3> 或以章节编号开头的段落，就开一个新章节。
 */
function parseHtmlToSections(html: string, fileName: string): ExtractResult {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const nodes = Array.from(doc.body.children);

  const preface: Block[] = [];
  const sections: Section[] = [];
  let current: Section | null = null;
  let totalParagraphs = 0;
  let totalImages = 0;
  let totalTables = 0;

  const pushBlock = (b: Block) => {
    if (current) current.blocks.push(b);
    else preface.push(b);
  };

  const startSection = (number: string, titleRaw: string) => {
    const { zh, en } = splitZhEn(titleRaw);
    current = {
      id: `sec-${sections.length + 1}`,
      number,
      titleZh: zh,
      titleEn: en,
      blocks: [],
    };
    sections.push(current);
  };

  for (const node of nodes) {
    const tag = node.tagName.toLowerCase();

    if (tag === "h1" || tag === "h2" || tag === "h3" || tag === "h4") {
      const text = (node.textContent || "").trim();
      const num = matchSectionNumber(text) ?? String(sections.length + 1);
      const title = text.replace(/^\s*\d+(?:\.\d+){0,3}[\s.、:：]?/, "").trim();
      startSection(num, title || text);
      continue;
    }

    if (tag === "p") {
      // 段落内可能既有文字又有图片
      const imgs = Array.from(node.querySelectorAll("img"));
      const text = (node.textContent || "").trim();

      // 尝试把段落识别为章节起点
      if (text) {
        const num = matchSectionNumber(text);
        if (num) {
          const title = text.replace(
            /^\s*\d+(?:\.\d+){0,3}[\s.、:：]?/,
            "",
          ).trim();
          startSection(num, title || text);
          totalParagraphs++;
          // 章节标题本身也作为一块内容
          const { zh, en } = splitZhEn(title || text);
          if (zh || en) {
            pushBlock({ kind: "text", zh, en, raw: text });
          }
        } else {
          totalParagraphs++;
          const { zh, en } = splitZhEn(text);
          pushBlock({ kind: "text", zh, en, raw: text });
        }
      }

      for (const img of imgs) {
        totalImages++;
        pushBlock({
          kind: "image",
          src: img.getAttribute("src") || "",
          alt: img.getAttribute("alt") || "",
        });
      }
      continue;
    }

    if (tag === "table") {
      totalTables++;
      pushBlock({ kind: "table", html: node.outerHTML });
      continue;
    }

    if (tag === "ul" || tag === "ol") {
      const items = Array.from(node.querySelectorAll("li"));
      for (const li of items) {
        const text = (li.textContent || "").trim();
        if (!text) continue;
        totalParagraphs++;
        const { zh, en } = splitZhEn(text);
        pushBlock({ kind: "text", zh, en, raw: `• ${text}` });
      }
      continue;
    }

    // 其他节点：简单当文本处理
    const text = (node.textContent || "").trim();
    if (text) {
      totalParagraphs++;
      const { zh, en } = splitZhEn(text);
      pushBlock({ kind: "text", zh, en, raw: text });
    }
  }

  return {
    fileName,
    totalParagraphs,
    totalImages,
    totalTables,
    sections,
    preface,
  };
}

/** 把结果导出为 Markdown 字符串 */
function toMarkdown(
  result: ExtractResult,
  labels: {
    stats: string;
    preface: string;
    tablePlaceholder: string;
  },
): string {
  const lines: string[] = [];
  lines.push(`# ${result.fileName}`);
  lines.push("");
  lines.push(`> ${labels.stats}`);
  lines.push("");

  const dumpBlocks = (blocks: Block[]) => {
    for (const b of blocks) {
      if (b.kind === "text") {
        if (b.zh && b.en) {
          lines.push(b.zh);
          lines.push("");
          lines.push(`_${b.en}_`);
        } else {
          lines.push(b.zh || b.en || b.raw);
        }
        lines.push("");
      } else if (b.kind === "image") {
        lines.push(`![${b.alt || "image"}](${b.src})`);
        lines.push("");
      } else if (b.kind === "table") {
        lines.push(`<!-- ${labels.tablePlaceholder} -->`);
        lines.push("");
      }
    }
  };

  if (result.preface.length) {
    lines.push(`## ${labels.preface}`);
    lines.push("");
    dumpBlocks(result.preface);
  }

  for (const sec of result.sections) {
    const title = [sec.titleZh, sec.titleEn].filter(Boolean).join(" / ");
    lines.push(`## ${sec.number} ${title}`);
    lines.push("");
    dumpBlocks(sec.blocks);
  }

  return lines.join("\n");
}

function download(filename: string, content: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export default function DocExtractor() {
  const t = useT();
  const locale = useI18n((s) => s.locale);
  const setLocale = useI18n((s) => s.setLocale);
  const [langOpen, setLangOpen] = useState(false);
  const langMenuRef = useRef<HTMLDivElement>(null);

  const [result, setResult] = useState<ExtractResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeSectionId, setActiveSectionId] = useState<string>("");
  const [showEn, setShowEn] = useState(true);
  const [showZh, setShowZh] = useState(true);
  const [showImages, setShowImages] = useState(true);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  /** 翻译目标语言：null 表示关闭翻译 */
  const [target, setTarget] = useState<TargetLang | null>(null);
  const [targetOpen, setTargetOpen] = useState(false);
  const targetMenuRef = useRef<HTMLDivElement>(null);
  /** 翻译结果表：blockId(section#index+kind) -> 译文 */
  const [translations, setTranslations] = useState<Record<string, string>>({});
  /** 正在翻译中的 block key 集合 */
  const [busyKeys, setBusyKeys] = useState<Set<string>>(new Set());
  /** 章节批量翻译中：sectionId */
  const [busySection, setBusySection] = useState<string | null>(null);

  // 关闭语言菜单：点外面 / Esc
  useEffect(() => {
    if (!langOpen) return;
    const onClick = (e: MouseEvent) => {
      if (!langMenuRef.current?.contains(e.target as Node)) setLangOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setLangOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [langOpen]);

  // 关闭目标语言菜单
  useEffect(() => {
    if (!targetOpen) return;
    const onClick = (e: MouseEvent) => {
      if (!targetMenuRef.current?.contains(e.target as Node))
        setTargetOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setTargetOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [targetOpen]);

  /** 换文件时重置翻译结果 */
  useEffect(() => {
    setTranslations({});
    setBusyKeys(new Set());
    setBusySection(null);
  }, [result?.fileName]);

  /** 换目标语言时清空当前显示的翻译结果，并从缓存中回填 */
  useEffect(() => {
    if (!target || !result) {
      setTranslations({});
      return;
    }
    const next: Record<string, string> = {};
    const collect = (blocks: Block[], prefix: string) => {
      blocks.forEach((b, i) => {
        if (b.kind !== "text") return;
        const source = b.en || b.zh;
        if (!source) return;
        const from: "en" | "zh" = b.en ? "en" : "zh";
        const cached = getCachedTranslation(source, from, target);
        if (cached) next[`${prefix}-${i}`] = cached;
      });
    };
    collect(result.preface, "sec-preface");
    result.sections.forEach((sec) => collect(sec.blocks, sec.id));
    setTranslations(next);
  }, [target, result]);

  /** 翻译单段文本 */
  const translateBlock = useCallback(
    async (blockKey: string, source: string, from: "en" | "zh") => {
      if (!target) return;
      setBusyKeys((prev) => new Set(prev).add(blockKey));
      try {
        const out = await translateText(source, from, target);
        setTranslations((prev) => ({ ...prev, [blockKey]: out }));
      } catch (err) {
        console.error("[translate] failed", err);
        alert(t("dx_translate_failed"));
      } finally {
        setBusyKeys((prev) => {
          const next = new Set(prev);
          next.delete(blockKey);
          return next;
        });
      }
    },
    [target, t],
  );

  /** 批量翻译一整章的文本块 */
  const translateSection = useCallback(
    async (sectionId: string, blocks: Block[]) => {
      if (!target) return;
      setBusySection(sectionId);
      try {
        for (let i = 0; i < blocks.length; i++) {
          const b = blocks[i];
          if (b.kind !== "text") continue;
          const source = b.en || b.zh;
          if (!source) continue;
          const from: "en" | "zh" = b.en ? "en" : "zh";
          const key = `${sectionId}-${i}`;
          if (translations[key]) continue;
          try {
            const out = await translateText(source, from, target);
            setTranslations((prev) => ({ ...prev, [key]: out }));
          } catch (err) {
            console.error("[translate] one failed, continue", err);
          }
        }
      } finally {
        setBusySection(null);
      }
    },
    [target, translations],
  );

  const handleClearCache = () => {
    clearTranslationCache();
    setTranslations({});
  };

  /** 收集全书所有可翻译文本段（含 preface + sections），返回按顺序编号的列表 */
  const collectSegments = useCallback((): {
    key: string;
    source: string;
    from: "en" | "zh";
  }[] => {
    if (!result) return [];
    const list: { key: string; source: string; from: "en" | "zh" }[] = [];
    const push = (blocks: Block[], prefix: string) => {
      blocks.forEach((b, i) => {
        if (b.kind !== "text") return;
        const source = b.en || b.zh;
        if (!source || !source.trim()) return;
        list.push({
          key: `${prefix}-${i}`,
          source,
          from: b.en ? "en" : "zh",
        });
      });
    };
    push(result.preface, "sec-preface");
    result.sections.forEach((sec) => push(sec.blocks, sec.id));
    return list;
  }, [result]);

  /** 目标语言的自然名（英文），用于生成 GPT 提示词 */
  const targetLangName = (t: TargetLang | null): string => {
    switch (t) {
      case "fr":
        return "French";
      case "es":
        return "Spanish";
      case "ru":
        return "Russian";
      case "ar":
        return "Arabic";
      case "vi":
        return "Vietnamese";
      case "zh":
        return "Simplified Chinese";
      case "en":
        return "English";
      default:
        return "";
    }
  };

  /** 生成翻译工作包 markdown */
  const buildTranslationPack = (): string => {
    const segs = collectSegments();
    const langName = targetLangName(target);
    const lines: string[] = [];
    lines.push(`# Translation Pack — ${result?.fileName || ""}`);
    lines.push("");
    lines.push(
      `> Instruction: Translate every segment below into **${langName}**. `,
    );
    lines.push(
      `> **KEEP every \`[[SEG-x]]\` marker exactly as-is on its own line.** `,
    );
    lines.push(
      `> Only replace the text UNDER each marker with its translation. Do not merge or reorder segments.`,
    );
    lines.push("");
    lines.push(`> Total segments: ${segs.length}`);
    lines.push("");
    lines.push("---");
    lines.push("");
    segs.forEach((s, idx) => {
      lines.push(`[[SEG-${idx + 1}]]`);
      lines.push(s.source);
      lines.push("");
    });
    return lines.join("\n");
  };

  /** 各语种的电梯行业术语表（英文 → 目标语言） */
  const glossary: Record<Exclude<TargetLang, "en">, string[]> = {
    fr: [
      "Landing Door → Porte palière",
      "Car Door → Porte de cabine",
      "Car → Cabine",
      "Hoistway / Shaft → Gaine",
      "Pit → Cuvette",
      "Overhead → Hauteur libre en tête de gaine",
      "Counterweight → Contrepoids",
      "Guide Rail → Rail de guidage",
      "Traction Machine → Machine de traction",
      "Governor → Limiteur de vitesse",
      "Safety Gear → Parachute",
      "Buffer → Amortisseur",
      "Control Cabinet → Armoire de commande",
      "COP → Tableau de commande de cabine (COP)",
      "LOP → Boîte à boutons palière (LOP)",
      "Light Curtain → Rideau lumineux",
      "Machine Room → Local des machines",
      "Machine-Room-Less → Sans local des machines (MRL)",
    ],
    es: [
      "Landing Door → Puerta de piso",
      "Car Door → Puerta de cabina",
      "Car → Cabina",
      "Hoistway / Shaft → Hueco",
      "Pit → Foso",
      "Overhead → Huida superior",
      "Counterweight → Contrapeso",
      "Guide Rail → Guía",
      "Traction Machine → Máquina de tracción",
      "Governor → Limitador de velocidad",
      "Safety Gear → Paracaídas",
      "Buffer → Amortiguador",
      "Control Cabinet → Cuadro de maniobra",
      "COP → Botonera de cabina (COP)",
      "LOP → Botonera de piso (LOP)",
      "Light Curtain → Cortina de luz",
      "Machine Room → Cuarto de máquinas",
      "Machine-Room-Less → Sin cuarto de máquinas (MRL)",
    ],
    ru: [
      "Landing Door → Дверь шахты",
      "Car Door → Дверь кабины",
      "Car → Кабина",
      "Hoistway / Shaft → Шахта",
      "Pit → Приямок",
      "Overhead → Верхний зазор шахты",
      "Counterweight → Противовес",
      "Guide Rail → Направляющая",
      "Traction Machine → Лебёдка",
      "Governor → Ограничитель скорости",
      "Safety Gear → Ловитель",
      "Buffer → Буфер",
      "Control Cabinet → Шкаф управления",
      "COP → Пост управления в кабине (COP)",
      "LOP → Этажный вызывной пост (LOP)",
      "Light Curtain → Световой барьер",
      "Machine Room → Машинное помещение",
      "Machine-Room-Less → Без машинного помещения (MRL)",
    ],
    ar: [
      "Landing Door → باب الطابق",
      "Car Door → باب الكابينة",
      "Car → الكابينة",
      "Hoistway / Shaft → بئر المصعد",
      "Pit → الحفرة",
      "Overhead → المسافة العلوية",
      "Counterweight → الثقل الموازن",
      "Guide Rail → قضيب التوجيه",
      "Traction Machine → آلة الجر",
      "Governor → منظّم السرعة",
      "Safety Gear → جهاز الأمان (المكابح)",
      "Buffer → المصد",
      "Control Cabinet → لوحة التحكم",
      "COP → لوحة التحكم داخل الكابينة (COP)",
      "LOP → لوحة الاستدعاء في الطابق (LOP)",
      "Light Curtain → الستار الضوئي",
      "Machine Room → غرفة الماكينة",
      "Machine-Room-Less → بدون غرفة ماكينة (MRL)",
    ],
    vi: [
      "Landing Door → Cửa tầng",
      "Car Door → Cửa cabin",
      "Car → Cabin",
      "Hoistway / Shaft → Giếng thang",
      "Pit → Hố PIT",
      "Overhead → Chiều cao OH (đỉnh giếng)",
      "Counterweight → Đối trọng",
      "Guide Rail → Ray dẫn hướng",
      "Traction Machine → Máy kéo",
      "Governor → Bộ khống chế vượt tốc",
      "Safety Gear → Bộ hãm bảo hiểm",
      "Buffer → Giảm chấn",
      "Control Cabinet → Tủ điều khiển",
      "COP → Bảng điều khiển trong cabin (COP)",
      "LOP → Hộp gọi tầng (LOP)",
      "Light Curtain → Màn quang an toàn",
      "Machine Room → Phòng máy",
      "Machine-Room-Less → Không phòng máy (MRL)",
    ],
    zh: [
      "Landing Door → 层门",
      "Car Door → 轿门",
      "Car → 轿厢",
      "Hoistway / Shaft → 井道",
      "Pit → 底坑",
      "Overhead → 顶层高度",
      "Counterweight → 对重",
      "Guide Rail → 导轨",
      "Traction Machine → 曳引机",
      "Governor → 限速器",
      "Safety Gear → 安全钳",
      "Buffer → 缓冲器",
      "Control Cabinet → 控制柜",
      "COP → 轿内操纵箱 (COP)",
      "LOP → 层站呼梯盒 (LOP)",
      "Light Curtain → 光幕",
      "Machine Room → 机房",
      "Machine-Room-Less → 无机房 (MRL)",
    ],
  };

  /** 生成 GPT 提示词（附在剪贴板里，直接贴到 chatgpt.com） */
  const buildPrompt = (): string => {
    const langName = targetLangName(target);
    const terms =
      target && target !== "en" ? glossary[target] : [];
    const lines: string[] = [
      `You are a professional technical translator specializing in elevator installation, commissioning, maintenance, and service manuals.`,
      ``,
      `Your task is to translate every segment I provide into **${langName}**.`,
      ``,
      `Requirements:`,
      ``,
      `1. The input consists of independent segments identified by markers such as:`,
      `   [[SEG-1]]`,
      `   [[SEG-2]]`,
      `   ...`,
      `2. Keep every marker exactly as provided, on its own line, in the original order.`,
      `3. Under each marker, output **only** the ${langName} translation of that segment.`,
      `4. Do not add explanations, notes, comments, numbering, or blank sections.`,
      `5. Do not merge, split, omit, or reorder any segments.`,
      `6. Preserve all numbers, dimensions, units, model numbers, product codes, standards, figure references, and part numbers exactly as written.`,
      `7. Preserve formatting where possible, including bullet points, punctuation, capitalization, warnings, and line breaks.`,
      `8. Keep terminology consistent throughout the entire translation.`,
      `9. Translate naturally using professional elevator industry terminology commonly used in ${langName} technical documentation.`,
      `10. Do not translate brand names, product names, software names, parameter names, or serial/model identifiers.`,
      `11. If a segment is already in ${langName}, reproduce it unchanged under its corresponding marker.`,
      `12. Translate every segment independently without relying on surrounding segments.`,
      ``,
    ];
    if (terms.length) {
      lines.push(`Terminology preferences:`);
      lines.push(``);
      terms.forEach((t) => lines.push(`* ${t}`));
      lines.push(``);
    }
    lines.push(`Output format:`);
    lines.push(``);
    lines.push(`[[SEG-1]] <translated text>`);
    lines.push(``);
    lines.push(`[[SEG-2]] <translated text>`);
    lines.push(``);
    lines.push(`Continue until every segment has been translated.`);
    return lines.join("\n");
  };

  /** 导出翻译包 */
  const doExportPack = () => {
    if (!result) return;
    if (!target) {
      alert(t("dx_pack_pick_lang"));
      return;
    }
    const md = buildTranslationPack();
    const filename =
      result.fileName.replace(/\.docx$/i, "") + `.pack.${target}.md`;
    download(filename, md, "text/markdown");
    alert(t("dx_pack_exported"));
  };

  /** 复制 GPT 提示词到剪贴板 */
  const doCopyPrompt = async () => {
    if (!target) {
      alert(t("dx_pack_pick_lang"));
      return;
    }
    await navigator.clipboard.writeText(buildPrompt());
    alert(t("dx_pack_prompt_copied"));
  };

  /** 导入译文相关状态 */
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState("");

  /** 解析 GPT 返回的粘贴内容并回填 */
  const doImportPack = () => {
    if (!target || !result) return;
    const raw = importText;
    // 用 [[SEG-x]] 作为分隔符，允许前后有空白，允许 x 是任意数字
    const regex = /\[\[SEG-(\d+)\]\]/g;
    const matches: { seg: number; index: number }[] = [];
    let m: RegExpExecArray | null;
    while ((m = regex.exec(raw)) !== null) {
      matches.push({ seg: Number(m[1]), index: m.index + m[0].length });
    }
    if (!matches.length) {
      alert(t("dx_import_none"));
      return;
    }
    const segs = collectSegments();
    const parsed: Record<number, string> = {};
    for (let i = 0; i < matches.length; i++) {
      const { seg, index } = matches[i];
      const end = i + 1 < matches.length ? matches[i + 1].index : raw.length;
      // matches[i+1].index 指向下一个 `[[SEG-x]]` 开头位置减 0；
      // 我们记录的 index 已经是本 marker 的**结束**位置，所以片段就是 [index, end)
      // 但 end 需要指向下一个 marker 的**起始**（[[SEG- 之前），需要在下一个 index 处向前找 `[[SEG-`
      const nextMarkerStart =
        i + 1 < matches.length
          ? raw.lastIndexOf("[[SEG-", matches[i + 1].index)
          : end;
      const sliceEnd = nextMarkerStart >= 0 ? nextMarkerStart : end;
      const chunk = raw.slice(index, sliceEnd);
      parsed[seg] = chunk.trim();
    }
    // 回填
    let count = 0;
    const nextTx: Record<string, string> = { ...translations };
    segs.forEach((s, idx) => {
      const segNo = idx + 1;
      const translated = parsed[segNo];
      if (translated) {
        saveTranslation(s.source, s.from, target, translated);
        nextTx[s.key] = translated;
        count++;
      }
    });
    setTranslations(nextTx);
    setImportOpen(false);
    setImportText("");
    alert(t("dx_import_done").replace("{n}", String(count)));
  };

  const filteredSections = useMemo(() => {
    if (!result) return [];
    return result.sections;
  }, [result]);

  // Markdown 导出时用到的多语言标签
  const mdLabels = useMemo(
    () => ({
      stats: result
        ? `${t("dx_stat_paragraphs")} ${result.totalParagraphs} · ${t(
            "dx_stat_images",
          )} ${result.totalImages} · ${t("dx_stat_tables")} ${
            result.totalTables
          } · ${t("dx_stat_sections")} ${result.sections.length}`
        : "",
      preface: t("dx_preface"),
      tablePlaceholder: t("dx_table_placeholder"),
    }),
    [result, t],
  );

  const handleFile = async (file: File) => {
    if (!file.name.toLowerCase().endsWith(".docx")) {
      setError(t("dx_format_error"));
      return;
    }
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const buffer = await file.arrayBuffer();
      // convertToHtml 会把图片以 base64 dataURL 内联到 <img src="...">
      const { value: html } = await mammoth.convertToHtml(
        { arrayBuffer: buffer },
        {
          convertImage: mammoth.images.imgElement((image) =>
            image.read("base64").then((data: string) => ({
              src: `data:${image.contentType};base64,${data}`,
            })),
          ),
        },
      );
      const parsed = parseHtmlToSections(html, file.name);
      setResult(parsed);
      setActiveSectionId(parsed.sections[0]?.id || "");
    } catch (err) {
      console.error("[extract] failed", err);
      setError(
        `${t("dx_parse_failed")}: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setLoading(false);
    }
  };

  const onPick = () => inputRef.current?.click();

  const onInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (f) handleFile(f);
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const f = e.dataTransfer.files?.[0];
    if (f) handleFile(f);
  };

  const doExportMd = () => {
    if (!result) return;
    const md = toMarkdown(result, mdLabels);
    download(
      result.fileName.replace(/\.docx$/i, "") + ".md",
      md,
      "text/markdown",
    );
  };

  const doExportJson = () => {
    if (!result) return;
    // 导出 JSON 时把 base64 图片替换成占位（避免文件过大）
    const compact = {
      ...result,
      sections: result.sections.map((s) => ({
        ...s,
        blocks: s.blocks.map((b) =>
          b.kind === "image"
            ? { kind: "image", alt: b.alt, src: "[embedded image omitted]" }
            : b,
        ),
      })),
    };
    download(
      result.fileName.replace(/\.docx$/i, "") + ".json",
      JSON.stringify(compact, null, 2),
      "application/json",
    );
  };

  const doCopyAll = async () => {
    if (!result) return;
    await navigator.clipboard.writeText(toMarkdown(result, mdLabels));
    alert(t("dx_copied"));
  };

  /** 项目文件的引用与解析器（.mtp = Manual Translation Project） */
  const projectInputRef = useRef<HTMLInputElement>(null);

  /** 导出项目：把原文结构 + 图片 + 所有译文 打包成一个 .mtp.json */
  const doExportProject = () => {
    if (!result) return;
    const payload = {
      version: 1,
      type: "manual-translation-project",
      exportedAt: new Date().toISOString(),
      target,
      result,
      translations,
    };
    const baseName = result.fileName.replace(/\.docx$/i, "");
    download(
      `${baseName}.mtp.json`,
      JSON.stringify(payload),
      "application/json",
    );
  };

  /** 导入项目：读取 .mtp.json，恢复整个工作区 */
  const doImportProject = async (file: File) => {
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      if (
        !data ||
        data.type !== "manual-translation-project" ||
        !data.result ||
        !data.result.sections
      ) {
        alert(t("dx_project_invalid"));
        return;
      }
      // 先设置 target，再设置 result，否则会被"换文件时重置翻译"清空
      const nextTarget: TargetLang | null = data.target ?? null;
      const nextResult: ExtractResult = data.result;
      const nextTx: Record<string, string> = data.translations || {};
      setTarget(nextTarget);
      setResult(nextResult);
      setActiveSectionId(nextResult.sections[0]?.id || "");
      // 用 setTimeout 让 result/target 的副作用先跑完再回填翻译
      setTimeout(() => setTranslations(nextTx), 0);
      alert(
        t("dx_project_imported").replace(
          "{n}",
          String(Object.keys(nextTx).length),
        ),
      );
    } catch (err) {
      console.error("[import project] failed", err);
      alert(t("dx_project_invalid"));
    }
  };

  const onPickProject = () => projectInputRef.current?.click();
  const onProjectInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (f) doImportProject(f);
  };

  return (
    <div className="h-screen flex flex-col bg-[#F2F4F7]">
      {/* 顶栏 */}
      <header className="h-14 shrink-0 bg-white border-b border-ink-900/8 flex items-center justify-between px-6 gap-4">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-8 h-8 rounded bg-ink-900 flex items-center justify-center">
            <FileText size={16} className="text-gold-500" />
          </div>
          <div className="leading-tight min-w-0">
            <div className="text-[13px] font-bold tracking-widest text-ink-900 uppercase font-display truncate">
              {t("dx_title")}
            </div>
            <div className="text-[10px] text-cool-500 tracking-widest truncate">
              {t("dx_subtitle")}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-1.5">
          {/* 语言切换器 */}
          <div ref={langMenuRef} className="relative mr-1">
            <button
              type="button"
              onClick={() => setLangOpen((v) => !v)}
              className="px-2.5 py-1.5 text-xs font-medium text-cool-500 hover:text-ink-900 border border-ink-900/12 rounded-md transition flex items-center gap-1.5 hover:border-ink-900/25"
              title={t("language")}
              aria-haspopup="listbox"
              aria-expanded={langOpen}
            >
              <Languages size={13} />
              <span className="text-[13px] leading-none">
                {localeOptions.find((o) => o.value === locale)?.flag}
              </span>
              <span className="hidden sm:inline">
                {localeOptions.find((o) => o.value === locale)?.label}
              </span>
            </button>
            {langOpen && (
              <div
                role="listbox"
                className="absolute right-0 top-full mt-1 min-w-[160px] bg-white border border-ink-900/10 rounded-md shadow-lg overflow-hidden z-20"
              >
                {localeOptions.map((opt) => {
                  const active = opt.value === locale;
                  return (
                    <button
                      key={opt.value}
                      type="button"
                      role="option"
                      aria-selected={active}
                      onClick={() => {
                        setLocale(opt.value);
                        setLangOpen(false);
                      }}
                      className={`w-full text-left px-3 py-2 text-xs flex items-center gap-2 transition ${
                        active
                          ? "bg-ink-900/[0.06] text-ink-900 font-semibold"
                          : "text-cool-600 hover:bg-ink-900/[0.04] hover:text-ink-900"
                      }`}
                    >
                      <span className="text-[14px] leading-none">
                        {opt.flag}
                      </span>
                      <span>{opt.label}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {result && (
            <>
              <button
                type="button"
                onClick={() => setShowEn((v) => !v)}
                className={`px-3 py-1.5 text-xs font-medium border rounded-md transition flex items-center gap-1.5 ${
                  showEn
                    ? "text-ink-900 border-ink-900/25 bg-ink-900/5"
                    : "text-cool-500 border-ink-900/12 hover:border-ink-900/25"
                }`}
                title={t("dx_toggle_en")}
              >
                <Type size={13} />
                {showEn ? t("dx_hide_en") : t("dx_show_en")}
              </button>
              <button
                type="button"
                onClick={() => setShowZh((v) => !v)}
                className={`px-3 py-1.5 text-xs font-medium border rounded-md transition flex items-center gap-1.5 ${
                  showZh
                    ? "text-ink-900 border-ink-900/25 bg-ink-900/5"
                    : "text-cool-500 border-ink-900/12 hover:border-ink-900/25"
                }`}
                title={t("dx_toggle_zh")}
              >
                <Type size={13} />
                {showZh ? t("dx_hide_zh") : t("dx_show_zh")}
              </button>
              <button
                type="button"
                onClick={() => setShowImages((v) => !v)}
                className={`px-3 py-1.5 text-xs font-medium border rounded-md transition flex items-center gap-1.5 ${
                  showImages
                    ? "text-ink-900 border-ink-900/25 bg-ink-900/5"
                    : "text-cool-500 border-ink-900/12 hover:border-ink-900/25"
                }`}
                title={t("dx_toggle_img")}
              >
                <ImageIcon size={13} />
                {showImages ? t("dx_hide_img") : t("dx_show_img")}
              </button>

              {/* 目标翻译语言选择器 */}
              <div ref={targetMenuRef} className="relative">
                <button
                  type="button"
                  onClick={() => setTargetOpen((v) => !v)}
                  className={`px-3 py-1.5 text-xs font-medium border rounded-md transition flex items-center gap-1.5 ${
                    target
                      ? "text-ink-900 border-ink-900/25 bg-ink-900/5"
                      : "text-cool-500 border-ink-900/12 hover:border-ink-900/25"
                  }`}
                  title={t("dx_translate_target")}
                  aria-haspopup="listbox"
                  aria-expanded={targetOpen}
                >
                  <Globe size={13} />
                  {target
                    ? t(`dx_lang_${target}` as DictKey)
                    : t("dx_translate_target")}
                </button>
                {targetOpen && (
                  <div
                    role="listbox"
                    className="absolute right-0 top-full mt-1 min-w-[180px] bg-white border border-ink-900/10 rounded-md shadow-lg overflow-hidden z-20"
                  >
                    {(
                      [
                        { v: null, key: "dx_translate_off" as DictKey },
                        { v: "fr", key: "dx_lang_fr" as DictKey },
                        { v: "es", key: "dx_lang_es" as DictKey },
                        { v: "ru", key: "dx_lang_ru" as DictKey },
                        { v: "ar", key: "dx_lang_ar" as DictKey },
                        { v: "vi", key: "dx_lang_vi" as DictKey },
                        { v: "zh", key: "dx_lang_zh" as DictKey },
                      ] as { v: TargetLang | null; key: DictKey }[]
                    ).map((opt) => {
                      const active = opt.v === target;
                      return (
                        <button
                          key={String(opt.v)}
                          type="button"
                          role="option"
                          aria-selected={active}
                          onClick={() => {
                            setTarget(opt.v);
                            setTargetOpen(false);
                          }}
                          className={`w-full text-left px-3 py-2 text-xs transition ${
                            active
                              ? "bg-ink-900/[0.06] text-ink-900 font-semibold"
                              : "text-cool-600 hover:bg-ink-900/[0.04] hover:text-ink-900"
                          }`}
                        >
                          {t(opt.key)}
                        </button>
                      );
                    })}
                    <div className="border-t border-ink-900/8 mt-1 pt-1">
                      <button
                        type="button"
                        onClick={() => {
                          handleClearCache();
                          setTargetOpen(false);
                        }}
                        className="w-full text-left px-3 py-2 text-[11px] text-cool-500 hover:bg-ink-900/[0.04] hover:text-ink-900 flex items-center gap-1.5"
                      >
                        <Trash2 size={11} />
                        {t("dx_clear_cache")}
                      </button>
                    </div>
                    <div className="px-3 py-2 text-[10px] text-cool-500 leading-snug border-t border-ink-900/8">
                      {t("dx_translate_note")}
                    </div>
                  </div>
                )}
              </div>

              {/* 翻译工作包：仅在选了目标语言时显示 */}
              {target && (
                <>
                  <button
                    type="button"
                    onClick={doCopyPrompt}
                    className="px-3 py-1.5 text-xs font-medium text-cool-500 hover:text-ink-900 border border-ink-900/12 rounded-md transition flex items-center gap-1.5 hover:border-ink-900/25"
                    title={t("dx_copy_prompt")}
                  >
                    <Sparkles size={13} />
                    {t("dx_copy_prompt")}
                  </button>
                  <button
                    type="button"
                    onClick={doExportPack}
                    className="px-3 py-1.5 text-xs font-medium text-cool-500 hover:text-ink-900 border border-ink-900/12 rounded-md transition flex items-center gap-1.5 hover:border-ink-900/25"
                    title={t("dx_export_pack")}
                  >
                    <Package size={13} />
                    {t("dx_export_pack")}
                  </button>
                  <button
                    type="button"
                    onClick={() => setImportOpen(true)}
                    className="px-3 py-1.5 text-xs font-medium text-white bg-ink-900 hover:bg-ink-800 rounded-md transition flex items-center gap-1.5"
                    title={t("dx_import_pack")}
                  >
                    <ClipboardPaste size={13} />
                    {t("dx_import_pack")}
                  </button>
                </>
              )}

              <button
                type="button"
                onClick={doExportProject}
                className="px-3 py-1.5 text-xs font-medium text-cool-500 hover:text-ink-900 border border-ink-900/12 rounded-md transition flex items-center gap-1.5 hover:border-ink-900/25"
                title={t("dx_export_project_hint")}
              >
                <Save size={13} />
                {t("dx_export_project")}
              </button>
              <button
                type="button"
                onClick={onPickProject}
                className="px-3 py-1.5 text-xs font-medium text-cool-500 hover:text-ink-900 border border-ink-900/12 rounded-md transition flex items-center gap-1.5 hover:border-ink-900/25"
                title={t("dx_import_project_hint")}
              >
                <FolderOpen size={13} />
                {t("dx_import_project")}
              </button>
              <button
                type="button"
                onClick={doCopyAll}
                className="px-3 py-1.5 text-xs font-medium text-cool-500 hover:text-ink-900 border border-ink-900/12 rounded-md transition flex items-center gap-1.5 hover:border-ink-900/25"
              >
                <Copy size={13} />
                {t("dx_copy_md")}
              </button>
              <button
                type="button"
                onClick={doExportJson}
                className="px-3 py-1.5 text-xs font-medium text-cool-500 hover:text-ink-900 border border-ink-900/12 rounded-md transition flex items-center gap-1.5 hover:border-ink-900/25"
              >
                <Download size={13} />
                {t("dx_export_json")}
              </button>
              <button
                type="button"
                onClick={doExportMd}
                className="px-4 py-1.5 text-xs font-semibold text-white bg-ink-900 hover:bg-ink-800 rounded-md transition flex items-center gap-1.5"
              >
                <Download size={13} />
                {t("dx_export_md")}
              </button>
              <button
                type="button"
                onClick={onPick}
                className="px-3 py-1.5 text-xs font-medium text-cool-500 hover:text-ink-900 border border-ink-900/12 rounded-md transition flex items-center gap-1.5 hover:border-ink-900/25"
              >
                <Upload size={13} />
                {t("dx_change_file")}
              </button>
            </>
          )}
        </div>
      </header>

      {/* 主体 */}
      {!result ? (
        <div className="flex-1 flex items-center justify-center p-8">
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={onDrop}
            className={`w-full max-w-2xl rounded-xl border-2 border-dashed p-16 text-center transition ${
              dragOver
                ? "border-ink-900 bg-ink-900/5"
                : "border-ink-900/20 bg-white"
            }`}
          >
            <div className="mx-auto w-16 h-16 rounded-full bg-ink-900/5 flex items-center justify-center mb-4">
              <Upload size={28} className="text-ink-900" />
            </div>
            <div className="text-lg font-semibold text-ink-900 mb-2">
              {t("dx_upload_title")}
            </div>
            <div className="text-sm text-cool-500 mb-6 leading-relaxed">
              {t("dx_upload_desc_1")}
              <br />
              {t("dx_upload_desc_2")}
            </div>
            <div className="flex items-center justify-center gap-3 flex-wrap">
              <button
                type="button"
                onClick={onPick}
                disabled={loading}
                className="px-6 py-2.5 bg-ink-900 text-white text-sm font-semibold rounded-md hover:bg-ink-800 transition inline-flex items-center gap-2 disabled:opacity-60"
              >
                {loading ? (
                  <>
                    <Loader2 size={16} className="animate-spin" />
                    {t("dx_parsing")}
                  </>
                ) : (
                  <>
                    <Upload size={16} />
                    {t("dx_pick_file")}
                  </>
                )}
              </button>
              <button
                type="button"
                onClick={onPickProject}
                disabled={loading}
                className="px-6 py-2.5 bg-white text-ink-900 text-sm font-semibold border border-ink-900/15 rounded-md hover:border-ink-900/40 transition inline-flex items-center gap-2 disabled:opacity-60"
                title={t("dx_import_project_hint")}
              >
                <FolderOpen size={16} />
                {t("dx_import_project")}
              </button>
            </div>
            {error && (
              <div className="mt-6 text-sm text-red-600 bg-red-50 border border-red-200 rounded-md p-3">
                {error}
              </div>
            )}
            <div className="mt-6 text-xs text-cool-500 leading-relaxed">
              {t("dx_doc_hint")}
            </div>
          </div>

          <input
            ref={inputRef}
            type="file"
            accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            className="hidden"
            onChange={onInput}
          />
        </div>
      ) : (
        <div className="flex-1 flex overflow-hidden">
          {/* 左：章节目录 */}
          <aside className="w-72 shrink-0 bg-white border-r border-ink-900/8 overflow-y-auto">
            <div className="px-4 py-3 border-b border-ink-900/8">
              <div className="text-[11px] uppercase tracking-widest text-cool-500 font-semibold">
                {t("dx_toc")}
              </div>
              <div className="text-xs text-cool-500 mt-1 truncate">
                {result.fileName}
              </div>
              <div className="text-[11px] text-cool-500 mt-2 flex flex-wrap gap-x-3 gap-y-1">
                <span>
                  {t("dx_stat_paragraphs")} {result.totalParagraphs}
                </span>
                <span>
                  {t("dx_stat_images")} {result.totalImages}
                </span>
                <span>
                  {t("dx_stat_tables")} {result.totalTables}
                </span>
                <span>
                  {t("dx_stat_sections")} {result.sections.length}
                </span>
              </div>
            </div>
            <nav className="py-2">
              {result.preface.length > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    setActiveSectionId("preface");
                    document
                      .getElementById("sec-preface")
                      ?.scrollIntoView({ behavior: "smooth" });
                  }}
                  className={`w-full text-left px-4 py-2 text-xs transition ${
                    activeSectionId === "preface"
                      ? "bg-ink-900/5 text-ink-900 font-semibold"
                      : "text-cool-600 hover:bg-ink-900/[0.03]"
                  }`}
                >
                  {t("dx_preface")}
                </button>
              )}
              {filteredSections.map((sec) => (
                <button
                  key={sec.id}
                  type="button"
                  onClick={() => {
                    setActiveSectionId(sec.id);
                    document
                      .getElementById(sec.id)
                      ?.scrollIntoView({ behavior: "smooth" });
                  }}
                  className={`w-full text-left px-4 py-2 text-xs transition ${
                    activeSectionId === sec.id
                      ? "bg-ink-900/5 text-ink-900 font-semibold"
                      : "text-cool-600 hover:bg-ink-900/[0.03]"
                  }`}
                >
                  <div className="flex gap-2">
                    <span className="font-mono text-ink-900/60 shrink-0">
                      {sec.number}
                    </span>
                    <span className="truncate">
                      {sec.titleZh || sec.titleEn}
                    </span>
                  </div>
                  {sec.titleZh && sec.titleEn && (
                    <div className="pl-8 text-[10px] text-cool-500 truncate italic">
                      {sec.titleEn}
                    </div>
                  )}
                </button>
              ))}
            </nav>
          </aside>

          {/* 右：内容 */}
          <main className="flex-1 overflow-y-auto">
            <div className="max-w-4xl mx-auto px-8 py-8">
              {result.preface.length > 0 && (
                <SectionView
                  id="sec-preface"
                  number=""
                  titleZh={t("dx_preface")}
                  titleEn=""
                  blocks={result.preface}
                  showEn={showEn}
                  showZh={showZh}
                  showImages={showImages}
                  target={target}
                  translations={translations}
                  busyKeys={busyKeys}
                  busySection={busySection}
                  onTranslateOne={translateBlock}
                  onTranslateSection={translateSection}
                  t={t}
                />
              )}
              {filteredSections.map((sec) => (
                <SectionView
                  key={sec.id}
                  id={sec.id}
                  number={sec.number}
                  titleZh={sec.titleZh}
                  titleEn={sec.titleEn}
                  blocks={sec.blocks}
                  showEn={showEn}
                  showZh={showZh}
                  showImages={showImages}
                  target={target}
                  translations={translations}
                  busyKeys={busyKeys}
                  busySection={busySection}
                  onTranslateOne={translateBlock}
                  onTranslateSection={translateSection}
                  t={t}
                />
              ))}
            </div>
          </main>
        </div>
      )}

      {/* 导入译文模态框 */}
      {importOpen && (
        <div
          className="fixed inset-0 z-50 bg-ink-900/40 flex items-center justify-center p-4"
          onClick={() => setImportOpen(false)}
        >
          <div
            className="bg-white rounded-lg shadow-2xl w-full max-w-3xl max-h-[85vh] flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-5 py-3 border-b border-ink-900/10 flex items-center justify-between">
              <div>
                <div className="text-sm font-semibold text-ink-900">
                  {t("dx_import_title")}
                </div>
                <div className="text-[11px] text-cool-500 mt-0.5">
                  {t("dx_import_hint")}
                </div>
              </div>
              <div className="text-[11px] text-cool-500">
                {target && t(`dx_lang_${target}` as DictKey)}
              </div>
            </div>
            <div className="flex-1 overflow-hidden p-4">
              <textarea
                value={importText}
                onChange={(e) => setImportText(e.target.value)}
                placeholder={t("dx_import_placeholder")}
                className="w-full h-[55vh] resize-none border border-ink-900/12 rounded-md p-3 text-xs font-mono text-ink-900 focus:outline-none focus:border-ink-900/40"
              />
            </div>
            <div className="px-5 py-3 border-t border-ink-900/10 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setImportOpen(false)}
                className="px-4 py-1.5 text-xs font-medium text-cool-500 hover:text-ink-900 border border-ink-900/12 rounded-md transition hover:border-ink-900/25"
              >
                {t("dx_cancel")}
              </button>
              <button
                type="button"
                onClick={doImportPack}
                disabled={!importText.trim()}
                className="px-4 py-1.5 text-xs font-semibold text-white bg-ink-900 hover:bg-ink-800 rounded-md transition disabled:opacity-60 flex items-center gap-1.5"
              >
                <ClipboardPaste size={13} />
                {t("dx_import_do")}
              </button>
            </div>
          </div>
        </div>
      )}
      <input
        ref={projectInputRef}
        type="file"
        accept=".json,.mtp,application/json"
        className="hidden"
        onChange={onProjectInput}
      />
    </div>
  );
}

function SectionView({
  id,
  number,
  titleZh,
  titleEn,
  blocks,
  showEn,
  showZh,
  showImages,
  target,
  translations,
  busyKeys,
  busySection,
  onTranslateOne,
  onTranslateSection,
  t,
}: {
  id: string;
  number: string;
  titleZh: string;
  titleEn: string;
  blocks: Block[];
  showEn: boolean;
  showZh: boolean;
  showImages: boolean;
  target: TargetLang | null;
  translations: Record<string, string>;
  busyKeys: Set<string>;
  busySection: string | null;
  onTranslateOne: (key: string, source: string, from: "en" | "zh") => void;
  onTranslateSection: (sectionId: string, blocks: Block[]) => void;
  t: (k: DictKey) => string;
}) {
  const isRtl = target === "ar";
  const sectionBusy = busySection === id;
  const primaryTitle = showZh
    ? titleZh || titleEn
    : titleEn || titleZh;
  const showSubtitle =
    showZh && showEn && titleZh && titleEn && primaryTitle !== titleEn;
  return (
    <section id={id} className="mb-10 scroll-mt-4">
      <div className="border-b border-ink-900/10 pb-3 mb-5">
        <div className="flex items-baseline gap-3 flex-wrap">
          {number && (
            <span className="font-mono text-sm text-cool-500">{number}</span>
          )}
          <h2 className="text-xl font-bold text-ink-900">
            {primaryTitle}
          </h2>
          {target && (
            <button
              type="button"
              onClick={() => onTranslateSection(id, blocks)}
              disabled={sectionBusy}
              className="ml-auto px-2.5 py-1 text-[11px] font-medium text-cool-500 hover:text-ink-900 border border-ink-900/12 rounded transition flex items-center gap-1 hover:border-ink-900/25 disabled:opacity-60"
            >
              {sectionBusy ? (
                <>
                  <Loader2 size={11} className="animate-spin" />
                  {t("dx_translating")}
                </>
              ) : (
                <>
                  <Globe size={11} />
                  {t("dx_translate_section")}
                </>
              )}
            </button>
          )}
        </div>
        {showSubtitle && (
          <div className="text-sm italic text-cool-500 mt-1">{titleEn}</div>
        )}
      </div>

      <div className="space-y-4">
        {blocks.map((b, i) => {
          if (b.kind === "text") {
            const key = `${id}-${i}`;
            const source = b.en || b.zh;
            const from: "en" | "zh" = b.en ? "en" : "zh";
            const translated = translations[key];
            const busy = busyKeys.has(key);
            return (
              <div key={i} className="text-[15px] leading-relaxed group">
                {showZh && b.zh && (
                  <div className="text-ink-900 whitespace-pre-wrap">{b.zh}</div>
                )}
                {showEn && b.en && (
                  <div className="text-cool-500 italic mt-1 whitespace-pre-wrap">
                    {b.en}
                  </div>
                )}
                {!b.zh && !b.en && (
                  <div className="text-ink-900 whitespace-pre-wrap">
                    {b.raw}
                  </div>
                )}
                {target && source && (
                  <div className="mt-1.5 flex items-start gap-2">
                    {translated ? (
                      <div
                        dir={isRtl ? "rtl" : "ltr"}
                        className={`flex-1 text-ink-900 whitespace-pre-wrap border-l-2 border-gold-500/60 pl-2 ${
                          isRtl ? "text-right border-l-0 border-r-2 pr-2 pl-0" : ""
                        }`}
                      >
                        {translated}
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => onTranslateOne(key, source, from)}
                        disabled={busy || sectionBusy}
                        className="text-[11px] text-cool-500 hover:text-ink-900 border border-ink-900/12 rounded px-2 py-0.5 transition hover:border-ink-900/25 disabled:opacity-60 flex items-center gap-1 opacity-0 group-hover:opacity-100"
                      >
                        {busy ? (
                          <>
                            <Loader2 size={10} className="animate-spin" />
                            {t("dx_translating")}
                          </>
                        ) : (
                          <>
                            <Globe size={10} />
                            {t("dx_translate_one")}
                          </>
                        )}
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          }
          if (b.kind === "image") {
            if (!showImages) return null;
            return (
              <div key={i} className="my-4">
                <img
                  src={b.src}
                  alt={b.alt}
                  className="max-w-full rounded border border-ink-900/10"
                />
              </div>
            );
          }
          if (b.kind === "table") {
            return (
              <div
                key={i}
                className="my-4 overflow-x-auto border border-ink-900/10 rounded [&_table]:w-full [&_td]:border [&_td]:border-ink-900/10 [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:border-ink-900/10 [&_th]:px-2 [&_th]:py-1 [&_th]:bg-ink-900/5"
                dangerouslySetInnerHTML={{ __html: b.html }}
              />
            );
          }
          return null;
        })}
      </div>
    </section>
  );
}
