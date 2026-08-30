import { beforeEach, expect, test, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "./i18n";
import App from "./App";
import { ProviderForm } from "./components/providers/ProviderForm";
import { api, endpointPreview, planBlockers, type Profile } from "./lib/api";

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
test("real list and review flow cannot apply to an unconnected host", async () => {
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
  await user.click(await screen.findByRole("button", { name: "查看计划" }));
  expect(
    await screen.findByRole("button", { name: "确认切换" }),
  ).toBeDisabled();
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
