import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "./i18n";
import App from "./App";
import { ProviderForm } from "./components/providers/ProviderForm";
import {
  api,
  endpointPreview,
  planBlockers,
  type Profile,
  type Plan,
  type Status,
  type Activation,
} from "./lib/api";

const profile: Profile = {
  schemaVersion: 1,
  id: "test-provider",
  displayName: "测试供应商",
  protocol: "openai-chat",
  baseUrl: "https://api.example.com/v1",
  model: "test-model",
  auth: { type: "bearer" },
  headers: { "X-Title": "keep" },
  parameters: { maxTokens: 8192, reasoningEffort: "high" },
  enabled: false,
  fallbackPolicy: "never",
  secret: { installed: true, fingerprintPrefix: "fixture123" },
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
beforeEach(() => {
  document.head.innerHTML = '<meta name="csrf-token" content="test-csrf">';
  vi.stubGlobal("fetch", vi.fn());
});
afterEach(() => vi.useRealTimers());

test("endpoint query and path suffix match the Python profile contract", () => {
  expect(
    endpointPreview(
      "https://api.example.com/v1?api-version=2026",
      "openai-responses",
      "/custom",
    ),
  ).toBe("https://api.example.com/v1/custom?api-version=2026");
  expect(
    endpointPreview("https://user:key@example.com", "openai-chat", ""),
  ).toBe("");
});
test("client writes are same-origin, CSRF-bound and refuse redirects", async () => {
  vi.mocked(fetch).mockResolvedValue(json({ ok: true }));
  await api("/api/test", { target: "official", live: false });
  expect(fetch).toHaveBeenCalledWith(
    "/api/test",
    expect.objectContaining({
      redirect: "error",
      credentials: "same-origin",
      headers: expect.objectContaining({ "X-CSRF-Token": "test-csrf" }),
    }),
  );
  await expect(api("https://example.com/api/")).rejects.toThrow("本机");
});
test("every unknown blocker still disables apply", () => {
  expect(planBlockers({ blocking: ["future-blocker"] })).toHaveLength(1);
  expect(
    planBlockers({ runtimeKind: "lab-synthetic", allowSyntheticApply: false }),
  ).toEqual(["模拟切换未启用"]);
});
test("ported edit form locks id, never reads a key, preserves parameters and enabled", async () => {
  vi.mocked(fetch).mockResolvedValue(json(profile));
  const user = userEvent.setup();
  render(
    <ProviderForm initial={profile} onClose={vi.fn()} onSaved={vi.fn()} />,
  );
  expect(screen.getByLabelText("编号")).toHaveAttribute("readonly");
  expect(screen.queryByLabelText(/API Key/)).not.toBeInTheDocument();
  await user.clear(screen.getByLabelText("名称"));
  await user.type(screen.getByLabelText("名称"), "改名");
  await user.click(screen.getByRole("button", { name: "保存" }));
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  const [url, options] = vi.mocked(fetch).mock.calls[0];
  const body = JSON.parse(String(options?.body));
  expect(url).toBe("/api/providers/test-provider/update");
  expect(body.parameters).toEqual(profile.parameters);
  expect(body.headers).toEqual(profile.headers);
  expect(body.enabled).toBe(false);
  expect(body).not.toHaveProperty("secret");
});
test("ported form saves key separately and clears it on failed install", async () => {
  vi.mocked(fetch)
    .mockResolvedValueOnce(json(profile))
    .mockResolvedValueOnce(
      json({ error: { message: "fixture key rejected" } }, 400),
    );
  const user = userEvent.setup();
  render(<ProviderForm onClose={vi.fn()} onSaved={vi.fn()} />);
  await user.type(screen.getByLabelText("编号"), "test-provider");
  await user.type(screen.getByLabelText("名称"), "测试供应商");
  await user.type(
    screen.getByLabelText("根地址"),
    "https://api.example.com/v1",
  );
  await user.type(screen.getByLabelText("模型"), "test-model");
  await user.type(screen.getByLabelText(/API Key/), "synthetic-key-only");
  await user.click(screen.getByRole("button", { name: "保存" }));
  await screen.findByRole("alert");
  expect(screen.getByLabelText(/API Key/)).toHaveValue("");
  const first = JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body));
  expect(JSON.stringify(first)).not.toContain("synthetic-key-only");
  expect(vi.mocked(fetch).mock.calls[1][0]).toBe(
    "/api/providers/test-provider/secret",
  );
  vi.mocked(fetch).mockResolvedValue(json(profile));
  await user.click(screen.getByRole("button", { name: "保存" }));
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
  expect(vi.mocked(fetch).mock.calls[2][0]).toBe(
    "/api/providers/test-provider/update",
  );
});
test("one-click use reports an unconnected host inline without applying or opening a dialog", async () => {
  const official = {
    ...profile,
    id: "official",
    displayName: "官方 Grok",
    mode: "official",
    protocol: null,
    model: null,
    auth: { type: "none" },
  };
  vi.mocked(fetch).mockImplementation(async (url) => {
    if (url === "/api/status")
      return json({
        desiredProfile: "official",
        activeProfile: null,
        host: { wired: false },
        runtimeKind: null,
        blocking: ["not-wired"],
      });
    if (url === "/api/providers") return json({ providers: [official] });
    if (url === "/api/plan")
      return json({
        target: "official",
        wired: false,
        blocking: ["not-wired"],
      });
    throw new Error("unexpected request");
  });
  const user = userEvent.setup();
  render(<App />);
  await user.click(await screen.findByRole("button", { name: "使用" }));
  expect(
    await within(screen.getByRole("article", { name: "官方 Grok" })).findByRole(
      "alert",
    ),
  ).toHaveTextContent("主机未接入");
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "使用" })).toBeEnabled();
  expect(vi.mocked(fetch).mock.calls.some(([url]) => url === "/api/use")).toBe(
    false,
  );
});
test("simulation does not label an observed provider as truly active", async () => {
  vi.mocked(fetch).mockImplementation(async (url) =>
    url === "/api/providers"
      ? json({ providers: [profile] })
      : json({
          desiredProfile: profile.id,
          activeProfile: profile.id,
          host: { wired: true },
          runtimeKind: "lab-synthetic",
          blocking: [],
        }),
  );
  render(<App />);
  await screen.findByText("模拟环境");
  expect(screen.queryByText("使用中")).not.toBeInTheDocument();
});

test("a pending save locks the form so later edits cannot be lost", async () => {
  let finish!: (value: Response) => void;
  vi.mocked(fetch).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const user = userEvent.setup();
  const saved = vi.fn();
  render(<ProviderForm initial={profile} onClose={vi.fn()} onSaved={saved} />);
  await user.click(screen.getByRole("button", { name: "保存" }));
  expect(screen.getByLabelText("名称")).toBeDisabled();
  expect(screen.getByRole("button", { name: "取消" })).toBeDisabled();
  finish(json(profile));
  await waitFor(() => expect(saved).toHaveBeenCalled());
});
test("a failed initial read is not presented as an empty provider list", async () => {
  vi.mocked(fetch).mockResolvedValue(
    json({ error: { message: "读取失败" } }, 500),
  );
  render(<App />);
  await screen.findByRole("alert");
  expect(screen.queryByText("没有匹配的供应商")).not.toBeInTheDocument();
});

test("installed Grok Bot is detected but never presented as connected or active", async () => {
  vi.mocked(fetch).mockImplementation(async (url) =>
    url === "/api/providers"
      ? json({ providers: [profile] })
      : json({
          desiredProfile: "official",
          activeProfile: null,
          host: { wired: false },
          runtimeKind: null,
          blocking: ["not-wired"],
          installation: {
            detected: true,
            ambiguous: false,
            integrationReady: false,
            installations: [
              {
                path: "/Applications/Grok Bot.app",
                executable: "/fixture/Grok Bot",
                version: "0.30.0",
              },
            ],
          },
        }),
  );
  render(<App />);
  await screen.findByText("已检测到 0.30.0");
  expect(
    screen.getByText("已找到本机 Grok Bot，尚未连接。"),
  ).toBeInTheDocument();
  expect(screen.queryByText("使用中")).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "连接设置" }),
  ).not.toBeInTheDocument();
  expect(screen.queryByText(/Tailscale|SSH/)).not.toBeInTheDocument();
});

function mockSwitch(
  plan: Plan = { target: profile.id, wired: true, blocking: [] },
  apply: () => Promise<Response> = async () => json({ ok: true }),
  observed = profile.id,
) {
  let applied = false;
  vi.mocked(fetch).mockImplementation(async (url, options) => {
    const body = options?.body ? JSON.parse(String(options.body)) : {};
    if (url === "/api/providers") return json({ providers: [profile] });
    if (url === "/api/status")
      return json({
        activeProfile: applied ? observed : null,
        desiredProfile: profile.id,
        host: { wired: true },
        runtimeKind: "host",
        blocking: [],
      });
    if (url === "/api/plan" || (url === "/api/rollback" && !body.apply))
      return json(plan);
    if (url === "/api/use" || url === "/api/rollback") {
      const response = await apply();
      applied = response.ok;
      return response;
    }
    if (String(url).endsWith("/remove")) return json({ ok: true });
    throw new Error("unexpected request " + url);
  });
}

test("use silently checks then applies once and displays fresh host status", async () => {
  let finish!: (response: Response) => void;
  mockSwitch(
    undefined,
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const user = userEvent.setup();
  render(<App />);
  await user.dblClick(await screen.findByRole("button", { name: "使用" }));
  expect(screen.getByRole("button", { name: "切换中" })).toBeDisabled();
  expect(screen.queryByText("使用中")).not.toBeInTheDocument();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  const writes = vi
    .mocked(fetch)
    .mock.calls.filter(([, options]) => options?.method === "POST");
  expect(writes.map(([url]) => url)).toEqual(["/api/plan", "/api/use"]);
  expect(JSON.parse(String(writes[1][1]?.body))).toEqual({
    target: profile.id,
    apply: true,
  });
  finish(json({ ok: true }));
  expect(await screen.findByRole("button", { name: "使用中" })).toBeDisabled();
  expect(screen.getByRole("status")).toHaveTextContent(
    "已切换到「测试供应商」",
  );
});

test.each([
  { target: profile.id, blocking: ["busy-agent"] },
  { target: profile.id, blocking: ["pending-command"] },
  { target: profile.id, blocking: ["future-blocker"] },
  {
    target: profile.id,
    runtimeKind: "lab-synthetic",
    allowSyntheticApply: false,
  },
  { target: "wrong-target", blocking: [] },
  { blocking: [] },
])("blocked or ambiguous preflight never applies: %j", async (plan) => {
  mockSwitch(plan);
  const user = userEvent.setup();
  render(<App />);
  await user.click(await screen.findByRole("button", { name: "使用" }));
  await within(screen.getByRole("article")).findByRole("alert");
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(vi.mocked(fetch).mock.calls.some(([url]) => url === "/api/use")).toBe(
    false,
  );
});

test("apply rejection is inline and retry repeats preflight", async () => {
  const apply = vi
    .fn()
    .mockResolvedValueOnce(
      json({ error: { message: "主机有任务运行中" } }, 409),
    )
    .mockResolvedValueOnce(json({ ok: true }));
  mockSwitch(undefined, apply);
  const user = userEvent.setup();
  render(<App />);
  await user.click(await screen.findByRole("button", { name: "使用" }));
  expect(
    await within(screen.getByRole("article")).findByRole("alert"),
  ).toHaveTextContent("主机有任务运行中");
  await user.click(screen.getByRole("button", { name: "使用" }));
  await screen.findByRole("button", { name: "使用中" });
  expect(
    vi.mocked(fetch).mock.calls.filter(([url]) => url === "/api/plan"),
  ).toHaveLength(2);
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

test("an apply response without matching status is not announced as success", async () => {
  mockSwitch(undefined, undefined, "official");
  const user = userEvent.setup();
  render(<App />);
  await user.click(await screen.findByRole("button", { name: "使用" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "尚未确认目标通道已生效",
  );
  expect(screen.queryByText("使用中")).not.toBeInTheDocument();
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
});

test("switch back also performs preflight and apply without a dialog", async () => {
  mockSwitch();
  const user = userEvent.setup();
  render(<App />);
  await screen.findByRole("article");
  await user.click(screen.getByRole("button", { name: "切回上一通道" }));
  await screen.findByRole("button", { name: "使用中" });
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(
    vi
      .mocked(fetch)
      .mock.calls.filter(([url]) => url === "/api/rollback")
      .map(([, options]) => JSON.parse(String(options?.body))),
  ).toEqual([{}, { target: profile.id, apply: true }]);
});

test("delete still requires confirmation; cancel never sends confirm", async () => {
  mockSwitch();
  const user = userEvent.setup();
  render(<App />);
  await user.click(await screen.findByRole("button", { name: "删除供应商" }));
  const dialog = await screen.findByRole("dialog");
  expect(dialog).toHaveTextContent("不能撤销");
  await user.click(within(dialog).getByRole("button", { name: "取消" }));
  expect(
    vi
      .mocked(fetch)
      .mock.calls.filter(([url]) => String(url).endsWith("/remove"))
      .map(([, options]) => JSON.parse(String(options?.body))),
  ).toEqual([{}]);
});

test("removing a key still requires confirmation", async () => {
  mockSwitch();
  const user = userEvent.setup();
  render(<App />);
  await user.click(await screen.findByRole("button", { name: "管理密钥" }));
  await user.click(
    within(screen.getByRole("dialog")).getByRole("button", {
      name: "移除密钥",
    }),
  );
  const dialog = await screen.findByRole("dialog", { name: "移除密钥" });
  await user.click(within(dialog).getByRole("button", { name: "取消" }));
  expect(
    vi
      .mocked(fetch)
      .mock.calls.filter(([url]) => String(url).endsWith("/secret/remove"))
      .map(([, options]) => JSON.parse(String(options?.body))),
  ).toEqual([{}]);
});

test("blocked switch back shows an inline reason and does not apply", async () => {
  mockSwitch({ target: profile.id, blocking: ["busy-agent"] });
  const user = userEvent.setup();
  render(<App />);
  await screen.findByRole("article");
  await user.click(screen.getByRole("button", { name: "切回上一通道" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "主机有任务运行中",
  );
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(
    vi.mocked(fetch).mock.calls.filter(([url]) => url === "/api/rollback"),
  ).toHaveLength(1);
});

test("readback failure does not announce a successful switch", async () => {
  mockSwitch();
  const handler = vi.mocked(fetch).getMockImplementation()!;
  let reads = 0;
  vi.mocked(fetch).mockImplementation(async (url, options) => {
    if (url === "/api/status" && ++reads > 1)
      return json({ error: { message: "无法读取主机" } }, 500);
    return handler(url, options);
  });
  const user = userEvent.setup();
  render(<App />);
  await user.click(await screen.findByRole("button", { name: "使用" }));
  expect(
    await within(screen.getByRole("article")).findByRole("alert"),
  ).toHaveTextContent("切换请求已提交，但状态读取失败");
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
  expect(screen.queryByText("使用中")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "刷新" })).toBeEnabled();
});

const pendingActivation: Activation = {
  id: "native-job-1",
  status: "pending",
  phase: "waiting-idle",
  target: profile.id,
  generation: 7,
};
function nativeStatus(
  activation: Activation | null = null,
  activeProfile: string | null = null,
): Status {
  return {
    desiredProfile: profile.id,
    activeProfile,
    previousProfile: "official",
    runtimeKind: "native-host",
    host: { wired: true },
    blocking: [],
    activation,
    client: {
      connected: true,
      mode: "native-switch",
      hostReachable: true,
      providerSwitchReady: true,
    },
    installation: {
      detected: true,
      ambiguous: false,
      integrationReady: true,
      installations: [
        {
          path: "C:\\Apps\\Grok Bot",
          executable: "C:\\Apps\\Grok Bot.exe",
          version: "0.28.0",
        },
      ],
    },
  };
}
const advance = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
const click = (name: string) =>
  act(async () => {
    fireEvent.click(screen.getByRole("button", { name }));
  });

test("checks the independent cloud inline with one POST and fresh ready status", async () => {
  let connected = false;
  const current = { ...nativeStatus(), connectionMode: "independent" };
  vi.mocked(fetch).mockImplementation(async (url, options) => {
    if (url === "/api/providers") return json({ providers: [profile] });
    if (url === "/api/status")
      return json(
        connected
          ? current
          : {
              ...current,
              runtimeKind: null,
              host: { wired: false },
              client: {
                ...current.client,
                mode: "probe",
                providerSwitchReady: false,
              },
            },
      );
    if (url === "/api/connect") {
      expect(JSON.parse(String(options?.body))).toEqual({});
      connected = true;
      return json({ ok: true });
    }
    throw new Error("unexpected request");
  });
  const user = userEvent.setup();
  render(<App />);
  const button = await screen.findByRole("button", { name: "检查云端兼容性" });
  expect(screen.getByText(/面板运行在你的 Grok Bot 云端/)).toBeInTheDocument();
  expect(screen.getByText(/切换会影响当前云端/)).toHaveTextContent(
    "供应商密钥保存在该云端",
  );
  await user.dblClick(button);
  expect(await screen.findByText("已连接 Grok Bot。")).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "检查云端兼容性" }),
  ).not.toBeInTheDocument();
  expect(
    vi.mocked(fetch).mock.calls.filter(([url]) => url === "/api/connect"),
  ).toHaveLength(1);
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(screen.queryByText(/SSH|Tailscale/)).not.toBeInTheDocument();
});

test("first connection errors remain inline and do not claim connection", async () => {
  const current = nativeStatus();
  vi.mocked(fetch).mockImplementation(async (url) => {
    if (url === "/api/providers") return json({ providers: [profile] });
    if (url === "/api/status")
      return json({
        ...current,
        connectionMode: "independent",
        runtimeKind: null,
        host: { wired: false },
        client: {
          ...current.client,
          mode: "probe",
          providerSwitchReady: false,
        },
      });
    return json({ error: { message: "请检查云端连接。" } }, 409);
  });
  const user = userEvent.setup();
  render(<App />);
  await user.click(
    await screen.findByRole("button", { name: "检查云端兼容性" }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "请检查云端连接",
  );
  expect(screen.queryByText("已连接 Grok Bot。")).not.toBeInTheDocument();
});

test("pending use never marks target active and progresses once to verified matching readback", async () => {
  vi.useFakeTimers();
  let current = nativeStatus();
  vi.mocked(fetch).mockImplementation(async (url, options) => {
    if (url === "/api/providers") return json({ providers: [profile] });
    if (url === "/api/status") return json(current);
    if (url === "/api/plan")
      return json({ target: profile.id, wired: true, blocking: [] });
    if (url === "/api/use") {
      current = nativeStatus(pendingActivation, profile.id);
      return json({ ...pendingActivation, verified: false });
    }
    if (url === "/api/progress") {
      expect(JSON.parse(String(options?.body))).toEqual({});
      current = nativeStatus(
        { ...pendingActivation, status: "verified" },
        profile.id,
      );
      return json({ ...current.activation, verified: true });
    }
    throw new Error("unexpected request");
  });
  await act(async () => {
    render(<App />);
  });
  await click("使用");
  expect(screen.getByRole("button", { name: "切换中" })).toBeDisabled();
  expect(screen.getByRole("status")).toHaveTextContent("等待确认");
  expect(screen.queryByText("使用中")).not.toBeInTheDocument();
  await click("切换中");
  expect(
    vi.mocked(fetch).mock.calls.filter(([url]) => url === "/api/use"),
  ).toHaveLength(1);
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  await advance(1000);
  expect(screen.getByRole("button", { name: "使用中" })).toBeDisabled();
  expect(screen.getByRole("status")).toHaveTextContent(
    "已切换到「测试供应商」",
  );
  expect(
    vi.mocked(fetch).mock.calls.filter(([url]) => url === "/api/progress"),
  ).toHaveLength(1);
});

test.each(["official", profile.id])(
  "verified result requires matching target and generation in fresh status: %s",
  async (active) => {
    vi.useFakeTimers();
    let current = nativeStatus(pendingActivation);
    vi.mocked(fetch).mockImplementation(async (url) => {
      if (url === "/api/providers") return json({ providers: [profile] });
      if (url === "/api/status") return json(current);
      if (url === "/api/progress") {
        current = nativeStatus(
          {
            ...pendingActivation,
            status: "verified",
            generation: active === profile.id ? 99 : 7,
          },
          active,
        );
        return json({
          ...pendingActivation,
          status: "verified",
          verified: true,
        });
      }
      throw new Error("unexpected request");
    });
    await act(async () => {
      render(<App />);
    });
    await advance(1000);
    expect(screen.getByRole("alert")).toHaveTextContent("尚未确认");
    expect(screen.queryByText("使用中")).not.toBeInTheDocument();
    expect(screen.queryByText(/已切换到/)).not.toBeInTheDocument();
  },
);

test("reopened pending job resumes progress without plan or second apply", async () => {
  vi.useFakeTimers();
  vi.mocked(fetch).mockImplementation(async (url) => {
    if (url === "/api/providers") return json({ providers: [profile] });
    if (url === "/api/status") return json(nativeStatus(pendingActivation));
    if (url === "/api/progress")
      return json({ ...pendingActivation, verified: false });
    throw new Error("duplicate begin");
  });
  await act(async () => {
    render(<App />);
  });
  await advance(30000);
  expect(
    vi.mocked(fetch).mock.calls.filter(([url]) => url === "/api/progress"),
  ).toHaveLength(12);
  expect(screen.getByRole("status")).toHaveTextContent("仍在等待确认");
  expect(screen.getByRole("button", { name: "继续检查" })).toBeEnabled();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(
    vi
      .mocked(fetch)
      .mock.calls.some(([url]) => url === "/api/use" || url === "/api/plan"),
  ).toBe(false);
  await click("继续检查");
  await advance(1000);
  expect(
    vi.mocked(fetch).mock.calls.filter(([url]) => url === "/api/progress"),
  ).toHaveLength(13);
});

test.each(["needs-attention", "failed"])(
  "conservative %s progress does not auto-resume from stale pending journal",
  async (resultStatus) => {
    vi.useFakeTimers();
    vi.mocked(fetch).mockImplementation(async (url) => {
      if (url === "/api/providers") return json({ providers: [profile] });
      if (url === "/api/status") return json(nativeStatus(pendingActivation));
      if (url === "/api/progress")
        return json({
          ...pendingActivation,
          status: resultStatus,
          error: "尚未取得确认回执",
          verified: false,
        });
      throw new Error("unexpected request");
    });
    await act(async () => {
      render(<App />);
    });
    await advance(30000);
    expect(
      vi.mocked(fetch).mock.calls.filter(([url]) => url === "/api/progress"),
    ).toHaveLength(1);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "切换尚未确认。尚未取得确认回执",
    );
    expect(
      screen.queryByRole("button", { name: /强制|重启/ }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("使用中")).not.toBeInTheDocument();
    await click("刷新");
    await advance(1000);
    expect(
      vi.mocked(fetch).mock.calls.filter(([url]) => url === "/api/progress"),
    ).toHaveLength(2);
  },
);

test.each([null, pendingActivation])(
  "attached native host never offers bootstrap merely because it is busy: %j",
  async (activation) => {
    vi.useFakeTimers();
    const current = nativeStatus(activation, activation ? null : profile.id);
    current.blocking = ["busy-agent"];
    current.client!.providerSwitchReady = false;
    vi.mocked(fetch).mockImplementation(async (url) =>
      url === "/api/providers" ? json({ providers: [profile] }) : json(current),
    );
    await act(async () => {
      render(<App />);
    });
    expect(screen.getByText("已接入")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "连接 Grok Bot" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/首次连接前/)).not.toBeInTheDocument();
    if (activation)
      expect(screen.getByRole("status")).toHaveTextContent("等待确认");
    else expect(screen.getByRole("button", { name: "使用中" })).toBeDisabled();
    expect(
      vi.mocked(fetch).mock.calls.some(([url]) => url === "/api/connect"),
    ).toBe(false);
  },
);

test("unmount cancels in-flight progress and leaves no polling timer", async () => {
  vi.useFakeTimers();
  let signal: AbortSignal | undefined;
  vi.mocked(fetch).mockImplementation(async (url, options) => {
    if (url === "/api/providers") return json({ providers: [profile] });
    if (url === "/api/status") return json(nativeStatus(pendingActivation));
    signal = options?.signal as AbortSignal;
    return new Promise((_, reject) =>
      signal?.addEventListener("abort", () => reject(new Error("aborted"))),
    );
  });
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(<App />);
  });
  await advance(1000);
  await act(async () => {
    view.unmount();
  });
  expect(signal?.aborted).toBe(true);
  await advance(60000);
  expect(
    vi.mocked(fetch).mock.calls.filter(([url]) => url === "/api/progress"),
  ).toHaveLength(1);
});
