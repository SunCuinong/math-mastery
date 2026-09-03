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
import base64
import uuid
import datetime
import urllib.request
import urllib.error
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(BASE_DIR, "data")
UPLOAD_DIR = os.path.join(BASE_DIR, "uploads")
QUESTIONS_FILE = os.path.join(DATA_DIR, "questions.json")
CONFIG_FILE = os.path.join(BASE_DIR, "config.json")

for d in (DATA_DIR, UPLOAD_DIR):
    os.makedirs(d, exist_ok=True)

GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models"

# 识别题目用的提示词：输出结构化 JSON，公式用 LaTeX
OCR_PROMPT = """你是一个专业的中小学数学题目识别助手。请仔细识别这张图片中的数学题目。

要求：
1. 用 LaTeX 表示所有数学公式、符号、分数、根号、上下标等，行内公式用 $...$ 包裹，独立公式用 $$...$$ 包裹。
2. 如果图片中有几何图形、函数图像、表格等，在 figure_desc 中详细描述其关键特征（如三角形的顶点、已知角度、边长标注、坐标系关键点等）。
3. 只输出题目本身。如果图片上有手写的答案、解题过程或批改痕迹，请忽略它们。
4. 题目文字用中文输出，保持原题的意思和表述。
5. 根据题目内容判断所属知识点。

严格按以下 JSON 格式输出，不要输出任何其他内容：
{
  "text": "题目的完整文字内容，数学部分用 LaTeX",
  "has_figure": true或false,
  "figure_desc": "图形详细描述，没有图形则为空字符串",
  "topic": "知识点分类，如：一元二次方程 / 平面几何 / 分数运算 / 概率统计"
}
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
    key = (key or "").strip()
    # 排除示例模板里的占位符
    if "在这里填入" in key or "YOUR_" in key.upper() or len(key) < 20:
        key = ""
    return {
        "api_key": key,
        "model": (model or "gemini-2.0-flash").strip(),
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


def now_iso():
    return datetime.datetime.now().isoformat(timespec="seconds")


# ---------------- Gemini 调用 ----------------
def gemini_generate(api_key, model, parts, timeout=90):
    """调用 Gemini generateContent。parts 为内容片段列表。"""
    url = f"{GEMINI_BASE}/{model}:generateContent?key={api_key}"
    body = json.dumps({"contents": [{"parts": parts}]}).encode("utf-8")
    req = urllib.request.Request(
        url, data=body,
        headers={"Content-Type": "application/json"},
        method="POST"
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def extract_text(resp):
    """从 Gemini 响应中取出文本。"""
    try:
        parts = resp["candidates"][0]["content"]["parts"]
        return "".join(p.get("text", "") for p in parts)
    except Exception:
        return ""


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
    }, None


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
        if not path.startswith("/wrongbook") and path != "/index.html":
            # 允许直接访问项目内静态文件
            pass
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
            self._send_json({"questions": load_questions()})
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

            item = {
                "id": "q_" + uuid.uuid4().hex[:10],
                "image": "uploads/" + fname,
                "text": info["text"] if info else "",
                "has_figure": info["has_figure"] if info else False,
                "figure_desc": info["figure_desc"] if info else "",
                "topic": info["topic"] if info else "",
                "answer": "",
                "status": "new",        # new / learning / mastered
                "streak": 0,
                "history": [],
                "createdAt": now_iso(),
                "ocrError": err or "",
            }

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
            save_questions(payload["questions"])
            self._send_json({"ok": True, "count": len(payload["questions"])})
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
