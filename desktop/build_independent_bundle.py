"""Build a reproducible, stdlib-only cloud panel and bounded installation prompt."""
import argparse
import hashlib
import json
from pathlib import Path
import sys
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from desktop.host_package import FILES, HOST_INIT

PANEL_FILES = (
    "ops/independent.py", "grokctl/independent_service.py", "grokctl/service.py",
    "grokctl/native_client_service.py", "grokctl/client_bridge.py", "grokctl/client_process.py",
    "grokctl/installation.py", "grokctl/integration.py", "grokctl/secrets.py",
    "grokctl/remote.py", "grokctl/switching.py", "grokctl/ui.py",
    "grokctl/web/index.html", "grokctl/web/app.js", "grokctl/web/styles.css",
    "THIRD_PARTY_NOTICES.md", "frontend/UPSTREAM.md", "frontend/licenses/CC-Switch-MIT.txt",
    "frontend/licenses/dependencies.txt",
)


def installation_prompt(digest, release="v0.3.0-beta.2"):
    return f'''# 给 Grok Bot 的安装提示词

只需将分隔线下方的提示词复制给 Grok Bot，不需要上传附件或在本机安装软件。
第一次安装由 Grok Bot 执行，可能消耗官方额度。不要将 API key 发到聊天中。

---

请在你自己的 Linux 云端电脑安装 Grok Bot Switch 独立面板。
只运行已提供的安装程序，不要编写、修改或下载替代代码。

允许：检查 Python 3.10+；下载并校验下面固定版本的发布包；在
`/workspace/grok-bot-switch-independent` 安装并启动仅监听 127.0.0.1 的面板。
不允许：sudo、安装系统依赖、修改 Grok Bot 客户端或云端主程序、重启主机、
读取账号/OAuth 凭据、输入供应商 Key、切换通道、发起模型请求、开放公网端口。
如果环境不满足条件、已有版本要求先停止、或者哈希不符，请报告并停止，不要自行修复。

1. 从以下精确的 GitHub 发布地址下载到新建的临时目录，不要使用 latest、main 或其它镜像：
   `https://github.com/enderzcx/grok-bot-switch/releases/download/{release}/GrokBotSwitch-independent.zip`
   只允许 HTTPS 跳转至 GitHub 的发布资产域名。下载失败则停止，不要自行寻找替代实现。
2. 先用 `sha256sum` 校验，必须精确等于：
   `{digest}`
   在校验通过之前，不得执行 ZIP 内任何代码。
3. 校验通过后运行（将下载路径替换为实际绝对路径）：
   `python3 -I /下载实际路径/GrokBotSwitch-independent.zip install --sha256 {digest}`
4. 只有 JSON 返回 `ok: true` 才算面板安装成功。不要把安装成功说成供应商切换成功。
5. 在你的云端浏览器打开返回的 `url`，让我从 Grok Bot 的云端桌面操作。
   这是云端的 127.0.0.1，不是我 Windows/Mac 本机的地址，不要让我在本机浏览器打开。
6. 读取面板状态，报告：页面能否打开、是否已就绪、若未就绪则给出原样错误原因。
   不要点击“使用”、切回官方或检查兼容性，不要重启任何工作中的 Agent。
   即使显示版本不支持，也保留已安装面板，不要打补丁或扩大支持列表。

最后只返回管理面板地址、云端状态和必要的错误信息。密钥由我之后在面板中输入。
安装到此结束。
'''


def build(root, out):
    out.mkdir(parents=True, exist_ok=True)
    archive = out / "GrokBotSwitch-independent.zip"
    names = sorted(set(FILES) | set(PANEL_FILES))
    with zipfile.ZipFile(archive, "w", zipfile.ZIP_STORED) as bundle:
        entries = {name: HOST_INIT if name == "grokctl/__init__.py" else (root / name).read_bytes()
                   for name in names}
        entries["__main__.py"] = b"from ops.independent import entrypoint\nentrypoint()\n"
        entries["ops/__init__.py"] = b""
        for name, content in sorted(entries.items()):
            info = zipfile.ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))
            info.create_system = 3
            info.external_attr = 0o100600 << 16
            bundle.writestr(info, content)
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    (out / "INSTALL-WITH-GROK.md").write_text(installation_prompt(digest), encoding="utf-8")
    (out / "SHA256SUMS.txt").write_text(digest + "  " + archive.name + "\n")
    return {"archive": str(archive), "sha256": digest, "files": len(entries)}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(build(Path(__file__).resolve().parents[1], args.output)))
