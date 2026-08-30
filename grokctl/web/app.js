(function () {
  "use strict";

  var CSRF = (document.querySelector('meta[name="csrf-token"]') || {}).content || "";
  var DEFAULT_PATHS = {
    "openai-chat": "/chat/completions",
    "openai-responses": "/responses",
    "anthropic-messages": "/messages",
  };
  var STATE_LABEL = {
    loading: "读取中",
    empty: "仅官方通道",
    healthy: "正常",
    drift: "偏差",
    blocked: "未接入",
    lab: "模拟环境",
    switching: "正在切换",
    error: "出错",
  };

  var els = {
    route: document.getElementById("route"),
    title: document.getElementById("route-title"),
    flag: document.getElementById("route-flag"),
    desired: document.getElementById("metric-desired"),
    observed: document.getElementById("metric-observed"),
    mode: document.getElementById("metric-mode"),
    fallback: document.getElementById("metric-fallback"),
    endpoint: document.getElementById("route-endpoint"),
    drift: document.getElementById("route-drift"),
    runtimeNote: document.getElementById("runtime-note"),
    listStatus: document.getElementById("list-status"),
    providers: document.getElementById("providers"),
    review: document.getElementById("review"),
    reviewTitle: document.getElementById("review-title"),
    reviewNote: document.getElementById("review-note"),
    reviewTarget: document.getElementById("review-target"),
    reviewEndpoint: document.getElementById("review-endpoint"),
    reviewProtocol: document.getElementById("review-protocol"),
    reviewModel: document.getElementById("review-model"),
    reviewFallback: document.getElementById("review-fallback"),
    reviewBlock: document.getElementById("review-block"),
    reviewApply: document.getElementById("review-apply"),
    reviewCancel: document.getElementById("review-cancel"),
    testResult: document.getElementById("test-result"),
    testSummary: document.getElementById("test-summary"),
    testEndpoint: document.getElementById("test-endpoint"),
    testChecks: document.getElementById("test-checks"),
    activity: document.getElementById("activity"),
    activityStatus: document.getElementById("activity-status"),
    activityList: document.getElementById("activity-list"),
    btnAdd: document.getElementById("btn-add"),
    btnRollback: document.getElementById("btn-rollback"),
    btnActivity: document.getElementById("btn-activity"),
    dialog: document.getElementById("add-dialog"),
    form: document.getElementById("add-form"),
    addError: document.getElementById("add-error"),
    headerRows: document.getElementById("header-rows"),
    preview: document.getElementById("add-preview"),
    adapterWrap: document.getElementById("adapter-wrap"),
    fieldId: document.getElementById("field-id"),
    fieldName: document.getElementById("field-name"),
    fieldProtocol: document.getElementById("field-protocol"),
    fieldBase: document.getElementById("field-base"),
    fieldModel: document.getElementById("field-model"),
    fieldAuth: document.getElementById("field-auth"),
    fieldAdapter: document.getElementById("field-adapter"),
    fieldSecret: document.getElementById("field-secret"),
    fieldPath: document.getElementById("field-path"),
  };

  var reviewKind = null;
  var reviewTarget = null;
  var busy = false;

  function text(node, value) {
    if (!node) return;
    if (value === null || value === undefined || value === "") {
      node.textContent = "—";
      return;
    }
    node.textContent = String(value);
  }

  function show(node, on) {
    if (node) node.hidden = !on;
  }

  function errorMessage(payload, fallback) {
    if (payload && payload.error && payload.error.message) return String(payload.error.message);
    return fallback;
  }

  function api(method, path, body) {
    var headers = { Accept: "application/json" };
    var opts = { method: method, headers: headers, credentials: "same-origin", cache: "no-store" };
    if (method !== "GET") {
      headers["X-CSRF-Token"] = CSRF;
      headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(body || {});
    }
    return fetch(path, opts).then(function (res) {
      return res.text().then(function (raw) {
        var data = {};
        if (raw) {
          try {
            data = JSON.parse(raw);
          } catch (err) {
            data = { ok: false, error: { code: "invalid", message: "无法读取返回内容" } };
          }
        }
        if (!res.ok) {
          var fail = new Error(errorMessage(data, "请求失败"));
          fail.payload = data;
          fail.status = res.status;
          throw fail;
        }
        return data;
      });
    });
  }

  function secretLabel(secret) {
    secret = secret || {};
    if (secret.rejected) return { kind: "rejected", text: secret.reason || "密钥不可用" };
    if (secret.installed) {
      var fp = secret.fingerprintPrefix ? String(secret.fingerprintPrefix) : "";
      return { kind: "installed", text: fp ? "已安装 " + fp : "已安装" };
    }
    if (secret.required) return { kind: "missing", text: "未安装密钥" };
    return { kind: "none", text: "无需密钥" };
  }

  function joinPreview(baseUrl, protocol, overridePath) {
    var path = (overridePath || "").trim() || DEFAULT_PATHS[protocol] || "";
    var base = (baseUrl || "").trim().replace(/\/$/, "");
    if (!base) return "填写根地址后显示";
    return "POST " + base + path;
  }

  function routeKind(status) {
    if (!status) return "loading";
    var host = status.host || {};
    if (status.runtimeKind === "lab-synthetic") return "lab";
    var desired = status.desiredProfile || "official";
    var observed = status.activeProfile;
    var hostState = host.state || "unknown";
    if (hostState === "error") return "error";
    if (hostState === "switching") return "switching";
    if (observed && desired && observed !== desired) return "drift";
    if (host.wired === true && observed && observed === desired) return "healthy";
    if (host.wired === false || hostState === "not-wired" || hostState === "blocked") return "blocked";
    if (observed && observed === desired) return "healthy";
    return "blocked";
  }

  function renderRoute(status, err) {
    var kind = err ? "error" : routeKind(status);
    els.route.dataset.state = kind;
    els.route.setAttribute("aria-busy", kind === "loading" ? "true" : "false");
    els.flag.textContent = STATE_LABEL[kind] || kind;
    show(els.runtimeNote, kind === "lab");
    text(els.runtimeNote, "当前连接的是本地模拟环境，不代表 Grok Bot 主机状态。真实主机接入尚未开放。");
    if (err) {
      text(els.title, err.message || "无法读取状态");
      text(els.desired, "—");
      text(els.observed, "—");
      text(els.mode, "—");
      text(els.fallback, "从不");
      text(els.endpoint, "无法解析实际地址");
      show(els.drift, false);
      return;
    }
    var desired = status.desiredProfile || "official";
    var observed = status.activeProfile;
    var providers = status._providers || [];
    var active = null;
    for (var i = 0; i < providers.length; i += 1) {
      if (providers[i].id === desired) active = providers[i];
    }
    var name = active && active.displayName ? active.displayName : desired;
    var model = active && active.model ? " / " + active.model : "";
    text(els.title, name + model);
    text(els.desired, desired);
    text(els.observed, observed || "未读到主机");
    var official = !active || active.mode === "official" || desired === "official";
    text(els.mode, official ? "官方通道" : "仅外部");
    text(els.fallback, (status.fallbackPolicy || (active && active.fallbackPolicy) || "never") === "never" ? "从不" : String(status.fallbackPolicy));
    if (active && active.resolvedMethod && active.resolvedEndpoint) {
      text(els.endpoint, active.resolvedMethod + " " + active.resolvedEndpoint);
    } else {
      text(els.endpoint, "本地官方通道");
    }
    if (kind === "drift") {
      els.drift.hidden = false;
      text(els.drift, "期望 " + desired + "，实际 " + String(observed));
    } else {
      els.drift.hidden = true;
    }
  }

  function clearChildren(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function addBtn(parent, label, onClick, className) {
    var btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = label;
    if (className) btn.className = className;
    btn.addEventListener("click", onClick);
    parent.appendChild(btn);
    return btn;
  }

  function renderProviders(items) {
    clearChildren(els.providers);
    if (!items || !items.length) {
      els.listStatus.textContent = "没有提供方";
      return;
    }
    var custom = 0;
    items.forEach(function (item) {
      if (item.id !== "official") custom += 1;
      var row = document.createElement("article");
      row.className = "provider";
      row.setAttribute("role", "row");

      var name = document.createElement("div");
      var title = document.createElement("div");
      title.className = "provider-name";
      title.textContent = item.displayName || item.id;
      var id = document.createElement("div");
      id.className = "provider-meta";
      id.textContent = item.id;
      name.appendChild(title);
      name.appendChild(id);

      var proto = document.createElement("div");
      proto.className = "provider-meta";
      var protocol = item.protocol || (item.mode === "official" ? "官方通道" : item.mode) || "—";
      proto.textContent = item.model ? protocol + " · " + item.model : protocol;

      var auth = document.createElement("div");
      auth.className = "provider-meta";
      var authType = item.authType || (item.auth && item.auth.type) || "—";
      var fallback = (item.fallbackPolicy || "never") === "never" ? "回退从不" : String(item.fallbackPolicy);
      auth.textContent = authType + " · " + fallback;

      var info = secretLabel(item.secret);
      var secretText = document.createElement("div");
      secretText.className = "secret-state";
      secretText.dataset.kind = info.kind;
      secretText.textContent = info.text;
      var form = null;
      if (item.id !== "official") {
        form = document.createElement("form");
        form.className = "secret-form";
        form.addEventListener("submit", function (event) {
          event.preventDefault();
          var field = form.querySelector("input");
          var value = field ? field.value : "";
          if (field) field.value = "";
          setSecret(item.id, value);
        });
        var input = document.createElement("input");
        input.type = "password";
        input.autocomplete = "off";
        input.spellcheck = false;
        input.setAttribute("aria-label", "密钥");
        form.appendChild(input);
        var save = document.createElement("button");
        save.type = "submit";
        save.textContent = "安装密钥";
        form.appendChild(save);
        if (item.secret && item.secret.installed) {
          addBtn(form, "移除密钥", function () {
            openReview("secret-remove", item.id);
          }, "danger-quiet");
        }
      }

      var actions = document.createElement("div");
      actions.className = "provider-actions";
      addBtn(actions, "测试配置", function () { testProvider(item.id); });
      addBtn(actions, "查看计划", function () { openReview("use", item.id); });
      if (item.id !== "official") {
        addBtn(actions, "删除", function () { openReview("remove", item.id); }, "danger-quiet");
      }

      var endpoint = document.createElement("p");
      endpoint.className = "endpoint provider-endpoint";
      if (item.resolvedMethod && item.resolvedEndpoint) {
        endpoint.textContent = item.resolvedMethod + " " + item.resolvedEndpoint;
      } else {
        endpoint.textContent = "本地官方通道";
      }

      row.appendChild(name);
      row.appendChild(proto);
      row.appendChild(auth);
      row.appendChild(secretText);
      row.appendChild(actions);
      row.appendChild(endpoint);
      if (form) row.appendChild(form);
      els.providers.appendChild(row);
    });
    els.listStatus.textContent = custom === 0 ? "目前只有官方通道" : "共 " + items.length + " 个提供方";
  }

  function loadAll() {
    return Promise.all([api("GET", "/api/status"), api("GET", "/api/providers")])
      .then(function (pair) {
        var status = pair[0] || {};
        var listed = pair[1] || {};
        var providers = listed.providers || [];
        status._providers = providers;
        renderRoute(status, null);
        renderProviders(providers);
      })
      .catch(function (err) {
        renderRoute(null, err);
        els.listStatus.textContent = err.message || "无法读取提供方";
      });
  }

  function openReview(kind, target) {
    reviewKind = kind;
    reviewTarget = target;
    show(els.review, true);
    text(els.reviewFallback, "从不");
    els.reviewApply.disabled = false;
    if (kind === "use") {
      text(els.reviewTitle, "切换计划");
      text(els.reviewNote, "现在不会改主机。确认后才会启用。");
      els.reviewApply.textContent = "启用";
      els.reviewApply.className = "primary";
      api("POST", "/api/plan", { target: target }).then(fillPlan).catch(reviewFail);
      return;
    }
    if (kind === "rollback") {
      text(els.reviewTitle, "切回上一通道");
      text(els.reviewNote, "按当前配置重新切换，不会按历史快照原样恢复。");
      els.reviewApply.textContent = "确认切回";
      els.reviewApply.className = "danger-quiet";
      api("POST", "/api/rollback", { apply: false }).then(fillPlan).catch(reviewFail);
      return;
    }
    if (kind === "remove") {
      text(els.reviewTitle, "删除提供方");
      text(els.reviewNote, "将删除该提供方和它的密钥。");
      els.reviewApply.textContent = "确认删除";
      els.reviewApply.className = "danger-quiet";
      api("POST", "/api/providers/" + encodeURIComponent(target) + "/remove", {}).then(fillPlan).catch(reviewFail);
      return;
    }
    text(els.reviewTitle, "移除密钥");
    text(els.reviewNote, "只移除密钥，配置会留下。");
    els.reviewApply.textContent = "确认移除密钥";
    els.reviewApply.className = "danger-quiet";
    api("POST", "/api/providers/" + encodeURIComponent(target) + "/secret/remove", {}).then(fillPlan).catch(reviewFail);
  }

  function fillPlan(plan) {
    var target = plan.target || plan.id || reviewTarget;
    reviewTarget = target;
    text(els.reviewTarget, target);
    if (plan.resolvedMethod && plan.resolvedEndpoint) {
      text(els.reviewEndpoint, plan.resolvedMethod + " " + plan.resolvedEndpoint);
    } else {
      text(els.reviewEndpoint, "本地官方通道");
    }
    text(els.reviewProtocol, plan.protocol || plan.mode || "—");
    text(els.reviewModel, plan.model || "—");
    text(els.reviewFallback, (plan.fallbackPolicy || "never") === "never" ? "从不" : String(plan.fallbackPolicy));
    var blocking = plan.blocking || [];
    var reasons = [];
    var seen = {};
    function addReason(text) {
      if (seen[text]) return;
      seen[text] = true;
      reasons.push(text);
    }
    if (plan.wired === false) addReason("主机未接入");
    if (blocking.indexOf("needs-key") !== -1) addReason("未安装密钥");
    if (blocking.indexOf("secret-rejected") !== -1) addReason("密钥不可用");
    if (blocking.indexOf("not-wired") !== -1) addReason("主机未接入");
    if (plan.runtimeKind === "lab-synthetic") {
      text(els.reviewNote, "这是本地模拟环境，不会切换真实 Grok Bot 主机。");
      if (!plan.allowSyntheticApply) addReason("模拟切换未启用");
    }
    var blockerLabels = {"busy-agent": "主机有任务运行中", "pending-command": "主机有待处理命令", "unknown-hash": "主机版本尚未验证", "drift": "主机状态与配置不一致", "missing-receipt": "缺少切换回执", "snapshot-mismatch": "历史快照校验失败", "unsafe-endpoint": "供应商地址未通过安全校验", "disabled": "提供方已停用"};
    blocking.forEach(function (code) {
      if (["needs-key", "secret-rejected", "not-wired"].indexOf(code) === -1) addReason(blockerLabels[code] || "尚未满足切换条件");
    });
    if (reasons.length) {
      els.reviewBlock.hidden = false;
      els.reviewBlock.textContent = reasons.join("；");
      els.reviewApply.disabled = true;
    } else {
      els.reviewBlock.hidden = true;
      els.reviewApply.disabled = false;
    }
  }

  function reviewFail(err) {
    els.reviewBlock.hidden = false;
    els.reviewBlock.textContent = err.message || "无法读取计划";
    els.reviewApply.disabled = true;
  }

  function applyReview() {
    if (busy || !reviewKind) return;
    busy = true;
    var done = function () {
      busy = false;
    };
    var req;
    if (reviewKind === "use") {
      req = api("POST", "/api/use", { target: reviewTarget, apply: true });
    } else if (reviewKind === "rollback") {
      req = api("POST", "/api/rollback", { target: reviewTarget || "official", apply: true });
    } else if (reviewKind === "remove") {
      req = api("POST", "/api/providers/" + encodeURIComponent(reviewTarget) + "/remove", { confirm: true });
    } else {
      req = api("POST", "/api/providers/" + encodeURIComponent(reviewTarget) + "/secret/remove", { confirm: true });
    }
    req.then(function () {
      show(els.review, false);
      return loadAll();
    }).catch(function (err) {
      els.reviewBlock.hidden = false;
      els.reviewBlock.textContent = err.message || "无法执行";
    }).then(done, done);
  }

  function testProvider(id) {
    api("POST", "/api/test", { target: id, live: false }).then(function (result) {
      show(els.testResult, true);
      text(els.testSummary, result.ok ? "配置校验通过" : "配置校验未通过");
      if (result.resolvedMethod && result.resolvedEndpoint) {
        text(els.testEndpoint, result.resolvedMethod + " " + result.resolvedEndpoint);
      } else {
        text(els.testEndpoint, "本地官方通道");
      }
      clearChildren(els.testChecks);
      (result.checks || []).forEach(function (check) {
        var li = document.createElement("li");
        li.textContent = (check.name || "check") + " · " + (check.ok ? "通过" : "未通过");
        els.testChecks.appendChild(li);
      });
    }).catch(function (err) {
      show(els.testResult, true);
      text(els.testSummary, err.message || "无法测试");
      text(els.testEndpoint, "");
      clearChildren(els.testChecks);
    });
  }

  function setSecret(profileId, value) {
    if (!value) return;
    api("POST", "/api/providers/" + encodeURIComponent(profileId) + "/secret", { secret: value })
      .then(function () { return loadAll(); })
      .catch(function (err) {
        els.listStatus.textContent = err.message || "无法安装密钥";
      });
  }

  function loadActivity() {
    show(els.activity, true);
    els.btnActivity.setAttribute("aria-expanded", "true");
    els.activityStatus.textContent = "正在读取活动";
    api("GET", "/api/activity?limit=50").then(function (payload) {
      var events = payload.events || [];
      clearChildren(els.activityList);
      if (!events.length) {
        els.activityStatus.textContent = "暂无活动";
        return;
      }
      els.activityStatus.textContent = "最近 " + events.length + " 条";
      events.forEach(function (event) {
        var li = document.createElement("li");
        var when = document.createElement("div");
        when.className = "when";
        when.textContent = event.at || "";
        var kind = document.createElement("div");
        kind.className = "kind";
        kind.textContent = (event.type || "") + "  " + (event.profileId || "");
        li.appendChild(when);
        li.appendChild(kind);
        els.activityList.appendChild(li);
      });
    }).catch(function (err) {
      els.activityStatus.textContent = err.message || "无法读取活动";
    });
  }

  function addHeaderRow(name, value) {
    var row = document.createElement("div");
    row.className = "header-row";
    var n = document.createElement("input");
    n.placeholder = "名称";
    n.autocomplete = "off";
    n.value = name || "";
    var v = document.createElement("input");
    v.placeholder = "值";
    v.autocomplete = "off";
    v.value = value || "";
    var rm = document.createElement("button");
    rm.type = "button";
    rm.textContent = "删除";
    rm.addEventListener("click", function () { row.remove(); });
    row.appendChild(n);
    row.appendChild(v);
    row.appendChild(rm);
    els.headerRows.appendChild(row);
  }

  function collectHeaders() {
    var headers = {};
    var rows = els.headerRows.querySelectorAll(".header-row");
    rows.forEach(function (row) {
      var inputs = row.querySelectorAll("input");
      var name = (inputs[0] && inputs[0].value || "").trim();
      var value = inputs[1] ? inputs[1].value : "";
      if (name) headers[name] = value;
    });
    return headers;
  }

  function updatePreview() {
    text(els.preview, joinPreview(els.fieldBase.value, els.fieldProtocol.value, els.fieldPath.value));
  }

  function resetDialog() {
    els.form.reset();
    els.fieldSecret.value = "";
    clearChildren(els.headerRows);
    addHeaderRow("", "");
    show(els.addError, false);
    els.adapterWrap.hidden = true;
    updatePreview();
  }

  function openAdd() {
    resetDialog();
    if (els.dialog.showModal) els.dialog.showModal();
  }

  function closeAdd() {
    els.fieldSecret.value = "";
    if (els.dialog.open) els.dialog.close();
  }

  els.form.addEventListener("submit", function (event) {
    event.preventDefault();
    show(els.addError, false);
    var secret = els.fieldSecret.value;
    els.fieldSecret.value = "";
    var profile = {
      schemaVersion: 1,
      id: els.fieldId.value.trim(),
      displayName: els.fieldName.value.trim(),
      protocol: els.fieldProtocol.value,
      baseUrl: els.fieldBase.value.trim(),
      model: els.fieldModel.value.trim(),
      auth: { type: els.fieldAuth.value },
      headers: collectHeaders(),
      fallbackPolicy: "never",
      enabled: true,
    };
    var path = els.fieldPath.value.trim();
    if (path) profile.endpointPath = path;
    if (profile.auth.type === "oauth-adapter") profile.auth.adapter = els.fieldAdapter.value.trim();
    api("POST", "/api/providers", profile).then(function (created) {
      var next = Promise.resolve();
      if (secret) {
        next = api("POST", "/api/providers/" + encodeURIComponent(created.id) + "/secret", { secret: secret });
      }
      return next;
    }).then(function () {
      closeAdd();
      return loadAll();
    }).catch(function (err) {
      els.addError.hidden = false;
      els.addError.textContent = err.message || "无法保存";
    });
  });

  els.fieldProtocol.addEventListener("change", updatePreview);
  els.fieldBase.addEventListener("input", updatePreview);
  els.fieldPath.addEventListener("input", updatePreview);
  els.fieldAuth.addEventListener("change", function () {
    els.adapterWrap.hidden = els.fieldAuth.value !== "oauth-adapter";
  });
  document.getElementById("btn-add-header").addEventListener("click", function () { addHeaderRow("", ""); });
  document.getElementById("btn-add-cancel").addEventListener("click", closeAdd);
  els.dialog.addEventListener("close", function () { els.fieldSecret.value = ""; });
  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape" && !els.dialog.open) {
      show(els.review, false);
      show(els.activity, false);
      els.btnActivity.setAttribute("aria-expanded", "false");
    }
  });

  els.btnAdd.addEventListener("click", openAdd);
  els.btnRollback.addEventListener("click", function () { openReview("rollback", "official"); });
  els.btnActivity.addEventListener("click", function () {
    if (els.activity.hidden) loadActivity();
    else {
      show(els.activity, false);
      els.btnActivity.setAttribute("aria-expanded", "false");
    }
  });
  els.reviewApply.addEventListener("click", applyReview);
  els.reviewCancel.addEventListener("click", function () { show(els.review, false); });

  loadAll();
})();
