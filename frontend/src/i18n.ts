import i18n from "i18next";
import { initReactI18next } from "react-i18next";

void i18n.use(initReactI18next).init({
  lng: "zh",
  fallbackLng: "zh",
  interpolation: { escapeValue: false },
  resources: {
    zh: {
      translation: {
        common: {
          cancel: "取消",
          confirm: "确认",
          edit: "编辑",
          delete: "删除",
        },
        apiKeyInput: {
          placeholder: "输入新的 API Key，不会回显已有密钥",
          show: "显示新输入的密钥",
          hide: "隐藏新输入的密钥",
        },
        opencode: {
          headers: "自定义请求头",
          headersHint: "仅用于非凭据请求头；密钥请使用 API Key 输入框。",
          addHeader: "添加请求头",
          noHeaders: "未配置自定义请求头",
          headerName: "请求头名称",
          headerValue: "请求头值",
          headerNamePlaceholder: "X-Title",
          headerValuePlaceholder: "Grok Bot Switch",
          removeHeader: "删除请求头",
        },
      },
    },
  },
});
export default i18n;
