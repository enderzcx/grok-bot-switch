"use strict";

var contract = require("./contract.cjs");

function unsupported(protocolId, detail) {
  return contract.protocolError(detail || "Shape is unrepresentable", {
    protocol: protocolId,
    code: "unsupported-shape"
  });
}

function jsonArgumentString(args, protocolId) {
  if (args == null) {
    return "{}";
  }
  if (typeof args === "string") {
    if (args.trim().length === 0) {
      return "{}";
    }
    try {
      JSON.parse(args);
      return args;
    } catch (_error) {
      return JSON.stringify(args);
    }
  }
  try {
    return JSON.stringify(args);
  } catch (_error) {
    throw unsupported(protocolId, "Tool call arguments are unrepresentable");
  }
}

function parseToolArgumentsObject(raw, protocolId) {
  var text = raw == null ? "" : String(raw);
  if (text.trim().length === 0) {
    return {};
  }
  try {
    return JSON.parse(text);
  } catch (_error) {
    throw contract.protocolError("Tool call has invalid final JSON arguments", {
      protocol: protocolId,
      code: "invalid-json"
    });
  }
}

function toolParameters(parameters, protocolId) {
  if (parameters == null) {
    return { type: "object", properties: {} };
  }
  if (typeof parameters !== "object" || Array.isArray(parameters)) {
    throw unsupported(protocolId, "Tool parameters are unrepresentable");
  }
  if (parameters.jsonSchema != null && typeof parameters.jsonSchema === "object" && !Array.isArray(parameters.jsonSchema)) {
    return parameters.jsonSchema;
  }
  if (parameters.type != null || parameters.properties != null || parameters.$schema != null) {
    return parameters;
  }
  if (Object.keys(parameters).length === 0) {
    return { type: "object", properties: {} };
  }
  throw unsupported(protocolId, "Tool parameters are unrepresentable");
}

function convertFunctionTools(tools, protocolId) {
  if (tools == null) {
    return [];
  }
  if (!Array.isArray(tools)) {
    throw unsupported(protocolId, "Tools must be an array");
  }
  var out = [];
  for (var i = 0; i < tools.length; i += 1) {
    out.push(convertFunctionTool(tools[i], protocolId));
  }
  return out;
}

function convertFunctionTool(tool, protocolId) {
  if (tool == null || typeof tool !== "object" || Array.isArray(tool)) {
    throw unsupported(protocolId, "Tool is unrepresentable");
  }
  if (tool.type === "provider-defined" || tool.type === "provider_defined") {
    throw unsupported(protocolId, "Tool has an unrepresentable provider-defined shape");
  }
  if (tool.type != null && tool.type !== "function") {
    throw unsupported(protocolId, "Tool has an unrepresentable provider-defined shape");
  }
  var fn = tool.type === "function" && tool.function != null && typeof tool.function === "object"
    ? tool.function
    : tool;
  var name = fn.name || tool.name;
  if (typeof name !== "string" || name.length === 0) {
    throw contract.protocolError("Tool is missing a function name", {
      protocol: protocolId,
      code: "invalid-request"
    });
  }
  var description = fn.description || tool.description;
  var parameters = toolParameters(fn.parameters || tool.parameters || fn.inputSchema || tool.inputSchema, protocolId);
  var converted = { name: name, parameters: parameters };
  if (typeof description === "string") {
    converted.description = description;
  }
  return converted;
}

function bytesToBase64(bytes) {
  var table = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  var out = "";
  var i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    var n = bytes[i] << 16 | bytes[i + 1] << 8 | bytes[i + 2];
    out += table[(n >> 18) & 63] + table[(n >> 12) & 63] + table[(n >> 6) & 63] + table[n & 63];
  }
  var remain = bytes.length - i;
  if (remain === 1) {
    var n1 = bytes[i] << 16;
    out += table[(n1 >> 18) & 63] + table[(n1 >> 12) & 63] + "==";
  } else if (remain === 2) {
    var n2 = bytes[i] << 16 | bytes[i + 1] << 8;
    out += table[(n2 >> 18) & 63] + table[(n2 >> 12) & 63] + table[(n2 >> 6) & 63] + "=";
  }
  return out;
}

function imageUrlFromPart(part, protocolId) {
  if (part.type === "image_url") {
    var imageUrl = part.image_url;
    var url = typeof imageUrl === "string" ? imageUrl : imageUrl != null ? imageUrl.url : null;
    if (typeof url !== "string" || url.length === 0) {
      throw unsupported(protocolId, "Image content is unrepresentable");
    }
    return url;
  }
  var image = part.image;
  var mime = typeof part.mimeType === "string" && part.mimeType.length > 0 ? part.mimeType : "image/png";
  if (typeof image === "string") {
    if (image.length === 0) {
      throw unsupported(protocolId, "Image content is unrepresentable");
    }
    return image;
  }
  if (typeof URL !== "undefined" && image instanceof URL) {
    return String(image);
  }
  if (image instanceof Uint8Array) {
    return "data:" + mime + ";base64," + bytesToBase64(image);
  }
  if (typeof ArrayBuffer !== "undefined" && image instanceof ArrayBuffer) {
    return "data:" + mime + ";base64," + bytesToBase64(new Uint8Array(image));
  }
  throw unsupported(protocolId, "Image content is unrepresentable");
}

function extractSystemText(message, protocolId) {
  if (typeof message.content === "string") {
    return message.content;
  }
  throw unsupported(protocolId, "System content is unrepresentable");
}

function extractUserParts(message, protocolId) {
  if (typeof message.content === "string") {
    return [{ kind: "text", text: message.content }];
  }
  if (!Array.isArray(message.content)) {
    throw unsupported(protocolId, "User content is unrepresentable");
  }
  var parts = [];
  for (var i = 0; i < message.content.length; i += 1) {
    var part = message.content[i];
    if (part == null || typeof part !== "object") {
      throw unsupported(protocolId, "User content is unrepresentable");
    }
    if (part.type === "text") {
      if (typeof part.text !== "string") {
        throw unsupported(protocolId, "User content is unrepresentable");
      }
      parts.push({ kind: "text", text: part.text });
    } else if (part.type === "image" || part.type === "image_url") {
      parts.push({ kind: "image", url: imageUrlFromPart(part, protocolId) });
    } else {
      throw unsupported(protocolId, "User content is unrepresentable");
    }
  }
  return parts;
}

function hostToolCall(part, protocolId) {
  var id = part.toolCallId || part.tool_call_id || part.id;
  var name = part.toolName || part.tool_name;
  if ((name == null || name === "") && part.function != null && typeof part.function.name === "string") {
    name = part.function.name;
  }
  if (typeof id !== "string" || id.length === 0 || typeof name !== "string" || name.length === 0) {
    throw contract.protocolError("Tool call is missing id or name", {
      protocol: protocolId,
      code: "incomplete-tool-call"
    });
  }
  var args = part.args;
  if (part.providerOptions != null && part.providerOptions.cursor != null && typeof part.providerOptions.cursor.rawToolCallArgs === "string") {
    args = part.providerOptions.cursor.rawToolCallArgs;
  }
  return { id: id, name: name, arguments: jsonArgumentString(args, protocolId) };
}

function openAiShapedToolCall(toolCall, protocolId) {
  if (toolCall == null || typeof toolCall !== "object") {
    throw unsupported(protocolId, "Tool call is unrepresentable");
  }
  var fn = toolCall.function;
  var id = toolCall.id;
  var name = fn != null ? fn.name : null;
  if (typeof id !== "string" || id.length === 0 || typeof name !== "string" || name.length === 0) {
    throw contract.protocolError("Tool call is missing id or name", {
      protocol: protocolId,
      code: "incomplete-tool-call"
    });
  }
  return { id: id, name: name, arguments: jsonArgumentString(fn.arguments, protocolId) };
}

function extractAssistantPayload(message, protocolId) {
  var toolCalls = [];
  var texts = [];
  var reasonings = [];
  if (Array.isArray(message.tool_calls)) {
    for (var i = 0; i < message.tool_calls.length; i += 1) {
      toolCalls.push(openAiShapedToolCall(message.tool_calls[i], protocolId));
    }
  }
  if (typeof message.reasoning_content === "string" && message.reasoning_content.length > 0) {
    reasonings.push(message.reasoning_content);
  }
  if (typeof message.content === "string") {
    texts.push(message.content);
  } else if (message.content == null) {
    // OpenAI-shaped assistant with tool_calls and null content.
  } else if (Array.isArray(message.content)) {
    for (var j = 0; j < message.content.length; j += 1) {
      var part = message.content[j];
      if (part == null || typeof part !== "object") {
        throw unsupported(protocolId, "Assistant content is unrepresentable");
      }
      if (part.type === "text") {
        if (typeof part.text !== "string") {
          throw unsupported(protocolId, "Assistant content is unrepresentable");
        }
        texts.push(part.text);
      } else if (part.type === "reasoning") {
        if (typeof part.text !== "string") {
          throw unsupported(protocolId, "Assistant content is unrepresentable");
        }
        reasonings.push(part.text);
      } else if (part.type === "tool-call" || part.type === "tool_call") {
        toolCalls.push(hostToolCall(part, protocolId));
      } else {
        throw unsupported(protocolId, "Assistant content is unrepresentable");
      }
    }
  } else {
    throw unsupported(protocolId, "Assistant content is unrepresentable");
  }
  return {
    text: texts.join(""),
    reasoning: reasonings.join(""),
    toolCalls: toolCalls
  };
}

function rejectUnrepresentableToolResultExtras(part, protocolId) {
  var extras = part.experimental_content || part.content;
  if (!Array.isArray(extras)) {
    return;
  }
  for (var i = 0; i < extras.length; i += 1) {
    var item = extras[i];
    if (item != null && typeof item === "object" && item.type != null && item.type !== "text") {
      throw unsupported(protocolId, "Tool result content is unrepresentable");
    }
  }
}

function toolResultContent(part, protocolId) {
  if (typeof part.result === "string") {
    return part.result;
  }
  if (part.result !== undefined) {
    try {
      return JSON.stringify(part.result);
    } catch (_error) {
      throw unsupported(protocolId, "Tool result content is unrepresentable");
    }
  }
  if (typeof part.content === "string") {
    return part.content;
  }
  if (Array.isArray(part.content)) {
    var texts = [];
    for (var i = 0; i < part.content.length; i += 1) {
      var item = part.content[i];
      if (item == null || typeof item !== "object" || item.type !== "text" || typeof item.text !== "string") {
        throw unsupported(protocolId, "Tool result content is unrepresentable");
      }
      texts.push(item.text);
    }
    return texts.join("");
  }
  return "";
}

function extractToolResults(message, protocolId) {
  if (typeof message.tool_call_id === "string" && message.tool_call_id.length > 0 && (typeof message.content === "string" || message.content == null)) {
    return [{ id: message.tool_call_id, content: message.content == null ? "" : message.content }];
  }
  if (!Array.isArray(message.content)) {
    throw unsupported(protocolId, "Tool content is unrepresentable");
  }
  var out = [];
  for (var i = 0; i < message.content.length; i += 1) {
    var part = message.content[i];
    if (part == null || typeof part !== "object" || (part.type !== "tool-result" && part.type !== "tool_result")) {
      throw unsupported(protocolId, "Tool content is unrepresentable");
    }
    var id = typeof part.toolCallId === "string" ? part.toolCallId : part.tool_call_id;
    if (typeof id !== "string" || id.length === 0) {
      throw contract.protocolError("Tool result is missing tool_call_id", {
        protocol: protocolId,
        code: "incomplete-tool-call"
      });
    }
    rejectUnrepresentableToolResultExtras(part, protocolId);
    out.push({ id: id, content: toolResultContent(part, protocolId) });
  }
  return out;
}

module.exports = {
  convertFunctionTools: convertFunctionTools,
  jsonArgumentString: jsonArgumentString,
  parseToolArgumentsObject: parseToolArgumentsObject,
  extractSystemText: extractSystemText,
  extractUserParts: extractUserParts,
  extractAssistantPayload: extractAssistantPayload,
  extractToolResults: extractToolResults,
  unsupported: unsupported
};
