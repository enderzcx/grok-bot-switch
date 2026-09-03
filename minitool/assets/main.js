/* Grok Bot Switch 使用向导 — 经典脚本，ES2017，纯本地运行。 */
(function () {
  "use strict";

  var DOWNLOAD_URL = "https://raw.githubusercontent.com/enderzcx/grok-bot-switch/main/dist/grok-switch.cjs";
  var TOOL_PATH = "/workspace/grok-switch/grok-switch.cjs";
  var STORAGE_KEY = "grok-switch-guide-v1";
  var DEFAULT_PATHS = {
    "openai-chat": "/chat/completions",
    "openai-responses": "/responses",
    "anthropic-messages": "/messages"
  };
  var MODE_DESC = {
    panel: "Grok Bot 装好后在它的云端电脑上打开配置面板（地址固定为 127.0.0.1:18990），你在 Grok Bot 的云端桌面里选预设、拉模型列表、测试、切换。API key 不经过聊天记录。",
    direct: "把供应商信息写进提示词，Grok Bot 下载、测试、切换一步完成。留空的项它会在对话里问你。"
  };

  var mode = "panel";

  function byId(id) {
    return document.getElementById(id);
  }

  function supportsFlexGap() {
    var flex = document.createElement("div");
    flex.style.position = "absolute";
    flex.style.visibility = "hidden";
    flex.style.display = "flex";
    flex.style.flexDirection = "column";
    flex.style.rowGap = "1px";
    flex.appendChild(document.createElement("div"));
    flex.appendChild(document.createElement("div"));
    document.body.appendChild(flex);
    var supported = flex.scrollHeight === 1;
    flex.parentNode.removeChild(flex);
    return supported;
  }

  function shellQuote(value) {
    // Single-quote for a POSIX shell; only needed when the value has spaces or quotes.
    if (/^[A-Za-z0-9._:\/@%+=,-]+$/.test(value)) return value;
    return "'" + value.replace(/'/g, "'\\''") + "'";
  }

  function downloadCommand() {
    return "mkdir -p /workspace/grok-switch && curl -fsSL \"" + DOWNLOAD_URL + "?v=$(date +%s)\" -o " + TOOL_PATH;
  }

  function fieldValue(id) {
    var el = byId(id);
    return el ? el.value.trim() : "";
  }

  function buildPanelPrompt() {
    return [
      "请在你的云端电脑执行下面这条命令，把输出里的面板地址在你的浏览器里打开，然后告诉我“面板已打开，请在云端桌面里配置”。不要做别的事：",
      "",
      downloadCommand() + " && node " + TOOL_PATH + " install"
    ].join("\n");
  }

  function buildDirectPrompt() {
    var name = fieldValue("f-name") || "myapi";
    var protocol = fieldValue("f-protocol") || "openai-chat";
    var url = fieldValue("f-url");
    var model = fieldValue("f-model");
    var key = fieldValue("f-key");
    var missing = [];
    if (!url) missing.push("接口根地址");
    if (!model) missing.push("模型名");
    if (!key) missing.push("API key");

    var args = [
      "use", name,
      "--protocol", protocol,
      "--url", url ? shellQuote(url) : "<接口根地址>",
      "--model", model ? shellQuote(model) : "<模型>",
      "--key", key ? shellQuote(key) : "<API key>"
    ];
    var lines = [];
    if (missing.length > 0) {
      lines.push("我要让你改用我自己的模型接口。请先在对话里向我确认这些信息：" + missing.join("、") + "。拿到后把下面命令里的尖括号占位符替换成我给的值，在你的云端电脑执行，然后把完整输出原样发给我：");
    } else {
      lines.push("请在你的云端电脑执行下面这条命令，然后把完整输出原样发给我，不要做别的事：");
    }
    lines.push("");
    lines.push(downloadCommand() + " && node " + TOOL_PATH + " " + args.join(" "));
    return lines.join("\n");
  }

  function renderPrompt() {
    var text = mode === "panel" ? buildPanelPrompt() : buildDirectPrompt();
    var box = byId("prompt");
    box.value = text;
    // Grow to fit so nothing is hidden behind a scrollbar the user cannot see.
    box.style.height = "auto";
    box.style.height = (box.scrollHeight + 2) + "px";
  }

  function renderUrlHint() {
    var protocol = fieldValue("f-protocol") || "openai-chat";
    var base = fieldValue("f-url") || "https://api.example.com/v1";
    byId("url-hint").textContent = "实际请求 " + base.replace(/\/+$/, "") + DEFAULT_PATHS[protocol];
  }

  function setMode(next) {
    mode = next;
    var items = document.querySelectorAll(".segment-item");
    for (var i = 0; i < items.length; i += 1) {
      items[i].classList.toggle("is-active", items[i].getAttribute("data-mode") === next);
    }
    byId("mode-desc").textContent = MODE_DESC[next];
    byId("direct-form-card").hidden = next !== "direct";
    renderPrompt();
    save();
  }

  function setView(name) {
    var tabs = document.querySelectorAll(".tab");
    for (var i = 0; i < tabs.length; i += 1) {
      tabs[i].classList.toggle("is-active", tabs[i].getAttribute("data-view") === name);
    }
    var views = document.querySelectorAll(".view");
    for (var j = 0; j < views.length; j += 1) {
      views[j].classList.toggle("is-active", views[j].id === "view-" + name);
    }
    window.scrollTo(0, 0);
    save();
  }

  function currentView() {
    var active = document.querySelector(".tab.is-active");
    return active ? active.getAttribute("data-view") : "install";
  }

  function save() {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify({
        mode: mode,
        view: currentView(),
        name: fieldValue("f-name"),
        protocol: fieldValue("f-protocol"),
        url: fieldValue("f-url"),
        model: fieldValue("f-model")
        // API key 故意不保存
      }));
    } catch (error) {
      // 存储不可用时静默忽略
    }
  }

  function restore() {
    var saved = null;
    try {
      saved = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || "null");
    } catch (error) {
      saved = null;
    }
    if (!saved || typeof saved !== "object") return;
    if (saved.name) byId("f-name").value = saved.name;
    if (saved.protocol && DEFAULT_PATHS[saved.protocol]) byId("f-protocol").value = saved.protocol;
    if (saved.url) byId("f-url").value = saved.url;
    if (saved.model) byId("f-model").value = saved.model;
    if (saved.mode === "direct") mode = "direct";
    if (saved.view && byId("view-" + saved.view)) setView(saved.view);
  }

  function selectPrompt() {
    var box = byId("prompt");
    box.focus();
    box.setSelectionRange(0, box.value.length);
    byId("select-hint").textContent = "已全选，现在长按选中的文字选择“复制”。";
  }

  function bind() {
    byId("tabs").addEventListener("click", function (event) {
      var target = event.target;
      while (target && target !== this) {
        if (target.classList && target.classList.contains("tab")) {
          setView(target.getAttribute("data-view"));
          return;
        }
        target = target.parentNode;
      }
    });

    byId("mode").addEventListener("click", function (event) {
      var target = event.target;
      while (target && target !== this) {
        if (target.classList && target.classList.contains("segment-item")) {
          setMode(target.getAttribute("data-mode"));
          return;
        }
        target = target.parentNode;
      }
    });

    var form = byId("direct-form");
    form.addEventListener("submit", function (event) {
      event.preventDefault();
    });
    form.addEventListener("input", function () {
      renderUrlHint();
      renderPrompt();
      save();
    });
    form.addEventListener("change", function () {
      renderUrlHint();
      renderPrompt();
      save();
    });

    byId("select-all").addEventListener("click", selectPrompt);
    byId("prompt").addEventListener("focus", function () {
      byId("select-hint").textContent = "长按文字可全选并复制。";
    });
  }

  function init() {
    if (supportsFlexGap()) {
      document.documentElement.classList.add("supports-flex-gap");
    }
    bind();
    restore();
    setMode(mode);
    renderUrlHint();
    // Re-measure after fonts settle and on resize; both are cheap single passes.
    window.addEventListener("resize", renderPrompt);
    setTimeout(renderPrompt, 300);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
