#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
数学错题本 - 轻量后端

能力：
  1) 托管静态页面（手机拍照端 / Web 管理端）
  2) POST /api/upload    接收题目图片，保存并调用 Gemini 视觉模型识别题目
  3) GET  /api/questions 读取题库
  4) POST /api/questions 更新/删除题目
  5) GET  /api/status    检查 API Key 配置状态与连通性

运行:  python3 server.py
依赖:  仅标准库（urllib / json / http.server）
配置:  复制 config.example.json 为 config.json，填入 Gemini API Key
"""

import os
import re
import json
import ssl
import base64
import uuid
import datetime
import certifi
import urllib.request
import urllib.error
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(BASE_DIR, "data")
UPLOAD_DIR = os.path.join(BASE_DIR, "uploads")
QUESTIONS_FILE = os.path.join(DATA_DIR, "questions.json")
PAPERS_FILE = os.path.join(DATA_DIR, "papers.json")
CONFIG_FILE = os.path.join(BASE_DIR, "config.json")

for d in (DATA_DIR, UPLOAD_DIR):
    os.makedirs(d, exist_ok=True)

GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models"

# macOS 上 Python 常因证书链不完整导致 SSL 验证失败（尤其公司网络有代理时）。
# 优先用 certifi 的证书；不可用时降级为不验证（仅本机工具，可接受）。
def build_ssl_context():
    try:
        return ssl.create_default_context(cafile=certifi.where())
    except Exception:
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        return ctx

SSL_CTX = build_ssl_context()

# 识别题目用的提示词：输出结构化 JSON，公式用 LaTeX，同时给出答案
OCR_PROMPT = """你是一个专业的中小学数学题目识别助手。请仔细识别这张图片中的数学题目，并给出答案。

要求：
1. 用 LaTeX 表示所有数学公式、符号、分数、根号、上下标等，行内公式用 $...$ 包裹，独立公式用 $$...$$ 包裹。
2. 如果图片中有几何图形、函数图像、表格等，在 figure_desc 中详细描述其关键特征（如三角形的顶点、已知角度、边长标注、坐标系关键点等）。
3. 只输出题目本身。如果图片上有手写的答案、解题过程或批改痕迹，请忽略它们。
4. 题目文字用中文输出，保持原题的意思和表述。
5. 根据题目内容判断所属知识点。
6. 在 answer 中给出最终答案。**只要得数，不要解题过程**。
   - 若有多个小问，按题号分行给出，如："(1) $x=2$ 或 $x=3$\\n(2) $20\\text{ cm}^2$"
   - 答案中的数学部分同样用 LaTeX 表示。
   - 若题目是证明题或开放题无法给出单一得数，则给出结论性答案。
   - 若确实无法作答，answer 填空字符串。

严格按以下 JSON 格式输出，不要输出任何其他内容：
{
  "text": "题目的完整文字内容，数学部分用 LaTeX",
  "has_figure": true或false,
  "figure_desc": "图形详细描述，没有图形则为空字符串",
  "topic": "知识点分类，如：一元二次方程 / 平面几何 / 分数运算 / 概率统计",
  "answer": "最终答案，只要得数不要过程，数学部分用 LaTeX"
}
"""

SIMILAR_QUESTION_PROMPT = """你是一名中小学数学老师。请根据给出的原题，生成一道知识点、题型和难度相当，但题干情境、数据和答案均不同的新题。

要求：
1. 必须是一道可独立作答的数学题，不要提及“原题”“改编”等字样。
2. 保留原题的知识点与题型；替换所有关键数字、情境或选项，避免与原题答案相同。
3. 所有数学公式用 LaTeX 表示，行内公式用 $...$ 包裹，独立公式用 $$...$$ 包裹。
4. answer 只给最终答案，不写过程；选择题只写选项字母。
5. 严格只输出以下 JSON，不要 Markdown 或其他文字：
{
  "text": "新题完整文字",
  "topic": "知识点",
  "answer": "最终答案"
}
"""

CLEAN_FIGURE_PROMPT = """你是一名严谨的数学教材插图重绘员。请从图片中提取题目原本印刷的几何图、函数图像、坐标图或表格，并重绘为干净的 SVG。

要求：
1. 只重绘题目原有的图形和印刷标注；彻底忽略手写答案、手写辅助线、圈画、勾叉、批改痕迹和污渍。
2. 必须保留原图中与解题有关的顶点字母、边长、角度、箭头、虚实线、坐标轴、刻度和表格文字。
3. 图形要清晰、黑白、适合 A4 打印；使用 viewBox，文字使用常见字体，避免外部图片和外部链接。
4. 若图片中没有可重绘的数学插图，输出空字符串。
5. 只输出完整 <svg ...>...</svg> 内容，不要 Markdown、解释或代码围栏。
"""

CLEAN_ORIGINAL_PROMPT = """请从这张做过的数学题照片中提取题目原有的数学插图，并输出一张清洁、紧凑裁切后的图形图片。

要求：
1. 只保留几何图、函数图像、坐标图或表格本身；紧贴图形内容裁切，并留少量干净白边。
2. 删除题号、题干文字、选项、解题要求、原印刷答案，以及图形区域外的一切内容。
3. 保留图形内部和紧邻图形的必要印刷标注：顶点字母、边长、角度、箭头、虚实线、坐标轴、刻度和表格内容。
4. 彻底移除手写答案、手写辅助线、涂改、圈画、勾叉、批改符号和污渍。
5. 不要添加任何新图形、新文字或装饰；不要改变保留下来的印刷线条和标注的位置。
6. 输出清晰的彩色或灰度图形，适合在 A4 试卷中使用。
"""


# ---------------- 配置 ----------------
def load_config():
    cfg = {}
    if os.path.exists(CONFIG_FILE):
        try:
            with open(CONFIG_FILE, "r", encoding="utf-8") as f:
                cfg = json.load(f)
        except Exception:
            cfg = {}
    # 环境变量优先，方便临时覆盖
    key = os.environ.get("GEMINI_API_KEY") or cfg.get("gemini_api_key", "")
    model = os.environ.get("GEMINI_MODEL") or cfg.get("model", "gemini-2.0-flash")
    image_model = os.environ.get("GEMINI_IMAGE_MODEL") or cfg.get("image_model", "gemini-3.1-flash-image")
    key = (key or "").strip()
    # 排除示例模板里的占位符
    if "在这里填入" in key or "YOUR_" in key.upper() or len(key) < 20:
        key = ""
    return {
        "api_key": key,
        "model": (model or "gemini-2.0-flash").strip(),
        "image_model": (image_model or "gemini-3.1-flash-image").strip(),
        "port": int(cfg.get("port", 8788)),
    }


# ---------------- 题库 ----------------
def load_questions():
    if not os.path.exists(QUESTIONS_FILE):
        return []
    try:
        with open(QUESTIONS_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, list) else []
    except Exception:
        return []


def save_questions(items):
    with open(QUESTIONS_FILE, "w", encoding="utf-8") as f:
        json.dump(items, f, ensure_ascii=False, indent=2)


def load_papers():
    if not os.path.exists(PAPERS_FILE):
        return []
    try:
        with open(PAPERS_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, list) else []
    except Exception:
        return []


def save_papers(items):
    with open(PAPERS_FILE, "w", encoding="utf-8") as f:
        json.dump(items, f, ensure_ascii=False, indent=2)


def normalize_question(item):
    item = item if isinstance(item, dict) else {}
    return {
        "id": str(item.get("id") or ("q_" + uuid.uuid4().hex[:10])),
        "image": str(item.get("image", "")).strip(),
        "text": str(item.get("text", "")).strip(),
        "has_figure": bool(item.get("has_figure", False)),
        "figure_desc": str(item.get("figure_desc", "")).strip(),
        "topic": str(item.get("topic", "")).strip(),
        "answer": str(item.get("answer", "")).strip(),
        "status": str(item.get("status", "learning")).strip() or "learning",
        "streak": int(item.get("streak", 0) or 0),
        "history": item.get("history") if isinstance(item.get("history"), list) else [],
        "cleanFigureSvg": str(item.get("cleanFigureSvg", "")).strip(),
        "cleanOriginalImage": str(item.get("cleanOriginalImage", "")).strip(),
        "createdAt": str(item.get("createdAt", "")).strip() or now_iso(),
        "ocrError": str(item.get("ocrError", "")).strip(),
    }


def normalize_paper_item(item):
    item = item if isinstance(item, dict) else {}
    source_id = str(item.get("sourceId") or item.get("id") or "").strip()
    return {
        "id": str(item.get("id") or source_id or ("paper_q_" + uuid.uuid4().hex[:10])),
        "sourceId": source_id,
        "image": str(item.get("image", "")).strip(),
        "text": str(item.get("text", "")).strip(),
        "topic": str(item.get("topic", "")).strip(),
        "answer": str(item.get("answer", "")).strip(),
        "cleanFigureSvg": str(item.get("cleanFigureSvg", "")).strip(),
        "cleanOriginalImage": str(item.get("cleanOriginalImage", "")).strip(),
        "result": item.get("result") if isinstance(item.get("result"), bool) else None,
    }


def normalize_paper(item):
    item = item if isinstance(item, dict) else {}
    items = item.get("items") if isinstance(item.get("items"), list) else []
    return {
        "id": str(item.get("id") or ("paper_" + uuid.uuid4().hex[:10])),
        "createdAt": str(item.get("createdAt", "")).strip() or now_iso(),
        "completedAt": str(item.get("completedAt", "")).strip(),
        "status": "completed" if item.get("status") == "completed" else "pending",
        "items": [normalize_paper_item(q) for q in items if isinstance(q, dict)],
    }


def now_iso():
    return datetime.datetime.now().isoformat(timespec="seconds")


# ---------------- Gemini 调用 ----------------
def gemini_generate(api_key, model, parts, timeout=90, generation_config=None):
    """调用 Gemini generateContent。parts 为内容片段列表。"""
    url = f"{GEMINI_BASE}/{model}:generateContent?key={api_key}"
    payload = {"contents": [{"parts": parts}]}
    if generation_config:
        payload["generationConfig"] = generation_config
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url, data=body,
        headers={"Content-Type": "application/json"},
        method="POST"
    )
    with urllib.request.urlopen(req, timeout=timeout, context=SSL_CTX) as resp:
        return json.loads(resp.read().decode("utf-8"))


def extract_text(resp):
    """从 Gemini 响应中取出文本。"""
    try:
        parts = resp["candidates"][0]["content"]["parts"]
        return "".join(p.get("text", "") for p in parts)
    except Exception:
        return ""


def extract_inline_image(resp):
    """取出 Gemini 图像编辑响应的第一个图片片段。"""
    try:
        parts = resp["candidates"][0]["content"]["parts"]
    except Exception:
        return None, None
    for part in parts:
        inline = part.get("inlineData") or part.get("inline_data")
        if not isinstance(inline, dict):
            continue
        data = inline.get("data", "")
        mime_type = inline.get("mimeType") or inline.get("mime_type") or "image/png"
        if not data:
            continue
        try:
            return base64.b64decode(data), str(mime_type)
        except Exception:
            continue
    return None, None


def parse_json_loose(text):
    """模型可能用 ```json 包裹，做一次宽松解析。"""
    if not text:
        return None
    cleaned = text.strip()
    cleaned = re.sub(r"^```(?:json)?", "", cleaned).strip()
    cleaned = re.sub(r"```$", "", cleaned).strip()
    try:
        return json.loads(cleaned)
    except Exception:
        m = re.search(r"\{.*\}", cleaned, re.S)
        if m:
            try:
                return json.loads(m.group(0))
            except Exception:
                return None
    return None


def ocr_question(api_key, model, image_bytes, mime_type):
    """识别单张题目图片，返回 (结构化字典, 错误信息)。"""
    b64 = base64.b64encode(image_bytes).decode("ascii")
    parts = [
        {"text": OCR_PROMPT},
        {"inline_data": {"mime_type": mime_type, "data": b64}},
    ]
    try:
        resp = gemini_generate(api_key, model, parts)
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "ignore")[:500]
        return None, f"Gemini HTTP {e.code}: {detail}"
    except Exception as e:
        return None, f"请求失败: {e}"

    raw = extract_text(resp)
    data = parse_json_loose(raw)
    if not isinstance(data, dict):
        return None, f"模型返回无法解析: {raw[:300]}"
    return {
        "text": str(data.get("text", "")).strip(),
        "has_figure": bool(data.get("has_figure", False)),
        "figure_desc": str(data.get("figure_desc", "")).strip(),
        "topic": str(data.get("topic", "")).strip(),
        "answer": str(data.get("answer", "")).strip(),
    }, None


def generate_similar_question(api_key, model, text, topic, answer):
    """根据原题生成一道同类型新题，只返回试卷中需要的文字信息。"""
    source = (
        f"知识点：{topic or '请根据题目判断'}\n"
        f"原题：{text}\n"
        f"原题答案（仅用于避免重复）：{answer or '未知'}"
    )
    try:
        resp = gemini_generate(api_key, model, [
            {"text": SIMILAR_QUESTION_PROMPT},
            {"text": source},
        ])
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "ignore")[:500]
        return None, f"Gemini HTTP {e.code}: {detail}"
    except Exception as e:
        return None, f"请求失败: {e}"

    data = parse_json_loose(extract_text(resp))
    if not isinstance(data, dict) or not str(data.get("text", "")).strip():
        return None, "模型未返回有效题目"
    return {
        "text": str(data.get("text", "")).strip(),
        "topic": str(data.get("topic", topic)).strip() or topic,
        "answer": str(data.get("answer", "")).strip(),
    }, None


def extract_svg(text):
    """只保留模型返回的 SVG 主体，并移除不需要的可执行内容。"""
    if not text:
        return ""
    match = re.search(r"<svg\b[^>]*>[\s\S]*?</svg>", text, re.I)
    if not match:
        return ""
    svg = match.group(0)
    svg = re.sub(r"<(?:script|foreignObject)\b[^>]*>[\s\S]*?</(?:script|foreignObject)>", "", svg, flags=re.I)
    svg = re.sub(r"\son\w+\s*=\s*(?:\"[^\"]*\"|'[^']*'|[^\s>]+)", "", svg, flags=re.I)
    svg = re.sub(r"\s(?:href|xlink:href)\s*=\s*(?:\"[^\"]*\"|'[^']*'|[^\s>]+)", "", svg, flags=re.I)
    return svg[:100000]


def clean_figure(api_key, model, image_bytes, mime_type):
    """根据含手写痕迹的原图生成无笔迹的题目插图 SVG。"""
    parts = [
        {"text": CLEAN_FIGURE_PROMPT},
        {"inline_data": {"mime_type": mime_type, "data": base64.b64encode(image_bytes).decode("ascii")}},
    ]
    try:
        response = gemini_generate(api_key, model, parts)
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "ignore")[:500]
        return "", f"Gemini HTTP {e.code}: {detail}"
    except Exception as e:
        return "", f"请求失败: {e}"
    svg = extract_svg(extract_text(response))
    if not svg:
        return "", "未识别到可重绘的题目插图"
    return svg, None


def clean_original_image(api_key, model, image_bytes, mime_type):
    """调用图像编辑模型，在尽量保留印刷原图的前提下去除手写痕迹。"""
    parts = [
        {"text": CLEAN_ORIGINAL_PROMPT},
        {"inline_data": {"mime_type": mime_type, "data": base64.b64encode(image_bytes).decode("ascii")}},
    ]
    try:
        response = gemini_generate(
            api_key, model, parts, timeout=120,
            generation_config={"responseModalities": ["IMAGE"]}
        )
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "ignore")[:500]
        return None, None, f"Gemini HTTP {e.code}: {detail}"
    except Exception as e:
        return None, None, f"请求失败: {e}"
    image_data, output_mime = extract_inline_image(response)
    if not image_data:
        return None, None, "图像模型未返回清洁后的图片"
    return image_data, output_mime, None


# ---------------- HTTP ----------------
class Handler(BaseHTTPRequestHandler):
    def _send_json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def _send_file(self, fpath, mime):
        try:
            with open(fpath, "rb") as f:
                data = f.read()
        except Exception:
            self._send_json({"error": "not found"}, 404)
            return
        self.send_response(200)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Access-Control-Allow-Origin", "*")
        # 本地工具类：禁用缓存，改完代码刷新即生效
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
        self.end_headers()
        self.wfile.write(data)

    def _serve_static(self, path):
        if path in ("", "/"):
            path = "/index.html"
        rel = path.lstrip("/")
        if rel == "" or rel.endswith("/"):
            rel += "index.html"
        safe = os.path.normpath(rel).replace("\\", "/")
        if safe.startswith("..") or os.path.isabs(safe):
            self._send_json({"error": "forbidden"}, 403)
            return
        fpath = os.path.join(BASE_DIR, safe)
        if not os.path.isfile(fpath):
            self._send_json({"error": "not found"}, 404)
            return
        ext = os.path.splitext(fpath)[1].lower()
        mime = {
            ".html": "text/html; charset=utf-8",
            ".css": "text/css; charset=utf-8",
            ".js": "application/javascript; charset=utf-8",
            ".json": "application/json; charset=utf-8",
            ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
            ".svg": "image/svg+xml", ".ico": "image/x-icon",
        }.get(ext, "application/octet-stream")
        self._send_file(fpath, mime)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)
        p = parsed.path
        cfg = load_config()

        if p == "/api/status":
            has_key = bool(cfg["api_key"])
            self._send_json({
                "configured": has_key,
                "model": cfg["model"],
                "questions": len(load_questions()),
            })
            return

        if p == "/api/questions":
            self._send_json({"questions": [normalize_question(q) for q in load_questions()]})
            return

        if p == "/api/papers":
            papers = [normalize_paper(item) for item in load_papers()]
            papers.sort(key=lambda item: item["createdAt"], reverse=True)
            self._send_json({"papers": papers})
            return

        if p == "/api/paper":
            paper_id = (parse_qs(parsed.query).get("id") or [""])[0].strip()
            for item in load_papers():
                paper = normalize_paper(item)
                if paper["id"] == paper_id:
                    self._send_json({"paper": paper})
                    return
            self._send_json({"error": "paper not found"}, 404)
            return

        if p == "/api/test":
            if not cfg["api_key"]:
                self._send_json({"ok": False, "error": "未配置 API Key"}, 400)
                return
            try:
                resp = gemini_generate(cfg["api_key"], cfg["model"],
                                       [{"text": "回复两个字：正常"}], timeout=30)
                self._send_json({"ok": True, "reply": extract_text(resp).strip()[:100]})
            except urllib.error.HTTPError as e:
                self._send_json({"ok": False,
                                 "error": f"HTTP {e.code}: " + e.read().decode("utf-8", "ignore")[:300]})
            except Exception as e:
                self._send_json({"ok": False, "error": str(e)})
            return

        self._serve_static(p)

    def do_POST(self):
        parsed = urlparse(self.path)
        p = parsed.path
        cfg = load_config()

        if p == "/api/upload":
            if not cfg["api_key"]:
                self._send_json({"error": "未配置 Gemini API Key，请填写 config.json"}, 400)
                return
            try:
                length = int(self.headers.get("Content-Length", "0"))
                raw = self.rfile.read(length) if length else b"{}"
                payload = json.loads(raw.decode("utf-8"))
            except Exception as e:
                self._send_json({"error": f"请求解析失败: {e}"}, 400)
                return

            data_url = payload.get("image", "")
            m = re.match(r"^data:(image/[\w.+-]+);base64,(.*)$", data_url, re.S)
            if not m:
                self._send_json({"error": "图片格式不正确"}, 400)
                return
            mime_type, b64 = m.group(1), m.group(2)
            try:
                img_bytes = base64.b64decode(b64)
            except Exception:
                self._send_json({"error": "图片解码失败"}, 400)
                return

            # 保存原图
            ext = ".jpg" if "jpeg" in mime_type or "jpg" in mime_type else ".png"
            fname = f"{datetime.datetime.now().strftime('%Y%m%d_%H%M%S')}_{uuid.uuid4().hex[:6]}{ext}"
            fpath = os.path.join(UPLOAD_DIR, fname)
            with open(fpath, "wb") as f:
                f.write(img_bytes)

            # 调用 Gemini 识别
            info, err = ocr_question(cfg["api_key"], cfg["model"], img_bytes, mime_type)

            item = normalize_question({
                "id": "q_" + uuid.uuid4().hex[:10],
                "image": "uploads/" + fname,
                "text": info["text"] if info else "",
                "has_figure": info["has_figure"] if info else False,
                "figure_desc": info["figure_desc"] if info else "",
                "topic": info["topic"] if info else "",
                "answer": info["answer"] if info else "",
                "status": "learning",   # learning / mastered
                "streak": 0,
                "history": [],
                "createdAt": now_iso(),
                "ocrError": err or "",
            })

            items = load_questions()
            items.append(item)
            save_questions(items)

            self._send_json({"ok": True, "question": item, "error": err})
            return

        if p == "/api/questions":
            try:
                length = int(self.headers.get("Content-Length", "0"))
                raw = self.rfile.read(length) if length else b"{}"
                payload = json.loads(raw.decode("utf-8"))
            except Exception as e:
                self._send_json({"error": f"请求解析失败: {e}"}, 400)
                return
            if not isinstance(payload.get("questions"), list):
                self._send_json({"error": "questions must be array"}, 400)
                return
            items = [normalize_question(q) for q in payload["questions"]]
            save_questions(items)
            self._send_json({"ok": True, "count": len(items)})
            return

        if p == "/api/question":
            try:
                length = int(self.headers.get("Content-Length", "0"))
                raw = self.rfile.read(length) if length else b"{}"
                payload = json.loads(raw.decode("utf-8"))
            except Exception as e:
                self._send_json({"error": f"请求解析失败: {e}"}, 400)
                return
            qid = str(payload.get("id", "")).strip()
            if not qid:
                self._send_json({"error": "id is required"}, 400)
                return
            items = load_questions()
            updated = None
            for i, item in enumerate(items):
                if str(item.get("id", "")).strip() == qid:
                    merged = dict(item)
                    if "text" in payload:
                        merged["text"] = payload.get("text", "")
                    if "answer" in payload:
                        merged["answer"] = payload.get("answer", "")
                    if "topic" in payload:
                        merged["topic"] = payload.get("topic", "")
                    if "status" in payload:
                        merged["status"] = payload.get("status", "learning")
                    updated = normalize_question(merged)
                    items[i] = updated
                    break
            if updated is None:
                self._send_json({"error": "question not found"}, 404)
                return
            save_questions(items)
            self._send_json({"ok": True, "question": updated})
            return

        if p == "/api/question/clean-figure":
            if not cfg["api_key"]:
                self._send_json({"error": "未配置 Gemini API Key，无法生成清洁图"}, 400)
                return
            try:
                length = int(self.headers.get("Content-Length", "0"))
                raw = self.rfile.read(length) if length else b"{}"
                payload = json.loads(raw.decode("utf-8"))
            except Exception as e:
                self._send_json({"error": f"请求解析失败: {e}"}, 400)
                return
            qid = str(payload.get("id", "")).strip()
            items = load_questions()
            question_index = next((i for i, item in enumerate(items) if str(item.get("id", "")).strip() == qid), -1)
            if question_index < 0:
                self._send_json({"error": "question not found"}, 404)
                return
            question = normalize_question(items[question_index])
            if not question["has_figure"]:
                self._send_json({"error": "该题未被识别为含插图题目"}, 400)
                return
            image_rel = os.path.normpath(question["image"]).replace("\\", "/")
            if not image_rel.startswith("uploads/") or image_rel.startswith("../"):
                self._send_json({"error": "原题图片不可用"}, 400)
                return
            image_path = os.path.join(BASE_DIR, image_rel)
            try:
                with open(image_path, "rb") as f:
                    image_bytes = f.read()
            except Exception:
                self._send_json({"error": "未找到原题图片"}, 404)
                return
            ext = os.path.splitext(image_path)[1].lower()
            mime_type = "image/png" if ext == ".png" else "image/jpeg"
            svg, err = clean_figure(cfg["api_key"], cfg["model"], image_bytes, mime_type)
            if err:
                self._send_json({"error": err}, 502)
                return
            question["cleanFigureSvg"] = svg
            items[question_index] = question
            save_questions(items)
            self._send_json({"ok": True, "question": question})
            return

        if p == "/api/question/clean-original":
            if not cfg["api_key"]:
                self._send_json({"error": "未配置 Gemini API Key，无法清洁原图"}, 400)
                return
            try:
                length = int(self.headers.get("Content-Length", "0"))
                raw = self.rfile.read(length) if length else b"{}"
                payload = json.loads(raw.decode("utf-8"))
            except Exception as e:
                self._send_json({"error": f"请求解析失败: {e}"}, 400)
                return
            qid = str(payload.get("id", "")).strip()
            items = load_questions()
            question_index = next((i for i, item in enumerate(items) if str(item.get("id", "")).strip() == qid), -1)
            if question_index < 0:
                self._send_json({"error": "question not found"}, 404)
                return
            question = normalize_question(items[question_index])
            if not question["has_figure"]:
                self._send_json({"error": "该题未被识别为含插图题目"}, 400)
                return
            image_rel = os.path.normpath(question["image"]).replace("\\", "/")
            if not image_rel.startswith("uploads/") or image_rel.startswith("../"):
                self._send_json({"error": "原题图片不可用"}, 400)
                return
            image_path = os.path.join(BASE_DIR, image_rel)
            try:
                with open(image_path, "rb") as f:
                    image_bytes = f.read()
            except Exception:
                self._send_json({"error": "未找到原题图片"}, 404)
                return
            ext = os.path.splitext(image_path)[1].lower()
            mime_type = "image/png" if ext == ".png" else "image/jpeg"
            image_data, output_mime, err = clean_original_image(
                cfg["api_key"], cfg["image_model"], image_bytes, mime_type
            )
            if err:
                self._send_json({"error": err}, 502)
                return
            out_ext = ".png" if "png" in (output_mime or "").lower() else ".jpg"
            filename = f"cleaned_{datetime.datetime.now().strftime('%Y%m%d_%H%M%S')}_{uuid.uuid4().hex[:6]}{out_ext}"
            with open(os.path.join(UPLOAD_DIR, filename), "wb") as f:
                f.write(image_data)
            question["cleanOriginalImage"] = "uploads/" + filename
            items[question_index] = question
            save_questions(items)
            self._send_json({"ok": True, "question": question})
            return

        if p == "/api/generate-similar":
            if not cfg["api_key"]:
                self._send_json({"error": "未配置 Gemini API Key，无法生成同类题"}, 400)
                return
            try:
                length = int(self.headers.get("Content-Length", "0"))
                raw = self.rfile.read(length) if length else b"{}"
                payload = json.loads(raw.decode("utf-8"))
            except Exception as e:
                self._send_json({"error": f"请求解析失败: {e}"}, 400)
                return
            text = str(payload.get("text", "")).strip()
            if not text:
                self._send_json({"error": "原题内容不能为空"}, 400)
                return
            question, err = generate_similar_question(
                cfg["api_key"], cfg["model"], text,
                str(payload.get("topic", "")).strip(),
                str(payload.get("answer", "")).strip(),
            )
            if err:
                self._send_json({"error": err}, 502)
                return
            self._send_json({"ok": True, "question": question})
            return

        if p == "/api/paper":
            try:
                length = int(self.headers.get("Content-Length", "0"))
                raw = self.rfile.read(length) if length else b"{}"
                payload = json.loads(raw.decode("utf-8"))
            except Exception as e:
                self._send_json({"error": f"请求解析失败: {e}"}, 400)
                return
            paper = normalize_paper({"items": payload.get("items", [])})
            if not paper["items"]:
                self._send_json({"error": "试卷至少需要一道题"}, 400)
                return
            papers = load_papers()
            papers.append(paper)
            save_papers(papers)
            self._send_json({"ok": True, "paper": paper})
            return

        if p == "/api/paper/delete":
            try:
                length = int(self.headers.get("Content-Length", "0"))
                raw = self.rfile.read(length) if length else b"{}"
                payload = json.loads(raw.decode("utf-8"))
            except Exception as e:
                self._send_json({"error": f"请求解析失败: {e}"}, 400)
                return
            paper_id = str(payload.get("id", "")).strip()
            papers = load_papers()
            remaining = [item for item in papers if str(item.get("id", "")).strip() != paper_id]
            if len(remaining) == len(papers):
                self._send_json({"error": "paper not found"}, 404)
                return
            save_papers(remaining)
            self._send_json({"ok": True})
            return

        if p == "/api/paper/mark":
            try:
                length = int(self.headers.get("Content-Length", "0"))
                raw = self.rfile.read(length) if length else b"{}"
                payload = json.loads(raw.decode("utf-8"))
            except Exception as e:
                self._send_json({"error": f"请求解析失败: {e}"}, 400)
                return
            paper_id = str(payload.get("id", "")).strip()
            results = payload.get("results") if isinstance(payload.get("results"), list) else []
            papers = load_papers()
            paper_index = next((i for i, item in enumerate(papers) if str(item.get("id", "")).strip() == paper_id), -1)
            if paper_index < 0:
                self._send_json({"error": "paper not found"}, 404)
                return
            paper = normalize_paper(papers[paper_index])
            if paper["status"] == "completed":
                self._send_json({"error": "这份试卷已经批改完成"}, 409)
                return
            result_by_source = {
                str(item.get("sourceId", "")).strip(): item.get("correct")
                for item in results
                if isinstance(item, dict) and isinstance(item.get("correct"), bool)
            }
            expected_sources = [item["sourceId"] for item in paper["items"] if item["sourceId"]]
            if len(result_by_source) != len(expected_sources) or any(source not in result_by_source for source in expected_sources):
                self._send_json({"error": "请先完成每道题的批改"}, 400)
                return

            completed_at = now_iso()
            questions = load_questions()
            question_by_id = {str(item.get("id", "")).strip(): item for item in questions}
            for paper_item in paper["items"]:
                source_id = paper_item["sourceId"]
                correct = result_by_source[source_id]
                paper_item["result"] = correct
                question = question_by_id.get(source_id)
                if question is None:
                    continue
                normalized = normalize_question(question)
                history = normalized["history"]
                history.append({"at": completed_at, "correct": correct, "paperId": paper_id})
                normalized["history"] = history
                normalized["streak"] = normalized["streak"] + 1 if correct else 0
                normalized["status"] = "mastered" if normalized["streak"] >= 3 else "learning"
                question.update(normalized)

            paper["status"] = "completed"
            paper["completedAt"] = completed_at
            papers[paper_index] = paper
            save_questions(questions)
            save_papers(papers)
            self._send_json({"ok": True, "paper": paper})
            return

        self._send_json({"error": "not found"}, 404)

    def log_message(self, fmt, *args):
        pass


def main():
    cfg = load_config()
    port = int(os.environ.get("PORT", cfg["port"]))
    if not cfg["api_key"]:
        print("⚠️  未检测到 API Key：请复制 config.example.json 为 config.json 并填入 Gemini API Key")
    else:
        print(f"✅ 已加载 API Key，模型: {cfg['model']}")
    server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    print(f"错题本服务已启动")
    print(f"  手机拍照: http://<本机IP>:{port}/")
    print(f"  Web 管理: http://<本机IP>:{port}/admin.html")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        server.shutdown()


if __name__ == "__main__":
    main()
