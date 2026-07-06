# Elevator Manual Translator · 电梯安装手册翻译工具

一个用于电梯外贸场景的 `.docx` 安装手册解析与翻译工作台。

- 上传 `.docx`（老 `.doc` 请先在 Word / WPS 里另存为 `.docx`）
- 自动按章节编号（`1`、`1.1`、`第一章`、`Chapter 1` 等）切分
- 中英文段落自动分离并列显示
- 保留原文插图与表格
- 一键导出 Markdown / JSON
- 内置多语言 UI（zh / en / fr / es / ru / vi）
- 集成两种翻译工作流：
  1. **自动翻译**：MyMemory 免费 API（无需 Key，有配额限制）
  2. **人工回填（推荐）**：导出 `[[SEG-x]]` 翻译工作包，交给 ChatGPT 翻译后一键回填，段落对齐 100% 准确
- 内置电梯行业术语表（fr / es / ru / ar / vi / zh）用于生成 GPT 提示词
- 阿拉伯语目标语种自动切换 RTL 从右向左

## 本地开发

```bash
npm install
npm run dev
```

## 生产构建

```bash
npm run build
```

## 部署到 Vercel

1. 在 Vercel 上导入本仓库
2. Framework 会被自动识别为 Vite，无需修改
3. 项目已带 `vercel.json` 处理 SPA 路由，直接 Deploy 即可

## 技术栈

React 18 · TypeScript · Vite 6 · TailwindCSS · mammoth.js · lucide-react
